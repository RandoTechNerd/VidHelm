// Tests for the Fix voice chain (electron/audiochain.ts): synthetic signals made here at 48 kHz, no
// ffmpeg, so it is fast and runs everywhere. The real bake against the measured corpus is the opt-in
// scripts/audiochain.corpus.test.mjs. Run with: npm run test:audiochain
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'electron', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const A = await load('audiochain.ts')
let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }
const near = (a, b, e) => Math.abs(a - b) <= e
const SR = 48000

// ---- signals (deterministic) ----
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const gauss = (r) => () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
const rmsOf = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)) }
/** white noise at an RMS level (dBFS) */
const white = (n, dbfs, seed) => { const g = gauss(rng(seed)), k = 10 ** (dbfs / 20), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = g() * k; return x }
/** pink noise (Paul Kellet's filter) scaled to an RMS level */
const pink = (n, dbfs, seed) => {
  const g = gauss(rng(seed)), x = new Float32Array(n)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  for (let i = 0; i < n; i++) {
    const w = g()
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898
    x[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926
  }
  const k = 10 ** (dbfs / 20) / rmsOf(x)
  for (let i = 0; i < n; i++) x[i] *= k
  return x
}
/**
 * "Speech": pink bursts at `burstDb` (RMS while on), `on` s on / `off` s off, over white room tone at
 * `roomDb`. Bursts start on 10 ms block boundaries so VAD edges can be checked to the block.
 */
const bursts = ({ seconds, on = 0.6, off = 1.0, burstDb = -30, roomDb = -70, seed = 1, first = 0.5 }) => {
  const n = Math.round(seconds * SR), x = white(n, roomDb, seed + 100), p = pink(n, burstDb, seed)
  const edges = []
  for (let t = first; t + on <= seconds - 0.05; t += on + off) {
    const a = Math.round(t * 100), b = Math.round((t + on) * 100)
    edges.push([a, b])
    for (let i = a * 480; i < b * 480; i++) x[i] += p[i]
  }
  return { x, edges }
}
const scale = (x, db) => Float32Array.from(x, (v) => v * 10 ** (db / 20))
const concat = (...xs) => { const o = new Float32Array(xs.reduce((a, x) => a + x.length, 0)); let k = 0; for (const x of xs) { o.set(x, k); k += x.length } return o }
const interleave = (L, R = L) => { const o = new Float32Array(L.length * 2); for (let i = 0; i < L.length; i++) { o[2 * i] = L[i]; o[2 * i + 1] = R[i] } return o }

console.log('1. analyzer vs the BS.1770 reference, and streaming = one shot')
{
  const n = SR * 5, sine = new Float32Array(n)
  for (let i = 0; i < n; i++) sine[i] = Math.sin(2 * Math.PI * 1000 * i / SR)
  const st = A.analyzeSamples(sine, sine)
  ok(near(st.speechDb, -3.01, 0.02), `full-scale 1 kHz sine reads -3.01 dBFS (${st.speechDb.toFixed(3)})`)
  // BS.1770 sums channel powers: the same sine on both channels is dual-mono, +3.01 over one channel
  ok(near(st.I, 0, 0.1), `on both channels it is 0.0 LUFS, dual-mono (${st.I.toFixed(3)})`)
  const one = A.analyzeSamples(sine, new Float32Array(n))
  ok(near(one.I, -3.01, 0.1), `in one channel it is -3.01 LUFS: K-weighting is 0 dB at 1 kHz (${one.I.toFixed(3)})`)
  const [k48] = A.kWeighting(48000), [kf] = A.kWeighting(48000.000001)
  ok(k48.every((c, i) => near(c, kf[i], 1e-6)), 'the generic K-weighting design equals the published 48 kHz table')

  const { x } = bursts({ seconds: 12, seed: 7 })
  const R = white(x.length, -50, 9)
  const whole = A.analyzeSamples(x, R)
  const an = A.createAnalyzer()
  const il = interleave(x, R)
  for (let i = 0; i < il.length; i += 8192) an.push(il.subarray(i, Math.min(il.length, i + 8192)))   // 4096-sample chunks
  const chunked = an.finish()
  let d = 0
  for (const k of ['kP', 'uP', 'pk']) for (let b = 0; b < whole.nb; b++) d = Math.max(d, Math.abs(whole[k][b] - chunked[k][b]))
  ok(d <= 1e-9 && whole.nb === chunked.nb, `4096-sample chunks give the same kP/uP/pk as one shot (max diff ${d})`)
  ok(whole.channel.foldLossDb === chunked.channel.foldLossDb && whole.I === chunked.I, 'and the same loudness and channel test')
}

console.log('2. floor, speech level and the VAD')
{
  // 0.6 s on / 0.5 s off: more than half the time is speech, so the loudest half is all burst
  const a = A.analyzeSamples(bursts({ seconds: 30, on: 0.6, off: 0.5, seed: 2 }).x)
  ok(near(a.floorDb, -70, 1), `room floor within 1 dB of -70 (${a.floorDb.toFixed(2)})`)
  ok(near(a.speechDb, -30, 1.5), `speech level within 1.5 dB of -30 (${a.speechDb.toFixed(2)})`)
  // the VAD closes 0.5 s gaps by design (50 ms pre-roll + 150 ms hangover + the centred 100 ms window
  // leave under 300 ms, and a breath between words is not a pause), so its shape is checked on 1.0 s gaps
  const { x, edges } = bursts({ seconds: 30, on: 0.6, off: 1.0, seed: 3 })
  const v = A.analyzeSamples(x)
  const rs = A.runs(v.act, 1)
  ok(rs.length === edges.length, `every burst is its own speech run (${rs.length} runs, ${edges.length} bursts)`)
  // the centred 100 ms window reaches 4 blocks ahead and 5 behind; then 5 blocks of pre-roll, 15 of hangover
  const shaped = edges.every(([o, e], i) => rs[i] && Math.abs(rs[i][0] - (o - 4 - 5)) <= 1 && Math.abs(rs[i][1] - Math.min(v.nb, e + 5 + 15)) <= 1)
  ok(shaped, `pre-roll 50 ms and hangover 150 ms past the detection, within one block (first run ${rs[0]}, burst ${edges[0]})`)
  let inGap = 0
  for (let i = 0; i + 1 < edges.length; i++) for (let b = edges[i][1] + 21; b < edges[i + 1][0] - 10; b++) inGap += v.act[b]
  ok(inGap === 0, 'no speech detected inside the gaps')
  const frac = v.activeS / v.durS
  ok(near(frac, 0.5, 0.08), `active fraction ${frac.toFixed(3)} (0.6 s of speech per 1.6 s, plus the padding)`)
  ok(near(v.activeS, A.analysisSummary(v).activeS, 0.05), 'summary reports the same speech seconds')
}

console.log('3. guards')
{
  const room = A.analyzeSamples(white(SR * 30, -70, 4))
  const d = A.decide(room, 'studio')
  ok(!!d.skipped && d.effective === 'off', `30 s of room tone only is left as is (${d.skipped})`)
  ok(A.summaryLine(d) === 'No clear speech, left as is', 'and says so')
  // 12 s with 1.9 s of speech: two short phrases
  const n = SR * 12, x = white(n, -70, 5), p = pink(n, -28, 6)
  for (const [a, b] of [[2, 2.95], [7, 7.95]]) for (let i = a * SR; i < b * SR; i++) x[i] += p[i]
  const sp = A.decide(A.analyzeSamples(x), 'studio')
  ok(!sp.skipped && sp.sparse && sp.effective === 'light', 'a few words in 12 s runs the Light rules')
  ok(sp.nrDb === 0 && !sp.riderOn && sp.gapEases.length === 0, 'no noise reduction, no rider, no room ease when sparse')
  const full = A.decide(A.analyzeSamples(bursts({ seconds: 54, on: 5.75, off: 0.8, seed: 8 }).x), 'studio')
  ok(!full.skipped && !full.sparse && full.effective === 'studio', '54 s with about 46 s of speech is neither')
}

console.log('4. static gain')
{
  const { x } = bursts({ seconds: 30, burstDb: -20, roomDb: -60, seed: 10 })
  const s0 = A.decide(A.analyzeSamples(x), 'light').staticDb
  const s20 = A.decide(A.analyzeSamples(scale(x, -20)), 'light').staticDb
  ok(near(s20 - s0, 20, 0.2), `20 dB quieter gets 20 dB more lift (${s0} -> ${s20})`)
  const capped = A.decide(A.analyzeSamples(scale(x, -40)), 'light')
  ok(capped.staticDb === 30 && capped.staticCapped, `the lift stops at +30 dB (${capped.staticDb})`)
  const loud = A.decide(A.analyzeSamples(scale(x, 8)), 'light')
  ok(loud.staticDb < 0, `an already loud recording is turned down (${loud.staticDb})`)
}

console.log('5. noise reduction decision')
{
  const q = A.nrDecision({ floorDb: -64.8, I: -34.0, boost0: 0, worstSnr: 30 })
  ok(q.nrDb === 16 && q.nf === -59, `quiet over room tone: nr 16 at nf -59 (${q.nrDb}, ${q.nf})`)
  ok(A.nrDecision({ floorDb: -82.5, I: -36, worstSnr: 40 }).nrDb === 0, 'a clean quiet take needs none')
  ok(A.nrDecision({ floorDb: -51.5, I: -18.7, worstSnr: 20 }).nrDb === 8, 'the phone is capped by its worst local SNR: 8')
  ok(A.nrDecision({ floorDb: -110, I: -30, worstSnr: 60 }).nf === -80 && A.nrDecision({ floorDb: -10, I: -5, worstSnr: 60 }).nf === -20, 'nf clamps to [-80, -20]')
}

console.log('6. channel decision')
{
  const { x } = bursts({ seconds: 20, seed: 11, roomDb: -90 })
  const same = A.analyzeSamples(x, x)
  ok(same.channel.identical && A.decideChannel(same.channel) === 'asis', 'identical channels stay as they are')
  const L = Float32Array.from(x), R = Float32Array.from(x), nl = white(x.length, -62, 12), nr = white(x.length, -62, 13)
  for (let i = 0; i < x.length; i++) { L[i] += nl[i]; R[i] += nr[i] }
  const two = A.analyzeSamples(L, R)
  ok(A.decideChannel(two.channel) === 'fold' && two.channel.foldLossDb > -1, `same voice, separate room noise: fold (loss ${two.channel.foldLossDb.toFixed(2)} dB)`)
  // R = L 0.4 ms later (two mics, a comb filter when summed), and noisier
  const D = 19, Rd = new Float32Array(x.length), nl2 = white(x.length, -75, 14), nr2 = white(x.length, -58, 15)
  for (let i = 0; i < x.length; i++) Rd[i] = (i >= D ? x[i - D] : 0) + nr2[i]
  const Lc = Float32Array.from(x, (v, i) => v + nl2[i])
  const comb = A.analyzeSamples(Lc, Rd)
  ok(comb.channel.foldLossDb < -1 && A.decideChannel(comb.channel) === 'left', `delayed copy: no fold (loss ${comb.channel.foldLossDb.toFixed(2)} dB), keeps the cleaner left`)
  const vR = A.viewAnalysis(comb, 'right'), vL = A.viewAnalysis(comb, 'left')
  ok(vL.snr > vR.snr && near(vL.speechDb, A.analyzeSamples(Lc, Lc).speechDb, 1e-9), 'the left view is exactly the left channel, dual-mono')
}

console.log('7. sections and the rider')
{
  // two halves 14 dB apart (the loud one a little longer, so it is the median level); speech with
  // short gaps (one long run each), room tone constant
  const loudH = bursts({ seconds: 21, on: 0.6, off: 0.4, burstDb: -20, roomDb: -70, seed: 20, first: 0 }).x
  const quietH = bursts({ seconds: 19, on: 0.6, off: 0.4, burstDb: -34, roomDb: -70, seed: 21, first: 0 }).x
  const an = A.analyzeSamples(concat(loudH, quietH))
  const sec = A.levelSections(an)
  const corr = sec.sections.map((s) => +s.corr.toFixed(1))
  ok(sec.sections.length === 2, `one split (${corr})`)
  ok(near(sec.sections[1].corr, 14, 1) && sec.sections[0].corr === 0, 'quiet half +14 dB, loud half (the reference) untouched')
  const g = A.riderDb(an, sec.ref)
  const sp = [], moves = []
  for (let b = 0; b < an.nb; b++) if (an.act[b]) sp.push(g[b])
  for (let b = 0; b + 10 < an.nb; b++) if (an.act[b] && an.act[b + 10]) moves.push(Math.abs(g[b + 10] - g[b]))
  sp.sort((a, b) => a - b); moves.sort((a, b) => a - b)
  const range = sp[Math.floor(sp.length * 0.95)] - sp[Math.floor(sp.length * 0.05)]
  ok(near(range, 14, 2), `rider P95 - P05 over speech ${range.toFixed(2)} dB`)
  // The measured rider does move faster than 0.9 dB per 100 ms at the change itself (the reference
  // reaches 3.2 on the leaning-away file): what holds is that speech is ridden smoothly, and nothing jumps.
  const p95 = moves[Math.floor(moves.length * 0.95)], maxStep = moves[moves.length - 1]
  ok(p95 <= 0.9, `during speech the rider moves under 0.9 dB per 100 ms at P95 (${p95.toFixed(2)})`)
  ok(maxStep <= 2, `and never jumps: at most ${maxStep.toFixed(2)} dB per 100 ms`)
  // pauses: quiet speech with real gaps; a pause is never lifted above the words around it
  const pq = A.analyzeSamples(concat(loudH, bursts({ seconds: 20, on: 0.6, off: 1.0, burstDb: -34, roomDb: -70, seed: 22, first: 0.3 }).x))
  const pg = A.riderDb(pq, A.levelSections(pq).ref)
  let worst = -Infinity
  for (const [s, e] of A.runs(pq.act, 0)) {
    if (s === 0 || e === pq.nb) continue
    let m = -Infinity
    for (let b = s; b < e; b++) m = Math.max(m, pg[b])
    worst = Math.max(worst, m - Math.max(pg[s - 1], pg[e]))
  }
  ok(worst <= 0.05, `no pause gets more gain than the speech beside it (worst excess ${worst.toFixed(3)} dB)`)
  const held = A.holdPauses(Float64Array.from([2, 2, 9, 9, 5, 5]), [1, 1, 0, 0, 1, 1])
  ok(held[2] === 2 && held[3] === 2 && held[4] === 5, 'holdPauses takes the lower neighbour')
}

console.log('8. transient dips')
{
  const { x } = bursts({ seconds: 30, burstDb: -26, roomDb: -70, seed: 30 })
  const at = [1.0, 2.75, 4.9, 6.2, 9.35, 12.05, 15.1]   // in words and in pauses
  const blocks = at.map((t) => Math.round(t * 100))
  for (const b of blocks) x[b * 480 + 200] = 10 ** (-0.3 / 20)
  const an = A.analyzeSamples(x)
  const tr = A.transientDipDb(an)
  ok(tr.events.length === 7, `exactly 7 knocks found (${tr.events.length})`)
  const ref = tr.speechPeakP99Db + 1
  ok(tr.events.every((e) => near(e.depthDb, -0.3 - ref, 1)), `each dipped by peak - (P99 + 1) = ${(-0.3 - ref).toFixed(1)} dB (${tr.events.map((e) => e.depthDb)})`)
  const d = tr.d, b = blocks[2], depth = tr.events[2].depthDb
  ok(d[b - 2] === 0 && near(d[b - 1], -depth, 0.1) && near(d[b + 2], -depth, 0.1), 'full depth from 10 ms before the knock')
  ok(d[b + 3] < 0 && d[b + 4] < 0 && d[b + 3] < d[b + 4] && d[b + 5] === 0, 'then a 30 ms raised-cosine release back to 0')
  const clean = A.transientDipDb(A.analyzeSamples(bursts({ seconds: 20, burstDb: -26, seed: 31 }).x))
  ok(clean.events.length === 0, 'speech alone has no knocks')
}

console.log('9. room ease in pauses')
{
  ok(A.gapEaseDepth(-90, 0) === 0 && A.gapEaseDepth(-40, 20) === 3, 'depth clamps to [0, 3]')
  ok(near(A.gapEaseDepth(-61, 0), 1.5, 1e-9), 'depth = pause level + gain + 2.5 - (-60)')
  const act = new Uint8Array(300)
  act.fill(1, 0, 100); act.fill(1, 200, 300)
  const { d, eases } = A.gapEaseDb({ nb: 300, act }, 3)
  ok(eases.length === 1 && eases[0].depthDb === 3, 'a 1 s pause is eased 3 dB')
  ok(d[100] === 0 && d[109] === 0 && d[110] === 0 && d[111] < 0, 'held 100 ms after the last word')
  ok(d[129] > -3 && d[130] === -3 && d[192] === -3, 'falls over 200 ms')
  ok(d[196] < 0 && d[197] === 0 && d[199] === 0, 'back up 30 ms before the next word')
  const short = new Uint8Array(300)
  short.fill(1, 0, 140); short.fill(1, 160, 300)
  ok(A.gapEaseDb({ nb: 300, act: short }, 3).eases.length === 0, 'a 0.2 s pause gets none')
}

console.log('10. envelope and the gain WAV')
{
  const dbs = [0, 6, -6, 0]
  const g = A.envelopeFromBlocks(dbs, 4 * 480)
  ok(dbs.every((v, b) => near(20 * Math.log10(g[b * 480 + 240]), v, 1e-4)), 'at a block centre the gain is the block dB')
  ok(near(20 * Math.log10(g[480 + 480]), 0, 1e-4) && near(20 * Math.log10(g[480 + 360]), 3, 1e-4), 'linear in dB between centres')
  const chunks = []
  await A.writeGainWav((c) => { chunks.push(Uint8Array.from(c)) }, dbs, 1920, { chunkFrames: 700 })
  const all = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0))
  let k = 0
  for (const c of chunks) { all.set(c, k); k += c.length }
  const dv = new DataView(all.buffer), tag = (o) => String.fromCharCode(...all.subarray(o, o + 4))
  ok(tag(0) === 'RIFF' && tag(8) === 'WAVE' && tag(12) === 'fmt ' && tag(36) === 'data', 'RIFF/WAVE/fmt/data')
  ok(dv.getUint16(20, true) === 3 && dv.getUint16(22, true) === 2 && dv.getUint32(24, true) === 48000 && dv.getUint16(34, true) === 32, 'IEEE float, 2 ch, 48000 Hz, 32-bit')
  ok(dv.getUint32(40, true) === 1920 * 8 && all.length === 44 + 1920 * 8 && dv.getUint32(4, true) === 36 + 1920 * 8, 'length is exactly n frames')
  const f = new Float32Array(all.buffer.slice(44))
  ok(near(f[2 * 1000], g[1000], 1e-6) && f[2 * 1000] === f[2 * 1000 + 1], 'samples are the envelope, same in both channels')
}

