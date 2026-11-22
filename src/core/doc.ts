import { BLACK, WHITE, densityPat, patPaint } from './patterns';
import type { Obj, Effects, GroupObj, ShapeObj, LineObj, TextObj, BitmapObj, Rect, ShapeKind, Stroke, Paint } from './types';
import { Buf } from './raster';
import { rasterText, fontById } from './fonts';

let counter = 0;
export const uid = () => Date.now().toString(36).slice(-5) + (counter++).toString(36) + Math.random().toString(36).slice(2, 6);

let revCounter = 1;
/** Globally unique revision stamps (so undo/redo never collides with stale render caches). */
export const nextRev = () => ++revCounter;

export const defaultFx = (): Effects => ({
  shadow: { on: false, dx: 2, dy: 2, style: 'drop', paint: patPaint(densityPat(16)) },
  outline: { on: false, width: 1, round: false, paint: BLACK() },
});

const base = (name: string) => ({
  id: uid(),
  name,
  visible: true,
  locked: false,
  blend: 'normal' as const,
  fx: defaultFx(),
});

export const SHAPE_NAMES: Record<ShapeKind, string> = {
  rect: 'Rectangle',
  roundrect: 'Rounded Rect',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
  rtriangle: 'Right Triangle',
  diamond: 'Diamond',
  polygon: 'Polygon',
  star: 'Star',
  heart: 'Heart',
  arrow: 'Arrow',
};

export const defaultStroke = (paint: Paint = BLACK()): Stroke => ({ width: 1, style: 'solid', dash: 4, gap: 2, paint });

export function newShape(shape: ShapeKind, r: Rect, stroke: Stroke, fill: Paint | null, extra: Partial<ShapeObj> = {}): ShapeObj {
  return {
    ...base(SHAPE_NAMES[shape]),
    type: 'shape',
    shape,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    radius: 4,
    sides: shape === 'star' ? 5 : 6,
    inner: 0.45,
    angle: 0,
    flipX: false,
    flipY: false,
    stroke: structuredClone(stroke),
    fill: fill ? structuredClone(fill) : null,
    ...extra,
  };
}

export function newLine(points: [number, number][], stroke: Stroke, extra: Partial<LineObj> = {}): LineObj {
  return {
    ...base(points.length > 2 ? 'Polyline' : 'Line'),
    type: 'line',
    points,
    closed: false,
    stroke: structuredClone(stroke),
    arrowStart: false,
    arrowEnd: false,
    ...extra,
  };
}

export function newText(x: number, y: number, text: string, extra: Partial<TextObj> = {}): TextObj {
  return {
    ...base('Text'),
    type: 'text',
    x,
    y,
    text,
    font: 'silkscreen',
    size: 16,
    bold: false,
    italic: false,
    underline: false,
    letterSpacing: 0,
    lineSpacing: 0,
    align: 'left',
    threshold: 128,
    flipX: false,
    flipY: false,
    paint: BLACK(),
    ...extra,
  };
}

export function newBitmap(x: number, y: number, w: number, h: number, name = 'Pixels'): BitmapObj {
  return { ...base(name), type: 'bitmap', x, y, w, h, data: new Uint8Array(w * h), rev: nextRev() };
}

export function newGroup(children: Obj[], name = 'Group'): GroupObj {
  return { ...base(name), type: 'group', children, expanded: false };
}

export const TYPE_LABEL: Record<Obj['type'], string> = {
  shape: 'Shape',
  line: 'Line',
  text: 'Text',
  bitmap: 'Pixel Layer',
  image: 'Image',
  group: 'Group',
};

// ------------------------------------------------------------ tree helpers

export interface Loc {
  obj: Obj;
  list: Obj[];
  index: number;
  parent: GroupObj | null;
}

export function locate(objs: Obj[], id: string, parent: GroupObj | null = null): Loc | null {
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    if (o.id === id) return { obj: o, list: objs, index: i, parent };
    if (o.type === 'group') {
      const r = locate(o.children, id, o);
      if (r) return r;
    }
  }
  return null;
}

export function walk(objs: Obj[], cb: (o: Obj, depth: number) => void, depth = 0) {
  for (const o of objs) {
    cb(o, depth);
    if (o.type === 'group') walk(o.children, cb, depth + 1);
  }
}

