import assert from 'node:assert/strict'
import { pickModels, estimateUsd, videoGenAvailable, generateClip, GenTimeout, GEN_BUDGET_MS } from './videogen'
const none = {}, fal = { FAL_KEY: 'x' }, both = { FAL_KEY: 'x', GEMINI_API_KEY: 'y' }
const img = new ArrayBuffer(8)
assert.equal(videoGenAvailable(none), false); assert.equal(videoGenAvailable(fal), true)
assert.deepEqual(pickModels(none, { prompt: 'p', aspect: 'landscape' }), [])
// a transition needs an end-frame model: with fal only, Kling 2.1 first; with Gemini too, Veo 3.1 first
assert.equal(pickModels(fal, { prompt: 'p', image: img, lastImage: img, aspect: 'landscape' })[0], 'kling-2.1')
assert.equal(pickModels(both, { prompt: 'p', image: img, lastImage: img, aspect: 'landscape' })[0], 'veo-3.1')
// portrait transition: Kling 2.5 (landscape only) must not be offered
assert.ok(!pickModels(fal, { prompt: 'p', image: img, lastImage: img, aspect: 'portrait' }).includes('kling-2.5'))
// text only: Veo fast on fal first, then Kling 2.5; image-only models excluded
assert.deepEqual(pickModels(fal, { prompt: 'p', aspect: 'landscape' }), ['veo-3.1-fal', 'kling-2.5'])
// an explicit model wins when it fits
assert.equal(pickModels(fal, { prompt: 'p', image: img, aspect: 'landscape', model: 'luma-ray2' })[0], 'luma-ray2')
assert.equal(estimateUsd('kling-2.1', 5), 0.45)

/* A job that is still running when its time runs out must stop the chain: falling back to the next
 * model would submit (and pay for) a second clip while the first can still finish. Fake clock + fetch.
 * (An async IIFE rather than top-level await, so it runs the same bundled as ESM or as CommonJS.) */
;(async () => {
  const realFetch = globalThis.fetch, realTimeout = globalThis.setTimeout, realNow = Date.now
  let now = 1_000_000, submits = 0
  Date.now = () => now
  globalThis.setTimeout = ((fn: () => void, ms?: number) => { now += ms || 0; fn(); return 0 }) as unknown as typeof setTimeout
  globalThis.fetch = (async (url: string) => {
    if (String(url).startsWith('https://queue.fal.run/')) { submits++; return new Response(JSON.stringify({ status_url: 'https://q/s', response_url: 'https://q/r' })) }
    if (url === 'https://q/s') return new Response(JSON.stringify({ status: 'IN_PROGRESS' }))
    throw new Error('unexpected fetch ' + url)
  }) as typeof fetch
  try {
    // text-only with fal: two candidates (veo-3.1-fal, kling-2.5), but only the first may be submitted
    await assert.rejects(generateClip(fal, { prompt: 'p', aspect: 'landscape' }), (e: unknown) => e instanceof GenTimeout)
    assert.equal(submits, 1)
    assert.ok(now - 1_000_000 <= GEN_BUDGET_MS + 10_000, 'the whole call stays inside its budget')
    // too little budget left: nothing is submitted at all
    submits = 0
    assert.equal(await generateClip(fal, { prompt: 'p', aspect: 'landscape' }, 30_000), null)
    assert.equal(submits, 0)
  } finally { globalThis.fetch = realFetch; globalThis.setTimeout = realTimeout; Date.now = realNow }
})().then(() => console.log('videogen: ok'), e => { console.error(e); process.exit(1) })
