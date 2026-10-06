// Tests for the undo history's view of each file's Sound role and Fix voice (src/soundChoices.ts):
// a role clicked by mistake re-levels and ducks the whole file in the export, so Ctrl+Z must take it
// back, while the bin's constant measuring and baking must never make an undo step of its own.
// Run: npm run test:soundchoices
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const S = await load('src/soundChoices.ts')

let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }

const bake = { want: 'studio|cam.mp4', path: 'cam.flac', previewPath: 'cam.mp4' }
const cam = { id: 'cam', name: 'cam.mp4', audio: { facts: { I: -30 }, bake } }
const song = { id: 'song', name: 'song.mp3', audio: { role: 'music', facts: { I: -12 } } }
const vo = { id: 'vo', name: 'vo.wav' }

console.log('\n-- what the history keeps --')
{
  const before = S.soundChoicesOf([cam, song, vo])
  ok(before === JSON.stringify([['song', 'music', null]]), `only the choices, by file (${before})`)
  // the bin changes all the time without a choice changing: a bake percent, a measurement landing
  const busy = [{ ...cam, audio: { ...cam.audio, baking: { want: 'studio|', pct: 42, line: 'Levelling' } } }, { ...song, audio: { ...song.audio, measured: { I: -12 } } }, vo]
  ok(S.soundChoicesOf(busy) === before, 'a bake or a measurement is not an undo step')
  ok(S.soundChoicesOf([cam, song, vo, { id: 'new', name: 'new.wav' }]) === before, 'nor is importing a file with no choice')
  ok(S.soundChoicesOf([{ ...cam, audio: { ...cam.audio, role: 'music' } }, song, vo]) !== before, 'a role clicked is one')
  ok(S.soundChoicesOf([cam, song, { ...vo, audio: { fix: 'off' } }]) !== before, 'and so is Fix voice turned off')
}

console.log('\n-- Ctrl+Z puts them back --')
{
  const snap = S.soundChoicesOf([cam, song, vo])
  // the mistake: the camera clip guessed as a voice is set to Music, the voice-over's Fix voice to Off
  const now = [{ ...cam, audio: { ...cam.audio, role: 'music' } }, song, { ...vo, audio: { fix: 'off' } }]
  const back = S.restoreSoundChoices(now, snap)
  ok(back[0].audio.role === undefined && back[0].audio.fix === undefined, 'a file the snapshot does not name goes back to the guess and Studio')
  ok(back[0].audio.bake === bake && back[0].audio.facts.I === -30, 'its measurement and its bake stay (they are of the file, not the choice)')
  ok(back[1] === now[1] && back[1].audio.role === 'music', 'a file whose choice did not change is the same object')
  ok(back[2].audio.fix === undefined && S.soundChoicesOf(back) === snap, 'the bin reads as the snapshot again')
  // redo
  const fwd = S.restoreSoundChoices(back, S.soundChoicesOf(now))
  ok(fwd[0].audio.role === 'music' && fwd[2].audio.fix === 'off', 'redo puts the choices back on')
  ok(S.restoreSoundChoices(fwd, S.soundChoicesOf(fwd)) === fwd, 'nothing to change returns the same array (no re-render)')
  // a file removed since the snapshot is simply not there; one added since has no choice to restore
  const later = [{ ...song, audio: { role: 'sfx' } }, { id: 'added', name: 'added.wav', audio: { role: 'voice' } }]
  const r = S.restoreSoundChoices(later, snap)
  ok(r.length === 2 && r[0].audio.role === 'music' && r[1].audio.role === undefined, 'files come and go: each is put back by its id')
}

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
