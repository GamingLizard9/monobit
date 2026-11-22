import { BITMAP_FONT_DATA, type RawBitmapFont } from './bitmapfonts.data';

/** A glyph on a font-row grid: row 0 of `ink` is font row `top`. */
export interface Glyph {
  w: number;
  top: number;
  h: number;
  ink: Uint8Array;
  /** body pixels inside the outline (outline fonts only) */
  inner: Uint8Array | null;
}

export interface BitmapFontMetrics {
  /** first/last font rows used by regular glyphs */
  minRow: number;
  maxRow: number;
  /** font row of the baseline (bottom of capitals) */
  baseRow: number;
  outline: boolean;
}

const COMBINING: Record<string, string> = {
  '̀': 'grave',
  '́': 'acute',
  '̂': 'circumflex',
  '̃': 'tilde',
  '̈': 'diaeresis',
  '̊': 'ring',
  '̧': 'cedilla',
};
const STROKED: Record<string, string> = { ø: 'o', Ø: 'O', đ: 'd', Đ: 'D', ł: 'l', Ł: 'L' };

const metricsCache = new Map<string, BitmapFontMetrics>();
const glyphCache = new Map<string, Glyph>();

export const isBitmapFont = (id: string) => id in BITMAP_FONT_DATA;

const colRows = (v: number) => {
  const out: number[] = [];
  for (let r = 0; v >> r; r++) if ((v >> r) & 1) out.push(r);
  return out;
};

export function bitmapMetrics(id: string): BitmapFontMetrics {
  const hit = metricsCache.get(id);
  if (hit) return hit;
  const f = BITMAP_FONT_DATA[id];
  let minRow = Infinity,
    maxRow = -Infinity;
  for (const cols of Object.values(f.glyphs))
    for (const c of cols)
      for (const r of colRows(c)) {
        minRow = Math.min(minRow, r);
        maxRow = Math.max(maxRow, r);
      }
  const baseRow = Math.max(...(f.glyphs['H'] ?? [0]).flatMap(colRows));
  const m = { minRow, maxRow, baseRow, outline: id.includes('outline') };
  metricsCache.set(id, m);
  return m;
}

function decompose(f: RawBitmapFont, ch: string): { base: string; accents: string[] } | null {
  if (f.glyphs[ch]) return { base: ch, accents: [] };
  if (STROKED[ch]) return { base: STROKED[ch], accents: ['stroke'] };
  const nfd = ch.normalize('NFD');
  const base = nfd[0];
  if (!f.glyphs[base]) return null;
  const accents = [...nfd.slice(1)].map((c) => COMBINING[c]).filter(Boolean);
  return accents.length ? { base, accents } : null;
}

export function bitmapGlyph(id: string, ch: string): Glyph {
  const key = id + '\u0000' + ch;
  const hit = glyphCache.get(key);
  if (hit) return hit;
  const f = BITMAP_FONT_DATA[id];
  const m = bitmapMetrics(id);
  const dec = decompose(f, ch) ?? decompose(f, '?')!;
  const cols = f.glyphs[dec.base];
  const w = Math.max(1, cols.length);
  // room above/below for accents (accent rows are placed at shift - 8 + r)
  const top = Math.min(m.minRow, -8),
    bottom = Math.max(m.maxRow, 16);
  const h = bottom - top + 1;
  const ink = new Uint8Array(w * h);
  const set = (x: number, r: number) => {
    const y = r - top;
    if (x >= 0 && x < w && y >= 0 && y < h) ink[y * w + x] = 1;
  };
  cols.forEach((c, x) => colRows(c).forEach((r) => set(x, r)));
  const upper = dec.base !== dec.base.toLowerCase();
  for (const a of dec.accents) {
    const acc = f.accents[a];
    if (!acc) continue;
    const off = (upper ? acc.upper : acc.lower) - 8;
    acc.cols.forEach((c, x) => colRows(c).forEach((r) => set(x, r + off)));
  }
  const g: Glyph = { w, top, h, ink, inner: m.outline ? glyphBody(ink, w, h) : null };
  glyphCache.set(key, g);
  return g;
}

/**
 * For outline fonts: the letter's body is the area between outlines. Label the empty
 * regions, connect regions that touch the same outline piece, and take every region an
 * odd number of outlines away from the outside (so counters like the hole in "O" stay empty).
 */
function glyphBody(ink: Uint8Array, w: number, h: number): Uint8Array {
  const W = w + 2,
    H = h + 2;
  const at = (x: number, y: number) => (x < 1 || y < 1 || x > w || y > h ? 0 : ink[(y - 1) * w + (x - 1)]);
  const region = new Int32Array(W * H).fill(-1);
  const inkComp = new Int32Array(W * H).fill(-1);
  const N4 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const label = (isInk: boolean, labels: Int32Array) => {
    let n = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (labels[i] >= 0 || !!at(x, y) !== isInk) continue;
        const stack = [i];
        labels[i] = n;
        while (stack.length) {
          const p = stack.pop()!;
          const px = p % W,
            py = (p - px) / W;
          for (const [dx, dy] of N4) {
            const nx = px + dx,
              ny = py + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const q = ny * W + nx;
            if (labels[q] < 0 && !!at(nx, ny) === isInk) {
              labels[q] = n;
              stack.push(q);
            }
          }
        }
        n++;
      }
    return n;
  };
  const nRegions = label(false, region);
  const nInk = label(true, inkComp);
  // which regions touch each outline piece
  const touches: Set<number>[] = Array.from({ length: nInk }, () => new Set());
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = inkComp[y * W + x];
      if (c < 0) continue;
      for (const [dx, dy] of N4) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const r = region[ny * W + nx];
        if (r >= 0) touches[c].add(r);
      }
    }
  const depth = new Int32Array(nRegions).fill(-1);
  const outside = region[0];
  depth[outside] = 0;
  const queue = [outside];
  for (let qi = 0; qi < queue.length; qi++) {
    const r = queue[qi];
    for (const t of touches)
      if (t.has(r))
        for (const o of t)
          if (depth[o] < 0) {
            depth[o] = depth[r] + 1;
            queue.push(o);
          }
  }
  const body = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const r = region[(y + 1) * W + (x + 1)];
      if (r >= 0 && depth[r] % 2 === 1) body[y * w + x] = 1;
    }
  return body;
}
