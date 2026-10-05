// Things Whisper says that nobody said.
//
// Given music, room tone or the silence after the last word, Whisper does not return nothing: it
// returns what its training subtitles most often said there. "Thanks for watching!" over the outro
// music, "Subtitles by the Amara.org community", a lone "you" a minute past the end of the audio,
// "Music" as a word. Burned into a video, each one is a caption the creator never spoke. Measured
// on a 2.5 minute clip with a music intro and outro: tiny added "you" 22 s past the end, base added
// "Thanks for watching!" with all three words at one instant, small added "Music" and "you".
//
// Rules, cheapest first. A phrase that is ONLY a sound tag or a subtitle credit always goes. A
// stock phrase people do really say ("thank you", "thanks for watching") goes only with a second
// sign it was not spoken: its words share one instant, it is three words or fewer stretched over
// 3.5 s or more, or it sits 20 dB under the speech around it. Anything 30 dB under the median
// spoken word, whatever it says, was heard in silence.
//
// No Electron imports, so `npm run test:asr` can exercise it.

import { levelDb, ENV_STEP } from './asrwindows'

export interface Piece { start: number; end: number; text: string }

export interface CleanOptions {
  /** length of the audio, in seconds: nothing can be said at or after it */
  total: number
  /** word mode (one piece per word, grouped into phrases here) or phrase mode (one piece per line) */
  word: boolean
  /** the mean square envelope from energyEnvelope, for the loudness rules (skipped without it) */
  env?: ArrayLike<number>
  step?: number
}

export interface Dropped { text: string; start: number; why: string }

/** Never speech: sound tags and subtitle credits, as the whole phrase. */
const ALWAYS = /^(?:music|applause|laughter|laughs|silence|blank audio|inaudible|no speech|background noise|subtitles? by.*|captions? by.*|transcribed by.*|translated by.*|transcript by.*|.*amara ?org.*|.*\bsubtitle(?:s|d)?\b.*community.*)$/
/** Stock phrases a real person also says: dropped only with a second sign (see above). */
const SUSPECT = /^(?:thank you(?: so much| very much)?(?: for watching| for listening)?|thanks(?: so much)?(?: for watching| for listening)?|please subscribe|(?:like and )?subscribe|bye(?: bye)?|goodbye|you|see you(?: next time| in the next (?:one|video))?|so|okay)$/

/** Lower case, punctuation and brackets out: "[Music]", "(music)" and "♪ Music ♪" all read "music". */
const plain = (s: string) => s.toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * Drop what was never said, clamp the rest to the audio, and say what went and why (for the log).
 * Order and timing of what is kept are unchanged.
 */
export function cleanTranscript(items: Piece[], opts: CleanOptions): { kept: Piece[]; dropped: Dropped[] } {
  const step = opts.step ?? ENV_STEP
  const dropped: Dropped[] = []
  // 1. inside the audio: a word "heard" after the end is invented by definition
  const inside: Piece[] = []
  for (const it of items) {
    if (!(it.start < opts.total - 0.02)) { dropped.push({ text: it.text, start: it.start, why: 'after the end of the audio' }); continue }
    inside.push({ ...it, end: Math.min(Math.max(it.start, it.end), opts.total) })
  }

  // 2. phrases: a ghost is a whole utterance, never one word inside a sentence
  const groups: Piece[][] = []
  for (const it of inside) {
    const g = groups[groups.length - 1], last = g?.[g.length - 1]
    if (opts.word && g && it.start - last!.end <= 0.5 && !/[.!?]["')\]]?$/.test(last!.text)) g.push(it)
    else groups.push([it])
  }

  // 3. how loud real speech is here: the median spoken word (needs the envelope)
  const env = opts.env
  const db = (s: number, e: number) => env ? levelDb(env, e - s >= 0.05 ? s : s - 0.05, e - s >= 0.05 ? e : s + 0.15, step) : 0
  const voiced = inside.filter(it => it.end - it.start >= 0.05).map(it => db(it.start, it.end)).sort((a, b) => a - b)
  const medianDb = env && voiced.length >= 3 ? voiced[Math.floor(voiced.length / 2)] : null

  const kept: Piece[] = []
  for (const g of groups) {
    const text = plain(g.map(x => x.text).join(' '))
    const start = g[0].start, end = g[g.length - 1].end
    const words = text ? text.split(' ').length : 0
    const level = medianDb !== null ? db(start, end) : 0
    const why =
      !text ? 'no words'
      : ALWAYS.test(text) ? 'a sound tag or subtitle credit'
      : medianDb !== null && level < medianDb - 30 ? 'heard in silence'
      : g.length >= 2 && g.every(x => x.end - x.start < 0.05) && end - start < 0.05 ? 'every word at one instant'
      : SUSPECT.test(text) && (
          g.every(x => x.end - x.start < 0.05) ? true
          : words <= 3 && end - start >= 3.5 ? true
          : medianDb !== null && level < medianDb - 20
        ) ? 'a stock phrase with nobody saying it'
      : ''
    if (why) dropped.push({ text: g.map(x => x.text).join(' '), start, why })
    else kept.push(...g)
  }
  return { kept, dropped }
}
