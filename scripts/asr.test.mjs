// Standalone tests for caption accuracy: where Whisper's windows end (electron/asrwindows.ts), what
// it invented (electron/asrclean.ts), and which model runs and for how long (electron/asrmodel.ts).
// Run: npm run test:asr
// esbuild bundles each in memory (asrclean.ts imports asrwindows.ts), so there is no build step.
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async f => {
  const out = await build({ entryPoints: [path.join(here, '..', 'electron', f)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const { energyEnvelope, levelDb, nextWindow, resumeAt, settleSeam, transcribeWindows, mergeWordPieces, ENV_STEP } = await load('asrwindows.ts')
const { cleanTranscript } = await load('asrclean.ts')
const { resolveCaptionModel, migrateCaptionModel, modelLabel, etaSeconds, blendRate, DEFAULT_SEC_PER_MIN } = await load('asrmodel.ts')

let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), `${l} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
const near = (a, b, tol, l) => ok(Math.abs(a - b) <= tol, `${l} (got ${a}, want ${b} +-${tol})`)

// A synthetic envelope: speech at -20 dB (mean square 0.01) with a little wobble, and the given
// pauses at -60 dB. `level` overrides the pause depth.
const SPEECH = 0.01
function envelope(totalSec, pauses = [], { level = 1e-6, wobble = true } = {}) {
  const n = Math.round(totalSec / ENV_STEP)
  const env = new Float32Array(n)
  for (let i = 0; i < n; i++) env[i] = SPEECH * (wobble ? 0.6 + 0.4 * Math.abs(Math.sin(i * 0.37)) : 1)
  for (const [a, b, l] of pauses) for (let i = Math.round(a / ENV_STEP); i < Math.round(b / ENV_STEP) && i < n; i++) env[i] = l ?? level
  return env
}

console.log('\n-- the envelope --')
{
  const sr = 16000, pcm = new Float32Array(sr)   // 1 s: half a second of full-scale square wave, then silence
  for (let i = 0; i < sr / 2; i++) pcm[i] = i % 2 ? 1 : -1
  const env = energyEnvelope(pcm, sr)
  eq(env.length, 100, '10 ms frames: 100 for a second')
  near(levelDb(env, 0, 0.5), 0, 0.01, 'a full-scale square wave is 0 dB')
  ok(levelDb(env, 0.5, 1) < -100, 'silence is very quiet')
  near(levelDb(env, 0, 1), -3.01, 0.05, 'half and half is 3 dB down')
}

console.log('\n-- where a window ends --')
{
  const w = nextWindow(envelope(20), 0, 20)
  ok(w.start === 0 && w.end === 20 && w.quiet, 'audio under 30 s is one window')
  const env = envelope(70, [[10, 10.4], [26.0, 26.5], [52, 52.5]])
  const a = nextWindow(env, 0, 70)
  ok(a.quiet && a.cut > 26.0 && a.cut < 26.5, `ends inside the pause at 26 s (cut ${a.cut})`)
  eq(a.end, a.cut, 'a window cut in a pause has no overlap')
  ok(a.end - a.start <= 30, 'and is no longer than Whisper hears')
  const b = nextWindow(env, a.cut, 70)
  ok(b.quiet && b.cut > 52 && b.cut < 52.5, `the next one starts there and ends in the pause at 52 s (cut ${b.cut})`)
  const c = nextWindow(env, b.cut, 70)
  ok(c.end === 70 && c.quiet, 'the last one runs to the end')
  // the pause at 10 s is too early (it would make a 10 s window), so it is not used
  ok(!(a.cut < 24), 'a window is at least 24 s, so a long take is not chopped into slivers')
}
{
  const env = envelope(65, [], { wobble: true })
  const w = nextWindow(env, 0, 65)
  ok(!w.quiet, 'nonstop speech has no pause to cut in')
  near(w.end - w.cut, 1.0, 0.001, '...so the window runs a second past the cut')
  ok(w.end <= 30 && w.cut <= 29, 'and still fits in 30 s (the cut is found by 29 s)')
}
{
  // a dip only 3 dB under the speech: a breath in music, not a pause
  const shallow = envelope(65, [[26, 26.4, SPEECH * 0.5]], { wobble: false })
  ok(!nextWindow(shallow, 0, 65).quiet, 'a 3 dB dip is not a pause')
  const deep = envelope(65, [[26, 26.4, SPEECH * 0.2]], { wobble: false })
  ok(nextWindow(deep, 0, 65).quiet, 'a 7 dB dip is')
  const silent = envelope(65, [], { wobble: false }).map(() => 1e-7)
  ok(nextWindow(silent, 0, 65).quiet, 'digital silence is always a fine place to cut')
}
{
  // several equally quiet gaps: the latest wins, for fewer, longer windows
  const env = envelope(65, [[24.5, 24.9], [27.5, 27.9]])
  ok(nextWindow(env, 0, 65).cut > 27.5, 'equal pauses: the later one')
}
{
  // walk a 5 minute talk with a pause every 7 s: every window ends in a pause, none overlaps,
  // and together they cover the audio exactly once
  const pauses = []; for (let t = 7; t < 300; t += 7) pauses.push([t, t + 0.35])
  const env = envelope(300, pauses)
  let from = 0, covered = 0, n = 0, allQuiet = true
  while (from < 300 - 0.2 && n < 100) {
    const w = nextWindow(env, from, 300); n++
    allQuiet &&= w.quiet
    ok(w.start === from, `window ${n} starts where the last one stopped (${from})`)
    covered += w.end - w.start
    if (w.end >= 300) break
    from = w.cut
  }
  ok(allQuiet, 'every seam is in a pause')
  near(covered, 300, 0.001, 'the windows cover the audio exactly once')
  ok(n <= 13, `in ${n} windows (no more than 300/24)`)
}

console.log('\n-- the seam when there is no pause --')
eq(resumeAt([{ start: 27.4, end: 27.9 }, { start: 27.95, end: 28.6 }, { start: 28.7, end: 29.1 }], 28.2, 23.2), 27.95, 'the word across the cut is heard again from its start')
eq(resumeAt([{ start: 27.4, end: 27.9 }, { start: 28.3, end: 28.6 }], 28.2, 23.2), 28.2, 'nothing across the cut: resume at the cut')
eq(resumeAt([{ start: 10, end: 29 }], 28.2, 23.2), 29, 'a piece from before the floor is kept whole: the next window starts where it ends, not back at the floor')
eq(resumeAt([{ start: 28.15, end: 28.21 }], 28.2, 23.2), 28.2, 'a word ending right at the cut is not "across" it')
{
  const L = (start, end, text) => ({ start, end, text })
  const w = { start: 0, end: 28.6, cut: 27.6, quiet: false }
  // the review's case: Whisper's 7 s line [21, 28] across the cut at 27.6. It used to be kept
  // whole AND heard again from 22.45, two stacked captions saying the same sentence.
  const s = settleSeam([L(14, 20.9, 'a'), L(21, 28, 'b'), L(28.05, 28.6, 'c')], w, 60)
  eq(s.keep.map(x => x.text), ['a', 'b'], 'a 7 s line across the cut is kept whole here...')
  eq([s.next, s.runUp], [28, 0.15], '...and the next window takes over where it ends (from a run-up just before)')
  const t = settleSeam([L(27.85, 28.02, 'b-tail'), L(28.05, 33, 'c d e')], { start: 27.85, end: 56.4, cut: 55.4, quiet: false }, 60, s)
  eq(t.keep.map(x => x.text), ['c d e'], 'the tail of that line heard in the run-up is not kept twice')
  const r = settleSeam([L(14, 20.9, 'a'), L(23, 28.3, 'b')], w, 60)
  eq([r.keep.map(x => x.text), r.next], [['a'], 23], 'a line from inside the last 5 s is left for the next window, which hears it whole')
  const off = settleSeam([L(14, 20.9, 'a'), L(21, 28.6, 'b')], w, 60)
  eq([off.next, off.runUp], [28.6, 0], 'a long line that ran off the end of the window: the next starts at that end, with no run-up to hear its last word twice')
  const q = settleSeam([L(10, 20, 'a'), L(20.5, 26.1, 'b')], { start: 0, end: 26.2, cut: 26.2, quiet: true }, 60)
  eq([q.keep.length, q.next, q.runUp, q.last], [2, 26.2, 0, false], 'a cut in a pause keeps everything before it')
  const z = settleSeam([L(50, 59, 'a'), L(59, 60, 'b')], { start: 40, end: 60, cut: 60, quiet: true }, 60)
  eq([z.keep.length, z.next, z.last], [2, 60, true], 'the last window keeps everything')
}

console.log('\n-- whole runs through a pretend Whisper --')
{
  // Nonstop speech over a music bed: a word every 0.4 s and no pause anywhere, so every seam is an
  // overlap. The pretend Whisper hears a word when its middle is inside the window and, in phrase
  // mode, returns the sentences it falls in (`seg` seconds long, wherever the speaker breathes).
  const total = 120, env = envelope(total)
  const WORDS = []
  for (let k = 0; k * 0.4 + 0.36 <= total; k++) WORDS.push({ s: +(k * 0.4).toFixed(2), e: +(k * 0.4 + 0.36).toFixed(2), t: 'w' + k })
  const hearWith = (words, { word, seg = 7, off = 0, stretch = () => null }) => async w => {
    const heard = words.filter(x => (x.s + x.e) / 2 >= w.start && (x.s + x.e) / 2 < w.end)
    const groups = word ? heard.map(x => [x]) : [...heard.reduce((m, x) => {
      const k = Math.floor((x.s + off) / seg); m.set(k, [...(m.get(k) || []), x]); return m
    }, new Map()).values()]
    // as main.ts does it: timeline seconds, nothing past the audio this window was given
    const pieces = groups.map(g => {
      const [s, e] = stretch(g[0], w) || [g[0].s, g[g.length - 1].e]
      return { start: Math.min(Math.max(s, w.start), w.end), end: Math.min(e, w.end), raw: ' ' + g.map(x => x.t).join(' ') }
    })
    return word ? mergeWordPieces(pieces) : pieces.map(p => ({ start: p.start, end: p.end, text: p.raw.trim() }))
  }
  const audit = (out, words) => {
    const said = out.flatMap(r => r.text.split(' '))
    let stacked = 0
    for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end - 0.2) stacked++
    return { twice: said.length - new Set(said).size, missing: words.filter(x => !said.includes(x.t)).length, stacked }
  }
  const clean = { twice: 0, missing: 0, stacked: 0 }
  for (const seg of [4, 7, 9, 10, 12, 15]) for (const off of [0, 1.3, 2.9]) {
    eq(audit(await transcribeWindows(env, total, hearWith(WORDS, { word: false, seg, off })), WORDS), clean,
      `phrase mode, ${seg} s lines (offset ${off}): every word once, no stacked captions`)
  }
  eq(audit(await transcribeWindows(env, total, hearWith(WORDS, { word: true })), WORDS), clean, 'word mode: every word once')
  // music with no words in it (as loud as the speech, so still no pause to cut in)
  const without = (a, b) => WORDS.filter(x => x.s < a || x.s >= b)
  const gapA = without(21, 27.5), after = gapA.find(x => x.s >= 27.5)
  const early = (x, w) => x === after && w.start < 21 ? [21, x.e] : null        // the word after the music gets an early start
  eq(audit(await transcribeWindows(env, total, hearWith(gapA, { word: true, stretch: early })), gapA), clean, 'word mode: a word whose start Whisper stretched back over the music is not heard twice')
  const gapB = without(21, 28.6), before = gapB.filter(x => x.s < 21).pop()
  const late = (x, w) => x === before && w.start < 21 ? [x.s, 28.7] : null     // the word before the music gets a long end
  eq(audit(await transcribeWindows(env, total, hearWith(gapB, { word: true, stretch: late })), gapB), clean, 'word mode: nor is a word whose end Whisper stretched over the music')
  const ticks = []
  await transcribeWindows(env, total, hearWith(WORDS, { word: false }), d => ticks.push(d))
  ok(ticks.length >= 4 && ticks.every((d, i) => !i || d > ticks[i - 1]) && ticks[ticks.length - 1] === total, `progress only goes forward and ends at the end (${ticks.join(', ')})`)
}

console.log('\n-- word pieces back into words --')
const P = (start, end, raw) => ({ start, end, raw })
eq(mergeWordPieces([P(1, 1.3, ' five'), P(1.3, 1.6, '-star'), P(1.6, 1.9, ' ratings')]).map(w => w.text), ['five-star', 'ratings'], '"five" + "-star" is one word')
eq(mergeWordPieces([P(1, 1.3, ' five'), P(1.3, 1.6, '-star')])[0].end, 1.6, '...ending where its last piece ends')
eq(mergeWordPieces([P(2, 2.2, ' $9'), P(2.2, 2.5, '.99')]).map(w => w.text), ['$9.99'], '"$9" + ".99"')
eq(mergeWordPieces([P(2, 2.1, ' $'), P(2.1, 2.2, '9'), P(2.2, 2.5, '.99')]).map(w => w.text), ['$9.99'], 'a lone "$" waits for its number')
eq(mergeWordPieces([P(3, 3.2, ' Crux'), P(3.2, 3.9, '-Sci.')]).map(w => w.text), ['Crux-Sci.'], '"Crux" + "-Sci."')
eq(mergeWordPieces([P(4, 4.3, ' world'), P(4.3, 4.3, '.')]).map(w => w.text), ['world.'], 'a full stop stays on its word (sentence breaks need it)')
eq(mergeWordPieces([P(5, 5.2, " don"), P(5.2, 5.4, "'t")]).map(w => w.text), ["don't"], 'contractions')
eq(mergeWordPieces([P(1, 1.2, ' Hi'), P(1.2, 1.3, ' -'), P(1.3, 1.5, ' ...'), P(1.5, 1.8, ' there')]).map(w => w.text), ['Hi', 'there'], 'a lone dash or "..." is never a word')
eq(mergeWordPieces([P(0, 0.2, '.'), P(0.2, 0.5, ' Hello')]).map(w => w.text), ['Hello'], 'punctuation with nothing before it is dropped')
eq(mergeWordPieces([P(0, 1, ' ♪'), P(1, 1.5, ' Hello')]).map(w => w.text), ['Hello'], 'music notes are not words')
eq(mergeWordPieces([P(0, 0.3, '你好'), P(0.3, 0.6, '世界')], 'zh').map(w => w.text), ['你好', '世界'], 'Chinese pieces are not fused into one "word"')
eq(mergeWordPieces([P(0, 0.3, 'こんにちは'), P(0.3, 0.6, '世界'), P(0.6, 0.9, '。')], 'auto').map(w => w.text), ['こんにちは', '世界。'], 'Auto-detect: a window with no spaces is left as pieces (punctuation still attaches)')
eq(mergeWordPieces([P(2, 1.9, ' odd')])[0].end, 2, 'an end before the start is pulled up to it')
eq(mergeWordPieces([]), [], 'nothing in, nothing out')

console.log('\n-- what nobody said --')
const W = (start, end, text) => ({ start, end, text })
const sentence = [W(10, 10.3, 'This'), W(10.3, 10.5, 'is'), W(10.5, 10.8, 'real.')]
{
  const r = cleanTranscript([...sentence, W(171.96, 172.48, 'you')], { total: 149.5, word: true })
  eq(r.kept.map(w => w.text), ['This', 'is', 'real.'], '"you" 22 s after the end of the audio is dropped (tiny, measured)')
  const c = cleanTranscript([W(149, 151, 'end.')], { total: 149.5, word: true })
  eq(c.kept[0].end, 149.5, 'a word running past the end is clamped to it')
}
{
  const ghost = [W(148.82, 148.82, 'Thanks'), W(148.82, 148.82, 'for'), W(148.82, 148.82, 'watching!')]
  const r = cleanTranscript([...sentence, ...ghost], { total: 149.5, word: true })
  eq(r.kept.length, 3, '"Thanks for watching!" with every word at one instant is dropped (base, measured)')
  ok(r.dropped.some(d => /watching/.test(d.text)), '...and reported as dropped')
}
{
  const r = cleanTranscript([...sentence, W(142.54, 143.98, 'Music')], { total: 149.5, word: true })
  eq(r.kept.length, 3, 'the word "Music" alone is a sound tag (small, measured)')
  const p = cleanTranscript([W(0, 5, ' [Music]'), W(5, 9, ' Welcome back.'), W(60, 64, ' Subtitles by the Amara.org community')], { total: 70, word: false })
  eq(p.kept.map(x => x.text), [' Welcome back.'], 'phrase mode: [Music] and the Amara credit go, the real line stays')
  const k = cleanTranscript([W(1, 1.2, 'I'), W(1.2, 1.4, 'love'), W(1.4, 1.6, 'this'), W(1.6, 2, 'music.')], { total: 5, word: true })
  eq(k.kept.length, 4, '"music" inside a real sentence stays')
}
{
  const spoken = [W(20, 20.4, 'Great'), W(20.4, 20.8, 'video.'), W(21, 21.3, 'Thank'), W(21.3, 21.6, 'you.')]
  eq(cleanTranscript(spoken, { total: 30, word: true }).kept.length, 4, 'a "Thank you." somebody really said stays')
  const stretched = [W(20, 20.4, 'Great'), W(20.4, 20.8, 'video.'), W(24, 26, 'Thank'), W(26, 28.5, 'you.')]
  eq(cleanTranscript(stretched, { total: 30, word: true }).kept.length, 2, 'two words stretched over 4.5 s of outro are dropped')
  const okay = [W(5, 5.3, 'Okay.')]
  eq(cleanTranscript(okay, { total: 30, word: true }).kept.length, 1, 'a quick "Okay." stays')
}
{
  // loudness: speech at -20 dB, a "you" heard in -70 dB silence, a whisper 12 dB down
  const env = envelope(40, [[30, 40, 1e-9]], { wobble: false })
  for (let i = Math.round(15 / ENV_STEP); i < Math.round(16 / ENV_STEP); i++) env[i] = SPEECH / 16
  const words = [W(1, 1.3, 'Hello'), W(1.3, 1.6, 'and'), W(1.6, 2, 'welcome.'), W(5, 5.4, 'Today'), W(5.4, 5.8, 'we'), W(5.8, 6.2, 'build.'),
    W(15, 15.4, 'quietly'), W(15.4, 15.9, 'said.'), W(33, 33.5, 'you')]
  const r = cleanTranscript(words, { total: 40, word: true, env })
  ok(!r.kept.some(w => w.text === 'you'), '"you" 50 dB under the speech is dropped as heard in silence')
  ok(r.kept.some(w => w.text === 'quietly'), 'a line spoken 12 dB quieter stays')
  const strange = [...words.slice(0, 6), W(33, 33.5, 'Banana.')]
  ok(!cleanTranscript(strange, { total: 40, word: true, env }).kept.some(w => w.text === 'Banana.'), 'anything at all 30 dB under the speech goes, whatever it says')
  const quietThanks = envelope(40, [[30, 40, SPEECH / 200]], { wobble: false })   // 23 dB down: music bed level
  const t = cleanTranscript([...words.slice(0, 6), W(31, 31.4, 'Thank'), W(31.4, 31.8, 'you.')], { total: 40, word: true, env: quietThanks })
  ok(!t.kept.some(w => w.text === 'Thank'), 'a stock phrase 23 dB under the speech goes')
  const t2 = cleanTranscript([...words.slice(0, 6), W(16, 16.3, 'Thank'), W(16.3, 16.6, 'you.')], { total: 40, word: true, env })
  ok(t2.kept.some(w => w.text === 'Thank'), 'the same phrase at speaking level stays')
}
eq(cleanTranscript([], { total: 10, word: true }).kept, [], 'nothing in, nothing out')

console.log('\n-- which model, and how long --')
eq(resolveCaptionModel('auto', 'small'), 'small', 'Automatic is the tier\'s model')
eq(resolveCaptionModel('tiny', 'small'), 'tiny', 'a choice beats the tier')
eq(resolveCaptionModel(undefined, 'base'), 'base', 'nothing set: the tier')
eq(resolveCaptionModel('huge', 'base'), 'base', 'nonsense: the tier')
eq(migrateCaptionModel({ model: 'tiny' }), 'auto', 'a saved tiny nobody picked was the old default: Automatic')
eq(migrateCaptionModel({ model: 'tiny', modelPicked: true }), 'tiny', 'Fast picked in the menu stays Fast')
eq(migrateCaptionModel({ model: 'small' }), 'small', 'base and small were always choices')
eq(migrateCaptionModel({ model: 'auto' }), 'auto', 'Automatic stays')
eq(migrateCaptionModel(undefined), 'auto', 'a new install is Automatic')
eq(migrateCaptionModel({ model: 'large-v3' }), 'auto', 'an unknown model is Automatic')
eq(modelLabel('tiny'), 'Fast (about 3 min per 10 min of audio)', 'Fast label')
eq(modelLabel('base'), 'Balanced (about 5 min per 10 min of audio)', 'Balanced label')
eq(modelLabel('small'), 'Best (about 13 min per 10 min of audio)', 'Best label')
ok(!/—/.test(modelLabel('small')), 'no em dash in the labels')
eq(etaSeconds({ audioSec: 600, doneSec: 0, elapsedSec: 0, secPerMin: DEFAULT_SEC_PER_MIN.small }), 800, '10 min on small, before it starts: the stored 80 s/min')
near(etaSeconds({ audioSec: 600, doneSec: 300, elapsedSec: 200, secPerMin: 80 }), 200, 1, 'halfway, the pace measured on this run is what counts (200 s for the rest)')
near(etaSeconds({ audioSec: 600, doneSec: 30, elapsedSec: 10, secPerMin: 80 }), (570 / 60 * 80) * (1 - 30 / 180) + (570 / 3) * (30 / 180), 1, 'early on it leans on the stored rate')
eq(etaSeconds({ audioSec: 600, doneSec: 600, elapsedSec: 500, secPerMin: 80 }), 0, 'done is done')
eq(blendRate(undefined, 10, 5), undefined, 'a 10 s clip does not set the rate (loading the model dominates)')
eq(blendRate(undefined, 120, 40), 20, 'the first real run sets it: 40 s for 2 min is 20 s/min')
eq(blendRate(20, 120, 80), 28, 'later runs move it 40% of the way')

console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✗ FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
