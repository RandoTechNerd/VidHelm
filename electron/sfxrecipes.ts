// Sound effects built from how the thing actually makes the sound.
//
// Each recipe is a pure function of its options, so a seed reproduces a take exactly and the
// tests can measure what came out. The comments say what physical picture each model is chasing,
// because that is the part worth keeping when someone tunes the numbers later.

import {
  Rng, whiteNoise, pinkNoise, brownNoise, filt, sweepFilt, osc, envPerc, envPoints,
  mul, gain, mix, addAt, saturate, normalize, dcBlock, resonate, impact, passBy, room,
  type Stereo,
} from './sfxsynth'

export interface RecipeOptions {
  sampleRate?: number
  seed?: number
  /** rough length in seconds; recipes clamp it to something sensible for the sound */
  duration?: number
  /** 0..1, how much of the thing there is: more beans, a bigger door, a closer pass */
  intensity?: number
}

const mono = (x: Float32Array, sr: number): Stereo => ({ left: x, right: x.slice(), sampleRate: sr })

/** Slight stereo width by delaying and tilting one side. Keeps mono compatibility. */
const widen = (x: Float32Array, sr: number, ms = 7): Stereo => {
  const d = Math.round((ms / 1000) * sr)
  const right = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) right[i] = x[Math.max(0, i - d)] * 0.94
  return { left: x, right, sampleRate: sr }
}

const finish = (s: Stereo, peak = 0.89): Stereo => {
  const l = normalize(dcBlock(s.left), peak)
  const r = normalize(dcBlock(s.right), peak)
  // one shared gain so the image does not shift
  const g = Math.min(l.appliedGain, r.appliedGain)
  return { left: gain(dcBlock(s.left), g), right: gain(dcBlock(s.right), g), sampleRate: s.sampleRate }
}

// ---------------------------------------------------------------------------
// coffee beans poured into a hopper
// ---------------------------------------------------------------------------

/**
 * The physical picture: a stream of beans leaves a scoop and lands in a container. What makes it
 * recognisable is not any single click, it is four things happening together:
 *
 *   1. HUNDREDS of separate impacts, arriving at random intervals (Poisson, not a drum roll).
 *   2. A density envelope: the stream starts, floods, thins, and then a few STRAGGLERS land
 *      individually. Those last three or four discrete ticks are most of what sells it.
 *   3. Pile-up: early beans hit a hard resonant container and ring brightly. Later beans land on
 *      other beans, so the sound gets duller and quieter as the pour goes on.
 *   4. One shared body resonance, because every impact excites the same container.
 */
