// Matching b-roll to what is being said, and deciding exactly where it cuts in and out.
//
// The shape of the job: the A-roll (you, talking) owns the audio from end to end and is never
// interrupted. B-roll only ever replaces the PICTURE, for a whole thought at a time, and hands
// the picture back before the next thought starts. That is what makes a cutaway read as
// deliberate instead of as a glitch:
//
//   audio   ────────────────────────────────────────────────────────────  (A-roll, untouched)
//   picture ──── A ────┤ b-roll: beans going in ├──── A ──────────────────
//                      ^ cuts in on the first word of the sentence
//                                               ^ cuts out after its last word, before the next
//
// Rules that came out of watching real cuts go wrong, all enforced here:
//   - never start mid-sentence, never end mid-word
//   - never cover the speaker's own reveal (protected ranges)
//   - leave a gap between cutaways, so it does not turn into a slideshow
//   - cap total coverage, because a review where you never see the reviewer is a slideshow too
//   - never loop or stretch an asset to fill time: use less of the timeline instead
//
// Pure functions only: `npm run test:broll` runs it with no app and no ffmpeg.

import { normalizeLine, wordsOf } from './takes'
import type { Span } from './speech'

export interface BrollAsset {
  id: string
  name: string
  path: string
  duration: number
  hasAudio: boolean
  /** what is in it, written by whoever actually looked at the frames */
  labels: string[]
  /** a sentence of description, matched with the same weight as labels */
  description?: string
  /** the usable part of the clip: the steady middle, not the hand reaching for the tripod */
  bestStart?: number
  bestEnd?: number
  /** how many times this one may appear. Default 2. */
  maxUses?: number
}

export interface Placement {
  assetId: string
  name: string
  path: string
  /** timeline window the cutaway occupies */
  start: number
  end: number
  /** where to start reading the asset */
  sourceStart: number
  sentenceIdx: number
  /** the words that earned it the slot, so the report can say why */
  matched: string[]
  score: number
  text: string
}

export interface PlanOptions {
  /** a cutaway shorter than this is a flash frame, not an edit. Default 1.4s. */
  minDuration?: number
  /** longer than this and the viewer wonders where you went. Default 5s. */
  maxDuration?: number
  /** quiet time on the speaker between cutaways. Default 4s. */
  gapBetween?: number
  /** at most this fraction of the runtime may be b-roll. Default 0.35. */
  coverage?: number
  /** leave the opening alone: the viewer needs to see who is talking. Default 8s. */
  protectStart?: number
  /** stretches that must stay on the A-roll (a reveal, a piece to camera, the outro) */
  protect?: { start: number; end: number }[]
  /** how good a match has to be before it is worth cutting away at all. Default 0.34. */
  minScore?: number
  /** total timeline length, for the coverage cap */
  totalDuration?: number
}

const DEFAULTS: Required<Omit<PlanOptions, 'protect' | 'totalDuration'>> = {
  minDuration: 1.4,
  maxDuration: 5,
  gapBetween: 4,
  coverage: 0.35,
  protectStart: 8,
  minScore: 0.34,
}

/** Words that carry no meaning for matching. Kept short on purpose: over-filtering loses nouns. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'so', 'if', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
  'is', 'was', 'are', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'i',
  'you', 'we', 'they', 'he', 'she', 'my', 'your', 'our', 'their', 'me', 'us', 'them', 'here',
  'there', 'just', 'really', 'very', 'like', 'got', 'get', 'go', 'going', 'have', 'has', 'had',
  'do', 'does', 'did', 'can', 'will', 'would', 'not', 'no', 'yes', 'up', 'down', 'out', 'about',
  'what', 'when', 'how', 'now', 'then', 'all', 'some', 'one', 'two', 'thing', 'things', 'know',
])

/**
 * Crude stemmer, deliberately: "grinding" and "grinder" and "grinds" should all match a clip
 * labelled "grind". A real stemmer would also fold "grind" into "grin", which is worse.
 */
