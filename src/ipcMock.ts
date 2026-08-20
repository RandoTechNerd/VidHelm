// Browser fallback for the Electron bridge, lets `npm run dev:web` render the full UI in a plain
// browser for UI work and screenshots. Media import/export need real Electron; everything visual
// (timeline, tag points, SFX list, booth, panels) works against this mock.
import { classify, profileFor, benchmark } from '../electron/capability'
import { matchRecipe, MIN_CONFIDENCE } from '../electron/sfxmatch'

const demoSfx = ['whoosh', 'pop', 'boing', 'squish', 'gummy-squish', 'gloop', 'poof', 'spoosh', 'sparkle', 'party', 'riser', 'ding', 'thud',
  // the modelled ones; the desktop app renders these for real, the preview only lists them
  'coffee-beans', 'coffee-beans-plastic', 'coffee-beans-glass', 'door-electronic', 'door-electronic-close', 'podracer-start', 'podracer-pass']

export function installIpcMock() {
  if (window.ipcRenderer) return
  // Marks this as the browser preview so the UI can say so instead of appearing broken:
  // file dialogs, FFmpeg and the agent bridge all live in the desktop process.
  ;(window as unknown as { __vhWeb?: boolean }).__vhWeb = true
  const noop = async () => null
  window.ipcRenderer = {
    on: () => {}, off: () => {}, send: () => {}, invoke: noop, log: () => {},
    getPathForFile: (f: File) => (f as any).path || f.name,
    selectSavePath: async () => null,
    getMetadata: async () => ({ duration: 5, hasVideo: false, hasAudio: true, ok: true, format: '', videoCodec: '' }),
    saveRecording: async () => 'mock://recording.webm',
    saveProject: async () => null,
    loadProject: async () => null,
    revealFile: async () => {},
    makeThumbnails: async () => ({ error: 'mock' }),
    getSettings: async () => null,
    setSettings: async () => true,
    pickLogo: async () => null,
    qualityCheck: async () => ({ error: 'Quality check needs the desktop app' }),
    transcribe: async () => ({ error: 'Captions need the desktop app' }),
    renderMixAudio: async () => ({ error: 'mock' }),
    detectSilence: async () => ({ intervals: [] }),
    detectFreeze: async () => ({ intervals: [] }),
    exportVideo: async () => { throw new Error('Export needs the desktop app (npm run dev)') },
    sfxLibrary: async () => ({ dir: 'mock', items: demoSfx.map((name, i) => ({ name, path: `mock://sfx/${name}.wav`, duration: 0.3 + (i % 5) * 0.25, builtin: true })) }),
    openSfxFolder: async () => ({ error: 'The sound folder needs the desktop app (npm run dev)' }),
    saveSfxRecording: async () => ({ error: 'Recording needs the desktop app (npm run dev)' }),
    openExternal: async (url: string) => { window.open(url, "_blank") },
    openTerminal: async () => ({ error: 'Opening a terminal needs the desktop app' }),
    makeProxy: async () => ({ skipped: true }),
    // The hardware tiering is genuinely measurable in a browser: the benchmark is plain JS, and
    // the core count is exposed. Memory is not (deviceMemory is Chrome-only and rounded), so it
    // is assumed generous rather than guessed low, which would misreport the tier as weak.
    machineProfile: async () => {
      const cores = navigator.hardwareConcurrency || 4
      const memGB = (navigator as unknown as { deviceMemory?: number }).deviceMemory || 16
      const specs = { cores, memGB, hwEncoder: false, benchMs: benchmark() }
      const { tier, reasons } = classify(specs)
      return { specs, cpu: 'browser preview', detected: tier, reasons, profile: profileFor(tier) }
    },
    // Search is plain HTTPS, but a browser cannot call either provider directly (CORS), and the
    // download has to land in the user's sound folder, which only the desktop app has.
    sfxSearch: async () => ({ error: 'Searching the sound libraries needs the desktop app (npm run dev)' }),
    sfxDownload: async () => ({ error: 'Saving a sound needs the desktop app (npm run dev)' }),
    sfxRender: async () => ({ error: 'Rendering a sound effect needs the desktop app (npm run dev)' }),
    sfxRecipes: async () => ({ recipes: [] }),
    findAudioCpp: async () => ({ exe: null, model: null, command: null, note: 'Searching your disk needs the desktop app (npm run dev)' }),
    // matching is pure, so the browser preview can do it for real; only the render needs Electron
    sfxPlan: async ({ text, seed }: { text: string; seed?: number }) => {
      const m = matchRecipe(text || '', { seed })
      return { ...m, canMake: !!m.recipe && m.confidence >= MIN_CONFIDENCE }
    },
    visualIndex: async () => ({ error: 'Looking through the video needs the desktop app (npm run dev)' }),
    scanBroll: async () => ({ error: 'Scanning b-roll needs the desktop app (npm run dev)' }),
    labelBroll: async () => ({ error: 'Labelling b-roll needs the desktop app (npm run dev)' }),
    refineCut: async ({ t }: { t: number }) => ({ t, refined: t, moved: 0, note: 'waveform snapping needs the desktop app' }),
    planFraming: async () => ({ error: 'Framing analysis needs the desktop app (npm run dev)' }),
    voiceClone: async () => ({ error: 'Narration needs the desktop app (npm run dev)' }),
    pickModel: async () => null,
    extractModel: async () => ({ error: 'Reading models needs the desktop app (npm run dev)' }),
    save3DRender: async () => ({ error: '3D rendering needs the desktop app (npm run dev)' }),
    save3DStill: async () => ({ error: '3D rendering needs the desktop app (npm run dev)' }),
    saveObjFile: async () => ({ error: 'Saving needs the desktop app' }),
    voiceCloneSetup: async () => ({ error: 'Voice setup needs the desktop app (npm run dev)' }),
    voiceCppSetup: async () => ({ error: 'Voice setup needs the desktop app (npm run dev)' }),
    sfxGenerate: async () => ({ error: 'SFX generation needs the desktop app (npm run dev)' }),
    pickFile: async () => null,
    pickFolder: async () => null,
    listProjects: async () => ({ error: 'Project folders need the desktop app (npm run dev)' }),
    scanProject: async () => ({ error: 'Project folders need the desktop app (npm run dev)' }),
    createProject: async () => ({ error: 'Project folders need the desktop app (npm run dev)' }),
    saveProjectTo: async () => ({ error: 'Project folders need the desktop app (npm run dev)' }),
    revealFolder: async () => {},
    analysisPath: async () => 'mock://analysis.mp4',
    windowDragStart: () => {}, windowDragEnd: () => {}, windowToggleMaximize: () => {},
    agentStatus: async () => ({
      appVersion: 'web', port: 5959, portOverridden: false,
      bridge: { listening: false, error: 'The agent bridge needs the desktop app (npm run dev)' },
      loopback: { ok: false, detail: 'desktop app only' },
      mcpFile: { ok: false, path: '<repo>/agent/mcp-server.mjs' },
      node: { ok: false },
    }),
  } as unknown as Window['ipcRenderer']
}
