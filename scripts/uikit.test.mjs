// Tests for the shared-control helpers (src/uikit.ts). Run with: npm run test:uikit
import { build } from 'esbuild'
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
ok(U.dragHasFiles(['Files']) && U.dragHasFiles(['text/uri-list', 'Files']), 'a drag from Explorer carries Files')
ok(!U.dragHasFiles(['application/x-vidhelm-media']), 'a clip dragged out of the Media Bin is not a file drop')
ok(!U.dragHasFiles(['text/plain', 'text/html']), 'text dragged from a page is not a file drop')
ok(!U.dragHasFiles(undefined) && !U.dragHasFiles(null) && !U.dragHasFiles([]), 'no types, no files')

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

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} - ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
