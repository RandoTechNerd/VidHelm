/* The export as a JOB, not a filtergraph: how far along it is, when it will be done, where it lands
 * and what it must never overwrite. Used by electron/main.ts (export-video) and the Export panel in
 * src/App.tsx, so it does no I/O and needs no Node: paths are plain strings with either separator.
 * Tests: npm run test:exportjob */

/** ffmpeg's position in the output ("time=00:01:02.50") in seconds; null for N/A or anything else. */
export function timemarkSeconds(mark: unknown): number | null {
  const m = /^(-)?(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(mark ?? '').trim())
  if (!m) return null
  const s = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])
  return m[1] ? 0 : s
}

/**
 * Percent done, from where ffmpeg has got to in the output. fluent-ffmpeg's own percent needs the
 * input's duration, and the first input here is a lavfi colour source it cannot probe, so the bar
 * sat at 0% for the whole render. Capped just under 100: after the last frame the muxer still moves
 * the index to the front of the file (+faststart), which reports no time at all, and a bar parked at
 * 100% for that stretch reads as hung.
 */
export function progressPct(mark: unknown, totalSeconds: number): number | null {
  const s = timemarkSeconds(mark)
  if (s === null || !(totalSeconds > 0)) return null
  return Math.max(0, Math.min(99.5, (s / totalSeconds) * 100))
}

export interface EtaState { at: number; pct: number; rate: number }

/**
 * Time left, from a smoothed rate (percent per second). Elapsed-over-done swings wildly at the start
 * (the first seconds open every input) and sticks at the end; an exponential average of the recent
 * rate settles in a few updates and follows a render that speeds up or slows down.
 */
export function etaStep(prev: EtaState | null, pct: number, nowMs: number): { state: EtaState; secondsLeft: number | null } {
  if (!prev || pct < prev.pct) return { state: { at: nowMs, pct, rate: 0 }, secondsLeft: null }
  const dt = (nowMs - prev.at) / 1000
  const left = (st: EtaState) => (st.rate > 0 ? (100 - pct) / st.rate : null)
  if (dt < 0.2 || pct === prev.pct) return { state: prev, secondsLeft: left(prev) }
  const inst = (pct - prev.pct) / dt
  const rate = prev.rate > 0 ? prev.rate + 0.25 * (inst - prev.rate) : inst
  const state = { at: nowMs, pct, rate }
  return { state, secondsLeft: left(state) }
}

const splitPath = (p: string) => {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const dir = p.slice(0, cut + 1), file = p.slice(cut + 1)
  const dot = file.lastIndexOf('.')
  return dot > 0 ? { dir, stem: file.slice(0, dot), ext: file.slice(dot) } : { dir, stem: file, ext: '' }
}

/**
 * Where a render is written while it runs: beside the target, same extension (the muxer picks its
 * format from it), so finishing is a rename on one disk. The target is untouched until the render
 * has succeeded, so a failed or cancelled export can never leave a half-written file where the last
 * good one was.
 */
export function partialPath(target: string): string {
  const { dir, stem, ext } = splitPath(target)
  return `${dir}${stem}.partial${ext}`
}

/** "talk_landscape_v2.mp4", then _v3 and on: the first that is free. A name that already ends in _vN counts on from N. */
export function nextVersion(target: string, exists: (p: string) => boolean): string {
  const { dir, stem, ext } = splitPath(target)
  const m = /^(.*)_v(\d+)$/.exec(stem)
  const base = m ? m[1] : stem
  for (let n = m ? Number(m[2]) + 1 : 2; n < 10000; n++) {
    const p = `${dir}${base}_v${n}${ext}`
    if (!exists(p)) return p
  }
  return `${dir}${base}_${Date.now()}${ext}`
}

/** The default file name: the project's name and the frame shape, without characters Windows refuses in a file name. */
export function exportFileName(project: string | null | undefined, orientation: string): string {
  const clean = (s: string) => Array.from(s, c => (c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c) ? ' ' : c)).join('')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '')
  const name = clean(String(project || '')) || 'video'
  const shape = clean(String(orientation || '')) || 'landscape'
  return `${name}_${shape}.mp4`
}
