/* The Fix voice bake: runs electron/audiochain.ts's chain on one media file with ffmpeg and caches
 * the result, a processed audio proxy the preview plays and the export reads (parity by
 * construction: both play the same file). Node only, no Electron, so the opt-in corpus test runs
 * exactly this code: npm run test:audiochain:corpus.
 *
 * Per media file, not per timeline clip: cuts, trims and pause cuts address the baked file with
 * -ss sourceStart exactly as they address the video proxy, so editing never re-runs the dynamics.
 * Sample 0 of the bake is the media's own time zero (headFilter's first_pts=0): an audio stream
 * that starts after the picture is padded, never slid forward onto the wrong frames.
 *
 *   analysis   decode to 48 kHz float stereo through a pipe, measured on the fly (never held)
 *   pass A     head + channel + learned-print NR (or the plain high-pass) -> a.f32, measured again
 *   gain WAV   the planned envelope (static + rider + knock dips + room ease), streamed to disk
 *   pass B     a.f32 x gain, 2:1 compressor, measured: make-up = target - I
 *   pass D     pass B again + make-up + 4x oversampled ceiling -> FLAC (24-bit), measured; the
 *              residual is folded back in when the limiter cost loudness (at most 3 passes)
 *   preview    video media only: the picture copied beside AAC of the bake, one file, one clock
 */
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  CHAIN_VERSION, SR, TARGET_LUFS, createAnalyzer, createLoudnessMeter, decide, decisionsJson, summaryLine,
  speechSegments, analysisSummary, headFilter, passAGraph, passBGraph, passDGraph, writeGainWav,
  type ChannelFacts, type Preset, type SourceAnalysis,
} from './audiochain'

export interface MediaProbe { durationS: number; hasVideo: boolean; hasAudio: boolean }

export interface BakeOptions {
  ffmpeg: string
  ffprobe?: string
  /** userData/voice */
  cacheDir: string
  filePath: string
  preset: Preset
  /** first line of `ffmpeg -version`: a different ffmpeg can filter differently, so it is part of the key */
  ffmpegVersion: string
  /** picture for the preview copy (the video proxy when there is one, else the original); null/undefined = no preview copy */
  picture?: string | null
  onProgress?: (pct: number, line: string) => void
  /** every ffmpeg started (done=false) and finished (done=true), so the app can stop them on quit */
  onChild?: (p: ChildProcess, done: boolean) => void
}

export interface BakeResult {
  ok?: boolean
  error?: string
  cached?: boolean
  key?: string
  /** the bake (FLAC, sample 0 = the media's time zero); absent when the fix is off or the recording was left as is */
  path?: string
  /** what the preview plays: the re-muxed video, or the FLAC for audio media */
  previewPath?: string
  previewError?: string
  jsonPath?: string
  preset?: Preset
  effective?: Preset
  skipped?: string | null
  summary?: string
  decisions?: ReturnType<typeof decisionsJson>
  /** speech in source seconds (the duck keys from these) */
  segments?: [number, number][]
  output?: { I: number; TP: number | null; makeupDb: number; passes: number; compI: number }
  seconds?: number
}

const slug = (p: string) => (p.split(/[\\/]/).pop() || 'clip').replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 40) || 'clip'

/** Cache key: sha1(path, size, mtime, preset, chain version, ffmpeg version), readable prefix for a human looking in the folder. */
export function voiceCacheKey(filePath: string, size: number, mtimeMs: number, preset: Preset, ffmpegVersion: string): string {
  const h = crypto.createHash('sha1').update([path.resolve(filePath), size, Math.round(mtimeMs), preset, CHAIN_VERSION, ffmpegVersion].join('|')).digest('hex')
  return `${slug(filePath)}-${preset}-${h.slice(0, 16)}`
}

export function readFfmpegVersion(ffmpeg: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-version'], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => { out += d.toString() })
    p.on('close', () => resolve(out.split(/\r?\n/)[0].trim() || 'unknown'))
    p.on('error', () => resolve('unknown'))
  })
}

export function probeMedia(ffprobe: string, file: string): Promise<MediaProbe | null> {
  return new Promise((resolve) => {
    const p = spawn(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => { out += d.toString() })
    p.on('error', () => resolve(null))
    p.on('close', () => {
      try {
        const j = JSON.parse(out)
        const st = (j.streams || []) as { codec_type?: string }[]
        resolve({ durationS: Number(j.format?.duration) || 0, hasVideo: st.some((s) => s.codec_type === 'video'), hasAudio: st.some((s) => s.codec_type === 'audio') })
      } catch { resolve(null) }
    })
  })
}

