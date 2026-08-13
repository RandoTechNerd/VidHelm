# The RandoSnap workflow

This is the editing pipeline RandoSnap is designed around. You can use it like any timeline editor, but the fast path is: **import → tag → tighten → narrate → sound → export**.

## 1 · Import

- Drag files into the **Media Bin** (left panel) or straight onto the timeline.
- Video and images land on the **VIDEO** track; audio lands on **VOICE / MUSIC**.
- Double-click a bin item to append it; right-click for **Add as intro clip** (uses your intro defaults from Settings — e.g. "first 5 seconds, faded, push everything later").
- Images default to 5 s stills — trim to taste.

## 2 · Tag the beats

Tag points are the backbone of everything else.

- Press **M** any time (playing or paused) to drop a tag at the playhead.
- Tags show as colored flags on the ruler. Drag to move, click to jump.
- Name them in the **Tag Points** panel (right side): `pop!`, `reveal`, `punchline`…
- Everything snaps to tags: clip edges, SFX placement, narration lines, booth cues.

> Tip: do one full watch-through and just tap `M` on every beat. Name them after.

## 3 · Tighten

- **Split** (`S`) at the playhead, drag trim handles, ripple-delete.
- **Cut Pauses** scans the whole timeline and removes dead space:
  - *Audio silence* mode for voice/music footage,
  - *Visual stillness* mode for silent screen recordings,
  - *Auto* picks for you. Configure thresholds in Settings → Cut Dead Space.
- Undo history (Ctrl+Z) covers everything.

## 4 · Narrate — three ways

RandoSnap treats narration as a first-class citizen. All three routes end with audio on the **VOICE / MUSIC** track:

### 🎙 The karaoke booth (one-take read-along)
1. Click **Booth**. Paste your script — one line per beat.
2. If you have at least as many tags as lines, each line is **pinned to its tag** ("time lines with tag points"); otherwise lines are spread evenly.
3. Hit **Record take** → 3-2-1 countdown → the video plays from the top and each line lights up when it's time to say it. Read along; there are no buttons to press between lines.
4. It auto-stops at the end and drops the take at 0:00 on the voice track. Don't like it? Delete the clip and go again.

### 🗣 Cloned-voice narration
Write the script in the **Narrate** dialog, and RandoSnap runs your local TTS/voice-clone tool on it — one WAV per line, placed at your tag points automatically. Any CLI works via a command template; a complete free local setup (XTTS-v2) is documented in [VOICE_CLONE.md](VOICE_CLONE.md).

### Plain voiceover
The **Voiceover** button punch-in records from the playhead — good for one-off pickups.

## 5 · Sound effects

- Open the **SFX** tab (left panel). Every sound has ▶ audition and **+** place-at-playhead.
- The 13 built-ins are synthesized locally on first launch — zero downloads, zero licensing.
- **Add your own…** opens the custom folder; any `.wav/.mp3/.ogg/.m4a/.flac` you drop there appears in the list.
- SFX land on their own **SFX** track so your voice lane stays clean. They're normal clips — trim, fade, or automate their volume like anything else.

Placement recipe: seek to a tag (click its flag), then hit **+** on the effect.

## 6 · Audio lanes, explained

| Lane | What lives there | Typical level |
|---|---|---|
| video clips' own audio | camera/screen-recording sound | duck under narration with the volume graph |
| **VOICE / MUSIC** | booth takes, cloned narration, voiceovers, music beds | the star of the mix |
| **SFX** | library + custom effects | accents; keep short |

Mixing tools, per clip: flat volume slider, **drawable volume-automation graph** (click to add points, drag to shape, double-click to delete), fade in/out. Master volume on the right.

**Export mastering** (Settings → Audio or the checkbox in Export):
- *Optimize loudness* compresses gently and lands the mix at YouTube's loudness target (≈ −14 LUFS, −1 dBTP) — leave it on unless you know why you're turning it off.
- *Noise reduction* adds an 80 Hz high-pass + FFT denoise — for hissy rooms.

## 7 · Captions

**Captions** transcribes the entire timeline on-device (Whisper) and adds timed text cues styled by Settings → Caption Style. Word-by-word mode gives karaoke-style captions. Nothing leaves your machine; the first run downloads the model.

## 8 · Export + Watch & Verify

- Pick **orientation** (Landscape/Portrait/Square), resolution up to 4K, and fps in the right panel.
- The encoder is tuned for YouTube: H.264 High, closed 2 s GOP, BT.709, `faststart`.
- After every export, **Watch & Verify** runs automatically: integrated loudness, true peak, black-frame detection, and a filmstrip of sampled frames so you can eyeball the result before uploading.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `M` | Drop a tag point at the playhead |
| `S` | Split selected clip at playhead |
| `Delete` | Delete selected clip/text |
| `←` / `→` | Step 1 frame (with `Shift`: 1 s) |
| `Home` | Jump to start |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
