// Where to point a 9:16 crop when the source is 16:9.
//
// A vertical crop throws away two thirds of the width, so the only question that matters is
// which third to keep. Centre-cropping a review loses the thing being reviewed about half the
// time: the grinder is on the right, the hands are on the left, the speaker is off centre.
//
// Two rules make the result read as deliberate rather than wobbly, and both are the point of
// this module:
//   1. HOLD. Inside a shot the crop stays put unless the subject really moves. A crop that
//      drifts a few pixels a second looks like a broken gimbal, not a camera move.
//   2. EASE. When it does move, it moves once, smoothly, and no faster than a person would pan.
//
// Pure maths only, no Electron and no ffmpeg: main.ts decodes tiny greyscale frames and hands
// them here, `npm run test:framing` hands them synthetic ones.

/** One decoded frame, greyscale, row-major, `w * h` bytes. Small: 64x36 is plenty. */
export interface Frame {
  t: number
  w: number
  h: number
  gray: ArrayLike<number>
}

/** A steady crop centre for a stretch of time. cx is 0..1 across the source width. */
export interface CropSegment {
  start: number
  end: number
  cx: number
  /** why it sits there, for the report the user reads */
  reason: string
}

export interface CropPlan {
  segments: CropSegment[]
  /** sampled centre track before holding, kept for diagnostics */
  track: { t: number; cx: number }[]
  shots: { start: number; end: number }[]
}

export interface FramingOptions {
  /** crop width as a fraction of source width. 9:16 out of 16:9 is 0.3164. */
  cropW?: number
  /** how much a column's detail counts. Default 1. */
  detailWeight?: number
  /** how much movement counts. Movement is what the eye follows, so it outweighs detail. */
  motionWeight?: number
  /** pull toward frame centre, which is where people shoot the subject unless they meant not to */
  centreBias?: number
  /**
   * A shot change is a difference this many times the clip's OWN median frame difference.
   *
   * Measured rather than guessed: on real handheld 1080p sampled at 4fps, consecutive frames
   * inside one continuous shot already differ by a mean of ~23/255, with the 99th percentile
   * around 55. A fixed threshold that catches a real cut on tripod footage therefore fires on
   * essentially every frame of handheld footage (112 of 160, on the review this was built for),
   * which turns every frame into its own "shot" and defeats the hold rule entirely.
   */
  shotRatio?: number
  /** ...but never call something a cut below this absolute difference, so a locked-off shot
   * with a near-zero median does not treat a passing hand as a scene change. */
  shotFloor?: number
  /** seconds of median smoothing applied to the raw per-frame pick */
  smoothSec?: number
  /** the crop only moves when the target has drifted more than this (fraction of width) */
  holdTolerance?: number
  /** fastest the crop may travel, fraction of width per second */
  maxPanPerSec?: number
  /** shots shorter than this never pan: there is no time to see it */
  minPanShot?: number
  /** how long the subject must stay away before the crop believes it and moves */
  sustainSec?: number
  /** explicit "the subject is here" nudges, from someone actually looking at the frames */
  hints?: { t: number; cx: number; weight?: number }[]
}

const DEFAULTS: Required<Omit<FramingOptions, 'hints'>> = {
  cropW: 9 / 16 / (16 / 9),      // 0.3164
  detailWeight: 0.7,
  motionWeight: 3.2,
  centreBias: 0.22,
  shotRatio: 3,
  shotFloor: 28,
  smoothSec: 1.4,
  holdTolerance: 0.09,
  maxPanPerSec: 0.10,
  minPanShot: 1.2,
  sustainSec: 0.8,
}

/**
 * Per-column interest for one frame: horizontal detail plus movement against the previous
 * frame. Both are normalised to 0..1 within the frame, so the weights mean the same thing on a
 * dark shot as on a bright one.
 */
export function columnScores(frame: Frame, prev: Frame | null, opts: FramingOptions = {}): number[] {
  const o = { ...DEFAULTS, ...opts }
  const { w, h, gray } = frame
  const detail = new Array(w).fill(0)
  const motion = new Array(w).fill(0)
  const usePrev = prev && prev.w === w && prev.h === h ? prev.gray : null

  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      const left = gray[row + Math.max(0, x - 1)]
      const right = gray[row + Math.min(w - 1, x + 1)]
      detail[x] += Math.abs(right - left)
      if (usePrev) motion[x] += Math.abs(gray[row + x] - usePrev[row + x])
    }
  }

  const norm = (a: number[]) => {
    const max = Math.max(...a)
    return max > 0 ? a.map(v => v / max) : a.map(() => 0)
  }
  const d = norm(detail), m = norm(motion)
  const out = new Array(w)
  for (let x = 0; x < w; x++) {
    const centred = 1 - Math.abs(x / (w - 1) - 0.5) * 2      // 1 at centre, 0 at the edges
    out[x] = d[x] * o.detailWeight + m[x] * o.motionWeight + centred * o.centreBias
  }
  return out
}

