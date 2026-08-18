// Can the preview actually show this file, and if not, what should the proxy look like?
//
// The preview is a Chromium <video> element, which is far pickier than FFmpeg: it cannot decode
// HEVC at all in this build, nor 10-bit H.264, and HDR footage would come out grey even where it
// does decode. FFmpeg happily reports such a file as a perfectly good video, which is how a
// phone recording lands on the timeline and plays as nothing at all.
//
// Electron-free so `npm run test:playable` can exercise it standalone.

export interface ProbeInfo {
  videoCodec?: string
  pixFmt?: string
  colorTransfer?: string
  width?: number
  height?: number
  fps?: number
  hasVideo?: boolean
  /** lets the progress percentage be worked out while a proxy builds */
  duration?: number
}

export interface ProxyPlan {
  needed: boolean
  /** short phrase for the user, e.g. "10-bit HEVC" */
  reason: string
  /** true when colour needs converting to SDR, not just re-encoding */
  hdr: boolean
  width: number
  fps: number
}

/** Codecs a Chromium <video> can decode in this build. Anything else gets a proxy. */
const PLAYABLE_CODECS = ['h264', 'avc1', 'vp8', 'vp9', 'av1', 'theora']

/** Transfer curves that mean HDR: colours must be tone-mapped or everything looks washed out. */
const HDR_TRANSFERS = ['arib-std-b67', 'smpte2084', 'smpte428', 'bt2020-10', 'bt2020-12']

export const isHdr = (info: ProbeInfo): boolean =>
  HDR_TRANSFERS.includes((info.colorTransfer || '').toLowerCase())

/** 10-bit and up. Chromium decodes 8-bit only for the codecs we rely on. */
export const isHighBitDepth = (pixFmt?: string): boolean => /(?:10|12|14|16)(?:le|be)$/.test((pixFmt || '').toLowerCase())

/**
 * Decide whether a file needs a preview proxy, and what to make.
 * Deliberately conservative: a proxy that was not strictly needed costs a minute, while a
 * preview that shows nothing costs the user's trust in the whole app.
 */
export function planProxy(info: ProbeInfo, opts: { maxWidth?: number; maxFps?: number } = {}): ProxyPlan {
  const maxWidth = opts.maxWidth ?? 1920
  const maxFps = opts.maxFps ?? 60
  const codec = (info.videoCodec || '').toLowerCase()
  const hdr = isHdr(info)
  const width = Math.min(info.width || maxWidth, maxWidth)
  const fps = Math.min(info.fps || 30, maxFps)
  const plan = (reason: string): ProxyPlan => ({ needed: true, reason, hdr, width, fps })

  if (!info.hasVideo) return { needed: false, reason: '', hdr: false, width, fps }
  if (!PLAYABLE_CODECS.includes(codec)) return plan(`${codec ? codec.toUpperCase() : 'this codec'} is not something the preview can decode`)
  if (isHighBitDepth(info.pixFmt)) return plan(`10-bit ${codec.toUpperCase()} is not something the preview can decode`)
  if (hdr) return plan('HDR colour would look washed out in the preview')
  // Playable, but heavy enough that scrubbing would crawl: 4K120 is 8x the pixels of 1080p60
  if ((info.width || 0) * (info.fps || 0) > maxWidth * maxFps * 2) return plan('very large frames, so scrubbing would be slow')
  return { needed: false, reason: '', hdr: false, width, fps }
}

/**
 * The FFmpeg video filter chain for the proxy. Scaling happens BEFORE tone mapping on purpose:
 * tone mapping is the expensive part and doing it at 1080p rather than 4K is a third faster,
 * measured on a real 4K120 HLG phone clip.
 */
export function proxyFilter(plan: ProxyPlan, hwDecode: boolean): string {
  const parts: string[] = []
  if (hwDecode) parts.push('hwdownload', `format=${plan.hdr ? 'p010le' : 'nv12'}`)
  parts.push(`fps=${plan.fps}`, `scale=${plan.width}:-2:flags=bilinear`)
  if (plan.hdr) {
    parts.push('zscale=t=linear:npl=100', 'tonemap=hable:desat=0', 'zscale=p=bt709:t=bt709:m=bt709:r=tv')
  }
  parts.push('format=nv12')
  return parts.join(',')
}

/** Same colour conversion for the real export, where the original file is the input. */
export const HDR_TO_SDR = 'zscale=t=linear:npl=100,tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv'

/** Cache key so the same file is never converted twice. */
export const proxyKey = (path: string, size: number, mtimeMs: number): string => {
  const name = (path.split(/[\/]/).pop() || 'clip').replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 40)
  let h = 0
  for (const ch of `${path}|${size}|${Math.round(mtimeMs)}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `${name}-${h.toString(36)}.mp4`
}
