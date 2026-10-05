// Runs a TypeScript test file with nothing but what the repo already has: esbuild bundles the test
// together with the module it tests, for Node, and the bundle is imported straight from memory,
// the way scripts/grid.test.mjs loads electron/grid.ts. (These suites used to need tsx, which is
// not a dependency, so they never ran in npm test.)
// Usage: node scripts/run-ts-test.mjs electron/cloudimport.test.ts
import { build } from 'esbuild'
import path from 'node:path'

const file = process.argv[2]
if (!file) { console.error('usage: node scripts/run-ts-test.mjs <file.test.ts>'); process.exit(2) }
const out = await build({ entryPoints: [path.resolve(file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18', logLevel: 'error' })
await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
