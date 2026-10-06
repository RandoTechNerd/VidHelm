/* Runs the export's sound (electron/audiomix.ts) with ffmpeg. Node only, no Electron, so the export
 * handler, the timeline loudness scan and the corpus test all run exactly this code.
 *
 *   measure    each media file once (cached in userData/voice): role guess, level, speech
 *   voices     the Fix voice bake of every voice clip's media (cached; made when missing)
 *   pass 1     the bus graph rendered to one float premaster, measured as it is written
 *   master     the linear gain to the target; when the ceiling may act, the result is measured
 *              and the residual folded back in (at most 3 passes, audio only, before the video)
 *
 * The video export then reads the premaster as its only sound and applies the master filter, so
 * the clips are decoded for sound once and the measurement is of exactly what gets encoded.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CHAIN_VERSION, SR, createLoudnessMeter, headFilter, roleGuess, speechSegments, type Analysis, type Preset } from './audiochain'
import {
  audibleClips, isPreset, planMaster, planMix, provenanceFromPath, resolveRole, roleLevelDb, withMasterGain,
  type Bus, type ExportAudioClip, type MasterPlan, type MixClip, type MixPlan, type MixTuning, type ProvenanceDirs, type SoundFacts,
} from './audiomix'
import { analyzeMedia, bakeVoice, cachedBake, probeMedia, runFF, type BakeOptions, type BakeResult } from './voicebake'

export interface MixEnv {
  ffmpeg: string
  ffprobe: string
  /** userData/voice: the bakes, and the measurements the mix reads */
  cacheDir: string
  ffmpegVersion: string
  /** where premasters and graph files go (a temp folder) */
  workDir: string
  dirs?: ProvenanceDirs
  /** make the bake of a voice that has none yet (the export does; a scan or an analysis render uses only what is cached) */
  bakeMissing?: boolean
  /** how a bake runs; main.ts passes its queue so one bake is never run twice at once */
  bake?: (o: { filePath: string; preset: Preset }) => Promise<BakeResult>
  onChild?: BakeOptions['onChild']
  /** a line of what is happening, for a log or a status bar */
  onStage?: (line: string) => void
  /**
   * Throws when the work is no longer wanted (the export was cancelled): called between every step,
   * so Cancel stops the sound stage at the next one instead of after the whole mix. The step running
   * at the time is stopped by killing its process (onChild).
   */
  check?: () => void
}

export interface MixSettings extends MixTuning {
  totalS: number
  optimize: boolean
  target?: string | null
  duck?: boolean
  masterVolume?: number
}

/** userData/voice/<name>-sound-<hash>.json: a media file's measured sound (it never changes for one file). */
export interface MediaSound extends SoundFacts {
  v: number; key: string; file: string; channels: number; durS: number
  I: number; M: number; segments: [number, number][]
  guessVideo: { role: 'voice' | 'music' | 'sfx' | 'asis'; why: string }
  guessAudio: { role: 'voice' | 'music' | 'sfx' | 'asis'; why: string }
}

const SOUND_V = 1
const slug = (p: string) => (p.split(/[\\/]/).pop() || 'clip').replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 40) || 'clip'
const name = (p: string) => p.split(/[\\/]/).pop() || p
const errText = (e: unknown) => String((e as Error)?.message || e)
/** A mono source is read at full level on both sides, the way the export mixes it (and the preview plays it). */
export const MONO_HEAD = 'aresample=48000:first_pts=0,pan=stereo|c0=c0|c1=c0,aformat=sample_fmts=flt:channel_layouts=stereo'
/** The head that reads a file the way the mix hears it. */
export const soundHead = (channels: number) => (channels === 1 ? MONO_HEAD : headFilter())

type SoundEnv = Pick<MixEnv, 'ffmpeg' | 'ffprobe' | 'cacheDir' | 'ffmpegVersion' | 'onChild'>
/** Where a file's measured sound is cached: keyed on the file as it is on disk now. */
function soundCache(file: string, env: Pick<MixEnv, 'cacheDir' | 'ffmpegVersion'>) {
  const st = fs.statSync(file)
  const key = crypto.createHash('sha1').update([path.resolve(file), st.size, Math.round(st.mtimeMs), CHAIN_VERSION, SOUND_V, env.ffmpegVersion].join('|')).digest('hex').slice(0, 16)
  return { key, jsonPath: path.join(env.cacheDir, `${slug(file)}-sound-${key}.json`) }
}
/** The cached measurement, or null (never measured, or the file changed since). */
export function cachedSound(file: string, env: Pick<MixEnv, 'cacheDir' | 'ffmpegVersion'>): MediaSound | null {
  try {
    const { key, jsonPath } = soundCache(file, env)
    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as MediaSound
    return j.v === SOUND_V && j.key === key ? j : null
  } catch { return null }
}
/**
 * A file's sound from an analysis already made (read through soundHead(channels)), written to the
 * cache: the import's measurement (analyze-audio-media) fills it, so the export decodes nothing again.
 */