/** Median of a window, which beats a mean here: one flashy frame should not move the crop. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** The crop centre (0..1) that captures the most interest in this frame. */
export function bestCentre(scores: number[], cropW: number): number {
  const n = scores.length
  const win = Math.max(1, Math.round(cropW * n))
  if (win >= n) return 0.5
  let sum = 0
  for (let i = 0; i < win; i++) sum += scores[i]
  let best = sum, bestStart = 0
  for (let i = win; i < n; i++) {
    sum += scores[i] - scores[i - win]
    if (sum > best) { best = sum; bestStart = i - win + 1 }
  }
  const centre = (bestStart + win / 2) / n
  const half = cropW / 2
  return Math.min(1 - half, Math.max(half, centre))
}

/**
 * Frame indices where the picture changed enough to be a cut.
 *
 * The bar is set from the clip's own median frame difference, so it adapts to grain, handheld
 * wobble and how far apart the samples are, instead of assuming footage is as calm as a tripod.
 */
export function shotCuts(frames: Frame[], opts: FramingOptions = {}): number[] {
  const o = { ...DEFAULTS, ...opts }
  if (frames.length < 2) return []
  const diffs: number[] = []
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i]
    if (a.w !== b.w || a.h !== b.h) { diffs.push(Infinity); continue }
    let diff = 0
    for (let k = 0; k < a.gray.length; k++) diff += Math.abs(b.gray[k] - a.gray[k])
    diffs.push(diff / a.gray.length)
  }
  const finite = diffs.filter(d => Number.isFinite(d))
  const med = finite.length ? median(finite) : 0
  const bar = Math.max(o.shotFloor, med * o.shotRatio)
  const cuts: number[] = []
  for (let i = 0; i < diffs.length; i++) if (diffs[i] > bar) cuts.push(i + 1)
  return cuts
}

/**
 * Turn a per-frame centre track into as few steady holds as possible.
 *
 * Walks the track and opens a new hold only when the target has been more than holdTolerance
 * away for long enough to be real movement rather than noise. Everything inside a hold uses one
 * centre, so the export gets a static crop for that stretch.
 */
export function holdSegments(track: { t: number; cx: number }[], shotStart: number, shotEnd: number, opts: FramingOptions = {}): CropSegment[] {
  const o = { ...DEFAULTS, ...opts }
  if (!track.length) return [{ start: shotStart, end: shotEnd, cx: 0.5, reason: 'no samples' }]
  const short = shotEnd - shotStart < o.minPanShot
  if (short || track.length < 3) {
    return [{ start: shotStart, end: shotEnd, cx: +median(track.map(p => p.cx)).toFixed(4), reason: short ? 'short shot, held' : 'held' }]
  }

  const segs: CropSegment[] = []
  let anchorIdx = 0
  let anchor = median(track.slice(0, Math.min(track.length, 5)).map(p => p.cx))
  let driftFrom = -1

  for (let i = 1; i < track.length; i++) {
    const off = Math.abs(track[i].cx - anchor)
    if (off > o.holdTolerance) {
      if (driftFrom < 0) driftFrom = i
      // sustained for half a second before we believe it
      if (track[i].t - track[driftFrom].t >= o.sustainSec) {
        segs.push({ start: track[anchorIdx].t, end: track[driftFrom].t, cx: +anchor.toFixed(4), reason: 'held on the subject' })
        anchorIdx = driftFrom
        anchor = median(track.slice(driftFrom, Math.min(track.length, driftFrom + 5)).map(p => p.cx))
        driftFrom = -1
      }
    } else {
      driftFrom = -1
    }
  }
  segs.push({ start: track[anchorIdx].t, end: shotEnd, cx: +anchor.toFixed(4), reason: segs.length ? 'moved with the subject' : 'held on the subject' })
  if (segs.length) segs[0].start = shotStart
  return segs
}

/**
 * Cap how fast the crop may travel between SHORT holds, so a flurry of quick reframes does not
 * read as a glitch.
 *
 * Deliberately does not touch a hold that lasts a while. Clamping the destination of a long hold
 * is the difference between "the crop eased over" and "the crop parked in the wrong place for
 * half a minute": on real footage this pinned a 31s hold at 71% because the 1.3s hold before it
 * was at 84%, while the frames underneath it averaged 44%. A sustained reframe goes where the
 * subject is; only the twitchy ones are rate-limited.
 */
export function limitPan(segs: CropSegment[], opts: FramingOptions = {}): CropSegment[] {
  const o = { ...DEFAULTS, ...opts }
  const settled = o.minPanShot * 1.6      // a hold this long is a decision, not a twitch
  const out = segs.map(s => ({ ...s }))
  for (let i = 1; i < out.length; i++) {
    if (out[i].end - out[i].start >= settled) continue
    const dt = Math.max(0.001, out[i].start - out[i - 1].start)
    const maxMove = o.maxPanPerSec * dt
    const delta = out[i].cx - out[i - 1].cx
    if (Math.abs(delta) > maxMove) {
      out[i].cx = +(out[i - 1].cx + Math.sign(delta) * maxMove).toFixed(4)
      out[i].reason = 'move limited to a natural pan'
    }
  }
  return out
}

