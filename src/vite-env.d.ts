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
    /** width/height are as DISPLAYED (a rotated phone clip is swapped); rotation is the flag that was applied */
    getMetadata: (filePath: string) => Promise<{ duration: number; hasVideo: boolean; hasAudio: boolean; ok?: boolean; error?: string; format?: string; videoCodec?: string; pixFmt?: string; colorTransfer?: string; width?: number; height?: number; fps?: number; rotation?: number }>
    /** bytes (or legacy base64); dir defaults to the app's recordings folder, never %TEMP% */
    saveRecording: (data: string | Uint8Array | ArrayBuffer, dir?: string) => Promise<string>
    saveProject: (data: any) => Promise<string | null>
    /** { data, path } names the file picked (older builds returned the bare project); null when cancelled or unreadable */
    loadProject: () => Promise<{ data: any; path: string } | any | null>
    revealFile: (filePath: string) => Promise<void>
    makeThumbnails: (data: { filePath: string; sourceStart: number; duration: number; count?: number }) => Promise<{ path?: string; error?: string }>
    audioPeaks: (filePath: string) => Promise<{ rate?: number; data?: Uint8Array; error?: string }>
    getSettings: () => Promise<any>
    setSettings: (data: any) => Promise<boolean>
    pickLogo: () => Promise<string | null>
    qualityCheck: (filePath: string) => Promise<any>
    transcribe: (filePath: string, opts?: { model?: string; language?: string; word?: boolean }) => Promise<{ chunks?: { start: number; end: number; text: string }[]; error?: string }>
    renderMixAudio: (data: { clips: any[] }) => Promise<{ path?: string; error?: string }>
    detectSilence: (data: { filePath: string; thresholdDb: number; minPause: number }) => Promise<{ intervals?: { start: number; end: number }[]; error?: string }>
    detectFreeze: (data: { filePath: string; sourceStart: number; duration: number; freezeDb: number; minDur: number }) => Promise<{ intervals?: { start: number; end: number }[]; error?: string }>
    /** rejects with an Error whose message is "Export failed: <reason>" plus the end of ffmpeg's log on following lines */
    exportVideo: (data: { clips: any[], texts: any[], brand: any, audio: any, outputPath: string, settings: any }) => Promise<{ success: boolean }>
    sfxLibrary: () => Promise<{ dir: string; items: { name: string; path: string; duration: number; builtin: boolean }[] }>
    pickAudio: () => Promise<string | null>
    openExternal: (url: string) => Promise<void>
    openTerminal: () => Promise<{ ok?: boolean; error?: string }>
    /** width/height/fps describe the PROXY file itself (as displayed), on fresh and cached replies alike */
    makeProxy: (data: { filePath: string; info: any; maxWidth?: number; maxFps?: number }) => Promise<{ ok?: boolean; path?: string; cached?: boolean; skipped?: boolean; reason?: string; encoder?: string; width?: number; height?: number; fps?: number; error?: string }>
    sampleFrames: (data: { filePath: string; count?: number; sourceStart?: number; duration?: number }) => Promise<{ frames?: { t: number; path: string }[]; error?: string }>
    machineProfile: (data?: { refresh?: boolean }) => Promise<{ specs?: { cores: number; memGB: number; hwEncoder: boolean; benchMs: number }; cpu?: string; detected?: 'low' | 'balanced' | 'best'; reasons?: string[]; profile?: any }>
    sfxSearch: (data: { query: string; token?: string; safeOnly?: boolean; maxSeconds?: number; pageSize?: number }) => Promise<{ ok?: boolean; query?: string; count?: number; notes?: string[]; results?: any[]; error?: string }>
    sfxDownload: (hit: any) => Promise<{ ok?: boolean; path?: string; name?: string; seconds?: number; attribution?: string | null; error?: string }>
    sfxRender: (data: { recipe: string; seed?: number; intensity?: number; duration?: number; outPath?: string; name?: string }) => Promise<{ ok?: boolean; path?: string; name?: string; seconds?: number; about?: string; error?: string; available?: string[] }>
    scoreRender: (data: { cuts: number[]; hits: number[]; duration: number; bpm?: number; seed?: number; intensity?: string; style?: string; name?: string }) => Promise<{ ok?: boolean; path?: string; name?: string; seconds?: number; bpm?: number; style?: string; pockets?: number; grooveAt?: number; calmsAt?: number; droneAt?: number; whooshes?: number; impacts?: number; denseBars?: number; error?: string }>
    captureSite: (data: { url: string; width?: number; height?: number; theme?: string; script?: string; settle?: number; seconds?: number; fps?: number; outPath?: string }) => Promise<{ ok?: boolean; kind?: 'image' | 'video'; path?: string; width?: number; height?: number; seconds?: number; fps?: number; frames?: number; error?: string }>
    sfxRecipes: () => Promise<{ recipes?: { name: string; seconds: number; about: string }[] }>
    findAudioCpp: (data?: { extraDirs?: string[] }) => Promise<{ exe: string | null; model: string | null; command: string | null; searched?: string[]; note: string }>
    sfxPlan: (data: { text: string; seed?: number }) => Promise<{ recipe: string; options: any; name: string; summary: string; confidence: number; canMake: boolean }>
    visualIndex: (data: { filePath: string; interval?: number; maxFrames?: number; perSheet?: number; cols?: number; tileWidth?: number; sourceStart?: number; duration?: number }) => Promise<{ ok?: boolean; frames?: number; interval?: number; sheets?: any[]; note?: string; hint?: string; error?: string }>
    scanBroll: (data: { folder: string; refresh?: boolean; tiles?: number }) => Promise<{ folder?: string; assets?: any[]; needsLabels?: string[]; error?: string }>
    labelBroll: (data: { folder: string; id: string; labels?: string[]; description?: string; bestStart?: number; bestEnd?: number; maxUses?: number }) => Promise<{ ok?: boolean; id?: string; saved?: any; error?: string }>
    refineCut: (data: { filePath: string; t: number; dir?: 'after' | 'before'; window?: number; floorDb?: number }) => Promise<{ t?: number; refined?: number; moved?: number; note?: string; error?: string }>
    planFraming: (data: { filePath: string; sourceStart?: number; duration?: number; fps?: number; hints?: { t: number; cx: number; weight?: number }[]; aspect?: number }) => Promise<any>
    composeThumbnail: (data: { filePath?: string | null; t?: number; imagePath?: string | null; subtitle?: string; logoPath?: string | null; outPath: string; theme?: string }) => Promise<{ ok?: boolean; outPath?: string; source?: 'photo' | 'frame' | 'placeholder'; placeholder?: boolean; nudge?: string; error?: string }>
    rankFrames: (data: { filePath: string; count?: number; keep?: number; sourceStart?: number; duration?: number }) => Promise<{ frames?: { t: number; path: string; score: number; why: string }[]; sampled?: number; error?: string }>
    openSfxFolder: () => Promise<{ ok?: boolean; path?: string; error?: string }>
    saveSfxRecording: (data: { base64: string; name: string }) => Promise<{ path?: string; name?: string; duration?: number; error?: string }>
    voiceClone: (data: { command: string; scriptText: string; pronounce?: boolean }) => Promise<{ files?: string[]; error?: string; log?: string; spoken?: string; pronounceTable?: string }>
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
    importCloudZip: (data: { root: string; zipPath?: string }) => Promise<{ path?: string; name?: string; clips?: number; timeline?: number; failed?: string[]; cancelled?: boolean; error?: string }>
    /** stillRunning: the provider job may still finish (and bill); do not resubmit */
    genClip: (data: { prompt: string; fromPath?: string; fromTime?: number; toPath?: string; toTime?: number; seconds?: number; aspect: 'landscape' | 'portrait' | 'square'; model?: string; keys?: { fal?: string; gemini?: string }; outDir: string }) => Promise<{ path?: string; model?: string; seconds?: number; hasAudio?: boolean; estimateUsd?: number; error?: string; stillRunning?: boolean }>
    createProject: (data: { root: string; name: string }) => Promise<{ path?: string; name?: string; error?: string }>
    /** moved: loose recordings (temp / app folder) copied into <dir>/voice; the saved file already points at `to`, with relPath set */
    saveProjectTo: (data: { dir: string; data: any }) => Promise<{ path?: string; error?: string; moved?: { from: string; to: string; relPath?: string }[] }>
    revealFolder: (dir: string) => Promise<void>
    analysisPath: (name: string) => Promise<string>
    windowDragStart: () => void
    windowDragEnd: () => void
    windowToggleMaximize: () => void
    setWindowTheme?: (theme: 'dark' | 'light') => void
    agentStatus: () => Promise<{
      appVersion: string; port: number; portOverridden: boolean
      bridge: { listening: boolean; error: string }
      loopback: { ok: boolean; detail: string }
      mcpFile: { ok: boolean; path: string }
      node: { ok: boolean; version?: string }; cli: { onPath: boolean; path?: string }
    }>
  }
}
