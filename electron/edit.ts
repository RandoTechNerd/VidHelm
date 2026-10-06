/**
 * Timeline edits that cut time: splitting a clip, removing a stretch and rippling what follows,
 * and choosing which pauses Cut Pauses takes out.
 *
 * These used to live inline in App.tsx, three copies of the split among them, and each copy had
 * dropped something on the floor:
 *  - a split copied the clip's volume automation to BOTH halves unshifted, so the right half
 *    played the line from the left half's start (a fade-down at 8 s landed at 8 s into the right
 *    half instead of where it was drawn);
 *  - removeRange cleared the right half's automation outright, so every Cut Pauses join reset a
 *    ducked music bed to its flat volume;
 *  - removeRange kept a caption's whole sentence on both pieces, so the line either side of a cut
 *    showed every word, timed as if nothing had been removed;
 *  - Cut Pauses padded and sliver-checked the head of the timeline like any other pause, so the
 *    dead air before the first word was never removed.
 *
 * The audio de-pop rule (CLAUDE.md): a cut is a hard cut on the PICTURE but never on the
 * waveform. Every new edge gets at least DEPOP of audio-only ramp (aFadeIn / aFadeOut).
 *
 * Pure module: no Electron, no React. npm run test:edit.
 */

/** Twelve milliseconds: far too short to hear as a fade, long enough that the waveform reaches
 *  zero before the splice. Without it a cut lands mid-cycle and the step reads as a click. */
export const DEPOP = 0.012

export interface VolPoint { t: number; v: number }

/** The fields a cut reads and writes. Anything else on a clip is carried along untouched. */
export interface EditClip {
  id: string
  start: number
  duration: number
  sourceStart: number
  fadeIn: number
  fadeOut: number
  aFadeIn?: number
  aFadeOut?: number
  /** automation: t = seconds from the clip's start, v = gain 0..2 */
  volumePoints?: VolPoint[]
}
export interface EditWord { s: number; e: number; t: string }
export interface EditText {
  id: string
  text: string
  start: number
  duration: number
  /** a themed caption: words in seconds from the text's start */
  caption?: { words?: EditWord[] }
}
export interface EditMarker { t: number }
export interface Span { start: number; end: number }

const r4 = (x: number) => +x.toFixed(4)
const sortPts = (pts: VolPoint[]) => [...pts].sort((a, b) => a.t - b.t)

/** The gain an automation line gives at local time t: straight lines between points, flat before
 *  the first and after the last. The same rule as the preview's gainAt and the export's volumeExpr. */
export function automationAt(pts: VolPoint[], t: number): number {
  const P = sortPts(pts)
  if (!P.length) return 1
  if (t <= P[0].t) return P[0].v
  if (t >= P[P.length - 1].t) return P[P.length - 1].v
  for (let i = 1; i < P.length; i++) {
    if (t <= P[i].t) { const a = P[i - 1], b = P[i]; return a.v + (b.v - a.v) * (t - a.t) / ((b.t - a.t) || 1) }
  }
  return P[P.length - 1].v
}

/**
 * The part of an automation line between local times `from` and `to`, moved to start at 0.
 * Where the line had points outside the stretch, a point is added at that edge carrying the
 * interpolated gain, so the piece plays exactly what that stretch of the whole clip played.
 * No automation stays no automation (undefined).
 */
export function rebasePoints(pts: VolPoint[] | undefined, from: number, to: number): VolPoint[] | undefined {
  if (!pts) return undefined
  if (!pts.length) return []
  const EPS = 1e-6
  const len = Math.max(0, to - from)
  const P = sortPts(pts)
  const out = P.filter(p => p.t >= from - EPS && p.t <= to + EPS).map(p => ({ t: r4(Math.min(len, Math.max(0, p.t - from))), v: p.v }))
  if (P.some(p => p.t < from - EPS) && !out.some(p => p.t <= EPS)) out.unshift({ t: 0, v: r4(automationAt(P, from)) })
  if (P.some(p => p.t > to + EPS) && !out.some(p => p.t >= len - EPS)) out.push({ t: r4(len), v: r4(automationAt(P, to)) })
  return out
}

/** Gain at or below this is silence: the Volume slider's own "zero". */
const SILENT = 1e-3