export function storeSound(file: string, an: Analysis, channels: number, env: Pick<MixEnv, 'cacheDir' | 'ffmpegVersion'>): MediaSound {
  const { key, jsonPath } = soundCache(file, env)
  const r2 = (x: number) => Math.round(x * 100) / 100
  const sound: MediaSound = {
    v: SOUND_V, key, file: path.resolve(file), channels, durS: r2(an.durS),
    I: r2(an.I), M: r2(an.momentaryMaxLufs), segments: speechSegments(an),
    guessVideo: roleGuess(an, { isVideo: true }), guessAudio: roleGuess(an, { isVideo: false }),
  }
  try {
    fs.mkdirSync(env.cacheDir, { recursive: true })
    fs.writeFileSync(jsonPath + '.tmp', JSON.stringify(sound))
    fs.renameSync(jsonPath + '.tmp', jsonPath)
  } catch { /* a cache that cannot be written only costs a decode next time */ }
  return sound
}

/**
 * One decode of a media file: the role guesses, the level a bed or an SFX is set from, and the
 * speech the music ducks under when the voice has no bake. Cached beside the bakes, so the second
 * export of a project measures nothing.
 */
export async function measureSound(file: string, env: SoundEnv): Promise<MediaSound> {
  const hit = cachedSound(file, env)
  if (hit) return hit
  const probe = await probeMedia(env.ffprobe, file)
  if (probe && !probe.hasAudio) throw new Error('this file has no sound')
  const channels = probe?.audioChannels || 2
  const an = await analyzeMedia(env.ffmpeg, file, { durationS: probe?.durationS, onChild: env.onChild, channelTest: false, head: soundHead(channels) })
  return storeSound(file, an, channels, env)
}

export interface ResolvedMix {
  clips: MixClip[]
  /** per clip, in timeline order: what it plays as, and why (get_state, logs) */
  roles: { start: number; trackId?: string; role: string; why: string; fixed?: string; file: string }[]
  /** voice media that has no bake (scan without baking, or a bake that failed): played as recorded */
  unbaked: number
  /** clips that read a bake (a voice cut into ten clips is ten) */
  baked: number
  /** things worth telling the user, in words */
  notes: string[]
}

/**
 * Decide every audible clip: its role (set, or guessed from the file), the file its sound comes
 * from (a voice's bake when there is one), its level and its speech. Nothing here fails the export:
 * a file that cannot be measured or baked plays as recorded and says so in `notes`.
 */
