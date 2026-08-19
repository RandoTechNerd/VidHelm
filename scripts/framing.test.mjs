// Standalone tests for the 9:16 crop planner (electron/framing.ts).
// Run with: npm run test:framing

import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = await build({
  entryPoints: [path.join(here, '..', 'electron', 'framing.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18',
})
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
const { columnScores, bestCentre, shotCuts, holdSegments, limitPan, planCrop, cropExpr, mergeHolds } = mod

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  PASS ', label) } else { fail++; console.log('  FAIL ', label) } }
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
const near = (a, b, tol, label) => ok(Math.abs(a - b) <= tol, `${label} (got ${a}, want ~${b})`)

const W = 64, H = 36

/** A frame that is flat grey with a busy patch (the "subject") centred at fraction cx. */
const frameWithSubject = (t, cx, { noise = 0, subjectW = 0.14 } = {}) => {
  const gray = new Uint8Array(W * H).fill(110)
  const x0 = Math.round((cx - subjectW / 2) * W)
  const x1 = Math.round((cx + subjectW / 2) * W)
  for (let y = 4; y < H - 4; y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      gray[y * W + x] = (x + y) % 2 ? 245 : 20        // high contrast texture
    }
  }
  if (noise) for (let i = 0; i < gray.length; i++) gray[i] = Math.max(0, Math.min(255, gray[i] + ((i * 37 + t * 13) % noise) - noise / 2))
  return { t, w: W, h: H, gray }
}

const flat = (t, value = 110) => ({ t, w: W, h: H, gray: new Uint8Array(W * H).fill(value) })

console.log('\n-- finding the subject in one frame --')
{
  const s = columnScores(frameWithSubject(0, 0.75), null)
  eq(s.length, W, 'one score per column')
  const peak = s.indexOf(Math.max(...s))
  near(peak / W, 0.75, 0.08, 'the busy patch scores highest')
}
{
  const cx = bestCentre(columnScores(frameWithSubject(0, 0.75), null), 9 / 16 / (16 / 9))
  near(cx, 0.75, 0.09, 'the crop centres on the subject, not the frame')
}
{
  const cx = bestCentre(columnScores(frameWithSubject(0, 0.02), null), 9 / 16 / (16 / 9))
  ok(cx >= 0.3164 / 2 - 1e-6, 'a subject at the edge still yields an in-bounds crop')
}
{
  const cx = bestCentre(columnScores(flat(0), null), 9 / 16 / (16 / 9))
  near(cx, 0.5, 0.02, 'a featureless frame falls back to centre')
}
{
  // movement should beat static detail: busy patch left, moving patch right
  const a = frameWithSubject(0, 0.25)
  const b = { ...frameWithSubject(0.25, 0.25) }
  for (let y = 10; y < 26; y++) for (let x = 46; x < 54; x++) b.gray[y * W + x] = 250
  const cx = bestCentre(columnScores(b, a), 9 / 16 / (16 / 9))
  ok(cx > 0.5, 'what moved wins over what is merely detailed')
}

console.log('\n-- shot changes --')
{
  const frames = [flat(0, 100), flat(0.25, 100), flat(0.5, 220), flat(0.75, 220)]
  eq(JSON.stringify(shotCuts(frames)), '[2]', 'a hard cut is detected once')
}
{
  const frames = [0, 0.25, 0.5, 0.75].map(t => flat(t, 100))
  eq(shotCuts(frames).length, 0, 'a static shot has no cuts')
}
{
  const frames = [0, 0.25, 0.5].map((t, i) => flat(t, 100 + i * 3))
  eq(shotCuts(frames).length, 0, 'a slow exposure drift is not a cut')
}

{
  // handheld: every frame differs a lot, but it is all one shot
  const noisy = Array.from({ length: 20 }, (_, i) => {
    const f = frameWithSubject(i * 0.25, 0.6)
    for (let k = 0; k < f.gray.length; k++) f.gray[k] = Math.max(0, Math.min(255, f.gray[k] + ((k * 7 + i * 53) % 61) - 30))
    return f
  })
  const cuts = shotCuts(noisy)
  ok(cuts.length <= 1, `handheld noise is not mistaken for 20 cuts (got ${cuts.length})`)
}
{
  // a locked-off shot with slight movement: the absolute floor stops it counting as cuts
  const still = Array.from({ length: 10 }, (_, i) => {
    const f = frameWithSubject(i * 0.25, 0.5)
    for (let k = 0; k < 200; k++) f.gray[k] = 110 + (i % 2) * 12
    return f
  })
  eq(shotCuts(still).length, 0, 'a tripod shot with slight movement has no cuts')
}

console.log('\n-- merging holds --')
{
  const segs = [
    { start: 0, end: 1, cx: 0.50, reason: 'a' },
    { start: 1, end: 2, cx: 0.52, reason: 'b' },
    { start: 2, end: 3, cx: 0.80, reason: 'c' },
  ]
  const m = mergeHolds(segs)
  eq(m.length, 2, 'holds a percent apart become one')
  eq(m[0].end, 2, 'and the merged hold spans both')
}

console.log('\n-- holding still --')
{
  // subject wobbles by a couple of percent: the crop must not follow
  const track = Array.from({ length: 20 }, (_, i) => ({ t: i * 0.25, cx: 0.6 + (i % 2 ? 0.015 : -0.015) }))
  const segs = holdSegments(track, 0, 5)
  eq(segs.length, 1, 'jitter does not move the crop')
  near(segs[0].cx, 0.6, 0.02, 'it holds on the subject')
}
{
  // subject genuinely walks from 0.3 to 0.75 halfway through
  const track = Array.from({ length: 24 }, (_, i) => ({ t: i * 0.25, cx: i < 12 ? 0.3 : 0.75 }))
  const segs = holdSegments(track, 0, 6)
  ok(segs.length >= 2, 'a real move does move the crop')
  near(segs[0].cx, 0.3, 0.03, 'the first hold is where the subject was')
  near(segs[segs.length - 1].cx, 0.75, 0.06, 'the last hold is where it went')
}
{
  const track = Array.from({ length: 4 }, (_, i) => ({ t: i * 0.25, cx: i < 2 ? 0.3 : 0.8 }))
  const segs = holdSegments(track, 0, 1.0)
  eq(segs.length, 1, 'a shot too short to pan is held on one centre')
}
{
  const track = Array.from({ length: 16 }, (_, i) => ({ t: i * 0.25, cx: 0.5 + (i > 8 && i < 10 ? 0.3 : 0) }))
  const segs = holdSegments(track, 0, 4)
  eq(segs.length, 1, 'a half-second blip is not a move')
}

console.log('\n-- pan limiting --')
{
  const segs = [
    { start: 0, end: 1, cx: 0.2, reason: '' },
    { start: 1, end: 2, cx: 0.9, reason: '' },
  ]
  const limited = limitPan(segs, { maxPanPerSec: 0.1 })
  near(limited[1].cx, 0.3, 0.001, 'a jump is capped at the pan rate')
}
{
  const segs = [{ start: 0, end: 1, cx: 0.4, reason: '' }, { start: 1, end: 2, cx: 0.45, reason: '' }]
  near(limitPan(segs, { maxPanPerSec: 0.1 })[1].cx, 0.45, 0.001, 'a gentle move is left alone')
}

console.log('\n-- the whole plan --')
{
  // 4 seconds at 4fps, subject parked right of centre
  const frames = Array.from({ length: 16 }, (_, i) => frameWithSubject(i * 0.25, 0.72))
  const plan = planCrop(frames)
  eq(plan.segments.length, 1, 'a steady shot yields one steady crop')
  near(plan.segments[0].cx, 0.72, 0.09, 'pointed at the subject')
  eq(plan.shots.length, 1, 'one shot detected')
}
{
  // two shots: subject left, then a cut to a different scene with the subject right.
  // The background changes too, because that is what a real cut looks like to a difference
  // metric: two handheld frames inside ONE shot already differ by ~23/255 at 4fps.
  const frames = [
    ...Array.from({ length: 8 }, (_, i) => frameWithSubject(i * 0.25, 0.25)),
    ...Array.from({ length: 8 }, (_, i) => {
      const f = frameWithSubject(2 + i * 0.25, 0.78)
      for (let k = 0; k < f.gray.length; k++) if (f.gray[k] === 110) f.gray[k] = 40
      return f
    }),
  ]
  const plan = planCrop(frames)
  ok(plan.shots.length === 2, 'the cut splits the plan into two shots')
  ok(plan.segments.length >= 2, 'each shot gets its own centre')
  ok(plan.segments[0].cx < 0.5 && plan.segments[plan.segments.length - 1].cx > 0.5, 'each points at its own subject')
}
{
  const frames = Array.from({ length: 12 }, (_, i) => frameWithSubject(i * 0.25, 0.5))
  const plan = planCrop(frames, { hints: [{ t: 1.0, cx: 0.85, weight: 1 }] })
  near(plan.segments[0].cx, 0.85, 0.05, 'a hint from someone who looked at it wins')
  eq(plan.segments[0].reason, 'placed by hint', 'and says so in the reason')
}
{
  eq(planCrop([]).segments.length, 0, 'no frames is not a crash')
}

console.log('\n-- ffmpeg expression --')
{
  const plan = { segments: [{ start: 0, end: 4, cx: 0.5, reason: '' }], track: [], shots: [] }
  eq(cropExpr(plan, 1920, 608), '656', 'a single hold is a plain number')
}
{
  const plan = { segments: [{ start: 0, end: 2, cx: 0.25, reason: '' }, { start: 2, end: 4, cx: 0.75, reason: '' }], track: [], shots: [] }
  const e = cropExpr(plan, 1920, 608)
  ok(e.includes('if(lt(t,2.000)'), 'two holds produce a stepped expression')
  ok(!e.includes('NaN'), 'no NaN leaks into the graph')
}
{
  const plan = { segments: [{ start: 0, end: 4, cx: 0.99, reason: '' }], track: [], shots: [] }
  eq(cropExpr(plan, 1920, 608), String(1920 - 608), 'the crop cannot run off the right edge')
}

console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✗ FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