export function coffeeBeans(opts: RecipeOptions & { container?: 'metal' | 'plastic' | 'glass' } = {}): Stereo {
  const sr = opts.sampleRate ?? 48000
  const dur = Math.max(1.2, Math.min(6, opts.duration ?? 2.6))
  const intensity = Math.max(0.15, Math.min(1, opts.intensity ?? 0.7))
  const rng = new Rng(opts.seed ?? 7)
  const n = Math.round(dur * sr)
  const dry = new Float32Array(n)

  // how many beans per second, over the pour
  const pourEnd = dur * 0.72
  //
  // Measured the hard way: at 420 beans/second the impacts overlap fourteen deep and the whole
  // thing turns into one flat "shhhh". Individual beans only start poking out of the texture
  // around 150/s, which is also roughly what a scoop into a hopper really is.
  const density = envPoints(n, sr, [
    { t: 0, v: 0 },
    { t: 0.05, v: 90 * intensity },
    { t: 0.16, v: 170 * intensity },
    { t: pourEnd * 0.55, v: 140 * intensity },
    { t: pourEnd, v: 45 * intensity },
    { t: pourEnd + 0.10, v: 14 },
    { t: pourEnd + 0.35, v: 5 },
    { t: dur * 0.94, v: 2 },
    { t: dur, v: 0 },
  ])

  // walk the timeline, drawing the next gap from the current density (a Poisson process)
  let i = 0
  let count = 0
  while (i < n) {
    const rate = density[Math.min(n - 1, i)]
    if (rate < 0.5) { i += Math.round(sr * 0.01); continue }
    const gap = -Math.log(1 - rng.next()) / rate
    i += Math.max(1, Math.round(gap * sr))
    if (i >= n) break
    const progress = i / n

    // pile-up: bright and hard at first, duller as beans land on beans
    const pileUp = Math.min(1, progress / Math.max(0.05, pourEnd / dur))
    const centre = (3400 - 2300 * pileUp) * (0.7 + rng.next() * 0.7)
    const decay = (0.011 - 0.006 * pileUp) * (0.6 + rng.next() * 0.9)
    // a wide spread matters more than the mean: real pours have the odd bean that really cracks
    const level = (1 - 0.5 * pileUp) * (0.3 + Math.pow(rng.next(), 0.6) * 1.3)

    addAt(dry, impact(sr, rng, { freq: centre, decay, q: 1.6 + rng.next() * 1.6, bright: 0.35 * (1 - pileUp) }), i, level)
    count++
  }

  // the container: one voice, excited by every impact
  const bodies: Record<string, { freq: number; q: number; gain: number }[]> = {
    metal: [{ freq: 430, q: 9, gain: 0.5 }, { freq: 1180, q: 13, gain: 0.36 }, { freq: 2340, q: 16, gain: 0.2 }, { freq: 3900, q: 18, gain: 0.1 }],
    plastic: [{ freq: 300, q: 5, gain: 0.5 }, { freq: 760, q: 6, gain: 0.28 }, { freq: 1500, q: 7, gain: 0.12 }],
    glass: [{ freq: 620, q: 14, gain: 0.45 }, { freq: 1720, q: 20, gain: 0.34 }, { freq: 3300, q: 24, gain: 0.22 }],
  }
  const body = resonate(dry, bodies[opts.container || 'metal'], sr)

  // the collective mass: a low rumble that exists only while the stream is heavy
  const massEnv = envPoints(n, sr, [
    { t: 0, v: 0 }, { t: 0.12, v: 0.22 }, { t: pourEnd * 0.6, v: 0.18 }, { t: pourEnd, v: 0.04 }, { t: dur, v: 0 },
  ])
  const mass = mul(filt(brownNoise(n, rng), 'lp', 220, 0.8, sr), massEnv)

  // bean-on-bean rattle: quiet, broadband, only while pouring
  const rattle = mul(filt(pinkNoise(n, rng), 'bp', 3200, 0.8, sr), gain(massEnv, 0.28))

  const all = mix(gain(dry, 1.0), gain(body, 0.5), gain(mass, 0.3), gain(rattle, 0.7))
  const wet = room(all, sr, { size: 0.011, mix: 0.13, damp: 9000 })
  void count
  return finish(widen(wet, sr, 5))
}

// ---------------------------------------------------------------------------
// electronic door
// ---------------------------------------------------------------------------

/**
 * The sci-fi door everyone pictures is not one sound, it is a little story in four beats:
 * the latch lets go, pressurised air escapes, a servo drags the panel, and the panel seats.
 *
 * The escaping air is the signature: a band of noise whose centre frequency falls as the
 * pressure drops. A fixed-frequency hiss sounds like a tape machine; a falling one sounds like
 * something releasing.
 */
