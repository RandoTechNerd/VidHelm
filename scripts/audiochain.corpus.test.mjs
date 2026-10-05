// Opt-in corpus test for Fix voice: the REAL bake (electron/voicebake.ts, the code the app runs) on the
// quiet-audio corpus, measured with scripts/audiomeasure.mjs against the thresholds the shoot-out set
// (each is the measured value with a margin). Skipped unless VIDHELM_AUDIO_CORPUS names the folder:
//   <dir>/phone_raw.wav quiet_clean.wav quiet_noisy.wav uneven.wav peaky.wav
//   <dir>/stems/voice_music_voice.wav voice_music_music.wav
//   <dir>/stress/mono44k.wav mono48k.wav st44k.wav aac.m4a roomonly.wav alreadyloud.wav short.wav sparse.wav premixed.wav long10min.wav
// A missing file skips its checks. The corpus is not in the repo (the phone recording is the owner's own).
// Run: VIDHELM_AUDIO_CORPUS=<dir> npm run test:audiochain:corpus   (about 5 to 10 minutes)
// VIDHELM_AUDIO_ONLY=<sections> runs a subset; VIDHELM_AUDIO_TIMING=0 reports bake times without
// asserting them (the 30 s bound assumes an idle machine); VIDHELM_KEEP=1 keeps the work folder.
import { build } from 'esbuild'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DIR = process.env.VIDHELM_AUDIO_CORPUS
if (!DIR) {
  console.log('SKIP  Fix voice corpus test: set VIDHELM_AUDIO_CORPUS to the corpus folder to run it')
  process.exit(0)
}
const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'electron', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const V = await load('voicebake.ts'), A = await load('audiochain.ts')
const FF = path.join(here, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
const FP = path.join(here, '..', 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')
const MEASURE = path.join(here, 'audiomeasure.mjs')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-audiocorpus-')), cache = path.join(work, 'voice')
const ver = await V.readFfmpegVersion(FF)

let pass = 0, fail = 0, skip = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }
const skipped = (l) => { skip++; console.log('  SKIP ', l) }
const near = (a, b, e) => Math.abs(a - b) <= e
const has = (f) => fs.existsSync(path.join(DIR, f))
// VIDHELM_AUDIO_ONLY=voice,preview,... runs only those sections (voice, match, cache, preview, mix, robustness, nosound)
const ONLY = (process.env.VIDHELM_AUDIO_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean)
const want = (section) => !ONLY.length || ONLY.includes(section)
const C = (f) => path.join(DIR, f)
const measure = (...a) => JSON.parse(execFileSync(process.execPath, [MEASURE, ...a, '--compact'], { encoding: 'utf8', maxBuffer: 1 << 26 }))
const ff = (args) => {
  const r = spawnSync(FF, ['-hide_banner', '-nostdin', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 })
  if (r.status !== 0) throw new Error((r.stderr || '').slice(-800))
  return r.stderr || ''
}
const pcm = (file) => {
  const buf = execFileSync(FF, ['-hide_banner', '-v', 'error', '-i', file, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 2 ** 31 - 1 })
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}
/** integrated loudness to 0.01 LU (the bake's own meter), true peak from ffmpeg's ebur128 */
const loud = (file) => {
  const m = A.createLoudnessMeter()
  m.push(pcm(file))
  const tp = /True peak:\s+Peak:\s*(-?[\d.]+)/.exec(ff(['-i', file, '-af', 'ebur128=peak=true:dualmono=true:framelog=quiet', '-f', 'null', '-']).split('Summary:').pop())
  return { I: m.finish().I, TP: tp ? +tp[1] : NaN }
}
const bake = async (file, preset = 'studio', picture = null) => {
  const t0 = Date.now()
  const r = await V.bakeVoice({ ffmpeg: FF, ffprobe: FP, cacheDir: cache, filePath: file, preset, ffmpegVersion: ver, picture })
  r.wall = (Date.now() - t0) / 1000
  return r
}
/** the design's master: a measured linear gain to -14, the 20 kHz lowpass, a -1.5 dBTP ceiling; then AAC 384k */
const master = (inF, outF, T = -14) => {
  let g = T - loud(inF).I, m
  for (let p = 0; p < 3; p++) {
    ff(['-i', inF, '-af', A.masterGraph(g), '-c:a', 'pcm_f32le', outF])
    m = loud(outF)
    if (Math.abs(T - m.I) <= 0.05) break
    g += T - m.I
  }
  const aac = outF.replace(/\.wav$/, '.m4a')
  ff(['-i', outF, '-c:a', 'aac', '-b:a', '384k', aac])
  return { gainDb: g, I: m.I, TP: m.TP, aacTP: loud(aac).TP }
}

// The duck metrics of the shoot-out's mixing judge (busmix/duck.mjs duckStats): the music's gain track
// (ducked / original, K-weighted 50 ms windows) read against the voice's speech segments and gaps.
function duckStats(origMusic, duckedMusic, voiceFile, staticDb) {
  const [kc1, kc2] = A.kWeighting(48000)
  const bq = (x, [b0, b1, b2, a1, a2]) => { const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v } return y }
  const split = (il) => { const n = il.length >> 1, L = new Float32Array(n), R = new Float32Array(n); for (let i = 0; i < n; i++) { L[i] = il[2 * i]; R[i] = il[2 * i + 1] } return { L, R, n } }
  const blockPowers = (a, k) => {
    const L = k ? bq(bq(a.L, kc1), kc2) : a.L, R = k ? bq(bq(a.R, kc1), kc2) : a.R
    const B = Math.floor(a.n / 480), p = new Float64Array(B)
    for (let b = 0; b < B; b++) { let s = 0; for (let i = b * 480; i < (b + 1) * 480; i++) s += L[i] * L[i] + R[i] * R[i]; p[b] = s / 480 }
    return p
  }
  const slide = (p, w) => { const B = p.length, out = new Float64Array(B), h = Math.floor(w / 2), c = new Float64Array(B + 1); for (let i = 0; i < B; i++) c[i + 1] = c[i] + p[i]; for (let i = 0; i < B; i++) { const a = Math.max(0, i - h), b = Math.min(B, i - h + w); out[i] = (c[b] - c[a]) / Math.max(1, b - a) } return out }
  const toDb = (p) => (p > 1e-14 ? 10 * Math.log10(p) : -140)
  const pct = (arr, q) => { const s = Float64Array.from(arr).sort(); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))] : NaN }
  const median = (arr) => pct(arr, 0.5)
  const mergeSegs = (segs, gap) => { const out = []; for (const g of segs) { const last = out[out.length - 1]; if (last && g.s - last.e < gap) last.e = Math.max(last.e, g.e); else out.push({ ...g }) } return out }
  const po = slide(blockPowers(split(pcm(origMusic)), true), 5), pd = slide(blockPowers(split(pcm(duckedMusic)), true), 5)
  const B = Math.min(po.length, pd.length), g = new Float64Array(B)
  for (let b = 0; b < B; b++) g[b] = toDb(pd[b]) - toDb(po[b]) - staticDb
  const vp = slide(blockPowers(split(pcm(voiceFile)), false).map((x) => x / 2), 10)
  const vdb = Array.from(vp, toDb), top = [...vdb].sort((a, b) => b - a).slice(0, Math.floor(vdb.length / 2))
  const speech = top.reduce((s, x) => s + x, 0) / top.length
  const isSp = vdb.map((x) => x > speech - 20), isGap = vdb.map((x) => x < speech - 30)
  let segs = []
  for (let i = 0; i < Math.min(B, isSp.length);) { if (!isSp[i]) { i++; continue } let j = i; while (j < B && isSp[j]) j++; segs.push({ s: i, e: j }); i = j }
  segs = mergeSegs(segs.map((x) => ({ s: x.s / 100, e: x.e / 100 })), 1.0).filter((x) => x.e - x.s >= 0.5)
  const interior = [], onsets = []
  for (const s of segs) { for (let b = Math.round(s.s * 100) + 30; b < Math.round(s.e * 100); b++) if (b < B) interior.push(b); onsets.push(Math.round(s.s * 100)) }
  const gi = interior.map((b) => g[b]), iset = new Set(interior)
  const steps = interior.filter((b) => b + 10 < B && iset.has(b + 10)).map((b) => Math.abs(g[b + 10] - g[b]))
  const gaps = []
  for (let i = 0; i < B;) { if (!isGap[i]) { i++; continue } let j = i; while (j < B && isGap[j]) j++; if (j - i >= 100) gaps.push({ s: i, e: j }); i = j }
  const settled = [], recov = []
  for (const q of gaps) {
    const set = []
    for (let b = q.s + 50; b < q.e; b++) set.push(g[b])
    const topG = Math.max(...set); settled.push(...set)
    let r = null
    for (let b = q.s; b < q.e; b++) if (g[b] >= topG - 1) { r = (b - q.s) / 100; break }
    if (q.s > 5) recov.push(r)
  }
  const gapSet = median(settled), under = median(gi), depth = gapSet - under
  const onsetFrac = onsets.filter((b) => b > 50).map((b) => (gapSet - g[b]) / Math.max(0.1, depth))
  const mean = gi.reduce((s, x) => s + x, 0) / gi.length
  return {
    underSpeechStdevDb: Math.sqrt(gi.reduce((s, x) => s + (x - mean) ** 2, 0) / gi.length),
    musicStepP95Db: pct(steps, 0.95), duckDepthDb: depth,
    onsetDuckFracMin: Math.min(...onsetFrac), recoveryMaxS: Math.max(...recov.filter((r) => r != null)),
  }
}

