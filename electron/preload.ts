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
  // the take as bytes (or a legacy base64 string); dir = <project>/voice when a project is open
  saveRecording: (data: string | Uint8Array | ArrayBuffer, dir?: string) => ipcRenderer.invoke('save-recording', data, dir),
  saveProject: (data: any) => ipcRenderer.invoke('save-project', data),
  loadProject: () => ipcRenderer.invoke('load-project'),
  revealFile: (filePath: string) => ipcRenderer.invoke('reveal-file', filePath),
  makeThumbnails: (data: { filePath: string; sourceStart: number; duration: number; count?: number }) => ipcRenderer.invoke('make-thumbnails', data),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (data: any) => ipcRenderer.invoke('set-settings', data),
  pickLogo: () => ipcRenderer.invoke('pick-logo'),
  qualityCheck: (filePath: string) => ipcRenderer.invoke('quality-check', filePath),
  transcribe: (filePath: string, opts?: any) => ipcRenderer.invoke('transcribe', filePath, opts),
  renderMixAudio: (data: { clips: any[] }) => ipcRenderer.invoke('render-mix-audio', data),
  detectSilence: (data: { filePath: string; thresholdDb: number; minPause: number }) => ipcRenderer.invoke('detect-silence', data),
  detectFreeze: (data: { filePath: string; sourceStart: number; duration: number; freezeDb: number; minDur: number }) => ipcRenderer.invoke('detect-freeze', data),
  // Fix voice (electron/audiochain.ts): measure a media file's sound; bake its processed voice
  analyzeAudioMedia: (data: { filePath: string; preset?: string; provenance?: string; isVideo?: boolean; track?: string }) => ipcRenderer.invoke('analyze-audio-media', data),
  bakeVoice: (data: { filePath: string; preset?: string; picture?: string | null }) => ipcRenderer.invoke('bake-voice', data),
  exportVideo: (data: { clips: any[], texts: any[], brand: any, audio: any, outputPath: string, settings: any }) => ipcRenderer.invoke('export-video', data),
  // where the export will land, measured on the export's own audio graph (electron/mixrender.ts)
  scanTimelineLoudness: (data: { clips: any[]; texts?: any[]; audio?: any; settings?: any; bake?: boolean }) => ipcRenderer.invoke('scan-timeline-loudness', data),
  sfxLibrary: () => ipcRenderer.invoke('sfx-library'),
  pickAudio: () => ipcRenderer.invoke('pick-audio'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  openTerminal: () => ipcRenderer.invoke('open-terminal'),
  makeProxy: (data: { filePath: string; info: any; maxWidth?: number; maxFps?: number }) => ipcRenderer.invoke('make-proxy', data),
  sampleFrames: (data: { filePath: string; count?: number; sourceStart?: number; duration?: number }) => ipcRenderer.invoke('sample-frames', data),
  machineProfile: (data?: { refresh?: boolean }) => ipcRenderer.invoke('machine-profile', data || {}),
  sfxSearch: (data: { query: string; token?: string; safeOnly?: boolean; maxSeconds?: number; pageSize?: number }) => ipcRenderer.invoke('sfx-search', data),
  sfxDownload: (hit: any) => ipcRenderer.invoke('sfx-download', hit),
  sfxRender: (data: { recipe: string; seed?: number; intensity?: number; duration?: number; outPath?: string; name?: string }) => ipcRenderer.invoke('sfx-render', data),
  scoreRender: (data: { cuts: number[]; hits: number[]; duration: number; bpm?: number; seed?: number; intensity?: string; style?: string; name?: string }) => ipcRenderer.invoke('score-render', data),
  captureSite: (data: { url: string; width?: number; height?: number; theme?: string; script?: string; settle?: number; seconds?: number; fps?: number; outPath?: string }) => ipcRenderer.invoke('capture-site', data),
  sfxRecipes: () => ipcRenderer.invoke('sfx-recipes'),
  findAudioCpp: (data?: { extraDirs?: string[] }) => ipcRenderer.invoke('find-audiocpp', data || {}),
  sfxPlan: (data: { text: string; seed?: number }) => ipcRenderer.invoke('sfx-plan', data),
  visualIndex: (data: { filePath: string; interval?: number; maxFrames?: number; perSheet?: number; cols?: number; tileWidth?: number; sourceStart?: number; duration?: number }) => ipcRenderer.invoke('visual-index', data),
  scanBroll: (data: { folder: string; refresh?: boolean; tiles?: number }) => ipcRenderer.invoke('scan-broll', data),
  labelBroll: (data: { folder: string; id: string; labels?: string[]; description?: string; bestStart?: number; bestEnd?: number; maxUses?: number }) => ipcRenderer.invoke('label-broll', data),
  refineCut: (data: { filePath: string; t: number; dir?: 'after' | 'before'; window?: number; floorDb?: number }) => ipcRenderer.invoke('refine-cut', data),
  planFraming: (data: { filePath: string; sourceStart?: number; duration?: number; fps?: number; hints?: { t: number; cx: number; weight?: number }[]; aspect?: number }) => ipcRenderer.invoke('plan-framing', data),
  composeThumbnail: (data: { filePath?: string | null; t?: number; imagePath?: string | null; subtitle?: string; logoPath?: string | null; outPath: string; theme?: string }) => ipcRenderer.invoke('compose-thumbnail', data),
  rankFrames: (data: { filePath: string; count?: number; keep?: number; sourceStart?: number; duration?: number }) => ipcRenderer.invoke('rank-frames', data),
  openSfxFolder: () => ipcRenderer.invoke('open-sfx-folder'),
  saveSfxRecording: (data: { base64: string; name: string }) => ipcRenderer.invoke('save-sfx-recording', data),
  voiceClone: (data: { command: string; scriptText: string; pronounce?: boolean }) => ipcRenderer.invoke('voice-clone', data),
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
  importCloudZip: (data: { root: string; zipPath?: string }) => ipcRenderer.invoke('import-cloud-zip', data),
  genClip: (data: any) => ipcRenderer.invoke('gen-clip', data),
  analysisPath: (name: string) => ipcRenderer.invoke('analysis-path', name),
  windowDragStart: () => ipcRenderer.send('window-drag-start'),
  windowDragEnd: () => ipcRenderer.send('window-drag-end'),
  windowToggleMaximize: () => ipcRenderer.send('window-toggle-maximize'),
  setWindowTheme: (theme: 'dark' | 'light') => ipcRenderer.send('window-theme', theme),
})
