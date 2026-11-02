import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mcpLaunch, addToClaudeDesktop, claudeDesktopConfigPaths } from './mcpclient'

const exe = 'C:\\Users\\a\\AppData\\Local\\Programs\\VidHelm\\VidHelm.exe'
const srv = 'C:\\Users\\a\\AppData\\Local\\Programs\\VidHelm\\resources\\agent\\mcp-server.mjs'

// installed: the app's own exe runs the server as Node, no Node.js install needed
const inst = mcpLaunch({ packaged: true, execPath: exe, serverPath: srv })
assert.deepEqual(inst, { command: exe, args: [srv], env: { ELECTRON_RUN_AS_NODE: '1' }, builtIn: true })
// from source: plain node, no env
assert.deepEqual(mcpLaunch({ packaged: false, execPath: 'electron.exe', serverPath: srv }), { command: 'node', args: [srv], env: {}, builtIn: false })
// a moved port travels with the config; the default one stays out of it
assert.equal(mcpLaunch({ packaged: true, execPath: exe, serverPath: srv, port: 5960, portOverridden: true }).env.VH_AGENT_PORT, '5960')
assert.equal(mcpLaunch({ packaged: true, execPath: exe, serverPath: srv, port: 5959 }).env.VH_AGENT_PORT, undefined)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-mcpclient-'))
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'))
const when = new Date('2026-11-01T18:00:00Z')

// no config yet: created, with folders, no backup
const fresh = path.join(tmp, 'a', 'Claude', 'claude_desktop_config.json')
let r = addToClaudeDesktop(fresh, inst, when)
assert.equal(r.ok, true); assert.equal(r.change, 'created'); assert.equal(r.backup, undefined)
assert.deepEqual(read(fresh).mcpServers.vidhelm, { command: exe, args: [srv], env: { ELECTRON_RUN_AS_NODE: '1' } })
// same again: nothing written, no backup piling up
r = addToClaudeDesktop(fresh, inst, when)
assert.equal(r.change, 'unchanged'); assert.equal(fs.readdirSync(path.dirname(fresh)).length, 1)

// an existing config keeps its other servers and settings, gets a backup, and loses no keys
const busy = path.join(tmp, 'b.json')
const orig = '\uFEFF{"preferences":{"x":true},"mcpServers":{"other":{"command":"uvx","args":["thing"]}}}'
fs.writeFileSync(busy, orig)
r = addToClaudeDesktop(busy, inst, when)
assert.equal(r.change, 'added')
const after = read(busy)
assert.deepEqual(after.preferences, { x: true })
assert.deepEqual(after.mcpServers.other, { command: 'uvx', args: ['thing'] })
assert.equal(after.mcpServers.vidhelm.command, exe)
assert.equal(fs.readFileSync(r.backup!, 'utf8'), orig)
assert.ok(!fs.existsSync(busy + '.vidhelm-tmp'))

// an old node-based entry is replaced
fs.writeFileSync(busy, JSON.stringify({ mcpServers: { vidhelm: { command: 'node', args: ['old.mjs'] } } }))
r = addToClaudeDesktop(busy, inst, new Date('2026-11-01T18:00:05Z'))
assert.equal(r.change, 'updated'); assert.equal(read(busy).mcpServers.vidhelm.command, exe)

// broken JSON is never overwritten
const broken = path.join(tmp, 'c.json')
fs.writeFileSync(broken, '{ "mcpServers": { , }')
r = addToClaudeDesktop(broken, inst, when)
assert.equal(r.ok, false); assert.match(r.error!, /left untouched/)
assert.equal(fs.readFileSync(broken, 'utf8'), '{ "mcpServers": { , }')
// an empty file counts as an empty config
const empty = path.join(tmp, 'd.json'); fs.writeFileSync(empty, '')
assert.equal(addToClaudeDesktop(empty, inst, when).ok, true)

// config paths: %APPDATA% always, a Store package copy only when it exists
const appData = path.join(tmp, 'Roaming'), local = path.join(tmp, 'Local')
assert.deepEqual(claudeDesktopConfigPaths(appData, local), [path.join(appData, 'Claude', 'claude_desktop_config.json')])
const pkgCfg = path.join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json')
fs.mkdirSync(path.dirname(pkgCfg), { recursive: true }); fs.writeFileSync(pkgCfg, '{}')
fs.mkdirSync(path.join(local, 'Packages', 'Claude_nocfg'), { recursive: true })
fs.mkdirSync(path.join(local, 'Packages', 'NotClaude_1', 'LocalCache', 'Roaming', 'Claude'), { recursive: true })
assert.deepEqual(claudeDesktopConfigPaths(appData, local), [path.join(appData, 'Claude', 'claude_desktop_config.json'), pkgCfg])

fs.rmSync(tmp, { recursive: true, force: true })
console.log('mcpclient: all checks passed')
