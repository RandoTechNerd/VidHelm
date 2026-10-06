/**
 * Design rules for on-screen text, as code.
 *
 * Every one of these was hand-written for the CruxStudy teaser and then had
 * to be re-checked by eye: text that fits inside its pill, no two texts on
 * top of each other, nothing off the edge of the frame, no sub-half-second
 * flashes. They belong here as defaults and as an export-time check, so the
 * agent's `add_text` gets them for free and `export_video` reports the ones
 * that slipped through.
 *
 * Geometry is estimated, not measured: a title with no theme font is set in
 * TITLE_FONT (Inter SemiBold), whose average advance measured 0.49 em for
 * mixed-case copy and 0.62 em for CAPS through drawtext itself; the estimate
 * adds a little for wide letters. That is accurate enough to catch collisions
 * and overflow, which is the point; it is not a typesetter.
 *
 * Pure module: no I/O, no Electron.
 */

/**
 * The face a title is set in when it names no theme font, in the preview AND the export: the
 * bundled file (public/fonts, also registered as a theme font) rather than whatever the system has.
 * The export used to burn Arial Regular while the preview showed bold Inter, so every title changed
 * shape and width on the way out. Registered for the browser at weight 400 (see fontFaceCss): ask
 * for more and Chromium paints a fake bold the export cannot.
 */
export const TITLE_FONT = { file: 'Inter-SemiBold.ttf', family: 'Inter SemiBold' } as const

/** A title's background box padding, in em: the CSS padding and drawtext's boxborderw (top/bottom, left/right). */
export const BOX_PAD = { y: 0.15, x: 0.4 } as const

/** Share of the frame width a title may take before it wraps (the preview's max-width). */
export const WRAP_WIDTH = 0.92

export interface TextLike {
  id?: string
  text: string
  /** centre, 0..1 of frame */
  x: number
  y: number
  /** px at 1080p height */
  fontSize: number
  start: number
  duration: number
  box?: boolean
}

/** frame-fraction rectangle */
export interface Rect { x0: number; y0: number; x1: number; y1: number }

const LINE_HEIGHT = 1.2

function advance(text: string): number {
  const caps = (text.match(/[A-Z]/g) || []).length
  const letters = (text.match(/[A-Za-z]/g) || []).length || 1
  const capShare = caps / letters
  return 0.52 + (0.65 - 0.52) * capShare
}

/** Estimated on-screen box (including the background bar's padding when box is on). */
export function estimateBox(t: TextLike, frameW = 1920, frameH = 1080): Rect {
  const scale = frameH / 1080
  const size = t.fontSize * scale
  const lines = String(t.text ?? '').split('\n')
  const widest = Math.max(...lines.map(l => l.length * advance(l)), 0.5)
  const w = widest * size + (t.box ? size * BOX_PAD.x * 2 : 0)
  const h = lines.length * size * LINE_HEIGHT + (t.box ? size * BOX_PAD.y * 2 : 0)
  const cx = t.x * frameW, cy = t.y * frameH
  return { x0: (cx - w / 2) / frameW, y0: (cy - h / 2) / frameH, x1: (cx + w / 2) / frameW, y1: (cy + h / 2) / frameH }
}

/** Largest font size (<= requested) whose widest line fits within maxWidth of the frame. */
export function fitFontSize(text: string, fontSize: number, maxWidth = 0.9, frameW = 1920, frameH = 1080): number {
  const probe = { text, x: 0.5, y: 0.5, fontSize, start: 0, duration: 1 }
  const box = estimateBox(probe, frameW, frameH)
  const width = box.x1 - box.x0
  if (width <= maxWidth) return fontSize
  return Math.max(12, Math.floor(fontSize * (maxWidth / width)))
}

const intersects = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

export interface Overlap { a: string; b: string; from: number; to: number }
export interface OffFrame { id: string; side: 'left' | 'right' | 'top' | 'bottom' }
export interface Flash { id: string; duration: number }

export interface LayoutReport {
  overlaps: Overlap[]
  offFrame: OffFrame[]
  flashes: Flash[]
  /** one-line verdicts the agent can relay */
  notes: string[]
}

