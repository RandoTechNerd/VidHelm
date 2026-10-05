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
  /** channels in the first audio stream (1 = a mono lav or phone mic) */
  audioChannels?: number
  /** a song's embedded album art: listed by ffprobe as a video stream, but it is one still picture */
  hasCoverArt?: boolean
  /**
   * The container never got its length or index written (a recording cut off by a crash or a full
   * disk). The duration was measured by reading the file through, and the preview cannot seek it.
   */
  needsRemux?: boolean
}

export interface ProxyPlan {
  needed: boolean
  /** short phrase for the user, e.g. "10-bit HEVC" */
  reason: string
  /** true when colour needs converting to SDR, not just re-encoding */
  hdr: boolean
  /** 10 bits or more per sample: a GPU decoder hands these frames back as P010, not NV12 */
  tenBit: boolean
  /** the picture is fine, only the container is broken: copy the video into a new file, no re-encode */
  remux?: boolean
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

/**
 * Transfer curves that mean HDR: colours must be tone-mapped or everything looks washed out. Only
 * HLG and PQ. bt2020-10/-12 are the ordinary SDR gamma curve at a higher bit depth (what a 10-bit
 * SDR camera file carries) and smpte428 is cinema XYZ; counting them as HDR sent plain footage
 * through the tone map, which darkens and flattens a picture that was already right.
 */
const HDR_TRANSFERS = ['arib-std-b67', 'smpte2084']

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
  const tenBit = isHighBitDepth(info.pixFmt)
  const plan = (reason: string, remux?: boolean): ProxyPlan => ({ needed: true, reason, hdr, tenBit, width, long, portrait, fps, rotate, ...(remux ? { remux } : {}) })
  const none: ProxyPlan = { needed: false, reason: '', hdr: false, tenBit, width, long, portrait, fps, rotate }

  if (!info.hasVideo) return none
  if (!PLAYABLE_CODECS.includes(codec)) return plan(`${codec ? codec.toUpperCase() : 'this codec'} is not something the preview can decode`)
  if (tenBit) return plan(`10-bit ${codec.toUpperCase()} is not something the preview can decode`)
  if (hdr) return plan('HDR colour would look washed out in the preview')
  // Playable, but heavy enough that scrubbing would crawl: 4K120 is 8x the pixels of 1080p60
  if (Math.max(info.width || 0, info.height || 0) * (info.fps || 0) > maxWidth * maxFps * 2) return plan('very large frames, so scrubbing would be slow')
  // The picture itself plays; only the container is broken, so copying it into a new file is enough
  // (seconds, no quality lost) where a re-encode would take minutes
  if (info.needsRemux) return plan('the recording was never finished (cut off by a crash?), so the preview cannot find its way around it', true)
  return none
}

/**
 * Can the GPU decode this, so the proxy may ask for hardware decoding? Only 4:2:0 in the codecs
 * Quick Sync and NVDEC actually handle. ProRes, DNxHR, 4:2:2 and 10-bit H.264 have no hardware
 * decoder: ffmpeg fell back to software frames, `hwdownload` then had nothing to download, and the
 * build wrote a 0 byte proxy (measured on a Sony XAVC S 4:2:2 10-bit clip, ProRes and DNxHR).
 */
export function canHwDecode(codec?: string, pixFmt?: string): boolean {
  const c = (codec || '').toLowerCase(), p = (pixFmt || '').toLowerCase()
  if (c === 'h264') return p === 'yuv420p'
  if (c === 'hevc' || c === 'vp9' || c === 'av1') return p === 'yuv420p' || p === 'yuv420p10le'
  return false
}

/** One way of building a proxy. `video` is the encoder, or 'copy' for a remux. */
export interface ProxyAttempt {
  video: string
  /** decode on the GPU too (only where canHwDecode says it can) */
  hwDecode: boolean
  /** names the attempt when telling the user which ones failed */
  label: string
}

const ENCODER_NAMES: Record<string, string> = { h264_qsv: 'Quick Sync', h264_nvenc: 'NVENC', h264_amf: 'AMF' }
// How each encoder's matching decoder is asked for. AMF has none here: its "hardware" rung would be
// the software one again, so it is left out.
const HWACCEL: Record<string, string> = { h264_qsv: 'qsv', h264_nvenc: 'cuda' }

/**
 * The order to try building a proxy in, fastest first, each rung dropping the part most likely to
 * be what failed: GPU decode (the codec or chroma it cannot do), then the GPU encoder (a driver that
 * advertised it and then refused), ending on x264, which always works, just slower. A remux tries
 * the copy first and falls back to a real encode.
 */
export function proxyAttempts(encoder: string, info: ProbeInfo, plan: Pick<ProxyPlan, 'remux'>): ProxyAttempt[] {
  const out: ProxyAttempt[] = []
  if (plan.remux) out.push({ video: 'copy', hwDecode: false, label: 'copy into a new file' })
  const name = ENCODER_NAMES[encoder]
  if (name) {
    if (HWACCEL[encoder] && canHwDecode(info.videoCodec, info.pixFmt)) out.push({ video: encoder, hwDecode: true, label: `${name} decode and encode` })
    out.push({ video: encoder, hwDecode: false, label: `software decode, ${name} encode` })
  }
  out.push({ video: 'libx264', hwDecode: false, label: 'software (x264)' })
  return out
}

