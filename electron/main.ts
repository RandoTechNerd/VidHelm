import { app, BrowserWindow, Menu, ipcMain, dialog, shell, screen, nativeTheme, type WebContents } from 'electron'
import { restoreDragOffset, plainDragOffset, shouldSnapMaximize } from './dragMath'
import { findModelInHtml } from './modelSniff'
import { buildAss, chooseTheme, THEME_FONTS, type ThemeFont } from './styletheme'
import { scoreFrame, rankFrames, sampleTimes, thumbTextLayout, photoNudge, type FrameScore } from './thumbpick'
import { planProxy, proxyFilter, proxyFits, proxyKey, quarterTurn, HDR_TO_SDR, type ProbeInfo } from './playable'
import { refineFromEnvelope } from './speech'
import { planCrop, cropExpr, type Frame as GrayFrame } from './framing'
import { classify, profileFor, benchmark, type MachineSpecs } from './capability'
import { REALISTIC_RECIPES, REALISTIC_REV } from './sfxrecipes'
import { toWav } from './sfxsynth'
import { freesoundUrl, commonsUrl, parseFreesound, parseCommons, collate, attributionLine, safeFilename, classifyLicense } from './sfxsearch'
import { matchRecipe, nameToFilename, MIN_CONFIDENCE } from './sfxmatch'
import { composeScore, type Intensity, type Style } from './score'
import { spellOut, parseTable, mergeTables } from './pronounce'
import { planVisualIndex, timecode, stackLayout } from './visual'
import { readZip, parseHandoff, downloadList, buildProject, entriesToWrite, isCloudMediaUrl, CLOUD_ORIGINS } from './cloudimport'
import { generateClip, videoGenAvailable, estimateUsd, VIDEO_MODELS, GenTimeout } from './videogen'
import { bridgeTimeoutMs, QUICK_MS } from '../agent/timeouts.mjs'
import { stillInput, clipAudioChain, masterChain, friendlyExportError, stderrTail, UNREADABLE_STILL } from './exportgraph'
import { bridgeRefusal, commandForEditor, replyAlias, replyKey, type PendingReply } from './bridgeguard'
import { isAppNavigation, externalLink } from './navguard'
import { pathToFileURL } from 'node:url'
import { PeakBucketer, peakDecodeArgs, PEAK_RATE, PEAK_VERSION } from './peaks'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import https from 'node:https'
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
// style-theme fonts (OFL): public/fonts in dev, copied beside the app by electron-builder when packaged
const themeFontsDir = () => app.isPackaged ? path.join(process.resourcesPath, 'fonts') : path.join(__dirname, '..', 'public', 'fonts')
ffmpeg.setFfmpegPath(paths.ffmpeg)
ffmpeg.setFfprobePath(paths.ffprobe)

process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public')

let win: BrowserWindow | null

