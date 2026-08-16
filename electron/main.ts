import { app, BrowserWindow, ipcMain, dialog, shell, screen } from 'electron'
import { restoreDragOffset, plainDragOffset, shouldSnapMaximize } from './dragMath'
import { findModelInHtml } from './modelSniff'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import ffmpeg from 'fluent-ffmpeg'

if (!process.env.VH_GPU) app.disableHardwareAcceleration()   // VH_GPU=1 keeps the GPU on (needed for video-layer screenshots)

// VH_USER_DATA=<dir> runs against an isolated profile (settings, SFX cache, renders).
// Handy for testing a dev build without disturbing the settings of an installed copy.
if (process.env.VH_USER_DATA) app.setPath('userData', process.env.VH_USER_DATA)

// Must match build.appId so Windows ties the running window to the installed shortcut - 
// without it the taskbar shows a generic Electron icon and pinning behaves oddly.
if (process.platform === 'win32') app.setAppUserModelId('com.randotechnerd.vidhelm')

const getBinaryPath = () => {
  if (app.isPackaged) {
    return {
      ffmpeg: path.join(process.resourcesPath, 'ffmpeg.exe'),
      ffprobe: path.join(process.resourcesPath, 'ffprobe.exe')
    }
  }
  const projectRoot = path.join(__dirname, '..')
  return {
    ffmpeg: path.join(projectRoot, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
    ffprobe: path.join(projectRoot, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe')
  }
}

const paths = getBinaryPath()
ffmpeg.setFfmpegPath(paths.ffmpeg)
ffmpeg.setFfprobePath(paths.ffprobe)

process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public')

let win: BrowserWindow | null

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'VidHelm',
    icon: path.join(process.env.VITE_PUBLIC, 'icon.png'),   // SVG is not a valid window/taskbar icon on Windows
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0f0f11',
      symbolColor: '#f8fafc',
      height: 32
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false, 
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
    if (!process.env.VH_NO_DEVTOOLS) win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(process.env.DIST, 'index.html'))
  }

  win.webContents.setBackgroundThrottling(false)   // keep rendering when unfocused (agent screenshots)

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`Page failed to load: ${errorDescription} (${errorCode}) at ${validatedURL}`);
  });

  // Dev helper: VH_SHOOT=<path.png> stages a small demo state, captures the window, writes the PNG and quits.
  // Used to regenerate docs/screenshot.png reproducibly (see docs/ARCHITECTURE.md).
  if (process.env.VH_SHOOT) {
    win.webContents.once('did-finish-load', async () => {
      try {
        await new Promise(r => setTimeout(r, 2500))
        await win!.webContents.executeJavaScript(`(async()=>{
          const sleep=ms=>new Promise(r=>setTimeout(r,ms))
          const click=t=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(t));if(b)b.click();return !!b}
          const addBtn=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('+ Tag at'))
          for(let i=0;i<3;i++){addBtn&&addBtn.click();await sleep(50)}
          const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set
          const names=['hook','reveal','punchline']
          ;[...document.querySelectorAll('.marker-name')].forEach((el,i)=>{set.call(el,names[i]||'');el.dispatchEvent(new Event('input',{bubbles:true}))})
          const flags=[...document.querySelectorAll('.marker-flag')]
          flags.forEach((f,i)=>{
            const r=f.getBoundingClientRect()
            f.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left+1,clientY:r.top+5}))
            window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:r.left+1+(i+1)*150,clientY:r.top+5}))
            window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))
          })
          const tab=[...document.querySelectorAll('.tab')].find(x=>x.textContent==='SFX'); if(tab)tab.click()
          await sleep(600)
          click('Booth'); await sleep(150)
          const ta=document.querySelector('.booth-script')
          if(ta){const ts=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;ts.call(ta,"I was in the mood for a gummy bear.\\nFunfetti or fairy floss? Can't decide!\\nPINK. FAIRY. FLOSS!");ta.dispatchEvent(new Event('input',{bubbles:true}))}
          await sleep(400)
          return 'staged'
        })()`)
        const img = await win!.webContents.capturePage()
        fs.writeFileSync(process.env.VH_SHOOT!, img.toPNG())
        console.log('VH_SHOOT saved', process.env.VH_SHOOT)
      } catch (e) { console.error('VH_SHOOT failed', e) }
      app.quit()
    })
  }
}

// Only one VidHelm at a time: a second copy would fail to claim the agent-bridge port and
// silently have no AI connection, so hand focus back to the window that is already open.
// Packaged builds only: during development you often want a dev build running next to the
// installed app (on its own VH_AGENT_PORT), and the lock would silently quit it.
const isPrimaryInstance = !app.isPackaged || app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

ipcMain.handle('select-save-path', async (event, defaultName: string) => {
  if (!win) return null
  const ext = (defaultName.split('.').pop() || 'mp4').toLowerCase()
  const { filePath } = await dialog.showSaveDialog(win, {
    title: ext === 'png' || ext === 'jpg' ? 'Save Image' : 'Export YouTube Video',
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase() + ' Files', extensions: [ext] }],
  })
  return filePath
})

ipcMain.handle('pick-audio', async () => {
  if (!win) return null
  const { filePaths } = await dialog.showOpenDialog(win, { title: 'Choose intro audio', filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'ogg', 'm4a', 'flac', 'aac'] }], properties: ['openFile'] })
  return filePaths?.[0] || null
})

