// Repeated-take detection: given a transcript of the timeline, find the places where the same
// line was said more than once and work out which attempt to keep.
//
// No Electron or DOM imports on purpose, so `npm run test:takes` can exercise it standalone.
// The renderer owns the timeline surgery; this module only ever returns times and indices.

export interface Chunk { start: number; end: number; text: string }
export interface TakeGroup { members: number[]; keep: number }
export interface GroupOptions {
  /** ignore lines shorter than this many words: "yeah", "okay" repeat constantly and are not takes */
  minWords?: number
  /** 0..1 word-overlap needed to call two lines the same line */
  threshold?: number
  /** a retake follows closely; stop comparing once lines are this far apart in seconds */
  maxGap?: number
  /** how many later lines to compare against, so one long ramble cannot chain the whole video */
  lookahead?: number
}

const DEFAULTS: Required<GroupOptions> = { minWords: 3, threshold: 0.68, maxGap: 30, lookahead: 6 }

// Fillers are noise for matching, but their presence is a mark against a take.
const FILLERS = ['um', 'umm', 'uh', 'uhh', 'erm', 'ah', 'like', 'basically', 'actually']

export const normalizeLine = (s: string): string =>
  (s || '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim()

export const wordsOf = (s: string): string[] => {
  const n = normalizeLine(s)
  return n ? n.split(' ') : []
}

/**
 * Word-overlap similarity, counting repeats (so "the the the" does not match everything).
 * Measured against the shorter line, which is what makes an abandoned half-line match the
 * full one it was a run at.
 */
export function similarity(a: string, b: string): number {
  const wa = wordsOf(a), wb = wordsOf(b)
  if (!wa.length || !wb.length) return 0
  const counts = new Map<string, number>()
  for (const w of wa) counts.set(w, (counts.get(w) || 0) + 1)
  let shared = 0
  for (const w of wb) {
    const left = counts.get(w) || 0
    if (left > 0) { shared++; counts.set(w, left - 1) }
  }
  return shared / Math.min(wa.length, wb.length)
}

/**
 * A false start: the speaker got a few words in, stopped, and began again. The aborted words
 * are a run from the beginning of the good take, so compare in order rather than as a set.
 */
export function isRestart(a: string, b: string): boolean {
  const wa = wordsOf(a), wb = wordsOf(b)
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa]
  if (short.length < 2 || long.length < short.length + 2) return false
  let matched = 0
  for (let i = 0; i < short.length; i++) { if (short[i] === long[i]) matched++; else break }
  return matched / short.length >= 0.7
}

/** Higher is a better take. Length wins, finished sentences help, fillers hurt. */
export function scoreTake(c: Chunk): number {
  const w = wordsOf(c.text)
  let score = Math.min(w.length, 40)
  if (/[.!?]\s*$/.test((c.text || '').trim())) score += 6
  for (const w2 of w) if (FILLERS.includes(w2)) score -= 3
  // trailing "and", "so", "but" reads as a sentence that never landed
  if (/\b(and|so|but|because|the|a|to)$/.test(normalizeLine(c.text))) score -= 5
  return score
}

/**
 * Which member of a group to keep. Best score wins; on a near tie the later take wins, because
 * people say the line again to fix it and then move on.
 */
export function pickBest(chunks: Chunk[], members: number[]): number {
  let best = members[0], bestScore = -Infinity
  for (const i of members) {
    const s = scoreTake(chunks[i]) + members.indexOf(i) * 0.75
    if (s > bestScore) { bestScore = s; best = i }
  }
  return best
}

/** Group lines that are retakes of each other. Only groups of two or more come back. */
export function groupTakes(chunks: Chunk[], opts: GroupOptions = {}): TakeGroup[] {
  const o = { ...DEFAULTS, ...opts }
  const taken = new Set<number>()
  const groups: TakeGroup[] = []
  for (let i = 0; i < chunks.length; i++) {
    if (taken.has(i)) continue
    if (wordsOf(chunks[i].text).length < o.minWords) continue
    const members = [i]
    for (let j = i + 1; j < chunks.length && j <= i + o.lookahead; j++) {
      if (taken.has(j)) continue
      if (wordsOf(chunks[j].text).length < o.minWords) continue
      if (chunks[j].start - chunks[members[members.length - 1]].end > o.maxGap) break
      // compare against every member so a b c chains only when each really matches one of them
      const hit = members.some(m => similarity(chunks[m].text, chunks[j].text) >= o.threshold || isRestart(chunks[m].text, chunks[j].text))
      if (hit) { members.push(j); taken.add(j) }
    }
    if (members.length > 1) { members.forEach(m => taken.add(m)); groups.push({ members, keep: pickBest(chunks, members) }) }
  }
  return groups
}

