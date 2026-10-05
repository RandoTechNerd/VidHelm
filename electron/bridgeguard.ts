/* Who may talk to the agent bridge (electron/main.ts, http://127.0.0.1:5959). Pure, so it is tested
 * without Electron: node electron/bridgeguard.test.mjs
 *
 * Listening on 127.0.0.1 keeps other machines out, but not the web pages open on THIS one: any site
 * can send a request to 127.0.0.1, and a text/plain POST needs no CORS preflight, so the remote
 * address alone let a page drive the editor (export over files, spend the AI video key, wipe the
 * timeline). A DNS-rebinding page could even read /state and /screenshot back. */

type Headers = Record<string, string | string[] | undefined>

/** Why a request is refused, or null to serve it. */
export function bridgeRefusal(headers: Headers, port: number): string | null {
  // Browsers send Origin on every POST (no-cors and form posts included) and Sec-Fetch-Site on every
  // request; the MCP server, curl, Python and the Connect panel send neither. Node's own fetch sends
  // Sec-Fetch-Mode but not these two, so scripts using it keep working.
  if (headers.origin !== undefined || headers['sec-fetch-site'] !== undefined) return 'the agent bridge does not accept requests from web pages'
  // A rebinding page's hostname, now resolving to 127.0.0.1, still arrives as the Host header.
  const host = String(headers.host || '').toLowerCase()
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && host !== `[::1]:${port}`) return `use http://127.0.0.1:${port}`
  return null
}

/* ---- matching the editor's answer to the request ----
 * The bridge forwards each command to the editor window and waits for the answer to come back with
 * the request's correlation id. That id used to travel as `id`, spread UNDER the command, so a
 * command with an `id` of its own (delete_item, label_broll) overwrote it: the editor did the work,
 * answered under the item's id, nothing matched, and 15 s later the agent was told the command had
 * timed out and might still be running. Every time, for the b-roll labelling loop. Now the
 * correlation id travels as `reqId` beside the command, which keeps its own `id`. */

export interface PendingReply { /** the command's own `id`, which an editor that predates `reqId` answers under */ alias?: string }

/** What the editor window is sent for request `reqId`. A command without its own `id` still carries the request's there, for editors that predate `reqId`. */
export function commandForEditor<T extends Record<string, unknown>>(cmd: T, reqId: number): T & { id: unknown; reqId: number } {
  return { ...cmd, id: cmd.id !== undefined ? cmd.id : reqId, reqId }
}

/** The pending request's alias for `cmd` (see PendingReply). */
export const replyAlias = (cmd: Record<string, unknown>): string | undefined => cmd.id !== undefined && cmd.id !== null ? String(cmd.id) : undefined

/** Which pending request an editor answer belongs to, or undefined (a late or duplicate answer). */
export function replyKey(pending: Map<number, PendingReply>, msg: { id?: unknown; reqId?: unknown } | null | undefined): number | undefined {
  if (typeof msg?.reqId === 'number') return pending.has(msg.reqId) ? msg.reqId : undefined
  // an editor that predates reqId answers under cmd.id: the request's own id, or the command's
  if (typeof msg?.id === 'number' && pending.get(msg.id) && pending.get(msg.id)!.alias === undefined) return msg.id
  if (msg?.id === undefined || msg?.id === null) return undefined
  const alias = String(msg.id)
  for (const [k, p] of pending) if (p.alias === alias) return k   // oldest first
  return undefined
}
