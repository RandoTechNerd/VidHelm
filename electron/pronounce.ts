/**
 * Pronunciation pass for text-to-speech.
 *
 * Zero-shot voices (XTTS, Chatterbox, Deepgram Aura) have no pronunciation
 * dictionary: "SAT, PSAT and ACT" comes out as near-words and "CruxSci" as
 * "Cruxie". The fix is the same one VoiceClone/pronounce.json has always
 * applied for XTTS, so it lives here as one function both the desktop
 * narration adapter and the cloud Voice Lab run before synthesis.
 *
 * Two layers: a table of known terms (longest match first, whole words), then
 * an automatic pass that spells out any remaining ALL-CAPS token of 2-5
 * letters unless it is a real word people say as a word (NASA, LASER, ...).
 *
 * Pure module: no I/O, no Electron.
 */

export type PronounceTable = Record<string, string>

/** Terms that come up across the user's channels; a user table extends or overrides. */
export const DEFAULT_PRONOUNCE: PronounceTable = {
  'CruxSci': 'Crux Sigh',
  'VidHelm': 'Vid Helm',
  'CruxStudy': 'Crux Study',
  'RandoTechNerd': 'Rando Tech Nerd',
  'YouTube': 'You Tube',
  'GitHub': 'Git Hub',
  'ASCP': 'A S C P',
  'SCYM': 'S C Y M',
  'ISCN': 'I S C N',
  'PSAT': 'P S A T',
  'SAT': 'S A T',
  'ACT': 'A C T',
  'MB': 'M B',
  'CG': 'C G',
  '4K': 'four K',
  '1080p': 'ten eighty P',
  '720p': 'seven twenty P',
  '3D': 'three D',
  '3MF': 'three M F',
  'STL': 'S T L',
  'PLA': 'P L A',
  'PETG': 'P E T G',
  'FFmpeg': 'F F m peg',
  'MP4': 'M P four',
  'WiFi': 'Wi Fi',
  'iPhone': 'i Phone',
  '&': ' and ',
  '%': ' percent',
}

/** ALL-CAPS tokens that are pronounced as words, so the auto pass leaves them alone. */
const SAID_AS_WORDS = new Set(['NASA', 'LASER', 'RADAR', 'SCUBA', 'NATO', 'FISH', 'ASAP', 'GIF', 'RAM', 'ROM', 'JPEG', 'PIN', 'ZIP', 'CAD', 'LED', 'AWOL', 'WASM', 'RIFF', 'WAV', 'PNG', 'OK'])

export interface SpellOptions {
  /** spell out unknown 2-5 letter CAPS tokens (default true) */
  autoAcronyms?: boolean
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Rewrite `text` so a zero-shot TTS says it the way a person would. */
export function spellOut(text: string, table: PronounceTable = DEFAULT_PRONOUNCE, opts: SpellOptions = {}): string {
  let out = text
  const keys = Object.keys(table).filter(k => k && !k.startsWith('_')).sort((a, b) => b.length - a.length)
  for (const key of keys) {
    const wordy = /^[\p{L}\p{N}]/u.test(key) && /[\p{L}\p{N}]$/u.test(key)
    // whole-word for wordy keys (so "SAT" never fires inside "SATURDAY"), literal otherwise
    const re = wordy ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(key)}(?![\\p{L}\\p{N}])`, 'gu') : new RegExp(escapeRe(key), 'g')
    out = out.replace(re, table[key])
  }
  if (opts.autoAcronyms !== false) {
    out = out.replace(/(?<![\p{L}\p{N}])([A-Z]{2,5})(?![\p{L}\p{N}])/gu, (m: string) =>
      SAID_AS_WORDS.has(m) ? m : m.split('').join(' '))
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;:!?])/g, '$1').trim()
}

/**
 * Accept both table shapes: a flat {term: spoken} object, or the sectioned
 * VoiceClone/pronounce.json form {general: {...}, cytogenetics: {...}} where
 * every section is merged and keys starting with "_" are comments.
 */
export function parseTable(json: string): PronounceTable {
  let data: unknown
  try { data = JSON.parse(json) } catch { return {} }
  if (!data || typeof data !== 'object') return {}
  const obj = data as Record<string, unknown>
  const flat: PronounceTable = {}
  const sectioned = Object.values(obj).some(v => v && typeof v === 'object')
  if (sectioned) {
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') for (const [k, s] of Object.entries(v as Record<string, unknown>)) if (typeof s === 'string' && !k.startsWith('_')) flat[k] = s
    }
  } else {
    for (const [k, s] of Object.entries(obj)) if (typeof s === 'string' && !k.startsWith('_')) flat[k] = s
  }
  return flat
}

/** Defaults plus the user's table, user wins. */
export const mergeTables = (...tables: PronounceTable[]): PronounceTable => Object.assign({}, DEFAULT_PRONOUNCE, ...tables)
