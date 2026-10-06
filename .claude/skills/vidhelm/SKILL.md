---
name: vidhelm
description: Drive the running VidHelm video editor to make or polish a video, cut pauses, place SFX on tag points, record/generate narration, compose thumbnails, run the user's Start Recipe, and export a YouTube-ready MP4. Use when the user asks to edit a video, "make this a YouTube video", run their workflow/recipe, or do anything inside VidHelm.
---

# Driving VidHelm

You are co-editing with a human: they see every change live in the GUI and can move things between your calls. The `vidhelm` MCP tools talk to the running app (start it with `npm run dev` if tools say it's not running; the user can check the Connect AI button in the app for connection help).

## Core loop

1. `get_state`: always first. Returns format, media bin, clips per track (`v1` video, `v2` b-roll, `a1` voice/music, `a2` SFX), texts, **tag points**, and `startRecipe`.
2. Batch a few edits, then `screenshot` to verify what the human sees. Re-read state after they touch anything.
3. Report progress in chat conversationally; the human is watching the app, not your tool calls.
4. **Unsaved work belongs to the human.** `get_state.unsaved` is true while there are changes not saved yet (`get_state.project` names what is open). `open_project` replaces the timeline, so it refuses then: ask the human, and call again with `save:true` (save, then open) or `force:true` (discard the changes). It also opens nothing when the target project holds unsaved work from an earlier session; only the human can restore or discard that, so ask them to choose the project in the Media panel's project list (they get Restore / Discard), then carry on. A media bin entry with `offline:true` is a missing file the human relinks in the Media panel.
5. Pictures go on `v1`/`v2` and sound on `a1`/`a2` (`add_clip` refuses the rest). `set_format` takes only landscape/portrait/square, 4K/1440p/1080p/720p and 24/30/60 fps; anything else is refused and nothing changes.

## The "make me a video" workflow (their Start Recipe)

`get_state.startRecipe` is the user's standing instruction block (`#` = disabled line). When asked to "run my workflow / recipe" or just "make this a video":

1. `run_recipe`: the app executes its native steps (cut-pauses, intro audio, logo, thumbnail picker) and returns which steps are **yours**.
2. Your steps, typically:
   - `titles 5` → pitch 5 title options in chat, let them pick.
   - `subtitle` → propose catchy thumbnail one-liners, then `sample_frames` → pick a strong frame with the user → `compose_thumbnail {t, subtitle, outPath}` (logo lands top-right automatically).
   - Any free-typed recipe lines are standing instructions for you, follow them.
3. `export_video {outputPath}`: blocks until rendered, returns a quality check (loudness against the target / true peak / black frames). Relay the verdict. `target` (`youtube`, `podcast`, `broadcast`, `audiobook`) and `duck` apply to that export only.

## Beats and sound

- **Tag points are the shared language.** The human taps `M` at moments that matter. Hang everything on tags: `place_sfx {name, t: tag.t}`, text overlays at tags, narration lines aligned to tags. Prefer tags over hardcoded times.
- SFX built-ins: whoosh, pop, boing, squish, gummy-squish, gloop, poof, spoosh, sparkle, party, riser, ding, thud (`list_sfx` for customs).
- `cut_pauses` removes silent/static dead air across the whole timeline with crossfades; it's undoable, run it before fine-tuning times.

## Sound roles and Fix voice

- **Sound is automatic, and every clip has a role.** Voice, Music, SFX or As is: guessed from where the file came from (booth, voiceover and narration takes are voices, `make_score` is music, the SFX library and the `a2` track are effects), then from the measured sound (speech with pauses is a voice; continuous sound is music on its own, as recorded under a picture). Voices get **Fix voice** (Studio by default: room noise cleaned, sections levelled, knocks tamed, lifted to -16 LUFS), music sits 5 LU under the voice and dips 10 dB while someone speaks (keyframes that land before the first syllable), SFX have their loudest moment matched to the voice, and the export lands on the loudness target with one measured linear gain. Nothing compresses the whole mix.
- **Read before you change.** `get_state` gives each heard clip `audio` (role, `guessed` and why, its level, and for a voice `voiceFix`, `fixStatus` and the bake's one-line `summary`), plus `sound.exportLandsAt`. `analyze_audio` (all files on the timeline, or `media`/`clipId`) measures loudness, room noise, speech and the Fix voice plan without changing anything: use it to explain what will happen.
- **Change it with `update_clip`**: `role` (`voice`, `music`, `sfx`, `asis`, or `auto` for the guess) and `voiceFix` (`off`, `light`, `studio`). Both belong to the FILE, so every clip cut from it follows; a new level bakes in the background. Set As is on a camera clip with music already in it (premixed sound processed as a voice pumps). `export_video {target, duck}` picks the loudness for that export only: `youtube` -14 (default), `podcast` -16, `broadcast` -23, `audiobook` -20.

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

- A dropped/asked-for STL, 3MF, OBJ or GLB goes through the **3D Studio**: `open_panel {panel: "model3d", path}` loads it (an HTML viewer page works too, the model inside gets extracted), then `render_3d` produces the clip. Multicolour 3MF/OBJ keeps its own colours (object-level 3MF colours and an OBJ's sidecar .mtl both load), so only tick recolor if you actually want to override them.
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

## Seeing the video

`look_through` samples the whole video and returns contact sheets with the **timecode burned into every tile**, so anything you notice can be quoted with the second it happened: read a display, a label, a product name, or find the shot worth cutting to. Long videos widen the interval rather than covering only the start, and any frame that could not be extracted is reported rather than silently missing. Pair it with `analyze_speech` to line up what was seen with what was said. This is the local answer to "send it to a video-analysis service", and it is faster, exact on time, and uploads nothing.

## Sound effects

- `search_sfx {query}` searches the free libraries and returns each hit's LICENCE. Wikimedia Commons always works; Freesound needs the user's free token in Settings and is the one worth having. Non-commercial and unlicensed results are hidden by default because they are not safe on a monetised channel. `download_sfx {index}` saves one and writes any required credit into CREDITS.txt: tell the user when a sound needs crediting, because it has to go in the description.
- The ✨ AI button turns a plain description into one of the models with no setup, so tell the user to just type what they want. `make_sfx, make_score {recipe, seed}` is the same thing from your side: coffee beans into a metal, plastic or glass container, a sci-fi door opening or closing, a podracer starting, and one flying past with real Doppler. Change the seed for another take of the same sound. Call it with no recipe to list them. See docs/SFX.md.

## Gotchas

- **Never edit `vidhelm-settings.json` yourself.** The running app owns it and rewrites it from memory on every change, so an outside edit disappears the next time anything saves. Use `set_recipe` to change the user's Start Recipe; it persists through the same path the GUI uses.
- `get_state.machine` tells you what the hardware was measured as and which defaults are in force. On a `low` tier the speech model is the quick one, so be more careful about anything hanging on an exact word, and say so.

- Times are seconds; text x/y are 0-1 of the frame.
- `export_video`, `cut_pauses`, `scan_broll`, `plan_broll` and `plan_framing` are long-running: don't parallelize other edits during them.
- B-roll on `v2` never contributes audio, by design. Natural sound from a cutaway has to go on `a1`/`a2` as its own clip.
- If a tool errors "VidHelm is not running": the app must be open. Ask, or run `npm run dev` in the background yourself.
- Connection problems on the user's side → tell them to click **Connect AI** in the header (live diagnostics + per-client config) or see docs/CONNECT.md.

## Word anchors, the grid, and the other 1.9 habits

- **Put things on words, not numbers.** `find_word {text}` returns where a word or phrase was said; then any time-taking tool (`add_text`, `add_tag`, `place_sfx`, `split_clip`, `add_clip`, `transport`) takes `at:"arcade"` or `at:"end:arcade"` instead of `t`/`start`. Every animation in a tight teaser is keyed to the moment a word is spoken; this is that trick as a parameter.
- **Snap before you score.** `snap_to_grid` rolls every join onto the beat and slides tags onto bar lines (nothing downstream moves, runtime unchanged; `dryRun` previews). Then `make_score` at the same bpm lands every hit exactly.
- **Two score palettes.** `make_score {style:"cinematic"}` swaps the electronic kit for bowed strings, a cello ostinato, felt piano, taiko, choir, braams, a riser into every hit and a pocket of silence before each drop. Use it when the user says anything like "no beeps".
- **Text presets and design rules.** `add_text {preset:"title"|"lower-third"|"caption"|"end-card"}` supplies the lane, size, box and fades; the font auto-shrinks to fit, and the reply warns if the text overlaps another, runs off-frame, or flashes under half a second. `export_video` re-checks the whole text track.
- **Script-aware export QC.** Pass `script` to `export_video` (or set the booth script first) and the finished mix is transcribed and diffed against it: the verdict gains a "Script match" line with the missing words. Cheap insurance against a dropped narration line.
- **Film a website.** `capture_site {url, width, height, theme, script, seconds}` renders any page (including localhost) in the app's own Chromium, runs your script first to seed state or freeze animations, and returns a still or a real-time recording straight into the bin.
- **Narration says acronyms right.** The narration adapter runs a pronunciation pass before synthesis (ASCP → "A S C P", CruxSci → "Crux Sigh", unknown CAPS spelled out). The user's own table is `pronounce.json` in the app data folder.

## AI video clips (`generate_clip`)

`generate_clip {prompt, from?, at?, to?, seconds?, model?, place?}` makes a real video clip with the human's fal.ai (or Gemini) key and lands it in the bin and at the end of v1. Three jobs: a shot from a description; one picture brought to life (`from` = a bin image, a path, or `playhead` for the frame under the playhead); a transition that morphs one picture into another (`from` + `to`). It costs the human money (about $0.35-0.75 per 5 s) and takes 1-4 minutes, so ask before generating more than a couple, prefer it for shots footage cannot give (openers, establishing shots, "make the sign catch fire" from a plain picture to the burning one), and never for something a cut or a still would do. If it returns "no AI video key", point the human at the ✨ AI clip button in the header.

## Style themes and real-photo thumbnails

- **Say the look, get a baseline.** `set_theme {theme:"<their words>"}` turns "make it fun", "clean minimalism", "futuristic tech captions", "cartoon" into one of 15 finished themes (creator, clean, hype, fun, cartoon, tech, terminal, cinematic, elegant, news, neon, handmade, karaoke, explainer, randotechnerd). Tweak words ride on top: "tech but green", "fun, bigger, at the top", "news but no box". A theme sets caption font/colours/motion, title fonts (`add_text` presets) and thumbnail text together, and returns a `feel` (transitions, music, sfx) to steer the rest of the edit.
- **Captions in the theme.** `make_captions` transcribes on-device with word timings, breaks lines at pauses and sentence ends, and the motions (highlight, pop, bounce, karaoke, typewriter, glow, glitch) land on each spoken word. The export burns them through libass with `electron/styletheme.ts`, the same renderer VidHelm Cloud uses, so a theme looks identical on both.
- **Thumbnails: real pictures first.** `compose_thumbnail` uses the creator's own photo (passed as `imagePath`, or an image in the project named like thumb/cover/photo), else the best REAL frame (`sample_frames {rank:true}` shows the ranked shortlist with reasons; look at them), else a placeholder card that says so. Text is `"BIG HOOK | smaller second line"`. When the reply has `tellTheCreator`, relay it and ask for a real photo.