/**
 * The Volume slider moved from `from` to `to` on a clip with automation: raise or lower the whole
 * line, keeping its shape. (It used to wipe the line, so one nudge of the slider threw away every
 * hand-drawn duck.) Returns the new line and the volume the slider actually reached.
 *
 * The line moves as a whole or not at all. When its loudest point would pass the slider's top
 * (2.0) the move stops there, and the returned volume says where; clamping points one at a time
 * used to flatten every peak that touched the ceiling, and since the slider feeds its last result
 * back in as the next step's start, nudging it up and back down lowered a drawn 1.8 to 1.667 for
 * good. A point at silence stays silent, except when the whole line is silent (the slider was
 * taken to zero): there is no shape left to keep then, and the line rises flat.
 */
export function rescaleAutomation(pts: VolPoint[], from: number, to: number): { volume: number; volumePoints: VolPoint[] } {
  const clamp = (v: number) => r4(Math.min(2, Math.max(0, v)))
  const peak = Math.max(0, ...pts.map(p => p.v))
  if (from > SILENT) {
    let ratio = to / from
    if (ratio > 1 && peak > 0) ratio = Math.max(1, Math.min(ratio, 2 / peak))
    return { volume: ratio === to / from ? to : r4(from * ratio), volumePoints: pts.map(p => ({ t: p.t, v: clamp(p.v * ratio) })) }
  }
  // from silence there is no ratio to scale by, so the line moves by the difference instead
  const silent = peak <= SILENT
  const moves = (p: VolPoint) => silent || p.v > SILENT
  let d = to - from
  const top = Math.max(0, ...pts.filter(moves).map(p => p.v))
  if (d > 0) d = Math.max(0, Math.min(d, 2 - top))
  return { volume: d === to - from ? to : r4(from + d), volumePoints: pts.map(p => ({ t: p.t, v: moves(p) ? clamp(p.v + d) : p.v })) }
}

/** A drag of the Volume slider on one clip with automation: the line it began from, and the line
 *  it last wrote. */
export interface VolumeSlide { id: string; volume: number; points: VolPoint[]; wrote: VolPoint[] }

/**
 * One step of the Volume slider on a clip with automation, scaled from where the drag began
 * rather than from the previous step: taking the slider to zero silences every point, and a line
 * of zeros has no shape left to bring back, so a drag that brushed the bottom flattened the line
 * for good (and each step's rounding piled onto the last). The slide carries on while the clip's
 * points are still the very array it last wrote (an identity check); a drawn point, an undo or an
 * agent edit replaces that array, and the next step starts from the line as it now stands.
 */
export function slideVolume(slide: VolumeSlide | null, clip: { id: string; volume: number; volumePoints: VolPoint[] }, to: number): { slide: VolumeSlide; volume: number; volumePoints: VolPoint[] } {
  const s = slide && slide.id === clip.id && slide.wrote === clip.volumePoints ? slide
    : { id: clip.id, volume: clip.volume, points: clip.volumePoints, wrote: clip.volumePoints }
  const r = rescaleAutomation(s.points, s.volume, to)
  return { slide: { ...s, wrote: r.volumePoints }, ...r }
}

/**
 * Split one clip at absolute time tAbs into two that play exactly what the one did: a hard cut on
 * the picture, DEPOP ramps either side of the join on the audio, and the automation line cut in
 * two with each half rebased to its own start. The original fades stay on the outer ends.
 * Null when tAbs is not strictly inside the clip.
 */
export function splitClip<C extends EditClip>(c: C, tAbs: number, newId: () => string): [C, C] | null {
  const off = tAbs - c.start
  if (!(off > 0) || !(off < c.duration)) return null
  const left: C = { ...c, id: newId(), duration: off, fadeOut: 0, aFadeOut: DEPOP, volumePoints: rebasePoints(c.volumePoints, 0, off) }
  const right: C = {
    ...c, id: newId(), start: tAbs, duration: c.duration - off, sourceStart: c.sourceStart + off,
    fadeIn: 0, aFadeIn: DEPOP, volumePoints: rebasePoints(c.volumePoints, off, c.duration),
  }
  return [left, right]
}

/**
 * Tag points ride along when time is removed: after the cut they shift left by its length, and a
 * tag inside the removed stretch lands on the join (or goes, when a whole head or tail is trimmed
 * off). Tagging first and cutting second is the documented workflow, so tags must not drift.
 */
export function rippleMarkers<M extends EditMarker>(markers: M[], s: number, e: number, dropInside = false): M[] {
  const len = e - s
  const out: M[] = []
  for (const m of markers) {
    if (m.t < s) out.push(m)
    else if (m.t >= e) out.push({ ...m, t: r4(m.t - len) })
    else if (!dropInside) out.push({ ...m, t: s })
  }
  return out
}

