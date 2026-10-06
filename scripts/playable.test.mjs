// Standalone tests for the proxy planner (electron/playable.ts). Run: npm run test:playable
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = await build({ entryPoints: [path.join(here, '..', 'electron', 'playable.ts')], bundle: false, write: false, format: 'esm', target: 'node18' })
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
const { isHdr, isHighBitDepth, planProxy, proxyFilter, proxyKey, HDR_TO_SDR, canHwDecode, proxyAttempts, proxyArgs, isCurrentProxy, needsReprobe, PROXY_GEN, isRealVideo, isStillFormat, probeDuration, lastStatsTime } = mod

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
ok(/^v2-PXL-20260816-231154028-[a-z0-9]+\.mp4$/.test(k1), 'key stays readable in the folder, behind the generation')
ok(proxyKey('C:/x/wéird nàme (1).mov', 1, 1).endsWith('.mp4'), 'awkward names are sanitised')
ok(HDR_TO_SDR.includes('tonemap'), 'export shares the same tone-map chain')
ok(/^v2-PXL-20260816-231154028-/.test(proxyKey('C:\\Users\\me\\Videos\\PXL_20260816_231154028.mp4', 1, 1)), 'a Windows path is named after the file, not after C:\\Users')
ok(isCurrentProxy('C:\\Users\\me\\AppData\\Roaming\\vidhelm\\proxies\\' + k1), 'a copy with this generation\'s name is current')
ok(!isCurrentProxy('C:\\Users\\me\\AppData\\Roaming\\vidhelm\\proxies\\PXL-20260816-231154028-abc.mp4'), 'one from before the generation prefix is rebuilt')
ok(!isCurrentProxy(undefined) && !isCurrentProxy(''), 'no copy is not a current copy')
eq(PROXY_GEN, 'v2-', 'generation 2: one keyframe a second')

console.log('\n-- phones and cameras: rotation, 10-bit, ProRes --')
// what get-metadata reports for the real files (sizes as displayed)
const rotPhone = { videoCodec: 'h264', pixFmt: 'yuv420p', width: 1080, height: 1920, fps: 30, hasVideo: true, rotation: 90, colorTransfer: 'bt709' }
const hevc10 = { videoCodec: 'hevc', pixFmt: 'yuv420p10le', width: 1080, height: 1920, fps: 30, hasVideo: true, rotation: 90 }
const prores = { videoCodec: 'prores', pixFmt: 'yuv422p10le', width: 1920, height: 1080, fps: 30, hasVideo: true }
const sony422 = { videoCodec: 'h264', pixFmt: 'yuv422p10le', width: 1920, height: 1080, fps: 30, hasVideo: true }
const pxl = { videoCodec: 'hevc', pixFmt: 'yuv420p10le', colorTransfer: 'arib-std-b67', width: 2160, height: 3840, fps: 29.94, hasVideo: true, rotation: 90 }
ok(!planProxy(rotPhone).needed, 'an ordinary rotated h264 phone clip plays without a copy')
ok(planProxy(hevc10).tenBit && !planProxy(hevc10).hdr, '10-bit SDR HEVC is ten-bit but not HDR')
ok(proxyFilter(planProxy(hevc10), true).startsWith('hwdownload,format=p010le'), '...so the GPU frame comes down as P010 (NV12 failed the filter: 0 byte proxy)')
ok(proxyFilter(planProxy({ ...plain, width: 3840, fps: 120 }), true).startsWith('hwdownload,format=nv12'), '8-bit footage still comes down as NV12')
ok(proxyFilter(planProxy(hevc10), true).includes('transpose=clock'), 'the GPU path turns a rotated clip upright itself')
ok(!proxyFilter(planProxy(hevc10), false).includes('transpose'), 'the software path leaves turning to ffmpeg (autorotate)')
ok(/scale=1920:-2.*transpose=clock/.test(proxyFilter(planProxy(hevc10), true)), 'GPU frames are scaled as stored (1920 wide, landscape), then turned')
ok(proxyFilter(planProxy({ ...hevc10, rotation: 180 }), true).includes('hflip,vflip') && proxyFilter(planProxy({ ...hevc10, rotation: 270 }), true).includes('transpose=cclock'), '180 and 270 turn the right way')
ok(planProxy(pxl).hdr && planProxy(pxl).portrait && planProxy(pxl).long === 1920, 'a Pixel portrait HLG clip: HDR, portrait, 1920 on the long side')

console.log('\n-- what the GPU may decode --')
ok(canHwDecode('h264', 'yuv420p') && canHwDecode('hevc', 'yuv420p') && canHwDecode('hevc', 'yuv420p10le'), 'h264 8-bit and HEVC 8/10-bit 4:2:0 decode on the GPU')
ok(canHwDecode('av1', 'yuv420p10le') && canHwDecode('vp9', 'yuv420p'), 'AV1 and VP9 4:2:0 too')
ok(!canHwDecode('prores', 'yuv422p10le') && !canHwDecode('dnxhd', 'yuv422p'), 'ProRes and DNxHR do not (they wrote 0 byte proxies)')
ok(!canHwDecode('h264', 'yuv422p10le') && !canHwDecode('h264', 'yuv420p10le'), 'nor 4:2:2 or 10-bit H.264 (Sony XAVC S, some Canons)')
ok(!canHwDecode('hevc', 'yuv422p10le') && !canHwDecode(undefined, undefined), 'nor 4:2:2 HEVC, nor an unknown codec')