// Sample N evenly-spaced frames from a video (for the thumbnail picker)
ipcMain.handle('sample-frames', async (_event, { filePath, count = 8, sourceStart = 0, duration }: { filePath: string; count?: number; sourceStart?: number; duration?: number }) => {
  if (!filePath || !fs.existsSync(filePath)) return { error: 'no file' }
  const dur: number = duration || await new Promise(res => ffmpeg.ffprobe(filePath, (e, d) => res(e ? 0 : (d.format.duration || 0))))
  if (!dur) return { error: 'cannot read duration' }
  const dir = path.join(app.getPath('temp'), 'vidhelm_frames', String(Date.now()))
  fs.mkdirSync(dir, { recursive: true })
  const frames: { t: number; path: string }[] = []
  for (let i = 0; i < count; i++) {
    const t = sourceStart + ((i + 0.5) / count) * dur
    const out = path.join(dir, `f_${i}.jpg`)
    await new Promise<void>(res => {
      const p = spawn(paths.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', filePath, '-frames:v', '1', '-vf', 'scale=480:-1', out])
      p.on('close', () => res()); p.on('error', () => res())
    })
    if (fs.existsSync(out)) frames.push({ t: +t.toFixed(2), path: out })
  }
  return { frames }
})

// Compose a YouTube thumbnail: full-res frame + catchy subtitle + brand logo -> 1280x720 image
ipcMain.handle('compose-thumbnail', async (_event, { filePath, t, subtitle, logoPath, outPath }: { filePath: string; t: number; subtitle?: string; logoPath?: string | null; outPath: string }) => {
  if (!filePath || !fs.existsSync(filePath)) return { error: 'no video' }
  const fontFile = escFilter(path.join(process.env.WINDIR || 'C:/Windows', 'Fonts', 'arialbd.ttf'))
  const hasLogo = logoPath && fs.existsSync(logoPath)
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', filePath]
  if (hasLogo) args.push('-i', logoPath!)
  let vf = `[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720`
  if (subtitle && subtitle.trim()) {
    const tmp = path.join(app.getPath('temp'), `rs_sub_${Date.now()}.txt`)
    fs.writeFileSync(tmp, subtitle.trim(), 'utf8')
    vf += `,drawtext=fontfile='${fontFile}':textfile='${escFilter(tmp)}':fontcolor=white:fontsize=72:borderw=8:bordercolor=black@0.9:x=48:y=h-text_h-48`
  }
  if (hasLogo) { vf += `[base];[1:v]format=rgba,scale=170:-1[lg];[base][lg]overlay=main_w-overlay_w-28:28` }
  args.push('-filter_complex', vf, '-frames:v', '1', outPath)
  return new Promise(resolve => {
    const p = spawn(paths.ffmpeg, args)
    let err = ''; p.stderr.on('data', d => err += d)
    p.on('close', code => resolve(code === 0 && fs.existsSync(outPath) ? { ok: true, outPath } : { error: err.slice(-400) || 'compose failed' }))
    p.on('error', e => resolve({ error: String(e) }))
  })
})

ipcMain.handle('open-external', async (_event, url: string) => {
  if (/^(https?:\/\/|mailto:)/.test(url)) shell.openExternal(url)
})

ipcMain.handle('reveal-file', async (_event, filePath: string) => {
  if (filePath) shell.showItemInFolder(filePath)
})

// Generate a horizontal filmstrip (tiled frames) for a video clip's source range, for timeline previews
ipcMain.handle('make-thumbnails', async (_event, { filePath, sourceStart, duration }: { filePath: string; sourceStart: number; duration: number }) => {
  if (!filePath || !fs.existsSync(filePath)) return { error: 'no file' }
  const dir = path.join(app.getPath('temp'), 'vidhelm_thumbs')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`)
  const count = 8
  const dur = Math.max(0.5, duration)
  const fps = Math.max(0.1, count / dur)
  await new Promise<void>((resolve) => {
    const p = spawn(paths.ffmpeg, ['-hide_banner', '-ss', String(sourceStart || 0), '-t', String(dur), '-i', filePath,
      '-vf', `fps=${fps},scale=160:90:force_original_aspect_ratio=increase,crop=160:90,tile=${count}x1`, '-frames:v', '1', '-q:v', '5', '-y', out])
    p.on('close', () => resolve())
    p.on('error', () => resolve())
  })
  return fs.existsSync(out) ? { path: out } : { error: 'failed' }
})

// Decode a media file's audio to 16kHz mono float32 PCM for Whisper
const decodePCM = (file: string) => new Promise<Float32Array>((resolve, reject) => {
  const p = spawn(paths.ffmpeg, ['-hide_banner', '-i', file, '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'])
  const chunks: Buffer[] = []
  p.stdout.on('data', d => chunks.push(d))
  p.on('close', () => { const b = Buffer.concat(chunks); resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4))) })
  p.on('error', reject)
})

// Local Whisper captioning (Transformers.js + onnxruntime-node, fully on-device)
const asrPipes: Record<string, any> = {} // cache one pipeline per model id
ipcMain.handle('transcribe', async (_event, filePath: string, opts: any = {}) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { error: 'File not found' }
    const size = ['tiny', 'base', 'small'].includes(opts.model) ? opts.model : 'tiny'
    const lang = opts.language || 'en'
    const useEn = lang === 'en' // English-only models are faster + more accurate for English
    const modelId = `Xenova/whisper-${size}${useEn ? '.en' : ''}`
    const tf: any = await import('@huggingface/transformers')
    tf.env.cacheDir = path.join(app.getPath('userData'), 'whisper-cache') // persist the model so it downloads once
    if (!asrPipes[modelId]) {
      asrPipes[modelId] = await tf.pipeline('automatic-speech-recognition', modelId, {
        progress_callback: (p: any) => { if (win && p?.status === 'progress') win.webContents.send('transcribe-progress', { stage: 'download', pct: Math.round(p.progress || 0) }) },
      })
    }
    const asr = asrPipes[modelId]
    const audio = await decodePCM(filePath)
    if (!audio.length) return { error: 'No audio found' }

    // Process in 30s segments (Whisper's window) so we can report real progress
    const sr = 16000, chunkSec = 30
    const nChunks = Math.max(1, Math.ceil(audio.length / (chunkSec * sr)))
    const genOpts: any = { return_timestamps: opts.word ? 'word' : true }
    if (!useEn) { genOpts.task = 'transcribe'; if (lang !== 'auto') genOpts.language = lang }
    const results: { start: number; end: number; text: string }[] = []
    for (let i = 0; i < nChunks; i++) {
      const seg = audio.subarray(i * chunkSec * sr, Math.min(audio.length, (i + 1) * chunkSec * sr))
      const out = await asr(seg, genOpts)
      const offset = i * chunkSec
      for (const c of (out.chunks || [])) {
        const text = (c.text || '').trim()
        if (!text) continue
        results.push({ start: (c.timestamp?.[0] ?? 0) + offset, end: (c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0) + offset, text })
      }
      if (win) win.webContents.send('transcribe-progress', { stage: 'transcribe', pct: Math.round(((i + 1) / nChunks) * 100) })
    }
    return { chunks: results }
  } catch (e: any) {
    console.error('transcribe error', e)
    return { error: e?.message || 'Transcription failed' }
  }
})

// Render the timeline's mixed audio to a temp file (timeline-aligned) so the whole video can be captioned at once
ipcMain.handle('render-mix-audio', async (_event, { clips }: { clips: any[] }) => {
  clips = clips || []
  const withAudio = clips.filter(c => c.hasAudio && c.path)
  if (!withAudio.length) return { error: 'No audio on the timeline to caption.' }
  const total = Math.max(...clips.map(c => c.start + c.duration))
  const out = path.join(app.getPath('temp'), `vidhelm_mix_${Date.now()}.wav`)
  return new Promise((resolve) => {
    const cmd = ffmpeg()
    cmd.input(`anullsrc=channel_layout=stereo:sample_rate=48000:d=${total}`).inputFormat('lavfi')
    const fc: string[] = []
    const mix: string[] = ['0:a']
    withAudio.forEach((c, i) => {
      const idx = i + 1
      cmd.input(c.path)
      // honor the clip's trim window (sourceStart/duration) so timeline alignment is exact
      const ss = c.sourceStart || 0
      const trim = `atrim=start=${ss}:end=${ss + (c.duration || 0) || 999999},asetpts=PTS-STARTPTS,`
      fc.push(`[${idx}:a]${trim}aresample=48000,volume=${c.volume ?? 1},adelay=${Math.round(c.start * 1000)}|${Math.round(c.start * 1000)}[a${idx}]`)
      mix.push(`a${idx}`)
    })
    fc.push(`${mix.map(a => `[${a}]`).join('')}amix=inputs=${mix.length}:duration=first:normalize=0[m]`)
    cmd.complexFilter(fc).map('[m]').audioFrequency(16000).audioChannels(1).outputOptions(['-t', String(total)])
      .on('end', () => resolve({ path: out }))
      .on('error', (e) => resolve({ error: e.message }))
      .save(out)
  })
})

// Run the ffmpeg binary and collect stderr (where ffmpeg writes analysis/log output)
const runFF = (args: string[]) => new Promise<string>((resolve) => {
  const p = spawn(paths.ffmpeg, args)
  let err = ''
  p.stderr.on('data', d => { err += d.toString() })
  p.on('close', () => resolve(err))
  p.on('error', () => resolve(err))
})

// Detect silent intervals in an audio file (for "cut dead space")
ipcMain.handle('detect-silence', async (_event, { filePath, thresholdDb = -30, minPause = 0.8 }: { filePath: string; thresholdDb: number; minPause: number }) => {
  if (!filePath || !fs.existsSync(filePath)) return { error: 'no file' }
  const out = await runFF(['-hide_banner', '-i', filePath, '-af', `silencedetect=noise=${thresholdDb}dB:d=${minPause}`, '-f', 'null', '-'])
  const intervals: { start: number; end: number }[] = []
  const re = /silence_start:\s*(-?[\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(out))) intervals.push({ start: Math.max(0, parseFloat(m[1])), end: parseFloat(m[2]) })
  // a silence running to EOF has no silence_end, close it at the file's duration
  const starts = [...out.matchAll(/silence_start:\s*(-?[\d.]+)/g)]
  if (starts.length > intervals.length) {
    const lastStart = Math.max(0, parseFloat(starts[starts.length - 1][1]))
    const dur: number = await new Promise(res => ffmpeg.ffprobe(filePath, (e, d) => res(e ? 0 : (d.format.duration || 0))))
    if (dur > lastStart) intervals.push({ start: lastStart, end: dur })
  }
  return { intervals }
})

// Detect visually frozen/static intervals in a video segment (dead space for silent footage)
ipcMain.handle('detect-freeze', async (_event, { filePath, sourceStart = 0, duration, freezeDb = -50, minDur = 0.8 }: { filePath: string; sourceStart: number; duration: number; freezeDb: number; minDur: number }) => {
  if (!filePath || !fs.existsSync(filePath)) return { error: 'no file' }
  const args = ['-hide_banner', '-ss', String(sourceStart || 0)]
  if (duration) args.push('-t', String(duration))
  args.push('-i', filePath, '-vf', `freezedetect=n=${freezeDb}dB:d=${minDur}`, '-an', '-f', 'null', '-')
  const out = await runFF(args)
  const starts = [...out.matchAll(/freeze_start:\s*([\d.]+)/g)].map(m => parseFloat(m[1]))
  const ends = [...out.matchAll(/freeze_end:\s*([\d.]+)/g)].map(m => parseFloat(m[1]))
  const intervals: { start: number; end: number }[] = []
  for (let i = 0; i < starts.length; i++) intervals.push({ start: starts[i], end: ends[i] !== undefined ? ends[i] : (duration || starts[i]) })
  return { intervals }
})

// "Watch & Verify": analyze a rendered file for YouTube-quality issues (loudness, peaks, codec, black frames)
// and return a report plus a filmstrip of sample frames the user can eyeball.
ipcMain.handle('quality-check', async (_event, filePath: string) => {
  if (!filePath || !fs.existsSync(filePath)) return { error: 'File not found' }
  const probe: any = await new Promise(res => ffmpeg.ffprobe(filePath, (e, d) => res(e ? null : d)))
  const v = probe?.streams?.find((s: any) => s.codec_type === 'video')
  const a = probe?.streams?.find((s: any) => s.codec_type === 'audio')
  const dur = probe?.format?.duration ? parseFloat(probe.format.duration) : 0
  const fpsParts = (v?.r_frame_rate || '0/1').split('/')
  const fps = fpsParts[1] && fpsParts[1] !== '0' ? Math.round(parseInt(fpsParts[0]) / parseInt(fpsParts[1])) : 0

  // Loudness measurement (loudnorm analysis pass prints JSON)
  const lnOut = await runFF(['-hide_banner', '-i', filePath, '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'])
  let loudness: any = {}
  try { const m = lnOut.match(/\{[\s\S]*?\}/); if (m) { const j = JSON.parse(m[0]); loudness = { integrated: parseFloat(j.input_i), truePeak: parseFloat(j.input_tp), lra: parseFloat(j.input_lra) } } } catch {}

  // Peak / clipping
  const vdOut = await runFF(['-hide_banner', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'])
  const maxV = parseFloat((vdOut.match(/max_volume:\s*(-?[\d.]+) dB/) || [])[1])
  const meanV = parseFloat((vdOut.match(/mean_volume:\s*(-?[\d.]+) dB/) || [])[1])

  // Black-frame detection
  const bdOut = await runFF(['-hide_banner', '-i', filePath, '-vf', 'blackdetect=d=0.3:pix_th=0.10', '-f', 'null', '-'])
  const black: { start: number; end: number }[] = []
  const bdRe = /black_start:([\d.]+) black_end:([\d.]+)/g
  let bm: RegExpExecArray | null
  while ((bm = bdRe.exec(bdOut))) black.push({ start: parseFloat(bm[1]), end: parseFloat(bm[2]) })

  // Sample frames (filmstrip)
  const frameDir = path.join(app.getPath('temp'), 'vidhelm_qc')
  if (fs.existsSync(frameDir)) { try { fs.rmSync(frameDir, { recursive: true, force: true }) } catch {} }
  fs.mkdirSync(frameDir, { recursive: true })
  const frames: { t: number; path: string }[] = []
  const N = 6
  for (let i = 0; i < N; i++) {
    const t = dur * ((i + 0.5) / N)
    const fp = path.join(frameDir, `qc_${i}.jpg`)
    await runFF(['-hide_banner', '-ss', String(t), '-i', filePath, '-frames:v', '1', '-vf', 'scale=320:-1', '-q:v', '4', '-y', fp])
    if (fs.existsSync(fp)) frames.push({ t, path: fp })
  }

  // Build pass/warn/fail checks against YouTube guidance
  const checks: { label: string; status: 'pass' | 'warn' | 'fail'; detail: string }[] = []
  const okRes = [720, 1080, 1440, 2160]
  checks.push({ label: 'Resolution', status: v && okRes.includes(v.height) ? 'pass' : 'warn', detail: v ? `${v.width}×${v.height}` : 'no video' })
  checks.push({ label: 'Frame rate', status: [24, 25, 30, 48, 50, 60].includes(fps) ? 'pass' : 'warn', detail: `${fps} fps` })
  checks.push({ label: 'Video codec', status: ['h264', 'hevc', 'vp9', 'av1'].includes(v?.codec_name) ? 'pass' : 'warn', detail: v?.codec_name || ' - ' })
  checks.push({ label: 'Pixel format', status: v?.pix_fmt === 'yuv420p' ? 'pass' : 'warn', detail: v?.pix_fmt || ' - ' })
  checks.push({ label: 'Audio', status: a && ['aac', 'opus', 'mp3'].includes(a.codec_name) ? 'pass' : 'warn', detail: a ? `${a.codec_name} ${a.sample_rate}Hz ${a.channels}ch` : 'no audio' })
  // faststart
  let faststart = false
  try { const head = fs.readFileSync(filePath).slice(0, 200000); faststart = head.indexOf('moov') >= 0 && head.indexOf('moov') < head.indexOf('mdat') } catch {}
  checks.push({ label: 'Web fast-start', status: faststart ? 'pass' : 'warn', detail: faststart ? 'moov at front' : 'not optimized' })
  // loudness
  if (!isNaN(loudness.integrated)) {
    const I = loudness.integrated
    const st = I >= -15.5 && I <= -12.5 ? 'pass' : (I >= -18 && I <= -11 ? 'warn' : 'fail')
    checks.push({ label: 'Loudness (target −14 LUFS)', status: st, detail: `${I.toFixed(1)} LUFS` })
  }
  if (!isNaN(loudness.truePeak)) {
    const tp = loudness.truePeak
    checks.push({ label: 'True peak (≤ −1 dBTP)', status: tp <= -1 ? 'pass' : (tp <= 0 ? 'warn' : 'fail'), detail: `${tp.toFixed(1)} dBTP` })
  }
  if (!isNaN(maxV)) {
    checks.push({ label: 'Clipping', status: maxV >= 0 ? 'fail' : (maxV >= -0.3 ? 'warn' : 'pass'), detail: `max ${maxV.toFixed(1)} dB` })
  }
  // black frames in the body (ignore a short lead-in/out for fades)
  const bodyBlack = black.filter(b => b.start > 0.6 && b.end < dur - 0.6 && (b.end - b.start) > 0.8)
  checks.push({ label: 'Black/blank frames', status: bodyBlack.length ? 'warn' : 'pass', detail: bodyBlack.length ? `${bodyBlack.length} segment(s) mid-video` : 'none' })

  const verdict: 'pass' | 'warn' | 'fail' = checks.some(c => c.status === 'fail') ? 'fail' : checks.some(c => c.status === 'warn') ? 'warn' : 'pass'
  return {
    probe: { width: v?.width, height: v?.height, fps, vcodec: v?.codec_name, pixfmt: v?.pix_fmt, acodec: a?.codec_name, sampleRate: a?.sample_rate, channels: a?.channels, duration: dur },
    loudness, volume: { max: maxV, mean: meanV }, black, frames, checks, verdict,
  }
})

ipcMain.handle('get-metadata', async (event, filePath: string) => {
  return new Promise((resolve, reject) => {
    if (!filePath) return reject(new Error('No file path provided'))
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        // `ok: false` lets the importer tell the user *why* a file was skipped instead of
        // silently adding a 5-second placeholder. Callers that only read duration/hasVideo
        // still get the old fallback shape.
        resolve({ duration: 5, hasVideo: false, hasAudio: false, ok: false, error: String((err as Error)?.message || err).split('\n')[0] })
      } else {
        const hasVideo = metadata.streams.some((s: any) => s.codec_type === 'video')
        const hasAudio = metadata.streams.some((s: any) => s.codec_type === 'audio')
        resolve({
          duration: metadata.format.duration || 5,
          hasVideo,
          hasAudio,
          ok: hasVideo || hasAudio,
          // still images probe as image2/png_pipe/mjpeg_pipe, used to tell photos from video
          format: metadata.format.format_name || '',
          videoCodec: metadata.streams.find((s: any) => s.codec_type === 'video')?.codec_name || '',
        })
      }
    })
  })
})

ipcMain.handle('save-recording', async (_event, base64: string) => {
  const dir = path.join(app.getPath('temp'), 'vidhelm_vo')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `vo_${Date.now()}.webm`)
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'))
  return filePath
})

// ---------------- Project folder (workspace) ----------------
// Point VidHelm at one folder; every sub-folder inside it is a project. Opening a project
// pulls in whatever media is sitting in that folder, so there is no separate import step - 
// drop files in with Explorer and they are simply there.
const MEDIA_RE = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpg|mpeg|ts|m2ts|mts|3gp|ogv|mxf|mp3|wav|aac|m4a|flac|ogg|oga|opus|wma|aif|aiff|caf|ac3|mka|png|jpg|jpeg|jfif|webp|gif|bmp|tif|tiff|avif)$/i
const PROJECT_FILE = 'project.vidhelm.json'

ipcMain.handle('list-projects', async (_event, root: string) => {
  try {
    if (!root || !fs.existsSync(root)) return { error: 'that folder is not there any more' }
    const entries = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.'))
    const projects = entries.map(e => {
      const dir = path.join(root, e.name)
      let media = 0, saved = false, modified = 0
      try {
        for (const f of fs.readdirSync(dir)) {
          if (MEDIA_RE.test(f)) media++
          if (f === PROJECT_FILE) saved = true
        }
        modified = fs.statSync(dir).mtimeMs
      } catch { /* unreadable folder, still list it */ }
      return { name: e.name, path: dir, media, saved, modified }
    })
    projects.sort((a, b) => b.modified - a.modified)
    return { projects }
  } catch (e) { return { error: String(e) } }
})

// Everything usable sitting in a project folder, newest first, so it can be loaded without an import step
ipcMain.handle('scan-project', async (_event, dir: string) => {
  try {
    if (!dir || !fs.existsSync(dir)) return { error: 'that project folder is not there any more' }
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter(f => f.isFile() && MEDIA_RE.test(f.name))
      .map(f => ({ path: path.join(dir, f.name), name: f.name, mtime: fs.statSync(path.join(dir, f.name)).mtimeMs }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    const projectFile = path.join(dir, PROJECT_FILE)
    let project = null
    if (fs.existsSync(projectFile)) { try { project = JSON.parse(fs.readFileSync(projectFile, 'utf8')) } catch { /* corrupt save, keep the media */ } }
    return { files, project, projectFile }
  } catch (e) { return { error: String(e) } }
})

ipcMain.handle('create-project', async (_event, { root, name }: { root: string; name: string }) => {
  try {
    const safe = (name || 'New project').replace(/[<>:"/\\|?*]/g, '').trim() || 'New project'
    let dir = path.join(root, safe), n = 2
    while (fs.existsSync(dir)) dir = path.join(root, `${safe} ${n++}`)
    fs.mkdirSync(dir, { recursive: true })
    return { path: dir, name: path.basename(dir) }
  } catch (e) { return { error: String(e) } }
})

ipcMain.handle('reveal-folder', async (_event, dir: string) => { if (dir && fs.existsSync(dir)) shell.openPath(dir) })

// Where flattened renders for video-analysis services go. Kept out of the project folder so
// they do not get picked up as project media on the next scan.
ipcMain.handle('analysis-path', async (_event, name: string) => {
  const dir = path.join(app.getPath('userData'), 'analysis')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${(name || 'timeline').replace(/[^\w-]+/g, '_')}_${Date.now()}.mp4`)
})

