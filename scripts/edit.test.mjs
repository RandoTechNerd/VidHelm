// Tests for timeline cuts (electron/edit.ts). Run with: npm run test:edit
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'electron', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const E = await load('edit.ts')
let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e
let n = 0
const id = () => 'n' + (++n)
/** gain a clip plays at absolute time t (what the preview's gainAt and the export's volumeExpr do) */
const gainAt = (c, t) => c.volumePoints?.length ? E.automationAt(c.volumePoints, t - c.start) : (c.volume ?? 1)
const clip = (o = {}) => ({ id: 'c', mediaId: 'm', trackId: 'a1', start: 2, duration: 10, sourceStart: 5, volume: 1, fadeIn: 0.5, fadeOut: 1, ...o })

console.log('rebasePoints')
{
  const pts = [{ t: 1, v: 1 }, { t: 3, v: 0 }]
  const L = E.rebasePoints(pts, 0, 2), R = E.rebasePoints(pts, 2, 4)
  ok(L.length === 2 && near(L[1].t, 2) && near(L[1].v, 0.5), 'left half ends on the interpolated gain')
  ok(near(R[0].t, 0) && near(R[0].v, 0.5) && near(R[1].t, 1) && R[1].v === 0, 'right half starts on it, later points rebased')
  ok(E.rebasePoints(undefined, 0, 1) === undefined && E.rebasePoints([], 0, 1).length === 0, 'no automation stays no automation')
  const before = E.rebasePoints([{ t: 1, v: 0.3 }], 5, 8)
  ok(before.length === 1 && before[0].t === 0 && near(before[0].v, 0.3), 'a stretch after the last point holds its gain')
}

console.log('splitClip')
{
  const c = clip({ volumePoints: [{ t: 0, v: 1 }, { t: 8, v: 0.2 }] })
  const [a, b] = E.splitClip(c, 6, id)
  ok(a.duration === 4 && b.start === 6 && b.duration === 6 && b.sourceStart === 9, 'halves meet at the split and the source carries on')
  ok(a.fadeOut === 0 && b.fadeIn === 0 && a.aFadeOut === E.DEPOP && b.aFadeIn === E.DEPOP, 'hard cut on the picture, DEPOP ramps on the audio')
  ok(a.fadeIn === 0.5 && b.fadeOut === 1, 'the original fades stay on the outer ends')
  ok(a.id !== c.id && b.id !== c.id && a.id !== b.id, 'two new ids')
  let worst = 0
  for (let t = 2; t <= 12; t += 0.25) { const w = t < 6 ? a : b; worst = Math.max(worst, Math.abs(gainAt(w, t) - gainAt(c, t))) }
  ok(worst < 1e-3, `the halves play the gain the whole clip did, everywhere (worst ${worst.toFixed(4)})`)
  ok(near(gainAt(a, 5.999), gainAt(b, 6)), 'no gain step at the split point')
  const old = { ...c, volumePoints: c.volumePoints }
  ok(Math.abs(gainAt({ ...b, volumePoints: old.volumePoints }, 10) - gainAt(c, 10)) > 0.3, '(the old copy-unshifted halves played the wrong gain)')
  ok(E.splitClip(c, 2, id) === null && E.splitClip(c, 12, id) === null && E.splitClip(c, 1, id) === null, 'no split at or outside the edges')
  const [fa, fb] = E.splitClip(clip(), 4, id)
  ok(fa.volumePoints === undefined && fb.volumePoints === undefined, 'a clip without automation gets none')
}

console.log('removeRange: clips')
{
  const c = clip({ start: 0, duration: 10, sourceStart: 0, volumePoints: [{ t: 0, v: 1 }, { t: 10, v: 0 }] })
  const after = clip({ id: 'after', start: 10, duration: 3, sourceStart: 0 })
  const r = E.removeRange([c, after], [], 4, 6, 0, [], id)
  const [L, R, A] = r.clips
  ok(L.duration === 4 && R.start === 4 && R.duration === 4 && R.sourceStart === 6 && A.start === 8, 'cut out and rippled left')
  ok(L.aFadeOut >= E.DEPOP && R.aFadeIn >= E.DEPOP, 'de-pop ramps either side of the join')
  ok(R.volumePoints && near(gainAt(R, 4), 0.4) && near(gainAt(R, 7), 0.1), 'the right piece keeps its automation, rebased (it used to be wiped)')
  ok(near(gainAt(L, 3), 0.7), 'the left piece keeps its own stretch of the line')
  const x = E.removeRange([c], [], 4, 6, 0.12, [], id)
  const [L2, R2] = x.clips
  ok(near(R2.start, 4 - 0.12) && near(R2.sourceStart, 6 - 0.12) && L2.fadeOut === 0, 'with a transition B overlaps A and A does not fade to black')
  ok(near(gainAt(R2, R2.start + 1), gainAt(c, 6 - 0.12 + 1)), 'overlapped right piece still plays the gain from where its source starts')
}

