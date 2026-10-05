/**
 * Style themes: the baseline looks a creator asks for in words.
 *
 * "Make it fun", "clean minimalism", "futuristic tech captions", "cartoon":
 * each of those should land on a finished look straight away, so the only
 * work left is a tweak ("but blue", "bigger", "at the top"). A theme sets the
 * captions, the on-screen titles and the thumbnail text together, so a video
 * reads as one style instead of three.
 *
 * The same module renders captions to ASS (libass) for both the desktop export
 * (ffmpeg `subtitles=`) and the cloud container, and gives the desktop preview
 * a per-frame description (captionFrame) so what you see is what exports.
 *
 * Fonts are the OFL files in public/fonts (bundled with the desktop app and
 * copied into the cloud container image).
 *
 * Pure module: no I/O, no Electron.
 */

/* ---------------------------------------------------------------- fonts -- */

export type ThemeFont = 'impact' | 'headline' | 'comic' | 'tech' | 'mono' | 'terminal' | 'serif' | 'round' | 'marker' | 'heavy' | 'clean' | 'grotesk'

export interface FontInfo {
  /** file in public/fonts */
  file: string
  /** family name as libass / fontconfig / CSS @font-face see it */
  family: string
  /** the file is the bold face of its family, so ASS must ask for Bold */
  bold: boolean
  /** average glyph advance in em for mixed case, for fit estimates */
  advance: number
  /** size multiplier so every font reads at the same visual size (condensed faces run small) */
  scale: number
  label: string
}

export const THEME_FONTS: Record<ThemeFont, FontInfo> = {
  impact:   { file: 'Anton-Regular.ttf',           family: 'Anton',                bold: false, advance: 0.46, scale: 1.12, label: 'Anton (poster)' },
  headline: { file: 'BebasNeue-Regular.ttf',       family: 'Bebas Neue',           bold: false, advance: 0.40, scale: 1.22, label: 'Bebas Neue (headline)' },
  comic:    { file: 'Bangers-Regular.ttf',         family: 'Bangers',              bold: false, advance: 0.50, scale: 1.12, label: 'Bangers (comic)' },
  tech:     { file: 'Orbitron-ExtraBold.ttf',      family: 'Orbitron ExtraBold',   bold: false, advance: 0.74, scale: 0.84, label: 'Orbitron (sci-fi)' },
  mono:     { file: 'JetBrainsMono-Bold.ttf',      family: 'JetBrains Mono',       bold: true,  advance: 0.60, scale: 0.92, label: 'JetBrains Mono (code)' },
  terminal: { file: 'ShareTechMono-Regular.ttf',   family: 'Share Tech Mono',      bold: false, advance: 0.54, scale: 1.0,  label: 'Share Tech Mono (terminal)' },
  serif:    { file: 'PlayfairDisplay-Bold.ttf',    family: 'Playfair Display',     bold: true,  advance: 0.56, scale: 1.0,  label: 'Playfair Display (serif)' },
  round:    { file: 'Fredoka-Bold.ttf',            family: 'Fredoka',              bold: true,  advance: 0.56, scale: 1.04, label: 'Fredoka (rounded)' },
  marker:   { file: 'PermanentMarker-Regular.ttf', family: 'Permanent Marker',     bold: false, advance: 0.62, scale: 0.96, label: 'Permanent Marker (handwritten)' },
  heavy:    { file: 'Montserrat-ExtraBold.ttf',    family: 'Montserrat ExtraBold', bold: false, advance: 0.64, scale: 0.94, label: 'Montserrat ExtraBold (creator)' },
  clean:    { file: 'Inter-SemiBold.ttf',          family: 'Inter SemiBold',       bold: false, advance: 0.56, scale: 0.96, label: 'Inter (clean)' },
  grotesk:  { file: 'SpaceGrotesk-Bold.ttf',       family: 'Space Grotesk',        bold: true,  advance: 0.58, scale: 1.0,  label: 'Space Grotesk (RandoTechNerd)' },
}
export const THEME_FONT_IDS = Object.keys(THEME_FONTS) as ThemeFont[]

/* --------------------------------------------------------------- specs -- */

/** How the words move. Every motion works on any chunking; some are written for one. */
export type CaptionMotion = 'none' | 'fade' | 'pop' | 'highlight' | 'karaoke' | 'typewriter' | 'bounce' | 'glow' | 'glitch'
export const CAPTION_MOTIONS: CaptionMotion[] = ['none', 'fade', 'pop', 'highlight', 'karaoke', 'typewriter', 'bounce', 'glow', 'glitch']
/** line = the whole phrase · group = 1-3 words at a time (Shorts) · word = one word at a time */
export type CaptionChunk = 'line' | 'group' | 'word'
export type CaptionSize = 's' | 'm' | 'l' | 'xl'
export type CaptionPlace = 'bottom' | 'lower' | 'center' | 'top'

export interface CaptionSpec {
  font: ThemeFont
  size: CaptionSize
  position: CaptionPlace
  /** text colour */
  color: string
  /** the spoken / highlighted word, glow colour, karaoke fill */
  accent: string
  /** several accents used in turn, one per word group (fun, cartoon) */
  accentCycle?: string[]
  /** outline width as a fraction of the font size (0 = none) */
  outline: number
  outlineColor: string
  /** drop shadow offset as a fraction of the font size (0 = none) */
  shadow: number
  shadowColor: string
  box: boolean
  boxColor: string
  boxOpacity: number
  uppercase: boolean
  /** extra letter spacing, fraction of the font size */
  tracking: number
  /** degrees, alternated left/right per group (0 = straight) */
  tilt: number
  motion: CaptionMotion
  chunk: CaptionChunk
}

export interface TitleSpec {
  font: ThemeFont
  color: string
  accent: string
  outline: number
  outlineColor: string
  box: boolean
  boxColor: string
  boxOpacity: number
  uppercase: boolean
}