console.log('11. graph strings')
{
  ok(A.compressorFilter() === 'acompressor=threshold=-16dB:ratio=2:attack=80:release=1000:knee=4:detection=rms:link=average:makeup=1', 'compressor: 2:1 at the working level, makeup 1')
  const lim = A.limiterFilter(-3.3)
  ok(lim.includes('limit=0.68391') && lim.includes('latency=1') && lim.includes('aresample=192000') && lim.includes('level=disabled'), 'voice ceiling -3.3 dBFS, 4x oversampled, latency compensated')
  const m = A.masterGraph(2.0)
  ok(m.includes('lowpass=f=20000:p=2:t=q:w=0.5412') && m.includes('lowpass=f=20000:p=2:t=q:w=1.3066') && m.includes('limit=0.84140') && m.startsWith('volume=2.00dB'), 'master: linear gain, 20 kHz Butterworth, -1.5 dBTP')
  const print = { s: 3.21, e: 5.01 }, len = 1.8
  const nr = A.nrGraph({ print, nrDb: 16, nf: -59 })
  ok(nr.includes(`start_sample=${Math.round(len * 48000) + 1200}`) && nr.includes('apad=pad_len=1200'), 'NR trims the print and afftdn latency together')
  ok(nr.includes('gs=16') && nr.includes('tn=0') && nr.includes('nf=-59') && !nr.includes('nf=-25'), 'NR: gs 16, tn 0, nf from the floor, never -25')
  ok(nr.includes("asendcmd=c='0.02 afftdn sn start;1.780 afftdn sn stop'") && nr.includes('atrim=3.210:5.010'), 'NR learns from the print only')
  ok(A.AFFTDN_LATENCY(44100) === 1103 && A.AFFTDN_LATENCY(48000) === 1200, 'afftdn latency = round(0.025 * sr)')
  const pa = A.passAGraph({ channel: 'right', nrDb: 0, nf: 0, print: null })
  ok(pa === `[0:a]aresample=48000,aformat=sample_fmts=flt:channel_layouts=stereo,asetpts=PTS-STARTPTS,pan=stereo|c0=c1|c1=c1,${A.HPF}[o]`, 'pass A without NR: head, channel, high-pass')
  ok(A.passAGraph({ channel: 'asis', nrDb: 12, nf: -64, print }).includes('afftdn=nr=12:nf=-64') && !A.passAGraph({ channel: 'asis', nrDb: 0, nf: 0, print: null }).includes('pan='), 'NR only when planned; no pan when as is')
  ok(A.passDGraph(2.5).includes('volume=2.50dB') && A.passDGraph(2.5).includes('ebur128=peak=true'), 'pass D: make-up, ceiling, measured copy')
}