// Save straight into the project folder, no dialog once a project is open
ipcMain.handle('save-project-to', async (_event, { dir, data }: { dir: string; data: any }) => {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, PROJECT_FILE)
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
    return { path: file }
  } catch (e) { return { error: String(e) } }
})

ipcMain.handle('save-project', async (_event, data: any) => {
  if (!win) return null
  const { filePath } = await dialog.showSaveDialog(win, {
    title: 'Save Project', defaultPath: 'project.rsnap',
    filters: [{ name: 'VidHelm Project', extensions: ['rsnap', 'json'] }],
  })
  if (!filePath) return null
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
  return filePath
})

ipcMain.handle('load-project', async () => {
  if (!win) return null
  const { filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open Project', properties: ['openFile'],
    filters: [{ name: 'VidHelm Project', extensions: ['rsnap', 'json'] }],
  })
  if (!filePaths || !filePaths[0]) return null
  try { return JSON.parse(fs.readFileSync(filePaths[0], 'utf8')) } catch { return null }
})

// ---- Persistent app settings (brand kit, intro defaults, audio) ----
const settingsPath = () => path.join(app.getPath('userData'), 'vidhelm-settings.json')
const DEFAULT_SETTINGS = {
  brand: { enabled: false, logoPath: null as string | null, position: 'br', sizePct: 16, margin: 40, opacity: 0.85, showMode: 'whole' as 'whole' | 'intro' | 'outro', windowSec: 5, fade: 0.5 },
  intro: { segment: 'first' as 'first' | 'last', seconds: 5, fade: 0.6, treatment: 'ripple' as 'ripple' | 'overlay' },
  audio: { optimize: true, noiseReduction: false },
  caption: { fontSize: 44, color: '#ffffff', position: 'lower' as 'lower' | 'top' | 'center', box: true, boxOpacity: 0.5, model: 'tiny' as 'tiny' | 'base' | 'small', language: 'en', mode: 'phrase' as 'phrase' | 'word' },
  silence: { minPause: 0.8, thresholdDb: -30, pad: 0.12, smooth: true, transition: 0.12, detectBy: 'auto' as 'auto' | 'audio' | 'motion', freezeDb: -50 },
}

