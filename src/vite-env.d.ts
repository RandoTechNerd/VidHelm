/// <reference types="vite/client" />

interface Window {
  ipcRenderer: {
    on: (channel: string, listener: (event: any, ...args: any[]) => void) => void
    off: (channel: string, listener: (event: any, ...args: any[]) => void) => void
    send: (channel: string, ...args: any[]) => void
    invoke: (channel: string, ...args: any[]) => any
    log: (...args: any[]) => void
    getPathForFile: (file: File) => string
    selectSavePath: (defaultName: string) => Promise<string | null>
    getMetadata: (filePath: string) => Promise<{ duration: number; hasVideo: boolean; hasAudio: boolean; ok?: boolean; error?: string; format?: string; videoCodec?: string; pixFmt?: string; colorTransfer?: string; width?: number; height?: number; fps?: number }>
    normalizeAlphaMedia: (data: { filePath: string; fallbackFps?: number }) => Promise<{ normalized?: boolean; cached?: boolean; path?: string; previewPath?: string; duration?: number; fps?: number; frames?: number; width?: number; height?: number; alpha?: boolean; sourceType?: 'webp' | 'png-sequence'; error?: string }>
    saveRecording: (base64: string) => Promise<string>
    saveProject: (data: any) => Promise<string | null>
    loadProject: () => Promise<any | null>
    revealFile: (filePath: string) => Promise<void>
    makeThumbnails: (data: { filePath: string; sourceStart: number; duration: number; count?: number }) => Promise<{ path?: string; error?: string }>
    getSettings: () => Promise<any>
    setSettings: (data: any) => Promise<boolean>
    pickLogo: () => Promise<string | null>
    qualityCheck: (filePath: string) => Promise<any>
    transcribe: (filePath: string, opts?: { model?: string; language?: string; word?: boolean }) => Promise<{ chunks?: { start: number; end: number; text: string }[]; error?: string }>
    renderMixAudio: (data: { clips: any[] }) => Promise<{ path?: string; error?: string }>
    detectSilence: (data: { filePath: string; thresholdDb: number; minPause: number }) => Promise<{ intervals?: { start: number; end: number }[]; error?: string }>
    detectFreeze: (data: { filePath: string; sourceStart: number; duration: number; freezeDb: number; minDur: number }) => Promise<{ intervals?: { start: number; end: number }[]; error?: string }>
    exportVideo: (data: { clips: any[], texts: any[], brand: any, audio: any, outputPath: string, settings: any }) => Promise<{ success: boolean; outputPath: string; format: string; alpha: boolean; frames?: number }>
    sfxLibrary: () => Promise<{ dir: string; items: { name: string; path: string; duration: number; builtin: boolean }[] }>
    pickAudio: () => Promise<string | null>
    openExternal: (url: string) => Promise<void>
    openTerminal: () => Promise<{ ok?: boolean; error?: string }>
    makeProxy: (data: { filePath: string; info: any; maxWidth?: number; maxFps?: number }) => Promise<{ ok?: boolean; path?: string; cached?: boolean; skipped?: boolean; reason?: string; encoder?: string; error?: string }>
    sampleFrames: (data: { filePath: string; count?: number; sourceStart?: number; duration?: number }) => Promise<{ frames?: { t: number; path: string }[]; error?: string }>
    machineProfile: (data?: { refresh?: boolean }) => Promise<{ specs?: { cores: number; memGB: number; hwEncoder: boolean; benchMs: number }; cpu?: string; detected?: 'low' | 'balanced' | 'best'; reasons?: string[]; profile?: any }>
    sfxSearch: (data: { query: string; token?: string; safeOnly?: boolean; maxSeconds?: number; pageSize?: number }) => Promise<{ ok?: boolean; query?: string; count?: number; notes?: string[]; results?: any[]; error?: string }>
    sfxDownload: (hit: any) => Promise<{ ok?: boolean; path?: string; name?: string; seconds?: number; attribution?: string | null; error?: string }>
    sfxRender: (data: { recipe: string; seed?: number; intensity?: number; duration?: number; outPath?: string; name?: string }) => Promise<{ ok?: boolean; path?: string; name?: string; seconds?: number; about?: string; error?: string; available?: string[] }>
    sfxRecipes: () => Promise<{ recipes?: { name: string; seconds: number; about: string }[] }>
    sfxPlan: (data: { text: string; seed?: number }) => Promise<{ recipe: string; options: any; name: string; summary: string; confidence: number; canMake: boolean }>
    scanBroll: (data: { folder: string; refresh?: boolean; tiles?: number }) => Promise<{ folder?: string; assets?: any[]; needsLabels?: string[]; error?: string }>
    labelBroll: (data: { folder: string; id: string; labels?: string[]; description?: string; bestStart?: number; bestEnd?: number; maxUses?: number }) => Promise<{ ok?: boolean; id?: string; saved?: any; error?: string }>
    refineCut: (data: { filePath: string; t: number; dir?: 'after' | 'before'; window?: number; floorDb?: number }) => Promise<{ t?: number; refined?: number; moved?: number; note?: string; error?: string }>
    planFraming: (data: { filePath: string; sourceStart?: number; duration?: number; fps?: number; hints?: { t: number; cx: number; weight?: number }[]; aspect?: number }) => Promise<any>
    composeThumbnail: (data: { filePath: string; t: number; subtitle?: string; logoPath?: string | null; outPath: string }) => Promise<{ ok?: boolean; outPath?: string; error?: string }>
    openSfxFolder: () => Promise<{ ok?: boolean; path?: string; error?: string }>
    saveSfxRecording: (data: { base64: string; name: string }) => Promise<{ path?: string; name?: string; duration?: number; error?: string }>
    voiceClone: (data: { command: string; scriptText: string }) => Promise<{ files?: string[]; error?: string; log?: string }>
    pickModel: () => Promise<string | null>
    extractModel: (filePath: string) => Promise<{ path?: string; how?: string; error?: string }>
    save3DRender: (data: { base64: string; name: string; alpha?: boolean }) => Promise<{ path?: string; error?: string }>
    save3DStill: (data: { dataUrl: string; name: string }) => Promise<{ path?: string; error?: string }>
    saveObjFile: (data: { text: string; defaultName: string }) => Promise<{ path?: string; error?: string }>
    voiceCloneSetup: (data: { sampleBase64?: string; samplePath?: string }) => Promise<{ dir?: string; command?: string; error?: string }>
    voiceCppSetup: (data: { sampleBase64?: string; samplePath?: string; cliPath: string; modelPath: string; family: string }) => Promise<{ dir?: string; command?: string; error?: string }>
    sfxGenerate: (data: { command: string; prompt: string }) => Promise<{ path?: string; error?: string; log?: string }>
    pickFile: (data: { title: string; extensions: string[] }) => Promise<string | null>
    pickFolder: (title: string) => Promise<string | null>
    listProjects: (root: string) => Promise<{ projects?: { name: string; path: string; media: number; saved: boolean; modified: number }[]; error?: string }>
    scanProject: (dir: string) => Promise<{ files?: { path: string; name: string; mtime: number }[]; project?: any; projectFile?: string; error?: string }>
    createProject: (data: { root: string; name: string }) => Promise<{ path?: string; name?: string; error?: string }>
    saveProjectTo: (data: { dir: string; data: any }) => Promise<{ path?: string; error?: string }>
    revealFolder: (dir: string) => Promise<void>
    analysisPath: (name: string) => Promise<string>
    windowDragStart: () => void
    windowDragEnd: () => void
    windowToggleMaximize: () => void
    agentStatus: () => Promise<{
      appVersion: string; port: number; portOverridden: boolean
      bridge: { listening: boolean; error: string }
      loopback: { ok: boolean; detail: string }
      mcpFile: { ok: boolean; path: string }
      node: { ok: boolean; version?: string }; cli: { onPath: boolean; path?: string }
    }>
  }
}
