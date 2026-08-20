import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import sharp from 'sharp'
import { Unzip, UnzipInflate } from 'fflate'

const MAX_FRAMES = 100_000
const MAX_FRAME_BYTES = 256 * 1024 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024 * 1024
const NORMALIZER_CACHE_VERSION = 2

type SequenceManifest = {
  version?: number
  fps?: number
  width?: number
  height?: number
  alpha?: boolean
  frames?: { name?: string; durationMs?: number }[]
}

export type AlphaImportResult = {
  normalized: boolean
  cached?: boolean
  path?: string
  previewPath?: string
  duration?: number
  fps?: number
  frames?: number
  width?: number
  height?: number
  alpha?: boolean
  sourceType?: 'webp' | 'png-sequence'
}

type NormalizeOptions = {
  filePath: string
  cacheRoot: string
  ffmpegPath: string
  fallbackFps?: number
  onProgress?: (percent: number, detail: string) => void
}

const clampFps = (value: unknown) => {
  const fps = Number(value)
  return Number.isFinite(fps) ? Math.max(1, Math.min(120, fps)) : 30
}

const run = (binary: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(binary, args, { windowsHide: true })
  let error = ''
  child.stderr.on('data', chunk => { error += chunk.toString() })
  child.on('error', reject)
  child.on('close', code => code === 0 ? resolve() : reject(new Error(error.slice(-1200) || `FFmpeg exited with code ${code}`)))
})

const sourceKey = (filePath: string) => {
  const stat = fs.statSync(filePath)
  return crypto.createHash('sha1').update(`${path.resolve(filePath)}\0${stat.size}\0${stat.mtimeMs}`).digest('hex')
}

type ExtractedSequence = { frames: string[]; durationsMs: number[]; fps: number; width?: number; height?: number }

async function extractPngZip(zipPath: string, frameDir: string, fallbackFps: number): Promise<ExtractedSequence> {
  const found: { name: string; tempPath: string }[] = []
  let manifest: SequenceManifest | null = null
  let sequence = 0
  let totalBytes = 0
  let streamError: Error | null = null

  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(zipPath)
    const unzip = new Unzip(file => {
      const base = path.basename(file.name.replace(/\\/g, '/'))
      const isPng = /\.png$/i.test(base)
      const isManifest = /^vidhelm-sequence\.json$/i.test(base)
      if (!isPng && !isManifest) return
      if (isPng && found.length >= MAX_FRAMES) {
        streamError = new Error(`PNG sequence has more than ${MAX_FRAMES.toLocaleString()} frames`)
        return
      }
      if (file.originalSize && file.originalSize > MAX_FRAME_BYTES) {
        streamError = new Error(`${base} is larger than the ${Math.round(MAX_FRAME_BYTES / 1024 / 1024)} MB per-frame limit`)
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      file.ondata = (error, data, final) => {
        if (error) { streamError = error; return }
        bytes += data.length
        totalBytes += data.length
        if (bytes > MAX_FRAME_BYTES || totalBytes > MAX_TOTAL_BYTES) {
          streamError = new Error('PNG sequence expands beyond the safe import limit')
          return
        }
        chunks.push(Buffer.from(data))
        if (!final || streamError) return
        const content = Buffer.concat(chunks)
        if (isManifest) {
          try { manifest = JSON.parse(content.toString('utf8')) as SequenceManifest } catch { /* optional metadata */ }
        } else {
          if (content.length < 8 || !content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
            streamError = new Error(`${base} is named PNG but is not a PNG image`)
            return
          }
          const tempPath = path.join(frameDir, `_zip_${String(++sequence).padStart(6, '0')}.png`)
          fs.writeFileSync(tempPath, content)
          found.push({ name: base, tempPath })
        }
      }
      try { file.start() } catch (error) { streamError = error as Error }
    })
    unzip.register(UnzipInflate)
    input.on('data', chunk => {
      if (streamError) { input.destroy(streamError); return }
      try { unzip.push(new Uint8Array(chunk)) } catch (error) { input.destroy(error as Error) }
    })
    input.on('error', reject)
    input.on('end', () => {
      try { unzip.push(new Uint8Array(0), true) } catch (error) { reject(error); return }
      if (streamError) reject(streamError)
      else resolve()
    })
  })

  if (!found.length) throw new Error('ZIP does not contain PNG frames')
  found.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  const frames: string[] = []
  for (let i = 0; i < found.length; i++) {
    const output = path.join(frameDir, `frame_${String(i + 1).padStart(6, '0')}.png`)
    fs.renameSync(found[i].tempPath, output)
    frames.push(output)
  }

  const fps = clampFps(manifest?.fps || fallbackFps)
  const byName = new Map((manifest?.frames || []).map(item => [path.basename(String(item.name || '')).toLowerCase(), Number(item.durationMs)]))
  const fallbackDelay = 1000 / fps
  const durationsMs = found.map(item => {
    const value = byName.get(item.name.toLowerCase())
    return Number.isFinite(value) && (value as number) > 0 ? Math.max(1, value as number) : fallbackDelay
  })
  return { frames, durationsMs, fps, width: manifest?.width, height: manifest?.height }
}