ipcMain.handle('get-settings', async () => {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    // Spread raw first: settings owned entirely by the renderer (the Start Recipe, the
    // narration command the voice wizard fills in, the SFX generator, the project folder)
    // used to be dropped here, so they were written to disk and then forgotten on restart.
    return {
      ...raw,
      brand: { ...DEFAULT_SETTINGS.brand, ...raw.brand },
      intro: { ...DEFAULT_SETTINGS.intro, ...raw.intro },
      audio: { ...DEFAULT_SETTINGS.audio, ...raw.audio },
      caption: { ...DEFAULT_SETTINGS.caption, ...raw.caption },
      silence: { ...DEFAULT_SETTINGS.silence, ...raw.silence },
    }
  } catch { return DEFAULT_SETTINGS }
})

ipcMain.handle('set-settings', async (_event, data: any) => {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2), 'utf8'); return true } catch { return false }
})

ipcMain.handle('pick-logo', async () => {
  if (!win) return null
  const { filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose Logo (PNG with transparency recommended)', properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  })
  if (!filePaths || !filePaths[0]) return null
  const dir = path.join(app.getPath('userData'), 'brand')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, `logo_${Date.now()}${path.extname(filePaths[0])}`)
  fs.copyFileSync(filePaths[0], dest) // copy so the logo persists even if the original moves
  return dest
})

// ---------------- 3D Studio (STL / 3MF / OBJ turntables) ----------------
const renders3dDir = () => { const d = path.join(app.getPath('userData'), 'renders3d'); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); return d }

// ---------------- Header window dragging ----------------
// The app has no OS title bar, so the header IS the grab bar. Movement is driven here
// (polling the cursor) rather than with -webkit-app-region, so it behaves like a real
// title bar: dragging while maximized or full screen restores the window under the
// cursor, and releasing at the top of the screen maximizes it again.
let dragTimer: ReturnType<typeof setInterval> | null = null
let dragOffset = { x: 0, y: 0 }
const stopWindowDrag = () => { if (dragTimer) { clearInterval(dragTimer); dragTimer = null } }

ipcMain.on('window-drag-start', () => {
  if (!win) return
  stopWindowDrag()
  const cursor = screen.getCursorScreenPoint()
  const wasFull = win.isFullScreen()
  if (wasFull) win.setFullScreen(false)
  if (wasFull || win.isMaximized()) {
    const before = win.getBounds()
    if (win.isMaximized()) win.unmaximize()
    dragOffset = restoreDragOffset(cursor, before, win.getBounds())
    win.setPosition(Math.round(cursor.x - dragOffset.x), Math.round(cursor.y - dragOffset.y), false)
  } else {
    dragOffset = plainDragOffset(cursor, win.getBounds())
  }
  const started = Date.now()
  dragTimer = setInterval(() => {
    // the 45s cap is a safety net: if a mouseup is ever missed (released off-window),
    // the window would otherwise follow the cursor forever
    if (!win || win.isDestroyed() || Date.now() - started > 45_000) return stopWindowDrag()
    const p = screen.getCursorScreenPoint()
    win.setPosition(Math.round(p.x - dragOffset.x), Math.round(p.y - dragOffset.y), false)
  }, 16)
})

ipcMain.on('window-drag-end', () => {
  if (!dragTimer) return          // ignore stray mouseups
  stopWindowDrag()
  if (!win || win.isDestroyed()) return
  const p = screen.getCursorScreenPoint()
  if (shouldSnapMaximize(p.y, screen.getDisplayNearestPoint(p).workArea.y)) win.maximize()
})

ipcMain.on('window-toggle-maximize', () => {
  if (!win) return
  if (win.isFullScreen()) win.setFullScreen(false)
  else if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})

ipcMain.handle('pick-file', async (_event, { title, extensions }: { title: string; extensions: string[] }) => {
  if (!win) return null
  const { filePaths } = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters: [{ name: title, extensions }] })
  return filePaths?.[0] || null
})

ipcMain.handle('pick-folder', async (_event, title: string) => {
  if (!win) return null
  const { filePaths } = await dialog.showOpenDialog(win, { title, properties: ['openDirectory'] })
  return filePaths?.[0] || null
})

ipcMain.handle('pick-model', async () => {
  if (!win) return null
  const { filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open 3D model', properties: ['openFile'],
    filters: [{ name: '3D models', extensions: ['stl', '3mf', 'obj', 'glb', 'gltf', 'html', 'htm'] }],
  })
  return filePaths?.[0] || null
})

// Pull a 3D model out of an HTML page (viewer exports, model-viewer pages, single-file
// three.js scenes). The searching lives in modelSniff.ts; this handles files and disk.
ipcMain.handle('extract-model', async (_event, filePath: string) => {
  try {
    if (fs.statSync(filePath).size > 300 * 1024 * 1024) return { error: 'that page is too large to scan' }
    const html = fs.readFileSync(filePath, 'latin1')   // byte-faithful, and base64/OBJ are ASCII
    const hit = findModelInHtml(html, ref => {
      const p = path.resolve(path.dirname(filePath), ref)
      return fs.existsSync(p) && fs.statSync(p).isFile() ? p : null
    })
    if (!hit) return { error: 'no 3D model found inside that page' }
    if (hit.kind === 'file') return { path: hit.path, how: hit.how }
    const outDir = path.join(app.getPath('userData'), 'model_extracts')
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
    const stem = path.basename(filePath).replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_')
    const out = path.join(outDir, `${stem}_${Date.now()}.${hit.ext}`)
    fs.writeFileSync(out, hit.buf)
    return { path: out, how: hit.how }
  } catch (e) { return { error: String(e) } }
})

// MediaRecorder gives us a VFR webm off the WebGL canvas, re-encode to something clean.
// Opaque renders become h264 mp4; transparent ones stay VP9 webm, the only common format
// that keeps an alpha channel (h264 has none). Both decode to yuva420p for the export
// filtergraph, so a transparent render composites straight over the footage below it.
ipcMain.handle('save-3d-render', async (_event, { base64, name, alpha }: { base64: string; name: string; alpha?: boolean }) => {
  try {
    const dir = renders3dDir()
    const cap = path.join(dir, `_cap_${Date.now()}.webm`)
    fs.writeFileSync(cap, Buffer.from(base64, 'base64'))
    const stem = `${name.replace(/[^\w-]+/g, '_')}_spin_${Date.now()}`
    const out = path.join(dir, alpha ? `${stem}_overlay.webm` : `${stem}.mp4`)
    await new Promise<void>((resolve, reject) => {
      const cmd = ffmpeg(cap)
      // Transparent: stream-copy Chromium's VP8/VP9. Its alpha lives in a WebM side channel
      // that this ffmpeg build cannot re-encode (it writes the tag but drops the channel),
      // so copying is the only way to keep it, and both the preview and the export
      // filtergraph decode it happily. Timestamps are rebuilt because MediaRecorder is VFR.
      if (alpha) cmd.outputOptions(['-c copy', '-fflags +genpts'])
      else cmd.videoFilter('scale=trunc(iw/2)*2:trunc(ih/2)*2')
        .outputOptions(['-c:v libx264', '-crf 18', '-preset medium', '-pix_fmt yuv420p', '-r 30', '-movflags +faststart', '-an'])
      cmd.save(out).on('end', () => resolve()).on('error', reject)
    })
    fs.unlinkSync(cap)
    return { path: out }
  } catch (e) { return { error: String(e) } }
})

ipcMain.handle('save-3d-still', async (_event, { dataUrl, name }: { dataUrl: string; name: string }) => {
  try {
    const out = path.join(renders3dDir(), `${name.replace(/[^\w-]+/g, '_')}_still_${Date.now()}.png`)
    fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'))
    return { path: out }
  } catch (e) { return { error: String(e) } }
})

