import type { Pat, Paint, PatternPaint, PaintMode, GradientPaint } from './types';

export const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function bayer(n: number): number[][] {
  if (n === 1) return [[0]];
  const m = bayer(n / 2);
  const out: number[][] = [];
  for (let y = 0; y < n; y++) {
    out.push([]);
    for (let x = 0; x < n; x++) {
      const base = m[y % (n / 2)][x % (n / 2)] * 4;
      const q = (y < n / 2 ? 0 : 2) + (x < n / 2 ? 0 : 1);
      out[y].push(base + [0, 2, 3, 1][q]);
    }
  }
  return out;
}

export const BAYER8 = bayer(8);

/** Ordered-dither tile with `level` black pixels out of 16 (Bayer 4x4, tiled to 8x8). */
export function densityPat(level: number): Pat {
  const rows: number[] = [];
  for (let y = 0; y < 8; y++) {
    let b = 0;
    for (let x = 0; x < 8; x++) if (BAYER4[y % 4][x % 4] < level) b |= 0x80 >> x;
    rows.push(b);
  }
  return rows;
}

/** The 16 density steps, white -> black (Bayer levels; 9/16 skipped so 50% checker stays). */
export const DENSITY_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16];
export const DENSITY: Pat[] = DENSITY_LEVELS.map(densityPat);

const P = (...rows: string[]): Pat =>
  rows.map((r) => [...r].reduce((acc, c, i) => (c === '#' ? acc | (0x80 >> i) : acc), 0));

export interface NamedPat {
  name: string;
  pat: Pat;
}

export const TEXTURES: NamedPat[] = [
  { name: 'Rows', pat: P('########', '........', '........', '........', '########', '........', '........', '........') },
  { name: 'Columns', pat: P('#...#...', '#...#...', '#...#...', '#...#...', '#...#...', '#...#...', '#...#...', '#...#...') },
  { name: 'Diagonal /', pat: P('.......#', '......#.', '.....#..', '....#...', '...#....', '..#.....', '.#......', '#.......') },
  { name: 'Diagonal \\', pat: P('#.......', '.#......', '..#.....', '...#....', '....#...', '.....#..', '......#.', '.......#') },
  { name: 'Grid', pat: P('########', '#...#...', '#...#...', '#...#...', '########', '#...#...', '#...#...', '#...#...') },
  { name: 'Crosshatch', pat: P('#.....#.', '.#...#..', '..#.#...', '...#....', '..#.#...', '.#...#..', '#.....#.', '.......#') },
  { name: 'Bricks', pat: P('########', '#.......', '#.......', '#.......', '########', '....#...', '....#...', '....#...') },
  { name: 'Checks', pat: P('####....', '####....', '####....', '####....', '....####', '....####', '....####', '....####') },
  { name: 'Small checks', pat: P('##..##..', '##..##..', '..##..##', '..##..##', '##..##..', '##..##..', '..##..##', '..##..##') },
  { name: 'Polka', pat: P('........', '.##.....', '.##.....', '........', '........', '.....##.', '.....##.', '........') },
  { name: 'Diamonds', pat: P('...#....', '..#.#...', '.#...#..', '#.....#.', '.#...#..', '..#.#...', '...#....', '........') },
  { name: 'Waves', pat: P('........', '##....##', '..#..#..', '...##...', '........', '##....##', '..#..#..', '...##...') },
  { name: 'Scales', pat: P('#.......', '.#.....#', '..##.##.', '....#...', '....#...', '.....#.#', '##.....#', '..#####.') },
  { name: 'Weave', pat: P('#####...', '.#####..', '..#.###.', '...#.###', '#...#.##', '##...#.#', '###...#.', '.###...#') },
  { name: 'Zigzag', pat: P('#.......', '.#.....#', '..#...#.', '...#.#..', '....#...', '........', '........', '........') },
  { name: 'Hearts', pat: P('.##.##..', '#######.', '#######.', '.#####..', '..###...', '...#....', '........', '........') },
];

export const SOLID_BLACK: Pat = [255, 255, 255, 255, 255, 255, 255, 255];
export const SOLID_WHITE: Pat = [0, 0, 0, 0, 0, 0, 0, 0];

