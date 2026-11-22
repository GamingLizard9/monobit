// Generates the pixel-art app icon (app-icon.png, 1024x1024) with no dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const N = 32;
const g = Array.from({ length: N }, () => new Array(N).fill(0)); // 0 transparent, 1 black, 2 white
const bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
// rounded square
for (let y = 1; y < 31; y++) for (let x = 1; x < 31; x++) {
  const cx = Math.min(x - 1, 30 - x), cy = Math.min(y - 1, 30 - y);
  if (cx + cy < 3 && !(cx >= 1 && cy >= 1 && cx + cy >= 2)) continue;
  g[y][x] = 1;
}
// interior dithered gradient (top-left white -> bottom-right black)
for (let y = 3; y < 29; y++) for (let x = 3; x < 29; x++) {
  const t = (x + y - 6) / 50;
  const level = Math.round((1 - t) * 16);
  g[y][x] = bayer[y % 4][x % 4] < level ? 2 : 1;
}
// big "1" glyph-ish monogram: a white block letter M with black outline + shadow
const M = [
  '##.....##',
  '###...###',
  '####.####',
  '##.###.##',
  '##..#..##',
  '##.....##',
  '##.....##',
  '##.....##',
  '##.....##',
];
const ox = 11, oy = 10, S = 1;
const mask = new Set();
M.forEach((row, ry) => [...row].forEach((c, rx) => { if (c === '#') mask.add(`${ox + rx},${oy + ry}`); }));
const has = (x, y) => mask.has(`${x},${y}`);
// shadow (2,2)
for (const k of mask) { const [x, y] = k.split(',').map(Number); for (let d = 1; d <= 2; d++) g[y + d][x + d] = 1; }
// outline
for (const k of mask) { const [x, y] = k.split(',').map(Number); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!has(x + dx, y + dy)) g[y + dy][x + dx] = 1; }
for (const k of mask) { const [x, y] = k.split(',').map(Number); g[y][x] = 2; }

const SCALE = 32, W = N * SCALE;
const raw = Buffer.alloc((W * 4 + 1) * W);
for (let y = 0; y < W; y++) {
  raw[y * (W * 4 + 1)] = 0;
  for (let x = 0; x < W; x++) {
    const v = g[Math.floor(y / SCALE)][Math.floor(x / SCALE)];
    const o = y * (W * 4 + 1) + 1 + x * 4;
    const c = v === 2 ? 255 : 0;
    raw[o] = c; raw[o + 1] = c; raw[o + 2] = c; raw[o + 3] = v === 0 ? 0 : 255;
  }
}
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
writeFileSync(process.argv[2] || 'app-icon.png', png);
console.log('wrote icon');
