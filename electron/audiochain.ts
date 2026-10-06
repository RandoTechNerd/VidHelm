/* Fix voice: the measured voice chain behind the Studio and Light presets, plus the music/SFX bus
 * helpers that sit around it. Pure (no Electron, no Node APIs), so the renderer and VidHelm Cloud
 * can import it as well; electron/voicebake.ts runs it with ffmpeg.
 *
 * The rule the whole chain follows: a quiet recording is fixed by ONE measured static gain that
 * puts its speech at TARGET_LUFS, applied before any dynamics. Peak normalising cannot do it (one
 * knock at -0.2 dBFS blocks any lift), a dynamic loudnorm is an automatic gain control (it lifts
 * the room one for one with the voice), and compressor make-up turns every dB of gain reduction
 * into a dB of room between syllables. Once the speech sits at a known level, the noise reduction,
 * the compressor and the limiter behave the same on a phone take and a studio take.
 *
 * The numbers are the ones the quiet-audio shoot-out measured on a six-file corpus (phone, quiet
 * clean, quiet over real room tone, leaning away, knocks, voice over music); where a constant looks
 * arbitrary its comment says what it was measured against.
 *
 * Tests: npm run test:audiochain (synthetic signals, no ffmpeg) and npm run test:audiochain:corpus
 * (the real bake against the corpus; opt-in through VIDHELM_AUDIO_CORPUS).
 */

/** Bumped whenever the chain's output changes, so every cached bake is made again. */
export const CHAIN_VERSION = 1
export const SR = 48000
/** Analysis blocks per second (10 ms blocks; every window below slides at one block). */
export const BLOCKS_PER_S = 100
/** Working level of every baked voice. The -14 master is then a pure linear gain of about +2 dB. */
export const TARGET_LUFS = -16
/** Voice ceiling: target + 12.7 dB peak-to-loudness, so the master's lift never reaches its limiter. */
export const CEILING_DBFS = -3.3
/** Where the room should end up after the lift; noise reduction only runs to get it there. */
export const ROOM_TARGET_DBFS = -60
/** What the 2:1 compressor takes off speech on average, so NR and gap ease can plan before it runs. */
export const EXPECTED_MAKEUP_DB = 2.5
/** A lift bigger than this is not a quiet recording, it is a recording of the room. */
export const MAX_STATIC_DB = 30
export const MASTER_CEILING_DBFS = -1.5
/** afftdn delays its output by 25 ms and nothing downstream compensates; the NR graph trims it. */
export const AFFTDN_LATENCY = (sr: number) => Math.round(0.025 * sr)
/** ffmpeg's acompressor attack/release are four time constants: attack=80 is a 20 ms tau. */
export const FF_TC_DIVISOR = 4

export type Preset = 'off' | 'light' | 'studio'
export type ChannelMode = 'asis' | 'fold' | 'left' | 'right'
export type Role = 'voice' | 'music' | 'sfx' | 'asis'
/** A run of 10 ms blocks, [start, end). */
export type Run = [number, number]

const db = (p: number) => (p > 1e-14 ? 10 * Math.log10(p) : -140)
const lufs = (p: number) => (p > 1e-14 ? -0.691 + 10 * Math.log10(p) : -140)
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
const r1 = (x: number) => Math.round(x * 10) / 10
const r2 = (x: number) => Math.round(x * 100) / 100

// ------------------------------------------------------------------ filters

/** Direct-form-I biquad with its state, so a stream can be filtered chunk by chunk. */
class Biquad {
  b0: number; b1: number; b2: number; a1: number; a2: number
  x1 = 0; x2 = 0; y1 = 0; y2 = 0
  constructor(c: readonly number[]) { [this.b0, this.b1, this.b2, this.a1, this.a2] = c }
  step(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y
    return y
  }
}

/**
 * BS.1770 K-weighting (pre-filter shelf, then the RLB high-pass) as [b0, b1, b2, a1, a2] pairs.
 * 48 kHz uses the published table so the numbers match ffmpeg's ebur128 and the shoot-out's meter;
 * other rates use the same design equations (libebur128's).
 */
export function kWeighting(sr = SR): [number[], number[]] {
  if (sr === 48000) return [
    [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
    [1, -2, 1, -1.99004745483398, 0.99007225036621],
  ]
  let f0 = 1681.974450955533, Q = 0.7071752369554196, K = Math.tan(Math.PI * f0 / sr)
  const Vh = 10 ** (3.999843853973347 / 20), Vb = Vh ** 0.4996667741545416
  let a0 = 1 + K / Q + K * K
  const shelf = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / sr)
  a0 = 1 + K / Q + K * K
  return [shelf, [1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]]
}

/** RBJ cookbook second-order high/low pass (Butterworth at the default Q). */
export function rbj(kind: 'hp' | 'lp', f: number, sr = SR, q = Math.SQRT1_2): number[] {
  const w = 2 * Math.PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al
  return kind === 'hp'
    ? [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0]
    : [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - al) / a0]
}

/** A Float64Array that grows, for per-block statistics of a stream of unknown length. */
class Grow {
  a = new Float64Array(4096); n = 0
  push(v: number) {
    if (this.n === this.a.length) { const b = new Float64Array(this.a.length * 2); b.set(this.a); this.a = b }
    this.a[this.n++] = v
  }
  take(len: number) { return this.a.slice(0, len) }
}

// ------------------------------------------------------------------ analysis

/** Per 10 ms block: K-weighted power summed over channels (the BS.1770 scale), mean unweighted power over channels (the dBFS scale), sample peak. */
export interface Blocks { kP: Float64Array; uP: Float64Array; pk: Float64Array }

export interface Analysis extends Blocks {
  sr: number; n: number; nb: number; durS: number
  /** 400 ms momentary K-power, 10 ms hop; index = window START block */
  m400: Float64Array
  /** 100 ms unweighted level (dBFS), 10 ms hop; index = window START block */
  u100db: Float64Array
  /** BS.1770 integrated loudness (400 ms blocks at 100 ms hop, -70 absolute and -10 LU relative gates) */
  I: number
  /** energy mean of the quietest 10 percent of 100 ms windows */
  floorDb: number
  /** mean dB of the loudest 50 percent of 100 ms windows */
  speechDb: number
  snr: number; thOn: number; thOff: number
  /** voice activity per block (1 = speech) */
  act: Uint8Array
  activeS: number
  /** P10 loudness of 2 s chunks that are at least half speech, minus the floor */
  worstSnr: number
  /** loudest 400 ms momentary loudness (an SFX's level) */
  momentaryMaxLufs: number
  /** stdev of 400 ms loudness within 20 dB of the speech level (natural speech moves, a steady bed does not) */
  spreadDb: number
}

export interface ChannelFacts {
  /** both channels carry the same samples (dual-mono, or a mono file) */
  identical: boolean
  /** 4-9 kHz energy of (L+R)/2 over speech, relative to the channels' mean: below -1 dB the fold would comb-filter the voice */
  foldLossDb: number
  snrL: number; snrR: number
}

/** Running per-block sums for every channel view, so the channel decision needs no second decode. */
export interface ChannelSums {
  sr: number; n: number; blk: number
  sLL: Float64Array; sRR: Float64Array; sLR: Float64Array
  kLL: Float64Array; kRR: Float64Array; kLR: Float64Array
  pkL: Float64Array; pkR: Float64Array; pkM: Float64Array
}

export interface SourceAnalysis extends Analysis { channel: ChannelFacts; sums: ChannelSums }

/** u[i] = mean of a[i .. i+w) (window START index), the shoot-out meter's convention. */
export function slidingMean(a: ArrayLike<number>, w: number): Float64Array {
  const o = new Float64Array(Math.max(0, a.length - w + 1))
  let s = 0
  for (let b = 0; b < a.length; b++) {
    s += a[b]
    if (b >= w) s -= a[b - w]
    if (b >= w - 1) o[b - w + 1] = s / w
  }
  return o
}

/** Runs of `val` in a 0/1 mask, as [start, end) block pairs. */
export function runs(act: ArrayLike<number>, val = 1): Run[] {
  const out: Run[] = []
  for (let b = 0; b < act.length;) {
    if (act[b] !== val) { b++; continue }
    let e = b
    while (e < act.length && act[e] === val) e++
    out.push([b, e]); b = e
  }
  return out
}