ipcMain.handle('save-obj-file', async (_event, { text, defaultName }: { text: string; defaultName: string }) => {
  if (!win) return { error: 'no window' }
  const { filePath } = await dialog.showSaveDialog(win, { title: 'Save as OBJ', defaultPath: defaultName, filters: [{ name: 'OBJ model', extensions: ['obj'] }] })
  if (!filePath) return {}
  try { fs.writeFileSync(filePath, text, 'utf8'); return { path: filePath } } catch (e) { return { error: String(e) } }
})

// ---------------- One-click voice-clone setup ----------------
// Writes a ready-to-run XTTS-v2 voice engine (reference wav + generator script + installer)
// into a folder the user picks, launches the installer, and returns the narration command.
const CLONE_PY = `import sys, os
os.environ.setdefault("COQUI_TOS_AGREED", "1")
from TTS.api import TTS
ref, script, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(outdir, exist_ok=True)
lines = [l.strip() for l in open(script, encoding="utf-8") if l.strip()]
tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
for i, line in enumerate(lines, 1):
    print(f"[{i}/{len(lines)}] {line[:60]}", flush=True)
    tts.tts_to_file(text=line, speaker_wav=ref, language="en",
                    file_path=os.path.join(outdir, f"scene_{i}.wav"), temperature=0.62)
print("done", flush=True)
`
const SETUP_BAT = `@echo off
title VidHelm voice engine setup
cd /d "%~dp0"
echo == VidHelm voice clone setup, one time, downloads the XTTS-v2 model (~2 GB) ==
where python >nul 2>nul || (echo Python 3.10+ is required. Install it from python.org, tick "Add to PATH", then run this file again. & pause & exit /b 1)
if not exist venv python -m venv venv
call venv\\Scripts\\activate.bat
python -m pip install --upgrade pip
pip install coqui-tts
echo.
echo Setup complete! Go back to VidHelm and hit "Generate narration".
echo (The voice model itself downloads automatically on the first generation.)
pause
`
ipcMain.handle('voice-clone-setup', async (_event, { sampleBase64, samplePath }: { sampleBase64?: string; samplePath?: string }) => {
  if (!win) return { error: 'no window' }
  const { filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose an empty folder for your voice engine (needs ~4 GB free)',
    properties: ['openDirectory', 'createDirectory'],
  })
  const dir = filePaths?.[0]
  if (!dir) return {}
  try {
    // reference sample → clean wav (what XTTS wants)
    const ref = path.join(dir, 'reference.wav')
    let src = samplePath
    if (sampleBase64) {
      src = path.join(app.getPath('temp'), `vh_voice_sample_${Date.now()}.webm`)
      fs.writeFileSync(src, Buffer.from(sampleBase64, 'base64'))
    }
    if (!src) return { error: 'no voice sample' }
    await new Promise<void>((resolve, reject) => {
      ffmpeg(src!).outputOptions(['-ar 22050', '-ac 1', '-c:a pcm_s16le']).save(ref).on('end', () => resolve()).on('error', reject)
    })
    fs.writeFileSync(path.join(dir, 'clone_voice.py'), CLONE_PY, 'utf8')
    const bat = path.join(dir, 'setup_voice_clone.bat')
    fs.writeFileSync(bat, SETUP_BAT, 'utf8')
    shell.openPath(bat)   // opens a console window so the user can watch the install
    const py = path.join(dir, 'venv', 'Scripts', 'python.exe')
    return { dir, command: `"${py}" "${path.join(dir, 'clone_voice.py')}" "${ref}" {script} {outdir}` }
  } catch (e) { return { error: String(e) } }
})

// audio.cpp voice engine (Apache-2.0, prebuilt exe, no Python): write reference.wav and a
// PowerShell wrapper that adapts audiocpp_cli's one-line-at-a-time CLI to VidHelm's
// {script}/{outdir} narration contract (scene_1.wav, scene_2.wav, ...).
ipcMain.handle('voice-cpp-setup', async (_event, { sampleBase64, samplePath, cliPath, modelPath, family }: { sampleBase64?: string; samplePath?: string; cliPath: string; modelPath: string; family: string }) => {
  try {
    if (!fs.existsSync(cliPath)) return { error: 'audiocpp_cli.exe not found at that path' }
    const dir = path.dirname(cliPath)
    const ref = path.join(dir, 'vidhelm_reference.wav')
    let src = samplePath
    if (sampleBase64) {
      src = path.join(app.getPath('temp'), `vh_voice_sample_${Date.now()}.webm`)
      fs.writeFileSync(src, Buffer.from(sampleBase64, 'base64'))
    }
    if (!src) return { error: 'no voice sample' }
    await new Promise<void>((resolve, reject) => {
      ffmpeg(src!).outputOptions(['-ar 24000', '-ac 1', '-c:a pcm_s16le']).save(ref).on('end', () => resolve()).on('error', reject)
    })
    const fam = (family || 'pocket_tts').replace(/[^\w.-]/g, '')
    const ps1 = path.join(dir, 'vidhelm_voice.ps1')
    fs.writeFileSync(ps1, `param([string]$ScriptFile, [string]$OutDir)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$lines = @(Get-Content -LiteralPath $ScriptFile -Encoding UTF8 | Where-Object { $_.Trim() -ne "" })
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$i = 0
foreach ($line in $lines) {
  $i++
  Write-Output "[$i/$($lines.Count)] $line"
  & "${cliPath}" --task tts --family "${fam}" --model "${modelPath}" --text "$line" --voice-ref "$here\\vidhelm_reference.wav" --out "$OutDir\\scene_$i.wav"
  if ($LASTEXITCODE -ne 0) { Write-Output "audiocpp_cli failed on line $i"; exit $LASTEXITCODE }
}
Write-Output "done"
`, 'utf8')
    return { dir, command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}" {script} {outdir}` }
  } catch (e) { return { error: String(e) } }
})

// ---------------- AI sound-effect generator ----------------
// Runs the user's text-to-audio command ({prompt} and {out} placeholders, e.g. audio.cpp's
// stable_audio gen task) and drops the result into the custom SFX folder so it shows up
// in the library immediately.
ipcMain.handle('sfx-generate', async (_event, { command, prompt }: { command: string; prompt: string }) => {
  if (!command?.includes('{out}')) return { error: 'Command must include {out} (and usually {prompt}).' }
  const customDir = path.join(app.getPath('userData'), 'sfx', 'custom')
  if (!fs.existsSync(customDir)) fs.mkdirSync(customDir, { recursive: true })
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'sfx'
  const out = path.join(customDir, `ai_${slug}.wav`)
  const cmd = command.replace(/\{prompt\}/g, prompt.replace(/["\n\r]/g, '')).replace(/\{out\}/g, out)
  return new Promise(resolve => {
    const child = spawn(cmd, [], { shell: true, windowsHide: true })
    let log = ''
    const cap = (d: Buffer) => { log = (log + d.toString()).slice(-4000) }
    child.stdout?.on('data', cap); child.stderr?.on('data', cap)
    const timer = setTimeout(() => { try { child.kill() } catch {} ; resolve({ error: 'generator timed out (5 min)', log }) }, 5 * 60 * 1000)
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0 && fs.existsSync(out)) resolve({ path: out })
      else resolve({ error: `generator exited with code ${code}${fs.existsSync(out) ? '' : ' (no output file)'}`, log })
    })
    child.on('error', e => { clearTimeout(timer); resolve({ error: String(e), log }) })
  })
})

// Escape a path or string for use inside an ffmpeg filtergraph option
const escFilter = (s: string) => s.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
// Build a piecewise-linear volume expression (eval=frame) from automation points.
// pts: [{t: secondsFromClipStart, v: gain}], clipStart shifts to absolute timeline time.
const volumeExpr = (pts: { t: number; v: number }[], clipStart: number, clipVol: number) => {
  if (!pts || pts.length === 0) return null
  const P = pts.slice().sort((a, b) => a.t - b.t).map(p => ({ a: clipStart + p.t, v: p.v }))
  let expr = `${P[P.length - 1].v}`
  for (let i = P.length - 1; i > 0; i--) {
    const p0 = P[i - 1], p1 = P[i]
    const span = (p1.a - p0.a) || 0.0001
    const seg = `(${p0.v}+(${p1.v}-${p0.v})*(t-${p0.a})/${span})`
    expr = `if(lt(t\\,${p1.a})\\,${seg}\\,${expr})`
  }
  expr = `if(lt(t\\,${P[0].a})\\,${P[0].v}\\,${expr})`
  return expr
}
// Build a 0..1 alpha expression with optional fade in/out for drawtext
const alphaExpr = (start: number, end: number, fi: number, fo: number) => {
  if (fi <= 0 && fo <= 0) return '1'
  const inE = fi > 0 ? `min(1\\,(t-${start})/${fi})` : '1'
  const outE = fo > 0 ? `min(1\\,(${end}-t)/${fo})` : '1'
  return `max(0\\,min(${inE}\\,${outE}))`
}

// ---------------- Agent bridge ----------------
// A localhost-only HTTP server that lets an AI agent (via the bundled MCP server in agent/)
// read the editor state and drive it while a human watches. See docs/AGENT.md.
//   GET  /state       -> current project state (from the renderer)
//   POST /command     -> { action, ...params } executed in the renderer, returns its result
//   GET  /screenshot  -> PNG of the app window
//   GET  /ping        -> { ok, app, version }
import http from 'node:http'

