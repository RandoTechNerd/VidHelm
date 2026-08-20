// Tests for turning a plain description into a renderable sound (electron/sfxmatch.ts).
// Run with: npm run test:sfxmatch

import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = await build({
  entryPoints: [path.join(here, '..', 'electron', 'sfxmatch.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18',
})
const M = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
const { matchRecipe, suggestName, nameToFilename, MIN_CONFIDENCE } = M

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  PASS ', label) } else { fail++; console.log('  FAIL ', label) } }
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
const recipeOf = (s) => matchRecipe(s).recipe

console.log('\n-- picking the right sound --')
eq(recipeOf('coffee beans pouring into a hopper'), 'coffee-beans', 'the obvious one')
eq(recipeOf('beans into a glass jar'), 'coffee-beans-glass', 'a glass container')
eq(recipeOf('pour beans into a plastic tub'), 'coffee-beans-plastic', 'a plastic one')
eq(recipeOf('rice pouring into a metal tin'), 'coffee-beans', 'rice is close enough to beans to be worth offering')
eq(recipeOf('sci-fi door opening'), 'door-electronic', 'a door')
eq(recipeOf('spaceship airlock sealing shut'), 'door-electronic-close', 'and one that is closing')
eq(recipeOf('podracer starting up'), 'podracer-start', 'an engine starting')
eq(recipeOf('engine ignition, burble then a growl'), 'podracer-start', 'described by its sound rather than its name')
eq(recipeOf('jet flying past the camera'), 'podracer-pass', 'a fly-past')
eq(recipeOf('a ship zooming by with doppler'), 'podracer-pass', 'doppler is a strong hint')

console.log('\n-- knowing when it cannot help --')
{
  const r = matchRecipe('a string quartet playing in a cathedral')
  ok(r.confidence < MIN_CONFIDENCE, `music is not something it can build (confidence ${r.confidence})`)
  eq(r.recipe, '', 'and it says so rather than guessing')
}
{
  const r = matchRecipe('dog barking')
  ok(r.confidence < MIN_CONFIDENCE, `a dog is not modelled (confidence ${r.confidence})`)
}
{
  // one weak word buried in a long description should not be enough
  const r = matchRecipe('a long ambient piece for the background of a montage about my engine of creativity')
  ok(r.confidence < MIN_CONFIDENCE, `one stray keyword in a ramble is not a match (confidence ${r.confidence})`)
}
{
  const r = matchRecipe('coffee beans')
  ok(r.confidence >= MIN_CONFIDENCE, `a short clear ask is confident (${r.confidence})`)
}

console.log('\n-- reading the modifiers --')
eq(matchRecipe('lots of beans, really full hopper').options.intensity, 1, 'more of it')
eq(matchRecipe('just a few beans, gentle').options.intensity, 0.3, 'less of it')
eq(matchRecipe('a long slow pour of beans').options.duration, 5, 'longer')
eq(matchRecipe('short quick bean pour').options.duration, 1.4, 'shorter')
eq(matchRecipe('beans pouring for 4 seconds').options.duration, 4, 'an explicit number of seconds')
eq(matchRecipe('beans pouring for 90 seconds').options.duration, undefined, 'an absurd length is ignored')
ok(matchRecipe('beans').options.intensity === undefined, 'no modifier means the recipe default')
{
  const r = matchRecipe('beans into a glass jar, lots of them, 3 seconds')
  eq(r.recipe, 'coffee-beans-glass', 'container, amount and length together: container')
  eq(r.options.intensity, 1, '...amount')
  eq(r.options.duration, 3, '...and length')
}

console.log('\n-- what it says it will make --')
{
  const r = matchRecipe('beans into a glass jar, lots of them')
  ok(r.summary.includes('glass jar'), `the summary names the container (${r.summary})`)
  ok(r.summary.includes('a lot of it'), 'and the amount')
}
eq(matchRecipe('door opening').summary.includes('door'), true, 'a door summary mentions the door')

console.log('\n-- suggesting a name --')
eq(suggestName('coffee beans into a glass jar', 'Coffee beans'), 'Coffee beans glass jar', 'built from the user’s own words')
eq(suggestName('make me a sound effect', 'Coffee beans'), 'Coffee beans', 'filler only falls back to the label')
eq(suggestName('', 'Electronic door'), 'Electronic door', 'empty falls back too')
ok(suggestName('beans', 'Coffee beans').length > 0, 'a single word still yields a name')
{
  const long = suggestName('beans pouring into an enormous industrial metal hopper on a factory floor', 'Coffee beans')
  ok(long.split(' ').length <= 4, `a long description is trimmed to something readable (${long})`)
}

console.log('\n-- filenames --')
eq(nameToFilename('Beans glass jar'), 'Beans glass jar.wav', 'a normal name')
ok(!/[<>:"/\\|?*]/.test(nameToFilename('a/b:c*d')), 'characters Windows refuses are stripped')
ok(nameToFilename('x'.repeat(200)).length < 60, 'a very long name is trimmed')
eq(nameToFilename(''), 'sound.wav', 'an empty name still produces a file')

console.log('\n-- seeds pass through --')
eq(matchRecipe('beans', { seed: 42 }).options.seed, 42, 'the seed is carried so takes can be re-rolled')

console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✗ FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
