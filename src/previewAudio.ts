/* The preview's sound, mixed the way the export mixes it (electron/audiomix.ts), so what plays while
 * editing is what the export will sound like.
 *
 *   element -> source -> clip gain -> bus gain -> master gain -> safety -> trim -> speakers
 *                                                                               \-> K-weighted meter
 *
 * The parity comes from two places. The DSP that WebAudio cannot do (the Fix voice noise reduction,
 * levelling and compression) is not re-implemented: the preview plays the BAKED file, the same file
 * the export reads. Everything else is a gain, and a gain WebAudio reproduces exactly: the clip's own
 * volume, automation and de-pop ramps, the bed and SFX levels, the keyframe ducks (scheduled as a
 * 1 ms curve) and the measured master gain. el.volume stays 1; it clamps at 1.0, which is why a
 * quiet clip could never be rescued in the preview and a +2 dB master could not be heard.
 *
 * What still differs, by construction: the bus limiters and the master's true-peak ceiling (they act
 * on the rare peak; the safety stage below stands in), and the AAC of the re-muxed preview copy.
 *
 * The planning functions are pure and tested in scripts/previewaudio.test.mjs; only PreviewMixer
 * touches WebAudio.
 */
import { DEPOP_S } from '../electron/exportgraph'
import { MAX_STATIC_DB, TARGET_LUFS, evalTrapezoidsDb, kWeighting, type Preset, type Role, type Trapezoid } from '../electron/audiochain'
import { audibleClips, busOf, duckPlan, isPreset, planMaster, resolveRole, roleLevelDb, type Bus, type MixTuning, type SoundFacts } from '../electron/audiomix'

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
export const dbToGain = (db: number) => (db <= -120 ? 0 : 10 ** (db / 20))
/** A gain as people read it: "−6.0 dB", "0.0 dB", "−inf dB" for silence (the stored value stays linear). */
export const dbLabel = (v: number) => {
  if (!(v > 0.001)) return '−inf dB'
  const d = Math.round(20 * Math.log10(v) * 10) / 10
  return `${d < 0 ? '−' : ''}${Math.abs(d).toFixed(1)} dB`
}

// ------------------------------------------------------------------ the clip's own gain

/**
 * The clip's audio ramps at time t, as the export's two afade filters apply them (clipAudioChain):
 * the fade-in ramp TIMES the fade-out ramp, so a short clip whose fades overlap dips the way the
 * export does. Audio-only ramps (aFadeIn/aFadeOut) win over the picture fades, and every splice gets
 * at least DEPOP_S: an end always, a start that is not the file's own beginning.
 */
export function audioFadeFactor(c: { start: number; duration: number; fadeIn: number; fadeOut: number; aFadeIn?: number; aFadeOut?: number; sourceStart?: number }, t: number) {
  const fadeIn = Math.max(c.aFadeIn ?? c.fadeIn ?? 0, (Number(c.sourceStart) || 0) > 0 ? DEPOP_S : 0)
  const fadeOut = Math.max(c.aFadeOut ?? c.fadeOut ?? 0, DEPOP_S)
  const end = c.start + c.duration
  const up = fadeIn > 0 ? clamp((t - c.start) / fadeIn, 0, 1) : t >= c.start ? 1 : 0
  const down = fadeOut > 0 ? clamp((end - t) / fadeOut, 0, 1) : t < end ? 1 : 0
  return up * down
}

type Point = { t: number; v: number }
/** The clip's volume at an absolute time, following its automation line (held flat outside it), as volumeExpr writes it for ffmpeg. */
export function gainAt(c: { start: number; volume?: number; volumePoints?: Point[] }, tAbs: number) {
  const pts = c.volumePoints
  if (!pts || pts.length === 0) return c.volume ?? 1
  const rel = tAbs - c.start
  const P = [...pts].sort((a, b) => a.t - b.t)
  if (rel <= P[0].t) return P[0].v
  if (rel >= P[P.length - 1].t) return P[P.length - 1].v
  for (let i = 1; i < P.length; i++) {
    if (rel <= P[i].t) { const a = P[i - 1], b = P[i]; const f = (rel - a.t) / ((b.t - a.t) || 1); return a.v + (b.v - a.v) * f }
  }
  return c.volume ?? 1
}

// ------------------------------------------------------------------ what each clip plays as

