// Tests for the export job decisions (electron/exportjob.ts): progress, time left, the partial file,
// versioned names, the default file name and the sound plans. Run with: npm run test:exportjob
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'electron', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const J = await load('exportjob.ts')
let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }

console.log('progress')
{
  ok(J.timemarkSeconds('00:01:02.50') === 62.5 && J.timemarkSeconds('01:00:00.00') === 3600, 'reads ffmpeg time marks')
  ok(J.timemarkSeconds('N/A') === null && J.timemarkSeconds(undefined) === null && J.timemarkSeconds('garbage') === null, 'N/A and junk are not a position')
  ok(J.timemarkSeconds('-00:00:00.05') === 0, 'the small negative start some muxers report counts as zero')
  ok(J.progressPct('00:00:30.00', 120) === 25, 'a quarter of the way through reads 25%')
  ok(J.progressPct('00:02:00.00', 120) === 99.5 && J.progressPct('00:02:05.00', 120) === 99.5, 'never claims 100% while the index is still being written')
  ok(J.progressPct('N/A', 120) === null && J.progressPct('00:00:10.00', 0) === null, 'nothing to report without a position or a length')
}

console.log('time left')
{
  let st = null, left
  ;({ state: st, secondsLeft: left } = J.etaStep(st, 0, 0))
  ok(left === null, 'no guess before there is a rate')
  // a steady 2% a second
  for (let t = 1; t <= 10; t++) ({ state: st, secondsLeft: left } = J.etaStep(st, t * 2, t * 1000))
  ok(Math.abs(left - 40) < 0.5, `steady 2%/s at 20% leaves 40 s (got ${left?.toFixed(1)})`)
  // one stall then a burst must not throw the estimate around
  ;({ state: st, secondsLeft: left } = J.etaStep(st, 20, 12000))
  const stalled = left
  ;({ state: st, secondsLeft: left } = J.etaStep(st, 30, 13000))
  ok(stalled > 30 && stalled < 50 && left > 20 && left < 45, `a stall and a burst move it gently (${stalled?.toFixed(1)} s, then ${left?.toFixed(1)} s)`)
  const again = J.etaStep(st, 30, 13100)
  ok(again.state === st, 'updates closer than 0.2 s apart are not used as a rate')
  ok(J.etaStep(st, 1, 14000).secondsLeft === null, 'a new export (percent went down) starts over')
}

console.log('files')
{
  ok(J.partialPath('C:\\Videos\\talk_landscape.mp4') === 'C:\\Videos\\talk_landscape.partial.mp4', 'the partial sits beside the target with the same extension')
  ok(J.partialPath('/a.b/clip.mov') === '/a.b/clip.partial.mov' && J.partialPath('out') === 'out.partial', 'dots in folders and no extension are handled')
  const have = new Set(['C:/x/talk.mp4', 'C:/x/talk_v2.mp4'])
  ok(J.nextVersion('C:/x/talk.mp4', p => have.has(p)) === 'C:/x/talk_v3.mp4', 'the next free version is used')
  ok(J.nextVersion('C:/x/new.mp4', () => false) === 'C:/x/new_v2.mp4', 'a fresh name becomes _v2')
  ok(J.nextVersion('C:/x/talk_v2.mp4', p => have.has(p)) === 'C:/x/talk_v3.mp4', 'a name already ending in _v2 counts on, it does not become _v2_v2')
  ok(J.exportFileName('My Trip', 'portrait') === 'My Trip_portrait.mp4', 'project name and orientation')
  ok(J.exportFileName(null, 'landscape') === 'video_landscape.mp4' && J.exportFileName('  ', '') === 'video_landscape.mp4', 'no project gives video_landscape.mp4')
  ok(J.exportFileName('a:b/c?d*. ', 'square') === 'a b c d_square.mp4', 'characters Windows refuses are replaced, no trailing dot')
}

console.log('sound plans')
{
  // main files a plan only in the render's 'end', after the rename; a cancel or an error never calls land()
  const plans = new J.LandedPlans((f) => f.replace(/\//g, '\\').toLowerCase())
  const first = { plannedLufs: -14, roles: { voice: 1 } }
  plans.land('C:\\Videos\\talk_landscape.mp4', first)
  ok(plans.get('c:/videos/TALK_landscape.mp4') === first, 'a landed export is found by any spelling of its path')
  // re-export with music and the master at -6 dB, then Cancel: main never reaches land(), nothing is filed
  const second = { plannedLufs: -20, roles: { voice: 1, music: 1 } }
  ok(plans.get('C:\\Videos\\talk_landscape.mp4') === first, 'a cancelled or failed re-export leaves the untouched file judged by its own plan')
  // the old file is open in a player, so the render lands as _v2: the plan goes with the render
  plans.land('C:\\Videos\\talk_landscape_v2.mp4', second)
  ok(plans.get('C:\\Videos\\talk_landscape_v2.mp4') === second && plans.get('C:\\Videos\\talk_landscape.mp4') === first, 'a render saved under the next name files its plan there, and the original keeps its own')
  ok(plans.get('C:\\Videos\\never.mp4') === null, 'a file this run never exported has no plan')
  const small = new J.LandedPlans(undefined, 2)
  small.land('a', 1); small.land('b', 2); small.land('a', 3); small.land('c', 4)
  ok(small.get('a') === 3 && small.get('b') === null && small.get('c') === 4, 'past the cap the oldest export is forgotten, never one just exported again')
  // and main files it only there: inside the render's 'end', after the rename has landed
  const main = fs.readFileSync(path.join(here, '..', 'electron', 'main.ts'), 'utf8')
  const end = main.search(/\.on\('end', \(\) => \{\s*setBar\(-1\)\s*let final = outputPath/), error = main.indexOf(".on('error'", end)
  const lands = [...main.matchAll(/exportPlans\.land\(/g)].map((m) => m.index)
  ok(end > 0 && lands.length === 1 && lands[0] > main.indexOf('fs.renameSync(partial', end) && lands[0] < error,
    'export-video files the plan once, in its end handler after the rename (never before the render, never on cancel)')
}

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
