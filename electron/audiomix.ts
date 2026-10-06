/* The export's sound, planned: which bus each clip plays on, the level each one is set to, where
 * the music ducks, and the master that puts the whole mix on the loudness target. Pure (no Node, no
 * Electron); electron/mixrender.ts runs it with ffmpeg, and the export, the timeline loudness scan
 * and the tests all build the one graph from here.
 *
 *   voice bus   baked voices (each already at -16 LUFS, -3.3 dBTP) and As is clips, with the
 *               clip's own volume, automation and fades; no compressor (each bake owns its level)
 *   music bus   each clip set to the bed level (5 LU under the voice), ducked 10 dB by keyframes
 *               drawn from the voices' speech, a -6 dBFS limiter for drum hits
 *   SFX bus     each clip's loudest moment set to the voice level, ducked 6 dB, -3.4 dBFS ceiling
 *   master      a measured LINEAR gain to the target, the 20 kHz low-pass, a 4x oversampled
 *               -1.5 dBTP ceiling. No compressor and no dynamic loudnorm: both re-pump the ducked bed
 *
 * The numbers are the quiet-audio shoot-out's (see electron/audiochain.ts).
 */
import {
  DUCK, SFX_DUCK, LOWPASS_20K, MASTER_CEILING_DBFS, MAX_STATIC_DB, SR, bedDb, sfxDb, duckTraps, limiterFilter,
  mapSegmentsToTimeline, musicBusGraph, platformTarget, roleGuess, sfxBusGraph, unionSegments,
  type Preset, type Provenance, type Role, type Trapezoid,
} from './audiochain'
import { clipAudioChain, type AudioClip } from './exportgraph'

export type Bus = 'voice' | 'music' | 'sfx'
const ROLES: Role[] = ['voice', 'music', 'sfx', 'asis']
const PRESETS: Preset[] = ['off', 'light', 'studio']
export const isRole = (r: unknown): r is Role => ROLES.includes(r as Role)
export const isPreset = (p: unknown): p is Preset => PRESETS.includes(p as Preset)
/** As is clips play on the voice bus: they keep their own level and are never ducked. */
export const busOf = (role: Role): Bus => (role === 'music' ? 'music' : role === 'sfx' ? 'sfx' : 'voice')

type Point = { t: number; v: number }

/** A clip as the export payload carries it: the fields the sound needs. */
export interface ExportAudioClip extends AudioClip {
  trackId?: string
  type?: string
  /** what the export opens for the clip (the video proxy, when it stands in for the picture) */
  path?: string
  /** the original media file: bakes and measurements belong to it, not to a proxy */
  mediaPath?: string
  hasAudio?: boolean
  volumePoints?: Point[]
  /** set on the clip (or its media) by the user or an agent; guessed when absent */
  role?: string
  voiceFix?: string
  audioChannels?: number
}

