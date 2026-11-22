import { BAYER4, BAYER8 } from './patterns';
import type { DitherAlgo, ImageObj } from './types';

export const DITHER_ALGOS: { id: DitherAlgo; label: string }[] = [
  { id: 'atkinson', label: 'Atkinson' },
  { id: 'floyd', label: 'Floyd–Steinberg' },
  { id: 'stucki', label: 'Stucki' },
  { id: 'bayer4', label: 'Ordered 4×4' },
  { id: 'bayer8', label: 'Ordered 8×8' },
  { id: 'halftone', label: 'Halftone dots' },
  { id: 'noise', label: 'Random noise' },
  { id: 'threshold', label: 'Threshold' },
];

/** Box/bilinear resample of an 8-bit gray image. */
export function resampleGray(src: Uint8Array, sw: number, sh: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  if (w <= sw && h <= sh) {
    // area average
    const fx = sw / w,
      fy = sh / h;
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y * fy),
        y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x * fx),
          x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
        let s = 0,
          n = 0;
        for (let yy = y0; yy < y1 && yy < sh; yy++)
          for (let xx = x0; xx < x1 && xx < sw; xx++) {
            s += src[yy * sw + xx];
            n++;
          }
        out[y * w + x] = n ? s / n : 255;
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      const sy = Math.max(0, Math.min(sh - 1, ((y + 0.5) * sh) / h - 0.5));
      const y0 = Math.floor(sy),
        y1 = Math.min(sh - 1, y0 + 1),
        ty = sy - y0;
      for (let x = 0; x < w; x++) {
        const sx = Math.max(0, Math.min(sw - 1, ((x + 0.5) * sw) / w - 0.5));
        const x0 = Math.floor(sx),
          x1 = Math.min(sw - 1, x0 + 1),
          tx = sx - x0;
        const a = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
        const b = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
        out[y * w + x] = a * (1 - ty) + b * ty;
      }
    }
  }
  return out;
}

export interface Adjust {
  brightness: number;
  contrast: number;
  gamma: number;
  invert: boolean;
}

export function adjust(g: Float32Array, a: Adjust) {
  const c = Math.max(-99, Math.min(99, a.contrast)) * 2.55;
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  const b = a.brightness * 2.55;
  const gm = Math.max(0.1, a.gamma || 1);
  for (let i = 0; i < g.length; i++) {
    let v = cf * (g[i] - 128) + 128 + b;
    v = Math.max(0, Math.min(255, v));
    if (gm !== 1) v = 255 * Math.pow(v / 255, 1 / gm);
    if (a.invert) v = 255 - v;
    g[i] = v;
  }
}

function hash(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const DIFFUSION: Record<string, { k: [number, number, number][]; div: number }> = {
  floyd: {
    k: [
      [1, 0, 7],
      [-1, 1, 3],
      [0, 1, 5],
      [1, 1, 1],
    ],
    div: 16,
  },
  atkinson: {
    k: [
      [1, 0, 1],
      [2, 0, 1],
      [-1, 1, 1],
      [0, 1, 1],
      [1, 1, 1],
      [0, 2, 1],
    ],
    div: 8,
  },
  stucki: {
    k: [
      [1, 0, 8],
      [2, 0, 4],
      [-2, 1, 2],
      [-1, 1, 4],
      [0, 1, 8],
      [1, 1, 4],
      [2, 1, 2],
      [-2, 2, 1],
      [-1, 2, 2],
      [0, 2, 4],
      [1, 2, 2],
      [2, 2, 1],
    ],
    div: 42,
  },
};

/** Dithers gray values (0 black .. 255 white) to ink bits (1 = black). ox/oy anchor ordered patterns. */
export function ditherGray(g: Float32Array, w: number, h: number, algo: DitherAlgo, ox = 0, oy = 0): Uint8Array {
  const ink = new Uint8Array(w * h);
  if (algo in DIFFUSION) {
    const { k, div } = DIFFUSION[algo];
    const buf = Float32Array.from(g);
    for (let y = 0; y < h; y++) {
      const rtl = algo === 'floyd' && y % 2 === 1;
      for (let i = 0; i < w; i++) {
        const x = rtl ? w - 1 - i : i;
        const p = y * w + x;
        const old = buf[p];
        const nv = old < 128 ? 0 : 255;
        ink[p] = nv === 0 ? 1 : 0;
        const err = old - nv;
        for (const [dx, dy, wt] of k) {
          const nx = x + (rtl ? -dx : dx),
            ny = y + dy;
          if (nx < 0 || nx >= w || ny >= h) continue;
          buf[ny * w + nx] += (err * wt) / div;
        }
      }
    }
    return ink;
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = g[y * w + x];
      const ax = x + ox,
        ay = y + oy;
      let thr: number;
      switch (algo) {
        case 'bayer4':
          thr = ((BAYER4[ay & 3][ax & 3] + 0.5) / 16) * 255;
          break;
        case 'bayer8':
          thr = ((BAYER8[ay & 7][ax & 7] + 0.5) / 64) * 255;
          break;
        case 'noise':
          thr = hash(ax, ay) * 255;
          break;
        case 'halftone': {
          const cell = 6;
          const u = (ax + ay) / Math.SQRT2,
            vv = (ax - ay) / Math.SQRT2;
          const fu = ((u % cell) + cell) % cell - cell / 2;
          const fv = ((vv % cell) + cell) % cell - cell / 2;
          const d = Math.sqrt(fu * fu + fv * fv) / (cell / Math.SQRT2);
          thr = d * 255;
          // dark areas => big dots: black when darkness exceeds distance
          ink[y * w + x] = 1 - v / 255 > d * 1.15 ? 1 : 0;
          continue;
        }
        default:
          thr = 128;
      }
      ink[y * w + x] = v < thr ? 1 : 0;
    }
  return ink;
}

/** Renders an image object to 0/1/2 values (row-major w*h). */
export function renderImagePixels(o: ImageObj): Uint8Array {
  const w = Math.max(1, Math.round(o.w)),
    h = Math.max(1, Math.round(o.h));
  const g = resampleGray(o.src.data, o.src.w, o.src.h, w, h);
  adjust(g, o);
  const ink = ditherGray(g, w, h, o.algo, o.x, o.y);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = ink[i] ? 1 : o.knockout ? 0 : 2;
  return out;
}

/** Decodes any browser-supported image into 8-bit gray (alpha composited over white). */
export async function decodeToGray(src: string, maxSide = 1600): Promise<{ w: number; h: number; data: Uint8Array }> {
  const img = new Image();
  img.src = src;
  await img.decode();
  let w = img.naturalWidth,
    h = img.naturalHeight;
  const s = Math.min(1, maxSide / Math.max(w, h));
  w = Math.max(1, Math.round(w * s));
  h = Math.max(1, Math.round(h * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
  return { w, h, data: out };
}
