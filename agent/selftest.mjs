#!/usr/bin/env node
// VidHelm MCP self-test, verifies the MCP server speaks protocol-correct JSON-RPC and
// that its tool definitions are valid for every mainstream client (Claude, Cursor, VS Code,
// LM Studio, Jan, Cline, Codex, Gemini CLI, and OpenAI-compatible front-ends, which convert
// MCP tools to function schemas). Run:  node agent/selftest.mjs
// If VidHelm is open it also does a live end-to-end tool call through the bridge.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-server.mjs')
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' - ' + extra : ''}`) }
}

const srv = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''
const queue = []
srv.stdout.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (line) try { queue.push(JSON.parse(line)) } catch { queue.push({ __unparseable: line }) }
  }
})
const send = m => srv.stdin.write(JSON.stringify(m) + '\n')
const recv = (timeout = 8000) => new Promise((resolve, reject) => {
  const t0 = Date.now()
  const poll = () => queue.length ? resolve(queue.shift())
    : Date.now() - t0 > timeout ? reject(new Error('timeout waiting for response')) : setTimeout(poll, 20)
  poll()
})

try {
  // 1) initialize, echoes the client's protocol version (old or new date-based)
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } } })
  const init = await recv()
  ok(init.id === 1 && init.result?.serverInfo?.name === 'vidhelm', 'initialize handshake')
  ok(init.result?.protocolVersion === '2025-06-18', 'protocol version echo (new clients)')
  ok(typeof init.result?.instructions === 'string' && init.result.instructions.length > 200,
    'initialize carries usage instructions (installed-app users have no CLAUDE.md)')
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  // 2) tools/list, schema validity for MCP clients AND OpenAI-function conversion
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const tools = (await recv()).result?.tools || []
  ok(tools.length === 48, `tools/list returns 48 tools (got ${tools.length})`)
  const nameRe = /^[a-zA-Z0-9_-]{1,64}$/   // OpenAI/Gemini function-name constraint
  ok(tools.every(t => nameRe.test(t.name)), 'tool names valid for OpenAI-compatible clients')
  ok(tools.every(t => t.description && t.description.length < 1024), 'descriptions present and within limits')
  ok(tools.every(t => t.inputSchema?.type === 'object' && typeof t.inputSchema.properties === 'object'), 'every inputSchema is a valid object schema')
  ok(tools.every(t => (t.inputSchema.required || []).every(r => r in t.inputSchema.properties)), 'required fields all exist in properties')
  ok(tools.every(t => Object.values(t.inputSchema.properties).every(p => ['string', 'number', 'boolean'].includes(p.type))), 'property types are primitives (small-model friendly)')
  // Gemini-family function calling refuses an enum on anything but a string ("enum: only allowed for
  // STRING type"), and one bad property fails the whole tool list for that client
  ok(tools.every(t => Object.values(t.inputSchema.properties).every(p => !p.enum || (p.type === 'string' && p.enum.every(v => typeof v === 'string')))), 'enums only on string properties, with string values')
  const fmt = tools.find(t => t.name === 'set_format')?.inputSchema.properties || {}
  ok(String(fmt.resolution?.enum) === '4K,1440p,1080p,720p' && String(fmt.orientation?.enum) === 'landscape,portrait,square' && !fmt.fps?.enum && /24.*30.*60/.test(fmt.fps?.description || ''),
    'set_format offers only the formats the app has (an off-list "4k" blanked the editor); fps is named in words')
  ok(/never retry/i.test(tools.find(t => t.name === 'generate_clip')?.description || ''), 'generate_clip warns that a retry pays twice')
  ok(String(tools.find(t => t.name === 'add_clip')?.inputSchema.properties.track?.enum) === 'v1,v2,a1,a2', 'add_clip can reach the b-roll track (v2)')
  const openP = tools.find(t => t.name === 'open_project')?.inputSchema.properties || {}
  ok(openP.save?.type === 'boolean' && openP.force?.type === 'boolean' && /unsaved/i.test(tools.find(t => t.name === 'get_state')?.description || ''),
    'open_project offers save / force for unsaved work, and get_state says when there is some')

  // 2b) timeouts: one shared table, the proxy always outlasts the bridge, and the slow tools are slow
  const T = await import('./timeouts.mjs')
  const actions = [...Object.keys(T.ACTION_TIMEOUTS), 'get_state', 'add_text', 'set_theme', 'label_broll']
  ok(actions.every(a => T.proxyTimeoutMs({ action: a }) > T.bridgeTimeoutMs({ action: a }) && T.proxyTimeoutMs({ action: a, at: 'arcade' }) > T.bridgeTimeoutMs({ action: a, at: 'arcade' })),
    'MCP proxy timeout is longer than the bridge timeout for every action (the bridge reports first)')
  ok(T.bridgeTimeoutMs({ action: 'export' }) === 4 * 60 * 60 * 1000, 'export may run 4 h on both sides')
  ok(T.bridgeTimeoutMs({ action: 'generate_clip' }) >= 13 * 60 * 1000, 'generate_clip outlasts the 12 min video-model budget')
  const slow = ['make_captions', 'find_repeats', 'apply_takes', 'find_word', 'capture_site', 'make_score', 'make_sfx', 'search_sfx', 'download_sfx', 'open_project',
    'cut_pauses', 'run_recipe', 'sample_frames', 'compose_thumbnail', 'render_3d', 'prepare_analysis', 'scan_broll', 'plan_broll', 'place_broll', 'analyze_speech', 'find_phrase', 'cut_at_phrase', 'plan_framing', 'look_through']
  const short = slow.filter(a => T.bridgeTimeoutMs({ action: a }) < 20 * 60 * 1000)
  ok(!short.length, `every Whisper/render/network tool gets the long budget${short.length ? ' (short: ' + short.join(', ') + ')' : ''}`)
  ok(T.bridgeTimeoutMs({ action: 'add_text', at: 'arcade' }) >= 20 * 60 * 1000 && T.bridgeTimeoutMs({ action: 'generate_clip', at: 12 }) === T.bridgeTimeoutMs({ action: 'generate_clip' }),
    'a word anchor (string at) gets the long budget; a numeric at does not')
  ok(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'].every(a => T.bridgeTimeoutMs({ action: a }) === T.QUICK_MS),
    'an action named like an Object.prototype member gets the ordinary budget, not a function')
  const { readFileSync, existsSync } = await import('node:fs')
  const mainPath = path.join(path.dirname(SERVER), '..', 'electron', 'main.ts')
  if (existsSync(mainPath)) {   // repo checkouts only; an installed app ships no sources
    const mainSrc = readFileSync(mainPath, 'utf8'), mcpSrc = readFileSync(SERVER, 'utf8')
    ok(/bridgeTimeoutMs\(cmd\)/.test(mainSrc) && !/const LONG = \[/.test(mainSrc) && /import\('\.\/timeouts\.mjs'\)/.test(mcpSrc) && !/30 \* 60 \* 1000/.test(mcpSrc),
      'bridge and MCP proxy both read agent/timeouts.mjs (no private copies to drift)')
  }

  // 3) startup probes strict clients make, must answer, not error
  send({ jsonrpc: '2.0', id: 3, method: 'resources/list' })
  ok(Array.isArray((await recv()).result?.resources), 'resources/list answers empty list')
  send({ jsonrpc: '2.0', id: 4, method: 'prompts/list' })
  ok(Array.isArray((await recv()).result?.prompts), 'prompts/list answers empty list')
  send({ jsonrpc: '2.0', id: 5, method: 'ping' })
  ok(!!(await recv()).result, 'ping answered')

  // 4) tools/call, end-to-end through the bridge if the app is open, clean error if not
  send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_state', arguments: {} } })
  const call = await recv(25000)
  const text = call.result?.content?.[0]?.text || ''
  if (call.result?.isError) {
    ok(text.includes('not running'), 'app closed → clean "not running" message (open VidHelm for a live test)')
  } else {
    let state = null
    try { state = JSON.parse(text) } catch {}
    ok(state && 'clips' in state && 'startRecipe' in state, 'LIVE end-to-end: get_state through the running app')
  }

  // 5) unknown method still errors properly (JSON-RPC correctness)
  send({ jsonrpc: '2.0', id: 7, method: 'no/such/method' })
  ok((await recv()).error?.code === -32601, 'unknown methods get a JSON-RPC error')
} catch (e) {
  fail++; console.log(`  FAIL  ${e.message}`)
}

srv.kill()
console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✕ CHECKS FAILED'} - ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