export interface ThumbSpec {
  font: ThemeFont
  color: string
  /** colour for the second line / the emphasised word */
  accent: string
  /** stroke width as a fraction of the font size */
  stroke: number
  strokeColor: string
  /** solid plate behind the text (null = text straight on the picture) */
  plate: string | null
  uppercase: boolean
}

export interface StyleTheme {
  id: string
  name: string
  /** one line, shown to people and to the planner */
  blurb: string
  /** words people use when they mean this look */
  keywords: string[]
  caption: CaptionSpec
  title: TitleSpec
  thumb: ThumbSpec
  /** the rest of the video's feel, as hints for the planner / agent */
  transition: 'cut' | 'crossfade' | 'zoom' | 'whip' | 'glitch' | 'dip'
  music: string
  sfx: string
}

const CAP: CaptionSpec = {
  font: 'heavy', size: 'm', position: 'bottom', color: '#ffffff', accent: '#ffd23f',
  outline: 0.09, outlineColor: '#000000', shadow: 0.03, shadowColor: '#000000',
  box: false, boxColor: '#000000', boxOpacity: 0.6, uppercase: false, tracking: 0, tilt: 0,
  motion: 'highlight', chunk: 'line',
}
const TITLE: TitleSpec = { font: 'heavy', color: '#ffffff', accent: '#ffd23f', outline: 0.07, outlineColor: '#000000', box: false, boxColor: '#000000', boxOpacity: 0.6, uppercase: false }
const THUMB: ThumbSpec = { font: 'impact', color: '#ffffff', accent: '#ffd23f', stroke: 0.1, strokeColor: '#000000', plate: null, uppercase: true }

const theme = (t: Omit<StyleTheme, 'caption' | 'title' | 'thumb'> & { caption?: Partial<CaptionSpec>; title?: Partial<TitleSpec>; thumb?: Partial<ThumbSpec> }): StyleTheme =>
  ({ ...t, caption: { ...CAP, ...t.caption }, title: { ...TITLE, ...t.title }, thumb: { ...THUMB, ...t.thumb } })

