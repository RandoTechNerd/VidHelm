// The karaoke booth's two ways of recording. Pure, so npm run test:booth checks it without React.
//
// Synced (the default): Record rewinds the video to 0:00, plays it, lights the script lines up in
// time, stops at the end, and the take lands at 0:00 on the voice track, in sync with the picture.
//
// Free record: the video does not move. You record whatever line you like while whatever frame
// you like is on screen (or nothing at all), the script stays up as a prompter you step by hand,
// and the take lands at the playhead as an ordinary audio clip you can drag anywhere. For picking
// up one line, recording a part before its picture exists, or reading without the video driving.

export interface BoothMode { freeRecord: boolean }
export const DEFAULT_BOOTH_MODE: BoothMode = { freeRecord: false }

export const FREE_RECORD_LABEL = 'Free record'
/** The one-line hint under the toggle. */
export const FREE_RECORD_HINT = 'The video stays put while you record. The take lands at the playhead; drag it anywhere.'

export interface TakePlan {
  /** where to put the playhead before recording starts, or null to leave it alone */
  seek: number | null
  /** whether the video plays while the take records */
  play: boolean
  /** where the finished take lands on the voice track, seconds */
  startAt: number
  /** whether the booth stops the take by itself when the playhead reaches the end */
  stopsAtEnd: boolean
  /** the booth's status line while recording */
  status: string
}

const finite = (n: number) => (Number.isFinite(n) ? n : 0)

/** Why Record is refused right now, or null when it may start. Free record needs no timeline. */
export function recordBlocker(freeRecord: boolean, totalDuration: number): string | null {
  if (!freeRecord && !(totalDuration > 0)) return 'Put something on the timeline first, or turn on Free record.'
  return null
}

/** What pressing Record does to the transport, and where the take lands. */
export function planTake(freeRecord: boolean, playhead: number): TakePlan {
  if (freeRecord) {
    // the take goes where the playhead is; a playhead past the end (or garbage) still lands somewhere sane
    const at = Math.max(0, finite(playhead))
    return { seek: null, play: false, startAt: +at.toFixed(3), stopsAtEnd: false, status: `Recording freely, the take will land at ${fmtTime(at)}` }
  }
  return { seek: 0, play: true, startAt: 0, stopsAtEnd: true, status: 'Recording, read along' }
}

/** Synced takes end when the video does; a free take ends only when you press Stop. */
export function shouldAutoStop(freeRecord: boolean, currentTime: number, totalDuration: number): boolean {
  return !freeRecord && totalDuration > 0 && currentTime >= totalDuration - 0.05
}

/** What the Back / Next prompter buttons do outside a recording: synced, they move the playhead
 *  to the line's cue; free, the video stays put and the prompter simply holds that line. */
export function stepHolds(freeRecord: boolean, recording: boolean): boolean {
  return recording || freeRecord
}

/** The agent bridge's freeRecord argument: booleans, 0/1, and the words people type. undefined = not given. */
export function parseFreeRecord(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const s = String(v).trim().toLowerCase()
  if (['true', 'on', 'yes', '1', 'free', 'detached', 'detach'].includes(s)) return true
  if (['false', 'off', 'no', '0', 'synced', 'sync', 'attached', 'attach'].includes(s)) return false
  return undefined
}

function fmtTime(t: number): string {
  const m = Math.floor(t / 60), s = t - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}
