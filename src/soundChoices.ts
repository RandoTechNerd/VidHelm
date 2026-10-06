/* A media file's sound choices (its Sound role and Fix voice level) as the undo history keeps them.
 * They belong to the FILE, not a clip, so they live in the bin rather than in the clips the history
 * snapshots; without them Ctrl+Z could not take back a role clicked by mistake, which re-levels and
 * ducks the whole file in the export. Pure, tested by npm run test:soundchoices.
 */
import type { Preset, Role } from '../electron/audiochain'

type WithChoices = { id: string; audio?: { role?: Role; fix?: Preset } }

/**
 * The bin's choices as one string. A string so the history only hears about a CHOICE: the bin also
 * changes with every measurement and bake percent, and those must neither make undo steps nor hold
 * the history's 450 ms coalescing open. A file with no choice (the guess and Studio) is left out, so
 * importing one is not an undo step either.
 */
export const soundChoicesOf = (bin: WithChoices[]): string =>
  JSON.stringify(bin.filter(m => m.audio?.role || m.audio?.fix).map(m => [m.id, m.audio?.role ?? null, m.audio?.fix ?? null]))

/**
 * The bin with the choices of a snapshot (soundChoicesOf) put back. A file the snapshot does not
 * name had no choice then: back to the guess and Studio. Everything else a file carries (its
 * measurement, its bake) is kept. Nothing to change returns the same array, so a state setter given
 * it does not re-render.
 */
export function restoreSoundChoices<M extends WithChoices>(bin: M[], snap: string): M[] {
  const was = new Map((JSON.parse(snap) as [string, Role | null, Preset | null][]).map(([id, role, fix]) => [id, { role: role ?? undefined, fix: fix ?? undefined }]))
  let changed = false
  const next = bin.map(m => {
    const w = was.get(m.id)
    if ((m.audio?.role ?? undefined) === w?.role && (m.audio?.fix ?? undefined) === w?.fix) return m
    changed = true
    return { ...m, audio: { ...m.audio, role: w?.role, fix: w?.fix } }
  })
  return changed ? next : bin
}
