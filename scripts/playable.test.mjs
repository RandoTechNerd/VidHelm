// Standalone tests for the proxy planner (electron/playable.ts). Run: npm run test:playable
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = await build({ entryPoints: [path.join(here, '..', 'electron', 'playable.ts')], bundle: false, write: false, format: 'esm', target: 'node18' })
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
const { isHdr, isHighBitDepth, planProxy, proxyFilter, proxyKey, HDR_TO_SDR } = mod

let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }
const eq = (a, b, l) => ok(a === b, `${l} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)

// the exact file that started this: a Pixel recording that imported fine and previewed as nothing
const pixel = { videoCodec: 'hevc', pixFmt: 'yuv420p10le', colorTransfer: 'arib-std-b67', width: 3840, height: 2160, fps: 120, hasVideo: true }
const plain = { videoCodec: 'h264', pixFmt: 'yuv420p', colorTransfer: 'bt709', width: 1920, height: 1080, fps: 30, hasVideo: true }

console.log('\n-- the phone clip --')
ok(planProxy(pixel).needed, 'the Pixel HEVC 10-bit HDR clip needs a proxy')
ok(planProxy(pixel).hdr, 'and is flagged as HDR so colours get converted')
eq(planProxy(pixel).width, 1920, 'proxy is capped at 1080p wide')
eq(planProxy(pixel).fps, 60, 'and at 60 fps, so 120 fps footage keeps its duration')
ok(/HEVC/.test(planProxy(pixel).reason), 'reason names the codec for the user')

console.log('\n-- ordinary footage is left alone --')
ok(!planProxy(plain).needed, 'plain 1080p30 h264 needs nothing')
ok(!planProxy({ ...plain, width: 1280, height: 720, fps: 60 }).needed, '720p60 needs nothing')
ok(!planProxy({ ...plain, videoCodec: 'vp9' }).needed, 'vp9 plays natively')
ok(!planProxy({ ...plain, videoCodec: 'av1' }).needed, 'av1 plays natively')
ok(!planProxy({ hasVideo: false }).needed, 'audio-only files are not proxied')

console.log('\n-- the other ways a preview goes black --')
ok(planProxy({ ...plain, videoCodec: 'prores' }).needed, 'ProRes needs a proxy')
ok(planProxy({ ...plain, videoCodec: 'dnxhd' }).needed, 'DNxHD needs a proxy')
ok(planProxy({ ...plain, videoCodec: 'mpeg2video' }).needed, 'MPEG-2 needs a proxy')
ok(planProxy({ ...plain, pixFmt: 'yuv422p10le' }).needed, '10-bit h264 needs a proxy')
ok(planProxy({ ...plain, colorTransfer: 'smpte2084' }).needed, 'PQ HDR needs a proxy even in h264')
ok(!planProxy({ ...plain, colorTransfer: 'smpte2084' }).reason.includes('decode'), 'and says it is about colour, not decoding')
ok(planProxy({ ...plain, width: 3840, fps: 120 }).needed, '4K120 h264 is proxied for speed even though it decodes')
ok(/scrubbing/.test(planProxy({ ...plain, width: 3840, fps: 120 }).reason), 'and says why: scrubbing')
ok(!planProxy({ ...plain, width: 3840, fps: 30 }).needed, 'plain 4K30 is left alone, it plays fine')

console.log('\n-- bit depth + hdr helpers --')
ok(isHighBitDepth('yuv420p10le'), '10-bit detected')
ok(isHighBitDepth('yuv444p12be'), '12-bit detected')
ok(!isHighBitDepth('yuv420p'), '8-bit is fine')
ok(!isHighBitDepth(undefined), 'missing pix_fmt does not crash')
ok(isHdr({ colorTransfer: 'arib-std-b67' }), 'HLG is HDR')
ok(isHdr({ colorTransfer: 'SMPTE2084' }), 'PQ is HDR, case-insensitively')
ok(!isHdr({ colorTransfer: 'bt709' }), 'bt709 is not HDR')

console.log('\n-- the filter chain --')
const hdrChain = proxyFilter(planProxy(pixel), true)
ok(hdrChain.indexOf('scale=1920') < hdrChain.indexOf('tonemap'), 'scales before tone mapping (measured a third faster)')
ok(hdrChain.startsWith('hwdownload'), 'pulls the frame off the GPU first when decoding in hardware')
ok(hdrChain.includes('zscale=p=bt709:t=bt709:m=bt709:r=tv'), 'lands in bt709 for the preview')
ok(!proxyFilter(planProxy({ ...plain, width: 3840, fps: 120 }), false).includes('tonemap'), 'no tone mapping for SDR footage')
ok(!proxyFilter(planProxy(pixel), false).includes('hwdownload'), 'no hwdownload when decoding in software')

console.log('\n-- proxy cache key --')
const k1 = proxyKey('C:/x/PXL_20260816_231154028.mp4', 5192445348, 1000)
eq(k1, proxyKey('C:/x/PXL_20260816_231154028.mp4', 5192445348, 1000), 'same file gives the same key, so it converts once')
ok(k1 !== proxyKey('C:/x/PXL_20260816_231154028.mp4', 5192445348, 2000), 'an edited file gets a new key')
ok(k1 !== proxyKey('C:/y/PXL_20260816_231154028.mp4', 5192445348, 1000), 'same name in another folder is not confused')
ok(/^PXL-20260816-231154028-[a-z0-9]+\.mp4$/.test(k1), 'key stays readable in the folder')
ok(proxyKey('C:/x/wéird nàme (1).mov', 1, 1).endsWith('.mp4'), 'awkward names are sanitised')
ok(HDR_TO_SDR.includes('tonemap'), 'export shares the same tone-map chain')

console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✗ FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
