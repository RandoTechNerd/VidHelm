/* Timeline geometry: ruler ticks, timecodes, how wide the scrollable lanes are. Pure (no Electron,
 * no DOM) so the numbers can be tested on their own: npm run test:timeline. src/App.tsx and
 * src/ruler.tsx draw what these return. */

// Tick spacings people think in. Half a second only appears when zoomed right in, where the
// labels switch to frames so a tick between two whole seconds still says where it is.
export const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

/** The labelled tick spacing: the smallest step whose label still has room (minPx) to itself. */
export const tickStepFor = (pxPerSec: number, minPx = 58): number =>
  TICK_STEPS.find(step => step * pxPerSec >= minPx) ?? TICK_STEPS[TICK_STEPS.length - 1]

// How many parts a labelled step splits into for the unlabelled minor ticks: quarters of a
// second, whole seconds under a 5 s step, quarter minutes under a minute, never a 12 s oddity.
const MINOR_PARTS: Record<number, number> = { 0.5: 5, 1: 4, 2: 4, 5: 5, 10: 5, 15: 3, 30: 6, 60: 4, 120: 4, 300: 5, 600: 5, 900: 3, 1800: 6, 3600: 4 }
export const minorPartsFor = (step: number): number => MINOR_PARTS[step] ?? 4

export interface Tick { t: number; label: boolean; major: boolean }

/**
 * Every tick between two times (seconds), labelled ones and the minor ones between them. Minor
 * ticks closer than 6 px are dropped rather than drawn as a grey smear. Times are built from an
 * integer index, never by adding a step over and over, so tick 300 sits at exactly 300 s.
 * `major` marks every other labelled tick once steps are a minute or more, as before.
 */
