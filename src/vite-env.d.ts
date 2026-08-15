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
    getMetadata: (filePath: string) => Promise<any>
    saveRecording: (base64: string) => Promise<string>
    saveProject: (data: any) => Promise<string | null>
    loadProject: () => Promise<any | null>
    revealFile: (filePath: string) => Promise<void>
    makeThumbnails: (data: { filePath: string; sourceStart: number; duration: number }) => Promise<{ path?: string; error?: string }>
    getSettings: () => Promise<any>
    setSettings: (data: any) => Promise<boolean>
    pickLogo: () => Promise<string | null>
    qualityCheck: (filePath: string) => Promise<any>
    transcribe: (filePath: string, opts?: { model?: string; language?: string; word?: boolean }) => Promise<{ chunks?: { start: number; end: number; text: string }[]; error?: string }>
    renderMixAudio: (data: { clips: any[] }) => Promise<{ path?: string; error?: string }>
    detectSilence: (data: { filePath: string; thresholdDb: number; minPause: number }) => Promise<{ intervals?: { start: number; end: number }[]; error?: string }>
    detectFreeze: (data: { filePath: string; sourceStart: number; duration: number; freezeDb: number; minDur: number }) => Promise<{ intervals?: { start: number; end: number }[]; error?: string }>
    exportVideo: (data: { clips: any[], texts: any[], brand: any, audio: any, outputPath: string, settings: any }) => Promise<{ success: boolean }>
    sfxLibrary: () => Promise<{ dir: string; items: { name: string; path: string; duration: number; builtin: boolean }[] }>
    pickAudio: () => Promise<string | null>
    openExternal: (url: string) => Promise<void>
    sampleFrames: (data: { filePath: string; count?: number; sourceStart?: number; duration?: number }) => Promise<{ frames?: { t: number; path: string }[]; error?: string }>
    composeThumbnail: (data: { filePath: string; t: number; subtitle?: string; logoPath?: string | null; outPath: string }) => Promise<{ ok?: boolean; outPath?: string; error?: string }>
    openSfxFolder: () => Promise<void>
    voiceClone: (data: { command: string; scriptText: string }) => Promise<{ files?: string[]; error?: string; log?: string }>
    agentStatus: () => Promise<{
      appVersion: string; port: number; portOverridden: boolean
      bridge: { listening: boolean; error: string }
      loopback: { ok: boolean; detail: string }
      mcpFile: { ok: boolean; path: string }
      node: { ok: boolean; version?: string }
    }>
  }
}
