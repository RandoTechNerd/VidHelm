import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'

// `npm run dev`      → full desktop app (Vite + Electron)
// `npm run dev:web`  → renderer only in a plain browser (UI work; uses the IPC mock)
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'web'
    ? [react()]
    : [
        react(),
        electron([
          {
            // Main-Process entry file of the Electron App.
            entry: 'electron/main.ts',
            vite: {
              build: {
                rollupOptions: {
                  // Keep the native ASR deps as runtime requires (don't bundle them)
                  external: ['@huggingface/transformers', 'onnxruntime-node'],
                },
              },
            },
          },
          {
            entry: 'electron/preload.ts',
            onstart(options) {
              // Reload the page when the preload build completes instead of restarting Electron.
              options.reload()
            },
          },
        ]),
        renderer(),
      ],
}))
