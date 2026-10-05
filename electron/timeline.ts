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
