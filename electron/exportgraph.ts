/* Pieces of the export filtergraph (electron/main.ts, export-video) that are easy to get subtly
 * wrong and silently: a still in the wrong demuxer fails the whole render, an untrimmed audio branch
 * plays past its out-point, a '%' in a title draws nothing. Pure (no Electron), so the decisions are
 * tested against the real bundled ffmpeg: node electron/exportgraph.test.mjs */

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

export interface AudioClip {
  start: number; duration: number; sourceStart?: number
  volume?: number; fadeIn?: number; fadeOut?: number; aFadeIn?: number; aFadeOut?: number
}

/**
 * One clip's audio branch, from its input to the mix. `volume` is either a number or a ready-made
 * eval=frame expression (volume automation).
 *
 * The input is opened with a little tail past the clip (the picture's fades need frames), so the
 * audio is cut to EXACTLY the clip's length first. Without that every clip kept playing 0.2 s past
 * its out-point: a split doubled the audio for 200 ms (+6 dB) and a trim leaked the cut-off audio
 * under the next clip, none of it audible in the preview.
 *
 * Every edge that is a splice gets at least DEPOP_S of audio ramp, however the clip was made (split
 * key, cut_at_phrase, a dragged edge): a hard splice mid-waveform is a step, and a step clicks. A
 * clip's natural beginning (sourceStart 0) is left alone so a sound effect keeps its attack.
 */
export function clipAudioChain(input: string, c: AudioClip, volume: number | string, out: string): string {
  const startMs = Math.round(c.start * 1000)
  const end = c.start + c.duration
  let a = `[${input}]asetpts=PTS-STARTPTS,atrim=duration=${c.duration.toFixed(3)},aresample=48000,adelay=${startMs}|${startMs}`
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
