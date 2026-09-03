/* node scripts/threemf.test.mjs
 * Object-level 3MF colours: the case three's own loader drops on the floor. */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = await build({
  entryPoints: [path.join(here, '..', 'electron', 'threemf.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18',
})
const { normHex, hexInName, colourGroups, partColours, pickModelEntry } =
  await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))

let pass = 0, fail = 0
const ok = (cond, label, got) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${got === undefined ? '' : ` (got ${JSON.stringify(got)})`}`) }
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, a)

/* ---- hex parsing --------------------------------------------------------- */
eq(normHex('#E8890C'), '#e8890c', 'hex normalises case')
eq(normHex('E8890C'), '#e8890c', 'hex without the hash')
eq(normHex('#E8890CFF'), '#e8890c', 'alpha is dropped')
eq(normHex('#fff'), null, 'shorthand is not a 3MF colour')
eq(normHex(''), null, 'empty is not a colour')
eq(normHex(null), null, 'null is not a colour')
eq(hexInName('SnapMaker U1 MICRO - #E8890C'), '#e8890c', 'hex read out of a part name')
eq(hexInName('just a lid'), null, 'a name with no hex')

/* ---- the shape BREPcode writes ------------------------------------------- */
const BREPCODE = `<?xml version="1.0"?>
<model unit="millimeter">
 <resources>
  <m:colorgroup id="1">
   <m:color color="#F2F1EC"/>
   <m:color color="#101215"/>
   <m:color color="#E8890C"/>
  </m:colorgroup>
  <object id="2" type="model" name="U1 - #F2F1EC" pid="1" pindex="0"><mesh/></object>
  <object id="3" type="model" name="U1 - #101215" pid="1" pindex="1"><mesh/></object>
  <object id="4" type="model" name="U1 spool" pid="1" pindex="2"><mesh/></object>
  <object id="9" type="model" name="U1 assembly"><components/></object>
 </resources>
</model>`

eq([...colourGroups(BREPCODE).get('1')], ['#f2f1ec', '#101215', '#e8890c'], 'colorgroup read in order')
const parts = partColours(BREPCODE)
eq(parts.length, 3, 'only objects that resolve to a colour come back')
eq(parts.map(p => p.hex), ['#f2f1ec', '#101215', '#e8890c'], 'each object gets its pindex colour')
eq(parts.find(p => p.name === 'U1 spool')?.via, 'pindex',
  'a name with no hex still resolves through pid/pindex')
ok(!parts.some(p => p.name === 'U1 assembly'), 'an object with no colour is skipped')

/* ---- core basematerials, the other exporter convention ------------------- */
const BASEMAT = `<model><resources>
 <basematerials id="7">
  <base name="PLA red" displaycolor="#D93A2BFF"/>
  <base name="PLA blue" displaycolor="#2C6BB0FF"/>
 </basematerials>
 <object id="2" name="body" pid="7" pindex="1"><mesh/></object>
</resources></model>`
eq(colourGroups(BASEMAT).get('7'), ['#d93a2b', '#2c6bb0'], 'basematerials displaycolor, alpha stripped')
eq(partColours(BASEMAT).map(p => p.hex), ['#2c6bb0'], 'object indexes into basematerials')

/* ---- the fallbacks and the refusals -------------------------------------- */
eq(partColours('<model><resources><object id="2" name="lid - #ABCDEF"><mesh/></object></resources></model>')
  .map(p => [p.hex, p.via]), [['#abcdef', 'name']], 'falls back to a hex in the name')
eq(partColours('<model><resources><object id="2" pid="1" pindex="0"><mesh/></object></resources></model>'), [],
  'an unnamed object is skipped, never guessed by order')
eq(partColours('<model><resources><object id="2" name="x" pid="1" pindex="9"><mesh/></object></resources></model>'), [],
  'a pindex past the end of the group is ignored')
eq(partColours(''), [], 'empty xml yields nothing')
eq(partColours('<model><resources/></model>'), [], 'no objects yields nothing')

/* a duplicate name would map two different colours onto the same meshes */
eq(partColours(`<model><resources>
  <m:colorgroup id="1"><m:color color="#111111"/><m:color color="#222222"/></m:colorgroup>
  <object id="2" name="dup" pid="1" pindex="0"><mesh/></object>
  <object id="3" name="dup" pid="1" pindex="1"><mesh/></object>
 </resources></model>`).map(p => p.hex), ['#111111'], 'first name wins, no ambiguous repaint')

/* ---- archive entry choice ------------------------------------------------ */
eq(pickModelEntry(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model', 'Metadata/x.config']),
  '3D/3dmodel.model', 'picks the 3D model part')
eq(pickModelEntry(['weird/place.model']), 'weird/place.model', 'falls back to any .model')
eq(pickModelEntry(['nothing.txt']), null, 'no model part')

console.log(`\n${fail ? '✗' : '✓'} ${fail ? 'FAILURES' : 'ALL CHECKS PASSED'} - ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