/** Every rule at once, over the whole text track. */
export function layoutReport(texts: TextLike[], frameW = 1920, frameH = 1080, minDuration = 0.5): LayoutReport {
  const overlaps: Overlap[] = []
  const offFrame: OffFrame[] = []
  const flashes: Flash[] = []
  const boxes = texts.map(t => ({ t, id: t.id ?? t.text.slice(0, 24), box: estimateBox(t, frameW, frameH) }))

  for (const { t, id, box } of boxes) {
    if (box.x0 < -0.005) offFrame.push({ id, side: 'left' })
    if (box.x1 > 1.005) offFrame.push({ id, side: 'right' })
    if (box.y0 < -0.005) offFrame.push({ id, side: 'top' })
    if (box.y1 > 1.005) offFrame.push({ id, side: 'bottom' })
    if (t.duration > 0 && t.duration < minDuration) flashes.push({ id, duration: t.duration })
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const A = boxes[i], B = boxes[j]
    const from = Math.max(A.t.start, B.t.start), to = Math.min(A.t.start + A.t.duration, B.t.start + B.t.duration)
    if (to - from <= 0.05) continue
    if (intersects(A.box, B.box)) overlaps.push({ a: A.id, b: B.id, from: +from.toFixed(2), to: +to.toFixed(2) })
  }
  const notes: string[] = []
  for (const o of overlaps) notes.push(`"${o.a}" and "${o.b}" overlap on screen from ${o.from}s to ${o.to}s`)
  for (const f of offFrame) notes.push(`"${f.id}" runs off the ${f.side} edge of the frame`)
  for (const f of flashes) notes.push(`"${f.id}" is on screen for only ${f.duration}s, shorter than a viewer can read`)
  return { overlaps, offFrame, flashes, notes }
}

/* ---- motion-template style presets ------------------------------------------
 * Not an animation renderer (yet); these are the positions, sizes, boxes and
 * fades that make a title, a lower third, a caption or an end card read as
 * that thing. The agent passes preset:'lower-third' and gets the right
 * defaults; anything it also passes explicitly wins. */

export type TextPreset = 'title' | 'lower-third' | 'caption' | 'end-card'

export interface PresetValues {
  x: number; y: number; fontSize: number; duration: number
  fadeIn: number; fadeOut: number; box: boolean; boxOpacity: number; color: string
}

export const PRESETS: Record<TextPreset, PresetValues> = {
  'title':       { x: 0.5,  y: 0.42, fontSize: 108, duration: 3.5, fadeIn: 0.25, fadeOut: 0.35, box: true, boxOpacity: 0.55, color: '#ffffff' },
  'lower-third': { x: 0.24, y: 0.84, fontSize: 48,  duration: 4.5, fadeIn: 0.2,  fadeOut: 0.3,  box: true, boxOpacity: 0.7,  color: '#ffffff' },
  'caption':     { x: 0.5,  y: 0.88, fontSize: 56,  duration: 3,   fadeIn: 0.08, fadeOut: 0.12, box: true, boxOpacity: 0.6,  color: '#ffffff' },
  'end-card':    { x: 0.5,  y: 0.5,  fontSize: 84,  duration: 6,   fadeIn: 0.5,  fadeOut: 0.8,  box: true, boxOpacity: 0.75, color: '#ffffff' },
}

/** Preset defaults, with the font shrunk so the text fits its lane. */
export function presetFor(name: string | undefined, text: string, frameW = 1920, frameH = 1080): Partial<PresetValues> {
  const p = PRESETS[name as TextPreset]
  if (!p) return {}
  const lane = name === 'lower-third' ? 0.44 : 0.9
  return { ...p, fontSize: fitFontSize(text, p.fontSize, lane, frameW, frameH) }
}

/* ---- checked fields ---------------------------------------------------------
 * The exporter writes a text's colours and numbers straight into a drawtext
 * filter, where ':' starts a new option. Unchecked, a colour such as
 * "white:textfile=<any file>" rendered that file into the video, and a start
 * time could rewrite the enable expression. Everything that reaches the filter
 * is a number or a hex colour, checked here, at every door: the agent's
 * add_text and update_text, a project being opened, and the export itself. */