/** Deep clone with fresh ids (and fresh bitmap revisions). */
export function cloneFresh<T extends Obj>(o: T): T {
  const c = structuredClone(o);
  const fix = (x: Obj) => {
    x.id = uid();
    if (x.type === 'bitmap' || x.type === 'image') x.rev = nextRev();
    if (x.type === 'group') x.children.forEach(fix);
  };
  fix(c);
  return c;
}

export function moveObj(o: Obj, dx: number, dy: number) {
  switch (o.type) {
    case 'line':
      o.points = o.points.map(([x, y]) => [x + dx, y + dy]);
      break;
    case 'group':
      o.children.forEach((c) => moveObj(c, dx, dy));
      break;
    default:
      o.x += dx;
      o.y += dy;
  }
}

function flipData(data: Uint8Array, w: number, h: number, axis: 'x' | 'y') {
  const out = new Uint8Array(data.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = axis === 'x' ? w - 1 - x : x,
        sy = axis === 'y' ? h - 1 - y : y;
      out[y * w + x] = data[sy * w + sx];
    }
  return out;
}

/** Mirrors an object across the vertical (x) or horizontal (y) line through `c` (pixel-edge coordinate ×2). */
export function flipObj(o: Obj, axis: 'x' | 'y', c2: number) {
  // c2 = left+right edge sum, so a pixel at p maps to c2 - 1 - p
  const mx = (p: number) => c2 - 1 - p;
  switch (o.type) {
    case 'shape':
      if (axis === 'x') {
        o.x = mx(o.x + o.w - 1);
        o.flipX = !o.flipX;
      } else {
        o.y = mx(o.y + o.h - 1);
        o.flipY = !o.flipY;
      }
      if (o.angle) o.angle = -o.angle;
      break;
    case 'line':
      o.points = o.points.map(([x, y]) => (axis === 'x' ? [mx(x), y] : [x, mx(y)]));
      break;
    case 'text':
      if (axis === 'x') o.flipX = !o.flipX;
      else o.flipY = !o.flipY;
      break;
    case 'bitmap':
      o.data = flipData(o.data, o.w, o.h, axis);
      o.rev = nextRev();
      if (axis === 'x') o.x = mx(o.x + o.w - 1);
      else o.y = mx(o.y + o.h - 1);
      break;
    case 'image':
      o.src = { ...o.src, data: flipData(o.src.data, o.src.w, o.src.h, axis) };
      o.rev = nextRev();
      if (axis === 'x') o.x = mx(o.x + o.w - 1);
      else o.y = mx(o.y + o.h - 1);
      break;
    case 'group':
      o.children.forEach((ch) => flipObj(ch, axis, c2));
      break;
  }
}

/**
 * Maps an object from one bounding rect to another (resize handles).
 * Groups (and components) scale proportionally: text size, stroke and outline widths,
 * corner radii and shadow offsets scale with the smaller axis factor. A single shape keeps
 * its stroke width (1px borders stay 1px); a single text object scales its font size.
 */
export function remapObj(o: Obj, from: Rect, to: Rect) {
  const sx = to.w / Math.max(1, from.w),
    sy = to.h / Math.max(1, from.h);
  let s: number | null = null;
  if (o.type === 'group') s = Math.min(sx, sy);
  else if (o.type === 'text') s = Math.abs(sy - 1) < 1e-6 ? sx : Math.abs(sx - 1) < 1e-6 ? sy : Math.min(sx, sy);
  remapInner(o, from, to, s);
}

const scaleThick = (v: number, s: number) => (v > 0 ? Math.max(1, Math.round(v * s)) : 0);
const scaleOffset = (v: number, s: number) => (v === 0 ? 0 : Math.sign(v) * Math.max(1, Math.round(Math.abs(v) * s)));

function scaleFx(o: Obj, s: number) {
  o.fx.shadow.dx = scaleOffset(o.fx.shadow.dx, s);
  o.fx.shadow.dy = scaleOffset(o.fx.shadow.dy, s);
  o.fx.outline.width = scaleThick(o.fx.outline.width, s);
}

