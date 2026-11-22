import { Buf } from './raster';
import type { TextObj } from './types';
import { bitmapGlyph, bitmapMetrics } from './bitmapfonts';

export interface FontDef {
  id: string;
  label: string;
  family: string;
  /** pixel fonts render crisply at multiples of `native` px */
  pixel: boolean;
  native: number;
  /** bundled bitmap font (exact pixels, scaled by whole numbers) */
  bitmap?: boolean;
}

export const FONTS: FontDef[] = [
  // bundled bitmap fonts (glyph data in bitmapfonts.data.ts)
  { id: 'font6', label: 'Font6', family: 'Font6', pixel: true, native: 6, bitmap: true },
  { id: 'font8', label: 'Font8', family: 'Font8', pixel: true, native: 8, bitmap: true },
  { id: 'font14_outline', label: 'Font14 Outline', family: 'Font14 Outline', pixel: true, native: 14, bitmap: true },
  // true pixel-grid fonts: exact at multiples of `native`
  { id: 'silkscreen', label: 'Silkscreen', family: 'Silkscreen', pixel: true, native: 8 },
  { id: 'press-start', label: 'Press Start 2P', family: 'Press Start 2P', pixel: true, native: 8 },
  { id: 'tiny5', label: 'Tiny5', family: 'Tiny5', pixel: true, native: 8 },
  { id: 'bytesized', label: 'Bytesized (micro)', family: 'Bytesized', pixel: true, native: 8 },
  { id: 'micro5', label: 'Micro 5', family: 'Micro 5', pixel: true, native: 11 },
  { id: 'jacquard12', label: 'Jacquard 12 (Gothic)', family: 'Jacquard 12', pixel: true, native: 21 },
  // pixel-styled outline fonts, binarised with a threshold
  { id: 'pixelify', label: 'Pixelify Sans', family: 'Pixelify Sans', pixel: false, native: 16 },
  { id: 'vt323', label: 'VT323 Terminal', family: 'VT323', pixel: false, native: 20 },
  { id: 'jersey10', label: 'Jersey 10', family: 'Jersey 10', pixel: false, native: 20 },
  { id: 'sixtyfour', label: 'Sixtyfour', family: 'Sixtyfour', pixel: false, native: 16 },
  { id: 'workbench', label: 'Workbench', family: 'Workbench', pixel: false, native: 16 },
  { id: 'dotgothic', label: 'DotGothic16', family: 'DotGothic16', pixel: false, native: 16 },
  { id: 'doto', label: 'Doto (Dot Matrix)', family: 'Doto', pixel: false, native: 24 },
  { id: 'handjet', label: 'Handjet', family: 'Handjet', pixel: false, native: 24 },
  // system outline fonts
  { id: 'arial-black', label: 'Arial Black', family: 'Arial Black', pixel: false, native: 32 },
  { id: 'arial', label: 'Arial', family: 'Arial', pixel: false, native: 24 },
  { id: 'segoe', label: 'Segoe UI', family: 'Segoe UI', pixel: false, native: 24 },
  { id: 'verdana', label: 'Verdana', family: 'Verdana', pixel: false, native: 20 },
  { id: 'trebuchet', label: 'Trebuchet MS', family: 'Trebuchet MS', pixel: false, native: 24 },
  { id: 'georgia', label: 'Georgia', family: 'Georgia', pixel: false, native: 24 },
  { id: 'times', label: 'Times New Roman', family: 'Times New Roman', pixel: false, native: 24 },
  { id: 'courier', label: 'Courier New', family: 'Courier New', pixel: false, native: 20 },
  { id: 'consolas', label: 'Consolas', family: 'Consolas', pixel: false, native: 20 },
  { id: 'impact', label: 'Impact', family: 'Impact', pixel: false, native: 32 },
  { id: 'comic', label: 'Comic Sans MS', family: 'Comic Sans MS', pixel: false, native: 24 },
];

export const fontById = (id: string): FontDef =>
  FONTS.find((f) => f.id === id) ?? { id, label: id, family: id, pixel: false, native: 24 };

/** Bumped whenever web fonts finish loading so cached text renders refresh. */
export let fontEpoch = 0;
const listeners = new Set<() => void>();
export const onFontsChanged = (cb: () => void) => listeners.add(cb);

export async function loadFonts() {
  const fams = FONTS.filter((f) => !f.bitmap).slice(0, 14);
  await Promise.all(fams.map((f) => document.fonts.load(`${f.native}px "${f.family}"`).catch(() => null)));
  fontEpoch++;
  listeners.forEach((l) => l());
}

let canvas: HTMLCanvasElement | null = null;
const ctx2d = () => {
  if (!canvas) canvas = document.createElement('canvas');
  return canvas.getContext('2d', { willReadFrequently: true })!;
};

