/**
 * Thumbnail picking: which frames of a video are worth a thumbnail, and how
 * the words sit on it.
 *
 * Real pictures beat painted ones for this channel, so the baseline is: the
 * creator's own photo when there is one, else the best real frame from the
 * footage, else a placeholder that is obviously a placeholder (and a nudge to
 * shoot the photo). This module scores frames from tiny RGB thumbnails that
 * ffmpeg decodes; it is a heuristic, not a face detector: sharp, well exposed,
 * contrasty, colourful frames with some skin tone in the middle score higher,
 * and near-duplicates are dropped so the shortlist shows real choices.
 *
 * Pure module: no I/O, no Electron.
 */

import { THEME_FONTS, type ThumbSpec } from './styletheme'

export interface FrameScore {
  /** 0..1 overall */
  score: number
  sharpness: number
  exposure: number
  contrast: number
  color: number
  skin: number
  /** 16x9 grey signature for de-duplication */
  sig: number[]
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

/** Score one frame from packed RGB24 pixels (w*h*3 bytes). */
export function scoreFrame(rgb: Uint8Array, w: number, h: number): FrameScore {
  const n = w * h
  const grey = new Float32Array(n)
  let sum = 0, sumSq = 0, colorSum = 0, skinCentre = 0, centreN = 0
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2]
    const y = 0.299 * r + 0.587 * g + 0.114 * b
    grey[i] = y; sum += y; sumSq += y * y
    // Hasler-Suesstrunk style colourfulness, per pixel opponent channels
    const rg = Math.abs(r - g), yb = Math.abs(0.5 * (r + g) - b)
    colorSum += Math.sqrt(rg * rg + yb * yb)
    const x = i % w, row = (i / w) | 0
    if (x > w * 0.2 && x < w * 0.8 && row > h * 0.1 && row < h * 0.9) {
      centreN++
      // a common RGB skin rule (Kovac et al.), loose on purpose
      if (r > 95 && g > 40 && b > 20 && r > g && r > b && r - Math.min(g, b) > 15 && Math.abs(r - g) > 15) skinCentre++
    }
  }
  const mean = sum / n
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean))
  // Laplacian variance, centre weighted twice: the subject is usually there, and a sharp
  // background behind a blurry subject should not win
  let lapSum = 0, lapSq = 0, lapN = 0
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x
    const l = 4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - w] - grey[i + w]
    const wgt = x > w * 0.25 && x < w * 0.75 && y > h * 0.2 && y < h * 0.8 ? 2 : 1
    lapSum += l * wgt; lapSq += l * l * wgt; lapN += wgt
  }
  const lapVar = lapSq / lapN - (lapSum / lapN) ** 2
  const sharpness = clamp01(Math.log10(1 + Math.max(0, lapVar)) / 3.2)
  const exposure = clamp01(1 - Math.abs(mean - 120) / 90)          // dark or blown-out frames lose
  const contrast = clamp01(std / 64)
  const color = clamp01(colorSum / n / 70)
  const skinShare = centreN ? skinCentre / centreN : 0
  const skin = clamp01(skinShare / 0.18)                             // a face/hands in shot, roughly
  const score = clamp01(0.38 * sharpness + 0.2 * exposure + 0.16 * contrast + 0.12 * color + 0.14 * skin)
  // de-dup signature: 16x9 block means
  const sig: number[] = []
  for (let by = 0; by < 9; by++) for (let bx = 0; bx < 16; bx++) {
    let s = 0, c = 0
    for (let y = Math.floor(by * h / 9); y < Math.floor((by + 1) * h / 9); y++) for (let x = Math.floor(bx * w / 16); x < Math.floor((bx + 1) * w / 16); x++) { s += grey[y * w + x]; c++ }
    sig.push(c ? s / c : 0)
  }
  return { score: +score.toFixed(3), sharpness: +sharpness.toFixed(3), exposure: +exposure.toFixed(3), contrast: +contrast.toFixed(3), color: +color.toFixed(3), skin: +skin.toFixed(3), sig }
}

/** Mean absolute difference of two signatures, 0..255. */
export const sigDistance = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - (b[i] ?? 0)), 0) / Math.max(1, a.length)

