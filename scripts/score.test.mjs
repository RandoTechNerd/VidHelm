// Tests for the cut-synced score engine (electron/score.ts).
// Run with: npm run test:score
//
// Like the sfxsynth suite these assert MUSICAL properties, not sample values:
// the fitted tempo has to recover a known grid, the duck has to carve a real
// pocket, the whoosh has to travel across the stereo field, and the hats have
// to calm down after the last hit. That is the only way to check "does it sync"
// without ears.

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
const S = await load('score.ts')

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  PASS ', label) } else { fail++; console.log('  FAIL ', label) } }

// ---- measurement helpers ----
const rms = (x, from, to) => {
  let s = 0, n = 0
  for (let i = Math.max(0, from | 0); i < Math.min(x.length, to | 0); i++) { s += x[i] * x[i]; n++ }
  return n ? Math.sqrt(s / n) : 0
}
const db = v => 20 * Math.log10(v + 1e-12)
// crude single-bin band energy via Goertzel, enough to compare regions
const goertzel = (x, from, to, freq, sr) => {
  const w = 2 * Math.PI * freq / sr, c = 2 * Math.cos(w)
  let s0 = 0, s1 = 0, s2 = 0
  for (let i = Math.max(0, from | 0); i < Math.min(x.length, to | 0); i++) { s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0 }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2))
}
const bandEnergy = (x, from, to, lo, hi, sr, steps = 8) => {
  let e = 0
  for (let k = 0; k < steps; k++) e += goertzel(x, from, to, lo + (hi - lo) * (k / (steps - 1)), sr)
  return e / steps
}

// ---------------------------------------------------------------------------
console.log('fitBpm')
{
  // cuts on a perfect 128 BPM grid, phase 0.7s, every other beat
  const beat = 60 / 128
  const cuts = Array.from({ length: 20 }, (_, i) => 0.7 + i * beat * 2)
  const f = S.fitBpm(cuts)
  ok(Math.abs(f.bpm - 128) < 0.51 || Math.abs(f.bpm - 64) < 0.51 || Math.abs(f.bpm % (60 / (beat * 2) / 1)) < 1,
    `recovers a 128 BPM grid or a harmonic of it (got ${f.bpm})`)
  ok(f.err < 0.02, `grid error is tiny on clean input (${f.err.toFixed(4)}s)`)

  // jittered grid still lands close
  const jit = cuts.map(c => c + (Math.sin(c * 37.7) * 0.02))
  const fj = S.fitBpm(jit)
  ok(fj.err < 0.05, `jittered cuts still fit (err ${fj.err.toFixed(3)}s)`)

  ok(S.fitBpm([]).bpm === 120 && S.fitBpm([5]).bpm === 120, 'degenerate inputs fall back to 120')
}

// ---------------------------------------------------------------------------
console.log('planScore')
{
  const beat = 60 / 128
  const cuts = Array.from({ length: 24 }, (_, i) => 1 + i * beat * 2)
  const dur = cuts[cuts.length - 1] + 4
  const hits = [cuts[3], cuts[12], cuts[20]]
  const plan = S.planScore({ cuts, hits, duration: dur }, { seed: 5 })

  ok(plan.whooshes.length === cuts.length, `a whoosh per cut (${plan.whooshes.length}/${cuts.length})`)
  ok(plan.whooshes.every((w, i) => Math.abs(w.t - cuts[i]) < 1e-6), 'each whoosh is centred on its cut')
  ok(hits.every(h => plan.impacts.some(im => Math.abs(im.t - h) < 1e-6)), 'every hit gets an impact')
  ok(plan.duckTimes.length === plan.impacts.length, 'every impact ducks the bed')
  ok(plan.lateBeat > plan.grooveBeat, 'late section comes after the groove')
  ok(Math.abs(plan.droneAt - cuts[cuts.length - 1]) < 1e-6, 'drone starts at the final cut')

  // dense-bar detection: cram cuts into one bar
  const bar = beat * 4
  const fast = { cuts: [10, 10 + beat, 10 + 2 * beat, 10 + 3 * beat, 20], hits: [], duration: 25 }
  const p2 = S.planScore(fast, { bpm: 128, seed: 1 })
  ok(p2.denseBars.includes(Math.floor(10 / bar)), 'a bar full of cuts is marked dense')

  ok(S.planScore({ cuts: [], hits: [], duration: 10 }, {}).whooshes.length === 0, 'empty timeline plans without crashing')
}

