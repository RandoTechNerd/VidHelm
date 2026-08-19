---
name: vidhelm
description: Drive the running VidHelm video editor to make or polish a video, cut pauses, place SFX on tag points, record/generate narration, compose thumbnails, run the user's Start Recipe, and export a YouTube-ready MP4. Use when the user asks to edit a video, "make this a YouTube video", run their workflow/recipe, or do anything inside VidHelm.
---

# Driving VidHelm

You are co-editing with a human: they see every change live in the GUI and can move things between your calls. The `vidhelm` MCP tools talk to the running app (start it with `npm run dev` if tools say it's not running; the user can check the 🤖 AI button in the app for connection help).

## Core loop

1. `get_state`: always first. Returns format, media bin, clips per track (`v1` video, `v2` b-roll, `a1` voice/music, `a2` SFX), texts, **tag points**, and `startRecipe`.
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

- `find_repeats` / `apply_takes`: for footage where the person said a line two or three times over. `find_repeats` reads the timeline's speech on-device, splits merged Whisper segments where the speaker started again, and hands back each repeated spot with every attempt's words and timing plus the default pick (longest, finished, fewest fillers, later on a tie). It cuts nothing. Read the takes, decide which one is actually best, then `apply_takes { keep: "0:2, 1:0" }` (group:member pairs) plus `drop: "7"` for a flub with no retake. Rippling and undo are handled. The human sees the same list in the Takes & history panel, so say which take you kept and why.
- `set_booth_script {script}`: write a read-along script straight into the karaoke booth and open it. The killer workflow: analyze the footage first (its transcript, or Adversal video notes if that MCP is available), draft clean lines one-per-beat, inject them, and the user re-records polished narration in one take.
- `open_panel booth`: the booth alone; it also has a "Draft from timeline audio" button (on-device Whisper) users can press themselves.
- `open_panel narration`: cloned-voice generation via their configured CLI; the 🧬 wizard sets up XTTS-v2 (Python) or audio.cpp (no Python, Apache-licensed models) for them.
- Keep narration lines as flowing sentences, not ultra-short fragments (short lines make TTS models babble).

## Cutting to a spoken line (do not eyeball timestamps)

Reading a time off a transcript and using it is how a cut ends up in the wrong place. Two tools do it properly:

- `find_phrase {text}` finds where a line was said and returns in/out points, cutting nothing. It is tolerant of transcription slips, and it **trims what dangles**: ask for "check out this portable espresso maker" when the take runs on into "and this…" and the out point lands after *maker*, not after *this*. The point is then snapped to the real waveform, so no consonant is clipped and no dead air is left hanging.
- `cut_at_phrase {text, mode}` does the same and then cuts: `end` (default) drops everything after the line, `start` drops everything before it, `split` only splits the clips there.

Both read the timeline's speech with word timings (`analyze_speech`, cached until the timeline changes) using the `small` Whisper model by default, because accuracy matters more here than speed. The first use downloads that model once.

## B-roll (the `v2` track)

B-roll is **picture only**. A cutaway covers the video track while the audio underneath keeps playing, and hands the picture back on a word boundary. That is what makes it read as an edit rather than a glitch.

1. `scan_broll` measures the project's `broll` folder (or any `folder` you pass): length, sound, the steady part worth using, and a **contact sheet** image per clip.
2. **Open every contact sheet and look at it**, then `label_broll {id, labels}` with short concrete nouns for what is actually in the shot: `"coffee beans, pouring, close up"`. Those labels are the only thing matching has to work with, so unlabelled footage is never used. Labels are saved next to the footage in `.vidhelm-broll.json`, so a re-scan keeps them and the user can edit them by hand.
3. `plan_broll` matches labelled clips to the sentences actually being spoken and returns what it would do, **without touching the timeline**. Read it. A cutaway covers a whole sentence, never the first 8s, keeps ~4s of the speaker between cutaways, and stays under a third of the runtime.
4. `place_broll` commits it (`drop: "0, 3"` to leave some out).

If nothing matches a line, stay on the speaker. A cutaway to footage that does not match what is being said is worse than no cutaway.

## Vertical crops for Shorts

`plan_framing` decodes the footage and works out where a 9:16 crop should point. It **holds** the crop still inside a shot and only moves when the subject really does, because a crop that drifts reads as a broken gimbal.

It also returns `proof`: one image with the proposed crop drawn on the middle frame of each hold. **Open it.** Detail and motion energy find the biggest, busiest object in frame, which is not always the subject: on a coffee review it framed a black canister sitting next to the grinder. Where it is wrong, pass `hints` (`"3@0.72, 9.5@0.35"`, time@x with x across the frame) and call again.
## 3D models and extras

- A dropped/asked-for STL, 3MF, OBJ or GLB goes through the **3D Studio**: `open_panel {panel: "model3d", path}` loads it (an HTML viewer page works too, the model inside gets extracted), then `render_3d` produces the clip.
- `render_3d {seconds}` → spinning turntable into the bin. `render_3d {still: true, transparent: true}` → a **PNG with real alpha dropped at the playhead**, so it composites on top of the footage underneath: that is how you put a model over a video.
- Turntable *video* can't be transparent (no available codec carries alpha). For a spin over footage, tell the user to pick the **Video frame** backdrop in the studio, which bakes the frame under the playhead behind the model.
## Sending footage to a video-analysis service (Adversal and similar)

Those services take a file and return notes; they never see VidHelm. You are the link. `prepare_analysis` gets the material into a shape they accept and tells you what still needs looking at:

1. `prepare_analysis {scope: "timeline"}` flattens the project to a small mp4 whose timestamps match the timeline exactly (`toTimeline.add` is 0). Use `scope: "clip"` instead to skip the render and get the original file plus in/out points, in which case a returned timestamp T is timeline time `T + toTimeline.add`.
2. It also returns `gaps`: the stretches with no tag point within `gapPad` seconds. On a repeat pass, analyse only those, so material the human has already marked is left alone. `covered` and `coveredSeconds` show the other side of the same picture.
3. Send the file (with `start_time`/`end_time` from a gap when you are topping up) to the analysis tool, wait for it to finish, then read its notes.
4. Bring the results back: `add_tag` at each interesting moment, `set_booth_script` with a tightened narration draft, chapter titles for the description, and `compose_thumbnail` for a still.

Derive final chapter timestamps from `get_state` after the edit is cut, not from the notes: the notes describe the file you sent, and later cuts move everything.
- With browser control available, offer to upload the finished export to YouTube (always pause for explicit user confirmation before publishing) or to capture website/localhost footage for the timeline.

## Gotchas

- **Never edit `vidhelm-settings.json` yourself.** The running app owns it and rewrites it from memory on every change, so an outside edit disappears the next time anything saves. Use `set_recipe` to change the user's Start Recipe; it persists through the same path the GUI uses.
- `get_state.machine` tells you what the hardware was measured as and which defaults are in force. On a `low` tier the speech model is the quick one, so be more careful about anything hanging on an exact word, and say so.

- Times are seconds; text x/y are 0-1 of the frame.
- `export_video`, `cut_pauses`, `scan_broll`, `plan_broll` and `plan_framing` are long-running: don't parallelize other edits during them.
- B-roll on `v2` never contributes audio, by design. Natural sound from a cutaway has to go on `a1`/`a2` as its own clip.
- If a tool errors "VidHelm is not running": the app must be open. Ask, or run `npm run dev` in the background yourself.
- Connection problems on the user's side → tell them to click **🤖 AI** in the header (live diagnostics + per-client config) or see docs/CONNECT.md.
