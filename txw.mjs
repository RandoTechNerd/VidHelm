// Word-level timestamps, so filler words can be located precisely enough to cut out.
import fs from 'node:fs'
import path from 'node:path'

const wavPath = process.argv[2]
const outPath = process.argv[3]
const size = process.argv[4] || 'small'

function readWav(p) {
  const buf = fs.readFileSync(p)
  let off = 12
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4)
    const sz = buf.readUInt32LE(off + 4)
    if (id === 'data') {
      const n = Math.floor(sz / 2)
      const f = new Float32Array(n)
      for (let i = 0; i < n; i++) f[i] = buf.readInt16LE(off + 8 + i * 2) / 32768
      return f
    }
    off += 8 + sz + (sz % 2)
  }
  throw new Error('no data chunk')
}

const tf = await import('@huggingface/transformers')
tf.env.cacheDir = path.join(process.env.APPDATA, 'VidHelm', 'whisper-cache')
const modelId = `Xenova/whisper-${size}.en`
console.error('loading', modelId)
const asr = await tf.pipeline('automatic-speech-recognition', modelId)

const audio = readWav(wavPath)
const sr = 16000, chunkSec = 30, overlap = 2.0, stride = chunkSec - overlap
const nChunks = Math.max(1, Math.ceil(Math.max(0, audio.length / sr - overlap) / stride))
const words = []
const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

for (let i = 0; i < nChunks; i++) {
  const from = Math.round(i * stride * sr)
  const seg = audio.subarray(from, Math.min(audio.length, from + chunkSec * sr))
  if (seg.length < sr * 0.2) break
  let out
  try { out = await asr(seg, { return_timestamps: 'word' }) }
  catch (e) { console.error('  chunk', i, 'failed:', e.message); continue }
  const offset = from / sr
  for (const c of (out.chunks || [])) {
    const text = (c.text || '').trim()
    if (!text) continue
    const start = (c.timestamp?.[0] ?? null)
    const end = (c.timestamp?.[1] ?? c.timestamp?.[0] ?? null)
    if (start === null) continue
    const s = start + offset, e = end + offset
    // de-duplicate the overlap region
    if (words.some(w => norm(w.t) === norm(text) && Math.abs(w.s - s) < 0.5)) continue
    words.push({ s: +s.toFixed(3), e: +e.toFixed(3), t: text })
  }
  if (i % 5 === 0) console.error(`  ${i + 1}/${nChunks}`)
}
words.sort((a, b) => a.s - b.s)
fs.writeFileSync(outPath, JSON.stringify(words))
console.error('wrote', outPath, words.length, 'words')
