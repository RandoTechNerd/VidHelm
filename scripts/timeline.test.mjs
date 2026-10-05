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

console.log('snap targets')
{
  const items = [{ id: 'a', start: 0, duration: 4 }, { id: 'b', start: 4, duration: 3 }, { id: 'me', start: 10, duration: 2 }]
  const tg = T.collectSnapTargets(items, 'me', [0, 5.5, NaN])
  ok(JSON.stringify(tg) === JSON.stringify([0, 4, 5.5, 7]), `both edges of the others, the fixed ones, no duplicates, not my own (${tg})`)
  ok(T.nearestTarget(4.1, tg, 0.2) === 4 && T.nearestTarget(4.5, tg, 0.2) === null, 'nearest within the threshold only')
  ok(T.nearestTarget(5.0, [4.8, 5.1], 0.5) === 5.1, 'the closer of two candidates')
}
{
  const tg = [0, 4, 9]
  const byStart = T.snapMove(4.1, 2, tg, 0.2)
  ok(byStart.start === 4 && byStart.line === 4, 'a move snaps its start edge')
  const byEnd = T.snapMove(6.9, 2, tg, 0.2)
  ok(near(byEnd.start, 7) && byEnd.line === 9, `a move snaps its END edge too (${byEnd.start})`)
  const closer = T.snapMove(3.95, 5.1, tg, 0.2)   // start 0.05 from 4, end 0.05 from 9: tie goes to the start
  ok(closer.start === 4 && closer.line === 4, 'a tie goes to the start edge')
  const free = T.snapMove(2, 1, tg, 0.2)
  ok(free.start === 2 && free.line === null, 'nothing near: no snap, no line')
  ok(T.snapMove(-1, 1, tg, 0.2).start === 0, 'never before 0')
  ok(T.snapMove(0.05, 4, [0.1, 4.1], 0.2).start >= 0, 'an end snap that would go negative is ignored')
}

console.log('trims stay inside the footage')
{
  const c = { start: 10, duration: 4, sourceStart: 2 }
  const opts = { sourceDuration: 8, hasSource: true }
  const l = T.trimTo(c, 'left', 7, opts)        // wants 3 s earlier, only 2 s of footage before the in-point
  ok(near(l.start, 8) && near(l.sourceStart, 0) && near(l.duration, 6) && l.limit === 'footage-start', `left trim stops at the file's first frame (${l.start}, ${l.sourceStart})`)
  const r = T.trimTo(c, 'right', 20, opts)      // wants to end at 20; footage ends 6 s after the in-point
  ok(near(r.duration, 6) && r.limit === 'footage-end', `right trim stops at the file's end (${r.duration})`)
  const inside = T.trimTo(c, 'left', 9, opts)
  ok(near(inside.start, 9) && near(inside.sourceStart, 1) && inside.limit === null, 'inside the footage: no limit, in-point slides with the edge')
  const tiny = T.trimTo(c, 'right', 10.1, opts)
  ok(near(tiny.duration, 0.3) && tiny.limit === null, 'never shorter than the minimum')
  const shut = T.trimTo(c, 'left', 13.9, opts)
  ok(near(shut.duration, 0.3) && near(shut.start, 13.7), 'left edge cannot cross the right one')
  const edge0 = T.trimTo({ start: 1, duration: 4, sourceStart: 5 }, 'left', -2, opts)
  ok(edge0.start === 0 && edge0.limit === 'timeline-start' && near(edge0.sourceStart, 4), 'the timeline start stops it before the footage does')
  const still = T.trimTo({ start: 2, duration: 5, sourceStart: 0 }, 'right', 60, { hasSource: false })
  ok(near(still.duration, 58) && still.limit === null, 'a still (no source) can be as long as you like')
  const stillL = T.trimTo({ start: 2, duration: 5, sourceStart: 0 }, 'left', 0.5, { hasSource: false })
  ok(near(stillL.start, 0.5) && stillL.sourceStart === 0, 'a still keeps its in-point on a left trim')
  const unknown = T.trimTo(c, 'right', 30, { hasSource: true })
  ok(near(unknown.duration, 20), 'unknown media length: no end wall')
  const text = T.trimTo({ start: 3, duration: 2 }, 'right', 3.05, { hasSource: false, minDuration: 0.2 })
  ok(near(text.duration, 0.2), 'text has its own minimum')
}

console.log('saved clips pulled back inside their footage')
{
  const neg = T.clampToSource({ id: 'x', start: 5, duration: 4, sourceStart: -1 }, 10)
  ok(near(neg.start, 6) && near(neg.duration, 3) && neg.sourceStart === 0 && neg.id === 'x', 'a negative in-point moves the start so frames keep their times')
  const over = T.clampToSource({ start: 0, duration: 9, sourceStart: 3 }, 10)
  ok(near(over.duration, 7), 'running past the file end is shortened')
  const fine = { start: 1, duration: 2, sourceStart: 1 }
  ok(T.clampToSource(fine, 10) === fine, 'a clip that fits comes back as the same object')
  const hair = { start: 0, duration: 10.0004, sourceStart: 0 }
  ok(T.clampToSource(hair, 10) === hair, 'under a millisecond of overrun is left alone')
  ok(T.clampToSource({ start: 0, duration: 5, sourceStart: NaN }, 10).sourceStart === 0, 'NaN in-point becomes 0')
  const past = T.clampToSource({ start: 0, duration: 2, sourceStart: 12 }, 10)
  ok(past.sourceStart < 10 && past.sourceStart + past.duration <= 10 + 1e-9, 'an in-point past the end is pulled inside')
  ok(T.maxDurationFrom(3, 10) === 7 && T.maxDurationFrom(3) === Infinity, 'the most a clip can last from its in-point')
}

console.log('drag readouts')
ok(T.moveReadout(12.4, 11.6) === '0:12.40 (+0:00.80)', `move (${T.moveReadout(12.4, 11.6)})`)
ok(T.moveReadout(3, 4.25) === '0:03.00 (-0:01.25)', 'move left')
ok(T.trimReadout(3.4, 3.9) === 'Dur 3.40 (-0.50)', `trim (${T.trimReadout(3.4, 3.9)})`)
ok(T.trimReadout(6, 4, 'footage-end').endsWith('end of footage'), 'trim names the wall it hit')

console.log('filmstrips keep 16:9 frames')
{
  const tileW = 46 * 16 / 9   // 81.8 px on the video row
  ok(T.stripTiles(818, 46) === 10, `818 px of clip = 10 frames (${T.stripTiles(818, 46)})`)
  ok(T.stripTiles(20, 46) === 1, 'a sliver still gets one frame')
  ok(T.stripTiles(1e6, 46) === 120, 'capped')
  ok(T.stripFits(10, 10 * tileW * 1.1, 46), '10% stretch is fine')
  ok(!T.stripFits(10, 10 * tileW * 1.3, 46), '30% stretch re-renders')
  ok(T.stripFits(1, tileW * 1.4, 46), 'when the count would not change, keep it')
  ok(!T.stripFits(0, 500, 46), 'no strip yet: make one')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