/**
 * The whole plan: per-frame pick, shot-aware smoothing, holds, pan limiting.
 *
 * Hints from someone who actually looked at the footage win over the maths: a hint inside a
 * shot pulls that shot's centre toward it, weighted, rather than replacing the measurement
 * outright, so a hint that lands on a frame boundary cannot yank the crop off the subject.
 */
export function planCrop(frames: Frame[], opts: FramingOptions = {}): CropPlan {
  const o = { ...DEFAULTS, ...opts }
  if (!frames.length) return { segments: [], track: [], shots: [] }

  const raw: { t: number; cx: number }[] = frames.map((f, i) => ({
    t: f.t,
    cx: bestCentre(columnScores(f, i > 0 ? frames[i - 1] : null, opts), o.cropW),
  }))

  const cuts = shotCuts(frames, opts)
  const bounds = [0, ...cuts, frames.length]
  const shots: { start: number; end: number }[] = []
  const segments: CropSegment[] = []

  for (let s = 0; s < bounds.length - 1; s++) {
    const from = bounds[s], to = bounds[s + 1]
    if (to <= from) continue
    const shotStart = frames[from].t
    const shotEnd = to < frames.length ? frames[to].t : frames[frames.length - 1].t + (frames[1] ? frames[1].t - frames[0].t : 0.25)
    shots.push({ start: shotStart, end: shotEnd })

    // median smooth inside the shot only, so a cut never drags the previous shot's centre in
    const span = raw.slice(from, to)
    const stepSec = span.length > 1 ? span[1].t - span[0].t : 0.25
    const half = Math.max(0, Math.floor((o.smoothSec / Math.max(0.001, stepSec)) / 2))
    const smoothed = span.map((p, i) => ({
      t: p.t,
      cx: median(span.slice(Math.max(0, i - half), Math.min(span.length, i + half + 1)).map(q => q.cx)),
    }))

    // a hint inside this shot pulls the whole shot toward it
    const hints = (opts.hints || []).filter(h => h.t >= shotStart && h.t < shotEnd)
    const pulled = hints.length
      ? smoothed.map(p => {
          const h = hints.reduce((acc, x) => (Math.abs(x.t - p.t) < Math.abs(acc.t - p.t) ? x : acc), hints[0])
          const wgt = Math.min(1, Math.max(0, h.weight ?? 0.7))
          return { t: p.t, cx: p.cx * (1 - wgt) + h.cx * wgt }
        })
      : smoothed

    const held = holdSegments(pulled, shotStart, shotEnd, opts)
    if (hints.length) held.forEach(seg => { seg.reason = 'placed by hint' })
    segments.push(...held)
  }

  // Merge first, THEN limit the pan. The other order clamps every step of a genuine move down to
  // the pan rate, producing a staircase of near-identical holds that then merge into one hold
  // sitting between the two places the subject actually was.
  return { segments: limitPan(mergeHolds(segments, opts), opts), track: raw, shots }
}

/**
 * Collapse neighbouring holds that point at effectively the same place.
 *
 * Two holds a percent apart are the same hold as far as the eye is concerned, and every extra
 * one costs a term in the ffmpeg crop expression. Merging keeps the expression short enough to
 * stay readable and to render.
 */
export function mergeHolds(segs: CropSegment[], opts: FramingOptions = {}): CropSegment[] {
  const o = { ...DEFAULTS, ...opts }
  const out: CropSegment[] = []
  // The centre each run STARTED at. Comparing against the running average instead lets a chain
  // of individually-small steps walk the crop right across the frame and still call itself one
  // hold: on real footage that produced a single 31s hold at 71% over a stretch whose own frames
  // averaged 44%, which is the whole subject sitting outside the crop.
  let anchor = 0
  for (const s of segs) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.cx - s.cx) <= o.holdTolerance / 2 && Math.abs(anchor - s.cx) <= o.holdTolerance) {
      const wA = last.end - last.start, wB = s.end - s.start
      last.cx = +(((last.cx * wA) + (s.cx * wB)) / Math.max(1e-6, wA + wB)).toFixed(4)
      last.end = s.end
    } else {
      out.push({ ...s })
      anchor = s.cx
    }
  }
  return out
}

/**
 * ffmpeg crop expression for a plan: one `crop` with a stepped x, evaluated per frame.
 * Static when there is a single segment, which is the common case and the cheapest.
 */
export function cropExpr(plan: CropPlan, srcW: number, cropWpx: number): string {
  const clamp = (cx: number) => Math.round(Math.min(srcW - cropWpx, Math.max(0, cx * srcW - cropWpx / 2)))
  if (plan.segments.length <= 1) {
    const x = plan.segments.length ? clamp(plan.segments[0].cx) : Math.round((srcW - cropWpx) / 2)
    return String(x)
  }
  // nested if(lt(t,..)) chain, innermost last segment
  let expr = String(clamp(plan.segments[plan.segments.length - 1].cx))
  for (let i = plan.segments.length - 2; i >= 0; i--) {
    expr = `if(lt(t,${plan.segments[i].end.toFixed(3)}),${clamp(plan.segments[i].cx)},${expr})`
  }
  return expr
}
