/* Pure helpers behind the shared controls (sliders, key fields) and the first screen (the empty
   stage, drop-anywhere import). No React runtime and no DOM, so scripts/uikit.test.mjs runs them
   under plain Node. */
import type { CSSProperties } from 'react'

/** The style a range input needs to paint its filled part (App.css reads --fill): the share of
 *  the way from min to max as a percentage, clamped, and 0% for anything that is not a number, so
 *  a bad value draws an empty track rather than a full one. */
export const rangeFill = (value: number, min: number, max: number): CSSProperties => {
  const span = max - min
  const f = span > 0 && Number.isFinite(value) ? Math.min(1, Math.max(0, (value - min) / span)) : 0
  return { '--fill': `${Math.round(f * 1000) / 10}%` } as CSSProperties
}

/** The end of a saved key: enough to tell two keys apart, never enough to use one. A short string
 *  shows nothing, since four characters of an eight-character token is half of it. */
export const keyTail = (key: string | null | undefined): string => {
  const k = (key ?? '').trim()
  return k.length >= 16 ? k.slice(-4) : ''
}

/** What a saved key field says in place of the key: "fal.ai key saved, ends in a1b2". */
export const savedKeyLabel = (name: string, key: string | null | undefined): string => {
  const tail = keyTail(key)
  return tail ? `${name} saved, ends in ${tail}` : `${name} saved`
}

/** Is this drag carrying files from Explorer? A clip dragged out of the Media Bin carries only
 *  VidHelm's own type, and text or a link dragged from a page carries neither: the window-wide
 *  drop target lights up for real files only. */
export const dragHasFiles = (types: ArrayLike<string> | null | undefined): boolean =>
  Array.from(types ?? []).includes('Files')

/** The clip a first import starts the timeline with: the first video, in the order the files
 *  came. Stills, sound and 3D wait in the bin; a lone song is not the start of an edit. */
export const firstVideoOf = <T extends { type: string }>(added: readonly T[]): T | null =>
  added.find(m => m.type === 'video') ?? null

/** The few projects the empty stage offers to reopen: most recently changed first. */
export const recentProjects = <T extends { modified?: number }>(projects: readonly T[], n = 3): T[] =>
  [...projects].sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0)).slice(0, n)

/** The empty stage's reminder of what the export will be: "1920×1080 · Landscape · 30 fps". */
export const formatLine = (w: number, h: number, shape: string, fps: number): string => `${w}×${h} · ${shape} · ${fps} fps`
