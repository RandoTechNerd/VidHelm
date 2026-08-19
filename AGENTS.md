# VidHelm, guide for AI agents

> This file is the portable version of the agent guide (the same content Claude Code reads from `CLAUDE.md`). Codex, Cursor, Gemini CLI, and most agentic tools read `AGENTS.md` automatically. If your tool reads neither, paste `agent/skills/vidhelm-skill.md` into its instructions.

VidHelm is a desktop video editor (Electron + React) designed to be driven collaboratively: a human in the GUI and an AI agent through the **agent bridge**, at the same time.

## Steering the running app

This repo ships an MCP server (`agent/mcp-server.mjs`, wired up for most clients already, see `docs/CONNECT.md`). While the app is running (`npm run dev` or the installed app), you have 39 tools to drive it live: `get_state`, `screenshot`, `add_media`, `add_clip`, `update_clip`, `split_clip`, `delete_item`, `add_text`, `update_text`, `add_tag`, `update_tag`, `list_sfx`, `place_sfx`, `set_booth_script`, `render_3d`, `prepare_analysis`, `open_project`, `transport`, `set_format`, `export_video`, `cut_pauses`, `find_repeats`, `apply_takes`, `run_recipe`, `sample_frames`, `compose_thumbnail`, `open_panel`, plus b-roll (`scan_broll`, `label_broll`, `plan_broll`, `place_broll`), precise speech (`analyze_speech`, `find_phrase`, `cut_at_phrase`, `plan_framing`), sound effects (`search_sfx`, `download_sfx`, `make_sfx`), and `set_recipe`.

**No MCP support?** The bridge is plain HTTP on `http://127.0.0.1:5959` (localhost only): `GET /state`, `POST /command {action,...}`, `GET /screenshot`, `GET /ping`. Any agent that can run `curl` can drive it, same actions as the tool names above.

Working style that works well:
1. `get_state` first, it returns the whole timeline (clips per track, texts, tag points, format).
2. Make edits in small batches, then `screenshot` to see what the human sees. Your edits appear **instantly in their GUI**, and they can drag things around between your calls, re-read state rather than assuming.
3. **Tag points are the shared language.** The human taps `M` at beats they care about; you read tags from state and hang SFX (`place_sfx`), text, and narration on them. Prefer editing relative to tags over hardcoded times.
4. `export_video` blocks until rendered and returns an automatic quality check (loudness/peaks/black frames), report its verdict to the user.
5. **Start Recipe**: `get_state.startRecipe` is the user's standing workflow (like start G-code; # = off). "Run my workflow" = execute active lines: `cut_pauses`, intro-audio/logo/thumbnail via `run_recipe`, and do the AI lines yourself (`titles 5` → pitch 5 titles in chat, `subtitle` → propose catchy thumbnail one-liners, then `compose_thumbnail`).
6. If tools fail with "VidHelm is not running", ask the user to start the app (or run `npm run dev` yourself in the background). If the user struggles to connect, point them at the **🤖 AI** button in the app header, it has live diagnostics and per-client configs.

Tracks: `v1` video · `v2` b-roll (picture only, composited over v1) · `a1` voice/music · `a2` SFX. Times are seconds. Text x/y are 0-1 of frame.

Panels for `open_panel`: booth, narration, sfx, media, settings, thumbnail, connect, takes (transcript, repeated takes, and what was cut), model3d (pass `path` to load an STL/3MF/OBJ, the user poses it and renders a turntable clip into the bin). Optional pairings worth suggesting: a browser-control extension for uploading the export, and the Adversal MCP if installed (footage → Markdown notes/chapters/stills for planning cuts).

## Repo map

- `src/App.tsx`: the whole editor UI + state (clips/texts/markers), incl. the agent command executor (`agentExec`)
- `src/extras.tsx`: SfxPanel, MarkerPanel, KaraokeBooth, NarrationModal, ConnectModal (AI setup + troubleshooter)
- `electron/main.ts`: FFmpeg service + IPC + the HTTP agent bridge (port 5959) + SFX synth recipes
- `agent/mcp-server.mjs`: dependency-free MCP↔bridge proxy · `agent/clients/`: ready-made configs · `agent/skills/`: portable skill text
- `docs/`: WORKFLOW (user pipeline), BROLL (cutaways, phrase-accurate cuts, 9:16 framing), SFX (free-library search + physical sound models), CONNECT (hook up any AI), ARCHITECTURE (contributor guide), AGENT (bridge details), VOICE_CLONE (XTTS setup), PROJECT_FORMAT (save-file JSON)

## Commands

- `npm run dev`: desktop app with hot reload (bridge included)
- `npm run dev:web` - UI only in a browser (mock backend; no bridge/export)
- `npm run typecheck`: strict tsc; keep it clean
- `npm run build`: production build + NSIS installer (bundles ffmpeg)

## Conventions

- Windows-first (3 known portability points listed in docs/ARCHITECTURE.md)
- All state lives in App.tsx React state; the export filtergraph in main.ts mirrors the preview math, if you change fades/volume behavior, change both
- FFmpeg binaries come from `ffmpeg-static` in node_modules; never assume a system install