console.log('\n-- the retry ladder --')
const labels = list => list.map(a => `${a.video}${a.hwDecode ? '+hw' : ''}`).join(' > ')
eq(labels(proxyAttempts('h264_qsv', hevc10, {})), 'h264_qsv+hw > h264_qsv > libx264', 'HEVC on Quick Sync: GPU both ways, then software decode, then x264')
eq(labels(proxyAttempts('h264_qsv', prores, {})), 'h264_qsv > libx264', 'ProRes on Quick Sync never asks the GPU to decode it')
eq(labels(proxyAttempts('h264_qsv', sony422, {})), 'h264_qsv > libx264', 'nor does 4:2:2 10-bit H.264')
eq(labels(proxyAttempts('libx264', hevc10, {})), 'libx264', 'a machine with no GPU encoder has one way')
eq(labels(proxyAttempts('h264_amf', hevc10, {})), 'h264_amf > libx264', 'AMF has no decoder wired up, so no GPU-decode rung that would only repeat the next one')
eq(labels(proxyAttempts('h264_nvenc', hevc10, {})), 'h264_nvenc+hw > h264_nvenc > libx264', 'NVENC gets the same ladder')
eq(labels(proxyAttempts('h264_qsv', plain, { remux: true })), 'copy > h264_qsv+hw > h264_qsv > libx264', 'a remux tries the copy first and can still fall back to encoding')
ok(proxyAttempts('h264_qsv', hevc10, {}).every(a => a.label && !/\u2014/.test(a.label)), 'every rung has a name for the error message')

console.log('\n-- the ffmpeg command --')
const hwArgs = proxyArgs('in.mov', 'out.part.mp4', planProxy(hevc10), proxyAttempts('h264_qsv', hevc10, {})[0])
const swArgs = proxyArgs('in.mov', 'out.part.mp4', planProxy(hevc10), proxyAttempts('h264_qsv', hevc10, {})[1])
const at = (args, flag) => args[args.indexOf(flag) + 1]
ok(at(hwArgs, '-hwaccel') === 'qsv' && hwArgs.indexOf('-hwaccel') < hwArgs.indexOf('-i'), 'the GPU rung asks for Quick Sync decoding, before the input')
ok(at(hwArgs, '-vf').startsWith('hwdownload'), '...and pulls its frames down')
ok(!swArgs.includes('-hwaccel') && !at(swArgs, '-vf').includes('hwdownload'), 'the software-decode rung drops both')
eq(at(swArgs, '-c:v'), 'h264_qsv', '...but keeps the GPU encoder')
ok(!hwArgs.includes('-noautorotate') && !swArgs.includes('-noautorotate'), 'no -noautorotate: it copies the rotate flag onto an already upright copy')
eq(at(hwArgs, '-g'), '30', 'a keyframe every second at 30 fps')
eq(at(proxyArgs('a', 'b', planProxy(pixel), { video: 'libx264', hwDecode: false, label: 'x' }), '-g'), '60', '...and at 60 fps')
eq(at(proxyArgs('a', 'b', planProxy(pxl), { video: 'libx264', hwDecode: false, label: 'x' }), '-g'), '30', '29.94 fps rounds to 30')
eq(at(hwArgs, '-bf'), '0', 'no B-frames, so a scrub decodes forward only')
eq(at(proxyArgs('a', 'b', planProxy(hevc10), { video: 'libx264', hwDecode: false, label: 'x' }), '-crf'), '24', 'x264 keeps its CRF 24 quality')
eq(hwArgs[hwArgs.length - 1], 'out.part.mp4', 'writes to the temp name it is given')
const cuda = proxyArgs('a', 'b', planProxy(hevc10), proxyAttempts('h264_nvenc', hevc10, {})[0])
ok(at(cuda, '-hwaccel') === 'cuda' && !at(cuda, '-vf').includes('hwdownload') && !at(cuda, '-vf').includes('transpose'), 'CUDA hands frames back in memory: no hwdownload, ffmpeg turns them')

