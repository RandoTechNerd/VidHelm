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
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  sampleFrames: (data: { filePath: string; count?: number; sourceStart?: number; duration?: number }) => ipcRenderer.invoke('sample-frames', data),
  composeThumbnail: (data: { filePath: string; t: number; subtitle?: string; logoPath?: string | null; outPath: string }) => ipcRenderer.invoke('compose-thumbnail', data),
  openSfxFolder: () => ipcRenderer.invoke('open-sfx-folder'),
  voiceClone: (data: { command: string; scriptText: string }) => ipcRenderer.invoke('voice-clone', data),
  agentStatus: () => ipcRenderer.invoke('agent-status'),
  pickModel: () => ipcRenderer.invoke('pick-model'),
  extractModel: (filePath: string) => ipcRenderer.invoke('extract-model', filePath),
  save3DRender: (data: { base64: string; name: string; alpha?: boolean }) => ipcRenderer.invoke('save-3d-render', data),
  save3DStill: (data: { dataUrl: string; name: string }) => ipcRenderer.invoke('save-3d-still', data),
  saveObjFile: (data: { text: string; defaultName: string }) => ipcRenderer.invoke('save-obj-file', data),
  voiceCloneSetup: (data: { sampleBase64?: string; samplePath?: string }) => ipcRenderer.invoke('voice-clone-setup', data),
  voiceCppSetup: (data: { sampleBase64?: string; samplePath?: string; cliPath: string; modelPath: string; family: string }) => ipcRenderer.invoke('voice-cpp-setup', data),
  sfxGenerate: (data: { command: string; prompt: string }) => ipcRenderer.invoke('sfx-generate', data),
  pickFile: (data: { title: string; extensions: string[] }) => ipcRenderer.invoke('pick-file', data),
  pickFolder: (title: string) => ipcRenderer.invoke('pick-folder', title),
  listProjects: (root: string) => ipcRenderer.invoke('list-projects', root),
  scanProject: (dir: string) => ipcRenderer.invoke('scan-project', dir),
  createProject: (data: { root: string; name: string }) => ipcRenderer.invoke('create-project', data),
  saveProjectTo: (data: { dir: string; data: any }) => ipcRenderer.invoke('save-project-to', data),
  revealFolder: (dir: string) => ipcRenderer.invoke('reveal-folder', dir),
  windowDragStart: () => ipcRenderer.send('window-drag-start'),
  windowDragEnd: () => ipcRenderer.send('window-drag-end'),
  windowToggleMaximize: () => ipcRenderer.send('window-toggle-maximize'),
})
