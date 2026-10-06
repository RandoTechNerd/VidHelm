// Tests for the Fix voice bake's files (electron/voicebake.ts): what a video's preview copy is made
// from, what the preview is told to play when no copy could be made, and the cache's size cap. The
// preview copies run the REAL bundled ffmpeg on a few seconds of generated picture and sound, because
// the failures here were silent: a FLAC handed to a <video> (voice audible, picture black) and every
// voice video copied whole into userData/voice. The chain itself is test:audiochain's.
// Run: npm run test:voicebake
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const out = await build({ entryPoints: [path.join(here, '..', 'electron', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const V = await load('voicebake.ts'), A = await load('audiochain.ts')
const FF = path.join(here, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
const FP = path.join(here, '..', 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-voicebake-'))
const T = (n) => path.join(tmp, n)

let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }
const ff = (args) => {
  const r = spawnSync(FF, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 })
  if (r.status !== 0) throw new Error(r.stderr.slice(-600))
  return r
}
/** codec, size and duration of each stream */
const streams = (file) => JSON.parse(spawnSync(FP, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,pix_fmt,duration', '-of', 'json', file], { encoding: 'utf8' }).stdout).streams
const video = (file) => streams(file).find((s) => s.codec_type === 'video')
const audio = (file) => streams(file).find((s) => s.codec_type === 'audio')
const MB = 1024 ** 2

try {
  console.log('\n-- what a preview copy is made from --')
  {
    ok(V.previewPicturePlan({ bytes: 40 * MB, isOriginal: true }) === 'copy', 'a small original is copied as it is (cheap, and the picture is untouched)')
    ok(V.previewPicturePlan({ bytes: 3.7 * 1024 * MB, isOriginal: true }) === 'small', 'a 3.7 GB 4K original gets a small picture, not a second 3.7 GB')
    ok(V.previewPicturePlan({ bytes: V.PREVIEW_COPY_MAX_BYTES, isOriginal: true }) === 'copy' && V.previewPicturePlan({ bytes: V.PREVIEW_COPY_MAX_BYTES + 1, isOriginal: true }) === 'small', `the line is ${V.PREVIEW_COPY_MAX_BYTES / MB} MB`)
    ok(V.previewPicturePlan({ bytes: 2 * 1024 * MB, isOriginal: false }) === 'copy', 'a proxy is always copied: it already is the small picture')
    const copy = V.previewCopyArgs('pic.mp4', 'v.flac', 'out.mp4', 'copy'), small = V.previewCopyArgs('pic.mp4', 'v.flac', 'out.mp4', 'small')
    const after = (a, k) => a[a.indexOf(k) + 1]
    ok(after(copy, '-c:v') === 'copy' && !copy.includes('-vf'), 'copy: the picture untouched')
    ok(after(small, '-c:v') === 'libx264' && after(small, '-pix_fmt') === 'yuv420p', 'small: 8-bit 4:2:0 H.264, which the preview decodes whatever the source was')
    ok(/min\(1280,iw\).*min\(1280,ih\).*force_original_aspect_ratio=decrease/.test(after(small, '-vf')), 'small: the long side capped at 1280, never enlarged')
    for (const [n, a] of [['copy', copy], ['small', small]]) {
      ok(after(a, '-map') === '0:v:0' && a[a.lastIndexOf('-map') + 1] === '1:a:0' && after(a, '-c:a') === 'aac' && after(a, '-b:a') === '256k' && a.includes('-stats'), `${n}: picture beside the bake as AAC 256k, with progress`)
    }
  }

  // speech-like sound: pink bursts (1 s on, 0.6 s off) over a quiet room, so the bake really runs
  const speech = T('speech.wav')
  ff(['-f', 'lavfi', '-i', "anoisesrc=color=pink:amplitude=0.08:duration=6:sample_rate=48000,volume='if(lt(mod(t\\,1.6)\\,1.0)\\,1\\,0.002)':eval=frame", '-ac', '2', '-c:a', 'pcm_s16le', speech])
  const ver = await V.readFfmpegVersion(FF)
  const cacheDir = T('voice')
  const bake = (filePath, picture) => V.bakeVoice({ ffmpeg: FF, ffprobe: FP, cacheDir, filePath, preset: 'studio', ffmpegVersion: ver, picture })
  const cached = (filePath, picture) => V.cachedBake({ cacheDir, filePath, preset: 'studio', ffmpegVersion: ver, picture })

  console.log('\n-- a picture MP4 cannot carry as it is (VP8 from Chrome\'s recorder) --')
  {
    const webm = T('talk.webm')
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=1600x900:rate=25:duration=6', '-i', speech, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '400k', '-c:a', 'libopus', '-b:a', '96k', webm])
    const r = await bake(webm, webm)
    ok(!r.error && r.path?.endsWith('.flac') && r.effective === 'studio', `the voice is baked (${r.error || path.basename(r.path || '')})`)
    ok(r.previewPath?.endsWith('.mp4') && !r.previewError, `the preview copy is made after all, not left to the FLAC (${path.basename(r.previewPath || '') || r.previewError})`)
    const v = r.previewPath && video(r.previewPath), a = r.previewPath && audio(r.previewPath)
    ok(v?.codec_name === 'h264' && v.width === 1280 && v.height === 720 && v.pix_fmt === 'yuv420p', `with the small picture: ${v?.codec_name} ${v?.width}x${v?.height} ${v?.pix_fmt}`)
    ok(a?.codec_name === 'aac' && Math.abs(Number(v?.duration) - 6) < 0.15, `and the bake beside it as AAC, the picture's whole length (${Number(v?.duration).toFixed(2)} s)`)
    const json = JSON.parse(fs.readFileSync(r.jsonPath, 'utf8'))
    ok(json.preview?.how === 'small' && json.preview.file === path.basename(r.previewPath || ''), 'the JSON records the copy and how it was made')
    const c = cached(webm, webm)
    ok(c?.cached && c.previewPath === r.previewPath, 'asked again it is the cached copy')
    // the cap's LRU reads the JSON's time: every use must move it
    const old = new Date(Date.now() - 86400_000)
    fs.utimesSync(r.jsonPath, old, old)
    cached(webm, webm)
    ok(Date.now() - fs.statSync(r.jsonPath).mtimeMs < 60_000, 'a cache hit marks the bake as used now')
  }

  console.log('\n-- an original the preview plays and MP4 carries is copied --')
  {
    const mp4 = T('camera.mp4')
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6', '-i', speech, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '128k', mp4])
    const r = await bake(mp4, mp4)
    const v = r.previewPath && video(r.previewPath)
    ok(!r.error && v?.codec_name === 'h264' && v.width === 640 && JSON.parse(fs.readFileSync(r.jsonPath, 'utf8')).preview?.how === 'copy', `copied as it is (${r.error || `${v?.width}x${v?.height}`})`)
    const noPic = await bake(mp4, null)
    ok(noPic.cached && noPic.previewPath === noPic.path && noPic.previewPath?.endsWith('.flac'), 'asked without a picture (an audio element, or the export) the answer is the FLAC')
  }

  console.log('\n-- no copy can be made: the preview is never handed the FLAC --')
  {
    const voice = T('voice.mp4')
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=6', '-i', speech, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', voice])
    // a "picture" with no picture in it: both the copy and the small picture fail
    const r = await bake(voice, speech)
    ok(!r.error && r.path?.endsWith('.flac'), 'the bake itself stands (the export reads it)')
    ok(r.previewPath === undefined && !!r.previewError, `previewPath is absent, not the FLAC, and previewError says why (${(r.previewError || '').split('\n')[0]})`)
    ok(!/frame=|size=/.test(r.previewError || ''), 'the reason is ffmpeg\'s complaint, not its progress lines')
    ok(cached(voice, speech) === null, 'a failed copy is not a cache hit: it is tried again (a fixed build may make it)')
    const again = await bake(voice, speech)
    ok(!again.cached && again.path === r.path && again.seconds === r.seconds && again.previewPath === undefined, 'trying again makes only the copy; the voice is not baked again')
    const fixed = await bake(voice, voice)
    ok(fixed.previewPath?.endsWith('.mp4') && !fixed.previewError && fixed.seconds === r.seconds, 'given a picture that works, the copy is made from the same bake')
    const audioOnly = cached(voice, null)
    ok(audioOnly?.previewPath === audioOnly?.path, 'without a picture the FLAC is still the answer')
  }

  console.log('\n-- the cache holds itself under its cap --')
  {
    const dir = T('prune')
    fs.mkdirSync(dir)
    const now = Date.now(), H = 3600_000
    const k = (name) => `${name}-studio-${(name.charCodeAt(0).toString(16) + '0'.repeat(16)).slice(0, 16)}`
    const put = (name, bytes, ageMs) => { const f = path.join(dir, name); fs.writeFileSync(f, Buffer.alloc(bytes)); const t = new Date(now - ageMs); fs.utimesSync(f, t, t) }
    /** a bake: JSON (its time = last used), FLAC, and a preview copy the JSON names */
    const entry = (name, ageH, { flac = 1000, mp4 = 0, v = A.CHAIN_VERSION } = {}) => {
      const key = k(name), copy = mp4 ? `${key}.0123abcd.mp4` : undefined
      put(`${key}.flac`, flac, ageH * H)
      if (copy) put(copy, mp4, ageH * H)
      fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ v, key, flac: `${key}.flac`, preview: copy ? { from: 'x', file: copy } : undefined }))
      const t = new Date(now - ageH * H); fs.utimesSync(path.join(dir, `${key}.json`), t, t)
      return key
    }
    const a = entry('alpha', 50, { mp4: 3000 }), b = entry('bravo', 40), c = entry('charlie', 30), d = entry('delta', 60), e = entry('echo', 0.01)
    const stale = entry('foxtrot', 1, { v: A.CHAIN_VERSION - 1 })
    put(`${b}.ffffffff.mp4`, 5000, 5 * H)         // an older picture's copy, no longer named
    put(`${c}.eeeeeeee.mp4`, 5000, 60_000)        // a copy just written: its JSON may be next
    put(`${k('golf')}.flac`, 7000, 5 * H)          // a FLAC whose JSON is gone
    put('alpha-sound-0123456789abcdef.json', 10, 99 * H)   // the measurement caches are not bakes
    put(`${k('hotel')}.part.flac`, 10, 99 * H)     // part files are sweepVoiceTemp's
    const has = (f) => fs.existsSync(path.join(dir, f))
    const r = V.pruneVoiceCache(dir, { maxBytes: 9000, keep: new Set([d]), now })
    ok(!has(`${b}.ffffffff.mp4`) && !has(`${k('golf')}.flac`) && !has(`${stale}.json`) && !has(`${stale}.flac`), 'what nothing can serve again goes first: an unnamed copy, a FLAC with no JSON, an older chain\'s bake')
    ok(has(`${c}.eeeeeeee.mp4`), 'but not a file younger than the grace (a bake may be between its FLAC and its JSON)')
    ok(!has(`${a}.json`) && !has(`${a}.flac`) && !has(`${a}.0123abcd.mp4`), 'over the cap, the bake used longest ago goes whole (JSON, FLAC and copy)')
    ok(has(`${d}.json`) && has(`${d}.flac`), 'never one asked for since the app started, however old')
    ok(has(`${e}.json`) && has(`${e}.flac`), 'nor one used in the last few minutes')
    ok(!has(`${b}.json`) && has(`${c}.json`) && has(`${c}.flac`), `then the next oldest, until it fits (${r.bytes} bytes left)`)
    ok(r.bytes <= 9000 && has('alpha-sound-0123456789abcdef.json') && has(`${k('hotel')}.part.flac`), 'and nothing that is not a bake is touched')
    const again = V.pruneVoiceCache(dir, { maxBytes: 1e9, keep: new Set(), now })
    ok(again.removed.length === 0, 'under the cap nothing more goes')
    ok(V.pruneVoiceCache(T('no-such-folder')).bytes === 0, 'no cache folder yet is not an error')
  }
} finally {
  if (!process.env.VIDHELM_KEEP) fs.rmSync(tmp, { recursive: true, force: true })
  else console.log('kept', tmp)
}

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
