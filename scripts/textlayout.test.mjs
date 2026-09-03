// Tests for the text design rules (electron/textlayout.ts). Run with: npm run test:textlayout
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'electron', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const T = await load('textlayout.ts')
let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }

console.log('estimateBox')
{
  const b = T.estimateBox({ text: 'Hello', x: 0.5, y: 0.5, fontSize: 100, start: 0, duration: 1 })
  ok(b.x0 < 0.5 && b.x1 > 0.5 && b.y0 < 0.5 && b.y1 > 0.5, 'box is centred on x/y')
  const caps = T.estimateBox({ text: 'HELLO', x: 0.5, y: 0.5, fontSize: 100, start: 0, duration: 1 })
  ok(caps.x1 - caps.x0 > b.x1 - b.x0, 'CAPS are wider than mixed case')
  const boxed = T.estimateBox({ text: 'Hello', x: 0.5, y: 0.5, fontSize: 100, start: 0, duration: 1, box: true })
  ok(boxed.x1 - boxed.x0 > b.x1 - b.x0, 'a background box adds padding')
  const two = T.estimateBox({ text: 'a\nb', x: 0.5, y: 0.5, fontSize: 100, start: 0, duration: 1 })
  ok(two.y1 - two.y0 > (b.y1 - b.y0) * 1.8, 'two lines are roughly twice as tall')
}

console.log('fitFontSize')
{
  ok(T.fitFontSize('Short', 80) === 80, 'short text keeps its size')
  const shrunk = T.fitFontSize('A VERY LONG TITLE THAT WOULD RUN RIGHT OFF THE EDGE OF THE FRAME', 120)
  ok(shrunk < 120 && shrunk >= 12, `long text shrinks to fit (${shrunk}px)`)
  const box = T.estimateBox({ text: 'A VERY LONG TITLE THAT WOULD RUN RIGHT OFF THE EDGE OF THE FRAME', x: 0.5, y: 0.5, fontSize: shrunk, start: 0, duration: 1 })
  ok(box.x1 - box.x0 <= 0.9 + 1e-6, 'and actually fits 90% of the frame after shrinking')
}

console.log('layoutReport')
{
  const texts = [
    { id: 'title', text: 'BIG TITLE', x: 0.5, y: 0.5, fontSize: 120, start: 0, duration: 3 },
    { id: 'clash', text: 'also here', x: 0.5, y: 0.52, fontSize: 60, start: 1, duration: 3 },
    { id: 'later', text: 'no clash', x: 0.5, y: 0.5, fontSize: 60, start: 5, duration: 3 },
    { id: 'edge', text: 'off the right edge for sure', x: 0.98, y: 0.3, fontSize: 60, start: 0, duration: 3 },
    { id: 'flash', text: 'blink', x: 0.2, y: 0.2, fontSize: 40, start: 10, duration: 0.2 },
  ]
  const r = T.layoutReport(texts)
  ok(r.overlaps.some(o => o.a === 'title' && o.b === 'clash'), 'overlapping texts at the same time are caught')
  ok(!r.overlaps.some(o => o.b === 'later'), 'same spot at a different time is not an overlap')
  ok(r.offFrame.some(o => o.id === 'edge' && o.side === 'right'), 'text off the right edge is caught')
  ok(r.flashes.some(f => f.id === 'flash'), 'a 0.2s flash is caught')
  ok(r.notes.length === r.overlaps.length + r.offFrame.length + r.flashes.length, 'one note per finding')
  const clean = T.layoutReport([{ id: 'x', text: 'fine', x: 0.5, y: 0.5, fontSize: 60, start: 0, duration: 2 }])
  ok(clean.notes.length === 0, 'a clean track reports nothing')
}

console.log('presets')
{
  const lt = T.presetFor('lower-third', 'Rando, RandoTechNerd')
  ok(lt.y > 0.75 && lt.x < 0.4 && lt.box === true, 'lower third sits bottom-left in a box')
  const big = T.presetFor('title', 'AN EXTREMELY LONG TITLE THAT NEEDS SHRINKING TO FIT THE FRAME WIDTH PROPERLY')
  ok(big.fontSize < T.PRESETS.title.fontSize, 'title preset shrinks long text')
  ok(Object.keys(T.presetFor('nope', 'x')).length === 0, 'unknown preset yields no defaults')
}

console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✗ FAILURES'} - ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