/** A clip as the preview knows it: the timeline fields plus what is known about its media's sound. */
export interface PreviewSoundClip {
  id: string
  trackId: string
  type: string
  start: number; duration: number; sourceStart: number
  volume: number; volumePoints?: Point[]
  fadeIn: number; fadeOut: number; aFadeIn?: number; aFadeOut?: number
  hasAudio?: boolean
  /** the original file (what bakes and measurements belong to) */
  mediaPath?: string
  /** set on the media by the user or an agent; absent = guessed, exactly as the export guesses */
  role?: string
  voiceFix?: string
  /** the media's measured sound (analyze-audio-media's `sound`, with its provenance); null = not measured (yet) */
  facts?: SoundFacts | null
  /** the finished bake for voiceFix: path absent when the recording was left as is; undefined while it is still being made */
  bake?: { path?: string; segments?: [number, number][] } | null
}

export interface PreviewClipPlan {
  role: Role
  why: string
  /** true when nobody set the role: the chips say "guessed" */
  guessed: boolean
  bus: Bus
  /** the role's level in dB: bed or SFX match, or the predicted Fix voice lift while the bake runs */
  levelDb: number
  /** a voice whose bake has landed: the preview plays the baked file */
  baked: boolean
  /** a voice whose bake is still to come: its lift is a prediction */
  pending: boolean
}

export interface PreviewMix {
  clips: Map<string, PreviewClipPlan>
  traps: { music: Trapezoid[]; sfx: Trapezoid[] }
  /** where the bus sum is expected to sit before the master, until a loudness scan measures it */
  predictedLufs: number | null
}

/** A recording's Fix voice lift before its bake lands: the bake measures and lands every voice at TARGET_LUFS. */
export const predictedLiftDb = (facts: SoundFacts | null | undefined) =>
  facts && typeof facts.I === 'number' && Number.isFinite(facts.I) && facts.I > -70 ? clamp(TARGET_LUFS - facts.I, -24, MAX_STATIC_DB) : 0

/**
 * Every audible clip's role, bus and level, and the duck keyframes: resolveMix's decisions (electron/
 * mixrender.ts) on what the renderer knows. A voice reads its bake's speech segments, else the
 * measured ones, as the export does; a voice still baking is lifted by the prediction so it is heard
 * at the right level at once, and the cleanup arrives when the bake does.
 */
export function planPreviewMix(clips: PreviewSoundClip[], o: { duck?: boolean; tune?: MixTuning | null } = {}): PreviewMix {
  const out = new Map<string, PreviewClipPlan>()
  const keyed: { role: Role; segments?: [number, number][]; start: number; duration: number; sourceStart: number }[] = []
  const levels: Level[] = []
  for (const c of audibleClips(clips)) {
    const f = c.facts ?? null
    const { role, why } = resolveRole(c, f)
    const preset: Preset = isPreset(c.voiceFix) ? c.voiceFix : 'studio'
    const fixing = role === 'voice' && preset !== 'off'
    const baked = fixing && !!c.bake?.path
    const pending = fixing && c.bake === undefined && !!f
    const levelDb = role === 'voice' ? (pending ? predictedLiftDb(f) : 0) : roleLevelDb(role, f, o.tune)
    out.set(c.id, { role, why, guessed: !(c.role && c.role === role), bus: busOf(role), levelDb, baked, pending })
    keyed.push({ role, segments: role === 'voice' ? (c.bake?.segments || f?.segments) : undefined, start: c.start, duration: c.duration, sourceStart: c.sourceStart })
    const volDb = c.volume > 0 ? 20 * Math.log10(c.volume) : -120
    // a voice that is (or will be) baked sits at the target; anything else at its measured level
    const fixed = role === 'voice' && fixing && (baked || pending)
    const L = fixed ? TARGET_LUFS : (f?.I ?? NaN) + levelDb
    if (Number.isFinite(L)) levels.push({ bus: busOf(role), L: L + volDb, d: c.duration, fixed })
  }
  const traps = o.duck === false ? { music: [], sfx: [] } : (({ music, sfx }) => ({ music, sfx }))(duckPlan(keyed, o.tune))
  return { clips: out, traps, predictedLufs: predictPremasterLufs(levels) }
}

