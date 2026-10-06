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

console.log('caption edits keep word timing (retimeWords)')
{
  const old = [{ s: 0.0, e: 0.3, t: 'Meet' }, { s: 0.35, e: 0.7, t: 'Crux' }, { s: 0.7, e: 1.1, t: 'Study' }, { s: 1.2, e: 1.6, t: 'SAT,' }, { s: 1.7, e: 2.2, t: 'PSAT,' }, { s: 2.25, e: 2.4, t: 'and' }, { s: 2.45, e: 2.9, t: 'ACT' }, { s: 2.95, e: 3.3, t: 'prep,' }]
  const at = (ws, t) => ws.find(w => w.t === t)
  const same = (w, s, e) => !!w && Math.abs(w.s - s) < 1e-6 && Math.abs(w.e - e) < 1e-6
  const merged = T.retimeWords(old, 'Meet CruxStudy: SAT, PSAT and ACT prep,', 0, 3.4)
  ok(merged.length === 7 && same(at(merged, 'CruxStudy:'), 0.35, 1.1), 'a merge spans both old words')
  ok(same(at(merged, 'Meet'), 0, 0.3) && same(at(merged, 'ACT'), 2.45, 2.9) && same(at(merged, 'prep,'), 2.95, 3.3), 'every other word keeps its slot')
  const inserted = T.retimeWords(old, 'Meet CruxStudy SAT, PSAT, and ACT test prep,', 0, 3.4)
  const test = at(inserted, 'test'), act = at(inserted, 'ACT')
  ok(test && test.s >= act.e - 1e-9 && test.e <= 2.95 + 1e-9 && test.e > test.s, 'an inserted word takes room beside its neighbours')
  ok(same(at(inserted, 'prep,'), 2.95, 3.3), 'the word after an insertion does not move')
  const dropped = T.retimeWords(old, 'Meet Crux Study SAT PSAT ACT prep', 0, 3.4)
  ok(dropped.length === 7 && same(at(dropped, 'ACT'), 2.45, 2.9) && same(at(dropped, 'Study'), 0.7, 1.1), 'deleting a word leaves the others where they were spoken')
  const split = T.retimeWords([{ s: 1, e: 2, t: 'VidHelm' }], 'Vid Helm', 0, 3)
  ok(split.length === 2 && split[0].s === 1 && Math.abs(split[0].e - (1 + 3 / 7)) < 1e-3 && split[1].e === 2, 'a split divides the slot by letters')
  const unchanged = T.retimeWords(old, old.map(w => w.t).join(' '), 0, 3.4)
  ok(unchanged.every((w, i) => same(w, old[i].s, old[i].e)), 'an unchanged line keeps every time exactly')
  const um = [{ s: 0, e: 0.3, t: 'So' }, { s: 0.4, e: 0.6, t: 'um' }, { s: 0.7, e: 1.2, t: 'today' }]
  const noUm = T.retimeWords(um, 'So today', 0, 1.5)
  ok(same(noUm[0], 0, 0.3) && same(noUm[1], 0.7, 1.2), 'removing an "um" keeps the words around it on the voice')
  const rewrite = T.retimeWords(old, 'Something else entirely different was said here instead', 0, 3.4)
  ok(rewrite.length === 8 && rewrite[0].s === 0 && Math.abs(rewrite[7].e - 3.3) < 1e-6, 'a whole rewrite is spread over the spoken stretch')
  ok(rewrite.every((w, i) => w.e >= w.s && (i === 0 || w.s >= rewrite[i - 1].s)), 'and it runs forwards, never overlapping backwards')
  ok(T.retimeWords(old, '   ', 0, 3.4).length === 0, 'no words, no timings')
  const none = T.retimeWords([], 'two words', 0, 2)
  ok(none.length === 2 && none[0].s === 0 && none[1].e === 2, 'no old timings: spread over the caption')
  const head = T.retimeWords([{ s: 0, e: 0.5, t: 'world' }], 'hello world', 0, 1)
  ok(head[0].s === 0 && head[0].e > 0 && head[0].e <= head[1].s + 1e-9 && head[1].e === 0.5, 'a word inserted at the start takes half of the first word')
  const kept = T.retimeWords(old, 'Meet CruxStudy: SAT, PSAT and ACT prep,', 0, 3.4)
  const cue = { start: 0, end: 3.4, text: 'Meet CruxStudy: SAT, PSAT and ACT prep,', words: kept }
  ok(T.cueWords(cue).every((w, i) => w.s === kept[i].s), 'cueWords uses the kept timings (the word count matches the text)')
}

