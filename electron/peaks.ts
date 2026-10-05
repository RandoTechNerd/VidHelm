/* Waveform peaks for the timeline. The main process decodes a file's audio once (8 kHz mono float,
 * see 'audio-peaks' in electron/main.ts), keeps the loudest sample of every 10 ms on a -60 dB
 * scale in one byte, and caches that; src/clipwave.tsx draws it under each clip. Pure (no Electron,
 * no DOM), so the numbers are tested on their own: npm run test:peaks */

/** What ffmpeg decodes to for peaks: plenty for a picture of loudness, and cheap (about 2 s per 10 minutes). */
export const PEAK_SAMPLE_RATE = 8000
/** Buckets per second: 10 ms each, two pixels apart at full zoom. */
export const PEAK_RATE = 100
/** The quietest level drawn; anything under it is a flat line. */
export const PEAK_FLOOR_DB = -60
/** Bump when the stored format changes, so cached peaks from an older build are not misread. */
export const PEAK_VERSION = 1

/** ffmpeg arguments that write a file's audio to stdout as 8 kHz mono float32 (-vn: a video's picture is never decoded). */
export const peakDecodeArgs = (file: string): string[] =>
  ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(PEAK_SAMPLE_RATE), '-f', 'f32le', 'pipe:1']

/**
 * The loudest |sample| of a bucket as one byte: 0 at or below the floor, 255 at full scale. Mapped
 * through decibels because that is how loudness reads: a linear scale draws a whisper as nothing
 * and a normal voice as a solid block.
 */
export function peakByte(max: number): number {
  if (!(max > 0)) return 0
  const db = 20 * Math.log10(max)
  return Math.round(255 * Math.max(0, Math.min(1, (db - PEAK_FLOOR_DB) / -PEAK_FLOOR_DB)))
}

/**
 * Peaks from raw little-endian float32 bytes, fed in whatever pieces they arrive in (an ffmpeg
 * stdout chunk can end in the middle of a sample), so a whole file's PCM is never held at once:
 * an hour of audio is 115 MB of floats but 360 kB of peaks.
 */
export class PeakBucketer {
  private out = new Uint8Array(4096)
  private n = 0
  private max = 0
  private count = 0
  private carry = new Uint8Array(4)
  private carried = 0
  private readonly per: number
  constructor(perBucket = PEAK_SAMPLE_RATE / PEAK_RATE) { this.per = Math.max(1, Math.round(perBucket)) }

  private sample(x: number) {
    const a = x < 0 ? -x : x
    if (a > this.max && Number.isFinite(a)) this.max = a
    if (++this.count === this.per) this.flush()
  }
  private flush() {
    if (this.n === this.out.length) { const grown = new Uint8Array(this.out.length * 2); grown.set(this.out); this.out = grown }
    this.out[this.n++] = peakByte(this.max)
    this.max = 0
    this.count = 0
  }

  /** Raw float32 LE bytes (a Buffer is a Uint8Array). */
  pushBytes(bytes: Uint8Array) {
    let i = 0
    // finish a sample split across the previous chunk and this one
    if (this.carried) {
      while (this.carried < 4 && i < bytes.length) this.carry[this.carried++] = bytes[i++]
      if (this.carried < 4) return
      this.sample(new DataView(this.carry.buffer).getFloat32(0, true))
      this.carried = 0
    }
    const whole = Math.floor((bytes.length - i) / 4)
    const dv = new DataView(bytes.buffer, bytes.byteOffset + i, whole * 4)
    for (let k = 0; k < whole; k++) this.sample(dv.getFloat32(k * 4, true))
    i += whole * 4
    while (i < bytes.length) this.carry[this.carried++] = bytes[i++]
  }

  /** Samples already as floats (tests, or a decoder that hands floats over). */
  pushFloats(pcm: Float32Array) { for (let k = 0; k < pcm.length; k++) this.sample(pcm[k]) }

  /** The peaks so far, with a last partial bucket if any samples are waiting. */
  finish(): Uint8Array {
    if (this.count > 0) this.flush()
    return this.out.slice(0, this.n)
  }
}

/** Peaks of a whole PCM buffer in one go: one byte per `per` samples (80 at 8 kHz = 10 ms). */
export function bucketPeaks(pcm: Float32Array, per = PEAK_SAMPLE_RATE / PEAK_RATE): Uint8Array {
  const b = new PeakBucketer(per)
  b.pushFloats(pcm)
  return b.finish()
}

/**
 * How tall a bar is (0..1) for a stored peak played at `gain` (linear, as the clip's volume and
 * fades give it). On the dB scale a gain is a shift, so a clip at 50% draws 6 dB lower and a fade
 * shrinks the bars toward the floor just as it sounds.
 */
export function barHeight(peak: number, gain: number): number {
  if (!(peak > 0) || !(gain > 0)) return 0
  return Math.max(0, Math.min(1, peak / 255 + (20 * Math.log10(gain)) / -PEAK_FLOOR_DB))
}

/**
 * The loudest stored peak (0..255) under each of `bars` equal slices of [from, to) seconds of the
 * source. A slice narrower than a bucket reads the bucket it falls in, so zooming in never shows
 * gaps; past the end of the data is silence.
 */
export function barPeaks(data: Uint8Array, rate: number, from: number, to: number, bars: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, bars))
  if (!data.length || !(rate > 0) || !(to > from) || bars <= 0) return out
  const step = (to - from) / bars
  for (let b = 0; b < bars; b++) {
    const i0 = Math.floor((from + b * step) * rate)
    const i1 = Math.max(i0 + 1, Math.floor((from + (b + 1) * step) * rate))
    let m = 0
    for (let i = Math.max(0, i0); i < i1 && i < data.length; i++) if (data[i] > m) m = data[i]
    out[b] = m
  }
  return out
}
