// Tests for the sound-effect synthesis engine (electron/sfxsynth.ts + sfxrecipes.ts).
// Run with: npm run test:sfxsynth
//
// These assert ACOUSTIC properties, not sample values: a pour has to have hundreds of separate
// onsets and get duller as the pile builds, a pass-by has to drop in pitch and move across the
// stereo field. That is the only way to check "does it sound like the thing" without ears.

import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({
    entryPoints: [path.join(here, '..', 'electron', file)],
    bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18',
  })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const S = await load('sfxsynth.ts')
const R = await load('sfxrecipes.ts')

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  PASS ', label) } else { fail++; console.log('  FAIL ', label) } }
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

// ---- measurement helpers ----
const peak = (x) => { let m = 0; for (const v of x) m = Math.max(m, Math.abs(v)); return m }
const rms = (x, from = 0, to = x.length) => {
  let s = 0
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, to - from))
}
const dc = (x) => { let s = 0; for (const v of x) s += v; return s / x.length }

/** Count sharp amplitude rises: how many separate events are in here. */
const onsets = (x, sr, { hop = 32, win = 64, ratio = 1.35, floor = 0.002 } = {}) => {
  const env = []
  for (let i = 0; i + win < x.length; i += hop) env.push(rms(x, i, i + win))
  let count = 0
  for (let i = 2; i < env.length - 1; i++) {
    if (env[i] > floor && env[i] > env[i - 1] * ratio && env[i] >= env[i + 1]) count++
  }
  return { count, env, hopSec: hop / sr }
}

/** Spectral centroid over a window, via a small DFT on a decimated band. */
const centroid = (x, sr, from, to) => {
  const n = 2048
  const start = Math.min(Math.max(0, from), Math.max(0, x.length - n))
  void to
  let num = 0, den = 0
  // Goertzel at log-spaced probe frequencies: cheaper than a full FFT and enough for a centroid
  for (let f = 120; f < sr / 2; f *= 1.18) {
    const w = 2 * Math.PI * f / sr
    const coeff = 2 * Math.cos(w)
    let s0 = 0, s1 = 0, s2 = 0
    for (let i = 0; i < n; i++) {
      const xi = x[start + i] ?? 0
      s0 = xi + coeff * s1 - s2
      s2 = s1; s1 = s0
    }
    const mag = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2))
    num += f * mag; den += mag
  }
  return den > 0 ? num / den : 0
}

/** Fundamental frequency by autocorrelation, on a low-passed copy. Used for the Doppler check. */
const pitch = (x, sr, from, len, loHz = 60, hiHz = 400) => {
  const seg = x.slice(from, from + len)
  const lp = S.filt(seg, 'lp', 900, 0.7, sr)
  const minLag = Math.floor(sr / hiHz), maxLag = Math.floor(sr / loHz)
  let best = 0, bestLag = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0
    for (let i = 0; i + lag < lp.length; i++) s += lp[i] * lp[i + lag]
    if (s > best) { best = s; bestLag = lag }
  }
  return bestLag > 0 ? sr / bestLag : 0
}

