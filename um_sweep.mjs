// Second, harder filler sweep with a built-in safety check.
//
// Candidates come from the same signal as before (Whisper stretches the word next to an "um"
// to cover it, so a word carrying far more time than its letters justify is a suspect, and the
// voiced stretch inside that excess is the filler). This time NO acoustic rule is trusted on its
// own: every candidate cut is auditioned. The 6.5s of audio around it is transcribed twice, once
// as recorded and once with the cut applied, and the cut is kept only if every content word that
// was there before is still there after. That is what would have caught "aluminum" and "STLAR".
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const X = 'C:/Users/Rando/Claude Play/XplorerVid'
const FF = 'C:/Users/Rando/Claude Play/VidHelm/node_modules/ffmpeg-static/ffmpeg.exe'
const FP = 'C:/Users/Rando/Claude Play/VidHelm/release/win-unpacked/resources/ffprobe.exe'
const SRC = `${X}/body.mp4`, OUT = `${X}/body_clean2.mp4`
const SR = 16000, HOP = 0.02
const FROM = 0.5, EXTRA = 0.26, HEADROOM = 0.10, TAILROOM = 0.12, MIN_CUT = 0.14, MAX_CUT = 0.85
const PAD = 3.0                       // audition window either side of a cut
const FILLER = /^(u+m+|u+h+|e+r+m+|h+m+|a+h+|mm+)$/

function readWav(p) {
  const buf = fs.readFileSync(p); let off = 12
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4), sz = buf.readUInt32LE(off + 4)
    if (id === 'data') { const n = Math.floor(sz / 2), f = new Float32Array(n); for (let i = 0; i < n; i++) f[i] = buf.readInt16LE(off + 8 + i * 2) / 32768; return f }
    off += 8 + sz + (sz % 2)
  }
  throw new Error('no data chunk')
}
const audio = readWav(`${X}/audio/body.wav`)
const DUR = audio.length / SR
const hop = Math.round(HOP * SR), nF = Math.floor(audio.length / hop)
const rms = new Float64Array(nF)
for (let i = 0; i < nF; i++) { let s = 0; for (let j = i * hop; j < (i + 1) * hop; j++) s += audio[j] * audio[j]; rms[i] = Math.sqrt(s / hop) }
const sorted = Array.from(rms).sort((a, b) => a - b)
const floor = sorted[Math.floor(nF * 0.2)], loud = sorted[Math.floor(nF * 0.85)]
const VOICED = floor + 0.30 * (loud - floor)

