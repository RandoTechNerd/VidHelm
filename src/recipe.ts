// The Start Recipe's switches: which lines are on, and turning one on or off. The default text
// itself lives with RecipeSection in extras.tsx. Kept out of that file, which holds only
// components, so React Fast Refresh can hot-swap the panels (react-refresh/only-export-components).

export interface RecipeSettings { text: string; introAudioPath: string | null }

export const RECIPE_TOGGLES: { key: string; label: string; hint: string }[] = [
  { key: 'cut-pauses', label: 'Cut dead air', hint: 'remove silent/static pauses first' },
  { key: 'thumbnail', label: 'Thumbnail', hint: 'your photo or the best real frame, subtitle + logo' },
  { key: 'subtitle', label: 'Catchy subtitle', hint: 'one-liner burned onto the thumbnail' },
  { key: 'titles', label: '5 title options', hint: 'your AI pitches titles, you pick' },
  { key: 'logo', label: 'Brand logo', hint: 'watermark on every export' },
  { key: 'intro-audio', label: 'Intro audio', hint: 'your sting placed at 0:00' },
  { key: 'captions', label: 'Captions', hint: 'on-device Whisper subtitles in your style theme' },
]

const lineKey = (line: string) => line.replace(/^#/, '').trim().split(/\s+/)[0] || ''
export const recipeActive = (text: string): Record<string, boolean> => {
  const state: Record<string, boolean> = {}
  for (const t of RECIPE_TOGGLES) state[t.key] = false
  for (const raw of text.split('\n')) {
    const key = lineKey(raw)
    if (key && state[key] !== undefined && !raw.trim().startsWith('#')) state[key] = true
  }
  return state
}
export const toggleRecipeLine = (text: string, key: string, on: boolean): string => {
  const lines = text.split('\n')
  let found = false
  const out = lines.map(raw => {
    if (lineKey(raw) !== key) return raw
    found = true
    const isOff = raw.trim().startsWith('#')
    if (on && isOff) return raw.replace(/^(\s*)#\s?/, '$1')
    if (!on && !isOff) return '# ' + raw
    return raw
  })
  if (on && !found) out.push(key)
  return out.join('\n')
}
