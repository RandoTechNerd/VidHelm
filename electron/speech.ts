// Precise speech boundaries: where a cut should actually land.
//
// The problem this exists to solve, in the user's words: you ask for
//   "Check out this portable espresso maker."
// and you get
//   "Check out this portable espresso maker and this..."
// because the cut was placed at a segment edge instead of at the end of the thought. Whisper
// hands back segments that run on past the sentence, and its word times are approximate, so
// trusting either one directly clips words or leaves half of the next clause hanging.
//
// Three separate jobs, kept apart so each can be tested on its own:
//   1. find the phrase somebody asked for, tolerating transcription slips
//   2. decide which word the thought really ends on (drop a dangling "and this")
//   3. turn a word index into a timestamp that neither clips the word nor runs into the next one
//
// No Electron or DOM imports, so `npm run test:speech` can exercise it standalone. Audio-level
// refinement of the chosen timestamp lives in main.ts (it needs ffmpeg), but the decision it
// makes from an RMS envelope is `refineFromEnvelope` here, so it is testable too.

import { normalizeLine, wordsOf } from './takes'

export interface Word { start: number; end: number; text: string }

export interface Span {
  startIdx: number
  endIdx: number      // inclusive
  start: number       // seconds
  end: number         // seconds
  text: string
}

/**
 * Words that start a clause the speaker never finished. A cut that keeps these reads as a
 * mistake: "...espresso maker and this" sounds like the file got truncated.
 *
 * Only ever used to look BACKWARDS from the end of a kept span, and only when the run they
 * begin is short and unpunctuated, so a real sentence ending in "that" survives.
 */
const CLAUSE_STARTERS = new Set([
  'and', 'so', 'but', 'or', 'because', 'cause', 'cuz', 'then', 'plus', 'also', 'which',
  'while', 'though', 'although', 'however', 'anyway', 'anyways', 'now', 'well',
])

/** Noise at the end of a line: never worth keeping, whatever precedes them. */
const TRAILING_FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'erm', 'ah', 'ahh', 'hmm', 'mm', 'like', 'yeah'])

/**
 * Words that cannot end a finished thought, so a span ending on one is still mid-sentence.
 *
 * Deliberately narrow: articles, prepositions, conjunctions and possessives only. Pronouns and
 * demonstratives are NOT here, because "I really like that" and "yes it is" are finished
 * sentences and Whisper often leaves the full stop off.
 */
const NEVER_LAST = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'my', 'your', 'our', 'their',
  'and', 'but', 'so', 'or', 'if', 'as', 'into', 'from', 'about', 'than',
])

const clean = (s: string) => normalizeLine(s)
const endsSentence = (s: string) => /[.!?]["')\]]?\s*$/.test((s || '').trim())

// ---------------------------------------------------------------------------
// 1. finding a phrase
// ---------------------------------------------------------------------------

/** Longest common subsequence length of two token lists. Small inputs, so the plain DP is fine. */
function lcs(a: string[], b: string[]): number {
  const prev = new Array(b.length + 1).fill(0)
  const cur = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    cur[0] = 0
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]
  }
  return prev[b.length]
}

export interface FindPhraseOptions {
  /** 0..1 of the query's words that must line up before a match counts. Default 0.7. */
  minScore?: number
  /** only look at words at or after this time */
  after?: number
  /** only look at words at or before this time */
  before?: number
}

/**
 * Find where a phrase was spoken. Tolerant on purpose: Whisper writes "expresso", drops "the",
 * and splits "USB-C" into two words, so an exact search finds nothing on real footage.
 *
 * Scores every window of a plausible length by how much of the query appears in it, in order,
 * and prefers the tightest window when several score the same (so asking for a short line does
 * not match a paragraph containing it).
 */