function remapInner(o: Obj, from: Rect, to: Rect, s: number | null) {
  const sx = to.w / Math.max(1, from.w),
    sy = to.h / Math.max(1, from.h);
  const mx = (x: number) => Math.round(to.x + (x - from.x) * sx);
  const my = (y: number) => Math.round(to.y + (y - from.y) * sy);
  if (s !== null && o.type !== 'group' && o.type !== 'text') scaleFx(o, s);
  switch (o.type) {
    case 'shape':
    case 'image': {
      const nx = mx(o.x),
        ny = my(o.y);
      const nx2 = mx(o.x + o.w),
        ny2 = my(o.y + o.h);
      o.x = nx;
      o.y = ny;
      o.w = Math.max(1, nx2 - nx);
      o.h = Math.max(1, ny2 - ny);
      if (s !== null && o.type === 'shape') {
        o.stroke.width = scaleThick(o.stroke.width, s);
        o.radius = scaleThick(o.radius, s);
      }
      break;
    }
    case 'line':
      o.points = o.points.map(([x, y]) => [mx(x), my(y)]);
      if (s !== null) o.stroke.width = scaleThick(o.stroke.width, s);
      break;
    case 'text': {
      // keep the text's center at the mapped position while its size scales
      const before = rasterText(o).box;
      const cx = before.x + before.w / 2,
        cy = before.y + before.h / 2;
      if (s !== null && s !== 1) {
        const f = fontById(o.font);
        o.size = f.pixel ? f.native * Math.max(1, Math.round((o.size * s) / f.native)) : Math.max(4, Math.round(o.size * s));
        o.letterSpacing = Math.round(o.letterSpacing * s);
        o.lineSpacing = Math.round(o.lineSpacing * s);
        scaleFx(o, s);
      }
      const after = rasterText(o).box;
      o.x += Math.round(to.x + (cx - from.x) * sx - (after.x + after.w / 2));
      o.y += Math.round(to.y + (cy - from.y) * sy - (after.y + after.h / 2));
      break;
    }
    case 'bitmap': {
      // nearest-neighbour rescale of pixel layers
      const nx = mx(o.x),
        ny = my(o.y);
      const nw = Math.max(1, mx(o.x + o.w) - nx),
        nh = Math.max(1, my(o.y + o.h) - ny);
      if (nw !== o.w || nh !== o.h) {
        const out = new Uint8Array(nw * nh);
        for (let y = 0; y < nh; y++)
          for (let x = 0; x < nw; x++) out[y * nw + x] = o.data[Math.floor((y * o.h) / nh) * o.w + Math.floor((x * o.w) / nw)];
        o.data = out;
        o.w = nw;
        o.h = nh;
        o.rev = nextRev();
      }
      o.x = nx;
      o.y = ny;
      break;
    }
    case 'group':
      if (s !== null) scaleFx(o, s);
      o.children.forEach((c) => remapInner(c, from, to, s));
      break;
  }
}

/** Grows a bitmap layer so (x,y) (± pad) is inside it. Returns true if it changed size. */
export function ensureBitmapCovers(b: BitmapObj, x0: number, y0: number, x1: number, y1: number): boolean {
  if (x0 >= b.x && y0 >= b.y && x1 < b.x + b.w && y1 < b.y + b.h) return false;
  const nx = Math.min(b.x, x0 - 16),
    ny = Math.min(b.y, y0 - 16);
  const nr = Math.max(b.x + b.w, x1 + 17),
    nb = Math.max(b.y + b.h, y1 + 17);
  const buf = new Buf(b.x, b.y, b.w, b.h, b.data).reframe({ x: nx, y: ny, w: nr - nx, h: nb - ny });
  b.x = buf.x;
  b.y = buf.y;
  b.w = buf.w;
  b.h = buf.h;
  b.data = buf.data;
  return true;
}

/** Shrinks a bitmap layer to its painted pixels. */
export function trimBitmap(b: BitmapObj) {
  const t = new Buf(b.x, b.y, b.w, b.h, b.data).bounds();
  if (!t) return;
  if (t.w === b.w && t.h === b.h) return;
  const r = new Buf(b.x, b.y, b.w, b.h, b.data).reframe(t);
  Object.assign(b, { x: r.x, y: r.y, w: r.w, h: r.h, data: r.data, rev: nextRev() });
}

export const WHITE_PAINT = WHITE;
