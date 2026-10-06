/* The export as a JOB, not a filtergraph: how far along it is, when it will be done, where it lands,
 * what it must never overwrite and which sound plan the landed file is judged by. Used by electron/main.ts (export-video) and the Export panel in
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

/**
 * What each export's sound was planned to be, by the file the render LANDED in, so Watch & Verify
 * judges a file against the mix it really holds. Filed when the render started, a cancelled or failed
 * re-export left its new plan on the old file it never touched, and that file then failed its
 * loudness check against a mix it does not contain. `key` gives a path its one spelling (main
 * resolves it and lower-cases it, as Windows compares names).
 */
export class LandedPlans<P> {
  private byFile = new Map<string, P>()
  private key: (file: string) => string
  private cap: number
  constructor(key: (file: string) => string = f => f, cap = 50) { this.key = key; this.cap = cap }
  /** The render is in place as `file`: this plan is that file's now. */
  land(file: string, plan: P) {
    const k = this.key(file)
    // filed again counts as newest, so the cap forgets the oldest export and never the one just made
    this.byFile.delete(k)
    this.byFile.set(k, plan)
    while (this.byFile.size > this.cap) this.byFile.delete(this.byFile.keys().next().value as string)
  }
  get(file: string): P | null { return this.byFile.get(this.key(file)) ?? null }
}

/** What a cancelled export throws from inside its own steps (the sound stage checks between them). */
export class ExportCancelled extends Error {
  constructor() { super('the export was cancelled'); this.name = 'ExportCancelled' }
}
export const isExportCancelled = (e: unknown): boolean =>
  e instanceof ExportCancelled || (!!e && typeof e === 'object' && (e as { name?: unknown }).name === 'ExportCancelled')

/** A process the job can stop (a ChildProcess; kept structural so this module needs no Node). */
export interface Killable { kill(signal?: 'SIGKILL'): unknown }

/**
 * One export's Cancel, from its first step to its last. Cancel used to only set a flag and kill the
 * video pass's ffmpeg, which did not exist yet for the whole sound stage (voice bakes, the premaster,
 * up to three master passes: a minute or more on a long timeline) and nothing there looked at the
 * flag, so the click did nothing until the mix had finished. Now:
 *  - every child process the job registers is killed on cancel, and one registered after the cancel
 *    is killed at once (a kill that lands before ffmpeg has started is not lost);
 *  - `check()` between steps throws ExportCancelled;
 *  - `race(p)` lets the export stop waiting for work it shares with others (a voice bake the preview
 *    asked for too, worth finishing for the cache) the moment Cancel is clicked;
 *  - `leftovers` names the files the export makes (the partial render, its work folder, the
 *    premaster), so quitting mid-render can remove them;
 *  - `over` settles when the export has ended, whichever way.
 */
export class ExportJob {
  cancelled = false
  readonly leftovers = new Set<string>()
  readonly over: Promise<void>
  private onCancels = new Set<() => void>()
  private kids = new Map<Killable, () => void>()
  private settle: () => void = () => {}
  constructor() { this.over = new Promise<void>(r => { this.settle = r }) }
  /** Stop: every registered kill runs now. False when it was already cancelled. */
  cancel(): boolean {
    if (this.cancelled) return false
    this.cancelled = true
    const all = [...this.onCancels]
    this.onCancels.clear()
    for (const f of all) { try { f() } catch { /* already gone */ } }
    return true
  }
  /** Throws ExportCancelled once the export is cancelled: call it between steps. */
  check(): void { if (this.cancelled) throw new ExportCancelled() }
  /** `f` runs when the export is cancelled, or right away if it already was. Returns the undo. */
  onCancel(f: () => void): () => void {
    if (this.cancelled) { try { f() } catch { /* already gone */ } return () => {} }
    this.onCancels.add(f)
    return () => { this.onCancels.delete(f) }
  }
  /** The onChild hook of a process this export started (done = it has exited). */
  child(p: Killable, done: boolean): void {
    if (done) { this.kids.get(p)?.(); this.kids.delete(p); return }
    if (this.kids.has(p)) return
    this.kids.set(p, this.onCancel(() => { try { p.kill('SIGKILL') } catch { /* already gone */ } }))
  }
  /** `p`'s result, or ExportCancelled as soon as the export is cancelled (`p` itself carries on, unawaited). */
  race<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const off = this.onCancel(() => reject(new ExportCancelled()))
      p.then(v => { off(); resolve(v) }, e => { off(); reject(e) })
    })
  }
  /** The export has ended (rendered, failed or cancelled). */
  end(): void { this.settle() }
}

/** "1:05" from 65 s, "42s" under a minute. */
export function etaText(s: number): string {
  return s >= 60 ? `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}` : `${Math.ceil(s)}s`
}

export interface ExportView {
  /** null: no export; 0..99.5 running; 100: just finished */
  pct: number | null
  /** what the sound stage is doing, until the video pass reports a position */
  stage?: string | null
  etaS?: number | null
  /** Cancel was clicked and the export has not ended yet */
  stopping?: boolean
}

/**
 * The Export buttons' words (the header's short one and the panel's). Through the sound stage the bar
 * used to sit at "0% · Cancel" for half a minute or more with nothing else moving, which reads as
 * hung; it now says what is being done. A Cancel click is acknowledged at once ("Stopping").
 */
export function exportLabel(v: ExportView, where: 'header' | 'panel'): string {
  const panel = where === 'panel'
  if (v.pct === null) return panel ? 'Export Video' : 'Export'
  if (v.pct >= 100) return 'Done'
  if (v.stopping) return 'Stopping…'
  if (v.stage && !(v.pct > 0)) return panel ? `Cancel (${v.stage})` : 'Mixing sound · Cancel'
  const pct = Math.round(v.pct)
  if (!panel) return `${pct}% · Cancel`
  return `Cancel (${pct}%${v.etaS && v.etaS > 0 ? `, ${etaText(v.etaS)} left` : ''})`
}

/** The default file name: the project's name and the frame shape, without characters Windows refuses in a file name. */
export function exportFileName(project: string | null | undefined, orientation: string): string {
  const clean = (s: string) => Array.from(s, c => (c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c) ? ' ' : c)).join('')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '')
  const name = clean(String(project || '')) || 'video'
  const shape = clean(String(orientation || '')) || 'landscape'
  return `${name}_${shape}.mp4`
}