export const THEMES: StyleTheme[] = [
  theme({
    id: 'creator', name: 'Bold creator', blurb: 'The YouTube default: chunky white captions, the spoken word lights up yellow.',
    keywords: ['default', 'youtube', 'creator', 'standard', 'normal', 'bold', 'classic', 'vlog'],
    caption: {}, transition: 'crossfade', music: 'upbeat lo-fi bed', sfx: 'light whooshes on cuts',
  }),
  theme({
    id: 'clean', name: 'Clean minimal', blurb: 'Small, quiet sentence-case captions with a soft shadow. Lets the picture breathe.',
    keywords: ['clean', 'minimal', 'minimalism', 'minimalist', 'simple', 'subtle', 'quiet', 'understated', 'calm', 'professional', 'corporate', 'apple', 'sleek', 'modern', 'plain'],
    caption: { font: 'clean', size: 's', outline: 0, shadow: 0.05, shadowColor: '#000000', motion: 'fade', accent: '#ffffff' },
    title: { font: 'clean', outline: 0 }, thumb: { font: 'clean', uppercase: false, stroke: 0, plate: '#111111', accent: '#9ad1ff' },
    transition: 'crossfade', music: 'soft ambient piano', sfx: 'none',
  }),
  theme({
    id: 'hype', name: 'Hype Shorts', blurb: 'Huge all-caps words, 1-3 at a time, popping in on the beat with the spoken word in yellow.',
    keywords: ['hype', 'energetic', 'energy', 'viral', 'shorts', 'tiktok', 'reels', 'mrbeast', 'beast', 'loud', 'punchy', 'exciting', 'intense', 'aggressive', 'fast'],
    caption: { font: 'impact', size: 'xl', position: 'center', uppercase: true, outline: 0.12, shadow: 0.05, motion: 'pop', chunk: 'group' },
    title: { font: 'impact', uppercase: true, outline: 0.1 }, thumb: { font: 'impact' },
    transition: 'zoom', music: 'driving trap beat', sfx: 'whooshes, risers and bass hits on cuts',
  }),
  theme({
    id: 'fun', name: 'Playful', blurb: 'Rounded bubbly words that bounce in, cycling pink, teal and sunshine yellow.',
    keywords: ['fun', 'playful', 'happy', 'cheerful', 'bubbly', 'cute', 'friendly', 'colorful', 'colourful', 'silly', 'goofy', 'lighthearted', 'whimsical', 'party', 'bright'],
    caption: { font: 'round', size: 'l', position: 'lower', outline: 0.1, outlineColor: '#2b1a4a', shadow: 0.06, shadowColor: '#2b1a4a', accent: '#ff5fa2', accentCycle: ['#ff5fa2', '#2ee6c8', '#ffd23f', '#8f7bff'], tilt: 2, motion: 'bounce', chunk: 'group' },
    title: { font: 'round', color: '#ffffff', outlineColor: '#2b1a4a', accent: '#ff5fa2' }, thumb: { font: 'round', accent: '#2ee6c8', strokeColor: '#2b1a4a' },
    transition: 'zoom', music: 'bouncy ukulele and claps', sfx: 'boings, pops and squeaks',
  }),
  theme({
    id: 'cartoon', name: 'Cartoon', blurb: 'Comic-book lettering: yellow caps, thick black ink, hard drop shadow, tilted and popping.',
    keywords: ['cartoon', 'cartoony', 'comic', 'comics', 'comic book', 'animated', 'anime', 'manga', 'kids', 'kid', 'zany', 'wacky', 'saturday morning', 'superhero', 'pow', 'zany'],
    caption: { font: 'comic', size: 'xl', position: 'lower', color: '#ffe14d', accent: '#ffffff', accentCycle: ['#ffffff', '#5fd3ff', '#ff6b6b'], outline: 0.13, shadow: 0.09, shadowColor: '#000000', uppercase: true, tracking: 0.02, tilt: 3, motion: 'pop', chunk: 'group' },
    title: { font: 'comic', color: '#ffe14d', uppercase: true, outline: 0.12, accent: '#ff6b6b' }, thumb: { font: 'comic', color: '#ffe14d', accent: '#ffffff', stroke: 0.13 },
    transition: 'whip', music: 'bouncy cartoon orchestra', sfx: 'cartoon boings, slide whistles, pops',
  }),
  theme({
    id: 'tech', name: 'Futuristic tech', blurb: 'Wide sci-fi caps in electric cyan with a glow and a quick chromatic glitch on each line.',
    keywords: ['futuristic', 'future', 'tech', 'techy', 'technology', 'sci-fi', 'scifi', 'cyber', 'cyberpunk', 'hud', 'robot', 'digital', 'space', 'hologram', 'holographic', 'tron', 'matrix', 'glitch', 'electronic', 'circuit'],
    caption: { font: 'tech', size: 'm', color: '#e8fdff', accent: '#3ff0ff', outline: 0.04, outlineColor: '#0a2a3a', shadow: 0.1, shadowColor: '#ff2bd6', uppercase: true, tracking: 0.08, motion: 'glitch', chunk: 'line' },
    title: { font: 'tech', color: '#e8fdff', accent: '#3ff0ff', outline: 0.04, outlineColor: '#0a2a3a', uppercase: true }, thumb: { font: 'tech', color: '#e8fdff', accent: '#3ff0ff', strokeColor: '#001018', stroke: 0.08 },
    transition: 'glitch', music: 'dark synth pulse', sfx: 'digital blips, glitches and data chirps',
  }),
  theme({
    id: 'terminal', name: 'Hacker terminal', blurb: 'Green monospace on a black box, typed out word by word.',
    keywords: ['hacker', 'terminal', 'code', 'coding', 'programmer', 'console', 'command line', 'retro computer', 'typewriter', 'typed', 'nerd', 'linux', 'mono', 'monospace'],
    caption: { font: 'terminal', size: 'm', color: '#39ff14', accent: '#b6ff9e', outline: 0, shadow: 0, box: true, boxColor: '#000000', boxOpacity: 0.82, motion: 'typewriter', chunk: 'line' },
    title: { font: 'terminal', color: '#39ff14', outline: 0, box: true, boxOpacity: 0.85 }, thumb: { font: 'mono', color: '#39ff14', accent: '#ffffff', plate: '#000000', stroke: 0, uppercase: false },
    transition: 'cut', music: 'minimal electronic', sfx: 'keyboard clicks and beeps',
  }),
  theme({
    id: 'cinematic', name: 'Cinematic', blurb: 'Small elegant serif subtitles low in frame, like a film. No colour, no motion.',
    keywords: ['cinematic', 'film', 'movie', 'documentary style', 'dramatic', 'moody', 'serious', 'artsy', 'arthouse', 'story', 'storytelling', 'emotional', 'netflix', 'trailer'],
    caption: { font: 'serif', size: 's', position: 'bottom', outline: 0, shadow: 0.06, tracking: 0.01, motion: 'fade', accent: '#ffffff' },
    title: { font: 'serif', outline: 0, uppercase: true, accent: '#e9d8a6' }, thumb: { font: 'serif', uppercase: false, stroke: 0.05, accent: '#e9d8a6' },
    transition: 'dip', music: 'cinematic strings and felt piano', sfx: 'low booms and soft risers',
  }),
  theme({
    id: 'elegant', name: 'Elegant', blurb: 'Serif captions with a warm gold highlight. Luxury, weddings, food, beauty.',
    keywords: ['elegant', 'luxury', 'luxurious', 'classy', 'fancy', 'premium', 'gold', 'wedding', 'beauty', 'fashion', 'sophisticated', 'refined', 'chic', 'boutique'],
    caption: { font: 'serif', size: 'm', outline: 0.03, outlineColor: '#1a1408', shadow: 0.04, accent: '#e8c36a', motion: 'highlight' },
    title: { font: 'serif', accent: '#e8c36a', outline: 0.02 }, thumb: { font: 'serif', accent: '#e8c36a', uppercase: false, stroke: 0.05, strokeColor: '#1a1408' },
    transition: 'crossfade', music: 'soft jazz or strings', sfx: 'gentle shimmer',
  }),
  theme({
    id: 'news', name: 'News / documentary', blurb: 'Condensed caps on a solid bar, read like a broadcast lower third.',
    keywords: ['news', 'documentary', 'journalism', 'report', 'broadcast', 'informative', 'serious news', 'explainer news', 'interview', 'facts', 'lower third', 'headlines'],
    caption: { font: 'headline', size: 'l', position: 'bottom', outline: 0, shadow: 0, box: true, boxColor: '#0d1b2a', boxOpacity: 0.88, uppercase: true, tracking: 0.03, accent: '#ffcc00', motion: 'highlight' },
    title: { font: 'headline', uppercase: true, box: true, boxColor: '#c8102e', boxOpacity: 0.95, outline: 0 }, thumb: { font: 'headline', plate: '#c8102e', stroke: 0, accent: '#ffcc00' },
    transition: 'cut', music: 'tense news underscore', sfx: 'subtle swooshes',
  }),
  theme({
    id: 'neon', name: 'Neon retro', blurb: 'Hot-pink glowing caps on a synthwave night. 80s, arcade, nightlife.',
    keywords: ['neon', 'retro', '80s', 'eighties', 'synthwave', 'vaporwave', 'outrun', 'arcade', 'nightlife', 'club', 'glow', 'glowing', 'miami', 'disco'],
    caption: { font: 'headline', size: 'l', color: '#ffffff', accent: '#ff3fd2', outline: 0.03, outlineColor: '#ff3fd2', shadow: 0, uppercase: true, tracking: 0.06, motion: 'glow', chunk: 'line' },
    title: { font: 'headline', uppercase: true, color: '#ffffff', accent: '#ff3fd2', outlineColor: '#ff3fd2', outline: 0.04 }, thumb: { font: 'headline', accent: '#3ff0ff', strokeColor: '#ff3fd2', stroke: 0.08 },
    transition: 'glitch', music: 'synthwave', sfx: 'laser zaps and arcade blips',
  }),
  theme({
    id: 'handmade', name: 'Handwritten', blurb: 'Marker-pen captions, slightly tilted, like notes on a whiteboard. DIY, crafts, sketchbook.',
    keywords: ['handwritten', 'hand written', 'handmade', 'marker', 'sketch', 'sketchbook', 'notebook', 'diy', 'craft', 'crafts', 'scrapbook', 'doodle', 'whiteboard', 'personal', 'cozy', 'cosy'],
    caption: { font: 'marker', size: 'l', color: '#fff8e7', accent: '#ffb347', outline: 0.07, outlineColor: '#1b1b1b', shadow: 0.03, tilt: 1.5, motion: 'pop', chunk: 'group' },
    title: { font: 'marker', color: '#fff8e7', accent: '#ffb347' }, thumb: { font: 'marker', color: '#fff8e7', accent: '#ffb347', uppercase: false },
    transition: 'crossfade', music: 'acoustic guitar', sfx: 'pencil scribbles and paper',
  }),
  theme({
    id: 'karaoke', name: 'Karaoke / music', blurb: 'Each word fills with colour as it is sung. Music videos, lyrics, sing-alongs.',
    keywords: ['karaoke', 'lyrics', 'lyric', 'music video', 'song', 'singing', 'sing along', 'singalong', 'rap', 'musical'],
    caption: { font: 'heavy', size: 'l', position: 'lower', accent: '#3ff0ff', motion: 'karaoke', chunk: 'line' },
    title: { font: 'heavy', accent: '#3ff0ff' }, thumb: { accent: '#3ff0ff' },
    transition: 'crossfade', music: 'the song itself', sfx: 'none',
  }),
  theme({
    id: 'explainer', name: 'Friendly explainer', blurb: 'Dark text on a white rounded card, spoken word in blue. Tutorials, teaching, science.',
    keywords: ['explainer', 'tutorial', 'teaching', 'teach', 'lesson', 'education', 'educational', 'school', 'class', 'classroom', 'science', 'how to', 'howto', 'guide', 'study', 'learning', 'course'],
    caption: { font: 'round', size: 'm', position: 'lower', color: '#16202c', accent: '#1e6bff', outline: 0, shadow: 0, box: true, boxColor: '#ffffff', boxOpacity: 0.94, motion: 'highlight' },
    title: { font: 'round', color: '#16202c', accent: '#1e6bff', outline: 0, box: true, boxColor: '#ffffff', boxOpacity: 0.95 }, thumb: { font: 'round', color: '#ffffff', accent: '#ffd23f', strokeColor: '#16202c' },
    transition: 'crossfade', music: 'light curious pizzicato', sfx: 'soft pops and dings',
  }),
  theme({
    id: 'randotechnerd', name: 'RandoTechNerd', blurb: 'The channel look: Space Grotesk, teal highlight from the night-sky logo, orange thumbnail accent, real photos.',
    keywords: ['randotechnerd', 'rando tech nerd', 'rtn', 'my brand', 'my style', 'my channel', 'channel style', '3d printing', '3d print', 'workshop'],
    caption: { font: 'grotesk', size: 'm', color: '#ffffff', accent: '#4fd8e8', outline: 0.09, outlineColor: '#07131d', shadow: 0.04, shadowColor: '#07131d', motion: 'highlight' },
    title: { font: 'grotesk', accent: '#ff9a3c', outlineColor: '#07131d' }, thumb: { font: 'impact', color: '#ffffff', accent: '#ff9a3c', strokeColor: '#07131d', stroke: 0.11 },
    transition: 'crossfade', music: 'ambient bed lifted from the footage', sfx: 'whoosh on the intro wipe',
  }),
]
export const THEME_IDS = THEMES.map(t => t.id)
export const DEFAULT_THEME_ID = 'creator'
export const themeById = (id: string | null | undefined): StyleTheme | undefined => THEMES.find(t => t.id === String(id || '').toLowerCase().trim())

