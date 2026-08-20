import fs from 'node:fs'
import path from 'node:path'

const U32_MAX = 0xffffffff
const U16_MAX = 0xffff

const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  crcTable[n] = c >>> 0
}

const crc32 = (data: Buffer) => {
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const dosStamp = (mtime: Date) => {
  const year = Math.max(1980, Math.min(2107, mtime.getFullYear()))
  const date = ((year - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate()
  const time = (mtime.getHours() << 11) | (mtime.getMinutes() << 5) | Math.floor(mtime.getSeconds() / 2)
  return { date, time }
}

const zip64Extra = (values: bigint[]) => {
  if (!values.length) return Buffer.alloc(0)
  const out = Buffer.alloc(4 + values.length * 8)
  out.writeUInt16LE(0x0001, 0)
  out.writeUInt16LE(values.length * 8, 2)
  values.forEach((value, i) => out.writeBigUInt64LE(value, 4 + i * 8))
  return out
}

type CentralEntry = {
  name: Buffer
  crc: number
  size: number
  offset: number
  date: number
  time: number
}

/**
 * PNG bytes are compressed already, so a method-0 ZIP avoids wasting CPU and can be
 * written incrementally. Only one frame is read at a time; central records stay tiny.
 * ZIP64 records are emitted when a long/high-resolution sequence crosses classic ZIP
 * count or offset limits.
 */
export async function writeStoredZip(outputPath: string, inputPaths: string[]) {
  const fd = await fs.promises.open(outputPath, 'w')
  let position = 0
  let closed = false
  const entries: CentralEntry[] = []
  const write = async (buffer: Buffer) => {
    let written = 0
    while (written < buffer.length) {
      const result = await fd.write(buffer, written, buffer.length - written, position + written)
      written += result.bytesWritten
    }
    position += buffer.length
  }

  try {
    for (const inputPath of inputPaths) {
      const data = await fs.promises.readFile(inputPath)
      const stat = await fs.promises.stat(inputPath)
      const name = Buffer.from(path.basename(inputPath), 'utf8')
      const size = data.length
      const offset = position
      const crc = crc32(data)
      const stamp = dosStamp(stat.mtime)
      const largeFile = size >= U32_MAX
      const extra = largeFile ? zip64Extra([BigInt(size), BigInt(size)]) : Buffer.alloc(0)
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(largeFile ? 45 : 20, 4)
      local.writeUInt16LE(0x0800, 6) // UTF-8 names
      local.writeUInt16LE(0, 8) // stored; PNG is already compressed
      local.writeUInt16LE(stamp.time, 10)
      local.writeUInt16LE(stamp.date, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(largeFile ? U32_MAX : size, 18)
      local.writeUInt32LE(largeFile ? U32_MAX : size, 22)
      local.writeUInt16LE(name.length, 26)
      local.writeUInt16LE(extra.length, 28)
      await write(local); await write(name); await write(extra); await write(data)
      entries.push({ name, crc, size, offset, ...stamp })
    }

    const centralOffset = position
    for (const entry of entries) {
      const largeFile = entry.size >= U32_MAX
      const largeOffset = entry.offset >= U32_MAX
      const extraValues: bigint[] = []
      if (largeFile) extraValues.push(BigInt(entry.size), BigInt(entry.size))
      if (largeOffset) extraValues.push(BigInt(entry.offset))
      const extra = zip64Extra(extraValues)
      const central = Buffer.alloc(46)
      central.writeUInt32LE(0x02014b50, 0)
      central.writeUInt16LE(45, 4)
      central.writeUInt16LE(largeFile || largeOffset ? 45 : 20, 6)
      central.writeUInt16LE(0x0800, 8)
      central.writeUInt16LE(0, 10)
      central.writeUInt16LE(entry.time, 12)
      central.writeUInt16LE(entry.date, 14)
      central.writeUInt32LE(entry.crc, 16)
      central.writeUInt32LE(largeFile ? U32_MAX : entry.size, 20)
      central.writeUInt32LE(largeFile ? U32_MAX : entry.size, 24)
      central.writeUInt16LE(entry.name.length, 28)
      central.writeUInt16LE(extra.length, 30)
      central.writeUInt32LE(0, 38)
      central.writeUInt32LE(largeOffset ? U32_MAX : entry.offset, 42)
      await write(central); await write(entry.name); await write(extra)
    }

    const centralSize = position - centralOffset
    const needsZip64 = entries.length >= U16_MAX || centralOffset >= U32_MAX || centralSize >= U32_MAX
    if (needsZip64) {
      const zip64Offset = position
      const end64 = Buffer.alloc(56)
      end64.writeUInt32LE(0x06064b50, 0)
      end64.writeBigUInt64LE(44n, 4)
      end64.writeUInt16LE(45, 12); end64.writeUInt16LE(45, 14)
      end64.writeBigUInt64LE(BigInt(entries.length), 24)
      end64.writeBigUInt64LE(BigInt(entries.length), 32)
      end64.writeBigUInt64LE(BigInt(centralSize), 40)
      end64.writeBigUInt64LE(BigInt(centralOffset), 48)
      await write(end64)
      const locator = Buffer.alloc(20)
      locator.writeUInt32LE(0x07064b50, 0)
      locator.writeBigUInt64LE(BigInt(zip64Offset), 8)
      locator.writeUInt32LE(1, 16)
      await write(locator)
    }

    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(needsZip64 ? U16_MAX : entries.length, 8)
    end.writeUInt16LE(needsZip64 ? U16_MAX : entries.length, 10)
    end.writeUInt32LE(needsZip64 ? U32_MAX : centralSize, 12)
    end.writeUInt32LE(needsZip64 ? U32_MAX : centralOffset, 16)
    await write(end)
    await fd.close()
    closed = true
  } catch (error) {
    if (!closed) { try { await fd.close() } catch { /* the failed write may already have closed it */ } }
    try { await fs.promises.rm(outputPath, { force: true }) } catch { /* preserve the original write error */ }
    throw error
  }
}
