// Tests for the visual-index planner (electron/visual.ts).
// Run with: npm run test:visual

import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = await build({
  entryPoints: [path.join(here, '..', 'electron', 'visual.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18',
})
const { planVisualIndex, timecode, stackLayout } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  PASS ', label) } else { fail++; console.log('  FAIL ', label) } }
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

console.log('\n-- timecodes --')
eq(timecode(0), '0:00', 'zero')
eq(timecode(9.4), '0:09', 'seconds round')
eq(timecode(65), '1:05', 'minutes')
eq(timecode(770.5), '12:50', 'the grinder video length')
eq(timecode(3725), '1:02:05', 'past an hour it grows an hour field')
eq(timecode(-5), '0:00', 'negative clamps')

console.log('\n-- sampling a short clip --')
{
  const p = planVisualIndex(60, { interval: 8 })
  ok(p.times.length >= 7 && p.times.length <= 8, `about one frame every 8s (${p.times.length} for 60s)`)
  ok(p.times[0] >= 0.4, 'it does not sample the very first frame, which is often a title or black')
  ok(p.times.every((t, i) => i === 0 || t > p.times[i - 1]), 'times are in order')
  ok(p.times.every(t => t <= 60), 'and never past the end')
}

console.log('\n-- long videos are covered, not truncated --')
{
  // 30 minutes at 8s would be 225 frames, over the cap
  const p = planVisualIndex(1800, { interval: 8, maxFrames: 60 })
  eq(p.times.length, 60, 'the cap is respected')
  ok(p.times[p.times.length - 1] > 1700, `the LAST frame is near the end of the video (${p.times[p.times.length - 1]}s of 1800s)`)
  ok(p.interval > 8, `the interval widened instead (${p.interval}s)`)
  ok(/widened/.test(p.note), 'and it says so, rather than silently covering only the start')
}
{
  // the failure this guards against: naive truncation would stop at 8s * 60 = 480s
  const p = planVisualIndex(1800, { interval: 8, maxFrames: 60 })
  ok(p.times.filter(t => t > 900).length > 20, 'the second half of the video is genuinely sampled')
}

console.log('\n-- sheets --')
{
  const p = planVisualIndex(160, { interval: 8, perSheet: 9, cols: 3 })
  ok(p.sheets.length >= 2, `it splits into sheets (${p.sheets.length})`)
  eq(p.sheets[0].times.length, 9, 'nine tiles on a full sheet')
  eq(p.sheets[0].cols, 3, 'three across')
  eq(p.sheets[0].rows, 3, 'three down')
  ok(p.sheets.every(s => s.from <= s.to), 'each sheet reports a sane time range')
  const all = p.sheets.flatMap(s => s.times)
  eq(all.length, p.times.length, 'every sampled time lands on exactly one sheet')
  eq(JSON.stringify(all), JSON.stringify(p.times), 'and in the same order')
}
{
  const p = planVisualIndex(100, { interval: 8, perSheet: 9, cols: 3 })
  const last = p.sheets[p.sheets.length - 1]
  ok(last.times.length <= 9 && last.times.length >= 1, 'a partial last sheet is allowed')
  eq(last.cols, Math.min(3, last.times.length), 'and its grid shrinks to fit')
}

console.log('\n-- awkward inputs --')
ok(planVisualIndex(0.2).times.length >= 1, 'a very short clip still yields one frame')
ok(planVisualIndex(3, { interval: 8 }).times.length >= 1, 'an interval longer than the clip still yields one')
ok(planVisualIndex(60, { perSheet: 999 }).sheets.length >= 1, 'an absurd sheet size is clamped')
ok(planVisualIndex(60, { interval: 0 }).times.length <= 130, 'a zero interval cannot ask for infinite frames')

console.log('\n-- stack layout --')
eq(stackLayout(4, 2), '0_0|w0_0|0_h0|w0_h0', 'a 2x2 grid reads left to right, top to bottom')
eq(stackLayout(3, 3), '0_0|w0_0|w0+w1_0', 'a single row uses cumulative widths')
// the exact layout from ffmpeg's own documented 3x3 example
eq(stackLayout(9, 3), '0_0|w0_0|w0+w1_0|0_h0|w0_h0|w0+w1_h0|0_h0+h1|w0_h0+h1|w0+w1_h0+h1',
  'a 3x3 grid matches the documented layout exactly')
ok(!stackLayout(9, 3).includes('*'),
  'NO multiplication: xstack has no such operator, and given one it silently crops the sheet rather than failing')
ok(!stackLayout(9, 3).includes('undefined'), 'nothing undefined leaks into the filtergraph')
eq(stackLayout(1, 3), '0_0', 'a single tile sits at the origin')

console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✗ FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