async function decodeAnimatedWebp(filePath: string, frameDir: string, onProgress?: NormalizeOptions['onProgress']): Promise<ExtractedSequence | null> {
  const metadata = await sharp(filePath, { animated: true }).metadata()
  const pages = metadata.pages || 1
  if (pages <= 1) return null
  if (pages > MAX_FRAMES) throw new Error(`Animated WebP has more than ${MAX_FRAMES.toLocaleString()} frames`)
  const delays = metadata.delay || []
  const fallbackDelay = 100
  const frames: string[] = []
  for (let i = 0; i < pages; i++) {
    const output = path.join(frameDir, `frame_${String(i + 1).padStart(6, '0')}.png`)
    await sharp(filePath, { page: i, pages: 1, limitInputPixels: false }).ensureAlpha().png().toFile(output)
    frames.push(output)
    onProgress?.(Math.round(((i + 1) / pages) * 55), `Decoding WebP frame ${i + 1} of ${pages}`)
  }
  const durationsMs = frames.map((_, i) => Math.max(1, Number(delays[i] ?? delays[0] ?? fallbackDelay)))
  const duration = durationsMs.reduce((sum, value) => sum + value, 0) / 1000
  return {
    frames, durationsMs,
    fps: duration > 0 ? frames.length / duration : 10,
    width: metadata.width,
    height: metadata.pageHeight || metadata.height,
  }
}

const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a

const makeTimedSequence = (frameDir: string, frames: string[], durationsMs: number[], preferredFps: number) => {
  const roundedDelays = durationsMs.map(value => Math.max(1, Math.round(value)))
  const delayUnit = roundedDelays.reduce((unit, value) => gcd(unit, value))
  const declaredFps = clampFps(preferredFps)
  const declaredDelay = 1000 / declaredFps
  // Export manifests use fractional millisecond delays (for example 33.333ms at
  // 30fps). Rounding those before deriving the rate turns 30fps into 30.303fps
  // and makes a one-second round trip 990ms. Honor the declared rate when every
  // frame is effectively constant-rate; retain the delay-GCD path for genuinely
  // variable WebP/sequence timing.
  const isDeclaredConstantRate = durationsMs.every(value => Math.abs(value - declaredDelay) <= Math.max(0.25, declaredDelay * 0.01))
  const fps = isDeclaredConstantRate ? declaredFps : Math.max(1, Math.min(60, 1000 / delayUnit))
  const timedDir = path.join(frameDir, 'timed')
  fs.mkdirSync(timedDir)
  let count = 0
  frames.forEach((frame, index) => {
    const copies = Math.max(1, Math.round((roundedDelays[index] / 1000) * fps))
    for (let i = 0; i < copies; i++) {
      if (++count > MAX_FRAMES * 60) throw new Error('Timed PNG sequence is too long to normalize safely')
      const output = path.join(timedDir, `timed_${String(count).padStart(8, '0')}.png`)
      try { fs.linkSync(frame, output) } catch { fs.copyFileSync(frame, output) }
    }
  })
  return { pattern: path.join(timedDir, 'timed_%08d.png'), fps, count, duration: count / fps }
}

