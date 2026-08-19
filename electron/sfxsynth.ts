// A small DSP engine for sound effects that are meant to sound like things, not like beeps.
//
// The existing built-ins are ffmpeg `aevalsrc` expressions: one closed-form formula per sample.
// That is a fine way to make a pop or a ding and a hopeless way to make coffee beans hitting a
// hopper, because that sound is two hundred separate impacts, each with its own pitch, decay and
// position, all exciting the same resonant container. You cannot write that as a formula; you
// have to actually run the events.
//
// So this renders samples in plain JS. Everything is deterministic given a seed, so a sound can
// be re-rolled into a different take of the same idea, and every model here is a pure function of
// (options) -> Float32Array, which means `npm run test:sfxsynth` can assert real acoustic
// properties: how many onsets a pour has, whether a pass-by's pitch falls as it should, whether
// anything clips.
//
// No Electron, no ffmpeg.

export interface Stereo { left: Float32Array; right: Float32Array; sampleRate: number }

// ---------------------------------------------------------------------------
// deterministic randomness
// ---------------------------------------------------------------------------

/** mulberry32: tiny, fast, and good enough that a different seed sounds like a different take. */
export class Rng {
  private s: number
  constructor(seed = 1) { this.s = (seed >>> 0) || 1 }
  next(): number {
    this.s = (this.s + 0x6D2B79F5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  /** uniform in [a, b) */
  range(a: number, b: number): number { return a + (b - a) * this.next() }
  /** roughly normal, via the sum of three uniforms. Cheap and plenty for jitter. */
  normal(): number { return (this.next() + this.next() + this.next() - 1.5) * 1.4 }
}

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

export function whiteNoise(n: number, rng: Rng): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = rng.range(-1, 1)
  return out
}

/** Pink-ish noise (Voss-McCartney, 5 octaves). Air, hiss and rushing all live here. */
export function pinkNoise(n: number, rng: Rng): Float32Array {
  const out = new Float32Array(n)
  const rows = new Float32Array(5)
  let running = 0
  for (let i = 0; i < n; i++) {
    // each row updates half as often as the one before it
    for (let r = 0; r < 5; r++) {
      if ((i & ((1 << r) - 1)) === 0) { running -= rows[r]; rows[r] = rng.range(-1, 1); running += rows[r] }
    }
    out[i] = running / 5
  }
  return out
}

/** Brown noise: rumble, distant thunder, the low half of an engine. */
export function brownNoise(n: number, rng: Rng): Float32Array {
  const out = new Float32Array(n)
  let last = 0
  for (let i = 0; i < n; i++) {
    last = Math.max(-1, Math.min(1, last + rng.range(-1, 1) * 0.05))
    out[i] = last * 3
  }
  return out
}

/**
 * Oscillator with a frequency that can change every sample, via a phase accumulator.
 *
 * A phase accumulator rather than `sin(2*PI*f(t)*t)`, which is the classic trap: that formula
 * sweeps to the wrong pitch, because multiplying a changing f by t makes the instantaneous
 * frequency f + t·df/dt, not f. Anything with a rising engine note needs it done properly.
 */
export function osc(n: number, sr: number, freqAt: (t: number) => number, shape: 'sine' | 'saw' | 'square' | 'tri' = 'sine', phase0 = 0): Float32Array {
  const out = new Float32Array(n)
  let phase = phase0
  for (let i = 0; i < n; i++) {
    const f = Math.max(0, freqAt(i / sr))
    phase += f / sr
    if (phase >= 1) phase -= Math.floor(phase)
    switch (shape) {
      case 'saw': out[i] = 2 * phase - 1; break
      case 'square': out[i] = phase < 0.5 ? 1 : -1; break
      case 'tri': out[i] = 4 * Math.abs(phase - 0.5) - 1; break
      default: out[i] = Math.sin(2 * Math.PI * phase)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// filters (RBJ cookbook biquads)
// ---------------------------------------------------------------------------

export interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

const makeBiquad = (kind: 'lp' | 'hp' | 'bp' | 'peak' | 'notch', freq: number, q: number, sr: number, gainDb = 0): Biquad => {
  const w0 = 2 * Math.PI * Math.min(freq, sr * 0.49) / sr
  const cos = Math.cos(w0), sin = Math.sin(w0)
  const alpha = sin / (2 * Math.max(0.0001, q))
  const A = Math.pow(10, gainDb / 40)
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0
  switch (kind) {
    case 'lp': b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break
    case 'hp': b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break
    case 'bp': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break
    case 'notch': b0 = 1; b1 = -2 * cos; b2 = 1; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break
    case 'peak': b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; break
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/** Run a fixed biquad over a buffer, in place is avoided so tests can compare before/after. */
export function filt(x: Float32Array, kind: 'lp' | 'hp' | 'bp' | 'peak' | 'notch', freq: number, q: number, sr: number, gainDb = 0): Float32Array {
  const c = makeBiquad(kind, freq, q, sr, gainDb)
  const y = new Float32Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const xn = x[i]
    const yn = c.b0 * xn + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    x2 = x1; x1 = xn; y2 = y1; y1 = yn
    y[i] = yn
  }
  return y
}

/**
 * Biquad whose cutoff moves, recomputed every `block` samples.
 *
 * This is what makes a filter sweep sound like something opening rather than like a filter: the
 * throttle on an engine, the pneumatic hiss of a door, the air absorption of something moving
 * away from you.
 */
export function sweepFilt(x: Float32Array, kind: 'lp' | 'hp' | 'bp', freqAt: (t: number) => number, q: number, sr: number, block = 64): Float32Array {
  const y = new Float32Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  let c = makeBiquad(kind, freqAt(0), q, sr)
  for (let i = 0; i < x.length; i++) {
    if (i % block === 0) c = makeBiquad(kind, Math.max(20, freqAt(i / sr)), q, sr)
    const xn = x[i]
    const yn = c.b0 * xn + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    x2 = x1; x1 = xn; y2 = y1; y1 = yn
    y[i] = yn
  }
  return y
}

// ---------------------------------------------------------------------------
// envelopes and mixing
// ---------------------------------------------------------------------------

/** Percussive envelope: near-instant attack, exponential decay. */
export function envPerc(n: number, sr: number, attackSec: number, decaySec: number): Float32Array {
  const out = new Float32Array(n)
  const a = Math.max(1, Math.round(attackSec * sr))
  const k = 1 / Math.max(0.0001, decaySec * sr)
  for (let i = 0; i < n; i++) out[i] = i < a ? i / a : Math.exp(-(i - a) * k * 5)
  return out
}

/** Linear ramp between arbitrary breakpoints, for shapes an ADSR cannot describe. */
export function envPoints(n: number, sr: number, points: { t: number; v: number }[]): Float32Array {
  const out = new Float32Array(n)
  const pts = [...points].sort((a, b) => a.t - b.t)
  if (!pts.length) return out
  for (let i = 0; i < n; i++) {
    const t = i / sr
    let a = pts[0], b = pts[pts.length - 1]
    for (let k = 0; k < pts.length - 1; k++) {
      if (t >= pts[k].t && t <= pts[k + 1].t) { a = pts[k]; b = pts[k + 1]; break }
    }
    if (t <= pts[0].t) out[i] = pts[0].v
    else if (t >= pts[pts.length - 1].t) out[i] = pts[pts.length - 1].v
    else out[i] = a.v + (b.v - a.v) * ((t - a.t) / Math.max(1e-9, b.t - a.t))
  }
  return out
}

export const mul = (a: Float32Array, b: Float32Array): Float32Array => {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] * (b[i] ?? 0)
  return out
}

export const gain = (a: Float32Array, g: number): Float32Array => {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] * g
  return out
}

export function mix(...parts: Float32Array[]): Float32Array {
  const n = Math.max(...parts.map(p => p.length), 0)
  const out = new Float32Array(n)
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i]
  return out
}

/** Add `src` into `dst` starting at a sample offset. The workhorse for event scheduling. */
export function addAt(dst: Float32Array, src: Float32Array, offset: number, g = 1): void {
  const start = Math.max(0, Math.round(offset))
  for (let i = 0; i < src.length; i++) {
    const j = start + i
    if (j >= dst.length) break
    dst[j] += src[i] * g
  }
}

/** Soft saturation. Adds the harmonics that make a big sound feel loud rather than just large. */
export function saturate(x: Float32Array, drive = 2): Float32Array {
  const out = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) out[i] = Math.tanh(x[i] * drive) / Math.tanh(drive)
  return out
}

/** Peak-normalise to a target, and report what it had to do. */
export function normalize(x: Float32Array, peak = 0.89): { out: Float32Array; appliedGain: number; wasPeak: number } {
  let max = 0
  for (let i = 0; i < x.length; i++) max = Math.max(max, Math.abs(x[i]))
  if (max === 0) return { out: x, appliedGain: 1, wasPeak: 0 }
  const g = peak / max
  return { out: gain(x, g), appliedGain: g, wasPeak: max }
}

/** Remove DC, which otherwise eats headroom and can thump on playback. */
export function dcBlock(x: Float32Array): Float32Array {
  const out = new Float32Array(x.length)
  let x1 = 0, y1 = 0
  for (let i = 0; i < x.length; i++) {
    const y = x[i] - x1 + 0.995 * y1
    x1 = x[i]; y1 = y
    out[i] = y
  }
  return out
}

// ---------------------------------------------------------------------------
// building blocks with physical meaning
// ---------------------------------------------------------------------------

/**
 * A resonant body: a handful of decaying modes, excited by whatever you feed in.
 *
 * This is what makes a hopper sound like a hopper. Every bean strikes the SAME set of modes, so
 * the container has one voice even though each impact is different. Modelled as parallel
 * bandpasses rather than a full modal synth, which is indistinguishable at this length.
 */
export function resonate(x: Float32Array, modes: { freq: number; q: number; gain: number }[], sr: number): Float32Array {
  const out = new Float32Array(x.length)
  for (const m of modes) {
    const band = filt(x, 'bp', m.freq, m.q, sr)
    for (let i = 0; i < out.length; i++) out[i] += band[i] * m.gain
  }
  return out
}

/** One impact: a click of noise, band-limited, with a very fast decay. */
export function impact(sr: number, rng: Rng, opts: { freq: number; decay: number; q?: number; bright?: number } ): Float32Array {
  const n = Math.max(4, Math.round(opts.decay * 4 * sr))
  const noise = whiteNoise(n, rng)
  const env = envPerc(n, sr, 0.0002, opts.decay)
  const band = filt(mul(noise, env), 'bp', opts.freq, opts.q ?? 2.2, sr)
  if (opts.bright) {
    const hi = filt(mul(noise, envPerc(n, sr, 0.0001, opts.decay * 0.35)), 'hp', opts.freq * 2.2, 0.9, sr)
    return mix(band, gain(hi, opts.bright))
  }
  return band
}

/**
 * A moving sound source, rendered with real Doppler.
 *
 * Not a pitch bend: the source's distance is computed per sample and used as a DELAY, so the
 * pitch shift falls out of the geometry exactly as it does in air. That is why a real pass-by has
 * its sharpest pitch drop at the closest point and not at the loudest point, and why faking it
 * with a linear pitch ramp never quite convinces.
 *
 * Also applies inverse-distance gain, air absorption (high frequencies fade with distance), and
 * the stereo angle.
 */
export function passBy(src: Float32Array, sr: number, opts: {
  /** metres per second */
  speed: number
  /** closest approach in metres: small is dramatic, large is a distant fly-past */
  closest: number
  /** where in the buffer the source is nearest, 0..1 */
  at?: number
  /** speed of sound, m/s */
  c?: number
}): { left: Float32Array; right: Float32Array } {
  const c = opts.c ?? 343
  const at = (opts.at ?? 0.5) * (src.length / sr)
  const left = new Float32Array(src.length)
  const right = new Float32Array(src.length)
  const maxDelay = Math.round(sr * 0.5)

  for (let i = 0; i < src.length; i++) {
    const t = i / sr
    const along = (t - at) * opts.speed              // metres past the closest point
    const dist = Math.sqrt(along * along + opts.closest * opts.closest)
    // what we hear now left the source `dist / c` seconds ago
    const readAt = i - (dist / c) * sr
    let s = 0
    if (readAt >= 0 && readAt < src.length - 1) {
      const i0 = Math.floor(readAt), frac = readAt - i0
      s = src[i0] * (1 - frac) + src[i0 + 1] * frac    // fractional delay = the pitch shift
    }
    void maxDelay
    const g = opts.closest / Math.max(opts.closest, dist)          // inverse distance, clamped
    // pan follows the angle: hard over as it passes, centred when far away
    const pan = Math.max(-1, Math.min(1, along / Math.max(0.5, dist)))
    const l = Math.cos((pan + 1) * Math.PI / 4), r = Math.sin((pan + 1) * Math.PI / 4)
    left[i] = s * g * l
    right[i] = s * g * r
  }

  // air absorption: the further away, the duller. Cheap one-pole whose cutoff tracks distance.
  const cutoffAt = (t: number) => {
    const along = (t - at) * opts.speed
    const dist = Math.sqrt(along * along + opts.closest * opts.closest)
    return Math.max(700, 18000 * Math.pow(opts.closest / Math.max(opts.closest, dist), 0.65))
  }
  return { left: sweepFilt(left, 'lp', cutoffAt, 0.7, sr), right: sweepFilt(right, 'lp', cutoffAt, 0.7, sr) }
}

/** Cheap early-reflection cluster: enough to put a sound in a room rather than in a vacuum. */
export function room(x: Float32Array, sr: number, opts: { size?: number; mix?: number; damp?: number } = {}): Float32Array {
  const size = opts.size ?? 0.03
  const wet = opts.mix ?? 0.18
  const taps = [1, 1.63, 2.31, 3.11, 4.07, 5.29]
  const out = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) out[i] = x[i] * (1 - wet)
  taps.forEach((mult, k) => {
    const d = Math.round(size * mult * sr)
    const g = wet * Math.pow(0.62, k + 1)
    for (let i = d; i < x.length; i++) out[i] += x[i - d] * g
  })
  return filt(out, 'lp', opts.damp ?? 7000, 0.7, sr)
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

/** 16-bit PCM WAV, stereo. Written by hand so nothing has to shell out to ffmpeg. */
export function toWav(s: Stereo): Uint8Array {
  const n = Math.min(s.left.length, s.right.length)
  const bytes = 44 + n * 4
  const buf = new Uint8Array(bytes)
  const view = new DataView(buf.buffer)
  const str = (off: number, v: string) => { for (let i = 0; i < v.length; i++) buf[off + i] = v.charCodeAt(i) }
  str(0, 'RIFF'); view.setUint32(4, bytes - 8, true); str(8, 'WAVE')
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 2, true); view.setUint32(24, s.sampleRate, true)
  view.setUint32(28, s.sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true)
  str(36, 'data'); view.setUint32(40, n * 4, true)
  let off = 44
  const clip = (v: number) => Math.max(-1, Math.min(1, v))
  for (let i = 0; i < n; i++) {
    view.setInt16(off, clip(s.left[i]) * 32767, true); off += 2
    view.setInt16(off, clip(s.right[i]) * 32767, true); off += 2
  }
  return buf
}
