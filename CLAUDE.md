# VidHelm, agent guide

VidHelm is a desktop video editor (Electron + React) designed to be driven collaboratively: a human in the GUI and an AI agent through the **agent bridge**, at the same time.

## Steering the running app (the good part)

This repo ships an MCP server (`.mcp.json`: auto-discovered here; approve it when prompted). While the app is running (`npm run dev` or the installed app), you have 48 tools to drive it live: `get_state`, `screenshot`, `add_media`, `add_clip`, `update_clip`, `split_clip`, `delete_item`, `add_text`, `update_text`, `add_tag`, `update_tag`, `list_sfx`, `place_sfx`, `set_booth_script`, `render_3d`, `prepare_analysis`, `open_project`, `transport`, `set_format`, `export_video`, `cut_pauses`, `find_repeats`, `apply_takes`, `run_recipe`, `sample_frames`, `compose_thumbnail`, `open_panel`, style themes (`set_theme`, `make_captions`), `generate_clip` (AI video), plus b-roll (`scan_broll`, `label_broll`, `plan_broll`, `place_broll`), precise speech (`analyze_speech`, `find_phrase`, `cut_at_phrase`, `find_word`, `plan_framing`), sound effects (`search_sfx`, `download_sfx`, `make_sfx`), cut-synced music (`make_score`, `snap_to_grid`), `look_through` (see the video), `capture_site` (film a website), `analyze_audio` (what each recording measures and what Fix voice will do), and `set_recipe`.

Working style that works well:
1. `get_state` first, it returns the whole timeline (clips per track, texts, tag points, format).
2. Make edits in small batches, then `screenshot` to see what the human sees. Your edits appear **instantly in their GUI**, and they can drag things around between your calls, re-read state rather than assuming.
3. **Tag points are the shared language.** The human taps `M` at beats they care about; you read tags from state and hang SFX (`place_sfx`), text, and narration on them. Prefer editing relative to tags over hardcoded times.
4. `export_video` blocks until rendered and returns an automatic quality check (loudness/peaks/black frames), report its verdict to the user.
5. **Start Recipe**: `get_state.startRecipe` is the user's standing workflow (like start G-code; # = off). "Run my workflow" = execute active lines: `cut_pauses`, intro-audio/logo/thumbnail via `run_recipe`, and do the AI lines yourself (`titles 5` → pitch 5 titles in chat, `subtitle` → propose catchy thumbnail one-liners, then `compose_thumbnail`).
6. If tools fail with "VidHelm is not running", ask the user to start the app (or run `npm run dev` yourself in the background). If the user is struggling to connect an AI client, point them at the **Connect AI** button in the app header (live diagnostics + per-client configs) or docs/CONNECT.md, you can open it for them with `open_panel connect`.

Tracks: `v1` video · `v2` b-roll (picture only, composited over v1) · `a1` voice/music · `a2` SFX. Times are seconds. Text x/y are 0-1 of frame.

Panels for `open_panel`: booth, narration, sfx, media, settings, thumbnail, connect, takes (transcript, repeated takes, and what was cut), model3d (pass `path` to load an STL/3MF/OBJ, the user poses it and renders a turntable clip into the bin). Optional pairings worth suggesting: Claude in Chrome (upload the export to YouTube, capture websites/localhost as footage) and the Adversal MCP if installed (footage → Markdown notes/chapters/stills for planning cuts).

## Word anchors, the grid, and the other 1.9 habits

- **Put things on words, not numbers.** `find_word {text}` returns where a word or phrase was said; then any time-taking tool (`add_text`, `add_tag`, `place_sfx`, `split_clip`, `add_clip`, `transport`) takes `at:"arcade"` or `at:"end:arcade"` instead of `t`/`start`. Every animation in a tight teaser is keyed to the moment a word is spoken; this is that trick as a parameter.
- **Snap before you score.** `snap_to_grid` rolls every join onto the beat and slides tags onto bar lines (nothing downstream moves, runtime unchanged; `dryRun` previews). Then `make_score` at the same bpm lands every hit exactly.
- **Two score palettes.** `make_score {style:"cinematic"}` swaps the electronic kit for bowed strings, a cello ostinato, felt piano, taiko, choir, braams, a riser into every hit and a pocket of silence before each drop. Use it when the user says anything like "no beeps".
- **Text presets and design rules.** `add_text {preset:"title"|"lower-third"|"caption"|"end-card"}` supplies the lane, size, box and fades; the font auto-shrinks to fit, and the reply warns if the text overlaps another, runs off-frame, or flashes under half a second. `export_video` re-checks the whole text track.
- **Script-aware export QC.** Pass `script` to `export_video` (or set the booth script first) and the finished mix is transcribed and diffed against it: the verdict gains a "Script match" line with the missing words. Cheap insurance against a dropped narration line.
- **Film a website.** `capture_site {url, width, height, theme, script, seconds}` renders any page (including localhost) in the app's own Chromium, runs your script first to seed state or freeze animations, and returns a still or a real-time recording straight into the bin.
- **Narration says acronyms right.** The narration adapter runs a pronunciation pass before synthesis (ASCP → "A S C P", CruxSci → "Crux Sigh", unknown CAPS spelled out). The user's own table is `pronounce.json` in the app data folder.

