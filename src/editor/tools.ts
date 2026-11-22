import { app, emit, setSelection, type EditorDoc } from '../app/state';
import { locate, moveObj, newBitmap, newLine, newShape, newText, remapObj, ensureBitmapCovers, cloneFresh, nextRev } from '../core/doc';
import { hitTest, objBounds, composite } from '../core/render';
import { line as bresenham, brushOffsets, floodRegion, rectIntersects, normRect } from '../core/raster';
import { paintAt, patPaint } from '../core/patterns';
import type { Obj, BitmapObj, LineObj, ShapeObj, TextObj, Rect, Paint } from '../core/types';
import { cursorFor } from '../ui/icons';
import type { Handle } from './viewport';

export interface PtrInfo {
  x: number;
  y: number;
  fx: number;
  fy: number;
  sx: number;
  sy: number;
  button: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export interface Tool {
  cursor(): string;
  down?(p: PtrInfo): void;
  move?(p: PtrInfo, dragging: boolean): void;
  up?(p: PtrInfo): void;
  dblclick?(p: PtrInfo): void;
  key?(e: KeyboardEvent): boolean;
  cancel?(): void;
  overlay?(ctx: CanvasRenderingContext2D, vp: any): void;
  pick?(p: PtrInfo): Obj | null;
  animated?(): boolean;
}

// late-bound hooks provided by the UI layer (avoids import cycles)
export const hooks = {
  vp: null as any,
  toast: (_msg: string) => {},
  editText: (_o: TextObj, _isNew: boolean) => {},
};

const doc = () => app.active as EditorDoc;
const tol = () => Math.max(1, Math.ceil((5 * (window.devicePixelRatio || 1)) / Math.max(0.1, doc().view.zoom)));

/** Topmost visible, unlocked object in the current scope under the pointer. */
function pickAt(p: PtrInfo, includeLocked = false): Obj | null {
  const list = doc().scopeList;
  const t = tol();
  for (let i = list.length - 1; i >= 0; i--) {
    const o = list[i];
    if (!o.visible || (o.locked && !includeLocked)) continue;
    if (hitTest(o, p.x, p.y, o.type === 'line' ? t : Math.min(t, 1))) return o;
  }
  return null;
}

/** Inserts an object into the current scope above the current selection (or on top). */
export function insertObj(o: Obj, select = true) {
  const d = doc();
  const list = d.scopeList;
  let idx = list.length;
  const selIdx = d.selection.map((id) => list.findIndex((x) => x.id === id)).filter((i) => i >= 0);
  if (selIdx.length) idx = Math.max(...selIdx) + 1;
  list.splice(idx, 0, o);
  if (select) d.selection = [o.id];
  emit('doc', 'selection');
}

function removeObj(o: Obj) {
  const l = locate(doc().data.objects, o.id);
  if (l) l.list.splice(l.index, 1);
  doc().selection = doc().selection.filter((id) => id !== o.id);
}

const strokeFromOpts = (paint: Paint) => ({
  width: app.strokeOn ? app.opts.strokeWidth : 0,
  style: app.opts.strokeStyle,
  dash: app.opts.dash,
  gap: app.opts.gap,
  paint: structuredClone(paint),
});

// ------------------------------------------------------------ select

type Drag =
  | { kind: 'move'; start: PtrInfo; orig: Map<string, Obj>; applied: [number, number]; moved: boolean }
  | { kind: 'marquee'; start: PtrInfo; cur: PtrInfo; additive: boolean }
  | { kind: 'resize'; handle: Handle; obj: Obj; orig: Obj; rect: Rect; moved: boolean }
  | { kind: 'point'; obj: LineObj; index: number; moved: boolean };

const selectTool = (): Tool => {
  let drag: Drag | null = null;
  return {
    cursor: () => cursorFor('select', 2, 1, 'default'),
    pick: (p) => pickAt(p),
    down(p) {
      const d = doc();
      const sel = d.selected();
      // handles first
      if (sel.length === 1 && !sel[0].locked) {
        const vp = hooks.vp;
        for (const r of vp.handleRects(sel[0])) {
          const pad = 3;
          if (p.sx >= r.x - pad && p.sx <= r.x + r.s + pad && p.sy >= r.y - pad && p.sy <= r.y + r.s + pad) {
            const o = sel[0];
            if (typeof r.id === 'string' && r.id.startsWith('p') && o.type === 'line') {
              drag = { kind: 'point', obj: o, index: parseInt(r.id.slice(1)), moved: false };
            } else {
              drag = { kind: 'resize', handle: r.id as Handle, obj: o, orig: structuredClone(o), rect: objBounds(o)!, moved: false };
            }
            return;
          }
        }
      }
      let hit = pickAt(p);
      if (hit) {
        if (p.shift) {
          const s = new Set(d.selection);
          if (s.has(hit.id)) s.delete(hit.id);
          else s.add(hit.id);
          setSelection([...s]);
          if (!s.has(hit.id)) return;
        } else if (!d.selection.includes(hit.id)) setSelection([hit.id]);
        if (p.alt) {
          // alt-drag duplicates
          const copies = d.selected().map((o) => {
            const c = cloneFresh(o);
            const l = locate(d.data.objects, o.id)!;
            l.list.splice(l.index + 1, 0, c);
            return c;
          });
          d.selection = copies.map((c) => c.id);
          emit('selection');
        }
        const orig = new Map<string, Obj>();
        for (const o of d.selected()) if (!o.locked) orig.set(o.id, o);
        drag = { kind: 'move', start: p, orig, applied: [0, 0], moved: false };
      } else {
        drag = { kind: 'marquee', start: p, cur: p, additive: p.shift };
        if (!p.shift) setSelection([]);
      }
    },
    move(p) {
      if (!drag) return;
      const d = doc();
      if (drag.kind === 'move') {
        let dx = p.x - drag.start.x,
          dy = p.y - drag.start.y;
        if (p.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
        const [ax, ay] = drag.applied;
        if (dx !== ax || dy !== ay) {
          for (const o of drag.orig.values()) moveObj(o, dx - ax, dy - ay);
          drag.applied = [dx, dy];
          drag.moved = true;
          emit('render');
        }
      } else if (drag.kind === 'marquee') {
        drag.cur = p;
      } else if (drag.kind === 'point') {
        const pts = drag.obj.points;
        let [nx, ny] = [p.x, p.y];
        if (p.shift && pts.length > 1) {
          const ref = pts[drag.index === 0 ? 1 : drag.index - 1];
          [nx, ny] = snap45(ref[0], ref[1], nx, ny);
        }
        if (pts[drag.index][0] !== nx || pts[drag.index][1] !== ny) {
          pts[drag.index] = [nx, ny];
          drag.moved = true;
          emit('render');
        }
      } else if (drag.kind === 'resize') {
        const r = drag.rect;
        let x0 = r.x,
          y0 = r.y,
          x1 = r.x + r.w,
          y1 = r.y + r.h;
        const hd = drag.handle;
        const px = Math.round(p.fx),
          py = Math.round(p.fy);
        if (hd.includes('w')) x0 = Math.min(px, x1 - 1);
        if (hd.includes('e')) x1 = Math.max(px, x0 + 1);
        if (hd.includes('n')) y0 = Math.min(py, y1 - 1);
        if (hd.includes('s')) y1 = Math.max(py, y0 + 1);
        if (p.shift && hd.length === 2) {
          const ar = r.w / r.h;
          const w = x1 - x0,
            h = y1 - y0;
          if (w / h > ar) {
            const nw = Math.round(h * ar);
            if (hd.includes('w')) x0 = x1 - nw;
            else x1 = x0 + nw;
          } else {
            const nh = Math.round(w / ar);
            if (hd.includes('n')) y0 = y1 - nh;
            else y1 = y0 + nh;
          }
        }
        if (p.alt) {
          const cx = r.x + r.w / 2,
            cy = r.y + r.h / 2;
          if (hd.includes('w') || hd.includes('e')) {
            const half = Math.max(Math.abs(x0 - cx), Math.abs(x1 - cx));
            x0 = Math.round(cx - half);
            x1 = Math.round(cx + half);
          }
          if (hd.includes('n') || hd.includes('s')) {
            const half = Math.max(Math.abs(y0 - cy), Math.abs(y1 - cy));
            y0 = Math.round(cy - half);
            y1 = Math.round(cy + half);
          }
        }
        const nr = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        Object.assign(drag.obj, structuredClone(drag.orig));
        if (drag.obj.type === 'group') {
          const fresh = structuredClone(drag.orig) as any;
          (drag.obj as any).children = fresh.children;
        }
        remapObj(drag.obj, r, nr);
        drag.moved = true;
        emit('render');
      }
      void d;
    },
    up() {
      if (!drag) return;
      const d = doc();
      if (drag.kind === 'move' && drag.moved) d.commit(drag.orig.size > 1 ? 'Move objects' : 'Move');
      else if (drag.kind === 'move' && !drag.moved && d.selection.length > 1 && !drag.start.shift) {
        // plain click on one of several selected objects selects just it
        const hit = pickAt(drag.start);
        if (hit) setSelection([hit.id]);
      } else if (drag.kind === 'point' && drag.moved) d.commit('Edit points');
      else if (drag.kind === 'resize' && drag.moved) d.commit('Resize');
      else if (drag.kind === 'marquee') {
        const r = normRect(drag.start.x, drag.start.y, drag.cur.x, drag.cur.y);
        if (r.w > 1 || r.h > 1) {
          const ids = d.scopeList.filter((o) => o.visible && !o.locked && (() => {
            const b = objBounds(o);
            return b && rectIntersects(b, r);
          })()).map((o) => o.id);
          setSelection(drag.additive ? [...new Set([...d.selection, ...ids])] : ids);
        }
      }
      drag = null;
      emit('selection', 'doc');
    },
    dblclick(p) {
      const d = doc();
      const hit = pickAt(p);
      if (hit?.type === 'group') {
        d.scope = hit.id;
        hit.expanded = true;
        setSelection([]);
        hooks.toast(`Editing group “${hit.name}” — Esc to exit`);
        emit('doc');
      } else if (hit?.type === 'text') {
        hooks.editText(hit, false);
      } else if (!hit && d.scope) {
        const prev = d.scope;
        d.scope = locate(d.data.objects, prev)?.parent?.id ?? null;
        setSelection([prev]);
        emit('doc');
      }
    },
    overlay(ctx, vp) {
      if (drag?.kind !== 'marquee') return;
      const r = normRect(drag.start.x, drag.start.y, drag.cur.x, drag.cur.y);
      const u = Math.max(1, Math.round(window.devicePixelRatio));
      const a = vp.docToScreen(r.x, r.y);
      ctx.save();
      ctx.globalCompositeOperation = 'difference';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = u;
      ctx.setLineDash([3 * u, 3 * u]);
      ctx.strokeRect(a.x + 0.5, a.y + 0.5, r.w * vp.view.zoom, r.h * vp.view.zoom);
      ctx.restore();
    },
    cancel() {
      drag = null;
    },
  };
};

function snap45(x0: number, y0: number, x1: number, y1: number): [number, number] {
  const dx = x1 - x0,
    dy = y1 - y0;
  const ang = Math.atan2(dy, dx);
  const q = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.max(Math.abs(dx), Math.abs(dy));
  const cx = Math.round(Math.cos(q)),
    cy = Math.round(Math.sin(q));
  return [x0 + cx * len, y0 + cy * len];
}

// ------------------------------------------------------------ pencil & eraser

function targetBitmap(create: boolean): BitmapObj | null {
  const d = doc();
  const sel = d.selected();
  if (sel.length === 1 && sel[0].type === 'bitmap' && !sel[0].locked && sel[0].visible) return sel[0];
  if (!create) return null;
  const b = newBitmap(0, 0, d.data.width, d.data.height, `Pixels ${countType('bitmap') + 1}`);
  insertObj(b);
  hooks.toast('New pixel layer created');
  return b;
}

function countType(t: Obj['type']) {
  let n = 0;
  const rec = (l: Obj[]) =>
    l.forEach((o) => {
      if (o.type === t) n++;
      if (o.type === 'group') rec(o.children);
    });
  rec(doc().data.objects);
  return n;
}

const brushTool = (erase: boolean): Tool => {
  let target: BitmapObj | null = null;
  let last: [number, number] | null = null;
  let paint: Paint | null = null;
  // pixel-perfect bookkeeping: recent stamped points with prior values
  let trail: { x: number; y: number; prev: [number, number, number][] }[] = [];
  let lastStroke: [number, number] | null = null;

  const write = (x: number, y: number, rec: [number, number, number][]) => {
    const b = target!;
    const offs = brushOffsets(app.opts.brushSize, app.opts.brushRound);
    const W = doc().data.width,
      H = doc().data.height;
    const pts: [number, number][] = [[x, y]];
    if (app.opts.symX) pts.push([W - 1 - x, y]);
    if (app.opts.symY) pts.push([x, H - 1 - y]);
    if (app.opts.symX && app.opts.symY) pts.push([W - 1 - x, H - 1 - y]);
    for (const [cx, cy] of pts)
      for (const [ox, oy] of offs) {
        const px = cx + ox,
          py = cy + oy;
        if (!erase) ensureBitmapCovers(b, px, py, px, py);
        const ix = px - b.x,
          iy = py - b.y;
        if (ix < 0 || iy < 0 || ix >= b.w || iy >= b.h) continue;
        const v = erase ? 0 : paintAt(paint!, px, py, { x: 0, y: 0, w: W, h: H });
        if (!erase && v === 0) continue;
        const i = iy * b.w + ix;
        if (b.data[i] !== v) {
          rec.push([px, py, b.data[i]]);
          b.data[i] = v;
        }
      }
  };

  const stamp = (x: number, y: number) => {
    const rec: [number, number, number][] = [];
    write(x, y, rec);
    if (app.opts.pixelPerfect && app.opts.brushSize === 1) {
      trail.push({ x, y, prev: rec });
      // Pixel-perfect: an L-corner a→b→c is only a "doubled" pixel when the stroke is
      // stair-stepping. Decide one pixel later: if the next step d turns back to the a→b
      // direction it's a staircase, so drop b; if it keeps going, b is a real corner.
      if (trail.length >= 4) {
        const [a, b, c, d] = trail.slice(-4);
        const lCorner = (a.x === b.x || a.y === b.y) && (c.x === b.x || c.y === b.y) && a.x !== c.x && a.y !== c.y;
        const zigzag = d.x - c.x === b.x - a.x && d.y - c.y === b.y - a.y;
        if (lCorner && zigzag) {
          const bm = target!;
          for (const [px, py, pv] of [...b.prev].reverse()) {
            const i = (py - bm.y) * bm.w + (px - bm.x);
            if (i >= 0 && i < bm.data.length) bm.data[i] = pv;
          }
          trail.splice(trail.length - 3, 1);
        }
      }
      if (trail.length > 5) trail.shift();
    }
  };

  return {
    cursor: () => cursorFor('crosshair', 7, 7, 'crosshair'),
    down(p) {
      target = targetBitmap(!erase);
      if (!target && erase) {
        // erase on the topmost pixel layer under the cursor
        const list = doc().scopeList;
        for (let i = list.length - 1; i >= 0; i--) {
          const o = list[i];
          if (o.type === 'bitmap' && o.visible && !o.locked && p.x >= o.x && p.y >= o.y && p.x < o.x + o.w && p.y < o.y + o.h) {
            target = o;
            setSelection([o.id]);
            break;
          }
        }
        if (!target) {
          hooks.toast('Eraser works on pixel layers — select one first');
          return;
        }
      }
      if (!target) return;
      paint = p.button === 2 ? app.fillPaint : app.strokePaint;
      trail = [];
      if (p.shift && lastStroke) bresenham(lastStroke[0], lastStroke[1], p.x, p.y, stamp);
      else stamp(p.x, p.y);
      last = [p.x, p.y];
      target.rev = nextRev();
      emit('render');
    },
    move(p, dragging) {
      if (!dragging || !target || !last) return;
      if (last[0] === p.x && last[1] === p.y) return;
      bresenham(last[0], last[1], p.x, p.y, stamp, true);
      last = [p.x, p.y];
      target.rev = nextRev();
      emit('render');
    },
    up() {
      if (!target) return;
      target.rev = nextRev();
      lastStroke = last;
      doc().commit(erase ? 'Erase' : 'Draw');
      target = null;
      last = null;
    },
  };
};

// ------------------------------------------------------------ fill bucket

/** Fills a pixel region; gradients span the region's bounds, or the drag from `a` to `b`. */
function fillPixels(p: PtrInfo, paint: Paint, a?: [number, number], b?: [number, number]) {
  const d = doc();
  const W = d.data.width,
    H = d.data.height;
  if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return;
  let grid: Uint8Array;
  const existing = targetBitmap(false);
  if (app.opts.fillSampleAll || !existing) grid = composite(d.data);
  else {
    grid = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const bx = x - existing.x,
          by = y - existing.y;
        grid[y * W + x] = bx >= 0 && by >= 0 && bx < existing.w && by < existing.h ? existing.data[by * existing.w + bx] : 0;
      }
  }
  let region: Uint8Array;
  if (app.opts.fillContiguous) region = floodRegion(grid, W, H, p.x, p.y, app.opts.fillDiagonal);
  else {
    const t = grid[p.y * W + p.x];
    region = grid.map((v) => (v === t ? 1 : 0));
  }
  // region bounds: a gradient fill spans exactly the filled area
  let x0 = W,
    y0 = H,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (region[y * W + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return;
  const box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  const pt = paint.kind === 'gradient' && a && b ? { ...paint, p0: a, p1: b } : paint;
  const bm = targetBitmap(true)!;
  ensureBitmapCovers(bm, 0, 0, W - 1, H - 1);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      if (!region[y * W + x]) continue;
      const v = paintAt(pt, x, y, box);
      if (v) bm.data[(y - bm.y) * bm.w + (x - bm.x)] = v;
    }
  bm.rev = nextRev();
  d.commit(paint.kind === 'gradient' ? 'Gradient fill' : 'Fill');
}

const fillTool = (): Tool => {
  // gradients wait for the release so a drag can set their direction
  let pending: { p: PtrInfo; paint: Paint; cur: PtrInfo } | null = null;
  const apply = (p: PtrInfo, paint: Paint, end?: PtrInfo) => {
    const d = doc();
    const dragged = !!end && (end.x !== p.x || end.y !== p.y);
    if (!p.shift) {
      const hit = pickAt(p);
      if (hit && (hit.type === 'shape' || hit.type === 'text')) {
        const np = structuredClone(paint);
        // on objects a drag sets the gradient's angle (gradient stays relative to the object)
        if (np.kind === 'gradient' && dragged) np.angle = Math.round((Math.atan2(end!.fy - p.fy, end!.fx - p.fx) * 180) / Math.PI);
        if (hit.type === 'shape') hit.fill = np;
        else hit.paint = np;
        d.commit(hit.type === 'shape' ? 'Fill shape' : 'Fill text');
        return;
      }
    }
    fillPixels(p, paint, dragged ? [p.x, p.y] : undefined, dragged ? [end!.x, end!.y] : undefined);
  };
  return {
    cursor: () => cursorFor('fill', 13, 13, 'crosshair'),
    down(p) {
      const paint = p.button === 2 ? app.fillPaint : app.slot === 'fill' ? app.fillPaint : app.strokePaint;
      if (paint.kind === 'gradient') pending = { p, paint, cur: p };
      else apply(p, paint);
    },
    move(p, dragging) {
      if (pending && dragging) pending.cur = p;
    },
    up(p) {
      if (!pending) return;
      const { p: start, paint } = pending;
      pending = null;
      apply(start, paint, p);
    },
    cancel: () => (pending = null),
    animated: () => !!pending,
    overlay(ctx, vp) {
      if (!pending || (pending.cur.x === pending.p.x && pending.cur.y === pending.p.y)) return;
      const u = Math.max(1, Math.round(window.devicePixelRatio));
      const a = vp.docToScreen(pending.p.x + 0.5, pending.p.y + 0.5);
      const b = vp.docToScreen(pending.cur.x + 0.5, pending.cur.y + 0.5);
      ctx.save();
      ctx.lineWidth = 3 * u;
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.lineWidth = u;
      ctx.strokeStyle = '#000';
      ctx.setLineDash([4 * u, 3 * u]);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const [pt, fill] of [
        [a, '#fff'],
        [b, '#000'],
      ] as const) {
        ctx.fillStyle = '#000';
        ctx.fillRect(pt.x - 5 * u, pt.y - 5 * u, 10 * u, 10 * u);
        ctx.fillStyle = fill;
        ctx.fillRect(pt.x - 3 * u, pt.y - 3 * u, 6 * u, 6 * u);
      }
      ctx.restore();
    },
  };
};

// ------------------------------------------------------------ line

const lineTool = (): Tool => {
  let cur: LineObj | null = null;
  let poly = false;
  const finish = () => {
    if (!cur) return;
    const d = doc();
    if (poly) cur.points.pop(); // drop floating point
    if (cur.points.length < 1) removeObj(cur);
    else d.commit(cur.points.length > 2 ? 'Polyline' : 'Line');
    cur = null;
    poly = false;
    emit('doc', 'selection');
  };
  return {
    cursor: () => cursorFor('crosshair', 7, 7, 'crosshair'),
    down(p) {
      const o = app.opts;
      if (o.lineMode === 'polyline') {
        if (!cur) {
          cur = newLine([[p.x, p.y], [p.x, p.y]], strokeFromOpts(app.strokePaint), { arrowStart: o.arrowStart, arrowEnd: o.arrowEnd, name: 'Polyline' });
          cur.stroke.width = Math.max(1, o.strokeWidth);
          insertObj(cur);
          poly = true;
          return;
        }
        const first = cur.points[0];
        if (cur.points.length > 3 && Math.abs(first[0] - p.x) <= 1 && Math.abs(first[1] - p.y) <= 1) {
          cur.closed = true;
          finish();
          return;
        }
        cur.points.push([p.x, p.y]);
        return;
      }
      cur = newLine([[p.x, p.y], [p.x, p.y]], strokeFromOpts(app.strokePaint), { arrowStart: o.arrowStart, arrowEnd: o.arrowEnd });
      cur.stroke.width = Math.max(1, o.strokeWidth);
      insertObj(cur);
    },
    move(p, dragging) {
      if (!cur) return;
      if (!dragging && !poly) return;
      const pts = cur.points;
      const a = pts[pts.length - 2];
      const [x, y] = p.shift ? snap45(a[0], a[1], p.x, p.y) : [p.x, p.y];
      pts[pts.length - 1] = [x, y];
      emit('render');
    },
    up() {
      if (!cur || poly) return;
      const d = doc();
      d.commit('Line');
      cur = null;
    },
    dblclick() {
      if (poly && cur) {
        cur.points.pop(); // dblclick added a duplicate point
        finish();
      }
    },
    key(e) {
      if (!poly) return false;
      if (e.key === 'Enter' || e.key === 'Escape') {
        finish();
        return true;
      }
      return false;
    },
    cancel: () => finish(),
    animated: () => poly,
  };
};

// ------------------------------------------------------------ shapes

const shapeTool = (): Tool => {
  let cur: ShapeObj | null = null;
  let anchor: PtrInfo | null = null;
  let moved = false;
  return {
    cursor: () => cursorFor('crosshair', 7, 7, 'crosshair'),
    down(p) {
      const o = app.opts;
      anchor = p;
      moved = false;
      const stroke = strokeFromOpts(app.strokePaint);
      cur = newShape(o.shapeKind, { x: p.x, y: p.y, w: 1, h: 1 }, stroke, app.fillOn ? app.fillPaint : null, {
        radius: o.radius,
        sides: o.sides,
        inner: o.inner,
      });
      insertObj(cur);
    },
    move(p, dragging) {
      if (!dragging || !cur || !anchor) return;
      let dx = p.x - anchor.x,
        dy = p.y - anchor.y;
      if (p.shift) {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx || 1) * m;
        dy = Math.sign(dy || 1) * m;
      }
      let r: Rect;
      if (p.alt) r = { x: anchor.x - Math.abs(dx), y: anchor.y - Math.abs(dy), w: Math.abs(dx) * 2 + 1, h: Math.abs(dy) * 2 + 1 };
      else r = normRect(anchor.x, anchor.y, anchor.x + dx, anchor.y + dy);
      Object.assign(cur, r);
      moved = true;
      emit('render');
    },
    up() {
      if (!cur) return;
      if (!moved) {
        const s = 24;
        Object.assign(cur, { x: cur.x - s / 2, y: cur.y - s / 2, w: s, h: s });
      }
      doc().commit(cur.name);
      cur = null;
      anchor = null;
    },
  };
};

