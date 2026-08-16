// Browser fallback for the Electron bridge, lets `npm run dev:web` render the full UI in a plain
// browser for UI work and screenshots. Media import/export need real Electron; everything visual
// (timeline, tag points, SFX list, booth, panels) works against this mock.
const demoSfx = ['whoosh', 'pop', 'boing', 'squish', 'gummy-squish', 'gloop', 'poof', 'spoosh', 'sparkle', 'party', 'riser', 'ding', 'thud']

export function installIpcMock() {
  if (window.ipcRenderer) return
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
    openSfxFolder: async () => {},
    openExternal: async (url: string) => { window.open(url, "_blank") },
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
