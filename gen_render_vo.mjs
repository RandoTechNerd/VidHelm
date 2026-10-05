// Narration for the INDX render, in the cloned voice (Chatterbox via Voice Studio /speak),
// with the standing whisper QA loop: every take is transcribed and must match its script,
// with no injected phrases, before it is accepted. Retries nudge cfg by 0.01 because the server
// caches by (text, exaggeration, cfg) and would otherwise hand back the same take.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const X = 'C:/Users/Rando/Claude Play/XplorerVid'
const OUT = `${X}/vo`
const SO = 'C:/Users/Rando/Claude Play/VoiceClone/output/studio'
const FF = 'C:/Users/Rando/Claude Play/VidHelm/node_modules/ffmpeg-static/ffmpeg.exe'
const FP = 'C:/Users/Rando/Claude Play/VidHelm/release/win-unpacked/resources/ffprobe.exe'
fs.mkdirSync(OUT, { recursive: true })

// [name, render time it should start at, script]. Flowing sentences, numbers spelled out.
export const LINES = [
  ['l1', 0.30, "Here's what the INDX dev kit is going to look like on the Xplorer."],
  ['l2', 5.20, "This is the IDEX gantry with Bondtech's INDX on T zero. It needs a custom bracket, but that's the easy part."],
  ['l3', 13.50, "It probes the bed, brushes the nozzle, and it's ready."],
  ['l4', 18.00, "The enclosure already has interior filament storage and four port holes, two per side, so it's set up for seven INDX filaments plus one on T one."],
  ['l5', 28.80, "Every colour is a tool change, and nobody touches a spool."],
  ['l6', 33.30, "Quick specs: a four hundred by four hundred plate, a C-PAP fan on the INDX T zero, and up to eight INDX tools down one side. David Wood, D W U K three D, covered that, link below."],
  ['l7', 45.90, "A dual gantry with nineteen INDX is theoretically possible. Future build."],
  ['l7b', 49.90, "And I'll be running Fumble Front's board cooling mod, because it is going to need it."],
  ['l8', 54.40, "Lights back on. Now, where did Lulu go? She was just around here."],
  ['l9', 59.50, "Oh, of course. She's on her throne. IQEX, INDX, IDEX, dual gantry, doesn't matter. It's all Lulu's throne."],
]
const EXA = 0.5, CFG = 0.42
// words whisper is allowed to hear differently for a scripted token
const ALIAS = { 'indx': ['index', 'indx', 'inx', 'in', 'dx'], 'idex': ['idex', 'i', 'dex', 'index'], 'xplorer': ['explorer', 'xplorer'], 'bondtech': ['bond', 'tech', 'bondtech', 'bontech'], 'benchy': ['benchy', 'benchie', 'bench'], 'lulu': ['lulu', 'lou', 'lu'], 'multicolour': ['multicolor', 'multicolour', 'multi', 'color', 'colour'], 'colour': ['color', 'colour'], 'cpap': ['cpap', 'c', 'pap', 'seapap', 'cepap'], 'dwuk3d': ['dwuk3d', 'd', 'w', 'u', 'k', 'three', '3', 'dwuk'], 'iqex': ['iqex', 'iq', 'ex', 'ikex'], 'fumble': ['fumble', 'fumbled', 'fumblefront', 'fumblefronts', "fumblefront's", 'thumbelfronts'], 'four': ['four', '4', '400', '400x400'], 'hundred': ['hundred', '400', '400x400'], 'eight': ['eight', '8'], 'nineteen': ['nineteen', '19'], 'zero': ['zero', 't0', '0'], 'one': ['one', 't1', '1'], 'seven': ['seven', '7'], "front's": ['fronts', 'front'] }

const norm = s => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()
const tf = await import('@huggingface/transformers')
tf.env.cacheDir = path.join(process.env.APPDATA, 'VidHelm', 'whisper-cache')
const asr = await tf.pipeline('automatic-speech-recognition', 'Xenova/whisper-small.en')
const hear = wav => {
  const raw = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', wav, '-ar', '16000', '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 })
  return asr(new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4), { return_timestamps: false }).then(r => norm(r.text || ''))
}
const check = (script, text) => {
  const S = norm(script).split(' '), T = text.split(' ').filter(Boolean)
  const known = new Set(S); for (const k of S) for (const a of (ALIAS[k] || [])) known.add(a)
  const hit = S.filter(w => T.includes(w) || (ALIAS[w] || []).some(a => T.includes(a))).length / S.length
  const lenR = T.length / S.length
  let injected = false
  for (let j = 0; j + 2 < T.length; j++) if (!known.has(T[j]) && !known.has(T[j + 1]) && !known.has(T[j + 2])) injected = true
  for (const w of T) if (!known.has(w) && w.length >= 9) injected = true
  return { hit, lenR, injected, pass: hit >= 0.85 && lenR >= 0.8 && lenR <= 1.25 && !injected }
}
const dur = f => parseFloat(execFileSync(FP, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim())

const report = []
for (const [name, at, script] of LINES) {
  let best = null
  for (let round = 0; round < 4; round++) {
    const cfg = +(CFG + round * 0.01).toFixed(2)
    const body = JSON.stringify({ text: script, exaggeration: EXA, cfg })
    const resp = execFileSync('curl', ['-s', '-m', '900', '-X', 'POST', 'http://localhost:5005/speak', '-H', 'Content-Type: application/json', '-d', body]).toString()
    const key = JSON.parse(resp).key
    const wav = path.join(SO, key + '.wav')
    const text = await hear(wav)
    const r = check(script, text)
    const q = r.hit - Math.abs(1 - r.lenR) - (r.injected ? 0.5 : 0)
    console.error(`  ${name} r${round + 1} cfg=${cfg} hit=${(r.hit * 100).toFixed(0)}% len=${r.lenR.toFixed(2)} ${r.pass ? 'PASS' : r.injected ? 'INJECTED' : 'retry'}  "${text.slice(0, 90)}"`)
    if (!best || q > best.q) best = { q, wav, text, r }
    if (r.pass) break
  }
  const dst = path.join(OUT, name + '.wav')
  fs.copyFileSync(best.wav, dst)
  report.push({ name, at, script, heard: best.text, pass: best.r.pass, dur: +dur(dst).toFixed(2) })
}
fs.writeFileSync(`${X}/vo/report.json`, JSON.stringify(report, null, 1))
for (const r of report) console.error(`${r.name} @${r.at}s ${r.dur}s ${r.pass ? 'ok' : 'BEST-TAKE'}: ${r.script}`)
console.error('DONE')
