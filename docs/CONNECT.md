# Connect your AI to VidHelm

VidHelm is built to be co-piloted: you edit in the GUI while your AI assistant edits the same timeline through a local bridge. This page gets **any** assistant connected in a couple of minutes.

> **Shortcut:** open VidHelm and click **🤖 AI** in the header. It runs live diagnostics, generates the exact config for your client with the real install path filled in, and walks you through fixes. Everything below is the long-hand version.

## How it fits together

```
your AI client  ──stdio──▶  agent/mcp-server.mjs  ──HTTP──▶  VidHelm app (127.0.0.1:5959)
(Claude, Cursor, …)          (21 MCP tools)                   (the editor you see)
```

- The **bridge** lives inside the app — it only exists while VidHelm is open, and only listens on localhost. Nothing leaves your machine.
- The **MCP server** is one dependency-free file your AI client launches with `node`. Repo clones have it at `agent/mcp-server.mjs`; installed apps ship it at `<install dir>\resources\agent\mcp-server.mjs` (the 🤖 AI panel shows and copies the exact path).
- **Requirements:** VidHelm running, plus Node.js 18+ on PATH for MCP clients (grab it at [nodejs.org](https://nodejs.org) — VidHelm itself doesn't need it).

## Zero-config clients (clone the repo, done)

| Client | Why it just works |
|---|---|
| **Claude Code** | `.mcp.json` at the repo root is auto-discovered — open the folder, approve the `vidhelm` server, done. The repo also ships a **skill** (`.claude/skills/vidhelm`) and `CLAUDE.md`, so Claude already knows the workflow. |
| **Cursor** | `.cursor/mcp.json` ships in the repo — approve when prompted. |
| **VS Code (Copilot agent mode)** | `.vscode/mcp.json` ships in the repo. |
| **Codex CLI / Gemini CLI / others that read `AGENTS.md`** | The workflow guide is in `AGENTS.md`; add the MCP server with your client's one-liner (below). |

Installed the app instead of cloning? Use your client's "add server" command with the path from the 🤖 AI panel, e.g. for Claude Code:

```bash
claude mcp add vidhelm -- node "C:\Program Files\VidHelm\resources\agent\mcp-server.mjs"
```

## Copy-paste clients

Ready-made snippets live in [`agent/clients/`](../agent/clients/) — replace `C:\\path\\to\\VidHelm` with your real path (or let the 🤖 AI panel generate them filled-in):

- **Claude Desktop** → `%APPDATA%\Claude\claude_desktop_config.json` (Settings → Developer → Edit Config), then fully restart
- **Windsurf** → `%USERPROFILE%\.codeium\windsurf\mcp_config.json`
- **Cline / Roo Code** → extension sidebar → MCP Servers → Configure
- **Codex CLI** → append `codex-cli.toml` to `%USERPROFILE%\.codex\config.toml`
- **Gemini CLI** → merge `gemini-cli.json` into `%USERPROFILE%\.gemini\settings.json`

All of these boil down to the same idea: *run `node <absolute path to mcp-server.mjs>` over stdio.* Any MCP-capable client not listed here will have an equivalent field.

## Local models (Ollama, LM Studio, Jan, Open WebUI, AMD Lemonade)

Everything works fully offline — the bridge, the MCP server, and a local model make a completely local editing copilot. The one requirement: **the model must support tool calling** (Qwen 2.5+, Llama 3.1+, Mistral, and similar do; old or heavily-quantized models often don't).

- **LM Studio** — native MCP: chat sidebar → Program → Install → Edit `mcp.json`, merge the standard `mcpServers` block (the 🤖 AI panel generates it with your real path). LM Studio has per-tool toggles — for small (7B) models enable just `get_state`, `screenshot`, `cut_pauses`, `place_sfx`, `export_video` so the tool list doesn't overwhelm the context.
- **Jan** — Settings → MCP Servers (enable the experimental toggle), same `mcpServers` shape.
- **Open WebUI** — speaks OpenAPI tool servers rather than MCP. Bridge it with [mcpo](https://github.com/open-webui/mcpo): `uvx mcpo --port 8001 -- node "<path>\agent\mcp-server.mjs"`, then add `http://localhost:8001` under Settings → Tools.
- **Ollama** — Ollama serves the model (`http://localhost:11434/v1`) but isn't an agent itself. Pair it with an MCP-capable front-end — LM Studio-style apps, Cline, Continue, or Open WebUI — point the front-end at Ollama for the model, and add VidHelm as an MCP server in that front-end.
- **AMD Lemonade Server** (Ryzen AI) — same pattern as Ollama: Lemonade exposes an OpenAI-compatible endpoint (`http://localhost:8000/api/v1`); use it as the model backend in Cline/Continue/Open WebUI/GAIA and add VidHelm's MCP server to the front-end. NPU/GPU acceleration comes free from Lemonade; VidHelm doesn't care where the tokens come from.
- **llama.cpp / vLLM / anything OpenAI-compatible** — same pattern again: front-end holds the MCP config, server holds the model.

Sanity-check the server itself anytime with `npm run selftest` (or `node agent/selftest.mjs`) — 13 protocol checks covering MCP handshake, strict-client probes, and OpenAI function-schema conversion rules.

## No MCP? Use the HTTP bridge directly

Any agent that can run shell commands can skip MCP entirely:

```bash
curl http://127.0.0.1:5959/ping        # is VidHelm up?
curl http://127.0.0.1:5959/state       # the whole timeline as JSON
curl -X POST http://127.0.0.1:5959/command -H "Content-Type: application/json" -d "{\"action\":\"cut_pauses\"}"
```

Paste [`agent/skills/vidhelm-skill.md`](../agent/skills/vidhelm-skill.md) into the assistant's custom instructions — it documents every action and the co-editing workflow in a form any model can follow.

## Teach your AI the workflow (the "skillset")

Connection gives your AI hands; these give it the know-how:

- **`AGENTS.md`** (repo root) — read automatically by Codex, Cursor, Gemini CLI, and most agentic tools
- **`CLAUDE.md`** + **`.claude/skills/vidhelm/`** — the same knowledge for Claude Code (the skill auto-triggers on "edit this video" -type asks)
- **`agent/skills/vidhelm-skill.md`** — portable copy for anything else (custom GPTs, rules files, system prompts)

All three teach the same things: read state first, use tag points as the shared language, run the user's Start Recipe, verify exports with the quality check.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "VidHelm is not running" from tools | The bridge only exists while the app is open. Start VidHelm (or `npm run dev`) and retry. |
| Config added but no tools appear | Fully restart the AI client — most read MCP configs only at startup. Check the JSON merged cleanly (no trailing commas). In Claude Code run `/mcp`. |
| Tools appear but every call fails | Open 🤖 AI → Test connection. Bridge green? Then the client can't launch the server: Node missing from PATH, or a stale path in `args`. |
| Bridge check is red / port conflict | Something else owns port 5959. Set `VH_AGENT_PORT=5960` (any free port) in the environment before launching VidHelm, **and** add `"env": {"VH_AGENT_PORT": "5960"}` to the server entry in your client config. |
| Firewall prompt on first run | Allow it — the bridge binds 127.0.0.1 only and rejects non-local connections. |
| Works in dev, not with the installed app | The installed app's server path is different: `<install dir>\resources\agent\mcp-server.mjs`. Re-copy the config from the 🤖 AI panel. |
| Local model connects but never calls tools | The model doesn't support tool calling, or 21 tools flooded a small context. Use a tool-capable model (Qwen 2.5+, Llama 3.1+, Mistral) and enable a subset of tools if your client has toggles. |
| Not sure if the server itself is healthy | `npm run selftest` — 13 protocol checks, works with or without the app open (open the app for the live end-to-end check). |

Still stuck? [Open an issue](https://github.com/RandoTechNerd/VidHelm/issues) with a screenshot of the 🤖 AI health check.
