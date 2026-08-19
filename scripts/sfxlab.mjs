// Bench for tuning the synth: renders recipes, prints measurements, writes WAVs to listen to.
// node scripts/sfxlab.mjs [outDir]
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = process.argv[2] || path.join(os.tmpdir(), 'vidhelm_sfxlab')
fs.mkdirSync(OUT, { recursive: true })
const load = async (f) => {
  const o = await build({ entryPoints: [path.join(here, '..', 'electron', f)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(o.outputFiles[0].text).toString('base64'))
}
const S = await load('sfxsynth.ts')
const R = await load('sfxrecipes.ts')

const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)) }
const peak = (x) => { let m = 0; for (const v of x) m = Math.max(m, Math.abs(v)); return m }
const centroid = (x, sr, start, n = 2048) => {
  let num = 0, den = 0
  for (let f = 120; f < sr / 2; f *= 1.18) {
    const w = 2 * Math.PI * f / sr, coeff = 2 * Math.cos(w)
    let s1 = 0, s2 = 0
    for (let i = 0; i < n; i++) { const s0 = (x[start + i] ?? 0) + coeff * s1 - s2; s2 = s1; s1 = s0 }
    const mag = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2))
    num += f * mag; den += mag
  }
  return den > 0 ? num / den : 0
}
const onsets = (x, sr, { hop = 64, win = 128, ratio = 1.6, floor = 0.003 } = {}) => {
  const env = []
  for (let i = 0; i + win < x.length; i += hop) env.push(rms(x, i, i + win))
  let count = 0
  for (let i = 2; i < env.length - 1; i++) if (env[i] > floor && env[i] > env[i - 1] * ratio && env[i] >= env[i + 1]) count++
  return count
}
const pitchAC = (x, sr, from, len, lo = 40, hi = 400) => {
  const seg = S.filt(x.slice(from, from + len), 'lp', 700, 0.7, sr)
  const minLag = Math.floor(sr / hi), maxLag = Math.floor(sr / lo)
  let best = -Infinity, bestLag = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0, e1 = 0, e2 = 0
    for (let i = 0; i + lag < seg.length; i++) { s += seg[i] * seg[i + lag]; e1 += seg[i] * seg[i]; e2 += seg[i + lag] * seg[i + lag] }
    const norm = s / Math.sqrt(Math.max(1e-9, e1 * e2))
    if (norm > best) { best = norm; bestLag = lag }
  }
  return { hz: bestLag ? sr / bestLag : 0, confidence: best }
}

const sr = 48000
console.log(`writing to ${OUT}\n`)

for (const [name, r] of Object.entries(R.REALISTIC_RECIPES)) {
  const s = r.render({ sampleRate: sr, seed: 3 })
  fs.writeFileSync(path.join(OUT, `${name}.wav`), Buffer.from(S.toWav(s)))
  const d = s.left.length / sr
  console.log(`${name.padEnd(24)} ${d.toFixed(2)}s  peak ${peak(s.left).toFixed(2)}  onsets ${String(onsets(s.left, sr)).padStart(4)}  rms ${rms(s.left).toFixed(3)}`)
}

console.log('\n-- coffee beans, in thirds --')
{
  const s = R.coffeeBeans({ sampleRate: sr, seed: 3 })
  for (const t of [0.2, 0.6, 1.0, 1.5, 2.0, 2.4]) {
    const i = Math.round(t * sr)
    console.log(`  t=${t.toFixed(1)}s  rms ${rms(s.left, i, i + 4096).toFixed(4)}  centroid ${centroid(s.left, sr, i).toFixed(0)}Hz  onsets/s ${(onsets(s.left.slice(i, i + sr / 4), sr) * 4)}`)
  }
}

console.log('\n-- door, in slices --')
{
  const s = R.electronicDoor({ sampleRate: sr, seed: 3 })
  for (const t of [0.0, 0.05, 0.15, 0.3, 0.5, 0.6, 0.7, 0.8, 0.95]) {
    const i = Math.round(t * sr)
    console.log(`  t=${t.toFixed(2)}s  rms ${rms(s.left, i, Math.min(s.left.length, i + 2400)).toFixed(4)}  centroid ${centroid(s.left, sr, i).toFixed(0)}Hz`)
  }
}

console.log('\n-- passBy on a pure tone (isolating the Doppler) --')
{
  const dur = 3, n = Math.round(dur * sr)
  const tone = S.osc(n, sr, () => 200, 'sine')
  for (const speed of [25, 60, 95, 120]) {
    const f = S.passBy(tone, sr, { speed, closest: 9, at: 0.5 })
    const a = pitchAC(f.left, sr, Math.round(0.5 * sr), 16384, 100, 400)
    const b = pitchAC(f.left, sr, Math.round(2.4 * sr), 16384, 100, 400)
    const theoryA = 200 * 343 / (343 - speed), theoryB = 200 * 343 / (343 + speed)
    console.log(`  speed ${String(speed).padStart(3)}m/s  approach ${a.hz.toFixed(0)}Hz (theory ${theoryA.toFixed(0)})  recede ${b.hz.toFixed(0)}Hz (theory ${theoryB.toFixed(0)})  conf ${a.confidence.toFixed(2)}/${b.confidence.toFixed(2)}`)
  }
}

console.log('\n-- podracer pass, engine pitch --')
{
  const s = R.podracerPassBy({ sampleRate: sr, seed: 12, speed: 95, closest: 9 })
  for (const t of [0.5, 0.9, 1.3, 1.7, 2.1, 2.5, 2.9]) {
    const p = pitchAC(s.left, sr, Math.round(t * sr), 16384, 40, 400)
    console.log(`  t=${t.toFixed(1)}s  pitch ${p.hz.toFixed(0)}Hz  conf ${p.confidence.toFixed(2)}  rms ${rms(s.left, Math.round(t * sr), Math.round(t * sr) + 4096).toFixed(4)}`)
  }
}