// ---- building lines out of word timings ----
// Whisper hands back a false start and the retake as ONE segment ("Say hello to VidHelm. Say
// hello to VidHelm, a free and open source editor..."), so phrase segments alone miss the most
// common repeat there is. With word timings we can split the line where the speaker started
// again, and then the ordinary grouping treats the two halves as the takes they are.

export interface Word { start: number; end: number; text: string }

/** Words that match ignoring case and punctuation. */
const sameWord = (a: string, b: string) => normalizeLine(a) === normalizeLine(b)

/**
 * Find an immediately repeated run of words: the speaker says something, stops, and says the
 * same thing again. Returns where the second attempt begins, or -1. Longest run wins, so
 * "say hello to vidhelm say hello to vidhelm" splits after four words, not one.
 */
export function findAdjacentRepeat(words: string[], minRun = 2, maxRun = 8): number {
  for (let k = Math.min(maxRun, Math.floor(words.length / 2)); k >= minRun; k--) {
    for (let i = 0; i + 2 * k <= words.length; i++) {
      let same = 0
      for (let n = 0; n < k; n++) if (sameWord(words[i + n], words[i + k + n])) same++
      if (same / k >= 0.8) return i + k
    }
  }
  return -1
}

/**
 * Turn word timings into transcript lines: break on sentence ends, on a real pause, or once a
 * line gets long, then split any line whose opening the speaker repeated.
 */
export function chunksFromWords(words: Word[], opts: { pauseGap?: number; maxWords?: number } = {}): Chunk[] {
  const pauseGap = opts.pauseGap ?? 0.6
  const maxWords = opts.maxWords ?? 18
  const lines: Word[][] = []
  let cur: Word[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (!(w.text || '').trim()) continue
    cur.push(w)
    const next = words[i + 1]
    const ended = /[.!?]["')\]]?\s*$/.test(w.text.trim())
    const gap = next ? next.start - w.end : Infinity
    if (ended || gap > pauseGap || cur.length >= maxWords) { lines.push(cur); cur = [] }
  }
  if (cur.length) lines.push(cur)

  const out: Chunk[] = []
  for (const line of lines) {
    // keep splitting while the line still contains a restart
    let rest = line
    for (let guard = 0; guard < 4; guard++) {
      const at = findAdjacentRepeat(rest.map(w => w.text))
      if (at <= 0 || at >= rest.length) break
      const head = rest.slice(0, at)
      out.push({ start: head[0].start, end: head[head.length - 1].end, text: head.map(w => w.text.trim()).join(' ') })
      rest = rest.slice(at)
    }
    if (rest.length) out.push({ start: rest[0].start, end: rest[rest.length - 1].end, text: rest.map(w => w.text.trim()).join(' ') })
  }
  return out
}

/**
 * Timeline ranges to cut: every grouped line that is not the keeper, plus anything dropped by
 * hand. Sorted, merged when they nearly touch, and slivers dropped, the same shape Cut Pauses
 * feeds to the ripple.
 */
export function removalRanges(chunks: Chunk[], groups: TakeGroup[], manualDrops: number[] = []): { start: number; end: number }[] {
  const idx = new Set<number>(manualDrops)
  for (const g of groups) for (const m of g.members) if (m !== g.keep) idx.add(m)
  const ranges = [...idx]
    .filter(i => chunks[i])
    .map(i => ({ start: chunks[i].start, end: chunks[i].end }))
    .filter(r => r.end - r.start > 0.12)
    .sort((a, b) => a.start - b.start)
  const merged: { start: number; end: number }[] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.start - last.end <= 0.4) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  return merged
}

/** Seconds the given selection would remove. */
export const removedSeconds = (ranges: { start: number; end: number }[]): number =>
  +ranges.reduce((sum, r) => sum + (r.end - r.start), 0).toFixed(2)