/** VAD shaping, in blocks: drop runs shorter than minRun (a knock in a pause is not speech), pad each kept run, close gaps under mergeGap. */
export const VAD_MORPH = { pre: 5, post: 15, mergeGap: 30, minRun: 12 }
export function morph(a: Uint8Array, o = VAD_MORPH): Uint8Array {
  const n = a.length
  const kept = runs(a, 1).filter(([s, e]) => e - s >= o.minRun).map(([s, e]): Run => [Math.max(0, s - o.pre), Math.min(n, e + o.post)])
  const merged: Run[] = []
  for (const r of kept) {
    const last = merged[merged.length - 1]
    if (last && r[0] - last[1] < o.mergeGap) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  const out = new Uint8Array(n)
  for (const [s, e] of merged) out.fill(1, s, e)
  return out
}

/** floor = energy mean of the quietest 10 percent of 100 ms windows; speech = mean dB of the loudest half. */
function floorAndSpeech(u100db: ArrayLike<number>) {
  const sorted = Float64Array.from(u100db).sort()
  if (!sorted.length) return { floorDb: -140, speechDb: -140 }
  const q10 = Math.max(1, Math.floor(sorted.length * 0.1))
  let fe = 0
  for (let i = 0; i < q10; i++) fe += 10 ** (sorted[i] / 10)
  let s = 0, k = 0
  for (let i = Math.floor(sorted.length / 2); i < sorted.length; i++) { s += sorted[i]; k++ }
  return { floorDb: db(fe / q10), speechDb: k ? s / k : -140 }
}

/** BS.1770 gated integrated loudness from 10 ms K-power blocks, optionally through a per-block gain (dB). */
export function integratedLufs(kP: ArrayLike<number>, gainDb?: ArrayLike<number>): number {
  let k: ArrayLike<number> = kP
  if (gainDb) { const g = new Float64Array(kP.length); for (let b = 0; b < kP.length; b++) g[b] = kP[b] * 10 ** ((gainDb[b] || 0) / 10); k = g }
  const m400 = slidingMean(k, 40)
  return integratedFromM400(m400)
}
function integratedFromM400(m400: Float64Array): number {
  const blocks: number[] = []
  for (let b = 0; b < m400.length; b += 10) if (lufs(m400[b]) > -70) blocks.push(m400[b])
  if (!blocks.length) return -140
  const rel = lufs(blocks.reduce((a, v) => a + v, 0) / blocks.length) - 10
  const gated = blocks.filter((p) => lufs(p) > rel)
  return lufs(gated.reduce((a, v) => a + v, 0) / Math.max(1, gated.length))
}

/**
 * Everything the decisions need, from the 10 ms block statistics alone (the samples are never
 * held: ten minutes is 60k blocks). The VAD reads a CENTRED 100 ms level with hysteresis, on/off
 * thresholds scaled to this recording's own SNR, then drops sub-120 ms runs and pads the rest
 * (50 ms pre-roll, 150 ms hangover, gaps under 300 ms closed: a breath between words is not a pause).
 */
export function analyzeBlocks(b: Blocks, sr = SR, n = b.kP.length * Math.round(sr / BLOCKS_PER_S)): Analysis {
  const nb = b.kP.length
  const u100 = slidingMean(b.uP, 10)
  const u100db = Float64Array.from(u100, db)
  const m400 = slidingMean(b.kP, 40)
  const { floorDb, speechDb } = floorAndSpeech(u100db)
  const I = integratedFromM400(m400)
  const snr = speechDb - floorDb
  const thOn = floorDb + clamp(0.4 * snr, 9, 18), thOff = floorDb + clamp(0.25 * snr, 6, 10)
  const raw = new Uint8Array(nb)
  if (u100db.length) {
    let on = false
    for (let i = 0; i < nb; i++) {
      const v = u100db[Math.min(u100db.length - 1, Math.max(0, i - 5))]
      if (!on && v > thOn) on = true
      else if (on && v < thOff) on = false
      raw[i] = on ? 1 : 0
    }
  }
  const act = morph(raw)
  let active = 0
  for (let i = 0; i < nb; i++) active += act[i]
  // worst local speech-to-room: the 10th percentile of 2 s chunks that are at least half speech
  const chunks: number[] = []
  for (let c = 0; c + 200 <= nb; c += 200) {
    let e = 0, k = 0
    for (let i = c; i < c + 200; i++) if (act[i]) { e += b.kP[i]; k++ }
    if (k >= 100) chunks.push(-0.691 + 10 * Math.log10(Math.max(1e-14, e / k)))
  }
  chunks.sort((x, y) => x - y)
  const worst = chunks.length ? chunks[Math.floor(chunks.length * 0.1)] : I
  // momentary loudness: the loudest window (SFX level) and the spread (speech moves, a bed does not)
  const mom = Array.from(m400, lufs)
  let momMax = -140
  for (const v of mom) if (v > momMax) momMax = v
  const top = [...mom].sort((x, y) => y - x).slice(0, Math.max(1, Math.ceil(mom.length / 2)))
  const ref = top.length ? top.reduce((a, v) => a + v, 0) / top.length : -140
  const near = mom.filter((v) => v >= ref - 20)
  const mean = near.reduce((a, v) => a + v, 0) / Math.max(1, near.length)
  const spread = near.length > 1 ? Math.sqrt(near.reduce((a, v) => a + (v - mean) ** 2, 0) / (near.length - 1)) : 0
  return {
    ...b, sr, n, nb, durS: n / sr, m400, u100db, I, floorDb, speechDb, snr, thOn, thOff, act,
    activeS: active / BLOCKS_PER_S, worstSnr: worst - floorDb, momentaryMaxLufs: momMax, spreadDb: spread,
  }
}

/** The block statistics as heard through one channel decision (dual-mono views count a channel twice, as BS.1770 does). */
export function viewBlocks(s: ChannelSums, mode: ChannelMode): Blocks {
  const nb = s.sLL.length, B = s.blk
  const kP = new Float64Array(nb), uP = new Float64Array(nb), pk = new Float64Array(nb)
  for (let b = 0; b < nb; b++) {
    if (mode === 'fold') {
      kP[b] = (s.kLL[b] + 2 * s.kLR[b] + s.kRR[b]) / 2 / B
      uP[b] = (s.sLL[b] + 2 * s.sLR[b] + s.sRR[b]) / 4 / B
      pk[b] = s.pkM[b]
    } else if (mode === 'left' || mode === 'right') {
      const L = mode === 'left'
      kP[b] = 2 * (L ? s.kLL[b] : s.kRR[b]) / B
      uP[b] = (L ? s.sLL[b] : s.sRR[b]) / B
      pk[b] = L ? s.pkL[b] : s.pkR[b]
    } else {
      kP[b] = (s.kLL[b] + s.kRR[b]) / B
      uP[b] = (s.sLL[b] + s.sRR[b]) / 2 / B
      pk[b] = Math.max(s.pkL[b], s.pkR[b])
    }
  }
  return { kP, uP, pk }
}

/** The recording as it will be processed: analysis of one channel view. */
export function viewAnalysis(src: SourceAnalysis, mode: ChannelMode): Analysis {
  if (mode === 'asis') return src
  return analyzeBlocks(viewBlocks(src.sums, mode), src.sr, src.n)
}

/**
 * The streaming analyzer: push interleaved stereo float chunks of any size (an ffmpeg pipe), then
 * finish(). Filter state is carried across chunks, so 4096-sample chunks and one big buffer give the
 * same blocks; memory is the per-block sums only. `channelTest` adds the 4-9 kHz fold test (skip it
 * when measuring audio that is already mono-folded or only needs its loudness).
 */
export function createAnalyzer(sr = SR, opts: { channelTest?: boolean } = {}) {
  const channelTest = opts.channelTest !== false
  const BLK = Math.round(sr / BLOCKS_PER_S)
  const [kc1, kc2] = kWeighting(sr)
  const k1L = new Biquad(kc1), k2L = new Biquad(kc2), k1R = new Biquad(kc1), k2R = new Biquad(kc2)
  const hp = rbj('hp', 4000, sr), lp = rbj('lp', 9000, sr)
  const hL = [new Biquad(hp), new Biquad(hp), new Biquad(lp), new Biquad(lp)]
  const hR = [new Biquad(hp), new Biquad(hp), new Biquad(lp), new Biquad(lp)]
  const g = { sLL: new Grow(), sRR: new Grow(), sLR: new Grow(), kLL: new Grow(), kRR: new Grow(), kLR: new Grow(), pkL: new Grow(), pkR: new Grow(), pkM: new Grow(), hLL: new Grow(), hRR: new Grow(), hLR: new Grow() }
  let sLL = 0, sRR = 0, sLR = 0, kLL = 0, kRR = 0, kLR = 0, pL = 0, pR = 0, pM = 0, eLL = 0, eRR = 0, eLR = 0
  let inBlk = 0, n = 0, nb = 0, maxDiff = 0
  const flush = () => {
    g.sLL.push(sLL); g.sRR.push(sRR); g.sLR.push(sLR); g.kLL.push(kLL); g.kRR.push(kRR); g.kLR.push(kLR)
    g.pkL.push(pL); g.pkR.push(pR); g.pkM.push(pM)
    if (channelTest) { g.hLL.push(eLL); g.hRR.push(eRR); g.hLR.push(eLR) }
    sLL = sRR = sLR = kLL = kRR = kLR = pL = pR = pM = eLL = eRR = eLR = 0
    inBlk = 0; nb++
  }
  return {
    /** interleaved L,R float samples; an odd trailing sample is the caller's to carry over */
    push(x: Float32Array) {
      const frames = x.length >> 1
      for (let i = 0; i < frames; i++) {
        const l = x[2 * i], r = x[2 * i + 1]
        const kl = k2L.step(k1L.step(l)), kr = k2R.step(k1R.step(r))
        sLL += l * l; sRR += r * r; sLR += l * r
        kLL += kl * kl; kRR += kr * kr; kLR += kl * kr
        const al = Math.abs(l), ar = Math.abs(r), am = Math.abs(l + r) * 0.5
        if (al > pL) pL = al
        if (ar > pR) pR = ar
        if (am > pM) pM = am
        const d = Math.abs(l - r)
        if (d > maxDiff) maxDiff = d
        if (channelTest) {
          const yl = hL[3].step(hL[2].step(hL[1].step(hL[0].step(l))))
          const yr = hR[3].step(hR[2].step(hR[1].step(hR[0].step(r))))
          eLL += yl * yl; eRR += yr * yr; eLR += yl * yr
        }
        n++
        if (++inBlk === BLK) flush()
      }
    },
    /** samples (per channel) seen so far */
    frames: () => n,
    finish(): SourceAnalysis {
      // a partial last block is dropped, as the meter does: the bake still processes every sample
      const sums: ChannelSums = {
        sr, n, blk: BLK,
        sLL: g.sLL.take(nb), sRR: g.sRR.take(nb), sLR: g.sLR.take(nb),
        kLL: g.kLL.take(nb), kRR: g.kRR.take(nb), kLR: g.kLR.take(nb),
        pkL: g.pkL.take(nb), pkR: g.pkR.take(nb), pkM: g.pkM.take(nb),
      }
      const an = analyzeBlocks(viewBlocks(sums, 'asis'), sr, n)
      let eL = 0, eR = 0, eM = 0
      if (channelTest) for (let b = 0; b < nb; b++) if (an.act[b]) { eL += g.hLL.a[b]; eR += g.hRR.a[b]; eM += (g.hLL.a[b] + 2 * g.hLR.a[b] + g.hRR.a[b]) / 4 }
      const perChannelSnr = (s: Float64Array) => { const u = floorAndSpeech(Float64Array.from(slidingMean(Float64Array.from(s, (v) => v / BLK), 10), db)); return u.speechDb - u.floorDb }
      const channel: ChannelFacts = {
        identical: maxDiff <= 1e-6,
        foldLossDb: eL + eR > 0 && eM > 0 ? 10 * Math.log10(eM / ((eL + eR) / 2)) : 0,
        snrL: perChannelSnr(sums.sLL), snrR: perChannelSnr(sums.sRR),
      }
      return { ...an, channel, sums }
    },
  }
}

/** One-shot analysis of planar channels (tests, short buffers): the same numbers as streaming them. */
export function analyzeSamples(L: Float32Array, R: Float32Array = L, sr = SR): SourceAnalysis {
  const a = createAnalyzer(sr)
  const x = new Float32Array(L.length * 2)
  for (let i = 0; i < L.length; i++) { x[2 * i] = L[i]; x[2 * i + 1] = R[i] }
  a.push(x)
  return a.finish()
}

/** A loudness-only meter for a stream (the bake's own output): integrated LUFS from K-weighted blocks. */
export function createLoudnessMeter(sr = SR) {
  const BLK = Math.round(sr / BLOCKS_PER_S)
  const [kc1, kc2] = kWeighting(sr)
  const k1L = new Biquad(kc1), k2L = new Biquad(kc2), k1R = new Biquad(kc1), k2R = new Biquad(kc2)
  const kP = new Grow()
  let acc = 0, inBlk = 0, n = 0, peak = 0
  return {
    push(x: Float32Array) {
      const frames = x.length >> 1
      for (let i = 0; i < frames; i++) {
        const l = x[2 * i], r = x[2 * i + 1]
        const kl = k2L.step(k1L.step(l)), kr = k2R.step(k1R.step(r))
        acc += kl * kl + kr * kr
        const a = Math.max(Math.abs(l), Math.abs(r))
        if (a > peak) peak = a
        n++
        if (++inBlk === BLK) { kP.push(acc / BLK); acc = 0; inBlk = 0 }
      }
    },
    frames: () => n,
    finish: () => ({ I: integratedLufs(kP.take(kP.n)), samplePeakDbfs: peak > 0 ? 20 * Math.log10(peak) : -140, n }),
  }
}

// ------------------------------------------------------------------ decisions

/** Channel: identical -> as is; fold unless it costs > 1 dB of 4-9 kHz speech (phase between two mics); else the cleaner channel. */
export function decideChannel(c: ChannelFacts): ChannelMode {
  if (c.identical) return 'asis'
  if (c.foldLossDb > -1) return 'fold'
  return c.snrL >= c.snrR ? 'left' : 'right'
}

export interface Section { sB: number; eB: number; corr: number; lvl: number; n: number }
export interface Sections { sections: Section[]; ref: number; pts: number }

/**
 * Level sections: binary segmentation of 400 ms momentary loudness over speech (a split needs 2 s
 * of speech each side and a 4 dB difference). Each section gets a correction toward the
 * duration-weighted median level, with a 2 to 4 dB soft deadband so natural phrasing survives and
 * only real level changes (leaning away, a second mic) are corrected.
 */
export function levelSections(an: Analysis, o: { minPts?: number; minStep?: number; deadLo?: number; deadHi?: number; maxBoost?: number; maxCut?: number } = {}): Sections {
  const minPts = o.minPts ?? 20, minStep = o.minStep ?? 4, dbLo = o.deadLo ?? 2, dbHi = o.deadHi ?? 4, maxBoost = o.maxBoost ?? 18, maxCut = o.maxCut ?? 12
  const pts: { b: number; x: number; p: number }[] = []
  for (let b = 0; b < an.m400.length; b += 10) {
    const c = b + 20
    if (c < an.nb && an.act[c] && lufs(an.m400[b]) > an.floorDb - 5) pts.push({ b: c, x: lufs(an.m400[b]), p: an.m400[b] })
  }
  if (pts.length < 2 * minPts) return { sections: [{ sB: 0, eB: an.nb, corr: 0, lvl: an.I, n: pts.length }], ref: an.I, pts: pts.length }
  const cuts: number[] = []
  const split = (s: number, e: number) => {
    const n = e - s
    if (n < 2 * minPts) return
    let sum = 0
    for (let i = s; i < e; i++) sum += pts[i].x
    let best: { k: number; gain: number; diff: number } | null = null, ls = 0
    for (let k = s; k < e - 1; k++) {
      ls += pts[k].x
      const nl = k - s + 1, nr = n - nl
      if (nl < minPts || nr < minPts) continue
      const ml = ls / nl, mr = (sum - ls) / nr, gain = nl * nr / n * (ml - mr) ** 2
      if (!best || gain > best.gain) best = { k: k + 1, gain, diff: ml - mr }
    }
    if (!best || Math.abs(best.diff) < minStep) return
    cuts.push(best.k); split(s, best.k); split(best.k, e)
  }
  split(0, pts.length)
  cuts.sort((a, b) => a - b)
  const bounds = [0, ...cuts, pts.length]
  const secs = bounds.slice(0, -1).map((b0, i) => {
    const sl = pts.slice(b0, bounds[i + 1])
    return { i0: b0, i1: bounds[i + 1], lvl: lufs(sl.reduce((a, q) => a + q.p, 0) / sl.length), n: sl.length, corr: 0 }
  })
  const srt = [...secs].sort((a, b) => a.lvl - b.lvl)
  let acc = 0, ref = srt[0].lvl
  for (const s of srt) { acc += s.n; if (acc >= pts.length / 2) { ref = s.lvl; break } }
  for (const s of secs) {
    const d = ref - s.lvl, ad = Math.abs(d)
    const w = ad <= dbLo ? 0 : ad >= dbHi ? 1 : (ad - dbLo) / (dbHi - dbLo)
    s.corr = clamp(d * w, -maxCut, maxBoost)
  }
  // section borders: midway between the last point of one and the first of the next, moved into a
  // pause (>= 120 ms) within 600 ms of it when there is one, so a level change never lands mid-word
  const out: Section[] = secs.map((s, i) => ({ sB: i === 0 ? 0 : -1, eB: i === secs.length - 1 ? an.nb : -1, corr: s.corr, lvl: s.lvl, n: s.n }))
  const gaps = runs(an.act, 0).filter(([gs, ge]) => ge - gs >= 12).map(([gs, ge]) => (gs + ge) >> 1)
  for (let i = 0; i < out.length - 1; i++) {
    let mid = Math.round((pts[secs[i].i1 - 1].b + pts[secs[i + 1].i0].b) / 2)
    let bestGap: number | null = null
    for (const gc of gaps) if (Math.abs(gc - mid) <= 60 && (bestGap == null || Math.abs(gc - mid) < Math.abs(bestGap - mid))) bestGap = gc
    if (bestGap != null) mid = bestGap
    out[i].eB = mid; out[i + 1].sB = mid
  }
  return { sections: out, ref, pts: pts.length }
}

function gaussKernel(sigmaBlocks: number) {
  const R = Math.ceil(3 * sigmaBlocks), k = new Float64Array(2 * R + 1)
  for (let i = -R; i <= R; i++) k[i + R] = Math.exp(-0.5 * (i / sigmaBlocks) ** 2)
  return { k, R }
}
function convolve(x: Float64Array, { k, R }: { k: Float64Array; R: number }) {
  const y = new Float64Array(x.length)
  for (let i = 0; i < x.length; i++) {
    let s = 0
    const j0 = Math.max(-R, -i), j1 = Math.min(R, x.length - 1 - i)
    for (let j = j0; j <= j1; j++) s += x[i + j] * k[j + R]
    y[i] = s
  }
  return y
}

/**
 * A pause never gets more gain than the speech on either side of it (a lifted pause is a lifted room).
 * Exported for the tests; riderDb applies it.
 */
export function holdPauses(gain: Float64Array, act: ArrayLike<number>): Float64Array {
  const S = gain.length
  for (let s = 0; s < S;) {
    if (act[s]) { s++; continue }
    let e = s
    while (e < S && !act[e]) e++
    const edge = Math.min(s > 0 ? gain[s - 1] : Infinity, e < S ? gain[e] : Infinity)
    if (Number.isFinite(edge)) for (let t = s; t < e; t++) gain[t] = Math.min(gain[t], edge)
    s = e
  }
  return gain
}

export const RIDER = { sigmaS: 0.8, minWeightS: 0.25, maxBoost: 18, maxCut: -12, minS: 0.2, smoothS: 0.12, capPct: 0.98, deadLo: 2, deadHi: 4 }

/**
 * The rider: an offline, speech-gated fader. L(t) = Gaussian (sigma 0.8 s) speech-only loudness with
 * blocks capped at the P98 so one shout does not pull a whole sentence down; correction = ref - L(t)
 * through the 2..4 dB deadband, clamped to -12..+18 dB. Pauses take the lower neighbour, a running
 * minimum over +-0.2 s keeps a lift from starting before the quiet word does, then 0.12 s smoothing.
 * Measured: under 0.9 dB of motion per 100 ms, where every compressor-based leveller pumped.
 */
export function riderDb(an: Analysis, ref: number, o = RIDER): Float64Array {
  const S = an.nb, act = an.act
  const ap: number[] = []
  for (let s = 0; s < S; s++) if (act[s]) ap.push(an.kP[s])
  ap.sort((a, b) => a - b)
  const cap = ap.length ? ap[Math.floor(ap.length * o.capPct)] : Infinity
  const G = gaussKernel(o.sigmaS * BLOCKS_PER_S), E = new Float64Array(S), N = new Float64Array(S)
  for (let s = 0; s < S; s++) if (act[s]) { E[s] = Math.min(an.kP[s], cap); N[s] = 1 }
  const cE = convolve(E, G), cN = convolve(N, G)
  const minW = o.minWeightS * BLOCKS_PER_S * (G.k.reduce((a, v) => a + v, 0) / (2 * G.R + 1))
  const gain = new Float64Array(S).fill(NaN)
  for (let s = 0; s < S; s++) if (cN[s] > minW) {
    const Ls = -0.691 + 10 * Math.log10(Math.max(1e-14, cE[s] / cN[s])), c = ref - Ls, ac = Math.abs(c)
    const w = ac <= o.deadLo ? 0 : ac >= o.deadHi ? 1 : (ac - o.deadLo) / (o.deadHi - o.deadLo)
    gain[s] = clamp(c * w, o.maxCut, o.maxBoost)
  }
  // blocks without enough speech nearby take the lower of the previous and next valid value
  const prev = new Float64Array(S), next = new Float64Array(S)
  let last = NaN
  for (let s = 0; s < S; s++) { if (!Number.isNaN(gain[s])) last = gain[s]; prev[s] = last }
  last = NaN
  for (let s = S - 1; s >= 0; s--) { if (!Number.isNaN(gain[s])) last = gain[s]; next[s] = last }
  for (let s = 0; s < S; s++) if (Number.isNaN(gain[s])) {
    const a = prev[s], c = next[s]
    gain[s] = Number.isNaN(a) ? (Number.isNaN(c) ? 0 : c) : Number.isNaN(c) ? a : Math.min(a, c)
  }
  holdPauses(gain, act)
  const M = Math.round(o.minS * BLOCKS_PER_S), gm = new Float64Array(S)
  for (let s = 0; s < S; s++) {
    let m = Infinity
    for (let j = Math.max(0, s - M); j <= Math.min(S - 1, s + M); j++) if (gain[j] < m) m = gain[j]
    gm[s] = m
  }
  const Gs = gaussKernel(Math.max(1, o.smoothS * BLOCKS_PER_S))
  const num = convolve(gm, Gs), den = convolve(new Float64Array(S).fill(1), Gs)
  return Float64Array.from(num, (v, s) => v / den[s])
}

/** raised-cosine move of a block-dB array from a to b over [s, e) */
export function ramp(arr: Float64Array, s: number, e: number, a: number, b: number) {
  for (let k = Math.max(0, s); k < Math.min(arr.length, e); k++) {
    const f = (k - s) / Math.max(1, e - s)
    arr[k] = a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * f))
  }
}

