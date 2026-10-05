/* Pure helpers behind the shared controls (sliders, key fields). No React runtime and no DOM,
   so scripts/uikit.test.mjs runs them under plain Node. */
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