/* ------------------------------------------------------------ matching -- */

const NAMED_COLORS: Record<string, string> = {
  white: '#ffffff', black: '#111111', red: '#ff3b3b', orange: '#ff9a3c', yellow: '#ffd23f', gold: '#e8c36a', green: '#39d353',
  lime: '#a6ff3f', teal: '#2ee6c8', cyan: '#3ff0ff', blue: '#3b82ff', navy: '#1b2a6b', purple: '#9b5cff', violet: '#8f7bff',
  pink: '#ff5fa2', magenta: '#ff3fd2', brown: '#8b5a2b', grey: '#9aa3ad', gray: '#9aa3ad', silver: '#c9d1d9', cream: '#fff8e7', mint: '#7dffc8',
}
const SIZE_UP: Record<CaptionSize, CaptionSize> = { s: 'm', m: 'l', l: 'xl', xl: 'xl' }
const SIZE_DOWN: Record<CaptionSize, CaptionSize> = { s: 's', m: 's', l: 'm', xl: 'l' }

const norm = (s: string) => ' ' + String(s || '').toLowerCase().replace(/[^a-z0-9#\s-]+/g, ' ').replace(/\s+/g, ' ').trim() + ' '
const has = (hay: string, word: string) => hay.includes(' ' + word + ' ')

/** Score every theme against what someone typed. Theme names and ids count most. */
export function rankThemes(text: string): { id: string; score: number; hits: string[] }[] {
  const hay = norm(text)
  return THEMES.map(t => {
    const hits: string[] = []
    let score = 0
    if (has(hay, t.id) || has(hay, t.name.toLowerCase())) { score += 5; hits.push(t.id) }
    for (const k of t.keywords) if (has(hay, k)) { score += k.includes(' ') ? 3 : 2; hits.push(k) }
    return { id: t.id, score, hits }
  }).sort((a, b) => b.score - a.score)
}

/** The tweaks hidden in a request: "but in blue", "bigger", "at the top", "all caps", "no box". */
export function tweaksFromText(text: string): Partial<CaptionSpec> {
  const hay = norm(text)
  const out: Partial<CaptionSpec> = {}
  // colours: "blue highlight" / "highlight in blue" -> accent, otherwise the text colour
  for (const [name, hex] of Object.entries(NAMED_COLORS)) {
    const re = new RegExp(`\\b(${name})\\b(\\s+\\w+){0,2}`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(hay))) {
      const after = m[0]
      const before = hay.slice(Math.max(0, m.index - 24), m.index)
      if (/\b(highlight|highlighted|accent|glow|glowing|pop|active|spoken)\b/.test(after + ' ' + before)) out.accent = hex
      else if (/\b(box|background|bar|card|plate)\b/.test(after)) { out.box = true; out.boxColor = hex }
      else if (/\b(outline|stroke|border)\b/.test(after)) { out.outlineColor = hex; out.outline = out.outline ?? 0.09 }
      else if (!out.color) out.color = hex
    }
  }
  const hex = hay.match(/#([0-9a-f]{6})\b/)
  if (hex && !out.color) out.color = '#' + hex[1]
  if (/\b(bigger|larger|huge|giant|massive|large)\b/.test(hay)) out.size = 'xl'
  if (/\b(smaller|small|tiny|subtle)\b/.test(hay)) out.size = 's'
  if (/\b(at the top|on top|top of)\b/.test(hay)) out.position = 'top'
  else if (/\b(centre|center|middle)\b/.test(hay)) out.position = 'center'
  else if (/\b(at the bottom|bottom of)\b/.test(hay)) out.position = 'bottom'
  if (/\b(all caps|uppercase|capitals|caps lock)\b/.test(hay)) out.uppercase = true
  if (/\b(no caps|lowercase|lower case|sentence case)\b/.test(hay)) out.uppercase = false
  if (/\b(no box|no background|without a box|no bar)\b/.test(hay)) out.box = false
  else if (/\b(boxed|with a box|on a box|background bar)\b/.test(hay)) out.box = true
  if (/\b(no outline|without outline|no stroke)\b/.test(hay)) out.outline = 0
  if (/\b(one word at a time|word by word|single word)\b/.test(hay)) out.chunk = 'word'
  else if (/\b(few words|two words|three words|short chunks|chunks)\b/.test(hay)) out.chunk = 'group'
  else if (/\b(full sentence|whole sentence|full line|whole line)\b/.test(hay)) out.chunk = 'line'
  if (/\b(no tilt|straight)\b/.test(hay)) out.tilt = 0
  if (/\b(no animation|no motion|static|still captions)\b/.test(hay)) out.motion = 'none'
  return out
}

export interface ThemeChoice {
  theme: StyleTheme
  /** the theme's caption spec with the tweaks applied */
  caption: CaptionSpec
  title: TitleSpec
  thumb: ThumbSpec
  tweaks: Partial<CaptionSpec>
  /** true when nothing in the text pointed at a theme and the default was used */
  fallback: boolean
  hits: string[]
}

/** Words or an id in, a finished look out. "futuristic tech but green" -> tech theme, green text. */
export function chooseTheme(request: string | null | undefined, extra?: Partial<CaptionSpec> | null): ThemeChoice {
  const text = String(request || '')
  let t = themeById(text)
  let hits: string[] = []
  let fallback = false
  if (!t) {
    const best = rankThemes(text)[0]
    if (best && best.score > 0) { t = themeById(best.id); hits = best.hits }
  }
  if (!t) { t = themeById(DEFAULT_THEME_ID)!; fallback = true }
  const tweaks = { ...(themeById(text) ? {} : tweaksFromText(text)), ...cleanSpec(extra || {}) }
  // a colour that named the theme ("elegant gold", "neon pink") is the theme, not a tweak
  for (const k of ['color', 'accent'] as const) if (!extra?.[k] && tweaks[k] && hits.some(h => NAMED_COLORS[h] === tweaks[k])) delete tweaks[k]
  if (tweaks.size === 'xl' && t.caption.size !== 'xl' && !extra?.size) tweaks.size = SIZE_UP[t.caption.size]
  if (tweaks.size === 's' && !extra?.size) tweaks.size = SIZE_DOWN[t.caption.size]
  const caption = resolveCaption({ ...t.caption, ...tweaks })
  const title = { ...t.title, ...(tweaks.color ? { color: tweaks.color } : {}), ...(tweaks.accent ? { accent: tweaks.accent } : {}) }
  const thumb = { ...t.thumb, ...(tweaks.accent ? { accent: tweaks.accent } : {}) }
  return { theme: t, caption, title, thumb, tweaks, fallback, hits }
}

const HEX = /^#[0-9a-fA-F]{6}$/
function cleanSpec(o: Partial<CaptionSpec>): Partial<CaptionSpec> {
  const r: Partial<CaptionSpec> = {}
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== '') (r as Record<string, unknown>)[k] = v
  return r
}
/** Any partial spec made safe: unknown values fall back to the creator default. */
export function resolveCaption(o: Partial<CaptionSpec> | null | undefined): CaptionSpec {
  const s = { ...CAP, ...cleanSpec(o || {}) } as CaptionSpec
  if (!THEME_FONTS[s.font]) s.font = CAP.font
  if (!['s', 'm', 'l', 'xl'].includes(s.size)) s.size = 'm'
  if (!['bottom', 'lower', 'center', 'top'].includes(s.position)) s.position = 'bottom'
  if (!CAPTION_MOTIONS.includes(s.motion)) s.motion = 'highlight'
  if (!['line', 'group', 'word'].includes(s.chunk)) s.chunk = 'line'
  for (const k of ['color', 'accent', 'outlineColor', 'shadowColor', 'boxColor'] as const) if (!HEX.test(String(s[k]))) s[k] = CAP[k]
  s.accentCycle = Array.isArray(s.accentCycle) ? s.accentCycle.filter(c => HEX.test(c)).slice(0, 6) : undefined
  if (s.accentCycle && !s.accentCycle.length) s.accentCycle = undefined
  const num = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }
  s.outline = num(s.outline, 0, 0.3, CAP.outline)
  s.shadow = num(s.shadow, 0, 0.3, CAP.shadow)
  s.boxOpacity = num(s.boxOpacity, 0, 1, CAP.boxOpacity)
  s.tracking = num(s.tracking, -0.05, 0.3, 0)
  s.tilt = num(s.tilt, 0, 12, 0)
  s.box = !!s.box; s.uppercase = !!s.uppercase
  return s
}