const AGENT_PORT = Number(process.env.VH_AGENT_PORT || 5959)
let agentSeq = 0
const agentPending = new Map<number, (result: any) => void>()

ipcMain.on('agent-response', (_e, { id, result }: { id: number; result: any }) => {
  const cb = agentPending.get(id)
  if (cb) { agentPending.delete(id); cb(result) }
})

const askRenderer = (cmd: any, timeoutMs = 15000) => new Promise<any>(resolve => {
  if (!win) return resolve({ error: 'VidHelm window is not open' })
  const id = ++agentSeq
  const timer = setTimeout(() => { agentPending.delete(id); resolve({ error: `renderer timeout after ${timeoutMs / 1000}s` }) }, timeoutMs)
  agentPending.set(id, r => { clearTimeout(timer); resolve(r) })
  win.webContents.send('agent-command', { id, ...cmd })
})

const agentServer = http.createServer(async (req, res) => {
  // localhost only
  const remote = req.socket.remoteAddress || ''
  if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote)) { res.writeHead(403); return res.end() }
  res.setHeader('Content-Type', 'application/json')
  try {
    if (req.method === 'GET' && req.url === '/ping') {
      return res.end(JSON.stringify({ ok: true, app: 'VidHelm', version: app.getVersion() }))
    }
    if (req.method === 'GET' && req.url === '/state') {
      return res.end(JSON.stringify(await askRenderer({ action: 'get_state' })))
    }
    if (req.method === 'GET' && req.url === '/screenshot') {
      if (!win) { res.writeHead(503); return res.end(JSON.stringify({ error: 'no window' })) }
      // force a fresh composite, capturePage can return a stale frame on idle/background windows
      win.webContents.invalidate()
      await new Promise(r => setTimeout(r, 120))
      const img = await win.webContents.capturePage()
      res.setHeader('Content-Type', 'image/png')
      return res.end(img.toPNG())
    }
    if (req.method === 'POST' && req.url === '/command') {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      let cmd: any
      try { cmd = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { res.writeHead(400); return res.end(JSON.stringify({ error: 'bad json' })) }
      if (!cmd.action) { res.writeHead(400); return res.end(JSON.stringify({ error: 'missing action' })) }
      const LONG = ['export', 'cut_pauses', 'run_recipe', 'sample_frames', 'compose_thumbnail', 'render_3d', 'prepare_analysis']
      const timeout = cmd.action === 'export' ? 30 * 60 * 1000 : LONG.includes(cmd.action) ? 5 * 60 * 1000 : 15000
      return res.end(JSON.stringify(await askRenderer(cmd, timeout)))
    }
    res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }))
  } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })) }
})
let bridgeState = { listening: false, error: '' }
agentServer.on('error', (e: NodeJS.ErrnoException) => {
  bridgeState = {
    listening: false,
    error: e?.code === 'EADDRINUSE'
      ? `port ${AGENT_PORT} is already taken, another copy of VidHelm (or another app) is using it`
      : String(e),
  }
  console.warn('agent bridge disabled:', bridgeState.error)
})
// Only the primary instance opens the bridge, a duplicate on its way out must never race
// the running app for the port.
if (isPrimaryInstance) {
  app.whenReady().then(() => agentServer.listen(AGENT_PORT, '127.0.0.1', () => { bridgeState = { listening: true, error: '' }; console.log(`agent bridge on http://127.0.0.1:${AGENT_PORT}`) }))
}

// Where the MCP server file lives on disk (packaged builds ship it in resources/agent/).
// The Connect panel hands this absolute path to MCP clients that need one.
const MCP_SERVER_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'agent', 'mcp-server.mjs')
  : path.join(__dirname, '..', 'agent', 'mcp-server.mjs')

// Diagnostics for the in-app "Connect your AI" panel: is the bridge up, does a real
// loopback HTTP call work, is the MCP server file on disk, and is Node on PATH
// (MCP clients launch the server themselves, so they need their own node).
ipcMain.handle('agent-status', async () => {
  const loopback = await new Promise<{ ok: boolean; detail: string }>(resolve => {
    const req = http.get(`http://127.0.0.1:${AGENT_PORT}/ping`, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c as Buffer))
      res.on('end', () => {
        try { const j = JSON.parse(Buffer.concat(chunks).toString()); resolve({ ok: !!j.ok, detail: `ping answered (v${j.version})` }) }
        catch { resolve({ ok: false, detail: 'ping gave a bad response' }) }
      })
    })
    req.on('error', e => resolve({ ok: false, detail: String(e) }))
    req.setTimeout(3000, () => { req.destroy(); resolve({ ok: false, detail: 'ping timed out' }) })
  })
  const node = await new Promise<{ ok: boolean; version?: string }>(resolve => {
    try {
      const p = spawn('node', ['--version'], { shell: true })
      let out = ''
      p.stdout.on('data', d => { out += d })
      p.on('close', code => resolve(code === 0 && out.trim().startsWith('v') ? { ok: true, version: out.trim() } : { ok: false }))
      p.on('error', () => resolve({ ok: false }))
    } catch { resolve({ ok: false }) }
  })
  return {
    appVersion: app.getVersion(),
    port: AGENT_PORT,
    portOverridden: !!process.env.VH_AGENT_PORT,
    bridge: bridgeState,
    loopback,
    mcpFile: { ok: fs.existsSync(MCP_SERVER_PATH), path: MCP_SERVER_PATH },
    node,
  }
})

// ---------------- SFX library ----------------
// A set of classic cartoon/UI sound effects synthesized with ffmpeg (no downloads, no licensing).
// Generated once into userData/sfx on first request. Users can drop extra .wav/.mp3 files into
// userData/sfx/custom and they appear in the same list.
const SFX_RECIPES: Record<string, { d: number; graph: string }> = {
  whoosh: { d: 0.5, graph: `anoisesrc=d=0.5:c=pink:a=0.6,highpass=f=300,lowpass=f=4500,afade=t=in:d=0.18,afade=t=out:st=0.24:d=0.26,volume=0.7[a]` },
  pop: { d: 0.25, graph: `aevalsrc='0.8*sin(2*PI*880*t)*exp(-t*34)+0.5*sin(2*PI*1760*t)*exp(-t*55)':d=0.25:s=48000,alimiter=limit=0.95[a]` },
  boing: { d: 0.8, graph: `aevalsrc='0.55*sin(2*PI*(150+520*(1-exp(-t*7)))*t+5*sin(2*PI*7*t))*exp(-t*1.6)':d=0.8:s=48000[a]` },
  squish: { d: 0.34, graph: `aevalsrc='0.5*sin(2*PI*(360-260*t/0.34)*t)*exp(-t*4)':d=0.34:s=48000[s];anoisesrc=d=0.34:c=brown:a=0.4,lowpass=f=1600,volume=0.5[n];[s][n]amix=inputs=2:normalize=0,alimiter=limit=0.9[a]` },
  'gummy-squish': { d: 0.45, graph: `aevalsrc='0.5*sin(2*PI*(210-110*t/0.45)*t+3.5*sin(2*PI*9*t))*exp(-t*5)':d=0.45:s=48000[w];anoisesrc=d=0.45:c=brown:a=0.5,bandpass=f=700:w=500,afade=t=in:d=0.04,afade=t=out:st=0.2:d=0.25,volume=0.45[n];[w][n]amix=inputs=2:normalize=0,alimiter=limit=0.9[a]` },
  gloop: { d: 1.0, graph: `aevalsrc='0.55*sin(2*PI*(150-70*t/0.9)*t+4.5*sin(2*PI*5.5*t))*exp(-t*2.2)':d=1:s=48000[g];aevalsrc='0.4*sin(2*PI*300*t)*exp(-t*30)':d=1:s=48000,adelay=140|140[b1];aevalsrc='0.35*sin(2*PI*380*t)*exp(-t*32)':d=1:s=48000,adelay=520|520[b2];anoisesrc=d=1:c=brown:a=0.5,lowpass=f=420,afade=t=out:st=0.5:d=0.5,volume=0.5[r];[g][b1][b2][r]amix=inputs=4:normalize=0,lowpass=f=750,alimiter=limit=0.9[a]` },
  poof: { d: 0.5, graph: `aevalsrc='0.65*sin(2*PI*(105-40*t/0.5)*t)*exp(-t*9)':d=0.5:s=48000[t];anoisesrc=d=0.5:c=pink:a=0.55,lowpass=f=900,afade=t=in:d=0.015,afade=t=out:st=0.08:d=0.4,volume=0.55[p];[t][p]amix=inputs=2:normalize=0,lowpass=f=2200,alimiter=limit=0.9[a]` },
  spoosh: { d: 0.9, graph: `anoisesrc=d=0.9:c=white:a=0.8,highpass=f=380,lowpass=f=9500,afade=t=in:d=0.012,afade=t=out:st=0.12:d=0.75,volume=0.9[s];anoisesrc=d=0.9:c=pink:a=0.7,highpass=f=1800,afade=t=out:st=0.05:d=0.3,volume=0.5[c];aevalsrc='0.4*sin(2*PI*95*t)*exp(-t*16)':d=0.9:s=48000[b];[s][c][b]amix=inputs=3:normalize=0,alimiter=limit=0.9[a]` },
  sparkle: { d: 1.0, graph: `aevalsrc='0.25*(sin(2*PI*2637*t)+sin(2*PI*3520*t)+sin(2*PI*5274*t))*exp(-t*3.2)*(0.6+0.4*sin(2*PI*18*t))':d=1:s=48000[a]` },
  party: { d: 1.4, graph: `aevalsrc='0.7*sin(2*PI*760*t)*exp(-t*30)':d=1.4:s=48000[p];aevalsrc='0.35*(sin(2*PI*(300+700*t/0.35)*t)+0.5*sin(2*PI*2*(300+700*t/0.35)*t))*exp(-t*2.5)':d=1.4:s=48000[h];aevalsrc='0.22*(sin(2*PI*2637*t)+sin(2*PI*3951*t))*exp(-max(0,t-0.15)*3)*(0.5+0.5*sin(2*PI*16*t))':d=1.4:s=48000[k];[p][h][k]amix=inputs=3:normalize=0,alimiter=limit=0.95[a]` },
  riser: { d: 1.2, graph: `aevalsrc='0.4*sin(2*PI*(120+900*t*t/1.44)*t)':d=1.2:s=48000,afade=t=in:d=0.5,afade=t=out:st=1.05:d=0.15[t];anoisesrc=d=1.2:c=pink:a=0.5,highpass=f=500,afade=t=in:d=1.0,volume=0.4[n];[t][n]amix=inputs=2:normalize=0,alimiter=limit=0.9[a]` },
  ding: { d: 0.8, graph: `aevalsrc='0.5*sin(2*PI*1318.5*t)*exp(-t*5)+0.25*sin(2*PI*2637*t)*exp(-t*7)':d=0.8:s=48000[a]` },
  thud: { d: 0.4, graph: `aevalsrc='0.8*sin(2*PI*(90-30*t)*t)*exp(-t*11)':d=0.4:s=48000[t];anoisesrc=d=0.4:c=brown:a=0.4,lowpass=f=300,afade=t=out:st=0.05:d=0.3,volume=0.4[n];[t][n]amix=inputs=2:normalize=0,alimiter=limit=0.9[a]` },
}