// ---------------------------------------------------------------------------
console.log('buildDuck')
{
  const sr = 48000, n = sr * 4
  const duck = S.buildDuck([2.0], n, sr, 0.4)
  ok(Math.abs(duck[Math.round(2.03 * sr)] - 0.4) < 0.02, 'hold sits at the floor')
  ok(duck[Math.round(1.99 * sr)] === 1, 'unity before the hit')
  ok(duck[Math.round(2.9 * sr)] > 0.97, 'recovered ~0.9s after')
  // probe AFTER the second duck's 12ms attack completes; mid-attack the value
  // is legitimately above the floor
  const two = S.buildDuck([2.0, 2.1], n, sr, 0.4)
  ok(two[Math.round(2.13 * sr)] <= 0.42, 'overlapping ducks take the minimum')
}

// ---------------------------------------------------------------------------
console.log('renderScore, 24s piece')
{
  const beat = 60 / 128
  const cuts = Array.from({ length: 16 }, (_, i) => 1 + i * beat * 2)
  const dur = 24
  const hits = [cuts[2], cuts[8], cuts[14]]
  const { plan, stereo } = S.composeScore({ cuts, hits, duration: dur }, { seed: 9, bpm: 128 })
  const sr = stereo.sampleRate
  const mono = new Float32Array(stereo.left.length)
  for (let i = 0; i < mono.length; i++) mono[i] = (stereo.left[i] + stereo.right[i]) / 2

  ok(Math.abs(stereo.left.length / sr - (dur + 1.6)) < 0.05, 'length is the piece plus the tail')
  let peak = 0
  for (const v of mono) peak = Math.max(peak, Math.abs(v))
  ok(peak <= 0.75 && peak > 0.4, `master peak leaves headroom (${peak.toFixed(2)})`)

  // duck pocket: measured on the music-only render, because the impact and the
  // whoosh land exactly in the pocket and would fill any band we probe
  const bedOnly = S.renderScore(plan, sr, { fx: false })
  const bed = new Float32Array(bedOnly.left.length)
  for (let i = 0; i < bed.length; i++) bed[i] = (bedOnly.left[i] + bedOnly.right[i]) / 2
  const h = hits[1]
  const before = rms(bed, (h - 0.12) * sr, (h - 0.02) * sr)
  const held = rms(bed, (h + 0.015) * sr, (h + 0.06) * sr)
  ok(db(before) - db(held) > 3, `bed ducks >3 dB at a hit (before ${db(before).toFixed(1)}, during ${db(held).toFixed(1)} dB)`)

  // stereo whoosh: side energy at cuts, silence between
  const side = new Float32Array(mono.length)
  for (let i = 0; i < side.length; i++) side[i] = (stereo.left[i] - stereo.right[i]) / 2
  const cut = cuts[10]
  const sAt = rms(side, (cut - 0.1) * sr, (cut + 0.1) * sr)
  const sBetween = rms(side, (cut + 0.4) * sr, (cut + 0.55) * sr)
  ok(sAt > sBetween * 5, `whooshes carry the only stereo width (at cut ${db(sAt).toFixed(1)} dB, between ${db(sBetween).toFixed(1)} dB)`)

  // hats calm down after the late boundary
  const lateT = plan.lateBeat * plan.beat
  const grooveT = plan.grooveBeat * plan.beat + 2
  const hatsGroove = bandEnergy(mono, grooveT * sr, (grooveT + 1.5) * sr, 9000, 13500, sr)
  const hatsLate = bandEnergy(mono, (lateT + 0.6) * sr, (lateT + 2.1) * sr, 9000, 13500, sr)
  ok(hatsLate < hatsGroove * 0.7, `hats calm down late (groove ${db(hatsGroove).toFixed(1)}, late ${db(hatsLate).toFixed(1)} dB)`)

  // nothing meaningful above the master low-pass
  const top = bandEnergy(mono, 5 * sr, 15 * sr, 17000, 21000, sr)
  const mids = bandEnergy(mono, 5 * sr, 15 * sr, 1000, 6000, sr)
  ok(top < mids * 0.02, 'spectrum is clean above the 15.5k master low-pass')

  // groove actually plays: low band carries real energy mid-piece
  const lows = bandEnergy(mono, 10 * sr, 14 * sr, 40, 120, sr)
  ok(db(lows) > db(mids) - 20 && lows > 0, 'the bass is present in the groove')

  // tail is drone, not groove: kick band energy collapses after the last cut
  const kickGroove = bandEnergy(mono, 10 * sr, 12 * sr, 45, 90, sr)
  const kickTail = bandEnergy(mono, (plan.droneAt + 0.8) * sr, (plan.droneAt + 2.2) * sr, 45, 90, sr)
  ok(kickTail < kickGroove, 'the tail sits on the drone, not the groove')
}