// The window buttons are drawn by Windows over the header, so they must match its colours
// (src/App.css --bg-header / --text-muted) and its height in each theme.
const TITLEBAR_H = 40
const TITLEBAR = {
  dark: { color: '#141416', symbolColor: '#a1a1aa' },
  light: { color: '#ffffff', symbolColor: '#52525b' },
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'VidHelm',
    icon: path.join(process.env.VITE_PUBLIC, 'icon.png'),   // SVG is not a valid window/taskbar icon on Windows
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...TITLEBAR.dark, height: TITLEBAR_H },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      // The 3D Studio records its WebGL canvas through requestAnimationFrame +
      // captureStream(30). Electron otherwise throttles those frames whenever
      // VidHelm is backgrounded, producing a nominal 30 fps file with only a
      // handful of unique frames per second.
      backgroundThrottling: false,
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

  // Unsaved work. The renderer blocks unloading (window.onbeforeunload) while the timeline has
  // changes that are not saved; Chromium then asks main what to do, and with no handler here the
  // close was silently cancelled or, worse, hours of editing went with one click on the X.
  // event.preventDefault() here means "ignore the page's objection and leave".
  // 'close' fires before the page's beforeunload, so it tells a real close (the X, Alt+F4, quitting)
  // from a reload: only a close can offer Save, because the renderer finishes it with window.close().
  let closing = false
  win.on('close', () => { closing = true })
  win.webContents.on('will-prevent-unload', (event) => {
    const isClose = closing
    closing = false   // whatever is chosen here, the next close or reload asks again
    if (process.env.VH_SHOOT) { event.preventDefault(); return }   // the screenshot helper quits unattended
    if (isClose) {
      const choice = dialog.showMessageBoxSync(win!, {
        type: 'warning',
        title: 'Unsaved changes',
        message: 'This project has changes that are not saved.',
        detail: "Save them before closing? Don't save and they are lost.",
        buttons: ['Save', "Don't save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })
      // Save: the close is cancelled here, the renderer saves and then closes the window itself; a
      // save that fails or is cancelled (no file picked) leaves the window open with the work in it
      if (choice === 0) win!.webContents.send('save-before-close')
      else if (choice === 1) event.preventDefault()
      return
    }
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      title: 'Unsaved changes',
      message: 'This project has changes that are not saved.',
      detail: 'Leave now and they are lost. Stay to go back and save them first.',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    if (choice === 0) event.preventDefault()
  })

  // If the editor itself dies, say so rather than leave a blank window with a dead agent bridge
  // (the bridge talks to the page, so every agent call would just time out).
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('renderer gone:', details.reason, details.exitCode)
    if (details.reason === 'clean-exit' || !win || win.isDestroyed()) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'error',
      title: 'VidHelm stopped',
      message: 'The editor stopped unexpectedly.',
      detail: `Reason: ${details.reason}. Reload it to keep working; anything since your last save may be gone.`,
      buttons: ['Reload', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (choice === 0) win.webContents.reload()
    else app.quit()
  })

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

// No application menu in the installed app. The window has no menu bar to show one, but
// Electron's default menu still owned its accelerators: Ctrl+R reloaded the editor (and threw the
// timeline away), Ctrl+W closed it, Ctrl+M minimised it, and DevTools, zoom and full screen were
// all one chord away. The editor's own keys live in electron/shortcuts.ts. A development run
// keeps the default menu for reload and DevTools.
app.whenReady().then(() => {
  if (app.isPackaged) Menu.setApplicationMenu(null)
  createWindow()
})

// The editor window may only ever show the editor (electron/navguard.ts has the why): every web
// contents gets the rules as it is created. Navigating away is refused, a new window is refused
// (a web link goes to the real browser instead) and no <webview> can be attached. The capture_site
// window is the one exception, for navigation only: loading other sites is its whole job, and
// sites redirect and route.
const freeToNavigate = new WeakSet<WebContents>()
const APP_PAGE = { devServer: process.env.VITE_DEV_SERVER_URL || null, indexUrl: pathToFileURL(path.join(process.env.DIST, 'index.html')).href }
app.on('web-contents-created', (_event, contents) => {
  const guard = (e: { preventDefault(): void }, url: string) => {
    if (freeToNavigate.has(contents) || isAppNavigation(url, APP_PAGE)) return
    e.preventDefault()
    console.warn('refused to navigate the window to', url)
  }
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  contents.setWindowOpenHandler(({ url }) => {
    const link = externalLink(url)
    if (link) void shell.openExternal(link)
    return { action: 'deny' }
  })
  contents.on('will-attach-webview', e => e.preventDefault())
})

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

// Rank frames for a thumbnail: sharp, well exposed, colourful, a person (skin) in the middle,
// near-duplicates dropped. Scored from tiny raw RGB frames, then the keepers are saved as JPGs.
ipcMain.handle('rank-frames', async (_event, { filePath, count = 24, keep = 8, sourceStart = 0, duration }: { filePath: string; count?: number; keep?: number; sourceStart?: number; duration?: number }) => {
  if (!filePath || !fs.existsSync(filePath)) return { error: 'no file' }
  const dur: number = duration || await new Promise(res => ffmpeg.ffprobe(filePath, (e, d) => res(e ? 0 : (d.format.duration || 0))))
  if (!dur) return { error: 'cannot read duration' }
  const SW = 160, SH = 90
  const grab = (t: number) => new Promise<Buffer | null>(res => {
    const p = spawn(paths.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', filePath, '-frames:v', '1',
      '-vf', `scale=${SW}:${SH}:force_original_aspect_ratio=increase,crop=${SW}:${SH}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    const parts: Buffer[] = []
    p.stdout.on('data', d => parts.push(d))
    p.on('close', () => { const b = Buffer.concat(parts); res(b.length === SW * SH * 3 ? b : null) })
    p.on('error', () => res(null))
  })
  const scored: { t: number; score: FrameScore }[] = []
  const times = sampleTimes(dur, Math.max(4, Math.min(60, count)), sourceStart)
  for (let i = 0; i < times.length; i += 4) {   // four decoders at a time
    const batch = await Promise.all(times.slice(i, i + 4).map(async t => ({ t, buf: await grab(t) })))
    for (const b of batch) if (b.buf) scored.push({ t: b.t, score: scoreFrame(new Uint8Array(b.buf), SW, SH) })
  }
  if (!scored.length) return { error: 'no frames could be read' }
  const best = rankFrames(scored, Math.max(1, Math.min(12, keep)))
  const dir = path.join(app.getPath('temp'), 'vidhelm_frames', 'rank_' + Date.now())
  fs.mkdirSync(dir, { recursive: true })
  const frames: { t: number; path: string; score: number; why: string }[] = []
  for (const [i, f] of best.entries()) {
    const out = path.join(dir, `best_${i}.jpg`)
    await new Promise<void>(res => { const p = spawn(paths.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(f.t), '-i', filePath, '-frames:v', '1', '-vf', 'scale=480:-2', out]); p.on('close', () => res()); p.on('error', () => res()) })
    const sc = f.score
    const why = [sc.sharpness > 0.6 ? 'sharp' : sc.sharpness < 0.35 ? 'soft' : '', sc.skin > 0.5 ? 'person in shot' : '', sc.exposure < 0.5 ? (sc.exposure < 0.3 ? 'badly exposed' : 'a bit dark/bright') : '', sc.color > 0.55 ? 'colourful' : ''].filter(Boolean).join(', ')
    if (fs.existsSync(out)) frames.push({ t: f.t, path: out, score: sc.score, why })
  }
  return { frames, sampled: scored.length }
})

// Compose a YouTube thumbnail -> 1280x720 PNG. The picture is, in order of preference: the creator's
// own photo (imagePath), a real frame of the video (filePath at t), or a placeholder card that says it
// is one. Text and colours come from the style theme; a second line ("hook | detail") is the accent.
ipcMain.handle('compose-thumbnail', async (_event, { filePath, t, imagePath, subtitle, logoPath, outPath, theme }: { filePath?: string | null; t?: number; imagePath?: string | null; subtitle?: string; logoPath?: string | null; outPath: string; theme?: string }) => {
  // an image file only: the agent bridge reaches this, and a thumbnail has no business writing a .cmd or a .json
  if (!outPath || !/\.(png|jpe?g|webp)$/i.test(outPath)) return { error: 'outPath must be an image file (.png or .jpg)' }
  const source: 'photo' | 'frame' | 'placeholder' = imagePath && fs.existsSync(imagePath) ? 'photo' : filePath && fs.existsSync(filePath) ? 'frame' : 'placeholder'
  const spec = chooseTheme(theme || 'randotechnerd').thumb
  const fi = THEME_FONTS[spec.font]
  const fontFile = escFilter(path.join(themeFontsDir(), fi.file))
  const hasLogo = !!(logoPath && fs.existsSync(logoPath))
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  if (source === 'photo') args.push('-i', imagePath!)
  else if (source === 'frame') args.push('-ss', String(t ?? 1), '-i', filePath!)
  else args.push('-f', 'lavfi', '-i', 'color=c=0x0d1b26:s=1280x720:d=1')
  if (hasLogo) args.push('-i', logoPath!)
  let vf = `[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1`
  if (source === 'placeholder') {
    // obviously not finished: a dashed photo frame and a label, so it never ships by accident
    const ph = path.join(app.getPath('temp'), `rs_ph_${Date.now()}.txt`)
    fs.writeFileSync(ph, 'YOUR PHOTO HERE', 'utf8')
    vf += `,drawbox=x=640:y=60:w=580:h=600:color=white@0.10:t=fill`
    for (let k = 0; k < 12; k++) vf += `,drawbox=x=${652 + k * 48}:y=60:w=24:h=6:color=white@0.5:t=fill,drawbox=x=${652 + k * 48}:y=654:w=24:h=6:color=white@0.5:t=fill`
    for (let k = 0; k < 12; k++) vf += `,drawbox=x=640:y=${72 + k * 48}:w=6:h=24:color=white@0.5:t=fill,drawbox=x=1214:y=${72 + k * 48}:w=6:h=24:color=white@0.5:t=fill`
    vf += `,drawtext=fontfile='${fontFile}':textfile='${escFilter(ph)}':expansion=none:fontcolor=white@0.55:fontsize=46:x=930-text_w/2:y=360-text_h/2`
  } else {
    // a smooth dark gradient rising from the bottom keeps the text readable on any photo (no visible band)
    vf += `[pic];color=c=black:s=1280x720:d=1,format=rgba,geq=r=0:g=0:b=0:a='255*0.62*pow(max(0\,(Y-280)/440)\,1.6)'[shade];[pic][shade]overlay=0:0:format=auto`
  }
  const lines = thumbTextLayout(subtitle || '', spec)
  const tmpFiles: string[] = []
  for (const [i, ln] of lines.entries()) {
    const tf = path.join(app.getPath('temp'), `rs_sub_${Date.now()}_${i}.txt`)
    fs.writeFileSync(tf, ln.text, 'utf8'); tmpFiles.push(tf)
    const stroke = spec.stroke > 0 ? `:borderw=${Math.max(2, Math.round(ln.size * spec.stroke))}:bordercolor=0x${spec.strokeColor.slice(1)}` : ''
    const plate = spec.plate ? `:box=1:boxcolor=0x${spec.plate.slice(1)}@0.92:boxborderw=${Math.round(ln.size * 0.22)}` : ''
    // expansion=none: with the default, '%' starts an expansion sequence and '100% WORTH IT' drew nothing at all
    vf += `,drawtext=fontfile='${fontFile}':textfile='${escFilter(tf)}':expansion=none:fontcolor=0x${ln.color.slice(1)}:fontsize=${ln.size}${stroke}${plate}:shadowcolor=black@0.5:shadowx=4:shadowy=4:x=48:y=${ln.y}`
  }
  if (hasLogo) { vf += `[base];[1:v]format=rgba,scale=170:-1[lg];[base][lg]overlay=main_w-overlay_w-28:28` }
  args.push('-filter_complex', vf, '-frames:v', '1', outPath)
  return new Promise(resolve => {
    const p = spawn(paths.ffmpeg, args)
    let err = ''; p.stderr.on('data', d => err += d)
    p.on('close', code => {
      for (const f of tmpFiles) fs.rm(f, () => {})
      resolve(code === 0 && fs.existsSync(outPath) ? { ok: true, outPath, source, placeholder: source === 'placeholder', ...(photoNudge(source) ? { nudge: photoNudge(source) } : {}) } : { error: err.slice(-400) || 'compose failed' })
    })
    p.on('error', e => resolve({ error: String(e) }))
  })
})

ipcMain.handle('open-external', async (_event, url: string) => {
  // ms-settings: opens a Windows Settings page (the booth links the Sound page for the mic)
  if (/^(https?:\/\/|mailto:|ms-settings:)/.test(url)) shell.openExternal(url)
})

ipcMain.handle('reveal-file', async (_event, filePath: string) => {
  if (filePath) shell.showItemInFolder(filePath)
})

// Setup lines like `pip install adversal-cli` have to be typed somewhere, and "open a terminal"
// is a step people get stuck on. This opens one in the user's home folder, nothing is run for
// them: the command is on the clipboard and they paste it, so they see what they are running.
ipcMain.handle('open-terminal', async () => {
  const home = os.homedir()
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', 'powershell.exe', '-NoExit', '-Command', `Set-Location -LiteralPath '${home.replace(/'/g, "''")}'`],
        { detached: true, stdio: 'ignore', windowsHide: false }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', home], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('x-terminal-emulator', [], { cwd: home, detached: true, stdio: 'ignore' }).unref()
    }
    return { ok: true }
  } catch (e) { return { error: String(e) } }
})

// Generate a horizontal filmstrip (tiled frames) for a video clip's source range, for timeline previews
ipcMain.handle('make-thumbnails', async (_event, { filePath, sourceStart, duration, count: want }: { filePath: string; sourceStart: number; duration: number; count?: number }) => {
  if (!filePath || !fs.existsSync(filePath)) return { error: 'no file' }
  const dir = path.join(app.getPath('temp'), 'vidhelm_thumbs')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`)
  // the renderer sizes the count so each 160x90 frame keeps its shape on the clip; a short clip
  // needs one or two, and forcing four squeezed them
  const count = Math.max(1, Math.min(120, Math.round(want || 8)))
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

// Waveform peaks for the timeline (electron/peaks.ts): the file's audio decoded once at 8 kHz mono,
// the loudest sample of every 10 ms kept as a byte while it streams (the PCM is never held), and
// the result cached by the file's identity so a project reopens with its waveforms already drawn.
// Always the ORIGINAL file: a preview copy's audio may be re-encoded or missing.
const peaksBuilds = new Map<string, Promise<{ rate?: number; data?: Uint8Array; error?: string }>>()
ipcMain.handle('audio-peaks', async (_event, { filePath }: { filePath: string }) => {
  if (!filePath || !fs.existsSync(filePath)) return { error: 'no file' }
  const st = fs.statSync(filePath)
  const key = crypto.createHash('sha1').update(`${PEAK_VERSION}|${filePath}|${st.size}|${st.mtimeMs}`).digest('hex')
  const dir = path.join(app.getPath('userData'), 'peaks')
  const cached = path.join(dir, key + '.bin')
  if (fs.existsSync(cached)) {
    try { return { rate: PEAK_RATE, data: new Uint8Array(fs.readFileSync(cached)) } } catch { /* unreadable: decode again */ }
  }
  const running = peaksBuilds.get(key)
  if (running) return await running
  const job = new Promise<{ rate?: number; data?: Uint8Array; error?: string }>(resolve => {
    const b = new PeakBucketer()
    let err = ''
    const p = spawn(paths.ffmpeg, peakDecodeArgs(filePath))
    p.stdout.on('data', (d: Buffer) => b.pushBytes(d))
    p.stderr.on('data', d => { err = (err + d).slice(-2000) })
    p.on('error', e => resolve({ error: String(e) }))
    p.on('close', code => {
      const data = b.finish()
      if (!data.length) return resolve({ error: err.trim().split(/\r?\n/).pop() || 'no audio could be read' })
      // only a clean decode is kept: a damaged tail would otherwise be remembered as silence
      if (code === 0) {
        try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(cached + '.part', data); fs.renameSync(cached + '.part', cached) } catch { /* the drawing still works, just uncached */ }
      }
      resolve({ rate: PEAK_RATE, data })
    })
  }).finally(() => peaksBuilds.delete(key))
  peaksBuilds.set(key, job)
  return await job
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

    // Process in 30s segments (Whisper's window) so we can report real progress.
    //
    // The windows OVERLAP. Slicing on an exact 30s boundary lands mid-word roughly every time,
    // and a word cut in half is either transcribed wrong or lost from both sides, which is
    // exactly the sort of hole that later makes a cut land in the wrong place. The overlap is
    // then de-duplicated: the same word spoken once must not come back twice.
    const sr = 16000, chunkSec = 30
    const overlap = Math.max(0, Math.min(5, opts.overlap ?? 1.5))
    const stride = chunkSec - overlap
    const nChunks = Math.max(1, Math.ceil(Math.max(0, audio.length / sr - overlap) / stride))
    const genOpts: any = { return_timestamps: opts.word ? 'word' : true }
    if (!useEn) { genOpts.task = 'transcribe'; if (lang !== 'auto') genOpts.language = lang }
    const results: { start: number; end: number; text: string }[] = []
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    for (let i = 0; i < nChunks; i++) {
      const from = Math.round(i * stride * sr)
      const seg = audio.subarray(from, Math.min(audio.length, from + chunkSec * sr))
      if (seg.length < sr * 0.2) break
      const out = await asr(seg, genOpts)
      const offset = from / sr
      for (const c of (out.chunks || [])) {
        const text = (c.text || '').trim()
        if (!text) continue
        const start = (c.timestamp?.[0] ?? 0) + offset
        const end = (c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0) + offset
        // already heard, in the overlap: same words at nearly the same time
        const dupe = results.some(r => norm(r.text) === norm(text) && Math.abs(r.start - start) < Math.max(0.8, overlap * 0.6))
        if (dupe) continue
        results.push({ start, end, text })
      }
      if (win) win.webContents.send('transcribe-progress', { stage: 'transcribe', pct: Math.round(((i + 1) / nChunks) * 100) })
    }
    results.sort((a, b) => a.start - b.start)
    return { chunks: results }
  } catch (e: any) {
    console.error('transcribe error', e)
    return { error: e?.message || 'Transcription failed' }
  }
})

// ---------------------------------------------------------------------------
// B-roll: measure a folder of footage, and refine cuts against the waveform
// ---------------------------------------------------------------------------

/** Labels live next to the footage, so they survive a restart and can be edited by hand. */
const BROLL_SIDECAR = '.vidhelm-broll.json'
const readSidecar = (folder: string): Record<string, any> => {
  try { return JSON.parse(fs.readFileSync(path.join(folder, BROLL_SIDECAR), 'utf8')) || {} } catch { return {} }
}
const writeSidecar = (folder: string, data: Record<string, any>) => {
  fs.writeFileSync(path.join(folder, BROLL_SIDECAR), JSON.stringify(data, null, 2), 'utf8')
}

/**
 * Decode a clip to tiny greyscale frames. 64x36 at 4fps is a few hundred kilobytes for a whole
 * clip and is plenty to answer "where is the subject" and "is anything moving".
 */
const decodeGrayFrames = (file: string, opts: { start?: number; duration?: number; fps?: number; w?: number; h?: number } = {}) =>
  new Promise<GrayFrame[]>(resolve => {
    const w = opts.w ?? 64, h = opts.h ?? 36, fps = opts.fps ?? 4
    const args = ['-hide_banner', '-loglevel', 'error']
    if (opts.start) args.push('-ss', String(opts.start))
    if (opts.duration) args.push('-t', String(opts.duration))
    args.push('-i', file, '-an', '-vf', `fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=disable,format=gray`, '-f', 'rawvideo', '-')
    const p = spawn(paths.ffmpeg, args)
    const chunks: Buffer[] = []
    p.stdout.on('data', d => chunks.push(d))
    p.on('error', () => resolve([]))
    p.on('close', () => {
      const buf = Buffer.concat(chunks)
      const size = w * h
      const frames: GrayFrame[] = []
      for (let i = 0; (i + 1) * size <= buf.length; i++) {
        frames.push({ t: +((opts.start ?? 0) + i / fps).toFixed(3), w, h, gray: buf.subarray(i * size, (i + 1) * size) })
      }
      resolve(frames)
    })
  })

/**
 * The part of a clip actually worth cutting to.
 *
 * Handheld b-roll starts with a lurch (reaching for record) and ends with another one, and
 * often has a blown or black frame at each end. This finds the longest stretch that is properly
 * exposed and not being thrown around, so `place_broll` uses the steady middle.
 */
const usableRange = (frames: GrayFrame[], minLen = 1.2): { start: number; end: number } | null => {
  if (frames.length < 3) return null
  const step = frames.length > 1 ? frames[1].t - frames[0].t : 0.25
  const mean = (f: GrayFrame) => { let s = 0; for (let i = 0; i < f.gray.length; i++) s += f.gray[i]; return s / f.gray.length }
  const motion: number[] = [0]
  for (let i = 1; i < frames.length; i++) {
    let d = 0
    for (let k = 0; k < frames[i].gray.length; k++) d += Math.abs(frames[i].gray[k] - frames[i - 1].gray[k])
    motion.push(d / frames[i].gray.length)
  }
  const sorted = [...motion].sort((a, b) => a - b)
  const median = sorted[sorted.length >> 1] || 0
  const chaos = Math.max(12, median * 3.5)      // a whip-pan, not a subject moving
  const good = frames.map((f, i) => {
    const b = mean(f)
    return b > 26 && b < 232 && motion[i] < chaos
  })
  let best = { from: -1, to: -1 }, from = -1
  for (let i = 0; i <= good.length; i++) {
    if (i < good.length && good[i]) { if (from < 0) from = i }
    else if (from >= 0) {
      if (i - from > best.to - best.from) best = { from, to: i }
      from = -1
    }
  }
  if (best.from < 0) return null
  // trim a breath off each end so the cut is not sitting on the edge of the good part
  const pad = Math.min(0.3, step * 2)
  const start = +(frames[best.from].t + pad).toFixed(2)
  const end = +(frames[Math.min(frames.length - 1, best.to - 1)].t - pad).toFixed(2)
  return end - start >= minLen ? { start, end } : null
}

/**
 * A contact sheet: one image showing the whole clip, so it can be labelled in a single look.
 *
 * Grabs each tile with its own fast seek rather than running `fps=n/duration` over the file.
 * The single-pass version has to DECODE THE WHOLE CLIP to emit its last tile, which is fine for
 * a five second cutaway and takes minutes on anything long. This is a handful of seeks.
 */
const contactSheet = async (file: string, duration: number, out: string, cols = 3, rows = 2): Promise<boolean> => {
  const n = cols * rows
  const dir = path.join(app.getPath('temp'), 'vidhelm_tiles', String(Date.now()))
  fs.mkdirSync(dir, { recursive: true })
  const tiles: string[] = []
  for (let i = 0; i < n; i++) {
    const t = duration > 0 ? ((i + 0.5) / n) * duration : 0
    const tile = path.join(dir, `t_${i}.jpg`)
    await new Promise<void>(res => {
      const p = spawn(paths.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3),
        '-i', file, '-an', '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '3', tile])
      p.on('close', () => res()); p.on('error', () => res())
    })
    if (fs.existsSync(tile)) tiles.push(tile)
  }
  if (!tiles.length) return false
  const ok = await new Promise<boolean>(res => {
    const args = ['-y', '-hide_banner', '-loglevel', 'error']
    for (const t of tiles) args.push('-i', t)
    // stack whatever came back, in whatever grid actually fits
    const usedCols = Math.min(cols, tiles.length)
    const usedRows = Math.ceil(tiles.length / usedCols)
    const inputs = tiles.map((_, i) => `[${i}:v]`).join('')
    args.push('-filter_complex', `${inputs}xstack=inputs=${tiles.length}:layout=${
      stackLayout(tiles.length, usedCols)
    }:fill=black[v]`, '-map', '[v]', '-frames:v', '1', '-q:v', '3', out)
    void usedRows
    const p = spawn(paths.ffmpeg, args)
    p.on('close', () => res(fs.existsSync(out)))
    p.on('error', () => res(false))
  })
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir, never fatal */ }
  return ok
}

const VIDEO_RE = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|mpg|mpeg|ts|m2ts|mts|3gp|ogv|mxf)$/i
const STILL_RE = /\.(png|jpg|jpeg|jfif|webp|bmp|tif|tiff|avif)$/i

/**
 * Walk a folder of b-roll and measure every clip: how long, does it have sound, which part is
 * usable, and a contact sheet to look at. Labels already written for a file are handed back so
 * a re-scan does not lose them, and `needsLabels` says which ones still have to be looked at.
 */
ipcMain.handle('scan-broll', async (_event, { folder, refresh, tiles }: { folder: string; refresh?: boolean; tiles?: number }) => {
  if (!folder || !fs.existsSync(folder)) return { error: 'folder not found' }
  let names: string[] = []
  try { names = fs.readdirSync(folder) } catch (e: any) { return { error: String(e?.message || e) } }
  const files = names.filter(n => VIDEO_RE.test(n) || STILL_RE.test(n)).sort()
  if (!files.length) return { error: `no footage in ${folder}`, assets: [] }

  const side = readSidecar(folder)
  const sheetDir = path.join(app.getPath('temp'), 'vidhelm_broll')
  if (!fs.existsSync(sheetDir)) fs.mkdirSync(sheetDir, { recursive: true })

  const assets: any[] = []
  for (const name of files) {
    const full = path.join(folder, name)
    const still = STILL_RE.test(name)
    const meta: any = await new Promise(res => ffmpeg.ffprobe(full, (e, d) => {
      if (e || !d) return res(null)
      const v = d.streams.find((s: any) => s.codec_type === 'video')
      res({
        duration: still ? 4 : (d.format.duration || 0),
        hasAudio: d.streams.some((s: any) => s.codec_type === 'audio'),
        width: v?.width || 0, height: v?.height || 0,
        fps: fpsOf(v?.avg_frame_rate || v?.r_frame_rate),
        pixFmt: v?.pix_fmt || '', colorTransfer: v?.color_transfer || '',
      })
    }))
    if (!meta) { assets.push({ id: name, name, path: full, error: 'unreadable' }); continue }

    const saved = side[name] || {}
    const sheet = path.join(sheetDir, `${name.replace(/[^\w.-]/g, '_')}.jpg`)
    if (!still && (refresh || !fs.existsSync(sheet))) await contactSheet(full, meta.duration, sheet, tiles === 4 ? 2 : 3, 2)

    let best: { start: number; end: number } | null = null
    if (!still && (refresh || saved.bestStart == null)) {
      const frames = await decodeGrayFrames(full, { fps: 4 })
      best = usableRange(frames)
    }
    assets.push({
      id: name, name, path: full,
      duration: +(meta.duration || 0).toFixed(2),
      hasAudio: !!meta.hasAudio, width: meta.width, height: meta.height, fps: meta.fps,
      hdr: /arib-std-b67|smpte2084/i.test(meta.colorTransfer || ''),
      still,
      sheet: fs.existsSync(sheet) ? sheet : null,
      labels: saved.labels || [],
      description: saved.description || '',
      bestStart: saved.bestStart ?? best?.start ?? 0,
      bestEnd: saved.bestEnd ?? best?.end ?? +(meta.duration || 0).toFixed(2),
      maxUses: saved.maxUses ?? 2,
    })
  }
  return {
    folder, assets,
    needsLabels: assets.filter(a => !a.error && !(a.labels || []).length).map(a => a.name),
  }
})

/**
 * Walk a whole video and build contact sheets an agent can actually read, with the TIME BURNED
 * INTO EVERY TILE.
 *
 * The burnt-in timecode is the entire point. A third-party analysis service was trialled for this
 * job and came back with three hundred lines of description and not one timestamp, which is
 * useless for cutting. Here, whatever gets said about a tile is anchored to the second it came
 * from, so "the battery reads 85" arrives as "at 1:20 the battery reads 85".
 *
 * Frames are pulled wide enough (default 640px) to read a display or a warning label, which a
 * 480px filmstrip thumbnail is not.
 */
ipcMain.handle('visual-index', async (_event, { filePath, interval, maxFrames, perSheet, cols, tileWidth, sourceStart, duration }: any) => {
  if (!filePath || !fs.existsSync(filePath)) return { error: 'no file' }
  const total: number = duration || await new Promise(res => ffmpeg.ffprobe(filePath, (e, d) => res(e ? 0 : (d.format.duration || 0))))
  if (!total) return { error: 'cannot read the duration of that file' }

  const plan = planVisualIndex(total, { interval, maxFrames, perSheet, cols })
  const width = Math.max(240, Math.min(960, Math.round(tileWidth || 640)))
  const dir = path.join(app.getPath('temp'), 'vidhelm_visual', String(Date.now()))
  fs.mkdirSync(dir, { recursive: true })
  const font = escFilter(path.join(process.env.WINDIR || 'C:/Windows', 'Fonts', 'arialbd.ttf'))
  const offset = Number(sourceStart) || 0

  const sheets: any[] = []
  const missed: { at: string; why: string }[] = []
  for (const s of plan.sheets) {
    const tiles: string[] = []
    for (const t of s.times) {
      const tile = path.join(dir, `t_${Math.round(t * 100)}.jpg`)
      // The label goes through a FILE, not through the filter string. A timecode contains a
      // colon, which is drawtext's own option separator: escaping it inside the argument still
      // lost everything after it, so "12:50" rendered as "12". textfile= sidesteps the whole
      // escaping problem, which is why the text overlays in export use it too.
      const labelFile = path.join(dir, `l_${Math.round(t * 100)}.txt`)
      fs.writeFileSync(labelFile, timecode(t + offset), 'utf8')
      const err = await new Promise<string>(res => {
        let e = ''
        const p = spawn(paths.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', filePath,
          '-frames:v', '1', '-vf',
          `scale=${width}:-2,drawtext=fontfile='${font}':textfile='${escFilter(labelFile)}':expansion=none:x=10:y=10:fontsize=${Math.round(width / 14)}:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=8`,
          '-q:v', '3', tile])
        p.stderr.on('data', d => { e += d.toString() })
        p.on('close', () => res(e)); p.on('error', ex => res(String(ex)))
      })
      try { fs.unlinkSync(labelFile) } catch { /* temp */ }
      // A frame that quietly vanishes is the worst outcome: the sheet still looks complete and
      // whatever happened in that stretch of the video is simply never described.
      if (fs.existsSync(tile)) tiles.push(tile)
      else missed.push({ at: timecode(t + offset), why: (err.trim().split('\n')[0] || 'no frame produced').slice(0, 160) })
    }
    if (!tiles.length) continue
    const sheetPath = path.join(dir, `sheet_${s.index + 1}.jpg`)
    if (tiles.length === 1) {
      // xstack needs two inputs or more, and a remainder sheet with one tile on it is common
      // enough that this silently lost the last frames of a video
      fs.copyFileSync(tiles[0], sheetPath)
    } else {
      const usedCols = Math.min(s.cols, tiles.length)
      const args = ['-y', '-hide_banner', '-loglevel', 'error']
      for (const t of tiles) args.push('-i', t)
      args.push('-filter_complex',
        `${tiles.map((_, i) => `[${i}:v]`).join('')}xstack=inputs=${tiles.length}:layout=${stackLayout(tiles.length, usedCols)}:fill=black[v]`,
        '-map', '[v]', '-frames:v', '1', '-q:v', '3', sheetPath)
      await new Promise<void>(res => { const p = spawn(paths.ffmpeg, args); p.on('close', () => res()); p.on('error', () => res()) })
    }
    if (fs.existsSync(sheetPath)) {
      sheets.push({
        sheet: sheetPath, index: s.index + 1,
        from: timecode(s.from + offset), to: timecode(s.to + offset),
        times: s.times.map((t: number) => timecode(t + offset)),
      })
    }
    for (const t of tiles) { try { fs.unlinkSync(t) } catch { /* temp */ } }
  }

  return {
    ok: true, frames: plan.times.length - missed.length, asked: plan.times.length,
    interval: plan.interval, sheets, note: plan.note,
    ...(missed.length ? { missed, missedNote: `${missed.length} frame(s) could not be extracted and are NOT on any sheet` } : {}),
    hint: 'Open each sheet image. Every tile has its timecode burned into the corner, so describe what you see and quote that time. Pair it with analyze_speech to get the words at the same moments.',
  }
})

/**
 * Hunt for an installed audio.cpp and a stable-audio model, and build the generator command.
 *
 * Getting that command string right by hand is the whole difficulty of this setup: two absolute
 * paths, a family name, and two placeholders, typed without a typo. Everything else is just
 * downloading files. So this looks in the handful of places people actually unzip things, with a
 * depth limit and a time budget so it can never turn into a disk scan.
 */
ipcMain.handle('find-audiocpp', async (_event, { extraDirs }: { extraDirs?: string[] } = {}) => {
  const home = app.getPath('home')
  const roots = [
    ...(extraDirs || []),
    'C:\\audiocpp', 'D:\\audiocpp',
    path.join(home, 'audiocpp'),
    path.join(home, 'Downloads'),
    path.join(home, 'Documents'),
    path.join(home, 'Desktop'),
    'C:\\Program Files\\audiocpp',
    'C:\\models', path.join(home, 'models'),
  ].filter(d => { try { return fs.existsSync(d) } catch { return false } })

  const deadline = Date.now() + 6000
  let exe: string | null = null
  let model: string | null = null

  const walk = (dir: string, depth: number) => {
    if (depth > 3 || Date.now() > deadline || (exe && model)) return
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (Date.now() > deadline) return
      const full = path.join(dir, e.name)
      if (e.isFile()) {
        if (!exe && /^audiocpp_cli(\.exe)?$/i.test(e.name)) exe = full
      } else if (e.isDirectory()) {
        // a model is a FOLDER whose name says stable-audio, or one holding a matching gguf
        if (!model && /stable[-_ ]?audio/i.test(e.name)) model = full
        if (/node_modules|\.git|AppData\\Local\\Temp|Windows|\$Recycle/i.test(full)) continue
        walk(full, depth + 1)
      }
    }
  }
  for (const r of roots) walk(r, 0)

  const command = exe && model
    ? `"${exe}" --task gen --family stable_audio --model "${model}" --text "{prompt}" --out "{out}"`
    : null
  return {
    exe, model, command,
    searched: roots,
    note: command
      ? 'Found both. The command is filled in; press Generate to try it.'
      : exe && !model
        ? 'Found audio.cpp but no stable-audio model folder. Download one and unzip it next to audio.cpp, then search again.'
        : model && !exe
          ? 'Found a model but not audiocpp_cli.exe. Unzip the audio.cpp release, then search again.'
          : 'Could not find either. Unzip audio.cpp and a stable-audio model somewhere obvious (C:\\audiocpp works), then search again, or paste the command yourself.',
  }
})

/** Write labels for one clip back to the folder's sidecar. */
ipcMain.handle('label-broll', async (_event, { folder, id, labels, description, bestStart, bestEnd, maxUses }: any) => {
  if (!folder || !fs.existsSync(folder)) return { error: 'folder not found' }
  const side = readSidecar(folder)
  const cur = side[id] || {}
  side[id] = {
    ...cur,
    ...(labels !== undefined ? { labels: Array.isArray(labels) ? labels : String(labels).split(',').map((s: string) => s.trim()).filter(Boolean) } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(bestStart !== undefined ? { bestStart: Number(bestStart) } : {}),
    ...(bestEnd !== undefined ? { bestEnd: Number(bestEnd) } : {}),
    ...(maxUses !== undefined ? { maxUses: Number(maxUses) } : {}),
  }
  try { writeSidecar(folder, side) } catch (e: any) { return { error: String(e?.message || e) } }
  return { ok: true, id, saved: side[id] }
})

/**
 * Move a proposed cut onto the nearest edge of silence in the real waveform.
 *
 * Whisper's word times are good to about a tenth of a second, which is precisely the scale at
 * which a clipped consonant or a beat of dead air is audible. This decodes a short window
 * around the estimate and snaps to where speech actually stops or starts.
 */
ipcMain.handle('refine-cut', async (_event, { filePath, t, dir = 'after', window = 0.6, floorDb = -34 }: { filePath: string; t: number; dir?: 'after' | 'before'; window?: number; floorDb?: number }) => {
  if (!filePath || !fs.existsSync(filePath)) return { error: 'no file' }
  const from = Math.max(0, t - window)
  const pcm: Float32Array = await new Promise(resolve => {
    const p = spawn(paths.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(from), '-t', String(window * 2),
      '-i', filePath, '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'])
    const chunks: Buffer[] = []
    p.stdout.on('data', d => chunks.push(d))
    p.on('error', () => resolve(new Float32Array(0)))
    p.on('close', () => { const b = Buffer.concat(chunks); resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4))) })
  })
  if (!pcm.length) return { t, refined: t, moved: 0, note: 'no audio in that window' }
  const sr = 16000, step = 0.01
  const per = Math.round(sr * step)
  const rms: number[] = []
  for (let i = 0; i + per <= pcm.length; i += per) {
    let sum = 0
    for (let k = 0; k < per; k++) sum += pcm[i + k] * pcm[i + k]
    rms.push(Math.sqrt(sum / per))
  }
  const refined = refineFromEnvelope({ rms, step, t0: from }, t, dir, { floorDb, searchSec: window })
  return { t, refined, moved: +(refined - t).toFixed(3) }
})

/**
 * Where a 9:16 crop should point, measured from the footage itself. Slow on purpose: it decodes
 * the whole clip at 4fps rather than guessing from a handful of stills.
 */
ipcMain.handle('plan-framing', async (_event, { filePath, sourceStart = 0, duration, fps, hints, aspect = 9 / 16 }: any) => {
  // the renderer passes the tier's rate; 3 is the balanced default if it did not
  const sampleFps = Math.max(1, Math.min(10, Number(fps) || 3))
  if (!filePath || !fs.existsSync(filePath)) return { error: 'no file' }
  const frames = await decodeGrayFrames(filePath, { start: sourceStart, duration, fps: sampleFps, w: 64, h: 36 })
  if (!frames.length) return { error: 'could not decode frames' }
  const meta: any = await new Promise(res => ffmpeg.ffprobe(filePath, (e, d) => {
    const v = d?.streams?.find((s: any) => s.codec_type === 'video')
    res(e ? null : { width: v?.width || 1920, height: v?.height || 1080 })
  }))
  const srcW = meta?.width || 1920, srcH = meta?.height || 1080
  const cropWpx = Math.min(srcW, Math.round(srcH * aspect))
  const plan = planCrop(frames, { cropW: cropWpx / srcW, hints })

  // A proof sheet: the middle frame of each hold with the proposed crop drawn on it.
  //
  // This matters more than it sounds. Edge and motion energy find the biggest, busiest thing in
  // frame, which is not always the SUBJECT: on a coffee review it happily framed a black canister
  // sitting next to the grinder, because the canister is larger and higher contrast. There is no
  // way to tell those apart without knowing what the video is about, so the plan is something to
  // look at and correct with `hints`, not something to trust blind.
  let proof: string | null = null
  if (plan.segments.length) {
    const dir = path.join(app.getPath('temp'), 'vidhelm_framing', String(Date.now()))
    fs.mkdirSync(dir, { recursive: true })
    const shots: string[] = []
    for (const [i, seg] of plan.segments.slice(0, 8).entries()) {
      const t = seg.start + (seg.end - seg.start) / 2
      const x = Math.round(Math.min(srcW - cropWpx, Math.max(0, seg.cx * srcW - cropWpx / 2)))
      const out = path.join(dir, `s_${i}.jpg`)
      await new Promise<void>(res => {
        const p = spawn(paths.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3),
          '-i', filePath, '-an', '-frames:v', '1',
          '-vf', `drawbox=x=${x}:y=0:w=${cropWpx}:h=${srcH}:color=yellow@0.9:t=8,scale=360:-2`,
          '-q:v', '3', out])
        p.on('close', () => res()); p.on('error', () => res())
      })
      if (fs.existsSync(out)) shots.push(out)
    }
    if (shots.length) {
      const sheet = path.join(dir, 'framing_proof.jpg')
      const cols = Math.min(4, shots.length)
      const layout = stackLayout(shots.length, cols)
      const args = ['-y', '-hide_banner', '-loglevel', 'error']
      for (const sh of shots) args.push('-i', sh)
      args.push('-filter_complex', `${shots.map((_, i) => `[${i}:v]`).join('')}xstack=inputs=${shots.length}:layout=${layout}:fill=black[v]`,
        '-map', '[v]', '-frames:v', '1', '-q:v', '3', sheet)
      await new Promise<void>(res => { const p = spawn(paths.ffmpeg, args); p.on('close', () => res()); p.on('error', () => res()) })
      if (fs.existsSync(sheet)) proof = sheet
    }
  }

  return {
    ...plan,
    track: plan.track.filter((_, i) => i % 4 === 0),      // thin it out: this is only for eyeballing
    srcW, srcH, cropWpx,
    expr: cropExpr(plan, srcW, cropWpx),
    proof,
    summary: plan.segments.map(s => `${s.start.toFixed(1)}-${s.end.toFixed(1)}s centre ${(s.cx * 100).toFixed(0)}% (${s.reason})`),
    hint: proof
      ? 'Open `proof`: each tile is one hold with the crop drawn on it. Anything pointing at the wrong thing, fix with hints ("time@x", x across the frame) and call again. Detail and motion cannot tell the subject from the biggest object near it.'
      : undefined,
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

// "120/1" or "30000/1001" -> a number the proxy planner can compare against
const fpsOf = (rate?: string): number => {
  if (!rate) return 0
  const [n, d] = rate.split('/').map(Number)
  return d ? +(n / d).toFixed(3) : n || 0
}

// Hardware encoders turn a 4K phone clip from an afternoon into a few minutes, but `ffmpeg
// -encoders` lists everything the binary was COMPILED with, not what this machine can run: it
// happily advertises NVENC on a laptop with Intel graphics, and the proxy then dies with
// "Cannot load nvcuda.dll". So actually encode a frame with each candidate and keep the first
// that works.
let encoderCache: { video: string; hwDecode: boolean } | null = null
const canEncode = (name: string) => new Promise<boolean>(resolve => {
  try {
    const p = spawn(paths.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x144:d=0.1', '-c:v', name, '-f', 'null', '-'])
    let err = ''
    p.stderr.on('data', d => { err += d.toString() })
    p.on('close', code => resolve(code === 0 && !/error|cannot|failed/i.test(err)))
    p.on('error', () => resolve(false))
  } catch { resolve(false) }
})
const pickEncoder = async (): Promise<{ video: string; hwDecode: boolean }> => {
  if (encoderCache) return encoderCache
  for (const name of ['h264_qsv', 'h264_nvenc', 'h264_amf']) {
    if (await canEncode(name)) { encoderCache = { video: name, hwDecode: true }; return encoderCache }
  }
  encoderCache = { video: 'libx264', hwDecode: false }   // always there, just slower
  return encoderCache
}

/**
 * What this machine can comfortably do. Measured once per run (the benchmark is ~0.4s), then
 * cached, because the renderer asks for it on every startup and nothing about it changes while
 * the app is open.
 *
 * The renderer owns the resolved profile and passes the parts main needs (proxy size, framing
 * fps, export preset) with each call, so there is one source of truth for what tier is in force
 * and the user's override in Settings always wins.
 */
let machineSpecs: MachineSpecs | null = null
ipcMain.handle('machine-profile', async (_event, { refresh }: { refresh?: boolean } = {}) => {
  if (!machineSpecs || refresh) {
    const enc = await pickEncoder()
    machineSpecs = {
      cores: os.cpus().length,
      memGB: os.totalmem() / (1024 ** 3),
      hwEncoder: enc.video !== 'libx264',
      benchMs: benchmark(),
    }
  }
  const { tier, reasons } = classify(machineSpecs)
  return {
    specs: { ...machineSpecs, memGB: +machineSpecs.memGB.toFixed(1) },
    cpu: (os.cpus()[0]?.model || '').trim(),
    detected: tier,
    reasons,
    profile: profileFor(tier),
  }
})

let proxyDirSwept = false
const proxyDir = () => {
  const dir = path.join(app.getPath('userData'), 'proxies')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  // A build cut off by a crash or a closed app leaves its temp file behind; clear those once per run.
  // Only old ones: a dev build often runs beside the installed app with the same data folder, and
  // the other copy's build in progress must not be pulled out from under it.
  if (!proxyDirSwept) {
    proxyDirSwept = true
    const stale = Date.now() - 30 * 60_000
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.part.mp4')) continue
        const p = path.join(dir, f)
        try { if (fs.statSync(p).mtimeMs < stale) fs.rmSync(p, { force: true }) } catch { /* in use or gone */ }
      }
    } catch { /* best effort */ }
  }
  return dir
}

/**
 * Phones store a portrait clip as landscape frames plus a "rotate 90" flag, and ffmpeg applies the
 * flag when decoding. Every size decision (the proxy's scale, whether it is big enough to export
 * from) has to use the DISPLAYED shape: the coded one sized a portrait phone proxy 1920x3413.
 */
const displaySize = (v: any): { width: number; height: number; rotation: number } => {
  // `rotation` (the display matrix, as ffprobe reports it) is counter-clockwise; the old `rotate`
  // tag is clockwise. Hand back one convention: degrees CLOCKWISE, 0/90/180/270, the way ffmpeg's
  // own autorotate reads it (a phone's -90 matrix = turn 90 clockwise).
  const side = v?.rotation !== undefined && v?.rotation !== '' ? Number(v.rotation) : NaN
  const rotation = quarterTurn(Number.isFinite(side) ? -side : Number(v?.tags?.rotate) || 0)
  const w = v?.width || 0, h = v?.height || 0
  return rotation === 90 || rotation === 270 ? { width: h, height: w, rotation } : { width: w, height: h, rotation }
}

type ProxyDims = { width: number; height: number; fps: number; duration: number }
/**
 * What a proxy file really is (displayed size, frame rate), or null when it does not parse, has no
 * picture, or is clearly shorter than its source (a build that was cut off before the fix below).
 */
const probeProxy = (file: string, expectDuration?: number) => new Promise<ProxyDims | null>(resolve => {
  ffmpeg.ffprobe(file, (err, d) => {
    if (err || !d) return resolve(null)
    const v: any = d.streams.find((s: any) => s.codec_type === 'video')
    if (!v) return resolve(null)
    const dur = Number(d.format?.duration) || 0
    if (!(dur > 0)) return resolve(null)
    if (expectDuration && expectDuration > 1 && dur < expectDuration - Math.max(2, expectDuration * 0.05)) return resolve(null)
    const { width, height } = displaySize(v)
    resolve({ width, height, fps: fpsOf(v.avg_frame_rate || v.r_frame_rate), duration: +dur.toFixed(3) })
  })
})
// A frame from the last second must decode. A file cut short can keep a perfectly valid header
// (+faststart puts the index at the FRONT), so only reading the end proves the end is there.
const tailDecodes = (file: string, duration: number) => new Promise<boolean>(resolve => {
  const p = spawn(paths.ffmpeg, ['-v', 'error', '-ss', Math.max(0, duration - 1).toFixed(3), '-i', file, '-frames:v', '1', '-s', '16x16', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'])
  let n = 0
  p.stdout.on('data', d => { n += d.length })
  p.on('close', code => resolve(code === 0 && n >= 256))
  p.on('error', () => resolve(false))
})
// A finished proxy's measured size sits beside it, so a cache hit needs no probe and an old,
// unverified one is checked exactly once. The version marks sidecars written by code that builds
// and checks proxies the right way round; one without it is re-checked like a proxy with none.
const PROXY_META_V = 2
const proxyMetaPath = (outPath: string) => outPath.replace(/\.mp4$/i, '.json')
const readProxyMeta = (outPath: string): ProxyDims | null => {
  try {
    const j = JSON.parse(fs.readFileSync(proxyMetaPath(outPath), 'utf8'))
    return j && j.v === PROXY_META_V && j.width > 0 && j.height > 0 ? { width: j.width, height: j.height, fps: Number(j.fps) || 0, duration: Number(j.duration) || 0 } : null
  } catch { return null }
}
const writeProxyMeta = (outPath: string, dims: ProxyDims) => {
  try { fs.writeFileSync(proxyMetaPath(outPath), JSON.stringify({ ...dims, v: PROXY_META_V })) } catch { /* only a cache */ }
}
// The source as displayed, measured here rather than taken from the renderer: whether a cached copy
// is the right way round, and whether a Quick Sync build turns its frames, both hang on it.
const probeShape = (file: string) => new Promise<{ width: number; height: number; rotation: number } | null>(resolve => {
  ffmpeg.ffprobe(file, (err, d) => {
    const v: any = !err && d ? d.streams.find((s: any) => s.codec_type === 'video') : null
    resolve(v && v.width > 0 && v.height > 0 ? displaySize(v) : null)
  })
})

/**
 * fs.renameSync, retried for a moment. On Windows a file that was just written is often held
 * briefly by Defender or the search indexer (EPERM / EBUSY / EACCES); graceful-fs retries for the
 * same reason. MoveFileEx replaces the destination, so no delete is needed first.
 */
const renameRetry = async (from: string, to: string, tries = 6) => {
  for (let i = 1; ; i++) {
    try { fs.renameSync(from, to); return } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code || ''
      if (i >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw e
      await new Promise(r => setTimeout(r, 60 * i))
    }
  }
}

/**
 * Write JSON to a temp file beside `file`, then rename it over the old one, so a crash or a full
 * disk mid-write never leaves a half-written project or autosave. The temp file is removed if it
 * cannot be put in place.
 */
const writeJsonAtomic = async (file: string, data: unknown, pretty = true) => {
  const tmp = file + '.tmp'
  try {
    fs.writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data), 'utf8')
    // retried: right after the write, Defender or the indexer often holds the file for a moment
    await renameRetry(tmp, file)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* locked: the next write overwrites it */ }
    throw e
  }
}

// The same clip asked for twice (a drag-drop plus a folder rescan) shares one build instead of two
// ffmpegs writing one file. The children are tracked so quitting does not leave them running.
const proxyBuilds = new Map<string, Promise<any>>()
const proxyChildren = new Set<ChildProcess>()
app.on('before-quit', () => { for (const c of proxyChildren) { try { c.kill() } catch { /* already gone */ } } })

/**
 * Build (or reuse) a preview proxy: an H.264 8-bit SDR copy the preview can actually decode. The
 * original stays the master. The reply carries the proxy's real width, height and fps, because the
 * renderer only lets an export read the proxy when it is big enough and fast enough to lose nothing.
 * Progress goes back to the renderer so the Media Bin can show it.
 */
ipcMain.handle('make-proxy', async (event, { filePath, info, maxWidth, maxFps }: { filePath: string; info: ProbeInfo; maxWidth?: number; maxFps?: number }) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { error: 'file not found' }
    // the measured shape wins over whatever the renderer sent (an older caller sends no rotation)
    const shape = await probeShape(filePath)
    const src: ProbeInfo = { ...(info || {}), ...(shape ? { width: shape.width, height: shape.height, rotation: shape.rotation } : {}) }
    const plan = planProxy(src, { maxWidth, maxFps })
    if (!plan.needed) return { ok: true, skipped: true }
    const stat = fs.statSync(filePath)
    const outPath = path.join(proxyDir(), proxyKey(filePath, stat.size, stat.mtimeMs))
    const running = proxyBuilds.get(outPath)
    if (running) return await running
    const job = buildProxy(event.sender, filePath, src, plan, outPath).finally(() => proxyBuilds.delete(outPath))
    proxyBuilds.set(outPath, job)
    return await job
  } catch (e) { return { error: String((e as Error)?.message || e) } }
})

