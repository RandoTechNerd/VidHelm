// Tests for the karaoke booth's record modes (src/boothmode.ts). Run with: npm run test:booth
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'src', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const B = await load('boothmode.ts')
let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }

console.log('synced (the default, unchanged)')
{
  const p = B.planTake(false, 12.4)
  ok(p.seek === 0 && p.play === true, 'Record rewinds to 0:00 and plays the video')
  ok(p.startAt === 0, 'the take lands at 0:00, in sync with the picture')
  ok(p.stopsAtEnd === true, 'the take stops itself at the end of the timeline')
  ok(B.shouldAutoStop(false, 59.97, 60) && !B.shouldAutoStop(false, 30, 60), 'auto-stop fires only at the end')
  ok(B.recordBlocker(false, 0) !== null && B.recordBlocker(false, 5) === null, 'synced needs something on the timeline')
  ok(B.stepHolds(false, false) === false && B.stepHolds(false, true) === true, 'Back/Next seek when idle, hold while recording')
}

console.log('free record (detached from the video)')
{
  const p = B.planTake(true, 12.4)
  ok(p.seek === null, 'the playhead is left where it is')
  ok(p.play === false, 'the video does not play')
  ok(p.startAt === 12.4, 'the take lands at the playhead')
  ok(p.stopsAtEnd === false, 'only Stop ends the take')
  ok(/12\.4/.test(p.status) && /0:12\.4/.test(p.status), 'the status says where the take will land')
  ok(!B.shouldAutoStop(true, 60, 60) && !B.shouldAutoStop(true, 99, 60), 'reaching the end never stops a free take')
  ok(B.recordBlocker(true, 0) === null, 'an empty timeline is fine: the take is the first thing on it')
  ok(B.planTake(true, -3).startAt === 0 && B.planTake(true, NaN).startAt === 0, 'a bad playhead lands at 0:00, not off the timeline')
  ok(B.planTake(true, 75).startAt === 75, 'a playhead past the end is honoured (the take extends the timeline)')
  ok(B.stepHolds(true, false) === true, 'Back/Next only move the prompter, never the video')
}

console.log('the bridge argument')
{
  ok(B.parseFreeRecord(true) === true && B.parseFreeRecord(false) === false, 'booleans')
  ok(B.parseFreeRecord('on') === true && B.parseFreeRecord('OFF') === false, 'on/off, any case')
  ok(B.parseFreeRecord('free') === true && B.parseFreeRecord('synced') === false, 'free/synced')
  ok(B.parseFreeRecord(1) === true && B.parseFreeRecord(0) === false, '0/1')
  ok(B.parseFreeRecord(undefined) === undefined && B.parseFreeRecord('') === undefined, 'not given stays not given')
  ok(B.parseFreeRecord('maybe') === undefined, 'nonsense is not a mode')
}

console.log('wiring')
{
  // The toggle has to be remembered: the setting exists in the renderer's defaults, and main
  // spreads the raw settings file first, so it survives a restart without a line there.
  const app = fs.readFileSync(path.join(here, '..', 'src', 'App.tsx'), 'utf8')
  ok(/booth:\s*\{\s*freeRecord:\s*false\s*\}/.test(app), 'App.tsx defaults booth.freeRecord to off')
  ok(/booth:\s*\{\s*\.\.\.DEFAULT_SETTINGS\.booth,\s*\.\.\.s\.booth\s*\}/.test(app), 'App.tsx merges a saved booth setting over the default')
  ok(/case 'booth_mode'/.test(app) && /freeRecord/.test(app.slice(app.indexOf("case 'get_state'"), app.indexOf("case 'generate_clip'"))), 'the bridge sets it (booth_mode) and reports it (get_state)')
  const mcp = fs.readFileSync(path.join(here, '..', 'agent', 'mcp-server.mjs'), 'utf8')
  ok(/name: 'set_booth_mode'/.test(mcp) && /action: 'booth_mode'/.test(mcp), 'the MCP server exposes set_booth_mode')
  const extras = fs.readFileSync(path.join(here, '..', 'src', 'extras.tsx'), 'utf8')
  ok(/FREE_RECORD_HINT/.test(extras) && /planTake\(/.test(extras) && /shouldAutoStop\(/.test(extras), 'the booth uses the plan, the auto-stop rule and the hint')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