/** One line per theme, for an AI planner's prompt or an agent's tool description. */
export function themeMenu(): string {
  return THEMES.map(t => `${t.id}: ${t.name}. ${t.blurb}`).join('\n')
}

/* ------------------------------------------------------- word grouping -- */

export interface CapWord { s: number; e: number; t: string }
export interface CapCue { start: number; end: number; text: string; words?: CapWord[] }

/** A cue's words with times: its own when they match the text, else spread evenly. */
export function cueWords(c: CapCue): CapWord[] {
  const tokens = String(c.text || '').trim().split(/\s+/).filter(Boolean)
  if (Array.isArray(c.words) && c.words.length === tokens.length)
    return c.words.map((w, i) => ({ s: Math.max(c.start, w.s), e: Math.min(c.end, Math.max(w.s, w.e)), t: tokens[i] }))
  const step = (c.end - c.start) / Math.max(1, tokens.length)
  return tokens.map((t, i) => ({ s: c.start + i * step, e: c.start + (i + 1) * step, t }))
}

/** Up to `max` words, broken after punctuation, never more than ~maxChars of big text. */
export function groupWords(words: CapWord[], max = 3, maxChars = 14): CapWord[][] {
  const out: CapWord[][] = []
  let g: CapWord[] = []
  const chars = () => g.reduce((n, w) => n + w.t.length + 1, 0)
  for (const w of words) {
    if (g.length && (g.length >= max || chars() + w.t.length > maxChars)) { out.push(g); g = [] }
    g.push(w)
    if (/[.!?,;:]$/.test(w.t)) { out.push(g); g = [] }
  }
  if (g.length) out.push(g)
  return out
}