/** A caption's words in seconds from its start: its own when they match the text word for word,
 *  else spread evenly (what the preview and the export show in that case, see cueWords). */
function captionWords(t: EditText): EditWord[] {
  const tokens = String(t.text || '').trim().split(/\s+/).filter(Boolean)
  const own = t.caption?.words
  if (Array.isArray(own) && own.length === tokens.length) return own.map((w, i) => ({ s: w.s, e: Math.max(w.s, w.e), t: tokens[i] }))
  const step = t.duration / Math.max(1, tokens.length)
  return tokens.map((tok, i) => ({ s: i * step, e: (i + 1) * step, t: tok }))
}

/** The words of a caption that were spoken between local times from and to (a word belongs where
 *  its middle is), rebased to start at 0, with the text rebuilt from them. Null when none were. */
function captionPiece<T extends EditText>(t: T, from: number, to: number): Pick<T, 'text' | 'caption'> | null {
  const kept = captionWords(t).filter(w => { const mid = (w.s + w.e) / 2; return mid >= from && mid < to })
  if (!kept.length) return null
  const len = to - from
  const words = kept.map(w => ({ s: r4(Math.max(0, w.s - from)), e: r4(Math.min(len, w.e - from)), t: w.t }))
  return { text: words.map(w => w.t).join(' '), caption: { ...t.caption, words } } as Pick<T, 'text' | 'caption'>
}

/**
 * Remove timeline range [s, e] and ripple everything after it left: clips, texts and tag points.
 *
 * Video composites over a black base, so fading A out and B in at the very same instant dips
 * through black: on a talking head with a hundred pause cuts that reads as the picture blinking
 * at you all the way through. When `transition` > 0 the two halves of a cut clip overlap instead,
 * and B dissolves in ON TOP of A, which never sees black. The picture keeps whatever the
 * transition asked for (including 0, and the deliberate no-fadeOut under an overlap); the AUDIO
 * always gets at least DEPOP either side of the join.
 */
export function removeRange<C extends EditClip, T extends EditText, M extends EditMarker>(
  clips: C[], texts: T[], s: number, e: number, transition: number, markers: M[], newId: () => string, dropTagsInside = false,
): { clips: C[]; texts: T[]; markers: M[] } {
  const len = e - s
  const td = Math.max(0, Math.min(transition, len, 0.3))
  const outClips: C[] = []
  for (const c of clips) {
    const cs = c.start, ce = c.start + c.duration
    if (ce <= s) { outClips.push(c); continue }
    if (cs >= e) { outClips.push({ ...c, start: cs - len }); continue }
    const left = s - cs, right = ce - e
    const overlap = Math.max(0, Math.min(td, left - 0.05, e - cs))
    if (left > 0.05) outClips.push({
      ...c, duration: left,
      fadeOut: overlap > 0 ? 0 : (td > 0 ? td : c.fadeOut),
      aFadeOut: Math.max(DEPOP, overlap > 0 ? 0 : (td > 0 ? td : c.fadeOut)),
      volumePoints: rebasePoints(c.volumePoints, 0, left),
    })
    if (right > 0.05) {
      const from = (e - cs) - overlap   // where the right piece now starts in the clip's own time
      outClips.push({
        ...c, id: newId(),
        start: s - overlap,
        duration: right + overlap,
        sourceStart: c.sourceStart + from,   // pulled back by the overlap so motion stays continuous
        fadeIn: overlap > 0 ? overlap : (td > 0 ? td : c.fadeIn),
        aFadeIn: Math.max(DEPOP, overlap > 0 ? overlap : (td > 0 ? td : c.fadeIn)),
        volumePoints: rebasePoints(c.volumePoints, from, c.duration),
      })
    }
  }
  const outTexts: T[] = []
  for (const t of texts) {
    const ts = t.start, te = t.start + t.duration
    if (te <= s) { outTexts.push(t); continue }
    if (ts >= e) { outTexts.push({ ...t, start: ts - len }); continue }
    const left = s - ts, right = te - e
    // a title spanning the cut simply carries on; a caption keeps the words said on its side of it
    if (left > 0.05) {
      const piece = t.caption ? captionPiece(t, 0, left) : {}
      if (piece) outTexts.push({ ...t, ...piece, duration: left })
    }
    if (right > 0.05) {
      const piece = t.caption ? captionPiece(t, e - ts, t.duration) : {}
      if (piece) outTexts.push({ ...t, ...piece, id: newId(), start: s, duration: right })
    }
  }
  return { clips: outClips, texts: outTexts, markers: rippleMarkers(markers, s, e, dropTagsInside) }
}