export function electronicDoor(opts: RecipeOptions & { closing?: boolean } = {}): Stereo {
  const sr = opts.sampleRate ?? 48000
  const dur = Math.max(0.5, Math.min(3, opts.duration ?? 0.92))
  const intensity = Math.max(0.15, Math.min(1, opts.intensity ?? 0.7))
  const rng = new Rng(opts.seed ?? 21)
  const n = Math.round(dur * sr)
  const out = new Float32Array(n)

  // 1) the latch: a hard metallic click
  addAt(out, impact(sr, rng, { freq: 2100, decay: 0.02, q: 3.2, bright: 0.5 }), 0.01 * sr, 0.55)
  addAt(out, impact(sr, rng, { freq: 620, decay: 0.05, q: 4.5 }), 0.014 * sr, 0.4)

  // 2) pneumatic release: noise whose band falls as the pressure drops
  const hissLen = Math.round(Math.min(dur * 0.6, 0.5) * sr)
  const hissEnv = envPoints(hissLen, sr, [
    { t: 0, v: 0 }, { t: 0.012, v: 1 }, { t: 0.08, v: 0.72 }, { t: hissLen / sr, v: 0 },
  ])
  const hissRaw = mul(whiteNoise(hissLen, rng), hissEnv)
  const hiss = sweepFilt(hissRaw, 'bp', t => 5200 * Math.exp(-t * 3.4) + 900, 1.05, sr)
  addAt(out, hiss, 0.02 * sr, 0.85 * intensity)

  // 3) servo: a quiet tone that rises as the panel accelerates and falls as it arrives.
  //    Slight vibrato, because a real motor is never perfectly smooth.
  const servoStart = 0.05, servoLen = Math.round(Math.min(dur * 0.62, 0.62) * sr)
  const dirn = opts.closing ? -1 : 1
  const servo = osc(servoLen, sr, t => {
    const p = t / (servoLen / sr)
    const base = 190 + dirn * 250 * Math.sin(Math.PI * p)      // up then back down
    return base + 6 * Math.sin(2 * Math.PI * 34 * t)
  }, 'saw')
  const servoEnv = envPoints(servoLen, sr, [
    { t: 0, v: 0 }, { t: 0.05, v: 0.5 }, { t: servoLen / sr * 0.6, v: 0.42 }, { t: servoLen / sr, v: 0 },
  ])
  addAt(out, filt(mul(servo, servoEnv), 'lp', 2600, 1.1, sr), servoStart * sr, 0.3)

  // 4) the panel sliding in its track, then seating with a soft thud and a short ring
  const slideLen = Math.round(Math.min(dur * 0.55, 0.55) * sr)
  const slide = mul(pinkNoise(slideLen, rng), envPoints(slideLen, sr, [
    { t: 0, v: 0 }, { t: 0.09, v: 0.55 }, { t: slideLen / sr * 0.8, v: 0.4 }, { t: slideLen / sr, v: 0 },
  ]))
  addAt(out, filt(slide, 'bp', 1500, 0.6, sr), 0.07 * sr, 0.35)

  const seatAt = Math.min(n - 1, Math.round((dur * 0.7) * sr))
  addAt(out, impact(sr, rng, { freq: 150, decay: 0.11, q: 1.4 }), seatAt, 1.15)
  addAt(out, impact(sr, rng, { freq: 78, decay: 0.14, q: 1.1 }), seatAt, 0.9)
  addAt(out, impact(sr, rng, { freq: 3100, decay: 0.03, q: 6, bright: 0.3 }), seatAt, 0.4)
  const ring = mul(osc(Math.round(0.3 * sr), sr, () => 2480, 'sine'), envPerc(Math.round(0.3 * sr), sr, 0.001, 0.06))
  addAt(out, ring, seatAt, 0.12)

  return finish(widen(room(out, sr, { size: 0.021, mix: 0.2, damp: 6500 }), sr, 9))
}

// ---------------------------------------------------------------------------
// pod racer
// ---------------------------------------------------------------------------

/**
 * The engine itself: a turbine scream over a combustion roar.
 *
 * Three layers, because that is what the real thing is made of. A set of detuned sawtooths gives
 * the harmonic body, slight frequency-modulation gives the growl that a plain oscillator stack
 * never has, and filtered noise gives the air being torn up. The resonant lowpass opens with
 * throttle, which is what makes it sound like power rather than volume.
 */
