#!/usr/bin/env node
// audiomeasure.mjs - the ONE shared audio meter of the quiet-audio study (there: measure.mjs), kept
// here unchanged apart from where it finds ffmpeg, so the Fix voice numbers in the corpus test
// (scripts/audiochain.corpus.test.mjs) stay comparable with the ones the chain was chosen on.
// No npm installs; ffmpeg decodes.
//
// Usage
//   node scripts/audiomeasure.mjs <file>                        all single-file metrics
//   node scripts/audiomeasure.mjs <processed> --ref <original>  + vsRef block (lag, floor rise, SNR change, gain track, band deltas)
//   node scripts/audiomeasure.mjs <mix> --voice <voiceStem> --music <musicStemAsMixed>
//                                                              + balance block (voice-minus-music, music in gaps)
//   options: --compact (one-line JSON), --out <file.json> (also write it), --help
//   env FFMPEG overrides the ffmpeg path (default: this repo's ffmpeg-static).
//
// Conventions (full metric definitions: node measure.mjs --help):
//   * Analysis at 48 kHz float (ffmpeg resamples if needed); >2 channels are downmixed to stereo.
//   * dBFS = 20*log10(RMS), RMS over all channels (mean power across channels). A full-scale sine
//     reads -3.01 dBFS. Digital silence is clamped to -140 dBFS so JSON never holds -Infinity.
//   * LUFS follow ITU-R BS.1770 K-weighting; a MONO file is treated as dual-mono (+3.01 dB), i.e. how it
//     sounds on two speakers (ffmpeg ebur128 dualmono=true does the same).
//   * Every windowed statistic slides at a 10 ms hop, so results do not depend on where t = 0 falls.
//     "100 ms window" = 10 consecutive 10 ms sub-blocks, "400 ms" = 40, "3 s" = 300.
import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FF = process.env.FFMPEG || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const SR = 48000
const HOP = 480               // 10 ms sub-block
const SILENCE_DB = -140
const TOOL_VERSION = 'measure.mjs 1.1 (2026-10-04)'