// ------------------------------------------------------------ text

const textTool = (): Tool => ({
  cursor: () => cursorFor('text', 7, 8, 'text'),
  down(p) {
    const hit = pickAt(p);
    if (hit && hit.type === 'text') {
      setSelection([hit.id]);
      hooks.editText(hit, false);
      return;
    }
    const o = app.opts;
    const t = newText(p.x, p.y, '', {
      font: o.font,
      size: o.fontSize,
      align: o.textAlign,
      paint: structuredClone(app.strokePaint),
    });
    insertObj(t);
    hooks.editText(t, true);
  },
});

// ------------------------------------------------------------ picker

const pickerTool = (): Tool => ({
  cursor: () => cursorFor('picker', 1, 14, 'crosshair'),
  down(p) {
    const setSlot = (pt: Paint) => {
      if (app.slot === 'stroke') app.strokePaint = structuredClone(pt);
      else app.fillPaint = structuredClone(pt);
      emit('paint');
    };
    const hit = p.shift ? null : pickAt(p, true);
    if (hit?.type === 'shape') {
      app.strokePaint = structuredClone(hit.stroke.paint);
      if (hit.fill) app.fillPaint = structuredClone(hit.fill);
      emit('paint');
      hooks.toast('Picked stroke & fill');
      return;
    }
    if (hit?.type === 'line') return setSlot(hit.stroke.paint), hooks.toast('Picked line paint');
    if (hit?.type === 'text') return setSlot(hit.paint), hooks.toast('Picked text paint');
    // grab the 8×8 tile under the cursor as a pattern
    const d = doc();
    const px = composite(d.data);
    const tx = p.x & ~7,
      ty = p.y & ~7;
    const pat: number[] = [];
    for (let y = 0; y < 8; y++) {
      let b = 0;
      for (let x = 0; x < 8; x++) {
        const xx = tx + x,
          yy = ty + y;
        if (xx >= 0 && yy >= 0 && xx < d.data.width && yy < d.data.height && px[yy * d.data.width + xx] === 1) b |= 0x80 >> x;
      }
      pat.push(b);
    }
    setSlot(patPaint(pat));
    hooks.toast('Grabbed 8×8 tile as pattern');
  },
});