export function stem(word: string): string {
  let w = word
  let stripped = true
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3)
  else if (w.length > 4 && w.endsWith('ers')) w = w.slice(0, -3)
  else if (w.length > 4 && w.endsWith('er')) w = w.slice(0, -2)
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2)
  else if (w.length > 3 && w.endsWith('es')) w = w.slice(0, -2)
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
  else stripped = false
  // "stopped" -> "stopp" -> "stop", but only after a suffix actually came off, or "glass"
  // and "burr" lose a letter they never doubled for grammatical reasons
  if (stripped && w.length > 3 && /(.)\1$/.test(w)) w = w.slice(0, -1)
  return w
}

/** Content words of a line, stemmed and de-duplicated. */
export function keywords(text: string): string[] {
  const seen = new Set<string>()
  for (const w of wordsOf(text)) {
    if (STOP.has(w) || w.length < 3) continue
    seen.add(stem(w))
  }
  return [...seen]
}

/**
 * How well an asset fits a line, 0..1, plus the words that earned it.
 *
 * A label that appears as a whole phrase in the line ("coffee beans") counts for more than the
 * same words scattered through it, because the phrase is what the viewer is expecting to see.
 */
export function matchScore(text: string, asset: BrollAsset): { score: number; matched: string[] } {
  const lineWords = keywords(text)
  if (!lineWords.length) return { score: 0, matched: [] }
  const lineSet = new Set(lineWords)
  const lineNorm = ' ' + normalizeLine(text) + ' '

  const labels = [...asset.labels, ...(asset.description ? [asset.description] : [])]
  const matched = new Set<string>()
  let hits = 0
  let phraseBonus = 0
  let labelTerms = 0

  for (const label of labels) {
    const terms = keywords(label)
    labelTerms += terms.length
    let all = terms.length > 0
    for (const t of terms) {
      if (lineSet.has(t)) { hits++; matched.add(t) } else all = false
    }
    // the whole label present as written, e.g. "coffee beans" inside the sentence
    const phrase = normalizeLine(label)
    if (phrase.includes(' ') && lineNorm.includes(' ' + phrase + ' ')) phraseBonus += 0.35
    else if (all && terms.length > 1) phraseBonus += 0.2
  }
  if (!labelTerms) return { score: 0, matched: [] }

  // share of the asset's vocabulary that the line mentions, tempered by how much of the line it
  // explains, so a clip labelled with twenty words cannot match everything
  const recall = hits / labelTerms
  const precision = matched.size / lineWords.length
  const score = Math.min(1, recall * 0.65 + precision * 0.35 + phraseBonus)
  return { score: +score.toFixed(4), matched: [...matched] }
}

const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE

/**
 * Choose the cutaways.
 *
 * Strongest matches are allocated first (a clip of beans going in should land on the line about
 * beans, not on whichever line came first), then the accepted set is returned in timeline order.
 */
