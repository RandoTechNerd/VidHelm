/**
 * Cut-synced score generation: dynamic music that lands ON the edit.
 *
 * Grown out of the Lucy montage build, where the score and the shot plan came
 * from one timeline and the sync was the whole appeal. In VidHelm the cuts come
 * first (the user has already edited), so the flow inverts: fit a tempo TO the
 * cuts, then arrange a bed whose hits, whooshes and silences are placed by the
 * same numbers the timeline uses.
 *
 * What "synced" means concretely, each one measured in the original build:
 *   - a stereo whoosh is centred on every cut and pans in the transition's
 *     direction, so the ear and the eye agree about which way the picture went
 *   - tagged moments get an impact, and the bed side-chain DUCKS around it:
 *     a hit that lands in its own pocket of silence feels attached to the
 *     picture, one that merely happens near it feels adjacent
 *   - bars that contain many cuts play denser (16th hats, hotter riff), bars
 *     after the last tag calm down to offbeat brushes, and the tail past the
 *     final cut sits on a drone instead of a groove
 *
 * Hard lessons baked in rather than re-learnable:
 *   - the duck is applied AFTER low-band saturation; tanh is compressive and
 *     re-expands a pre-saturation duck to almost nothing (measured 8 dB -> 2)
 *   - nothing is synthesised near Nyquist and the master is low-passed at
 *     15.5 kHz; near-Nyquist noise is what makes AAC overshoot and ring
 *   - the low end is saturated, not shelved: a shelf raises the peak, the
 *     normaliser takes it all back, and the result is mud at the same LUFS
 *   - hats get accent patterns, per-hit variety and dropouts; a metronomic
 *     tick is fatiguing precisely when shots slow down and expose it
 *
 * Two palettes. `electronic` (the original: kick, clap, hats, arp riff) and
 * `cinematic`, grown out of the CruxStudy teaser build where the electronic
 * palette was exactly what the user rejected ("8-bit dinks and beeps"): bowed
 * strings, a cello ostinato, felt piano, taiko, a choir pad, braams, a riser
 * into every hit, and a POCKET OF SILENCE before each drop. The pocket is the
 * part that makes a drop land: the bed vanishes for a third of a second, the
 * impact arrives into nothing, and the bed comes back ducked.
 *
 * Pure module: no I/O, no Node APIs, deterministic for a given seed.
 */
import {
  Rng, whiteNoise, osc, filt, envPerc, mul, gain, addAt, saturate, toWav, type Stereo,
} from './sfxsynth'

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface ScoreInput {
  /** every cut boundary, seconds, sorted or not */
  cuts: number[]
  /** the cuts that deserve an impact + duck (tag points, section starts) */
  hits: number[]
  /** total length of the piece, seconds */
  duration: number
}

export type Intensity = 'chill' | 'standard' | 'epic'
export type Style = 'electronic' | 'cinematic'

export interface ScoreOpts {
  /** override the fitted tempo */
  bpm?: number
  seed?: number
  intensity?: Intensity
  /** palette: electronic (default) or cinematic */
  style?: Style
}

export interface WhooshEvent { t: number; dur: number; up: boolean; level: number }
export interface ImpactEvent { t: number; level: number }

export interface ScorePlan {
  bpm: number
  beat: number
  duration: number
  intensity: Intensity
  style: Style
  seed: number
  /** beat index where the full groove starts */
  grooveBeat: number
  /** beat index where the arrangement calms down */
  lateBeat: number
  /** seconds where the groove yields to the end drone (last cut) */
  droneAt: number
  /** bars whose span contains enough cuts to play dense */
  denseBars: number[]
  whooshes: WhooshEvent[]
  impacts: ImpactEvent[]
  /** duck (side-chain) trigger times, seconds */
  duckTimes: number[]
  /** cinematic only: hits that get a silence pocket in the bed just before them */
  pockets: number[]
}

/** How long the bed disappears before a cinematic drop, seconds. */
export const POCKET_SEC = 0.34

// ---------------------------------------------------------------------------
// tempo fitting
// ---------------------------------------------------------------------------

/**
 * Choose the tempo whose beat grid the cuts already sit closest to.
 *
 * The grid's phase is anchored on the first cut, then every candidate BPM is
 * scored by the mean distance from each cut to its nearest beat. Ties break
 * toward 120 so pathological inputs get an ordinary answer, not an extreme one.
 */