function engine(n: number, sr: number, rng: Rng, rpmAt: (t: number) => number, throttleAt: (t: number) => number): Float32Array {
  const growl = osc(n, sr, t => rpmAt(t) * 0.5 + 9 * Math.sin(2 * Math.PI * 31 * t), 'sine')
  const fm = (t: number, i: number) => rpmAt(t) * (1 + 0.06 * growl[Math.min(n - 1, i)])

  // detuned pair: the beating between them is most of the "big machine" impression
  const a = osc(n, sr, t => fm(t, Math.round(t * sr)), 'saw')
  const b = osc(n, sr, t => fm(t, Math.round(t * sr)) * 1.008, 'saw', 0.3)
  const sub = osc(n, sr, t => rpmAt(t) * 0.5, 'square')
  // the scream: two high partials of the same shaft speed, which is what makes it a turbine
  // rather than a diesel. Without these the whole thing sits under 200Hz and rumbles.
  const turbine = osc(n, sr, t => rpmAt(t) * 8.5, 'sine')
  const turbine2 = osc(n, sr, t => rpmAt(t) * 13.1, 'sine')

  const roar = filt(whiteNoise(n, rng), 'bp', 1800, 0.55, sr)
  const air = filt(pinkNoise(n, rng), 'hp', 3000, 0.7, sr)

  const stack = mix(gain(a, 0.3), gain(b, 0.26), gain(sub, 0.18),
    gain(turbine, 0.26), gain(turbine2, 0.14), gain(roar, 0.4), gain(air, 0.16))
  // the throttle opens the filter, not just the fader
  const opened = sweepFilt(stack, 'lp', t => 420 + 8200 * throttleAt(t), 1.5, sr)
  return saturate(opened, 1.9)
}

/** Ignition, catch, rev up to full song. */
export function podracerStart(opts: RecipeOptions = {}): Stereo {
  const sr = opts.sampleRate ?? 48000
  const dur = Math.max(1.5, Math.min(8, opts.duration ?? 3.2))
  const intensity = Math.max(0.15, Math.min(1, opts.intensity ?? 0.8))
  const rng = new Rng(opts.seed ?? 99)
  const n = Math.round(dur * sr)

  // RPM: a couple of failed catches, then it takes and climbs
  const idle = 74, full = 210 * (0.8 + 0.4 * intensity)
  const rpmAt = (t: number) => {
    const p = t / dur
    if (p < 0.10) return idle * (0.25 + 2.4 * p)                       // turning over
    if (p < 0.17) return idle * 0.9                                     // didn't catch
    if (p < 0.24) return idle * (0.9 + 1.6 * (p - 0.17) / 0.07)         // catches
    const k = Math.min(1, (p - 0.24) / 0.55)
    return idle * 1.7 + (full - idle * 1.7) * (1 - Math.exp(-3.2 * k))  // spools up
  }
  const throttleAt = (t: number) => {
    const p = t / dur
    if (p < 0.10) return 0.08
    if (p < 0.17) return 0.05
    const k = Math.min(1, (p - 0.17) / 0.6)
    return 0.1 + 0.9 * (1 - Math.exp(-2.6 * k))
  }

  let core = engine(n, sr, rng, rpmAt, throttleAt)

  // sputters while it is trying to catch: brief dropouts, which is what makes it sound
  // mechanical rather than like a synth pad being faded up
  const sputter = new Float32Array(n).fill(1)
  for (let k = 0; k < 7; k++) {
    const at = Math.round(rng.range(0.04, 0.30) * n)
    const len = Math.round(rng.range(0.004, 0.02) * sr)
    for (let i = at; i < Math.min(n, at + len); i++) sputter[i] = 0.18
  }
  core = mul(core, sputter)

  // the ignition itself
  const ign = mul(whiteNoise(Math.round(0.25 * sr), rng), envPerc(Math.round(0.25 * sr), sr, 0.001, 0.05))
  const out = new Float32Array(n)
  addAt(out, filt(ign, 'bp', 900, 0.6, sr), 0.02 * sr, 0.8)
  addAt(out, core, 0, 1)

  // whine that arrives once it is really going
  const whine = mul(
    osc(n, sr, t => 2400 + 2600 * Math.min(1, Math.max(0, (t / dur - 0.3) / 0.5)), 'sine'),
    envPoints(n, sr, [{ t: 0, v: 0 }, { t: dur * 0.35, v: 0 }, { t: dur * 0.75, v: 0.1 }, { t: dur, v: 0.08 }]),
  )
  const all = mix(out, whine)
  return finish(widen(room(all, sr, { size: 0.05, mix: 0.16, damp: 8000 }), sr, 11))
}