console.log(`Fix voice corpus test (corpus: ${DIR}, work: ${work})`)

// ---- the five voice files: the design's thresholds; null = not asserted for that file ----
// Floor rise minus speech gain on the phone: the design asks -5, but that was measured with the 6 dB
// room ease; the 3 dB ease it then chose measured -3.9 (its own table: room -47.1 dBFS), so -3.5 here.
const VOICE = {
  quiet_clean: { step: 1.5, spread: null, room: -57, riseMinusGain: null, wobble: 1.0, bands: true },
  quiet_noisy: { step: 1.5, spread: 1.3, room: -55, riseMinusGain: -13, wobble: 2.8, bands: true },
  uneven: { step: 1.8, spread: 1.6, room: -68, riseMinusGain: -9, wobble: 4.0, bands: true },
  peaky: { step: 1.8, spread: null, room: -63, riseMinusGain: null, wobble: 1.2, bands: false },
  phone_raw: { step: 3.6, spread: 1.6, room: -46, riseMinusGain: -3.5, wobble: 6.0, bands: true },
}
const baked = {}
for (const [name, th] of Object.entries(want('voice') ? VOICE : {})) {
  console.log(name)
  if (!has(`${name}.wav`)) { skipped(`${name}.wav not in the corpus folder`); continue }
  const src = C(`${name}.wav`), r = await bake(src)
  if (r.error || !r.path) { ok(false, `${name}: bake failed (${r.error || r.skipped})`); continue }
  const m = measure(r.path, '--ref', src), v = m.vsRef, sw = v.sameWindows
  baked[name] = { r, m }
  ok(near(m.integratedLufs, -16, 0.2) && m.truePeakDbtp <= -3.2 && m.clippedSamples === 0, `${m.integratedLufs} LUFS, ${m.truePeakDbtp} dBTP, ${m.clippedSamples} clipped`)
  ok(Math.abs(v.lagMs) <= 1 && Math.abs(v.durationDeltaS) <= 0.005, `lag ${v.lagMs} ms, length change ${v.durationDeltaS} s`)
  ok(v.gainTrack.speechStepP95Db <= th.step, `gain step P95 during speech ${v.gainTrack.speechStepP95Db} dB (<= ${th.step})`)
  if (th.spread != null) ok(m.shortTermSpreadDb <= th.spread, `short-term spread ${m.shortTermSpreadDb} dB (<= ${th.spread}; raw ${v.refSummary.shortTermSpreadDb})`)
  if (th.riseMinusGain != null) ok(sw.floorRiseDb - sw.speechGainDb <= th.riseMinusGain, `room rose ${sw.floorRiseDb} dB for ${sw.speechGainDb} dB of speech (difference <= ${th.riseMinusGain})`)
  ok(sw.gapStdevDb <= th.wobble, `in-pause wobble ${sw.gapStdevDb} dB (<= ${th.wobble}; raw ${sw.refGapStdevDb})`)
  if (th.bands) {
    const d = v.bandsSpeechDeltaDb
    ok(Object.values(d).every((x) => Math.abs(x) <= 1.5), `no tonal change: speech bands within 1.5 dB (${Object.values(d).join(', ')})`)
  }
  const mo = path.join(work, `${name}.master.wav`), ms = master(r.path, mo), mm = measure(mo, '--ref', src)
  const room = v.refSummary.noiseFloorDbfs + mm.vsRef.sameWindows.floorRiseDb
  ok(room <= th.room, `room after the -14 master ${room.toFixed(1)} dBFS (<= ${th.room})`)
  ok(near(ms.I, -14, 0.15) && ms.TP <= -1.4 && ms.aacTP <= -1.2, `master ${ms.I.toFixed(2)} LUFS, ${ms.TP} dBTP, AAC ${ms.aacTP} dBTP`)
  // the design's bound is for an otherwise idle machine; on a shared one VIDHELM_AUDIO_TIMING=0 reports it instead
  if (process.env.VIDHELM_AUDIO_TIMING === '0') console.log(`  NOTE  baked in ${r.wall.toFixed(1)} s for ${m.durationS} s of sound (timing not asserted)`)
  else ok(r.wall < 30, `baked in ${r.wall.toFixed(1)} s for ${m.durationS} s of sound (an idle machine; VIDHELM_AUDIO_TIMING=0 on a busy one)`)
  console.log(`    ${r.summary} | ${JSON.stringify(r.output)}`)
}

