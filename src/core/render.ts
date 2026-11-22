import { Buf, line, ellipseRect, fillInterior, fillRows, erode, dilate, contourIndex, brushOffsets, rectUnion } from './raster';
import { paintAt, WHITE, type PaintBox } from './patterns';
import { rasterText, fontEpoch } from './fonts';
import { renderImagePixels } from './dither';
import type { Obj, ShapeObj, LineObj, Paint, Rect, Stroke, DocData, Effects, Blend } from './types';

/**
 * Rendered object: `pix` holds 0 (transparent) / 1 (black) / 2 (white);
 * `cover` is the object's footprint (used for hit-testing, outlines and shadows).
 */
export interface Sprite {
  pix: Buf;
  cover: Buf;
  /** geometric bounds used for selection handles */
  geo: Rect | null;
}

const EMPTY = (): Sprite => ({ pix: new Buf(0, 0, 0, 0), cover: new Buf(0, 0, 0, 0), geo: null });

// ------------------------------------------------------------ shape geometry

type V = [number, number];

function normUnit(vs: V[]): V[] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [x, y] of vs) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return vs.map(([x, y]) => [(x - x0) / (x1 - x0 || 1), (y - y0) / (y1 - y0 || 1)]);
}

export function unitVerts(o: ShapeObj): V[] {
  switch (o.shape) {
    case 'triangle':
      return [
        [0.5, 0],
        [1, 1],
        [0, 1],
      ];
    case 'rtriangle':
      return [
        [0, 0],
        [1, 1],
        [0, 1],
      ];
    case 'diamond':
      return [
        [0.5, 0],
        [1, 0.5],
        [0.5, 1],
        [0, 0.5],
      ];
    case 'arrow':
      return [
        [0, 0.3],
        [0.58, 0.3],
        [0.58, 0],
        [1, 0.5],
        [0.58, 1],
        [0.58, 0.7],
        [0, 0.7],
      ];
    case 'polygon': {
      const n = Math.max(3, Math.min(32, Math.round(o.sides)));
      return normUnit(
        Array.from({ length: n }, (_, i) => {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
          return [Math.cos(a), Math.sin(a)] as V;
        }),
      );
    }
    case 'star': {
      const n = Math.max(3, Math.min(32, Math.round(o.sides)));
      const inner = Math.max(0.1, Math.min(0.95, o.inner));
      return normUnit(
        Array.from({ length: n * 2 }, (_, i) => {
          const a = -Math.PI / 2 + (i * Math.PI) / n;
          const r = i % 2 ? inner : 1;
          return [Math.cos(a) * r, Math.sin(a) * r] as V;
        }),
      );
    }
    case 'heart': {
      const vs: V[] = [];
      for (let i = 0; i < 64; i++) {
        const t = (i / 64) * Math.PI * 2;
        vs.push([16 * Math.sin(t) ** 3, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]);
      }
      return normUnit(vs);
    }
    default:
      return [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
  }
}

/** Pixel-space polygon vertices for vertex-based shapes (after flips & rotation). */
export function shapeVerts(o: ShapeObj): V[] {
  const w = Math.max(1, o.w),
    h = Math.max(1, o.h);
  const cx = o.x + (w - 1) / 2,
    cy = o.y + (h - 1) / 2;
  const a = ((o.angle || 0) * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  return unitVerts(o).map(([u, v]) => {
    if (o.flipX) u = 1 - u;
    if (o.flipY) v = 1 - v;
    const px = o.x + u * (w - 1) - cx,
      py = o.y + v * (h - 1) - cy;
    return [Math.round(cx + px * c - py * s), Math.round(cy + px * s + py * c)] as V;
  });
}

const isVertexShape = (o: ShapeObj) => !['rect', 'roundrect', 'ellipse'].includes(o.shape);

/** Solid (filled) footprint of a shape. */
export function shapeSolid(o: ShapeObj): Buf {
  const w = Math.max(1, Math.round(o.w)),
    h = Math.max(1, Math.round(o.h));
  const x = Math.round(o.x),
    y = Math.round(o.y);
  if (isVertexShape(o)) {
    const vs = shapeVerts(o);
    let r: Rect | null = null;
    for (const [vx, vy] of vs) r = rectUnion(r, { x: vx, y: vy, w: 1, h: 1 });
    const m = Buf.fromRect(r!);
    const plot = (px: number, py: number) => m.set(px, py, 1);
    for (let i = 0; i < vs.length; i++) {
      const [ax, ay] = vs[i],
        [bx, by] = vs[(i + 1) % vs.length];
      line(ax, ay, bx, by, plot);
    }
    fillInterior(m);
    return m;
  }
  const m = new Buf(x, y, w, h);
  if (o.shape === 'rect') {
    m.data.fill(1);
  } else if (o.shape === 'ellipse') {
    ellipseRect(x, y, x + w - 1, y + h - 1, (px, py) => m.set(px, py, 1));
    fillRows(m);
  } else {
    const d = Math.max(1, Math.min(Math.round(o.radius) * 2, w, h));
    const half = Math.floor(d / 2);
    for (let yy = half; yy < h - half; yy++) m.data.fill(1, yy * w, yy * w + w);
    for (let yy = 0; yy < h; yy++) m.data.fill(1, yy * w + half, yy * w + w - half);
    const corners: V[] = [
      [x, y],
      [x + w - d, y],
      [x, y + h - d],
      [x + w - d, y + h - d],
    ];
    for (const [cx, cy] of corners) {
      const c = new Buf(cx, cy, d, d);
      ellipseRect(cx, cy, cx + d - 1, cy + d - 1, (px, py) => c.set(px, py, 1));
      fillRows(c);
      c.forEachSet((px, py) => m.set(px, py, 1));
    }
  }
  return m;
}

function dashOn(s: Stroke, idx: number): boolean {
  if (s.style === 'solid') return true;
  const w = Math.max(1, s.width);
  if (s.style === 'dotted') {
    const period = w + Math.max(1, s.gap);
    return idx % period < w;
  }
  const dash = Math.max(1, s.dash),
    gap = Math.max(1, s.gap) + (w > 1 ? w - 1 : 0);
  return idx % (dash + gap) < dash;
}

function renderShape(o: ShapeObj): Sprite {
  const solid = shapeSolid(o);
  const box: PaintBox = { x: solid.x, y: solid.y, w: solid.w, h: solid.h };
  const pix = solid.empty();
  const sw = o.stroke.width > 0 ? Math.round(o.stroke.width) : 0;
  let inner = solid;
  let strokeMask: Buf | null = null;
  if (sw > 0) {
    strokeMask = solid.empty();
    for (let k = 0; k < sw; k++) {
      const e = erode(inner);
      for (let i = 0; i < inner.data.length; i++) if (inner.data[i] && !e.data[i]) strokeMask.data[i] = 1;
      inner = e;
    }
  }
  if (o.fill) {
    const f = o.fill;
    inner.forEachSet((px, py) => {
      const v = paintAt(f, px, py, box);
      if (v) pix.set(px, py, v);
    });
  }
  if (strokeMask) {
    const idx = o.stroke.style === 'solid' ? null : contourIndex(solid, strokeMask);
    const sp = o.stroke.paint;
    const W = strokeMask.w;
    for (let i = 0; i < strokeMask.data.length; i++) {
      if (!strokeMask.data[i]) continue;
      if (idx && !dashOn(o.stroke, Math.max(0, idx[i]))) continue;
      const px = (i % W) + strokeMask.x,
        py = Math.floor(i / W) + strokeMask.y;
      const v = paintAt(sp, px, py, box);
      pix.data[i] = v;
    }
  }
  // cover = painted region (fill area counts even if no fill, so hollow shapes stay clickable)
  const cover = solid.clone();
  if (!o.fill && strokeMask) {
    // hollow + dashed: footprint is the stroke band only (for outlines/shadows)
    cover.data.set(strokeMask.data);
    if (o.stroke.style !== 'solid') for (let i = 0; i < cover.data.length; i++) if (!pix.data[i]) cover.data[i] = 0;
  }
  return { pix, cover, geo: { x: solid.x, y: solid.y, w: solid.w, h: solid.h } };
}

// ------------------------------------------------------------ lines

function arrowHead(tip: V, from: V, w: number, plot: (x: number, y: number) => void) {
  const dx = tip[0] - from[0],
    dy = tip[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len,
    uy = dy / len;
  const L = 3 + w * 2,
    hw = L * 0.65;
  const bx = tip[0] - ux * L,
    by = tip[1] - uy * L;
  const pts: V[] = [
    [tip[0], tip[1]],
    [Math.round(bx - uy * hw), Math.round(by + ux * hw)],
    [Math.round(bx + uy * hw), Math.round(by - ux * hw)],
  ];
  let r: Rect | null = null;
  for (const [x, y] of pts) r = rectUnion(r, { x, y, w: 1, h: 1 });
  const m = Buf.fromRect(r!);
  for (let i = 0; i < 3; i++) line(pts[i][0], pts[i][1], pts[(i + 1) % 3][0], pts[(i + 1) % 3][1], (x, y) => m.set(x, y, 1));
  fillInterior(m);
  m.forEachSet(plot);
}

function renderLine(o: LineObj): Sprite {
  const pts = o.points;
  if (!pts.length) return EMPTY();
  const sw = Math.max(1, Math.round(o.stroke.width || 1));
  let r: Rect | null = null;
  for (const [x, y] of pts) r = rectUnion(r, { x, y, w: 1, h: 1 });
  const pad = sw + 6 + sw * 2;
  const cover = Buf.fromRect(r!, pad);
  const brush = brushOffsets(sw, sw >= 3);
  let idx = 0;
  const stamp = (x: number, y: number) => {
    if (dashOn({ ...o.stroke, width: sw }, idx)) for (const [bx, by] of brush) cover.set(x + bx, y + by, 1);
    idx++;
  };
  const seq = o.closed && pts.length > 2 ? [...pts, pts[0]] : pts;
  if (seq.length === 1) stamp(seq[0][0], seq[0][1]);
  for (let i = 1; i < seq.length; i++) line(seq[i - 1][0], seq[i - 1][1], seq[i][0], seq[i][1], stamp, i > 1);
  const plot = (x: number, y: number) => cover.set(x, y, 1);
  if (pts.length > 1 && !o.closed) {
    if (o.arrowEnd) arrowHead(pts[pts.length - 1], pts[pts.length - 2], sw, plot);
    if (o.arrowStart) arrowHead(pts[0], pts[1], sw, plot);
  }
  const t = cover.trimmed();
  const geo = t.w ? { x: t.x, y: t.y, w: t.w, h: t.h } : null;
  const pix = t.empty();
  const box: PaintBox = geo ?? { x: 0, y: 0, w: 1, h: 1 };
  t.forEachSet((x, y) => pix.set(x, y, paintAt(o.stroke.paint, x, y, box)));
  return { pix, cover: t, geo };
}

// ------------------------------------------------------------ paint a cover

function paintCover(cover: Buf, paint: Paint, box?: PaintBox): Buf {
  const pix = cover.empty();
  const b = box ?? { x: cover.x, y: cover.y, w: cover.w, h: cover.h };
  cover.forEachSet((x, y) => {
    const v = paintAt(paint, x, y, b);
    if (v) pix.set(x, y, v);
  });
  return pix;
}

// ------------------------------------------------------------ effects

function applyEffects(base: Sprite, fx: Effects): Sprite {
  const { shadow, outline } = fx;
  if (!shadow.on && !outline.on) return base;
  if (!base.cover.w || !base.cover.h) return base;
  let full = base.cover;
  let ring: Buf | null = null;
  if (outline.on && outline.width > 0) {
    full = dilate(base.cover, Math.round(outline.width), outline.round);
    ring = full.clone();
    base.cover.forEachSet((x, y) => ring!.set(x, y, 0));
  }
  let shadowM: Buf | null = null;
  if (shadow.on && (shadow.dx || shadow.dy)) {
    const steps: V[] = [];
    if (shadow.style === 'extrude') line(0, 0, shadow.dx, shadow.dy, (x, y) => (x || y) && steps.push([x, y]));
    else steps.push([shadow.dx, shadow.dy]);
    const minx = Math.min(0, ...steps.map((s) => s[0])),
      maxx = Math.max(0, ...steps.map((s) => s[0]));
    const miny = Math.min(0, ...steps.map((s) => s[1])),
      maxy = Math.max(0, ...steps.map((s) => s[1]));
    shadowM = new Buf(full.x + minx, full.y + miny, full.w + maxx - minx, full.h + maxy - miny);
    for (const [sx, sy] of steps) full.forEachSet((x, y) => shadowM!.set(x + sx, y + sy, 1));
  }
  let bounds: Rect = { x: full.x, y: full.y, w: full.w, h: full.h };
  if (shadowM) bounds = rectUnion(bounds, shadowM)!;
  const pix = Buf.fromRect(bounds);
  const cover = Buf.fromRect(bounds);
  const geoBox = base.geo ?? bounds;
  if (shadowM) {
    const sb = { x: geoBox.x + shadow.dx, y: geoBox.y + shadow.dy, w: geoBox.w, h: geoBox.h };
    shadowM.forEachSet((x, y) => {
      cover.set(x, y, 1);
      const v = paintAt(shadow.paint, x, y, sb);
      if (v) pix.set(x, y, v);
    });
  }
  if (ring) {
    ring.forEachSet((x, y) => {
      cover.set(x, y, 1);
      const v = paintAt(outline.paint, x, y, geoBox);
      if (v) pix.set(x, y, v);
    });
  }
  base.cover.forEachSet((x, y) => cover.set(x, y, 1));
  base.pix.forEachSet((x, y, v) => pix.set(x, y, v));
  return { pix, cover, geo: base.geo };
}

// ------------------------------------------------------------ cache + dispatch

const cache = new Map<string, { key: string; sprite: Sprite }>();

const keyReplacer = (k: string, v: unknown) => (v instanceof Uint8Array ? undefined : k === 'expanded' || k === 'name' || k === 'locked' ? undefined : v);
export const objKey = (o: Obj) => JSON.stringify(o, keyReplacer) + (o.type === 'text' || o.type === 'group' ? '#' + fontEpoch : '');

export function clearRenderCache() {
  cache.clear();
}

export function renderObj(o: Obj): Sprite {
  const key = objKey(o);
  const hit = cache.get(o.id);
  if (hit && hit.key === key) return hit.sprite;
  const sprite = applyEffects(renderBase(o), o.fx);
  cache.set(o.id, { key, sprite });
  if (cache.size > 4000) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  return sprite;
}

function renderBase(o: Obj): Sprite {
  switch (o.type) {
    case 'shape':
      return renderShape(o);
    case 'line':
      return renderLine(o);
    case 'text': {
      const { cover, inner, box } = rasterText(o);
      const all = cover.clone();
      inner?.forEachSet((x, y) => all.set(x, y, 1));
      const t = all.trimmed();
      const geo = { ...box, w: Math.max(box.w, 1), h: Math.max(box.h, 1) };
      const pb = t.w ? t : undefined;
      const pix = paintCover(cover, o.paint, pb).reframe(t);
      const inside = o.fill === undefined ? WHITE() : o.fill;
      if (inner && inside) paintCover(inner, inside, pb).forEachSet((x, y, v) => pix.set(x, y, v));
      return { pix, cover: t, geo };
    }
    case 'bitmap': {
      const pix = new Buf(o.x, o.y, o.w, o.h, o.data);
      const cover = pix.empty();
      for (let i = 0; i < o.data.length; i++) cover.data[i] = o.data[i] ? 1 : 0;
      return { pix, cover, geo: { x: o.x, y: o.y, w: o.w, h: o.h } };
    }
    case 'image': {
      const w = Math.max(1, Math.round(o.w)),
        h = Math.max(1, Math.round(o.h));
      const pix = new Buf(Math.round(o.x), Math.round(o.y), w, h, renderImagePixels(o));
      const cover = pix.empty();
      cover.data.fill(1);
      return { pix, cover, geo: { x: pix.x, y: pix.y, w, h } };
    }
    case 'group': {
      const visible = o.children.filter((c) => c.visible);
      const sprites = visible.map((c) => ({ s: renderObj(c), blend: c.blend }));
      let r: Rect | null = null;
      let geo: Rect | null = null;
      for (const { s } of sprites) {
        if (s.pix.w) r = rectUnion(r, s.pix);
        if (s.geo) geo = rectUnion(geo, s.geo);
      }
      if (!r) return { ...EMPTY(), geo };
      const pix = Buf.fromRect(r);
      const cover = Buf.fromRect(r);
      for (const { s, blend } of sprites) {
        blitInto(pix.data, pix.x, pix.y, pix.w, pix.h, s.pix, blend, true);
        s.cover.forEachSet((x, y) => cover.set(x, y, 1));
      }
      return { pix, cover, geo };
    }
  }
}

/** Composites a sprite's pixels into a destination grid positioned at (dx,dy). */
export function blitInto(dst: Uint8Array, dx: number, dy: number, dw: number, dh: number, s: Buf, blend: Blend, keepTransparentInvert = false) {
  const x0 = Math.max(dx, s.x),
    y0 = Math.max(dy, s.y);
  const x1 = Math.min(dx + dw, s.x + s.w),
    y1 = Math.min(dy + dh, s.y + s.h);
  for (let y = y0; y < y1; y++) {
    let si = (y - s.y) * s.w + (x0 - s.x);
    let di = (y - dy) * dw + (x0 - dx);
    for (let x = x0; x < x1; x++, si++, di++) {
      const v = s.data[si];
      if (!v) continue;
      if (blend === 'invert') {
        if (v !== 1) continue;
        const cur = dst[di];
        dst[di] = cur === 1 ? 2 : cur === 2 ? 1 : keepTransparentInvert ? 1 : 1;
      } else dst[di] = v;
    }
  }
}

export function bgValue(bg: DocData['background']) {
  return bg === 'black' ? 1 : bg === 'white' ? 2 : 0;
}

/** Full-document composite: one byte per pixel (0 transparent, 1 black, 2 white). */
export function composite(doc: DocData, opts: { background?: boolean } = {}): Uint8Array {
  const { width: W, height: H } = doc;
  const out = new Uint8Array(W * H);
  if (opts.background !== false) out.fill(bgValue(doc.background));
  for (const o of doc.objects) {
    if (!o.visible) continue;
    blitInto(out, 0, 0, W, H, renderObj(o).pix, o.blend);
  }
  return out;
}

/** Composites a list of objects into their own tight bounds (for components, thumbnails, copy). */
export function composeObjects(objs: Obj[], bounds?: Rect): Buf | null {
  let r: Rect | null = bounds ?? null;
  if (!r) for (const o of objs) if (o.visible) r = rectUnion(r, renderObj(o).pix.w ? renderObj(o).pix : null);
  if (!r || !r.w || !r.h) return null;
  const b = Buf.fromRect(r);
  for (const o of objs) if (o.visible) blitInto(b.data, b.x, b.y, b.w, b.h, renderObj(o).pix, o.blend);
  return b;
}

export function objBounds(o: Obj): Rect | null {
  const s = renderObj(o);
  return s.geo ?? (s.pix.w ? s.pix.bounds() : null);
}

/** Full rendered extent including effects. */
export function objExtent(o: Obj): Rect | null {
  const s = renderObj(o);
  return s.pix.w ? { x: s.pix.x, y: s.pix.y, w: s.pix.w, h: s.pix.h } : s.geo;
}

/** Point hit-test against the object's footprint with a pixel tolerance. */
export function hitTest(o: Obj, x: number, y: number, tol: number): boolean {
  const s = renderObj(o);
  const c = s.cover;
  for (let dy = -tol; dy <= tol; dy++) for (let dx = -tol; dx <= tol; dx++) if (c.get(x + dx, y + dy)) return true;
  if (o.type === 'text' && s.geo) {
    const g = s.geo;
    return x >= g.x && y >= g.y && x < g.x + g.w && y < g.y + g.h;
  }
  return false;
}

/** RGBA rendering of 0/1/2 pixels (transparent shown as checker if requested). */
export function toRGBA(px: Uint8Array, w: number, h: number, checker = true, invert = false): ImageData {
  const img = new ImageData(w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) {
    let v = px[i];
    const o = i * 4;
    if (v === 0) {
      if (!checker) {
        d[o + 3] = 0;
        continue;
      }
      const x = i % w,
        y = (i - x) / w;
      const c = ((x >> 2) + (y >> 2)) & 1 ? 236 : 255;
      d[o] = d[o + 1] = d[o + 2] = invert ? 255 - c : c;
      d[o + 3] = 255;
      continue;
    }
    if (invert) v = v === 1 ? 2 : 1;
    const c = v === 1 ? 0 : 255;
    d[o] = d[o + 1] = d[o + 2] = c;
    d[o + 3] = 255;
  }
  return img;
}