export function fitBpm(cuts: number[], lo = 84, hi = 150): { bpm: number; err: number } {
  const cs = [...cuts].sort((a, b) => a - b)
  if (cs.length < 2) return { bpm: 120, err: 0 }
  const phase = cs[0]
  let best = { bpm: 120, err: Infinity }
  for (let bpm = lo; bpm <= hi; bpm += 0.5) {
    const beat = 60 / bpm
    let err = 0
    for (const c of cs) {
      const k = (c - phase) / beat
      err += Math.abs(k - Math.round(k)) * beat
    }
    err /= cs.length
    const better = err < best.err - 1e-9
      || (Math.abs(err - best.err) <= 1e-9 && Math.abs(bpm - 120) < Math.abs(best.bpm - 120))
    if (better) best = { bpm, err }
  }
  return best
}

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

export function planScore(input: ScoreInput, opts: ScoreOpts = {}): ScorePlan {
  const seed = opts.seed ?? 1
  const intensity: Intensity = opts.intensity ?? 'standard'
  const style: Style = opts.style ?? 'electronic'
  const cuts = [...new Set(input.cuts.map(c => +c.toFixed(4)))].sort((a, b) => a - b)
    .filter(c => c > 0.05 && c < input.duration - 0.05)
  const hits = [...new Set(input.hits.map(h => +h.toFixed(4)))].sort((a, b) => a - b)
    .filter(h => h >= 0 && h < input.duration)

  const bpm = opts.bpm ?? fitBpm(cuts).bpm
  const beat = 60 / bpm
  const bar = beat * 4

  // groove enters at the first hit, or a quarter in; always on a bar line
  const grooveSec = hits.length ? hits[0] : input.duration * 0.25
  const grooveBeat = Math.max(4, Math.round(grooveSec / bar) * 4)

  // calm down at the last hit if it sits in the final 40%, else at 78%
  const lateHit = hits.length && hits[hits.length - 1] > input.duration * 0.6
    ? hits[hits.length - 1] : input.duration * 0.78
  const lateBeat = Math.max(grooveBeat + 4, Math.round(lateHit / bar) * 4)

  // past the final cut there is nothing left to sync to, so the groove stops
  const droneAt = cuts.length ? cuts[cuts.length - 1] : input.duration * 0.9

  // a bar is dense when the edit inside it is fast
  const denseBars: number[] = []
  const nBars = Math.ceil(input.duration / bar)
  for (let b = 0; b < nBars; b++) {
    const inBar = cuts.filter(c => c >= b * bar && c < (b + 1) * bar).length
    if (inBar >= 3) denseBars.push(b)
  }

  // whoosh on every cut, centred so its energy peak IS the cut
  const whooshes: WhooshEvent[] = cuts.map((c, i) => {
    const prev = i > 0 ? c - cuts[i - 1] : bar
    const fast = prev < beat * 1.5
    return { t: c, dur: fast ? 0.2 : 0.34, up: i % 2 === 0, level: fast ? 0.34 : 0.5 }
  })

  const lvl = intensity === 'epic' ? 1.0 : intensity === 'chill' ? 0.6 : 0.85
  const impacts: ImpactEvent[] = hits.map(h => ({ t: h, level: lvl }))
  const sectionTimes = [grooveBeat * beat, lateBeat * beat]
  for (const t of sectionTimes) {
    if (t < input.duration && !impacts.some(i => Math.abs(i.t - t) < 0.1)) impacts.push({ t, level: lvl })
  }
  impacts.sort((a, b) => a.t - b.t)

  // a pocket needs room to be heard as a pocket: nothing in the first second
  const pockets = style === 'cinematic' ? hits.filter(h => h > POCKET_SEC + 0.6) : []

  return {
    bpm, beat, duration: input.duration, intensity, style, seed,
    grooveBeat, lateBeat, droneAt, denseBars, whooshes, impacts,
    duckTimes: impacts.map(i => i.t),
    pockets,
  }
}

// ---------------------------------------------------------------------------
// small synth pieces, on top of sfxsynth primitives
// ---------------------------------------------------------------------------

const bandpass = (x: Float32Array, lo: number, hi: number, sr: number): Float32Array =>
  filt(filt(x, 'hp', lo, 0.71, sr), 'lp', hi, 0.71, sr)

/** 4th-order Butterworth low-pass as a two-biquad cascade. */
const lp4 = (x: Float32Array, freq: number, sr: number): Float32Array =>
  filt(filt(x, 'lp', freq, 0.541, sr), 'lp', freq, 1.307, sr)

