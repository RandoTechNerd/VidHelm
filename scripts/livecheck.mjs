// End-to-end check of the new b-roll / framing / cut-refinement machinery against REAL footage.
//
// The unit tests prove the maths on synthetic data. This proves the parts that only break on
// real files: the ffmpeg argument lists, the raw-buffer slicing, and whether the analysis says
// anything sensible about actual video. It reimplements the same ffmpeg calls main.ts makes,
// because those live inside Electron ipcMain handlers and cannot be imported from plain node.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const FF = path.join(ROOT, 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const SRC = process.argv[2]
if (!SRC) {
  console.error('usage: node scripts/livecheck.mjs <path-to-a-real-video.mp4>')
  console.error('Checks the ffmpeg paths behind b-roll scanning, 9:16 framing and cut refinement')
  console.error('against actual footage. The unit tests cover the maths; this covers the plumbing.')
  process.exit(2)
}
const OUT = path.join(os.tmpdir(), 'vidhelm_livecheck')
fs.mkdirSync(OUT, { recursive: true })

const load = async (file) => {
  const r = await build({ entryPoints: [path.join(ROOT, 'electron', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'))
}
const framing = await load('framing.ts')
const speech = await load('speech.ts')
const broll = await load('broll.ts')

let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }

// ---- the same decode main.ts does ----
const decodeGrayFrames = (file, { start = 0, duration, fps = 4, w = 64, h = 36 } = {}) =>
  new Promise(resolve => {
    const args = ['-hide_banner', '-loglevel', 'error']
    if (start) args.push('-ss', String(start))
    if (duration) args.push('-t', String(duration))
    args.push('-i', file, '-an', '-vf', `fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=disable,format=gray`, '-f', 'rawvideo', '-')
    const p = spawn(FF, args)
    const chunks = []
    p.stdout.on('data', d => chunks.push(d))
    p.on('error', () => resolve([]))
    p.on('close', () => {
      const buf = Buffer.concat(chunks), size = w * h, frames = []
      for (let i = 0; (i + 1) * size <= buf.length; i++) frames.push({ t: +(start + i / fps).toFixed(3), w, h, gray: buf.subarray(i * size, (i + 1) * size) })
      resolve(frames)
    })
  })

// same approach main.ts uses: one fast seek per tile, then stack them
const contactSheet = async (file, duration, out, cols = 3, rows = 2) => {
  const n = cols * rows
  const dir = `${OUT}/tiles`
  fs.mkdirSync(dir, { recursive: true })
  const tiles = []
  for (let i = 0; i < n; i++) {
    const t = duration > 0 ? ((i + 0.5) / n) * duration : 0
    const tile = `${dir}/t_${i}.jpg`
    await new Promise(res => {
      const p = spawn(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', file,
        '-an', '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '3', tile])
      p.on('close', res); p.on('error', res)
    })
    if (fs.existsSync(tile)) tiles.push(tile)
  }
  if (!tiles.length) return false
  const usedCols = Math.min(cols, tiles.length)
  const layout = tiles.map((_, i) => `${(i % usedCols) === 0 ? '0' : `w0*${i % usedCols}`}_${Math.floor(i / usedCols) === 0 ? '0' : `h0*${Math.floor(i / usedCols)}`}`).join('|')
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  for (const t of tiles) args.push('-i', t)
  args.push('-filter_complex', `${tiles.map((_, i) => `[${i}:v]`).join('')}xstack=inputs=${tiles.length}:layout=${layout}:fill=black[v]`, '-map', '[v]', '-frames:v', '1', '-q:v', '3', out)
  return await new Promise(res => {
    const p = spawn(FF, args)
    p.on('close', () => res(fs.existsSync(out)))
    p.on('error', () => res(false))
  })
}

const rmsEnvelope = (file, at, window = 0.6) => new Promise(resolve => {
  const from = Math.max(0, at - window)
  const p = spawn(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(from), '-t', String(window * 2),
    '-i', file, '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'])
  const chunks = []
  p.stdout.on('data', d => chunks.push(d))
  p.on('error', () => resolve(null))
  p.on('close', () => {
    const b = Buffer.concat(chunks)
    const pcm = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4))
    const step = 0.01, per = Math.round(16000 * step), rms = []
    for (let i = 0; i + per <= pcm.length; i += per) {
      let s = 0
      for (let k = 0; k < per; k++) s += pcm[i + k] * pcm[i + k]
      rms.push(Math.sqrt(s / per))
    }
    resolve({ rms, step, t0: from })
  })
})

console.log(`\n== source: ${SRC}`)
ok(fs.existsSync(SRC), 'the test file exists')
if (!fs.existsSync(SRC)) process.exit(1)

console.log('\n-- decoding tiny frames (this is what the framing analysis eats) --')
const t0 = Date.now()
const frames = await decodeGrayFrames(SRC, { start: 60, duration: 40, fps: 4 })
console.log(`  decoded ${frames.length} frames of 40s in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
ok(frames.length > 130 && frames.length < 175, `about 4 frames a second came back (${frames.length})`)
ok(frames.every(f => f.gray.length === 64 * 36), 'every frame is the size it claims')
ok(new Set(frames.map(f => f.gray[500])).size > 1, 'the frames are not all identical (real decode, not a stuck frame)')

console.log('\n-- planning a 9:16 crop from real footage --')
const plan = framing.planCrop(frames)
console.log('  ' + plan.summary?.join('\n  ') || '')
console.log(`  shots: ${plan.shots.length}, holds: ${plan.segments.length}`)
plan.segments.slice(0, 12).forEach(s => console.log(`    ${s.start.toFixed(1)}-${s.end.toFixed(1)}s  centre ${(s.cx * 100).toFixed(0)}%  ${s.reason}`))
ok(plan.segments.length > 0, 'it produced a plan')
ok(plan.segments.every(s => s.cx >= 0.15 && s.cx <= 0.85), 'every centre is inside the frame')
ok(plan.segments.length <= frames.length / 8, `it holds rather than chasing every frame (${plan.segments.length} holds for ${frames.length} frames)`)
const expr = framing.cropExpr(plan, 1920, 608)
ok(!/NaN|undefined/.test(expr), 'the ffmpeg expression is clean')
console.log(`  crop x = ${expr.slice(0, 120)}${expr.length > 120 ? '…' : ''}`)

console.log('\n-- the crop expression actually renders --')
const shortOut = `${OUT}/crop_test.mp4`
let cropErr = ''
await new Promise(res => {
  const p = spawn(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '60', '-t', '6', '-i', SRC,
    '-vf', `crop=608:1080:x='${expr}':y=0,scale=1080:1920`, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', shortOut])
  p.stderr.on('data', d => { cropErr += d.toString() })
  p.on('close', res); p.on('error', res)
})
if (cropErr.trim()) console.log('  ffmpeg said: ' + cropErr.trim().slice(0, 400))
ok(fs.existsSync(shortOut) && fs.statSync(shortOut).size > 20000, 'ffmpeg accepted the generated crop and produced a vertical clip')

console.log('\n-- contact sheet (what gets labelled) --')
const sheet = `${OUT}/sheet.jpg`
const madeSheet = await contactSheet(SRC, 60, sheet)
ok(madeSheet && fs.statSync(sheet).size > 10000, `a contact sheet was written (${madeSheet ? Math.round(fs.statSync(sheet).size / 1024) : 0} KB)`)

console.log('\n-- snapping a cut to the waveform --')
const env = await rmsEnvelope(SRC, 30, 0.8)
ok(env && env.rms.length > 100, `an RMS envelope came back (${env?.rms.length} frames of 10ms)`)
if (env) {
  const loud = env.rms.filter(v => v > 0.01).length
  console.log(`  ${loud}/${env.rms.length} frames above the floor`)
  const moved = []
  for (const t of [30.0, 30.2, 30.4]) {
    const r = speech.refineFromEnvelope(env, t, 'after')
    moved.push(+(r - t).toFixed(3))
  }
  console.log(`  refinement moved cuts by ${moved.join('s, ')}s`)
  ok(moved.every(m => Math.abs(m) <= 0.8), 'refinement never throws a cut outside its search window')
}

console.log('\n-- usable-range detection on a real clip --')
const mean = f => { let s = 0; for (let i = 0; i < f.gray.length; i++) s += f.gray[i]; return s / f.gray.length }
console.log(`  brightness range across the sample: ${Math.min(...frames.map(mean)).toFixed(0)} - ${Math.max(...frames.map(mean)).toFixed(0)}`)
ok(frames.some(f => mean(f) > 26 && mean(f) < 232), 'real frames land inside the exposure window the scanner accepts')

console.log(`\n${fail === 0 ? '✓ ALL LIVE CHECKS PASSED' : '✗ FAILURES'} - ${pass} passed, ${fail} failed`)
console.log(`artifacts in ${OUT}\n`)
process.exit(fail === 0 ? 0 : 1)