export interface TransientEvent { t: number; durMs: number; depthDb: number }

/**
 * Knocks and claps: any block more than 6 dB over the speech peak reference (P99 of speech block
 * peaks + 1 dB) is dipped down to that reference, from one block before to one after, with a 30 ms
 * raised-cosine release. It runs BEFORE the compressor, so a knock no longer digs a 250 ms hole in
 * the words after it. Measured: 7 events on the knock file, about 10 dB each, none elsewhere.
 */
export function transientDipDb(an: { nb: number; act: ArrayLike<number>; pk: ArrayLike<number> }, o: { overDb?: number; marginDb?: number } = {}) {
  const over = o.overDb ?? 6
  const pdb = (b: number) => db(an.pk[b] * an.pk[b])
  const sp: number[] = []
  for (let b = 0; b < an.nb; b++) if (an.act[b]) sp.push(pdb(b))
  sp.sort((a, b) => a - b)
  const p99 = sp.length ? sp[Math.floor(sp.length * 0.99)] : -20
  const ref = p99 + (o.marginDb ?? 1)
  const d = new Float64Array(an.nb), events: TransientEvent[] = []
  for (let b = 0; b < an.nb; b++) {
    if (pdb(b) <= ref + over) continue
    let e = b
    while (e < an.nb && pdb(e) > ref + 1) e++
    let top = -140
    for (let k = b; k < e; k++) top = Math.max(top, pdb(k))
    const depth = top - ref
    events.push({ t: r2(b / BLOCKS_PER_S), durMs: (e - b) * 10, depthDb: r1(depth) })
    for (let k = Math.max(0, b - 1); k < Math.min(an.nb, e + 1); k++) d[k] = Math.min(d[k], -depth)
    ramp(d, e + 1, e + 4, -depth, 0)
    b = e
  }
  return { d, events, speechPeakP99Db: r1(p99) }
}

