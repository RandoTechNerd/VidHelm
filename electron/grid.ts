/**
 * Snap cuts and tag points onto a musical grid.
 *
 * `make_score` fits a tempo TO the cuts; this is the other direction, from the
 * CruxStudy teaser build: every scene length was rounded to whole bars and the
 * drop word was slid onto a bar line, and that is why the drops landed. Here
 * the grid is derived from (or given) a BPM, and each join between two clips
 * is ROLLED onto the nearest line: the left clip gets longer or shorter, the
 * right clip's in-point slides the same amount, nothing downstream moves and
 * the total runtime is unchanged. Tag points snap independently, so a hit
 * that was "about here" becomes exactly on the bar.
 *
 * Nothing is ever moved further than `tolerance`, and a roll that would leave
 * a clip shorter than `minClip` or run off the start of its source is skipped
 * and reported rather than done.
 *
 * Pure module: no I/O, no Electron.
 */

export interface GridClip {
  id: string
  trackId: string
  start: number
  duration: number
  sourceStart: number
  /** length of the source media, if known; lets an out-point extend, not only shrink */
  sourceDuration?: number
}

export interface GridMarker { id: string; t: number }

export type Division = 'bar' | 'half' | 'beat'

export interface GridOpts {
  bpm: number
  /** grid origin, seconds; defaults to the first clip start on the snapped tracks */
  phase?: number
  /** where cuts snap to (default beat) */
  cutDivision?: Division
  /** where tag points snap to (default bar) */
  tagDivision?: Division
  /** furthest a cut may move, seconds; default half of the cut step */
  tolerance?: number
  /** furthest a tag may move; default half of the tag step */
  tagTolerance?: number
  /** which tracks hold picture; default v1 and v2 */
  tracks?: string[]
  /** a clip may not end up shorter than this, seconds */
  minClip?: number
  snapCuts?: boolean
  snapTags?: boolean
}

export interface GridMove { kind: 'cut' | 'tag'; id: string; from: number; to: number; delta: number }
export interface GridSkip { kind: 'cut' | 'tag'; id: string; at: number; reason: string }

export interface GridResult {
  clips: GridClip[]
  markers: GridMarker[]
  moves: GridMove[]
  skipped: GridSkip[]
  bpm: number
  phase: number
  cutStep: number
  tagStep: number
}

const stepFor = (bpm: number, div: Division): number => {
  const beat = 60 / bpm
  return div === 'bar' ? beat * 4 : div === 'half' ? beat * 2 : beat
}

/** Nearest grid line to t. */
export function nearestLine(t: number, step: number, phase: number): number {
  return phase + Math.round((t - phase) / step) * step
}

const r3 = (v: number) => +v.toFixed(3)