console.log('\n-- primitives --')
{
  const rng = new S.Rng(5)
  const a = S.whiteNoise(1000, new S.Rng(5))
  const b = S.whiteNoise(1000, new S.Rng(5))
  const c = S.whiteNoise(1000, new S.Rng(6))
  ok(a.every((v, i) => v === b[i]), 'the same seed gives the same noise')
  ok(!a.every((v, i) => v === c[i]), 'a different seed gives different noise')
  ok(Math.abs(dc(a)) < 0.08, 'white noise has no meaningful DC offset')
  void rng
}
{
  const sr = 48000
  const pink = S.pinkNoise(sr, new S.Rng(1))
  const white = S.whiteNoise(sr, new S.Rng(1))
  ok(centroid(pink, sr, 0) < centroid(white, sr, 0), 'pink noise is darker than white noise')
  ok(centroid(S.brownNoise(sr, new S.Rng(1)), sr, 0) < centroid(pink, sr, 0), 'brown is darker still')
}
{
  const sr = 48000
  const tone = S.osc(sr, sr, () => 1000, 'sine')
  const lp = S.filt(tone, 'lp', 200, 0.7, sr)
  ok(peak(lp) < peak(tone) * 0.35, 'a lowpass well below the tone actually attenuates it')
  const hp = S.filt(tone, 'hp', 5000, 0.7, sr)
  ok(peak(hp) < peak(tone) * 0.35, 'and so does a highpass well above it')
}
{
  // the phase-accumulator check: a swept oscillator must END at the frequency asked for
  const sr = 48000
  const sweep = S.osc(sr, sr, t => 100 + 900 * t, 'sine')
  const endPitch = pitch(sweep, sr, sr - 8000, 8000, 50, 2000)
  ok(Math.abs(endPitch - 1000) < 120, `a sweep to 1000Hz ends near 1000Hz (got ${endPitch.toFixed(0)})`)
}
{
  const sr = 48000
  const x = S.osc(4800, sr, () => 200, 'sine')
  const n = S.normalize(x, 0.5)
  ok(Math.abs(peak(n.out) - 0.5) < 0.001, 'normalize hits its target peak')
  eq(S.normalize(new Float32Array(100), 0.9).appliedGain, 1, 'normalizing silence does not divide by zero')
}
{
  const sr = 48000
  const dst = new Float32Array(1000)
  S.addAt(dst, new Float32Array([1, 1, 1]), 998, 1)
  ok(dst[998] === 1 && dst[999] === 1, 'addAt writes what fits')
  ok(dst.length === 1000, 'and does not grow the buffer past its end')
}

console.log('\n-- coffee beans --')
{
  const sr = 48000
  const s = R.coffeeBeans({ sampleRate: sr, seed: 3, duration: 2.6 })
  eq(s.left.length, Math.round(2.6 * sr), 'it is the length asked for')
  ok(peak(s.left) <= 0.9001, `it does not clip (peak ${peak(s.left).toFixed(3)})`)
  ok(Math.abs(dc(s.left)) < 0.002, 'no DC offset')

  const o = onsets(s.left, sr)
  ok(o.count > 60, `it is made of many separate impacts (${o.count} onsets detected)`)

  // pile-up: the pour gets duller as beans land on beans instead of on metal
  const early = centroid(s.left, sr, Math.round(0.2 * sr))
  const late = centroid(s.left, sr, Math.round(1.5 * sr))
  ok(late < early, `it gets duller as the pile builds (${early.toFixed(0)}Hz -> ${late.toFixed(0)}Hz)`)

  // stragglers: the tail is much quieter than the flood, but not silent
  const flood = rms(s.left, Math.round(0.3 * sr), Math.round(0.8 * sr))
  const tail = rms(s.left, Math.round(2.1 * sr), Math.round(2.5 * sr))
  ok(tail < flood * 0.5, `the stream thins out (flood ${flood.toFixed(3)} vs tail ${tail.toFixed(3)})`)
  ok(tail > 0.0002, 'but the last beans still land, rather than cutting to silence')

  const again = R.coffeeBeans({ sampleRate: sr, seed: 3, duration: 2.6 })
  ok(s.left.every((v, i) => v === again.left[i]), 'the same seed is the same take')
  const other = R.coffeeBeans({ sampleRate: sr, seed: 4, duration: 2.6 })
  ok(!s.left.every((v, i) => v === other.left[i]), 'a different seed is a different take')

  const plastic = R.coffeeBeans({ sampleRate: sr, seed: 3, container: 'plastic' })
  const glass = R.coffeeBeans({ sampleRate: sr, seed: 3, container: 'glass' })
  ok(centroid(glass.left, sr, Math.round(0.4 * sr)) > centroid(plastic.left, sr, Math.round(0.4 * sr)),
    'a glass jar rings brighter than a plastic tub')
}
{
  const sr = 48000
  const light = R.coffeeBeans({ sampleRate: sr, seed: 3, intensity: 0.2 })
  const heavy = R.coffeeBeans({ sampleRate: sr, seed: 3, intensity: 1 })
  ok(onsets(heavy.left, sr).count > onsets(light.left, sr).count, 'more intensity means more beans')
}