const HELP = `${TOOL_VERSION}
usage: node measure.mjs <file> [--ref <original>] [--voice <voiceStem> --music <musicStemAsMixed>] [--compact] [--out f.json]

GRID  audio decoded by ffmpeg to 48 kHz float (>2 ch downmixed to stereo). Power is summed in 10 ms sub-blocks;
      every window below slides at a 10 ms hop (grid-phase independent). dBFS = 10log10(mean square over all
      channels), so a full-scale sine is -3.01 dBFS; silence clamps to -140. LUFS use BS.1770 K-weighting with
      channel powers summed (mono counted as dual-mono, +3.01 dB).

SINGLE FILE
  integratedLufs, lraLu, truePeakDbtp   ffmpeg ebur128=peak=true+sample:dualmono=true (the same scanner VidHelm's
                                        loudnorm/QC uses). integratedLufsJs = same gating recomputed here, 0.01 LU.
  samplePeakDbfs                        max |sample| over all channels.
  clippedSamples / clippedRuns          samples with |x| >= 0.999 / runs of >= 3 such consecutive samples per channel.
  rmsDbfs, crestFactorDb                whole-file RMS; crest = samplePeak - RMS (gaps inflate it).
  speechCrestFactorDb                   peak inside speech windows minus RMS over speech windows.
  speechLevelDbfs                       mean of the dB values of the loudest 50 % of 100 ms RMS windows.
  noiseFloorDbfs                        RMS (energy mean) of the quietest 10 % of 100 ms windows.
  snrDb                                 speechLevelDbfs - noiseFloorDbfs.
  speechFraction                        share of 100 ms windows within 20 dB of the speech level ("speech windows").
  speechLoudnessLufs / noiseFloorLufs   K-weighted energy over the speech windows / the floor windows (ungated).
  loudnessSpreadDb                      stdev (dB) of 400 ms momentary loudness over windows within 20 dB of the
                                        momentary speech level (mean of the loudest 50 % of momentary values).
                                        Natural clean read speech is about 3-3.5; it mostly reflects syllables.
  shortTermSpreadDb                     same with 3 s short-term loudness: section-to-section evenness (leveling).
  pumpingP95Db                          95th percentile of |L(t+100ms) - L(t)| of the 100 ms RMS where both windows
                                        are speech windows. Includes natural syllabic motion (about 13-16 dB raw),
                                        so read it as a delta vs the original; vsRef.gainTrack is the clean one.
  bandsSpeechDb                         energy in rumble<80, 80-250, 250-1k, 1k-4k, 4k-9k, >9k Hz (4th-order
                                        Butterworth splits) over speech windows, dB relative to full-band speech.
  bandsFloorDbfs                        absolute band levels over the floor windows (what the noise is made of).

--ref <original>   (processed vs original; the original's windows define speech/gaps)
  lagMs, lagCorr          envelope cross-correlation of 1 ms log-RMS, +-500 ms; positive = processed is LATE.
                          Validated: adelay 40 ms -> 40, trim 17 ms -> -17, afftdn -> 25, alimiter -> 5.
  durationDeltaS          processed duration - original duration.
  speechGainDb, noiseFloorRiseDb, noiseFloorRiseLu, snrChangeDb   differences of the single-file metrics.
  sameWindows.*           same comparisons on the ORIGINAL's speech/floor windows, lag-aligned: the floor rise
                          where the gaps really are, even if processing changed which windows are quietest.
                          gapStdevDb vs refGapStdevDb: level wobble inside the gaps (noise "breathing").
  gainTrack.*             per-window gain the processor applied (processed dB - original dB, lag-aligned):
                          speechMedian/P05/P95 = how much and how evenly speech was lifted; speechStepP95 =
                          95th pct of the gain change across 100 ms during speech (THE pumping metric: a pure
                          gain is 0); gapMedian = gain applied to gaps; gapMinusSpeech > 0 means the gaps were
                          lifted more than the speech (noise pumped up), < 0 means gaps pushed down (expander/NR).
  *DeltaDb / *DeltaLu     processed - original for LRA, spreads, pumping proxy, and every band.

--voice <stem> --music <stem as mixed>   (ducking / balance; stems must be sample-aligned with the mix)
  speech windows = voice stem within 20 dB of its own speech level; gaps = stretches >= 1.0 s where the voice stem
  is >= 30 dB under it ("settled" drops each gap's first 0.5 s, i.e. after the release). Levels are K-weighted
  energy over those windows on the LUFS scale (ungated), so voice and music are compared as the ear weights them.
  voiceMinusMusicLu       voice loudness - music loudness during speech (the dialogue-over-bed margin).
  voiceMinusMusicDb       the same with unweighted RMS (bass-heavy music reads louder here).
  ...WorstSegmentLu / ...MedianSegmentLu   per speech segment (speech merged across < 1 s pauses, >= 0.5 s long).
  musicDuringSpeechLufs, musicDuringGapsLufs, musicDuringGapsSettledLufs, duckDepthLu = gaps - speech.
  mixDuringSpeechLufs, mixDuringGapsLufs   the same windows measured on the mix itself.
  Pass the voice as it sits in the mix (processed) for an exact margin; the original voice stem still gives the
  right windows. Pass the MUSIC AFTER ducking (the music as it sits in the mix).
`

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2)
if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP)
  process.exit(argv.length ? 0 : 1)
}
const opt = { files: [] }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--ref') opt.ref = argv[++i]
  else if (a === '--voice') opt.voice = argv[++i]
  else if (a === '--music') opt.music = argv[++i]
  else if (a === '--out') opt.out = argv[++i]
  else if (a === '--compact') opt.compact = true
  else opt.files.push(a)
}
if (opt.files.length !== 1) { console.error('measure.mjs: give exactly one file to measure'); process.exit(1) }
if (!!opt.voice !== !!opt.music) { console.error('measure.mjs: --voice and --music go together'); process.exit(1) }
for (const f of [opt.files[0], opt.ref, opt.voice, opt.music]) if (f && !existsSync(f)) { console.error(`measure.mjs: not found: ${f}`); process.exit(1) }

