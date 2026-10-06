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
  const end = main.search(/\.on\('end', \(\) => \{\s*setBar\(-1\)[^]{0,300}?let final = outputPath/), error = main.indexOf(".on('error'", end)
  const lands = [...main.matchAll(/exportPlans\.land\(/g)].map((m) => m.index)
  ok(end > 0 && lands.length === 1 && lands[0] > main.indexOf('fs.renameSync(partial', end) && lands[0] < error,
    'export-video files the plan once, in its end handler after the rename (never before the render, never on cancel)')
}

console.log('cancel')
{
  // a stand-in child process: records the kill
  const kid = () => ({ killed: null, kill(sig) { this.killed = sig || 'SIGTERM' } })
  const job = new J.ExportJob()
  const running = kid(), exited = kid()
  job.child(running, false)
  job.child(exited, false); job.child(exited, true)
  let fired = 0
  const off = job.onCancel(() => fired++)
  ok(job.cancel() === true && running.killed === 'SIGKILL' && exited.killed === null && fired === 1, 'Cancel kills the process that is running, not one that has already exited')
  ok(job.cancel() === false && fired === 1, 'a second click changes nothing')
  void off
  // the sound stage registers a new ffmpeg after the click (the premaster starting as Cancel lands)
  const late = kid()
  job.child(late, false)
  let lateKill = 0
  job.onCancel(() => lateKill++)
  ok(late.killed === 'SIGKILL' && lateKill === 1, 'a process or kill registered after the Cancel is stopped at once (it used to run to the end)')
  let threw = null
  try { job.check() } catch (e) { threw = e }
  ok(threw && J.isExportCancelled(threw) && threw.name === 'ExportCancelled' && !J.isExportCancelled(new Error('x')), 'check() between steps throws ExportCancelled once cancelled')
  ok(J.isExportCancelled({ name: 'ExportCancelled' }), 'recognised by name too (a bundle of its own has its own class)')
}
{
  // a voice bake the preview also waits on: the export stops waiting, the bake runs on
  const job = new J.ExportJob()
  let finishBake
  const bake = new Promise((r) => { finishBake = r })
  const raced = job.race(bake)
  let outcome = null
  raced.then((v) => { outcome = ['value', v] }, (e) => { outcome = ['error', e] })
  job.cancel()
  await new Promise((r) => setTimeout(r, 0))
  ok(outcome && outcome[0] === 'error' && J.isExportCancelled(outcome[1]), 'race() gives up on a running bake the moment Cancel is clicked')
  finishBake('baked')
  ok((await bake) === 'baked', '...and the bake itself still finishes (for the cache)')
  const quiet = new J.ExportJob()
  ok((await quiet.race(Promise.resolve(7))) === 7, 'without a Cancel, race() is just the result')
  let rejected = null
  try { await quiet.race(Promise.reject(new Error('bake failed'))) } catch (e) { rejected = e }
  ok(rejected && rejected.message === 'bake failed', '...or the error')
  let over = false
  void quiet.over.then(() => { over = true })
  quiet.end()
  await quiet.over
  ok(over, '`over` settles when the export ends (quitting waits on it)')
}

console.log('the Export buttons')
{
  const L = J.exportLabel
  ok(L({ pct: null }, 'header') === 'Export' && L({ pct: null }, 'panel') === 'Export Video', 'idle')
  ok(L({ pct: 0, stage: 'Fixing the voice in talk.mp4, 42%' }, 'panel') === 'Cancel (Fixing the voice in talk.mp4, 42%)' && L({ pct: 0, stage: 'Mixing the sound' }, 'header') === 'Mixing sound · Cancel',
    'the sound stage says what it is doing instead of "0% · Cancel"')
  ok(L({ pct: 42.4, stage: null, etaS: 65 }, 'panel') === 'Cancel (42%, 1:05 left)' && L({ pct: 42.4, etaS: 65 }, 'header') === '42% · Cancel', 'the video pass shows its percent and time left')
  ok(L({ pct: 0, stage: 'Mixing the sound', stopping: true }, 'header') === 'Stopping…' && L({ pct: 50, stopping: true }, 'panel') === 'Stopping…', 'a Cancel click is acknowledged at once')
  ok(L({ pct: 100, stopping: true }, 'header') === 'Done' && L({ pct: 100 }, 'panel') === 'Done', 'finished')
  ok(J.etaText(42.2) === '43s' && J.etaText(65) === '1:05' && J.etaText(600) === '10:00', 'time left reads 43s, 1:05, 10:00')
}

console.log('main wires the job through every stage')
{
  const main = fs.readFileSync(path.join(here, '..', 'electron', 'main.ts'), 'utf8')
  const handler = main.slice(main.indexOf("ipcMain.handle('export-video'"))
  ok(/mixEnv\(\{[^}]*\bjob\b[^}]*onStage: stage/.test(handler), 'the sound stage gets the job (kill, check, race) and reports its steps')
  ok(/\.on\('start', \(cmd\) => \{[^]{0,200}?if \(job\.cancelled\) command\.kill\('SIGKILL'\)/.test(handler), "a Cancel that landed before ffmpeg started kills it in 'start'")
  ok(/\.on\('end', \(\) => \{\s*setBar\(-1\)[^]{0,200}?if \(job\.cancelled\) \{ removePartial\(\); resolve\(\{ cancelled: true \}\)/.test(handler), "...and 'end' never turns a cancelled render into a success")
}

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
