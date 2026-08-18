# VidHelm architecture

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

All editing state lives in `App.tsx` React state, no store library:

- `MediaFile[]`: the bin (id, path, type, duration, hasVideo/hasAudio)
- `TimelineClip[]`: clips with `trackId: 'v1' | 'a1' | 'a2'` (video · voice/music · SFX), `start`, `duration`, `sourceStart`, volume + `volumePoints` automation, fades
- `TextClip[]`: overlay text cues (position is 0..1 relative to frame)
- `Marker[]`: tag points `{ t, label, color }` (see `extras.tsx`)
- `AppSettings`: brand kit, intro defaults, audio, captions, silence detection, narration command; persisted via `get/set-settings` IPC

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
- **Markers**: pure renderer state; rendered as draggable flags over the ruler, listed in `MarkerPanel`, included in project files (`version: 2`; older projects load fine, markers default to `[]`).

- **Agent bridge** (`main.ts` + `agent/mcp-server.mjs`): a localhost-only HTTP server (127.0.0.1:5959) forwards agent commands into the renderer over IPC (`agent-command` → executor in App.tsx → `agent-response`), so agent edits go through the same React state (and undo history) as human edits. The MCP server is a dependency-free stdio JSON-RPC proxy over that bridge; `.mcp.json` makes Claude Code pick it up automatically. `GET /screenshot` uses `webContents.capturePage`. Export via agent runs the normal export pipeline with an explicit output path and returns the quality-check summary. See `docs/AGENT.md`.