const buildProxy = async (sender: Electron.WebContents, filePath: string, info: ProbeInfo, plan: ReturnType<typeof planProxy>, outPath: string) => {
  try {
    // Reuse a finished proxy only when it is a complete file, the picture's shape, no bigger than its
    // source, and at least as big and as fast as this plan wants (the setting may have gone up a tier
    // since it was made); otherwise build it again. An export reads the proxy when it covers the
    // frame, so a copy lying on its side here becomes an export lying on its side.
    let keep: ProxyDims | null = null   // a sound copy that is only too small: kept if it cannot be replaced
    if (fs.existsSync(outPath)) {
      let dims = readProxyMeta(outPath)
      if (!dims) {
        // Made before proxies were built atomically and the right way round: check it properly, once.
        // An old copy of a ROTATED clip is never trusted: Quick Sync built those on their side, which
        // a square or upside-down picture does not even show in its size, and software builds of
        // portrait clips were blown up past the source. Those are simply made again.
        if (!quarterTurn(info?.rotation)) {
          dims = await probeProxy(outPath, info?.duration)
          if (dims && !(await tailDecodes(outPath, dims.duration))) dims = null
          if (dims) writeProxyMeta(outPath, dims)
        }
      }
      if (dims && proxyFits(dims, info || {}, plan)) {
        return { ok: true, path: outPath, cached: true, reason: plan.reason, ...dims }
      }
      if (dims && proxyFits(dims, info || {}, { ...plan, long: 0, fps: 0 })) keep = dims
    }

    const { video, hwDecode } = await pickEncoder()
    // Written to a temp name and renamed only after ffmpeg exits cleanly. Written straight to the
    // cache path, a build cut off part way (app closed, crash) left a file with no moov atom that was
    // then served as "cached" forever: blank preview, failed filmstrip, broken export.
    // (.part.mp4, not .part: ffmpeg picks the container from the extension.)
    const tmp = outPath.replace(/\.mp4$/i, '.part.mp4')
    const args = ['-y', '-v', 'error', '-stats']
    if (hwDecode && video === 'h264_qsv') args.push('-hwaccel', 'qsv')
    else if (hwDecode && video === 'h264_nvenc') args.push('-hwaccel', 'cuda')
    args.push('-i', filePath, '-vf', proxyFilter(plan, hwDecode && video === 'h264_qsv'))
    args.push('-c:v', video)
    args.push(...(video === 'libx264' ? ['-preset', 'veryfast', '-crf', '24'] : ['-global_quality', '24']))
    args.push('-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tmp)

    await new Promise<void>((resolve, reject) => {
      const p = spawn(paths.ffmpeg, args)
      proxyChildren.add(p)
      const fail = (e: Error) => { proxyChildren.delete(p); try { fs.rmSync(tmp, { force: true }) } catch { /* locked */ } reject(e) }
      let err = ''
      p.stderr.on('data', d => {
        const line = d.toString()
        err += line
        // ffmpeg -stats prints "time=00:01:23.45"; turn that into a percentage of the clip
        const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(line)
        if (m && info?.duration) {
          const secs = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])
          const pct = Math.max(0, Math.min(99, Math.round((secs / info.duration) * 100)))
          if (!sender.isDestroyed()) sender.send('proxy-progress', { filePath, pct })
        }
      })
      p.on('close', code => {
        if (code !== 0 || !fs.existsSync(tmp)) return fail(new Error(err.slice(-400) || 'proxy failed'))
        proxyChildren.delete(p)
        resolve()
      })
      p.on('error', fail)
    })
    // Swap it in. The copy being replaced may be open in the preview, and Windows will not replace an
    // open file: then a sound old copy (only too small for the new tier) stays in use rather than
    // the clip losing its preview, and the bigger one is built again next time.
    try { fs.rmSync(proxyMetaPath(outPath), { force: true }) } catch { /* only a cache */ }
    try { await renameRetry(tmp, outPath) } catch (e) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* locked */ }
      if (keep && fs.existsSync(outPath)) {
        console.warn('proxy: could not replace the preview copy in use, keeping the old one:', outPath, e)
        writeProxyMeta(outPath, keep)
        return { ok: true, path: outPath, cached: true, reason: plan.reason, ...keep }
      }
      throw e
    }
    const dims = await probeProxy(outPath)
    if (!dims) { try { fs.rmSync(outPath, { force: true }) } catch { /* locked */ } return { error: 'the preview copy came out unreadable' } }
    writeProxyMeta(outPath, dims)
    if (!sender.isDestroyed()) sender.send('proxy-progress', { filePath, pct: 100 })
    return { ok: true, path: outPath, reason: plan.reason, encoder: video, ...dims }
  } catch (e) { return { error: String((e as Error)?.message || e) } }
}

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
        const v = metadata.streams.find((s: any) => s.codec_type === 'video')
        resolve({
          duration: metadata.format.duration || 5,
          hasVideo,
          hasAudio,
          ok: hasVideo || hasAudio,
          // still images probe as image2/png_pipe/mjpeg_pipe, used to tell photos from video
          format: metadata.format.format_name || '',
          videoCodec: v?.codec_name || '',
          // the preview is a Chromium <video>, which is pickier than FFmpeg: it needs these to
          // decide whether the file will actually show anything (see electron/playable.ts)
          pixFmt: v?.pix_fmt || '',
          colorTransfer: v?.color_transfer || '',
          // as displayed: a portrait phone clip is coded landscape with a rotate-90 flag
          ...(() => { const d = displaySize(v); return { width: d.width, height: d.height, ...(d.rotation ? { rotation: d.rotation } : {}) } })(),
          fps: fpsOf(v?.avg_frame_rate || v?.r_frame_rate),
        })
      }
    })
  })
})

