// Tests for the shared-control helpers (src/uikit.ts). Run with: npm run test:uikit
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'src', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const U = await load('uikit.ts')
let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }
const fill = (v, lo, hi) => U.rangeFill(v, lo, hi)['--fill']

console.log('rangeFill')
ok(fill(0.5, 0, 1) === '50%', 'halfway is 50%')
ok(fill(16, 4, 40) === '33.3%', 'measured from min, not from zero (logo size 16 of 4..40)')
ok(fill(0.1, 0.1, 1) === '0%' && fill(1, 0.1, 1) === '100%', 'the ends are 0% and 100%')
ok(fill(-3, 0, 1) === '0%' && fill(9, 0, 1) === '100%', 'out-of-range values clamp')
ok(fill(NaN, 0, 1) === '0%' && fill(Infinity, 0, 1) === '0%', 'not a number draws an empty track')
ok(fill(5, 3, 3) === '0%' && fill(5, 4, 2) === '0%', 'a zero or inverted span does not divide by zero')

console.log('keyTail / savedKeyLabel')
const fal = '3f9c2b7e-1d4a-4c8e-9b2f-7a6d5e4c3b2a:0123456789abcdef0123456789aba1b2'
ok(U.keyTail(fal) === 'a1b2', 'a real-length key shows its last four')
ok(U.keyTail('  ' + fal + '\n') === 'a1b2', 'pasted whitespace is not part of the key')
ok(U.keyTail('short-token') === '', 'a short token shows nothing (four would be a third of it)')
ok(U.keyTail('') === '' && U.keyTail(undefined) === '' && U.keyTail(null) === '', 'nothing saved, nothing shown')
ok(U.savedKeyLabel('fal.ai key', fal) === 'fal.ai key saved, ends in a1b2', 'the saved line names the key and its tail')
ok(U.savedKeyLabel('Freesound key', 'abc123') === 'Freesound key saved', 'and drops the tail when there is none to show')
ok(!U.savedKeyLabel('fal.ai key', fal).includes(fal.slice(0, 8)), 'the start of the key never appears')

console.log('dragHasFiles')
ok(U.MEDIA_DRAG === 'application/x-vidhelm-media', 'the Media Bin drag type is lower case (Chromium lower-cases types)')
ok(U.dragHasFiles(['Files']) && U.dragHasFiles(['text/uri-list', 'Files']), 'a drag from Explorer carries Files')
ok(!U.dragHasFiles([U.MEDIA_DRAG]), 'a clip dragged out of the Media Bin is not a file drop')
// what a bin row's still actually carries when the picture, not the row, starts the drag
ok(!U.dragHasFiles(['text/uri-list', 'text/html', 'Files', U.MEDIA_DRAG]), 'nor is a picture dragged out of the bin, Files and all')
ok(!U.dragHasFiles(['text/plain', 'text/html']), 'text dragged from a page is not a file drop')
ok(!U.dragHasFiles(undefined) && !U.dragHasFiles(null) && !U.dragHasFiles([]), 'no types, no files')

console.log('isTextEntry')
ok(U.isTextEntry({ tagName: 'TEXTAREA' }), 'the booth script and the prompts are textareas')
ok(U.isTextEntry({ tagName: 'INPUT', type: 'text' }) && U.isTextEntry({ tagName: 'INPUT', type: 'search' }) && U.isTextEntry({ tagName: 'INPUT' }), 'text and search inputs, and an input with no type')
ok(U.isTextEntry({ tagName: 'INPUT', type: 'password' }), 'a masked key field takes dropped text too')
ok(U.isTextEntry({ tagName: 'DIV', isContentEditable: true }), 'a text layer being typed into')
ok(!U.isTextEntry({ tagName: 'INPUT', type: 'range' }) && !U.isTextEntry({ tagName: 'INPUT', type: 'checkbox' }) && !U.isTextEntry({ tagName: 'INPUT', type: 'number' }), 'sliders, switches and number boxes do not take text')
ok(!U.isTextEntry({ tagName: 'TEXTAREA', readOnly: true }) && !U.isTextEntry({ tagName: 'INPUT', type: 'text', disabled: true }), 'read-only and disabled fields do not')
ok(!U.isTextEntry({ tagName: 'DIV' }) && !U.isTextEntry({ tagName: 'BUTTON' }) && !U.isTextEntry(null), 'nor does the rest of the window')

