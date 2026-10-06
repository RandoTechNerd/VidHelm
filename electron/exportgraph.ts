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
 * differs only by rounding at sharp edges. That fit is held to even sizes: zscale (the tone map's
 * first step) refuses a 4:2:0 frame with an odd side ("image dimensions must be divisible by
 * subsampling factor") and the whole export stops. DCI 4K (4096x2160, what drones and many cameras
 * record HLG at) fits 1920x1080 as 1920x1013; swscale and pad never minded, so only this branch did.
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
  else if (c.hdr && o.hdrToSdr) v = `[${input}]fps=${o.fps}:start_time=0,${keyChain}${fit}:force_divisible_by=2,${o.hdrToSdr},format=yuva420p`
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
 * Lines are laid out on the font's own line metrics (y_align=font), as CSS lays out a line box: by
 * default drawtext's text_h, and so its box, is the INK of the glyphs actually drawn, so a boxed
 * "HHHH" at 100 px got a 102 px bar where the preview drew 151 (and "gjpq" 128): every lower third
 * came out a third thinner than it previewed, and text with descenders sat 0.12 em higher. On the
 * font's metrics the box is lines x line height + padding whatever the letters, and text_h/2 is the
 * middle of the line box, which is what the preview centres on y.
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
    'y_align=font',
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
 * Which characters a TrueType/OpenType font has a glyph for, from its cmap (format 12 for the full
 * range, else format 4). drawtext draws from ONE face with no fallback, so a character the face lacks
 * is drawn as its .notdef glyph, which in Inter is a box with "NO GLYPH" printed in it: an emoji that
 * the preview shows (Chromium falls back to Segoe UI Emoji) burned into the video as that box. A
 * font this cannot read answers "yes" for everything, which is how the export behaved before.
 */
export function fontCoverage(font: Uint8Array): (cp: number) => boolean {
  const all = () => true
  try {
    const dv = new DataView(font.buffer, font.byteOffset, font.byteLength)
    const tag = (o: number) => String.fromCharCode(font[o], font[o + 1], font[o + 2], font[o + 3])
    // a collection: its first face
    const base = tag(0) === 'ttcf' ? dv.getUint32(12) : 0
    let cmap = -1
    for (let i = 0, n = dv.getUint16(base + 4); i < n; i++) if (tag(base + 12 + i * 16) === 'cmap') cmap = dv.getUint32(base + 12 + i * 16 + 8)
    if (cmap < 0) return all
    let f4 = -1, f12 = -1
    for (let i = 0, n = dv.getUint16(cmap + 2); i < n; i++) {
      const rec = cmap + 4 + i * 8, platform = dv.getUint16(rec), encoding = dv.getUint16(rec + 2), at = cmap + dv.getUint32(rec + 4)
      const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))
      if (!unicode) continue
      const format = dv.getUint16(at)
      if (format === 12 && f12 < 0) f12 = at
      if (format === 4 && f4 < 0) f4 = at
    }
    if (f12 >= 0) {
      const groups: [number, number, number][] = []
      for (let i = 0, n = dv.getUint32(f12 + 12); i < n; i++) { const g = f12 + 16 + i * 12; groups.push([dv.getUint32(g), dv.getUint32(g + 4), dv.getUint32(g + 8)]) }
      return cp => groups.some(([s, e, glyph]) => cp >= s && cp <= e && glyph + (cp - s) !== 0)
    }
    if (f4 >= 0) {
      const segs = dv.getUint16(f4 + 6) / 2
      const endAt = f4 + 14, startAt = endAt + segs * 2 + 2, deltaAt = startAt + segs * 2, rangeAt = deltaAt + segs * 2
      return cp => {
        if (cp > 0xffff) return false
        for (let i = 0; i < segs; i++) {
          if (dv.getUint16(endAt + i * 2) < cp) continue
          const start = dv.getUint16(startAt + i * 2)
          if (start > cp) return false
          const delta = dv.getInt16(deltaAt + i * 2), ro = dv.getUint16(rangeAt + i * 2)
          if (ro === 0) return ((cp + delta) & 0xffff) !== 0
          const gAt = rangeAt + i * 2 + ro + (cp - start) * 2
          if (gAt + 2 > font.byteLength) return false
          const g = dv.getUint16(gAt)
          return g !== 0 && ((g + delta) & 0xffff) !== 0
        }
        return false
      }
    }
    return all
  } catch { return all }
}

/**
 * A title without the characters its face cannot draw (see fontCoverage), and which ones went. Line
 * breaks and tabs are drawtext's own layout and always stay; a space left doubled by a removal is
 * closed up. Only lines that lost something are touched.
 */
export function dropMissingGlyphs(text: string, has: (cp: number) => boolean): { text: string; dropped: string[] } {
  const dropped: string[] = []
  const lines = String(text ?? '').split('\n').map(line => {
    let kept = '', lost = false
    for (const ch of line) {
      const cp = ch.codePointAt(0)!
      if (cp === 9 || cp === 11 || cp === 12 || cp === 13 || has(cp)) { kept += ch; continue }
      lost = true
      // a variation selector or a joiner is part of the emoji just dropped, not a character of its own
      if (!(cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x1f3fb && cp <= 0x1f3ff)) && !dropped.includes(ch)) dropped.push(ch)
    }
    return lost ? kept.replace(/ {2,}/g, ' ').replace(/^ +| +$/g, '') : kept
  })
  return { text: lines.join('\n'), dropped }
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