// ---------------------------------------------------------------------------
console.log('determinism and variation')
{
  const input = { cuts: [1, 2, 3, 4.5, 6], hits: [2], duration: 9 }
  const a = S.composeScore(input, { seed: 3, bpm: 120 }).stereo
  const b = S.composeScore(input, { seed: 3, bpm: 120 }).stereo
  const c = S.composeScore(input, { seed: 4, bpm: 120 }).stereo
  let same = true, diff = false
  for (let i = 0; i < a.left.length; i += 997) {
    if (a.left[i] !== b.left[i]) same = false
    if (a.left[i] !== c.left[i]) diff = true
  }
  ok(same, 'same seed renders identical audio')
  ok(diff, 'a different seed renders a different take')

  const w = S.toWav(a)
  ok(w[0] === 0x52 && w[1] === 0x49 && w.length > a.left.length * 2, 'toWav produces a RIFF file of plausible size')
}

// ---------------------------------------------------------------------------
console.log('cinematic style')
{
  const sr = 24000
  const beat = 60 / 120
  const cuts = Array.from({ length: 16 }, (_, i) => 2 + i * beat * 2)
  const dur = cuts[cuts.length - 1] + 3
  const hits = [cuts[4], cuts[10]]
  const plan = S.planScore({ cuts, hits, duration: dur }, { seed: 3, style: 'cinematic', bpm: 120 })
  ok(plan.style === 'cinematic', 'plan carries the style')
  ok(plan.pockets.length === hits.length, `every hit gets a silence pocket (${plan.pockets.length}/${hits.length})`)

  const bed = S.renderScore(plan, sr, { fx: false })
  const elecPlan = S.planScore({ cuts, hits, duration: dur }, { seed: 3, style: 'electronic', bpm: 120 })
  const elec = S.renderScore(elecPlan, sr, { fx: false })

  // the pocket: the bed in the last 250ms before a hit is far quieter than the bar before it
  const h = hits[1]
  const inPocket = rms(bed.left, (h - 0.25) * sr, (h - 0.03) * sr)
  const before = rms(bed.left, (h - 2.2) * sr, (h - 0.6) * sr)
  ok(db(inPocket) < db(before) - 25, `bed vanishes before the drop (${db(inPocket).toFixed(1)} dB vs ${db(before).toFixed(1)} dB)`)

  // no hats: the cinematic bed has far less energy above 6 kHz than the electronic one
  const hiC = bandEnergy(bed.left, 6 * sr, 10 * sr, 6500, 10500, sr)
  const hiE = bandEnergy(elec.left, 6 * sr, 10 * sr, 6500, 10500, sr)
  ok(hiC < hiE * 0.35, `cinematic has no hat sizzle (hi-band ${(hiC / hiE * 100).toFixed(0)}% of electronic)`)

  // the ostinato lives in the cello register during the groove
  const gT = plan.grooveBeat * beat
  const cello = bandEnergy(bed.left, (gT + 1) * sr, (gT + 5) * sr, 85, 260, sr)
  const air = bandEnergy(bed.left, (gT + 1) * sr, (gT + 5) * sr, 4000, 6000, sr)
  ok(cello > air * 3, `cello register dominates the groove (${(cello / air).toFixed(1)}x the upper mids)`)

  let pk = 0
  for (let i = 0; i < bed.left.length; i++) pk = Math.max(pk, Math.abs(bed.left[i]))
  ok(pk <= 0.71 && pk > 0.4, `cinematic master peaks at ${pk.toFixed(2)}`)
}

console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✗ FAILURES'} - ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
