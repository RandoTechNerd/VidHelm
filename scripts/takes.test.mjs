// Standalone tests for the repeated-take detector (electron/takes.ts).
// Run with: npm run test:takes
// esbuild transpiles the TS in memory so there is no build step and no test framework.

import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = await build({
  entryPoints: [path.join(here, '..', 'electron', 'takes.ts')],
  bundle: false, write: false, format: 'esm', target: 'node18',
})
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
const { normalizeLine, similarity, isRestart, scoreTake, groupTakes, removalRanges, removedSeconds, findAdjacentRepeat, chunksFromWords } = mod

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  PASS ', label) } else { fail++; console.log('  FAIL ', label) } }
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

console.log('\n-- text helpers --')
eq(normalizeLine('  So, THE thing is... '), 'so the thing is', 'normalize strips punctuation and case')
eq(normalizeLine("it's fine!"), "it's fine", 'apostrophes survive (it is vs its matters)')
ok(similarity('the cat sat on the mat', 'the cat sat on the mat') === 1, 'identical lines score 1')
ok(similarity('hello there friend', 'completely different words entirely') === 0, 'unrelated lines score 0')
ok(similarity('the the the', 'the cat sat down quietly') < 0.5, 'repeated words cannot inflate a match')
ok(similarity('this printer prints four colours at once', 'this printer prints four colors at once') > 0.8, 'one different word still matches')

console.log('\n-- false starts --')
ok(isRestart('so the first thing', 'so the first thing you notice is the size of it'), 'aborted run at the same words is a restart')
ok(!isRestart('so the first thing', 'and then we moved on to something else'), 'different opening is not a restart')
ok(!isRestart('hello', 'hello there everyone welcome back'), 'a single word is too little to call it a restart')
ok(!isRestart('the same words here', 'the same words here'), 'equal-length lines are not restarts (similarity handles those)')

console.log('\n-- scoring --')
ok(scoreTake({ start: 0, end: 3, text: 'This is the finished sentence.' }) >
   scoreTake({ start: 0, end: 3, text: 'This is the finished sentence and' }), 'a sentence that lands beats one that trails off')
ok(scoreTake({ start: 0, end: 3, text: 'the print bed is heated.' }) >
   scoreTake({ start: 0, end: 3, text: 'um the uh print bed is like heated.' }), 'fillers cost a take')

console.log('\n-- grouping a real-looking retake --')
const takeChunks = [
  { start: 0.0, end: 2.4, text: 'Welcome back to the channel.' },
  { start: 2.6, end: 4.0, text: 'So this printer has four' },                       // false start
  { start: 4.2, end: 8.0, text: 'So this printer has four tool heads, um, which is wild.' },
  { start: 8.2, end: 12.0, text: 'So this printer has four tool heads, which is wild.' }, // clean retake
  { start: 12.4, end: 16.0, text: 'Let me show you what that means in practice.' },
]
const groups = groupTakes(takeChunks)
eq(groups.length, 1, 'one group found')
eq(JSON.stringify(groups[0].members), JSON.stringify([1, 2, 3]), 'false start and both attempts grouped')
eq(groups[0].keep, 3, 'keeps the clean final take, not the one with fillers')

console.log('\n-- things that must NOT group --')
const distinct = [
  { start: 0, end: 3, text: 'First we level the bed.' },
  { start: 3, end: 6, text: 'Then we load the filament.' },
  { start: 6, end: 9, text: 'Finally we start the print.' },
]
eq(groupTakes(distinct).length, 0, 'different sentences are left alone')
eq(groupTakes([{ start: 0, end: 1, text: 'okay' }, { start: 1, end: 2, text: 'okay' }]).length, 0, 'short interjections are ignored')
const farApart = [
  { start: 0, end: 3, text: 'This is the part that always breaks.' },
  { start: 400, end: 403, text: 'This is the part that always breaks.' },
]
eq(groupTakes(farApart).length, 0, 'the same line an hour later is a callback, not a retake')
eq(groupTakes([{ start: 0, end: 3, text: 'This is the part that always breaks.' },
               { start: 4, end: 7, text: 'This is the part that always breaks.' }]).length, 1, 'the same line seconds later is a retake')

console.log('\n-- removal ranges --')
const ranges = removalRanges(takeChunks, groups)
eq(ranges.length, 1, 'the two rejected takes merge into one contiguous cut')
eq(ranges[0].start, 2.6, 'cut starts at the false start')
eq(ranges[0].end, 8.0, 'cut ends where the kept take begins')
eq(removedSeconds(ranges), 5.4, 'reports the seconds removed')
ok(removalRanges(takeChunks, groups, [4]).length === 2, 'a hand-dropped line adds its own range')
eq(removalRanges(takeChunks, [], []).length, 0, 'no groups and no drops removes nothing')

console.log('\n-- keeping an earlier take on request --')
const manual = [{ members: [1, 2, 3], keep: 2 }]
const r2 = removalRanges(takeChunks, manual)
eq(r2.length, 2, 'keeping the middle take splits the cut either side of it')
eq(r2[0].start, 2.6, 'first cut is the false start')
eq(r2[1].start, 8.2, 'second cut is the take after the keeper')

console.log('\n-- repeats hiding inside one Whisper line --')
// Whisper hands back a false start and its retake as a single segment, which is the common case
eq(findAdjacentRepeat('say hello to vidhelm say hello to vidhelm a free editor'.split(' ')), 4, 'finds the longest repeated opening')
eq(findAdjacentRepeat('the bed is heated the bed is heated which means'.split(' ')), 4, 'finds a repeat mid-line')
eq(findAdjacentRepeat('every word here is different from the last'.split(' ')), -1, 'no repeat, no split')
eq(findAdjacentRepeat('Say hello. Say hello, everyone.'.split(' ')), 2, 'punctuation and case do not hide a repeat')
eq(findAdjacentRepeat('a a b c'.split(' ')), -1, 'a single doubled word is a stutter, not a take')

const wordTimes = 'Say hello to VidHelm. Say hello to VidHelm, a free editor.'.split(' ')
  .map((text, i) => ({ start: i * 0.4, end: i * 0.4 + 0.35, text }))
const split = chunksFromWords(wordTimes)
eq(split.length, 2, 'the merged line splits into the aborted take and the real one')
eq(split[0].text, 'Say hello to VidHelm.', 'first chunk is the false start')
ok(split[1].text.startsWith('Say hello to VidHelm,'), 'second chunk is the full take')
ok(isRestart(split[0].text, split[1].text), 'the halves read as a restart pair, so grouping catches them')
eq(groupTakes(split, { minWords: 3 }).length, 1, 'grouped once split')

const twoSentences = [
  ...'First we level the bed.'.split(' ').map((text, i) => ({ start: i * 0.3, end: i * 0.3 + 0.25, text })),
  ...'Then we load filament.'.split(' ').map((text, i) => ({ start: 3 + i * 0.3, end: 3 + i * 0.3 + 0.25, text })),
]
eq(chunksFromWords(twoSentences).length, 2, 'sentence ends break lines')
const pauseSplit = [
  { start: 0, end: 0.3, text: 'okay' }, { start: 0.4, end: 0.7, text: 'ready' },
  { start: 5.0, end: 5.3, text: 'starting' }, { start: 5.4, end: 5.7, text: 'now' },
]
eq(chunksFromWords(pauseSplit).length, 2, 'a long pause breaks a line even without punctuation')

console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✗ FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
