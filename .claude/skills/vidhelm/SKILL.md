---
name: vidhelm
description: Drive the running VidHelm video editor to make or polish a video — cut pauses, place SFX on tag points, record/generate narration, compose thumbnails, run the user's Start Recipe, and export a YouTube-ready MP4. Use when the user asks to edit a video, "make this a YouTube video", run their workflow/recipe, or do anything inside VidHelm.
---

# Driving VidHelm

You are co-editing with a human: they see every change live in the GUI and can move things between your calls. The `vidhelm` MCP tools talk to the running app (start it with `npm run dev` if tools say it's not running; the user can check the 🤖 AI button in the app for connection help).

## Core loop

1. `get_state` — always first. Returns format, media bin, clips per track (`v1` video, `a1` voice/music, `a2` SFX), texts, **tag points**, and `startRecipe`.
2. Batch a few edits, then `screenshot` to verify what the human sees. Re-read state after they touch anything.
3. Report progress in chat conversationally; the human is watching the app, not your tool calls.

## The "make me a video" workflow (their Start Recipe)

`get_state.startRecipe` is the user's standing instruction block (`#` = disabled line). When asked to "run my workflow / recipe" or just "make this a video":

1. `run_recipe` — the app executes its native steps (cut-pauses, intro audio, logo, thumbnail picker) and returns which steps are **yours**.
2. Your steps, typically:
   - `titles 5` → pitch 5 title options in chat, let them pick.
   - `subtitle` → propose catchy thumbnail one-liners, then `sample_frames` → pick a strong frame with the user → `compose_thumbnail {t, subtitle, outPath}` (logo lands top-right automatically).
   - Any free-typed recipe lines are standing instructions for you — follow them.
3. `export_video {outputPath}` — blocks until rendered, returns a quality check (loudness / true peak / black frames). Relay the verdict.

## Beats and sound

- **Tag points are the shared language.** The human taps `M` at moments that matter. Hang everything on tags: `place_sfx {name, t: tag.t}`, text overlays at tags, narration lines aligned to tags. Prefer tags over hardcoded times.
- SFX built-ins: whoosh, pop, boing, squish, gummy-squish, gloop, poof, spoosh, sparkle, party, riser, ding, thud (`list_sfx` for customs).
- `cut_pauses` removes silent/static dead air across the whole timeline with crossfades; it's undoable, run it before fine-tuning times.

## Narration

- `open_panel booth` — the karaoke booth: the user records one read-along take, lines timed to their tags.
- `open_panel narration` — cloned-voice generation via their configured CLI (see docs/VOICE_CLONE.md); generated lines auto-place at tags.
- Keep narration lines as flowing sentences, not ultra-short fragments (short lines make TTS models babble).

## Gotchas

- Times are seconds; text x/y are 0–1 of the frame.
- `export_video` and `cut_pauses` are long-running — don't parallelize other edits during them.
- If a tool errors "VidHelm is not running": the app must be open. Ask, or run `npm run dev` in the background yourself.
- Connection problems on the user's side → tell them to click **🤖 AI** in the header (live diagnostics + per-client config) or see docs/CONNECT.md.