// ---------------------------------------------------------------- helpers
const r1 = (x) => (x == null || !isFinite(x) ? x : Math.round(x * 10) / 10)
const r2 = (x) => (x == null || !isFinite(x) ? x : Math.round(x * 100) / 100)
const r3 = (x) => (x == null || !isFinite(x) ? x : Math.round(x * 1000) / 1000)
const db = (p) => (p > 0 ? Math.max(SILENCE_DB, 10 * Math.log10(p)) : SILENCE_DB)
const lufs = (p) => (p > 0 ? Math.max(SILENCE_DB, -0.691 + 10 * Math.log10(p)) : SILENCE_DB)
const mean = (a) => { if (!a.length) return NaN; let s = 0; for (const v of a) s += v; return s / a.length }
const stdev = (a) => { if (a.length < 2) return 0; const m = mean(a); let s = 0; for (const v of a) s += (v - m) ** 2; return Math.sqrt(s / (a.length - 1)) }
const pct = (a, q) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] }
const topHalfMean = (a) => { const s = Float64Array.from(a).sort().reverse(); return mean(s.subarray(0, Math.max(1, Math.ceil(s.length * 0.5)))) }
const idxWhere = (n, f) => { const o = []; for (let i = 0; i < n; i++) if (f(i)) o.push(i); return o }
const energyOver = (pw, idx) => { if (!idx.length) return 0; let s = 0; for (const i of idx) s += pw[i]; return s / idx.length }

/** Probe the first audio stream: source rate and channel count, from ffmpeg's banner. */
function probe(file) {
  const r = spawnSync(FF, ['-hide_banner', '-i', file], { encoding: 'utf8' })
  const line = (r.stderr || '').split(/\r?\n/).find((l) => /Stream #.*Audio:/.test(l))
  if (!line) throw new Error(`no audio stream in ${file}`)
  const rate = +(line.match(/(\d+) Hz/) || [])[1] || null
  const lay = ((line.match(/Hz, ([^,]+)/) || [])[1] || '').trim()
  let ch = 2
  if (/^mono/.test(lay)) ch = 1
  else if (/^stereo/.test(lay)) ch = 2
  else { const m = lay.match(/(\d+) channels/); ch = m ? +m[1] : 2 }
  return { rate, layout: lay, channels: ch }
}

/** Decode to planar Float32 at 48 kHz. >2 channels are downmixed to stereo. */
function decode(file) {
  const p = probe(file)
  const ch = p.channels > 2 ? 2 : p.channels
  const buf = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-map', '0:a:0',
    '-ac', String(ch), '-ar', String(SR), '-f', 'f32le', '-acodec', 'pcm_f32le', '-'], { maxBuffer: 2 ** 31 - 1 })
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2)
  const n = Math.floor(all.length / ch)
  const data = Array.from({ length: ch }, () => new Float32Array(n))
  for (let i = 0, k = 0; i < n; i++) for (let c = 0; c < ch; c++) data[c][i] = all[k++]
  return { file, data, n, ch, srcChannels: p.channels, srcRate: p.rate, layout: p.layout }
}

