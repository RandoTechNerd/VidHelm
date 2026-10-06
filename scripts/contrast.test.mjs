// Contrast of the design tokens in src/App.css, in both themes. Run with: npm run test:contrast
// The palette is easy to nudge by eye and easy to break by eye: a "slightly softer" grey or a
// "slightly brighter" clip colour has twice taken secondary text and clip labels under WCAG AA.
// This reads the real token blocks, so the numbers here are the numbers the app ships.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = fs.readFileSync(path.join(here, '..', 'src', 'App.css'), 'utf8')
let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }

/** the custom properties declared in the first rule whose selector is exactly `selector` */
const block = (selector) => {
  const at = css.indexOf(selector + ' {')
  if (at < 0) throw new Error(`no ${selector} block in App.css`)
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('\n}', at))
  const out = {}
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}
const dark = block(':root')
// light only redeclares what changes; everything else falls through from :root
const light = { ...dark, ...block(':root[data-theme="light"]') }

const hex = (theme, v) => {
  const ref = /^var\((--[\w-]+)\)$/.exec(v)
  if (ref) return hex(theme, theme[ref[1]])
  if (!/^#[0-9a-f]{6}$/i.test(v || '')) throw new Error(`not a 6-digit hex colour: ${v}`)
  return v
}
const lum = (h) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const tok = (theme, v) => v.startsWith('#') ? v : hex(theme, theme[v])

const AA = 4.5
const check = (name, theme, fg, bg, min = AA) => {
  let r
  try { r = ratio(tok(theme, fg), tok(theme, bg)) }
  catch (e) { ok(false, `${name}: ${fg} on ${bg} (${e.message})`); return }
  ok(r >= min, `${name}: ${fg} on ${bg} ${r.toFixed(2)}:1`)
}

for (const [name, t] of [['dark', dark], ['light', light]]) {
  console.log(`\n${name} theme`)
  // every grade of text on every panel it can land on
  for (const fg of ['--text-main', '--text-muted', '--text-dim'])
    for (const bg of ['--bg-surface', '--bg-surface-elevated', '--bg-input', '--bg-track']) check(name, t, fg, bg)
  // status colours double as text: licence badges, warnings, the QC verdict, accent links
  for (const fg of ['--accent-text', '--accent-gold', '--accent-secondary', '--accent-warning', '--accent-error']) check(name, t, fg, '--bg-surface')
  // white clip labels and white text on filled buttons
  for (const bg of ['--clip-video', '--clip-image', '--clip-audio', '--clip-broll', '--accent-primary', '--accent-hover']) check(name, t, '#ffffff', bg)
  check(name, t, '--clip-text-ink', '--clip-text')
  // the Takes badge inks its amber fill with the panel colour
  check(name, t, '--bg-surface', '--accent-warning')
  // the first screen: the empty stage carries a heading and a hint
  check(name, t, '--text-main', '--bg-stage-empty')
  check(name, t, '--text-muted', '--bg-stage-empty')
}

console.log('\nno literal yellows left as text colours')
ok(!/color:\s*#(facc15|ffb423)\b/i.test(css), 'favourites, held lines and credit badges use --accent-gold')

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} - ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