export const GAP_EASE = { minGapMs: 250, holdMs: 100, fallMs: 200, riseMs: 40, leadMs: 30, maxDb: 3 }

export interface GapEase { s: number; e: number; depthDb: number }

/**
 * Room ease in pauses of at least 250 ms: hold 100 ms after the last word, fall over 200 ms, rise
 * over 40 ms ending 30 ms before the next word. depthOf(s, e) says how far (eases under 1 dB are
 * skipped). At most 3 dB: on the phone file 6 dB bought 1.8 dB of room for 0.8 dB more wobble, and a
 * gated-sounding room is worse than a slightly higher one.
 */
export function gapEaseDb(an: { nb: number; act: ArrayLike<number> }, depthOf: number | ((s: number, e: number) => number), o: Partial<typeof GAP_EASE> = {}) {
  const P = { ...GAP_EASE, ...o }
  const minGap = Math.round(P.minGapMs / 10), hold = Math.round(P.holdMs / 10), fall = Math.round(P.fallMs / 10)
  const rise = Math.round(P.riseMs / 10), lead = Math.round(P.leadMs / 10)
  const d = new Float64Array(an.nb), eases: GapEase[] = []
  const depthFn = typeof depthOf === 'function' ? depthOf : () => depthOf
  for (const [s, e] of runs(an.act, 0)) {
    if (e - s < minGap) continue
    const depth = depthFn(s, e)
    if (!(depth >= 1)) continue
    const startFall = s === 0 ? 0 : s + hold, endRise = e === an.nb ? an.nb : e - lead
    const endFall = Math.min(startFall + fall, endRise - rise), startRise = Math.max(endRise - rise, endFall)
    if (endFall <= startFall) continue
    ramp(d, startFall, endFall, 0, -depth)
    d.fill(-depth, endFall, startRise)
    ramp(d, startRise, endRise, -depth, 0)
    if (s === 0) d.fill(-depth, 0, endFall)
    if (e === an.nb) d.fill(-depth, startRise, an.nb)
    eases.push({ s: s / BLOCKS_PER_S, e: e / BLOCKS_PER_S, depthDb: r1(depth) })
  }
  return { d, eases }
}

