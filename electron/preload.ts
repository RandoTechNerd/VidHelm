import { ipcRenderer, contextBridge, webUtils } from 'electron'

// --------- Expose some API to the Renderer process ---------
// Track wrapper functions so off() can actually unregister what on() registered
const wrapped = new Map<Function, (...a: any[]) => void>()
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    const wrap = (event: any, ...rest: any[]) => listener(event, ...rest)
    wrapped.set(listener, wrap)
    return ipcRenderer.on(channel, wrap)
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, listener] = args
    const wrap = wrapped.get(listener as any)
    wrapped.delete(listener as any)
    return ipcRenderer.off(channel, (wrap || listener) as any)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },

  // Custom handlers
  log: (...args: any[]) => ipcRenderer.send('log', ...args),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  selectSavePath: (defaultName: string) => ipcRenderer.invoke('select-save-path', defaultName),
  getMetadata: (filePath: string) => ipcRenderer.invoke('get-metadata', filePath),
  saveRecording: (base64: string) => ipcRenderer.invoke('save-recording', base64),
  saveProject: (data: any) => ipcRenderer.invoke('save-project', data),
  loadProject: () => ipcRenderer.invoke('load-project'),
  revealFile: (filePath: string) => ipcRenderer.invoke('reveal-file', filePath),
  makeThumbnails: (data: { filePath: string; sourceStart: number; duration: number }) => ipcRenderer.invoke('make-thumbnails', data),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (data: any) => ipcRenderer.invoke('set-settings', data),
  pickLogo: () => ipcRenderer.invoke('pick-logo'),
  qualityCheck: (filePath: string) => ipcRenderer.invoke('quality-check', filePath),
  transcribe: (filePath: string, opts?: any) => ipcRenderer.invoke('transcribe', filePath, opts),
  renderMixAudio: (data: { clips: any[] }) => ipcRenderer.invoke('render-mix-audio', data),
  detectSilence: (data: { filePath: string; thresholdDb: number; minPause: number }) => ipcRenderer.invoke('detect-silence', data),
  detectFreeze: (data: { filePath: string; sourceStart: number; duration: number; freezeDb: number; minDur: number }) => ipcRenderer.invoke('detect-freeze', data),
  exportVideo: (data: { clips: any[], texts: any[], brand: any, audio: any, outputPath: string, settings: any }) => ipcRenderer.invoke('export-video', data),
  sfxLibrary: () => ipcRenderer.invoke('sfx-library'),
  pickAudio: () => ipcRenderer.invoke('pick-audio'),
  sampleFrames: (data: { filePath: string; count?: number; sourceStart?: number; duration?: number }) => ipcRenderer.invoke('sample-frames', data),
  composeThumbnail: (data: { filePath: string; t: number; subtitle?: string; logoPath?: string | null; outPath: string }) => ipcRenderer.invoke('compose-thumbnail', data),
  openSfxFolder: () => ipcRenderer.invoke('open-sfx-folder'),
  voiceClone: (data: { command: string; scriptText: string }) => ipcRenderer.invoke('voice-clone', data),
})