export function findPhrase(words: Word[], query: string, opts: FindPhraseOptions = {}): Span | null {
  const q = wordsOf(query)
  if (!q.length || !words.length) return null
  const minScore = opts.minScore ?? 0.7

  const lo = opts.after != null ? words.findIndex(w => w.end >= opts.after!) : 0
  const hiRaw = opts.before != null ? words.findIndex(w => w.start > opts.before!) : -1
  const hi = hiRaw === -1 ? words.length - 1 : Math.max(lo, hiRaw - 1)
  if (lo < 0 || lo > hi) return null

  const norm = words.map(w => clean(w.text))
  const minLen = Math.max(1, Math.floor(q.length * 0.6))
  const maxLen = Math.ceil(q.length * 1.8) + 2

  let best: Span | null = null
  let bestScore = 0
  for (let i = lo; i <= hi; i++) {
    // a window can only start on a word that appears in the query, which cuts the search hard
    if (!q.includes(norm[i]) && norm[i] !== '') continue
    for (let len = minLen; len <= maxLen && i + len - 1 <= hi; len++) {
      const window = norm.slice(i, i + len).filter(Boolean)
      if (!window.length) continue
      const matched = lcs(q, window)
      // reward covering the query, penalise padding the window with words nobody asked for
      const coverage = matched / q.length
      const density = matched / window.length
      const score = coverage * 0.75 + density * 0.25
      if (coverage >= minScore && score > bestScore + 1e-9) {
        bestScore = score
        const endIdx = i + len - 1
        best = {
          startIdx: i, endIdx,
          start: words[i].start, end: words[endIdx].end,
          text: words.slice(i, endIdx + 1).map(w => w.text.trim()).join(' '),
        }
      }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// 2. where the thought actually ends
// ---------------------------------------------------------------------------

export interface TrimOptions {
  /** how many trailing words an abandoned clause may be before we stop assuming it is one */
  maxDangle?: number
}

/**
 * Walk back from `endIdx` to the last word that finishes a thought.
 *
 * Trims, in order:
 *   - trailing fillers ("um", "like")
 *   - an unpunctuated run of up to maxDangle words that begins with a clause starter
 *     ("...espresso maker" + "and this")
 *   - a final word that cannot end a sentence ("...and this" -> "...and", then the run rule)
 *
 * Never trims past the halfway point of the span, and never returns less than startIdx: a
 * short line made entirely of these words is left alone rather than deleted.
 */
export function trimTrailingDangle(words: Word[], startIdx: number, endIdx: number, opts: TrimOptions = {}): number {
  const maxDangle = opts.maxDangle ?? 3
  if (endIdx <= startIdx) return endIdx
  const floor = startIdx + Math.floor((endIdx - startIdx) / 2)
  let end = endIdx

  const strip = () => {
    while (end > floor && TRAILING_FILLERS.has(clean(words[end].text)) && !endsSentence(words[end].text)) end--
  }

  strip()
  // a run that starts with "and"/"so"/"but" and never lands
  for (let guard = 0; guard < 3; guard++) {
    if (end <= floor || endsSentence(words[end].text)) break
    let found = -1
    for (let k = end; k > end - maxDangle && k > floor; k--) {
      if (endsSentence(words[k - 1]?.text || '')) break   // the previous word closed a sentence: stop
      if (CLAUSE_STARTERS.has(clean(words[k].text))) { found = k; break }
    }
    if (found < 0) break
    end = found - 1
    strip()
  }
  // a dangling preposition/article/pronoun left at the end
  while (end > floor && !endsSentence(words[end].text) && NEVER_LAST.has(clean(words[end].text))) end--
  strip()

  return Math.max(startIdx, end)
}

/**
 * Split words into sentences, using punctuation where Whisper produced it and a real pause
 * where it did not. This is what b-roll placement matches against: an insert should cover a
 * whole thought, never start halfway through one.
 */
export function sentenceSpans(words: Word[], opts: { pauseGap?: number; maxWords?: number } = {}): Span[] {
  const pauseGap = opts.pauseGap ?? 0.55
  const maxWords = opts.maxWords ?? 26
  const out: Span[] = []
  let startIdx = -1
  for (let i = 0; i < words.length; i++) {
    if (!(words[i].text || '').trim()) continue
    if (startIdx < 0) startIdx = i
    const next = words[i + 1]
    const gap = next ? next.start - words[i].end : Infinity
    const long = i - startIdx + 1 >= maxWords
    if (endsSentence(words[i].text) || gap > pauseGap || long || !next) {
      out.push({
        startIdx, endIdx: i,
        start: words[startIdx].start, end: words[i].end,
        text: words.slice(startIdx, i + 1).map(w => w.text.trim()).join(' '),
      })
      startIdx = -1
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 3. word index -> timestamp
// ---------------------------------------------------------------------------

export interface BoundaryOptions {
  /** seconds of release kept after the last word so it is not clipped. Default 0.12. */
  tail?: number
  /** never come closer than this to the next word's start. Default 0.05. */
  guard?: number
  /** seconds of run-up kept before the first word. Default 0.10. */
  lead?: number
}

/**
 * Timestamp for a cut AFTER `idx`. Keeps the word's release, stops short of the next word, and
 * splits the difference when the gap is tight rather than picking one side and clipping.
 */
export function cutAfter(words: Word[], idx: number, opts: BoundaryOptions = {}): number {
  const tail = opts.tail ?? 0.12
  const guard = opts.guard ?? 0.05
  const w = words[idx]
  if (!w) return 0
  const next = words[idx + 1]
  if (!next) return +(w.end + tail).toFixed(3)
  const gap = next.start - w.end
  if (gap <= 0) return +w.end.toFixed(3)
  if (gap < tail + guard) return +(w.end + gap * 0.5).toFixed(3)   // tight: land mid-gap
  return +Math.min(w.end + tail, next.start - guard).toFixed(3)
}

/** Timestamp for a cut BEFORE `idx`, with a little run-up so the first consonant survives. */
export function cutBefore(words: Word[], idx: number, opts: BoundaryOptions = {}): number {
  const lead = opts.lead ?? 0.10
  const guard = opts.guard ?? 0.05
  const w = words[idx]
  if (!w) return 0
  const prev = words[idx - 1]
  if (!prev) return +Math.max(0, w.start - lead).toFixed(3)
  const gap = w.start - prev.end
  if (gap <= 0) return +w.start.toFixed(3)
  if (gap < lead + guard) return +(w.start - gap * 0.5).toFixed(3)
  return +Math.max(prev.end + guard, w.start - lead).toFixed(3)
}

/**
 * The whole job in one call: find the phrase, drop whatever dangles off the end of it, and hand
 * back in/out points that will not clip a word.
 */
export function spanForPhrase(words: Word[], query: string, opts: FindPhraseOptions & BoundaryOptions & TrimOptions = {}):
  (Span & { cutIn: number; cutOut: number; trimmed: string }) | null {
  const hit = findPhrase(words, query, opts)
  if (!hit) return null
  const endIdx = trimTrailingDangle(words, hit.startIdx, hit.endIdx, opts)
  return {
    ...hit,
    endIdx,
    end: words[endIdx].end,
    cutIn: cutBefore(words, hit.startIdx, opts),
    cutOut: cutAfter(words, endIdx, opts),
    trimmed: words.slice(hit.startIdx, endIdx + 1).map(w => w.text.trim()).join(' '),
  }
}

// ---------------------------------------------------------------------------
// audio-level refinement
// ---------------------------------------------------------------------------

export interface Envelope {
  /** RMS per frame, linear 0..1 */
  rms: number[]
  /** seconds covered by one frame */
  step: number
  /** timeline time of rms[0] */
  t0: number
}

/**
 * Whisper's word times are good to roughly a tenth of a second, which is exactly the scale at
 * which a clipped consonant or a half-second of dead air is audible. Given the real waveform
 * around a proposed cut, move it to the nearest edge of silence.
 *
 * `dir` 'after' looks for where speech stops at or after the estimate; 'before' looks for where
 * speech starts at or before it. Returns the estimate untouched when the window is all speech
 * or all silence, which is the honest answer: there is no edge to snap to.
 */
export function refineFromEnvelope(env: Envelope, estimate: number, dir: 'after' | 'before', opts: { floorDb?: number; searchSec?: number; holdSec?: number } = {}): number {
  const floor = Math.pow(10, (opts.floorDb ?? -34) / 20)
  const search = opts.searchSec ?? 0.35
  const hold = opts.holdSec ?? 0.05
  const { rms, step, t0 } = env
  if (!rms.length || step <= 0) return estimate
  const holdFrames = Math.max(1, Math.round(hold / step))
  const idxOf = (t: number) => Math.round((t - t0) / step)
  const timeOf = (i: number) => +(t0 + i * step).toFixed(3)

  const centre = idxOf(estimate)
  const lo = Math.max(0, idxOf(estimate - search))
  const hi = Math.min(rms.length - 1, idxOf(estimate + search))
  if (hi <= lo) return estimate

  const quiet = (i: number) => (rms[i] ?? 0) < floor
  const quietRun = (i: number) => {
    for (let k = i; k < i + holdFrames; k++) if (k > hi || !quiet(k)) return false
    return true
  }

  const startsQuiet = quietRun(Math.max(lo, Math.min(centre, hi - holdFrames)))

  if (dir === 'after') {
    if (startsQuiet) {
      // already past the end of speech: back up to where the silence began, so the cut does
      // not leave dead air hanging off the line
      let i = centre
      while (i > lo && quiet(i - 1)) i--
      return i <= lo ? estimate : timeOf(i)   // all quiet across the window: no edge to snap to
    }
    for (let i = centre; i <= hi - holdFrames; i++) if (quietRun(i)) return timeOf(i)
    return estimate
  }

  // 'before': land on the last quiet frame before speech starts
  if (startsQuiet) {
    let i = centre
    while (i < hi && quiet(i + 1)) i++
    return i >= hi ? estimate : timeOf(i)
  }
  let i = centre
  while (i > lo && !quiet(i)) i--
  return i <= lo ? estimate : timeOf(i)
}
