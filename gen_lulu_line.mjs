// One cloned-voice line ("Where is Lulu?") with the standing whisper QA loop.
// Short lines are the risky case for cloned voices, so each take is transcribed and must match
// before it is accepted; retries nudge cfg because the server caches by (text, exaggeration, cfg).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const X = 'C:/Users/Rando/Claude Play/XplorerVid'
const SO = 'C:/Users/Rando/Claude Play/VoiceClone/output/studio'
const FF = 'C:/Users/Rando/Claude Play/VidHelm/node_modules/ffmpeg-static/ffmpeg.exe'
const FP = 'C:/Users/Rando/Claude Play/VidHelm/release/win-unpacked/resources/ffprobe.exe'
const SCRIPT = 'Where is Lulu?'
const OUT = path.join(X, 'vo_user', 'lines', 'sq.wav')

const norm = s => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()
const tf = await import('@huggingface/transformers')
tf.env.cacheDir = path.join(process.env.APPDATA, 'VidHelm', 'whisper-cache')
const asr = await tf.pipeline('automatic-speech-recognition', 'Xenova/whisper-small.en')
const hear = wav => {
  const raw = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', wav, '-ar', '16000', '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 })
  return asr(new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4), { return_timestamps: false }).then(r => norm(r.text || ''))
}
const S = norm(SCRIPT).split(' ')
const ALIAS = { lulu: ['lulu', 'lou', 'loulou', 'lulus'] }
const check = text => {
  const T = text.split(' ').filter(Boolean)
  const known = new Set(S); for (const k of S) for (const a of (ALIAS[k] || [])) known.add(a)
  const hit = S.filter(w => T.includes(w) || (ALIAS[w] || []).some(a => T.includes(a))).length / S.length
  const lenR = T.length / S.length
  const injected = T.some(w => !known.has(w) && w.length >= 6) || T.length > S.length + 2
  return { hit, lenR, injected, pass: hit >= 0.99 && lenR <= 1.5 && !injected }
}
let best = null
for (let r = 0; r < 5; r++) {
  const cfg = +(0.42 + r * 0.01).toFixed(2)
  const body = JSON.stringify({ text: SCRIPT, exaggeration: 0.5, cfg })
  const resp = execFileSync('curl', ['-s', '-m', '900', '-X', 'POST', 'http://localhost:5005/speak', '-H', 'Content-Type: application/json', '-d', body]).toString()
  const key = JSON.parse(resp).key
  const wav = path.join(SO, key + '.wav')
  const text = await hear(wav)
  const c = check(text)
  const q = c.hit - Math.abs(1 - c.lenR) - (c.injected ? 0.5 : 0)
  console.error(`  r${r + 1} cfg=${cfg} hit=${(c.hit * 100).toFixed(0)}% len=${c.lenR.toFixed(2)} ${c.pass ? 'PASS' : c.injected ? 'INJECTED' : 'retry'}  "${text}"`)
  if (!best || q > best.q) best = { q, wav, text, c }
  if (c.pass) break
}
// trim silence off both ends so it can be placed exactly
execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-i', best.wav,
  '-af', 'silenceremove=start_periods=1:start_silence=0.05:start_threshold=-45dB:detection=peak,areverse,silenceremove=start_periods=1:start_silence=0.10:start_threshold=-45dB:detection=peak,areverse,highpass=f=80,loudnorm=I=-15:TP=-1.5:LRA=9',
  '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', OUT])
const d = parseFloat(execFileSync(FP, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', OUT]).toString().trim())
console.error(`accepted${best.c.pass ? '' : ' (best take)'}: "${best.text}"  ->  sq.wav ${d.toFixed(2)}s`)
fs.writeFileSync(path.join(X, 'vo_user', 'sq.json'), JSON.stringify({ script: SCRIPT, heard: best.text, pass: best.c.pass, dur: +d.toFixed(3) }, null, 1))