/**
 * Raw float PCM from a pipe or file arrives in arbitrary byte chunks (and Node's pooled buffers are
 * not 4-byte aligned): carry the partial frame over and copy into aligned Float32Arrays.
 */
function pcmFeeder(push: (x: Float32Array) => void) {
  let carry = new Uint8Array(0)
  return (chunk: Uint8Array) => {
    const total = carry.length + chunk.length, whole = total - (total % 8)
    if (!whole) { const b = new Uint8Array(total); b.set(carry); b.set(chunk, carry.length); carry = b; return }
    // straight into the aligned buffer: one copy per chunk, not two
    const f = new Float32Array(whole / 4), u = new Uint8Array(f.buffer)
    u.set(carry)
    u.set(chunk.subarray(0, whole - carry.length), carry.length)
    carry = chunk.slice(whole - carry.length)
    push(f)
  }
}

const timeOf = (s: string) => { const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/g; let last: RegExpExecArray | null = null, x; while ((x = m.exec(s))) last = x; return last ? +last[1] * 3600 + +last[2] * 60 + +last[3] : null }

/** Run ffmpeg; stdout (if any) goes to onPcm, `time=` progress to onTime. Rejects with the end of the log on failure. */
function runFF(ffmpeg: string, args: string[], o: { onPcm?: (x: Float32Array) => void; onTime?: (s: number) => void; onChild?: BakeOptions['onChild'] } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true })
    o.onChild?.(p, false)
    let tail = ''
    const feed = o.onPcm ? pcmFeeder(o.onPcm) : null
    p.stdout.on('data', (d: Buffer) => { if (feed) feed(d) })
    p.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      tail = (tail + s).slice(-12000)
      if (o.onTime) { const t = timeOf(s); if (t != null) o.onTime(t) }
    })
    p.on('error', (e) => { o.onChild?.(p, true); reject(e) })
    p.on('close', (code) => {
      o.onChild?.(p, true)
      if (code === 0) resolve(tail)
      else reject(new Error(tail.split(/\r?\n/).filter((l) => l.trim() && !/^\s*size=/.test(l)).slice(-6).join('\n') || `ffmpeg exited ${code}`))
    })
  })
}

/** One decode of the first audio stream through the analyzer, on the same clock as pass A (headFilter). */
export async function analyzeMedia(ffmpeg: string, filePath: string, o: { durationS?: number; onFraction?: (f: number) => void; onChild?: BakeOptions['onChild']; channelTest?: boolean } = {}): Promise<SourceAnalysis> {
  const an = createAnalyzer(SR, { channelTest: o.channelTest })
  const total = (o.durationS || 0) * SR
  let next = 0
  try {
    await runFF(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', filePath, '-vn', '-map', '0:a:0', '-af', headFilter(), '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], {
      onChild: o.onChild,
      onPcm: (x) => {
        an.push(x)
        if (o.onFraction && total && an.frames() >= next) { next = an.frames() + SR * 5; o.onFraction(Math.min(1, an.frames() / total)) }
      },
    })
  } catch (e) {
    if (/matches no streams/i.test(String((e as Error)?.message))) throw new Error('this file has no sound')
    throw e
  }
  if (!an.frames()) throw new Error('no audio could be decoded from this file')
  return an.finish()
}

/** Stream a raw stereo f32 file through the analyzer (pass A's output: no ffmpeg needed to read it). */
function analyzeRaw(file: string, onFraction?: (f: number) => void): Promise<SourceAnalysis> {
  return new Promise((resolve, reject) => {
    const an = createAnalyzer(SR, { channelTest: false })
    const size = fs.statSync(file).size
    let seen = 0
    const feed = pcmFeeder((x) => an.push(x))
    fs.createReadStream(file, { highWaterMark: 1 << 20 })
      .on('data', (d) => { const b = d as Buffer; seen += b.length; feed(b); onFraction?.(size ? seen / size : 1) })
      .on('error', reject)
      .on('end', () => resolve(an.finish()))
  })
}

function writeGainFile(file: string, envelopeDb: Float64Array, n: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(file)
    ws.on('error', reject)
    const write = (chunk: Uint8Array) => (ws.write(chunk) ? undefined : new Promise<void>((r) => ws.once('drain', () => r())))
    writeGainWav(write, envelopeDb, n).then(() => ws.end(() => resolve()), (e) => { ws.destroy(); reject(e) })
  })
}

