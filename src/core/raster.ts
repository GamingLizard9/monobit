import type { Rect } from './types';

/** A byte grid positioned in canvas space. Out-of-bounds reads return 0, writes are ignored. */
export class Buf {
  constructor(
    public x: number,
    public y: number,
    public w: number,
    public h: number,
    public data: Uint8Array = new Uint8Array(Math.max(0, w * h)),
  ) {}

  static fromRect(r: Rect, pad = 0) {
    return new Buf(r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2);
  }

  get(x: number, y: number): number {
    x -= this.x;
    y -= this.y;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.data[y * this.w + x];
  }

  set(x: number, y: number, v: number) {
    x -= this.x;
    y -= this.y;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.data[y * this.w + x] = v;
  }

  inside(x: number, y: number) {
    return x >= this.x && y >= this.y && x < this.x + this.w && y < this.y + this.h;
  }

  clone() {
    return new Buf(this.x, this.y, this.w, this.h, this.data.slice());
  }

  /** Same-bounds copy with every cell cleared. */
  empty() {
    return new Buf(this.x, this.y, this.w, this.h);
  }

  forEachSet(cb: (x: number, y: number, v: number) => void) {
    const { w, h, data } = this;
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const v = data[j * w + i];
        if (v) cb(i + this.x, j + this.y, v);
      }
  }

  /** Tight bounds of the non-zero cells, or null when empty. */
  bounds(): Rect | null {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    const { w, h, data } = this;
    for (let j = 0; j < h; j++) {
      const row = j * w;
      for (let i = 0; i < w; i++)
        if (data[row + i]) {
          if (i < x0) x0 = i;
          if (i > x1) x1 = i;
          if (j < y0) y0 = j;
          y1 = j;
        }
    }
    if (x1 < 0) return null;
    return { x: x0 + this.x, y: y0 + this.y, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /** Returns a copy re-positioned into a (larger or smaller) rect. */
  reframe(r: Rect): Buf {
    const out = new Buf(r.x, r.y, r.w, r.h);
    const x0 = Math.max(r.x, this.x),
      y0 = Math.max(r.y, this.y);
    const x1 = Math.min(r.x + r.w, this.x + this.w),
      y1 = Math.min(r.y + r.h, this.y + this.h);
    for (let y = y0; y < y1; y++) {
      const src = (y - this.y) * this.w + (x0 - this.x);
      const dst = (y - r.y) * r.w + (x0 - r.x);
      out.data.set(this.data.subarray(src, src + (x1 - x0)), dst);
    }
    return out;
  }

  /** Crops to the non-zero area (keeps a 1-cell buffer if empty). */
  trimmed(): Buf {
    const b = this.bounds();
    if (!b) return new Buf(this.x, this.y, 0, 0);
    return this.reframe(b);
  }
}

export const rectUnion = (a: Rect | null, b: Rect | null): Rect | null => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

export const rectIntersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export const rectContains = (r: Rect, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

export const normRect = (x0: number, y0: number, x1: number, y1: number): Rect => ({
  x: Math.min(x0, x1),
  y: Math.min(y0, y1),
  w: Math.abs(x1 - x0) + 1,
  h: Math.abs(y1 - y0) + 1,
});

// ------------------------------------------------------------ primitives

export type Plot = (x: number, y: number) => void;

/** Bresenham line, visiting pixels in order from (x0,y0) to (x1,y1). */
export function line(x0: number, y0: number, x1: number, y1: number, plot: Plot, skipFirst = false) {
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0),
    sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0),
    sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let first = true;
  for (;;) {
    if (!(first && skipFirst)) plot(x0, y0);
    first = false;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** Ellipse outline inscribed in a rectangle (Zingl). Handles even sizes crisply. */
export function ellipseRect(x0: number, y0: number, x1: number, y1: number, plot: Plot) {
  let a = Math.abs(x1 - x0),
    b = Math.abs(y1 - y0);
  let b1 = b & 1;
  let dx = 4 * (1 - a) * b * b,
    dy = 4 * (b1 + 1) * a * a;
  let err = dx + dy + b1 * a * a,
    e2;
  if (x0 > x1) {
    x0 = x1;
    x1 += a;
  }
  if (y0 > y1) y0 = y1;
  y0 += (b + 1) >> 1;
  y1 = y0 - b1;
  a *= 8 * a;
  b1 = 8 * b * b;
  do {
    plot(x1, y0);
    plot(x0, y0);
    plot(x0, y1);
    plot(x1, y1);
    e2 = 2 * err;
    if (e2 <= dy) {
      y0++;
      y1--;
      err += dy += a;
    }
    if (e2 >= dx || 2 * err > dy) {
      x0++;
      x1--;
      err += dx += b1;
    }
  } while (x0 <= x1);
  while (y0 - y1 <= b) {
    plot(x0 - 1, y0);
    plot(x1 + 1, y0++);
    plot(x0 - 1, y1);
    plot(x1 + 1, y1--);
  }
}

/** Fills the inside of closed outlines drawn into `m` (flood the exterior, invert). */
export function fillInterior(m: Buf) {
  const { w, h, data } = m;
  const W = w + 2,
    H = h + 2;
  const ext = new Uint8Array(W * H);
  const stack: number[] = [0];
  ext[0] = 1;
  while (stack.length) {
    const p = stack.pop()!;
    const px = p % W,
      py = (p - px) / W;
    const nb = [
      [px - 1, py],
      [px + 1, py],
      [px, py - 1],
      [px, py + 1],
    ];
    for (const [nx, ny] of nb) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const q = ny * W + nx;
      if (ext[q]) continue;
      const ix = nx - 1,
        iy = ny - 1;
      if (ix >= 0 && iy >= 0 && ix < w && iy < h && data[iy * w + ix]) continue;
      ext[q] = 1;
      stack.push(q);
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!ext[(y + 1) * W + x + 1]) data[y * w + x] = 1;
}

/** Fills a convex outline row by row (min..max of set cells on each row). */
export function fillRows(m: Buf) {
  const { w, h, data } = m;
  for (let y = 0; y < h; y++) {
    let a = -1,
      b = -1;
    for (let x = 0; x < w; x++)
      if (data[y * w + x]) {
        if (a < 0) a = x;
        b = x;
      }
    if (a >= 0) data.fill(1, y * w + a, y * w + b + 1);
  }
}

/** 4-neighbour erosion. */
export function erode(m: Buf): Buf {
  const out = m.empty();
  const { w, h, data } = m;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!data[i]) continue;
      if (x > 0 && y > 0 && x < w - 1 && y < h - 1 && data[i - 1] && data[i + 1] && data[i - w] && data[i + w]) out.data[i] = 1;
    }
  return out;
}