// Voiceover and booth takes. They used to go to %TEMP%, which Storage Sense and every disk cleaner
// empty, while the saved project kept pointing at them: the user's own performance, the hardest
// thing in the project to recreate, silently gone. Now: <project>/voice when the renderer passes a
// folder, else the app's own data folder, which nothing cleans. The take arrives as bytes
// (Uint8Array/ArrayBuffer, structured-cloned by IPC) or, from older callers, as a base64 string.
const recordingsDir = () => path.join(app.getPath('userData'), 'recordings')
/** <project>/voice: where takes go when a project folder is open (the renderer passes it). */
const VOICE_DIR = 'voice'
/** Local wall-clock time for a file name: the bin shows the name, and a take recorded at 9:52 must not read 16-52. */
const localStamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}
ipcMain.handle('save-recording', async (_event, data: string | Uint8Array | ArrayBuffer, targetDir?: string) => {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'base64')
    : data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data))
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (!bytes.length) throw new Error('the recording is empty')
  const stamp = localStamp()
  const writeIn = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true })
    let filePath = path.join(dir, `voiceover ${stamp}.webm`), n = 2
    while (fs.existsSync(filePath)) filePath = path.join(dir, `voiceover ${stamp} (${n++}).webm`)
    fs.writeFileSync(filePath, bytes)
    return filePath
  }
  const wanted = typeof targetDir === 'string' && targetDir.trim() && path.isAbsolute(targetDir) ? targetDir : ''
  if (wanted) {
    // The only other copy of this performance is in the renderer's memory, so a project folder that
    // cannot be written right now (an offline network drive, a OneDrive placeholder, read-only media)
    // must not lose it: it goes to the app's own folder instead, and moves into the project on save.
    try { return writeIn(wanted) } catch (e) { console.warn(`save-recording: could not write into ${wanted}, keeping the take in the app's recordings folder:`, e) }
  }
  return writeIn(recordingsDir())
})