/** userData/voice/<key>.json: the bake's verdict, kept so a cached bake answers without measuring again */
interface BakeJson {
  v: number; key: string; createdAt: string; ffmpeg: string
  source: { path: string; size: number; mtimeMs: number; durationS: number; hasVideo: boolean }
  preset: Preset; effective: Preset; skipped: string | null
  before: ReturnType<typeof analysisSummary>; after?: ReturnType<typeof analysisSummary>
  channel: ChannelFacts
  decisions?: ReturnType<typeof decisionsJson>; segments?: [number, number][]; summary?: string
  /** file names inside the cache folder */
  flac?: string
  output?: BakeResult['output']
  preview?: { from: string; file?: string; error?: string }
  seconds?: number
}
const readJson = (file: string): BakeJson | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as BakeJson } catch { return null } }

/** Rename, retried a moment: on Windows a file that was just written is often held by Defender or the indexer. */
async function renameRetry(from: string, to: string, tries = 6) {
  for (let i = 1; ; i++) {
    try { fs.renameSync(from, to); return } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code || ''
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw e
      await new Promise((r) => setTimeout(r, 60 * i))
    }
  }
}
async function writeJsonAtomic(file: string, data: unknown) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1))
  await renameRetry(tmp, file)
}

const pictureId = (picture: string) => { try { const s = fs.statSync(picture); return `${path.resolve(picture)}|${s.size}|${Math.round(s.mtimeMs)}` } catch { return '' } }
/**
 * One preview copy per picture: when the video proxy arrives the copy is made again from it, and
 * the old one may be playing (Windows will not replace an open file), so the new one gets its own name.
 */
const previewName = (key: string, picture: string) => `${key}.${crypto.createHash('sha1').update(pictureId(picture)).digest('hex').slice(0, 8)}.mp4`

/** Make the preview copy and record it (or why it failed) in the bake's JSON; an older copy is removed when nothing holds it. */
async function attachPreview(o: BakeOptions, json: BakeJson, flac: string) {
  const name = previewName(json.key, o.picture!), old = json.preview?.file
  try {
    await remux(o, flac, path.join(o.cacheDir, name))
    json.preview = { from: pictureId(o.picture!), file: name }
    if (old && old !== name) try { fs.rmSync(path.join(o.cacheDir, old), { force: true }) } catch { /* still playing: harmless */ }
  } catch (e) {
    json.preview = { from: pictureId(o.picture!), error: String((e as Error)?.message || e).slice(0, 300) }
  }
}

/** The reply for a finished (or cached) bake, from its JSON. */
function resultFrom(j: BakeJson, base: string, cached: boolean): BakeResult {
  const flac = j.flac ? path.join(path.dirname(base), j.flac) : undefined
  const preview = j.preview?.file ? path.join(path.dirname(base), j.preview.file) : flac
  return {
    ok: true, cached, key: j.key, path: flac, previewPath: preview, previewError: j.preview?.error, jsonPath: base + '.json',
    preset: j.preset, effective: j.effective, skipped: j.skipped, summary: j.summary, decisions: j.decisions,
    segments: j.segments, output: j.output, seconds: j.seconds,
  }
}

/** A cached bake for these options, or null. Cheap (a stat and a JSON read), so callers check it before queueing. */
export function cachedBake(o: Pick<BakeOptions, 'cacheDir' | 'filePath' | 'preset' | 'ffmpegVersion' | 'picture'>): BakeResult | null {
  try {
    const st = fs.statSync(o.filePath)
    const key = voiceCacheKey(o.filePath, st.size, st.mtimeMs, o.preset, o.ffmpegVersion)
    const base = path.join(o.cacheDir, key)
    const j = readJson(base + '.json')
    if (!j || j.v !== CHAIN_VERSION || j.key !== key) return null
    if (j.flac && !fs.existsSync(path.join(o.cacheDir, j.flac))) return null
    // a preview copy made from another picture (the proxy arrived since) is made again
    if (o.picture && j.flac && (!j.preview || j.preview.from !== pictureId(o.picture) || (j.preview.file && !fs.existsSync(path.join(o.cacheDir, j.preview.file))))) return null
    return resultFrom(j, base, true)
  } catch { return null }
}

/**
 * The preview copy: the picture untouched, the bake as AAC 256k. Both already sit on the media's
 * own clock (the bake starts at its time zero), so they are muxed as they are; no offset to guess.
 */