/**
 * Ripple edits, the way Premiere and Resolve mean them: take time out and close the gap.
 *
 * What moves depends on where the clip lives. The video track is the spine of the edit, so taking
 * time out of it takes that time out of everything (b-roll, music, captions and tags stay in sync,
 * exactly like Cut Pauses). A clip on any other track only closes the gap on its own track: deleting
 * a sound effect must not shorten the video under it.
 */
export type RippleKind = 'delete' | 'trimStart' | 'trimEnd'

/** The stretch a ripple edit takes out of one clip, or null when the playhead is not inside it. */
export function rippleRange(c: { start: number; duration: number }, kind: RippleKind, playhead: number): { start: number; end: number } | null {
  const s = c.start, e = c.start + c.duration
  if (kind === 'delete') return { start: s, end: e }
  const inside = playhead > s + 0.01 && playhead < e - 0.01
  if (!inside) return null
  return kind === 'trimStart' ? { start: s, end: playhead } : { start: playhead, end: e }
}

/** Close a gap on one track only: the time [s, e) comes out of the clips on `track`, later ones move left. */
export function rippleTrack<C extends EditClip & { trackId: string }>(clips: C[], track: string, s: number, e: number): C[] {
  const len = e - s
  if (!(len > 0)) return clips
  const out: C[] = []
  for (const c of clips) {
    if (c.trackId !== track) { out.push(c); continue }
    const cs = c.start, ce = c.start + c.duration
    if (ce <= s + 1e-9) { out.push(c); continue }
    if (cs >= e - 1e-9) { out.push({ ...c, start: cs - len }); continue }
    // the edited clip itself: keep what lies outside [s, e), joined up
    const left = Math.max(0, s - cs), right = Math.max(0, ce - e)
    if (left > 0.01) out.push({ ...c, duration: left, aFadeOut: Math.max(DEPOP, c.aFadeOut ?? 0), volumePoints: rebasePoints(c.volumePoints, 0, left) })
    if (right > 0.01) {
      const from = e - cs
      out.push({ ...c, ...(left > 0.01 ? { id: c.id + '_r' } : {}), start: s, duration: right, sourceStart: c.sourceStart + from,
        aFadeIn: Math.max(DEPOP, c.aFadeIn ?? 0), volumePoints: rebasePoints(c.volumePoints, from, c.duration) })
    }
  }
  return out
}

/**
 * Which stretches Cut Pauses removes, from the quiet (or still) intervals it measured.
 *
 * - Each interval is padded inward by `pad`, so a breath stays either side of the speech. Not at
 *   the very head or tail of the timeline: there is no speech before the start or after the end to
 *   leave room for, and the pad there only kept a sliver of dead air.
 * - A fragment shorter than `minWord` before the first pause (or after the last) is a click or a
 *   breath, not speech (no word is that short), so it goes with the pause. Anything longer stays.
 * - Overlaps are merged, or overlapping clips would cut the same seconds twice.
 * - Two pauses close together leave an orphan between them: a third of a second of speech that
 *   dissolves in and straight back out, which reads as a stutter rather than an edit. A cut that
 *   would strand a fragment shorter than `minKeep` after the previous one is left out. The head is
 *   exempt: there is nothing before it to dissolve from, and a short opening line followed by a cut
 *   is an ordinary jump cut. (It used to count as a sliver, so head dead air was never removed.)
 * - Never the whole timeline.
 * Returned in timeline order; apply them last to first so earlier times stay valid.
 */
export function planPauseCuts(intervals: Span[], total: number, opts: { pad: number; minKeep: number; minWord?: number }): Span[] {
  const minWord = opts.minWord ?? 0.25
  const ranges = intervals
    .filter(iv => Number.isFinite(iv.start) && Number.isFinite(iv.end))
    .map(iv => ({
      start: iv.start < minWord ? 0 : Math.max(0, iv.start + opts.pad),
      end: total - iv.end < minWord ? total : Math.min(total, iv.end - opts.pad),
    }))
    .filter(r => r.end - r.start > 0.1)
    .sort((a, b) => a.start - b.start)
  const merged: Span[] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end + 0.01) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  const spaced: Span[] = []
  for (const r of merged) {
    if (spaced.length && r.start - spaced[spaced.length - 1].end < opts.minKeep) continue
    spaced.push(r)
  }
  return spaced.filter(r => !(r.start <= 0 && r.end >= total))
}