/**
 * Takes recorded before this fix (or before a project folder was open) live in %TEMP% or the app's
 * recordings folder. When a project is saved into a folder, copy any of those it uses into
 * <project>/voice and point the saved file at the copies, so the project carries its own voice.
 * Returns what moved so the renderer can update its paths too.
 */
const adoptLooseRecordings = (dir: string, data: any): { from: string; to: string; relPath: string }[] => {
  const moved: { from: string; to: string; relPath: string }[] = []
  const loose = [path.join(app.getPath('temp'), 'vidhelm_vo'), path.join(os.tmpdir(), 'vidhelm_vo'), recordingsDir()].map(d => path.resolve(d).toLowerCase() + path.sep)
  const isLoose = (p: unknown) => typeof p === 'string' && loose.some(d => path.resolve(p).toLowerCase().startsWith(d))
  const voiceDir = path.join(dir, VOICE_DIR)
  for (const m of Array.isArray(data?.mediaBin) ? data.mediaBin : []) {
    if (!isLoose(m?.path) || !fs.existsSync(m.path)) continue
    try {
      fs.mkdirSync(voiceDir, { recursive: true })
      let to = path.join(voiceDir, path.basename(m.path)), n = 2
      while (fs.existsSync(to) && fs.statSync(to).size !== fs.statSync(m.path).size) to = path.join(voiceDir, path.basename(m.path).replace(/(\.[^.]+)?$/, ` (${n++})$1`))
      if (!fs.existsSync(to)) fs.copyFileSync(m.path, to)
      // where it sits inside the project, in the renderer's relInside form, so a moved folder relinks
      // it; returned too, so the renderer needs no second write just to add it
      const relPath = path.relative(dir, to)
      moved.push({ from: m.path, to, relPath })
      m.path = to
      m.relPath = relPath
    } catch (e) { console.warn('could not copy a recording into the project:', m.path, e) }
  }
  return moved
}

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

