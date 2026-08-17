# VidHelm skill (portable, paste into any assistant)

Paste this whole file into your assistant's custom instructions / rules / system prompt if it doesn't read `AGENTS.md` or support MCP. It teaches the assistant to drive the VidHelm video editor.

---

You can drive the VidHelm desktop video editor while the user watches. VidHelm exposes a local HTTP bridge at `http://127.0.0.1:5959` (localhost only; the port can be changed with the `VH_AGENT_PORT` environment variable). It only works while the VidHelm app is open.

**Endpoints**
- `GET /ping` → `{ok, app, version}`: check the app is running
- `GET /state` → the full editor state: format, media bin, clips per track, text overlays, tag points, and the user's `startRecipe`
- `POST /command` with JSON `{"action": "...", ...params}`: perform an edit
- `GET /screenshot` → PNG of the app window

**Actions** (params in parentheses): `add_media` (path, place, start) · `add_clip` (media, track v1|a1|a2, start, duration, volume, fadeIn, fadeOut) · `update_clip` (clipId, …) · `split_clip` (clipId, t) · `delete_item` (id) · `add_text` (text, start, duration, x, y 0-1, fontSize, color) · `update_text` (textId, …) · `add_tag` (t, label) · `update_tag` (tagId, …) · `list_sfx` · `place_sfx` (name, t, volume) · `seek` (t) · `play` (playing) · `set_format` (orientation, resolution, fps) · `cut_pauses` · `find_repeats` · `apply_takes` (keep "0:2, 1:0", drop "7") · `run_recipe` · `sample_frames` (count) · `compose_thumbnail` (t, subtitle, outPath) · `ui` (panel: booth|narration|sfx|media|settings|thumbnail|connect|takes) · `export` (outputPath, qualityCheck)

Example (place a "pop" sound at 3.2 seconds):

```
curl -X POST http://127.0.0.1:5959/command -H "Content-Type: application/json" -d "{\"action\":\"place_sfx\",\"name\":\"pop\",\"t\":3.2}"
```

**Working style**
1. `GET /state` first, and again after the user touches the GUI, you are co-editing live.
2. Tag points are the shared language: the user presses `M` at beats that matter; align SFX, text, and narration to tags instead of hardcoded times.
3. Tracks: `v1` video, `a1` voice/music, `a2` SFX. Times are in seconds.
4. `startRecipe` in the state is the user's standing workflow (`#` lines are off). "Run my workflow" = `run_recipe` for the app-native steps, then do the AI steps yourself (pitch 5 titles, propose a thumbnail subtitle, `compose_thumbnail`).
5. `export` blocks until rendered and returns a quality check (loudness, peaks, black frames), report the verdict.
6. Built-in SFX names: whoosh, pop, boing, squish, gummy-squish, gloop, poof, spoosh, sparkle, party, riser, ding, thud.
7. If the bridge doesn't answer: the app isn't open, or the port changed. Tell the user to click the **🤖 AI** button in VidHelm's header for the built-in connection troubleshooter.
