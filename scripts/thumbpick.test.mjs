// Tests for thumbnail picking (electron/thumbpick.ts). Run with: npm run test:thumbpick
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'electron', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const P = await load('thumbpick.ts')
const S = await load('styletheme.ts')
let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }

const W = 160, H = 90
// synthetic frames: a checkerboard "detailed" scene, a blurred copy, a dark copy, a flat grey
const make = (fn) => { const b = new Uint8Array(W * H * 3); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, bl] = fn(x, y); const i = (y * W + x) * 3; b[i] = r; b[i + 1] = g; b[i + 2] = bl } return b }
const detail = make((x, y) => ((x >> 2) + (y >> 2)) % 2 ? [60, 200, 90] : [40, 90, 160])
const blurred = (() => { const b = new Uint8Array(detail.length); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) { let s = 0, n = 0; for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy)); s += detail[(yy * W + xx) * 3 + c]; n++ } b[(y * W + x) * 3 + c] = s / n } return b })()
const dark = detail.map(v => v * 0.12)
const flat = make((x) => [x, x, x])   // a featureless left-to-right ramp
const skin = make((x, y) => (x > 50 && x < 110 && y > 20 && y < 80) ? [205, 150, 120] : ((x >> 2) + (y >> 2)) % 2 ? [200, 200, 200] : [60, 60, 60])

console.log('scoreFrame')
const sd = P.scoreFrame(detail, W, H), sb = P.scoreFrame(blurred, W, H), sk = P.scoreFrame(dark, W, H), sf = P.scoreFrame(flat, W, H), ss = P.scoreFrame(skin, W, H)
ok(sd.sharpness > sb.sharpness, `sharp beats blurred (${sd.sharpness} vs ${sb.sharpness})`)
ok(sd.score > sb.score, 'a sharp frame outscores its blurred copy')
ok(sd.score > sk.score, 'a well-exposed frame outscores a dark one')
ok(sf.score < 0.35, `a flat grey frame scores low (${sf.score})`)
ok(ss.skin > 0.5 && sd.skin < ss.skin, 'skin tone in the middle is noticed')
ok(sd.sig.length === 144, '16x9 signature')

console.log('rankFrames')
{
  const frames = [{ t: 1, score: sb }, { t: 2, score: sd }, { t: 3, score: { ...sd, score: sd.score - 0.01 } }, { t: 4, score: sk }, { t: 5, score: sf }]
  const r = P.rankFrames(frames, 3)
  ok(r[0].t === 2, 'best first')
  ok(!r.some(f => f.t === 3), 'a near-duplicate of a better frame is dropped')
  ok(r.length === 3, 'keeps the requested number')
}

console.log('sampleTimes / photo names')
{
  const ts = P.sampleTimes(100, 10)
  ok(ts[0] > 5 && ts[ts.length - 1] < 95, 'skips the first and last 5%')
  ok(ts.every((t, i) => i === 0 || t > ts[i - 1]), 'in order')
  ok(P.looksLikeThumbPhoto('thumb.jpg') && P.looksLikeThumbPhoto('Cover Photo.PNG') && P.looksLikeThumbPhoto('me_selfie.webp'), 'thumb/cover/photo/selfie names count')
  ok(!P.looksLikeThumbPhoto('broll_01.jpg') && !P.looksLikeThumbPhoto('thumb.mp4'), 'other files do not')
  ok(!P.looksLikeThumbPhoto('MyVideo_thumbnail.png'), 'our own composed thumbnails are not mistaken for a photo')
}

console.log('thumbTextLayout')
{
  const spec = S.themeById('randotechnerd').thumb
  const one = P.thumbTextLayout('I fixed it', spec)
  ok(one.length === 1 && one[0].text === 'I FIXED IT', 'one line, uppercased by the theme')
  const two = P.thumbTextLayout('A1 MINI RESCUE | for $12 in parts', spec)
  ok(two.length === 2 && two[1].color === spec.accent && two[0].color === spec.color, 'second line in the accent colour')
  ok(two[0].y < two[1].y && two[1].y + two[1].size <= 720 - 40, 'stacked, inside the bottom margin')
  const long = P.thumbTextLayout('THIS IS A VERY LONG THUMBNAIL LINE THAT WOULD NEVER FIT', spec)
  const adv = S.THEME_FONTS[spec.font].advance * 1.12
  ok(long.length === 2 && long[0].color === long[1].color, 'one long line wraps into two of the same colour')
  ok(long.every(l => l.size * adv * l.text.length <= 1280 * 0.63), 'wrapped lines fit the left side')
  ok(P.thumbTextLayout('', spec).length === 0, 'no subtitle, no text')
}

console.log('nudge')
ok(!P.photoNudge('photo') && /PLACEHOLDER/.test(P.photoNudge('placeholder')) && /thumb\.jpg/.test(P.photoNudge('frame')), 'nudges unless it is a real photo')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
