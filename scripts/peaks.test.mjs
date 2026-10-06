// Tests for waveform peaks (electron/peaks.ts), including one real decode through the bundled
// ffmpeg with the same arguments the main process uses. Run with: npm run test:peaks
import { build } from 'esbuild'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'electron', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const P = await load('peaks.ts')
let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e

console.log('one byte per bucket, on a -60 dB scale')
ok(P.peakByte(1) === 255 && P.peakByte(1.5) === 255, 'full scale (and over) is 255')
ok(P.peakByte(0.001) === 0 && P.peakByte(0.0001) === 0, '-60 dB and below is 0')
ok(P.peakByte(0.1) === 170, `-20 dB is two thirds up (${P.peakByte(0.1)})`)
ok(P.peakByte(0) === 0 && P.peakByte(NaN) === 0 && P.peakByte(-1) === 0, 'nothing, NaN or a negative max read as silence')

const sine = (amp, secs, rate = 8000, f = 220) => Float32Array.from({ length: Math.round(secs * rate) }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / rate))

console.log('bucketing')
{
  const pk = P.bucketPeaks(sine(0.5, 1))
  ok(pk.length === 100, `1 s at 8 kHz is 100 buckets (${pk.length})`)
  const want = P.peakByte(0.5)
  ok(pk.slice(1).every(v => Math.abs(v - want) <= 1), `a half-scale tone reads about ${want} in every bucket`)
  ok(P.bucketPeaks(new Float32Array(81)).length === 2, 'a partial last bucket still counts')
  ok(P.bucketPeaks(new Float32Array(0)).length === 0, 'no audio, no peaks')
  const loudThenQuiet = Float32Array.from({ length: 160 }, (_, i) => i < 80 ? (i === 40 ? -0.9 : 0.01) : 0.01)
  const lq = P.bucketPeaks(loudThenQuiet)
  ok(lq[0] === P.peakByte(0.9) && lq[1] === P.peakByte(0.01), 'the loudest sample wins its bucket, negative ones too')
}
{
  // ffmpeg's stdout arrives in pieces that split samples; streaming must match the one-shot result
  const pcm = sine(0.3, 2.37)
  const bytes = new Uint8Array(pcm.buffer)
  const b = new P.PeakBucketer()
  for (let i = 0; i < bytes.length; i += 7) b.pushBytes(bytes.subarray(i, Math.min(bytes.length, i + 7)))
  const streamed = b.finish(), whole = P.bucketPeaks(pcm)
  ok(streamed.length === whole.length && streamed.every((v, i) => v === whole[i]), `7-byte chunks give the same ${whole.length} peaks`)
  const big = new P.PeakBucketer()
  big.pushFloats(new Float32Array(8000 * 3600))
  ok(big.finish().length === 360000, 'an hour of audio is 360000 bytes of peaks')
}

console.log('drawing')
ok(P.barHeight(255, 1) === 1 && P.barHeight(0, 1) === 0, 'full scale is a full bar, silence none')
ok(near(P.barHeight(255, 0.5), 1 - 6.0206 / 60, 1e-3), 'a clip at 50% draws 6 dB lower')
ok(P.barHeight(200, 0) === 0 && P.barHeight(200, -1) === 0, 'muted (or a fade at its end) draws nothing')
ok(P.barHeight(128, 2) > P.barHeight(128, 1) && P.barHeight(250, 2) === 1, 'a boost lifts the bars, capped at the top')
{
  const data = Uint8Array.from([0, 10, 200, 30])
  const two = P.barPeaks(data, 100, 0, 0.04, 2)
  ok(two[0] === 10 && two[1] === 200, `each bar takes the loudest bucket under it (${[...two]})`)
  const zoom = P.barPeaks(data, 100, 0.02, 0.03, 4)
  ok([...zoom].every(v => v === 200), 'bars narrower than a bucket read the bucket they sit in (no gaps)')
  const past = P.barPeaks(data, 100, 0.03, 0.08, 5)
  ok(past[0] === 30 && past[4] === 0, 'past the end of the audio is silence')
  ok(P.barPeaks(data, 100, 1, 1, 3).every(v => v === 0) && P.barPeaks(new Uint8Array(0), 100, 0, 1, 2).length === 2, 'empty ranges and empty data')
}

console.log('a real decode, with the arguments the main process uses')
{
  const FF = path.join(here, '..', 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  if (!fs.existsSync(FF)) { console.log('  SKIP  no bundled ffmpeg') }
  else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-peaks-'))
    try {
      // lavfi's sine is 1/8 full scale, so: 1 s of tone at 1/16 (-24 dB), 1 s of silence, 0.5 s at 1/160 (-44 dB),
      // stereo 48 kHz like real footage audio
      const wav = path.join(tmp, 'steps.wav')
      spawnSync(FF, ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'sine=f=300:r=48000:d=1,volume=0.5[a];anullsrc=r=48000:cl=mono,atrim=duration=1[b];sine=f=300:r=48000:d=0.5,volume=0.05[c];[a][b][c]concat=n=3:v=0:a=1',
        '-ac', '2', wav])
      const peaks = await new Promise(resolve => {
        const b = new P.PeakBucketer()
        const p = spawn(FF, P.peakDecodeArgs(wav))
        p.stdout.on('data', d => b.pushBytes(d))
        p.on('close', () => resolve(b.finish()))
      })
      ok(Math.abs(peaks.length - 250) <= 1, `2.5 s decodes to about 250 buckets (${peaks.length})`)
      const avg = (a, b) => peaks.slice(a, b).reduce((s, v) => s + v, 0) / (b - a)
      ok(Math.abs(avg(10, 90) - P.peakByte(0.0625)) <= 3, `the -24 dB stretch reads about ${P.peakByte(0.0625)} (${avg(10, 90).toFixed(1)})`)
      ok(avg(110, 190) === 0, 'the silent stretch is flat')
      ok(Math.abs(avg(210, 240) - P.peakByte(0.00625)) <= 3, `the -44 dB stretch reads about ${P.peakByte(0.00625)} (${avg(210, 240).toFixed(1)})`)
      const none = spawnSync(FF, P.peakDecodeArgs(path.join(tmp, 'missing.wav')))
      ok(none.status !== 0 && !none.stdout.length, 'a missing file fails with nothing on stdout (the handler reports it, caches nothing)')
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