export async function resolveMix(clips: ExportAudioClip[], env: MixEnv, tune?: MixTuning | null): Promise<ResolvedMix> {
  let audible = audibleClips(clips)
  const notes: string[] = []
  const mediaOf = (c: ExportAudioClip) => (c.mediaPath && fs.existsSync(c.mediaPath) ? c.mediaPath : (c.path || c.mediaPath)!)
  const facts = new Map<string, MediaSound | null>()
  const soundless = new Set<string>()
  for (const c of audible) {
    const m = mediaOf(c)
    if (facts.has(m)) continue
    env.check?.()
    env.onStage?.(`Measuring the sound of ${name(m)}`)
    try { facts.set(m, await measureSound(m, env)) } catch (e) {
      env.check?.()   // a measurement killed by Cancel is not a file that cannot be measured
      facts.set(m, null)
      // marked as having sound but has none (a stale bin entry): asking for its audio would stop the whole mix
      if (/has no sound/.test(errText(e))) soundless.add(m)
      else notes.push(`${name(m)} could not be measured (${errText(e)}), so it plays as recorded`)
    }
  }
  if (soundless.size) audible = audible.filter((c) => !soundless.has(mediaOf(c)))
  const sound = (c: ExportAudioClip): SoundFacts | null => {
    const f = facts.get(mediaOf(c))
    return f ? { ...f, provenance: provenanceFromPath(mediaOf(c), env.dirs) } : { provenance: provenanceFromPath(mediaOf(c), env.dirs) }
  }
  const roles = audible.map((c) => resolveRole(c, sound(c)))

  // one bake per media and preset, however many clips cut it up
  const bakes = new Map<string, BakeResult | null>()
  let unbaked = 0
  for (let i = 0; i < audible.length; i++) {
    if (roles[i].role !== 'voice') continue
    const c = audible[i], m = mediaOf(c)
    const preset: Preset = isPreset(c.voiceFix) ? c.voiceFix : 'studio'
    const k = `${m}|${preset}`
    if (preset === 'off' || bakes.has(k)) continue
    let r: BakeResult | null = cachedBake({ cacheDir: env.cacheDir, filePath: m, preset, ffmpegVersion: env.ffmpegVersion, picture: null })
    if (!r && env.bakeMissing) {
      env.check?.()
      env.onStage?.(`Fixing the voice in ${name(m)}`)
      r = env.bake ? await env.bake({ filePath: m, preset })
        : await bakeVoice({ ffmpeg: env.ffmpeg, ffprobe: env.ffprobe, cacheDir: env.cacheDir, filePath: m, preset, ffmpegVersion: env.ffmpegVersion, picture: null, onChild: env.onChild })
      env.check?.()
      if (r?.error) notes.push(`Fix voice could not run on ${name(m)} (${r.error}), so it plays as recorded`)
    }
    if (!r || r.error) unbaked++
    bakes.set(k, r)
  }

  const out: MixClip[] = []
  const roleList: ResolvedMix['roles'] = []
  let baked = 0
  audible.forEach((c, i) => {
    const f = sound(c), { role, why } = roles[i]
    const preset: Preset = isPreset(c.voiceFix) ? c.voiceFix : 'studio'
    const bake = role === 'voice' && preset !== 'off' ? bakes.get(`${mediaOf(c)}|${preset}`) : null
    const mc: MixClip = {
      start: c.start, duration: c.duration, sourceStart: c.sourceStart, volume: c.volume, volumePoints: c.volumePoints,
      fadeIn: c.fadeIn, fadeOut: c.fadeOut, aFadeIn: c.aFadeIn, aFadeOut: c.aFadeOut,
      role, file: c.path || mediaOf(c), levelDb: roleLevelDb(role, f, tune), segments: role === 'voice' ? f?.segments : undefined,
    }
    if (bake?.path) {
      // the bake is stereo at the working level, sample 0 = the media's time zero: -ss sourceStart lines it up
      mc.file = bake.path; mc.channels = 2; mc.segments = bake.segments || mc.segments; baked++
    } else {
      // the channel count of the file actually read (the payload knows it when the bin probed it)
      const fileFacts = mc.file === mediaOf(c) ? facts.get(mediaOf(c)) : null
      mc.channels = Number(c.audioChannels) > 0 ? Number(c.audioChannels) : fileFacts?.channels
    }
    out.push(mc)
    roleList.push({ start: c.start, trackId: c.trackId, role, why, fixed: bake?.path ? (bake.effective || preset) : undefined, file: name(mc.file) })
  })
  // a proxy read in place of the original: ask it how many channels it has
  const unknown = [...new Set(out.filter((c) => !c.channels).map((c) => c.file))]
  for (const f of unknown) {
    env.check?.()
    const p = await probeMedia(env.ffprobe, f)
    for (const c of out) if (c.file === f) c.channels = p?.audioChannels || 2
  }
  return { clips: out, roles: roleList, unbaked, baked, notes }
}

const TP_RE = /True peak:\s+Peak:\s*(-?[\d.]+|-inf)\s*dBFS/
const truePeakOf = (log: string) => { const m = TP_RE.exec(log.split('Summary:').pop() || ''); return m ? (m[1] === '-inf' ? -140 : +m[1]) : null }

/** A content hash of the mix: the same timeline (same graph, same files on disk) gives the same hash. */
export function mixHash(plan: MixPlan): string {
  const h = crypto.createHash('sha1').update(plan.graph)
  for (const args of plan.inputs) {
    h.update(args.join('\u0001'))
    const f = args[args.length - 1]
    try { const st = fs.statSync(f); h.update(`|${st.size}|${Math.round(st.mtimeMs)}`) } catch { /* lavfi source */ }
  }
  return h.digest('hex').slice(0, 20)
}

