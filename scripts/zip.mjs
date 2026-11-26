/**
 * Deterministic ZIP writer.
 *
 * `Compress-Archive` stores each entry's mtime as a *local-time* DOS timestamp, so the same
 * directory produces different bytes on a machine at UTC+8 than on a UTC CI runner - same
 * size, different sha256. That mismatch is exactly how a released digest stopped matching
 * the artifact on the download server. This writer stores entries uncompressed in sorted
 * order with a fixed timestamp, so its bytes depend only on the file names and contents.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** Fixed DOS date/time: 1980-01-01 00:00:00, the earliest value the format can express. */
const DOS_TIME = 0
const DOS_DATE = 0x0021

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[i] = value >>> 0
  }
  return table
})()

export function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Every file under `dir`, as zip entry names, sorted so the order never depends on the filesystem. */
async function collect(dir, base = dir) {
  const names = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) names.push(...await collect(full, base))
    else names.push(relative(base, full).split('\\').join('/'))
  }
  return names
}

/** Build the zip bytes for one directory tree. */
export async function buildZip(dir) {
  const names = (await collect(dir)).sort()
  const entries = []
  for (const name of names) {
    const data = await readFile(join(dir, name))
    entries.push({ name, data, crc: crc32(data) })
  }

  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)              // version needed
    local.writeUInt16LE(0x0800, 6)          // UTF-8 names
    local.writeUInt16LE(0, 8)               // stored
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(entry.crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)              // no extra field
    locals.push(local, nameBytes, entry.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)            // version made by
    central.writeUInt16LE(20, 6)            // version needed
    central.writeUInt16LE(0x0800, 8)        // UTF-8 names
    central.writeUInt16LE(0, 10)            // stored
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(entry.crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)            // extra length
    central.writeUInt16LE(0, 32)            // comment length
    central.writeUInt16LE(0, 34)            // disk number
    central.writeUInt16LE(0, 36)            // internal attributes
    central.writeUInt32LE(0, 38)            // external attributes
    central.writeUInt32LE(offset, 42)       // local header offset
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + entry.data.length
  }

  const centralSize = centrals.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, ...centrals, end])
}
