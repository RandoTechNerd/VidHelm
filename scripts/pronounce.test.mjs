// Tests for the TTS pronunciation pass (electron/pronounce.ts). Run with: npm run test:pronounce
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'electron', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const P = await load('pronounce.ts')
let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }

console.log('table terms')
ok(P.spellOut('Prep for the ASCP exam.') === 'Prep for the A S C P exam.', 'ASCP is spelled out')
ok(P.spellOut('SAT, PSAT and ACT.') === 'S A T, P S A T and A C T.', 'SAT / PSAT / ACT, longest first, commas kept tight')
ok(P.spellOut('Welcome to CruxSci.') === 'Welcome to Crux Sigh.', 'mixed-case brand names get their spoken form')
ok(P.spellOut('SATURDAY is fine') === 'SATURDAY is fine', 'a term never fires inside a longer word')
ok(P.spellOut('Renders in 4K at 1080p.') === 'Renders in four K at ten eighty P.', 'resolutions read as people say them')
ok(P.spellOut('salt & pepper, 50%') === 'salt and pepper, 50 percent', 'symbols become words')

console.log('automatic acronyms')
ok(P.spellOut('Plug in the HDMI cable.') === 'Plug in the H D M I cable.', 'unknown CAPS tokens are spelled out')
ok(P.spellOut('NASA and the FISH probe') === 'NASA and the FISH probe', 'words said as words are left alone')
ok(P.spellOut('Plug in the HDMI cable.', P.DEFAULT_PRONOUNCE, { autoAcronyms: false }) === 'Plug in the HDMI cable.', 'the auto pass can be switched off')
ok(P.spellOut('I saw a cat') === 'I saw a cat', 'single capitals and ordinary words are untouched')

console.log('user tables')
{
  const t = P.mergeTables({ 'ASCP': 'ay ess see pee', 'Metafer': 'Meta fur' })
  ok(P.spellOut('ASCP Metafer', t) === 'ay ess see pee Meta fur', 'user entries override and extend the defaults')
  const flat = P.parseTable('{"Eazao": "Ee zow", "_note": "ignored"}')
  ok(flat.Eazao === 'Ee zow' && !('_note' in flat), 'flat JSON tables parse, comments dropped')
  const sect = P.parseTable('{"general": {"CruxSci": "Crux Sigh"}, "cytogenetics": {"ISCN": "I S C N", "_why": "x"}}')
  ok(sect.CruxSci === 'Crux Sigh' && sect.ISCN === 'I S C N' && !('_why' in sect), 'sectioned VoiceClone tables merge every section')
  ok(Object.keys(P.parseTable('not json')).length === 0, 'bad JSON yields an empty table, not a crash')
}

console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✗ FAILURES'} - ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