/** Best frames first, near-duplicates of a better frame dropped. */
export function rankFrames<T extends { score: FrameScore }>(frames: T[], keep = 8, minDistance = 12): T[] {
  const sorted = [...frames].sort((a, b) => b.score.score - a.score.score)
  const out: T[] = []
  for (const f of sorted) {
    if (out.some(o => sigDistance(o.score.sig, f.score.sig) < minDistance)) continue
    out.push(f)
    if (out.length >= keep) break
  }
  return out
}

/** Sample times across a clip, skipping the first and last few percent (fades, fumbling with the camera). */
export function sampleTimes(duration: number, count: number, start = 0, edge = 0.05): number[] {
  const n = Math.max(1, Math.round(count))
  const a = start + duration * edge, span = duration * (1 - 2 * edge)
  return Array.from({ length: n }, (_, i) => +(a + ((i + 0.5) / n) * span).toFixed(2))
}

/** Image files that look like the creator's own thumbnail photo. */
export function looksLikeThumbPhoto(name: string): boolean {
  return /\.(jpe?g|png|webp)$/i.test(name) && /(thumb|photo|cover|hero|poster|selfie)/i.test(name.replace(/_thumbnail\.png$/i, ''))
}

export interface ThumbLine { text: string; size: number; color: string; y: number }

/**
 * Thumbnail text: up to two lines ("BIG HOOK | smaller second line" or a newline), sized to fit
 * the left 60% of a 1280x720 frame (the right side is usually the face or the build), bottom-left.
 */
export function thumbTextLayout(subtitle: string, spec: ThumbSpec, W = 1280, H = 720): ThumbLine[] {
  let raw = String(subtitle || '').split(/\s*\|\s*|\n/).map(s => s.trim()).filter(Boolean).slice(0, 2)
  if (!raw.length) return []
  // one long line wraps into two of the same colour rather than shrinking into unreadable type
  let wrapped = false
  if (raw.length === 1 && raw[0].length > 18 && raw[0].includes(' ')) {
    const words = raw[0].split(/\s+/), half = raw[0].length / 2
    let best = 1, bestD = Infinity
    for (let k = 1; k < words.length; k++) { const d = Math.abs(words.slice(0, k).join(' ').length - half); if (d < bestD) { bestD = d; best = k } }
    raw = [words.slice(0, best).join(' '), words.slice(best).join(' ')]
    wrapped = true
  }
  const adv = THEME_FONTS[spec.font]?.advance ?? 0.56
  const caps = spec.uppercase
  const lines = raw.map(t => (caps ? t.toUpperCase() : t))
  const maxW = W * (lines.length > 1 || lines[0].length > 14 ? 0.62 : 0.56)
  const fit = (t: string, want: number) => Math.max(36, Math.min(want, Math.floor(maxW / (adv * (caps ? 1.12 : 1) * Math.max(4, t.length)))))
  const sizes = wrapped ? [fit(lines[0], 112), fit(lines[1], 112)] : [fit(lines[0], 132), lines[1] ? fit(lines[1], 84) : 0]
  if (wrapped) sizes[0] = sizes[1] = Math.min(sizes[0], sizes[1])
  const margin = 44
  const out: ThumbLine[] = []
  let y = H - margin
  for (let i = lines.length - 1; i >= 0; i--) {
    y -= sizes[i]
    out.unshift({ text: lines[i], size: sizes[i], color: i === 1 && !wrapped ? spec.accent : spec.color, y })
    y -= Math.round(sizes[i] * 0.18)
  }
  return out
}

/** What to tell the creator when the thumbnail is not from a real photo of theirs. */
export function photoNudge(source: 'photo' | 'frame' | 'placeholder'): string | undefined {
  if (source === 'photo') return undefined
  if (source === 'placeholder') return 'This is a PLACEHOLDER. Real photos win on this channel: shoot one (you + the build, close, eyes to camera, bright light) and save it in the project folder as thumb.jpg, then run the thumbnail again.'
  return 'Made from the best real frame. A posed photo usually beats a video frame: save one in the project folder as thumb.jpg (you + the build, close, eyes to camera) and it will be used instead.'
}