/** ffmpeg's own EBU R128 scanner: integrated, LRA, sample + true peak. Mono is measured as dual-mono. */
function ffEbur128(file) {
  const r = spawnSync(FF, ['-hide_banner', '-nostats', '-i', file, '-vn', '-map', '0:a:0',
    '-af', 'ebur128=peak=true+sample:dualmono=true:framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 })
  const s = (r.stderr || '').split('Summary:').pop()
  const num = (re) => { const m = s.match(re); return m ? +m[1] : null }
  const peaks = [...s.matchAll(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/g)].map((m) => (m[1] === '-inf' ? SILENCE_DB : +m[1]))
  return { I: num(/I:\s+(-?[\d.]+) LUFS/), LRA: num(/LRA:\s+(-?[\d.]+) LU/), samplePeak: peaks[0] ?? null, truePeak: peaks[1] ?? null }
}

/** Direct-form-I biquad over one channel. */
function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float32Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v
  }
  return y
}
/** RBJ cookbook 2nd-order Butterworth low/high pass at 48 kHz. */
function rbj(x, kind, f) {
  const w = 2 * Math.PI * f / SR, c = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + al
  if (kind === 'lp') return biquad(x, (1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - al) / a0)
  return biquad(x, (1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0)
}
/** ITU-R BS.1770 K-weighting, 48 kHz coefficients. */
const kWeight = (x) => biquad(biquad(x, 1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585),
  1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621)

/** Power per 10 ms sub-block. mode 'mean' = mean over channels (dBFS scale), 'sum' = sum over channels (BS.1770 scale).
 *  offset (samples) shifts the grid, used to lag-align a processed file to its reference. */
function subPowers(chans, offset = 0, mode = 'mean') {
  const n = chans[0].length, S = Math.max(0, Math.floor((n - Math.max(0, offset)) / HOP))
  const out = new Float64Array(S), div = mode === 'sum' ? HOP : HOP * chans.length
  for (let b = 0; b < S; b++) {
    const s0 = b * HOP + offset
    let acc = 0
    for (const x of chans) for (let i = s0; i < s0 + HOP; i++) { const v = i >= 0 ? x[i] : 0; acc += v * v }
    out[b] = acc / div
  }
  return out
}
/** Sliding mean of `len` sub-blocks at a one-sub-block (10 ms) hop. Window w covers sub-blocks [w, w+len). */
function slide(sub, len) {
  const W = Math.max(0, sub.length - len + 1), out = new Float64Array(W)
  let acc = 0
  for (let i = 0; i < sub.length; i++) { acc += sub[i]; if (i >= len) acc -= sub[i - len]; if (i >= len - 1) out[i - len + 1] = acc / len }
  return out
}
/** Gated BS.1770 integrated loudness: 400 ms windows every 100 ms from K-power sub-blocks. */
function integratedFromK(ksub) {
  const w400 = slide(ksub, 40), w = []
  for (let i = 0; i < w400.length; i += 10) w.push(w400[i])
  const abs = w.filter((p) => lufs(p) > -70)
  if (!abs.length) return SILENCE_DB
  const rel = lufs(mean(abs)) - 10
  return lufs(mean(abs.filter((p) => lufs(p) > rel)))
}

const BANDS = [
  ['rumble_lt80', null, 80], ['low_80_250', 80, 250], ['lowmid_250_1k', 250, 1000],
  ['mid_1k_4k', 1000, 4000], ['presence_4k_9k', 4000, 9000], ['air_gt9k', 9000, null],
]
/** Band-limited copies (4th order: two cascaded Butterworth sections per edge). */
function bandSplit(chans) {
  const out = {}
  for (const [name, lo, hi] of BANDS) out[name] = chans.map((x) => {
    let y = x
    if (lo) { y = rbj(y, 'hp', lo); y = rbj(y, 'hp', lo) }
    if (hi) { y = rbj(y, 'lp', hi); y = rbj(y, 'lp', hi) }
    return y
  })
  return out
}

// ---------------------------------------------------------------- core analysis
function analyse(file) {
  const d = decode(file)
  const ff = ffEbur128(file)
  const chans = d.data

  const sub = subPowers(chans)                       // 10 ms, mean over channels
  const p100 = slide(sub, 10), W = p100.length       // 100 ms windows, 10 ms hop
  const d100 = Array.from(p100, db)
  const speechLevel = topHalfMean(d100)
  const order = [...d100.keys()].sort((a, b) => d100[a] - d100[b])        // quiet -> loud
  const floorIdx = order.slice(0, Math.max(1, Math.round(W * 0.1)))
  const floorDb = db(energyOver(p100, floorIdx))
  const speechMask = d100.map((v) => v >= speechLevel - 20)
  const speechIdx = idxWhere(W, (i) => speechMask[i])

  // K-weighted (BS.1770) power: sum over channels; mono counted twice (dual-mono)
  const ksub = subPowers(chans.map(kWeight), 0, 'sum')
  if (d.ch === 1) for (let i = 0; i < ksub.length; i++) ksub[i] *= 2
  const k100 = slide(ksub, 10)
  const mom = Array.from(slide(ksub, 40), lufs)
  const st = Array.from(slide(ksub, 300), lufs)
  const momRef = topHalfMean(mom), stRef = topHalfMean(st)
  const loudSpread = stdev(mom.filter((v) => v >= momRef - 20))
  const stSpread = st.length ? stdev(st.filter((v) => v >= stRef - 20)) : null

  // pumping proxy: |change| between consecutive (abutting) 100 ms windows, both speech, every 10 ms
  const deltas = []
  for (let w = 0; w + 10 < W; w++) if (speechMask[w] && speechMask[w + 10]) deltas.push(Math.abs(d100[w + 10] - d100[w]))

  // peaks, clipping, crest
  let peak = 0, clipped = 0, runs = 0, sumsq = 0
  const subPeak = new Float32Array(sub.length)
  for (const x of chans) {
    let run = 0
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]); sumsq += x[i] * x[i]
      if (a > peak) peak = a
      const b = (i / HOP) | 0; if (b < subPeak.length && a > subPeak[b]) subPeak[b] = a
      if (a >= 0.999) { clipped++; run++; if (run === 3) runs++ } else run = 0
    }
  }
  let speechPeak = 0
  const inSpeech = new Uint8Array(sub.length)
  for (const w of speechIdx) for (let k = w; k < w + 10; k++) inSpeech[k] = 1
  for (let k = 0; k < sub.length; k++) if (inSpeech[k] && subPeak[k] > speechPeak) speechPeak = subPeak[k]
  const rmsDb = db(sumsq / (d.n * d.ch))
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : SILENCE_DB
  const speechRmsDb = db(energyOver(p100, speechIdx))

  const res = {
    tool: TOOL_VERSION,
    file: path.resolve(file),
    durationS: r3(d.n / SR),
    channels: d.srcChannels,
    sourceRate: d.srcRate,
    integratedLufs: ff.I,
    lraLu: ff.LRA,
    truePeakDbtp: ff.truePeak,
    samplePeakDbfs: r2(peakDb),
    clippedSamples: clipped,
    clippedRuns: runs,
    rmsDbfs: r2(rmsDb),
    crestFactorDb: r2(peakDb - rmsDb),
    speechCrestFactorDb: r2((speechPeak > 0 ? 20 * Math.log10(speechPeak) : SILENCE_DB) - speechRmsDb),
    speechLevelDbfs: r2(speechLevel),
    noiseFloorDbfs: r2(floorDb),
    snrDb: r2(speechLevel - floorDb),
    speechFraction: r3(speechIdx.length / W),
    speechLoudnessLufs: r2(lufs(energyOver(k100, speechIdx))),
    noiseFloorLufs: r2(lufs(energyOver(k100, floorIdx))),
    loudnessSpreadDb: r2(loudSpread),
    shortTermSpreadDb: r2(stSpread),
    pumpingP95Db: r2(pct(deltas, 0.95)),
    integratedLufsJs: r2(integratedFromK(ksub)),
  }
  const bands = bandSplit(chans)
  res.bandsSpeechDb = {}; res.bandsFloorDbfs = {}
  const tot = energyOver(p100, speechIdx)
  for (const [name] of BANDS) {
    const bp = slide(subPowers(bands[name]), 10)
    res.bandsSpeechDb[name] = r1(db(energyOver(bp, speechIdx)) - db(tot))
    res.bandsFloorDbfs[name] = r1(db(energyOver(bp, floorIdx)))
  }
  return { res, internal: { d, p100, d100, k100, speechMask, speechIdx, floorIdx, speechLevel } }
}

