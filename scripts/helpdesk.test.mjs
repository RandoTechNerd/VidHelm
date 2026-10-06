// Tests for the in-app help knowledge base (electron/helpdesk.ts). Run with: npm run test:helpdesk
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'electron', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const H = await load('helpdesk.ts')
let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }

// the offline answerer picks the right topic for plain questions people actually type
const expect = {
  'How do I make a vertical Short?': 'format',
  'how do I remove the pauses': 'pauses',
  'add subtitles to my video': 'captions',
  'what does connect ai do': 'connect',
  'where do I export the mp4': 'export',
  'how can I add a whoosh sound effect': 'sfx',
  'record my voiceover': 'voiceover',
  'my 4k video is choppy': 'slow',
  'keyboard shortcuts?': 'shortcuts',
  'put my logo in the corner': 'brand',
  'my voice is too quiet and there is background noise': 'fixvoice',
  'what loudness target should a podcast use': 'loudness',
  'how loud will the export be in lufs': 'loudness',
}
for (const [q, id] of Object.entries(expect)) ok(H.localAnswer(q)?.id === id, `"${q}" -> ${id} (got ${H.localAnswer(q)?.id})`)
ok(H.localAnswer('what is the capital of France') === null, 'off-topic question gets no answer rather than a wrong one')

// action tags become buttons, unknown ones are dropped, the text is cleaned
const p = H.parseActions('Use the Booth. [[open:booth]]\n[[open:nope]] [[open:booth]] [[open:export]]')
ok(p.text === 'Use the Booth.', 'tags stripped from text')
ok(JSON.stringify(p.actions) === '["booth","export"]', 'valid actions kept once, in order')

// every entry's action is a real one, and the prompt offers every action
for (const e of H.HELP_ENTRIES) if (e.action) ok(e.action in H.ACTION_LABELS, `entry ${e.id} has a known action`)
const sys = H.helpSystemPrompt({ version: '1.9.1', clips: 3, format: 'Portrait' })
ok(Object.keys(H.ACTION_LABELS).every(a => sys.includes(a)), 'system prompt lists every action')
ok(sys.includes('1.9.1') && sys.includes('Portrait'), 'system prompt carries the app context')
ok(!sys.includes('—'), 'no em dashes in what the model is shown')

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} - ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