export const patPaint = (pat: Pat, mode: PaintMode = 'opaque'): PatternPaint => ({ kind: 'pattern', pat: [...pat], mode });
export const BLACK = (): PatternPaint => patPaint(SOLID_BLACK);
export const WHITE = (): PatternPaint => patPaint(SOLID_WHITE);
export const defaultGradient = (mode: PaintMode = 'opaque'): GradientPaint => ({
  kind: 'gradient',
  from: 0,
  to: 64,
  angle: 0,
  shape: 'linear',
  dither: 'bayer',
  mode,
});

export const patBit = (pat: Pat, x: number, y: number) => (pat[y & 7] >> (7 - (x & 7))) & 1;

export const samePat = (a: Pat, b: Pat) => a.length === b.length && a.every((v, i) => v === b[i]);

export const patEquals = (a: Paint | null | undefined, b: Paint | null | undefined): boolean => {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind || a.mode !== b.mode) return false;
  if (a.kind === 'pattern' && b.kind === 'pattern') return samePat(a.pat, b.pat);
  return JSON.stringify(a) === JSON.stringify(b);
};

/** Approximate ink coverage of a paint (0..1), used for previews and gradients. */
export function paintDensity(p: Paint): number {
  if (p.kind === 'gradient') return (p.from + p.to) / 128;
  let n = 0;
  for (const r of p.pat) for (let i = 0; i < 8; i++) n += (r >> i) & 1;
  return n / 64;
}

export function invertPat(p: Pat): Pat {
  return p.map((r) => ~r & 255);
}

// cheap deterministic per-pixel noise for "noise" gradients
function hash(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface PaintBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Evaluates a paint at absolute canvas pixel (x,y). Returns 0 (transparent), 1 (black) or 2 (white).
 * Patterns are anchored to the canvas so neighbouring objects mesh seamlessly.
 */
export function paintAt(p: Paint, x: number, y: number, box?: PaintBox): number {
  let ink: number;
  if (p.kind === 'pattern') {
    ink = patBit(p.pat, x, y);
  } else {
    const b = box ?? { x: 0, y: 0, w: 1, h: 1 };
    const cx = b.x + b.w / 2,
      cy = b.y + b.h / 2;
    let t: number;
    if (p.p0 && p.p1) {
      const dx = p.p1[0] - p.p0[0],
        dy = p.p1[1] - p.p0[1];
      const px = x + 0.5 - (p.p0[0] + 0.5),
        py = y + 0.5 - (p.p0[1] + 0.5);
      const len2 = Math.max(1, dx * dx + dy * dy);
      t = p.shape === 'radial' ? Math.sqrt((px * px + py * py) / len2) : (px * dx + py * dy) / len2;
      t = Math.max(0, Math.min(1, t));
    } else if (p.shape === 'radial') {
      const rx = Math.max(1, b.w / 2),
        ry = Math.max(1, b.h / 2);
      const dx = (x + 0.5 - cx) / rx,
        dy = (y + 0.5 - cy) / ry;
      t = Math.min(1, Math.sqrt(dx * dx + dy * dy));
    } else {
      const a = (p.angle * Math.PI) / 180;
      const c = Math.cos(a),
        s = Math.sin(a);
      const ext = Math.max(0.5, Math.abs((b.w / 2) * c) + Math.abs((b.h / 2) * s));
      t = ((x + 0.5 - cx) * c + (y + 0.5 - cy) * s) / ext;
      t = Math.max(0, Math.min(1, (t + 1) / 2));
    }
    const level = p.from + (p.to - p.from) * t; // 0..64
    const thr = p.dither === 'noise' ? hash(x, y) * 64 : BAYER8[y & 7][x & 7] + 0.5;
    ink = thr < level ? 1 : 0;
  }
  if (ink) return p.mode === 'paper' ? 0 : 1;
  return p.mode === 'ink' ? 0 : 2;
}

/** Renders a paint swatch into an ImageData-friendly RGBA array. */
export function paintSwatchRGBA(p: Paint | null, w: number, h: number, scale = 1, offX = 0, offY = 0): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const px = Math.floor(x / scale) + offX,
        py = Math.floor(y / scale) + offY;
      let v = 2;
      if (p) v = paintAt(p, px, py, { x: offX, y: offY, w: w / scale, h: h / scale });
      const o = (y * w + x) * 4;
      if (v === 0) {
        // transparency shown as a fine checker
        const c = ((x >> 1) + (y >> 1)) & 1 ? 255 : 200;
        out[o] = out[o + 1] = out[o + 2] = c;
      } else {
        const c = v === 1 ? 0 : 255;
        out[o] = out[o + 1] = out[o + 2] = c;
      }
      out[o + 3] = 255;
    }
  return out;
}
