/**
 * What a key press means to the editor, decided in one place.
 *
 * The old handler was a chain of ifs in App.tsx, and the order of those ifs WAS the behaviour:
 * the single-key tools were checked without looking at the modifiers, so Ctrl+S split the
 * selected clip (and saved nothing) and Ctrl+M dropped a tag; Ctrl+Z was checked before the
 * text-field guard, so undoing a typo in a caption undid the timeline instead; and Space played
 * the video behind an open Settings dialog. Here the rules are a pure function with a test suite
 * (npm run test:shortcuts), and App.tsx only carries out the answer.
 *
 * The rules, in order:
 *  1. Ctrl (or Cmd) + S / Shift+S / O / E save, save a copy, open and export from anywhere,
 *     including a text field. Alt must be up: AltGr arrives as Ctrl+Alt and types letters
 *     (AltGr+S is a Polish s), so it is never a command.
 *  2. Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y undo and redo the timeline, except while typing, where
 *     the field's own undo is what anyone means.
 *  3. Nothing else fires while typing, while a form control has focus (arrows move a slider,
 *     Space ticks a box), behind a dialog, or with Ctrl, Alt or Cmd held. Shift is allowed: it
 *     is what turns a frame step into a second, and Caps Lock users type S as well as s.
 *  4. Held keys repeat only the playhead steps. A held M used to drop a row of tags, a held
 *     Space flickered between play and pause.
 *
 * Pure module: no DOM, no Electron. The element test takes the few fields it reads.
 */

export type Shortcut =
  | 'save' | 'saveAs' | 'open' | 'export' | 'undo' | 'redo'
  | 'play' | 'delete' | 'rippleDelete' | 'rippleTrimStart' | 'rippleTrimEnd' | 'split' | 'tag'
  | 'frameBack' | 'frameForward' | 'secondBack' | 'secondForward' | 'start' | 'end' | 'escape'

/** typing: the keys belong to a caret. control: a slider, tick box or list owns arrows and Space. */
export type FocusKind = 'typing' | 'control' | 'none'

export interface KeyPress { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean }
export interface FocusTarget { tagName?: string; type?: string; isContentEditable?: boolean }
export interface KeyContext { focus: FocusKind; modalOpen: boolean }

// input types you type into; every other input (range, checkbox, colour, file, button) is a control
const TYPING_INPUTS = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week'])

/** What kind of thing has the focus. */
export function focusKind(el: FocusTarget | null | undefined): FocusKind {
  if (!el) return 'none'
  if (el.isContentEditable) return 'typing'
  const tag = String(el.tagName || '').toUpperCase()
  if (tag === 'TEXTAREA') return 'typing'
  if (tag === 'INPUT') return TYPING_INPUTS.has(String(el.type ?? '').toLowerCase()) ? 'typing' : 'control'
  if (tag === 'SELECT') return 'control'
  return 'none'
}

/** The letter a key names. A Latin key reports itself; on another layout (Cyrillic, Greek) the
 *  physical key's code stands in, so Ctrl+S still saves on a Russian keyboard. AZERTY keeps its
 *  own letters: its Z key reports "z", whatever its code. */
function letterOf(e: KeyPress): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase()
  if (e.key.length === 1 && /^Key[A-Z]$/.test(e.code || '')) return e.code!.slice(3).toLowerCase()
  return ''
}

/** The shortcut a key press asks for, or null when it belongs to someone else (a field, a dialog, the OS). */
export function shortcutFor(e: KeyPress, ctx: KeyContext): Shortcut | null {
  const cmd = !!(e.ctrlKey || e.metaKey)
  const letter = letterOf(e)
  if (cmd && !e.altKey) {
    if (letter === 's') return e.shiftKey ? 'saveAs' : 'save'
    if (letter === 'o' && !e.shiftKey) return 'open'
    if (letter === 'e' && !e.shiftKey) return 'export'
    if (ctx.focus === 'typing') return null
    if (letter === 'z') return e.shiftKey ? 'redo' : 'undo'
    if (letter === 'y' && !e.shiftKey) return 'redo'
    return null
  }
  if (cmd || e.altKey) return null
  if (ctx.focus !== 'none' || ctx.modalOpen) return null
  let hit: Shortcut | null = null
  if (e.code === 'Space' || e.key === ' ') hit = 'play'
  else if (e.key === 'Delete' || e.key === 'Backspace') hit = e.shiftKey ? 'rippleDelete' : 'delete'
  else if (e.key === 'ArrowLeft') hit = e.shiftKey ? 'secondBack' : 'frameBack'
  else if (e.key === 'ArrowRight') hit = e.shiftKey ? 'secondForward' : 'frameForward'
  else if (e.key === 'Home') hit = 'start'
  else if (e.key === 'End') hit = 'end'
  else if (e.key === 'Escape') hit = 'escape'
  else if (letter === 's') hit = 'split'
  else if (letter === 'm') hit = 'tag'
  // Q and W as in Premiere and Resolve: trim the selected clip's head or tail to the playhead, gap closed
  else if (letter === 'q') hit = 'rippleTrimStart'
  else if (letter === 'w') hit = 'rippleTrimEnd'
  if (hit && e.repeat && !/Back$|Forward$/.test(hit)) return null
  return hit
}

/**
 * The playhead one frame (or one second) along, on the frame grid, inside [0, total].
 * After playback the playhead sits between frames; a step then goes to the edge of the frame it
 * is in rather than a whole frame on, so a step never skips the frame under the playhead.
 */
export function stepTime(t: number, dir: -1 | 1, fps: number, total: number, unit: 'frame' | 'second' = 'frame'): number {
  const f = fps > 0 && Number.isFinite(fps) ? fps : 30
  const end = Math.max(0, Number.isFinite(total) ? total : 0)
  const pos = (Number.isFinite(t) ? t : 0) * f
  const n = Math.round(pos)
  const onGrid = Math.abs(pos - n) < 1e-6
  const next = unit === 'second'
    ? n + dir * Math.round(f)
    : onGrid ? n + dir : (dir > 0 ? Math.ceil(pos) : Math.floor(pos))
  return Math.min(end, Math.max(0, next / f))
}
