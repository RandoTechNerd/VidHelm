# Project file & state format

`Save` writes a single JSON file (version 2). The agent bridge's `get_state` returns a close cousin of this shape. Both are stable, hand-editable, and diff-friendly, a valid target for scripts and agents.

```jsonc
{
  "version": 2,
  "orientation": "landscape",      // landscape | portrait | square
  "resolution": "1080p",           // 4K | 1440p | 1080p | 720p
  "fps": 30,                        // 24 | 30 | 60
  "masterVolume": 1,
  "exportQuality": "high",         // medium | high
  "savedAt": 1791234567890,        // when it was written (ms since 1970)
  "projectDir": "C:\\Videos\\VidHelm\\Launch",  // project-folder saves only: the folder it was saved in

  "mediaBin": [
    { "id": "abc123", "name": "clip.mp4", "path": "C:\\videos\\clip.mp4",
      "type": "video",             // video | audio | image
      "duration": 12.4, "hasVideo": true, "hasAudio": true,
      "relPath": "clip.mp4",       // optional: where the file sits inside projectDir (voice takes: "voice\\voiceover ....webm")
      "fps": 59.94,                // optional: the source's own frame rate
      "hdr": true,                 // optional: HLG/PQ footage, tone-mapped on export
      "chromaKey": "#00e800",      // optional: key colour removed on export and in the preview
      "proxyPath": "C:\\Users\\me\\AppData\\Roaming\\vidhelm\\proxies\\ab12.mp4",  // optional: the preview copy
      "proxyWidth": 1080, "proxyHeight": 1920, "proxyFps": 30,  // optional: that copy's real size and rate
      "audio": { "role": "voice", "fix": "studio" } }  // optional: the sound choices (see "Sound roles and Fix voice")
  ],

  "clips": [
    { "id": "c1", "mediaId": "abc123", "type": "video",
      "trackId": "v1",             // v1 = video · v2 = b-roll (picture only, over v1) · a1 = voice/music · a2 = SFX
      "start": 0,                  // seconds on the timeline
      "duration": 8.0,
      "sourceStart": 2.0,          // seconds into the source file
      "volume": 1,                 // 0..2 flat gain (ignored if volumePoints set)
      "fadeIn": 0.5, "fadeOut": 0.5,
      "aFadeIn": 0.012,            // optional: AUDIO-only ramp, overrides fadeIn for sound
      "aFadeOut": 0.012,           // optional: ditto for fadeOut. Absent = follow the picture fades.
      "volumePoints": [            // optional volume automation (t relative to clip start)
        { "t": 0, "v": 1 }, { "t": 3, "v": 0.3 }
      ] }
  ],

  "texts": [
    { "id": "t1", "text": "Hello", "start": 1, "duration": 3,
      "x": 0.5, "y": 0.2,          // 0..1 of frame, anchor = center
      "fontSize": 64,              // px at 1080p height (scales with resolution)
      "color": "#ffffff", "fadeIn": 0.3, "fadeOut": 0.3,
      "box": true, "boxOpacity": 0.5 }
  ],

  "markers": [                     // tag points, the beat map
    { "id": "m1", "t": 3.5, "label": "hook", "color": "#f472b6" }
  ]
}
```

Notes for tooling:

- **Media paths are absolute**: projects reference files in place, nothing is copied. The one exception is voice takes recorded before the project had a folder (or under an older version, in `%TEMP%`): saving into a project folder copies them into its `voice` sub-folder and points the file at the copies.
- **Relinking on open.** For each `mediaBin` entry, opening a project folder tries, in order: `relPath` inside the folder being opened; when the folder was moved or copied (`projectDir` differs), a file of the same name in it; the saved `path`; then a file of the same name in the folder. Whatever is still not found loads with `offline: true` (relink it in the Media panel) instead of as blank clips. A relinked entry drops its `proxyPath` and proxy size so the preview copy is rebuilt from the right file. `offline` and `relPath` are worked out again on every open and save, so editing them by hand changes nothing.
- The proxy fields describe the preview copy, not the source. A Standard export reads that copy only when it is at least as big and as smooth as the export needs; a High quality export always reads the original.
- Overlapping `v1` clips composite in array order (later on top), in the preview and in the export alike; `v2` always sits above `v1`. Give both fades for a crossfade.
- All clips with audio are mixed regardless of track; tracks are an organizational convention (`a2` keeps effects out of the voice lane).
- `markers` don't affect rendering: they're coordination points for humans, the karaoke booth, narration placement, and agents.
- The bridge's `get_state` flattens this for reading (media names inlined into clips, tags sorted) and adds `unsaved` and `project`; write operations go through `POST /command` actions rather than file writes, so the GUI updates live and undo history stays intact.

### Files beside the save

A project folder holds `project.vidhelm.json` (the save) and, at times, these:

- `project.vidhelm.json.bak`: the previous save, kept for one more save, so a save of the wrong state can be walked back by renaming it.
- `project.vidhelm.autosave.json`: unsaved work, written about every 30 seconds while there is any and removed once it is saved or discarded. It wraps the project: `{ "savedAt", "dir", "name", "file", "data": <the project> }`. When it is newer than the save, opening the project offers Restore or Discard. Untitled work (no project folder) autosaves to `autosave\untitled.json` in the app's data folder instead.
- `voice\`: recorded takes. Opening the project lists them along with the folder's own media.

The save and the autosave are written to a `.tmp` file first and renamed into place, so a crash mid-write never leaves half a file. A project opened from an `.rsnap` or `.json` file is saved back into that same file.

### Sound roles and Fix voice

`mediaBin[].audio` holds the two sound choices a person (or an agent, through `update_clip`) made for a file, and nothing else:

- `role`: `voice`, `music`, `sfx` or `asis`. Absent means guessed, the same way on every machine: where the file came from (booth, narration and voiceover takes are voices, `make_score` beds are music, the SFX library and the `a2` track are effects), then the measured sound (speech with pauses is a voice; a continuous sound is music on its own and as recorded under a picture).
- `fix`: Fix voice for a voice, `off`, `light` or `studio`. Absent means `studio`.

Both apply to every clip cut from that file. The measurements and the baked voices behind them live in the app's data folder (`voice\`), keyed on the file itself, and are rebuilt on open (a cache hit answers at once), so they never make a project unsaved and a project file never points at them. Files saved before these fields existed open with every role guessed and Studio on, which is what an untouched project gets anyway. docs/AUDIO.md explains what each choice does.

### Audio-only fades

`aFadeIn` / `aFadeOut` let the picture cut hard while the waveform still ramps.
Cutting a pause or splitting a clip sets them to about twelve milliseconds:
inaudible as a fade, but long enough that the signal reaches zero before the
join. Without it a splice lands mid-cycle, and that step is a click, which is
what a run of pause cuts turns into a string of little pops. Older project files
have no such field and simply follow `fadeIn` / `fadeOut`, so they load fine.
