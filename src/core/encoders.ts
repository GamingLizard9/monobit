/**
 * 1-bit image encoders for the web build (the desktop build uses the Rust versions in src-tauri/src/lib.rs).
 * Rasters hold one byte per pixel: 0 = transparent, 1 = black (ink), 2 = white (paper).
 */

const TRANSPARENT = 0;
const BLACK = 1;

export interface Pixels {
  w: number;
  h: number;
  data: Uint8Array;
}

/** Nearest-neighbour upscale by an integer factor. */
export function scaled(px: Pixels, scale: number): Pixels {
  const s = Math.max(1, Math.min(64, Math.floor(scale)));
  if (s === 1) return px;
  const w = px.w * s;
  const h = px.h * s;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = Math.floor(y / s) * px.w;
    const row = y * w;
    for (let x = 0; x < w; x++) data[row + x] = px.data[src + Math.floor(x / s)];
  }
  return { w, h, data };
}

export function sanitizeSymbol(name: string): string {
  let s = [...name].map((c) => (/[A-Za-z0-9]/.test(c) ? c.toLowerCase() : '_')).join('');
  if (!s || /^[0-9]/.test(s)) s = 'img_' + s;
  return s;
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** zlib-wrapped deflate (what PNG's IDAT expects) via the browser's built-in CompressionStream. */
async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out, 4, 8 + body.length));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

/** True 1-bit grayscale PNG, or 2-bit indexed (transparent/black/white) when the image has transparency. */
export async function encodePng(px: Pixels): Promise<Uint8Array> {
  const transparent = px.data.includes(TRANSPARENT);
  const bits = transparent ? 2 : 1;
  const rowLen = Math.ceil((px.w * bits) / 8);
  // each scanline is prefixed with filter type 0 (none)
  const raw = new Uint8Array((rowLen + 1) * px.h);
  for (let y = 0; y < px.h; y++) {
    const base = y * (rowLen + 1) + 1;
    for (let x = 0; x < px.w; x++) {
      const p = px.data[y * px.w + x];
      const v = transparent ? Math.min(p, 2) : p === BLACK ? 0 : 1;
      const bit = x * bits;
      raw[base + (bit >> 3)] |= v << (8 - bits - (bit & 7));
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, px.w);
  dv.setUint32(4, px.h);
  ihdr[8] = bits; // bit depth
  ihdr[9] = transparent ? 3 : 0; // colour type: indexed / grayscale
  const parts = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk('IHDR', ihdr)];
  if (transparent) {
    parts.push(chunk('PLTE', Uint8Array.of(0, 0, 0, 0, 0, 0, 255, 255, 255)));
    parts.push(chunk('tRNS', Uint8Array.of(0, 255, 255)));
  }
  parts.push(chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array(0)));
  return concat(parts);
}

// ---------------------------------------------------------------- BMP / PBM

export function encodeBmp(px: Pixels): Uint8Array {
  const row = Math.ceil(px.w / 32) * 4;
  const imgSize = row * px.h;
  const offset = 14 + 40 + 8;
  const b = new Uint8Array(offset + imgSize);
  const dv = new DataView(b.buffer);
  b[0] = 0x42; // 'B'
  b[1] = 0x4d; // 'M'
  dv.setUint32(2, offset + imgSize, true);
  dv.setUint32(10, offset, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, px.w, true);
  dv.setInt32(22, px.h, true);
  dv.setUint16(26, 1, true); // planes
  dv.setUint16(28, 1, true); // bpp
  dv.setUint32(34, imgSize, true);
  dv.setUint32(38, 2835, true);
  dv.setUint32(42, 2835, true);
  dv.setUint32(46, 2, true);
  dv.setUint32(50, 2, true);
  b.set([0, 0, 0, 0, 255, 255, 255, 0], 54); // palette: black, white
  for (let y = 0; y < px.h; y++) {
    const line = offset + (px.h - 1 - y) * row; // bottom-up
    for (let x = 0; x < px.w; x++) if (px.data[y * px.w + x] !== BLACK) b[line + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return b;
}

/** Packs rows of ink bits (1 = black). MSB-first matches Adafruit GFX / u8g2 drawBitmap; LSB-first matches XBM. */
export function packRows(px: Pixels, msbFirst: boolean): Uint8Array {
  const row = Math.ceil(px.w / 8);
  const out = new Uint8Array(row * px.h);
  for (let y = 0; y < px.h; y++)
    for (let x = 0; x < px.w; x++)
      if (px.data[y * px.w + x] === BLACK) out[y * row + (x >> 3)] |= msbFirst ? 0x80 >> (x & 7) : 1 << (x & 7);
  return out;
}

export function encodePbm(px: Pixels): Uint8Array {
  return concat([new TextEncoder().encode(`P4\n# Monobit\n${px.w} ${px.h}\n`), packRows(px, true)]);
}

// ---------------------------------------------------------------- source formats

function hexTable(bytes: Uint8Array, perLine: number): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine)
    lines.push('  ' + [...bytes.subarray(i, i + perLine)].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', '));
  return lines.join(',\n');
}

export function encodeCHeader(px: Pixels, name: string): string {
  const sym = sanitizeSymbol(name);
  const up = sym.toUpperCase();
  const bytes = packRows(px, true);
  return (
    `// ${sym}.h - generated by Monobit\n` +
    `// ${px.w}x${px.h} 1-bit bitmap, horizontal rows, MSB first, 1 = black ink.\n` +
    `// Compatible with Adafruit GFX drawBitmap() and u8g2 drawBitmap().\n` +
    `#pragma once\n#include <stdint.h>\n#ifndef PROGMEM\n#define PROGMEM\n#endif\n\n` +
    `#define ${up}_WIDTH  ${px.w}\n#define ${up}_HEIGHT ${px.h}\n\n` +
    `const uint8_t ${sym}[${bytes.length}] PROGMEM = {\n${hexTable(bytes, 12)}\n};\n`
  );
}

export function encodeXbm(px: Pixels, name: string): string {
  const sym = sanitizeSymbol(name);
  return `#define ${sym}_width ${px.w}\n#define ${sym}_height ${px.h}\nstatic unsigned char ${sym}_bits[] = {\n${hexTable(packRows(px, false), 12)}\n};\n`;
}
