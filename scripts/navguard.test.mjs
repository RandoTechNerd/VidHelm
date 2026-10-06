// Tests for the editor window's navigation guard (electron/navguard.ts). Run with: npm run test:navguard
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'electron', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const N = await load('navguard.ts')
let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }

const packaged = { indexUrl: pathToFileURL('C:\\Program Files\\VidHelm\\resources\\app.asar\\dist\\index.html').href }
const dev = { devServer: 'http://localhost:5173/' }

console.log('the packaged app')
ok(N.isAppNavigation(packaged.indexUrl, packaged), 'its own index.html')
ok(N.isAppNavigation(packaged.indexUrl + '#tour', packaged), 'its own page with a hash')
ok(N.isAppNavigation(packaged.indexUrl.replace('Program%20Files', 'program%20files'), packaged), 'path case does not matter on Windows')
ok(!N.isAppNavigation(pathToFileURL('C:\\Users\\me\\Downloads\\page.html').href, packaged), 'a dropped .html file is refused')
ok(!N.isAppNavigation(pathToFileURL('C:\\Users\\me\\Videos\\clip.mp4').href, packaged), 'a dropped video file is refused')
ok(!N.isAppNavigation('https://example.com/', packaged), 'a web page is refused')
ok(!N.isAppNavigation('http://localhost:5173/', packaged), 'a dev server is refused when there is none')

console.log('development')
ok(N.isAppNavigation('http://localhost:5173/', dev) && N.isAppNavigation('http://localhost:5173/index.html?x=1', dev), 'the dev server origin')
ok(!N.isAppNavigation('http://localhost:5174/', dev) && !N.isAppNavigation('http://127.0.0.1:5173/', dev), 'another port or host is refused')
ok(!N.isAppNavigation('file:///C:/evil.html', dev), 'a file is refused')
ok(!N.isAppNavigation('not a url', dev) && !N.isAppNavigation('', packaged), 'garbage is refused')
ok(!N.isAppNavigation('javascript:alert(1)', { ...dev, ...packaged }), 'javascript: is refused')

console.log('links that ask for a new window')
ok(N.externalLink('https://vidhelm.com/docs') === 'https://vidhelm.com/docs', 'https goes to the browser')
ok(N.externalLink('http://example.com') === null, 'plain http is dropped')
ok(N.externalLink('file:///C:/Windows/System32/calc.exe') === null && N.externalLink('ms-settings:privacy') === null, 'file: and other schemes are dropped')
ok(N.externalLink('nonsense') === null, 'garbage is dropped')

console.log(`\n${fail ? 'FAILED' : 'ALL PASSED'} - ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