const sfxDir = () => path.join(app.getPath('userData'), 'sfx')
const genSfx = (name: string, recipe: { d: number; graph: string }) => new Promise<string>((resolve, reject) => {
  const out = path.join(sfxDir(), `${name}.wav`)
  if (fs.existsSync(out)) return resolve(out)
  const proc = spawn(paths.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-filter_complex', recipe.graph, '-map', '[a]', '-ar', '48000', '-ac', '2', out])
  proc.on('close', code => code === 0 ? resolve(out) : reject(new Error(`sfx ${name} failed (${code})`)))
  proc.on('error', reject)
})

// Returns the full SFX list, generating the built-ins on first call.
// Custom user sounds: drop .wav/.mp3 into <userData>/sfx/custom
ipcMain.handle('sfx-library', async () => {
  const dir = sfxDir()
  const custom = path.join(dir, 'custom')
  fs.mkdirSync(custom, { recursive: true })
  const items: { name: string; path: string; duration: number; builtin: boolean }[] = []
  for (const [name, recipe] of Object.entries(SFX_RECIPES)) {
    try { items.push({ name, path: await genSfx(name, recipe), duration: recipe.d, builtin: true }) }
    catch (e) { console.error(e) }
  }
  for (const f of fs.readdirSync(custom)) {
    if (!/\.(wav|mp3|ogg|m4a|flac)$/i.test(f)) continue
    const p = path.join(custom, f)
    const duration = await new Promise<number>(res => ffmpeg.ffprobe(p, (err, data) => res(err ? 1 : (data.format.duration || 1))))
    items.push({ name: f.replace(/\.[^.]+$/, ''), path: p, duration, builtin: false })
  }
  return { dir: custom, items }
})

ipcMain.handle('open-sfx-folder', async () => {
  const custom = path.join(sfxDir(), 'custom')
  try {
    fs.mkdirSync(custom, { recursive: true })
    // a note in the folder beats an empty window with no explanation
    const readme = path.join(custom, 'READ ME.txt')
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, 'Drop .wav, .mp3, .ogg, .m4a or .flac files in here and they appear in VidHelm\'s SFX tab (hit the refresh arrow, or reopen the app).\r\n\r\nYou can also record your own straight into this folder with the microphone button in that tab.\r\n', 'utf8')
    }
    // openPath returns an error string rather than throwing, so surface it
    const err = await shell.openPath(custom)
    return err ? { error: err, path: custom } : { ok: true, path: custom }
  } catch (e) { return { error: String(e), path: custom } }
})