// Everything usable sitting in a project folder, newest first, so it can be loaded without an import step.
// That includes <project>/voice, where takes are recorded: a take from a session that was never
// saved is on disk there, and has to come back when the project is opened again.
ipcMain.handle('scan-project', async (_event, dir: string) => {
  try {
    if (!dir || !fs.existsSync(dir)) return { error: 'that project folder is not there any more' }
    const mediaIn = (d: string) => fs.readdirSync(d, { withFileTypes: true })
      .filter(f => f.isFile() && MEDIA_RE.test(f.name))
      .map(f => ({ path: path.join(d, f.name), name: f.name, mtime: fs.statSync(path.join(d, f.name)).mtimeMs }))
    const voice = path.join(dir, VOICE_DIR)
    let takes: ReturnType<typeof mediaIn> = []
    try { if (fs.statSync(voice).isDirectory()) takes = mediaIn(voice) } catch { /* no voice folder */ }
    const files = [...mediaIn(dir), ...takes]
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

// AI clip: a still (or a frame of a clip) → JPEG → the video harness (fal.ai / Gemini) → mp4 in the project folder.
// Every generation costs money, so an identical request that arrives while one is already running
// (an agent retrying after a timeout, a double click) joins that job instead of buying another.
type GenClipArgs = { prompt: string; fromPath?: string; fromTime?: number; toPath?: string; toTime?: number; seconds?: number; aspect: 'landscape' | 'portrait' | 'square'; model?: string; keys?: { fal?: string; gemini?: string }; outDir: string }
const genClipInflight = new Map<string, Promise<any>>()
ipcMain.handle('gen-clip', async (_event, a: GenClipArgs) => {
  const key = JSON.stringify([a?.prompt, a?.fromPath, a?.fromTime, a?.toPath, a?.toTime, a?.seconds, a?.aspect, a?.model, a?.outDir])
  const running = genClipInflight.get(key)
  if (running) return running
  const job = genClipRun(a).finally(() => genClipInflight.delete(key))
  genClipInflight.set(key, job)
  return job
})
const genClipRun = async (a: GenClipArgs) => {
  try {
    const env = { FAL_KEY: a.keys?.fal || undefined, GEMINI_API_KEY: a.keys?.gemini || undefined }
    if (!videoGenAvailable(env)) return { error: 'Add a fal.ai key (or a Gemini key) in the AI clip panel first. fal.ai → Keys → Add key.' }
    const frame = async (p?: string, t?: number): Promise<ArrayBuffer | undefined> => {
      if (!p) return undefined
      const out = path.join(os.tmpdir(), `vh-frame-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`)
      await new Promise<void>((res, rej) => {
        let c = ffmpeg(p); if (typeof t === 'number' && t > 0) c = c.seekInput(t)
        c.outputOptions(['-frames:v', '1', '-q:v', '2', '-vf', 'scale=1280:-2']).on('end', () => res()).on('error', rej).save(out)
      })
      const b = fs.readFileSync(out); try { fs.unlinkSync(out) } catch { /* tmp */ }
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    }
    const image = await frame(a.fromPath, a.fromTime), lastImage = await frame(a.toPath, a.toTime)
    const clip = await generateClip(env, { prompt: a.prompt, image, lastImage, aspect: a.aspect, seconds: a.seconds, model: a.model })
    if (!clip) return { error: 'No configured video model produced a clip. Check the key and the balance at fal.ai, then try again.' }
    fs.mkdirSync(a.outDir, { recursive: true })
    const file = path.join(a.outDir, `ai-clip-${(a.prompt || 'clip').replace(/[^\w]+/g, '-').slice(0, 30)}-${Date.now().toString(36)}.mp4`)
    fs.writeFileSync(file, Buffer.from(clip.bytes))
    return { path: file, model: VIDEO_MODELS[clip.model]?.label || clip.model, seconds: clip.seconds, hasAudio: clip.hasAudio, estimateUsd: estimateUsd(clip.model, clip.seconds) }
  } catch (e) {
    if (e instanceof GenTimeout) return { error: e.message, stillRunning: true }
    return { error: String(e) }
  }
}

// VidHelm Cloud hand-off (.zip): pick it, unpack it into a new project folder under the workspace root,
// download the clips and finished drafts, and write a project file with the cloud's edit plan on the timeline.
ipcMain.handle('import-cloud-zip', async (_event, { root, zipPath }: { root: string; zipPath?: string }) => {
  try {
    let file = zipPath
    if (!file) {
      const { filePaths } = await dialog.showOpenDialog(win!, { title: 'Import a VidHelm Cloud hand-off (.zip)', filters: [{ name: 'VidHelm Cloud hand-off', extensions: ['zip'] }], properties: ['openFile'] })
      file = filePaths?.[0]
    }
    if (!file) return { cancelled: true }
    const entries = readZip(fs.readFileSync(file))
    // Untrusted names: entriesToWrite throws on any entry that would leave the folder (zip slip)
    // BEFORE anything is written, and keeps only the files the cloud actually makes.
    const unpack = entriesToWrite(entries)
    const { manifest, plan, notesMd, reviews } = parseHandoff(entries)
    // eslint-disable-next-line no-control-regex
    const named = String(manifest.project?.name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/^[. ]+|[. ]+$/g, '').trim() || 'Cloud project'
    const safe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(named) ? '_' + named : named   // Windows device names
    let dir = path.join(root, safe), n = 2
    while (fs.existsSync(dir)) dir = path.join(root, `${safe} ${n++}`)
    // every path written below must resolve inside these, whatever the names said
    const inside = (base: string, p: string) => { const b = path.resolve(base), r = path.resolve(p); return r.startsWith(b + path.sep) }
    if (!inside(root, dir)) throw new Error('that project name is not usable as a folder name')
    const cloudDir = path.join(dir, 'cloud')
    fs.mkdirSync(cloudDir, { recursive: true })
    const narration: Record<string, string> = {}
    for (const e of unpack) {
      const p = path.join(cloudDir, e.name)
      if (!inside(cloudDir, p)) throw new Error(`unsafe entry in the zip: ${e.name}`)
      fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, e.data)
      if (e.name.startsWith('narration/')) narration[e.name] = p
    }
    if (notesMd) fs.writeFileSync(path.join(dir, 'NOTES.md'), notesMd)
    const files: Record<string, { path: string; hasAudio: boolean }> = {}
    const failed: string[] = []
    // Downloads only from VidHelm Cloud's own media links: the manifest could otherwise point the
    // app at any URL, localhost included. VH_CLOUD_ORIGIN adds a dev server (e.g. http://localhost:8787).
    const origins = [...CLOUD_ORIGINS, ...(process.env.VH_CLOUD_ORIGIN ? [process.env.VH_CLOUD_ORIGIN.replace(/\/+$/, '')] : [])]
    for (const d of downloadList(manifest)) {
      const dest = path.join(dir, d.file)
      try {
        if (!inside(dir, dest)) throw new Error('unsafe file name')
        if (!isCloudMediaUrl(d.url, origins)) throw new Error('refused: not a VidHelm Cloud media link')
        const r = await fetch(d.url, { redirect: 'error', signal: AbortSignal.timeout(30 * 60 * 1000) })
        if (!r.ok || !r.body) throw new Error('HTTP ' + r.status)
        // streamed to disk, so a long proxy is not held in memory whole
        await pipeline(Readable.fromWeb(r.body as any), fs.createWriteStream(dest))
        if (d.clipId) files[d.clipId] = { path: dest, hasAudio: d.kind !== 'image' }
      } catch (e) { try { fs.rmSync(dest, { force: true }) } catch { /* nothing written */ } failed.push(`${d.file}: ${String((e as Error)?.message || e)}`) }
    }
    const project = buildProject(manifest, plan, files, narration, reviews)
    fs.writeFileSync(path.join(dir, PROJECT_FILE), JSON.stringify(project, null, 2))
    return { path: dir, name: path.basename(dir), clips: Object.keys(files).length, timeline: (project.clips as unknown[]).length, failed }
  } catch (e) { return { error: String(e) } }
})

// Where flattened renders for video-analysis services go. Kept out of the project folder so
// they do not get picked up as project media on the next scan.
ipcMain.handle('analysis-path', async (_event, name: string) => {
  const dir = path.join(app.getPath('userData'), 'analysis')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${(name || 'timeline').replace(/[^\w-]+/g, '_')}_${Date.now()}.mp4`)
})

// Save straight into the project folder, no dialog once a project is open. Written to a temp file
// and renamed over the old save, so a crash or a full disk mid-write never leaves a half project file.
ipcMain.handle('save-project-to', async (_event, { dir, data }: { dir: string; data: any }) => {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const moved = adoptLooseRecordings(dir, data)
    const file = path.join(dir, PROJECT_FILE)
    // The previous save survives one more save as project.vidhelm.json.bak, so a save of the wrong
    // state (undone too far, the wrong project open) can still be walked back by hand. Neither the
    // project list nor the media scan looks at it.
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, file + '.bak') } catch (e) { console.warn('could not keep a backup of the previous save:', e) }
    }
    await writeJsonAtomic(file, data)
    return { path: file, ...(moved.length ? { moved } : {}) }
  } catch (e) { return { error: String(e) } }
})

const PROJECT_FILE_RE = /\.(rsnap|json)$/i

ipcMain.handle('save-project', async (_event, data: any) => {
  if (!win) return null
  const { filePath } = await dialog.showSaveDialog(win, {
    title: 'Save Project', defaultPath: 'project.rsnap',
    filters: [{ name: 'VidHelm Project', extensions: ['rsnap', 'json'] }],
  })
  if (!filePath) return null
  await writeJsonAtomic(filePath, data)
  return filePath
})

// Save back into the .rsnap / .json file the project was opened from (or first saved as), with no
// dialog: Save means "where it lives", the same as a folder project.
ipcMain.handle('save-project-file', async (_event, { path: file, data }: { path: string; data: any } = { path: '', data: null }) => {
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !PROJECT_FILE_RE.test(file)) return { error: 'that is not a project file (.rsnap or .json)' }
    if (!data || typeof data !== 'object') return { error: 'nothing to save' }
    if (!fs.existsSync(path.dirname(file))) return { error: `the folder ${path.dirname(file)} is not there any more (use Save As to keep it somewhere else)` }
    await writeJsonAtomic(file, data)
    return { path: file }
  } catch (e) { return { error: String(e) } }
})

// Says which file it was, so Save can write back to it (and a folder's own project.vidhelm.json
// opens as that folder). The renderer still accepts the bare project an older build returned.
ipcMain.handle('load-project', async () => {
  if (!win) return null
  const { filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open Project', properties: ['openFile'],
    filters: [{ name: 'VidHelm Project', extensions: ['rsnap', 'json'] }],
  })
  const file = filePaths?.[0]
  if (!file) return null
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('it holds no project')
    return { data, path: file }
  } catch (e) {
    // a silent nothing looked like the Open button was broken
    await dialog.showMessageBox(win, { type: 'error', title: 'Open Project', message: `${path.basename(file)} could not be opened as a VidHelm project.`, detail: String((e as Error)?.message || e), noLink: true })
    return null
  }
})

// ---- Autosave ----
// Unsaved work, written every 30 s or so while there is any: <project>/project.vidhelm.autosave.json
// beside the real save, or the app's own folder when no project folder is open. The renderer offers
// it back when that project (or, untitled, the app) opens after a session that ended without saving.
// Neither the project list nor the media scan picks the file up.
const AUTOSAVE_FILE = 'project.vidhelm.autosave.json'
const autosavePath = (dir: unknown): string | null => {
  if (dir === null || dir === undefined || dir === '') return path.join(app.getPath('userData'), 'autosave', 'untitled.json')
  return typeof dir === 'string' && path.isAbsolute(dir) ? path.join(dir, AUTOSAVE_FILE) : null
}

ipcMain.handle('autosave-write', async (_event, { dir, data }: { dir?: string | null; data?: any } = {}) => {
  try {
    const file = autosavePath(dir)
    if (!file) return { error: 'not a project folder' }
    if (!data || typeof data !== 'object') return { error: 'nothing to autosave' }
    // A project folder that has gone (renamed, a drive unplugged) is not re-created by an autosave:
    // the renderer keeps its own copy instead.
    if (dir && !fs.existsSync(dir)) return { error: 'that project folder is not there any more' }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    await writeJsonAtomic(file, data, false)
    return { path: file }
  } catch (e) { return { error: String(e) } }
})

ipcMain.handle('autosave-read', async (_event, { dir }: { dir?: string | null } = {}) => {
  try {
    const file = autosavePath(dir)
    if (!file || !fs.existsSync(file)) return null
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? { data } : null
  } catch { return null }   // unreadable or torn: there is no autosave to offer
})

ipcMain.handle('autosave-clear', async (_event, { dir }: { dir?: string | null } = {}) => {
  try {
    const file = autosavePath(dir)
    if (file) for (const f of [file, file + '.tmp']) fs.rmSync(f, { force: true })
    return { ok: true }
  } catch (e) { return { error: String(e) } }
})

// ---- Persistent app settings (brand kit, intro defaults, audio) ----
const settingsPath = () => path.join(app.getPath('userData'), 'vidhelm-settings.json')
const DEFAULT_SETTINGS = {
  brand: { enabled: false, logoPath: null as string | null, position: 'br', sizePct: 16, margin: 40, opacity: 0.85, showMode: 'whole' as 'whole' | 'intro' | 'outro', windowSec: 5, fade: 0.5 },
  intro: { segment: 'first' as 'first' | 'last', seconds: 5, fade: 0.6, treatment: 'ripple' as 'ripple' | 'overlay' },
  audio: { optimize: true, noiseReduction: false },
  caption: { fontSize: 44, color: '#ffffff', position: 'lower' as 'lower' | 'top' | 'center', box: true, boxOpacity: 0.5, model: 'tiny' as 'tiny' | 'base' | 'small', language: 'en', mode: 'phrase' as 'phrase' | 'word', theme: 'creator', tweak: '' },
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

ipcMain.on('window-theme', (_e, theme: 'dark' | 'light') => {
  if (!win || win.isDestroyed()) return
  try { win.setTitleBarOverlay({ ...(TITLEBAR[theme] || TITLEBAR.dark), height: TITLEBAR_H }) } catch { /* not supported on this platform */ }
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

// MediaRecorder gives us a VFR webm off the WebGL canvas. A complex model can take
// longer than 1/30s to draw, but the renderer still requests exactly one view per
// output frame. Re-time by frame index here so slow wall-clock capture never turns
// into a stuttering/slow-motion result.
// Opaque renders become h264 mp4; transparent ones stay VP8 WebM, the Chromium format
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
      // so copying is the only way to keep it. The setts bitstream filter changes packet
      // timestamps without touching the encoded frames or their alpha side data.
      if (alpha) cmd.outputOptions([
        '-c copy',
        '-bsf:v setts=pts=N/(30*TB):dts=N/(30*TB):duration=1/(30*TB)',
      ])
      else cmd.videoFilter('setpts=N/(30*TB),scale=trunc(iw/2)*2:trunc(ih/2)*2')
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
// Requests waiting on the editor, by correlation id (reqId: see electron/bridgeguard.ts for why it
// is not the command's `id`)
const agentPending = new Map<number, PendingReply & { done: (result: any) => void }>()

ipcMain.on('agent-response', (_e, msg: { id?: unknown; reqId?: unknown; result: any }) => {
  const key = replyKey(agentPending, msg)
  const p = key === undefined ? undefined : agentPending.get(key)
  if (p) { agentPending.delete(key!); p.done(msg?.result) }
})

const askRenderer = (cmd: any, timeoutMs = QUICK_MS) => new Promise<any>(resolve => {
  if (!win) return resolve({ error: 'VidHelm window is not open' })
  const id = ++agentSeq
  const alias = replyAlias(cmd)
  const timer = setTimeout(() => {
    const secs = Math.round(timeoutMs / 1000)
    if (cmd.action === 'get_state') { agentPending.delete(id); return resolve({ error: `renderer timeout after ${secs}s (the editor window is not answering)` }) }
    // The editor is NOT interrupted: the command carries on and may still land. Say so, so an
    // agent looks before it retries (a retried generate_clip is a second paid generation), and
    // keep listening so the late result at least shows up in the log instead of vanishing.
    agentPending.set(id, { alias, done: late => console.log(`agent: '${cmd.action}' finished ${secs}s+ after it was sent:`, JSON.stringify(late)?.slice(0, 300)) })
    setTimeout(() => agentPending.delete(id), 60 * 60 * 1000).unref?.()
    resolve({ error: `renderer timeout after ${secs}s: '${cmd.action}' is still running in the app and was not cancelled, so it may still finish. Call get_state to see whether it landed before retrying.`, stillRunning: true })
  }, timeoutMs)
  agentPending.set(id, { alias, done: r => { clearTimeout(timer); resolve(r) } })
  // the command keeps its own `id` (delete_item, label_broll); the request's travels as reqId
  win.webContents.send('agent-command', commandForEditor(cmd, id))
})

const agentServer = http.createServer(async (req, res) => {
  // localhost only
  const remote = req.socket.remoteAddress || ''
  if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote)) { res.writeHead(403); return res.end() }
  // ...and never a web page: every site the user has open can reach 127.0.0.1 too, with no CORS
  // preflight for a text/plain POST, and a DNS-rebinding page could read /state and /screenshot.
  // Checked before any routing, so all four endpoints are covered (electron/bridgeguard.ts).
  const refused = bridgeRefusal(req.headers, AGENT_PORT)
  if (refused) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: refused }))
  }
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
      if (!cmd || typeof cmd !== 'object' || !cmd.action) { res.writeHead(400); return res.end(JSON.stringify({ error: 'missing action' })) }
      // How long each action may take lives in agent/timeouts.mjs, shared with the MCP proxy so
      // the two ends can never disagree again (and the proxy always waits a little longer).
      return res.end(JSON.stringify(await askRenderer(cmd, bridgeTimeoutMs(cmd))))
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
  // Installers routinely drop the Claude CLI somewhere that never made it onto PATH, so
  // `claude mcp add ...` fails with "not recognized" and the setup line looks broken. Find the
  // exe ourselves and hand back a command that works either way.
  const cli = await new Promise<{ onPath: boolean; path?: string }>(resolve => {
    try {
      const p = spawn(process.platform === 'win32' ? 'where' : 'which', ['claude'], { shell: true })
      let out = ''
      p.stdout.on('data', d => { out += d })
      p.on('close', code => {
        const first = out.split(/\r?\n/).map(l => l.trim()).find(Boolean)
        if (code === 0 && first) return resolve({ onPath: true, path: first })
        const home = os.homedir()
        const guesses = [
          path.join(home, '.local', 'bin', 'claude.exe'),
          path.join(home, '.local', 'bin', 'claude'),
          path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
        ]
        const roots = [path.join(process.env.APPDATA || '', 'Claude', 'claude-code')]
        for (const root of roots) {
          try {
            for (const v of fs.readdirSync(root)) {
              const exe = path.join(root, v, process.platform === 'win32' ? 'claude.exe' : 'claude')
              if (fs.existsSync(exe)) guesses.push(exe)
            }
          } catch { /* not installed that way */ }
        }
        const found = guesses.find(g => g && fs.existsSync(g))
        resolve({ onPath: false, path: found })
      })
      p.on('error', () => resolve({ onPath: false }))
    } catch { resolve({ onPath: false }) }
  })
  return {
    appVersion: app.getVersion(),
    port: AGENT_PORT,
    portOverridden: !!process.env.VH_AGENT_PORT,
    bridge: bridgeState,
    loopback,
    mcpFile: { ok: fs.existsSync(MCP_SERVER_PATH), path: MCP_SERVER_PATH },
    node,
    cli,
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

// ---------------- realistic SFX, synthesized here rather than with ffmpeg expressions ----------
// The lavfi recipes above are closed-form formulas, which is fine for a pop and hopeless for a
// pour: that sound is a couple of hundred separate impacts exciting one resonant container.
// electron/sfxrecipes.ts renders those as actual samples. See docs/SFX.md.

/** Render one of the modelled effects straight to a WAV. */
ipcMain.handle('sfx-render', async (_event, { recipe, seed, intensity, duration, outPath, name }: { recipe: string; seed?: number; intensity?: number; duration?: number; outPath?: string; name?: string }) => {
  const entry = REALISTIC_RECIPES[recipe]
  if (!entry) return { error: `no such sound: ${recipe}`, available: Object.keys(REALISTIC_RECIPES) }
  try {
    const stereo = entry.render({ sampleRate: 48000, seed, intensity, duration })
    const dir = path.join(sfxDir(), 'custom')
    fs.mkdirSync(dir, { recursive: true })
    // the user's own wording if they gave one, so the library reads like their library
    const file = name ? nameToFilename(name) : (seed === undefined ? `${recipe}.wav` : `${recipe}-${seed}.wav`)
    const out = outPath || path.join(dir, file)
    fs.writeFileSync(out, Buffer.from(toWav(stereo)))
    return { ok: true, path: out, name: path.basename(out).replace(/\.wav$/, ''), seconds: +(stereo.left.length / stereo.sampleRate).toFixed(2), about: entry.about }
  } catch (e: any) {
    return { error: String(e?.message || e) }
  }
})

ipcMain.handle('score-render', async (_event, { cuts, hits, duration, bpm, seed, intensity, style, name }: {
  cuts: number[]; hits: number[]; duration: number; bpm?: number; seed?: number; intensity?: Intensity; style?: Style; name?: string
}) => {
  try {
    if (!duration || duration <= 0) return { error: 'timeline is empty, nothing to score' }
    const { plan, stereo } = composeScore({ cuts: cuts || [], hits: hits || [], duration }, { bpm, seed, intensity, style })
    const dir = path.join(sfxDir(), 'score')
    fs.mkdirSync(dir, { recursive: true })
    const file = name ? nameToFilename(name) : `score-${plan.style === 'cinematic' ? 'cinematic-' : ''}${plan.bpm}bpm${seed !== undefined ? `-${seed}` : ''}.wav`
    const out = path.join(dir, file)
    fs.writeFileSync(out, Buffer.from(toWav(stereo)))
    return {
      ok: true, path: out, name: path.basename(out).replace(/\.wav$/, ''),
      seconds: +(stereo.left.length / stereo.sampleRate).toFixed(2),
      bpm: plan.bpm, style: plan.style, pockets: plan.pockets.length, grooveAt: +(plan.grooveBeat * plan.beat).toFixed(2),
      calmsAt: +(plan.lateBeat * plan.beat).toFixed(2), droneAt: +plan.droneAt.toFixed(2),
      whooshes: plan.whooshes.length, impacts: plan.impacts.length, denseBars: plan.denseBars.length,
    }
  } catch (e: any) {
    return { error: String(e?.message || e) }
  }
})

ipcMain.handle('sfx-plan', async (_event, { text, seed }: { text: string; seed?: number }) => {
  const m = matchRecipe(text || '', { seed })
  return { ...m, canMake: !!m.recipe && m.confidence >= MIN_CONFIDENCE }
})

ipcMain.handle('sfx-recipes', async () => ({
  recipes: Object.entries(REALISTIC_RECIPES).map(([name, r]) => ({ name, seconds: r.seconds, about: r.about })),
}))

// ---------------- searching free sound libraries ----------------

const httpsJson = (url: string): Promise<any> => new Promise((resolve) => {
  const req = https.request(url, { method: 'GET', headers: { 'User-Agent': 'VidHelm/1.7 (https://vidhelm.com)', 'Accept': 'application/json' } }, res => {
    const chunks: Buffer[] = []
    res.on('data', d => chunks.push(d as Buffer))
    res.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      if ((res.statusCode || 0) >= 400) return resolve({ __error: `HTTP ${res.statusCode}`, __body: body.slice(0, 300) })
      try { resolve(JSON.parse(body)) } catch { resolve({ __error: 'bad json from provider' }) }
    })
  })
  req.setTimeout(20000, () => { req.destroy(); resolve({ __error: 'timed out' }) })
  req.on('error', e => resolve({ __error: String(e?.message || e) }))
  req.end()
})

/**
 * Search the free libraries. Wikimedia Commons always runs (no key); Freesound runs as well when
 * the user has pasted a token, and it is the one that returns the good results.
 */
ipcMain.handle('sfx-search', async (_event, { query, token, safeOnly, maxSeconds, pageSize }: { query: string; token?: string; safeOnly?: boolean; maxSeconds?: number; pageSize?: number }) => {
  if (!query || !query.trim()) return { error: 'nothing to search for' }
  const opts = { safeOnly, maxSeconds, pageSize }
  const notes: string[] = []
  const lists: any[][] = []

  if (token) {
    const r = await httpsJson(freesoundUrl(query, token, opts))
    if (r.__error) notes.push(`Freesound: ${r.__error === 'HTTP 401' ? 'that token was rejected' : r.__error}`)
    else lists.push(parseFreesound(r))
  } else {
    notes.push('No Freesound token set, so only Wikimedia Commons was searched. Freesound is much bigger: get a free token at freesound.org/apiv2/apply and paste it in Settings.')
  }

  const c = await httpsJson(commonsUrl(query, opts))
  if (c.__error) notes.push(`Wikimedia Commons: ${c.__error}`)
  else lists.push(parseCommons(c))

  const hits = collate(lists, query, opts)
  return {
    ok: true, query, count: hits.length, notes,
    results: hits.slice(0, Math.min(50, pageSize ?? 20)).map(h => ({
      provider: h.provider, id: h.id, name: h.name, seconds: h.seconds, author: h.author,
      license: h.license.name, licenseCode: h.license.code,
      needsAttribution: h.license.needsAttribution, commercialOk: h.license.commercialOk,
      audioUrl: h.audioUrl, pageUrl: h.pageUrl, tags: h.tags,
      attribution: attributionLine(h),
    })),
  }
})

/**
 * Download one result into the user's own SFX folder, and record the credit it needs.
 *
 * Anything requiring attribution is also appended to CREDITS.txt next to the file, because a
 * credit that only exists in a chat log is a credit that will be missing from the description.
 */
ipcMain.handle('sfx-download', async (_event, hit: any) => {
  if (!hit?.audioUrl) return { error: 'no audio url' }
  const dir = path.join(sfxDir(), 'custom')
  fs.mkdirSync(dir, { recursive: true })
  const name = safeFilename({ ...hit, license: classifyLicense(hit.license) })
  const out = path.join(dir, name)

  const fetched = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const get = (url: string, redirects = 0) => {
      https.get(url, { headers: { 'User-Agent': 'VidHelm/1.7 (https://vidhelm.com)' } }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location && redirects < 4) {
          res.resume()
          return get(new URL(res.headers.location, url).toString(), redirects + 1)
        }
        if ((res.statusCode || 0) >= 400) { res.resume(); return resolve({ ok: false, error: `HTTP ${res.statusCode}` }) }
        const file = fs.createWriteStream(out)
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve({ ok: true })))
        file.on('error', e => resolve({ ok: false, error: String(e?.message || e) }))
      }).on('error', e => resolve({ ok: false, error: String(e?.message || e) }))
    }
    get(hit.audioUrl)
  })
  if (!fetched.ok) { try { fs.unlinkSync(out) } catch { /* nothing to clean up */ } return { error: fetched.error } }

  const credit = hit.attribution || attributionLine({ ...hit, license: classifyLicense(hit.license) })
  if (credit) {
    const creditsFile = path.join(dir, 'CREDITS.txt')
    const line = `${name}\n  ${credit}\n\n`
    try {
      const existing = fs.existsSync(creditsFile) ? fs.readFileSync(creditsFile, 'utf8') : 'Sounds used in these videos, and the credit each one needs.\n\n'
      if (!existing.includes(name)) fs.writeFileSync(creditsFile, existing + line, 'utf8')
    } catch { /* the file is a convenience, never fail the download over it */ }
  }
  const duration: number = await new Promise(res => ffmpeg.ffprobe(out, (e, d) => res(e ? 0 : (d.format.duration || 0))))
  return { ok: true, path: out, name, seconds: +duration.toFixed(2), attribution: credit || null }
})

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
  const items: { name: string; path: string; duration: number; builtin: boolean; about?: string }[] = []
  for (const [name, recipe] of Object.entries(SFX_RECIPES)) {
    try { items.push({ name, path: await genSfx(name, recipe), duration: recipe.d, builtin: true }) }
    catch (e) { console.error(e) }
  }
  // the modelled ones, rendered by electron/sfxrecipes.ts rather than by an ffmpeg expression.
  // The revision is part of the file name, so improving a model actually reaches people who have
  // already generated the old one.
  for (const [name, r] of Object.entries(REALISTIC_RECIPES)) {
    try {
      const out = path.join(dir, `${name}.v${REALISTIC_REV}.wav`)
      if (!fs.existsSync(out)) {
        fs.writeFileSync(out, Buffer.from(toWav(r.render({ sampleRate: 48000 }))))
        // drop any earlier revision of this sound
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(`${name}.v`) && f !== path.basename(out)) {
            try { fs.unlinkSync(path.join(dir, f)) } catch { /* it is a cache, never fatal */ }
          }
        }
      }
      items.push({ name, path: out, duration: r.seconds, builtin: true, about: r.about })
    } catch (e) { console.error(e) }
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
// Product captures: a hidden Chromium window renders any URL (a site, a
// localhost dev server, a staging build) at an exact size and theme, runs an
// optional script to seed state or freeze animations, then either grabs a
// still or records `seconds` of frames straight into an mp4. This is the
// `capture_site` tool; it is what made the CruxStudy teaser's UI shots routine.
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
ipcMain.handle('capture-site', async (_event, { url, width = 1920, height = 1080, theme, script, settle = 800, seconds = 0, fps = 30, outPath }: {
  url: string; width?: number; height?: number; theme?: 'light' | 'dark'; script?: string; settle?: number; seconds?: number; fps?: number; outPath?: string
}) => {
  if (!url) return { error: 'url required' }
  // web pages only: file:, data:, chrome: and friends would let a caller read local files into a capture
  try { if (!/^https?:$/.test(new URL(url).protocol)) return { error: 'url must start with http:// or https://' } } catch { return { error: 'that url is not valid' } }
  if (outPath && !(Number(seconds) > 0 ? /\.(mp4|m4v|mov|mkv)$/i : /\.(png|jpe?g)$/i).test(outPath)) {
    return { error: Number(seconds) > 0 ? 'outPath must be a video file (.mp4) for a recording' : 'outPath must be an image file (.png) for a still' }
  }
  const W = Math.max(320, Math.min(3840, Math.round(width))), H = Math.max(240, Math.min(2160, Math.round(height)))
  const FPS = Math.max(5, Math.min(60, Math.round(fps)))
  const prevTheme = nativeTheme.themeSource
  const cap = new BrowserWindow({
    width: W, height: H, show: false, frame: false, backgroundColor: '#000000',
    webPreferences: { offscreen: true, contextIsolation: true, sandbox: true },
  })
  freeToNavigate.add(cap.webContents)   // no preload, sandboxed, and its page is any site at all
  try {
    cap.webContents.setAudioMuted(true)
    if (theme === 'dark' || theme === 'light') nativeTheme.themeSource = theme
    cap.setContentSize(W, H)
    await cap.loadURL(url)
    if (script && script.trim()) {
      try { await cap.webContents.executeJavaScript(script, true) } catch (e) { return { error: 'the page script threw: ' + String(e) } }
    }
    await sleep(Math.max(0, settle))
    const dir = path.join(app.getPath('userData'), 'captures')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    // offscreen pages render at the display's DPI scale (a 1280x720 request came back
    // 2244x1262 on a 175% display), so every frame is brought back to the requested size
    const grab = async () => {
      const img = await cap.webContents.capturePage()
      const size = img.getSize()
      return size.width === W && size.height === H ? img : img.resize({ width: W, height: H, quality: 'best' })
    }
    if (!seconds || seconds <= 0) {
      const img = await grab()
      const out = outPath || path.join(dir, `capture-${stamp}.png`)
      fs.writeFileSync(out, img.toPNG())
      const size = img.getSize()
      return { ok: true, kind: 'image', path: out, width: size.width, height: size.height }
    }
    const secs = Math.min(120, seconds)
    const out = outPath || path.join(dir, `capture-${stamp}.mp4`)
    const total = Math.round(secs * FPS)
    const ff = spawn(paths.ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
      '-vf', `scale=${W - (W % 2)}:${H - (H % 2)}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', out])
    let ffErr = ''
    ff.stderr?.on('data', d => { ffErr += d })
    const t0 = Date.now()
    let written = 0
    for (let i = 0; i < total; i++) {
      const due = t0 + (i * 1000) / FPS
      const wait = due - Date.now()
      if (wait > 0) await sleep(wait)
      const img = await grab()
      if (!ff.stdin.write(img.toPNG())) await new Promise(r => ff.stdin.once('drain', r))
      written++
    }
    ff.stdin.end()
    const code = await new Promise<number>(res => { ff.on('close', c => res(c ?? 0)); ff.on('error', () => res(-1)) })
    if (code !== 0 || !fs.existsSync(out)) return { error: 'encoding the capture failed: ' + ffErr.slice(-400) }
    return { ok: true, kind: 'video', path: out, seconds: secs, fps: FPS, frames: written, width: W, height: H }
  } catch (e: any) {
    return { error: String(e?.message || e) }
  } finally {
    nativeTheme.themeSource = prevTheme
    try { cap.destroy() } catch {}
  }
})

// The pronunciation table the narration adapter applies before synthesis
// (see electron/pronounce.ts). Created with an example on first use so the
// user finds it; edits are picked up on the next narration run.
const pronounceTablePath = () => path.join(app.getPath('userData'), 'pronounce.json')
function loadPronounceTable(): Record<string, string> {
  const p = pronounceTablePath()
  try {
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, JSON.stringify({
        _readme: 'Terms rewritten before narration is synthesized, so the voice says them the way you do. Add your own as "Term": "how to say it". Built-in defaults cover ASCP, SAT, CruxSci, 4K and friends; ALL-CAPS acronyms are spelled out automatically.',
        'CruxSci': 'Crux Sigh',
      }, null, 2))
    }
    return mergeTables(parseTable(fs.readFileSync(p, 'utf8')))
  } catch { return mergeTables() }
}