console.log('match: five sources, one level')
if (want('match')) {
  const Is = Object.values(baked).map((b) => loud(b.r.path).I)
  if (Is.length < 2) skipped('needs the voice files')
  else ok(Math.max(...Is) - Math.min(...Is) <= 0.3, `spread across ${Is.length} baked clips ${(Math.max(...Is) - Math.min(...Is)).toFixed(2)} LU (${Is.map((x) => x.toFixed(2)).join(', ')})`)
}

console.log('cache')
if (!want('cache')) skipped('not asked for')
else if (baked.quiet_noisy) {
  const again = await bake(C('quiet_noisy.wav'))
  ok(again.cached && again.path === baked.quiet_noisy.r.path && again.wall < 1, `second ask is the cached bake (${again.wall.toFixed(2)} s)`)
  const light = await bake(C('quiet_noisy.wav'), 'light')
  ok(!light.cached && light.path !== again.path && light.decisions.nrDb === 0 && light.effective === 'light', 'another preset is another bake (Light: no noise reduction)')
} else skipped('needs quiet_noisy.wav')

console.log('preview copy for video media')
if (!want('preview')) skipped('not asked for')
else if (has('quiet_noisy.wav')) {
  // a camera-like file: a test picture with the quiet voice, audio starting 0.1 s after the picture
  const vid = path.join(work, 'camera.mp4')
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=12', '-itsoffset', '0.1', '-i', C('quiet_noisy.wav'), '-map', '0:v', '-map', '1:a', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '160k', vid])
  const r = await bake(vid, 'studio', vid)
  const probe = (f) => JSON.parse(execFileSync(FP, ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', f], { encoding: 'utf8' }))
  const p = r.previewPath ? probe(r.previewPath) : null
  ok(!r.error && r.path?.endsWith('.flac') && r.previewPath?.endsWith('.mp4') && p?.streams.some((s) => s.codec_type === 'video') && p?.streams.some((s) => s.codec_type === 'audio'), `a video gets the FLAC plus a playable copy (${r.error || path.basename(r.previewPath || '')})`)
  // on the media's own clock (the camera's sound decoded against its timestamps), the bake and the
  // preview copy must both sit exactly where the camera's sound sits: 0.1 s in, AAC priming and all
  const clock = (f, out) => { ff(['-i', f, '-vn', '-af', A.headFilter(), '-c:a', 'pcm_f32le', out]); return out }
  const refClock = clock(vid, path.join(work, 'camera.clock.wav'))
  const lagBake = measure(r.path, '--ref', refClock).vsRef, lagPrev = measure(clock(r.previewPath, path.join(work, 'preview.clock.wav')), '--ref', refClock).vsRef
  ok(Math.abs(lagBake.lagMs) <= 1 && Math.abs(lagBake.durationDeltaS) <= 0.005, `the bake is on the media clock: lag ${lagBake.lagMs} ms, length change ${lagBake.durationDeltaS} s`)
  ok(Math.abs(lagPrev.lagMs) <= 1, `and so is the preview copy: lag ${lagPrev.lagMs} ms`)
  const again = await bake(vid, 'studio', vid)
  ok(again.cached && again.previewPath === r.previewPath, 'cached with its preview copy')
  // the video proxy arrives later: only the preview copy is made again, from the new picture
  const proxy = path.join(work, 'camera.proxy.mp4')
  ff(['-i', vid, '-map', '0:v', '-map', '0:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-c:a', 'aac', '-b:a', '160k', proxy])
  const withProxy = await bake(vid, 'studio', proxy)
  ok(!withProxy.cached && withProxy.path === r.path && withProxy.previewPath !== r.previewPath && fs.existsSync(withProxy.previewPath) && withProxy.seconds === r.seconds,
    `a new picture re-muxes only (same bake, new copy in ${withProxy.wall.toFixed(1)} s)`)
  const lagProxy = measure(clock(withProxy.previewPath, path.join(work, 'proxy.clock.wav')), '--ref', refClock).vsRef
  ok(Math.abs(lagProxy.lagMs) <= 1, `and the proxy's copy is on the media clock too: lag ${lagProxy.lagMs} ms`)
} else skipped('needs quiet_noisy.wav')

console.log('voice over music: the keyframe duck and the bed')
if (!want('mix')) skipped('not asked for')
else if (has('stems/voice_music_voice.wav') && has('stems/voice_music_music.wav')) {
  const vs = C('stems/voice_music_voice.wav'), msF = C('stems/voice_music_music.wav')
  const r = await bake(vs)
  const traps = A.duckTraps(r.segments)
  const bed = A.bedDb(loud(msF).I)
  const graph = path.join(work, 'music.txt')
  fs.writeFileSync(graph, A.musicBusGraph({ inputs: ['0:a'], bedDb: bed, traps }))
  const mOut = path.join(work, 'music.wav'), pre = path.join(work, 'pre.wav'), mst = path.join(work, 'mix.master.wav')
  ff(['-i', msF, '-filter_complex_script', graph, '-map', '[mbus]', '-c:a', 'pcm_f32le', mOut])
  ff(['-i', r.path, '-i', mOut, '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0:duration=longest[o]', '-map', '[o]', '-c:a', 'pcm_f32le', pre])
  const M = master(pre, mst)
  // the stems as they sit in the master, for the balance block
  const gv = path.join(work, 'v.m.wav'), gm = path.join(work, 'm.m.wav')
  ff(['-i', r.path, '-af', `volume=${M.gainDb.toFixed(3)}dB`, '-c:a', 'pcm_f32le', gv])
  ff(['-i', mOut, '-af', `volume=${M.gainDb.toFixed(3)}dB`, '-c:a', 'pcm_f32le', gm])
  const b = measure(mst, '--voice', gv, '--music', gm).balance, d = duckStats(msF, mOut, r.path, bed)
  ok(b.voiceMinusMusicLu >= 15 && b.voiceMinusMusicWorstSegmentLu >= 14.5, `voice over bed ${b.voiceMinusMusicLu} LU, worst segment ${b.voiceMinusMusicWorstSegmentLu} (bed ${bed.toFixed(2)} dB, ${traps.length} ducks)`)
  ok(d.underSpeechStdevDb <= 0.3 && d.musicStepP95Db <= 0.5, `music under speech is flat: stdev ${d.underSpeechStdevDb.toFixed(2)} dB, step P95 ${d.musicStepP95Db.toFixed(2)} dB`)
  ok(d.onsetDuckFracMin >= 0.95, `fully ducked on every first word (${d.onsetDuckFracMin.toFixed(2)})`)
  ok(d.recoveryMaxS <= 0.6, `the bed is back within ${d.recoveryMaxS.toFixed(2)} s of a pause`)
  ok(near(M.I, -14, 0.15) && M.TP <= -1.4 && M.aacTP <= -1.2, `mix master ${M.I.toFixed(2)} LUFS, ${M.TP} dBTP, AAC ${M.aacTP} dBTP`)
} else skipped('needs stems/voice_music_voice.wav and stems/voice_music_music.wav')

console.log('robustness')
if (want('robustness')) {
  const S = (f) => C(path.join('stress', f))
  const refI = baked.quiet_noisy ? loud(baked.quiet_noisy.r.path).I : null
  for (const f of ['mono44k.wav', 'mono48k.wav', 'st44k.wav', 'aac.m4a']) {
    if (!has(`stress/${f}`) || refI == null) { skipped(`${f} (needs it and quiet_noisy.wav)`); continue }
    const r = await bake(S(f))
    if (r.error || !r.path) { ok(false, `${f}: ${r.error || r.skipped}`); continue }
    const m = measure(r.path, '--ref', S(f)), I = loud(r.path).I
    ok(near(I, refI, 0.1) && Math.abs(m.vsRef.lagMs) <= 1, `${f}: ${I.toFixed(2)} LUFS (48 kHz stereo ${refI.toFixed(2)}), lag ${m.vsRef.lagMs} ms`)
  }
  if (has('stress/roomonly.wav')) {
    const r = await bake(S('roomonly.wav'))
    ok(!!r.skipped && !r.path && r.summary === 'No clear speech, left as is', `room tone only is left as is (${r.skipped})`)
  } else skipped('roomonly.wav')
  if (has('stress/alreadyloud.wav')) {
    const r = await bake(S('alreadyloud.wav')), m = measure(r.path, '--ref', S('alreadyloud.wav'))
    ok(near(m.integratedLufs, -16, 0.2) && r.decisions.staticDb < 0, `already loud is turned down: ${m.integratedLufs} LUFS, static ${r.decisions.staticDb} dB`)
  } else skipped('alreadyloud.wav')
  if (has('stress/short.wav')) {
    const r = await bake(S('short.wav')), m = measure(r.path, '--ref', S('short.wav'))
    ok(near(m.integratedLufs, -16, 0.2) && m.vsRef.gainTrack.speechStepP95Db <= 1.2, `4.5 s clip: ${m.integratedLufs} LUFS, step ${m.vsRef.gainTrack.speechStepP95Db} dB`)
  } else skipped('short.wav')
  if (has('stress/sparse.wav')) {
    const r = await bake(S('sparse.wav')), m = measure(r.path, '--ref', S('sparse.wav'))
    ok(r.effective === 'light' && r.decisions.sparse && m.vsRef.gainTrack.speechStepP95Db <= 1.5, `sparse speech runs the Light rules: step ${m.vsRef.gainTrack.speechStepP95Db} dB (8.2 with NR)`)
  } else skipped('sparse.wav')
  if (has('stress/premixed.wav')) {
    const an = await V.analyzeMedia(FF, S('premixed.wav'))
    const asVideo = A.roleGuess(an, { isVideo: true }), asAudio = A.roleGuess(an, { track: 'a1' })
    ok(asVideo.role === 'asis' && asAudio.role !== 'voice', `voice over music in one file is never guessed Voice (${asVideo.role} on a video: ${asVideo.why}; ${asAudio.role} as audio)`)
  } else skipped('premixed.wav')
  if (has('stress/long10min.wav')) {
    // in a process of its own, so the number is the bake's and not this test's decoded files
    const bundle = path.join(work, 'voicebake.bundle.mjs'), runner = path.join(work, 'rss-runner.mjs')
    fs.writeFileSync(bundle, (await build({ entryPoints: [path.join(here, '..', 'electron', 'voicebake.ts')], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })).outputFiles[0].text)
    fs.writeFileSync(runner, `import * as V from ${JSON.stringify(pathToFileURL(bundle).href)}
let peak = process.memoryUsage().rss
const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 50)
const t0 = Date.now(), r = await V.bakeVoice(JSON.parse(process.argv[2]))
clearInterval(iv)
console.log(JSON.stringify({ r, peak, wall: (Date.now() - t0) / 1000 }))`)
    const { r, peak, wall } = JSON.parse(execFileSync(process.execPath, [runner, JSON.stringify({ ffmpeg: FF, ffprobe: FP, cacheDir: cache, filePath: S('long10min.wav'), preset: 'studio', ffmpegVersion: ver })], { encoding: 'utf8', maxBuffer: 1 << 26 }))
    ok(!r.error && near(loud(r.path).I, -16, 0.2), `10 minutes: ${r.error || r.summary}, ${wall.toFixed(1)} s`)
    ok(peak < 300 * 2 ** 20, `streamed: the bake process peaked at ${(peak / 2 ** 20).toFixed(0)} MB (< 300)`)
  } else skipped('long10min.wav')
}

console.log('a file with no sound')
if (want('nosound')) {
  const silent = path.join(work, 'picture-only.mp4')
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', silent])
  const r = await bake(silent)
  let direct = ''
  try { await V.analyzeMedia(FF, silent) } catch (e) { direct = String(e.message) }
  ok(r.error === 'this file has no sound' && direct === 'this file has no sound', `said plainly (${r.error}; ${direct})`)
}

if (!process.env.VIDHELM_KEEP) try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* a file still open: the OS temp cleaner gets it */ }
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`)
process.exit(fail ? 1 : 0)
