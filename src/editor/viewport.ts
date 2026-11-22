import { app, emit, on, type View } from '../app/state';
import { composite, toRGBA, objBounds, renderObj } from '../core/render';
import { locate } from '../core/doc';
import type { Obj, Rect } from '../core/types';
import { tools, type PtrInfo } from './tools';
import { h } from '../ui/dom';

export const ZOOMS = [0.125, 0.25, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64];

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

class Viewport {
  el!: HTMLElement;
  canvas!: HTMLCanvasElement;
  ctx!: CanvasRenderingContext2D;
  private paper = document.createElement('canvas');
  private compDirty = true;
  private spaceDown = false;
  private panning: { sx: number; sy: number; px: number; py: number } | null = null;
  private dragging = false;
  private antsPhase = 0;
  hoverId: string | null = null;
  lastPtr: PtrInfo | null = null;
  private shadowPat: CanvasPattern | null = null;

  get dpr() {
    return window.devicePixelRatio || 1;
  }

  get view(): View {
    return app.active?.view ?? { zoom: 1, panX: 0, panY: 0 };
  }

  mount(parent: HTMLElement) {
    this.canvas = h('canvas', { class: 'viewport-canvas' });
    this.el = h('div', { class: 'viewport' }, this.canvas);
    parent.append(this.el);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(this.el);
    on('render', () => {
      this.compDirty = true;
      this.draw();
    });
    on('view', () => this.draw());
    on('selection', () => this.draw());
    on('tool', () => {
      this.updateCursor();
      this.draw();
    });
    on('tabs', () => {
      if (app.active && !app.active.view.zoom) this.fit();
      this.compDirty = true;
      this.draw();
    });
    on('settings', () => this.draw());
    this.bindInput();
    // marching ants
    setInterval(() => {
      const d = app.active;
      if (d && (d.selection.length || tools[app.tool].animated?.())) {
        this.antsPhase = (this.antsPhase + 1) % 8;
        this.draw();
      }
    }, 110);
  }

