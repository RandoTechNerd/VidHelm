/* VidHelm Cloud hand-off import: read the zip the cloud produces (manifest.json + plan.json + notes +
 * narration), and turn it into a desktop project: media bin, v1 clips in plan order, narration on a1,
 * titles as texts, every note as a tag point. Pure logic (no Electron), so it has a test: npm run test:cloudimport. */
import { inflateRawSync } from 'node:zlib'

export interface ZipEntry { name: string; data: Buffer }

/** Minimal zip reader: STORE and DEFLATE entries, no encryption, no zip64. */
export function readZip(buf: Buffer): ZipEntry[] {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory)')
  const count = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16)
  const out: ZipEntry[] = []
  let p = cdOff
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory')
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8')
    p += 46 + nlen + xlen + clen
    const lnlen = buf.readUInt16LE(lho + 26), lxlen = buf.readUInt16LE(lho + 28)
    const start = lho + 30 + lnlen + lxlen
    const raw = buf.subarray(start, start + csize)
    if (name.endsWith('/')) continue
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null
    if (!data) throw new Error(`unsupported compression (${method}) for ${name}`)
    if (data.length !== usize) throw new Error(`size mismatch for ${name}`)
    out.push({ name, data })
  }
  return out
}

/* ---- what may be written to disk -------------------------------------------------------------
 * A hand-off zip is a file people pass around (Discord, email), so its entry names are untrusted.
 * Written blindly under <project>/cloud, a name like '../../../AppData/Roaming/Microsoft/Windows/Start
 * Menu/Programs/Startup/run.cmd' lands outside the project (zip slip). Only the files the cloud
 * actually produces are written, and one bad name rejects the whole zip before anything is written. */

/** Windows device names: 'CON.txt' opens the console, not a file. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
const KNOWN_ROOT = /^(manifest\.json|plan[\w.-]*\.json|NOTES\.md|README\.md|review-notes\.json|captions\.srt)$/
const KNOWN_DIR = /^(transcripts|narration)\/[^/]+$/

/**
 * 'write' = a file the cloud makes, safe to put under <project>/cloud.
 * 'skip' = harmless but not ours (or a name Windows would mangle), left in the zip.
 * 'unsafe' = tries to leave the folder (.., absolute, drive letter, stream, NUL): reject the zip.
 */
export function entryVerdict(name: string): 'write' | 'skip' | 'unsafe' {
  if (!name || name.includes('\0') || name.includes(':') || name.includes('\\') || name.startsWith('/')) return 'unsafe'
  const parts = name.split('/')
  if (parts.some(seg => seg === '' || seg === '.' || seg === '..')) return 'unsafe'
  // Windows drops trailing dots and spaces, so 'x.' and 'x ' would not be the file that was checked
  if (parts.some(seg => /[. ]$/.test(seg) || DEVICE_NAME.test(seg))) return 'skip'
  return KNOWN_ROOT.test(name) || KNOWN_DIR.test(name) ? 'write' : 'skip'
}

/** The entries to unpack. Throws (before anything touches the disk) if any name is unsafe. */
export function entriesToWrite(entries: ZipEntry[]): ZipEntry[] {
  const bad = entries.filter(e => entryVerdict(e.name) === 'unsafe').map(e => e.name)
  if (bad.length) throw new Error(`this zip is not a safe VidHelm Cloud hand-off (entry names that leave the project folder: ${bad.slice(0, 3).join(', ')})`)
  return entries.filter(e => entryVerdict(e.name) === 'write')
}

/** Where downloads may come from. The manifest is as untrusted as the zip, so its own review_url proves nothing. */
export const CLOUD_ORIGINS = ['https://app.vidhelm.com']

/** A media link VidHelm Cloud itself produces: an allowed origin and its /m/ streaming path, nothing else (no localhost, no other hosts). */
export function isCloudMediaUrl(url: string, origins: string[] = CLOUD_ORIGINS): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.username || u.password) return false
  return origins.includes(u.origin) && u.pathname.startsWith('/m/')
}

export interface CloudClip { id: string; name: string; kind: 'video' | 'audio' | 'image'; role: string; duration: number | null; width?: number | null; height?: number | null; url: string; proxyUrl: string | null; local?: string | null }
export interface CloudManifest {
  format: string; version: number; project: { id: string; name: string; review_url: string }
  clips: CloudClip[]; drafts: Array<{ id: string; version: number; duration: number | null; url: string; summary?: string | null; prompt?: string | null }>
  latest_plan: string | null; captions: string | null; notes: Array<{ mediaId: string | null; t: number | null; text: string }>
}
export interface CloudPlan {
  output?: { width: number; height: number; fps?: number }
  segments?: Array<{ src: string; in: number; out: number; mute?: boolean; speed?: number; audio?: string; transition?: { type: string; d: number } }>
  titles?: Array<{ at: number; dur: number; value: string; preset: string }>
  narration?: Array<{ at: number; text: string; file?: string }>
}

