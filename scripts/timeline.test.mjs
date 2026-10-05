// Tests for timeline geometry (electron/timeline.ts). Run with: npm run test:timeline
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'electron', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const T = await load('timeline.ts')
let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e

console.log('tick spacing')
ok(T.tickStepFor(40) === 2, `40 px/s labels every 2 s (${T.tickStepFor(40)})`)
ok(T.tickStepFor(200) === 0.5, 'fully zoomed in labels every half second')
ok(T.tickStepFor(2) === 30, `2 px/s labels every 30 s (${T.tickStepFor(2)})`)
ok(T.tickStepFor(0.001) === 3600, 'never runs off the end of the list')

console.log('ruler ticks')
{
  const ticks = T.rulerTicks(0, 10, 40)   // step 2, minor every 0.5 s (20 px apart)
  const labels = ticks.filter(t => t.label).map(t => t.t)
  ok(JSON.stringify(labels) === JSON.stringify([0, 2, 4, 6, 8, 10]), `labels on the step (${labels})`)
  ok(ticks.filter(t => !t.label).length === 15, `three minor ticks between labels (${ticks.filter(t => !t.label).length})`)
  ok(ticks.every((t, i) => i === 0 || t.t > ticks[i - 1].t), 'in order, no duplicates')
}
{
  const far = T.rulerTicks(0, 3600, 1)   // step 60, 4 parts of 15 s = 15 px apart
  const at300 = far.find(t => near(t.t, 300))
  ok(at300 && at300.label, 'tick 300 lands on exactly 300 s (no float drift)')
  ok(far.find(t => t.t === 0).major && !far.find(t => t.t === 60).major && far.find(t => t.t === 120).major, 'every other minute tick is major')
}
ok(T.rulerTicks(0, 100, 3).some(t => !t.label), 'minor ticks between 30 s labels at 3 px/s (15 px apart)')
ok(T.rulerTicks(0, 36000, 0.005).every(t => t.label), 'minor ticks dropped when they would be under 6 px apart')
ok(T.rulerTicks(4, 6, 40)[0].t === 4 && T.rulerTicks(4.1, 6, 40)[0].t === 4.5, 'a window starts at its first tick, not at 0')
ok(T.rulerTicks(0, 1e9, 200).length === 4000, 'capped, so a huge window cannot make millions of nodes')
ok(T.rulerTicks(0, 10, 0).length === 0 && T.rulerTicks(5, 1, 40).length === 0, 'nonsense in, nothing out')

console.log('timecodes')
ok(T.timecode(2.3) === '0:02.3', `2.3 s reads 0:02.3 (${T.timecode(2.3)})`)
ok(T.timecode(65.07) === '1:05.0' && T.timecode(0) === '0:00.0', 'minutes and zero')
ok(T.timecode(59 / 30, 'frames', 30) === '0:01:29', `59 frames at 30 fps (${T.timecode(59 / 30, 'frames', 30)})`)
ok(T.timecode(1, 'frames', 24) === '0:01:00' && T.timecode(61.5, 'frames', 24) === '1:01:12', '24 fps')
ok(T.timecode(NaN) === '0:00.0' && T.timecode(-3) === '0:00.0', 'NaN and negatives clamp to zero')
ok(T.clock(12.4) === '0:12.40' && T.clock(0.8) === '0:00.80' && T.clock(-0.5) === '-0:00.50', `clock with hundredths (${T.clock(12.4)})`)
ok(T.rulerLabel(90, 30) === '1:30' && T.rulerLabel(2, 1) === '0:02', 'ruler labels are m:ss')
ok(T.rulerLabel(1.5, 0.5, 30) === '0:01:15', 'half-second ticks show frames')

console.log('content width')
ok(T.contentWidth(0, 40, 1200) === 1200, 'an empty timeline still fills the view')
ok(T.contentWidth(100, 40, 1200) === (100 + 2) * 40 + 240, `a long one runs past the last clip (${T.contentWidth(100, 40, 1200)})`)
ok(T.contentWidth(100.2, 40, 1200) === (101 + 2) * 40 + 240, 'rounds the length up')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
