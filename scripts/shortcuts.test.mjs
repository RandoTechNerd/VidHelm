// Tests for the keyboard rules (electron/shortcuts.ts). Run with: npm run test:shortcuts
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'electron', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const K = await load('shortcuts.ts')
let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e

const free = { focus: 'none', modalOpen: false }
const typing = { focus: 'typing', modalOpen: false }
const control = { focus: 'control', modalOpen: false }
const modal = { focus: 'none', modalOpen: true }
const key = (k, mods = {}) => ({ key: k, code: /^[a-z]$/i.test(k) ? 'Key' + k.toUpperCase() : k === ' ' ? 'Space' : k, ...mods })
const S = (k, mods, ctx = free) => K.shortcutFor(key(k, mods), ctx)

console.log('Ctrl shortcuts')
ok(S('s', { ctrlKey: true }) === 'save', 'Ctrl+S saves')
ok(S('s', { ctrlKey: true }) !== 'split', 'Ctrl+S never splits')
ok(S('S', { ctrlKey: true, shiftKey: true }) === 'saveAs', 'Ctrl+Shift+S saves a copy')
ok(S('s', { metaKey: true }) === 'save', 'Cmd+S saves')
ok(S('s', { ctrlKey: true }, typing) === 'save', 'Ctrl+S saves while typing in a field')
ok(S('o', { ctrlKey: true }) === 'open' && S('o', { ctrlKey: true }, typing) === 'open', 'Ctrl+O opens, field or not')
ok(S('e', { ctrlKey: true }) === 'export', 'Ctrl+E exports')
ok(S('s', { ctrlKey: true, altKey: true }, typing) === null, 'AltGr+S (Ctrl+Alt) types a letter, never saves')
ok(S('m', { ctrlKey: true }) === null, 'Ctrl+M does not drop a tag')
ok(S('r', { ctrlKey: true }) === null && S('w', { ctrlKey: true }) === null, 'Ctrl+R and Ctrl+W are not ours')

console.log('undo and redo')
ok(S('z', { ctrlKey: true }) === 'undo', 'Ctrl+Z undoes the timeline')
ok(S('Z', { ctrlKey: true, shiftKey: true }) === 'redo' && S('y', { ctrlKey: true }) === 'redo', 'Ctrl+Shift+Z and Ctrl+Y redo')
ok(S('z', { ctrlKey: true }, typing) === null, 'Ctrl+Z in a text field is the field\'s own undo')
ok(S('y', { ctrlKey: true }, typing) === null, 'Ctrl+Y in a text field is the field\'s own redo')
ok(S('z', { ctrlKey: true }, control) === 'undo', 'Ctrl+Z after nudging a slider still undoes (a slider has no undo of its own)')
ok(S('z', { ctrlKey: true }, modal) === 'undo', 'Ctrl+Z works with a panel open (undo after applying takes)')

console.log('single-key tools')
ok(S(' ') === 'play' && S('s') === 'split' && S('m') === 'tag', 'Space plays, S splits, M tags')
ok(S('S', { shiftKey: true }) === 'split', 'Shift (or Caps Lock) S still splits')
ok(S('Delete') === 'delete' && S('Backspace') === 'delete', 'Delete and Backspace delete')
ok(S('Home') === 'start' && S('End') === 'end' && S('Escape') === 'escape', 'Home, End, Escape')
ok(S('ArrowLeft') === 'frameBack' && S('ArrowRight', { shiftKey: true }) === 'secondForward', 'arrows step a frame, Shift a second')
ok(S(' ', {}, typing) === null && S('m', {}, typing) === null && S('Delete', {}, typing) === null, 'nothing fires while typing')
ok(S(' ', {}, control) === null && S('ArrowLeft', {}, control) === null, 'a focused slider or tick box keeps Space and the arrows')
ok(S(' ', {}, modal) === null && S('Delete', {}, modal) === null && S('s', {}, modal) === null && S('ArrowRight', {}, modal) === null, 'nothing fires behind a dialog')
ok(S('m', { altKey: true }) === null && S(' ', { ctrlKey: true }) === null, 'Alt+M and Ctrl+Space are not tools')
ok(S('m', { repeat: true }) === null && S(' ', { repeat: true }) === null, 'a held M or Space fires once')
ok(S('ArrowRight', { repeat: true }) === 'frameForward', 'a held arrow keeps stepping')