function kickDrum(sr: number, rng: Rng): Float32Array {
  const dur = 0.42, n = Math.round(dur * sr)
  const body = mul(osc(n, sr, t => 38 + 105 * Math.exp(-t / 0.026)), envPerc(n, sr, 0.001, 0.27))
  const sub = mul(osc(n, sr, () => 41), envPerc(n, sr, 0.004, 0.20))
  const click = mul(bandpass(whiteNoise(n, rng), 900, 5500, sr), envPerc(n, sr, 0.0002, 0.005))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = (body[i] + sub[i] * 0.55 + click[i] * 0.5) * 0.95
  return out
}

function clapDrum(sr: number, rng: Rng): Float32Array {
  const n = Math.round(0.30 * sr)
  const src = bandpass(whiteNoise(n, rng), 1400, 8500, sr)
  const out = new Float32Array(n)
  const slaps = [0, 0.011, 0.022]
  slaps.forEach((off, k) => {
    const i0 = Math.round(off * sr)
    const e = envPerc(n - i0, sr, 0.0006, 0.013)
    for (let i = i0; i < n; i++) out[i] += src[i - i0] * e[i - i0] * (0.95 - 0.2 * k)
  })
  const tail = envPerc(n, sr, 0.005, 0.095)
  for (let i = 0; i < n; i++) out[i] = (out[i] + src[i] * tail[i] * 0.36) * 0.55
  return out
}

function hatTick(sr: number, rng: Rng, dur: number, lo: number, hi: number, level: number): Float32Array {
  const n = Math.round(dur * sr)
  return gain(mul(bandpass(whiteNoise(n, rng), lo, hi, sr), envPerc(n, sr, 0.0004, dur * 0.42)), level)
}

function additiveTone(sr: number, rng: Rng, freq: number, dur: number, harmonics: number, tilt: number, attack: number, decay: number): Float32Array {
  const n = Math.round(dur * sr)
  const out = new Float32Array(n)
  for (let h = 1; h <= harmonics; h++) {
    const f = freq * h
    if (f >= 15000) break
    const ph = rng.range(0, Math.PI * 2)
    const w = 2 * Math.PI * f / sr, amp = 1 / Math.pow(h, tilt)
    for (let i = 0; i < n; i++) out[i] += Math.sin(ph + w * i) * amp
  }
  let peak = 0
  for (const v of out) peak = Math.max(peak, Math.abs(v))
  const e = envPerc(n, sr, attack, decay)
  const g = peak > 0 ? 1 / peak : 1
  for (let i = 0; i < n; i++) out[i] *= e[i] * g
  return out
}

function braamSwell(sr: number, rng: Rng, freq: number, dur: number, level: number): Float32Array {
  const n = Math.round(dur * sr)
  const out = new Float32Array(n)
  for (const cents of [-9, -4, 0, 5, 11]) {
    const f0 = freq * Math.pow(2, cents / 1200)
    for (let h = 1; h <= 3; h++) {
      if (f0 * h >= 2600) break
      const ph = rng.range(0, Math.PI * 2)
      const w = 2 * Math.PI * f0 * h / sr, amp = 1 / Math.pow(h, 0.9)
      for (let i = 0; i < n; i++) out[i] += Math.sin(ph + w * i) * amp
    }
  }
  const dark = lp4(out, 1900, sr)
  const riseEnd = dur * 0.62
  let peak = 0
  for (const v of dark) peak = Math.max(peak, Math.abs(v))
  const g = peak > 0 ? level / peak : level
  const y = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const rise = Math.pow(Math.min(1, t / riseEnd), 2.2)
    const fall = Math.exp(-Math.max(0, t - riseEnd) / 0.35)
    y[i] = dark[i] * rise * fall * g
  }
  return y
}

function subDrop(sr: number, dur: number, f0: number, f1: number, level: number): Float32Array {
  const n = Math.round(dur * sr)
  const sig = osc(n, sr, t => f0 * Math.pow(f1 / f0, t / dur))
  const driven = saturate(sig, 1.8)
  const y = new Float32Array(n)
  const fade = Math.round(0.05 * sr)
  for (let i = 0; i < n; i++) {
    const x = i / n
    let s = driven[i] * 0.7 * Math.min(1, x * 8) * (1 - x * 0.25) * level
    if (i >= n - fade) s *= (n - i) / fade
    y[i] = s
  }
  return y
}

function endDrone(sr: number, freq: number, dur: number, level: number): Float32Array {
  const n = Math.max(4, Math.round(dur * sr))
  const y = new Float32Array(n)
  const w1 = 2 * Math.PI * (freq / 2) / sr
  const w2 = 2 * Math.PI * (freq * 0.749) / sr
  const w3 = 2 * Math.PI * freq / sr
  const a = Math.round(0.4 * sr), r = Math.min(n >> 1, Math.round(1.2 * sr))
  for (let i = 0; i < n; i++) {
    const t = i / sr
    let e = 1
    if (i < a) e = i / a
    if (i > n - r) e = Math.min(e, (n - i) / r)
    const lfo = 1 + 0.06 * Math.sin(2 * Math.PI * 0.4 * t)
    y[i] = (Math.sin(w1 * i) + 0.4 * Math.sin(w2 * i) + 0.25 * Math.sin(w3 * i)) * lfo * e * level / 1.65
  }
  return y
}