console.log('12. ducking')
{
  // segments whose trapezoids are the design's 2.33-14.50 and 15.47-22.04 (a 1.7 s pause: two ducks)
  const traps = A.duckTraps([[2.61, 14.05], [15.75, 21.59]])
  ok(traps.length === 2, 'a 1.7 s pause stays two trapezoids')
  ok(near(traps[0].a0, 2.33, 1e-9) && near(traps[0].a1, 2.53, 1e-9) && near(traps[0].b0, 14.2, 1e-9) && near(traps[0].b1, 14.5, 1e-9) && near(traps[1].a0, 15.47, 1e-9) && near(traps[1].b1, 22.04, 1e-9), 'a0 = s - 0.28, a1 = s - 0.08, b0 = e + 0.15, b1 = e + 0.45')
  ok(A.duckTraps([[0, 5], [6, 10]]).length === 1, 'a 1.0 s pause merges')
  const expr = A.trapezoidExpr(traps)
  ok(expr.startsWith('pow(10,(0.00-10.00*clip((t-2.330)/0.200,0,1)*clip((14.500-t)/0.300,0,1)-10.00*'), 'expression in the design form')
  const fn = new Function('t', 'clip', 'pow', `return ${expr}`)
  const clip = (x, a, b) => Math.min(b, Math.max(a, x)), dB = (t) => 20 * Math.log10(fn(t, clip, Math.pow))
  ok(traps.every((p) => near(dB(p.a1), -10, 0.005) && near(dB(p.b0), -10, 0.005) && near(dB((p.a1 + p.b0) / 2), -10, 0.005)), 'fully ducked from a1 to b0: -10.00 dB')
  ok(traps.every((p) => near(dB(p.a0), 0, 0.005) && near(dB(p.b1), 0, 0.005)), '0 dB at a0 and b1')
  ok(traps.every((p) => near(dB((p.a0 + p.a1) / 2), -5, 0.01) && near(dB((p.b0 + p.b1) / 2), -5, 0.01)), 'ramp midpoints at -5 dB (dB-linear)')
  let maxErr = 0
  for (let t = 0; t < 25; t += 0.001) maxErr = Math.max(maxErr, Math.abs(dB(t) - A.evalTrapezoidsDb(traps, t)))
  ok(maxErr < 1e-6, 'the JS evaluator matches the ffmpeg expression')
  ok(A.trapezoidExpr([{ a0: -0.18, a1: 0.02, b0: 1, b1: 1.3, depthDb: 6 }]).includes('(t+0.180)'), 'a duck starting before 0 is written t+x, not t--x')
  const mapped = A.mapSegmentsToTimeline([[1, 3], [4, 6], [8, 9]], { start: 10, duration: 5, sourceStart: 2 })
  ok(JSON.stringify(mapped) === JSON.stringify([[10, 11], [12, 14]]), `source time shifted and clipped to the clip (${JSON.stringify(mapped)})`)
  ok(JSON.stringify(A.unionSegments([[[0, 2], [5, 6]], [[1, 3], [6, 7]]])) === JSON.stringify([[0, 3], [5, 7]]), 'overlaps across clips become one')
  const mb = A.musicBusGraph({ inputs: ['m0', 'm1'], bedDb: 1, traps })
  ok(mb.includes('amix=inputs=2:normalize=0') && mb.includes('volume=1.00dB,asetnsamples=n=48:p=0,volume=\'pow(10,') && mb.endsWith('alimiter=limit=0.5012:attack=1:release=80:level=disabled:latency=1[mbus]'), 'music bus: bed level, 1 ms steps, the duck, a -6 dBFS limiter')
  ok(!A.musicBusGraph({ inputs: ['m0'], bedDb: 1, traps, duck: false }).includes('pow(') && A.sfxBusGraph({ inputs: ['s0'], gainDb: -7.4, traps }).includes('limit=0.6761'), 'duck toggle off drops the expression; SFX bus ceiling -3.4 dBFS')
  ok(A.bedDb(-22) === 1 && A.sfxDb(-8.6) === -7.4, 'bed 5 LU under the voice; an SFX peak lands at the voice level')
}