/** Lag of b relative to a (positive = b is late), from 1 ms log-envelopes, search +-500 ms. */
function estimateLag(a, b) {
  const H = 48, env = (chans) => {
    const n = Math.floor(chans[0].length / H), e = new Float64Array(n)
    for (let k = 0; k < n; k++) { let s = 0; for (const x of chans) for (let i = k * H; i < (k + 1) * H; i++) s += x[i] * x[i]; e[k] = db(s / (H * chans.length)) }
    let mx = -Infinity; for (const v of e) if (v > mx) mx = v
    let m = 0; for (let k = 0; k < n; k++) { e[k] = Math.max(e[k], mx - 60); m += e[k] } m /= n || 1
    for (let k = 0; k < n; k++) e[k] -= m
    return e
  }
  const ea = env(a), eb = env(b), N = Math.min(ea.length, eb.length), L = 500
  let best = 0, bestC = -Infinity, na = 0, nb = 0
  for (let k = 0; k < N; k++) { na += ea[k] * ea[k]; nb += eb[k] * eb[k] }
  for (let lag = -L; lag <= L; lag++) {
    let s = 0
    for (let k = Math.max(0, -lag); k < Math.min(N, N - lag); k++) s += ea[k] * eb[k + lag]
    if (s > bestC) { bestC = s; best = lag }
  }
  return { lagMs: best, corr: bestC / Math.sqrt(na * nb || 1) }
}