/**
 * The full ffmpeg argument list for one attempt. `-stats` keeps the time= lines coming for the
 * progress bar. No -noautorotate, on purpose: with it ffmpeg 6.1 copies the phone's rotate flag onto
 * the proxy, so a Quick Sync copy that was already turned upright in the filter played sideways
 * again (measured: 1080x1920 frames tagged rotate=90). Left on, ffmpeg turns software frames itself
 * and drops the flag, and proxyFilter turns the GPU ones.
 */
export function proxyArgs(input: string, output: string, plan: ProxyPlan, attempt: ProxyAttempt): string[] {
  const args = ['-y', '-v', 'error', '-stats']
  const accel = attempt.hwDecode ? HWACCEL[attempt.video] : undefined
  if (accel) args.push('-hwaccel', accel)
  args.push('-i', input)
  if (attempt.video === 'copy') {
    // the audio is re-encoded anyway: an MKV's PCM or FLAC does not always go into an MP4 as-is
    args.push('-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy')
  } else {
    // Only Quick Sync leaves its frames on the GPU (hwdownload); CUDA hands them back already in memory.
    args.push('-vf', proxyFilter(plan, accel === 'qsv'))
    args.push('-c:v', attempt.video)
    args.push(...(attempt.video === 'libx264' ? ['-preset', 'veryfast', '-crf', '24'] : ['-global_quality', '24']))
    // A keyframe every second and no B-frames. The encoders' own defaults left 19 keyframes in 75 s,
    // so every scrub decoded up to four seconds of frames to show one, and the playhead lagged.
    args.push('-g', String(Math.max(1, Math.round(plan.fps))), '-bf', '0')
  }
  args.push('-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output)
  return args
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
  // The GPU hands back 10-bit frames as P010 whatever the colour: asking hwdownload for NV12 on a
  // 10-bit SDR clip failed the whole filter ("Invalid argument") and wrote a 0 byte proxy.
  if (hwDecode) parts.push('hwdownload', `format=${plan.hdr || plan.tenBit ? 'p010le' : 'nv12'}`)
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

/**
 * The proxy generation, at the front of every cached copy's name. Bumped when copies are built
 * differently enough that the old ones should be replaced, which a new name does without touching
 * them (an older VidHelm sharing this data folder may still have them open). v2: a keyframe every
 * second, so scrubbing is smooth.
 */
export const PROXY_GEN = 'v2-'

/** Cache key so the same file is never converted twice. */
export const proxyKey = (path: string, size: number, mtimeMs: number): string => {
  // both separators: split on "/" alone, a Windows path named every copy after its drive and folders
  const name = (path.split(/[\\/]/).pop() || 'clip').replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 40)
  let h = 0
  for (const ch of `${path}|${size}|${Math.round(mtimeMs)}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `${PROXY_GEN}${name}-${h.toString(36)}.mp4`
}

/** Was this copy made by the current generation? An older one is rebuilt when its project opens. */
export const isCurrentProxy = (p?: string): boolean => !!p && (p.split(/[\\/]/).pop() || '').startsWith(PROXY_GEN)

/**
 * A real picture track. ffprobe lists a song's album art as a video stream (disposition
 * attached_pic), which imported an MP3 or M4A as a "video" of one frozen picture.
 */
export const isRealVideo = (s: { codec_type?: string; disposition?: { attached_pic?: unknown } } | null | undefined): boolean =>
  s?.codec_type === 'video' && Number(s.disposition?.attached_pic) !== 1

/** Still pictures probe as image2 or a *_pipe format and have no length; that is not a broken file. */
export const isStillFormat = (formatName?: string): boolean => /(^|,)(image2|image2pipe|[a-z0-9]+_pipe)(,|$)/.test(formatName || '')

/**
 * The file's length in seconds: the container's, else its longest stream's, else null. ffprobe says
 * "N/A" (a string) when a recording was cut off before its length was written, and that string was
 * passed on as the duration: NaN clips that could not be placed or trimmed.
 */
export function probeDuration(format: { duration?: unknown } | undefined, streams: ({ duration?: unknown } | null | undefined)[] = []): number | null {
  const d = Number(format?.duration)
  if (Number.isFinite(d) && d > 0) return d
  const each = streams.map(s => Number(s?.duration)).filter(x => Number.isFinite(x) && x > 0)
  return each.length ? Math.max(...each) : null
}

/** The last "time=HH:MM:SS.ss" in ffmpeg's -stats output, in seconds (null when there is none). */
export function lastStatsTime(text: string): number | null {
  let last: number | null = null
  for (const m of text.matchAll(/time=(-?)(\d+):(\d+):(\d+(?:\.\d+)?)/g)) {
    if (m[1]) continue
    last = (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4])
  }
  return last
}
