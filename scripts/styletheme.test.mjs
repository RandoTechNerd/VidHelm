// Tests for the style themes (electron/styletheme.ts). Run with: npm run test:styletheme
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'electron', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const T = await load('styletheme.ts')
let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }
const pick = (q) => T.chooseTheme(q)

console.log('what people say lands on a theme')
for (const [q, id] of [
  ['I want a fun theme', 'fun'],
  ['clean minimalism please', 'clean'],
  ['make the captions futuristic tech style', 'tech'],
  ['cartoon', 'cartoon'],
  ['something like a comic book', 'cartoon'],
  ['hacker terminal vibes', 'terminal'],
  ['cinematic, like a movie', 'cinematic'],
  ['synthwave neon 80s', 'neon'],
  ['big punchy tiktok captions', 'hype'],
  ['a tutorial for my science class', 'explainer'],
  ['karaoke lyrics', 'karaoke'],
  ['my channel style', 'randotechnerd'],
  ['elegant wedding video', 'elegant'],
  ['handwritten notebook look', 'handmade'],
  ['news broadcast', 'news'],
  ['tech', 'tech'],
]) {
  const c = pick(q)
  ok(c.theme.id === id, `"${q}" -> ${id} (got ${c.theme.id})`)
}
ok(pick('').fallback && pick('').theme.id === 'creator', 'nothing said -> the creator default, flagged as fallback')
ok(pick('add subtitles').theme.id === 'creator', '"add subtitles" is not a style request')

console.log('tweaks ride on top of the theme')
{
  const c = pick('futuristic tech but green')
  ok(c.theme.id === 'tech' && c.caption.color === '#39d353', 'tech theme, green text')
  ok(c.caption.font === 'tech', 'keeps the tech font')
  const b = pick('fun theme with a blue highlight, at the top')
  ok(b.caption.accent === '#3b82ff' && b.caption.position === 'top', 'blue highlight + top position')
  const big = pick('clean minimal but bigger')
  ok(big.caption.size === 'm', 'bigger steps clean (s) up one size')
  const caps = pick('cinematic all caps')
  ok(caps.caption.uppercase === true, 'all caps')
  const nb = pick('news but no box')
  ok(nb.caption.box === false, 'no box')
  const gold = pick('elegant gold')
  ok(gold.caption.color === '#ffffff' && gold.caption.accent === '#e8c36a', 'a colour that named the theme is not a tweak')
  const x = T.chooseTheme('cartoon', { color: '#ff0000' })
  ok(x.caption.color === '#ff0000' && x.caption.font === 'comic', 'explicit overrides win')
}

console.log('every theme is complete and safe')
for (const t of T.THEMES) {
  const s = T.resolveCaption(t.caption)
  ok(JSON.stringify(s) === JSON.stringify(T.resolveCaption(s)), `${t.id}: caption spec is already clean`)
  ok(existsSync(path.join(here, '..', 'public', 'fonts', T.THEME_FONTS[t.caption.font].file)), `${t.id}: caption font file is bundled`)
  ok(T.THEME_FONTS[t.thumb.font] && T.THEME_FONTS[t.title.font], `${t.id}: title + thumb fonts exist`)
}
ok(new Set(T.THEME_IDS).size === T.THEMES.length, 'theme ids are unique')
ok(T.resolveCaption({ font: 'nope', motion: 'zzz', color: 'red', outline: 9 }).font === 'heavy', 'junk values fall back')

console.log('grouping')
{
  const words = 'This is a really long sentence, with commas. And more'.split(' ').map((t, i) => ({ s: i, e: i + 0.9, t }))
  const g = T.groupWords(words)
  ok(g.every(x => x.length <= 3), 'groups are at most 3 words')
  ok(g.some(x => x[x.length - 1].t === 'sentence,'), 'breaks after punctuation')
  const parts = T.chunkCue({ start: 0, end: 10, text: words.map(w => w.t).join(' '), words }, { chunk: 'group', size: 'l', font: 'impact' })
  ok(parts[0].s === 0 && parts[parts.length - 1].e === 10, 'chunks cover the whole cue')
  ok(parts.every((p, i) => i === 0 || p.s === parts[i - 1].e), 'chunks butt up with no gaps')
}

