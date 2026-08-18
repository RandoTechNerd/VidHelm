# VidHelm 🎬

**A lean desktop video editor for makers. You take the helm; your AI crews the busywork.**

> **Built to be flown with an AI co-captain.** VidHelm cuts, tags, narrates and exports by hand today, but it is not a standalone editor yet: the parts that make it fast (titles written for you, effects placed on every beat, your whole workflow run from one sentence) need an assistant connected. Setup is one command and takes about a minute, see [docs/CONNECT.md](docs/CONNECT.md).

[vidhelm.com](https://vidhelm.com) · [YouTube](https://www.youtube.com/@randotechnerd) · [Instagram](https://www.instagram.com/randotechnerd/) · [Buy me a coffee ☕](https://buymeacoffee.com/randotechnerd) · [randotechnerd@gmail.com](mailto:randotechnerd@gmail.com)

VidHelm is an Electron + React editor built around one workflow: drop in footage, **tag the beats**, add **sound effects** and **narration** (your mic, a karaoke-style read-along, or a cloned voice), and export a **YouTube-ready** MP4 with the right resolution, loudness and encoding every time.

Your footage never leaves your machine: FFmpeg does the rendering, Whisper runs on-device for captions, and the SFX library is synthesized locally, no accounts, no uploads, no stock-library fees. (The interface does fetch its font from Google Fonts, and Whisper's model downloads once on first use.)

![VidHelm](docs/screenshot.png)

## Features

**Your workflow, automated**
- **Start Recipe**: standing instructions like start G-code: a plain-text block with toggle chips (off = `#`-commented), free-type welcome. Default pipeline: cut dead air → thumbnail picker (frame + catchy subtitle + your logo) → 5 AI-pitched titles → brand watermark → intro sting at 0:00. One click (🚀 Recipe) or one sentence to your AI runs it
- **Robust pause removal**: trim-aware audio analysis, tail-silence detection, overlap-safe splicing with crossfades

**Project folders, no importing**
- Point VidHelm at one folder in Settings and every sub-folder inside it becomes a project. Open one and the footage sitting in that folder is simply there, so dropping files in with Explorer *is* the import
- Saving writes back into the same folder, which makes a project something you can copy, back up or hand to someone else. Switch projects from the Media Bin, or ask your AI to (`open_project`)

**Editing**
- Timeline with filmstrip thumbnails, trim/split/ripple, snapping, undo/redo, zoom-to-fit (see every clip at once; Ctrl+scroll zooms around the cursor)
- **🧊 3D Studio**: drop in an **STL / 3MF / OBJ / GLB** (your prints!), even an HTML viewer page with a model inside, pose it in a live viewer, pick color/finish/backdrop, and render a spinning **turntable clip** or still straight onto the timeline. Pick the **Green screen** backdrop and the spin drops onto the timeline with its backdrop keyed out, so the model sits over your footage. **Transparent** gives stills a real alpha channel, and **Video frame** bakes in the frame under your playhead. Any green-screen footage can be keyed the same way: right-click it in the Media Bin. Converts to OBJ too
- **Phone footage just works**: HEVC, 10-bit and HDR recordings (what every recent phone shoots) cannot be decoded by the preview at all, so VidHelm quietly builds a watchable stand-in in the background and tells you it did. Your original stays the master: exports read from it, and HDR colour is tone-mapped so the result matches what you saw instead of coming out grey
- **Imports just about anything**: video, audio and image formats are decided by FFmpeg rather than a fixed list, so unusual files still work; anything unusable is refused with a plain-English reason instead of landing on the timeline as a broken clip
- **Tag points**: press `M` to mark beats (a joke, a reveal, a cut). Tags are visible flags on the ruler; clips snap to them, SFX drop on them, narration lines align to them
- Text overlays with fades: click **Text** and type straight onto the picture, or double-click any text to edit it where it sits. Drag to move
- Volume automation (draw a gain curve on any clip), per-clip fades, crossfades
- **Cut Pauses**: detects silent gaps *or* motionless stretches and ripples them out
- **Takes & history**: said the line three times? A quiet 📋 Takes button reads the timeline's speech on-device, groups the attempts (including the false start Whisper merges into the same sentence), and keeps the best one. You get the whole transcript with the cut lines greyed out, so it doubles as a record of what left the edit, and you can switch to a different take afterwards without re-scanning

**Audio** (three labeled lanes: `VOICE / MUSIC`, `SFX`, plus each video's own sound)
- **SFX library**: 13 built-in synthesized effects (whoosh, pop, boing, squish, gloop, poof, sparkle, party horn…). Audition with one click, place at the playhead. Drop your own WAV/MP3s into the custom folder and they appear alongside
- **✨ AI sound effects**: describe any sound ("cartoon spring boing, short") and generate it locally with a text-to-audio model (one-time command setup; [audio.cpp](https://github.com/0xShug0/audio.cpp) + stable_audio recommended, see [docs/VOICE_CLONE.md](docs/VOICE_CLONE.md))
- **Karaoke booth**: paste your script (or **✨ draft it from your timeline audio** with on-device Whisper, perfect for cleanly re-recording a rough take), hit record: the video plays, lines light up in time (evenly, or pinned to your tag points), you read along in **one take**, and the take lands on the voice track. Your AI can write the script into the booth too
- **Cloned-voice narration**: a built-in **🧬 setup wizard** records a ~20s sample of your voice and sets up a free local engine for you: **XTTS-v2** (guided Python install) or **[audio.cpp](https://github.com/0xShug0/audio.cpp)** (prebuilt exe, no Python, Apache-licensed models, safe for monetized videos). Any TTS/voice-clone CLI works too, see [docs/VOICE_CLONE.md](docs/VOICE_CLONE.md); generated lines are placed at your tag points automatically
- Loudness done right: one checkbox masters the mix to YouTube's target with a compressor + `loudnorm`; optional noise reduction

**🤖 AI copilot built in, bring your AI of choice**
- VidHelm ships an **MCP server**: your AI assistant drives the running app **while you watch**: read the timeline, drop SFX on your tag points, write titles, seek your window, take screenshots of what you see, and export with a quality report
- You edit in the GUI, the agent edits through the bridge: same timeline, live, with shared undo. Tag points become the language between you: you mark the beats, it does the busywork
- **Zero config** for Claude Code, Cursor, and VS Code (configs ship in the repo) · copy-paste setup for Claude Desktop, Windsurf, Cline, Codex CLI, Gemini CLI · **fully-local setups** with LM Studio, Jan, Open WebUI, Ollama, or AMD Lemonade Server · plain-HTTP fallback for everything else, see [docs/CONNECT.md](docs/CONNECT.md)
- A **portable skillset** teaches any assistant the workflow: `AGENTS.md` (read automatically by most agentic tools), a Claude Code skill in `.claude/skills/`, and a paste-anywhere version in `agent/skills/`
- Stuck? Click **🤖 AI** in the app header: live connection diagnostics, per-client configs generated with your real install path, and fixes for the usual snags

**Finishing**
- On-device **Whisper captions** (phrase or word-by-word karaoke style, 10+ languages)
- Brand kit: your logo as intro bug / outro watermark on every export
- Landscape · Portrait · Square presets up to 4K, 24/30/60 fps
- **Watch & Verify**: every export is auto-checked (loudness, true peak, black frames, sampled stills) before you upload

## Your first ten minutes

**1. Install.** Grab the installer from [Releases](https://github.com/RandoTechNerd/VidHelm/releases/latest) and run it. Nothing else to install - FFmpeg is bundled. (Windows may warn about an unknown publisher; the installer isn't signed with a paid certificate yet.)

**2. Make something.** Drag a video onto the timeline. Play it, tap `M` at moments that matter, and press **Cut Pauses** to strip dead air. Open the **SFX** tab and drop a whoosh on a tag point.

**3. Export.** Hit **Export Video**, pick a location, and let **Watch & Verify** confirm it's upload-ready (resolution, loudness, true peak, black frames).

**4. Add your AI (optional, and the fun part).** Click **🤖 AI** in the header. It health-checks everything and gives you the exact setup line for your assistant, for Claude Code that's one command:

```bash
claude mcp add vidhelm -- node "C:\Program Files\VidHelm\resources\agent\mcp-server.mjs"
```

Restart your assistant, keep VidHelm open, and ask it something like *"look at my timeline and put a whoosh on every tag point"* or *"run my workflow"*. It sees the same timeline you do. If anything is red in that panel, it tells you how to fix it, full guide in [docs/CONNECT.md](docs/CONNECT.md).

**5. Publish.** Pair your assistant with browser control and it can upload the finished file to YouTube for you, filling in the title, description, tags and thumbnail, and pausing before it publishes.

## Building from source

```bash
git clone https://github.com/RandoTechNerd/VidHelm
cd VidHelm
npm install
npm run dev        # full desktop app (Electron)
```

> **Windows-first.** FFmpeg/FFprobe binaries ship via npm (`ffmpeg-static`), no manual install. macOS/Linux need two small path tweaks; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#platform-notes).

Other commands:

```bash
npm run dev:web    # UI only, in a plain browser (mock backend, great for UI work)
npm run typecheck  # strict TS across renderer + main process
npm run build      # production build + installer (electron-builder)
```

## The 5-minute workflow

1. **Import**: drag videos/images/audio into the Media Bin (or straight onto the timeline).
2. **Tag the beats**: play through once, tap `M` at every moment that matters. Name the tags in the right panel.
3. **Tighten** - `Cut Pauses` removes dead air; split/trim around your tags (clips snap to them).
4. **Narrate**: pick one:
   - 🎙 **Booth**: paste your script, one line per tag, record a single read-along take;
   - 🗣 **Narrate**: generate the lines with your cloned voice;
   - or plain **Voiceover** punch-in at the playhead.
5. **Sound**: open the **SFX** tab, audition, `+` to drop effects at the playhead/tags.
6. **Export**: pick orientation/resolution, leave *Optimize loudness* on, hit Export, and let **Watch & Verify** confirm it's upload-ready.

Full walkthrough with details: [docs/WORKFLOW.md](docs/WORKFLOW.md)

## Docs

| Doc | What's inside |
|---|---|
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | The full editing pipeline, keyboard shortcuts, audio lanes explained |
| [docs/CONNECT.md](docs/CONNECT.md) | Hook up **your AI of choice**: zero-config + copy-paste setups, HTTP fallback, troubleshooting |
| [docs/AGENT.md](docs/AGENT.md) | The agent bridge itself, endpoints, tool list, protocol details |
| [docs/PROJECT_FORMAT.md](docs/PROJECT_FORMAT.md) | The JSON project/state format for scripts and tooling |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the app is built, for contributors |
| [docs/VOICE_CLONE.md](docs/VOICE_CLONE.md) | Set up free local voice cloning (XTTS-v2) and wire it to the Narrate button |

## Thanks

Special thanks to **[inventinside](https://github.com/inventinside)**: now a contributor, whose feedback drove a good stretch of what VidHelm can do. A lot of the recent capabilities exist because the ideas kept coming. If you've got one, [open an issue](https://github.com/RandoTechNerd/VidHelm/issues); that's how most of this list got written.

## License

VidHelm's own code is MIT, see [LICENSE](LICENSE).

It also ships other people's work, and that comes with its own terms. The most important one: the bundled **FFmpeg and FFprobe binaries are GPL-3.0-or-later**, not MIT - VidHelm runs them as separate programs and stays MIT itself, but if you redistribute VidHelm you carry those obligations along with it. The full picture, including every npm package that ships inside the app, is in **[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)** (and inside the app under **?** → Credits & licences). Installed copies ship those texts too, in the `licences` folder beside the program.

Built by [RandoTechNerd](https://www.youtube.com/@randotechnerd). If VidHelm saves you time, [a coffee keeps the updates coming](https://buymeacoffee.com/randotechnerd). ☕ Please put **"VidHelm"** in the comment so it lands against the right project, and add any feature you want next while you are there.
