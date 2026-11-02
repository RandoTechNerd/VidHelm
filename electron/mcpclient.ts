// How an AI client should start VidHelm's MCP server, and the one-click "Add to Claude Desktop".
// Electron-free and pure apart from fs, so npm run test:mcpclient checks it on temp folders.
//
// The server is plain Node, and every Electron app carries Node inside it: started with
// ELECTRON_RUN_AS_NODE=1, VidHelm.exe runs a script exactly like node.exe would, without opening
// a window. So an installed VidHelm hands clients its own exe and nobody has to install Node.js.
// A from-source run has no installed exe to offer and keeps using `node`.

import fs from 'node:fs'
import path from 'node:path'

export interface McpLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  /** true when no separate Node.js install is needed */
  builtIn: boolean
}

export function mcpLaunch(opts: { packaged: boolean; execPath: string; serverPath: string; port?: number; portOverridden?: boolean }): McpLaunch {
  const env: Record<string, string> = {}
  if (opts.packaged) env.ELECTRON_RUN_AS_NODE = '1'
  // a moved bridge port has to reach the server too, or it knocks on 5959 and finds nothing
  if (opts.portOverridden && opts.port) env.VH_AGENT_PORT = String(opts.port)
  return opts.packaged
    ? { command: opts.execPath, args: [opts.serverPath], env, builtIn: true }
    : { command: 'node', args: [opts.serverPath], env, builtIn: false }
}

/** Every claude_desktop_config.json Claude Desktop might read. The Microsoft Store / MSIX build
 *  can read a redirected copy under its package folder, so an existing copy there is updated too;
 *  the plain %APPDATA% one is always included (created when nothing exists yet). */
export function claudeDesktopConfigPaths(appData: string, localAppData: string): string[] {
  const out = [path.join(appData, 'Claude', 'claude_desktop_config.json')]
  try {
    const pk = path.join(localAppData, 'Packages')
    for (const d of fs.readdirSync(pk)) {
      if (!/^Claude_/i.test(d)) continue
      const f = path.join(pk, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json')
      if (fs.existsSync(f)) out.push(f)
    }
  } catch { /* no Store packages folder */ }
  return out
}

export interface AddResult {
  file: string
  ok: boolean
  /** created | added | updated | unchanged */
  change?: string
  backup?: string
  error?: string
}

/** Put a "vidhelm" entry into one Claude Desktop config, keeping everything else in it. A file
 *  that is not valid JSON is left alone (the user's other servers live there). */
export function addToClaudeDesktop(file: string, launch: McpLaunch, now = new Date()): AddResult {
  let cfg: any = {}
  let existed = false
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '')
    existed = true
    if (raw.trim()) cfg = JSON.parse(raw)
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('not a JSON object')
  } catch (e: any) {
    if (existed) return { file, ok: false, error: `Could not read it as JSON (${e?.message || e}), so it was left untouched. Fix or remove it, then try again.` }
  }
  const entry: any = { command: launch.command, args: launch.args }
  if (Object.keys(launch.env).length) entry.env = launch.env
  const servers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {}
  const before = servers.vidhelm
  if (before && JSON.stringify(before) === JSON.stringify(entry)) return { file, ok: true, change: 'unchanged' }
  cfg.mcpServers = { ...servers, vidhelm: entry }
  let backup: string | undefined
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (existed) {
      const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
      backup = `${file}.vidhelm-backup-${stamp}`
      fs.copyFileSync(file, backup)
    }
    // write beside it then rename, so a crash mid-write never leaves half a config
    const tmp = `${file}.vidhelm-tmp`
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, file)
  } catch (e: any) {
    return { file, ok: false, error: String(e?.message || e) }
  }
  return { file, ok: true, change: !existed ? 'created' : before ? 'updated' : 'added', backup }
}
