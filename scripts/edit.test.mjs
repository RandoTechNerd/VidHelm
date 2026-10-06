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
  ok(up.volume === 1.5 && up.volumePoints[0].v === 1.5 && up.volumePoints[1].v === 0.75 && up.volumePoints[2].v === 0, 'the line moves as a whole, a silenced point stays silent')
  ok(up.volumePoints.length === 3 && up.volumePoints.every((p, i) => p.t === pts[i].t), 'point times untouched')
  ok(E.rescaleAutomation(pts, 1, 0.5).volumePoints[0].v === 0.5, 'and down the same way')
  // the review's case: a drawn 1.8 peak, the slider nudged up past where the peak hits the top
  const drawn = [{ t: 0, v: 1.0 }, { t: 5, v: 1.8 }, { t: 10, v: 0.5 }]
  const high = E.rescaleAutomation(drawn, 1, 1.2)
  ok(high.volumePoints.every(p => p.v <= 2) && near(high.volumePoints[1].v, 2, 1e-9), 'the loudest point stops at the 2.0 ceiling')
  ok(near(high.volume, 1 / 0.9, 1e-4) && near(high.volumePoints[0].v / high.volumePoints[2].v, 2, 1e-3), `and the rest stop with it: the slider reports where it got to (${high.volume}), the shape is kept`)
  const back = E.rescaleAutomation(high.volumePoints, high.volume, 1)
  ok(back.volume === 1 && back.volumePoints.every((p, i) => near(p.v, drawn[i].v, 1e-3)), `up past the ceiling and back restores the line (peak ${back.volumePoints[1].v}, was 1.8)`)
  let swept = { volume: 1, volumePoints: drawn }
  for (let v = 1.05; v <= 2.0001; v += 0.05) swept = E.rescaleAutomation(swept.volumePoints, swept.volume, +v.toFixed(2))
  for (let v = 1.95; v >= 0.9999; v -= 0.05) swept = E.rescaleAutomation(swept.volumePoints, swept.volume, +v.toFixed(2))
  ok(swept.volumePoints.every((p, i) => near(p.v, drawn[i].v, 2e-3)), 'a full sweep of the slider, step by step, up to the top and back, keeps the drawn line')
  const atTop = E.rescaleAutomation([{ t: 0, v: 2 }, { t: 1, v: 1 }], 1, 1.5)
  ok(atTop.volume === 1 && atTop.volumePoints[1].v === 1, 'a line already touching the top does not move up at all')
  // from silence there is no ratio: the line shifts, but a point at silence stays silent
  const fromZero = E.rescaleAutomation(pts, 0, 0.5)
  ok(fromZero.volumePoints[0].v === 1.5 && fromZero.volumePoints[1].v === 1 && fromZero.volumePoints[2].v === 0, 'from silence it shifts instead of scaling, leaving silence silent')
  const capped = E.rescaleAutomation([{ t: 0, v: 1.8 }, { t: 1, v: 0 }], 0, 1)
  ok(near(capped.volume, 0.2, 1e-9) && capped.volumePoints[0].v === 2 && capped.volumePoints[1].v === 0, 'and the shift also stops at the top')
  const dead = E.rescaleAutomation([{ t: 0, v: 0 }, { t: 1, v: 0 }], 0, 0.8)
  ok(dead.volume === 0.8 && dead.volumePoints.every(p => p.v === 0.8), 'a line taken all the way to silence rises flat (no shape left, and the slider must not go dead)')
}

