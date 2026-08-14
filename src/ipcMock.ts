// Browser fallback for the Electron bridge — lets `npm run dev:web` render the full UI in a plain
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
    getMetadata: async () => ({ duration: 5, hasVideo: false, hasAudio: true }),
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
  } as unknown as Window['ipcRenderer']
}
