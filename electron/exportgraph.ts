/* Pieces of the export filtergraph (electron/main.ts, export-video) that are easy to get subtly
 * wrong and silently: a still in the wrong demuxer fails the whole render, an untrimmed audio branch
 * plays past its out-point, a '%' in a title draws nothing. Pure (no Electron), so the decisions are
 * tested against the real bundled ffmpeg: npm run test:exportgraph */
import { BOX_PAD, type cleanText } from './textlayout'

/** Audio-only ramp at a splice (about 12 ms): long enough that the waveform reaches zero, short enough that nobody hears it. */
export const DEPOP_S = 0.012

/**
 * Stills the image2 demuxer reads. `-loop 1` is an option of image2 ONLY: handed a GIF, AVIF or ICO
 * (each read by its own demuxer) ffmpeg stops the whole export with "Option loop not found".
 */
const IMAGE2_EXT = /\.(png|jpe?g|jfif|bmp|tiff?|webp|tga|ppm|pgm|dds|exr)$/i

/**
 * How to open a still so it lasts `seconds`: input options, plus a prefix for the head of its video
 * chain when the looping has to happen in the graph instead.
 *  - image2 stills: `-loop 1 -t D`, as before.
 *  - GIF: `-stream_loop -1 -t D`, which also keeps an animated GIF moving (and plays one whose file
 *    says "play once" for the whole clip, where -ignore_loop 0 would let it vanish).
 *  - anything else (AVIF, ICO, ...): no input looping at all (-stream_loop gives ZERO frames from an
 *    ICO, silently); the graph repeats the first frame instead.
 * GIFs and the graph-looped kinds are re-timed to `fps`: an AVIF decodes at 1 fps and a GIF at its own
 * slow rate, and the overlay stops showing a stream at its LAST frame, so a 2 s AVIF used to vanish
 * after 1 s. A short tail past D does the same for every kind; the clip's enable window still ends it
 * exactly on time.
 */
export function stillInput(file: string, seconds: number, fps = 30): { opts: string[]; vf: string } {
  const d = (Math.max(0.04, seconds) + 0.1).toFixed(3)
  if (IMAGE2_EXT.test(file)) return { opts: ['-loop', '1', '-t', d], vf: '' }
  if (/\.gif$/i.test(file)) return { opts: ['-stream_loop', '-1', '-t', d], vf: `fps=${fps},` }
  return { opts: [], vf: `loop=loop=-1:size=1:start=0,fps=${fps},trim=duration=${d},` }
}

/** Photo formats this ffmpeg build cannot decode at all (and Chromium cannot show either). */
export const UNREADABLE_STILL = /\.(heic|heif)$/i

/**
 * scale options for a conversion INTO the export's colour: BT.709, limited range, which is what the
 * file is tagged as. swscale's default for RGB to YUV is BT.601, so a PNG, a logo or a captured web
 * page converted without this sat in a BT.709 file with the wrong matrix and every player showed
 * it shifted (brand orange #FF6A00 played back as #FF7200). Video clips are already YUV and pass
 * through untouched.
 */
export const TO_709 = 'flags=lanczos+accurate_rnd+full_chroma_int:out_color_matrix=bt709:out_range=tv'

export interface VideoClip {
  type?: string; start: number; duration: number; fadeIn?: number; fadeOut?: number
  hdr?: boolean; chromaKey?: string
}

/**
 * One clip's picture branch, from its input to the overlay: fitted into the frame with transparent
 * padding (so overlapping clips can crossfade through each other) and placed at its start.
 *
 * Video is first put on the export's frame clock from the clip's in-point. A screen recording or
 * phone clip with variable frame rate can have a hole in it, and an input that starts on the far
 * side of a hole used to be pulled back to zero, so everything after played early (1.5 s in the
 * measured case) against its own sound. fps=...:start_time=0 fills from the in-point instead.
 *
 * HDR footage is scaled down BEFORE the tone map: about 2x faster from 4K to 1080p, and the picture
 * differs only by rounding at sharp edges.
 * Stills go straight from their own colours to BT.709 in one scale (see TO_709).
 */
