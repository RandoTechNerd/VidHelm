// Standalone tests for b-roll matching and placement (electron/broll.ts).
// Run with: npm run test:broll

import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = await build({
  entryPoints: [path.join(here, '..', 'electron', 'broll.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18',
})
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
const { stem, keywords, matchScore, planBroll, snapToWords, describePlan } = mod

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  PASS ', label) } else { fail++; console.log('  FAIL ', label) } }
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

const asset = (id, labels, extra = {}) => ({
  id, name: `${id}.mp4`, path: `C:/broll/${id}.mp4`, duration: 12, hasAudio: false, labels, ...extra,
})
/** sentences at 6s each, starting at t */
const sentence = (idx, text, start, len = 6) => ({
  startIdx: idx * 10, endIdx: idx * 10 + 5, start, end: start + len, text,
})

console.log('\n-- stemming and keywords --')
eq(stem('grinding'), 'grind', 'ing is stripped')
eq(stem('grinder'), 'grind', 'er is stripped')
eq(stem('grinds'), 'grind', 'plural s is stripped')
eq(stem('beans'), 'bean', 'beans -> bean')
eq(stem('espresso'), 'espresso', 'a normal word is left alone')
eq(stem('glass'), 'glass', 'a double s is not mistaken for a plural')
ok(!keywords('this is the one and only thing').includes('thing'), 'stop words are dropped')
ok(keywords('pouring the beans into the grinder').includes('bean'), 'nouns survive stemming')

console.log('\n-- scoring a match --')
{
  const beans = asset('beans', ['coffee beans', 'pouring'])
  const hi = matchScore('now I am pouring the coffee beans in', beans)
  const lo = matchScore('the battery lasts about two weeks', beans)
  ok(hi.score > 0.6, `an on-topic line scores high (${hi.score})`)
  ok(lo.score === 0, 'an unrelated line scores zero')
  ok(hi.matched.includes('bean'), 'it reports which words matched')
}
{
  const grind = asset('grind', ['grinder', 'grinding'])
  ok(matchScore('so that is a nice fine grind we got going', grind).score > 0.5, 'inflections still match')
}
{
  const kitchen = asset('kitchen', ['kitchen', 'counter', 'morning', 'sunlight', 'window', 'plants', 'tiles', 'wood'])
  const focused = asset('grind', ['grinder'])
  const line = 'I keep the grinder on the kitchen counter'
  ok(matchScore(line, focused).score > matchScore(line, kitchen).score,
    'a clip labelled with everything does not beat a clip that is actually about the line')
}
{
  const phrase = asset('p', ['coffee beans'])
  const split = asset('s', ['coffee', 'beans'])
  const line = 'I poured the coffee beans in'
  ok(matchScore(line, phrase).score >= matchScore(line, split).score, 'the whole phrase counts for at least as much')
}

console.log('\n-- placement --')
const assets = [
  asset('beans', ['coffee beans', 'pouring']),
  asset('grind', ['grinder', 'grinding', 'burr']),
  asset('shot', ['espresso', 'crema', 'portafilter']),
]
{
  const sentences = [
    sentence(0, 'welcome back everyone', 0),
    sentence(1, 'I am pouring the coffee beans in now', 10),
    sentence(2, 'listen to the grinder working through them', 20),
    sentence(3, 'and here is the espresso with a lovely crema', 30),
  ]
  // 15s of cutaway in a 40s cut would be 37%, over the default cap, so this case asks for 50%
  const { placements } = planBroll(sentences, assets, { totalDuration: 40, protectStart: 5, coverage: 0.5 })
  eq(placements.length, 3, 'every on-topic line gets its clip')
  eq(placements[0].assetId, 'beans', 'the beans clip lands on the beans line')
  eq(placements[1].assetId, 'grind', 'the grinder clip lands on the grinder line')
  eq(placements[2].assetId, 'shot', 'the espresso clip lands on the espresso line')
  ok(placements.every((p, i) => i === 0 || p.start >= placements[i - 1].start), 'returned in timeline order')
}
{
  const sentences = [sentence(0, 'I am pouring the coffee beans in now', 1)]
  const { placements } = planBroll(sentences, assets, { totalDuration: 40, protectStart: 8 })
  eq(placements.length, 0, 'the opening is left on the speaker')
}
{
  const sentences = [
    sentence(0, 'I am pouring the coffee beans in now', 10),
    sentence(1, 'more about those coffee beans', 17),
  ]
  const { placements, skipped } = planBroll(sentences, assets, { totalDuration: 40, protectStart: 5, gapBetween: 4 })
  eq(placements.length, 1, 'two cutaways back to back become one')
  ok(skipped.some(s => s.reason === 'too close to another cutaway'), 'and it says why')
}
{
  const sentences = Array.from({ length: 8 }, (_, i) => sentence(i, 'pouring the coffee beans in', 10 + i * 20))
  const { placements } = planBroll(sentences, assets, { totalDuration: 200, protectStart: 5, gapBetween: 1 })
  ok(placements.length <= 2, 'one clip cannot be used over and over')
}
{
  // enough distinct clips that per-clip reuse is not what limits it: the cap is
  const many = Array.from({ length: 10 }, (_, i) => asset(`beans${i}`, ['coffee beans']))
  const sentences = Array.from({ length: 10 }, (_, i) => sentence(i, 'pouring the coffee beans in', 10 + i * 8))
  const { placements, skipped } = planBroll(sentences, many, { totalDuration: 100, protectStart: 5, gapBetween: 1, coverage: 0.2 })
  const covered = placements.reduce((s, p) => s + (p.end - p.start), 0)
  ok(covered <= 20.001, `coverage stays under the cap (${covered.toFixed(1)}s of 100s)`)
  ok(skipped.some(s => s.reason === 'coverage cap'), 'and it says why')
}
{
  const sentences = [sentence(0, 'I am pouring the coffee beans in now', 10)]
  const { placements } = planBroll(sentences, assets, {
    totalDuration: 40, protectStart: 5, protect: [{ start: 8, end: 20 }],
  })
  eq(placements.length, 0, 'a protected stretch is never covered')
}
{
  const short = [asset('beans', ['coffee beans', 'pouring'], { duration: 0.8 })]
  const sentences = [sentence(0, 'I am pouring the coffee beans in now', 10)]
  eq(planBroll(sentences, short, { totalDuration: 40, protectStart: 5 }).placements.length, 0,
    'a clip too short to cut to is skipped rather than looped')
}
{
  const sentences = [sentence(0, 'I am pouring the coffee beans in now', 10, 30)]
  const { placements } = planBroll(sentences, assets, { totalDuration: 60, protectStart: 5, maxDuration: 5 })
  ok(placements[0].end - placements[0].start <= 5.001, 'a long sentence does not mean a long cutaway')
}
{
  const sentences = [sentence(0, 'the battery lasts about two weeks', 10)]
  eq(planBroll(sentences, assets, { totalDuration: 40, protectStart: 5 }).placements.length, 0,
    'nothing is cut in when nothing matches')
}
{
  const ranged = [asset('beans', ['coffee beans'], { bestStart: 3, bestEnd: 9 })]
  const sentences = [sentence(0, 'pouring the coffee beans', 10)]
  const { placements } = planBroll(sentences, ranged, { totalDuration: 40, protectStart: 5 })
  eq(placements[0].sourceStart, 3, 'the usable part of the clip is what gets used')
}

console.log('\n-- snapping to words --')
{
  const words = [
    { start: 10.0, end: 10.3 }, { start: 10.35, end: 10.8 }, { start: 10.85, end: 11.4 },
    { start: 11.5, end: 12.0 }, { start: 12.1, end: 12.6 }, { start: 12.7, end: 13.2 },
    { start: 14.0, end: 14.4 },
  ]
  const sentences = [{ startIdx: 0, endIdx: 5, start: 10, end: 13.2, text: 'pouring the coffee beans in now' }]
  const placements = [{ assetId: 'beans', name: 'b', path: 'p', start: 10, end: 12.4, sourceStart: 0, sentenceIdx: 0, matched: [], score: 1, text: '' }]
  const snapped = snapToWords(placements, sentences, words)
  ok(snapped[0].start <= 10 && snapped[0].start > 9.9, 'the in point sits just before the first word')
  ok(snapped[0].end > 12.0 && snapped[0].end < 12.1, 'the out point lands in the gap after a whole word')
}
{
  const words = [{ start: 10, end: 10.4 }, { start: 10.5, end: 11.0 }]
  const sentences = [{ startIdx: 0, endIdx: 1, start: 10, end: 11, text: 'two words' }]
  const placements = [{ assetId: 'x', name: 'b', path: 'p', start: 10, end: 11, sourceStart: 0, sentenceIdx: 0, matched: [], score: 1, text: '' }]
  const snapped = snapToWords(placements, sentences, words)
  ok(snapped[0].end > snapped[0].start, 'a snapped clip never inverts')
}

console.log('\n-- the report --')
{
  const p = [{ assetId: 'beans', name: 'beans.mp4', path: 'p', start: 65, end: 68, sourceStart: 0, sentenceIdx: 1, matched: ['bean'], score: 0.8, text: '' }]
  const s = describePlan(p, 200)
  ok(s.includes('1:05'), 'timestamps are readable')
  ok(s.includes('beans.mp4'), 'it names the clip')
}
eq(describePlan([], 100).startsWith('No cutaways'), true, 'an empty plan says so plainly')

console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✗ FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
