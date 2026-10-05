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
  /** as DISPLAYED: a phone's portrait clip (landscape frames + a rotate-90 flag) is narrower than tall */
  width?: number
  height?: number
  fps?: number
  hasVideo?: boolean
  /** lets the progress percentage be worked out while a proxy builds */
  duration?: number
  /** degrees clockwise the stored frames are turned for display (a phone's 0/90/180/270 flag) */
  rotation?: number
}

export interface ProxyPlan {
  needed: boolean
  /** short phrase for the user, e.g. "10-bit HEVC" */
  reason: string
  /** true when colour needs converting to SDR, not just re-encoding */
  hdr: boolean
  /** output width for landscape footage (the long side); kept for callers that read it */
  width: number
  /** the proxy's LONG side: maxWidth bounds this, so a portrait proxy is not 1920 wide */
  long: number
  /** taller than wide, as displayed */
  portrait: boolean
  fps: number
  /** the stored frames' display rotation, 0/90/180/270 clockwise */
  rotate?: number
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
  // The size cap is on the LONG side. Capping the width alone sized a portrait phone clip's proxy
  // 1920 wide, which is 1920x3413: bigger than the 1080x1920 original it stands in for.
  const portrait = (info.height || 0) > (info.width || 0)
  const long = Math.min(Math.max(info.width || 0, info.height || 0) || maxWidth, maxWidth)
  const width = portrait ? Math.max(2, Math.round((long * (info.width || 0)) / (info.height || 1) / 2) * 2) : long
  const fps = Math.min(info.fps || 30, maxFps)
  const rotate = quarterTurn(info.rotation)
  const plan = (reason: string): ProxyPlan => ({ needed: true, reason, hdr, width, long, portrait, fps, rotate })

  if (!info.hasVideo) return { needed: false, reason: '', hdr: false, width, long, portrait, fps, rotate }
  if (!PLAYABLE_CODECS.includes(codec)) return plan(`${codec ? codec.toUpperCase() : 'this codec'} is not something the preview can decode`)
  if (isHighBitDepth(info.pixFmt)) return plan(`10-bit ${codec.toUpperCase()} is not something the preview can decode`)
  if (hdr) return plan('HDR colour would look washed out in the preview')
  // Playable, but heavy enough that scrubbing would crawl: 4K120 is 8x the pixels of 1080p60
  if (Math.max(info.width || 0, info.height || 0) * (info.fps || 0) > maxWidth * maxFps * 2) return plan('very large frames, so scrubbing would be slow')
  return { needed: false, reason: '', hdr: false, width, long, portrait, fps, rotate }
}

/** 0, 90, 180 or 270: the nearest quarter turn of a clockwise rotation in degrees (anything else is 0). */
export const quarterTurn = (deg?: number): number => {
  const d = ((Math.round(Number(deg) || 0) % 360) + 360) % 360
  return [0, 90, 180, 270].find(q => Math.abs(q - d) < 2) ?? 0
}

/**
 * The FFmpeg video filter chain for the proxy. Scaling happens BEFORE tone mapping on purpose:
 * tone mapping is the expensive part and doing it at 1080p rather than 4K is a third faster,
 * measured on a real 4K120 HLG phone clip.
 */
export function proxyFilter(plan: ProxyPlan, hwDecode: boolean): string {
  const parts: string[] = []
  if (hwDecode) parts.push('hwdownload', `format=${plan.hdr ? 'p010le' : 'nv12'}`)
  // ffmpeg turns software-decoded frames upright by itself (autorotate) but NOT hardware-decoded
  // ones, and the proxy keeps no rotation flag: a portrait phone clip proxied through Quick Sync
  // came out 1920x1080, lying on its side. So on that path the turn is done here, after the scale
  // (cheaper on the smaller frame), and the scale is worked out on the frame as stored.
  const turn = hwDecode ? (plan.rotate ?? 0) : 0
  const portraitNow = turn === 90 || turn === 270 ? !plan.portrait : plan.portrait
  // scale the long side; the other follows the picture's shape
  parts.push(`fps=${plan.fps}`, portraitNow ? `scale=-2:${plan.long}:flags=bilinear` : `scale=${plan.long ?? plan.width}:-2:flags=bilinear`)
  if (turn === 90) parts.push('transpose=clock')
  else if (turn === 270) parts.push('transpose=cclock')
  else if (turn === 180) parts.push('hflip', 'vflip')
  if (plan.hdr) {
    parts.push('zscale=t=linear:npl=100', 'tonemap=hable:desat=0', 'zscale=p=bt709:t=bt709:m=bt709:r=tv')
  }
  parts.push('format=nv12')
  return parts.join(',')
}

/**
 * May an existing proxy stand in for this plan? Size alone is not enough: an old Quick Sync proxy of
 * a portrait phone clip is the right SIZE lying on its side (1920x1080 for a 1080x1920 picture), and
 * an old software one was blown up past its own source (1920x3413). Both passed a size-only test and
 * were then picked over the original for exports. So the copy must have the picture's shape, be no
 * bigger than its source, and be at least as big and as fast as the plan asks for (a smaller tier's
 * copy is rebuilt after the setting goes up; a bigger one is kept when it goes down).
 */
export function proxyFits(proxy: { width: number; height: number; fps: number }, info: ProbeInfo, plan: ProxyPlan): boolean {
  if (!(proxy?.width > 0 && proxy?.height > 0)) return false
  const long = Math.max(proxy.width, proxy.height)
  const srcW = info.width || 0, srcH = info.height || 0
  if (srcW > 0 && srcH > 0) {
    // same aspect as the picture as displayed (scale=-2 rounds to even pixels, hence the slack);
    // a sideways copy has the inverse aspect, a square picture must stay square
    const want = srcW / srcH, got = proxy.width / proxy.height
    if (Math.abs(got - want) / want > 0.03) return false
    if (long > Math.max(srcW, srcH) + 2) return false
  }
  return long >= plan.long - 2 && (proxy.fps || 0) >= plan.fps - 1
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
