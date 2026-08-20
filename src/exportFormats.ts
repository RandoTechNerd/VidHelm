export type ExportFormat = 'mp4' | 'webm' | 'webp' | 'png-sequence'

export type ExportFormatSpec = {
  label: string
  detail: string
  defaultName: string
  extension: string
  alpha: boolean
  audio: boolean
  qualityCheck: boolean
}

export const EXPORT_FORMATS: Record<ExportFormat, ExportFormatSpec> = {
  mp4: {
    label: 'MP4', detail: 'H.264 · background color · audio',
    defaultName: 'vidhelm_export.mp4', extension: '.mp4',
    alpha: false, audio: true, qualityCheck: true,
  },
  webm: {
    label: 'WebM', detail: 'VP9 · background color · audio',
    defaultName: 'vidhelm_export.webm', extension: '.webm',
    alpha: false, audio: true, qualityCheck: true,
  },
  webp: {
    label: 'WebP (alpha)', detail: 'Animated · transparent · no audio',
    defaultName: 'vidhelm_export.webp', extension: '.webp',
    alpha: true, audio: false, qualityCheck: false,
  },
  'png-sequence': {
    label: 'PNG sequence (alpha)', detail: 'Transparent frames · ZIP · no audio',
    defaultName: 'vidhelm_export-frames.zip', extension: '.zip',
    alpha: true, audio: false, qualityCheck: false,
  },
}

export const isExportFormat = (value: unknown): value is ExportFormat =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(EXPORT_FORMATS, value)

export const defaultExportName = (format: ExportFormat) => EXPORT_FORMATS[format].defaultName

const formatFromPath = (outputPath: string): ExportFormat | undefined => {
  const lower = String(outputPath || '').toLowerCase()
  if (lower.endsWith('.webm')) return 'webm'
  if (lower.endsWith('.webp')) return 'webp'
  if (lower.endsWith('.zip')) return 'png-sequence'
  if (lower.endsWith('.mp4')) return 'mp4'
  return undefined
}

/**
 * The filename is part of the export contract: media players choose a demuxer from it.
 * Reject an explicit mismatch rather than quietly putting one container in another
 * extension, which produces a file that looks corrupt when opened elsewhere.
 */
export const resolveExportFormat = (requested: unknown, outputPath: string): ExportFormat => {
  if (requested !== undefined && requested !== null && requested !== '' && !isExportFormat(requested)) {
    throw new Error(`Unsupported export format: ${String(requested)}`)
  }
  const explicit = isExportFormat(requested) ? requested : undefined
  const inferred = formatFromPath(outputPath)
  if (explicit && inferred && explicit !== inferred) {
    throw new Error(`${explicit} export requires a ${EXPORT_FORMATS[explicit].extension} output path`)
  }
  return explicit || inferred || 'mp4'
}

/** FFmpeg color sources accept RRGGBB. Invalid bridge input falls back safely to black. */
export const safeBackground = (value: unknown): string => {
  const match = String(value || '').trim().match(/^#?([0-9a-f]{6})$/i)
  return match ? match[1].toLowerCase() : '000000'
}

export const resolveMediaExportSource = (
  media: { path: string; proxyPath?: string; hdr?: boolean; alpha?: boolean } | undefined,
  outHeight: number,
) => {
  // Chromium previews alpha in VP9, while the bundled FFmpeg decoder does not
  // expose that alpha plane. Alpha imports must render from their FFV1 master.
  if (media?.alpha) return { path: media.path, hdr: false }
  return media?.proxyPath && outHeight <= 1080
    ? { path: media.proxyPath, hdr: false }
    : { path: media?.path, hdr: media?.hdr }
}

/** libwebp_anim in the bundled FFmpeg only retains alpha in VP8L lossless mode. */
export const webpEncoderOptions = (quality: 'medium' | 'high', fps: number, duration: number) => [
  '-pix_fmt', 'bgra',
  '-lossless', '1',
  '-compression_level', quality === 'high' ? '6' : '4',
  '-quality', quality === 'high' ? '90' : '75',
  '-loop', '0',
  '-r', String(fps),
  '-t', String(duration),
]
