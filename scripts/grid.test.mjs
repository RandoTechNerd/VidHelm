// Tests for grid snapping (electron/grid.ts). Run with: npm run test:grid
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'electron', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const G = await load('grid.ts')
let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e

console.log('nearestLine')
ok(near(G.nearestLine(2.1, 0.5, 0), 2.0) && near(G.nearestLine(2.3, 0.5, 0), 2.5), 'rounds to the closest line')
ok(near(G.nearestLine(2.1, 0.5, 0.2), 2.2), 'honours the phase')

console.log('roll a join onto the beat')
{
  // 120 BPM: beat 0.5s. Three touching clips with joins at 2.1 and 4.05 (should become 2.0 and 4.0)
  const clips = [
    { id: 'a', trackId: 'v1', start: 0, duration: 2.1, sourceStart: 0 },
    { id: 'b', trackId: 'v1', start: 2.1, duration: 1.95, sourceStart: 5 },
    { id: 'c', trackId: 'v1', start: 4.05, duration: 2.95, sourceStart: 9 },
  ]
  const r = G.snapToGrid(clips, [], { bpm: 120 })
  const a = r.clips.find(c => c.id === 'a'), b = r.clips.find(c => c.id === 'b'), c = r.clips.find(c => c.id === 'c')
  ok(near(a.duration, 2.0) && near(b.start, 2.0), 'first join rolled from 2.1 to 2.0')
  ok(near(b.sourceStart, 4.9) && near(b.start + b.duration, 4.0), 'right clip slid its in-point and kept its end')
  ok(near(c.start, 4.0) && near(c.sourceStart, 8.95), 'second join rolled from 4.05 to 4.0')
  ok(near(c.start + c.duration, 7.0), 'final out-point already sits on a beat (7.0) and stays')
  ok(r.moves.filter(m => m.kind === 'cut').length === 2, `two cut moves reported (${r.moves.length})`)
  ok(r.skipped.length === 0, 'nothing skipped')
}

console.log('limits')
{
  const clips = [
    { id: 'a', trackId: 'v1', start: 0, duration: 1.0, sourceStart: 0 },
    { id: 'b', trackId: 'v1', start: 1.0, duration: 0.3, sourceStart: 0 },   // too short to roll, and no earlier source
    { id: 'c', trackId: 'v1', start: 1.3, duration: 3.0, sourceStart: 2 },
  ]
  const r = G.snapToGrid(clips, [], { bpm: 120 })
  const b = r.clips.find(c => c.id === 'b')
  ok(near(b.start, 1.0), 'a join already on the grid stays')
  ok(r.skipped.some(s => s.id === 'c'), 'a roll that would starve the short clip is skipped and reported')
  const far = G.snapToGrid([{ id: 'x', trackId: 'v1', start: 0, duration: 3, sourceStart: 0 }, { id: 'y', trackId: 'v1', start: 3.24, duration: 3, sourceStart: 4 }], [], { bpm: 120, tolerance: 0.1 })
  ok(far.skipped.some(s => s.id === 'y') && near(far.clips[1].start, 3.24), 'moves beyond tolerance are refused')
  const ext = G.snapToGrid([{ id: 'z', trackId: 'v1', start: 0, duration: 2.8, sourceStart: 0, sourceDuration: 2.85 }], [], { bpm: 120 })
  ok(ext.skipped.some(s => s.id === 'z'), 'an out-point cannot extend past the end of its source')
}

console.log('tags to bar lines')
{
  const markers = [{ id: 'm1', t: 4.3 }, { id: 'm2', t: 7.6 }, { id: 'm3', t: 12.0 }]
  const r = G.snapToGrid([{ id: 'a', trackId: 'v1', start: 0, duration: 20, sourceStart: 0 }], markers, { bpm: 120, phase: 0 })
  const t = Object.fromEntries(r.markers.map(m => [m.id, m.t]))
  ok(near(t.m1, 4.0) && near(t.m2, 8.0) && near(t.m3, 12.0), `tags land on bar lines (${t.m1}, ${t.m2}, ${t.m3})`)
  ok(r.moves.filter(m => m.kind === 'tag').length === 2, 'only the tags that moved are reported')
  ok(/2 tags slid/.test(G.describeSnap(r)), 'summary reads like a sentence')
}

console.log('audio tracks untouched')
{
  const clips = [
    { id: 'v', trackId: 'v1', start: 0, duration: 4.1, sourceStart: 0 },
    { id: 'm', trackId: 'a1', start: 0.13, duration: 9, sourceStart: 0 },
  ]
  const r = G.snapToGrid(clips, [], { bpm: 120 })
  ok(near(r.clips.find(c => c.id === 'm').start, 0.13), 'music bed is not snapped')
}

console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✗ FAILURES'} - ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