- **Window dragging** (`main.ts` + `electron/dragMath.ts`): the window has no OS title bar (`titleBarStyle: 'hidden'` + `titleBarOverlay`), so the header is the grab bar. Rather than `-webkit-app-region: drag` (which swallows mouse events and can't restore a maximized window under the cursor), the renderer sends `window-drag-start`/`-end` and the main process moves the window by polling `screen.getCursorScreenPoint()` every 16 ms. Dragging while maximized or full screen restores first and re-anchors the pointer proportionally along the header (`restoreDragOffset`); releasing within 6 px of the top of the work area maximizes (`shouldSnapMaximize`). Double-clicking the header toggles maximize. The geometry lives in `dragMath.ts` with no Electron imports so it can be tested standalone. Header children matching `HDR_CONTROLS` (buttons, inputs, …) never start a drag.

- **Media import** (`classifyMedia` in App.tsx): extension tables are only a hint - `get-metadata` (ffprobe) has the final say, so unusual-but-valid files import and broken ones are refused with a reason. Junk demuxers are filtered explicitly: ffprobe happily reads a `.txt` as an `ansi` video stream via the `tty` demuxer, which used to land on the timeline as a 0.04s clip. 3D models bypass the bin and open the 3D Studio; `.html` pages are scanned for a model first (`electron/modelSniff.ts`: sibling file reference, base64 payload, or inline model text; Electron-free so it can be tested standalone).
- **Chroma key**: a clip can carry `chromaKey` (a hex colour). The export inserts `colorkey` plus `despill` ahead of the usual scale-and-overlay chain, and the preview applies the matching SVG filter (`vh-key-green` / `vh-key-magenta`) so the stage shows what will render. Measured cost is roughly a second per six seconds of overlay at 1080p, negligible against the encode. This is how a spinning model sits over footage, since no available codec here carries alpha: the 3D Studio renders on a key colour (magenta when the model itself is green) and flags the result. Real green-screen footage works the same way through the media bin context menu.
- **3D Studio transparency**: stills render as PNGs with a real alpha channel and composite over footage (the export overlays every clip through `format=yuva420p`, and the preview stacks clips as absolutely-positioned layers, so an alpha clip added later sits on top). Turntable *video* cannot be transparent - Chromium's MediaRecorder flattens canvas alpha whatever the codec, and this FFmpeg build writes the WebM `ALPHA_MODE` tag but drops the channel. The **Video frame** backdrop is the workaround: it bakes the frame under the playhead behind the model.
- **Repeated takes** (`electron/takes.ts` + `src/takes.tsx`): the scan mixes the timeline audio, transcribes it with **word** timestamps, and rebuilds the lines itself (`chunksFromWords`) rather than trusting Whisper's segmentation, because Whisper packs a false start and its retake into one segment ("Say hello to VidHelm. Say hello to VidHelm, a free editor"), which is the commonest repeat there is. `findAdjacentRepeat` splits those lines where the speaker started over, then `groupTakes` pairs lines by word overlap (measured against the shorter, so an abandoned half-line matches the full one) or an in-order prefix run, within a lookahead and a time gap so a callback an hour later is not a retake. Cutting reuses `removeRange`, last→first, exactly like Cut Pauses. Choices stay changeable: the applied state keeps `before`/`after` snapshots in a ref, and a re-apply rebuilds from `before` **only** while the timeline still matches `after`, otherwise the transcript's timestamps would no longer line up. The detector is Electron-free and covered by `npm run test:takes` (40 assertions).
- **Preview proxies** (`electron/playable.ts`): the preview is a Chromium `<video>`, which is far pickier than FFmpeg. It cannot decode HEVC in this build, nor 10-bit anything, and HDR would render grey, so a perfectly valid phone recording imports fine and plays as a black rectangle. `planProxy` decides from the probe (codec, pix_fmt, colour transfer, frame size x rate) and `make-proxy` builds an H.264 8-bit SDR stand-in into `userData/proxies`, keyed by path+size+mtime so it converts once. Only the preview and the filmstrip use it; `path` stays the master for export, where `HDR_TO_SDR` is spliced into the clip's filter chain instead. Two traps: `ffmpeg -encoders` lists everything the binary was COMPILED with, so it advertises NVENC on an Intel laptop and the proxy dies on `nvcuda.dll` (encoders are now probed by actually encoding a frame), and tone mapping belongs AFTER the downscale, which measured a third faster on a 4K120 clip.
- **Splices crossfade, they do not blink** (`removeRange`): the two halves of a cut used to sit end to end, each with its own fade. Video composites over a black base, so fading A out and B in at the same instant dips through black, and a talking head with a hundred pause cuts blinks all the way through. The incoming clip now starts `overlap` seconds earlier with its `sourceStart` pulled back to match, and dissolves in on top of the outgoing one, which never sees black. Verified by exporting and measuring per-frame luminance: 420 frames, minimum 21.8, nothing under 10.
- **Agent command ids**: the renderer dedupes by `cmd.id` in a `window`-scoped set. StrictMode's double mount and dev hot reloads can leave more than one bridge listener registered, which otherwise applies each edit twice (two tags from a single `add_tag`).

## Dev modes

- `npm run dev`: Vite + Electron via `vite-plugin-electron`; hot reload on both sides.
- `npm run dev:web`: renderer only in a browser; `src/ipcMock.ts` installs a stub bridge (SFX list is fake, export disabled). Use it for UI/CSS work and screenshots.
- `npm run typecheck`: strict `tsc -b` over renderer + main.

## Platform notes

Windows-first. The three Windows-isms, all in `electron/main.ts`:

1. `ffprobe-static` path uses `bin/win32/x64`: switch on `process.platform` to port.
2. `drawtext` uses `C:/Windows/Fonts/arial.ttf`: pick a platform font or bundle one.
3. Voice-clone commands run through the default shell (`cmd`).

Everything else (fluent-ffmpeg, Whisper via `@huggingface/transformers`, the renderer) is cross-platform already. PRs welcome.

## Repo hygiene

- `electron-builder` packages `ffmpeg.exe`/`ffprobe.exe` into resources for production builds.
- Whisper models download on first captions run (HF cache); they are not in the repo.
- Generated SFX live in `userData`, not the repo.