  resize() {
    const r = this.el.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * this.dpr)),
      hh = Math.max(1, Math.round(r.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== hh) {
      const first = this.canvas.width <= 300;
      this.canvas.width = w;
      this.canvas.height = hh;
      if (app.active && (!app.active.view.zoom || first)) this.fit();
    }
    this.draw();
  }

  // ------------------------------------------------------------ coordinates

  docToScreen(x: number, y: number) {
    const v = this.view;
    return { x: v.panX + x * v.zoom, y: v.panY + y * v.zoom };
  }

  /** client (CSS) coords → doc coords (float) */
  clientToDoc(cx: number, cy: number) {
    const r = this.canvas.getBoundingClientRect();
    const dx = (cx - r.left) * this.dpr,
      dy = (cy - r.top) * this.dpr;
    const v = this.view;
    return { fx: (dx - v.panX) / v.zoom, fy: (dy - v.panY) / v.zoom, sx: dx, sy: dy };
  }

  /** doc rect → CSS-pixel rect relative to the window */
  docRectToClient(r: Rect): DOMRect {
    const cr = this.canvas.getBoundingClientRect();
    const a = this.docToScreen(r.x, r.y);
    const v = this.view;
    return new DOMRect(cr.left + a.x / this.dpr, cr.top + a.y / this.dpr, (r.w * v.zoom) / this.dpr, (r.h * v.zoom) / this.dpr);
  }

  fit() {
    const d = app.active;
    if (!d || this.canvas.width < 10) return;
    const m = 64 * this.dpr;
    const zx = (this.canvas.width - m) / d.data.width,
      zy = (this.canvas.height - m) / d.data.height;
    const z = Math.min(zx, zy);
    let zoom = z >= 1 ? Math.max(1, Math.floor(z)) : ZOOMS.filter((q) => q <= z).pop() ?? ZOOMS[0];
    zoom = Math.min(zoom, 48);
    d.view.zoom = zoom;
    d.view.panX = Math.round((this.canvas.width - d.data.width * zoom) / 2);
    d.view.panY = Math.round((this.canvas.height - d.data.height * zoom) / 2);
    emit('view');
  }

  setZoom(z: number, anchorX?: number, anchorY?: number) {
    const d = app.active;
    if (!d) return;
    const v = d.view;
    const ax = anchorX ?? this.canvas.width / 2,
      ay = anchorY ?? this.canvas.height / 2;
    const docX = (ax - v.panX) / v.zoom,
      docY = (ay - v.panY) / v.zoom;
    v.zoom = Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1], z));
    v.panX = Math.round(ax - docX * v.zoom);
    v.panY = Math.round(ay - docY * v.zoom);
    emit('view');
  }

  zoomStep(dir: 1 | -1, ax?: number, ay?: number) {
    const z = this.view.zoom;
    const next = dir > 0 ? ZOOMS.find((q) => q > z + 1e-6) : [...ZOOMS].reverse().find((q) => q < z - 1e-6);
    if (next) this.setZoom(next, ax, ay);
  }

  /** Zoom expressed in CSS pixels per doc pixel (what users think of as "800%"). */
  get cssZoom() {
    return this.view.zoom / this.dpr;
  }

  // ------------------------------------------------------------ input

  private ptr(e: PointerEvent | MouseEvent): PtrInfo {
    const { fx, fy, sx, sy } = this.clientToDoc(e.clientX, e.clientY);
    return { x: Math.floor(fx), y: Math.floor(fy), fx, fy, sx, sy, button: e.button, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
  }

  private bindInput() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      if (!app.active) return;
      // stop the compat mousedown from moving focus (keeps tool-opened editors focused)
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      (document.activeElement as HTMLElement)?.blur?.();
      const p = this.ptr(e);
      if (e.button === 1 || this.spaceDown || app.tool === 'hand') {
        this.panning = { sx: e.clientX, sy: e.clientY, px: this.view.panX, py: this.view.panY };
        this.el.classList.add('grabbing');
        return;
      }
      this.dragging = true;
      tools[app.tool].down?.(p);
      this.lastPtr = p;
      this.draw();
    });
    c.addEventListener('pointermove', (e) => {
      if (!app.active) return;
      if (this.panning) {
        this.view.panX = this.panning.px + (e.clientX - this.panning.sx) * this.dpr;
        this.view.panY = this.panning.py + (e.clientY - this.panning.sy) * this.dpr;
        emit('view');
        return;
      }
      const p = this.ptr(e);
      const prev = app.cursor;
      app.cursor = { x: p.x, y: p.y };
      if (!prev || prev.x !== p.x || prev.y !== p.y) emit('cursor');
      this.lastPtr = p;
      tools[app.tool].move?.(p, this.dragging);
      if (!this.dragging && app.tool === 'select') this.updateHover(p);
      this.draw();
    });
    const end = (e: PointerEvent) => {
      if (this.panning) {
        this.panning = null;
        this.el.classList.remove('grabbing');
        return;
      }
      if (!this.dragging) return;
      this.dragging = false;
      tools[app.tool].up?.(this.ptr(e));
      this.draw();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      app.cursor = null;
      this.hoverId = null;
      emit('cursor');
      this.lastPtr = null;
      this.draw();
    });
    c.addEventListener('dblclick', (e) => tools[app.tool].dblclick?.(this.ptr(e)));
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (!app.active) return;
        const { sx, sy } = this.clientToDoc(e.clientX, e.clientY);
        if (e.ctrlKey || e.metaKey) {
          // Mouse wheels send big notches; trackpad pinches send a stream of small ctrl+wheel
          // deltas. Accumulate so a pinch zooms smoothly through the steps instead of racing.
          const now = performance.now();
          const d = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
          if (now - this.pinch.t > 300 || Math.sign(d) !== Math.sign(this.pinch.acc)) this.pinch.acc = 0;
          this.pinch.t = now;
          if (Math.abs(d) >= 50) {
            // one mouse-wheel notch = one zoom step
            this.zoomStep(d < 0 ? 1 : -1, sx, sy);
            this.pinch.acc = 0;
          } else {
            this.pinch.acc += d;
            const STEP = 22;
            while (Math.abs(this.pinch.acc) >= STEP) {
              const dir = this.pinch.acc < 0 ? 1 : -1;
              this.zoomStep(dir, sx, sy);
              this.pinch.acc += dir * STEP;
            }
          }
        } else {
          const k = e.deltaMode === 1 ? 16 : 1;
          if (e.shiftKey) this.view.panX -= (e.deltaY || e.deltaX) * k * this.dpr;
          else {
            this.view.panX -= e.deltaX * k * this.dpr;
            this.view.panY -= e.deltaY * k * this.dpr;
          }
          emit('view');
        }
      },
      { passive: false },
    );
    // a pinch (ctrl+wheel) anywhere else must never zoom the whole interface
    window.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey && e.target !== c) e.preventDefault();
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping()) {
        if (!this.spaceDown) {
          this.spaceDown = true;
          this.el.classList.add('grab');
        }
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        this.el.classList.remove('grab');
      }
    });
    // components dropped from the library
    this.el.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('application/x-monobit-component')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        this.el.classList.add('drop-target');
      }
    });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('drop-target'));
    this.el.addEventListener('drop', (e) => {
      this.el.classList.remove('drop-target');
      const id = e.dataTransfer?.getData('application/x-monobit-component');
      if (!id) return;
      e.preventDefault();
      const { fx, fy } = this.clientToDoc(e.clientX, e.clientY);
      this.onDropComponent?.(id, Math.round(fx), Math.round(fy));
    });
  }

  private pinch = { acc: 0, t: 0 };

  onDropComponent?: (id: string, x: number, y: number) => void;

  updateCursor() {
    this.canvas.style.cursor = tools[app.tool].cursor();
  }

  private updateHover(p: PtrInfo) {
    const id = tools.select.pick?.(p)?.id ?? null;
    if (id !== this.hoverId) {
      this.hoverId = id;
    }
  }

  // ------------------------------------------------------------ drawing

  private ensureShadowPattern() {
    if (this.shadowPat) return this.shadowPat;
    const c = document.createElement('canvas');
    c.width = c.height = 2;
    const x = c.getContext('2d')!;
    x.fillStyle = '#000';
    x.fillRect(0, 0, 1, 1);
    x.fillRect(1, 1, 1, 1);
    this.shadowPat = this.ctx.createPattern(c, 'repeat');
    return this.shadowPat;
  }

  private rebuildPaper() {
    const d = app.active!;
    const px = composite(d.data);
    const img = toRGBA(px, d.data.width, d.data.height, app.settings.showCheckerboard);
    if (this.paper.width !== d.data.width || this.paper.height !== d.data.height) {
      this.paper.width = d.data.width;
      this.paper.height = d.data.height;
    }
    this.paper.getContext('2d')!.putImageData(img, 0, 0);
    this.compDirty = false;
    this.onComposite?.(this.paper);
  }

  onComposite?: (c: HTMLCanvasElement) => void;

  draw() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const W = this.canvas.width,
      H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const d = app.active;
    if (!d) return;
    if (this.compDirty) this.rebuildPaper();
    const v = d.view;
    const dw = d.data.width * v.zoom,
      dh = d.data.height * v.zoom;
    const px = Math.round(v.panX),
      py = Math.round(v.panY);
    const u = Math.max(1, Math.round(this.dpr));
    // dithered drop shadow under the paper
    ctx.fillStyle = this.ensureShadowPattern()!;
    ctx.fillRect(px + 6 * u, py + 6 * u, dw, dh);
    ctx.fillStyle = '#000';
    ctx.fillRect(px - u, py - u, dw + 2 * u, dh + 2 * u);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.paper, px, py, dw, dh);

    // pixel grid (dotted, difference blend so it shows on black and white)
    const cssZ = v.zoom / this.dpr;
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, dw, dh);
    ctx.clip();
    if (app.settings.grid && cssZ >= app.settings.gridMin) {
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = 'rgba(255,255,255,0.32)';
      const x0 = Math.max(0, Math.floor(-px / v.zoom)),
        x1 = Math.min(d.data.width, Math.ceil((W - px) / v.zoom));
      const y0 = Math.max(0, Math.floor(-py / v.zoom)),
        y1 = Math.min(d.data.height, Math.ceil((H - py) / v.zoom));
      for (let x = x0 + 1; x < x1; x++) ctx.fillRect(px + x * v.zoom, Math.max(py, 0), 1, Math.min(dh, H));
      for (let y = y0 + 1; y < y1; y++) ctx.fillRect(Math.max(px, 0), py + y * v.zoom, Math.min(dw, W), 1);
    }
    const tg = app.settings.tileGrid;
    if (tg > 1 && tg * v.zoom >= 6) {
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (let x = tg; x < d.data.width; x += tg) ctx.fillRect(px + x * v.zoom, py, u, dh);
      for (let y = tg; y < d.data.height; y += tg) ctx.fillRect(px, py + y * v.zoom, dw, u);
    }
    ctx.restore();

    // symmetry guides
    const o = app.opts;
    if ((app.tool === 'pencil' || app.tool === 'eraser') && (o.symX || o.symY)) {
      ctx.save();
      ctx.globalCompositeOperation = 'difference';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = u;
      ctx.setLineDash([4 * u, 4 * u]);
      ctx.beginPath();
      if (o.symX) {
        const x = px + (d.data.width / 2) * v.zoom + 0.5;
        ctx.moveTo(x, py - 12 * u);
        ctx.lineTo(x, py + dh + 12 * u);
      }
      if (o.symY) {
        const y = py + (d.data.height / 2) * v.zoom + 0.5;
        ctx.moveTo(px - 12 * u, y);
        ctx.lineTo(px + dw + 12 * u, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // scope (entered group)
    if (d.scope) {
      const g = locate(d.data.objects, d.scope)?.obj;
      const b = g && objBounds(g);
      if (b) this.dashedRect(b, 0, [2 * u, 3 * u], 'rgba(255,255,255,0.9)', 3);
    }

    // hover
    if (app.tool === 'select' && this.hoverId && !d.selection.includes(this.hoverId) && !this.dragging) {
      const ho = locate(d.data.objects, this.hoverId)?.obj;
      const b = ho && objBounds(ho);
      if (b) this.dashedRect(b, 0, [u, u], '#fff', 1);
    }

    // selection
    const sel = d.selected();
    for (const so of sel) {
      const b = objBounds(so);
      if (b) this.dashedRect(b, this.antsPhase * u, [4 * u, 4 * u], '#fff', 1);
    }
    if (app.tool === 'select' && sel.length) this.drawHandles(sel);

    tools[app.tool].overlay?.(ctx, this);

    // brush preview
    const lp = this.lastPtr;
    if (lp && (app.tool === 'pencil' || app.tool === 'eraser')) {
      const s = Math.max(1, o.brushSize);
      const off = Math.floor((s - 1) / 2);
      const a = this.docToScreen(lp.x - off, lp.y - off);
      ctx.save();
      ctx.globalCompositeOperation = 'difference';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = u;
      ctx.strokeRect(a.x + 0.5, a.y + 0.5, s * v.zoom - 1, s * v.zoom - 1);
      ctx.restore();
    }
  }

  dashedRect(b: Rect, phase: number, dash: number[], color: string, widthMul: number) {
    const ctx = this.ctx;
    const u = Math.max(1, Math.round(this.dpr));
    const a = this.docToScreen(b.x, b.y);
    const w = b.w * this.view.zoom,
      hh = b.h * this.view.zoom;
    ctx.save();
    ctx.lineWidth = u * widthMul;
    ctx.strokeStyle = '#000';
    ctx.setLineDash([]);
    ctx.strokeRect(a.x - u + 0.5, a.y - u + 0.5, w + 2 * u - 1, hh + 2 * u - 1);
    ctx.strokeStyle = color;
    ctx.setLineDash(dash);
    ctx.lineDashOffset = -phase;
    ctx.strokeRect(a.x - u + 0.5, a.y - u + 0.5, w + 2 * u - 1, hh + 2 * u - 1);
    ctx.restore();
  }

  /** Screen-space handle rects for a single selected object. */
  handleRects(o: Obj): { id: Handle | `p${number}`; x: number; y: number; s: number }[] {
    const u = Math.max(1, Math.round(this.dpr));
    const s = 7 * u;
    if (o.type === 'line') {
      return o.points.map(([x, y], i) => {
        const a = this.docToScreen(x + 0.5, y + 0.5);
        return { id: `p${i}` as const, x: a.x - s / 2, y: a.y - s / 2, s };
      });
    }
    const b = objBounds(o);
    if (!b) return [];
    const a = this.docToScreen(b.x, b.y);
    const z = this.view.zoom;
    const x0 = a.x - u,
      y0 = a.y - u,
      x1 = a.x + b.w * z + u,
      y1 = a.y + b.h * z + u;
    const xm = (x0 + x1) / 2,
      ym = (y0 + y1) / 2;
    const pos: Record<Handle, [number, number]> = { nw: [x0, y0], n: [xm, y0], ne: [x1, y0], e: [x1, ym], se: [x1, y1], s: [xm, y1], sw: [x0, y1], w: [x0, ym] };
    return HANDLES.map((hd) => ({ id: hd, x: Math.round(pos[hd][0] - s / 2), y: Math.round(pos[hd][1] - s / 2), s }));
  }

  private drawHandles(sel: Obj[]) {
    if (sel.length !== 1 || sel[0].locked) return;
    const ctx = this.ctx;
    const u = Math.max(1, Math.round(this.dpr));
    for (const r of this.handleRects(sel[0])) {
      ctx.fillStyle = '#000';
      ctx.fillRect(r.x - u, r.y - u, r.s + 2 * u, r.s + 2 * u);
      ctx.fillStyle = '#fff';
      ctx.fillRect(r.x, r.y, r.s, r.s);
    }
  }

  /** Re-renders a fresh composite immediately (export/preview helpers). */
  get paperCanvas() {
    if (this.compDirty && app.active) this.rebuildPaper();
    return this.paper;
  }
}

export function isTyping() {
  const a = document.activeElement as HTMLElement | null;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
}

export const viewport = new Viewport();
export { renderObj };
