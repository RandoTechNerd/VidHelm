# Ready-made client configs

Copy the file for your AI client, replace `C:\\path\\to\\VidHelm` with your actual install/clone path, and merge it into the client's config file. **Easier:** open VidHelm and click **🤖 AI** in the header, it generates these with the correct path filled in, runs live connection diagnostics, and has fixes for common snags. Full walkthroughs: [docs/CONNECT.md](../../docs/CONNECT.md).

| File | Client | Where it goes |
|---|---|---|
| - | Claude Code | nothing to copy, open the repo folder, `.mcp.json` is auto-discovered (installed app: `claude mcp add vidhelm -- node "<path>\agent\mcp-server.mjs"`) |
| `claude-desktop.json` | Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` |
| - | Cursor | nothing to copy - `.cursor/mcp.json` ships in the repo (global: `%USERPROFILE%\.cursor\mcp.json`, same shape) |
| - | VS Code Copilot | nothing to copy - `.vscode/mcp.json` ships in the repo |
| `windsurf.json` | Windsurf | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` |
| `cline.json` | Cline / Roo Code | extension sidebar → MCP Servers → Configure |
| `codex-cli.toml` | OpenAI Codex CLI | append to `%USERPROFILE%\.codex\config.toml` |
| `gemini-cli.json` | Gemini CLI | `%USERPROFILE%\.gemini\settings.json` |
| `lmstudio.json` | LM Studio (local models) | chat sidebar → Program → Install → Edit mcp.json |
| `jan.json` | Jan (local models) | Settings → MCP Servers (experimental toggle) |
| - | Open WebUI | via mcpo proxy: `uvx mcpo --port 8001 -- node "<path>\agent\mcp-server.mjs"`, then add `http://localhost:8001` as a tool server |
| - | Ollama / AMD Lemonade / llama.cpp | model servers, not agents, pair with an MCP front-end (LM Studio, Cline, Continue, Open WebUI); see [docs/CONNECT.md](../../docs/CONNECT.md#local-models-ollama-lm-studio-jan-open-webui-amd-lemonade) |

No MCP support at all? Paste [`agent/skills/vidhelm-skill.md`](../skills/vidhelm-skill.md) into your assistant's instructions, it teaches the plain-HTTP bridge instead.