/**
 * Pass 1: render the bus graph, measuring as it goes (the integrated loudness in JS to 0.01 LU,
 * ffmpeg's ebur128 for the true peak). `out` null measures only (the loudness scan).
 */
export async function renderPremaster(plan: MixPlan, env: Pick<MixEnv, 'ffmpeg' | 'workDir' | 'onChild'>, out: string | null): Promise<{ I: number; TP: number | null; seconds: number }> {
  const t0 = Date.now()
  fs.mkdirSync(env.workDir, { recursive: true })
  const graphFile = path.join(env.workDir, `vidhelm_mixgraph_${process.pid}_${t0}_${Math.random().toString(36).slice(2, 8)}.txt`)
  const meterTap = out ? '[pre]asplit=2[o][m0];[m0]ebur128=peak=true:framelog=quiet[m]' : '[pre]ebur128=peak=true:framelog=quiet[m]'
  // a graph file, not the command line: a long timeline's graph is far past Windows' 32k argv limit
  fs.writeFileSync(graphFile, `${plan.graph};${meterTap}`)
  const meter = createLoudnessMeter(SR)
  try {
    const log = await runFF(env.ffmpeg, [
      '-hide_banner', '-nostdin', '-y', ...plan.inputs.flat(), '-filter_complex_script', graphFile,
      // float, so a bus sum over 0 dBFS is kept for the master to bring down; RF64 past 4 GB (about 3 hours)
      ...(out ? ['-map', '[o]', '-c:a', 'pcm_f32le', '-rf64', 'auto', out] : []),
      '-map', '[m]', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1',
    ], { onChild: env.onChild, onPcm: (x) => meter.push(x) })
    return { I: meter.finish().I, TP: truePeakOf(log), seconds: (Date.now() - t0) / 1000 }
  } finally {
    try { fs.rmSync(graphFile, { force: true }) } catch { /* temp */ }
  }
}