export function parseHandoff(entries: ZipEntry[]): { manifest: CloudManifest; plan: CloudPlan | null; notesMd: string | null; reviews: Array<{ t: number; author: string; text: string }> } {
  const get = (n: string) => entries.find(e => e.name === n)?.data.toString('utf8') ?? null
  const mtxt = get('manifest.json')
  if (!mtxt) throw new Error('manifest.json missing: this is not a VidHelm Cloud hand-off')
  const manifest = JSON.parse(mtxt) as CloudManifest
  if (manifest.format !== 'vidhelm-cloud-handoff') throw new Error('manifest is not a VidHelm Cloud hand-off')
  const ptxt = manifest.latest_plan ? get(manifest.latest_plan) : null
  const plan = ptxt ? JSON.parse(ptxt) as CloudPlan : null
  let reviews: Array<{ t: number; author: string; text: string }> = []
  const rtxt = get('review-notes.json'); if (rtxt) { try { reviews = (JSON.parse(rtxt).notes || []) } catch { /* optional */ } }
  return { manifest, plan, notesMd: get('NOTES.md'), reviews }
}

/**
 * The extensions a downloaded file may end in, by kind; the first is the default. The name comes from
 * the untrusted manifest, so it does not get to choose: 'x.url', 'x.scf', 'x.lnk' or 'desktop.ini'
 * dropped into the new project folder can make Explorer fetch an attacker's UNC icon path (and leak
 * the user's NTLM hash) the moment the folder is shown. Anything off the list is replaced.
 */
