// Preview parity (src/previewAudio.ts): the preview's gains must be the export's gains, because the
// whole point of the WebAudio mixer is that what plays while editing is what exports. Every check
// here compares against the strings the export actually hands ffmpeg (electron/audiomix.ts and
// audiochain.ts), turned back into JS, rather than against a second copy of the formula.
// Run: npm run test:previewaudio
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const P = await load('src/previewAudio.ts'), A = await load('electron/audiochain.ts'), M = await load('electron/audiomix.ts')

let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }
const db = (g) => 20 * Math.log10(Math.max(1e-12, g))
// a seeded generator, so a failure can be reproduced
let seed = 1234567
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32 }

/** An ffmpeg expression (the subset the export writes) as a JS function of t. */
const exprFn = (expr) => {
  const js = expr.replace(/\\,/g, ',').replace(/\bpow\(/g, 'Math.pow(').replace(/\bclip\(/g, 'C(').replace(/\bif\(/g, 'I(').replace(/\blt\(/g, 'L(')
  const f = new Function('t', 'C', 'I', 'L', `return ${js}`)
  return (t) => f(t, (x, a, b) => Math.min(b, Math.max(a, x)), (c, a, b) => (c ? a : b), (a, b) => (a < b ? 1 : 0))
}

console.log('duck curve')
{
  // the corpus voice_music segments plus a run of short phrases, as the export's planner draws them
  const segs = [[2.33, 14.5], [15.47, 22.04], [24.99, 41.64], [43.79, 52.98], [60, 61.2], [62.5, 63.1], [65, 66]]
  const traps = A.duckTraps(segs, A.DUCK)
  ok(traps.length >= 5, `${traps.length} trapezoids`)
  // the expression the music bus really runs (the tree form for 3+ ducks) and the flat sum, back in JS
  const bus = A.musicBusGraph({ inputs: ['a'], bedDb: 0, traps })
  const m = /volume='([^']+)':eval=frame/.exec(bus)
  ok(!!m, 'the music bus carries a duck expression')
  const tree = exprFn(m[1]), flat = exprFn(A.trapezoidExpr(traps))
  let worstTree = 0, worstFlat = 0
  for (let k = 0; k <= 70000; k += 1) {
    const t = k / 1000, ideal = A.evalTrapezoidsDb(traps, t)
    worstTree = Math.max(worstTree, Math.abs(db(tree(t)) - ideal))
    worstFlat = Math.max(worstFlat, Math.abs(db(flat(t)) - ideal))
  }
  ok(worstTree < 1e-3, `the export's tree expression equals the JS evaluator at every 1 ms frame (worst ${worstTree.toExponential(1)} dB)`)
  ok(worstFlat < 1e-3, `so does the flat expression (worst ${worstFlat.toExponential(1)} dB)`)

  // the preview schedules 30 s windows from wherever the playhead is; WebAudio interpolates linearly
  let worstIdeal = 0, worstExport = 0
  for (let w = 0; w < 6; w++) {
    const t0 = rnd() * 50, secs = 30
    const curve = P.duckCurve(traps, t0, secs)
    const dur = (curve.length - 1) / P.CURVE_HZ
    ok(curve.length === secs * 1000 + 1 && Math.abs(dur - secs) < 1e-9, `window ${w}: one point per ms (${curve.length})`)
    for (let i = 0; i < 4000; i++) {
      const dt = rnd() * dur, t = t0 + dt
      const heard = db(P.curveValueAt(curve, dur, dt))
      worstIdeal = Math.max(worstIdeal, Math.abs(heard - A.evalTrapezoidsDb(traps, t)))
      // the export holds each 1 ms frame's value (asetnsamples=48, eval=frame): compare with that
      worstExport = Math.max(worstExport, Math.abs(heard - db(tree(Math.floor(t * 1000) / 1000))))
    }
  }
  ok(worstIdeal <= 0.05, `preview curve vs the dB-linear trapezoids: worst ${worstIdeal.toFixed(4)} dB (<= 0.05)`)
  ok(worstExport <= 0.05 + 1e-6, `preview curve vs the export's 1 ms frames: worst ${worstExport.toFixed(4)} dB (<= 0.05)`)
  const c = P.duckCurve(traps, 5, 1)
  ok(Math.abs(db(c[0]) + 10) < 1e-6 && Math.abs(db(P.curveValueAt(c, 1, 2)) + 10) < 1e-6, 'fully down inside speech; held at the ends of a window')
  ok(P.duckCurve([], 0, 2).every((v) => v === 1), 'no ducks is unity')
}

console.log('clip gain = the export clip chain')
{
  // random clips through the real planner; the clip line it writes is read back and multiplied out
  let worst = 0
  for (let n = 0; n < 40; n++) {
    // whole milliseconds: the export writes fade starts to the millisecond, and this compares gains, not that rounding
    const ms = (x) => Math.round(x * 1000) / 1000
    const start = ms(rnd() * 20), duration = ms(0.3 + rnd() * 8)
    const pts = rnd() < 0.5 ? null : Array.from({ length: 2 + Math.floor(rnd() * 4) }, () => ({ t: rnd() * duration, v: rnd() * 2 }))
    const c = {
      id: 'c', trackId: 'a1', type: 'audio', start, duration, sourceStart: rnd() < 0.5 ? 0 : rnd() * 5, volume: 0.2 + rnd() * 1.8,
      volumePoints: pts || undefined, fadeIn: rnd() < 0.5 ? 0 : ms(rnd() * 2), fadeOut: rnd() < 0.5 ? 0 : ms(rnd() * 2),
      aFadeIn: rnd() < 0.3 ? 0.012 : undefined, aFadeOut: rnd() < 0.3 ? 0.012 : undefined,
    }
    const levelDb = rnd() < 0.5 ? 0 : Math.round((rnd() - 0.5) * 2000) / 100
    const plan = M.planMix([{ ...c, role: 'asis', file: 'x.wav', levelDb, channels: 2 }], { totalS: start + duration + 1 })
    const line = plan.graph.split(';').find((l) => l.includes('afade') || l.includes('volume'))
    const pre = /\[p1\]/.test(plan.graph) ? (/volume=(-?[\d.]+)dB\[p1\]/.exec(plan.graph) || /volume=(-?[\d.]+)dB/.exec(plan.graph)) : null
    const preDb = pre ? +pre[1] : 0
    const chain = plan.graph.split(';').find((l) => l.includes('adelay'))
    const vexpr = /volume='([^']+)':eval=frame/.exec(chain)
    const vflat = /,volume=([\d.e+-]+)(,|\[)/.exec(chain)
    const vol = vexpr ? exprFn(vexpr[1]) : () => +vflat[1]
    const fin = /afade=t=in:st=([\d.e+-]+):d=([\d.e+-]+)/.exec(chain), fout = /afade=t=out:st=([\d.e+-]+):d=([\d.e+-]+)/.exec(chain)
    const ramp = (t, m, dir) => !m ? 1 : Math.min(1, Math.max(0, dir === 'in' ? (t - +m[1]) / +m[2] : (+m[1] + +m[2] - t) / +m[2]))
    for (let i = 0; i < 25; i++) {
      const t = start + rnd() * duration
      const exported = 10 ** (preDb / 20) * vol(t) * ramp(t, fin, 'in') * ramp(t, fout, 'out')
      const preview = P.dbToGain(levelDb) * P.gainAt(c, t) * P.audioFadeFactor(c, t)
      worst = Math.max(worst, Math.abs(exported - preview))
    }
    if (n === 0) ok(!!line, 'the planner wrote a clip line')
  }
  ok(worst < 1e-6, `1,000 random times on 40 random clips: worst |export - preview| ${worst.toExponential(2)}`)
  // overlapping fades multiply, as two afade filters do (min() was the old preview's guess)
  const short = { start: 0, duration: 1, fadeIn: 0.8, fadeOut: 0.8 }
  ok(Math.abs(P.audioFadeFactor(short, 0.5) - (0.5 / 0.8) * (0.5 / 0.8)) < 1e-9, 'overlapping fades multiply like the two afades')
  ok(P.audioFadeFactor({ start: 2, duration: 3, fadeIn: 0, fadeOut: 0 }, 4.9999) > 0 && P.audioFadeFactor({ start: 2, duration: 3, fadeIn: 0, fadeOut: 0 }, 5) === 0, 'every clip end ramps for at least the de-pop 12 ms')
  ok(Math.abs(P.audioFadeFactor({ start: 2, duration: 3, fadeIn: 0, fadeOut: 0, sourceStart: 1 }, 2.006) - 0.5) < 1e-9, 'a start that is not the file\'s beginning ramps too')
  ok(P.audioFadeFactor({ start: 2, duration: 3, fadeIn: 0, fadeOut: 0, sourceStart: 0 }, 2) === 1, 'a natural beginning keeps its attack')
}

console.log('roles, levels and ducks: the export\'s decisions')
{
  const voiceFacts = { I: -30, M: -20, segments: [[1, 4], [6, 9]], guessAudio: { role: 'voice', why: 'speech' }, guessVideo: { role: 'voice', why: 'speech' } }
  const musicFacts = { I: -22, M: -12, segments: [], guessAudio: { role: 'music', why: 'continuous' }, guessVideo: { role: 'asis', why: 'continuous' } }
  const sfxFacts = { I: -25, M: -9, segments: [], guessAudio: { role: 'music', why: 'x' }, guessVideo: { role: 'asis', why: 'x' } }
  const base = { type: 'audio', sourceStart: 0, volume: 1, fadeIn: 0, fadeOut: 0, hasAudio: true }
  const clips = [
    { ...base, id: 'v', trackId: 'a1', start: 0, duration: 10, mediaPath: 'v.wav', facts: voiceFacts },
    { ...base, id: 'm', trackId: 'a1', start: 0, duration: 12, mediaPath: 'm.wav', facts: musicFacts },
    { ...base, id: 's', trackId: 'a2', start: 3, duration: 1, mediaPath: 's.wav', facts: sfxFacts },
    { ...base, id: 'x', trackId: 'a1', start: 0, duration: 5, mediaPath: 'x.wav', facts: null },
    { ...base, id: 'mute', trackId: 'a1', start: 0, duration: 5, mediaPath: 'v.wav', volume: 0, facts: voiceFacts },
    { ...base, id: 'b', trackId: 'v2', type: 'video', start: 0, duration: 5, mediaPath: 'b.mp4', facts: voiceFacts },
  ]
  const mix = P.planPreviewMix(clips)
  const v = mix.clips.get('v'), mu = mix.clips.get('m'), s = mix.clips.get('s'), x = mix.clips.get('x')
  ok(v.role === 'voice' && v.bus === 'voice' && v.guessed && v.pending && Math.abs(v.levelDb - 14) < 1e-9, `voice, guessed, still baking: lifted by the prediction (${v.levelDb} dB = -16 - (-30))`)
  ok(mu.role === 'music' && mu.bus === 'music' && Math.abs(mu.levelDb - M.roleLevelDb('music', musicFacts)) < 1e-9 && Math.abs(mu.levelDb - (-21 + 22)) < 1e-9, `music at the bed (${mu.levelDb} dB)`)
  ok(s.role === 'sfx' && s.bus === 'sfx' && Math.abs(s.levelDb - (-16 + 9)) < 1e-9, `on the SFX track: an SFX, loudest moment at the voice level (${s.levelDb} dB)`)
  ok(x.role === 'asis' && x.levelDb === 0, 'not measured yet: as recorded, as the export plays it')
  ok(!mix.clips.has('mute') && !mix.clips.has('b'), 'a muted clip and b-roll are not in the mix')
  const want = M.duckPlan([{ role: 'voice', segments: voiceFacts.segments, start: 0, duration: 10, sourceStart: 0 }])
  ok(JSON.stringify(mix.traps.music) === JSON.stringify(want.music) && JSON.stringify(mix.traps.sfx) === JSON.stringify(want.sfx), `ducks are the export's (${mix.traps.music.length} music, ${mix.traps.sfx.length} SFX)`)
  ok(mix.traps.music[0].depthDb === 10 && mix.traps.sfx[0].depthDb === 6, 'default depths 10 dB and 6 dB')

  const baked = P.planPreviewMix([{ ...clips[0], bake: { path: 'v.flac', segments: [[1.5, 3]] } }, clips[1]])
  ok(baked.clips.get('v').baked && baked.clips.get('v').levelDb === 0, 'baked: the bake is already at the working level')
  ok(baked.traps.music.length === 1 && Math.abs(baked.traps.music[0].a1 - (1.5 - 0.08)) < 1e-9, 'baked: the duck keys from the bake\'s own speech')
  const asIs = P.planPreviewMix([{ ...clips[0], bake: {} }])
  ok(asIs.clips.get('v').levelDb === 0 && !asIs.clips.get('v').baked && !asIs.clips.get('v').pending, 'left as is by the bake: played as recorded')
  const off = P.planPreviewMix([{ ...clips[0], voiceFix: 'off' }])
  ok(off.clips.get('v').levelDb === 0 && !off.clips.get('v').pending, 'Fix voice off: as recorded')
  const set = P.planPreviewMix([{ ...clips[0], role: 'music' }])
  ok(set.clips.get('v').role === 'music' && !set.clips.get('v').guessed, 'a role set on the media wins and is not "guessed"')

  const noDuck = P.planPreviewMix(clips, { duck: false })
  ok(!noDuck.traps.music.length && !noDuck.traps.sfx.length, 'Duck off: no keyframes')
  const tuned = P.planPreviewMix(clips, { tune: { duckDb: 14, sfxDuckDb: 0, bedLu: 8 } })
  ok(tuned.traps.music[0].depthDb === 14 && tuned.traps.sfx.length === 0, 'Advanced depths: 14 dB music, SFX duck 0 = none')
  ok(Math.abs(tuned.clips.get('m').levelDb - (-16 - 8 + 22)) < 1e-9, `bed 8 LU under the voice (${tuned.clips.get('m').levelDb} dB)`)
  const plan = M.planMix([{ start: 0, duration: 10, sourceStart: 0, role: 'voice', file: 'v.flac', segments: voiceFacts.segments }, { start: 0, duration: 12, sourceStart: 0, role: 'music', file: 'm.wav', levelDb: 0 }], { totalS: 12, tune: { duckDb: 14 } })
  ok(plan.traps.music[0].depthDb === 14, 'the export planner takes the same depth')
  ok(Math.abs(M.roleLevelDb('music', musicFacts, { bedLu: 8 }) - tuned.clips.get('m').levelDb) < 1e-9, 'and the same bed level')
  ok(M.mixTuning({ duckDb: 99, bedLu: -3 }).duckDb === 24 && M.mixTuning({ bedLu: -3 }).bedLu === 0 && M.mixTuning(null).sfxDuckDb === 6, 'depths are clamped, defaults fill the gaps')
}

console.log('master')
{
  ok(Math.abs(P.compressorMakeupDb(-1.5, 20) - 0.855) < 1e-9, `the safety compressor's own make-up is ${P.compressorMakeupDb(-1.5, 20).toFixed(3)} dB, and the trim takes it back`)
  ok(P.predictPremasterLufs([{ bus: 'voice', L: -16, d: 10, fixed: true }]) === -16, 'voice only: -16')
  ok(P.predictPremasterLufs([{ bus: 'voice', L: -16, d: 10, fixed: true }, { bus: 'music', L: -21, d: 10 }]) === -16.5, 'voice and a bed: -16.5')
  ok(Math.abs(P.predictPremasterLufs([{ bus: 'voice', L: -22.02, d: 10, fixed: true }]) - -22.02) < 1e-9, 'a voice at half volume: 6 dB lower, so the master makes it up')
  ok(Math.abs(P.predictPremasterLufs([{ bus: 'voice', L: -20, d: 5 }, { bus: 'voice', L: -20, d: 5 }]) - -20) < 1e-9, 'no fixed voice: the clips\' own levels')
  ok(P.predictPremasterLufs([]) === null, 'silence: nothing to predict')
  const m = P.previewMasterDb({ optimize: true, target: 'youtube', masterVolume: 1, predictedLufs: -16 })
  ok(Math.abs(m.gainDb - 2) < 1e-9, `predicted: +${m.gainDb} dB to -14`)
  const s = P.previewMasterDb({ optimize: true, target: 'podcast', masterVolume: 0.5, measuredLufs: -17.3, measuredTp: -5, predictedLufs: -16 })
  const e = M.planMaster({ I: -17.3, TP: -5, optimize: true, target: 'podcast', masterVolume: 0.5 })
  ok(Math.abs(s.gainDb - e.gainDb) < 1e-12, `measured: the export's own master gain (${s.gainDb.toFixed(2)} dB)`)
  const o = P.previewMasterDb({ optimize: false, masterVolume: 1.5, predictedLufs: -20 })
  ok(Math.abs(o.gainDb - 20 * Math.log10(1.5)) < 1e-9, 'Optimize off: the Master volume alone')
}

console.log('labels')
{
  ok(P.dbLabel(1) === '0.0 dB' && P.dbLabel(0.5) === '−6.0 dB' && P.dbLabel(2) === '6.0 dB', `0 dB, half, double: ${P.dbLabel(1)} / ${P.dbLabel(0.5)} / ${P.dbLabel(2)}`)
  ok(P.dbLabel(0) === '−inf dB' && P.dbLabel(0.0005) === '−inf dB', 'silence reads -inf dB')
  ok(P.dbLabel(0.9999) === '0.0 dB', 'a hair under unity is not "-0.0 dB"')
}

console.log('meter')
{
  const n = 19200, l = new Float32Array(32768).fill(0.1), r = new Float32Array(32768).fill(0.1)
  ok(Math.abs(P.momentaryLufs(l, r, n) - (-0.691 + 10 * Math.log10(0.02))) < 1e-6, `two channels at 0.1: ${P.momentaryLufs(l, r, n).toFixed(2)} LUFS (channels sum)`)
  const late = new Float32Array(32768); late.fill(0.1, 32768 - n)
  ok(Math.abs(P.momentaryLufs(late, null, n) - P.momentaryLufs(l, null, n)) < 1e-6, 'only the last 400 ms count')
  ok(P.momentaryLufs(new Float32Array(100), null, 50) === -Infinity, 'silence reads -inf')
  // the K-weighting the meter uses is the bake's own (1 kHz passes at about 0 dB)
  const [sh, hp] = A.kWeighting(48000)
  const H = (b, z) => { const re = Math.cos(z), im = -Math.sin(z), re2 = Math.cos(2 * z), im2 = -Math.sin(2 * z)
    const nr = b[0] + b[1] * re + b[2] * re2, ni = b[1] * im + b[2] * im2, dr = 1 + b[3] * re + b[4] * re2, di = b[3] * im + b[4] * im2
    return Math.hypot(nr, ni) / Math.hypot(dr, di) }
  const w = 2 * Math.PI * 1000 / 48000
  ok(Math.abs(20 * Math.log10(H(sh, w) * H(hp, w))) < 0.7, `K-weighting at 1 kHz ${(20 * Math.log10(H(sh, w) * H(hp, w))).toFixed(2)} dB`)
}

console.log('the WebAudio graph (against a stand-in that enforces the spec\'s automation rules)')
{
  // AudioParam's rule that bites: a value curve may not overlap any other scheduled event
  // (NotSupportedError), so a reschedule that forgot to cancel would throw mid-playback.
  class Param {
    constructor(v) { this.value = v; this.events = [] }
    setValueAtTime(v, t) { this.events.push({ kind: 'set', t, v }); this.value = v; return this }
    setTargetAtTime(v, t, tau) { this.events.push({ kind: 'target', t, v, tau }); return this }
    setValueCurveAtTime(curve, t, d) {
      for (const e of this.events) {
        const end = e.kind === 'curve' ? e.t + e.d : e.t
        if ((e.t >= t && e.t < t + d) || (e.kind === 'curve' && t >= e.t && t < end)) throw new Error('NotSupportedError: overlaps an automation event')
      }
      this.events.push({ kind: 'curve', t, d, curve }); return this
    }
    cancelScheduledValues(t) { this.events = this.events.filter((e) => e.t < t && !(e.kind === 'curve' && e.t + e.d > t)); return this }
  }
  const node = (extra = {}) => ({ outs: new Set(), connect(n) { this.outs.add(n); return n }, disconnect() { this.outs.clear() }, ...extra })
  class FakeCtx {
    constructor() { this.currentTime = 0; this.sampleRate = 48000; this.state = 'running'; this.destination = node(); this.sources = 0 }
    createGain() { return node({ gain: new Param(1) }) }
    createDynamicsCompressor() { return node({ threshold: { value: 0 }, ratio: { value: 0 }, knee: { value: 0 }, attack: { value: 0 }, release: { value: 0 } }) }
    createChannelSplitter() { return node() }
    createIIRFilter(ff, fb) { if (fb[0] !== 1 || ff.length !== 3) throw new Error('bad IIR'); return node() }
    createAnalyser() { return node({ fftSize: 2048, getFloatTimeDomainData(b) { b.fill(0.1) } }) }
    createMediaElementSource(el) { if (el.captured) throw new Error('InvalidStateError: already connected'); el.captured = true; this.sources++; return node() }
    resume() { return Promise.resolve() }
  }
  globalThis.AudioContext = FakeCtx
  const mx = new P.PreviewMixer()
  ok(mx.available, 'the mixer starts')
  const el = { volume: 0.3 }, el2 = { volume: 1 }
  ok(mx.attach('a', el, 'music') && el.volume === 1, 'an element is routed, and its own volume goes to 1')
  ok(mx.attach('a', el, 'voice') && mx.attach('a', el, 'voice'), 'moving it to another bus (a new role) re-routes the same node')
  mx.detach('a')
  ok(mx.attach('b', el, 'sfx'), 'an element captured once is routed again after a detach (one source node per element, for ever)')
  ok(mx.attach('c', el2, 'music'), 'a second element')
  const ctx = mx.ctx, voiceBus = mx.buses.voice, musicBus = mx.buses.music
  mx.setClipGain('c', 0.5); mx.setClipGain('c', 0.5)
  ok(mx.clips.get('c').gain.gain.events.filter((e) => e.kind === 'target').length === 1, 'a per-frame gain that has not changed schedules nothing')
  const traps = A.duckTraps([[2, 5], [9, 12]], A.DUCK)
  let threw = null
  try {
    mx.scheduleDucks({ music: traps, sfx: [] }, 0, true)
    const first = musicBus.gain.events.filter((e) => e.kind === 'curve').length
    ok(first === 1, 'playing: one duck curve on the music bus')
    ctx.currentTime += 0.5
    mx.scheduleDucks({ music: traps, sfx: [] }, 0.5, true)
    ok(musicBus.gain.events.filter((e) => e.kind === 'curve').length === 1, 'the clock moving on as planned schedules nothing new')
    ctx.currentTime += 0.1
    mx.scheduleDucks({ music: traps, sfx: [] }, 7, true)
    const cur = musicBus.gain.events.filter((e) => e.kind === 'curve')
    ok(cur.length === 1 && Math.abs(cur[0].t - (ctx.currentTime + 0.02)) < 1e-9, 'a jump of the playhead replaces the curve (cancelled first, so it never overlaps)')
    const curveNow = () => musicBus.gain.events.find((e) => e.kind === 'curve')
    const before = curveNow()
    const moved = A.duckTraps([[3, 6], [9, 12]], A.DUCK)
    mx.scheduleDucks({ music: moved, sfx: [] }, 7.01, true)
    ok(musicBus.gain.events.filter((e) => e.kind === 'curve').length === 1 && curveNow() !== before, 'an edit to the speech replaces it too')
    const edited = curveNow()
    ctx.currentTime += 24.9
    mx.scheduleDucks({ music: moved, sfx: [] }, 31.92, true)
    ok(curveNow() === edited, 'with more than 5 s of curve left it is kept')
    ctx.currentTime += 0.2
    mx.scheduleDucks({ music: moved, sfx: [] }, 32.12, true)
    ok(musicBus.gain.events.filter((e) => e.kind === 'curve').length === 1 && curveNow() !== edited, 'renewed before the window runs out')
    mx.scheduleDucks({ music: moved, sfx: [] }, 10, false)
    ok(!musicBus.gain.events.some((e) => e.kind === 'curve') && Math.abs(db(musicBus.gain.value) + 10) < 1e-6, 'paused: no curve, the gain held at the duck\'s value (-10 dB inside speech)')
    mx.scheduleDucks({ music: [], sfx: [] }, 10, true)
    ok(Math.abs(musicBus.gain.value - 1) < 1e-9, 'Duck off while playing: back to unity')
  } catch (e) { threw = e }
  ok(!threw, `no automation call threw${threw ? `: ${threw.message}` : ''}`)
  ok(voiceBus.gain.events.length === 0, 'the voice bus is never ducked')
  ok(Math.abs(mx.momentary() - (-0.691 + 10 * Math.log10(0.02))) < 1e-6, 'the meter reads both sides of the master')
  delete globalThis.AudioContext
  const none = new P.PreviewMixer()
  ok(!none.available && none.attach('x', { volume: 0.5 }, 'voice') === false && none.momentary() === null, 'no WebAudio: the caller is told to keep el.volume')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