export function planBroll(
  sentences: Span[],
  assets: BrollAsset[],
  opts: PlanOptions = {},
): { placements: Placement[]; skipped: { reason: string; text: string; score?: number }[] } {
  const o = { ...DEFAULTS, ...opts }
  const protect = opts.protect || []
  const total = opts.totalDuration ?? (sentences.length ? sentences[sentences.length - 1].end : 0)
  const budget = total * o.coverage

  const candidates: (Placement & { sentenceEnd: number })[] = []
  const skipped: { reason: string; text: string; score?: number }[] = []

  sentences.forEach((s, idx) => {
    if (s.start < o.protectStart) return
    if (protect.some(p => overlaps(s.start, s.end, p.start, p.end))) return
    for (const asset of assets) {
      const { score, matched } = matchScore(s.text, asset)
      if (score < o.minScore) continue
      const srcFrom = asset.bestStart ?? 0
      const srcTo = asset.bestEnd ?? asset.duration
      const available = Math.max(0, srcTo - srcFrom)
      // never stretch or loop: the cutaway is as long as the sentence, the cap, or the footage,
      // whichever runs out first
      const want = Math.min(s.end - s.start, o.maxDuration, available)
      if (want < o.minDuration) continue
      candidates.push({
        assetId: asset.id, name: asset.name, path: asset.path,
        start: s.start, end: +(s.start + want).toFixed(3),
        sourceStart: +srcFrom.toFixed(3),
        sentenceIdx: idx, matched, score, text: s.text, sentenceEnd: s.end,
      })
    }
  })

  candidates.sort((a, b) => b.score - a.score || a.start - b.start)

  const accepted: Placement[] = []
  const uses = new Map<string, number>()
  let used = 0

  for (const c of candidates) {
    const asset = assets.find(a => a.id === c.assetId)!
    if (accepted.some(p => p.sentenceIdx === c.sentenceIdx)) continue          // one per sentence
    if ((uses.get(c.assetId) || 0) >= (asset.maxUses ?? 2)) continue
    if (used + (c.end - c.start) > budget) { skipped.push({ reason: 'coverage cap', text: c.text, score: c.score }); continue }
    // keep the speaker on screen between cutaways
    const tooClose = accepted.some(p => c.start < p.end + o.gapBetween && p.start < c.end + o.gapBetween)
    if (tooClose) { skipped.push({ reason: 'too close to another cutaway', text: c.text, score: c.score }); continue }
    accepted.push({ assetId: c.assetId, name: c.name, path: c.path, start: c.start, end: c.end, sourceStart: c.sourceStart, sentenceIdx: c.sentenceIdx, matched: c.matched, score: c.score, text: c.text })
    uses.set(c.assetId, (uses.get(c.assetId) || 0) + 1)
    used += c.end - c.start
  }

  accepted.sort((a, b) => a.start - b.start)
  return { placements: accepted, skipped }
}

/**
 * Snap a plan's edges to real word boundaries so the picture never changes in the middle of a
 * word. Audio is untouched either way, but a cut that lands mid-syllable still reads wrong,
 * because the mouth shape on screen changes at the same instant.
 */
export function snapToWords(placements: Placement[], sentences: Span[], words: { start: number; end: number }[]): Placement[] {
  return placements.map(p => {
    const s = sentences[p.sentenceIdx]
    if (!s) return p
    const startWord = words[s.startIdx]
    const inAt = startWord ? Math.max(0, startWord.start - 0.04) : p.start
    // the last word that still fits inside the planned window
    let endIdx = s.startIdx
    for (let i = s.startIdx; i <= s.endIdx && i < words.length; i++) {
      if (words[i].end <= p.end) endIdx = i; else break
    }
    const endWord = words[endIdx]
    const nextWord = words[endIdx + 1]
    let outAt = endWord ? endWord.end + 0.08 : p.end
    if (nextWord) outAt = Math.min(outAt, nextWord.start - 0.04)
    return { ...p, start: +inAt.toFixed(3), end: +Math.max(inAt + 0.2, outAt).toFixed(3) }
  })
}

/** Human-readable summary of a plan, for the chat message the user actually reads. */
export function describePlan(placements: Placement[], totalDuration: number): string {
  if (!placements.length) return 'No cutaways: nothing matched well enough to be worth leaving your face for.'
  const covered = placements.reduce((sum, p) => sum + (p.end - p.start), 0)
  const pct = totalDuration > 0 ? Math.round((covered / totalDuration) * 100) : 0
  const lines = placements.map(p => {
    const mm = Math.floor(p.start / 60), ss = String(Math.floor(p.start % 60)).padStart(2, '0')
    return `${mm}:${ss}  ${p.name}  (${(p.end - p.start).toFixed(1)}s, on "${p.matched.join(', ')}")`
  })
  return `${placements.length} cutaways, ${covered.toFixed(1)}s of ${totalDuration.toFixed(0)}s (${pct}%):\n${lines.join('\n')}`
}