// Save a recorded sound into the custom SFX folder: trim the silence either side and
// bring the level up, so a phone-quality "boing" is usable the moment it lands.
ipcMain.handle('save-sfx-recording', async (_event, { base64, name }: { base64: string; name: string }) => {
  try {
    const custom = path.join(sfxDir(), 'custom')
    fs.mkdirSync(custom, { recursive: true })
    const tmp = path.join(app.getPath('temp'), `vh_sfx_${Date.now()}.webm`)
    fs.writeFileSync(tmp, Buffer.from(base64, 'base64'))
    const safe = (name || 'my sound').replace(/[<>:"/\\|?*]/g, '').trim().slice(0, 48) || 'my sound'
    let out = path.join(custom, `${safe}.wav`), n = 2
    while (fs.existsSync(out)) out = path.join(custom, `${safe} ${n++}.wav`)

    // 1. trim the dead air either side of the noise you actually made
    const trimmed = path.join(app.getPath('temp'), `vh_sfx_trim_${Date.now()}.wav`)
    const hush = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05'
    await new Promise<void>((resolve, reject) => {
      ffmpeg(tmp).audioFilters([hush, 'areverse', hush, 'areverse'])
        .outputOptions(['-ar 48000', '-ac 2', '-c:a pcm_s16le'])
        .save(trimmed).on('end', () => resolve()).on('error', reject)
    })

    // 2. lift it to a usable level. A one-shot recorded at arm's length is often -20 dB or
    // quieter, and dynamic normalisers barely touch a short decaying sound, so measure the
    // real peak and apply a flat gain to land just under full scale.
    const measured = await runFF(['-hide_banner', '-i', trimmed, '-af', 'volumedetect', '-f', 'null', '-'])
    const peak = parseFloat(measured.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/)?.[1] ?? '-1')
    const gain = Math.max(-6, Math.min(30, -1 - (isFinite(peak) ? peak : -1)))   // never boost noise more than 30 dB
    await new Promise<void>((resolve, reject) => {
      ffmpeg(trimmed).audioFilters([`volume=${gain.toFixed(2)}dB`, 'alimiter=limit=0.94:level=disabled'])
        .outputOptions(['-ar 48000', '-ac 2', '-c:a pcm_s16le'])
        .save(out).on('end', () => resolve()).on('error', reject)
    })
    for (const f of [tmp, trimmed]) { try { fs.unlinkSync(f) } catch { /* temp files, fine either way */ } }
    const duration = await new Promise<number>(res => ffmpeg.ffprobe(out, (err, d) => res(err ? 1 : (d.format.duration || 1))))
    return { path: out, name: path.basename(out).replace(/\.[^.]+$/, ''), duration }
  } catch (e) { return { error: String(e) } }
})

// ---------------- Voice clone (external tool adapter) ----------------
// Runs a user-configured narration command (e.g. an XTTS clone_voice.py wrapper).
// Template placeholders: {script} -> path of a temp file holding the script text (one line per scene),
// {outdir} -> a fresh output dir. When the command exits, every .wav in {outdir} (sorted naturally)
// is returned so the renderer can place them on the timeline.
ipcMain.handle('voice-clone', async (_event, { command, scriptText }: { command: string; scriptText: string }) => {
  if (!command || !command.trim()) return { error: 'No narration command configured (Settings → Narration).' }
  if (!scriptText || !scriptText.trim()) return { error: 'Script is empty.' }
  const workDir = path.join(app.getPath('userData'), 'narration', String(Date.now()))
  fs.mkdirSync(workDir, { recursive: true })
  const scriptFile = path.join(workDir, 'script.txt')
  fs.writeFileSync(scriptFile, scriptText.trim() + '\n', 'utf8')
  const outDir = path.join(workDir, 'out')
  fs.mkdirSync(outDir, { recursive: true })
  const cmd = command.replace(/\{script\}/g, `"${scriptFile}"`).replace(/\{outdir\}/g, `"${outDir}"`)
  return new Promise(resolve => {
    const proc = spawn(cmd, { shell: true, windowsHide: true })
    let log = ''
    proc.stdout?.on('data', d => { log += d; if (win) win.webContents.send('voice-clone-progress', String(d)) })
    proc.stderr?.on('data', d => { log += d; if (win) win.webContents.send('voice-clone-progress', String(d)) })
    proc.on('close', code => {
      const wavs = fs.existsSync(outDir)
        ? fs.readdirSync(outDir).filter(f => /\.wav$/i.test(f))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .map(f => path.join(outDir, f))
        : []
      if (!wavs.length) resolve({ error: `Command finished (code ${code}) but produced no .wav files in {outdir}.`, log: log.slice(-2000) })
      else resolve({ files: wavs, log: log.slice(-2000) })
    })
    proc.on('error', err => resolve({ error: String(err), log: log.slice(-2000) }))
  })
})

ipcMain.handle('export-video', async (_event, { clips, texts, brand, audio, outputPath, settings }: { clips: any[], texts: any[], brand: any, audio: any, outputPath: string, settings: any }) => {
  return new Promise((resolve, reject) => {
    clips = clips || []
    texts = texts || []
    audio = audio || { optimize: settings?.normalizeAudio !== false, noiseReduction: false }
    if (clips.length === 0 && texts.length === 0) return reject('Nothing to export')

    const W = Math.round(settings?.width) || 1920
    const H = Math.round(settings?.height) || 1080
    const FPS = [24, 30, 60].includes(settings?.fps) ? settings.fps : 30
    const master = typeof settings?.masterVolume === 'number' ? settings.masterVolume : 1
    const fontFile = escFilter(path.join(process.env.WINDIR || 'C:/Windows', 'Fonts', 'arial.ttf'))
    const ends = [...clips.map(c => c.start + c.duration), ...texts.map(t => t.start + t.duration)]
    const totalDuration = ends.length ? Math.max(...ends) : 1

    const tmpDir = path.join(app.getPath('temp'), 'vidhelm_text')
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })

    let command = ffmpeg()
    // 0: black base video at target resolution/fps, 1: silent base audio at 48kHz (YouTube spec)
    command.input(`color=c=black:s=${W}x${H}:r=${FPS}:d=${totalDuration}`).inputFormat('lavfi')
    command.input(`anullsrc=channel_layout=stereo:sample_rate=48000:d=${totalDuration}`).inputFormat('lavfi')

    const filterComplex: string[] = []
    let currentVOut = '0:v'
    const audioMixInputs: string[] = ['1:a']

    clips.forEach((clip, i) => {
      const idx = i + 2
      const end = clip.start + clip.duration
      if (clip.type === 'image') {
        command.input(clip.path).inputOptions([`-loop 1`, `-t ${clip.duration}`])
      } else {
        command.input(clip.path)
      }

      if (clip.hasVideo || clip.type === 'image') {
        // Fit into frame with transparent padding so overlapping clips can crossfade through each other
        let v = `[${idx}:v]format=yuva420p,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setpts=PTS-STARTPTS+${clip.start}/TB`
        if (clip.fadeIn > 0) v += `,fade=t=in:st=${clip.start}:d=${clip.fadeIn}:alpha=1`
        if (clip.fadeOut > 0) v += `,fade=t=out:st=${(end - clip.fadeOut).toFixed(3)}:d=${clip.fadeOut}:alpha=1`
        filterComplex.push(`${v}[v_scaled_${idx}]`)
        filterComplex.push(`[${currentVOut}][v_scaled_${idx}]overlay=enable='between(t,${clip.start},${end})':eof_action=pass[v_out_${idx}]`)
        currentVOut = `v_out_${idx}`
      }

      if (clip.hasAudio) {
        const vExpr = volumeExpr(clip.volumePoints, clip.start, clip.volume ?? 1.0)
        let a = `[${idx}:a]aresample=48000,adelay=${Math.round(clip.start * 1000)}|${Math.round(clip.start * 1000)}`
        // Volume automation (graph) takes precedence over the flat per-clip volume
        a += vExpr ? `,volume='${vExpr}':eval=frame` : `,volume=${clip.volume ?? 1.0}`
        if (clip.fadeIn > 0) a += `,afade=t=in:st=${clip.start}:d=${clip.fadeIn}`
        if (clip.fadeOut > 0) a += `,afade=t=out:st=${(end - clip.fadeOut).toFixed(3)}:d=${clip.fadeOut}`
        filterComplex.push(`${a}[a_delayed_${idx}]`)
        audioMixInputs.push(`a_delayed_${idx}`)
      }
    })

    // Burn in text overlays on top of the video chain
    texts.forEach((t, i) => {
      const end = t.start + t.duration
      const txtFile = path.join(tmpDir, `t_${i}_${Date.now()}.txt`)
      fs.writeFileSync(txtFile, String(t.text ?? ''), 'utf8')
      const color = `0x${(t.color || '#ffffff').replace('#', '')}`
      const size = Math.max(8, Math.round((t.fontSize / 1080) * H))
      const dt = [
        `fontfile='${fontFile}'`,
        `textfile='${escFilter(txtFile)}'`,
        `fontcolor=${color}`,
        `fontsize=${size}`,
        `x=${Math.round(t.x * W)}-text_w/2`,
        `y=${Math.round(t.y * H)}-text_h/2`,
        ...(t.box ? [`box=1`, `boxcolor=black@${typeof t.boxOpacity === 'number' ? t.boxOpacity : 0.5}`, `boxborderw=${Math.round(size * 0.25)}`] : [`box=0`]),
        `enable='between(t,${t.start},${end})'`,
        `alpha='${alphaExpr(t.start, end, t.fadeIn || 0, t.fadeOut || 0)}'`,
      ].join(':')
      filterComplex.push(`[${currentVOut}]drawtext=${dt}[v_txt_${i}]`)
      currentVOut = `v_txt_${i}`
    })

    // Brand logo / outro watermark (applied on top of everything), from persistent settings
    if (brand && brand.enabled && brand.logoPath && fs.existsSync(brand.logoPath)) {
      const logoIdx = 2 + clips.length
      command.input(brand.logoPath).inputOptions(['-loop 1', '-t', String(totalDuration)])
      const m = Math.round((brand.margin ?? 40) / 1080 * H)
      const logoW = Math.max(16, Math.round((brand.sizePct ?? 16) / 100 * W))
      const op = typeof brand.opacity === 'number' ? brand.opacity : 0.85
      const fade = brand.fade ?? 0.5
      let s = 0, e = totalDuration
      if (brand.showMode === 'intro') { s = 0; e = Math.min(totalDuration, brand.windowSec ?? 5) }
      else if (brand.showMode === 'outro') { s = Math.max(0, totalDuration - (brand.windowSec ?? 5)); e = totalDuration }
      const posMap: Record<string, string> = {
        tl: `${m}:${m}`,
        tr: `main_w-overlay_w-${m}:${m}`,
        bl: `${m}:main_h-overlay_h-${m}`,
        br: `main_w-overlay_w-${m}:main_h-overlay_h-${m}`,
        center: `(main_w-overlay_w)/2:(main_h-overlay_h)/2`,
      }
      let lf = `[${logoIdx}:v]format=rgba,scale=${logoW}:-1,colorchannelmixer=aa=${op}`
      if (fade > 0) { lf += `,fade=t=in:st=${s}:d=${fade}:alpha=1,fade=t=out:st=${(e - fade).toFixed(3)}:d=${fade}:alpha=1` }
      filterComplex.push(`${lf}[logo]`)
      filterComplex.push(`[${currentVOut}][logo]overlay=${posMap[brand.position] || posMap.br}:enable='between(t,${s},${e})'[v_brand]`)
      currentVOut = 'v_brand'
    }

    // Audio: mix (normalize=0 so per-clip volumes are honored) → denoise → master gain → loudness optimize
    if (audioMixInputs.length > 1) {
      filterComplex.push(`${audioMixInputs.map(a => `[${a}]`).join('')}amix=inputs=${audioMixInputs.length}:duration=first:dropout_transition=0:normalize=0[amixed]`)
      let chain = '[amixed]'
      if (audio.noiseReduction) { filterComplex.push(`${chain}highpass=f=80,afftdn=nf=-25[aclean]`); chain = '[aclean]' }
      filterComplex.push(`${chain}volume=${master}[amaster]`)
      // "Loud for YouTube" master: compress dynamics for higher perceived loudness, then land at -13 LUFS
      // (the loud end of YouTube's window; tighter LRA=7 = denser/punchier). loudnorm runs single-pass here,
      // and its internal true-peak limiter only approximates the ceiling, it measured -0.9 dBTP against the
      // -1 dBTP target, i.e. the export failed our own quality check. Asking loudnorm for -1.5 and following
      // it with a hard ceiling leaves enough room for inter-sample peaks to still land under -1 dBTP.
      // level=disabled matters: without it alimiter re-normalises the level and undoes loudnorm.
      filterComplex.push(audio.optimize
        ? `[amaster]acompressor=threshold=-18dB:ratio=3:attack=20:release=250:makeup=3,loudnorm=I=-13:LRA=7:TP=-1.5,alimiter=limit=0.85:level=disabled[aout]`
        : `[amaster]alimiter=limit=0.891:level=disabled[aout]`)
    } else {
      filterComplex.push(`[1:a]volume=${master}[aout]`)
    }

    command
      .complexFilter(filterComplex)
      .map(`[${currentVOut}]`)
      .map(`[aout]`)
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('384k')
      .audioFrequency(48000)
      .audioChannels(2)
      .outputOptions([
        // x264 tuned for YouTube: High profile, fixed 2s closed GOP, BT.709 SDR color.
        // 'analysis' is the exception: a throwaway render for a video-analysis service, where
        // speed and upload size matter and picture quality does not.
        '-preset', settings?.quality === 'high' ? 'medium' : settings?.quality === 'analysis' ? 'veryfast' : 'fast',
        '-crf', settings?.quality === 'high' ? '17' : settings?.quality === 'analysis' ? '30' : '20',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p',
        '-r', String(FPS),
        '-g', String(FPS * 2),
        '-keyint_min', String(FPS * 2),
        '-sc_threshold', '0',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-movflags', '+faststart',
        '-t', totalDuration.toString(),
      ])
      .on('start', (cmd) => console.log('FFmpeg started:', cmd))
      .on('progress', (progress) => { if (win) win.webContents.send('export-progress', progress.percent) })
      .on('end', () => resolve({ success: true }))
      .on('error', (err) => { console.error('FFmpeg error:', err); reject(err) })
      .save(outputPath)
  })
})
