// Tests for free sound-library search (electron/sfxsearch.ts). No network: the fixtures below
// are trimmed copies of real responses captured from each provider.
// Run with: npm run test:sfxsearch

import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = await build({
  entryPoints: [path.join(here, '..', 'electron', 'sfxsearch.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18',
})
const M = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
const { classifyLicense, isSafeForYouTube, freesoundUrl, commonsUrl, parseFreesound, parseCommons, attributionLine, safeFilename, rank, collate } = M

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  PASS ', label) } else { fail++; console.log('  FAIL ', label) } }
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

console.log('\n-- reading licences --')
eq(classifyLicense('http://creativecommons.org/publicdomain/zero/1.0/').code, 'cc0', 'a CC0 url')
eq(classifyLicense('Creative Commons 0').code, 'cc0', 'Freesound wording for CC0')
eq(classifyLicense('CC0').code, 'cc0', 'the short form')
eq(classifyLicense('Public domain').code, 'pd', 'plain public domain')
eq(classifyLicense('Attribution').code, 'by', 'Freesound wording for CC BY')
eq(classifyLicense('CC BY 4.0').code, 'by', 'Commons wording for CC BY')
eq(classifyLicense('CC BY-SA 4.0').code, 'by-sa', 'share alike is spotted')
eq(classifyLicense('Attribution Noncommercial').code, 'by-nc', 'non-commercial is spotted')
eq(classifyLicense('Attribution NonCommercial ShareAlike 3.0').code, 'by-nc',
  'non-commercial wins over share-alike: the stricter term is the one that matters')
eq(classifyLicense('Sampling+').code, 'sampling+', 'Sampling+ is its own thing')
eq(classifyLicense('').code, 'unknown', 'an empty licence is unknown')
eq(classifyLicense(null).code, 'unknown', 'a missing licence is unknown')
eq(classifyLicense('some bespoke wording').code, 'unknown', 'wording we do not recognise stays unknown')

console.log('\n-- what is safe to publish --')
ok(isSafeForYouTube(classifyLicense('CC0')), 'CC0 is fine')
ok(isSafeForYouTube(classifyLicense('Attribution')), 'CC BY is fine (with a credit)')
ok(isSafeForYouTube(classifyLicense('CC BY-SA 4.0')), 'CC BY-SA is fine commercially')
ok(!isSafeForYouTube(classifyLicense('Attribution Noncommercial')), 'CC BY-NC is not')
ok(!isSafeForYouTube(classifyLicense('')), 'and neither is a sound with no stated licence')
ok(classifyLicense('CC0').needsAttribution === false, 'CC0 needs no credit')
ok(classifyLicense('Attribution').needsAttribution === true, 'CC BY does')
ok(classifyLicense('CC BY-SA 4.0').shareAlike === true, 'share-alike is flagged')

console.log('\n-- building requests --')
{
  const u = new URL(freesoundUrl('coffee beans', 'TOK123'))
  eq(u.origin + u.pathname, 'https://freesound.org/apiv2/search/text/', 'the documented endpoint')
  eq(u.searchParams.get('query'), 'coffee beans', 'the query goes through')
  eq(u.searchParams.get('token'), 'TOK123', 'the token is attached')
  ok(u.searchParams.get('filter').includes('duration:[0.15 TO 15]'), 'duration is bounded so music stays out')
  ok(u.searchParams.get('filter').includes('license:'), 'and unusable licences are filtered server-side')
  ok(u.searchParams.get('fields').includes('previews'), 'previews are requested, since that is what we play')
}
{
  const u = new URL(freesoundUrl('door', 'T', { safeOnly: false, maxSeconds: 4 }))
  ok(!u.searchParams.get('filter').includes('license:'), 'the licence filter can be turned off')
  ok(u.searchParams.get('filter').includes('TO 4'), 'and the duration bound is settable')
}
{
  const u = new URL(commonsUrl('coffee pour'))
  eq(u.origin + u.pathname, 'https://commons.wikimedia.org/w/api.php', 'the Commons endpoint')
  ok(u.searchParams.get('gsrsearch').startsWith('filetype:audio'), 'it asks for audio only')
  ok(u.searchParams.get('iiprop').includes('extmetadata'), 'and for the metadata that carries the licence')
  ok(!u.toString().includes('token'), 'no key is involved')
}

console.log('\n-- parsing Freesound --')
{
  const fixture = {
    count: 2,
    results: [
      { id: 316847, name: 'Coffee beans pour.wav', tags: ['coffee', 'beans', 'pour'], license: 'Creative Commons 0', duration: 3.44, username: 'beanmic', url: 'https://freesound.org/s/316847/', previews: { 'preview-hq-mp3': 'https://cdn.freesound.org/previews/316/316847_hq.mp3', 'preview-lq-mp3': 'https://cdn.freesound.org/previews/316/316847_lq.mp3' } },
      { id: 22, name: 'no preview here', tags: [], license: 'Attribution', duration: 1, username: 'x', previews: {} },
    ],
  }
  const hits = parseFreesound(fixture)
  eq(hits.length, 1, 'a result with no preview is dropped rather than shown as broken')
  eq(hits[0].name, 'Coffee beans pour.wav', 'the name comes through')
  eq(hits[0].license.code, 'cc0', 'the licence is classified')
  eq(hits[0].seconds, 3.44, 'the duration comes through')
  eq(hits[0].author, 'beanmic', 'and the author, for the credit line')
  ok(hits[0].audioUrl.includes('_hq.mp3'), 'the better preview is preferred')
}
eq(parseFreesound({}).length, 0, 'an empty response is not a crash')
eq(parseFreesound({ results: null }).length, 0, 'nor is a null result set')

console.log('\n-- parsing Commons --')
{
  // shape captured from a real call
  const fixture = { query: { pages: {
    '123': {
      pageid: 123, title: 'File:CoffeeBrewing.wav',
      imageinfo: [{ url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/CoffeeBrewing.wav', mime: 'audio/wav',
        extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: '<a href="/wiki/User:Someone">Someone</a>' } } }],
    },
    '124': { pageid: 124, title: 'File:Broken.ogg' },
  } } }
  const hits = parseCommons(fixture)
  eq(hits.length, 1, 'a page with no file info is skipped')
  eq(hits[0].name, 'CoffeeBrewing', 'the File: prefix and extension are stripped')
  eq(hits[0].license.code, 'by-sa', 'the licence is read from extmetadata')
  eq(hits[0].author, 'Someone', 'the author is de-HTMLed for the credit line')
}
eq(parseCommons({}).length, 0, 'an empty Commons response is not a crash')

