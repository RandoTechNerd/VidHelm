// Turning "beans going into a glass jar, quite full" into something the synth can actually render.
//
// The old ✨ AI panel asked the user to install a text-to-audio model and paste a command line
// with {prompt} and {out} in it before it would do anything at all. That is a wall in front of a
// feature, and almost nobody climbs it.
//
// Most of what people ask for is a variation on a sound that is already modelled, so this matches
// the description against the recipes and works out the parameters: which container, how much of
// it, how long, opening or closing. No model to install, no command line, instant.
//
// It also proposes a NAME, because "coffee-beans-3" is not what anyone wants in their library.
// The name is a suggestion the user edits before saving.
//
// Pure, no Electron: `npm run test:sfxmatch`.

export interface MatchResult {
  /** the recipe to render */
  recipe: string
  /** parameters to pass with it */
  options: { intensity?: number; duration?: number; seed?: number }
  /** a name to put in the box, which the user can change */
  name: string
  /** plain-English description of what it is about to make, shown before it commits */
  summary: string
  /** 0..1: below `MIN_CONFIDENCE` the caller should offer the external generator instead */
  confidence: number
}

/** How sure the match has to be before we claim we can make the sound. */
export const MIN_CONFIDENCE = 0.34

interface RecipeVocab {
  recipe: string
  /** words that mean this recipe, and what each is worth */
  terms: Record<string, number>
  /** what to call it by default */
  label: string
}

const VOCAB: RecipeVocab[] = [
  {
    recipe: 'coffee-beans', label: 'Coffee beans',
    terms: {
      bean: 3, beans: 3, coffee: 2.5, espresso: 1.5, pour: 2, pouring: 2, poured: 2,
      hopper: 2, grinder: 1, scoop: 1.5, rattle: 1.2, rattling: 1.2, grain: 1.5, grains: 1.5,
      rice: 1.5, pellets: 1.5, gravel: 1.2, nuts: 1.2, cereal: 1.5, seeds: 1.5,
    },
  },
  {
    recipe: 'door-electronic', label: 'Electronic door',
    terms: {
      door: 3, doors: 3, hatch: 2.5, airlock: 3, sliding: 1.5, slide: 1.2, pneumatic: 2.5,
      hiss: 1.5, hydraulic: 2, scifi: 2, 'sci-fi': 2, spaceship: 1.5, starship: 1.5,
      elevator: 1.5, lift: 1, whoosh: 0.6, panel: 1.2,
    },
  },
  {
    recipe: 'podracer-start', label: 'Engine starting',
    terms: {
      start: 2.5, starting: 2.5, startup: 2.5, ignition: 3, ignite: 2.5, crank: 2.5,
      rev: 2, revving: 2, engine: 2, motor: 1.8, turbine: 1.5, podracer: 2.5, pod: 1,
      idle: 2, idling: 2, burble: 2.5, gurgle: 2, growl: 2, rumble: 2, 'power up': 3,
      powering: 2, warmup: 2, spool: 2, spooling: 2, thruster: 1.5, rocket: 1.2,
    },
  },
  {
    recipe: 'podracer-pass', label: 'Engine flying past',
    terms: {
      pass: 3, passing: 3, 'fly by': 3, flyby: 3, 'fly past': 3, past: 2, zoom: 2.5,
      zooming: 2.5, whizz: 2.5, speeding: 2, racing: 2, race: 1.5, podracer: 2, doppler: 3,
      overhead: 2, jet: 2, ship: 1.2, roar: 1.5, engine: 1, rush: 1.5,
    },
  },
]

/** Words that change the material of the container. */
const CONTAINERS: { term: string; suffix: string; label: string }[] = [
  { term: 'glass', suffix: '-glass', label: 'a glass jar' },
  { term: 'jar', suffix: '-glass', label: 'a glass jar' },
  { term: 'plastic', suffix: '-plastic', label: 'a plastic tub' },
  { term: 'tub', suffix: '-plastic', label: 'a plastic tub' },
  { term: 'metal', suffix: '', label: 'a metal hopper' },
  { term: 'steel', suffix: '', label: 'a metal hopper' },
  { term: 'tin', suffix: '', label: 'a metal hopper' },
]