/** One audible clip's expected loudness (LUFS, its volume included) and how long it plays. fixed = a baked (or baking) voice. */
export interface Level { bus: Bus; L: number; d: number; fixed?: boolean }
const powerMean = (ls: Level[]) => {
  let e = 0, d = 0
  for (const l of ls) { e += l.d * 10 ** (l.L / 10); d += l.d }
  return d > 0 && e > 0 ? 10 * Math.log10(e / d) : null
}
/**
 * The bus sum's loudness before anything measured it. With a fixed voice the voice bus decides it:
 * its clips power-averaged over the time they play (each baked voice is at -16, moved by its own
 * volume), and a bed under it measured half a LU lower again (-16.0 voice only, -16.5 with a bed, in
 * the shoot-out's mix). Without one: every clip's own level, averaged the same way (silence between
 * clips is gated out of an integrated loudness too).
 */
export function predictPremasterLufs(levels: Level[]): number | null {
  if (!levels.length) return null
  if (levels.some((l) => l.fixed)) {
    const v = powerMean(levels.filter((l) => l.bus === 'voice'))
    return v == null ? null : v - (levels.some((l) => l.bus === 'music') ? 0.5 : 0)
  }
  return powerMean(levels)
}

/**
 * The master gain the preview plays (dB): the export's planMaster on the measured bus sum when a
 * loudness scan has landed for this very timeline, else on the prediction. Optimize off is the Master
 * volume alone, as in the export.
 */
export function previewMasterDb(o: { optimize: boolean; target?: string | null; masterVolume: number; measuredLufs?: number | null; measuredTp?: number | null; predictedLufs?: number | null }) {
  const I = o.measuredLufs ?? o.predictedLufs ?? null
  return planMaster({ I: I ?? -Infinity, TP: o.measuredTp ?? null, optimize: o.optimize, target: o.target, masterVolume: o.masterVolume })
}

// ------------------------------------------------------------------ the duck as a WebAudio curve

/** Points per second of a scheduled duck curve: 1 ms, the step the export's eval=frame volume runs at (asetnsamples=48). */
export const CURVE_HZ = 1000

/**
 * The duck as a curve of linear gains for AudioParam.setValueCurveAtTime: one point per millisecond
 * from timeline time t0, the export's dB-linear trapezoids (evalTrapezoidsDb) evaluated at each.
 * WebAudio interpolates linearly between the points; on a 10 dB, 200 ms ramp that is under a
 * thousandth of a dB from the true dB-linear shape.
 */
export function duckCurve(traps: Trapezoid[], t0: number, seconds: number, hz = CURVE_HZ): Float32Array {
  const n = Math.max(2, Math.round(seconds * hz) + 1)
  const t1 = t0 + (n - 1) / hz
  // only the ducks that touch this window: a long timeline has hundreds
  const near = traps.filter((p) => p.b1 >= t0 && p.a0 <= t1)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = dbToGain(evalTrapezoidsDb(near, t0 + i / hz))
  return out
}

/** The value WebAudio plays dt seconds into a curve scheduled over `duration` (the spec's linear interpolation). */
export function curveValueAt(curve: ArrayLike<number>, duration: number, dt: number) {
  const N = curve.length
  if (dt <= 0) return curve[0]
  if (dt >= duration) return curve[N - 1]
  const x = (N - 1) * dt / duration, k = Math.floor(x)
  return curve[k] + (curve[Math.min(N - 1, k + 1)] - curve[k]) * (x - k)
}

// ------------------------------------------------------------------ the safety stage and the meter

/**
 * The stand-in for the export's -1.5 dBTP ceiling: a hard, fast DynamicsCompressorNode. WebAudio's
 * compressor adds its own make-up gain, (1 / the gain it applies at 0 dBFS) to the power 0.6, to
 * EVERYTHING; at this threshold and ratio that is +0.86 dB, so the preview would play hot. The trim
 * after it takes exactly that back off, so below the ceiling the chain is unity.
 */
export const SAFETY = { threshold: -1.5, ratio: 20, knee: 0, attack: 0.001, release: 0.06 }
export const compressorMakeupDb = (thresholdDb: number, ratio: number) => -0.6 * thresholdDb * (1 - 1 / ratio)