const words = JSON.parse(fs.readFileSync(`${X}/audio/body_words.json`, 'utf8'))
const expLen = t => { const c = t.replace(/[^A-Za-z0-9']/g, ''); if (!c) return 0.06; const acr = c.length >= 2 && c === c.toUpperCase() && /[A-Z]/.test(c); return 0.06 + c.length * (acr ? 0.26 : 0.075) }

// ---- candidates ------------------------------------------------------------
let cands = []
for (const w of words) {
  const d = w.e - w.s
  if (w.s < FROM || d > 3.0 || d - expLen(w.t) <= EXTRA) continue
  const a = w.s + expLen(w.t) + HEADROOM, b = w.e - TAILROOM
  if (b - a < MIN_CUT) continue
  const lo = Math.ceil(a / HOP), hi = Math.floor(b / HOP)
  let i = lo
  while (i <= hi) {
    if (rms[i] > VOICED) {
      let j = i; while (j <= hi && rms[j] > VOICED) j++
      const s = i * HOP, e = Math.min(j * HOP, b)
      if (e - s >= MIN_CUT && e - s <= MAX_CUT) cands.push({ a: +s.toFixed(3), b: +e.toFixed(3), after: w.t })
      i = j
    } else i++
  }
}
cands.sort((x, y) => x.a - y.a)
// merge touching candidates so one audition covers them
const merged = []
for (const c of cands) { const l = merged[merged.length - 1]; if (l && c.a <= l.b + 0.08) { l.b = Math.max(l.b, c.b); l.after += '/' + c.after } else merged.push({ ...c }) }
cands = merged.filter(c => c.b - c.a <= MAX_CUT)
const fmt = s => Math.floor(s / 60) + ':' + (s % 60).toFixed(1).padStart(4, '0')
console.error(`${cands.length} candidates to audition (${cands.reduce((s, c) => s + c.b - c.a, 0).toFixed(1)}s)`)

// ---- audition each one ------------------------------------------------------
const tf = await import('@huggingface/transformers')
tf.env.cacheDir = path.join(process.env.APPDATA, 'VidHelm', 'whisper-cache')
const asr = await tf.pipeline('automatic-speech-recognition', 'Xenova/whisper-small.en')
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean)
const content = ws => ws.filter(w => w.length >= 3 && !FILLER.test(w))
const slice = (s, e) => audio.subarray(Math.max(0, Math.round(s * SR)), Math.min(audio.length, Math.round(e * SR)))
const fadeJoin = (A, B) => {
  const n = Math.round(0.025 * SR), out = new Float32Array(A.length + B.length)
  out.set(A); out.set(B, A.length)
  for (let i = 0; i < n && i < A.length; i++) out[A.length - 1 - i] *= i / n
  for (let i = 0; i < n && i < B.length; i++) out[A.length + i] *= i / n
  return out
}
const hear = async arr => norm((await asr(arr, { return_timestamps: false })).text)
const present = (want, have) => want.every(w => have.some(h => h === w || (w.length >= 4 && h.startsWith(w.slice(0, 4))) || (h.length >= 4 && w.startsWith(h.slice(0, 4)))))

const kept = [], rejected = []
for (let k = 0; k < cands.length; k++) {
  const c = cands[k]
  const ws = Math.max(0, c.a - PAD), we = Math.min(DUR, c.b + PAD)
  const before = await hear(slice(ws, we))
  const after = await hear(fadeJoin(slice(ws, c.a), slice(c.b, we)))
  const cb = content(before), ca = content(after)
  const ok = present(cb, ca) && ca.length >= cb.length - 1
  ;(ok ? kept : rejected).push({ ...c, before: before.join(' '), after: after.join(' ') })
  console.error(`  ${String(k + 1).padStart(3)}/${cands.length} ${fmt(c.a)} ${(c.b - c.a).toFixed(2)}s  ${ok ? 'KEEP  ' : 'REJECT'}  after "${c.after}"`)
}
const total = kept.reduce((s, c) => s + c.b - c.a, 0)
console.error(`\nkept ${kept.length}, rejected ${rejected.length}, removing ${total.toFixed(1)}s`)

// ---- build body_clean2.mp4 ------------------------------------------------
const keeps = []; let p = 0
for (const c of kept) { if (c.a - p > 0.12) keeps.push([p, c.a]); p = c.b }
if (DUR - p > 0.12) keeps.push([p, DUR])
const v = keeps.map((k, i) => `[0:v]trim=${k[0].toFixed(3)}:${k[1].toFixed(3)},setpts=PTS-STARTPTS[v${i}]`).join(';')
const a = keeps.map((k, i) => { const len = k[1] - k[0]; return `[0:a]atrim=${k[0].toFixed(3)}:${k[1].toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.025,afade=t=out:st=${(len - 0.025).toFixed(3)}:d=0.025[a${i}]` }).join(';')
const cat = keeps.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${keeps.length}:v=1:a=1[v][a]`
execFileSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-i', SRC, '-filter_complex', `${v};${a};${cat}`, '-map', '[v]', '-map', '[a]',
  '-r', '30', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', OUT], { stdio: 'inherit' })

// time map for the assembly anchors
const map = t => { let sh = 0; for (const c of kept) { if (c.b <= t) sh += c.b - c.a; else if (c.a < t) return c.a - sh } return t - sh }
const anchors = { BODY_START: 17.00, INDX_AT: 95.50, CUT1: 116.56, CUT2: 345.08, XPL_AT: 350.00 }
const mapped = Object.fromEntries(Object.entries(anchors).map(([k, t]) => [k, +map(t).toFixed(3)]))
fs.writeFileSync(`${X}/filler_map2.json`, JSON.stringify({ kept, rejected, removed: total, anchors: mapped, cleanDur: DUR - total }, null, 1))
console.error('anchors ->', JSON.stringify(mapped))
console.error(`DONE -> body_clean2.mp4 (${(DUR - total).toFixed(2)}s, was ${DUR.toFixed(2)}s)`)
