// Where to cut long audio into Whisper's 30 second windows, and how to put words back together.
//
// Whisper hears 30 seconds at a time. Cutting the audio every 30 seconds exactly lands mid-word
// nearly every time, and the word cut in half comes back garbled, twice, or not at all; the old
// fix (overlap 1.5 s, then drop a word whose TEXT matched one already heard) missed every case where
// the two halves were heard differently. So a window now ends in the quietest moment of its last
// few seconds, where no word is being spoken. Only when there is no quiet moment (a loud music bed,
// nonstop talk) do two windows overlap, and then words are kept by TIME. Measured against the
// script of a 2 minute voiceover: every error at a seam went (a dropped "has" and "you're", a
// mangled "Math Blitz"), tiny went from 9.3% to 7.3% of words wrong and base from 8.2% to 6.8% over
// a music bed, and what is left is mostly brand names the model has never heard.
//
// Whisper's word timestamps also split one written word into pieces ("five" "-star", "$9" ".99",
// "Crux" "-Sci"); a piece with no leading space belongs to the word before it.
//
// No Electron imports, so `npm run test:asr` can exercise it on synthetic envelopes.

/** Frame length of the loudness envelope, in seconds. */
export const ENV_STEP = 0.01

/** Mean square level per 10 ms frame of mono PCM: cheap, and enough to find the gaps between words. */
export function energyEnvelope(pcm: Float32Array, sr: number, step = ENV_STEP): Float32Array {
  const hop = Math.max(1, Math.round(sr * step))
  const n = Math.floor(pcm.length / hop)
  const env = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    let q = 0
    for (let k = f * hop, end = k + hop; k < end; k++) q += pcm[k] * pcm[k]
    env[f] = q / hop
  }
  return env
}

/** Level of a stretch of the envelope in dBFS (mean square, so 0 dB is a full-scale square wave). */
export function levelDb(env: ArrayLike<number>, from: number, to: number, step = ENV_STEP): number {
  const a = Math.max(0, Math.floor(from / step)), b = Math.min(env.length, Math.max(a + 1, Math.ceil(to / step)))
  let q = 0, n = 0
  for (let i = a; i < b; i++) { q += env[i]; n++ }
  return 10 * Math.log10((n ? q / n : 0) + 1e-12)
}

export interface WindowOptions {
  /** Whisper's window: audio past this is cut off by the model, so no window may be longer */
  maxSec?: number
  /** a window ends somewhere in [from + earliest, from + latest] */
  earliest?: number
  latest?: number
  /** length of the quiet stretch looked for */
  gapSec?: number
  /** how far under the window's median level a gap must be to cut in it */
  quietDb?: number
  /** a gap this quiet is always fine to cut in, whatever the median (digital silence, room tone) */
  silentDb?: number
  /** audio heard past the cut when there is no gap, so the word on the seam is heard whole */
  overlapSec?: number
}

export interface AsrWindow {
  /** audio slice to transcribe, in seconds */
  start: number
  end: number
  /** where this window's words stop counting; the next window takes over from here */
  cut: number
  /** cut in a real gap, so nothing is spoken across it and no overlap is needed */
  quiet: boolean
}

/**
 * The next window starting at `from`. Ends at the quietest 200 ms between 24 and 29 seconds in
 * (29, not 30, so a window that has to overlap still fits in Whisper's 30). A gap 6 dB under the
 * window's median level, or under -50 dBFS, is a real pause: the window ends there. Otherwise the
 * window runs on a second past the cut and the seam is settled by time (resumeAt).
 */
export function nextWindow(env: ArrayLike<number>, from: number, total: number, opts: WindowOptions = {}): AsrWindow {
  const maxSec = opts.maxSec ?? 30, earliest = opts.earliest ?? 24, latest = opts.latest ?? 29
  const gap = opts.gapSec ?? 0.2, quietDb = opts.quietDb ?? 6, silentDb = opts.silentDb ?? -50
  const overlap = opts.overlapSec ?? 1.0
  if (total - from <= maxSec) return { start: from, end: total, cut: total, quiet: true }

  const f0 = Math.round(from / ENV_STEP)
  const lo = Math.round((from + earliest) / ENV_STEP), hi = Math.round((from + latest - gap) / ENV_STEP)
  const g = Math.max(1, Math.round(gap / ENV_STEP))
  // sliding sum over the gap length; ties go to the later gap (fewer, longer windows)
  let sum = 0
  for (let i = lo; i < lo + g; i++) sum += env[i] ?? 0
  let best = lo, bestSum = sum
  for (let i = lo + 1; i <= hi; i++) {
    sum += (env[i + g - 1] ?? 0) - (env[i - 1] ?? 0)
    if (sum <= bestSum + 1e-15) { best = i; bestSum = sum }
  }
  const cut = +((best + g / 2) * ENV_STEP).toFixed(3)
  const gapDb = 10 * Math.log10(bestSum / g + 1e-12)
  const levels = Array.from({ length: Math.round(maxSec / ENV_STEP) }, (_, k) => env[f0 + k] ?? 0).sort((a, b) => a - b)
  const medianDb = 10 * Math.log10(levels[Math.floor(levels.length / 2)] + 1e-12)
  const quiet = gapDb <= medianDb - quietDb || gapDb <= silentDb
  return quiet
    ? { start: from, end: cut, cut, quiet }
    : { start: from, end: Math.min(cut + overlap, from + maxSec), cut, quiet }
}