console.log('13. compressor port')
{
  const comp = A.makeCompressor({ thrDb: -16, ratio: 2 })
  const n = SR, a = 10 ** (-10 / 20)
  const L = new Float32Array(n), R = new Float32Array(n)
  for (let i = 0; i < n; i++) L[i] = R[i] = (Math.floor(i / 24) % 2 ? -a : a)   // a -10 dBFS RMS square: a steady detector
  const inL = Float32Array.from(L)
  comp([L, R])
  const outDb = (i) => 20 * Math.log10(Math.abs(L[i]))
  ok(near(outDb(n - 1), -13, 0.05), `-10 dBFS settles at -13 dBFS, 2:1 over -16 (${outDb(n - 1).toFixed(3)})`)
  // from silence: the detector's tau is attack/4 = 20 ms; four of them is 98 percent of the step
  const gr = (i) => -10 - outDb(i), final = gr(n - 1)
  ok(gr(Math.round(0.080 * SR)) >= 0.95 * final && gr(Math.round(0.020 * SR)) < 0.8 * final, `95 percent of the gain reduction by 80 ms (${(gr(0.08 * SR) / final * 100).toFixed(1)} percent), not at 20 ms (${(gr(0.02 * SR) / final * 100).toFixed(1)})`)
  ok(L.every((v, i) => Math.sign(v) === Math.sign(inL[i])), 'gain only, never a polarity flip')
  const quiet = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 7) * 0.03), q2 = Float32Array.from(quiet)
  A.makeCompressor({ thrDb: -16 })([q2, Float32Array.from(quiet)])
  ok(q2.every((v, i) => v === quiet[i]), 'under the threshold the signal passes bit-exact')
}

