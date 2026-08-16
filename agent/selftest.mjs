#!/usr/bin/env node
// VidHelm MCP self-test — verifies the MCP server speaks protocol-correct JSON-RPC and
// that its tool definitions are valid for every mainstream client (Claude, Cursor, VS Code,
// LM Studio, Jan, Cline, Codex, Gemini CLI — and OpenAI-compatible front-ends, which convert
// MCP tools to function schemas). Run:  node agent/selftest.mjs
// If VidHelm is open it also does a live end-to-end tool call through the bridge.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-server.mjs')
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${extra ? ' — ' + extra : ''}`) }
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
  // 1) initialize — echoes the client's protocol version (old or new date-based)
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } } })
  const init = await recv()
  ok(init.id === 1 && init.result?.serverInfo?.name === 'vidhelm', 'initialize handshake')
  ok(init.result?.protocolVersion === '2025-06-18', 'protocol version echo (new clients)')
  ok(typeof init.result?.instructions === 'string' && init.result.instructions.length > 200,
    'initialize carries usage instructions (installed-app users have no CLAUDE.md)')
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  // 2) tools/list — schema validity for MCP clients AND OpenAI-function conversion
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const tools = (await recv()).result?.tools || []
  ok(tools.length === 24, `tools/list returns 24 tools (got ${tools.length})`)
  const nameRe = /^[a-zA-Z0-9_-]{1,64}$/   // OpenAI/Gemini function-name constraint
  ok(tools.every(t => nameRe.test(t.name)), 'tool names valid for OpenAI-compatible clients')
  ok(tools.every(t => t.description && t.description.length < 1024), 'descriptions present and within limits')
  ok(tools.every(t => t.inputSchema?.type === 'object' && typeof t.inputSchema.properties === 'object'), 'every inputSchema is a valid object schema')
  ok(tools.every(t => (t.inputSchema.required || []).every(r => r in t.inputSchema.properties)), 'required fields all exist in properties')
  ok(tools.every(t => Object.values(t.inputSchema.properties).every(p => ['string', 'number', 'boolean'].includes(p.type))), 'property types are primitives (small-model friendly)')

  // 3) startup probes strict clients make — must answer, not error
  send({ jsonrpc: '2.0', id: 3, method: 'resources/list' })
  ok(Array.isArray((await recv()).result?.resources), 'resources/list answers empty list')
  send({ jsonrpc: '2.0', id: 4, method: 'prompts/list' })
  ok(Array.isArray((await recv()).result?.prompts), 'prompts/list answers empty list')
  send({ jsonrpc: '2.0', id: 5, method: 'ping' })
  ok(!!(await recv()).result, 'ping answered')

  // 4) tools/call — end-to-end through the bridge if the app is open, clean error if not
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
console.log(`\n${fail === 0 ? '✓ ALL CHECKS PASSED' : '✕ CHECKS FAILED'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