console.log('dropIntent')
ok(U.dropIntent(['Files'], false) === 'import' && U.dropIntent(['Files'], true) === 'import', 'files are imported wherever they land')
ok(U.dropIntent(['text/plain', 'text/html'], true) === 'field', 'text on a field is left to the field, so it is inserted')
ok(U.dropIntent(['text/uri-list', 'text/plain'], false) === 'swallow', 'a link anywhere else is swallowed, not navigated to')
ok(U.dropIntent([U.MEDIA_DRAG], true) === 'swallow' && U.dropIntent([U.MEDIA_DRAG], false) === 'swallow', 'a bin item off the timeline does nothing')
ok(U.dropIntent(['text/uri-list', 'text/html', 'Files', U.MEDIA_DRAG], false) === 'swallow', 'a bin still dropped on the stage is not re-imported')
ok(U.dropIntent([], false) === 'swallow' && U.dropIntent(undefined, true) === 'field', 'an empty drag on a field is still the field\'s')

console.log('firstVideoOf')
const bin = [{ id: 'a', type: 'audio' }, { id: 'i', type: 'image' }, { id: 'v1', type: 'video' }, { id: 'v2', type: 'video' }]
ok(U.firstVideoOf(bin)?.id === 'v1', 'the first video in drop order, past the song and the still')
ok(U.firstVideoOf([{ type: 'audio' }, { type: 'image' }]) === null, 'no video, nothing goes on the timeline')
ok(U.firstVideoOf([]) === null, 'nothing imported, nothing placed')

console.log('recentProjects')
const projects = [{ name: 'old', modified: 100 }, { name: 'newest', modified: 900 }, { name: 'undated' }, { name: 'mid', modified: 500 }, { name: 'newer', modified: 700 }]
ok(U.recentProjects(projects).map(p => p.name).join() === 'newest,newer,mid', 'three, most recently changed first')
ok(U.recentProjects(projects, 10).at(-1).name === 'undated', 'a project with no date sorts last')
ok(projects[0].name === 'old', 'the list it was given is left alone')
ok(U.recentProjects([]).length === 0, 'no projects, no list')

console.log('formatLine')
ok(U.formatLine(1920, 1080, 'Landscape', 30) === '1920×1080 · Landscape · 30 fps', 'size, shape and rate')
ok(U.formatLine(1080, 1920, 'Portrait', 60) === '1080×1920 · Portrait · 60 fps', 'portrait reads tall')

// App.css, read the way the cascade reads it. Several control states are set by rules of equal
// weight where only the order decides, and a later variant quietly beating :disabled, or a .modal
// rule beating a component's own, is easy to miss by eye. For one property on one element,
// `matching` names every App.css selector that matches that element; the declaration from the
// most specific of them wins, and among equals the one written last.
const css = fs.readFileSync(path.join(here, '..', 'src', 'App.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m, i) => ({
  selectors: m[1].split(',').map(x => x.trim().replace(/\s+/g, ' ')),
  decls: [...m[2].matchAll(/([\w-]+)\s*:\s*([^;]+)/g)].map((d, j) => ({ prop: d[1], value: d[2].trim(), at: i * 1000 + j })),
}))
const specificity = (sel) => {
  const s = sel.replace(/"[^"]*"/g, '').replace(/::[\w-]+/g, '')
  const ids = (s.match(/#[\w-]+/g) || []).length
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!not\()[\w-]+/g) || []).length
  const tags = (s.match(/(?:^|[\s>+~(])[a-z][\w-]*/g) || []).length
  return ids * 10000 + classes * 100 + tags
}
const winner = (props, matching) => {
  let best = null
  for (const r of rules) for (const sel of r.selectors) {
    if (!matching.includes(sel)) continue
    const sp = specificity(sel)
    for (const d of r.decls) if (props.includes(d.prop) && (!best || sp > best.sp || (sp === best.sp && d.at > best.at))) best = { sp, sel, ...d }
  }
  return best
}

console.log('App.css cascade')
ok(specificity('.modal input[type="text"]') === 201 && specificity('.tool-btn:hover:not(:disabled)') === 300 && specificity('.secret-field .duration-input') === 200, 'the specificity reader agrees with the spec')
for (const [what, matching] of [['a Media Bin still', ['img', '.media-still']], ['a still on the stage', ['img', '.layer']], ['the logo on the stage', ['img', '.brand-logo']]])
  ok(winner(['-webkit-user-drag'], matching)?.value === 'none', `${what} is not a drag source of its own`)

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} - ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