const normalize = (s: string): string => (s || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim()

/** Adjectives that mean "more of it" or "less of it". */
function intensityFrom(text: string): { value?: number; word?: string } {
  const t = ` ${text} `
  if (/\b(huge|massive|enormous|loud|heavy|full|lots|big|hard|violent|intense)\b/.test(t)) return { value: 1, word: 'a lot of it' }
  if (/\b(tiny|small|quiet|light|gentle|soft|little|few|delicate)\b/.test(t)) return { value: 0.3, word: 'gently' }
  return {}
}

/** Words that mean it should run longer or shorter. */
function durationFrom(text: string): { value?: number; word?: string } {
  const t = ` ${text} `
  const explicit = t.match(/\b(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/)
  if (explicit) {
    const v = parseFloat(explicit[1])
    if (v >= 0.4 && v <= 10) return { value: v, word: `${v}s` }
  }
  if (/\b(long|longer|extended|drawn out|slow)\b/.test(t)) return { value: 5, word: 'long' }
  if (/\b(short|quick|brief|snappy|fast|clipped)\b/.test(t)) return { value: 1.4, word: 'short' }
  return {}
}

/**
 * Work out what the user is asking for.
 *
 * Scores the description against each recipe's vocabulary, then reads the modifiers off it.
 * Confidence is the winning score relative to how many words were spent on it, so a long
 * description that mentions nothing we can build scores low rather than matching on one stray
 * word like "engine".
 */
export function matchRecipe(text: string, opts: { seed?: number } = {}): MatchResult {
  const norm = normalize(text)
  const words = norm.split(' ').filter(Boolean)

  let best: RecipeVocab | null = null
  let bestScore = 0
  for (const v of VOCAB) {
    let score = 0
    for (const [term, weight] of Object.entries(v.terms)) {
      if (term.includes(' ')) { if (norm.includes(term)) score += weight }
      else if (words.includes(term)) score += weight
    }
    if (score > bestScore) { bestScore = score; best = v }
  }

  const seed = opts.seed
  if (!best || bestScore === 0) {
    return { recipe: '', options: { seed }, name: '', summary: '', confidence: 0 }
  }

  // closing beats opening for a door, if it is mentioned
  let recipe = best.recipe
  let label = best.label
  const parts: string[] = []

  if (recipe === 'door-electronic' && /\b(clos|shut|seal)/.test(norm)) {
    recipe = 'door-electronic-close'
    label = 'Electronic door closing'
  }
  if (best.recipe === 'coffee-beans') {
    const c = CONTAINERS.find(c => words.includes(c.term))
    if (c) { recipe = `coffee-beans${c.suffix}`; parts.push(`into ${c.label}`) }
    else parts.push('into a metal hopper')
  }

  const intensity = intensityFrom(norm)
  const duration = durationFrom(norm)
  if (intensity.word) parts.push(intensity.word)
  if (duration.word) parts.push(duration.word)

  // confidence: a strong hit on a short phrase is certain; one weak word in a long ramble is not
  const density = bestScore / Math.max(3, Math.min(words.length, 14))
  const confidence = Math.max(0, Math.min(1, (bestScore / 6) * 0.6 + density * 0.6))

  return {
    recipe,
    options: {
      seed,
      ...(intensity.value !== undefined ? { intensity: intensity.value } : {}),
      ...(duration.value !== undefined ? { duration: duration.value } : {}),
    },
    name: suggestName(text, label),
    summary: [label.toLowerCase(), ...parts].join(', '),
    confidence: +confidence.toFixed(3),
  }
}

const STOP = new Set(['a', 'an', 'the', 'of', 'in', 'into', 'to', 'on', 'at', 'with', 'and', 'or',
  'sound', 'effect', 'sfx', 'noise', 'audio', 'me', 'my', 'some', 'please', 'make', 'like', 'that', 'is', 'it'])

/**
 * A name for the library, taken from the user's own words where possible.
 *
 * People recognise their own phrasing faster than a generated label, so "beans into a glass jar"
 * becomes "beans glass jar" rather than "coffee-beans-glass-7". Falls back to the recipe's label
 * when the description was all filler.
 */
export function suggestName(text: string, label: string): string {
  const words = normalize(text).split(' ').filter(w => w && !STOP.has(w) && w.length > 1)
  if (!words.length) return label
  const kept = words.slice(0, 4).join(' ')
  return kept.charAt(0).toUpperCase() + kept.slice(1)
}

/** Filenames the library will accept, without losing what the user typed. */
export function nameToFilename(name: string): string {
  const base = (name || 'sound')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50) || 'sound'
  return `${base}.wav`
}