console.log('\n-- electronic door --')
{
  const sr = 48000
  const s = R.electronicDoor({ sampleRate: sr, seed: 11 })
  ok(peak(s.left) <= 0.9001, 'it does not clip')
  ok(rms(s.left, 0, Math.round(0.03 * sr)) > 0.01, 'the latch fires immediately, not after a gap')

  // the signature: the escaping air falls in pitch as the pressure drops
  const c1 = centroid(s.left, sr, Math.round(0.04 * sr))
  const c2 = centroid(s.left, sr, Math.round(0.30 * sr))
  ok(c2 < c1, `the pneumatic release falls in pitch (${c1.toFixed(0)}Hz -> ${c2.toFixed(0)}Hz)`)

  // and it lands on something: a transient in the last third
  const seat = rms(s.left, Math.round(0.64 * sr), Math.round(0.75 * sr))
  const before = rms(s.left, Math.round(0.52 * sr), Math.round(0.60 * sr))
  ok(seat > before * 1.05, `the panel seats with an audible thud at the end (${before.toFixed(4)} -> ${seat.toFixed(4)})`)
}

console.log('\n-- podracer starting --')
{
  const sr = 48000
  const s = R.podracerStart({ sampleRate: sr, seed: 8, duration: 3.2 })
  ok(peak(s.left) <= 0.9001, 'it does not clip')
  const first = rms(s.left, Math.round(0.4 * sr), Math.round(0.7 * sr))
  const last = rms(s.left, Math.round(2.6 * sr), Math.round(3.0 * sr))
  ok(last > first, `it gets louder as it spools up (${first.toFixed(3)} -> ${last.toFixed(3)})`)

  const pEarly = pitch(s.left, sr, Math.round(0.5 * sr), 16384, 30, 400)
  const pLate = pitch(s.left, sr, Math.round(2.7 * sr), 16384, 30, 400)
  ok(pLate > pEarly, `the engine note rises (${pEarly.toFixed(0)}Hz -> ${pLate.toFixed(0)}Hz)`)
}

console.log('\n-- podracer pass-by (the Doppler test) --')
{
  const sr = 48000
  const s = R.podracerPassBy({ sampleRate: sr, seed: 12, duration: 3.4, speed: 95, closest: 9 })
  ok(peak(s.left) <= 0.9001, 'it does not clip')

  // loudest as it goes past, quiet at both ends
  const mid = rms(s.left, Math.round(1.5 * sr), Math.round(1.9 * sr))
  const start = rms(s.left, 0, Math.round(0.4 * sr))
  const end = rms(s.left, Math.round(3.0 * sr), Math.round(3.4 * sr))
  ok(mid > start * 1.5 && mid > end * 1.5, `it peaks at the closest point (${start.toFixed(3)} / ${mid.toFixed(3)} / ${end.toFixed(3)})`)

  // and it crosses the stereo field rather than sitting in the middle
  const lFirst = rms(s.left, Math.round(0.6 * sr), Math.round(1.4 * sr))
  const rFirst = rms(s.right, Math.round(0.6 * sr), Math.round(1.4 * sr))
  const lLast = rms(s.left, Math.round(2.0 * sr), Math.round(2.8 * sr))
  const rLast = rms(s.right, Math.round(2.0 * sr), Math.round(2.8 * sr))
  ok(lFirst > rFirst && rLast > lLast, `it travels left to right (L/R ${(lFirst / rFirst).toFixed(2)} then ${(lLast / rLast).toFixed(2)})`)

  // and it dulls as it leaves, because air eats the top end with distance
  const near = centroid(s.left, sr, Math.round(1.7 * sr))
  const far = centroid(s.left, sr, Math.round(3.1 * sr))
  ok(far < near, `it gets duller as it goes away (${near.toFixed(0)}Hz -> ${far.toFixed(0)}Hz)`)
}

