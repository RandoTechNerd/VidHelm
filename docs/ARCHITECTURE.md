# RandoSnap architecture

For contributors. TL;DR: a React single-page renderer that owns *all* editing state, an Electron main process that is a thin FFmpeg/FS service, and one IPC bridge between them.

```
┌───────────────────────────── renderer (Chromium) ─────────────────────────────┐
│  src/App.tsx        the editor: media bin, timeline, preview, panels, export  │
│  src/extras.tsx     SfxPanel · MarkerPanel · KaraokeBooth · NarrationModal    │
│  src/ipcMock.ts     browser fallback bridge (npm run dev:web)                 │
└──────────────────────────────┬────────────────────────────────────────────────┘
                    window.ipcRenderer (electron/preload.ts, contextBridge)
┌──────────────────────────────┴────────────────────────────────────────────────┐
│  electron/main.ts   IPC handlers: metadata, thumbnails, export, silence/      │
│                     freeze detection, Whisper transcribe, QC, SFX synth,      │
│                     voice-clone runner, settings/projects persistence         │
│  binaries           ffmpeg-static + ffprobe-static (npm), no system install   │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Renderer model

All editing state lives in `App.tsx` React state — no store library:

- `MediaFile[]` — the bin (id, path, type, duration, hasVideo/hasAudio)
- `TimelineClip[]` — clips with `trackId: 'v1' | 'a1' | 'a2'` (video · voice/music · SFX), `start`, `duration`, `sourceStart`, volume + `volumePoints` automation, fades
- `TextClip[]` — overlay text cues (position is 0..1 relative to frame)
- `Marker[]` — tag points `{ t, label, color }` (see `extras.tsx`)
- `AppSettings` — brand kit, intro defaults, audio, captions, silence detection, narration command; persisted via `get/set-settings` IPC

**Preview playback** is DOM-based: a rAF clock advances `currentTime`; `<video>` elements for active video clips and hidden `Audio` elements for `a1`/`a2` clips are seeked/played to follow the clock, with per-frame gain from `gainAt()` (automation) × fades × master. The preview intentionally mirrors the export math (`fadeFactor`, `gainAt` ↔ `volumeExpr`, `alphaExpr` in main.ts).

**Undo/redo**: debounced JSON snapshots of `{clips, texts}` (~450 ms coalescing) with a 100-step ring.

## Export pipeline (`export-video` handler)

One FFmpeg process, one filtergraph:

1. Base layers: `color=black` video + `anullsrc` audio at target size/fps/48 kHz.
2. Every clip becomes an input; video clips are scaled/padded into frame with alpha, shifted by `setpts`, alpha-faded, then chained through `overlay` (so overlapping fades crossfade for real).
3. Audio clips get `adelay` + volume (flat or piecewise-linear automation expression) + `afade`, then a single `amix` with `normalize=0`.
4. Texts are `drawtext` (textfile-based, so quoting is safe) with alpha expressions.
5. Brand logo is a final overlay with its own window/fade logic.
6. Mastering: optional FFT denoise → master gain → `acompressor` + `loudnorm` (YouTube target) or a plain safety limiter.
7. x264 High profile, closed 2 s GOP, BT.709 tags, `+faststart`.

Progress streams to the renderer; a **quality check** pass (`quality-check`) then measures loudness/true peak, scans for black frames, and samples stills.

## The new subsystems (v1.0)

- **SFX library** (`sfx-library`): 13 effects defined as pure FFmpeg `lavfi` filtergraphs in `SFX_RECIPES`, rendered to `userData/sfx/*.wav` on first request (no downloads, no licensing). `userData/sfx/custom/` is scanned for user files. The renderer treats results as ordinary audio media placed on track `a2`.
- **Karaoke booth** (`KaraokeBooth`): drives the app's own playback (`onSeek/onPlay`) while recording the mic via `MediaRecorder`; cue lines are indexed against tag points (or spread evenly). The take is saved through the existing `save-recording` handler and placed at 0:00 on `a1`.
- **Voice clone** (`voice-clone`): spawns a user-configured shell command with `{script}`/`{outdir}` substitution, streams output, then returns the sorted `.wav` list. Placement logic lives in the renderer (`narrationGenerated`). See `docs/VOICE_CLONE.md` for the contract.
- **Markers**: pure renderer state; rendered as draggable flags over the ruler, listed in `MarkerPanel`, included in project files (`version: 2`; older projects load fine — markers default to `[]`).

- **Agent bridge** (`main.ts` + `agent/mcp-server.mjs`): a localhost-only HTTP server (127.0.0.1:5959) forwards agent commands into the renderer over IPC (`agent-command` → executor in App.tsx → `agent-response`), so agent edits go through the same React state (and undo history) as human edits. The MCP server is a dependency-free stdio JSON-RPC proxy over that bridge; `.mcp.json` makes Claude Code pick it up automatically. `GET /screenshot` uses `webContents.capturePage`. Export via agent runs the normal export pipeline with an explicit output path and returns the quality-check summary. See `docs/AGENT.md`.

## Dev modes

- `npm run dev` — Vite + Electron via `vite-plugin-electron`; hot reload on both sides.
- `npm run dev:web` — renderer only in a browser; `src/ipcMock.ts` installs a stub bridge (SFX list is fake, export disabled). Use it for UI/CSS work and screenshots.
- `npm run typecheck` — strict `tsc -b` over renderer + main.

## Platform notes

Windows-first. The three Windows-isms, all in `electron/main.ts`:

1. `ffprobe-static` path uses `bin/win32/x64` — switch on `process.platform` to port.
2. `drawtext` uses `C:/Windows/Fonts/arial.ttf` — pick a platform font or bundle one.
3. Voice-clone commands run through the default shell (`cmd`).

Everything else (fluent-ffmpeg, Whisper via `@huggingface/transformers`, the renderer) is cross-platform already. PRs welcome.

## Repo hygiene

- `electron-builder` packages `ffmpeg.exe`/`ffprobe.exe` into resources for production builds.
- Whisper models download on first captions run (HF cache); they are not in the repo.
- Generated SFX live in `userData`, not the repo.
