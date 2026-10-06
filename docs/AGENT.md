# Driving VidHelm with an AI agent

VidHelm is built for **two-handed editing**: you in the GUI, an AI assistant on the other side of a local bridge, both working on the same timeline at the same time. You drag clips; the agent tags beats, drops SFX, writes titles, and exports. Everything the agent does appears live in your window.

> **Connecting a client?** [docs/CONNECT.md](CONNECT.md) covers every AI client (Claude, Cursor, VS Code, Windsurf, Cline, Codex, Gemini, plain HTTP) plus troubleshooting, or click **Connect AI** in the app header for live diagnostics and configs generated with your real install path. This page documents the bridge itself.

## Setup with Claude Code (zero config)

The repo contains `.mcp.json`, so Claude Code discovers the server automatically:

1. Start the app: `npm run dev` (or launch the installed VidHelm).
2. Open this repo folder in Claude Code and approve the `vidhelm` MCP server when prompted.
3. Talk: *"look at my timeline and put a whoosh on every tag point"*.

## Setup with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vidhelm": {
      "command": "node",
      "args": ["C:/path/to/VidHelm/agent/mcp-server.mjs"]
    }
  }
}
```

## What the agent can do

| Tool | Purpose |
|---|---|
| `get_state` | Read the whole project: format, media bin, clips per track, texts, tag points, playhead |
| `screenshot` | See the app window exactly as you see it |
| `add_media` / `add_clip` / `update_clip` / `split_clip` / `delete_item` | Build and edit the timeline |
| `add_text` / `update_text` | Titles and captions |
| `add_tag` / `update_tag` | Read/write the beat map you create with `M` |
| `list_sfx` / `place_sfx` | The sound-effect library, placed on the SFX track |
| `transport` | Seek / play / pause your window (e.g. "show me the reveal") |
| `set_format` | Landscape/portrait/square, resolution, fps |
| `export_video` | Render + automatic quality check (loudness, peaks, black frames) |
| `cut_pauses` | Remove silent/static dead space across the timeline, spliced with crossfades |
| `find_repeats` | Read the timeline's speech on-device and return the spots where a line was said more than once, with every attempt's words, timing, and the default pick. Cuts nothing |
| `apply_takes` | Cut the rejected takes (`keep` as `"group:member"` pairs, `drop` as line indexes). Ripples and stays undoable; re-running rebuilds from the pre-cut state |
| `run_recipe` | Execute the user's Start Recipe (their standing workflow) |
| `sample_frames` / `compose_thumbnail` | Pick a moment and produce a 1280×720 thumbnail with subtitle + logo |
| `open_panel` | Open the booth / narration / thumbnail picker / settings for the user |
| `open_project` | List the project folders, or open one by `name`. Opening replaces the timeline, so while `get_state.unsaved` is true it refuses: ask the human, then call again with `save:true` (save, then open) or `force:true` (discard the changes) |

A conversation that works well:

> **You:** I dropped tags on all the beats. Make it fun.
> **Agent:** *(get_state → sees `hook 3.5s`, `reveal 8.2s`, `punchline 11s`)* placing a riser into the reveal, a party horn on it, pop on the punchline, and a title over the hook… *(screenshot)* here's how it looks, want the horn louder?

## The Start Recipe, your standing orders

`get_state` returns `startRecipe`: the user's instruction block (# lines are OFF). Treat active lines as your to-do when they say "run my workflow": app-native steps go through `run_recipe`/`cut_pauses`/`compose_thumbnail`; lines like `titles 5` mean YOU pitch five title options in chat and let them pick. Free-typed lines are custom standing instructions, follow them.

## Long commands, timeouts and `stillRunning`

Every command has a time limit, and both ends of the bridge read it from one table, `agent/timeouts.mjs`: 15 s for quick edits, 2 min for the ones whose first call can do real work (`add_media`, `list_sfx`, `place_sfx`, opening a panel), 20 min for whole-timeline renders and Whisper passes (`cut_pauses`, `make_captions`, `find_phrase`, `open_project`, and any command with a word anchor `at:"..."`), 15 min for `generate_clip` and 4 h for `export`. The MCP proxy always waits a minute longer than the bridge, so the bridge's own, clearer message is the one that arrives.

A timeout cancels nothing. A reply that carries `stillRunning: true` means the command is still going inside the app (a long render, a Whisper pass, a paid AI clip): call `get_state` to see whether it landed instead of sending it again. **Never retry `generate_clip`** after a timeout or a `stillRunning` reply: the generation carries on at the provider, and a second call pays for a second clip. Look for the new ai-clip in `get_state`'s media bin first.

## How it works / security

- The app runs a **localhost-only** HTTP bridge (`127.0.0.1:5959`, override with `VH_AGENT_PORT`). Connections from other machines are refused; nothing is exposed to the network.
- Web pages open on the same machine can reach 127.0.0.1 too, so the bridge refuses any request that carries an `Origin` or `Sec-Fetch-Site` header (a browser adds one or both to every request a page makes) and any whose `Host` is not `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` (a DNS-rebinding page still arrives under its own hostname). The MCP server, curl, Python and Node's `fetch` send neither header and work as before; a web page or browser extension cannot drive VidHelm. The rules are in `electron/bridgeguard.ts`.
- `agent/mcp-server.mjs` is a dependency-free stdio MCP server that proxies tool calls to the bridge. If the app isn't running, tools return a clear "start the app" message instead of hanging.
- The agent edits the same React state you do: undo (Ctrl+Z) works on its changes, and yours and its edits interleave safely.

## For other agent frameworks

Skip MCP and hit the bridge directly (from a script or a terminal: a request from a web page is refused, see above):

```bash
curl http://127.0.0.1:5959/state
curl -X POST http://127.0.0.1:5959/command -d '{"action":"place_sfx","name":"pop","t":11.0}'
curl http://127.0.0.1:5959/screenshot -o now.png
```

Actions mirror the MCP tools (`docs/PROJECT_FORMAT.md` documents the state shape).
