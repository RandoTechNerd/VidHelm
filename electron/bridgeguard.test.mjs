// Tests for the agent bridge's request guard (electron/bridgeguard.ts). Run: node electron/bridgeguard.test.mjs
// A real HTTP server with the guard in front, hit by the clients that must keep working (the MCP
// server's http.request, curl-style requests, Node's fetch) and by what a web page can send.
import { build } from 'esbuild'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = await build({ entryPoints: [path.join(here, 'bridgeguard.ts')], bundle: false, write: false, format: 'esm', target: 'node18' })
const { bridgeRefusal, commandForEditor, replyAlias, replyKey } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))

let pass = 0, fail = 0
const ok = (c, l) => { if (c) { pass++; console.log('  PASS ', l) } else { fail++; console.log('  FAIL ', l) } }

const srv = http.createServer((req, res) => {
  const why = bridgeRefusal(req.headers, srv.address().port)
  res.writeHead(why ? 403 : 200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(why ? { error: why } : { ok: true }))
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const port = srv.address().port
const raw = (headers, method = 'POST', host = `127.0.0.1:${port}`) => new Promise(resolve => {
  const req = http.request({ host: '127.0.0.1', port, path: '/command', method, headers: { Host: host, ...headers }, setHost: false }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
  req.on('error', () => resolve(-1))
  req.end(method === 'POST' ? '{"action":"get_state"}' : undefined)
})

console.log('\n-- the clients that must keep working --')
ok(await raw({ 'Content-Type': 'application/json' }) === 200, 'the MCP server (http.request with JSON)')
ok(await raw({ 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'curl/8' }) === 200, 'curl -d without -H, as docs/AGENT.md shows it')
ok(await raw({}, 'GET') === 200, 'GET /state and /screenshot from a script')
ok(await raw({}, 'GET', `localhost:${port}`) === 200, 'addressed as localhost')
const nodeFetch = await fetch(`http://127.0.0.1:${port}/command`, { method: 'POST', body: '{"action":"get_state"}' })
ok(nodeFetch.status === 200, `Node's fetch (sends Sec-Fetch-Mode, no Origin) (got ${nodeFetch.status})`)

console.log('\n-- what a web page can send --')
ok(await raw({ Origin: 'https://evil.example', 'Content-Type': 'text/plain' }) === 403, 'a no-cors text/plain POST from a site (Origin)')
ok(await raw({ Origin: 'null', 'Content-Type': 'text/plain' }) === 403, 'a sandboxed iframe or file page (Origin: null)')
ok(await raw({ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors' }, 'GET') === 403, 'a browser GET (Sec-Fetch-Site)')
ok(await raw({}, 'GET', `rebind.evil.example:${port}`) === 403, 'DNS rebinding: a foreign Host reading /state or /screenshot')
ok(await raw({}, 'GET', '127.0.0.1') === 403, 'a Host without the port')
ok(await raw({}, 'GET', '') === 403, 'no Host at all')

console.log('\n-- the pure function --')
ok(bridgeRefusal({ host: '127.0.0.1:5959' }, 5959) === null, 'plain local request served')
ok(/web pages/.test(bridgeRefusal({ host: '127.0.0.1:5959', origin: 'http://localhost:5173' }, 5959) || ''), 'even a localhost page is a web page')
ok(bridgeRefusal({ host: '[::1]:5959' }, 5959) === null, 'IPv6 loopback by name')
ok(bridgeRefusal({ host: '127.0.0.1:5960' }, 5959) !== null, 'another port in Host is refused')

console.log('\n-- the editor\'s answer reaches the request that asked --')
// A stand-in for the editor window exactly as src/App.tsx answers today (it echoes cmd.id) and as it
// will once it echoes reqId; and the bridge's pending table, as electron/main.ts keeps it.
const run = async (editor, cmds) => {
  const pending = new Map(); let seq = 0
  const answer = msg => { const k = replyKey(pending, msg); const p = k === undefined ? undefined : pending.get(k); if (p) { pending.delete(k); p.done(msg.result) } }
  const asks = cmds.map(cmd => new Promise(resolve => {
    const id = ++seq
    const timer = setTimeout(() => { pending.delete(id); resolve({ timedOut: true }) }, 300)
    pending.set(id, { alias: replyAlias(cmd), done: r => { clearTimeout(timer); resolve(r) } })
    const sent = commandForEditor(cmd, id)
    setTimeout(() => answer(editor(sent)), 5 + Math.random() * 20)   // answers arrive in any order
  }))
  return Promise.all(asks)
}
const exec = c => c.action === 'delete_item' ? { ok: true, deleted: c.id } : c.action === 'label_broll' ? { ok: true, id: c.id } : { ok: true, action: c.action }
const todayEditor = c => ({ id: c.id, result: exec(c) })                 // App.tsx as it is
const nextEditor = c => ({ id: c.id, reqId: c.reqId, result: exec(c) })  // App.tsx echoing reqId
for (const [name, editor] of [['today\'s editor', todayEditor], ['an editor that echoes reqId', nextEditor]]) {
  const res = await run(editor, [{ action: 'delete_item', id: 'clip-7' }, { action: 'get_state' }, { action: 'label_broll', id: 'beans.mp4', labels: 'coffee' }, { action: 'delete_item', id: 3 }, { action: 'add_text', text: 'hi' }])
  ok(res[0].deleted === 'clip-7' && res[2].id === 'beans.mp4' && res[3].deleted === 3 && res[1].action === 'get_state' && res[4].action === 'add_text' && !res.some(r => r.timedOut),
    `${name}: delete_item and label_broll answer instead of timing out, and every answer reaches its own request (${JSON.stringify(res.map(r => r.deleted ?? r.id ?? r.action ?? r))})`)
}
ok(commandForEditor({ action: 'delete_item', id: 'x' }, 9).id === 'x' && commandForEditor({ action: 'delete_item', id: 'x' }, 9).reqId === 9, 'the command keeps its own id; the request\'s travels as reqId')
ok(commandForEditor({ action: 'get_state' }, 9).id === 9, 'a command without one still carries the request\'s id as id (editors that predate reqId)')
ok(replyKey(new Map([[4, {}]]), { id: 4, reqId: 5 }) === undefined, 'a reqId that is no longer pending matches nothing (no guessing)')
ok(replyKey(new Map([[4, { alias: '4' }], [5, {}]]), { id: 4 }) === 4 && replyKey(new Map([[4, { alias: 'x' }]]), { id: 4 }) === undefined, 'a numeric item id is matched as an item id, not as a request id')

srv.close()
console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'} - ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