export function snapToGrid(clipsIn: GridClip[], markersIn: GridMarker[], opts: GridOpts): GridResult {
  const bpm = opts.bpm > 0 ? opts.bpm : 120
  const tracks = opts.tracks ?? ['v1', 'v2']
  const cutStep = stepFor(bpm, opts.cutDivision ?? 'beat')
  const tagStep = stepFor(bpm, opts.tagDivision ?? 'bar')
  const tol = opts.tolerance ?? cutStep / 2
  const tagTol = opts.tagTolerance ?? tagStep / 2
  const minClip = opts.minClip ?? 0.25
  const clips = clipsIn.map(c => ({ ...c }))
  const markers = markersIn.map(m => ({ ...m }))
  const moves: GridMove[] = []
  const skipped: GridSkip[] = []

  const picture = clips.filter(c => tracks.includes(c.trackId))
  const phase = opts.phase ?? (picture.length ? Math.min(...picture.map(c => c.start)) : 0)

  if (opts.snapCuts !== false) {
    for (const track of tracks) {
      const row = clips.filter(c => c.trackId === track).sort((a, b) => a.start - b.start)
      for (let i = 0; i < row.length; i++) {
        const b = row[i]
        const a = i > 0 ? row[i - 1] : null
        const touching = a ? Math.abs(a.start + a.duration - b.start) < 0.02 : false
        const at = b.start
        // the first clip on a track is the grid's own origin when phase was not given
        if (!a && Math.abs(at - phase) < 1e-6) continue
        const target = nearestLine(at, cutStep, phase)
        const delta = target - at
        if (Math.abs(delta) < 0.002) continue
        if (Math.abs(delta) > tol + 1e-9) { skipped.push({ kind: 'cut', id: b.id, at: r3(at), reason: `nearest line is ${Math.abs(delta).toFixed(2)}s away, past tolerance` }); continue }
        if (b.duration - delta < minClip) { skipped.push({ kind: 'cut', id: b.id, at: r3(at), reason: 'would leave the right-hand clip too short' }); continue }
        if (b.sourceStart + delta < 0) { skipped.push({ kind: 'cut', id: b.id, at: r3(at), reason: 'right-hand clip has no earlier source to reveal' }); continue }
        if (touching && a && a.duration + delta < minClip) { skipped.push({ kind: 'cut', id: b.id, at: r3(at), reason: 'would leave the left-hand clip too short' }); continue }
        if (touching && a && delta > 0 && a.sourceDuration != null && a.sourceStart + a.duration + delta > a.sourceDuration + 1e-6) {
          skipped.push({ kind: 'cut', id: b.id, at: r3(at), reason: 'left-hand clip has no more source to extend into' }); continue
        }
        // roll: left grows/shrinks, right slides its in-point, its end stays put
        if (touching && a) a.duration = r3(a.duration + delta)
        b.start = r3(b.start + delta)
        b.sourceStart = r3(b.sourceStart + delta)
        b.duration = r3(b.duration - delta)
        moves.push({ kind: 'cut', id: b.id, from: r3(at), to: r3(target), delta: r3(delta) })
      }
      // the final out-point on the track
      const last = row[row.length - 1]
      if (last) {
        const end = last.start + last.duration
        const target = nearestLine(end, cutStep, phase)
        const delta = target - end
        if (Math.abs(delta) >= 0.002 && Math.abs(delta) <= tol + 1e-9) {
          const canExtend = delta <= 0 || (last.sourceDuration != null && last.sourceStart + last.duration + delta <= last.sourceDuration + 1e-6)
          if (!canExtend) skipped.push({ kind: 'cut', id: last.id, at: r3(end), reason: 'out-point cannot extend past the end of its source' })
          else if (last.duration + delta < minClip) skipped.push({ kind: 'cut', id: last.id, at: r3(end), reason: 'would leave the last clip too short' })
          else { last.duration = r3(last.duration + delta); moves.push({ kind: 'cut', id: last.id, from: r3(end), to: r3(target), delta: r3(delta) }) }
        }
      }
    }
  }

  if (opts.snapTags !== false) {
    for (const m of markers) {
      const target = nearestLine(m.t, tagStep, phase)
      const delta = target - m.t
      if (Math.abs(delta) < 0.002) continue
      if (Math.abs(delta) > tagTol + 1e-9) { skipped.push({ kind: 'tag', id: m.id, at: r3(m.t), reason: `nearest bar line is ${Math.abs(delta).toFixed(2)}s away, past tolerance` }); continue }
      moves.push({ kind: 'tag', id: m.id, from: r3(m.t), to: r3(target), delta: r3(delta) })
      m.t = r3(target)
    }
  }

  return { clips, markers, moves, skipped, bpm, phase: r3(phase), cutStep: r3(cutStep), tagStep: r3(tagStep) }
}

/** Human summary for the agent's reply. */
export function describeSnap(r: GridResult): string {
  const cuts = r.moves.filter(m => m.kind === 'cut'), tags = r.moves.filter(m => m.kind === 'tag')
  const worst = r.moves.reduce((w, m) => Math.max(w, Math.abs(m.delta)), 0)
  const parts = [`${r.bpm} BPM grid from ${r.phase}s`]
  parts.push(cuts.length ? `${cuts.length} cut${cuts.length === 1 ? '' : 's'} rolled onto the beat` : 'no cuts needed moving')
  parts.push(tags.length ? `${tags.length} tag${tags.length === 1 ? '' : 's'} slid onto a bar line` : 'no tags needed moving')
  if (worst) parts.push(`largest move ${worst.toFixed(3)}s`)
  if (r.skipped.length) parts.push(`${r.skipped.length} left alone (see skipped)`)
  return parts.join('; ')
}