console.log('phrases from Whisper words')
{
  const ws = 'Hey everyone. Today we are fixing a broken printer that I found on the curb'.split(' ').map((t, i) => ({ s: i * 0.3 + (i > 6 ? 1 : 0), e: i * 0.3 + 0.25 + (i > 6 ? 1 : 0), t }))
  const ph = T.phrasesFromWords(ws)
  ok(ph[0].text === 'Hey everyone.', 'sentence end starts a new line')
  ok(ph.every(p => p.words.length <= 7 && p.text.length <= 45), 'lines stay short')
  ok(ph.some(p => p.words[0].t === 'broken' || p.words[0].t === 'a'), 'the pause after "fixing a" breaks the line')
  ok(ph.every((p, i) => i === 0 || p.start >= ph[i - 1].end), 'lines never overlap')
  ok(ph.map(p => p.text).join(' ') === ws.map(w => w.t).join(' '), 'no word lost or duplicated')
}

console.log('ASS output')
{
  const cue = { start: 1, end: 3, text: 'hello big world', words: [{ s: 1, e: 1.5, t: 'hello' }, { s: 1.6, e: 2.2, t: 'big' }, { s: 2.3, e: 2.9, t: 'world' }] }
  for (const t of T.THEMES) {
    const ass = T.buildAss([cue], t.caption, 1920, 1080)
    const d = ass.split('\n').filter(l => l.startsWith('Dialogue:'))
    ok(d.length >= 1 && ass.includes(T.THEME_FONTS[t.caption.font].family), `${t.id}: renders (${d.length} events, ${t.caption.motion})`)
  }
  const kar = T.buildAss([cue], T.themeById('karaoke').caption, 1920, 1080)
  ok(/\\kf\d+/.test(kar), 'karaoke uses \\kf fills')
  const pop = T.buildAss([cue], T.themeById('hype').caption, 1080, 1920)
  ok(pop.includes('HELLO') && pop.includes('\\fscx78'), 'hype is uppercase and pops in')
  const tw = T.buildAss([cue], T.themeById('terminal').caption, 1920, 1080)
  ok(tw.includes('\\alpha&HFF&'), 'typewriter hides the words not yet typed')
  ok(T.assColor('#ff8000', 1) === '&H000080FF' && T.assColor('#000000', 0.5) === '&H80000000', 'ASS colours are AABBGGRR')
  const esc = T.buildAss([{ start: 0, end: 1, text: 'a {b} c' }], T.themeById('clean').caption, 1920, 1080)
  ok(!esc.includes('{b}'), 'braces in speech cannot inject tags')
}

console.log('preview frames match the motion')
{
  const cue = { start: 0, end: 2, text: 'one two three', words: [{ s: 0, e: 0.5, t: 'one' }, { s: 0.6, e: 1.1, t: 'two' }, { s: 1.2, e: 1.9, t: 'three' }] }
  const hl = T.captionFrame(cue, T.resolveCaption({ motion: 'highlight', accent: '#ff0000' }), 0.7)
  ok(hl.pieces[1].color === '#ff0000' && hl.pieces[0].color !== '#ff0000', 'highlight lights the spoken word')
  const tw = T.captionFrame(cue, T.resolveCaption({ motion: 'typewriter' }), 0.7)
  ok(!tw.pieces[1].hidden && tw.pieces[2].hidden, 'typewriter shows only typed words')
  const pop = T.captionFrame(cue, T.resolveCaption({ motion: 'pop', chunk: 'word' }), 0.62)
  ok(pop.pieces.length === 1 && pop.scale < 1, 'pop, one word, scaling in')
  ok(T.captionFrame(cue, T.resolveCaption({}), 2.5) === null, 'nothing after the cue ends')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
