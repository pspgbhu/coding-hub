import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(name, data) {
  const type = Buffer.from(name)
  const length = Buffer.alloc(4)
  const checksum = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])))
  return Buffer.concat([length, type, data, checksum])
}
function onSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - ax - t * dx, y - ay - t * dy) < 0.065
}
function render(file, size, template = false) {
  const pixels = Buffer.alloc((size * 4 + 1) * size)
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const x = (column + 0.5) / size
      const y = (row + 0.5) / size
      const background =
        Math.max(Math.abs(x - 0.5) - 0.28, 0) ** 2 + Math.max(Math.abs(y - 0.5) - 0.28, 0) ** 2 <
        0.22 ** 2
      const mark =
        onSegment(x, y, 0.3, 0.29, 0.3, 0.71) ||
        onSegment(x, y, 0.7, 0.29, 0.7, 0.71) ||
        onSegment(x, y, 0.3, 0.5, 0.7, 0.5)
      const shade = mark ? 240 : background && !template ? 24 : 0
      const offset = row * (size * 4 + 1) + column * 4 + 1
      pixels.set([shade, shade, shade, mark || (background && !template) ? 255 : 0], offset)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}
render('build/icon.png', 1024)
render('build/tray.png', 36, true)
