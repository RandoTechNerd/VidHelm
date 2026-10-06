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

/** The drag payload of an item pulled out of the Media Bin onto the timeline: its bin id. */
export const MEDIA_DRAG = 'application/x-vidhelm-media'

/** Is this drag carrying files from Explorer? Text or a link dragged from a page carries none: the
 *  window-wide drop target lights up for real files only. VidHelm's own type outranks 'Files',
 *  because a picture dragged inside the window lists both (Chromium hands the image over as a
 *  file), and that is a clip on its way to the timeline, not footage to import. */
export const dragHasFiles = (types: ArrayLike<string> | null | undefined): boolean => {
  const t = Array.from(types ?? [])
  return t.includes('Files') && !t.includes(MEDIA_DRAG)
}

// Input types Chromium types into, and so drops text into. Number is left out: it refuses most
// of what anyone would drag at it.
const TEXT_INPUTS = new Set(['text', 'search', 'url', 'email', 'tel', 'password'])

/** Does this element take typing, and so take dropped text? Shaped like a DOM element but read
 *  field by field, so it runs without one. */
export const isTextEntry = (el: { tagName?: string; type?: string; readOnly?: boolean; disabled?: boolean; isContentEditable?: boolean } | null | undefined): boolean => {
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = (el.tagName ?? '').toUpperCase()
  const typed = tag === 'TEXTAREA' || (tag === 'INPUT' && TEXT_INPUTS.has((el.type || 'text').toLowerCase()))
  return typed && !el.readOnly && !el.disabled
}

/** What a drop that no panel claimed should do. Files are imported. Text dropped on a field is
 *  left to the field: cancelling the drop also cancels Chromium inserting it, which broke dragging
 *  a line into the booth script or a prompt. Anything else is swallowed, since an uncancelled drop
 *  of a link navigates the whole window away from the edit. */
export type DropIntent = 'import' | 'field' | 'swallow'
export const dropIntent = (types: ArrayLike<string> | null | undefined, onTextEntry: boolean): DropIntent =>
  Array.from(types ?? []).includes(MEDIA_DRAG) ? 'swallow' // a bin item has nothing to type
    : dragHasFiles(types) ? 'import'
    : onTextEntry ? 'field' : 'swallow'

/** Does the window-wide guard (src/main.tsx) cancel this drag before anything else sees it? Files
 *  always: dropped where nothing takes them, Chromium opens the file as a page in place of the
 *  editor. A link too, unless it is over a field: there Chromium types the address into the field
 *  instead of navigating, which is what dragging a link at a prompt is for. */
export const holdsDrop = (types: ArrayLike<string> | null | undefined, onTextEntry: boolean): boolean => {
  const t = Array.from(types ?? [])
  return t.includes('Files') || (t.includes('text/uri-list') && !onTextEntry)
}

/** The clip a first import starts the timeline with: the first video, in the order the files
 *  came. Stills, sound and 3D wait in the bin; a lone song is not the start of an edit. */
export const firstVideoOf = <T extends { type: string }>(added: readonly T[]): T | null =>
  added.find(m => m.type === 'video') ?? null

/** The few projects the empty stage offers to reopen: most recently changed first. */
export const recentProjects = <T extends { modified?: number }>(projects: readonly T[], n = 3): T[] =>
  [...projects].sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0)).slice(0, n)

/** The empty stage's reminder of what the export will be: "1920×1080 · Landscape · 30 fps". */
export const formatLine = (w: number, h: number, shape: string, fps: number): string => `${w}×${h} · ${shape} · ${fps} fps`
