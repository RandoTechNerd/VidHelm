// What this machine can comfortably do, and what the heavy jobs should default to.
//
// VidHelm's accuracy work is deliberately expensive: reading speech with the `small` Whisper
// model, decoding a whole clip at 4fps to plan a crop, building proxies. On the machine it was
// written for that is the right trade. On a thin laptop it is the difference between "slow" and
// "unusable", and the person on that laptop is the one least able to diagnose why.
//
// So the defaults come from the hardware, once, and the user can always overrule them.
//
// CORE COUNT ALONE IS A BAD TEST, which is the whole reason there is a benchmark here. The
// machine this was developed on is an Intel Core Ultra 7 258V: 8 logical cores, no
// hyperthreading, and a very fast core. Classifying by core count would call it weak and quietly
// downgrade the accuracy its owner explicitly asked for. Measured on it: benchMs 99, 8 cores,
// 31.5 GB.
//
// No Electron imports, so `npm run test:capability` can exercise it standalone.

export type Tier = 'low' | 'balanced' | 'best'
/** What the user chose in Settings. 'auto' means "use what you detected". */
export type TierPreference = Tier | 'auto'

export interface MachineSpecs {
  /** logical processors */
  cores: number
  memGB: number
  /** a hardware video encoder that actually encoded a test frame, not one ffmpeg merely lists */
  hwEncoder: boolean
  /** milliseconds for a fixed single-core kernel. Lower is faster. ~99 on the reference machine. */
  benchMs: number
}

export interface PerfProfile {
  tier: Tier
  /** Whisper model for the analysis pass everything else measures from */
  speechModel: 'tiny' | 'base' | 'small'
  /** sample rate for the 9:16 crop analysis: halving it halves the decode work */
  framingFps: number
  /** how many filmstrip/thumbnail ffmpeg jobs may run at once */
  thumbnailWorkers: number
  /** x264 preset for exports */
  exportPreset: 'veryfast' | 'fast' | 'medium'
  proxyMaxWidth: number
  proxyMaxFps: number
  /** tiles on a b-roll contact sheet */
  sheetTiles: number
  /** one line for the Settings panel */
  note: string
}

/** A fast core. The reference machine measures 99. */
const FAST_MS = 130
/** Past here, everything heavy is going to hurt. */
const SLOW_MS = 260

/**
 * Work out which tier a machine belongs to, and say why in words a user can read.
 *
 * Deliberately asymmetric: it takes all three of a fast core, enough cores and enough memory to
 * earn `best`, but any ONE serious weakness drops it to `low`. Being wrong towards "too slow"
 * costs some accuracy; being wrong towards "too fast" costs an unusable app.
 */
export function classify(s: MachineSpecs): { tier: Tier; reasons: string[] } {
  const reasons: string[] = []
  const cores = Math.max(1, Math.round(s.cores || 1))
  const memGB = Math.max(0.5, s.memGB || 1)
  const bench = s.benchMs > 0 ? s.benchMs : SLOW_MS + 1

  const slowCore = bench > SLOW_MS
  const fastCore = bench <= FAST_MS
  const fewCores = cores <= 3
  const lowMem = memGB < 6

  if (slowCore) reasons.push(`slow processor (benchmark ${Math.round(bench)}ms, over ${SLOW_MS}ms)`)
  if (fewCores) reasons.push(`${cores} logical core${cores === 1 ? '' : 's'}`)
  if (lowMem) reasons.push(`${memGB.toFixed(1)} GB of memory`)

  if (slowCore || fewCores || lowMem) return { tier: 'low', reasons }

  if (fastCore && cores >= 8 && memGB >= 16) {
    reasons.push(`fast processor (benchmark ${Math.round(bench)}ms)`, `${cores} logical cores`, `${memGB.toFixed(1)} GB of memory`)
    if (s.hwEncoder) reasons.push('hardware video encoder')
    return { tier: 'best', reasons }
  }

  reasons.push(`${cores} logical cores`, `${memGB.toFixed(1)} GB of memory`, `benchmark ${Math.round(bench)}ms`)
  return { tier: 'balanced', reasons }
}

/** The defaults each tier gets. */
export function profileFor(tier: Tier): PerfProfile {
  switch (tier) {
    case 'low':
      return {
        tier, speechModel: 'tiny', framingFps: 2, thumbnailWorkers: 1,
        exportPreset: 'veryfast', proxyMaxWidth: 1280, proxyMaxFps: 30, sheetTiles: 4,
        note: 'Tuned for a modest machine: quickest speech model, lighter analysis, faster encoding. Accuracy suffers a little; you can raise it here.',
      }
    case 'best':
      return {
        tier, speechModel: 'small', framingFps: 4, thumbnailWorkers: 3,
        exportPreset: 'medium', proxyMaxWidth: 1920, proxyMaxFps: 60, sheetTiles: 6,
        note: 'Tuned for accuracy: the best speech model and the most thorough analysis. Slower, on purpose.',
      }
    default:
      return {
        tier: 'balanced', speechModel: 'base', framingFps: 3, thumbnailWorkers: 2,
        exportPreset: 'fast', proxyMaxWidth: 1920, proxyMaxFps: 30, sheetTiles: 6,
        note: 'A middle setting: accurate enough for real edits without making you wait for everything.',
      }
  }
}

/** Honour an explicit choice, fall back to what was detected, and never return nothing. */
export function resolveProfile(pref: TierPreference | undefined, detected: Tier | undefined): PerfProfile {
  if (pref && pref !== 'auto') return profileFor(pref)
  return profileFor(detected || 'balanced')
}

/**
 * The benchmark itself, kept here so the thresholds above and the thing being measured cannot
 * drift apart. Fixed iteration count, so the number means the same thing on every machine and
 * across versions: changing the kernel invalidates FAST_MS and SLOW_MS.
 *
 * One warm-up pass, then the median of three, so a stray scheduling hiccup cannot mislabel a
 * machine for the rest of its life.
 */
export function benchmark(): number {
  const kernel = () => {
    const t = Date.now()
    let x = 0
    for (let i = 1; i <= 8_000_000; i++) x = (x + Math.sqrt(i) * 1.000001) % 100000
    // returned so a clever engine cannot delete the loop as dead code
    return { ms: Date.now() - t, x }
  }
  kernel()
  const runs = [kernel().ms, kernel().ms, kernel().ms].sort((a, b) => a - b)
  return runs[1]
}

/** Short human summary for the Settings panel and for get_state. */
export function describeProfile(p: PerfProfile, detected?: Tier, pref?: TierPreference): string {
  const label = { low: 'Lighter', balanced: 'Balanced', best: 'Most accurate' }[p.tier]
  const how = !pref || pref === 'auto' ? `detected ${detected || 'balanced'}` : 'set by you'
  return `${label} (${how}): speech ${p.speechModel}, framing ${p.framingFps}fps, ${p.thumbnailWorkers} thumbnail job${p.thumbnailWorkers === 1 ? '' : 's'} at a time, export preset ${p.exportPreset}`
}