/** BS.1770 momentary loudness of the last `n` samples of two K-weighted channels: -0.691 + 10 log10(sum of the channels' mean squares). */
export function momentaryLufs(l: Float32Array, r: Float32Array | null, n: number): number {
  const ms = (x: Float32Array) => {
    const from = Math.max(0, x.length - n)
    let s = 0
    for (let i = from; i < x.length; i++) s += x[i] * x[i]
    return s / Math.max(1, x.length - from)
  }
  const p = ms(l) + (r ? ms(r) : 0)
  return p > 1e-14 ? -0.691 + 10 * Math.log10(p) : -Infinity
}

// ------------------------------------------------------------------ the WebAudio graph

interface ClipNode { el: HTMLMediaElement; gain: GainNode; bus: Bus; target: number }
interface DuckState { sig: string; t0: number; ctxT0: number; until: number }

/** How far ahead a duck curve is scheduled; it is renewed well before it runs out. */
const DUCK_WINDOW_S = 30
/** Context time between scheduling and the curve's first point, so it is never in the past. */
const DUCK_LEAD_S = 0.02

/**
 * One AudioContext for the whole preview. Every clip's element is routed through its own gain into
 * its bus; ducks are scheduled curves on the music and SFX buses; the master carries the measured
 * gain. `available` is false where WebAudio could not start: the caller then falls back to
 * el.volume (clamped at 1, as before).
 */