/** One audible clip with everything decided: what it plays on, from which file, at what level. */
export interface MixClip extends AudioClip {
  volumePoints?: Point[]
  role: Role
  /** the file the sound is read from (a voice's bake, else the clip's own source) */
  file: string
  /** 1 = a mono source, copied to both sides at full level */
  channels?: number
  /** the role's level (bed or SFX match), dB, before the clip's own volume */
  levelDb?: number
  /** speech in source seconds (voice clips; the duck keys from these) */
  segments?: [number, number][]
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/**
 * Volume automation as an eval=frame expression: linear between points, held flat outside them.
 * Times are timeline seconds (the clip is already delayed to its start when the volume runs), and
 * the preview's gainAt() reads the same points the same way.
 */
export function volumeExpr(pts: Point[] | undefined, clipStart: number): string | null {
  if (!pts || pts.length === 0) return null
  const P = pts.slice().sort((a, b) => a.t - b.t).map((p) => ({ a: clipStart + p.t, v: p.v }))
  let expr = `${P[P.length - 1].v}`
  for (let i = P.length - 1; i > 0; i--) {
    const p0 = P[i - 1], p1 = P[i]
    const span = (p1.a - p0.a) || 0.0001
    const seg = `(${p0.v}+(${p1.v}-${p0.v})*(t-${p0.a})/${span})`
    expr = `if(lt(t\\,${p1.a})\\,${seg}\\,${expr})`
  }
  return `if(lt(t\\,${P[0].a})\\,${P[0].v}\\,${expr})`
}

/** The clip's own gain: its automation when it has any (it takes precedence), else the flat volume. */
export const clipGain = (c: { start: number; volume?: number; volumePoints?: Point[] }): number | string =>
  volumeExpr(c.volumePoints, c.start) ?? (typeof c.volume === 'number' && Number.isFinite(c.volume) ? c.volume : 1)

/** Silent for its whole length: no reason to decode it, and a muted voice must not duck the music. */
const muted = (c: { volume?: number; volumePoints?: Point[] }) =>
  c.volumePoints?.length ? c.volumePoints.every((p) => !(p.v > 0)) : typeof c.volume === 'number' && !(c.volume > 0)

/** The clips that are heard: B-roll is picture only, and a muted clip contributes nothing. */
export function audibleClips<T extends ExportAudioClip>(clips: T[]): T[] {
  return (clips || []).filter((c) => c && c.hasAudio && c.trackId !== 'v2' && (c.path || c.mediaPath) && c.duration > 0 && !muted(c))
}

/** Where the file came from, read off its folder: the app's own recordings, narration, score and SFX library. */
export interface ProvenanceDirs { score?: string; sfx?: string; narration?: string }
const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const under = (file: string, dir?: string) => !!dir && normPath(file).startsWith(normPath(dir) + '/')
export function provenanceFromPath(file: string, dirs: ProvenanceDirs = {}): Provenance | undefined {
  if (under(file, dirs.score)) return 'score'
  if (under(file, dirs.sfx)) return 'sfx'
  if (under(file, dirs.narration)) return 'narration'
  // the voiceover button and the karaoke booth both save "voiceover <time>.webm"
  if (/^voiceover /i.test(file.replace(/\\/g, '/').split('/').pop() || '')) return 'voiceover'
  return undefined
}

/** A media file's sound, measured once: what the role guess and the level matching read. */
export interface SoundFacts {
  provenance?: Provenance
  /** the guess for the file under a picture (video) and on its own (audio) */
  guessVideo?: { role: Role; why: string }
  guessAudio?: { role: Role; why: string }
  /** integrated loudness and loudest 400 ms, read the way the export plays the file */
  I?: number
  M?: number
  segments?: [number, number][]
}

const DECISIVE: Provenance[] = ['booth', 'narration', 'voiceclone', 'voiceover', 'score', 'sfx']
/**
 * The clip's role: set on the clip wins, then where the file came from and the SFX track, then the
 * measurement. A file that could not be measured plays As is: the voice chain on music pumps, and a
 * duck under a voice nobody detected would only guess.
 */
export function resolveRole(c: { role?: string; trackId?: string; type?: string }, f: SoundFacts | null | undefined): { role: Role; why: string } {
  if (isRole(c.role)) return { role: c.role, why: 'set on the clip' }
  const isVideo = c.type === 'video'
  if ((f?.provenance && DECISIVE.includes(f.provenance)) || c.trackId === 'a2') return roleGuess(null, { provenance: f?.provenance, track: c.trackId, isVideo })
  return (isVideo ? f?.guessVideo : f?.guessAudio) || { role: 'asis', why: 'not measured, so played as recorded' }
}

/**
 * The level a role puts a clip at. Music: the bed, 5 LU under the voice. SFX: the loudest moment at
 * the voice level. Voices are already at it (the bake) and As is stays as recorded. Capped so a
 * near-silent file is not lifted into hiss.
 */
export function roleLevelDb(role: Role, f: SoundFacts | null | undefined): number {
  const ok = (x?: number) => typeof x === 'number' && Number.isFinite(x) && x > -70
  if (role === 'music' && ok(f?.I)) return clamp(bedDb(f!.I!), -24, 18)
  if (role === 'sfx' && ok(f?.M)) return clamp(sfxDb(f!.M!), -24, 18)
  return 0
}

/** Every voice clip's speech on the timeline, and the duck trapezoids for the music and SFX buses. */
export function duckPlan(clips: MixClip[]) {
  const segments = unionSegments(clips.filter((c) => c.role === 'voice' && c.segments?.length).map((c) => mapSegmentsToTimeline(c.segments!, c)))
  return { segments, music: duckTraps(segments, DUCK), sfx: duckTraps(segments, SFX_DUCK) }
}

export interface MixPlan {
  /** ffmpeg input arguments in order; input 0 is the silent bed that makes the mix exactly the timeline's length */
  inputs: string[][]
  /** the filtergraph, ending in [pre] (the bus sum, before the master) */
  graph: string
  /** samples in [pre] */
  samples: number
  buses: Record<Bus, number>
  traps: { music: Trapezoid[]; sfx: Trapezoid[] }
}

/**
 * The bus graph for the audible clips. Each clip keeps exportgraph's clipAudioChain (exact trim,
 * timeline delay, its own volume and the de-pop ramps at splices); in front of it a mono source is
 * copied to both sides at full level (the mixer's own upmix put it 3 dB under what the preview plays)
 * and the role's level is applied. `solo` renders one bus alone with the ducks still drawn from every
 * voice (stems, and the tests' voice-over-bed measurement).
 */
export function planMix(all: MixClip[], o: { totalS: number; duck?: boolean; solo?: Bus }): MixPlan {
  const total = Math.max(0.05, o.totalS)
  const samples = Math.round(total * SR)
  const traps = duckPlan(all)
  const clips = o.solo ? all.filter((c) => busOf(c.role) === o.solo) : all
  const inputs: string[][] = [['-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${SR}:d=${total.toFixed(3)}`]]
  const lines: string[] = []
  const bus: Record<Bus, string[]> = { voice: [], music: [], sfx: [] }
  clips.forEach((c, i) => {
    const k = i + 1
    const ss = Number(c.sourceStart) || 0
    // a short tail past the clip, as the picture inputs have: the chain trims to the exact length
    inputs.push([...(ss > 0 ? ['-ss', ss.toFixed(3)] : []), '-t', (c.duration + 0.2).toFixed(3), '-i', c.file])
    const pre: string[] = []
    if (c.channels === 1) pre.push('pan=stereo|c0=c0|c1=c0')
    if (c.levelDb && Math.abs(c.levelDb) >= 0.005) pre.push(`volume=${c.levelDb.toFixed(2)}dB`)
    let src = `${k}:a`
    if (pre.length) { lines.push(`[${k}:a]${pre.join(',')}[p${k}]`); src = `p${k}` }
    const timing: AudioClip = { start: c.start, duration: c.duration, sourceStart: c.sourceStart, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, aFadeIn: c.aFadeIn, aFadeOut: c.aFadeOut }
    lines.push(clipAudioChain(src, timing, clipGain(c), `c${k}`))
    bus[busOf(c.role)].push(`c${k}`)
  })
  const duck = o.duck !== false
  const sum: string[] = []
  if (!o.solo || o.solo === 'voice') {
    lines.push(bus.voice.length
      ? `[0:a]${bus.voice.map((l) => `[${l}]`).join('')}amix=inputs=${bus.voice.length + 1}:duration=first:dropout_transition=0:normalize=0[vbus]`
      : '[0:a]anull[vbus]')
    sum.push('vbus')
  } else {
    // the silent bed still sets the length of a solo render
    lines.push('[0:a]anull[vbus]')
    sum.push('vbus')
  }
  if (bus.music.length) { lines.push(musicBusGraph({ inputs: bus.music, bedDb: 0, traps: traps.music, duck })); sum.push('mbus') }
  if (bus.sfx.length) { lines.push(sfxBusGraph({ inputs: bus.sfx, gainDb: 0, traps: traps.sfx, duck })); sum.push('sbus') }
  // The master's 20 kHz low-pass (without it the AAC encode of a knock overshot to +0.1 dBTP) is
  // linear, so it can sit here, before the master's gain, where the measurement includes it: on bright
  // material it took 0.04 LU that a linear master then missed the target by. Then exactly the
  // timeline's length: the video's -t would cut a long tail, and a short one leaves the end silent.
  const fit = `${LOWPASS_20K},apad=whole_len=${samples},atrim=end_sample=${samples}`
  lines.push(sum.length > 1
    ? `${sum.map((l) => `[${l}]`).join('')}amix=inputs=${sum.length}:duration=first:dropout_transition=0:normalize=0,${fit}[pre]`
    : `[${sum[0]}]${fit}[pre]`)
  return {
    inputs, graph: lines.join(';'), samples,
    buses: { voice: bus.voice.length, music: bus.music.length, sfx: bus.sfx.length },
    traps: { music: duck ? traps.music : [], sfx: duck ? traps.sfx : [] },
  }
}

/** Above this distance from the ceiling the limiter is treated as idle and the master as exactly linear. */
export const LIMITER_MARGIN_DB = 0.5

/** The master after the premaster: the measured gain, then the 4x oversampled true-peak ceiling (the low-pass is already in the premaster). */
export const masterFilter = (gainDb: number, ceilDb = MASTER_CEILING_DBFS) => `volume=${gainDb.toFixed(2)}dB,${limiterFilter(ceilDb)}`
/** Optimize loudness off: the Master volume and the old -1 dBFS safety ceiling, now a true-peak one. */
export const safetyFilter = (masterVolume: number) => `volume=${+masterVolume.toFixed(4)},${limiterFilter(-1)}`

export interface MasterPlan {
  /** the filter chain from the premaster to the encoder */
  filter: string
  gainDb: number
  /** the platform target, or null when Optimize loudness is off */
  targetLufs: number | null
  /** where the export will land; null when the timeline is silent */
  plannedLufs: number | null
  ceilingDbtp: number
  /** the ceiling may act, so the result is measured (and the gain corrected) before the export */
  limiterLikely: boolean
}

/**
 * The master, from the measured premaster. Optimize on: the linear gain that lands the mix on the
 * target, times the Master volume (so the slider really moves the export: 0.5 is 6 dB under the
 * target), the 20 kHz low-pass and the -1.5 dBTP ceiling. Off: the Master volume and a -1 dBTP
 * safety ceiling only. Silence stays silence (no gain chasing a target it cannot reach).
 */
export function planMaster(o: { I: number; TP: number | null; optimize: boolean; target?: string | null; masterVolume?: number }): MasterPlan {
  const mv = clamp(typeof o.masterVolume === 'number' && Number.isFinite(o.masterVolume) ? o.masterVolume : 1, 0, 4)
  const audible = Number.isFinite(o.I) && o.I > -70
  if (mv < 0.001) return { filter: 'volume=0', gainDb: -120, targetLufs: o.optimize ? platformTarget(o.target).lufs : null, plannedLufs: null, ceilingDbtp: MASTER_CEILING_DBFS, limiterLikely: false }
  const mvDb = 20 * Math.log10(mv)
  const tp = typeof o.TP === 'number' && Number.isFinite(o.TP) ? o.TP : null
  if (o.optimize) {
    const T = platformTarget(o.target)
    const gainDb = (audible ? clamp(T.lufs - o.I, -40, MAX_STATIC_DB) : 0) + mvDb
    return {
      filter: masterFilter(gainDb, T.ceilingDbtp), gainDb, targetLufs: T.lufs,
      plannedLufs: audible ? o.I + gainDb : null, ceilingDbtp: T.ceilingDbtp,
      limiterLikely: audible && (tp == null || tp + gainDb > T.ceilingDbtp - LIMITER_MARGIN_DB),
    }
  }
  return {
    filter: safetyFilter(mv), gainDb: mvDb, targetLufs: null,
    plannedLufs: audible ? o.I + mvDb : null, ceilingDbtp: -1,
    limiterLikely: audible && (tp == null || tp + mvDb > -1 - LIMITER_MARGIN_DB),
  }
}

/** The same master with a corrected gain (the measured residual folded back in). Optimize only: off has no target to correct to. */
export function withMasterGain(m: MasterPlan, gainDb: number): MasterPlan {
  if (m.targetLufs == null) return m
  return { ...m, gainDb, filter: masterFilter(gainDb, m.ceilingDbtp) }
}