const KIND_EXT: Record<string, string[]> = {
  video: ['mp4', 'mov', 'm4v', 'mkv', 'webm'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac'],
  image: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
}

/** What to download: every clip (proxy when it exists, it is the uniform H.264), every finished draft, and narration from the zip. */
export function downloadList(m: CloudManifest): Array<{ url: string; file: string; kind: string; clipId?: string }> {
  const seen = new Set<string>(), out: Array<{ url: string; file: string; kind: string; clipId?: string }> = []
  // no separators, no control characters, no device names, no trailing dot/space: every file lands in the project folder itself
  // eslint-disable-next-line no-control-regex
  const safe = (n: string) => { const f = String(n || 'clip').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'clip'; return DEVICE_NAME.test(f) ? '_' + f : f }
  for (const c of m.clips) {
    if (c.local) continue                       // narration is inside the zip
    // a proxy is always the H.264 mp4; otherwise keep the name's extension only when it is one of
    // this kind's (generated music arrives with none at all)
    const allowed = c.proxyUrl ? ['mp4'] : KIND_EXT[c.kind] || KIND_EXT.video
    const extOf = (f: string) => /\.([a-z0-9]{1,5})$/i.exec(f)?.[1]?.toLowerCase()
    let file = safe(c.name), ext = extOf(file)
    if (!ext || !allowed.includes(ext)) {
      if (ext) { file = file.slice(0, -(ext.length + 1)).replace(/[. ]+$/, ''); ext = extOf(file) }   // 'a.mp4.url' -> 'a.mp4'
      if (!ext || !allowed.includes(ext)) file += '.' + allowed[0]
    }
    if (file.startsWith('.')) file = 'clip' + file
    while (seen.has(file.toLowerCase())) file = file.replace(/(\.[^.]+)$/, '-2$1'); seen.add(file.toLowerCase())
    out.push({ url: c.proxyUrl || c.url, file, kind: c.kind, clipId: c.id })
  }
  // the version is a number from an untrusted manifest: '../../x' must not become part of a path
  for (const d of m.drafts) out.push({ url: d.url, file: `cloud-draft-v${Math.max(0, Math.floor(Number(d.version))) || 0}.mp4`, kind: 'draft' })
  return out
}

const rid = () => Math.random().toString(36).slice(2, 10)

/** Build the project.vidhelm.json content. `files` maps clip id → absolute path; `narration` maps zip name → absolute path. */
export function buildProject(m: CloudManifest, plan: CloudPlan | null, files: Record<string, { path: string; hasAudio: boolean }>, narration: Record<string, string>, reviews: Array<{ t: number; author: string; text: string }>) {
  const mediaBin: Array<Record<string, unknown>> = []
  const binIdByClip: Record<string, string> = {}
  for (const c of m.clips) {
    const f = c.local ? (narration[c.local] ? { path: narration[c.local], hasAudio: true } : null) : files[c.id]
    if (!f) continue
    const id = rid(); binIdByClip[c.id] = id
    mediaBin.push({ id, name: c.name, path: f.path, type: c.kind, duration: c.duration ?? (c.kind === 'image' ? 5 : 5), hasVideo: c.kind !== 'audio', hasAudio: c.kind === 'audio' ? true : f.hasAudio })
  }
  const clips: Array<Record<string, unknown>> = []
  const texts: Array<Record<string, unknown>> = []
  let t = 0
  for (const s of plan?.segments || []) {
    const bin = binIdByClip[s.src]; if (!bin) continue
    const speed = s.speed || 1
    const dur = Math.max(0.1, (s.out - s.in) / speed)
    const tr = clips.length && s.transition ? Math.min(s.transition.d, dur * 0.45) : 0
    t -= tr
    clips.push({ id: 'c' + rid(), mediaId: bin, type: m.clips.find(c => c.id === s.src)?.kind === 'image' ? 'image' : 'video', trackId: 'v1', start: +t.toFixed(3), duration: +dur.toFixed(3), sourceStart: s.in, volume: s.mute ? 0 : 1, fadeIn: tr ? +tr.toFixed(3) : 0, fadeOut: 0, aFadeIn: 0.012, aFadeOut: 0.012 })
    if (s.audio && binIdByClip[s.audio]) clips.push({ id: 'c' + rid(), mediaId: binIdByClip[s.audio], type: 'audio', trackId: 'a1', start: +t.toFixed(3), duration: +dur.toFixed(3), sourceStart: 0, volume: 1, fadeIn: 0, fadeOut: 0.05 })
    t += dur
  }
  for (const n of plan?.narration || []) {
    if (!n.file || !binIdByClip[n.file]) continue
    const bin = mediaBin.find(b => b.id === binIdByClip[n.file!])
    clips.push({ id: 'c' + rid(), mediaId: binIdByClip[n.file], type: 'audio', trackId: 'a1', start: n.at, duration: Number(bin?.duration) || 3, sourceStart: 0, volume: 1, fadeIn: 0, fadeOut: 0.05 })
  }
  // the cloud's music bed goes on a1 under everything, quiet
  const musicSrc = (plan as { music?: { src?: string; gain?: number } } | null)?.music?.src
  if (musicSrc && binIdByClip[musicSrc]) clips.push({ id: 'c' + rid(), mediaId: binIdByClip[musicSrc], type: 'audio', trackId: 'a1', start: 0, duration: +Math.max(1, t).toFixed(3), sourceStart: 0, volume: (plan as { music?: { gain?: number } }).music?.gain ?? 0.3, fadeIn: 0.8, fadeOut: 1.5 })
  for (const tt of plan?.titles || []) {
    const y = tt.preset === 'lower-third' ? 0.82 : tt.preset === 'caption' ? 0.9 : 0.5
    texts.push({ id: 't' + rid(), text: tt.value, start: tt.at, duration: tt.dur, x: 0.5, y, fontSize: tt.preset === 'title' ? 84 : 44, color: '#ffffff', fadeIn: 0.3, fadeOut: 0.3, box: tt.preset !== 'title', boxOpacity: 0.55 })
  }
  const markers: Array<Record<string, unknown>> = []
  for (const n of m.notes) if (n.t != null) markers.push({ id: 'm' + rid(), t: n.t, label: n.text.slice(0, 60), color: '#20c4ae' })
  for (const r of reviews) markers.push({ id: 'm' + rid(), t: r.t, label: `${r.author}: ${r.text}`.slice(0, 60), color: '#f472b6' })
  const w = plan?.output?.width || 1920, h = plan?.output?.height || 1080
  return {
    version: 2, orientation: w > h ? 'landscape' : w < h ? 'portrait' : 'square', resolution: Math.max(w, h) >= 3840 ? '4K' : Math.max(w, h) >= 1920 ? '1080p' : '720p', fps: plan?.output?.fps || 30,
    masterVolume: 1, exportQuality: 'high', mediaBin, clips, texts, markers,
    cloud: { project: m.project, imported_at: new Date().toISOString() },
  }
}