/**
 * Word timings (Whisper word mode) into caption lines: a new line at a pause, after a sentence
 * end, or when the line gets long. Each cue keeps its words so word-level motions stay in sync.
 */
export function phrasesFromWords(words: CapWord[], maxWords = 7, maxChars = 38, pause = 0.6): CapCue[] {
  // a spoken word is never longer than ~1.5 s; longer means the recogniser stretched it over silence
  const ws = words.map(w => ({ s: +w.s, e: Math.min(Math.max(+w.s, +w.e), +w.s + 1.5), t: String(w.t || '').trim() })).filter(w => w.t && isFinite(w.s) && isFinite(w.e)).sort((a, b) => a.s - b.s)
  const out: CapCue[] = []
  let cur: CapWord[] = []
  const flush = () => {
    if (!cur.length) return
    const end = Math.max(cur[cur.length - 1].e, cur[0].s + 0.4)
    out.push({ start: cur[0].s, end, text: cur.map(w => w.t).join(' '), words: cur })
    cur = []
  }
  for (const w of ws) {
    const prev = cur[cur.length - 1]
    const len = cur.reduce((n, x) => n + x.t.length + 1, 0)
    if (prev && (w.s - prev.e > pause || cur.length >= maxWords || len + w.t.length > maxChars)) flush()
    cur.push(w)
    if (/[.!?]$/.test(w.t)) flush()
  }
  flush()
  // hold each line until the next one starts (up to 0.8 s) so captions do not blink off between words
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1]
    out[i].end = next ? Math.min(next.start, Math.max(out[i].end, Math.min(out[i].end + 0.8, next.start))) : out[i].end + 0.4
  }
  return out
}

/** The pieces a spec shows for one cue: each piece is on screen from s to e. */
export function chunkCue(c: CapCue, spec: Pick<CaptionSpec, 'chunk' | 'font' | 'size'>): { s: number; e: number; words: CapWord[] }[] {
  const words = cueWords(c)
  if (!words.length) return []
  const big = spec.size === 'xl' || spec.size === 'l'
  const groups = spec.chunk === 'word' ? words.map(w => [w]) : spec.chunk === 'group' ? groupWords(words, 3, big ? 14 : 18) : [words]
  return groups.map((g, i) => ({ s: i === 0 ? c.start : g[0].s, e: i + 1 < groups.length ? groups[i + 1][0].s : c.end, words: g }))
}

/* ---------------------------------------------------------- dimensions -- */

const SIZE_FRAC: Record<CaptionSize, number> = { s: 0.04, m: 0.05, l: 0.064, xl: 0.082 }

