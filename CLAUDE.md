# RandoSnap — agent guide

RandoSnap is a desktop video editor (Electron + React) designed to be driven collaboratively: a human in the GUI and an AI agent through the **agent bridge**, at the same time.

## Steering the running app (the good part)

This repo ships an MCP server (`.mcp.json` — auto-discovered here; approve it when prompted). While the app is running (`npm run dev` or the installed app), you have 21 tools to drive it live: `get_state`, `screenshot`, `add_media`, `add_clip`, `update_clip`, `split_clip`, `delete_item`, `add_text`, `update_text`, `add_tag`, `update_tag`, `list_sfx`, `place_sfx`, `transport`, `set_format`, `export_video`, `cut_pauses`, `run_recipe`, `sample_frames`, `compose_thumbnail`, `open_panel`.

Working style that works well:
1. `get_state` first — it returns the whole timeline (clips per track, texts, tag points, format).
2. Make edits in small batches, then `screenshot` to see what the human sees. Your edits appear **instantly in their GUI**, and they can drag things around between your calls — re-read state rather than assuming.
3. **Tag points are the shared language.** The human taps `M` at beats they care about; you read tags from state and hang SFX (`place_sfx`), text, and narration on them. Prefer editing relative to tags over hardcoded times.
4. `export_video` blocks until rendered and returns an automatic quality check (loudness/peaks/black frames) — report its verdict to the user.
5. **Start Recipe**: `get_state.startRecipe` is the user's standing workflow (like start G-code; # = off). "Run my workflow" = execute active lines: `cut_pauses`, intro-audio/logo/thumbnail via `run_recipe`, and do the AI lines yourself (`titles 5` → pitch 5 titles in chat, `subtitle` → propose catchy thumbnail one-liners, then `compose_thumbnail`).
6. If tools fail with "RandoSnap is not running", ask the user to start the app (or run `npm run dev` yourself in the background).

Tracks: `v1` video · `a1` voice/music · `a2` SFX. Times are seconds. Text x/y are 0–1 of frame.

## Repo map

- `src/App.tsx` — the whole editor UI + state (clips/texts/markers), incl. the agent command executor (`agentExec`)
- `src/extras.tsx` — SfxPanel, MarkerPanel, KaraokeBooth, NarrationModal
- `electron/main.ts` — FFmpeg service + IPC + the HTTP agent bridge (port 5959) + SFX synth recipes
- `agent/mcp-server.mjs` — dependency-free MCP↔bridge proxy
- `docs/` — WORKFLOW (user pipeline), ARCHITECTURE (contributor guide), AGENT (bridge details), VOICE_CLONE (XTTS setup), PROJECT_FORMAT (save-file JSON)

## Commands

- `npm run dev` — desktop app with hot reload (bridge included)
- `npm run dev:web` — UI only in a browser (mock backend; no bridge/export)
- `npm run typecheck` — strict tsc; keep it clean
- `npm run build` — production build + NSIS installer (bundles ffmpeg)

## Conventions

- Windows-first (3 known portability points listed in docs/ARCHITECTURE.md)
- All state lives in App.tsx React state; the export filtergraph in main.ts mirrors the preview math — if you change fades/volume behavior, change both
- FFmpeg binaries come from `ffmpeg-static` in node_modules; never assume a system install