async function remux(o: BakeOptions, flac: string, out: string) {
  const part = out.replace(/\.mp4$/i, '.part.mp4')
  const args = ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-i', o.picture!, '-i', flac,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', part]
  try {
    await runFF(o.ffmpeg, args, { onChild: o.onChild })
    await renameRetry(part, out)
  } catch (e) {
    try { fs.rmSync(part, { force: true }) } catch { /* locked */ }
    throw e
  }
}

/**
 * Bake one media file (or return the cached bake). Never throws: failures come back as { error }.
 * Off returns at once with nothing baked; a recording with no clear speech is measured, left as is,
 * and that verdict is cached so it is not measured again.
 */
export async function bakeVoice(o: BakeOptions): Promise<BakeResult> {
  const T0 = Date.now()
  // one event per percent: an hour of sound would otherwise send thousands over IPC
  let lastPct = -1, lastLine = ''
  const progress = (pct: number, line: string) => {
    const p = Math.max(0, Math.min(100, Math.round(pct)))
    if (p === lastPct && line === lastLine) return
    lastPct = p; lastLine = line
    o.onProgress?.(p, line)
  }
  if (o.preset === 'off') return { ok: true, preset: 'off', effective: 'off', skipped: null, summary: summaryLine({ effective: 'off', skipped: null, sparse: false, riderOn: false, sections: [], staticDb: 0, nrDb: 0, transients: [] }) }
  const hit = cachedBake(o)
  if (hit) return hit
  let tmp = '', part = ''
  try {
    if (!fs.existsSync(o.filePath)) return { error: 'file not found' }
    const st = fs.statSync(o.filePath)
    fs.mkdirSync(o.cacheDir, { recursive: true })
    const key = voiceCacheKey(o.filePath, st.size, st.mtimeMs, o.preset, o.ffmpegVersion)
    const base = path.join(o.cacheDir, key)
    const prior = readJson(base + '.json')
    const flacName = `${key}.flac`, flac = path.join(o.cacheDir, flacName)
    // only the preview copy is missing (a proxy arrived, or the copy was deleted): re-mux, nothing else
    if (prior && prior.v === CHAIN_VERSION && prior.key === key && prior.flac && fs.existsSync(flac) && o.picture) {
      progress(90, 'Making the preview copy')
      await attachPreview(o, prior, flac)
      await writeJsonAtomic(base + '.json', prior)
      progress(100, 'Done')
      return resultFrom(prior, base, false)
    }

    const probe = o.ffprobe ? await probeMedia(o.ffprobe, o.filePath) : null
    if (probe && !probe.hasAudio) return { error: 'this file has no sound' }
    progress(1, 'Measuring the recording')
    const src = await analyzeMedia(o.ffmpeg, o.filePath, { durationS: probe?.durationS, onFraction: (f) => progress(1 + f * 11, 'Measuring the recording'), onChild: o.onChild })
    const plan = decide(src, o.preset)
    const json: BakeJson = {
      v: CHAIN_VERSION, key, createdAt: new Date().toISOString(), ffmpeg: o.ffmpegVersion,
      source: { path: path.resolve(o.filePath), size: st.size, mtimeMs: Math.round(st.mtimeMs), durationS: +src.durS.toFixed(3), hasVideo: !!probe?.hasVideo },
      preset: o.preset, effective: plan.effective, skipped: plan.skipped, before: analysisSummary(src),
      channel: { ...src.channel, foldLossDb: +src.channel.foldLossDb.toFixed(2), snrL: +src.channel.snrL.toFixed(1), snrR: +src.channel.snrR.toFixed(1) },
    }
    if (plan.effective === 'off') {
      // left as is: the original plays and exports untouched; the verdict is what gets cached
      Object.assign(json, { decisions: decisionsJson(plan), segments: speechSegments(src), summary: summaryLine(plan), seconds: (Date.now() - T0) / 1000 })
      await writeJsonAtomic(base + '.json', json)
      progress(100, 'Done')
      return resultFrom(json, base, false)
    }

    tmp = path.join(o.cacheDir, 'tmp', key)
    fs.mkdirSync(tmp, { recursive: true })
    const durS = src.durS || probe?.durationS || 1
    const aFile = path.join(tmp, 'a.f32'), gainFile = path.join(tmp, 'gain.wav')
    const graph = (name: string, text: string) => { const f = path.join(tmp, name); fs.writeFileSync(f, text); return f }

    // pass A: head + channel + NR (it carries the high-pass) into a raw float file
    progress(12, plan.nrDb ? 'Cleaning room noise' : 'Preparing the voice')
    await runFF(o.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', o.filePath, '-filter_complex_script', graph('a.txt', passAGraph(plan)), '-map', '[o]', '-c:a', 'pcm_f32le', '-f', 'f32le', aFile], {
      onChild: o.onChild, onTime: (t) => progress(12 + 28 * t / durS, plan.nrDb ? 'Cleaning room noise' : 'Preparing the voice'),
    })
    // the floor moved: measure what the compressor will really see, and plan the gain on that
    const after = await analyzeRaw(aFile, (f) => progress(40 + 5 * f, 'Planning the level'))
    const gainPlan = decide(after, o.preset, { prior: plan })
    progress(45, 'Planning the level')
    await writeGainFile(gainFile, gainPlan.envelopeDb, after.n)

    const rawIn = ['-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', aFile, '-i', gainFile]
    // pass B: gain + compressor, measured only (pass D runs it again; it is deterministic)
    const compMeter = createLoudnessMeter(SR)
    await runFF(o.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...rawIn, '-filter_complex_script', graph('b.txt', passBGraph()), '-map', '[o]', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], {
      onChild: o.onChild, onPcm: (x) => compMeter.push(x), onTime: (t) => progress(50 + 20 * t / durS, 'Levelling'),
    })
    const compI = compMeter.finish().I
    // pass D: make-up and the ceiling; the limiter can cost a little loudness, so measure and correct
    let makeupDb = TARGET_LUFS - compI, outI = NaN, TP: number | null = null, passes = 0
    part = flac.replace(/\.flac$/i, '.part.flac')
    for (; passes < 3;) {
      const meter = createLoudnessMeter(SR)
      const lo = 70 + passes * 8
      const log = await runFF(o.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...rawIn, '-filter_complex_script', graph('d.txt', passDGraph(makeupDb)),
        '-map', '[o]', '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', part,
        '-map', '[m]', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'], {
        onChild: o.onChild, onPcm: (x) => meter.push(x), onTime: (t) => progress(lo + 8 * t / durS, 'Setting the level'),
      })
      passes++
      outI = meter.finish().I
      const tp = /True peak:\s+Peak:\s*(-?[\d.]+|-inf)\s*dBFS/.exec(log.split('Summary:').pop() || '')
      TP = tp ? (tp[1] === '-inf' ? -140 : +tp[1]) : null
      if (Math.abs(outI - TARGET_LUFS) <= 0.05) break
      makeupDb += TARGET_LUFS - outI
    }
    await renameRetry(part, flac)
    Object.assign(json, {
      flac: flacName, decisions: decisionsJson(gainPlan), after: analysisSummary(after), segments: speechSegments(after),
      summary: summaryLine(gainPlan),
      output: { I: +outI.toFixed(2), TP, makeupDb: +makeupDb.toFixed(2), passes, compI: +compI.toFixed(2) },
    })
    if (o.picture) {
      progress(92, 'Making the preview copy')
      await attachPreview(o, json, flac)
    }
    json.seconds = +((Date.now() - T0) / 1000).toFixed(1)
    await writeJsonAtomic(base + '.json', json)
    progress(100, 'Done')
    return resultFrom(json, base, false)
  } catch (e) {
    return { error: String((e as Error)?.message || e) }
  } finally {
    // the part file only outlives a failed pass (after the rename it is gone)
    for (const p of [tmp, part]) if (p) try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* locked: swept next run */ }
  }
}

/** Temp folders left by a bake cut off by a crash or a closed app; only old ones (another copy of the app may be baking). */
export function sweepVoiceTemp(cacheDir: string, olderThanMs = 30 * 60_000) {
  const dir = path.join(cacheDir, 'tmp'), stale = Date.now() - olderThanMs
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f)
      try { if (fs.statSync(p).mtimeMs < stale) fs.rmSync(p, { recursive: true, force: true }) } catch { /* in use or gone */ }
    }
  } catch { /* no temp folder yet */ }
  try {
    for (const f of fs.readdirSync(cacheDir)) if (/\.part\.(flac|mp4)$/i.test(f)) {
      const p = path.join(cacheDir, f)
      try { if (fs.statSync(p).mtimeMs < stale) fs.rmSync(p, { force: true }) } catch { /* in use */ }
    }
  } catch { /* no cache yet */ }
}