console.log('other layouts')
ok(K.shortcutFor({ key: 'ы', code: 'KeyS', ctrlKey: true }, free) === 'save', 'Ctrl+S on a Russian layout saves')
ok(K.shortcutFor({ key: 'ь', code: 'KeyM' }, free) === 'tag', 'M on a Russian layout tags')
ok(K.shortcutFor({ key: 'z', code: 'KeyW', ctrlKey: true }, free) === 'undo', 'AZERTY Ctrl+Z (the key coded W) undoes')

console.log('focusKind')
ok(K.focusKind({ tagName: 'INPUT', type: 'text' }) === 'typing' && K.focusKind({ tagName: 'INPUT', type: 'number' }) === 'typing', 'text and number inputs are typing')
ok(K.focusKind({ tagName: 'INPUT' }) === 'typing', 'an input with no type is a text input')
ok(K.focusKind({ tagName: 'TEXTAREA' }) === 'typing' && K.focusKind({ tagName: 'DIV', isContentEditable: true }) === 'typing', 'textarea and contentEditable are typing')
ok(K.focusKind({ tagName: 'INPUT', type: 'range' }) === 'control' && K.focusKind({ tagName: 'INPUT', type: 'checkbox' }) === 'control' && K.focusKind({ tagName: 'SELECT' }) === 'control', 'sliders, tick boxes and lists are controls')
ok(K.focusKind({ tagName: 'BUTTON' }) === 'none' && K.focusKind({ tagName: 'BODY' }) === 'none' && K.focusKind(null) === 'none', 'buttons and the page are free')

console.log('stepTime')
ok(near(K.stepTime(1, 1, 30, 10), 1 + 1 / 30), 'one frame forward at 30 fps')
ok(near(K.stepTime(1, -1, 25, 10), 1 - 1 / 25), 'one frame back at 25 fps')
ok(near(K.stepTime(1.2345, 1, 30, 10), 38 / 30) && near(K.stepTime(1.2345, -1, 30, 10), 37 / 30), 'from between frames, steps to the edges of the frame it is in')
ok(near(K.stepTime(2, 1, 30, 10, 'second'), 3) && near(K.stepTime(2.01, -1, 30, 10, 'second'), 1), 'Shift steps a second, on the grid')
ok(K.stepTime(0, -1, 30, 10) === 0 && near(K.stepTime(9.99, 1, 30, 10), 10), 'never before 0 or past the end')
ok(near(K.stepTime(1, 1, 0, 10), 1 + 1 / 30) && K.stepTime(NaN, 1, 30, 10) === 1 / 30, 'a bad fps or time falls back sanely')

// ---- ripple keys ----
{
  const free = { focus: 'none', modalOpen: false }
  ok(K.shortcutFor({ key: 'Delete', shiftKey: true }, free) === 'rippleDelete' && K.shortcutFor({ key: 'Backspace', shiftKey: true }, free) === 'rippleDelete', 'Shift+Delete / Shift+Backspace ripple-delete')
  ok(K.shortcutFor({ key: 'Delete' }, free) === 'delete', 'plain Delete still leaves the gap')
  ok(K.shortcutFor({ key: 'q' }, free) === 'rippleTrimStart' && K.shortcutFor({ key: 'w' }, free) === 'rippleTrimEnd', 'Q and W ripple-trim')
  ok(K.shortcutFor({ key: 'q' }, { focus: 'typing', modalOpen: false }) === null && K.shortcutFor({ key: 'w', ctrlKey: true }, free) === null, 'Q/W never fire in a text field or with Ctrl')
  ok(K.shortcutFor({ key: 'q', repeat: true }, free) === null, 'a held Q does not repeat')
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} - ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