console.log('14. role guess')
{
  const cont = A.analyzeSamples(pink(SR * 30, -20, 40))
  ok(A.roleGuess(cont, { provenance: 'booth' }).role === 'voice' && A.roleGuess(cont, { provenance: 'score' }).role === 'music' && A.roleGuess(cont, { provenance: 'sfx' }).role === 'sfx', 'where it came from beats the measurement')
  ok(A.roleGuess(cont, { isVideo: false, track: 'a1' }).role === 'music', 'continuous with no pause on a1: music')
  ok(A.roleGuess(cont, { isVideo: true }).role === 'asis', 'continuous under a picture: as is (premixed must not get the voice chain)')
  const speech = A.analyzeSamples(bursts({ seconds: 30, seed: 41 }).x)
  ok(A.roleGuess(speech, {}).role === 'voice' && A.roleGuess(speech, { isVideo: true }).role === 'voice', `the burst signal is a voice (${A.roleGuess(speech).why})`)
  ok(A.roleGuess(null, { isVideo: true }).role === 'asis', 'unmeasured video: as is')
}

console.log('15. platform targets')
{
  ok(A.platformTarget('youtube').lufs === -14 && A.platformTarget('podcast').lufs === -16 && A.platformTarget('broadcast').lufs === -23 && A.platformTarget('audiobook').lufs === -20, 'youtube -14, podcast -16, broadcast -23, audiobook -20')
  ok(A.platformTarget('nonsense').lufs === -14 && A.platformTarget(undefined).id === 'youtube' && A.platformTarget('Spotify').id === 'podcast', 'unknown -> -14; aliases resolve')
}