// ---------------------------------------------------------------- run
const main = analyse(opt.files[0])
const out = main.res

if (opt.ref) {
  const ref = analyse(opt.ref)
  const R = ref.res, P = out, RI = ref.internal
  const { lagMs, corr } = estimateLag(RI.d.data, main.internal.d.data)
  const off = Math.round(lagMs * SR / 1000)
  // processed 100 ms windows on the reference's time grid (shifted by the lag)
  const p100s = slide(subPowers(main.internal.d.data, off), 10), d100s = Array.from(p100s, db)
  const n = Math.min(p100s.length, RI.p100.length)
  const rFloor = RI.floorIdx.filter((i) => i < n), rSpeech = RI.speechIdx.filter((i) => i < n)
  const sameSpeech = mean(rSpeech.map((i) => d100s[i])), refSameSpeech = mean(rSpeech.map((i) => RI.d100[i]))
  const sameFloor = db(energyOver(p100s, rFloor)), refSameFloor = db(energyOver(RI.p100, rFloor))
  // gain track: what the processor did to each reference window (processed dB minus original dB)
  const g = (i) => d100s[i] - RI.d100[i]
  const gS = rSpeech.map(g), gF = rFloor.map(g)
  const steps = []
  for (const w of rSpeech) if (w + 10 < n && RI.speechMask[w + 10]) steps.push(Math.abs(g(w + 10) - g(w)))
  out.vsRef = {
    ref: path.resolve(opt.ref),
    lagMs, lagCorr: r3(corr),
    durationDeltaS: r3(P.durationS - R.durationS),
    integratedDeltaLu: R.integratedLufs != null && P.integratedLufs != null ? r1(P.integratedLufs - R.integratedLufs) : null,
    speechGainDb: r2(P.speechLevelDbfs - R.speechLevelDbfs),
    noiseFloorRiseDb: r2(P.noiseFloorDbfs - R.noiseFloorDbfs),
    noiseFloorRiseLu: r2(P.noiseFloorLufs - R.noiseFloorLufs),
    snrChangeDb: r2(P.snrDb - R.snrDb),
    sameWindows: {
      speechGainDb: r2(sameSpeech - refSameSpeech),
      floorRiseDb: r2(sameFloor - refSameFloor),
      snrChangeDb: r2((sameSpeech - refSameSpeech) - (sameFloor - refSameFloor)),
      gapStdevDb: r2(stdev(rFloor.map((i) => d100s[i]))),
      refGapStdevDb: r2(stdev(rFloor.map((i) => RI.d100[i]))),
    },
    gainTrack: {
      speechMedianDb: r2(pct(gS, 0.5)),
      speechP05Db: r2(pct(gS, 0.05)),
      speechP95Db: r2(pct(gS, 0.95)),
      speechStepP95Db: r2(pct(steps, 0.95)),
      gapMedianDb: r2(pct(gF, 0.5)),
      gapMinusSpeechDb: r2(pct(gF, 0.5) - pct(gS, 0.5)),
    },
    lraDeltaLu: R.lraLu != null && P.lraLu != null ? r1(P.lraLu - R.lraLu) : null,
    loudnessSpreadDeltaDb: r2(P.loudnessSpreadDb - R.loudnessSpreadDb),
    shortTermSpreadDeltaDb: r2(P.shortTermSpreadDb - R.shortTermSpreadDb),
    pumpingDeltaDb: r2(P.pumpingP95Db - R.pumpingP95Db),
    bandsSpeechDeltaDb: Object.fromEntries(Object.keys(P.bandsSpeechDb).map((k) => [k, r1(P.bandsSpeechDb[k] - R.bandsSpeechDb[k])])),
    bandsFloorDeltaDb: Object.fromEntries(Object.keys(P.bandsFloorDbfs).map((k) => [k, r1(P.bandsFloorDbfs[k] - R.bandsFloorDbfs[k])])),
    refSummary: Object.fromEntries(['integratedLufs', 'lraLu', 'truePeakDbtp', 'speechLevelDbfs', 'noiseFloorDbfs', 'snrDb',
      'loudnessSpreadDb', 'shortTermSpreadDb', 'pumpingP95Db', 'durationS'].map((k) => [k, R[k]])),
  }
}

