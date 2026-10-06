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
  const out = await build({ entryPoints: [path.join(here, f)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node18' })
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
}
const { stillInput, clipAudioChain, clipVideoChain, logoChain, titleDrawtext, friendlyExportError, stderrTail, DEPOP_S, UNREADABLE_STILL } = await load('exportgraph.ts')
const { planProxy, proxyFilter, proxyFits, HDR_TO_SDR } = await load('playable.ts')
const { cleanText, TITLE_FONT } = await load('textlayout.ts')

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

  console.log('\n-- a mono mic exports at the level the preview plays --')
  ff(['-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=3', '-ac', '1', T('mono.wav')])
  r = mix([{ file: T('mono.wav'), start: 0, duration: 1.5, audioChannels: 1 }], T('mono-out.wav'))
  const stereoRef = mix([{ file: T('sine.wav'), start: 0, duration: 1.5, audioChannels: 2 }], T('stereo-out.wav'))
  // each side on its own: the mono source must be on BOTH at the stereo source's level
  const sideDb = (file, ch) => {
    const s = spawnSync(FF, ['-hide_banner', '-i', file, '-af', `pan=mono|c0=c${ch},atrim=start=0.3:end=1.2,volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(s); return m ? parseFloat(m[1]) : NaN
  }
  const [src, ml, mr] = [sideDb(T('mono.wav'), 0), sideDb(T('mono-out.wav'), 0), sideDb(T('mono-out.wav'), 1)]
  ok(r.status === 0 && Math.abs(ml - src) < 0.1 && Math.abs(mr - src) < 0.1, `mono lands on both sides at full level (L ${ml} dB, R ${mr} dB, source ${src} dB; was 3 dB down)`)
  const [stIn, stOut] = [sideDb(T('sine.wav'), 0), sideDb(T('stereo-out.wav'), 0)]
  ok(stereoRef.status === 0 && Math.abs(stOut - stIn) < 0.1, `a stereo source keeps its level (${stOut} dB vs ${stIn} dB)`)
  ok(!clipAudioChain('2:a', { start: 0, duration: 1, audioChannels: 2 }, 1, 'x').includes('pan=') && !clipAudioChain('2:a', { start: 0, duration: 1 }, 1, 'x').includes('pan='), 'stereo and unknown sources are not folded to one side')

  console.log('\n-- sound and picture stay together --')
  // each fixture has a white flash and a 1 kHz beep at the SAME moment of the file
  // late audio: the sound stream starts 0.5 s into the file (cameras, screen recorders); flash + beep at 2.0 s
  ff(['-f', 'lavfi', '-i', "color=c=black:s=320x180:r=30:d=4,drawbox=c=white:t=fill:enable='between(t,2,2.1)'",
    '-itsoffset', '0.5', '-f', 'lavfi', '-i', "aevalsrc=exprs='if(between(t,1.5,1.6),0.8*sin(2*PI*1000*t),0)':s=48000:d=3.5",
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', T('late.mp4')])
  // variable frame rate with a hole: frames from 2 to 3 s were never recorded; flash + beep at 4.0 s
  ff(['-f', 'lavfi', '-i', "color=c=black:s=320x180:r=30:d=6,drawbox=c=white:t=fill:enable='between(t,4,4.1)'",
    '-f', 'lavfi', '-i', "aevalsrc=exprs='if(between(t,4,4.1),0.8*sin(2*PI*1000*t),0)':s=48000:d=6",
    '-vf', "select='not(between(t,2,3))'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', T('vfr.mp4')])
  /** one clip through the real picture and sound chains, as export-video lays them; when the flash and the beep happen */
  const flashAndBeep = (file, clip) => {
    const total = clip.start + clip.duration
    const args = ['-f', 'lavfi', '-i', `color=c=black:s=320x180:r=30:d=${total}`, '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000:d=${total}`]
    if (clip.sourceStart) args.push('-ss', clip.sourceStart.toFixed(3))
    args.push('-t', (clip.duration + 0.2).toFixed(3), '-i', file)
    const g = [clipVideoChain('2:v', clip, { W: 320, H: 180, fps: 30 }, 'vs'),
      `[0:v][vs]overlay=enable='between(t,${clip.start},${total})':eof_action=pass,format=gray[v]`,
      clipAudioChain('2:a', clip, 1, 'ad'),
      '[1:a][ad]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]'].join(';')
    const run = ff([...args, '-filter_complex', g, '-map', '[v]', '-r', '30', '-t', String(total), '-f', 'rawvideo', T('fb.gray'), '-map', '[a]', '-t', String(total), '-ac', '1', '-f', 'f32le', T('fb.f32')])
    if (run.status !== 0) return { error: run.stderr }
    const px = fs.readFileSync(T('fb.gray')), fr = 320 * 180
    let flash = NaN
    for (let i = 0; i * fr < px.length; i++) { let s = 0; for (let k = i * fr; k < (i + 1) * fr; k += 97) s += px[k]; if (s / (fr / 97) > 128) { flash = i / 30; break } }
    const au = fs.readFileSync(T('fb.f32')), n = au.length / 4
    let beep = NaN
    for (let i = 0; i < n; i++) if (Math.abs(au.readFloatLE(i * 4)) > 0.2) { beep = i / 48000; break }
    return { flash, beep }
  }
  const synced = (label, got, want) => ok(!got.error && Math.abs(got.flash - want) < 0.05 && Math.abs(got.beep - want) < 0.03,
    `${label}: flash at ${got.flash?.toFixed?.(3)} s, beep at ${got.beep?.toFixed?.(3)} s (want both at ${want} s)${got.error ? ' ' + got.error.slice(-300) : ''}`)
  synced('audio that starts 0.5 s into the file', flashAndBeep(T('late.mp4'), { start: 0, duration: 3.5 }), 2.0)
  synced('...trimmed in by 0.2 s', flashAndBeep(T('late.mp4'), { start: 0, duration: 3, sourceStart: 0.2 }), 1.8)
  synced('...placed at 1 s on the timeline', flashAndBeep(T('late.mp4'), { start: 1, duration: 3 }), 3.0)
  synced('VFR clip whose in-point falls inside a hole in the frames', flashAndBeep(T('vfr.mp4'), { start: 0, duration: 3, sourceStart: 2.5 }), 1.5)
  synced('VFR clip trimmed past the hole', flashAndBeep(T('vfr.mp4'), { start: 0, duration: 2, sourceStart: 3.5 }), 0.5)

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

  console.log('\n-- stills and the logo keep their colour in a BT.709 file --')
  // brand orange, decoded the way a player decodes the export (BT.709, limited range)
  const FW = 64, FH = 36
  const decode709 = (buf) => {
    const Y = buf[(FH / 2) * FW + FW / 2], U = buf[FW * FH + (FH / 4) * (FW / 2) + FW / 4], V = buf[FW * FH * 5 / 4 + (FH / 4) * (FW / 2) + FW / 4]
    return [1.164 * (Y - 16) + 1.793 * (V - 128), 1.164 * (Y - 16) - 0.213 * (U - 128) - 0.533 * (V - 128), 1.164 * (Y - 16) + 2.112 * (U - 128)].map(Math.round)
  }
  const orange = [255, 106, 0]
  const near = (rgb) => rgb.every((v, i) => Math.abs(Math.min(255, Math.max(0, v)) - orange[i]) <= 3)
  const onBase = (file, branch) => {
    const run = ffBuf(['-f', 'lavfi', '-i', `color=c=black:s=${FW}x${FH}:r=30:d=1`, '-loop', '1', '-t', '1', '-i', file,
      '-filter_complex', `${branch};[0:v][s]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2,format=yuv420p[v]`, '-map', '[v]', '-frames:v', '1', '-f', 'rawvideo', '-'])
    return run.status === 0 ? decode709(run.stdout) : String(run.stderr)
  }
  for (const ext of ['png', 'jpg']) {
    ff(['-f', 'lavfi', '-i', 'color=c=0xFF6A00:s=160x90:d=1', '-frames:v', '1', ...(ext === 'jpg' ? ['-q:v', '1'] : ['-pix_fmt', 'rgb24']), T('orange.' + ext)])
    const got = onBase(T('orange.' + ext), clipVideoChain('1:v', { type: 'image', start: 0, duration: 1 }, { W: FW, H: FH, fps: 30 }, 's'))
    ok(Array.isArray(got) && near(got), `a ${ext.toUpperCase()} still plays back as #FF6A00 (got rgb ${got}; the BT.601 conversion gave about 255,113,0)`)
  }
  const logo = onBase(T('orange.png'), logoChain('1:v', { width: 32, opacity: 1, fade: 0, from: 0, to: 1 }, 's'))
  ok(Array.isArray(logo) && near(logo), `the brand logo plays back as #FF6A00 (got rgb ${logo})`)
  const old = onBase(T('orange.png'), '[1:v]format=yuva420p,scale=64:36[s]')
  ok(Array.isArray(old) && !near(old), `(control: the old conversion really was off, rgb ${old})`)

  console.log('\n-- HDR is scaled before it is tone mapped --')
  // a 10-bit HLG clip of colour bars, tagged the way a phone tags it (scaled first, only the edges
  // between bars may differ, by rounding; measured about 2x faster from 4K to 1080p)
  const hlg = ff(['-f', 'lavfi', '-i', 'smptehdbars=s=1280x720:r=30:d=1', '-vf', 'format=yuv420p10le', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error',
    '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', T('hlg.mp4')])
  if (hlg.status === 0) {
    const chain = clipVideoChain('0:v', { start: 0, duration: 1, hdr: true }, { W: 640, H: 360, fps: 30, hdrToSdr: HDR_TO_SDR }, 'v')
    ok(/fps=30:start_time=0,scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2,zscale/.test(chain), 'the scale comes before the tone map')
    const pic = (g) => ffBuf(['-i', T('hlg.mp4'), '-filter_complex', g, '-map', '[v]', '-frames:v', '10', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    const fast = pic(chain.replace('[v]', '[x]') + ';[x]format=yuv420p[v]')
    const slow = pic(`[0:v]fps=30:start_time=0,${HDR_TO_SDR},format=yuva420p,scale=640:360:force_original_aspect_ratio=decrease,format=yuv420p[v]`)
    let diff = 0
    if (fast.stdout?.length && fast.stdout.length === slow.stdout?.length) { for (let i = 0; i < fast.stdout.length; i++) diff += Math.abs(fast.stdout[i] - slow.stdout[i]); diff /= fast.stdout.length }
    else diff = Infinity
    ok(fast.status === 0 && diff < 1.5, `same picture as tone mapping at full size (mean difference ${diff.toFixed(2)} of 255)`)
    // DCI 4K (4096x2160) into 1920x1080 fits as 1920x1013, and zscale refuses an odd side of a 4:2:0
    // frame, stopping the whole export. The same shape, small: 1024x540 into 480x270 fits as 480x253.
    const dci = ff(['-f', 'lavfi', '-i', 'smptehdbars=s=1024x540:r=30:d=1', '-vf', 'format=yuv420p10le', '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error',
      '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', T('hlg-dci.mp4')])
    const oddFit = (g) => ffBuf(['-i', T('hlg-dci.mp4'), '-filter_complex', g, '-map', '[v]', '-frames:v', '3', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
    const dciChain = clipVideoChain('0:v', { start: 0, duration: 1, hdr: true }, { W: 480, H: 270, fps: 30, hdrToSdr: HDR_TO_SDR }, 'v')
    const dciRun = oddFit(dciChain)
    ok(dci.status === 0 && dciRun.status === 0 && dciRun.stdout.length === 480 * 270 * 3, `an HDR clip whose fit has an odd side renders (exit ${dciRun.status}${dciRun.status ? ': ' + String(dciRun.stderr).trim().split('\n')[0] : ''})`)
    const oldRun = oddFit(dciChain.replace(':force_divisible_by=2', ''))
    ok(oldRun.status !== 0 && /divisible by subsampling/.test(String(oldRun.stderr)), '(control: without the even fit, zscale stops the render)')
  } else console.log('  skip  HDR (this ffmpeg cannot write a 10-bit HEVC clip)')

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

  console.log('\n-- titles are drawn the way the preview draws them --')
  const esc = p => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
  const titleFont = path.join(here, '..', 'public', 'fonts', TITLE_FONT.file)
  ok(fs.existsSync(titleFont), `the title font ships with the app (public/fonts/${TITLE_FONT.file})`)
  const { THEME_FONTS } = await load('styletheme.ts')
  ok(Object.values(THEME_FONTS).some(f => f.file === TITLE_FONT.file && f.family === TITLE_FONT.family && !f.bold),
    'the preview has the same face: it is a theme font, registered at weight 400 (so nothing fakes a bold the export cannot)')
  /** one title through titleDrawtext on a grey 640x360 frame, as gray bytes (null if ffmpeg refused it) */
  const title = (t) => {
    const c = cleanText(t)
    fs.writeFileSync(T('title.txt'), c.text, 'utf8')
    const opts = titleDrawtext(c, { W: 640, H: 360, fontFile: esc(titleFont), textFile: esc(T('title.txt')), alpha: '1' })
    const run = ffBuf(['-f', 'lavfi', '-i', 'color=c=0x808080:s=640x360:d=1', '-vf', `drawtext=${opts},format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-'])
    return { opts, px: run.status === 0 && run.stdout.length === 640 * 360 ? run.stdout : null, err: String(run.stderr || '') }
  }
  const base = { text: 'A\nMUCH LONGER LINE', x: 0.5, y: 0.5, fontSize: 120, start: 0, duration: 1, color: '#ffffff' }
  const plain = title(base)
  ok(plain.px !== null, 'centred, shadowed title renders' + (plain.px ? '' : ': ' + plain.err.slice(-300)))
  if (plain.px) {
    // each line's ink, centred on the same x (the export used to left-align them)
    const inkCentre = (rows) => { let x0 = 640, x1 = -1; for (const y of rows) for (let x = 0; x < 640; x++) if (plain.px[y * 640 + x] > 230) { x0 = Math.min(x0, x); x1 = Math.max(x1, x) } return (x0 + x1) / 2 }
    const lit = []; for (let y = 0; y < 360; y++) { for (let x = 0; x < 640; x++) if (plain.px[y * 640 + x] > 230) { lit.push(y); break } }
    const split = lit.findIndex((y, i) => i > 0 && y - lit[i - 1] > 3)
    const c1 = inkCentre(lit.slice(0, split)), c2 = inkCentre(lit.slice(split))
    ok(split > 0 && Math.abs(c1 - c2) < 3 && Math.abs(c2 - 320) < 4, `every line is centred on x (line centres ${c1}, ${c2}; frame centre 320)`)
    let dark = 0; for (const v of plain.px) if (v < 100) dark++
    ok(dark > 200, `bare text casts the preview's drop shadow (${dark} shadow pixels on the grey)`)
  }
  ok(/shadowy=\d+/.test(plain.opts) && !/shadow/.test(title({ ...base, box: true }).opts), 'a boxed title has no shadow, as in the preview')
  const boxed = title({ ...base, text: 'BOX', box: true, boxColor: '#000000', boxOpacity: 1 })
  ok(boxed.px !== null && /boxborderw=6\|16:/.test(boxed.opts), `the box is padded 0.15em top and bottom, 0.4em at the sides (${/boxborderw=[^:]+/.exec(boxed.opts)?.[0]})` + (boxed.px ? '' : ': ' + boxed.err.slice(-300)))
  // the injection: a colour that smuggles a second textfile in (measured: it drew that file into the video)
  fs.writeFileSync(T('secret.txt'), 'SECRET SECRET SECRET', 'utf8')
  const sneaky = title({ ...base, text: 'Hi', box: true, color: `white:textfile='${esc(T('secret.txt'))}'`, boxColor: 'red:x=0', start: "0,1)':textfile=x:enable='1" })
  const honest = title({ ...base, text: 'Hi', box: true, boxColor: '#000000' })
  ok(!/secret/i.test(sneaky.opts) && !/x=0[:']/.test(sneaky.opts) && /enable='between\(t,0,1\)'/.test(sneaky.opts), 'colour and time fields cannot add options to the filter')
  ok(sneaky.px && honest.px && Buffer.compare(sneaky.px, honest.px) === 0, 'the crafted colour renders exactly like a plain white title')

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
