// Walking a whole video and handing an agent something it can actually read.
//
// The gap this closes: an agent driving VidHelm can hear everything (word-level transcription)
// and measure everything (brightness, motion, onsets), but it has never SEEN the video. So it
// cannot tell you the battery display said 85, that the label warns "not washable", or that the
// thing on the right of frame is a canister rather than the grinder.
//
// A third-party video-analysis service was tested for exactly this. It read the screen correctly,
// and then returned notes with ZERO timestamps in three hundred lines, which makes it useless for
// cutting. The fix is not a better service, it is contact sheets with the time burned into every
// tile, so a description can be attributed to the second it came from.
//
// Pure planning only: `npm run test:visual` needs no ffmpeg.

export interface SheetPlan {
  index: number
  /** timeline/source times of each tile, in order */
  times: number[]
  from: number
  to: number
  cols: number
  rows: number
}

export interface IndexPlan {
  /** every sampled time, across all sheets */
  times: number[]
  sheets: SheetPlan[]
  interval: number
  note: string
}

/**
 * mm:ss for a label, hh:mm:ss once it earns the hour.
 *
 * Truncates rather than rounds, the way video timecode does: a frame grabbed at 770.5s belongs to
 * the second labelled 12:50, and rounding it up to 12:51 would send anyone who scrubbed there
 * looking at the wrong moment.
 */
export function timecode(t: number): string {
  const s = Math.max(0, Math.floor(t))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`
}

export interface PlanOptions {
  /** seconds between samples. Default 8. */
  interval?: number
  /** never take more than this many frames, whatever the interval says. Default 120. */
  maxFrames?: number
  /** tiles per sheet. Default 9 (3x3). */
  perSheet?: number
  cols?: number
  /** skip the first and last moments, which are usually a title card or black */
  edgePad?: number
}

/**
 * Decide what to look at.
 *
 * The interval is widened rather than truncating the video when a clip is long: seeing all of a
 * thirty minute video every twelve seconds is far more useful than seeing the first sixteen
 * minutes every eight and nothing after it. That silent truncation is exactly the failure mode
 * that makes an agent confidently describe a video it only half watched.
 */
export function planVisualIndex(duration: number, opts: PlanOptions = {}): IndexPlan {
  const perSheet = Math.max(1, Math.min(16, Math.round(opts.perSheet ?? 9)))
  const cols = Math.max(1, Math.min(6, Math.round(opts.cols ?? Math.ceil(Math.sqrt(perSheet)))))
  const maxFrames = Math.max(1, Math.round(opts.maxFrames ?? 120))
  const edge = Math.max(0, opts.edgePad ?? 0.5)
  const usable = Math.max(0.1, duration - edge * 2)

  let interval = Math.max(0.5, opts.interval ?? 8)
  let count = Math.floor(usable / interval) + 1
  let widened = false
  if (count > maxFrames) {
    interval = +(usable / (maxFrames - 1)).toFixed(2)
    count = maxFrames
    widened = true
  }

  const times: number[] = []
  for (let i = 0; i < count; i++) {
    const t = +(edge + i * interval).toFixed(2)
    if (t > duration) break
    times.push(t)
  }
  if (!times.length) times.push(+(duration / 2).toFixed(2))

  const sheets: SheetPlan[] = []
  for (let i = 0; i < times.length; i += perSheet) {
    const slice = times.slice(i, i + perSheet)
    sheets.push({
      index: sheets.length,
      times: slice,
      from: slice[0],
      to: slice[slice.length - 1],
      cols: Math.min(cols, slice.length),
      rows: Math.ceil(slice.length / Math.min(cols, slice.length)),
    })
  }

  return {
    times, sheets, interval,
    note: widened
      ? `${times.length} frames every ${interval}s: the interval was widened from ${opts.interval ?? 8}s so the whole video is covered rather than only the first part`
      : `${times.length} frames every ${interval}s`,
  }
}

/**
 * The xstack layout string for a sheet, so tiles land in reading order.
 *
 * Positions are CUMULATIVE SUMS of input dimensions (`w0+w1`), not multiples (`w0*2`).
 * xstack's layout parser has no multiplication: given `w0*2` it does not error, it quietly
 * computes a smaller canvas and CROPS the tiles that fall outside it. A nine-tile sheet came
 * back as a four-tile sheet with five frames silently missing, and the JSON still claimed nine.
 */
export function stackLayout(count: number, cols: number): string {
  const n = Math.max(1, cols)
  return Array.from({ length: count }, (_, i) => {
    const c = i % n
    const r = Math.floor(i / n)
    const x = c === 0 ? '0' : Array.from({ length: c }, (_, k) => `w${k}`).join('+')
    const y = r === 0 ? '0' : Array.from({ length: r }, (_, k) => `h${k}`).join('+')
    return `${x}_${y}`
  }).join('|')
}