/** depth for one pause: how far the room in it would sit over ROOM_TARGET_DBFS after the lift, clamped to [0, max] */
export function gapEaseDepth(pauseLevelDb: number, gainDb: number, maxDb = GAP_EASE.maxDb) {
  return clamp(pauseLevelDb + gainDb + EXPECTED_MAKEUP_DB - ROOM_TARGET_DBFS, 0, maxDb)
}

/**
 * Noise reduction amount: only as much as the room would sit above ROOM_TARGET_DBFS after the lift
 * (excess), never more than the worst local speech-to-room minus 12 dB (cleaning deeper than the
 * quietest words eats them) and never more than 18 dB; under 3 dB it is not worth running.
 * nf = floor + 6: the old fixed nf=-25 told the denoiser the room was at -25 dBFS and it ate quiet speech.
 */
export function nrDecision(a: { floorDb: number; I: number; boost0?: number; worstSnr: number }) {
  const excessDb = a.floorDb + (TARGET_LUFS - a.I) + (a.boost0 || 0) + EXPECTED_MAKEUP_DB - ROOM_TARGET_DBFS
  const capDb = Math.max(0, Math.min(18, a.worstSnr - 12))
  const want = Math.min(capDb, excessDb)
  return { nrDb: want >= 3 ? Math.round(want) : 0, nf: clamp(Math.round(a.floorDb + 6), -80, -20), excessDb: r1(excessDb), capDb: r1(capDb) }
}

/** The noise print: the longest pause of at least 0.4 s, inset 100 ms at both ends, at most 2 s (seconds). */
export function noisePrint(act: ArrayLike<number>): { s: number; e: number } | null {
  let best: Run | null = null
  for (const r of runs(act, 0)) if (r[1] - r[0] >= 40 && (!best || r[1] - r[0] > best[1] - best[0])) best = r
  if (!best) return null
  const [gs, ge] = best
  return { s: (gs + 10) / BLOCKS_PER_S, e: Math.min(ge - 10, gs + 10 + 200) / BLOCKS_PER_S }
}

export interface Decisions {
  version: number
  preset: Preset
  /** what actually runs: guards turn Studio into Light (little speech) or Off (no clear speech) */
  effective: Preset
  skipped: string | null
  sparse: boolean
  channel: ChannelMode
  foldLossDb: number
  nrDb: number; nf: number
  print: { s: number; e: number } | null
  riderOn: boolean
  /** non-zero section corrections, dB */
  sections: number[]
  staticDb: number
  staticCapped: boolean
  transients: TransientEvent[]
  gapEases: GapEase[]
  /** total gain per 10 ms block (dB): static + rider + transient dips + gap eases */
  envelopeDb: Float64Array
  /** the analysis the plan was made from */
  measured: { I: number; floorDb: number; speechDb: number; snr: number; activeS: number; durS: number; worstSnr: number }
}

const measuredOf = (an: Analysis) => ({ I: r2(an.I), floorDb: r1(an.floorDb), speechDb: r1(an.speechDb), snr: r1(an.snr), activeS: r1(an.activeS), durS: r2(an.durS), worstSnr: r1(an.worstSnr) })

/**
 * The plan for one recording. Without `prior` it is the whole plan, made from the source (channel,
 * guards, NR, and a first gain plan). The bake then runs the channel + NR pass, measures again (the
 * floor moved) and calls decide(after, preset, { prior }) to re-plan only the gain stages on what
 * the compressor will really see.
 */
export function decide(an: Analysis | SourceAnalysis, preset: Preset, opts: { prior?: Decisions } = {}): Decisions {
  const prior = opts.prior
  const base = {
    version: CHAIN_VERSION, preset, sparse: false, channel: 'asis' as ChannelMode, foldLossDb: 0, nrDb: 0, nf: 0, print: null,
    riderOn: false, sections: [], staticDb: 0, staticCapped: false, transients: [], gapEases: [], envelopeDb: new Float64Array(an.nb),
  }
  if (preset === 'off') return { ...base, effective: 'off', skipped: null, measured: measuredOf(an) }
  let view: Analysis = an, channel: ChannelMode = 'asis', foldLossDb = 0
  if (prior) {
    channel = prior.channel; foldLossDb = prior.foldLossDb
  } else if ('channel' in an && an.channel) {
    channel = decideChannel(an.channel); foldLossDb = r2(an.channel.foldLossDb)
    view = viewAnalysis(an as SourceAnalysis, channel)
  }
  // guards: nothing to fix (room tone only would be lifted +43 dB), or too little speech to plan from
  const snrI = view.I - view.floorDb
  const skipped = prior ? prior.skipped
    : view.activeS < 1 || snrI < 10 || !Number.isFinite(view.I) || view.I < -69
      ? `no clear speech (${r1(view.activeS)} s of speech, ${r1(snrI)} dB over the room)` : null
  if (skipped) return { ...base, channel, foldLossDb, effective: 'off', skipped, measured: prior ? prior.measured : measuredOf(view) }
  const sparse = prior ? prior.sparse : view.activeS < 5 || view.activeS / Math.max(0.01, view.durS) < 0.25
  const effective: Preset = prior ? prior.effective : preset === 'light' || sparse ? 'light' : 'studio'
  const studio = effective === 'studio'
  let nrDb = 0, nf = 0, print: { s: number; e: number } | null = null
  if (prior) { nrDb = prior.nrDb; nf = prior.nf; print = prior.print }
  else if (studio) {
    const sec0 = levelSections(view)
    const on0 = sec0.sections.some((x) => Math.abs(x.corr) >= 1.5)
    const boost0 = on0 ? Math.max(0, ...sec0.sections.map((x) => x.corr)) : 0
    print = noisePrint(view.act)
    if (print) ({ nrDb, nf } = nrDecision({ floorDb: view.floorDb, I: view.I, boost0, worstSnr: view.worstSnr }))
    if (!nrDb) { nf = 0; print = null }
  }
  // gain stages, on what the compressor will see
  const nb = view.nb
  let lev: Float64Array = new Float64Array(nb), riderOn = false, sections: number[] = []
  if (studio) {
    const sec = levelSections(view)
    riderOn = sec.sections.some((x) => Math.abs(x.corr) >= 1.5)
    if (riderOn) { lev = riderDb(view, sec.ref); sections = sec.sections.map((x) => r1(x.corr)).filter((x) => x !== 0) }
  }
  let staticDb = TARGET_LUFS - integratedLufs(view.kP, riderOn ? lev : undefined)
  const staticCapped = staticDb > MAX_STATIC_DB
  if (staticCapped) staticDb = MAX_STATIC_DB
  const pkG = new Float64Array(nb)
  for (let b = 0; b < nb; b++) pkG[b] = view.pk[b] * 10 ** ((staticDb + lev[b]) / 20)
  const tr = transientDipDb({ nb, act: view.act, pk: pkG })
  let gap = { d: new Float64Array(nb), eases: [] as GapEase[] }
  if (studio) gap = gapEaseDb(view, (s, e) => {
    const w: number[] = []
    for (let b = s + 5; b < e - 15; b++) if (b < view.u100db.length) w.push(view.u100db[b])
    w.sort((x, y) => x - y)
    const lvl = w.length ? w[Math.floor(w.length * 0.5)] : view.floorDb
    return gapEaseDepth(lvl, staticDb + lev[Math.min(nb - 1, (s + e) >> 1)])
  })
  const envelopeDb = new Float64Array(nb)
  for (let b = 0; b < nb; b++) envelopeDb[b] = staticDb + lev[b] + tr.d[b] + gap.d[b]
  return {
    version: CHAIN_VERSION, preset, effective, skipped: null, sparse, channel, foldLossDb, nrDb, nf, print,
    riderOn, sections, staticDb: r2(staticDb), staticCapped, transients: tr.events, gapEases: gap.eases, envelopeDb,
    measured: prior ? prior.measured : measuredOf(view),
  }
}