export async function normalizeAlphaMedia(options: NormalizeOptions): Promise<AlphaImportResult> {
  const filePath = path.resolve(options.filePath)
  const ext = path.extname(filePath).toLowerCase()
  if (ext !== '.webp' && ext !== '.zip') return { normalized: false }
  if (!fs.existsSync(filePath)) throw new Error('Import file does not exist')

  const key = sourceKey(filePath)
  const cacheRoot = path.resolve(options.cacheRoot)
  const outputDir = path.join(cacheRoot, key)
  const resultPath = path.join(outputDir, 'master.mkv')
  const previewPath = path.join(outputDir, 'preview.webm')
  const metadataPath = path.join(outputDir, 'import.json')
  try {
    const cached = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as AlphaImportResult & { cacheVersion?: number }
    if (cached.cacheVersion === NORMALIZER_CACHE_VERSION && cached.normalized && fs.existsSync(resultPath) && fs.existsSync(previewPath)) {
      return { ...cached, path: resultPath, previewPath, cached: true }
    }
  } catch { /* first import or an incomplete old cache */ }

  fs.mkdirSync(cacheRoot, { recursive: true })
  if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true })
  const frameDir = path.join(outputDir, 'frames')
  fs.mkdirSync(frameDir, { recursive: true })
  try {
    options.onProgress?.(1, ext === '.webp' ? 'Reading animated WebP' : 'Opening PNG frame ZIP')
    const fallbackFps = clampFps(options.fallbackFps)
    const sequence = ext === '.webp'
      ? await decodeAnimatedWebp(filePath, frameDir, options.onProgress)
      : await extractPngZip(filePath, frameDir, fallbackFps)
    if (!sequence) {
      fs.rmSync(outputDir, { recursive: true, force: true })
      options.onProgress?.(100, 'Image ready')
      return { normalized: false }
    }
    if (!sequence.frames.length) throw new Error('No animation frames were decoded')
    const timed = makeTimedSequence(frameDir, sequence.frames, sequence.durationsMs, sequence.fps)
    const duration = timed.duration
    if (!(duration > 0)) throw new Error('Animation has no usable frame timing')

    options.onProgress?.(60, 'Building lossless alpha master')
    await run(options.ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(timed.fps), '-i', timed.pattern,
      '-frames:v', String(timed.count), '-an', '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'bgra', resultPath,
    ])
    options.onProgress?.(82, 'Building transparent preview')
    await run(options.ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error', '-i', resultPath, '-t', duration.toFixed(6), '-an',
      '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0',
      '-deadline', 'good', '-cpu-used', '4', '-metadata:s:v:0', 'alpha_mode=1', previewPath,
    ])

    const result: AlphaImportResult = {
      normalized: true, path: resultPath, previewPath, duration,
      fps: timed.fps, frames: sequence.frames.length,
      width: sequence.width, height: sequence.height,
      alpha: true, sourceType: ext === '.webp' ? 'webp' : 'png-sequence',
    }
    fs.writeFileSync(metadataPath, JSON.stringify({ cacheVersion: NORMALIZER_CACHE_VERSION, ...result }, null, 2), 'utf8')
    fs.rmSync(frameDir, { recursive: true, force: true })
    options.onProgress?.(100, 'Alpha animation ready')
    return result
  } catch (error) {
    try { fs.rmSync(outputDir, { recursive: true, force: true }) } catch { /* preserve the import error */ }
    throw error
  }
}
