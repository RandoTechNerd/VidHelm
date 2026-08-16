// Generates the app icons from one source design: build/icon.ico (Windows exe, installer,
// Start-menu and desktop shortcuts) and public/icon.png (the window/taskbar icon in dev).
// Run:  node scripts/make-icons.mjs      (needs sharp - `npm i -D sharp` if it is missing)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
let sharp
try { sharp = (await import('sharp')).default }
catch { console.error('sharp is required to regenerate icons:  npm i -D sharp'); process.exit(1) }

const BLUE = '#3b82f6', DEEP = '#0a0d14', MID = '#16233c'

// The helm: outer ring, hub, eight spokes, and the play triangle that makes it a video app.
const helm = (cx, cy, r, stroke) => {
  const spokes = [0, 45, 90, 135, 180, 225, 270, 315].map(a => {
    const t = a * Math.PI / 180
    return `<line x1="${(cx + Math.cos(t) * r * 0.58).toFixed(1)}" y1="${(cy + Math.sin(t) * r * 0.58).toFixed(1)}" x2="${(cx + Math.cos(t) * r * 1.3).toFixed(1)}" y2="${(cy + Math.sin(t) * r * 1.3).toFixed(1)}"/>`
  }).join('')
  return `<g stroke="${BLUE}" stroke-width="${stroke}" stroke-linecap="round" fill="none">
      <circle cx="${cx}" cy="${cy}" r="${r}"/><circle cx="${cx}" cy="${cy}" r="${r * 0.58}"/>${spokes}</g>
    <path d="M ${cx - r * 0.17} ${cy - r * 0.3} L ${cx + r * 0.36} ${cy} L ${cx - r * 0.17} ${cy + r * 0.3} Z" fill="${BLUE}"/>`
}

// Small sizes drop the spokes and thicken everything, at 16px thin strokes turn to mush.
const art = (simple) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${MID}"/><stop offset="1" stop-color="${DEEP}"/></linearGradient></defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  ${simple
    ? `<g stroke="${BLUE}" stroke-width="34" fill="none"><circle cx="256" cy="256" r="150"/></g>
       <path d="M 214 176 L 330 256 L 214 336 Z" fill="${BLUE}"/>`
    : helm(256, 256, 138, 22)}
</svg>`

const png = (simple, size) => sharp(Buffer.from(art(simple))).resize(size, size).png({ compressionLevel: 9 }).toBuffer()

// ICO: 6-byte header, one 16-byte directory entry per image, then PNG payloads (Vista+).
const buildIco = (images) => {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(16 * images.length)
  let offset = 6 + 16 * images.length
  images.forEach(({ size, buf }, i) => {
    const e = i * 16
    dir[e] = size >= 256 ? 0 : size          // 0 means 256 in the ICO format
    dir[e + 1] = size >= 256 ? 0 : size
    dir.writeUInt16LE(1, e + 4)              // colour planes
    dir.writeUInt16LE(32, e + 6)             // bits per pixel
    dir.writeUInt32LE(buf.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += buf.length
  })
  return Buffer.concat([header, dir, ...images.map(i => i.buf)])
}

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const images = []
for (const size of SIZES) images.push({ size, buf: await png(size <= 32, size) })

fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), buildIco(images))
fs.writeFileSync(path.join(ROOT, 'build', 'icon.svg'), art(false))
fs.writeFileSync(path.join(ROOT, 'public', 'icon.png'), await png(false, 512))
console.log(`icons written: build/icon.ico (${SIZES.join(', ')}px), build/icon.svg, public/icon.png`)