export class PreviewMixer {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private buses!: Record<Bus, GainNode>
  private meters: [AnalyserNode, AnalyserNode] | null = null
  private meterBuf: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] | null = null
  private sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()
  private clips = new Map<string, ClipNode>()
  private ducks: Record<'music' | 'sfx', DuckState | null> = { music: null, sfx: null }

  constructor() {
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      const master = ctx.createGain()
      const safety = ctx.createDynamicsCompressor()
      safety.threshold.value = SAFETY.threshold
      safety.ratio.value = SAFETY.ratio
      safety.knee.value = SAFETY.knee
      safety.attack.value = SAFETY.attack
      safety.release.value = SAFETY.release
      const trim = ctx.createGain()
      trim.gain.value = dbToGain(-compressorMakeupDb(SAFETY.threshold, SAFETY.ratio))
      master.connect(safety).connect(trim).connect(ctx.destination)
      this.buses = { voice: ctx.createGain(), music: ctx.createGain(), sfx: ctx.createGain() }
      for (const b of Object.values(this.buses)) b.connect(master)
      this.master = master
      this.ctx = ctx
      try {
        // the meter: each side K-weighted with the exact BS.1770 coefficients for this rate, then
        // read back as samples (an AnalyserNode alone would down-mix the two sides first)
        const split = ctx.createChannelSplitter(2)
        trim.connect(split)
        const [shelf, hp] = kWeighting(ctx.sampleRate)
        const side = (ch: number) => {
          const a = ctx.createIIRFilter([shelf[0], shelf[1], shelf[2]], [1, shelf[3], shelf[4]])
          const b = ctx.createIIRFilter([hp[0], hp[1], hp[2]], [1, hp[3], hp[4]])
          const an = ctx.createAnalyser()
          an.fftSize = 32768
          split.connect(a, ch).connect(b).connect(an)
          return an
        }
        this.meters = [side(0), side(1)]
        this.meterBuf = [new Float32Array(32768), new Float32Array(32768)]
      } catch { this.meters = null }
    } catch {
      this.ctx = null
    }
  }

  get available() { return !!this.ctx }

  /** Start the clock if the browser held it (a web build before the first click); Electron starts it at once. */
  resume() { if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {}) }

  /**
   * Route an element through a clip gain into a bus (again, after a role change). An element can be
   * captured by one source node only, ever, so the node is kept with the element. False when the
   * element cannot be routed: the caller keeps it on el.volume.
   */
  attach(id: string, el: HTMLMediaElement, bus: Bus): boolean {
    const ctx = this.ctx
    if (!ctx) return false
    const cur = this.clips.get(id)
    if (cur && cur.el === el) {
      if (cur.bus !== bus) { cur.gain.disconnect(); cur.gain.connect(this.buses[bus]); cur.bus = bus }
      // a stretch on b-roll left it on the el.volume fallback (often 0), which would scale its sound
      // before the graph from here on: a clip dragged V1 -> V2 -> V1 came back silent
      if (el.volume !== 1) el.volume = 1
      return true
    }
    if (cur) this.detach(id)
    try {
      let src = this.sources.get(el)
      if (!src) { src = ctx.createMediaElementSource(el); this.sources.set(el, src) }
      const gain = ctx.createGain()
      gain.gain.value = 0
      src.disconnect()
      src.connect(gain).connect(this.buses[bus])
      // the element's own volume would scale its sound before the graph; the gain node is the volume now
      el.volume = 1
      this.clips.set(id, { el, gain, bus, target: 0 })
      return true
    } catch { return false }
  }

  detach(id: string) {
    const cur = this.clips.get(id)
    if (!cur) return
    try { cur.gain.disconnect() } catch { /* already gone */ }
    try { this.sources.get(cur.el)?.disconnect() } catch { /* already gone */ }
    this.clips.delete(id)
  }

  has(id: string) { return this.clips.has(id) }

  /** The clips routed now, so the caller can detach the ones whose element has gone. */
  routedIds() { return [...this.clips.keys()] }

  /** A clip's gain (linear), eased over a few ms so a per-frame update does not zipper. */
  setClipGain(id: string, g: number) {
    const cur = this.clips.get(id)
    if (!cur || !this.ctx) return
    const v = Number.isFinite(g) ? Math.max(0, g) : 0
    // called every frame: only a new value is scheduled
    if (Math.abs(cur.target - v) < 1e-5) return
    cur.target = v
    cur.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.004)
  }

  private masterTarget = 1
  setMaster(g: number) {
    if (!this.ctx) return
    const v = Number.isFinite(g) ? Math.max(0, g) : 0
    if (Math.abs(this.masterTarget - v) < 1e-5) return
    this.masterTarget = v
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02)
  }

  /**
   * The music and SFX ducks at timeline time t. While playing, each bus gets the export's keyframes
   * as a 1 ms curve scheduled on the audio clock, renewed before it runs out and rescheduled when the
   * plan changes or the playhead jumps; paused, it simply holds the value at t.
   */
  scheduleDucks(traps: { music: Trapezoid[]; sfx: Trapezoid[] }, t: number, playing: boolean) {
    const ctx = this.ctx
    if (!ctx) return
    for (const b of ['music', 'sfx'] as const) {
      const p = this.buses[b].gain, list = traps[b]
      const sig = list.length ? `${list.length}:${list[0].a0}:${list[list.length - 1].b1}:${list.reduce((a, x) => a + x.a0 * 7 + x.b1 * 3 + x.depthDb, 0)}` : ''
      const st = this.ducks[b]
      if (!playing || !list.length) {
        if (st || Math.abs(p.value - dbToGain(evalTrapezoidsDb(list, t))) > 1e-4) {
          p.cancelScheduledValues(0)
          p.setValueAtTime(dbToGain(evalTrapezoidsDb(list, t)), ctx.currentTime)
          this.ducks[b] = null
        }
        continue
      }
      const expected = st ? st.t0 + (ctx.currentTime - st.ctxT0) : NaN
      if (st && st.sig === sig && Math.abs(expected - t) < 0.12 && st.until - t > 5) continue
      const at = ctx.currentTime + DUCK_LEAD_S, t0 = t + DUCK_LEAD_S
      const curve = duckCurve(list, t0, DUCK_WINDOW_S)
      const dur = (curve.length - 1) / CURVE_HZ
      try {
        p.cancelScheduledValues(0)
        p.setValueAtTime(dbToGain(evalTrapezoidsDb(list, t)), ctx.currentTime)
        p.setValueCurveAtTime(curve, at, dur)
        this.ducks[b] = { sig, t0, ctxT0: at, until: t0 + dur }
      } catch {
        p.setValueAtTime(dbToGain(evalTrapezoidsDb(list, t)), ctx.currentTime)
        this.ducks[b] = null
      }
    }
  }

  /** Momentary loudness (400 ms) of what is playing, in LUFS; null without a meter. */
  momentary(): number | null {
    if (!this.ctx || !this.meters || !this.meterBuf) return null
    this.meters[0].getFloatTimeDomainData(this.meterBuf[0])
    this.meters[1].getFloatTimeDomainData(this.meterBuf[1])
    return momentaryLufs(this.meterBuf[0], this.meterBuf[1], Math.round(0.4 * this.ctx.sampleRate))
  }
}

let shared: PreviewMixer | null = null
/** The app's one mixer, made on first use (StrictMode's double render must not open two AudioContexts). */
export function previewMixer(): PreviewMixer {
  if (!shared) shared = new PreviewMixer()
  return shared
}
