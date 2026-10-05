import { buildProject, downloadList, parseHandoff, readZip, entriesToWrite, entryVerdict, isCloudMediaUrl, type CloudManifest } from './cloudimport'
import { deflateRawSync } from 'node:zlib'
import assert from 'node:assert/strict'

/* build a tiny zip the way the cloud does (STORE), plus one DEFLATE entry, and read it back */
function crc32(b: Buffer): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1 } return (c ^ 0xffffffff) >>> 0 }
function zip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const parts: Buffer[] = [], cd: Buffer[] = []; let off = 0
  for (const e of entries) {
    const name = Buffer.from(e.name), body = e.deflate ? deflateRawSync(e.data) : e.data, method = e.deflate ? 8 : 0
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc32(e.data), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26)
    parts.push(lh, name, body)
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(method, 10); c.writeUInt32LE(crc32(e.data), 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(e.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42)
    cd.push(Buffer.concat([c, name])); off += lh.length + name.length + body.length
  }
  const cdb = Buffer.concat(cd); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdb.length, 12); end.writeUInt32LE(off, 16)
  return Buffer.concat([...parts, cdb, end])
}
const manifest: CloudManifest = {
  format: 'vidhelm-cloud-handoff', version: 1, project: { id: 'p1', name: 'Launch', review_url: 'https://app.vidhelm.com/r/x' },
  clips: [
    { id: 'a', name: 'talk.mov', kind: 'video', role: 'main', duration: 20, url: 'https://x/m/a', proxyUrl: 'https://x/p/a.mp4' },
    { id: 'b', name: 'still.png', kind: 'image', role: 'asset', duration: null, url: 'https://x/m/b', proxyUrl: null },
    { id: 'n', name: 'narration-1.mp3', kind: 'audio', role: 'sfx', duration: 3, url: 'https://x/s/n', proxyUrl: null, local: 'narration/narration-1.mp3' },
  ],
  drafts: [{ id: 'd', version: 2, duration: 12, url: 'https://x/d/2.mp4' }], latest_plan: 'plan.json', captions: null,
  notes: [{ mediaId: 'a', t: 4.5, text: 'delete before here' }],
}
const plan = { output: { width: 1080, height: 1920, fps: 30 }, segments: [{ src: 'a', in: 4.5, out: 12 }, { src: 'b', in: 0, out: 4, transition: { type: 'fade', d: 0.6 } }], titles: [{ at: 0.4, dur: 3, value: 'Hello', preset: 'title' }], narration: [{ at: 1, text: 'hi', file: 'n' }] }
const buf = zip([
  { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
  { name: 'plan.json', data: Buffer.from(JSON.stringify(plan)), deflate: true },
  { name: 'narration/narration-1.mp3', data: Buffer.from([1, 2, 3]) },
  { name: 'review-notes.json', data: Buffer.from(JSON.stringify({ notes: [{ t: 7, author: 'Sam', text: 'tighter' }] })) },
])
const entries = readZip(buf)
assert.equal(entries.length, 4)
const h = parseHandoff(entries)
assert.equal(h.manifest.project.name, 'Launch'); assert.equal(h.plan?.segments?.length, 2); assert.equal(h.reviews.length, 1)
const dl = downloadList(h.manifest)
assert.deepEqual(dl.map(d => d.file), ['talk.mp4', 'still.png', 'cloud-draft-v2.mp4'])   // proxy → .mp4, narration not downloaded
const proj = buildProject(h.manifest, h.plan, { a: { path: 'C:\\p\\talk.mp4', hasAudio: true }, b: { path: 'C:\\p\\still.png', hasAudio: false } }, { 'narration/narration-1.mp3': 'C:\\p\\cloud\\narration\\narration-1.mp3' }, h.reviews)
assert.equal(proj.orientation, 'portrait'); assert.equal(proj.mediaBin.length, 3)
const v1 = proj.clips.filter(c => c.trackId === 'v1'); assert.equal(v1.length, 2)
assert.equal(v1[0].sourceStart, 4.5); assert.equal(v1[0].duration, 7.5); assert.equal(v1[1].start, 6.9)   // 7.5 - 0.6 crossfade
assert.equal(proj.clips.filter(c => c.trackId === 'a1').length, 1); assert.equal(proj.texts.length, 1); assert.equal(proj.markers.length, 2)

/* zip slip: a crafted hand-off must never write outside <project>/cloud */
assert.deepEqual(entriesToWrite(entries).map(e => e.name).sort(), ['manifest.json', 'narration/narration-1.mp3', 'plan.json', 'review-notes.json'])
for (const bad of ['../x', '..\\x', 'a/../../x', 'C:/x', 'C:x', '/etc/x', 'narration/..', 'narration/../../run.cmd', 'transcripts//x.txt', 'x\0.txt', 'NOTES.md:evil', '../../../../AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/run.cmd'])
  assert.equal(entryVerdict(bad), 'unsafe', bad)
for (const skip of ['run.cmd', 'narration/CON.mp3', 'transcripts/x.', 'deep/a/b.txt', 'transcripts/sub/x.txt'])
  assert.equal(entryVerdict(skip), 'skip', skip)
for (const ok of ['manifest.json', 'plan.json', 'NOTES.md', 'README.md', 'review-notes.json', 'captions.srt', 'transcripts/talk.mov.txt', 'narration/narration-1.mp3'])
  assert.equal(entryVerdict(ok), 'write', ok)
// one bad name rejects the whole zip, before anything is written
const evil = readZip(zip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, { name: '../../../../AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/run.cmd', data: Buffer.from('calc') }]))
assert.throws(() => entriesToWrite(evil), /not a safe/)