console.log('\n-- probe facts --')
ok(isRealVideo({ codec_type: 'video', disposition: { attached_pic: 0 } }), 'a picture track is video')
ok(!isRealVideo({ codec_type: 'video', disposition: { attached_pic: 1 } }), 'a song\'s album art is not')
ok(!isRealVideo({ codec_type: 'audio' }) && !isRealVideo(undefined), 'audio and nothing are not')
ok(isStillFormat('png_pipe') && isStillFormat('image2') && isStillFormat('webp_pipe'), 'still pictures are recognised by format')
ok(!isStillFormat('matroska,webm') && !isStillFormat('mov,mp4,m4a,3gp,3g2,mj2') && !isStillFormat(undefined), '...and recordings are not')
eq(probeDuration({ duration: 12.5 }, []), 12.5, 'the container\'s length when it has one')
eq(probeDuration({ duration: 'N/A' }, [{ duration: 'N/A' }, { duration: 47.9 }, { duration: 48.02 }]), 48.02, 'else the longest stream')
eq(probeDuration({ duration: 'N/A' }, [{ duration: 'N/A' }, null]), null, 'a crashed MKV with no lengths anywhere says so (was the string "N/A")')
eq(probeDuration(undefined, undefined), null, 'nothing at all does not crash')
eq(lastStatsTime('frame=1 time=00:00:01.00 \rframe=2 time=00:00:48.00 bitrate=N/A'), 48, 'the last time= wins')
eq(lastStatsTime('size=N/A time=01:02:03.50 bitrate'), 3723.5, 'hours and minutes count')
eq(lastStatsTime('time=-00:00:00.02 x'), null, 'a negative start time is not progress')
eq(lastStatsTime('nothing here'), null, 'no time=, no answer')

console.log('\n-- broken recordings --')
const crashed = { videoCodec: 'h264', pixFmt: 'yuv420p', width: 1280, height: 720, fps: 30, hasVideo: true, needsRemux: true, duration: 48 }
ok(planProxy(crashed).needed && planProxy(crashed).remux, 'a cut-off h264 recording gets a copy, made by remuxing')
ok(/never finished/.test(planProxy(crashed).reason), 'and the reason says what happened')
ok(planProxy({ ...crashed, videoCodec: 'hevc' }).needed && !planProxy({ ...crashed, videoCodec: 'hevc' }).remux, 'a cut-off HEVC one is re-encoded anyway (the preview cannot decode it)')
const copy = proxyArgs('in.mkv', 'out.part.mp4', planProxy(crashed), { video: 'copy', hwDecode: false, label: 'copy' })
ok(at(copy, '-c:v') === 'copy' && !copy.includes('-vf') && !copy.includes('-g'), 'the remux copies the picture: no filter, no re-encode')
eq(at(copy, '-c:a'), 'aac', 'and turns the sound into AAC, which every MP4 takes')

console.log('\n-- HDR is only HLG and PQ --')
ok(!isHdr({ colorTransfer: 'bt2020-10' }) && !isHdr({ colorTransfer: 'bt2020-12' }), '10/12-bit BT.2020 SDR is not tone-mapped (it came out darker and flat)')
ok(!isHdr({ colorTransfer: 'smpte428' }), 'nor cinema XYZ')

console.log('\n-- what an opened project probes again --')
{
  const proxy = PROXY_GEN + 'clip-abc.mp4'
  const full = { type: 'video', hasAudio: true, hdr: false, fps: 30, width: 1080, height: 1920, audioChannels: 2 }
  ok(!needsReprobe(full), 'footage the save knows everything about is not probed on every open')
  ok(!needsReprobe({ ...full, proxyPath: proxy, proxyWidth: 1080, proxyHeight: 1920, proxyFps: 30 }), '...nor with a measured, current preview copy')
  ok(needsReprobe({ ...full, width: undefined, height: undefined }), 'a clip saved before frame sizes were kept is (the portrait offer reads it)')
  ok(needsReprobe({ ...full, audioChannels: undefined }), 'so is one without its channel count')
  ok(!needsReprobe({ ...full, hasAudio: false, audioChannels: undefined }), '...unless it has no sound to count')
  const wav = { type: 'audio', hasAudio: true }
  ok(needsReprobe(wav), 'a lav mic WAV saved without its channel count is probed (the export level rule reads it)')
  ok(!needsReprobe({ ...wav, audioChannels: 1 }), '...once, then never again')
  ok(!needsReprobe({ ...wav, audioChannels: 2, hdr: undefined, fps: undefined }), 'sound has no HDR flag or frame rate to miss')
  ok(!needsReprobe({ type: 'image', hasAudio: false }), 'a still has nothing to probe')
  ok(!needsReprobe({ ...wav, offline: true }), 'a missing file is not probed')
  ok(needsReprobe({ ...full, hdr: undefined }) && needsReprobe({ ...full, fps: undefined }), 'the HDR flag and frame rate are still backfilled')
  ok(needsReprobe({ ...full, proxyPath: 'clip-abc.mp4', proxyWidth: 1, proxyHeight: 1, proxyFps: 1 }), 'an older generation\'s copy is rebuilt')
  ok(needsReprobe({ ...full, proxyPath: proxy }), 'a copy with no measured size is measured')
  ok(needsReprobe({ ...full, proxyNote: 'HEVC' }), 'a copy that was needed and is gone is rebuilt')
}

console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✗ FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