/** Stereo whoosh: three noise bands cross-faded low-to-high, panned across the
 *  field in the sweep's direction. Returns [left, right]. */
function whooshPair(sr: number, rng: Rng, dur: number, up: boolean, level: number): [Float32Array, Float32Array] {
  const n = Math.round(dur * sr)
  const src = whiteNoise(n, rng)
  const lowb = bandpass(src, 140, 900, sr)
  const midb = bandpass(src, 700, 3200, sr)
  const air = bandpass(src, 2800, 9000, sr)
  const L = new Float32Array(n), R = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = i / n
    const s = up ? x : 1 - x
    const sig = (lowb[i] * (1 - s) * (1 - s) * 1.35 + midb[i] * 2 * s * (1 - s) * 1.1 + air[i] * s * s * 1.15)
      * Math.pow(Math.sin(Math.PI * x), 1.3) * level * 0.5
    const pan = Math.max(-1, Math.min(1, (x - 0.5) * 1.7 * (up ? 1 : -1)))
    const theta = (pan + 1) * Math.PI / 4
    L[i] = sig * Math.cos(theta)
    R[i] = sig * Math.sin(theta)
  }
  return [L, R]
}

/** Impact with a room: boom + crack + three early reflections + tail wash. */
function bigImpact(sr: number, rng: Rng, level: number): Float32Array {
  const dur = 1.4, n = Math.round(dur * sr)
  const boom = mul(osc(n, sr, t => 36 + 130 * Math.exp(-t / 0.05)), envPerc(n, sr, 0.001, 0.32))
  const crack = gain(mul(bandpass(whiteNoise(n, rng), 1200, 8500, sr), envPerc(n, sr, 0.0004, 0.055)), 0.5)
  const dry = new Float32Array(n)
  for (let i = 0; i < n; i++) dry[i] = boom[i] + crack[i]
  const out = Float32Array.from(dry)
  for (const [delay, g, dark] of [[0.083, 0.30, 3800], [0.151, 0.18, 2600], [0.243, 0.11, 1700]] as const) {
    const echo = gain(filt(dry, 'lp', dark, 0.71, sr), g)
    addAt(out, echo, Math.round(delay * sr))
  }
  const wash = mul(bandpass(whiteNoise(n, rng), 300, 2400, sr), envPerc(n, sr, 0.01, 0.55))
  for (let i = 0; i < n; i++) out[i] = (out[i] + wash[i] * 0.06) * level * 0.72
  return out
}

function riserSweep(sr: number, rng: Rng, dur: number, level: number): Float32Array {
  const n = Math.round(dur * sr)
  const air = bandpass(whiteNoise(n, rng), 1500, 11000, sr)
  const tone = osc(n, sr, t => 220 * Math.pow(2, 2.6 * (t / dur)))
  const y = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = i / n
    y[i] = (air[i] * x * x * 1.5 + tone[i] * 0.25) * Math.pow(x, 1.7) * level * 0.55
  }
  return y
}

// ---------------------------------------------------------------------------
// cinematic palette
// ---------------------------------------------------------------------------

/** attack / sustain / release envelope, linear ramps */
function envASR(n: number, sr: number, attack: number, release: number): Float32Array {
  const a = Math.max(1, Math.round(attack * sr)), r = Math.max(1, Math.round(release * sr))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let e = 1
    if (i < a) e = i / a
    if (i > n - r) e = Math.min(e, (n - i) / r)
    out[i] = e
  }
  return out
}