console.log('a caption typed letter by letter lands where a pasted one does (typeCaption)')
{
  const old = [{ s: 0.0, e: 0.3, t: 'Meet' }, { s: 0.35, e: 0.7, t: 'Crux' }, { s: 0.7, e: 1.1, t: 'Study' }, { s: 1.2, e: 1.6, t: 'SAT,' }, { s: 1.7, e: 2.2, t: 'PSAT,' }, { s: 2.25, e: 2.4, t: 'and' }, { s: 2.45, e: 2.9, t: 'ACT' }, { s: 2.95, e: 3.3, t: 'prep,' }]
  const line = old.map(w => w.t).join(' ')
  const sameWords = (a, b) => a.length === b.length && a.every((w, i) => w.t === b[i].t && Math.abs(w.s - b[i].s) < 1e-9 && Math.abs(w.e - b[i].e) < 1e-9)
  // the Inspector's Content box: the caption as the document holds it, and the session in a ref
  const box = () => {
    let session = null
    return {
      cap: { id: 'c1', text: line, duration: 3.4, words: old },
      key(text) { const r = T.typeCaption(session, this.cap, text); session = r.session; this.cap = { ...this.cap, text, words: r.words }; return this.cap.words },
      type(target) { for (let i = 1; i <= target.length; i++) this.key(target.slice(0, i)); return this.cap.words },
    }
  }
  const target = 'The quick brown fox jumps over it'
  const pasted = T.retimeWords(old, target, 0, 3.4)
  const typed = box().type(target)
  ok(sameWords(typed, pasted), 'typing a rewrite letter by letter gives exactly the pasted result')
  ok(typed[0].s === 0 && Math.abs(typed[typed.length - 1].e - 3.3) < 1e-6, 'and it is spread over the spoken stretch')
  ok(typed.every(w => w.e - w.s > 0.2), `no word squeezed into a sliver (shortest ${Math.min(...typed.map(w => w.e - w.s)).toFixed(3)} s)`)
  const cleared = box()
  ok(cleared.key('').length === 0, 'an empty box has no word times')
  ok(sameWords(cleared.type(target), pasted), 'and clearing it first, then typing, lands the same way')
  const typo = box()
  typo.key(line + 'x')
  ok(sameWords(typo.key(line), old), 'a letter typed and deleted again leaves every spoken time exactly as it was')
  // a fix made in place: delete the space in "Crux Study", then type a colon after it
  const fix = box()
  fix.key('Meet CruxStudy SAT, PSAT, and ACT prep,')
  const inPlace = fix.key('Meet CruxStudy: SAT, PSAT, and ACT prep,')
  const cs = inPlace.find(w => w.t === 'CruxStudy:'), act = inPlace.find(w => w.t === 'ACT')
  ok(Math.abs(cs.s - 0.35) < 1e-9 && Math.abs(cs.e - 1.1) < 1e-9 && Math.abs(act.s - 2.45) < 1e-9, 'a small fix typed in place keeps the words on the voice')
  // someone else changes the caption mid-session (an undo, an agent edit): the box starts from that
  const other = box()
  other.type('Meet the team')
  other.cap = { ...other.cap, text: 'Hello there', words: [{ s: 1, e: 1.5, t: 'Hello' }, { s: 1.6, e: 2.4, t: 'there' }] }
  const after = other.key('Hello there!')
  ok(Math.abs(after[0].s - 1) < 1e-9 && Math.abs(after[1].e - 2.4) < 1e-9, 'a change made elsewhere starts a fresh base instead of being reverted')
  const r = T.typeCaption({ id: 'someone-else', base: { text: 'x', duration: 1 }, wrote: old }, { id: 'c1', text: line, duration: 3.4, words: old }, line + ' now')
  ok(r.session.id === 'c1' && r.session.base.text === line, 'a session for another caption is never applied to this one')
  ok(T.typeCaption(null, { id: 'c1', text: line, duration: 3.4, words: old }, line).words === old, 'no change, the very same words')
  ok(T.retimeCaptionText({ text: line, words: old, duration: 3.4 }, 'Meet Crux', 2).every(w => w.e <= 2), 'a shorter caption keeps every word inside it')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