/** Dilation by radius r. Square kernel (8-neighbour) or a disc when `round`. Grows bounds. */
export function dilate(m: Buf, r: number, round: boolean): Buf {
  const out = new Buf(m.x - r, m.y - r, m.w + 2 * r, m.h + 2 * r);
  const offs: [number, number][] = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      if (round && r > 1 && dx * dx + dy * dy > r * r + r * 0.8) continue;
      if (round && r === 1 && Math.abs(dx) + Math.abs(dy) > 1) continue;
      offs.push([dx, dy]);
    }
  const { w, h, data } = m;
  const ow = out.w;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue;
      for (const [dx, dy] of offs) out.data[(y + r + dy) * ow + (x + r + dx)] = 1;
    }
  return out;
}

/**
 * Moore-neighbour trace of the outer contour of the blob containing the first set cell.
 * Returns ordered flat indices (into m.data).
 */
export function traceContour(m: Buf): number[] {
  const { w, h, data } = m;
  let start = -1;
  for (let i = 0; i < w * h; i++)
    if (data[i]) {
      start = i;
      break;
    }
  if (start < 0) return [];
  const DX = [-1, -1, 0, 1, 1, 1, 0, -1];
  const DY = [0, -1, -1, -1, 0, 1, 1, 1];
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] !== 0;
  const out: number[] = [start];
  let cx = start % w,
    cy = (start - cx) / w;
  let back = 0; // direction from current to backtrack cell (west)
  const limit = w * h * 4 + 8;
  for (let n = 0; n < limit; n++) {
    let found = false;
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8;
      const nx = cx + DX[d],
        ny = cy + DY[d];
      if (at(nx, ny)) {
        // new backtrack = the cell checked just before, relative to the new position
        const pd = (back + k - 1) % 8;
        const bx = cx + DX[pd] - nx,
          by = cy + DY[pd] - ny;
        back = DX.findIndex((v, i) => v === bx && DY[i] === by);
        if (back < 0) back = 0;
        cx = nx;
        cy = ny;
        found = true;
        break;
      }
    }
    if (!found) break;
    const idx = cy * w + cx;
    if (idx === start) break;
    out.push(idx);
  }
  return out;
}

/**
 * Assigns each set cell of `region` an arc-length index along the outer contour of `solid`
 * (multi-source BFS from the contour). Used to dash strokes of any shape and width.
 */
export function contourIndex(solid: Buf, region: Buf): Int32Array {
  const idx = new Int32Array(region.w * region.h).fill(-1);
  const contour = traceContour(solid);
  const q: number[] = [];
  const seen = new Set<number>();
  let n = 0;
  for (const c of contour) {
    if (seen.has(c)) continue;
    seen.add(c);
    const x = (c % solid.w) + solid.x,
      y = Math.floor(c / solid.w) + solid.y;
    const ri = (y - region.y) * region.w + (x - region.x);
    if (ri >= 0 && ri < idx.length && region.data[ri] && idx[ri] < 0) {
      idx[ri] = n;
      q.push(ri);
    }
    n++;
  }
  for (let head = 0; head < q.length; head++) {
    const p = q[head];
    const px = p % region.w,
      py = (p - px) / region.w;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx,
          ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= region.w || ny >= region.h) continue;
        const ni = ny * region.w + nx;
        if (region.data[ni] && idx[ni] < 0) {
          idx[ni] = idx[p];
          q.push(ni);
        }
      }
  }
  return idx;
}

/** Brush footprint offsets for pencil/eraser/line stamps. */
export function brushOffsets(size: number, round: boolean): [number, number][] {
  const out: [number, number][] = [];
  const s = Math.max(1, Math.round(size));
  const o = Math.floor((s - 1) / 2);
  const c = (s - 1) / 2;
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      if (round && s > 2) {
        const dx = x - c,
          dy = y - c;
        if (dx * dx + dy * dy > (s / 2) * (s / 2) + 0.25) continue;
      }
      out.push([x - o, y - o]);
    }
  return out;
}

/** Scanline flood fill on a value grid; returns visited flat indices. */
export function floodRegion(grid: Uint8Array, w: number, h: number, sx: number, sy: number, diagonal = false): Uint8Array {
  const mask = new Uint8Array(w * h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const target = grid[sy * w + sx];
  const stack = [sy * w + sx];
  mask[sy * w + sx] = 1;
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w,
      y = (p - x) / w;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        if (!diagonal && dx && dy) continue;
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (mask[q] || grid[q] !== target) continue;
        mask[q] = 1;
        stack.push(q);
      }
  }
  return mask;
}