if (opt.voice) {
  const V = decode(opt.voice), M = decode(opt.music), X = main.internal.d
  const warn = []
  for (const [nm, s] of [['voice', V], ['music', M]]) if (Math.abs(s.n - X.n) > SR * 0.05) warn.push(`${nm} stem length ${r3(s.n / SR)} s differs from mix ${r3(X.n / SR)} s`)
  const vp = slide(subPowers(V.data), 10), vd = Array.from(vp, db), vLevel = topHalfMean(vd)
  const k100of = (s) => { const k = subPowers(s.data.map(kWeight), 0, 'sum'); if (s.ch === 1) for (let i = 0; i < k.length; i++) k[i] *= 2; return slide(k, 10) }
  const vk = k100of(V), mk = k100of(M), xk = main.internal.k100, mp = slide(subPowers(M.data), 10)
  const W = Math.min(vd.length, mk.length, xk.length)
  const speech = idxWhere(W, (i) => vd[i] >= vLevel - 20)
  const silent = vd.map((v) => v < vLevel - 30)
  // gaps: stretches >= 1.0 s where the voice stem is >= 30 dB under its speech level (a run of k silent
  // 100 ms windows at a 10 ms hop spans k+9 sub-blocks, so >= 1.0 s means k >= 91)
  const gaps = [], settled = []; let gapCount = 0, gapSub = 0
  for (let i = 0; i < W;) {
    if (!silent[i]) { i++; continue }
    let j = i; while (j < W && silent[j]) j++
    if (j - i >= 91) { gapCount++; gapSub += j - i + 9; for (let k = i; k < j; k++) { gaps.push(k); if (k - i >= 50) settled.push(k) } }
    i = j
  }
  // speech segments: speech windows merged across pauses shorter than 1 s; segments >= 0.5 s scored
  const segs = []
  for (const i of speech) { const s = segs[segs.length - 1]; if (s && i - s[s.length - 1] <= 100) s.push(i); else segs.push([i]) }
  const segVm = segs.filter((s) => s.length >= 50).map((s) => lufs(energyOver(vk, s)) - lufs(energyOver(mk, s)))
  const vS = lufs(energyOver(vk, speech)), mS = lufs(energyOver(mk, speech)), mG = lufs(energyOver(mk, gaps))
  out.balance = {
    voice: path.resolve(opt.voice), music: path.resolve(opt.music),
    method: 'speech = 100 ms windows (10 ms hop) where the voice stem is within 20 dB of its own speech level; gaps = stretches >= 1.0 s where the voice stem is >= 30 dB under it ("settled" skips the first 0.5 s of each gap). Levels are K-weighted energy (LUFS scale, ungated) over those windows; the *Db twin is unweighted RMS.',
    speechSeconds: r1(speech.length / 100), gapSeconds: r1(gapSub / 100), gapCount,
    voiceDuringSpeechLufs: r2(vS),
    musicDuringSpeechLufs: r2(mS),
    voiceMinusMusicLu: r2(vS - mS),
    voiceMinusMusicDb: r2(db(energyOver(vp, speech)) - db(energyOver(mp, speech))),
    voiceMinusMusicWorstSegmentLu: segVm.length ? r2(Math.min(...segVm)) : null,
    voiceMinusMusicMedianSegmentLu: segVm.length ? r2(pct(segVm, 0.5)) : null,
    speechSegments: segVm.length,
    musicDuringGapsLufs: r2(mG),
    musicDuringGapsSettledLufs: r2(lufs(energyOver(mk, settled))),
    duckDepthLu: r2(mG - mS),
    mixDuringSpeechLufs: r2(lufs(energyOver(xk, speech))),
    mixDuringGapsLufs: r2(lufs(energyOver(xk, gaps))),
    warnings: warn,
  }
}

const json = JSON.stringify(out, null, opt.compact ? 0 : 2)
if (opt.out) writeFileSync(opt.out, json + '\n')
console.log(json)
