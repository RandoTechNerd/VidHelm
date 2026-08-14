# Driving RandoSnap with an AI agent

RandoSnap is built for **two-handed editing**: you in the GUI, an AI assistant on the other side of a local bridge — both working on the same timeline at the same time. You drag clips; the agent tags beats, drops SFX, writes titles, and exports. Everything the agent does appears live in your window.

## Setup with Claude Code (zero config)

The repo contains `.mcp.json`, so Claude Code discovers the server automatically:

1. Start the app: `npm run dev` (or launch the installed RandoSnap).
2. Open this repo folder in Claude Code and approve the `randosnap` MCP server when prompted.
3. Talk: *"look at my timeline and put a whoosh on every tag point"*.

## Setup with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "randosnap": {
      "command": "node",
      "args": ["C:/path/to/RandoSnap/agent/mcp-server.mjs"]
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
| `run_recipe` | Execute the user's Start Recipe (their standing workflow) |
| `sample_frames` / `compose_thumbnail` | Pick a moment and produce a 1280×720 thumbnail with subtitle + logo |
| `open_panel` | Open the booth / narration / thumbnail picker / settings for the user |

A conversation that works well:

> **You:** I dropped tags on all the beats. Make it fun.
> **Agent:** *(get_state → sees `hook 3.5s`, `reveal 8.2s`, `punchline 11s`)* placing a riser into the reveal, a party horn on it, pop on the punchline, and a title over the hook… *(screenshot)* here's how it looks — want the horn louder?

## The Start Recipe — your standing orders

`get_state` returns `startRecipe`: the user's instruction block (# lines are OFF). Treat active lines as your to-do when they say "run my workflow": app-native steps go through `run_recipe`/`cut_pauses`/`compose_thumbnail`; lines like `titles 5` mean YOU pitch five title options in chat and let them pick. Free-typed lines are custom standing instructions — follow them.

## How it works / security

- The app runs a **localhost-only** HTTP bridge (`127.0.0.1:5959`, override with `RS_AGENT_PORT`). Connections from other machines are refused; nothing is exposed to the network.
- `agent/mcp-server.mjs` is a dependency-free stdio MCP server that proxies tool calls to the bridge. If the app isn't running, tools return a clear "start the app" message instead of hanging.
- The agent edits the same React state you do — undo (Ctrl+Z) works on its changes, and yours and its edits interleave safely.

## For other agent frameworks

Skip MCP and hit the bridge directly:

```bash
curl http://127.0.0.1:5959/state
curl -X POST http://127.0.0.1:5959/command -d '{"action":"place_sfx","name":"pop","t":11.0}'
curl http://127.0.0.1:5959/screenshot -o now.png
```

Actions mirror the MCP tools (`docs/PROJECT_FORMAT.md` documents the state shape).