## Sound roles and Fix voice

- **Sound is automatic, and every clip has a role.** Voice, Music, SFX or As is: guessed from where the file came from (booth, voiceover and narration takes are voices, `make_score` is music, the SFX library and the `a2` track are effects), then from the measured sound (speech with pauses is a voice; continuous sound is music on its own, as recorded under a picture). Voices get **Fix voice** (Studio by default: room noise cleaned, sections levelled, knocks tamed, lifted to -16 LUFS), music sits 5 LU under the voice and dips 10 dB while someone speaks (keyframes that land before the first syllable), SFX have their loudest moment matched to the voice, and the export lands on the loudness target with one measured linear gain. Nothing compresses the whole mix.
- **Read before you change.** `get_state` gives each heard clip `audio` (role, `guessed` and why, its level, and for a voice `voiceFix`, `fixStatus` and the bake's one-line `summary`), plus `sound.exportLandsAt`. `analyze_audio` (all files on the timeline, or `media`/`clipId`) measures loudness, room noise, speech and the Fix voice plan without changing anything: use it to explain what will happen.
- **Change it with `update_clip`**: `role` (`voice`, `music`, `sfx`, `asis`, or `auto` for the guess) and `voiceFix` (`off`, `light`, `studio`). Both belong to the FILE, so every clip cut from it follows; a new level bakes in the background. Set As is on a camera clip with music already in it (premixed sound processed as a voice pumps). `export_video {target, duck}` picks the loudness for that export only: `youtube` -14 (default), `podcast` -16, `broadcast` -23, `audiobook` -20.

## Style themes and real-photo thumbnails

- **Say the look, get a baseline.** `set_theme {theme:"<their words>"}` turns "make it fun", "clean minimalism", "futuristic tech captions", "cartoon" into one of 15 finished themes (creator, clean, hype, fun, cartoon, tech, terminal, cinematic, elegant, news, neon, handmade, karaoke, explainer, randotechnerd). Tweak words ride on top: "tech but green", "fun, bigger, at the top", "news but no box". A theme sets caption font/colours/motion, title fonts (`add_text` presets) and thumbnail text together, and returns a `feel` (transitions, music, sfx) to steer the rest of the edit.
- **Captions in the theme.** `make_captions` transcribes on-device with word timings, breaks lines at pauses and sentence ends, and the motions (highlight, pop, bounce, karaoke, typewriter, glow, glitch) land on each spoken word. The export burns them through libass with `electron/styletheme.ts`, the same renderer VidHelm Cloud uses, so a theme looks identical on both.
- **Thumbnails: real pictures first.** `compose_thumbnail` uses the creator's own photo (passed as `imagePath`, or an image in the project named like thumb/cover/photo), else the best REAL frame (`sample_frames {rank:true}` shows the ranked shortlist with reasons; look at them), else a placeholder card that says so. Text is `"BIG HOOK | smaller second line"`. When the reply has `tellTheCreator`, relay it and ask for a real photo.

## Repo map

- `src/App.tsx`: the whole editor UI + state (clips/texts/markers), incl. the agent command executor (`agentExec`)
- `src/extras.tsx`: SfxPanel, MarkerPanel, KaraokeBooth, NarrationModal, ConnectModal (AI setup + troubleshooter)
- `electron/main.ts`: FFmpeg service + IPC + the HTTP agent bridge (port 5959) + SFX synth recipes
- `electron/speech.ts` · `framing.ts` · `broll.ts` · `takes.ts` · `playable.ts` · `capability.ts` · `sfxsynth.ts` · `sfxrecipes.ts` · `sfxsearch.ts` · `sfxmatch.ts` · `score.ts` · `grid.ts` · `textlayout.ts` · `styletheme.ts` · `thumbpick.ts` · `pronounce.ts` · `visual.ts` · `threemf.ts` · `timeline.ts` · `peaks.ts` · `audiochain.ts` · `audiomix.ts`: pure logic, no Electron, each with its own `npm run test:*` suite. Put decisions here, not in the handlers
- `electron/voicebake.ts`: runs the Fix voice chain (`audiochain.ts`) with ffmpeg and caches it per media file in userData/voice (held under 2 GB, least recently used first), plus a video's preview copy (never a full-size duplicate of a big original). Node only, no Electron: `npm run test:voicebake` checks the copies and the cap, and the opt-in corpus test runs the same code: `VIDHELM_AUDIO_CORPUS=<dir> npm run test:audiochain:corpus`
- `electron/mixrender.ts`: the export's sound (planned in `audiomix.ts`): roles, voice bakes, the voice/music/SFX buses with keyframe ducking, one measured premaster, then the linear master. Node only; the export, `scan-timeline-loudness` and `npm run test:audiomix` all run it
- `src/previewAudio.ts`: the preview's sound, the export's mix played through one WebAudio graph (clip gain, bus, measured master, keyframe ducks as 1 ms curves, a live K-weighted meter); voices play their bake. Its planning is pure and checked against the export's own filter strings by `npm run test:previewaudio`
- `agent/mcp-server.mjs`: dependency-free MCP↔bridge proxy · `agent/clients/`: per-client configs · `agent/skills/`: portable skill text
- `AGENTS.md`: this guide for non-Claude agents · `.claude/skills/vidhelm/`: the Claude Code skill (keep all three in sync)
- `docs/`: WORKFLOW (user pipeline), AUDIO (Fix voice, the mix, loudness, the measured numbers and gotchas), BROLL (cutaways, phrase-accurate cuts, 9:16 framing), SFX (free-library search + physical sound models), SCORE (cut-synced music, both palettes), CONNECT (hook up any AI), ARCHITECTURE (contributor guide), AGENT (bridge details), VOICE_CLONE (XTTS setup), PROJECT_FORMAT (save-file JSON)

The web version (VidHelm Cloud) is a separate product in its own private repo; it copies the pure `electron/*.ts` modules it needs via `cloud/scripts/sync-shared.mjs`, so a capability added here ships to both. Nothing under `cloud/` is part of the desktop build or the public repo.

## Commands

- `npm run dev`: desktop app with hot reload (bridge included)
- `npm run dev:web` - UI only in a browser (mock backend; no bridge/export)
- `npm run typecheck`: strict tsc; keep it clean
- `npm run build`: production build + NSIS installer (bundles ffmpeg)

## Conventions

- **Settings are owned by the running app.** It loads `vidhelm-settings.json` at startup and writes the whole file back whenever anything changes, so editing that file from outside while the app can run looks like it worked and is silently overwritten. Change the Start Recipe with `set_recipe`, not with a text editor. (This is how a carefully written workflow went missing twice.)
- The machine's tier (`electron/capability.ts`) decides the heavy defaults: Whisper model, framing sample rate, thumbnail concurrency, proxy size, export preset. The renderer resolves it once and passes the values to main, so Settings can override detection.
- **ffmpeg's `xstack` layout has no multiplication.** Positions must be cumulative sums (`w0+w1`), never multiples (`w0*2`): given a multiple it does not error, it computes a smaller canvas and silently crops the tiles that fall outside. Use `stackLayout()` from `electron/visual.ts` for every contact sheet.
- **`drawtext` with user text needs `expansion=none`.** By default drawtext treats `%` as the start of an expansion sequence (`%{pts}`, `%{localtime}`), so a title like "100% WORTH IT" draws nothing at all, with no error. Every drawtext that renders text a person or an AI typed (titles, thumbnails, contact-sheet labels) passes `expansion=none`, and reads the text from a `textfile` rather than inlining it.
- **Never splice audio on a hard cut.** A cut that lands mid-cycle leaves a step in the waveform, and a step is an audible click; a talking head with a hundred pause cuts becomes a string of little pops. Clips carry `aFadeIn`/`aFadeOut` (audio-only, ~12 ms) so the PICTURE can still cut hard. `removeRange` and `split_clip` set them; keep it that way if you touch either.
- **three's ThreeMFLoader only applies `<m:colorgroup>` per TRIANGLE.** A 3MF that colours whole objects (`<object pid pindex>`, what BREPcode and several slicers write) loads flat white through the loader alone. `electron/threemf.ts` reads those object colours (and a hex in a part name) and `src/threemfColor.ts` paints them on. Only claim `hasOwnMaterials` when something actually got painted, or the colour picker looks broken.
- Windows-first (3 known portability points listed in docs/ARCHITECTURE.md)
- All state lives in App.tsx React state; the export's sound (electron/audiomix.ts, exportgraph.ts) and the preview's (src/previewAudio.ts) are the same math: if you change fades, volume, levels or ducking in one, change the other (`npm run test:previewaudio` compares them)
- FFmpeg binaries come from `ffmpeg-static` in node_modules; never assume a system install