console.log('decide end to end, and the words under a clip')
{
  const { x } = bursts({ seconds: 40, burstDb: -36, roomDb: -58, seed: 50 })
  const d = A.decide(A.analyzeSamples(x), 'studio')
  ok(d.effective === 'studio' && d.nrDb > 0 && d.print && d.print.e - d.print.s <= 2 && d.staticDb > 15, `quiet over a loud room: NR ${d.nrDb} dB at nf ${d.nf}, lift ${d.staticDb} dB`)
  ok(d.envelopeDb.length === Math.floor(x.length / 480) && d.gapEases.every((g) => g.depthDb <= 3), 'one envelope value per block, eases at most 3 dB')
  ok(/^Lifted \d+ dB, cleaned \d+ dB of room noise/.test(A.summaryLine(d)), `"${A.summaryLine(d)}"`)
  const j = A.decisionsJson(d)
  ok(!('envelopeDb' in j) && j.envelope.blocks === d.envelopeDb.length && JSON.parse(JSON.stringify(j)).channel === 'asis', 'JSON form drops the per-block envelope')
  const light = A.decide(A.analyzeSamples(x), 'light')
  ok(light.nrDb === 0 && light.effective === 'light' && light.gapEases.length === 0, 'Light: right level only')
  ok(A.decide(A.analyzeSamples(x), 'off').effective === 'off', 'Off plans nothing')
  ok(A.summaryLine({ effective: 'studio', skipped: null, sparse: false, riderOn: true, sections: [0, 14.1, 18, 16.3, -0.4, 10.9, 12.1, 14.1], staticDb: 0.4, nrDb: 0, transients: [] }) === 'Levelled 6 sections, up to +18 dB', 'levelled sections read as such')
  const segs = A.speechSegments({ act: Uint8Array.from([0, ...new Array(40).fill(1), 0, 0]), nb: 43 })
  ok(JSON.stringify(segs) === JSON.stringify([[0.06, 0.26]]), `speech segments drop the VAD padding (${JSON.stringify(segs)})`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