console.log('removeRange: tags')
{
  const m = [{ id: 'a', t: 1 }, { id: 'b', t: 5 }, { id: 'c', t: 9 }]
  const r = E.removeRange([], [], 4, 6, 0, m, id)
  ok(r.markers[0].t === 1 && r.markers[1].t === 4 && r.markers[2].t === 7, 'a tag after the cut moves left by its length, one inside lands on the join')
  const d = E.removeRange([], [], 4, 6, 0, m, id, true)
  ok(d.markers.length === 2 && d.markers[1].t === 7, 'trimming a head or tail drops the tags inside')
}

console.log('removeRange: captions')
{
  const words = [{ s: 0, e: 0.4, t: 'one' }, { s: 0.5, e: 0.9, t: 'two' }, { s: 2.6, e: 3, t: 'three' }, { s: 3.1, e: 3.5, t: 'four' }]
  const cap = { id: 't', text: 'one two three four', start: 10, duration: 4, x: 0.5, y: 0.8, caption: { spec: { motion: 'highlight' }, theme: 'creator', words } }
  const r = E.removeRange([], [cap], 11, 12.5, 0, [], id)
  const [L, R] = r.texts
  ok(L.text === 'one two' && R.text === 'three four', 'each piece keeps the words said on its side of the cut')
  ok(L.caption.words.length === 2 && R.caption.words.length === 2 && L.caption.spec.motion === 'highlight', 'words travel with them, the style stays')
  ok(R.start === 11 && near(R.caption.words[0].s, 0.1) && near(R.caption.words[1].e, 1), 'right piece words rebased to its new start')
  const gone = E.removeRange([], [cap], 9.9, 11.2, 0, [], id)
  ok(gone.texts.length === 1 && gone.texts[0].text === 'three four' && gone.texts[0].start === 9.9, 'a caption cut at its head keeps only what is left')
  const plain = { id: 'p', text: 'TITLE', start: 0, duration: 10, x: 0.5, y: 0.5 }
  const p = E.removeRange([], [plain], 4, 6, 0, [], id)
  ok(p.texts.length === 2 && p.texts.every(t => t.text === 'TITLE'), 'a title spanning a cut simply carries on')
  const noWords = { ...cap, caption: { spec: {}, theme: 'x' } }
  const q = E.removeRange([], [noWords], 12, 14, 0, [], id)
  ok(q.texts.length === 1 && q.texts[0].text === 'one two', 'a caption without word times splits on its evenly spread words')
}

console.log('planPauseCuts')
{
  const o = { pad: 0.12, minKeep: 0.9 }
  const head = E.planPauseCuts([{ start: 0, end: 1.0 }], 20, o)
  ok(head.length === 1 && head[0].start === 0 && near(head[0].end, 0.88), 'Cut Pauses removes the dead air at the head (it used to keep it)')
  const head5 = E.planPauseCuts([{ start: 0, end: 0.5 + 0.12 + 0.12 }], 20, o)
  ok(head5.length === 1 && head5[0].start === 0 && near(head5[0].end - head5[0].start, 0.62), 'a short silent head goes too')
  const click = E.planPauseCuts([{ start: 0.15, end: 2.5 }], 20, o)
  ok(click.length === 1 && click[0].start === 0, 'a click before the first pause goes with it')
  const word = E.planPauseCuts([{ start: 0.6, end: 2.5 }], 20, o)
  ok(word.length === 1 && near(word[0].start, 0.72), 'a short opening word stays (no speech thrown away), and the pause after it is cut')
  const tail = E.planPauseCuts([{ start: 18, end: 20 }], 20, o)
  ok(tail.length === 1 && tail[0].end === 20 && near(tail[0].start, 18.12), 'the tail is cut to the very end, no pad after the last word')
  const mid = E.planPauseCuts([{ start: 5, end: 7 }], 20, o)
  ok(near(mid[0].start, 5.12) && near(mid[0].end, 6.88), 'a pause mid-timeline keeps a breath either side')
  const sliver = E.planPauseCuts([{ start: 5, end: 7 }, { start: 7.3, end: 9 }], 20, o)
  ok(sliver.length === 1, 'a cut that would strand a stutter between two cuts is left out')
  const merged = E.planPauseCuts([{ start: 5, end: 7 }, { start: 6.5, end: 8 }], 20, o)
  ok(merged.length === 1 && near(merged[0].end, 7.88), 'overlapping detections merge')
  ok(E.planPauseCuts([{ start: 0, end: 20 }], 20, o).length === 0, 'an all-silent timeline is never removed whole')
  ok(E.planPauseCuts([{ start: 5, end: 5.2 }], 20, o).length === 0, 'too short to cut once padded')
}

console.log('rescaleAutomation')
{
  const pts = [{ t: 0, v: 1 }, { t: 1, v: 0.5 }, { t: 2, v: 0 }]
  const up = E.rescaleAutomation(pts, 1, 1.5)
  ok(up[0].v === 1.5 && up[1].v === 0.75 && up[2].v === 0, 'the line moves as a whole, a silenced point stays silent')
  ok(E.rescaleAutomation([{ t: 0, v: 1.8 }], 1, 2)[0].v === 2, 'never past the slider top')
  ok(E.rescaleAutomation(pts, 0, 0.5)[1].v === 1, 'from silence it shifts instead of scaling')
  ok(up.length === 3 && up.every((p, i) => p.t === pts[i].t), 'point times untouched')
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} - ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