/** Bowed string: saw-like additive with vibrato, breath noise and a dark low-pass. */
function bowedTone(sr: number, rng: Rng, freq: number, dur: number, attack: number, release: number, bright = 3200): Float32Array {
  const n = Math.round(dur * sr)
  const out = new Float32Array(n)
  const ph = rng.range(0, Math.PI * 2)
  const vibRate = 5.2 + rng.range(-0.4, 0.4), vibDepth = 0.004
  let phase = ph
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const f = freq * (1 + vibDepth * Math.sin(2 * Math.PI * vibRate * t) * Math.min(1, t / 0.4))
    phase += 2 * Math.PI * f / sr
    let v = 0
    for (let h = 1; h <= 14; h++) {
      if (f * h >= 12000) break
      v += Math.sin(phase * h) / Math.pow(h, 1.05)
    }
    out[i] = v
  }
  const breath = gain(bandpass(whiteNoise(n, rng), 1200, 4200, sr), 0.05)
  for (let i = 0; i < n; i++) out[i] += breath[i]
  const dark = lp4(out, bright, sr)
  const e = envASR(n, sr, attack, release)
  let peak = 0
  for (const v of dark) peak = Math.max(peak, Math.abs(v))
  const g = peak > 0 ? 1 / peak : 1
  for (let i = 0; i < n; i++) dark[i] *= e[i] * g
  return dark
}

/** Three detuned bowed voices per note: the string section. */
function stringsPad(sr: number, rng: Rng, freqs: number[], dur: number, level: number): Float32Array {
  const n = Math.round(dur * sr)
  const out = new Float32Array(n)
  for (const f of freqs) for (const cents of [-7, 0, 6]) {
    addAt(out, bowedTone(sr, rng, f * Math.pow(2, cents / 1200), dur, 0.55, 0.6, 2600), 0)
  }
  let peak = 0
  for (const v of out) peak = Math.max(peak, Math.abs(v))
  return gain(out, peak > 0 ? level / peak : level)
}

/** Felt piano: soft mallet, few harmonics, fast decay, a second detuned strike. */
function feltPiano(sr: number, rng: Rng, freq: number, dur: number): Float32Array {
  const n = Math.round(dur * sr)
  const a = additiveTone(sr, rng, freq, dur, 6, 1.8, 0.004, dur * 0.55)
  const b = additiveTone(sr, rng, freq * 1.0015, dur, 4, 2.2, 0.006, dur * 0.4)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = a[i] + b[i] * 0.5
  return lp4(out, 2400, sr)
}

/** Taiko: deep skin, long boom, a slap of noise, and the hall it lives in. */
function taiko(sr: number, rng: Rng, level: number): Float32Array {
  const dur = 1.1, n = Math.round(dur * sr)
  const body = mul(osc(n, sr, t => 46 + 70 * Math.exp(-t / 0.045)), envPerc(n, sr, 0.002, 0.42))
  const skin = mul(bandpass(whiteNoise(n, rng), 180, 1400, sr), envPerc(n, sr, 0.0008, 0.028))
  const dry = new Float32Array(n)
  for (let i = 0; i < n; i++) dry[i] = body[i] + skin[i] * 0.6
  const out = Float32Array.from(dry)
  for (const [delay, g, dark] of [[0.061, 0.28, 2600], [0.137, 0.16, 1800], [0.221, 0.09, 1200]] as const) {
    addAt(out, gain(filt(dry, 'lp', dark, 0.71, sr), g), Math.round(delay * sr))
  }
  let peak = 0
  for (const v of out) peak = Math.max(peak, Math.abs(v))
  return gain(out, peak > 0 ? level / peak : level)
}

/** Choir "ah": a rich tone pushed through three vowel formants, slow to bloom. */
function choirPad(sr: number, rng: Rng, freq: number, dur: number, level: number): Float32Array {
  const n = Math.round(dur * sr)
  const src = new Float32Array(n)
  for (const cents of [-5, 0, 4]) {
    const f0 = freq * Math.pow(2, cents / 1200)
    const ph = rng.range(0, Math.PI * 2)
    for (let h = 1; h <= 18; h++) {
      if (f0 * h >= 9000) break
      const w = 2 * Math.PI * f0 * h / sr, amp = 1 / Math.pow(h, 0.8)
      for (let i = 0; i < n; i++) src[i] += Math.sin(ph + w * i) * amp
    }
  }
  const out = new Float32Array(n)
  for (const [ff, q, g] of [[700, 5, 1.0], [1150, 6, 0.6], [2600, 7, 0.25]] as const) {
    const f = filt(src, 'bp', ff, q, sr)
    for (let i = 0; i < n; i++) out[i] += f[i] * g
  }
  const e = envASR(n, sr, 0.7, 0.8)
  let peak = 0
  for (const v of out) peak = Math.max(peak, Math.abs(v))
  const gg = peak > 0 ? level / peak : level
  for (let i = 0; i < n; i++) out[i] *= e[i] * gg
  return out
}