ipcMain.handle('voice-clone', async (_event, { command, scriptText, pronounce }: { command: string; scriptText: string; pronounce?: boolean }) => {
  if (!command || !command.trim()) return { error: 'No narration command configured (Settings → Narration).' }
  if (!scriptText || !scriptText.trim()) return { error: 'Script is empty.' }
  const workDir = path.join(app.getPath('userData'), 'narration', String(Date.now()))
  fs.mkdirSync(workDir, { recursive: true })
  const scriptFile = path.join(workDir, 'script.txt')
  // pronunciation pass: the voice reads the rewritten lines, the booth keeps the originals
  const spoken = pronounce === false ? scriptText.trim()
    : scriptText.trim().split('\n').map(l => spellOut(l, loadPronounceTable())).join('\n')
  fs.writeFileSync(scriptFile, spoken + '\n', 'utf8')
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
      else resolve({ files: wavs, log: log.slice(-2000), spoken: spoken !== scriptText.trim() ? spoken : undefined, pronounceTable: pronounceTablePath() })
    })
    proc.on('error', err => resolve({ error: String(err), log: log.slice(-2000) }))
  })
})

// Exports in flight, by output file: two renders writing one file produce garbage (an agent retrying
// after a timeout while the first export still runs is exactly how that happens).
const exportsRunning = new Set<string>()
// A failure must say WHY, in words, with the end of ffmpeg's log after it: the renderer shows the
// message in a toast (it used to just make the progress bar disappear).
const exportError = (reason: string, detail = '') => new Error(`Export failed: ${reason}${detail ? `\n${detail}` : ''}`)