/**
 * After an overlapping window: where the next one should start. A word (or phrase) that began
 * before the cut and ran across it is heard again, whole, by the next window, so this is the start
 * of the earliest piece crossing the cut, or the cut itself when nothing crosses it.
 *
 * Unless that piece began before `floor`: going back that far would have the next window redo most
 * of this one, and a stretched timestamp could send it backwards forever. Such a piece (a long
 * phrase-mode line, a word whose timestamp Whisper stretched) is kept whole here instead and the
 * next window starts where it ends. Never both: keeping a 7 s line whole AND resuming at the floor
 * had the next window hear its last 5 s again, two stacked captions saying the same sentence.
 */
export function resumeAt(pieces: { start: number; end: number }[], cut: number, floor = 0): number {
  const across = pieces.filter(p => p.start < cut && p.end > cut + 0.02)
  if (!across.length) return cut
  const first = Math.min(...across.map(p => p.start))
  return +(first >= floor ? first : Math.max(...across.map(p => p.end))).toFixed(3)
}

export interface Span { start: number; end: number }
/** Where one window handed over to the next: `next` is where the next window's words count from, and it starts `runUp` earlier. */
export interface Seam { next: number; runUp: number }

/** How far back from a cut with no pause the next window may start, to hear the word on the seam whole. */
const MAX_REHEAR = 5
/** The next window starts this much before `next`, so its first word is heard from its onset. */
const RUN_UP = 0.15

/**
 * One window's transcript settled against both its seams. `prev` is the seam it started from:
 * after an overlap it began a run-up early, and anything it heard ending inside that run-up is the
 * tail of a word the last window already kept. Returns what counts from this window, where the next
 * one takes over, and whether this was the last.
 */
export function settleSeam<T extends Span>(items: T[], w: AsrWindow, total: number, prev?: Seam): Seam & { keep: T[]; last: boolean } {
  const heard = prev?.runUp ? items.filter(it => it.end > prev.next + 0.05) : items
  if (w.end >= total - 1e-6) return { keep: heard, next: total, runUp: 0, last: true }
  // A cut in a pause keeps everything before it. Without a pause, a word that crossed the cut is
  // dropped here and heard again, whole, at the start of the next window (resumeAt).
  const next = w.quiet ? w.cut : Math.min(w.end, resumeAt(heard, w.cut, w.cut - MAX_REHEAR))
  // The run-up is for the onset of the word the next window starts on. A line kept whole that ran
  // off the end of this window has none there, only the rest of a word this window already heard:
  // starting early would hear that word twice.
  const runUp = w.quiet || next >= w.end - 1e-6 ? 0 : Math.min(RUN_UP, next - w.start)
  return { keep: heard.filter(it => it.start < next), next, runUp, last: false }
}

/**
 * Long audio through Whisper, window by window. `hear` transcribes one window and returns what it
 * heard in timeline seconds (words or lines); the seams are settled here rather than in the IPC
 * handler, so `npm run test:asr` walks the same bookkeeping the app does. `progress` gets the
 * seconds done after each window. Returned in time order.
 */
export async function transcribeWindows<T extends Span>(env: ArrayLike<number>, total: number, hear: (w: AsrWindow) => Promise<T[]>, progress?: (doneSec: number) => void): Promise<T[]> {
  const out: T[] = []
  let from = 0, seam: Seam | undefined
  for (let guard = 0; from < total - 0.2 && guard < 100000; guard++) {
    const w = nextWindow(env, from, total)
    const s = settleSeam(await hear(w), w, total, seam)
    out.push(...s.keep)
    progress?.(s.next)
    if (s.last) break
    seam = s
    from = s.next - s.runUp
  }
  return out.sort((a, b) => a.start - b.start)
}

/** A piece as Whisper returns it, already moved to timeline seconds. `raw` keeps its leading space. */
export interface RawPiece { start: number; end: number; raw: string }
export interface Word { start: number; end: number; text: string }

/** Scripts written without spaces between words: every piece lacks a leading space, so joining would fuse whole sentences. */
const UNSPACED_LANGS = new Set(['zh', 'ja', 'th', 'lo', 'my', 'km', 'bo', 'yue'])
/** Nothing a caption can show: punctuation, dashes, music notes. `$` stays (a price is coming). */
const NOT_A_WORD = /^[^\p{L}\p{N}$]+$/u
const MUSIC = /^[\s♪♫♬♩]+$/u

/**
 * One window's word pieces back into words. A piece with no leading space continues the word
 * before it ("five" + "-star" = "five-star", "$9" + ".99", "Crux" + "-Sci"), and its end time
 * becomes the word's. Punctuation that cannot attach to a word is dropped, so a lone "-" or "..."
 * is never a caption. Run per window: the first piece of a new window starts a new word.
 *
 * Languages without spaces are left as pieces, and so is a window where the pieces with letters in
 * them mostly have no leading space (Auto-detect heard such a language): joining there would make
 * one "word" of a whole line. Their punctuation still attaches to the piece before it.
 */
export function mergeWordPieces(pieces: RawPiece[], lang = 'en'): Word[] {
  const lettered = pieces.filter(p => /\p{L}/u.test(p.raw))
  const spaced = lettered.filter(p => /^\s/.test(p.raw)).length
  const join = !UNSPACED_LANGS.has(lang.toLowerCase().split('-')[0]) && !(lettered.length >= 2 && spaced * 3 < lettered.length)
  const out: Word[] = []
  for (const p of pieces) {
    const text = p.raw.trim()
    if (!text || MUSIC.test(text)) continue
    const prev = out[out.length - 1]
    if (prev && !/^\s/.test(p.raw) && (join || NOT_A_WORD.test(text))) {
      prev.text += text
      prev.end = Math.max(prev.end, p.end)
      continue
    }
    if (NOT_A_WORD.test(text)) continue
    out.push({ start: p.start, end: Math.max(p.start, p.end), text })
  }
  return out
}
