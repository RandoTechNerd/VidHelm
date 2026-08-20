import { build } from 'esbuild'
import { zipSync, strToU8 } from 'fflate'
import sharp from 'sharp'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = path.join(import.meta.dirname, '..')
const ffmpeg = path.join(root, 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const ffprobe = process.platform === 'win32'
  ? path.join(root, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')
  : path.join(root, 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, 'ffprobe')
const bundlePath = path.join(root, `.alpha-import-test-${process.pid}.mjs`)
await build({
  entryPoints: [path.join(root, 'electron', 'alphaImport.ts')], bundle: true, write: true,
  outfile: bundlePath, format: 'esm', platform: 'node', target: 'node18', external: ['sharp'],
})
const alphaImport = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)

let passed = 0
let failed = 0
const section = name => console.log(`\n-- ${name} --`)
const check = (ok, name, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ''}`) }
  else { failed++; console.error(`  FAIL  ${name}${detail ? ` (${detail})` : ''}`) }
}
const run = (bin, args) => {
  const r = spawnSync(bin, args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr || `${path.basename(bin)} failed`)
  return r.stdout
}
const probe = file => JSON.parse(run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]))
const alphaAt = (file, x, y, out) => {
  run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `alphaextract,crop=2:2:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', out])
  return fs.readFileSync(out)[0]
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidhelm-alpha-import-test-'))
try {
  const frames = path.join(temp, 'source-frames')
  const cache = path.join(temp, 'cache')
  fs.mkdirSync(frames)
  for (const [number, x] of [[1, 0], [2, 8]]) {
    await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: { create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }, left: x, top: 4 }])
      .png().toFile(path.join(frames, `frame_${String(number).padStart(6, '0')}.png`))
  }

  section('animated WebP import')
  const webp = path.join(temp, 'moving.webp')
  run(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error', '-framerate', '2', '-i', path.join(frames, 'frame_%06d.png'),
    '-c:v', 'libwebp_anim', '-pix_fmt', 'bgra', '-lossless', '1', '-loop', '0', '-r', '2', webp,
  ])
  const webpResult = await alphaImport.normalizeAlphaMedia({ filePath: webp, cacheRoot: cache, ffmpegPath: ffmpeg, fallbackFps: 30 })
  check(webpResult.normalized && webpResult.frames === 2, 'both WebP animation frames are normalized')
  check(Math.abs(webpResult.duration - 1) < 0.01, 'WebP frame delays become timeline duration', `${webpResult.duration}s`)
  check(fs.existsSync(webpResult.path) && fs.existsSync(webpResult.previewPath), 'master and Chromium preview are created')
  const webpMaster = probe(webpResult.path)
  check(webpMaster.streams[0]?.codec_name === 'ffv1', 'the edit master is lossless FFV1')
  check(/a/.test(webpMaster.streams[0]?.pix_fmt || ''), 'the edit master has an alpha pixel format', webpMaster.streams[0]?.pix_fmt)
  check(alphaAt(webpResult.path, 14, 0, path.join(temp, 'webp-transparent.raw')) === 0, 'the WebP transparent corner survives normalization')
  check(alphaAt(webpResult.path, 2, 6, path.join(temp, 'webp-opaque.raw')) > 250, 'the WebP opaque artwork survives normalization')
  const webpPreview = probe(webpResult.previewPath)
  const previewTags = Object.fromEntries(Object.entries(webpPreview.streams[0]?.tags || {}).map(([key, value]) => [key.toLowerCase(), value]))
  check(webpPreview.streams[0]?.codec_name === 'vp9' && previewTags.alpha_mode === '1', 'the preview is VP9 marked for alpha', JSON.stringify(webpPreview.streams[0]?.tags || {}))
  check(Math.abs(Number(webpPreview.format.duration) - 1) < 0.01, 'the preview duration matches the WebP timeline', `${webpPreview.format.duration}s`)
  const cached = await alphaImport.normalizeAlphaMedia({ filePath: webp, cacheRoot: cache, ffmpegPath: ffmpeg, fallbackFps: 30 })
  check(cached.cached === true && cached.path === webpResult.path, 'a second import reuses the normalized media')

  const staticWebp = path.join(temp, 'still.webp')
  await sharp(path.join(frames, 'frame_000001.png')).webp({ lossless: true }).toFile(staticWebp)
  const staticProgress = []
  const staticResult = await alphaImport.normalizeAlphaMedia({
    filePath: staticWebp, cacheRoot: cache, ffmpegPath: ffmpeg, fallbackFps: 30,
    onProgress: (percent, detail) => staticProgress.push({ percent, detail }),
  })
  check(staticResult.normalized === false && staticProgress.at(-1)?.percent === 100, 'a static WebP stays an image and completes import progress')

  section('PNG frame ZIP import')
  const manifest = {
    version: 1, fps: 2, width: 16, height: 16, alpha: true,
    frames: [
      { name: 'frame_000001.png', durationMs: 500 },
      { name: 'frame_000002.png', durationMs: 500 },
    ],
  }
  const zip = path.join(temp, 'moving-frames.zip')
  fs.writeFileSync(zip, Buffer.from(zipSync({
    'vidhelm-sequence.json': strToU8(JSON.stringify(manifest)),
    '../frame_000001.png': new Uint8Array(fs.readFileSync(path.join(frames, 'frame_000001.png'))),
    'nested/frame_000002.png': new Uint8Array(fs.readFileSync(path.join(frames, 'frame_000002.png'))),
  }, { level: 6 })))
  const zipResult = await alphaImport.normalizeAlphaMedia({ filePath: zip, cacheRoot: cache, ffmpegPath: ffmpeg, fallbackFps: 30 })
  check(zipResult.normalized && zipResult.frames === 2, 'both compressed ZIP frames are normalized')
  check(Math.abs(zipResult.duration - 1) < 0.01 && zipResult.fps === 2, 'the sequence manifest controls timing')
  check(alphaAt(zipResult.path, 14, 0, path.join(temp, 'zip-transparent.raw')) === 0, 'PNG transparency survives ZIP import')
  check(alphaAt(zipResult.path, 2, 6, path.join(temp, 'zip-opaque.raw')) > 250, 'PNG opaque artwork survives ZIP import')
  check(!fs.existsSync(path.join(temp, 'frame_000001.png')), 'archive paths cannot escape the cache')

  const thirtyFpsZip = path.join(temp, 'thirty-fps-frames.zip')
  const thirtyFpsManifest = {
    ...manifest, fps: 30,
    frames: manifest.frames.map(frame => ({ ...frame, durationMs: 1000 / 30 })),
  }
  fs.writeFileSync(thirtyFpsZip, Buffer.from(zipSync({
    'vidhelm-sequence.json': strToU8(JSON.stringify(thirtyFpsManifest)),
    'frame_000001.png': new Uint8Array(fs.readFileSync(path.join(frames, 'frame_000001.png'))),
    'frame_000002.png': new Uint8Array(fs.readFileSync(path.join(frames, 'frame_000002.png'))),
  }, { level: 6 })))
  const thirtyFpsResult = await alphaImport.normalizeAlphaMedia({ filePath: thirtyFpsZip, cacheRoot: cache, ffmpegPath: ffmpeg, fallbackFps: 24 })
  check(thirtyFpsResult.fps === 30 && Math.abs(thirtyFpsResult.duration - (2 / 30)) < 0.0001, 'fractional 30fps frame delays round-trip without timing drift', `${thirtyFpsResult.duration}s`)

  section('rejection')
  const badZip = path.join(temp, 'not-frames.zip')
  fs.writeFileSync(badZip, Buffer.from(zipSync({ 'readme.txt': strToU8('not a frame sequence') })))
  let rejected = false
  try { await alphaImport.normalizeAlphaMedia({ filePath: badZip, cacheRoot: cache, ffmpegPath: ffmpeg, fallbackFps: 30 }) } catch (error) { rejected = /PNG frames/i.test(String(error)) }
  check(rejected, 'a generic ZIP is rejected with a frame-specific error')
} finally {
  try { fs.rmSync(temp, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(bundlePath, { force: true }) } catch {}
}

console.log(`\n${failed ? '✗' : '✓'} ALL CHECKS ${failed ? 'FAILED' : 'PASSED'} - ${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
