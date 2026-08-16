// Finding a 3D model by its bytes, and digging one out of an HTML wrapper page.
// No Electron/fs imports so the logic can be tested standalone (see docs/ARCHITECTURE.md).

export type ModelKind = 'stl' | '3mf' | 'obj' | 'glb' | 'gltf'

/** Identify a model from its contents — extensions inside HTML wrappers are unreliable. */
export const sniffModel = (buf: Buffer): ModelKind | null => {
  if (buf.length < 16) return null
  if (buf.toString('latin1', 0, 4) === 'glTF') return 'glb'
  if (buf[0] === 0x50 && buf[1] === 0x4b) return '3mf'                                  // zip container
  if (buf.length >= 84 && 84 + buf.readUInt32LE(80) * 50 === buf.length) return 'stl'   // binary STL
  const head = buf.toString('latin1', 0, Math.min(buf.length, 4096))
  if (/^\s*solid\b/i.test(head) && /facet\s+normal/i.test(head)) return 'stl'
  if (/^\s*[{[]/.test(head) && /"asset"\s*:/.test(head) && /"version"/.test(head)) return 'gltf'
  if (/^[ \t]*(v|vn|vt)\s+-?[\d.]/m.test(head) && /^[ \t]*(f|g|o|usemtl|mtllib)\s/m.test(head)) return 'obj'
  return null
}

export const decodeEntities = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&')

export type HtmlModelHit =
  | { kind: 'file'; path: string; how: string }
  | { kind: 'data'; ext: ModelKind; buf: Buffer; how: string }

/**
 * Look for a model in an HTML page, in the order viewer exports actually use it:
 * a model file sitting beside the page, a base64 payload, then inline model text.
 * `resolveSibling` maps a relative reference to an absolute path (or null if missing),
 * keeping filesystem access out of this module.
 */
export const findModelInHtml = (html: string, resolveSibling: (ref: string) => string | null): HtmlModelHit | null => {
  for (const m of html.matchAll(/["'(]([^"'()<>\s]+?\.(?:stl|3mf|obj|glb|gltf))["')]/gi)) {
    const ref = m[1]
    if (/^(https?:|data:|\/\/)/i.test(ref)) continue
    const hit = resolveSibling(decodeURIComponent(ref.replace(/^\.\//, '')))
    if (hit) return { kind: 'file', path: hit, how: `linked file ${hit.split(/[\\/]/).pop()}` }
  }

  let tried = 0
  for (const m of html.matchAll(/base64,\s*([A-Za-z0-9+/=\s]{200,})/g)) {
    if (++tried > 25) break
    const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64')
    const ext = sniffModel(buf)
    if (ext) return { kind: 'data', ext, buf, how: `embedded ${ext.toUpperCase()}` }
  }

  for (const m of html.matchAll(/<(script|pre|textarea)\b[^>]*>([\s\S]{40,}?)<\/\1>/gi)) {
    const buf = Buffer.from(decodeEntities(m[2]), 'utf8')
    const ext = sniffModel(buf)
    if (ext === 'obj' || ext === 'stl' || ext === 'gltf') return { kind: 'data', ext, buf, how: `inline ${ext.toUpperCase()}` }
  }
  return null
}