/**
 * Full throttle, straight past the camera.
 *
 * The engine is rendered as a mono source and then physically flown past the listener, so the
 * Doppler, the loudness and the stereo movement all come from one consistent geometry rather
 * than three separate automation curves that never quite agree with each other.
 */
export function podracerPassBy(opts: RecipeOptions & { speed?: number; closest?: number } = {}): Stereo {
  const sr = opts.sampleRate ?? 48000
  // 3.4s at nine metres left most of both ends inaudible (measured -42dB at the edges), so the
  // default pass sits a little further out and does not run as long
  const dur = Math.max(1.5, Math.min(8, opts.duration ?? 2.8))
  const intensity = Math.max(0.15, Math.min(1, opts.intensity ?? 0.85))
  const rng = new Rng(opts.seed ?? 4242)
  const n = Math.round(dur * sr)

  // it is already flat out, with a little surge as it goes by
  const rpm = 196 * (0.8 + 0.4 * intensity)
  const rpmAt = (t: number) => rpm * (1 + 0.06 * Math.sin(2 * Math.PI * 0.7 * t) + 0.05 * Math.exp(-Math.pow((t - dur * 0.5) / 0.35, 2)))
  const throttleAt = () => 0.92

  // The air being torn up is part of the SOURCE, so it is mixed in before the fly-past rather
  // than laid over the top. Added afterwards it keeps its own level while the engine falls away
  // with distance, and the thing ends up sounding brighter as it disappears than it did going
  // past: measured 754Hz at the closest point against 1466Hz once it was 130 metres away.
  const rush = filt(pinkNoise(n, rng), 'bp', 1200, 0.5, sr)
  const src = mix(engine(n, sr, rng, rpmAt, throttleAt), gain(rush, 0.22))

  const flown = passBy(src, sr, {
    speed: opts.speed ?? 95,           // m/s: fast enough for an obvious pitch drop
    closest: opts.closest ?? 13,
    at: 0.5,
  })

  return finish({ left: flown.left, right: flown.right, sampleRate: sr })
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export const REALISTIC_RECIPES: Record<string, { render: (o: RecipeOptions) => Stereo; seconds: number; about: string }> = {
  'coffee-beans': { render: coffeeBeans, seconds: 2.6, about: 'beans poured into a metal hopper, with stragglers at the end' },
  'coffee-beans-plastic': { render: (o) => coffeeBeans({ ...o, container: 'plastic' }), seconds: 2.6, about: 'beans poured into a plastic tub' },
  'coffee-beans-glass': { render: (o) => coffeeBeans({ ...o, container: 'glass' }), seconds: 2.6, about: 'beans poured into a glass jar' },
  'door-electronic': { render: electronicDoor, seconds: 0.92, about: 'sci-fi door: latch, pneumatic release, servo, seat' },
  'door-electronic-close': { render: (o) => electronicDoor({ ...o, closing: true }), seconds: 0.92, about: 'the same door closing' },
  'podracer-start': { render: podracerStart, seconds: 3.2, about: 'ignition, a couple of failed catches, then it spools up' },
  'podracer-pass': { render: podracerPassBy, seconds: 2.8, about: 'full throttle past the camera, with real Doppler' },
}