console.log('\n-- credit lines --')
{
  const cc0 = { provider: 'freesound', id: '1', name: 'Beans', seconds: 2, author: 'bob', license: classifyLicense('CC0'), audioUrl: 'x.mp3', pageUrl: 'https://freesound.org/s/1/', tags: [] }
  eq(attributionLine(cc0), '', 'CC0 needs no credit line')
  const by = { ...cc0, license: classifyLicense('Attribution') }
  const line = attributionLine(by)
  ok(line.includes('Beans') && line.includes('bob') && line.includes('freesound.org/s/1/'), 'CC BY produces a pasteable credit')
  ok(line.includes('CC BY'), 'and names the licence')
}

console.log('\n-- filenames --')
{
  const h = { provider: 'freesound', id: '99', name: 'Door: open/close *test*', seconds: 1, author: 'a', license: classifyLicense('CC0'), audioUrl: 'https://x/y.mp3', pageUrl: '', tags: [] }
  const f = safeFilename(h)
  ok(!/[<>:"/\\|?*]/.test(f), `no characters Windows will refuse (${f})`)
  ok(f.endsWith('.mp3'), 'the extension survives')
  ok(f.includes('freesound-99'), 'and it says where it came from, so credits can be traced later')
}
{
  const h = { provider: 'commons', id: '1', name: 'x'.repeat(200), seconds: 1, author: 'a', license: classifyLicense('CC0'), audioUrl: 'https://x/y.ogg?download', pageUrl: '', tags: [] }
  ok(safeFilename(h).length < 100, 'a very long name is trimmed')
  ok(safeFilename(h).endsWith('.ogg'), 'an extension with a query string still parses')
}

console.log('\n-- ranking and collating --')
{
  const mk = (over) => ({ provider: 'freesound', id: '1', name: 'x', seconds: 2, author: 'a', license: classifyLicense('CC0'), audioUrl: 'a.mp3', pageUrl: '', tags: [], ...over })
  const hits = [
    mk({ id: '1', name: 'random ambience', tags: [] }),
    mk({ id: '2', name: 'coffee beans pouring', tags: ['coffee'] }),
    mk({ id: '3', name: 'coffee grinder', tags: [] }),
  ]
  eq(rank(hits, 'coffee beans')[0].id, '2', 'the best name match comes first')
}
{
  const mk = (over) => ({ provider: 'freesound', id: '1', name: 'coffee', seconds: 2, author: 'a', license: classifyLicense('CC0'), audioUrl: 'a.mp3', pageUrl: '', tags: [], ...over })
  const ranked = rank([mk({ id: '1', license: classifyLicense('Attribution') }), mk({ id: '2', license: classifyLicense('CC0') })], 'coffee')
  eq(ranked[0].id, '2', 'all else equal, the one needing no credit wins')
}
{
  const mk = (over) => ({ provider: 'freesound', id: '1', name: 'door', seconds: 2, author: 'a', license: classifyLicense('CC0'), audioUrl: 'a.mp3', pageUrl: '', tags: [], ...over })
  const merged = collate([[mk({ id: '1' })], [mk({ id: '1' }), mk({ id: '2', provider: 'commons' })]], 'door')
  eq(merged.length, 2, 'the same sound from two lists appears once')
}
{
  const mk = (over) => ({ provider: 'freesound', id: '1', name: 'door', seconds: 2, author: 'a', license: classifyLicense('CC0'), audioUrl: 'a.mp3', pageUrl: '', tags: [], ...over })
  const unsafe = [mk({ id: '9', license: classifyLicense('Attribution Noncommercial') }), mk({ id: '8', license: classifyLicense('') })]
  eq(collate([unsafe], 'door').length, 0, 'non-commercial and unlicensed are hidden by default')
  eq(collate([unsafe], 'door', { safeOnly: false }).length, 2, 'and shown when asked for explicitly')
}

console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✗ FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
