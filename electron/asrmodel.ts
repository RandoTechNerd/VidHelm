// Which Whisper model captions use, and how long it will take.
//
// Captions used to default to tiny on every machine, including the ones the machine tier
// (capability.ts) rates for a bigger model that gets more of the words right.
// "Automatic" follows the tier, and the time each model takes is shown up front and counted down
// while it runs, because a 13 minute job with a spinner looks like a hang.
//
// No Electron imports, so `npm run test:asr` can exercise it.

export type AsrModel = 'tiny' | 'base' | 'small'
export type CaptionModelSetting = AsrModel | 'auto'

const MODELS: AsrModel[] = ['tiny', 'base', 'small']
export const isAsrModel = (m: unknown): m is AsrModel => MODELS.includes(m as AsrModel)

/** What the settings call each model. */
export const MODEL_NAMES: Record<AsrModel, string> = { tiny: 'Fast', base: 'Balanced', small: 'Best' }

/**
 * Seconds of work per minute of audio, measured with the app's own loop on a 2 minute voiceover
 * (tiny 17, base 23 to 29, small 80 to 95). Replaced by this machine's own figures once it has run.
 */
export const DEFAULT_SEC_PER_MIN: Record<AsrModel, number> = { tiny: 17, base: 28, small: 80 }

/** The model a caption run uses: Automatic is whatever the machine tier picked. */
export const resolveCaptionModel = (setting: unknown, tierModel: AsrModel): AsrModel =>
  isAsrModel(setting) ? setting : tierModel

/**
 * Saved settings from before Automatic existed all say tiny, because tiny was the default and the
 * file is rewritten on every change; nobody can tell a choice from a default. So a saved tiny that
 * was never picked in the menu (modelPicked) is read as Automatic, once; picking Fast keeps it.
 */
export function migrateCaptionModel(saved: { model?: unknown; modelPicked?: unknown } | null | undefined): CaptionModelSetting {
  const m = saved?.model
  if (m === 'tiny' && saved?.modelPicked !== true) return 'auto'
  return m === 'auto' || isAsrModel(m) ? m : 'auto'
}

/** "Fast (about 3 min per 10 min of audio)" */
export function modelLabel(model: AsrModel, secPerMin = DEFAULT_SEC_PER_MIN[model]): string {
  const per10 = Math.max(1, Math.round((secPerMin * 10) / 60))
  return `${MODEL_NAMES[model]} (about ${per10} min per 10 min of audio)`
}

/**
 * Seconds left. Before the first window is back, the stored rate is all there is; after that the
 * pace actually measured on this run counts more the further it gets, since the machine may be
 * busier (or idler) than when the rate was stored.
 */
export function etaSeconds(p: { audioSec: number; doneSec: number; elapsedSec: number; secPerMin: number }): number {
  const left = Math.max(0, p.audioSec - p.doneSec)
  const stored = (left / 60) * p.secPerMin
  if (!(p.doneSec > 0) || !(p.elapsedSec > 0)) return Math.round(stored)
  const measured = left * (p.elapsedSec / p.doneSec)
  const trust = Math.min(1, p.doneSec / Math.max(1, p.audioSec * 0.3))
  return Math.round(stored * (1 - trust) + measured * trust)
}

/**
 * A run's pace folded into the stored one. Runs under 20 s of audio say more about loading the
 * model than about reading speech, so they leave it alone.
 */
export function blendRate(stored: number | undefined, audioSec: number, workSec: number): number | undefined {
  if (!(audioSec >= 20) || !(workSec > 0)) return stored
  const measured = workSec / (audioSec / 60)
  return +(stored && stored > 0 ? stored * 0.6 + measured * 0.4 : measured).toFixed(2)
}