console.log('slideVolume (one drag of the Volume slider)')
{
  const drawn = [{ t: 0, v: 1.0 }, { t: 5, v: 1.8 }, { t: 10, v: 0.5 }]
  // the Inspector: the clip as the document holds it, and the drag in a ref
  const slider = () => {
    let slide = null
    return {
      clip: { id: 'a', volume: 1, volumePoints: drawn },
      to(v) { const r = E.slideVolume(slide, this.clip, v); slide = r.slide; this.clip = { ...this.clip, volume: r.volume, volumePoints: r.volumePoints }; return this.clip },
    }
  }
  const s = slider()
  s.to(0.5); s.to(0); s.to(0.5)
  const restored = s.to(1)
  ok(restored.volume === 1 && restored.volumePoints.every((p, i) => p.v === drawn[i].v), 'down to zero and back up restores the drawn line exactly')
  const g = slider()
  for (let i = 0; i < 40; i++) g.to(i % 2 ? 1.35 : 0.65)
  ok(g.to(1).volumePoints.every((p, i) => p.v === drawn[i].v), 'forty steps back and forth leave no rounding behind')
  const o = slider()
  o.to(0.5)
  o.clip = { ...o.clip, volumePoints: [{ t: 0, v: 0.2 }, { t: 3, v: 0.4 }] }   // a point dragged on the graph, or an undo
  const fresh = o.to(1)
  ok(near(fresh.volumePoints[0].v, 0.4, 1e-9) && near(fresh.volumePoints[1].v, 0.8, 1e-9), 'a line changed elsewhere is scaled as it now stands, not reverted')
  const other = E.slideVolume({ id: 'b', volume: 1, points: [{ t: 0, v: 2 }], wrote: drawn }, { id: 'a', volume: 1, volumePoints: drawn }, 0.5)
  ok(other.slide.id === 'a' && other.volumePoints[1].v === 0.9, 'a slide on another clip is never applied to this one')
}

// ---- ripple edits ----
{
  const c = { start: 10, duration: 5 }
  ok(JSON.stringify(E.rippleRange(c, 'delete', 0)) === '{"start":10,"end":15}', 'ripple delete takes the whole clip, wherever the playhead is')
  ok(JSON.stringify(E.rippleRange(c, 'trimStart', 12)) === '{"start":10,"end":12}', 'Q takes head to playhead')
  ok(JSON.stringify(E.rippleRange(c, 'trimEnd', 12)) === '{"start":12,"end":15}', 'W takes playhead to tail')
  ok(E.rippleRange(c, 'trimStart', 9) === null && E.rippleRange(c, 'trimEnd', 15) === null, 'Q/W refuse when the playhead is outside the clip')
  const mk = (id, track, start, duration, sourceStart = 0) => ({ id, trackId: track, start, duration, sourceStart, fadeIn: 0, fadeOut: 0 })
  const sfx = [mk('a', 'a2', 0, 1), mk('b', 'a2', 2, 1), mk('c', 'a2', 5, 1), mk('v', 'v1', 0, 10)]
  const del = E.rippleTrack(sfx, 'a2', 2, 3)
  ok(!del.find(x => x.id === 'b') && del.find(x => x.id === 'c').start === 4, 'ripple delete on a2 removes b and pulls c left by its length')
  ok(del.find(x => x.id === 'a').start === 0 && del.find(x => x.id === 'v').start === 0 && del.find(x => x.id === 'v').duration === 10, 'earlier clips and other tracks never move')
  const head = E.rippleTrack([mk('m', 'a1', 4, 6, 100), mk('n', 'a1', 12, 2)], 'a1', 4, 6)
  const m = head.find(x => x.id === 'm')
  ok(m.start === 4 && m.duration === 4 && m.sourceStart === 102, 'Q on a music clip: start stays put, source advances by the trimmed amount')
  ok(m.aFadeIn >= E.DEPOP, 'the new head gets a de-pop ramp')
  ok(head.find(x => x.id === 'n').start === 10, 'the next clip on the track closes up')
  const tail = E.rippleTrack([mk('m', 'a1', 4, 6, 100)], 'a1', 7, 10)
  ok(tail[0].duration === 3 && tail[0].sourceStart === 100 && tail[0].aFadeOut >= E.DEPOP, 'W keeps the head and ramps the new tail')
  ok(E.rippleTrack(sfx, 'a2', 3, 3) === sfx, 'an empty range changes nothing')
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} - ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