/* downloads: only VidHelm Cloud's own media links, whatever the manifest says */
assert.equal(isCloudMediaUrl('https://app.vidhelm.com/m/m/p1/a-talk.mov?s=tok'), true)
for (const url of ['https://x/m/a', 'http://app.vidhelm.com/m/a', 'https://app.vidhelm.com.evil.com/m/a', 'https://evil.com/?https://app.vidhelm.com/m/a', 'http://127.0.0.1:5959/command', 'file:///C:/x', 'https://app.vidhelm.com/api/projects', 'https://u:p@app.vidhelm.com/m/a', 'not a url'])
  assert.equal(isCloudMediaUrl(url), false, url)
assert.equal(isCloudMediaUrl('http://localhost:8787/m/a', ['http://localhost:8787']), true)   // a dev origin only when configured
// a draft version from the manifest is a number, never a path
const sneaky = downloadList({ ...manifest, clips: [{ ...manifest.clips[0], name: '..\\..\\CON.mov' }], drafts: [{ id: 'd', version: '../../evil' as unknown as number, duration: 1, url: 'https://x' }] })
assert.ok(sneaky.every(d => !/[\\/]/.test(d.file) && !/^(con|nul|prn|aux)(\.|$)/i.test(d.file)), JSON.stringify(sneaky))
assert.equal(sneaky[1].file, 'cloud-draft-v0.mp4')
// the manifest does not choose the extension: nothing Explorer acts on (.url/.scf/.lnk/.ini) lands in the project
const base = manifest.clips[0]
const named = (name: string, kind: 'video' | 'audio' | 'image', proxyUrl: string | null = null) => downloadList({ ...manifest, drafts: [], clips: [{ ...base, name, kind, proxyUrl }] })[0].file
assert.equal(named('evil.url', 'video'), 'evil.mp4')
assert.equal(named('x.scf', 'audio'), 'x.mp3')
assert.equal(named('desktop.ini', 'image'), 'desktop.jpg')
assert.equal(named('shortcut.lnk', 'video', 'https://app.vidhelm.com/m/p'), 'shortcut.mp4')
assert.equal(named('Theme song', 'audio'), 'Theme song.mp3')
assert.equal(named('take 2.MOV', 'video'), 'take 2.MOV')
assert.equal(named('take 2.MOV', 'video', 'https://app.vidhelm.com/m/p'), 'take 2.mp4')
assert.equal(named('cover.png', 'image'), 'cover.png')
assert.equal(named('beat.wav', 'audio'), 'beat.wav')
assert.equal(named('.url', 'video'), 'clip.mp4')
assert.equal(named('a.mp4.url ', 'video'), 'a.mp4')
console.log('cloudimport: ok')