/** The master applied to the premaster, measured (audio only; the 192 kHz ceiling is the slow part). */
async function measureMaster(premaster: string, filter: string, env: Pick<MixEnv, 'ffmpeg' | 'onChild'>) {
  const meter = createLoudnessMeter(SR)
  const log = await runFF(env.ffmpeg, ['-hide_banner', '-nostdin', '-i', premaster, '-af', `${filter},ebur128=peak=true:framelog=quiet`, '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
    { onChild: env.onChild, onPcm: (x) => meter.push(x) })
  return { I: meter.finish().I, TP: truePeakOf(log) }
}

export interface SettledMaster extends MasterPlan { passes: number; measuredI?: number; measuredTP?: number | null }

/**
 * The master's gain, settled. While the ceiling stays idle the master is a pure gain and the result
 * is exactly the plan, so nothing is rendered. When it may act (a hot Master volume, stacked SFX), the
 * master is measured and the loudness it cost folded back in, as the bake does (at most 3 passes).
 */
export async function settleMaster(premaster: string, m: MasterPlan, env: Pick<MixEnv, 'ffmpeg' | 'onChild' | 'check'>): Promise<SettledMaster> {
  if (!m.limiterLikely || m.plannedLufs == null) return { ...m, passes: 0 }
  let cur = m, passes = 0, got: { I: number; TP: number | null } = { I: NaN, TP: null }
  while (passes < 3) {
    env.check?.()
    got = await measureMaster(premaster, cur.filter, env)
    passes++
    // Optimize off has no target: what it measures is what it will be
    if (cur.targetLufs == null) return { ...cur, plannedLufs: got.I > -70 ? got.I : null, passes, measuredI: got.I, measuredTP: got.TP }
    if (!Number.isFinite(got.I) || Math.abs(got.I - m.plannedLufs) <= 0.05) break
    cur = withMasterGain(cur, cur.gainDb + (m.plannedLufs - got.I))
  }
  return { ...cur, passes, measuredI: got.I, measuredTP: got.TP }
}

export interface ExportAudio {
  /** the bus sum, float WAV, exactly the timeline's length; null when nothing on the timeline is heard */
  premaster: string | null
  master: SettledMaster
  pre: { I: number; TP: number | null }
  hash: string
  plan: Pick<MixPlan, 'buses'> & { ducks: number }
  mix: Omit<ResolvedMix, 'clips'>
  seconds: number
  cleanup: () => void
}

/** Recent loudness scans by mix hash (the UI meter asks again after every edit; the same timeline answers at once). */
const scans = new Map<string, { I: number; TP: number | null; at: number }>()
const remember = (hash: string, r: { I: number; TP: number | null }) => {
  scans.set(hash, { ...r, at: Date.now() })
  if (scans.size > 24) scans.delete(scans.keys().next().value!)
}

/** Everything the export's sound needs, ready for the video pass: the premaster on disk and the settled master. */
export async function prepareExportAudio(clips: ExportAudioClip[], s: MixSettings, env: MixEnv): Promise<ExportAudio> {
  const t0 = Date.now()
  const mix = await resolveMix(clips, env, s)
  const { clips: mixClips, ...mixInfo } = mix
  if (!mixClips.length) {
    const master = { ...planMaster({ I: -Infinity, TP: null, optimize: s.optimize, target: s.target, masterVolume: s.masterVolume }), passes: 0 }
    return { premaster: null, master, pre: { I: -Infinity, TP: null }, hash: '', plan: { buses: { voice: 0, music: 0, sfx: 0 }, ducks: 0 }, mix: mixInfo, seconds: 0, cleanup: () => {} }
  }
  const plan = planMix(mixClips, { totalS: s.totalS, duck: s.duck, tune: s })
  const hash = mixHash(plan)
  const premaster = path.join(env.workDir, `vidhelm_premaster_${process.pid}_${Date.now()}.wav`)
  const cleanup = () => { try { fs.rmSync(premaster, { force: true }) } catch { /* in use: the temp folder's own cleanup */ } }
  try {
    env.check?.()
    env.onStage?.('Mixing the sound')
    const pre = await renderPremaster(plan, env, premaster)
    env.check?.()
    remember(hash, pre)
    const planned = planMaster({ I: pre.I, TP: pre.TP, optimize: s.optimize, target: s.target, masterVolume: s.masterVolume })
    if (planned.limiterLikely) env.onStage?.('Setting the loudness')
    const master = await settleMaster(premaster, planned, env)
    return {
      premaster, master, pre, hash, plan: { buses: plan.buses, ducks: plan.traps.music.length }, mix: mixInfo,
      seconds: (Date.now() - t0) / 1000, cleanup,
    }
  } catch (e) {
    cleanup()
    throw e
  }
}

/**
 * The timeline loudness scan: where the export will land, without exporting. The same graph as the
 * export, rendered to nothing; voices without a bake are counted (they play as recorded here, and
 * the export bakes them first), so a caller can show the number as provisional.
 */
export async function scanTimelineLoudness(clips: ExportAudioClip[], s: MixSettings, env: MixEnv) {
  const t0 = Date.now()
  const mix = await resolveMix(clips, env, s)
  if (!mix.clips.length) return { ok: true, silent: true, I: null, TP: null, hash: '', plannedLufs: null, targetLufs: s.optimize ? planMaster({ I: -Infinity, TP: null, optimize: true, target: s.target }).targetLufs : null, unbaked: 0, notes: mix.notes, seconds: 0 }
  const plan = planMix(mix.clips, { totalS: s.totalS, duck: s.duck, tune: s })
  const hash = mixHash(plan)
  const hit = scans.get(hash)
  const pre = hit ? { I: hit.I, TP: hit.TP } : await renderPremaster(plan, env, null)
  if (!hit) remember(hash, pre)
  const m = planMaster({ I: pre.I, TP: pre.TP, optimize: s.optimize, target: s.target, masterVolume: s.masterVolume })
  const r1 = (x: number | null) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10)
  return {
    ok: true, cached: !!hit, hash, I: r1(pre.I), TP: r1(pre.TP), gainDb: r1(m.gainDb), plannedLufs: r1(m.plannedLufs), targetLufs: m.targetLufs,
    // the ceiling may take some of the gain back: the export measures and corrects; the scan says so
    limiterLikely: m.limiterLikely, unbaked: mix.unbaked, baked: mix.baked,
    buses: plan.buses, ducks: plan.traps.music.length, roles: mix.roles, notes: mix.notes, seconds: (Date.now() - t0) / 1000,
  }
}

export type { Bus }
