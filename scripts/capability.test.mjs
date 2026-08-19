// Standalone tests for hardware tiering (electron/capability.ts).
// Run with: npm run test:capability

import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = await build({
  entryPoints: [path.join(here, '..', 'electron', 'capability.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18',
})
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
const { classify, profileFor, resolveProfile, describeProfile, benchmark } = mod

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  PASS ', label) } else { fail++; console.log('  FAIL ', label) } }
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

// the machine this was developed on, measured
const REFERENCE = { cores: 8, memGB: 31.5, hwEncoder: false, benchMs: 99 }

console.log('\n-- classifying real-ish machines --')
eq(classify(REFERENCE).tier, 'best', 'the reference laptop (8 fast cores, 31GB) is not called weak')
eq(classify({ cores: 24, memGB: 64, hwEncoder: true, benchMs: 70 }).tier, 'best', 'a workstation is best')
eq(classify({ cores: 4, memGB: 8, hwEncoder: false, benchMs: 320 }).tier, 'low', 'an old dual-core-ish laptop is low')
eq(classify({ cores: 2, memGB: 8, hwEncoder: false, benchMs: 110 }).tier, 'low', 'a fast core cannot rescue 2 cores')
eq(classify({ cores: 16, memGB: 4, hwEncoder: true, benchMs: 90 }).tier, 'low', 'plenty of cores cannot rescue 4GB of memory')
eq(classify({ cores: 16, memGB: 32, hwEncoder: true, benchMs: 300 }).tier, 'low', 'plenty of cores cannot rescue a slow core')
eq(classify({ cores: 8, memGB: 16, hwEncoder: false, benchMs: 200 }).tier, 'balanced', 'a mid machine lands in the middle')
eq(classify({ cores: 6, memGB: 16, hwEncoder: false, benchMs: 100 }).tier, 'balanced', 'fast but only 6 cores is balanced, not best')
eq(classify({ cores: 8, memGB: 12, hwEncoder: false, benchMs: 100 }).tier, 'balanced', '12GB is not enough for best')

console.log('\n-- it explains itself --')
{
  const r = classify({ cores: 2, memGB: 4, hwEncoder: false, benchMs: 400 })
  ok(r.reasons.length >= 3, 'a weak machine lists every reason')
  ok(r.reasons.some(x => x.includes('2 logical cores')), 'it names the core count')
  ok(r.reasons.some(x => x.includes('4.0 GB')), 'it names the memory')
  ok(r.reasons.some(x => x.toLowerCase().includes('slow processor')), 'it names the slow processor')
}
{
  const r = classify({ cores: 1, memGB: 2, hwEncoder: false, benchMs: 500 })
  ok(r.reasons.some(x => x.includes('1 logical core') && !x.includes('cores')), 'singular reads correctly')
}
{
  const r = classify({ ...REFERENCE, hwEncoder: true })
  ok(r.reasons.some(x => x.includes('hardware video encoder')), 'a hardware encoder is worth mentioning')
}

console.log('\n-- garbage in --')
eq(classify({ cores: 0, memGB: 0, hwEncoder: false, benchMs: 0 }).tier, 'low', 'unknown hardware is assumed weak, not strong')
ok(classify({ cores: NaN, memGB: NaN, hwEncoder: false, benchMs: NaN }).tier === 'low', 'NaN does not throw or promote')

console.log('\n-- profiles --')
eq(profileFor('low').speechModel, 'tiny', 'a weak machine gets the quick speech model')
eq(profileFor('balanced').speechModel, 'base', 'the middle gets base')
eq(profileFor('best').speechModel, 'small', 'a strong machine keeps the accurate model')
ok(profileFor('low').framingFps < profileFor('best').framingFps, 'weaker machines decode fewer frames')
ok(profileFor('low').thumbnailWorkers < profileFor('best').thumbnailWorkers, 'weaker machines run fewer jobs at once')
eq(profileFor('low').exportPreset, 'veryfast', 'weaker machines encode faster')
ok(profileFor('low').proxyMaxFps <= profileFor('best').proxyMaxFps, 'weaker machines get lighter proxies')
for (const t of ['low', 'balanced', 'best']) {
  const p = profileFor(t)
  ok(p.thumbnailWorkers >= 1 && p.framingFps >= 1, `${t} profile has usable values`)
  ok(!!p.note && p.note.length < 200, `${t} profile explains itself briefly`)
}

console.log('\n-- the user always wins --')
eq(resolveProfile('best', 'low').speechModel, 'small', 'an explicit choice beats detection')
eq(resolveProfile('low', 'best').speechModel, 'tiny', 'including choosing to go lighter than detected')
eq(resolveProfile('auto', 'low').tier, 'low', 'auto follows detection')
eq(resolveProfile(undefined, 'best').tier, 'best', 'no preference follows detection')
eq(resolveProfile(undefined, undefined).tier, 'balanced', 'knowing nothing lands in the middle, not at either extreme')

console.log('\n-- the summary line --')
{
  const s = describeProfile(profileFor('best'), 'best', 'auto')
  ok(s.includes('Most accurate') && s.includes('detected best'), 'auto says it was detected')
  ok(describeProfile(profileFor('low'), 'best', 'low').includes('set by you'), 'an override says so')
}

console.log('\n-- the benchmark itself --')
{
  const t0 = Date.now()
  const ms = benchmark()
  const wall = Date.now() - t0
  ok(ms > 0, `it returns a positive number (${ms}ms on this machine)`)
  ok(wall < 8000, `it finishes quickly enough to run at startup (${wall}ms for 4 passes)`)
  const again = benchmark()
  ok(Math.abs(again - ms) <= Math.max(40, ms * 0.5), `it is repeatable (${ms} then ${again})`)
}

console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✗ FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