const NAMED: Record<string, string> = {
  white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', lime: '#00ff00', blue: '#0000ff',
  yellow: '#ffff00', orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', cyan: '#00ffff', magenta: '#ff00ff',
  gray: '#808080', grey: '#808080',
}

/** A colour as '#rrggbb' or '#rrggbbaa' (also taken: '#rgb', no '#', and a few plain names), or the fallback. */
export function hexColor(v: unknown, fallback: string): string {
  const s = String(v ?? '').trim()
  if (NAMED[s.toLowerCase()]) return NAMED[s.toLowerCase()]
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s)
  if (!m) return fallback
  const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1]
  return '#' + h
}

const num = (v: unknown, fallback: number, lo = -Infinity, hi = Infinity) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

export interface TextFields {
  text?: unknown; start?: unknown; duration?: unknown; x?: unknown; y?: unknown; fontSize?: unknown
  color?: unknown; fadeIn?: unknown; fadeOut?: unknown; box?: unknown; boxOpacity?: unknown; boxColor?: unknown
  outline?: unknown; outlineColor?: unknown
}

/**
 * The same text with every field the exporter uses made safe: numbers finite and in range, colours
 * hex, the text a string. Fields it does not have stay absent; everything else (id, font, caption)
 * passes through untouched.
 */
export function cleanText<T extends TextFields>(t: T): T & { text: string; start: number; duration: number; x: number; y: number; fontSize: number; color: string; fadeIn: number; fadeOut: number } {
  const fixed: Record<string, unknown> = {
    text: String(t.text ?? ''),
    start: num(t.start, 0, 0),
    duration: num(t.duration, 3, 0.04),
    x: num(t.x, 0.5, -1, 2),
    y: num(t.y, 0.5, -1, 2),
    fontSize: num(t.fontSize, 64, 4, 1000),
    color: hexColor(t.color, '#ffffff'),
    fadeIn: num(t.fadeIn, 0, 0),
    fadeOut: num(t.fadeOut, 0, 0),
  }
  if (t.box !== undefined) fixed.box = t.box === true || t.box === 'true' || t.box === 1
  if (t.boxOpacity !== undefined) fixed.boxOpacity = num(t.boxOpacity, 0.5, 0, 1)
  if (t.boxColor !== undefined) fixed.boxColor = hexColor(t.boxColor, '#000000')
  if (t.outline !== undefined) fixed.outline = num(t.outline, 0, 0, 0.5)
  if (t.outlineColor !== undefined) fixed.outlineColor = hexColor(t.outlineColor, '#000000')
  return { ...t, ...fixed } as T & { text: string; start: number; duration: number; x: number; y: number; fontSize: number; color: string; fadeIn: number; fadeOut: number }
}

/**
 * A paragraph cut where a line may break, as CSS breaks a title: at a space (the space goes with the
 * break), and after a hyphen inside a word ("step-|by-|step", the hyphen stays at the line's end),
 * but not between a hyphen and a digit ("-5", "COVID-19") and not between two hyphens.
 */
function breakPieces(par: string): { glue: string; piece: string }[] {
  const out: { glue: string; piece: string }[] = []
  par.split(' ').forEach((word, i) => {
    const glue = i === 0 ? '' : ' '
    const parts = word.split(/(?<=[^\s-]-)(?=[^\s\d-])/)
    parts.forEach((piece, j) => out.push({ glue: j === 0 ? glue : '', piece }))
  })
  return out
}

/**
 * Line breaks for a title: greedy, at spaces and after a word's hyphens, the author's own newlines
 * kept, a word longer than the line left whole (as CSS does). The export has no wrapping of its own,
 * so a title that took two lines in the preview ran off both edges of the frame. The preview shows
 * these same lines (it no longer wraps by itself), so both break in the same places and the box hugs
 * the same widest line. `measure` is the width of a string in the export's pixels, from a canvas in
 * the renderer.
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string {
  return String(text ?? '').split('\n').map(par => {
    const lines: string[] = []
    let line = ''
    breakPieces(par).forEach(({ glue, piece }, i) => {
      const next = i === 0 ? piece : `${line}${glue}${piece}`
      if (i > 0 && line && measure(next) > maxWidth) { lines.push(line); line = piece } else line = next
    })
    lines.push(line)
    return lines.join('\n')
  }).join('\n')
}
