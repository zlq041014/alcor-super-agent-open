import { deflateSync } from "node:zlib";
import { writeFile, mkdir } from "node:fs/promises";
const crc = (buffer) => {
  let c = 0xffffffff;
  for (const b of buffer) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const t = Buffer.from(type),
    n = Buffer.alloc(4),
    c = Buffer.alloc(4);
  n.writeUInt32BE(data.length);
  c.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([n, t, data, c]);
}
function star(x, y, cx, cy, r) {
  return Math.sqrt(Math.abs(x - cx) / r) + Math.sqrt(Math.abs(y - cy) / r) < 1;
}
const n = 256,
  raw = Buffer.alloc((n * 4 + 1) * n);
for (let y = 0; y < n; y++)
  for (let x = 0; x < n; x++) {
    const p = y * (n * 4 + 1) + 1 + x * 4;
    const px = x + 0.5,
      py = y + 0.5;
    const dx = Math.max(0, Math.abs(px - 128) - 80),
      dy = Math.max(0, Math.abs(py - 128) - 80);
    const inside = dx * dx + dy * dy <= 48 * 48;
    const white =
      star(px, py, 123, 140, 70) ||
      star(px, py, 183, 67, 29) ||
      star(px, py, 62, 62, 18);
    raw[p] = white ? 255 : 102;
    raw[p + 1] = white ? 255 : 87;
    raw[p + 2] = white ? 255 : 217;
    raw[p + 3] = inside ? 255 : 0;
  }
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(n);
ihdr.writeUInt32BE(n, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
await mkdir("assets", { recursive: true });
await writeFile("assets/alcor.png", png);
await writeFile("assets/alcor.ico", Buffer.concat([ico, png]));