export function rulerTicks(from: number, to: number, pxPerSec: number, cap = 4000): Tick[] {
  if (!(pxPerSec > 0) || !(to >= from)) return []
  const step = tickStepFor(pxPerSec)
  const parts = minorPartsFor(step)
  const showMinor = (step / parts) * pxPerSec >= 6
  const unit = showMinor ? step / parts : step
  const per = showMinor ? parts : 1
  const out: Tick[] = []
  for (let j = Math.max(0, Math.ceil(from / unit - 1e-9)); j * unit <= to + 1e-9 && out.length < cap; j++) {
    const label = j % per === 0
    const k = Math.round(j / per)
    out.push({ t: +(j * unit).toFixed(6), label, major: label && step >= 60 && k % 2 === 0 })
  }
  return out
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export type TimecodeMode = 'tenths' | 'frames'

/**
 * The playhead clock. 'tenths' is m:ss.t, 'frames' is m:ss:ff at the project frame rate. Both count
 * from an integer (tenths or frames) so 2.3 s reads 0:02.3, not the 0:02.2 that (2.3 % 1) * 10
 * gives in floating point, and 59 frames at 30 fps reads 0:01:29.
 */
export function timecode(s: number, mode: TimecodeMode = 'tenths', fps = 30): string {
  const v = Number.isFinite(s) && s > 0 ? s : 0
  if (mode === 'frames') {
    const rate = Math.max(1, Math.round(fps) || 30)
    const total = Math.floor(v * rate + 1e-6)
    const secs = Math.floor(total / rate)
    return `${Math.floor(secs / 60)}:${pad2(secs % 60)}:${pad2(total % rate)}`
  }
  const tenths = Math.floor(v * 10 + 1e-6)
  const secs = Math.floor(tenths / 10)
  return `${Math.floor(secs / 60)}:${pad2(secs % 60)}.${tenths % 10}`
}

/** m:ss.hh, for readouts that move in small steps (drag times, the ruler hover). */
export function clock(s: number): string {
  const v = Number.isFinite(s) ? Math.abs(s) : 0
  const hund = Math.round(v * 100)
  const secs = Math.floor(hund / 100)
  return `${s < 0 && hund > 0 ? '-' : ''}${Math.floor(secs / 60)}:${pad2(secs % 60)}.${pad2(hund % 100)}`
}

/** A ruler label: m:ss, or m:ss:ff once the ticks are closer than a second apart. */
export const rulerLabel = (t: number, step: number, fps = 30): string =>
  step < 1 ? timecode(t, 'frames', fps) : `${Math.floor(t / 60)}:${pad2(Math.round(t) % 60)}`

/**
 * How wide the scrollable timeline is, in px. The lanes, the ruler and the scrub area all span
 * this, so their backgrounds and hit areas reach the last clip at any zoom (they used to stop at
 * the first screen while the clips carried on). A little room past the end leaves space to drop
 * and drag beyond the last clip.
 */
export const contentWidth = (totalDuration: number, pxPerSec: number, viewW: number, step = tickStepFor(pxPerSec)): number =>
  Math.ceil(Math.max(viewW, (Math.ceil(Math.max(0, totalDuration)) + step) * pxPerSec + 240))

// ---- dragging: snapping, trimming, staying inside the footage ----

export interface Span { start: number; duration: number }
export interface SourcedSpan extends Span { sourceStart: number }

/**
 * Every time a dragged edge may snap to: the fixed ones (0, the playhead, tag points) plus both
 * edges of every other clip and text, on every track, so a title can line up with a cut on the
 * row below it. Sorted, duplicates dropped.
 */
export function collectSnapTargets(items: (Span & { id: string })[], excludeId: string | null, fixed: number[] = []): number[] {
  const all = [...fixed]
  for (const it of items) if (it.id !== excludeId) all.push(it.start, it.start + it.duration)
  return [...new Set(all.filter(Number.isFinite).map(t => +t.toFixed(6)))].sort((a, b) => a - b)
}

/** The target closest to t, if one is within `threshold` seconds of it. */
export function nearestTarget(t: number, targets: number[], threshold: number): number | null {
  let best: number | null = null
  for (const s of targets) if (Math.abs(s - t) <= threshold && (best === null || Math.abs(s - t) < Math.abs(best - t))) best = s
  return best
}

/**
 * A moved clip snaps by whichever of its edges is closer to a target, so its END can land on a
 * cut as well as its start. `line` is where to draw the snap guide (null when nothing snapped).
 * Never before 0: an end snap that would push the start negative is ignored.
 */
export function snapMove(start: number, duration: number, targets: number[], threshold: number): { start: number; line: number | null } {
  const s = Math.max(0, start)
  const a = nearestTarget(s, targets, threshold)
  const b = nearestTarget(s + duration, targets, threshold)
  const da = a === null ? Infinity : Math.abs(a - s)
  const db = b === null || b - duration < 0 ? Infinity : Math.abs(b - (s + duration))
  if (da === Infinity && db === Infinity) return { start: s, line: null }
  return da <= db ? { start: a!, line: a } : { start: b! - duration, line: b }
}

export type TrimLimit = 'footage-start' | 'footage-end' | 'timeline-start' | null

export interface TrimOptions {
  /** the media's own length (s); unset for stills, text and media of unknown length: no footage edge to stop at */
  sourceDuration?: number
  /** does a left trim move the in-point? Clips yes (the footage slides), text and stills no */
  hasSource?: boolean
  minDuration?: number
}

/**
 * One edge of a clip dragged to `edge` (seconds on the timeline), held inside what exists: the
 * timeline starts at 0, a clip cannot be shorter than minDuration, and a clip of footage cannot
 * start before the file does or run past its end. Past those edges the preview froze on the last
 * frame while the export rendered black and silent, so the two disagreed. `limit` says which wall
 * stopped it (the handle turns red), or null.
 */
export function trimTo<T extends Span & { sourceStart?: number }>(o: T, side: 'left' | 'right', edge: number, opts: TrimOptions = {}): SourcedSpan & { limit: TrimLimit } {
  const min = opts.minDuration ?? 0.3
  const hasSource = opts.hasSource !== false
  const ss = Number(o.sourceStart) || 0
  const end = o.start + o.duration
  let limit: TrimLimit = null
  if (side === 'left') {
    // the file's first frame sits at start - sourceStart on the timeline
    const footageAt = hasSource ? o.start - ss : -Infinity
    const lo = Math.max(0, footageAt)
    let s = edge
    if (s < lo) { s = lo; limit = footageAt >= 0 ? 'footage-start' : 'timeline-start' }
    if (s > end - min) { s = end - min; limit = null }
    return { start: s, duration: end - s, sourceStart: hasSource ? ss + (s - o.start) : ss, limit }
  }
  const hi = hasSource && opts.sourceDuration !== undefined && opts.sourceDuration > 0 ? o.start + (opts.sourceDuration - ss) : Infinity
  let e = edge
  if (e > hi) { e = hi; limit = 'footage-end' }
  if (e < o.start + min) { e = o.start + min; limit = null }
  return { start: o.start, duration: e - o.start, sourceStart: ss, limit }
}

/**
 * A clip as saved or as an agent asked for it, pulled back inside its footage. A negative in-point
 * moves the clip's start right by the same amount, so every frame that does exist stays at the
 * time it was at; a clip running past the end of the file is shortened. Under a millisecond of
 * overrun is left alone (probe rounding). Returns the same object when nothing changes.
 */
export function clampToSource<T extends SourcedSpan>(c: T, sourceDuration?: number, minDuration = 0.05): T {
  let { start, duration, sourceStart } = c
  if (!Number.isFinite(sourceStart) || sourceStart < 0) {
    const lead = Number.isFinite(sourceStart) ? -sourceStart : 0
    start += lead; duration -= lead; sourceStart = 0
  }
  if (sourceDuration !== undefined && sourceDuration > 0) {
    if (sourceStart > sourceDuration - minDuration) sourceStart = Math.max(0, sourceDuration - minDuration)
    if (sourceStart + duration > sourceDuration + 1e-3) duration = sourceDuration - sourceStart
  }
  duration = Math.max(minDuration, duration)
  if (start === c.start && duration === c.duration && sourceStart === c.sourceStart) return c
  return { ...c, start, duration, sourceStart }
}

/** The most a clip can last from its in-point, or Infinity when the media has no fixed length. */
export const maxDurationFrom = (sourceStart: number, sourceDuration?: number): number =>
  sourceDuration !== undefined && sourceDuration > 0 ? Math.max(0, sourceDuration - Math.max(0, sourceStart || 0)) : Infinity

const signed = (d: number) => (d < 0 ? '-' : '+') + clock(Math.abs(d))

/** The drag readout for a move: where it starts now, and how far it went. */
export const moveReadout = (start: number, origStart: number): string => `${clock(start)} (${signed(start - origStart)})`

/** The drag readout for a trim: the new length and the change, and which wall stopped it. */
export function trimReadout(duration: number, origDuration: number, limit: TrimLimit = null): string {
  const d = duration - origDuration
  const wall = limit === 'footage-start' ? ' · start of footage' : limit === 'footage-end' ? ' · end of footage' : limit === 'timeline-start' ? ' · start of timeline' : ''
  return `Dur ${duration.toFixed(2)} (${d < 0 ? '-' : '+'}${Math.abs(d).toFixed(2)})${wall}`
}

// ---- filmstrips ----

/**
 * How many frames a clip's filmstrip needs so each one keeps the 16:9 shape make-thumbnails cuts
 * them to. The strip is stretched across the clip, so a count picked per 110 px drew every frame
 * 1.34x too wide.
 */
export const stripTiles = (widthPx: number, tileH: number, aspect = 16 / 9, max = 120): number =>
  Math.max(1, Math.min(max, Math.round(widthPx / (tileH * aspect)) || 1))

/**
 * Whether a strip of `have` frames still looks right at this width: either it is the count we
 * would ask for anyway, or stretching it costs under 15% of its shape. Zooming a step at a time
 * then re-renders a strip only when it has drifted visibly, not on every step.
 */
export function stripFits(have: number, widthPx: number, tileH: number, aspect = 16 / 9, max = 120): boolean {
  if (!(have > 0)) return false
  if (have === stripTiles(widthPx, tileH, aspect, max)) return true
  return Math.abs(widthPx / (have * tileH * aspect) - 1) <= 0.15
}