/** Decisions without the per-block envelope, for JSON and the renderer. */
export function decisionsJson(d: Decisions) {
  const { envelopeDb, ...rest } = d
  let min = 0, max = 0
  if (envelopeDb.length) { min = Infinity; max = -Infinity; for (const v of envelopeDb) { if (v < min) min = v; if (v > max) max = v } }
  return { ...rest, envelope: { minDb: r1(min), maxDb: r1(max), blocks: envelopeDb.length } }
}

/** The one line under a clip: what the fix did, in words a non-expert can read. */
export function summaryLine(d: Pick<Decisions, 'effective' | 'skipped' | 'sparse' | 'riderOn' | 'sections' | 'staticDb' | 'nrDb' | 'transients'>): string {
  if (d.skipped) return 'No clear speech, left as is'
  if (d.effective === 'off') return 'Fix voice is off, left as recorded'
  const parts: string[] = []
  const levelled = d.riderOn ? d.sections.filter((x) => Math.abs(x) >= 1.5) : []
  if (levelled.length) {
    const top = levelled.reduce((a, x) => (Math.abs(x) > Math.abs(a) ? x : a), 0)
    parts.push(`levelled ${levelled.length} section${levelled.length > 1 ? 's' : ''}, up to ${top > 0 ? '+' : ''}${Math.round(top)} dB`)
  }
  if (d.staticDb >= 1) parts.push(`lifted ${Math.round(d.staticDb)} dB`)
  else if (d.staticDb <= -1) parts.push(`turned down ${Math.round(-d.staticDb)} dB`)
  if (d.nrDb > 0) parts.push(`cleaned ${d.nrDb} dB of room noise`)
  if (d.transients.length) parts.push(`tamed ${d.transients.length} knock${d.transients.length > 1 ? 's' : ''}`)
  if (!parts.length) parts.push('the level was already right')
  const line = parts.join(', ')
  return line[0].toUpperCase() + line.slice(1) + (d.sparse ? ' (little speech, so Light rules)' : '')
}

/** Speech segments in seconds: the VAD's runs with its 50 ms pre-roll and 150 ms hangover taken back off (what the duck keys from). */
export function speechSegments(an: { act: ArrayLike<number>; nb: number }): [number, number][] {
  return runs(an.act, 1).map(([s, e]): [number, number] => {
    const s0 = s === 0 ? 0 : s + VAD_MORPH.pre, e0 = e === an.nb ? an.nb : e - VAD_MORPH.post
    return [r2(s0 / BLOCKS_PER_S), r2(Math.max(s0, e0) / BLOCKS_PER_S)]
  })
}

/** The headline numbers of an analysis (IPC replies and the bake's JSON). */
export function analysisSummary(an: Analysis) {
  const pauses = runs(an.act, 0).filter(([s, e]) => e - s >= 40)
  return {
    durationS: r2(an.durS), I: r2(an.I), floorDb: r1(an.floorDb), speechDb: r1(an.speechDb), snr: r1(an.snr),
    activeS: r1(an.activeS), speechFraction: r2(an.activeS / Math.max(0.01, an.durS)), worstSnr: r1(an.worstSnr),
    longestPauseS: r2(pauses.reduce((m, [s, e]) => Math.max(m, (e - s) / BLOCKS_PER_S), 0)),
    momentaryMaxLufs: r1(an.momentaryMaxLufs), spreadDb: r2(an.spreadDb),
  }
}

// ------------------------------------------------------------------ envelope

/** Per-sample linear gain from per-block dB, linearly interpolated (in dB) between 10 ms block centres. */
export function gainSampler(dbBlocks: ArrayLike<number>, sr = SR) {
  const BLK = sr / BLOCKS_PER_S, last = dbBlocks.length - 1
  return (i: number) => {
    if (last < 0) return 1
    const t = i / BLK - 0.5
    const b = clamp(Math.floor(t), 0, last), b2 = Math.min(last, b + 1), f = clamp(t - b, 0, 1)
    return 10 ** ((dbBlocks[b] * (1 - f) + dbBlocks[b2] * f) / 20)
  }
}

export function envelopeFromBlocks(dbBlocks: ArrayLike<number>, n: number, sr = SR): Float32Array {
  const g = gainSampler(dbBlocks, sr), out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = g(i)
  return out
}

/**
 * The envelope as an IEEE-float WAV (`amultiply`'s second input), written in chunks so ten minutes
 * of gain never sits in memory. `write` may return a promise (stream backpressure).
 */
export async function writeGainWav(write: (chunk: Uint8Array) => unknown, envelopeDb: ArrayLike<number>, n: number, o: { sr?: number; channels?: number; chunkFrames?: number } = {}) {
  const sr = o.sr ?? SR, ch = o.channels ?? 2, chunk = o.chunkFrames ?? 48000
  const bytes = n * ch * 4
  // past 4 GB a RIFF size cannot be written; 0xFFFFFFFF reads as "to the end of the file"
  const size = (v: number) => (v > 0xffffffff ? 0xffffffff : v)
  const h = new Uint8Array(44), dv = new DataView(h.buffer)
  const tag = (at: number, s: string) => { for (let i = 0; i < 4; i++) h[at + i] = s.charCodeAt(i) }
  tag(0, 'RIFF'); dv.setUint32(4, size(36 + bytes), true); tag(8, 'WAVE'); tag(12, 'fmt ')
  dv.setUint32(16, 16, true); dv.setUint16(20, 3, true); dv.setUint16(22, ch, true); dv.setUint32(24, sr, true)
  dv.setUint32(28, sr * ch * 4, true); dv.setUint16(32, ch * 4, true); dv.setUint16(34, 32, true)
  tag(36, 'data'); dv.setUint32(40, size(bytes), true)
  await write(h)
  const g = gainSampler(envelopeDb, sr)
  for (let i0 = 0; i0 < n; i0 += chunk) {
    const m = Math.min(chunk, n - i0), f = new Float32Array(m * ch)
    for (let i = 0; i < m; i++) { const v = g(i0 + i); for (let c = 0; c < ch; c++) f[i * ch + c] = v }
    await write(new Uint8Array(f.buffer))
  }
}

// ------------------------------------------------------------------ ffmpeg graph builders

/**
 * Always first, even for Off: fixes 44.1 kHz input landing early and mono input landing hot, and the
 * s32 high-pass overshoot clip. first_pts=0 anchors sample 0 to the media's own time zero: an audio
 * stream that starts after the picture (phones and cameras do, by 20 to 250 ms, AAC priming included)
 * is padded rather than slid forward, so a bake addressed with -ss sourceStart stays on the lips.
 */
export const headFilter = () => 'aresample=48000:first_pts=0,aformat=sample_fmts=flt:channel_layouts=stereo'
/**
 * Rumble and handling only. 70 Hz is what the reference chain measured with; 80 Hz took 0.6 dB more
 * from the band under 80 Hz in speech and raised the gain-track step on clean speech from 1.19 to
 * 1.38 dB, for no audible gain.
 */
export const HPF = 'highpass=f=70:p=2'

export function panFilter(channel: ChannelMode): string {
  if (channel === 'fold') return 'pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1'
  if (channel === 'left') return 'pan=stereo|c0=c0|c1=c0'
  if (channel === 'right') return 'pan=stereo|c0=c1|c1=c1'
  return ''
}

const f3 = (x: number) => x.toFixed(3)

/**
 * Learned-print noise reduction, appended to a chain: the print (the longest pause) is played
 * ahead of the recording so afftdn learns THIS room (asendcmd sn start/stop), then the print and
 * afftdn's 25 ms of latency are trimmed off together, so the output lines up sample for sample.
 * gs=16 smooths the gains (musical noise 0.98 vs 1.35 at 0). Never tn=1 with a learned print, and
 * never a fixed nf: nf is floor + 6.
 */
export function nrGraph(o: { print: { s: number; e: number }; nrDb: number; nf: number; sr?: number }): string {
  const sr = o.sr ?? SR, lat = AFFTDN_LATENCY(sr)
  const s = f3(o.print.s), e = f3(o.print.e), len = +e - +s
  return `asplit=2[f][p];[p]atrim=${s}:${e},asetpts=PTS-STARTPTS[n];[f]asetpts=PTS-STARTPTS[f2];` +
    `[n][f2]concat=n=2:v=0:a=1,${HPF},apad=pad_len=${lat},` +
    `asendcmd=c='0.02 afftdn sn start;${f3(len - 0.02)} afftdn sn stop',afftdn=nr=${o.nrDb}:nf=${o.nf}:tn=0:gs=16,` +
    `atrim=start_sample=${Math.round(len * sr) + lat},asetpts=PTS-STARTPTS`
}