export function clipVideoChain(input: string, c: VideoClip, o: { W: number; H: number; fps: number; stillVf?: string; hdrToSdr?: string }, out: string): string {
  const { W, H } = o
  const end = c.start + c.duration
  // Clips rendered on a key colour (3D Studio green screen) get it removed first, so whatever sits
  // below shows through. despill cleans the fringe that 4:2:0 chroma subsampling leaves around
  // antialiased edges. Costs roughly a second per six seconds of overlay at 1080p, cheap next to
  // the encode itself.
  const key = typeof c.chromaKey === 'string' && /^#?[0-9a-f]{6}$/i.test(c.chromaKey) ? c.chromaKey.replace('#', '') : null
  const keyChain = key ? `colorkey=0x${key}:0.30:0.10,${/^00e/i.test(key) ? 'despill=type=green:mix=0.5:expand=0,' : ''}` : ''
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease`
  let v: string
  if (c.type === 'image') v = `[${input}]${o.stillVf || ''}${keyChain}${fit}:${TO_709},format=yuva420p`
  else if (c.hdr && o.hdrToSdr) v = `[${input}]fps=${o.fps}:start_time=0,${keyChain}${fit},${o.hdrToSdr},format=yuva420p`
  else v = `[${input}]fps=${o.fps}:start_time=0,${keyChain}format=yuva420p,${fit}`
  v += `,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setpts=PTS-STARTPTS+${c.start}/TB`
  if ((c.fadeIn ?? 0) > 0) v += `,fade=t=in:st=${c.start}:d=${c.fadeIn}:alpha=1`
  if ((c.fadeOut ?? 0) > 0) v += `,fade=t=out:st=${(end - (c.fadeOut ?? 0)).toFixed(3)}:d=${c.fadeOut}:alpha=1`
  return `${v}[${out}]`
}

/**
 * drawtext options for one title, drawn the way the preview draws it (the .text-layer styles in
 * src/App.tsx): every line centred on the text's x, a hard drop shadow under bare text (drawtext
 * cannot blur, so the preview's shadow is hard too), a square box padded BOX_PAD em. The export used
 * to left-align every line of a multi-line title, draw no shadow and pad the box evenly.
 *
 * `t` must have been through cleanText: its colours and numbers go into the filter as they are.
 * `fontFile` and `textFile` arrive escaped for a filtergraph; `alpha` is the fade expression.
 */
export function titleDrawtext(t: ReturnType<typeof cleanText>, o: { H: number; W: number; fontFile: string; textFile: string; alpha: string }): string {
  const ff = (hex: string) => '0x' + hex.replace('#', '')
  const size = Math.max(8, Math.round((t.fontSize / 1080) * o.H))
  const end = t.start + t.duration
  const boxed = t.box === true
  const outline = typeof t.outline === 'number' && t.outline > 0 && !boxed
    ? [`borderw=${Math.max(1, Math.round(size * t.outline))}`, `bordercolor=${ff(String(t.outlineColor || '#000000'))}`] : []
  const shadow = boxed ? [] : ['shadowcolor=black@0.6', 'shadowx=0', `shadowy=${Math.max(1, Math.round(size * 0.04))}`]
  const box = boxed
    ? ['box=1', `boxcolor=${ff(String(t.boxColor || '#000000'))}@${typeof t.boxOpacity === 'number' ? t.boxOpacity : 0.5}`,
      `boxborderw=${Math.round(size * BOX_PAD.y)}|${Math.round(size * BOX_PAD.x)}`]
    : ['box=0']
  return [
    `fontfile='${o.fontFile}'`,
    ...outline,
    `textfile='${o.textFile}'`,
    // the text is the user's, literally: under the default expansion a '%' ('100% PLA', 'Save 20%')
    // made drawtext draw NOTHING for the whole overlay (exit 0, no error), and backslashes vanished
    'expansion=none',
    'text_align=C',
    `fontcolor=${ff(t.color)}`,
    `fontsize=${size}`,
    `x=${Math.round(t.x * o.W)}-text_w/2`,
    `y=${Math.round(t.y * o.H)}-text_h/2`,
    ...shadow,
    ...box,
    `enable='between(t,${t.start},${end})'`,
    `alpha='${o.alpha}'`,
  ].join(':')
}

/**
 * The brand logo's branch: sized and made translucent in RGB, then converted to the file's BT.709
 * here. Left to the overlay, the conversion happens automatically with BT.601 and shifts the brand
 * colours, the one place a viewer is sure to notice.
 */
export function logoChain(input: string, o: { stillVf?: string; width: number; opacity: number; fade: number; from: number; to: number }, out: string): string {
  let lf = `[${input}]${o.stillVf || ''}format=rgba,scale=${o.width}:-1,colorchannelmixer=aa=${o.opacity},scale=${TO_709},format=yuva420p`
  if (o.fade > 0) lf += `,fade=t=in:st=${o.from}:d=${o.fade}:alpha=1,fade=t=out:st=${(o.to - o.fade).toFixed(3)}:d=${o.fade}:alpha=1`
  return `${lf}[${out}]`
}

export interface AudioClip {
  start: number; duration: number; sourceStart?: number
  volume?: number; fadeIn?: number; fadeOut?: number; aFadeIn?: number; aFadeOut?: number
  /** channels in the source's audio stream (1 = a mono lav or phone mic); unknown counts as stereo */
  audioChannels?: number
}

/**
 * One clip's audio branch, from its input to the mix. `volume` is either a number or a ready-made
 * eval=frame expression (volume automation).
 *
 * The audio is laid on the clock the picture uses, then cut. The input is opened at the clip's
 * in-point, so a stream that starts late in the file (0.46 s is common from cameras and screen
 * recorders) or has a hole in it arrives with timestamps that say so. Renumbering it from zero used
 * to pull every word that much early; aresample's async mode pads the late start and fills the holes
 * with silence instead, so the sound stays on the frames it belongs to.
 *
 * The input is also opened with a little tail past the clip (the picture's fades need frames), so the
 * audio is then cut to EXACTLY the clip's length. Without that every clip kept playing 0.2 s past
 * its out-point: a split doubled the audio for 200 ms (+6 dB) and a trim leaked the cut-off audio
 * under the next clip, none of it audible in the preview.
 *
 * A mono source is copied to both sides at full level. Left to the mixer's automatic upmix it went in
 * at -3 dB per side (the "centre" share), so a mono mic exported 3 dB quieter than the preview plays it.
 *
 * Every edge that is a splice gets at least DEPOP_S of audio ramp, however the clip was made (split
 * key, cut_at_phrase, a dragged edge): a hard splice mid-waveform is a step, and a step clicks. A
 * clip's natural beginning (sourceStart 0) is left alone so a sound effect keeps its attack.
 */
export function clipAudioChain(input: string, c: AudioClip, volume: number | string, out: string): string {
  const startMs = Math.round(c.start * 1000)
  const end = c.start + c.duration
  const mono = c.audioChannels === 1 ? 'pan=stereo|c0=c0|c1=c0,' : ''
  let a = `[${input}]aresample=48000:async=1:first_pts=0,atrim=end=${c.duration.toFixed(3)},asetpts=PTS-STARTPTS,${mono}aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${startMs}|${startMs}`
  a += typeof volume === 'string' ? `,volume='${volume}':eval=frame` : `,volume=${volume}`
  // Audio-only ramps override the picture fades, so the picture can still cut hard.
  const aIn = Math.max(c.aFadeIn ?? c.fadeIn ?? 0, (Number(c.sourceStart) || 0) > 0 ? DEPOP_S : 0)
  const aOut = Math.max(c.aFadeOut ?? c.fadeOut ?? 0, DEPOP_S)
  if (aIn > 0) a += `,afade=t=in:st=${c.start}:d=${aIn}`
  if (aOut > 0) a += `,afade=t=out:st=${(end - aOut).toFixed(3)}:d=${aOut}`
  return `${a}[${out}]`
}

/**
 * The master bus, `[amaster]` to `[aout]`.
 *
 * optimize ("Loud for YouTube"): compress dynamics for higher perceived loudness, then land at
 * -13 LUFS (the loud end of YouTube's window; the tighter LRA=7 is denser and punchier). loudnorm runs
 * single-pass here, and its internal true-peak limiter only approximates the ceiling: it measured
 * -0.9 dBTP against the -1 dBTP target, i.e. the export failed our own quality check. Asking loudnorm
 * for -1.5 and following it with a hard ceiling leaves enough room for inter-sample peaks to still
 * land under -1 dBTP. level=disabled matters: without it alimiter re-normalises the level and undoes
 * loudnorm.
 *
 * loudnorm (ffmpeg 6.1) also works in 100 ms steps, and when it flushes its last ~3 s it stamps that
 * audio at its NEXT step. Unless the mix is a whole number of tenths of a second long, everything
 * from there on played up to 0.1 s late (a gap mid-stream, out of sync with the picture) and the
 * output's -t then cut the end of the sound off. Back to 48 kHz (loudnorm runs at 192 kHz) and the
 * samples renumbered from zero, the audio is continuous and exactly as long as the mix.
 */
export function masterChain(optimize: boolean): string {
  return optimize
    ? '[amaster]acompressor=threshold=-18dB:ratio=3:attack=20:release=250:makeup=3,loudnorm=I=-13:LRA=7:TP=-1.5,aresample=48000,asetpts=N/SR/TB,alimiter=limit=0.85:level=disabled[aout]'
    : '[amaster]alimiter=limit=0.891:level=disabled[aout]'
}

/**
 * A short reason a person can act on, for an ffmpeg failure. The raw tail still goes after it, but
 * "Export failed: a source file is missing" beats a progress bar that just disappears.
 *
 * "Permission denied" and "No such file" happen on either side, and pointing at the wrong one sends
 * the user looking in the wrong place. ffmpeg says which: "Error opening output <path>: ..." versus
 * "Error opening input: ...". `outputPath` lets a line that names the output count as the output.
 */
export function friendlyExportError(text: string, outputPath = ''): string {
  const t = String(text || '')
  const lines = t.split(/\r?\n/)
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase()
  const out = outputPath ? norm(outputPath) : ''
  const side = (re: RegExp): 'input' | 'output' | '' => {
    let seen: 'input' | '' = ''
    for (const l of lines) {
      if (!re.test(l)) continue
      if ((out && norm(l).includes(out)) || /\boutput\b/i.test(l)) return 'output'
      if (/\binput\b/i.test(l)) seen = 'input'
    }
    return seen
  }
  if (/No space left|ENOSPC/i.test(t)) return 'the disk is full'
  const denied = /Permission denied|EACCES|EBUSY|EPERM|resource busy/i
  if (denied.test(t)) return side(denied) === 'input'
    ? 'a source file cannot be opened (permission denied: is it locked by another program, or in a folder VidHelm cannot read?)'
    : 'the output file cannot be written (is it open in another program, or in a protected folder?)'
  if (/Option loop not found|Option not found/i.test(t)) return 'an image on the timeline is in a format the exporter cannot read'
  const missing = /No such file or directory|ENOENT/i
  if (missing.test(t)) return side(missing) === 'output' ? 'the folder you are exporting to does not exist' : 'a source file is missing'
  if (/Unable to (choose|find a suitable) output format/i.test(t)) return 'the output file needs a video extension such as .mp4'
  if (/Invalid data found|moov atom not found|could not find codec parameters|Error opening input/i.test(t)) return 'a source file is unreadable or damaged'
  if (/Cannot allocate memory|out of memory|ENOMEM/i.test(t)) return 'the computer ran out of memory (try a lower resolution, or export in parts)'
  if (/SIGKILL|SIGTERM|was killed/i.test(t)) return 'ffmpeg was stopped before it finished'
  return 'ffmpeg stopped with an error'
}

/** The last few meaningful lines of ffmpeg's stderr (progress lines dropped), capped for a toast. */
export function stderrTail(stderr: string, lines = 4, max = 600): string {
  const keep = String(stderr || '').split(/\r?\n/).map(l => l.trim())
    .filter(l => l && !/^(frame=|size=|video:|\[out#|Press \[q\])/.test(l))
  return keep.slice(-lines).join('\n').slice(-max)
}