/** Caption font size in px for a frame (portrait frames are sized by their width). */
export function captionPx(spec: Pick<CaptionSpec, 'size' | 'font' | 'motion'>, W: number, H: number): number {
  const base = Math.min(H, W * 1.25)
  return Math.round(base * SIZE_FRAC[spec.size] * (THEME_FONTS[spec.font]?.scale || 1))
}
/** Centre-line y (0..1) of each caption position, for the preview and fit checks. */
export const CAPTION_Y: Record<CaptionPlace, number> = { top: 0.1, center: 0.5, lower: 0.76, bottom: 0.88 }

/* ------------------------------------------------------- live preview -- */

export interface FramePiece { t: string; color: string; hidden?: boolean }
export interface CaptionFrame {
  pieces: FramePiece[]
  /** 1 = rest size; >1 or <1 while popping/bouncing */
  scale: number
  /** degrees */
  tilt: number
  opacity: number
  /** glitch shadow offset in em (0 = none) */
  glitch: number
}

const ease = (x: number) => Math.max(0, Math.min(1, x))
/**
 * What a caption looks like at time t, for an HTML preview that matches the ASS
 * export. Returns null when nothing from this cue is on screen at t.
 */
export function captionFrame(c: CapCue, spec: CaptionSpec, t: number, groupIndexBase = 0): CaptionFrame | null {
  if (!(t >= c.start && t < c.end)) return null
  const pieces = chunkCue(c, spec)
  const gi = pieces.findIndex(p => t >= p.s && t < p.e)
  if (gi < 0) return null
  const g = pieces[gi]
  const up = (w: string) => (spec.uppercase ? w.toUpperCase() : w)
  const accent = spec.accentCycle ? spec.accentCycle[(groupIndexBase + gi) % spec.accentCycle.length] : spec.accent
  const active = g.words.findIndex((w, i) => t >= w.s && (i + 1 >= g.words.length || t < g.words[i + 1].s))
  const since = t - g.s
  const out: CaptionFrame = { pieces: [], scale: 1, tilt: spec.tilt ? (((groupIndexBase + gi) % 2) ? -spec.tilt : spec.tilt) : 0, opacity: 1, glitch: 0 }
  switch (spec.motion) {
    case 'fade': out.opacity = Math.min(ease((t - g.s) / 0.12), ease((g.e - t) / 0.1)); break
    case 'pop': out.scale = since < 0.12 ? 0.78 + 0.22 * (since / 0.12) : 1; break
    case 'bounce': out.scale = since < 0.1 ? 0.55 + 0.6 * (since / 0.1) : since < 0.19 ? 1.15 - 0.15 * ((since - 0.1) / 0.09) : 1; break
    case 'glow': out.opacity = Math.min(ease((t - g.s) / 0.08), ease((g.e - t) / 0.08)); break
    case 'glitch': out.glitch = since < 0.16 ? 0.12 - 0.09 * (since / 0.16) : 0.03; break
  }
  g.words.forEach((w, i) => {
    let color = spec.color
    let hidden = false
    if (spec.motion === 'highlight' || spec.motion === 'pop' || spec.motion === 'bounce') { if (i === active) color = accent }
    else if (spec.motion === 'karaoke') { if (t >= w.s) color = accent }
    else if (spec.motion === 'typewriter') { if (t < w.s && i > 0) hidden = true }
    out.pieces.push({ t: up(w.t), color, hidden })
  })
  return out
}