export interface TextLayout {
  cover: Buf;
  /** body inside outline-font glyphs (painted with the text's inside paint) */
  inner: Buf | null;
  /** layout box (where the caret/edit box goes), not the tight ink bounds */
  box: { x: number; y: number; w: number; h: number };
}

export const alignOffset = (align: TextObj['align'], w: number) => (align === 'center' ? Math.floor(w / 2) : align === 'right' ? w : 0);

interface RawLayout {
  ink: Uint8Array;
  inner: Uint8Array | null;
  cw: number;
  ch: number;
  pad: number;
  boxW: number;
  boxH: number;
  lh: number;
  widths: number[];
  baselines: number[];
  lines: string[];
  /** size of one font pixel (for synthetic styles) */
  unit: number;
}

const lineOffset = (t: TextObj, boxW: number, w: number) => (t.align === 'center' ? Math.round((boxW - w) / 2) : t.align === 'right' ? boxW - w : 0);

/** Lays out text with one of the bundled bitmap fonts: exact pixels, scaled by whole numbers. */
function layoutBitmap(t: TextObj, f: FontDef): RawLayout {
  const m = bitmapMetrics(f.id);
  const unit = Math.max(1, Math.round(t.size / f.native));
  const gap = unit + t.letterSpacing;
  const lines = (t.text || '').split('\n');
  const glyphLines = lines.map((l) => [...l].map((c) => bitmapGlyph(f.id, c)));
  const widths = glyphLines.map((gs) => Math.max(0, gs.reduce((a, g) => a + g.w * unit + gap, 0) - gap));
  const rows = m.maxRow - m.minRow + 1;
  const lh = Math.max(1, (rows + 1) * unit + t.lineSpacing);
  const boxW = Math.max(1, ...widths);
  const boxH = Math.max(1, lines.length * lh - (unit + t.lineSpacing));
  const pad = 9 * unit + 4;
  const cw = boxW + pad * 2,
    ch = boxH + pad * 2;
  const ink = new Uint8Array(cw * ch);
  const inner = m.outline ? new Uint8Array(cw * ch) : null;
  const baselines: number[] = [];
  const block = (arr: Uint8Array, x: number, y: number) => {
    for (let yy = 0; yy < unit; yy++) {
      const py = y + yy;
      if (py < 0 || py >= ch) continue;
      for (let xx = 0; xx < unit; xx++) {
        const px = x + xx;
        if (px >= 0 && px < cw) arr[py * cw + px] = 1;
      }
    }
  };
  glyphLines.forEach((gs, li) => {
    const lineTop = pad + li * lh;
    baselines.push(lineTop + (m.baseRow - m.minRow + 1) * unit);
    let pen = pad + lineOffset(t, boxW, widths[li]);
    for (const g of gs) {
      for (let gy = 0; gy < g.h; gy++)
        for (let gx = 0; gx < g.w; gx++) {
          const i = gy * g.w + gx;
          const x = pen + gx * unit,
            y = lineTop + (gy + g.top - m.minRow) * unit;
          if (g.ink[i]) block(ink, x, y);
          else if (inner && g.inner?.[i]) block(inner, x, y);
        }
      pen += g.w * unit + gap;
    }
  });
  return { ink, inner, cw, ch, pad, boxW, boxH, lh, widths, baselines, lines, unit };
}