// The Doppler itself is measured on a PURE TONE rather than on the engine. A pitch tracker
// cannot be trusted on a saw-and-noise engine once it is 40dB down and receding (measured
// confidence fell to 0.09), so testing it there tests the tracker, not the physics. If the
// geometry is right for a tone, it is right for anything flown through it.
console.log('\n-- Doppler, against the textbook --')
{
  const sr = 48000, c = 343, f0 = 200
  const tone = S.osc(Math.round(3 * sr), sr, () => f0, 'sine')
  for (const speed of [25, 60, 95]) {
    const flown = S.passBy(tone, sr, { speed, closest: 9, at: 0.5 })
    const approach = pitch(flown.left, sr, Math.round(0.5 * sr), 16384, 100, 400)
    const recede = pitch(flown.left, sr, Math.round(2.4 * sr), 16384, 100, 400)
    const wantA = f0 * c / (c - speed), wantB = f0 * c / (c + speed)
    // the measuring window spans a range of velocities, so it reads a little inside the
    // instantaneous extremes: the bound is "past f0, and no further than theory allows"
    ok(approach > f0 * 1.02 && approach <= wantA * 1.05,
      `${speed}m/s approaching: ${approach.toFixed(0)}Hz, above ${f0} and within theory ${wantA.toFixed(0)}`)
    ok(recede < f0 * 0.98 && recede >= wantB * 0.9,
      `${speed}m/s receding: ${recede.toFixed(0)}Hz, below ${f0} and near theory ${wantB.toFixed(0)}`)
  }
}
{
  // the shift must scale with speed, which is what proves it is geometry and not a preset ramp
  const sr = 48000
  const tone = S.osc(Math.round(3 * sr), sr, () => 200, 'sine')
  const shift = (speed) => {
    const f = S.passBy(tone, sr, { speed, closest: 9, at: 0.5 })
    return pitch(f.left, sr, Math.round(0.5 * sr), 16384, 100, 400) / pitch(f.left, sr, Math.round(2.4 * sr), 16384, 100, 400)
  }
  const slow = shift(25), fast = shift(95)
  ok(fast > slow * 1.3, `a faster pass bends pitch further (x${slow.toFixed(2)} at 25m/s vs x${fast.toFixed(2)} at 95m/s)`)
}
{
  // the null case, which catches a hidden pitch ramp masquerading as physics
  const sr = 48000
  const tone = S.osc(Math.round(3 * sr), sr, () => 200, 'sine')
  const still = S.passBy(tone, sr, { speed: 0, closest: 9, at: 0.5 })
  const a = pitch(still.left, sr, Math.round(0.5 * sr), 16384, 100, 400)
  const b = pitch(still.left, sr, Math.round(2.4 * sr), 16384, 100, 400)
  ok(Math.abs(a - b) < 3, `a source that is not moving does not change pitch (${a.toFixed(0)}Hz vs ${b.toFixed(0)}Hz)`)
}

console.log('\n-- wav output --')
{
  const sr = 48000
  const s = R.electronicDoor({ sampleRate: sr, seed: 2 })
  const wav = S.toWav(s)
  const txt = Buffer.from(wav.slice(0, 4)).toString()
  eq(txt, 'RIFF', 'it writes a RIFF header')
  eq(Buffer.from(wav.slice(8, 12)).toString(), 'WAVE', 'of type WAVE')
  const view = new DataView(wav.buffer, wav.byteOffset)
  eq(view.getUint16(22, true), 2, 'stereo')
  eq(view.getUint32(24, true), 48000, '48kHz')
  eq(view.getUint16(34, true), 16, '16-bit')
  eq(wav.length, 44 + s.left.length * 4, 'the data length matches the samples')
}

console.log('\n-- every recipe in the registry renders --')
for (const [name, r] of Object.entries(R.REALISTIC_RECIPES)) {
  const s = r.render({ sampleRate: 48000, seed: 1 })
  const good = s.left.length > 1000 && peak(s.left) > 0.05 && peak(s.left) <= 0.9001 && s.left.every(Number.isFinite)
  ok(good, `${name}: ${s.left.length} samples, peak ${peak(s.left).toFixed(2)}${r.about ? ` (${r.about})` : ''}`)
}

console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✗ FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