// ------------------------------------------------------------ hand & zoom

const handTool = (): Tool => ({ cursor: () => cursorFor('hand', 8, 8, 'grab') });

const zoomTool = (): Tool => ({
  cursor: () => cursorFor('zoom', 6, 6, 'zoom-in'),
  down(p) {
    hooks.vp.zoomStep(p.alt || p.button === 2 ? -1 : 1, p.sx, p.sy);
  },
});

export const tools: Record<string, Tool> = {
  select: selectTool(),
  pencil: brushTool(false),
  eraser: brushTool(true),
  fill: fillTool(),
  line: lineTool(),
  shape: shapeTool(),
  text: textTool(),
  picker: pickerTool(),
  hand: handTool(),
  zoom: zoomTool(),
};

export const TOOL_INFO: { id: keyof typeof tools; label: string; key: string; icon: string; hint: string }[] = [
  { id: 'select', label: 'Select', key: 'V', icon: 'select', hint: 'Click to select · Shift adds · Alt-drag duplicates · Double-click group to enter' },
  { id: 'pencil', label: 'Pencil', key: 'B', icon: 'pencil', hint: 'Draw pixels · Right-click uses fill paint · Shift-click draws a line' },
  { id: 'eraser', label: 'Eraser', key: 'E', icon: 'eraser', hint: 'Erase pixels from the selected pixel layer' },
  { id: 'fill', label: 'Fill', key: 'G', icon: 'fill', hint: 'Fill an area · Gradients: drag to set direction · Click a shape to set its fill · Shift forces a pixel fill' },
  { id: 'line', label: 'Line', key: 'L', icon: 'line', hint: 'Drag to draw · Shift snaps to 45° · Polyline: click points, Enter to finish' },
  { id: 'shape', label: 'Shape', key: 'U', icon: 'shape', hint: 'Drag to draw · Shift = equal sides · Alt = from center · Click for 24×24' },
  { id: 'text', label: 'Text', key: 'T', icon: 'text', hint: 'Click to add text · Click existing text to edit' },
  { id: 'picker', label: 'Pattern Picker', key: 'I', icon: 'picker', hint: 'Pick an object’s paint · Click pixels to grab an 8×8 tile pattern' },
  { id: 'hand', label: 'Hand', key: 'H', icon: 'hand', hint: 'Drag to pan · Hold Space with any tool' },
  { id: 'zoom', label: 'Zoom', key: 'Z', icon: 'zoom', hint: 'Click to zoom in · Alt-click to zoom out · Ctrl+wheel anywhere' },
];
