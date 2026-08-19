// Standalone tests for precise speech boundaries (electron/speech.ts).
// Run with: npm run test:speech
// esbuild bundles the TS in memory (speech.ts imports takes.ts) so there is no build step.

import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = await build({
  entryPoints: [path.join(here, '..', 'electron', 'speech.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18',
})
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
const { findPhrase, trimTrailingDangle, sentenceSpans, cutAfter, cutBefore, spanForPhrase, refineFromEnvelope } = mod

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  PASS ', label) } else { fail++; console.log('  FAIL ', label) } }
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
const near = (a, b, tol, label) => ok(Math.abs(a - b) <= tol, `${label} (got ${a}, want ~${b})`)

/** Build words from "text" with an even cadence, or from [text, start, end] triples. */
const say = (text, t0 = 0, per = 0.3) =>
  text.split(' ').map((w, i) => ({ text: w, start: +(t0 + i * per).toFixed(3), end: +(t0 + i * per + per * 0.8).toFixed(3) }))

console.log('\n-- finding a phrase --')
{
  const w = say('welcome back everyone check out this portable espresso maker and this thing is tiny')
  const hit = findPhrase(w, 'check out this portable espresso maker')
  ok(hit !== null, 'the phrase is found')
  eq(hit && hit.text, 'check out this portable espresso maker', 'exact words come back')
  eq(hit && hit.startIdx, 3, 'starts at the right word')
}
{
  const w = say('so i grabbed this portable expresso grinder off their site')
  const hit = findPhrase(w, 'this portable espresso grinder')
  ok(hit !== null, 'a transcription slip (expresso) still matches')
}
{
  const w = say('the print bed heats up in about ninety seconds')
  eq(findPhrase(w, 'completely unrelated sentence about coffee'), null, 'no match returns null')
}
{
  const w = say('one two three four five six seven eight nine ten')
  const hit = findPhrase(w, 'six seven eight', { after: 1.0 })
  ok(hit && hit.startIdx === 5, 'the after window is respected')
}
{
  // the same line said twice: searching after the first should land on the second
  const w = say('here we go here we go again')
  const first = findPhrase(w, 'here we go')
  const second = findPhrase(w, 'here we go', { after: first.end })
  ok(second && second.startIdx > first.startIdx, 'searching after a hit finds the later one')
}

console.log('\n-- trimming what dangles off the end --')
{
  // the exact complaint: asked for "...espresso maker", got "...espresso maker and this"
  const w = say('check out this portable espresso maker and this')
  const end = trimTrailingDangle(w, 0, w.length - 1)
  eq(w.slice(0, end + 1).map(x => x.text).join(' '), 'check out this portable espresso maker',
    'an abandoned "and this" is dropped')
}
{
  const w = say('so that is a nice fine grind we got going and')
  const end = trimTrailingDangle(w, 0, w.length - 1)
  eq(w[end].text, 'going', 'a trailing conjunction on its own is dropped')
}
{
  const w = say('it grinds fast um')
  eq(w[trimTrailingDangle(w, 0, w.length - 1)].text, 'fast', 'a trailing filler is dropped')
}
{
  const w = say('i really like that')
  eq(w[trimTrailingDangle(w, 0, w.length - 1)].text, 'that', 'a real sentence ending in "that" survives')
}
{
  const w = say('yes it is')
  eq(w[trimTrailingDangle(w, 0, w.length - 1)].text, 'is', 'a short complete sentence is left alone')
}
{
  const w = [...say('this is the finished sentence')]
  w[w.length - 1].text = 'sentence.'
  eq(trimTrailingDangle(w, 0, w.length - 1), w.length - 1, 'punctuation means nothing is trimmed')
}
{
  const w = say('and this')
  const end = trimTrailingDangle(w, 0, 1)
  ok(end >= 0, 'a line that is nothing but danglers is not deleted')
}
{
  const w = say('we ran it on the')
  eq(w[trimTrailingDangle(w, 0, w.length - 1)].text, 'it', 'a dangling article is dropped')
}
{
  // trimming must not eat more than half the span
  const w = say('and so but or then plus also which')
  ok(trimTrailingDangle(w, 0, w.length - 1) >= 3, 'trimming stops at the halfway point')
}

console.log('\n-- sentences --')
{
  const w = [
    { text: 'this', start: 0, end: 0.2 }, { text: 'is', start: 0.2, end: 0.4 }, { text: 'one.', start: 0.4, end: 0.7 },
    { text: 'and', start: 0.8, end: 1.0 }, { text: 'this', start: 1.0, end: 1.2 }, { text: 'is', start: 1.2, end: 1.4 }, { text: 'two.', start: 1.4, end: 1.7 },
  ]
  eq(sentenceSpans(w).length, 2, 'punctuation splits sentences')
}
{
  const w = [
    { text: 'first', start: 0, end: 0.3 }, { text: 'thought', start: 0.3, end: 0.7 },
    { text: 'second', start: 2.0, end: 2.3 }, { text: 'thought', start: 2.3, end: 2.7 },
  ]
  const s = sentenceSpans(w)
  eq(s.length, 2, 'a long pause splits sentences even with no punctuation')
  near(s[0].end, 0.7, 0.001, 'the first sentence ends on its last word')
}
{
  const w = say('one two three four five six')
  eq(sentenceSpans(w, { maxWords: 3 }).length, 2, 'a runaway line is broken at maxWords')
}

console.log('\n-- turning a word into a timestamp --')
{
  const w = [{ text: 'maker', start: 1.0, end: 1.5 }, { text: 'and', start: 2.2, end: 2.4 }]
  near(cutAfter(w, 0), 1.62, 0.001, 'a wide gap keeps the default tail')
  ok(cutAfter(w, 0) < w[1].start, 'the cut never reaches the next word')
}
{
  const w = [{ text: 'maker', start: 1.0, end: 1.5 }, { text: 'and', start: 1.56, end: 1.8 }]
  const t = cutAfter(w, 0)
  ok(t > 1.5 && t < 1.56, 'a tight gap lands between the words instead of clipping either')
}
{
  const w = [{ text: 'last', start: 1.0, end: 1.5 }]
  near(cutAfter(w, 0), 1.62, 0.001, 'the final word still gets its release')
}
{
  const w = [{ text: 'a', start: 0.0, end: 0.2 }, { text: 'check', start: 1.0, end: 1.4 }]
  const t = cutBefore(w, 1)
  ok(t >= 0.25 && t <= 0.95, 'a cut before a word leaves run-up without touching the previous one')
}
{
  const w = [{ text: 'check', start: 0.05, end: 0.4 }]
  ok(cutBefore(w, 0) >= 0, 'a cut before the first word cannot go negative')
}

console.log('\n-- the whole job in one call --')
{
  const w = say('welcome back check out this portable espresso maker and this thing is tiny')
  const s = spanForPhrase(w, 'check out this portable espresso maker')
  eq(s.trimmed, 'check out this portable espresso maker', 'the dangle is gone')
  ok(s.cutOut < w.find(x => x.text === 'and').start, 'the out point lands before the abandoned clause')
  ok(s.cutIn <= w[2].start, 'the in point leaves run-up')
}

console.log('\n-- refining against the waveform --')
{
  // 20ms frames: speech until 1.00s, then silence
  const step = 0.02
  const rms = Array.from({ length: 150 }, (_, i) => (i * step < 1.0 ? 0.2 : 0.0005))
  const env = { rms, step, t0: 0 }
  near(refineFromEnvelope(env, 1.12, 'after'), 1.0, 0.03, 'an estimate inside silence snaps back to where speech stopped')
  near(refineFromEnvelope(env, 0.92, 'after'), 1.0, 0.03, 'an estimate inside speech snaps forward to the silence')
}
{
  const step = 0.02
  const rms = Array.from({ length: 150 }, (_, i) => (i * step < 1.0 ? 0.0005 : 0.2))
  const env = { rms, step, t0: 0 }
  near(refineFromEnvelope(env, 1.1, 'before'), 1.0, 0.04, 'a before-cut snaps to where speech starts')
}
{
  const step = 0.02
  const rms = new Array(100).fill(0.2)      // wall to wall speech: nothing to snap to
  eq(refineFromEnvelope({ rms, step, t0: 0 }, 1.0, 'after'), 1.0, 'no edge in the window leaves the estimate alone')
}
{
  const step = 0.02
  const rms = Array.from({ length: 200 }, (_, i) => (i * step < 1.0 ? 0.2 : 0.0005))
  const env = { rms, step, t0: 0 }
  eq(refineFromEnvelope(env, 3.0, 'after'), 3.0, 'an estimate far past the edge is not dragged back')
}

console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✗ FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