/** Lays out text with a web/system font, binarised via supersampling. */
function layoutCanvas(t: TextObj, f: FontDef): RawLayout {
  const ctx = ctx2d();
  const weight = t.bold && !f.pixel ? 'bold ' : '';
  const style = t.italic && !f.pixel ? 'italic ' : '';
  ctx.font = `${style}${weight}${t.size}px "${f.family}", monospace`;
  (ctx as any).letterSpacing = `${t.letterSpacing}px`;
  const lines = (t.text || '').split('\n');
  const m = ctx.measureText('Mgjpq|ÁÉ');
  const ascent = Math.ceil(m.fontBoundingBoxAscent ?? t.size * 0.8);
  const descent = Math.ceil(m.fontBoundingBoxDescent ?? t.size * 0.2);
  const lh = Math.max(1, ascent + descent + t.lineSpacing);
  const widths = lines.map((l) => Math.ceil(ctx.measureText(l).width));
  const boxW = Math.max(1, ...widths);
  const boxH = Math.max(1, lines.length * lh - t.lineSpacing);
  const pad = Math.ceil(t.size * 0.6) + 4;
  const cw = boxW + pad * 2,
    ch = boxH + pad * 2;
  // Supersample: Chrome blurs canvas glyph edges horizontally, so draw large and
  // average each SS×SS block. Pixel fonts come out exact; outline fonts get clean coverage.
  let SS = t.size <= 40 ? 8 : 4;
  while (SS > 1 && Math.max(cw, ch) * SS > 8192) SS >>= 1;
  const c = ctx.canvas;
  const sw = cw * SS,
    sh = ch * SS;
  if (c.width < sw || c.height < sh) {
    c.width = Math.max(c.width, sw);
    c.height = Math.max(c.height, sh);
  }
  ctx.clearRect(0, 0, sw, sh);
  ctx.font = `${style}${weight}${t.size * SS}px "${f.family}", monospace`;
  (ctx as any).letterSpacing = `${t.letterSpacing * SS}px`;
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const baselines: number[] = [];
  lines.forEach((l, i) => {
    const by = pad + i * lh + ascent;
    baselines.push(by);
    ctx.fillText(l, (pad + lineOffset(t, boxW, widths[i])) * SS, by * SS);
  });
  const img = ctx.getImageData(0, 0, sw, sh).data;
  const ink = new Uint8Array(cw * ch);
  const thr = Math.max(1, Math.min(255, t.threshold)) * SS * SS;
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      let sum = 0;
      for (let yy = 0; yy < SS; yy++) {
        let o = ((y * SS + yy) * sw + x * SS) * 4 + 3;
        for (let xx = 0; xx < SS; xx++, o += 4) sum += img[o];
      }
      ink[y * cw + x] = sum >= thr ? 1 : 0;
    }
  return { ink, inner: null, cw, ch, pad, boxW, boxH, lh, widths, baselines, lines, unit: Math.max(1, Math.round(t.size / f.native)) };
}

/** Rasterises a text object into 0/1 coverage buffers in canvas space. */
export function rasterText(t: TextObj): TextLayout {
  const f = fontById(t.font);
  const L = f.bitmap ? layoutBitmap(t, f) : layoutCanvas(t, f);
  const { cw, ch, pad, boxW, boxH, lh, widths, baselines, lines, unit } = L;
  let ink = L.ink,
    inner = L.inner;
  const gridFont = f.pixel || !!f.bitmap;

  if (t.underline) {
    lines.forEach((l, i) => {
      if (!l.trim()) return;
      const off = lineOffset(t, boxW, widths[i]);
      const uy = baselines[i] + (gridFont ? unit : Math.max(1, Math.round(t.size / 10)));
      const th = gridFont ? unit : Math.max(1, Math.round(t.size / 14));
      for (let k = 0; k < th; k++) ink.fill(1, (uy + k) * cw + pad + off, (uy + k) * cw + pad + off + widths[i]);
    });
  }
  // synthetic styles for grid fonts keep glyphs on the pixel grid
  if (gridFont && t.italic) {
    const slant = (src: Uint8Array) => {
      const out = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) {
        const li = Math.min(lines.length - 1, Math.max(0, Math.floor((y - pad) / lh)));
        const shift = Math.floor((baselines[li] - y) / (3 * unit)) * unit;
        for (let x = 0; x < cw; x++) {
          const sx = x - shift;
          if (sx >= 0 && sx < cw && src[y * cw + sx]) out[y * cw + x] = 1;
        }
      }
      return out;
    };
    ink = slant(ink);
    if (inner) inner = slant(inner);
  }
  if (gridFont && t.bold) {
    const out = ink.slice();
    for (let y = 0; y < ch; y++)
      for (let x = cw - 1; x >= 0; x--) if (ink[y * cw + x]) for (let k = 1; k <= unit && x + k < cw; k++) out[y * cw + x + k] = 1;
    ink = out;
  }
  if (t.flipX || t.flipY) {
    // mirror within the layout box
    const flip = (src: Uint8Array) => {
      const out = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++)
        for (let x = 0; x < cw; x++) {
          if (!src[y * cw + x]) continue;
          const nx = t.flipX ? 2 * pad + boxW - 1 - x : x;
          const ny = t.flipY ? 2 * pad + boxH - 1 - y : y;
          if (nx >= 0 && ny >= 0 && nx < cw && ny < ch) out[ny * cw + nx] = 1;
        }
      return out;
    };
    ink = flip(ink);
    if (inner) inner = flip(inner);
  }
  if (inner) for (let i = 0; i < inner.length; i++) if (ink[i]) inner[i] = 0;
  // alignment is also the anchor: x is the left edge, the center, or the right edge
  const boxX = t.x - alignOffset(t.align, boxW);
  const cover = new Buf(boxX - pad, t.y - pad, cw, ch, ink);
  return {
    cover,
    inner: inner ? new Buf(cover.x, cover.y, cw, ch, inner) : null,
    box: { x: boxX, y: t.y, w: boxW, h: boxH },
  };
}