/** The pocket: the bed drops to nothing for POCKET_SEC before each hit, 20ms ramps. */
export function buildPockets(times: number[], n: number, sr: number): Float32Array {
  const env = new Float32Array(n).fill(1)
  const ramp = Math.round(0.02 * sr)
  for (const t of times) {
    const i1 = Math.round(t * sr), i0 = i1 - Math.round(POCKET_SEC * sr)
    for (let i = i0 - ramp; i < i1; i++) {
      if (i < 0 || i >= n) continue
      let v = 0
      if (i < i0) v = 1 - (i - (i0 - ramp)) / ramp
      if (v < env[i]) env[i] = v
    }
  }
  return env
}

const MINOR3 = Math.pow(2, 3 / 12), FIFTH = Math.pow(2, 7 / 12)

/** Fill the music bus with the cinematic arrangement. */
function renderCinematicBed(plan: ScorePlan, sr: number, rng: Rng, music: Float32Array, hot: number): void {
  const beat = plan.beat, bar = beat * 4
  const nBars = Math.ceil(plan.duration / bar)
  const at = (s: Float32Array, t: number, g = 1) => addAt(music, gain(s, g), Math.round(t * sr))
  const TK = taiko(sr, rng, 1)
  const epic = plan.intensity === 'epic'

  for (let b = 0; b < nBars; b++) {
    const b0 = b * 4, t0 = b0 * beat
    if (t0 >= plan.droneAt) continue
    const root = ROOTS[b % 4]
    const full = b0 >= plan.grooveBeat
    const late = b0 >= plan.lateBeat
    const dense = plan.denseBars.includes(b)
    const chord = [root * 2, root * 2 * MINOR3, root * 2 * FIFTH]

    // strings: quiet before the groove, present in it, sustained through the calm
    at(stringsPad(sr, rng, chord, bar * 1.05, (full ? 0.34 : 0.22) * hot), t0)

    // cello ostinato: eighths in the groove, quarters once it calms down
    if (full) {
      const steps = late ? [0, 1, 2, 3] : [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]
      steps.forEach((st, k) => {
        const f = (k % 4 === 2) ? root * 2 * FIFTH : root * 2
        const acc = (st % 1 === 0 ? 1 : 0.72) * (dense && k % 2 ? 1.1 : 1)
        at(bowedTone(sr, rng, f, (late ? beat : beat / 2) * 0.92, 0.018, 0.05, 2200), t0 + st * beat, 0.42 * acc * hot)
      })
    }

    // taiko: 1 and 3, plus 2, 4 and the "and of 4" when the edit is fast
    if (full) {
      const steps = late ? [0] : dense ? [0, 1, 2, 3, 3.5] : [0, 2]
      for (const st of steps) at(TK, t0 + st * beat, (st % 2 === 0 ? 0.9 : 0.6) * hot)
    }

    // felt piano: root on the downbeat, a fifth on 3 half the time
    at(feltPiano(sr, rng, root * 4, beat * 2.4), t0, (full ? 0.30 : 0.36) * hot)
    if (rng.next() < 0.5) at(feltPiano(sr, rng, root * 4 * FIFTH, beat * 1.8), t0 + 2 * beat, 0.22 * hot)
    if (!full && rng.next() < 0.35) at(feltPiano(sr, rng, root * 8, beat * 1.2), t0 + 3 * beat, 0.16 * hot)

    // choir: once the groove is under way (always in epic, second half otherwise)
    const choirIn = full && (epic || b0 >= plan.grooveBeat + Math.max(8, Math.round((plan.lateBeat - plan.grooveBeat) / 2 / 4) * 4))
    if (choirIn) at(choirPad(sr, rng, root * 4 * FIFTH, bar * 1.1, 0.20 * hot), t0)
  }

  // braams into the section starts, sub dives ahead of them, risers into every hit
  for (const [beatIdx, freq, lvl] of [[plan.grooveBeat, 110.0, 0.42], [plan.lateBeat, 98.0, 0.44]] as const) {
    const t = beatIdx * beat
    if (t > 1.2 && t < plan.duration) {
      at(braamSwell(sr, rng, freq, 1.8, lvl * hot), t - 1.8 * 0.62)
      at(subDrop(sr, 1.1, 120, 32, 0.7 * hot), t - 1.06)
    }
  }
  at(endDrone(sr, 55.0, plan.duration + 1.6 - plan.droneAt, 0.5), plan.droneAt)
}

