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
 * Geometry is estimated, not measured: the export burns text with drawtext in
 * Arial, whose average advance is close to 0.56 em for mixed-case copy and
 * 0.66 em for CAPS. That is accurate enough to catch collisions and overflow,
 * which is the point; it is not a typesetter.
 *
 * Pure module: no I/O, no Electron.
 */

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
  return 0.56 + (0.66 - 0.56) * capShare
}

/** Estimated on-screen box (including the background bar's padding when box is on). */
export function estimateBox(t: TextLike, frameW = 1920, frameH = 1080): Rect {
  const scale = frameH / 1080
  const size = t.fontSize * scale
  const lines = String(t.text ?? '').split('\n')
  const widest = Math.max(...lines.map(l => l.length * advance(l)), 0.5)
  const pad = t.box ? size * 0.25 : 0
  const w = widest * size + pad * 2
  const h = lines.length * size * LINE_HEIGHT + pad * 2
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
