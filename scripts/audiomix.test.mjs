// Tests for the export's sound: the planner (electron/audiomix.ts, pure) and the runner
// (electron/mixrender.ts) against the REAL bundled ffmpeg on a few seconds of generated sound, because
// every mistake here is silent: ffmpeg exits 0 with the music a little too loud, a mono mic 3 dB down,
// or a master that lands a dB off its target. Run: npm run test:audiomix
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'electron', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const M = await load('audiomix.ts'), R = await load('mixrender.ts'), A = await load('audiochain.ts'), V = await load('voicebake.ts')
const FF = path.join(here, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
const FP = path.join(here, '..', 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-audiomix-'))
const T = (n) => path.join(tmp, n)

let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }
const near = (a, b, e) => Math.abs(a - b) <= e
const ff = (args) => {
  const r = spawnSync(FF, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 })
  if (r.status !== 0) throw new Error(r.stderr.slice(-600))
  return r
}
/** interleaved stereo float samples of a file */
const pcm = (file) => {
  const r = spawnSync(FF, ['-hide_banner', '-v', 'error', '-i', file, '-ac', '2', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 })
  return new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength))
}
/** RMS dBFS of one channel (0 = left, 1 = right) between two times */
const chDb = (x, ch, from, to) => {
  let s = 0, n = 0
  for (let i = Math.round(from * 48000); i < Math.min(x.length / 2, Math.round(to * 48000)); i++) { s += x[2 * i + ch] ** 2; n++ }
  return 10 * Math.log10(s / Math.max(1, n) + 1e-20)
}
const loud = (file) => { const m = A.createLoudnessMeter(); m.push(pcm(file)); return m.finish().I }
/** [pts, duration] of every audio packet */
const packetsOf = (file) => spawnSync(FP, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'packet=pts,duration', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  .stdout.split(/\r?\n/).filter((l) => /^-?\d+,\d+/.test(l)).map((l) => l.split(',').map(Number))
/** ebur128's true peak, dBTP */
const truePeak = (file) => +(/True peak:\s+Peak:\s*(-?[\d.]+)/.exec(spawnSync(FF, ['-hide_banner', '-i', file, '-vn', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.split('Summary:').pop()) || [])[1]
const loudSlice = (x, from, to) => { const m = A.createLoudnessMeter(); m.push(x.subarray(Math.round(from * 48000) * 2, Math.round(to * 48000) * 2)); return m.finish().I }

try {
  console.log('\n-- volume automation: the expression the export always used --')
  {
    const e = M.volumeExpr([{ t: 1, v: 0.5 }, { t: 0, v: 1 }], 10)
    ok(e === 'if(lt(t\\,10)\\,1\\,if(lt(t\\,11)\\,(1+(0.5-1)*(t-10)/1)\\,0.5))', `points sorted, timeline time, linear between (${e})`)
    ok(M.volumeExpr([], 0) === null && M.clipGain({ start: 0, volume: 0.7 }) === 0.7 && M.clipGain({ start: 0 }) === 1, 'no points: the flat volume (default 1)')
  }

  console.log('\n-- which clips are heard --')
  {
    const c = (o) => ({ start: 0, duration: 2, hasAudio: true, path: 'a.wav', trackId: 'a1', volume: 1, ...o })
    const kept = M.audibleClips([c({ id: 1 }), c({ id: 2, trackId: 'v2' }), c({ id: 3, volume: 0 }), c({ id: 4, hasAudio: false }), c({ id: 5, volume: 0, volumePoints: [{ t: 0, v: 0 }, { t: 1, v: 0.5 }] }), c({ id: 6, volumePoints: [{ t: 0, v: 0 }] }), c({ id: 7, path: undefined })])
    ok(JSON.stringify(kept.map((x) => x.id)) === '[1,5]', `b-roll, muted, silent and pathless clips are left out; automation that rises is kept (${kept.map((x) => x.id)})`)
  }

  console.log('\n-- where a file came from, and its role --')
  {
    const dirs = { score: 'C:\\Users\\x\\AppData\\VidHelm\\sfx\\score', sfx: 'C:\\Users\\x\\AppData\\VidHelm\\sfx', narration: 'C:/Users/x/AppData/VidHelm/narration' }
    ok(M.provenanceFromPath('C:/Users/x/AppData/VidHelm/sfx/score/bed 120.wav', dirs) === 'score' && M.provenanceFromPath('c:\\users\\x\\appdata\\vidhelm\\sfx\\whoosh.wav', dirs) === 'sfx', 'score before the SFX library it sits in; case and slashes do not matter')
    ok(M.provenanceFromPath('C:/Users/x/AppData/VidHelm/narration/1700/out/1.wav', dirs) === 'narration' && M.provenanceFromPath('D:/proj/voice/voiceover 2026-10-05 09-52-00.webm', dirs) === 'voiceover', 'narration, and voiceover/booth takes by name')
    ok(M.provenanceFromPath('D:/footage/C0001.MP4', dirs) === undefined && M.provenanceFromPath('C:/Users/x/AppData/VidHelm/sfxtra/a.wav', dirs) === undefined, 'anything else is unknown (a folder that merely starts the same is not inside)')
    const speech = { guessVideo: { role: 'voice', why: 'speech' }, guessAudio: { role: 'voice', why: 'speech' } }
    const steady = { guessVideo: { role: 'asis', why: 'continuous' }, guessAudio: { role: 'music', why: 'continuous' } }
    ok(M.resolveRole({ role: 'music', trackId: 'v1', type: 'video' }, speech).role === 'music', 'a role set on the clip wins')
    ok(M.resolveRole({ trackId: 'a2', type: 'audio' }, speech).role === 'sfx' && M.resolveRole({ trackId: 'a1', type: 'audio' }, { ...speech, provenance: 'score' }).role === 'music', 'the SFX track and make_score decide before the measurement')
    ok(M.resolveRole({ trackId: 'a1', type: 'audio' }, { ...steady, provenance: 'voiceover' }).role === 'voice', 'a voiceover take is a voice whatever it measured')
    ok(M.resolveRole({ trackId: 'v1', type: 'video' }, steady).role === 'asis' && M.resolveRole({ trackId: 'a1', type: 'audio' }, steady).role === 'music' && M.resolveRole({ trackId: 'v1', type: 'video' }, speech).role === 'voice', 'measured: speech is a voice; continuous sound is music on its own, As is under a picture')
    ok(M.resolveRole({ trackId: 'a1', type: 'audio' }, null).role === 'asis', 'a file that could not be measured plays as recorded')
    ok(M.busOf('asis') === 'voice' && M.busOf('music') === 'music' && M.busOf('sfx') === 'sfx', 'As is rides the voice bus (never ducked)')
  }

  console.log('\n-- role levels --')
  {
    ok(near(M.roleLevelDb('music', { I: -22 }), 1, 1e-9) && near(M.roleLevelDb('sfx', { M: -8.6 }), -7.4, 1e-9), 'the bed 5 LU under the voice; an SFX peak at the voice level')
    ok(M.roleLevelDb('voice', { I: -40 }) === 0 && M.roleLevelDb('asis', { I: -40 }) === 0, 'voices (already baked) and As is keep their level')
    ok(M.roleLevelDb('music', { I: -60 }) === 18 && M.roleLevelDb('sfx', { M: 20 }) === -24 && M.roleLevelDb('music', { I: -Infinity }) === 0 && M.roleLevelDb('music', null) === 0, 'capped; nothing measured, nothing changed')
  }

  console.log('\n-- the plan: inputs, buses, the exact length --')
  {
    const v = { start: 0, duration: 4, sourceStart: 1.5, volume: 1, role: 'voice', file: 'v.flac', channels: 2, segments: [[2, 4], [8, 9]] }
    const mu = { start: 0, duration: 6, volume: 0.5, role: 'music', file: 'm.wav', channels: 1, levelDb: 1.25 }
    const sx = { start: 3, duration: 1, volume: 1, role: 'sfx', file: 's.wav', channels: 2, levelDb: -7.4 }
    const p = M.planMix([v, mu, sx], { totalS: 6.5 })
    ok(p.inputs.length === 4 && p.inputs[0].join(' ').includes('anullsrc=channel_layout=stereo:sample_rate=48000:d=6.500'), 'input 0 is the silent bed the length comes from')
    ok(p.inputs[1].join(' ') === '-ss 1.500 -t 4.200 -i v.flac' && p.inputs[2].join(' ') === '-t 6.200 -i m.wav', 'clips are opened at their in-point with a short tail, as the picture is')
    ok(p.graph.includes('[2:a]pan=stereo|c0=c0|c1=c0,volume=1.25dB[p2]') && p.graph.includes('[3:a]volume=-7.40dB[p3]') && !p.graph.includes('[1:a]pan'), 'mono copied to both sides, the role level in front of the clip chain')
    ok(p.graph.includes('[0:a][c1]amix=inputs=2:duration=first') && p.graph.includes('[c2]volume=0.00dB,asetnsamples=n=48:p=0') && p.graph.includes('[c3]volume=0.00dB'), 'voice bus with the bed; music and SFX buses')
    ok(p.graph.endsWith(`[vbus][mbus][sbus]amix=inputs=3:duration=first:dropout_transition=0:normalize=0,${A.LOWPASS_20K},apad=whole_len=${6.5 * 48000},atrim=end_sample=${6.5 * 48000}[pre]`), 'the sum gets the 20 kHz low-pass and is exactly the timeline long')
    // the voice's speech (source 2-4 s and 8-9 s, the clip reads 1.5-5.5) is on the timeline at 0.5-2.5 only
    ok(p.traps.music.length === 1 && near(p.traps.music[0].a1, 0.42, 1e-9) && near(p.traps.music[0].b0, 2.65, 1e-9) && p.traps.sfx[0].depthDb === 6, 'ducks from the voice clip\'s speech in timeline time, 10 dB for music, 6 for SFX')
    ok(p.buses.voice === 1 && p.buses.music === 1 && p.buses.sfx === 1, 'one clip per bus')
    const off = M.planMix([v, mu], { totalS: 6.5, duck: false })
    ok(!off.graph.includes('pow(10') && off.traps.music.length === 0, 'Duck off: no duck expression')
    const solo = M.planMix([v, mu, sx], { totalS: 6.5, solo: 'music' })
    ok(solo.inputs.length === 2 && solo.graph.includes("volume='pow(10") && solo.graph.includes('[0:a]anull[vbus]') && !solo.graph.includes('sbus'), 'a solo bus keeps the ducks drawn from the voice it leaves out')
    const quiet = M.planMix([], { totalS: 2 })
    ok(quiet.graph === `[0:a]anull[vbus];[vbus]${A.LOWPASS_20K},apad=whole_len=96000,atrim=end_sample=96000[pre]`, 'nothing heard: silence of the right length')
  }

  console.log('\n-- the duck as a binary search (one term per frame) --')
  {
    const segs = []
    for (let i = 0; i < 60; i++) segs.push([3 + i * 5, 5.5 + i * 5])
    const traps = A.duckTraps(segs)
    const expr = A.trapezoidTreeExpr(traps)
    const js = (e) => new Function('t', `const pow = Math.pow, clip = (x, a, b) => Math.min(b, Math.max(a, x)), lt = (a, b) => (a < b ? 1 : 0), IF = (c, a, b) => (c ? a : b); return ${e.replace(/\bif\(/g, 'IF(')}`)
    const f = js(expr)
    let maxErr = 0
    for (let t = 0; t < 310; t += 0.0137) maxErr = Math.max(maxErr, Math.abs(20 * Math.log10(f(t)) - A.evalTrapezoidsDb(traps, t)))
    ok(traps.length === 60 && expr.startsWith('pow(10,(0.00+if(lt(t,') && maxErr < 1e-6, `60 ducks: the tree gives the trapezoid envelope exactly (max error ${maxErr.toExponential(1)} dB)`)
    ok(A.trapezoidTreeExpr(traps.slice(0, 2)) === A.trapezoidExpr(traps.slice(0, 2)), 'two or fewer stay the flat sum')
    const overl = [{ a0: 0, a1: 0.2, b0: 2, b1: 2.3, depthDb: 10 }, { a0: 1, a1: 1.2, b0: 3, b1: 3.3, depthDb: 6 }, { a0: 5, a1: 5.2, b0: 6, b1: 6.3, depthDb: 10 }]
    ok(A.trapezoidTreeExpr(overl) === A.trapezoidExpr(overl), 'overlapping trapezoids fall back to the flat sum')
    const t0 = Date.now()
    const segs200 = []
    for (let i = 0; i < 200; i++) segs200.push([i * 3 + 0.5, i * 3 + 1.5])
    fs.writeFileSync(T('duck.txt'), `[0:a]asetnsamples=n=48:p=0,volume='${A.trapezoidTreeExpr(A.duckTraps(segs200))}':eval=frame[o]`)
    ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=600', '-filter_complex_script', T('duck.txt'), '-map', '[o]', '-f', 'null', '-'])
    const secs = (Date.now() - t0) / 1000
    ok(secs < 10, `ten minutes with 200 ducks renders in ${secs.toFixed(1)} s (the flat sum took about 20)`)
  }

  console.log('\n-- the master --')
  {
    const m = M.planMaster({ I: -16.4, TP: -5.0, optimize: true, target: 'youtube', masterVolume: 1 })
    ok(near(m.gainDb, 2.4, 1e-9) && near(m.plannedLufs, -14, 1e-9) && m.targetLufs === -14 && m.filter === `volume=2.40dB,${A.limiterFilter(-1.5)}` && m.filter.includes('limit=0.84140') && !m.limiterLikely, 'Optimize: a linear gain to -14 and the 4x oversampled -1.5 dBTP ceiling, idle here')
    const half = M.planMaster({ I: -16.4, TP: -3.0, optimize: true, masterVolume: 0.5 })
    ok(near(half.gainDb, 2.4 + 20 * Math.log10(0.5), 1e-9) && near(half.plannedLufs, -20.02, 0.01), `Master volume 0.5 is ${(20 * Math.log10(0.5)).toFixed(2)} dB under the target (lands at ${half.plannedLufs.toFixed(2)})`)
    const hot = M.planMaster({ I: -16.4, TP: -3.0, optimize: true, masterVolume: 1.5 })
    ok(hot.limiterLikely && near(hot.plannedLufs, -14 + 20 * Math.log10(1.5), 1e-9), 'a hot Master volume reaches the ceiling, so it gets measured')
    ok(M.planMaster({ I: -20, TP: -8, optimize: true, target: 'podcast' }).plannedLufs === -16 && M.planMaster({ I: -20, TP: -8, optimize: true, target: 'broadcast' }).gainDb === -3, 'podcast -16, broadcast -23')
    const raw = M.planMaster({ I: -18, TP: -6, optimize: false, masterVolume: 0.8 })
    ok(raw.targetLufs === null && raw.filter.startsWith('volume=0.8,aresample=192000,alimiter=limit=0.89125') && near(raw.plannedLufs, -18 + 20 * Math.log10(0.8), 1e-9), 'Optimize off: the Master volume and a -1 dBTP ceiling only')
    const silent = M.planMaster({ I: -Infinity, TP: null, optimize: true })
    ok(silent.plannedLufs === null && silent.gainDb === 0 && !silent.limiterLikely, 'a silent timeline is not chased toward a target')
    ok(M.planMaster({ I: -16, TP: -3, optimize: true, masterVolume: 0 }).filter === 'volume=0', 'Master volume 0 is silence')
    ok(M.planMaster({ I: -60, TP: -40, optimize: true }).gainDb === 30, 'the lift is capped at +30 dB (a near-silent mix is mostly room)')
  }

  console.log('\n-- Watch & Verify: loudness against the plan --')
  {
    const yt = { targetLufs: -14, plannedLufs: -14 }
    const c = M.loudnessChecks({ I: -14.04, TP: -1.4, codec: 'aac' }, yt)
    ok(c.length === 3 && c.every((x) => x.status === 'pass') && c[0].label === 'Loudness (target −14 LUFS)', `on target: ${c.map((x) => `${x.label} ${x.detail}`).join(' | ')}`)
    ok(c[2].label === 'Loudness plan' && c[2].detail === 'planned -14.0, measured -14.0 LUFS, -1.4 dBTP (AAC)', 'planned vs measured, in words')
    ok(M.loudnessChecks({ I: -14, TP: -0.9, codec: 'aac' }, yt)[1].status === 'fail' && M.loudnessChecks({ I: -14, TP: -1.0 }, yt)[1].status === 'pass', 'the delivered true peak fails above -1.0 dBTP')
    ok(M.loudnessChecks({ I: -16, TP: -2 }, { targetLufs: -16, plannedLufs: -16 })[0].status === 'pass' && M.loudnessChecks({ I: -16, TP: -2 })[0].status === 'warn', 'a podcast export is judged as one; the same file from elsewhere is 2 LU under YouTube')
    const quiet = M.loudnessChecks({ I: -20.1, TP: -7 }, { targetLufs: -14, plannedLufs: -20.02 })
    ok(quiet[0].status === 'warn' && /Master volume puts it 6\.0 dB under/.test(quiet[0].detail) && quiet[2].status === 'pass', `a Master volume of 50 percent is a choice, not a failure (${quiet[0].detail})`)
    ok(M.loudnessChecks({ I: -25, TP: -9 })[0].status === 'fail' && M.loudnessChecks({ I: -14.9, TP: -3 }, { targetLufs: -14, plannedLufs: -14 })[2].status === 'warn', 'far off the target fails; a plan missed by 0.9 LU is a warning')
    const s = M.soundCheck({ targetLufs: -14, plannedLufs: -14, roles: { voice: 3, music: 1, sfx: 2 }, baked: 3, notes: [] })
    ok(s.status === 'pass' && s.detail === '3 voice clips (Fix voice on 3), 1 music clip, 2 sound effects', `"${s.detail}"`)
    ok(M.soundCheck({ targetLufs: -14, plannedLufs: -14, roles: { voice: 1 }, baked: 0, notes: ['Fix voice could not run on a.mp4 (x), so it plays as recorded'] }).status === 'warn' && M.soundCheck(null) === null, 'anything that did not go to plan is a warning; a file from elsewhere has no line')
  }

  // ---- real renders ----
  // "speech": pink bursts 2 s on / 3 s off at about -24 dBFS over a -70 dBFS room; a steady two-tone bed; a mono tone
  ff(['-f', 'lavfi', '-i', 'anoisesrc=c=pink:a=0.25:r=48000:d=20:seed=7', '-f', 'lavfi', '-i', 'anoisesrc=c=white:a=0.0004:r=48000:d=20:seed=9',
    '-filter_complex', "[0:a]volume='if(lt(mod(t,5),2),1,0)':eval=frame[b];[b][1:a]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo[o]", '-map', '[o]', '-c:a', 'pcm_s24le', T('voice.wav')])
  ff(['-f', 'lavfi', '-i', 'sine=f=220:r=48000:d=20', '-f', 'lavfi', '-i', 'sine=f=331:r=48000:d=20', '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0,volume=0.2,aformat=channel_layouts=stereo[o]', '-map', '[o]', T('music.wav')])
  ff(['-f', 'lavfi', '-i', 'sine=f=1000:r=48000:d=6', '-af', 'volume=0.25', '-ac', '1', T('mono.wav')])
  // full level on both sides, as the preview plays a mono file (-ac 2 would use the -3 dB upmix)
  ff(['-f', 'lavfi', '-i', 'sine=f=1000:r=48000:d=6', '-af', 'volume=0.25,pan=stereo|c0=c0|c1=c0', T('stereo.wav')])
  // knocks: 5 ms bursts near full scale, for a master that has to use its ceiling
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.95*sin(2*PI*900*t)*lt(mod(t\\,2.5)\\,0.005)':s=48000:d=20", '-af', 'pan=stereo|c0=c0|c1=c0', T('knocks.wav')])
  const env = { ffmpeg: FF, ffprobe: FP, cacheDir: path.join(tmp, 'voice'), ffmpegVersion: 'test', workDir: path.join(tmp, 'work'), bakeMissing: false }

  console.log('\n-- a mono source plays at the level the preview plays it --')
  {
    const clips = [
      { start: 0, duration: 5, hasAudio: true, path: T('mono.wav'), trackId: 'a1', type: 'audio', volume: 1, role: 'asis' },
      { start: 0, duration: 5, hasAudio: true, path: T('stereo.wav'), trackId: 'a2', type: 'audio', volume: 1, role: 'asis' },
    ]
    const mixM = await R.resolveMix([clips[0]], env), mixS = await R.resolveMix([clips[1]], env)
    ok(mixM.clips[0].channels === 1 && mixS.clips[0].channels === 2, 'the channel count is probed')
    const a = M.planMix(mixM.clips, { totalS: 5 }), b = M.planMix(mixS.clips, { totalS: 5 })
    await R.renderPremaster(a, env, T('pm_mono.wav')); await R.renderPremaster(b, env, T('pm_st.wav'))
    const xm = pcm(T('pm_mono.wav')), xs = pcm(T('pm_st.wav'))
    const lm = chDb(xm, 0, 1, 4), rm = chDb(xm, 1, 1, 4), ls = chDb(xs, 0, 1, 4)
    ok(near(lm, ls, 0.02) && near(rm, ls, 0.02), `mono ${lm.toFixed(2)} / ${rm.toFixed(2)} dBFS per side, stereo ${ls.toFixed(2)} (the mixer's upmix was 3.01 dB down)`)
    const old = ff(['-i', T('mono.wav'), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=5', '-filter_complex', '[1:a][0:a]amix=inputs=2:duration=first:normalize=0[o]', '-map', '[o]', '-f', 'wav', T('old_mono.wav')])
    ok(old.status === 0 && near(chDb(pcm(T('old_mono.wav')), 0, 1, 4), ls - 3.01, 0.05), 'the old path really was 3 dB down (so this test can fail)')
    const st = await R.measureSound(T('mono.wav'), env)
    ok(st.channels === 1 && near(st.I, loud(T('pm_st.wav')), 0.05), `a mono file is measured as it will be mixed (${st.I} LUFS)`)
  }

  console.log('\n-- music under a voice: the bed level and the duck, rendered --')
  let full
  {
    const clips = [
      { start: 0, duration: 20, hasAudio: true, path: T('voice.wav'), trackId: 'a1', type: 'audio', volume: 1, role: 'voice', voiceFix: 'off' },
      { start: 0, duration: 20, hasAudio: true, path: T('music.wav'), trackId: 'a1', type: 'audio', volume: 1 },
    ]
    const mix = await R.resolveMix(clips, env)
    ok(mix.clips[1].role === 'music' && mix.clips[0].segments.length === 4, `the bed is guessed as music (${mix.roles[1].why}); the voice has ${mix.clips[0].segments.length} speech segments`)
    const musicI = (await R.measureSound(T('music.wav'), env)).I
    ok(near(mix.clips[1].levelDb, -21 - musicI, 0.01), `bed level ${mix.clips[1].levelDb.toFixed(2)} dB puts it at -21 LUFS`)
    const solo = M.planMix(mix.clips, { totalS: 20, solo: 'music' })
    await R.renderPremaster(solo, env, T('bed.wav'))
    const x = pcm(T('bed.wav'))
    // speech 0-2, 5-7, 10-12, 15-17: fully ducked from 0.08 s before each onset to 0.15 s after it ends
    const under = chDb(x, 0, 5.3, 6.9), gap = chDb(x, 0, 3.0, 4.6)
    ok(near(gap - under, 10, 0.1), `ducked ${(gap - under).toFixed(2)} dB under speech`)
    const pre = chDb(x, 0, 4.85, 4.9), onset = chDb(x, 0, 4.93, 4.99)
    ok(onset < gap - 9.5 && pre > onset, `fully down before the first syllable (at 4.93-4.99 s: ${(gap - onset).toFixed(1)} dB down)`)
    const gapLufs = loudSlice(x, 3.0, 4.6)
    ok(near(gapLufs, -21, 0.3), `between the words the bed sits at ${gapLufs.toFixed(2)} LUFS, 5 LU under the voice's -16`)
    ok(x.length / 2 === 20 * 48000, 'the bus is exactly 20 s long')
    full = mix
  }

  console.log('\n-- the export path: premaster, settled master, the encoded file --')
  {
    const clips = [
      { start: 0, duration: 20, hasAudio: true, path: T('voice.wav'), trackId: 'a1', type: 'audio', volume: 1, role: 'voice', voiceFix: 'off' },
      { start: 0, duration: 20, hasAudio: true, path: T('music.wav'), trackId: 'a1', type: 'audio', volume: 1, role: 'music' },
    ]
    const ex = await R.prepareExportAudio(clips, { totalS: 20, optimize: true, target: 'youtube', duck: true, masterVolume: 1 }, env)
    ok(fs.existsSync(ex.premaster) && near(ex.master.plannedLufs, -14, 1e-6) && ex.plan.ducks === 4 && ex.mix.roles.length === 2, `premaster ${ex.pre.I.toFixed(2)} LUFS / ${ex.pre.TP} dBTP, master ${ex.master.gainDb.toFixed(2)} dB, ${ex.master.passes} check passes`)
    // the export's own audio half: the premaster as input 1, the master filter, AAC in an mp4
    const out = T('export.mp4')
    ff(['-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=20', '-i', ex.premaster, '-filter_complex', `[1:a]${ex.master.filter}[aout]`,
      '-map', '0:v', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '384k', '-ar', '48000', '-ac', '2', '-t', '20', out])
    const I = loud(out)
    const TP = truePeak(out)
    ok(near(I, -14, 0.15) && TP <= -1.2, `the encoded file: ${I.toFixed(2)} LUFS, ${TP} dBTP after AAC`)
    // what Watch & Verify reads off the same file
    const qc = M.parseEbur128(spawnSync(FF, ['-hide_banner', '-i', out, '-vn', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8' }).stderr)
    ok(near(qc.I, I, 0.06) && qc.TP === TP && qc.LRA >= 0, `the quality check reads it as ${qc.I} LUFS, ${qc.TP} dBTP, LRA ${qc.LRA} LU`)
    const lines = M.loudnessChecks({ I: qc.I, TP: qc.TP, codec: 'aac' }, { targetLufs: ex.master.targetLufs, plannedLufs: ex.master.plannedLufs })
    ok(lines.length === 3 && lines.every((l) => l.status === 'pass'), `and passes it: ${lines.map((l) => `${l.label}: ${l.detail}`).join(' | ')}`)
    const packets = packetsOf(out)
    const jumps = packets.slice(1).filter(([p], i) => p !== packets[i][0] + packets[i][1])
    ok(packets.length >= Math.ceil(20 * 48000 / 1024) && !jumps.length, `the sound is continuous to the end (${packets.length} AAC packets back to back)`)
    ex.cleanup()
    ok(!fs.existsSync(ex.premaster), 'the premaster is removed afterwards')
    // a length that is not a whole number of AAC frames or tenths (loudnorm's 100 ms grid once left a
    // gap near the end and lost the last 90 ms): the 192 kHz ceiling must keep every sample in place
    const len = 5.0123
    const odd = await R.prepareExportAudio([{ ...clips[1], duration: len }], { totalS: len, optimize: true, masterVolume: 1.5 }, env)
    ff(['-i', odd.premaster, '-filter_complex', `[0:a]${odd.master.filter}[aout]`, '-map', '[aout]', '-c:a', 'aac', '-b:a', '384k', '-ar', '48000', '-ac', '2', '-t', String(len), T('odd.m4a')])
    const pk = packetsOf(T('odd.m4a')), want = Math.ceil(len * 48000 / 1024)
    ok(pk.length >= want && !pk.slice(0, -1).some(([, d]) => d !== 1024) && !pk.slice(1).some(([p], i) => p !== pk[i][0] + pk[i][1]), `an odd length (${len} s): ${pk.length} packets (need ${want}), every one 1024 samples and back to back`)
    odd.cleanup()

    const hot = await R.prepareExportAudio(clips, { totalS: 20, optimize: true, duck: true, masterVolume: 1.5 }, env)
    ff(['-i', hot.premaster, '-af', hot.master.filter, '-c:a', 'pcm_f32le', T('hot.wav')])
    const hotI = loud(T('hot.wav'))
    ok(near(hotI, hot.master.plannedLufs, 0.05) && near(hotI, I + 20 * Math.log10(1.5), 0.15), `Master volume 1.5 really is louder: ${hotI.toFixed(2)} LUFS (planned ${hot.master.plannedLufs.toFixed(2)})`)
    hot.cleanup()
    // knocks near full scale on top: the ceiling has to work, so the master is measured and corrected
    const knocky = [...clips, { start: 0, duration: 20, hasAudio: true, path: T('knocks.wav'), trackId: 'a2', type: 'audio', volume: 1, role: 'asis' }]
    const kn = await R.prepareExportAudio(knocky, { totalS: 20, optimize: true, duck: true, masterVolume: 1 }, env)
    ff(['-i', kn.premaster, '-af', kn.master.filter, '-c:a', 'pcm_f32le', T('kn.wav')])
    const knTP = truePeak(T('kn.wav')), knI = loud(T('kn.wav'))
    ok(kn.master.limiterLikely && kn.master.passes >= 1 && near(knI, -14, 0.05) && knTP <= -1.4, `with the ceiling at work: ${knI.toFixed(2)} LUFS, ${knTP} dBTP after ${kn.master.passes} check pass(es) (premaster peak ${kn.pre.TP} dBTP)`)
    kn.cleanup()
    const pod = await R.prepareExportAudio(clips, { totalS: 20, optimize: true, target: 'podcast', duck: true, masterVolume: 1 }, env)
    ff(['-i', pod.premaster, '-af', pod.master.filter, '-c:a', 'pcm_f32le', T('pod.wav')])
    ok(near(loud(T('pod.wav')), -16, 0.1), 'the podcast target lands at -16')
    pod.cleanup()
    const off = await R.prepareExportAudio(clips, { totalS: 20, optimize: false, duck: false, masterVolume: 0.5 }, env)
    ff(['-i', off.premaster, '-af', off.master.filter, '-c:a', 'pcm_f32le', T('off.wav')])
    ok(near(loud(T('off.wav')), off.pre.I - 6.02, 0.1) && off.master.targetLufs === null, 'Optimize off: the mix as it is, times the Master volume')
    off.cleanup()

    const scan1 = await R.scanTimelineLoudness(clips, { totalS: 20, optimize: true, duck: true, masterVolume: 1 }, env)
    const scan2 = await R.scanTimelineLoudness(clips, { totalS: 20, optimize: true, duck: true, masterVolume: 1 }, env)
    ok(scan1.hash === ex.hash && scan2.cached && near(scan1.I, ex.pre.I, 0.05) && scan1.plannedLufs === -14, `the loudness scan is the export's own measurement (${scan1.I} LUFS), the second ask answers from memory`)
    const empty = await R.prepareExportAudio([{ start: 0, duration: 3, hasAudio: false, path: T('voice.wav'), trackId: 'v1' }], { totalS: 3, optimize: true }, env)
    ok(empty.premaster === null && empty.master.plannedLufs === null, 'nothing audible: no premaster, the export keeps its silent track')
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', T('picture.mp4')])
    const stale = await R.prepareExportAudio([...clips, { start: 0, duration: 2, hasAudio: true, path: T('picture.mp4'), trackId: 'v1', type: 'video', volume: 1 }], { totalS: 20, optimize: true }, env)
    ok(stale.premaster && stale.mix.roles.length === 2, 'a clip marked as having sound whose file has none is left out instead of stopping the mix')
    stale.cleanup()
    void full
  }

  console.log('\n-- the import measures a file once, and the export reads that measurement --')
  {
    // analyze-audio-media decodes through the head the mix uses and stores the result where measureSound looks
    const cache = { ...env, cacheDir: path.join(tmp, 'voice-import') }
    ok(R.cachedSound(T('mono.wav'), cache) === null, 'nothing measured yet')
    const an = await V.analyzeMedia(FF, T('mono.wav'), { head: R.soundHead(1) })
    const stored = R.storeSound(T('mono.wav'), an, 1, cache)
    const fresh = await R.measureSound(T('mono.wav'), env)
    ok(near(stored.I, fresh.I, 0.01) && stored.channels === 1, `the import's numbers are the export's (${stored.I} vs ${fresh.I} LUFS)`)
    // an ffmpeg that does not exist proves nothing is decoded again
    const again = await R.measureSound(T('mono.wav'), { ...cache, ffmpeg: path.join(tmp, 'no-ffmpeg.exe'), ffprobe: path.join(tmp, 'no-ffprobe.exe') })
    ok(again.I === stored.I && again.key === stored.key, 'the export answers from that measurement without decoding')
    const later = new Date(Date.now() + 5000)
    fs.utimesSync(T('mono.wav'), later, later)
    ok(R.cachedSound(T('mono.wav'), cache) === null, 'a file changed since is measured again')
  }
} finally {
  if (!process.env.VIDHELM_KEEP) fs.rmSync(tmp, { recursive: true, force: true })
  else console.log('kept', tmp)
}

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