/** The side-chain envelope: 12ms dive to `floor`, 50ms hold, 420ms recovery. */
export function buildDuck(times: number[], n: number, sr: number, floor = 0.40): Float32Array {
  const duck = new Float32Array(n).fill(1)
  const aN = Math.round(0.012 * sr), hN = Math.round(0.05 * sr), rN = Math.round(0.42 * sr)
  for (const t of times) {
    const i0 = Math.round(t * sr)
    for (let k = 0; k < aN + hN + rN; k++) {
      const i = i0 + k
      if (i < 0 || i >= n) continue
      let v: number
      if (k < aN) v = 1 + (floor - 1) * (k / aN)
      else if (k < aN + hN) v = floor
      else v = floor + (1 - floor) * (1 - Math.exp(-(k - aN - hN) / (rN / 5)))
      if (v < duck[i]) duck[i] = v
    }
  }
  return duck
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const ROOTS = [55.0, 43.65, 65.41, 49.0]      // Am F C G, one per bar
const RIFF = [440.0, 523.25, 659.25, 587.33, 523.25, 659.25, 783.99, 587.33]
const ACC = [1.0, 0.5, 0.78, 0.58]

export interface RenderParts { music?: boolean; fx?: boolean }

/** `parts` exists for tests and debugging: rendering the bed without the fx bus
 *  is the only honest way to measure the duck, because impacts and whooshes
 *  land exactly where the pocket is and fill the measurement window. */
export function renderScore(plan: ScorePlan, sampleRate = 48000, parts: RenderParts = {}): Stereo {
  const withMusic = parts.music !== false
  const withFx = parts.fx !== false
  const sr = sampleRate
  const rng = new Rng(plan.seed)
  const beat = plan.beat, bar = beat * 4
  const dur = plan.duration + 1.6
  const n = Math.round(dur * sr)
  const music = new Float32Array(n)
  const fxL = new Float32Array(n)
  const fxR = new Float32Array(n)
  const at = (buf: Float32Array, s: Float32Array, t: number, g = 1) => addAt(buf, gain(s, g), Math.round(t * sr))

  const K = kickDrum(sr, rng), C = clapDrum(sr, rng)
  const hot = plan.intensity === 'epic' ? 1.15 : plan.intensity === 'chill' ? 0.8 : 1.0
  const nBars = Math.ceil(plan.duration / bar)
  const cinematic = plan.style === 'cinematic'

  if (withMusic && cinematic) renderCinematicBed(plan, sr, rng, music, hot)

  for (let b = 0; b < (withMusic && !cinematic ? nBars : 0); b++) {
    const b0 = b * 4, t0 = b0 * beat
    if (t0 >= plan.droneAt) continue                       // the tail is drone country
    const root = ROOTS[b % 4]
    const full = b0 >= plan.grooveBeat
    const dense = plan.denseBars.includes(b)
    const late = b0 >= plan.lateBeat

    for (const step of (full ? [0, 1, 2, 3] : [0, 2])) at(music, K, t0 + step * beat, 1.0 * hot)
    if (full) at(music, K, t0 + 3.5 * beat, 0.55 * hot)

    if (full || b0 >= plan.grooveBeat - 8) {
      for (const step of [1, 3]) at(music, C, t0 + step * beat, (late ? 0.5 : full ? 0.85 : 0.5) * hot)
    }

    // dynamic hats: accents, per-hit variety, dropouts; brushes when late
    if (late) {
      for (const k of [1, 3]) {
        at(music, hatTick(sr, rng, rng.range(0.10, 0.16), 5500, 11000, 0.20),
          t0 + (2 * k - 0.5) * beat + rng.range(-0.005, 0.005), rng.range(0.45, 0.6))
      }
    } else {
      const div = dense ? 4 : 2
      let idx = 0
      for (let k = 1; k < div * 4; k += 2, idx++) {
        if (rng.next() < (dense ? 0.06 : 0.10)) continue
        at(music, hatTick(sr, rng, rng.range(0.035, 0.07), rng.range(6500, 7600), rng.range(12000, 14000), 0.30),
          t0 + k * beat / div + rng.range(-0.006, 0.006), ACC[idx % 4] * rng.range(0.85, 1.0))
      }
      at(music, hatTick(sr, rng, 0.16, 6000, 12000, 0.22), t0 + 3.5 * beat + rng.range(-0.004, 0.004), 0.8)
      if (rng.next() < 0.35) at(music, hatTick(sr, rng, 0.12, 6000, 12000, 0.20), t0 + 1.5 * beat + rng.range(-0.004, 0.004), 0.55)
    }

    if (full || b0 >= plan.grooveBeat - 8) {
      at(music, additiveTone(sr, rng, root, beat * 2.6, 10, 1.25, 0.006, 0.55), t0, 0.50)
      at(music, additiveTone(sr, rng, root, beat * 1.1, 10, 1.25, 0.006, 0.26), t0 + 2.5 * beat, 0.40)
      at(music, mul(osc(Math.round(beat * 3.2 * sr), sr, () => root / 2), envPerc(Math.round(beat * 3.2 * sr), sr, 0.008, 0.70)), t0, 0.62)
    }

    if (full) {
      for (let k = 0; k < 4; k++) {
        const note = RIFF[(b * 4 + k) % RIFF.length]
        at(music, additiveTone(sr, rng, note, beat * 0.9, 8, 1.5, 0.003, 0.13),
          t0 + k * beat + (k % 2 ? beat / 2 : 0), (dense ? 0.26 : 0.20) * hot)
      }
    }
  }

  // braams swell into the section starts, dives ahead of them
  if (withMusic && !cinematic) for (const [beatIdx, freq, lvl] of [[plan.grooveBeat, 110.0, 0.34], [plan.lateBeat, 98.0, 0.38]] as const) {
    const t = beatIdx * beat
    if (t > 1.2 && t < plan.duration) {
      at(music, braamSwell(sr, rng, freq, 1.6, lvl * hot), t - 1.6 * 0.62)
      at(music, subDrop(sr, 1.1, 120, 32, 0.7 * hot), t - 1.06)
    }
  }
  if (withMusic && !cinematic) at(music, endDrone(sr, 55.0, dur - plan.droneAt, 0.5), plan.droneAt)

  // fx bus: riser into the groove, whoosh on every cut, impact on every hit
  const grooveT = plan.grooveBeat * beat
  if (withFx && grooveT > 2) at(fxL, riserSweep(sr, rng, 1.9, 0.6), grooveT - 1.9), at(fxR, riserSweep(sr, rng, 1.9, 0.6), grooveT - 1.9)
  // cinematic: a riser climbs into every drop, so the pocket reads as tension, not a dropout
  if (withFx && cinematic) for (const t of plan.pockets) {
    const r = riserSweep(sr, rng, 1.4, 0.5)
    at(fxL, r, t - 1.4); at(fxR, r, t - 1.4)
  }
  for (const w of (withFx ? plan.whooshes : [])) {
    const [L, R] = whooshPair(sr, rng, w.dur, w.up, cinematic ? w.level * 0.55 : w.level)
    addAt(fxL, L, Math.round((w.t - w.dur / 2) * sr))
    addAt(fxR, R, Math.round((w.t - w.dur / 2) * sr))
  }
  for (const imp of (withFx ? plan.impacts : [])) {
    const s = bigImpact(sr, rng, imp.level)
    addAt(fxL, s, Math.round(imp.t * sr))
    addAt(fxR, s, Math.round(imp.t * sr))
  }

  // ---- master ----
  // saturate the low band (not a shelf), THEN duck (post-saturation), then sum
  const low = lp4(music, 130, sr)
  const duck = buildDuck(plan.duckTimes, n, sr)
  const pocket = plan.pockets.length ? buildPockets(plan.pockets, n, sr) : null
  let mPeak = 0
  const lowSat = saturate(low, 2.2)
  for (let i = 0; i < n; i++) {
    music[i] = (music[i] - low[i] + lowSat[i] * 0.55 * 1.35) * duck[i] * (pocket ? pocket[i] : 1)
    mPeak = Math.max(mPeak, Math.abs(music[i]))
  }
  const mg = mPeak > 0 ? 0.80 / mPeak : 1
  let fPeak = 0
  for (let i = 0; i < n; i++) fPeak = Math.max(fPeak, Math.abs(fxL[i]), Math.abs(fxR[i]))
  const fg = fPeak > 0 ? 0.58 / fPeak : 1

  let L: Float32Array = new Float32Array(n), R: Float32Array = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    L[i] = Math.tanh((music[i] * mg + fxL[i] * fg) * 1.05) * 0.92
    R[i] = Math.tanh((music[i] * mg + fxR[i] * fg) * 1.05) * 0.92
  }
  L = lp4(L, 15500, sr)
  R = lp4(R, 15500, sr)

  const fi = Math.round(0.12 * sr), fo = Math.round(1.2 * sr)
  for (const ch of [L, R]) {
    for (let i = 0; i < fi; i++) ch[i] *= i / fi
    for (let i = 0; i < fo; i++) ch[n - 1 - i] *= i / fo
  }
  let pk = 0
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]))
  const g = pk > 0 ? 0.70 / pk : 1
  for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g }

  return { left: L, right: R, sampleRate: sr }
}

/** One call: fit, plan, render. */
export function composeScore(input: ScoreInput, opts: ScoreOpts = {}): { plan: ScorePlan; stereo: Stereo } {
  const plan = planScore(input, opts)
  return { plan, stereo: renderScore(plan) }
}

export { toWav }
