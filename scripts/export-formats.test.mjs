import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.join(import.meta.dirname, '..')

async function load(entry) {
  const out = await build({
    entryPoints: [path.join(root, entry)], bundle: true, write: false,
    format: 'esm', platform: 'node', target: 'node18',
  })
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
}

let passed = 0
let failed = 0
const section = name => console.log(`\n-- ${name} --`)
const check = (ok, name, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ''}`) }
  else { failed++; console.error(`  FAIL  ${name}${detail ? ` (${detail})` : ''}`) }
}

const formats = await load('src/exportFormats.ts')

section('format contract')
check(formats.resolveExportFormat(undefined, 'movie.mp4') === 'mp4', 'MP4 stays the default')
check(formats.resolveExportFormat(undefined, 'movie.webm') === 'webm', 'WebM is inferred from its extension')
check(formats.resolveExportFormat(undefined, 'movie.webp') === 'webp', 'WebP is inferred from its extension')
check(formats.resolveExportFormat(undefined, 'movie-frames.zip') === 'png-sequence', 'a ZIP means a PNG sequence')
check(formats.resolveExportFormat('webm', 'movie.webm') === 'webm', 'an explicit matching format is accepted')
let mismatch = false
try { formats.resolveExportFormat('webp', 'movie.mp4') } catch { mismatch = true }
check(mismatch, 'a mismatched extension is rejected instead of writing the wrong container')

section('format capabilities')
check(formats.EXPORT_FORMATS.mp4.audio && !formats.EXPORT_FORMATS.mp4.alpha, 'MP4 remains opaque with audio')
check(formats.EXPORT_FORMATS.webm.audio && !formats.EXPORT_FORMATS.webm.alpha, 'WebM uses the background and keeps audio')
check(!formats.EXPORT_FORMATS.webp.audio && formats.EXPORT_FORMATS.webp.alpha, 'WebP preserves alpha and omits audio')
check(!formats.EXPORT_FORMATS['png-sequence'].audio && formats.EXPORT_FORMATS['png-sequence'].alpha, 'PNG frames preserve alpha and omit audio')
check(formats.defaultExportName('mp4') === 'vidhelm_export.mp4', 'MP4 default filename is unchanged')
check(formats.defaultExportName('webm') === 'vidhelm_export.webm', 'WebM uses .webm')
check(formats.defaultExportName('webp') === 'vidhelm_export.webp', 'WebP uses .webp')
check(formats.defaultExportName('png-sequence') === 'vidhelm_export-frames.zip', 'PNG sequence uses -frames.zip')
check(formats.safeBackground('#12abEF') === '12abef', 'background colors are normalized for FFmpeg')
check(formats.safeBackground('not-a-color') === '000000', 'invalid background colors fail safely to black')
check(formats.resolveMediaExportSource({ path: 'master.mkv', proxyPath: 'preview.webm', alpha: true }, 720).path === 'master.mkv', 'alpha imports export from the lossless master')
check(formats.resolveMediaExportSource({ path: 'source.mov', proxyPath: 'proxy.mp4' }, 1080).path === 'proxy.mp4', 'ordinary 1080p exports can use the fast proxy')
check(formats.resolveMediaExportSource({ path: 'source.mov', proxyPath: 'proxy.mp4' }, 2160).path === 'source.mov', 'large exports retain the original source')

const zip = await load('electron/zip.ts')

// Read enough of a stored ZIP to prove another ZIP implementation can find every
// central-directory record and recover the exact file bytes.
function readStoredZip(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('EOCD not found')
  const count = buf.readUInt16LE(eocd + 10)
  let at = buf.readUInt32LE(eocd + 16)
  const files = new Map()
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('central record not found')
    const size = buf.readUInt32LE(at + 24)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const localAt = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    if (buf.readUInt32LE(localAt) !== 0x04034b50) throw new Error('local record not found')
    const localNameLen = buf.readUInt16LE(localAt + 26)
    const localExtraLen = buf.readUInt16LE(localAt + 28)
    const dataAt = localAt + 30 + localNameLen + localExtraLen
    files.set(name, Buffer.from(buf.subarray(dataAt, dataAt + size)))
    at += 46 + nameLen + extraLen + commentLen
  }
  return files
}

section('PNG frame ZIP')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidhelm-export-test-'))
try {
  const one = path.join(dir, 'frame_000001.png')
  const two = path.join(dir, 'frame_000002.png')
  const output = path.join(dir, 'animation-frames.zip')
  const bytesOne = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  const bytesTwo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6, 7])
  fs.writeFileSync(one, bytesOne)
  fs.writeFileSync(two, bytesTwo)
  await zip.writeStoredZip(output, [one, two])
  const archive = readStoredZip(fs.readFileSync(output))
  check(archive.size === 2, 'the archive exposes both frames')
  check(archive.get('frame_000001.png')?.equals(bytesOne), 'the first frame round-trips byte for byte')
  check(archive.get('frame_000002.png')?.equals(bytesTwo), 'the second frame round-trips byte for byte')
  check(![...archive.keys()].some(name => name.includes('\\') || name.includes('/')), 'frame names do not leak temporary folders')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

section('animated WebP alpha encoding')
const webpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidhelm-webp-test-'))
try {
  const ffmpeg = path.join(root, 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  for (const [number, x] of [[1, 0], [2, 8]]) {
    const result = spawnSync(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=1',
      '-vf', `format=rgba,colorchannelmixer=aa=0,drawbox=x=${x}:y=4:w=8:h=8:color=red@1:t=fill`,
      '-frames:v', '1', path.join(webpDir, `frame_${String(number).padStart(6, '0')}.png`),
    ])
    if (result.status !== 0) throw new Error(result.stderr.toString())
  }
  const output = path.join(webpDir, 'alpha.webp')
  const encoded = spawnSync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error', '-framerate', '2',
    '-i', path.join(webpDir, 'frame_%06d.png'), '-c:v', 'libwebp_anim',
    ...formats.webpEncoderOptions('high', 2, 1), '-f', 'webp', output,
  ])
  if (encoded.status !== 0) throw new Error(encoded.stderr.toString())
  const bytes = fs.readFileSync(output)
  const ascii = bytes.toString('latin1')
  check(ascii.includes('ANIM') && (ascii.match(/ANMF/g) || []).length === 2, 'the WebP contains two animation frames')
  const alphaBits = []
  let at = 0
  while ((at = ascii.indexOf('VP8L', at)) >= 0) {
    alphaBits.push((bytes.readUInt32LE(at + 9) >>> 28) & 1)
    at += 4
  }
  check(alphaBits.length === 2 && alphaBits.every(Boolean), 'every lossless animation frame declares alpha')
} finally {
  fs.rmSync(webpDir, { recursive: true, force: true })
}

console.log(`\n${failed ? '✗' : '✓'} ALL CHECKS ${failed ? 'FAILED' : 'PASSED'} - ${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