/** Pass A: head, channel, then NR (which carries its own high-pass) or the plain high-pass. Input [0:a], output [o]. */
export function passAGraph(d: Pick<Decisions, 'channel' | 'nrDb' | 'nf' | 'print'>): string {
  const pan = panFilter(d.channel)
  const pre = `[0:a]${headFilter()},asetpts=PTS-STARTPTS${pan ? ',' + pan : ''}`
  if (d.nrDb > 0 && d.print) return `${pre},${nrGraph({ print: d.print, nrDb: d.nrDb, nf: d.nf })}[o]`
  return `${pre},${HPF}[o]`
}

/**
 * 2:1 with the threshold AT the working level, so it only touches stressed syllables (measured
 * gain reduction median 1.1 to 2.0 dB). attack=80 / release=1000 are real 20 / 250 ms (FF_TC_DIVISOR);
 * knee=4 is a +-6 dB soft knee in amplitude. makeup stays 1: it is a LINEAR factor (makeup=3 was +9.5 dB)
 * and the make-up is measured afterwards instead.
 */
export const compressorFilter = () => 'acompressor=threshold=-16dB:ratio=2:attack=80:release=1000:knee=4:detection=rms:link=average:makeup=1'

/**
 * Lookahead limiter, oversampled so the TRUE peak holds (a 48 kHz alimiter let 1.7 dB of
 * inter-sample peaks through). level=disabled stops it normalising; latency=1 removes its delay.
 */
export function limiterFilter(ceilDb = CEILING_DBFS, releaseMs = 60, oversample = 4): string {
  const lim = `alimiter=limit=${(10 ** (ceilDb / 20)).toFixed(5)}:attack=1.5:release=${releaseMs}:level=disabled:latency=1`
  return oversample > 1 ? `aresample=${SR * oversample},${lim},aresample=${SR}` : lim
}

export const makeupLimiterFilter = (makeupDb: number) => `volume=${makeupDb.toFixed(2)}dB,${limiterFilter(CEILING_DBFS)}`

/** Pass B: [0:a] (pass A) x [1:a] (gain WAV), then the compressor; output [o]. Measured to set the make-up. */
export const passBGraph = () => `[0:a][1:a]amultiply,${compressorFilter()}[o]`

/** Pass D: pass B again plus make-up and the ceiling; [o] is the bake, [m] a measured copy (ebur128 for the true peak). */
export const passDGraph = (makeupDb: number) =>
  `[0:a][1:a]amultiply,${compressorFilter()},${makeupLimiterFilter(makeupDb)},asplit=2[o][m0];[m0]ebur128=peak=true:dualmono=true:framelog=quiet[m]`

/** 4th-order 20 kHz Butterworth before the master limiter: without it the AAC encode of a knock overshot to +0.1 dBTP. */
export const LOWPASS_20K = 'lowpass=f=20000:p=2:t=q:w=0.5412,lowpass=f=20000:p=2:t=q:w=1.3066'

/** The master: a measured linear gain to the target, the 20 kHz lowpass, a true-peak ceiling. No compressor (it re-pumps the ducked bed). */
export const masterGraph = (gainDb: number, ceilDb = MASTER_CEILING_DBFS) => `volume=${gainDb.toFixed(2)}dB,${LOWPASS_20K},${limiterFilter(ceilDb)}`

/** "Optimize loudness" off: the user's master volume and a -1 dBTP safety ceiling only. */
export const safetyGraph = (masterVolume: number) => `volume=${masterVolume},${limiterFilter(-1)}`

/** Bus limiter (48 kHz, fast): catches drum hits in music-only stretches and stacked SFX under speech. */
export const busLimiter = (ceilDb: number, releaseMs: number) => `alimiter=limit=${(10 ** (ceilDb / 20)).toFixed(4)}:attack=1:release=${releaseMs}:level=disabled:latency=1`

// ------------------------------------------------------------------ ducking, buses, roles

export interface Trapezoid { a0: number; a1: number; b0: number; b1: number; depthDb: number }
export const DUCK = { depth: 10, lead: 0.08, attackRamp: 0.2, hold: 0.15, releaseRamp: 0.3, mergeGap: 1.2 }
export const SFX_DUCK = { ...DUCK, depth: 6 }
/** The bed sits this far under the voice target. */
export const BED_UNDER_VOICE_LU = 5

