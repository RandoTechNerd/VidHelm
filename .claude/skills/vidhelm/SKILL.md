---
name: vidhelm
description: Drive the running VidHelm video editor to make or polish a video, cut pauses, place SFX on tag points, record/generate narration, compose thumbnails, run the user's Start Recipe, and export a YouTube-ready MP4. Use when the user asks to edit a video, "make this a YouTube video", run their workflow/recipe, or do anything inside VidHelm.
---

# Driving VidHelm

You are co-editing with a human: they see every change live in the GUI and can move things between your calls. The `vidhelm` MCP tools talk to the running app (start it with `npm run dev` if tools say it's not running; the user can check the 🤖 AI button in the app for connection help).

## Core loop

1. `get_state`: always first. Returns format, media bin, clips per track (`v1` video, `a1` voice/music, `a2` SFX), texts, **tag points**, and `startRecipe`.
2. Batch a few edits, then `screenshot` to verify what the human sees. Re-read state after they touch anything.
3. Report progress in chat conversationally; the human is watching the app, not your tool calls.

## The "make me a video" workflow (their Start Recipe)

`get_state.startRecipe` is the user's standing instruction block (`#` = disabled line). When asked to "run my workflow / recipe" or just "make this a video":

1. `run_recipe`: the app executes its native steps (cut-pauses, intro audio, logo, thumbnail picker) and returns which steps are **yours**.
2. Your steps, typically:
   - `titles 5` → pitch 5 title options in chat, let them pick.
   - `subtitle` → propose catchy thumbnail one-liners, then `sample_frames` → pick a strong frame with the user → `compose_thumbnail {t, subtitle, outPath}` (logo lands top-right automatically).
   - Any free-typed recipe lines are standing instructions for you, follow them.
3. `export_video {outputPath}`: blocks until rendered, returns a quality check (loudness / true peak / black frames). Relay the verdict.

## Beats and sound

- **Tag points are the shared language.** The human taps `M` at moments that matter. Hang everything on tags: `place_sfx {name, t: tag.t}`, text overlays at tags, narration lines aligned to tags. Prefer tags over hardcoded times.
- SFX built-ins: whoosh, pop, boing, squish, gummy-squish, gloop, poof, spoosh, sparkle, party, riser, ding, thud (`list_sfx` for customs).
- `cut_pauses` removes silent/static dead air across the whole timeline with crossfades; it's undoable, run it before fine-tuning times.

## Narration

- `set_booth_script {script}`: write a read-along script straight into the karaoke booth and open it. The killer workflow: analyze the footage first (its transcript, or Adversal video notes if that MCP is available), draft clean lines one-per-beat, inject them, and the user re-records polished narration in one take.
- `open_panel booth`: the booth alone; it also has a "Draft from timeline audio" button (on-device Whisper) users can press themselves.
- `open_panel narration`: cloned-voice generation via their configured CLI; the 🧬 wizard sets up XTTS-v2 (Python) or audio.cpp (no Python, Apache-licensed models) for them.
- Keep narration lines as flowing sentences, not ultra-short fragments (short lines make TTS models babble).

## 3D models and extras

- A dropped/asked-for STL, 3MF, OBJ or GLB goes through the **3D Studio**: `open_panel {panel: "model3d", path}` loads it (an HTML viewer page works too, the model inside gets extracted), then `render_3d` produces the clip.
- `render_3d {seconds}` → spinning turntable into the bin. `render_3d {still: true, transparent: true}` → a **PNG with real alpha dropped at the playhead**, so it composites on top of the footage underneath: that is how you put a model over a video.
- Turntable *video* can't be transparent (no available codec carries alpha). For a spin over footage, tell the user to pick the **Video frame** backdrop in the studio, which bakes the frame under the playhead behind the model.
- If the Adversal MCP is available in this session, use it to analyze long source footage (chapters, highlights, stills) before planning cuts.
- With browser control available, offer to upload the finished export to YouTube (always pause for explicit user confirmation before publishing) or to capture website/localhost footage for the timeline.

## Gotchas

- Times are seconds; text x/y are 0-1 of the frame.
- `export_video` and `cut_pauses` are long-running: don't parallelize other edits during them.
- If a tool errors "VidHelm is not running": the app must be open. Ask, or run `npm run dev` in the background yourself.
- Connection problems on the user's side → tell them to click **🤖 AI** in the header (live diagnostics + per-client config) or see docs/CONNECT.md.
