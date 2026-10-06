// Tests for the export filtergraph pieces (electron/exportgraph.ts) and the proxy's shape
// (electron/playable.ts), run against the REAL bundled ffmpeg on tiny generated media, because every
// bug here was silent: ffmpeg exited 0, or the preview looked right. Run: node electron/exportgraph.test.mjs
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = async f => {
  const out = await build({ entryPoints: [path.join(here, f)], bundle: false, write: false, format: 'esm', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const { stillInput, clipAudioChain, friendlyExportError, stderrTail, DEPOP_S, UNREADABLE_STILL } = await load('exportgraph.ts')
const { planProxy, proxyFilter, proxyFits } = await load('playable.ts')

const FF = path.join(here, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-exportgraph-'))
const T = n => path.join(tmp, n)
const ff = (args) => spawnSync(FF, ['-hide_banner', '-y', '-loglevel', 'error', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const ffBuf = (args) => spawnSync(FF, ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 64 * 1024 * 1024 })

let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }

/** mean level (dB) of a window of a wav, via volumedetect */
const levelDb = (file, from, to) => {
  const r = spawnSync(FF, ['-hide_banner', '-i', file, '-af', `atrim=start=${from}:end=${to},volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' })
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr)
  return m ? (m[1] === '-inf' ? -200 : parseFloat(m[1])) : NaN
}

try {
  console.log('\n-- audio stops at the out-point --')
  ff(['-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=3', '-ac', '2', T('sine.wav')])
  ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '3', T('silence.wav')])
  // mirrors export-video: each input opened with -ss/-t (clip + 0.2 s tail), a silent bed, amix normalize=0
  const mix = (clips, out) => {
    const args = ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000:d=2']
    clips.forEach(c => { if (c.sourceStart) args.push('-ss', String(c.sourceStart)); args.push('-t', (c.duration + 0.2).toFixed(3), '-i', c.file) })
    const fc = clips.map((c, i) => clipAudioChain(`${i + 1}:a`, c, 1, `a${i + 1}`))
    fc.push(`[0:a]${clips.map((_, i) => `[a${i + 1}]`).join('')}amix=inputs=${clips.length + 1}:duration=first:dropout_transition=0:normalize=0[m]`)
    return ff([...args, '-filter_complex', fc.join(';'), '-map', '[m]', '-t', '2', out])
  }
  let r = mix([{ file: T('sine.wav'), start: 0, duration: 1 }, { file: T('silence.wav'), start: 1, duration: 1 }], T('trim.wav'))
  ok(r.status === 0, 'trim graph renders' + (r.status ? ': ' + r.stderr : ''))
  const leak = levelDb(T('trim.wav'), 1.02, 1.18)
  ok(leak < -60, `nothing of a trimmed clip plays under the next one (1.02-1.18 s: ${leak} dB, was about -24 dB)`)
  r = mix([{ file: T('sine.wav'), start: 0, duration: 1 }, { file: T('sine.wav'), start: 1, duration: 1, sourceStart: 1, aFadeIn: 0, fadeIn: 0 }], T('split.wav'))
  ok(r.status === 0, 'split graph renders' + (r.status ? ': ' + r.stderr : ''))
  const body = levelDb(T('split.wav'), 0.3, 0.7), after = levelDb(T('split.wav'), 1.02, 1.18)
  ok(Math.abs(after - body) < 1, `a split no longer doubles the audio for 200 ms (just after the split ${after} dB vs ${body} dB, was +6 dB)`)
  const chainA = clipAudioChain('2:a', { start: 0, duration: 1, sourceStart: 0, fadeIn: 0, fadeOut: 0 }, 1, 'x')
  const chainB = clipAudioChain('3:a', { start: 1, duration: 1, sourceStart: 1, fadeIn: 0, fadeOut: 0 }, 1, 'y')
  ok(chainA.includes('afade=t=out') && !chainA.includes('afade=t=in'), 'a clip from the top of its file keeps its attack, its splice end is ramped')
  ok(chainB.includes(`afade=t=in:st=1:d=${DEPOP_S}`), 'a clip starting mid-file (a split, a trim) is ramped in so the join cannot click')
  ok(clipAudioChain('2:a', { start: 0, duration: 2, fadeIn: 0.5, fadeOut: 0.5, aFadeIn: 0.02 }, 'if(lt(t\\,1)\\,1\\,0.5)', 'z').includes("volume='if(lt(t\\,1)\\,1\\,0.5)':eval=frame"), 'volume automation passes through as an expression')

  console.log('\n-- stills of every kind make it into the export --')
  const stillTest = (file, label, mustMove = false) => {
    const still = stillInput(file, 2)
    const args = ['-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=3']
    if (still.opts.length) args.push(...still.opts)
    args.push('-i', file)
    const g = `[1:v]${still.vf}format=yuva420p,scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setpts=PTS-STARTPTS+0.5/TB[s];[0:v][s]overlay=enable='between(t,0.5,2.5)':eof_action=pass,format=rgb24[v]`
    const run = ffBuf([...args, '-filter_complex', g, '-map', '[v]', '-t', '3', '-r', '30', '-f', 'rawvideo', '-'])
    const frame = 320 * 180 * 3, n = run.stdout ? Math.floor(run.stdout.length / frame) : 0
    // the frame at 2.2 s (inside the still's window, past its first second) must show it
    const at = (t) => { const i = Math.min(n - 1, Math.round(t * 30)); const f = run.stdout.subarray(i * frame, (i + 1) * frame); let s = 0; for (let k = 0; k < f.length; k += 3) s += f[k]; return s / (f.length / 3) }
    const red = n ? at(2.2) : 0
    // (the animated test GIF blinks between red 250 and red 90; the background is black, red 0)
    ok(run.status === 0 && n >= 89 && red > (mustMove ? 60 : 120), `${label}: renders, ${n} frames, still on screen at 2.2 s (red ${red.toFixed(0)})${run.status ? ' ' + String(run.stderr).slice(-200) : ''}`)
    if (mustMove && n) ok(Math.abs(at(1.0) - at(1.2)) > 20 || Math.abs(at(1.2) - at(1.4)) > 20 || Math.abs(at(2.0) - at(2.2)) > 20, `${label}: keeps animating`)
  }
  const red = ['-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=1', '-frames:v', '1']
  for (const ext of ['png', 'jpg', 'bmp', 'tiff']) { ff([...red, T('still.' + ext)]); stillTest(T('still.' + ext), ext) }
  if (ff([...red, T('still.webp')]).status === 0) stillTest(T('still.webp'), 'webp')
  ff([...red, T('still.gif')]); stillTest(T('still.gif'), 'gif (single frame)')
  // animated: red/dark blink, three frames a second
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=3:d=1', '-vf', "geq=r='if(mod(N\\,2)\\,250\\,90)':g=0:b=0", '-loop', '0', T('anim.gif')])
  stillTest(T('anim.gif'), 'gif (animated)', true)
  // "play once" GIFs must not vanish part way through the clip
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=3:d=1', '-loop', '-1', T('once.gif')])
  stillTest(T('once.gif'), 'gif (play once)')
  if (ff([...red, '-c:v', 'bmp', '-f', 'ico', T('still.ico')]).status === 0 || ff([...red, T('still.ico')]).status === 0) stillTest(T('still.ico'), 'ico')
  else console.log('  skip  ico (this ffmpeg cannot write one)')
  if (ff([...red, '-c:v', 'libaom-av1', '-still-picture', '1', T('still.avif')]).status === 0) stillTest(T('still.avif'), 'avif')
  else console.log('  skip  avif (this ffmpeg cannot write one)')
  ok(stillInput('a.PNG', 2).opts[0] === '-loop' && stillInput('a.gif', 2).opts[0] === '-stream_loop' && stillInput('a.avif', 2).vf.startsWith('loop='), 'stills are routed by their demuxer, case-insensitively')
  ok(UNREADABLE_STILL.test('IMG_1234.HEIC') && !UNREADABLE_STILL.test('x.png'), 'HEIC/HEIF are named up front instead of failing inside ffmpeg')

  console.log('\n-- text is drawn literally --')
  const drawn = (text) => {
    fs.writeFileSync(T('t.txt'), text, 'utf8')
    const font = path.join(process.env.WINDIR || 'C:/Windows', 'Fonts', 'arial.ttf').replace(/\\/g, '/').replace(/:/g, '\\:')
    const tf = T('t.txt').replace(/\\/g, '/').replace(/:/g, '\\:')
    const run = ffBuf(['-f', 'lavfi', '-i', 'color=c=black:s=320x120:d=1', '-vf', `drawtext=fontfile='${font}':textfile='${tf}':expansion=none:fontcolor=white:fontsize=40:x=10:y=40,format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'])
    let lit = 0; for (const b of run.stdout || []) if (b > 200) lit++
    return lit
  }
  ok(drawn('100% PLA') > 200, "'100% PLA' is drawn (the default expansion drew nothing)")
  ok(drawn('Save 20%') > 150 && drawn('C:\\path') > 150, "'Save 20%' and a backslash are drawn too")

  console.log('\n-- a portrait phone proxy is not blown up --')
  ff(['-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', T('coded.mp4')])
  ff(['-display_rotation', '90', '-i', T('coded.mp4'), '-c', 'copy', T('rot.mp4')])
  // get-metadata now reports the DISPLAYED size: 360x640
  const plan = planProxy({ videoCodec: 'hevc', width: 360, height: 640, fps: 30, hasVideo: true }, { maxWidth: 1920 })
  ok(plan.portrait && plan.long === 640, 'the plan bounds the long side of a portrait clip')
  r = ff(['-i', T('rot.mp4'), '-vf', proxyFilter(plan, false), '-c:v', 'libx264', '-preset', 'ultrafast', T('proxy.mp4')])
  const probe = spawnSync(FF, ['-hide_banner', '-i', T('proxy.mp4')], { encoding: 'utf8' }).stderr
  const dims = /Video: .*?, (\d+)x(\d+)/.exec(probe)
  ok(r.status === 0 && dims && +dims[1] === 360 && +dims[2] === 640, `rotated 640x360 phone clip proxies at its real 360x640 (got ${dims ? dims[1] + 'x' + dims[2] : 'nothing'}, was 640x1138)`)
  const low = planProxy({ videoCodec: 'hevc', width: 2160, height: 3840, fps: 30, hasVideo: true }, { maxWidth: 1280 })
  ok(low.long === 1280 && low.width === 720 && proxyFilter(low, false).includes('scale=-2:1280'), 'a 4K portrait clip on the light tier proxies at 720x1280')
  ok(proxyFilter(planProxy({ videoCodec: 'hevc', width: 3840, height: 2160, fps: 30, hasVideo: true }), false).includes('scale=1920:-2'), 'landscape is unchanged: 1920 wide')

  console.log('\n-- which cached proxies may be reused --')
  // what an old Quick Sync build of a rotated clip really is: the frames as stored, no rotation flag
  ff(['-noautorotate', '-i', T('rot.mp4'), '-c:v', 'libx264', '-preset', 'ultrafast', T('sideways.mp4')])
  const sw = /Video: .*?, (\d+)x(\d+)/.exec(spawnSync(FF, ['-hide_banner', '-i', T('sideways.mp4')], { encoding: 'utf8' }).stderr)
  const phone = { videoCodec: 'hevc', width: 360, height: 640, fps: 30, hasVideo: true, rotation: 90 }
  const pp = planProxy(phone, { maxWidth: 640 })
  ok(sw && !proxyFits({ width: +sw[1], height: +sw[2], fps: 30 }, phone, pp), `a sideways ${sw && sw[1] + 'x' + sw[2]} copy of a 360x640 clip is not reused, though its long side is big enough`)
  ok(dims && proxyFits({ width: +dims[1], height: +dims[2], fps: 30 }, phone, pp), 'the upright copy is reused')
  const p1080 = { videoCodec: 'hevc', width: 1080, height: 1920, fps: 30, hasVideo: true }
  ok(!proxyFits({ width: 1280, height: 720, fps: 30 }, p1080, planProxy(p1080, { maxWidth: 1280 })), 'the reviewer\'s case: a 1280x720 copy of a portrait 1080x1920 clip is refused on the light tier')
  ok(!proxyFits({ width: 1920, height: 1080, fps: 30 }, p1080, planProxy(p1080, { maxWidth: 1920 })), '...and a 1920x1080 one on the best tier')
  ok(!proxyFits({ width: 1920, height: 3414, fps: 30 }, p1080, planProxy(p1080, { maxWidth: 1920 })), 'an old copy blown up past its 1080x1920 source (1920x3414) is refused')
  ok(proxyFits({ width: 1080, height: 1920, fps: 30 }, p1080, planProxy(p1080, { maxWidth: 1920 })), 'a 1080x1920 copy of it is reused')
  const p4k = { videoCodec: 'hevc', width: 2160, height: 3840, fps: 60, hasVideo: true }
  ok(!proxyFits({ width: 720, height: 1280, fps: 30 }, p4k, planProxy(p4k, { maxWidth: 1920, maxFps: 30 })), 'a light-tier copy is rebuilt when the tier goes up')
  ok(proxyFits({ width: 1080, height: 1920, fps: 30 }, p4k, planProxy(p4k, { maxWidth: 1280, maxFps: 30 })), 'a bigger copy is kept when the tier goes down')
  ok(!proxyFits({ width: 1080, height: 1920, fps: 30 }, p4k, planProxy(p4k, { maxWidth: 1920, maxFps: 60 })), 'a 30 fps copy is rebuilt when 60 fps is wanted')
  const sq = { videoCodec: 'hevc', width: 1080, height: 1080, fps: 30, hasVideo: true }
  ok(proxyFits({ width: 1080, height: 1080, fps: 30 }, sq, planProxy(sq)) && !proxyFits({ width: 1080, height: 608, fps: 30 }, sq, planProxy(sq)), 'a square picture needs a square copy')
  ok(proxyFits({ width: 1278, height: 720, fps: 29.97 }, { videoCodec: 'hevc', width: 1920, height: 1080, fps: 29.97, hasVideo: true }, planProxy({ videoCodec: 'hevc', width: 1920, height: 1080, fps: 29.97, hasVideo: true }, { maxWidth: 1280 })), 'even-pixel rounding and 29.97 fps still count as a fit')
  ok(!proxyFits({ width: 0, height: 0, fps: 30 }, phone, pp) && !proxyFits(null, phone, pp), 'no measurements, no reuse')

  console.log('\n-- failures say why --')
  ok(friendlyExportError('ffmpeg exited with code 1: C:/x/a.mp4: No such file or directory') === 'a source file is missing', 'missing source')
  ok(/image/.test(friendlyExportError('Option loop not found.\nError opening input files')), 'a still the exporter cannot loop')
  ok(/disk is full/.test(friendlyExportError('No space left on device')), 'full disk')
  ok(/cannot be written/.test(friendlyExportError('C:/out.mp4: Permission denied')), 'output locked')
  // the real wording, from the bundled ffmpeg: which side failed decides where the user is sent
  const outMissing = ff(['-f', 'lavfi', '-i', 'testsrc=d=0.2', path.join(tmp, 'no-such-folder', 'out.mp4')])
  ok(outMissing.status !== 0 && friendlyExportError(outMissing.stderr, path.join(tmp, 'no-such-folder', 'out.mp4')) === 'the folder you are exporting to does not exist', 'a missing OUTPUT folder is not called a missing source')
  const inMissing = ff(['-i', T('not-there.mp4'), T('x.mp4')])
  ok(inMissing.status !== 0 && friendlyExportError(inMissing.stderr, T('x.mp4')) === 'a source file is missing', 'a missing input still is')
  ok(/source file cannot be opened/.test(friendlyExportError('[in#0 @ 0000024a97ab3c80] Error opening input: Permission denied\nError opening input file C:/clips/a.mp4.\nError opening input files: Permission denied', 'C:/out/final.mp4')), 'a locked INPUT is not called a locked output')
  ok(/output file cannot be written/.test(friendlyExportError('[out#0/mp4 @ 000002cb1472f800] Error opening output C:\Windows\System32\v.mp4: Permission denied\nError opening output files: Permission denied', 'C:/Windows/System32/v.mp4')), 'a locked output is')
  ok(/output file cannot be written/.test(friendlyExportError('Error opening output C:/input/final.mp4: Permission denied', 'C:/input/final.mp4')), 'an output path containing the word "input" is still the output')
  ok(stderrTail('frame=  10 fps=1\nInput #0\n[in] bad thing\nConversion failed!\n') === 'Input #0\n[in] bad thing\nConversion failed!', 'the log tail drops progress lines')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