/** Sorted segments merged across gaps shorter than `gap` seconds. */
export function mergeSegments(segs: [number, number][], gap: number): [number, number][] {
  const out: [number, number][] = []
  for (const [s, e] of [...segs].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1]
    if (last && s - last[1] < gap) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/** Every voice clip's speech, one list: overlapping or touching segments become one. */
export const unionSegments = (lists: [number, number][][]) => mergeSegments(lists.flat(), 1e-9)

/** Source-time segments of a clip's media onto the timeline, clipped to the clip's window. */
export function mapSegmentsToTimeline(segs: [number, number][], clip: { start: number; duration: number; sourceStart?: number }): [number, number][] {
  const ss = clip.sourceStart || 0, end = clip.start + clip.duration, out: [number, number][] = []
  for (const [s, e] of segs) {
    const t0 = Math.max(clip.start, clip.start + (s - ss)), t1 = Math.min(end, clip.start + (e - ss))
    if (t1 > t0) out.push([t0, t1])
  }
  return out
}

/**
 * Speech segments to duck trapezoids: fully down 80 ms BEFORE the first syllable after a 200 ms
 * dB-linear ramp (a sidechain cannot anticipate, so with sidechaincompress the first word landed on
 * full-level music), 150 ms hold, 300 ms release. Pauses shorter than mergeGap (and never shorter
 * than the trapezoid's own corners) stay ducked, so the bed does not swell in a breath.
 */
export function duckTraps(segs: [number, number][], o: Partial<typeof DUCK> = {}): Trapezoid[] {
  const v = { ...DUCK, ...o }
  const span = v.lead + v.attackRamp + v.hold + v.releaseRamp
  return mergeSegments(segs, Math.max(v.mergeGap, span)).map(([s, e]) => ({
    a0: s - v.lead - v.attackRamp, a1: s - v.lead, b0: e + v.hold, b1: e + v.hold + v.releaseRamp, depthDb: v.depth,
  }))
}

const tMinus = (x: number) => (x >= 0 ? `t-${f3(x)}` : `t+${f3(-x)}`)

/**
 * The trapezoids as one flat ffmpeg expression, dB-linear ramps summed: a 200-segment timeline
 * stays one short expression. Put `asetnsamples=n=48:p=0` before the eval=frame volume so it steps
 * every 1 ms (0.48 dB of error on these ramps at 480 samples, under 0.05 dB at 48).
 */
export function trapezoidExpr(traps: Trapezoid[], baseDb = 0): string {
  const terms = traps.map((t) =>
    `-${t.depthDb.toFixed(2)}*clip((${tMinus(t.a0)})/${f3(Math.max(0.001, t.a1 - t.a0))},0,1)*clip((${f3(t.b1)}-t)/${f3(Math.max(0.001, t.b1 - t.b0))},0,1)`)
  return `pow(10,(${baseDb.toFixed(2)}${terms.join('')})/20)`
}

/**
 * The same envelope as trapezoidExpr, written as a binary search on t. duckTraps never lets two
 * trapezoids overlap (a pause short enough to overlap them is merged), so at any moment at most one
 * is active, and ffmpeg's if() evaluates only the branch it takes: a frame costs about log2(n)
 * comparisons and one term. The flat sum evaluates every term on every 1 ms frame, which measured
 * 19 s per bus on a 10-minute timeline with 200 ducks; this form, 0.5 s. Overlapping trapezoids
 * (hand-made ones) fall back to the flat sum, which is right for any input.
 */
export function trapezoidTreeExpr(traps: Trapezoid[], baseDb = 0): string {
  const ts = [...traps].sort((a, b) => a.a0 - b.a0)
  if (ts.length < 3 || ts.some((t, i) => i > 0 && t.a0 < ts[i - 1].b1)) return trapezoidExpr(traps, baseDb)
  const term = (t: Trapezoid) =>
    `-${t.depthDb.toFixed(2)}*clip((${tMinus(t.a0)})/${f3(Math.max(0.001, t.a1 - t.a0))},0,1)*clip((${f3(t.b1)}-t)/${f3(Math.max(0.001, t.b1 - t.b0))},0,1)`
  // before ts[m].a0 nothing from m on has started; from it on, everything before m has ended
  const node = (lo: number, hi: number): string => {
    if (hi - lo === 1) return term(ts[lo])
    const m = (lo + hi) >> 1
    return `if(lt(t,${f3(ts[m].a0)}),${node(lo, m)},${node(m, hi)})`
  }
  return `pow(10,(${baseDb.toFixed(2)}+${node(0, ts.length)})/20)`
}

/** The same envelope evaluated in JS (dB): the preview's GainNode curve and the parity tests. */
export function evalTrapezoidsDb(traps: Trapezoid[], t: number, baseDb = 0): number {
  let v = baseDb
  for (const p of traps) v -= p.depthDb * clamp((t - p.a0) / Math.max(0.001, p.a1 - p.a0), 0, 1) * clamp((p.b1 - t) / Math.max(0.001, p.b1 - p.b0), 0, 1)
  return v
}

/** The bed level for a music file: BED_UNDER_VOICE_LU under the voice target. */
export const bedDb = (musicI: number, underLu = BED_UNDER_VOICE_LU) => TARGET_LUFS - underLu - musicI
/** An SFX's loudest moment lands at the voice level. */
export const sfxDb = (momentaryMaxLufs: number) => TARGET_LUFS - momentaryMaxLufs

function busGraph(inputs: string[], gainDb: number, traps: Trapezoid[], duck: boolean, limiter: string, out: string, tag: string) {
  // the clips are already delayed to their timeline starts; `longest` so a short first clip does not end the bus
  const head = inputs.length === 1 ? `[${inputs[0]}]` : `${inputs.map((l) => `[${l}]`).join('')}amix=inputs=${inputs.length}:normalize=0:duration=longest[${tag}raw];[${tag}raw]`
  const duckExpr = duck && traps.length ? `,volume='${trapezoidTreeExpr(traps)}':eval=frame` : ''
  return `${head}volume=${gainDb.toFixed(2)}dB,asetnsamples=n=48:p=0${duckExpr},${limiter}[${out}]`
}

/** Music bus: level-set to the bed, ducked 10 dB under speech, a -6 dBFS limiter for drum hits in music-only stretches. */
export const musicBusGraph = (o: { inputs: string[]; bedDb: number; traps: Trapezoid[]; duck?: boolean; out?: string }) =>
  busGraph(o.inputs, o.bedDb, o.traps, o.duck !== false, busLimiter(-6, 80), o.out || 'mbus', 'm')

/** SFX bus: level-set, ducked 6 dB, a -3.4 dBFS ceiling so a whoosh under speech cannot push the sum past the master's linear window. */
export const sfxBusGraph = (o: { inputs: string[]; gainDb: number; traps: Trapezoid[]; duck?: boolean; out?: string }) =>
  busGraph(o.inputs, o.gainDb, o.traps, o.duck !== false, busLimiter(-3.4, 60), o.out || 'sbus', 's')

export type Provenance = 'booth' | 'narration' | 'voiceclone' | 'voiceover' | 'score' | 'sfx' | 'import' | 'camera'

/**
 * What a clip's sound is, guessed. Where it came from wins (the booth records voice, make_score
 * writes music); then the measurement: speech pauses (>= 0.4 s), speech 25 to 92 percent of the time
 * and 400 ms loudness that moves (>= 2 dB) is a voice. Anything else on a video is left As is: a
 * camera clip with music under the talking (premixed) processed as voice pumped 6.2 dB.
 */
export function roleGuess(an: Analysis | null, ctx: { provenance?: Provenance; isVideo?: boolean; track?: string } = {}): { role: Role; why: string } {
  const p = ctx.provenance
  if (p === 'booth' || p === 'narration' || p === 'voiceclone' || p === 'voiceover') return { role: 'voice', why: `recorded as ${p}` }
  if (p === 'score') return { role: 'music', why: 'made by make_score' }
  if (p === 'sfx') return { role: 'sfx', why: 'from the sound library' }
  if (ctx.track === 'a2') return { role: 'sfx', why: 'on the SFX track' }
  if (!an) return { role: ctx.isVideo ? 'asis' : 'music', why: 'not measured' }
  const pauses = runs(an.act, 0).filter(([s, e]) => e - s >= 40).length
  const frac = an.activeS / Math.max(0.01, an.durS)
  if (pauses > 0 && frac >= 0.25 && frac <= 0.92 && an.spreadDb >= 2) return { role: 'voice', why: `speech ${Math.round(frac * 100)} percent of the time, with pauses` }
  if (ctx.isVideo) return { role: 'asis', why: pauses ? 'not speech-like, left as recorded' : 'continuous sound under the picture, left as recorded' }
  return { role: 'music', why: pauses ? 'not speech-like' : 'continuous, no pauses' }
}

/** Where an export lands unless another platform is picked (YouTube, and what Watch & Verify judges a file from elsewhere by). */
export const LOUDNESS_TARGET = -14
export interface PlatformTarget { id: string; label: string; lufs: number; maxTruePeak: number; ceilingDbtp: number }
const TARGETS: PlatformTarget[] = [
  { id: 'youtube', label: 'YouTube and social (-14 LUFS)', lufs: LOUDNESS_TARGET, maxTruePeak: -1, ceilingDbtp: MASTER_CEILING_DBFS },
  { id: 'podcast', label: 'Podcast (-16 LUFS)', lufs: -16, maxTruePeak: -1, ceilingDbtp: MASTER_CEILING_DBFS },
  { id: 'broadcast', label: 'Broadcast R128 (-23 LUFS)', lufs: -23, maxTruePeak: -1, ceilingDbtp: MASTER_CEILING_DBFS },
  { id: 'audiobook', label: 'Audiobook (-20 LUFS)', lufs: -20, maxTruePeak: -1, ceilingDbtp: MASTER_CEILING_DBFS },
]
const TARGET_ALIASES: Record<string, string> = {
  youtube: 'youtube', vimeo: 'youtube', instagram: 'youtube', tiktok: 'youtube', facebook: 'youtube', social: 'youtube',
  podcast: 'podcast', 'apple podcasts': 'podcast', spotify: 'podcast',
  broadcast: 'broadcast', r128: 'broadcast', ebu: 'broadcast',
  audiobook: 'audiobook', audible: 'audiobook', amazon: 'audiobook', acx: 'audiobook',
}
/** Loudness target by platform name; anything unknown is YouTube's -14. */
export function platformTarget(name?: string | null): PlatformTarget {
  const id = TARGET_ALIASES[String(name || '').trim().toLowerCase()] || 'youtube'
  return TARGETS.find((t) => t.id === id)!
}
export const PLATFORM_TARGETS = TARGETS

/**
 * Sample-exact port of ffmpeg's acompressor (af_sidechaincompress.c, downward), so the SAME kernel
 * can run in an AudioWorklet for a live Light preview. Parameters are ffmpeg's: attack/release in
 * its "ms" (real tau = value / FF_TC_DIVISOR). Processes planar channels in place, any block size.
 */
export function makeCompressor(o: { thrDb: number; ratio?: number; attack?: number; release?: number; knee?: number; makeupDb?: number; rms?: boolean; sr?: number }) {
  const ratio = o.ratio ?? 2, attack = o.attack ?? 80, release = o.release ?? 1000, knee = o.knee ?? 4
  const rms = o.rms !== false, sr = o.sr ?? SR
  const threshold = 10 ** (o.thrDb / 20), makeup = 10 ** ((o.makeupDb ?? 0) / 20)
  const thres = Math.log(threshold)
  const linKneeStart = threshold / Math.sqrt(knee), linKneeStop = threshold * Math.sqrt(knee)
  const adjKneeStart = linKneeStart * linKneeStart
  const kneeStart = Math.log(linKneeStart), kneeStop = Math.log(linKneeStop)
  const compressedKneeStop = (kneeStop - thres) / ratio + thres
  const attackCoeff = Math.min(1, 1 / (attack * sr / 4000)), releaseCoeff = Math.min(1, 1 / (release * sr / 4000))
  const delta = 1 / ratio
  let linSlope = 0
  const hermite = (x: number, x0: number, x1: number, p0: number, p1: number, m0: number, m1: number) => {
    const width = x1 - x0, t = (x - x0) / width
    m0 *= width; m1 *= width
    const t2 = t * t, t3 = t2 * t
    return (2 * p0 + m0 - 2 * p1 + m1) * t3 + (-3 * p0 - 2 * m0 + 3 * p1 - m1) * t2 + m0 * t + p0
  }
  const outputGain = (ls: number) => {
    let slope = Math.log(ls)
    if (rms) slope *= 0.5
    let gain = (slope - thres) / ratio + thres
    if (knee > 1 && slope < kneeStop) gain = hermite(slope, kneeStart, kneeStop, kneeStart, compressedKneeStop, 1, delta)
    return Math.exp(gain - slope)
  }
  return function process(chs: Float32Array[] | Float64Array[]) {
    const n = chs[0].length, nc = chs.length
    for (let i = 0; i < n; i++) {
      let a = 0
      for (let c = 0; c < nc; c++) a += Math.abs(chs[c][i])
      a /= nc
      if (rms) a *= a
      linSlope += (a - linSlope) * (a > linSlope ? attackCoeff : releaseCoeff)
      let g = 1
      if (linSlope > 0 && linSlope > (rms ? adjKneeStart : linKneeStart)) g = outputGain(linSlope)
      const k = g * makeup
      for (let c = 0; c < nc; c++) chs[c][i] *= k
    }
  }
}