/** Every theme font as CSS @font-face rules, for the desktop preview and web pages. */
export function fontFaceCss(urlFor: (file: string) => string): string {
  return THEME_FONT_IDS.map(id => {
    const f = THEME_FONTS[id]
    return `@font-face{font-family:'${f.family}';src:url('${urlFor(f.file)}') format('truetype');font-weight:${f.bold ? 700 : 400};font-display:swap}`
  }).join('\n')
}
/** CSS for a caption spec at a given rendered font size (px). */
export function captionCss(spec: CaptionSpec, px: number): Record<string, string> {
  const f = THEME_FONTS[spec.font]
  const o = Math.round(px * spec.outline * 10) / 10
  const sh = Math.round(px * spec.shadow * 10) / 10
  const shadows: string[] = []
  if (sh > 0) shadows.push(`${sh}px ${sh}px 0 ${spec.shadowColor}`)
  if (spec.motion === 'glow') shadows.push(`0 0 ${Math.round(px * 0.35)}px ${spec.accent}`, `0 0 ${Math.round(px * 0.12)}px ${spec.accent}`)
  return {
    fontFamily: `'${f.family}', sans-serif`,
    fontWeight: f.bold ? '700' : '400',
    fontSize: px + 'px',
    letterSpacing: spec.tracking ? (spec.tracking * px).toFixed(1) + 'px' : 'normal',
    WebkitTextStroke: o > 0 && !spec.box ? `${o * 2}px ${spec.outlineColor}` : '0',
    paintOrder: 'stroke fill',
    textShadow: shadows.join(', ') || 'none',
    background: spec.box ? hexA(spec.boxColor, spec.boxOpacity) : 'transparent',
    padding: spec.box ? '0.12em 0.4em' : '0',
    borderRadius: spec.box ? '0.28em' : '0',
    lineHeight: '1.2',
  }
}
const hexA = (hex: string, a: number) => { const h = hex.replace('#', ''); return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})` }

/* ----------------------------------------------------------------- ASS -- */

/** #rrggbb + opacity (1 = solid) -> ASS &HAABBGGRR */
export function assColor(hex: string, opacity = 1): string {
  const h = HEX.test(hex) ? hex.slice(1) : 'ffffff'
  const a = Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255).toString(16).padStart(2, '0')
  return `&H${a}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase()
}
const bgr = (hex: string) => assColor(hex).slice(4) // BBGGRR for inline \c tags
const assTime = (x: number) => { x = Math.max(0, x); const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), s = x % 60; return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}` }
const assEsc = (x: string) => String(x).replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\n/g, '\\N')

/**
 * Burned-in captions as an ASS script. Same output on desktop and cloud, so a
 * theme looks identical wherever the video is rendered.
 */
export function buildAss(cues: CapCue[], specIn: Partial<CaptionSpec>, W: number, H: number): string {
  const spec = resolveCaption(specIn)
  const f = THEME_FONTS[spec.font]
  const px = captionPx(spec, W, H)
  const outline = spec.box ? Math.max(6, Math.round(px * 0.24)) : Math.round(px * spec.outline * 10) / 10
  const shadow = spec.box ? 0 : Math.round(px * spec.shadow * 10) / 10
  const align = { bottom: 2, lower: 2, top: 8, center: 5 }[spec.position]
  const marginV = spec.position === 'lower' ? Math.round(H * 0.2) : spec.position === 'center' ? 0 : Math.round(H * 0.07)
  const marginX = Math.round(W * 0.07)
  const outlineColour = spec.box ? assColor(spec.boxColor, spec.boxOpacity) : assColor(spec.outlineColor)
  const backColour = spec.box ? assColor('#000000', 0) : assColor(spec.shadowColor, spec.motion === 'glitch' ? 0.85 : 0.9)
  const pri = bgr(spec.color)
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${f.family},${px},${assColor(spec.color)},${assColor(spec.color)},${outlineColour},${backColour},${f.bold ? -1 : 0},0,0,0,100,100,${Math.round(spec.tracking * px * 10) / 10},0,${spec.box ? 3 : 1},${outline},${shadow},${align},${marginX},${marginX},${marginV},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  const ev = (a: number, b: number, text: string, layer = 1) => { if (b - a >= 0.02) lines.push(`Dialogue: ${layer},${assTime(a)},${assTime(b)},Cap,,0,0,0,,${text}`) }
  const say = (w: string) => assEsc(spec.uppercase ? w.toUpperCase() : w)
  let groupNo = 0
  for (const c of cues || []) {
    if (!(c.end > c.start) || !String(c.text || '').trim()) continue
    for (const g of chunkCue(c, spec)) {
      const accent = spec.accentCycle ? spec.accentCycle[groupNo % spec.accentCycle.length] : spec.accent
      const acc = bgr(accent)
      const tilt = spec.tilt ? `\\frz${(groupNo % 2 ? -spec.tilt : spec.tilt).toFixed(1)}` : ''
      groupNo++
      const words = g.words
      const lit = (w: string) => `{\\c&H${acc}&}${say(w)}{\\c&H${pri}&}`
      const plain = () => words.map(w => say(w.t)).join(' ')
      const head = (extra = '') => (tilt || extra ? `{${tilt}${extra}}` : '')
      switch (spec.motion) {
        case 'none': ev(g.s, g.e, head() + plain()); break
        case 'fade': ev(g.s, g.e, head('\\fad(120,100)') + plain()); break
        case 'karaoke': {
          let k = `{${tilt}\\1c&H${acc}&\\2c&H${pri}&}`
          let cur = g.s
          words.forEach((w, i) => {
            if (w.s > cur + 0.01) { k += `{\\k${Math.round((w.s - cur) * 100)}}`; cur = w.s }
            const end = i + 1 < words.length ? words[i + 1].s : Math.max(w.e, w.s + 0.05)
            k += `{\\kf${Math.max(1, Math.round((end - cur) * 100))}}${say(w.t)}${i + 1 < words.length ? ' ' : ''}`
            cur = end
          })
          ev(g.s, g.e, k)
          break
        }
        case 'typewriter': {
          words.forEach((w, i) => {
            const a = i === 0 ? g.s : w.s
            const b = i + 1 < words.length ? words[i + 1].s : g.e
            const shown = words.slice(0, i + 1).map(x => say(x.t)).join(' ')
            const rest = words.slice(i + 1).map(x => say(x.t)).join(' ')
            ev(a, b, head() + shown + (rest ? `{\\alpha&HFF&} ${rest}` : ''))
          })
          break
        }
        case 'glow': {
          const glowB = Math.max(2, Math.round(px * 0.18)), blur = Math.max(2, Math.round(px * 0.22))
          ev(g.s, g.e, `{${tilt}\\fad(80,80)\\bord${glowB}\\blur${blur}\\shad0\\1c&H${acc}&\\3c&H${acc}&\\1a&H60&\\3a&H40&}` + plain(), 0)
          ev(g.s, g.e, `{${tilt}\\fad(80,80)\\3c&H${acc}&}` + plain(), 1)
          break
        }
        case 'glitch': {
          const big = Math.max(3, Math.round(px * 0.12)), small = Math.max(1, Math.round(px * 0.03))
          ev(g.s, g.e, `{${tilt}\\4c&H${bgr(spec.shadowColor)}&\\xshad-${big}\\yshad0\\t(0,160,\\xshad-${small})}` + plain(), 1)
          ev(g.s, Math.min(g.e, g.s + 0.12), `{${tilt}\\shad0\\bord0\\1c&H${acc}&\\1a&H70&\\fsp${Math.round(px * 0.25)}}` + plain(), 0)
          break
        }
        default: { // highlight, pop, bounce: the spoken word in the accent colour
          words.forEach((w, i) => {
            const a = i === 0 ? g.s : w.s
            const b = i + 1 < words.length ? words[i + 1].s : g.e
            let anim = ''
            if (i === 0 && spec.motion === 'pop') anim = '\\fscx78\\fscy78\\t(0,120,\\fscx100\\fscy100)'
            if (i === 0 && spec.motion === 'bounce') anim = '\\fscx55\\fscy55\\t(0,100,\\fscx115\\fscy115)\\t(100,190,\\fscx100\\fscy100)'
            ev(a, b, head(anim) + words.map((x, j) => (j === i ? lit(x.t) : say(x.t))).join(' '))
          })
        }
      }
    }
  }
  return lines.join('\n') + '\n'
}