ipcMain.handle('export-video', async (_event, { clips, texts, brand, audio, outputPath, settings }: { clips: any[], texts: any[], brand: any, audio: any, outputPath: string, settings: any }) => {
  let cleanupGraph = ''   // the filtergraph is written to a file, see below
  clips = clips || []
  texts = texts || []
  if (clips.length === 0 && texts.length === 0) throw exportError('there is nothing on the timeline to export')
  // A video container only. Besides failing late inside ffmpeg, a bridge caller could otherwise aim
  // the render at any file name it liked (a .cmd in the Startup folder, say).
  if (!outputPath || !/\.(mp4|m4v|mov|mkv)$/i.test(outputPath)) throw exportError('the output file needs a video extension such as .mp4', outputPath ? `got: ${outputPath}` : '')
  // Check every source before ffmpeg starts, and name what is wrong. A clip whose media was removed
  // from the bin arrives with no path at all, which used to throw deep inside fluent-ffmpeg.
  const at = (c: any) => `${c.trackId || 'a track'} at ${Number(c.start || 0).toFixed(1)}s`
  const problems: string[] = []
  for (const c of clips) {
    if (!c.path) problems.push(`the clip on ${at(c)} has no media (it was removed from the bin)`)
    else if (!fs.existsSync(c.path)) problems.push(`${path.basename(c.path)} (on ${at(c)}) is missing`)
    else if (c.type === 'image' && UNREADABLE_STILL.test(c.path)) problems.push(`${path.basename(c.path)} is a HEIC/HEIF photo, which the exporter cannot read: convert it to JPG or PNG`)
  }
  // one problem is the headline by itself; several get a count, then the list
  if (problems.length) throw exportError(problems.length === 1 ? problems[0] : `${problems.length} clips cannot be read`, problems.length === 1 ? '' : problems.slice(0, 6).join('\n'))
  const outKey = path.resolve(outputPath).toLowerCase()
  if (exportsRunning.has(outKey)) throw exportError('an export to that file is already running')
  exportsRunning.add(outKey)
  return new Promise((resolve, reject) => {
    audio = audio || { optimize: settings?.normalizeAudio !== false, noiseReduction: false }

    const W = Math.round(settings?.width) || 1920
    const H = Math.round(settings?.height) || 1080
    const FPS = [24, 30, 60].includes(settings?.fps) ? settings.fps : 30
    const master = typeof settings?.masterVolume === 'number' ? settings.masterVolume : 1
    const fontFile = escFilter(path.join(process.env.WINDIR || 'C:/Windows', 'Fonts', 'arial.ttf'))
    const ends = [...clips.map(c => c.start + c.duration), ...texts.map(t => t.start + t.duration)]
    const totalDuration = ends.length ? Math.max(...ends) : 1

    const tmpDir = path.join(app.getPath('temp'), 'vidhelm_text')
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })

    // what was at the output path before this run, so a failure only removes a file THIS run wrote
    const before = (() => { try { const st = fs.statSync(outputPath); return `${st.mtimeMs}|${st.size}` } catch { return null } })()
    let command = ffmpeg()
    // 0: black base video at target resolution/fps, 1: silent base audio at 48kHz (YouTube spec)
    command.input(`color=c=black:s=${W}x${H}:r=${FPS}:d=${totalDuration}`).inputFormat('lavfi')
    command.input(`anullsrc=channel_layout=stereo:sample_rate=48000:d=${totalDuration}`).inputFormat('lavfi')

    const filterComplex: string[] = []
    let currentVOut = '0:v'
    const audioMixInputs: string[] = ['1:a']
    // One decoder per clip, and each decoder sizes its thread pool to the whole CPU: a long pause-cut
    // of 4K phone footage opened 90 of those at once and took the machine down. Past a handful of
    // video inputs, cap each one; the encoder is the bottleneck by then anyway.
    const videoInputs = clips.filter(c => c.type !== 'image' && c.hasVideo).length
    const decodeThreads = videoInputs > 4 ? ['-threads', '2'] : []

    clips.forEach((clip, i) => {
      const idx = i + 2
      const end = clip.start + clip.duration
      let stillVf = ''
      if (clip.type === 'image') {
        // -loop 1 is image2-only: a GIF, AVIF or ICO used to fail the whole export
        const still = stillInput(clip.path, clip.duration, FPS)
        if (still.opts.length) command.input(clip.path).inputOptions(still.opts)
        else command.input(clip.path)
        stillVf = still.vf
      } else {
        // Honour the clip's trim window. Without this the export renders every clip from the
        // START of its source file and only uses the overlay window to decide when it is on
        // screen, so any trimmed, split or pause-cut timeline exported the wrong footage (and
        // the wrong audio) while the preview looked right. A little tail past the clip length
        // keeps fades fed.
        const ss = Number(clip.sourceStart) || 0
        const opts: string[] = []
        if (ss > 0) opts.push(`-ss ${ss.toFixed(3)}`)
        opts.push(`-t ${(clip.duration + 0.2).toFixed(3)}`)
        if (clip.hasVideo) opts.push(...decodeThreads)
        command.input(clip.path).inputOptions(opts)
      }

      if (clip.hasVideo || clip.type === 'image') {
        // Clips rendered on a key colour (3D Studio green screen) get it removed first, so
        // whatever sits below shows through. despill cleans the fringe that 4:2:0 chroma
        // subsampling leaves around antialiased edges. Costs roughly a second per six
        // seconds of overlay at 1080p, which is cheap next to the encode itself.
        const key = typeof clip.chromaKey === 'string' && /^#?[0-9a-f]{6}$/i.test(clip.chromaKey)
          ? clip.chromaKey.replace('#', '') : null
        const keyChain = key
          ? `colorkey=0x${key}:0.30:0.10,${/^00e/i.test(key) ? 'despill=type=green:mix=0.5:expand=0,' : ''}`
          : ''
        // HDR footage (phone HLG, PQ) is graded for a different display: dropped straight into a
        // bt709 export it comes out grey and flat, so convert it the same way the preview proxy
        // does. Scaling happens after, since tone mapping at output size is the cheaper order.
        const hdrChain = clip.hdr ? `${HDR_TO_SDR},` : ''
        // Fit into frame with transparent padding so overlapping clips can crossfade through each other
        let v = `[${idx}:v]${stillVf}${keyChain}${hdrChain}format=yuva420p,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setpts=PTS-STARTPTS+${clip.start}/TB`
        if (clip.fadeIn > 0) v += `,fade=t=in:st=${clip.start}:d=${clip.fadeIn}:alpha=1`
        if (clip.fadeOut > 0) v += `,fade=t=out:st=${(end - clip.fadeOut).toFixed(3)}:d=${clip.fadeOut}:alpha=1`
        filterComplex.push(`${v}[v_scaled_${idx}]`)
        filterComplex.push(`[${currentVOut}][v_scaled_${idx}]overlay=enable='between(t,${clip.start},${end})':eof_action=pass[v_out_${idx}]`)
        currentVOut = `v_out_${idx}`
      }

      if (clip.hasAudio) {
        const vExpr = volumeExpr(clip.volumePoints, clip.start, clip.volume ?? 1.0)
        // Trimmed to exactly the clip (the input carries a 0.2 s tail for the picture fades, which
        // used to play on under the next clip), and every splice ramped by a few milliseconds so the
        // picture can cut hard without the join clicking. See electron/exportgraph.ts.
        // Volume automation (graph) takes precedence over the flat per-clip volume.
        filterComplex.push(clipAudioChain(`${idx}:a`, clip, vExpr ?? (clip.volume ?? 1.0), `a_delayed_${idx}`))
        audioMixInputs.push(`a_delayed_${idx}`)
      }
    })

    // Themed captions: one ASS script per caption style, rendered by the same code as VidHelm Cloud
    const capTexts = texts.filter(t => t.caption && t.caption.spec)
    const byStyle = new Map<string, any[]>()
    for (const t of capTexts) { const k = JSON.stringify(t.caption.spec); if (!byStyle.has(k)) byStyle.set(k, []); byStyle.get(k)!.push(t) }
    let assNo = 0
    for (const [k, group] of byStyle) {
      const cues = group.map((t: any) => ({ start: t.start, end: t.start + t.duration, text: String(t.text ?? ''),
        words: Array.isArray(t.caption.words) ? t.caption.words.map((w: any) => ({ s: t.start + w.s, e: t.start + w.e, t: w.t })) : undefined }))
      const assFile = path.join(tmpDir, `caps_${assNo}_${Date.now()}.ass`)
      fs.writeFileSync(assFile, buildAss(cues, JSON.parse(k), W, H), 'utf8')
      filterComplex.push(`[${currentVOut}]subtitles=filename='${escFilter(assFile)}':fontsdir='${escFilter(themeFontsDir())}'[v_cap_${assNo}]`)
      currentVOut = `v_cap_${assNo}`
      assNo++
    }

    // Burn in text overlays on top of the video chain
    texts.forEach((t, i) => {
      if (t.caption && t.caption.spec) return   // burned above with its theme
      const end = t.start + t.duration
      const txtFile = path.join(tmpDir, `t_${i}_${Date.now()}.txt`)
      fs.writeFileSync(txtFile, String(t.text ?? ''), 'utf8')
      const color = `0x${(t.color || '#ffffff').replace('#', '')}`
      const size = Math.max(8, Math.round((t.fontSize / 1080) * H))
      const themeFont = t.font && THEME_FONTS[t.font as ThemeFont] ? escFilter(path.join(themeFontsDir(), THEME_FONTS[t.font as ThemeFont].file)) : null
      const outline = typeof t.outline === 'number' && t.outline > 0 && !t.box ? [`borderw=${Math.max(1, Math.round(size * t.outline))}`, `bordercolor=0x${String(t.outlineColor || '#000000').replace('#', '')}`] : []
      const dt = [
        `fontfile='${themeFont || fontFile}'`,
        ...outline,
        `textfile='${escFilter(txtFile)}'`,
        // the text is the user's, literally: under the default expansion a '%' ('100% PLA', 'Save 20%')
        // made drawtext draw NOTHING for the whole overlay (exit 0, no error), and backslashes vanished
        `expansion=none`,
        `fontcolor=${color}`,
        `fontsize=${size}`,
        `x=${Math.round(t.x * W)}-text_w/2`,
        `y=${Math.round(t.y * H)}-text_h/2`,
        ...(t.box ? [`box=1`, `boxcolor=${t.boxColor ? '0x' + String(t.boxColor).replace('#', '') : 'black'}@${typeof t.boxOpacity === 'number' ? t.boxOpacity : 0.5}`, `boxborderw=${Math.round(size * 0.25)}`] : [`box=0`]),
        `enable='between(t,${t.start},${end})'`,
        `alpha='${alphaExpr(t.start, end, t.fadeIn || 0, t.fadeOut || 0)}'`,
      ].join(':')
      filterComplex.push(`[${currentVOut}]drawtext=${dt}[v_txt_${i}]`)
      currentVOut = `v_txt_${i}`
    })

    // Brand logo / outro watermark (applied on top of everything), from persistent settings
    if (brand && brand.enabled && brand.logoPath && fs.existsSync(brand.logoPath)) {
      const logoIdx = 2 + clips.length
      const logo = stillInput(brand.logoPath, totalDuration, FPS)
      if (logo.opts.length) command.input(brand.logoPath).inputOptions(logo.opts)
      else command.input(brand.logoPath)
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
      let lf = `[${logoIdx}:v]${logo.vf}format=rgba,scale=${logoW}:-1,colorchannelmixer=aa=${op}`
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
      // "Loud for YouTube" (compressor, loudnorm to -13 LUFS, hard ceiling) or just the ceiling. The
      // loudnorm branch also mends loudnorm's own timestamp jump near the end; see electron/exportgraph.ts.
      filterComplex.push(masterChain(!!audio.optimize))
    } else {
      filterComplex.push(`[1:a]volume=${master}[aout]`)
    }

    // Windows caps a command line at 32767 characters. A ninety-clip cut builds a filtergraph of
    // roughly 25k on its own, which on top of the inputs blows straight past that and the process
    // simply fails to start. Hand ffmpeg the graph as a file instead: same graph, tiny argv.
    const graph = filterComplex.map(f => (typeof f === 'string' ? f : String(f))).join(';')
    const graphPath = path.join(app.getPath('temp'), `vidhelm_graph_${Date.now()}.txt`)
    fs.writeFileSync(graphPath, graph)
    cleanupGraph = graphPath
    command
      .outputOptions(['-filter_complex_script', graphPath])
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
      .on('end', () => { exportsRunning.delete(outKey); if (cleanupGraph) { try { fs.unlinkSync(cleanupGraph) } catch { /* already gone */ } } resolve({ success: true }) })
      .on('error', (err: Error, _stdout: string, stderr: string) => {
        exportsRunning.delete(outKey)
        if (cleanupGraph) { try { fs.unlinkSync(cleanupGraph) } catch { /* already gone */ } }
        // A half-written file would otherwise sit there looking like a finished export. Only one this
        // run actually wrote: a failure while opening the inputs never touches the output, and an
        // earlier good export at the same path must survive that.
        try { const st = fs.statSync(outputPath); if (`${st.mtimeMs}|${st.size}` !== before) fs.rmSync(outputPath, { force: true }) } catch { /* locked or never created */ }
        console.error('FFmpeg error:', err, stderr)
        const raw = `${err?.message || err}\n${stderr || ''}`
        reject(exportError(friendlyExportError(raw, outputPath), stderrTail(stderr || String(err?.message || ''))))
      })
      .save(outputPath)
  }).finally(() => exportsRunning.delete(outKey))
})
