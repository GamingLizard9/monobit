import { icon } from './icons';
import { paintSwatchRGBA } from '../core/patterns';
import type { Paint } from '../core/types';

type Attrs = Record<string, any> & { class?: string; style?: string };
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c as any);
  return el;
}

export const clear = (el: HTMLElement) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};

export function btn(label: string | Node, onClick: (e: MouseEvent) => void, opts: { title?: string; icon?: string; cls?: string; disabled?: boolean } = {}) {
  const b = h('button', { class: 'btn ' + (opts.cls ?? ''), title: opts.title, disabled: opts.disabled, onclick: onClick, type: 'button' });
  if (opts.icon) b.append(icon(opts.icon));
  if (label) b.append(typeof label === 'string' ? h('span', {}, label) : label);
  return b;
}

export function iconBtn(name: string, title: string, onClick: (e: MouseEvent) => void, opts: { active?: boolean; disabled?: boolean; cls?: string } = {}) {
  const b = h('button', {
    class: 'icon-btn' + (opts.active ? ' active' : '') + (opts.cls ? ' ' + opts.cls : ''),
    title,
    disabled: opts.disabled,
    type: 'button',
    onclick: (e: MouseEvent) => {
      e.stopPropagation();
      onClick(e);
    },
  });
  b.append(icon(name));
  return b;
}

export interface NumOpts {
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  width?: number;
  title?: string;
  /** called continuously while scrubbing */
  live?: boolean;
}

/**
 * Number field with a scrubbable label: drag the label left/right to change the value.
 * Arrow keys step (shift ×10).
 */
export function numField(label: string, get: () => number, set: (v: number, final: boolean) => void, o: NumOpts = {}) {
  const step = o.step ?? 1;
  const clamp = (v: number) => {
    if (o.min !== undefined) v = Math.max(o.min, v);
    if (o.max !== undefined) v = Math.min(o.max, v);
    const d = step < 1 ? Math.round(1 / step) : 1;
    return step < 1 ? Math.round(v * d) / d : Math.round(v / step) * step;
  };
  const input = h('input', { class: 'num', type: 'text', inputmode: 'decimal', value: String(get()), style: o.width ? `width:${o.width}px` : '' }) as HTMLInputElement;
  const lab = h('label', { class: 'num-label', title: o.title ?? 'Drag to adjust' }, label);
  const commit = (final: boolean) => {
    const v = parseFloat(input.value);
    if (!isNaN(v)) {
      const c = clamp(v);
      input.value = String(c);
      set(c, final);
    } else input.value = String(get());
  };
  input.addEventListener('change', () => commit(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit(true);
      input.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const v = clamp(get() + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
      input.value = String(v);
      set(v, true);
    } else if (e.key === 'Escape') {
      input.value = String(get());
      input.blur();
    }
    e.stopPropagation();
  });
  lab.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const sx = e.clientX;
    const start = get();
    let moved = false;
    lab.setPointerCapture(e.pointerId);
    document.body.classList.add('scrubbing');
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      if (Math.abs(dx) > 2) moved = true;
      const v = clamp(start + Math.round(dx / 4) * step * (ev.shiftKey ? 10 : 1));
      input.value = String(v);
      set(v, false);
    };
    const up = () => {
      lab.removeEventListener('pointermove', mv);
      lab.removeEventListener('pointerup', up);
      document.body.classList.remove('scrubbing');
      if (moved) set(get(), true);
      else input.focus();
    };
    lab.addEventListener('pointermove', mv);
    lab.addEventListener('pointerup', up);
  });
  const el = h('div', { class: 'field num-field' }, lab, input, o.suffix ? h('span', { class: 'suffix' }, o.suffix) : null);
  (el as any).sync = () => {
    if (document.activeElement !== input) input.value = String(get());
  };
  return el;
}

export function toggle(label: string, get: () => boolean, set: (v: boolean) => void, title?: string) {
  const el = h('button', { class: 'toggle' + (get() ? ' on' : ''), type: 'button', title: title ?? label }, h('span', { class: 'box' }), h('span', {}, label));
  el.addEventListener('click', () => {
    set(!get());
    el.classList.toggle('on', get());
  });
  (el as any).sync = () => el.classList.toggle('on', get());
  return el;
}

export function segmented<T extends string>(options: { value: T; label?: string; icon?: string; title?: string }[], get: () => T, set: (v: T) => void) {
  const el = h('div', { class: 'seg' });
  const render = () => {
    clear(el);
    for (const o of options) {
      const b = h('button', { class: 'seg-btn' + (get() === o.value ? ' on' : ''), type: 'button', title: o.title ?? o.label ?? o.value });
      if (o.icon) b.append(icon(o.icon));
      if (o.label) b.append(h('span', {}, o.label));
      b.addEventListener('click', () => {
        set(o.value);
        render();
      });
      el.append(b);
    }
  };
  render();
  (el as any).sync = render;
  return el;
}

export function select<T extends string>(options: { value: T; label: string; group?: string }[], get: () => T, set: (v: T) => void, cls = '') {
  const s = h('select', { class: 'select ' + cls }) as HTMLSelectElement;
  let groupEl: HTMLOptGroupElement | null = null;
  for (const o of options) {
    const opt = h('option', { value: o.value }, o.label);
    if (o.group) {
      if (!groupEl || groupEl.label !== o.group) {
        groupEl = h('optgroup', { label: o.group }) as HTMLOptGroupElement;
        s.append(groupEl);
      }
      groupEl.append(opt);
    } else s.append(opt);
  }
  s.value = get();
  s.addEventListener('change', () => set(s.value as T));
  s.addEventListener('keydown', (e) => e.stopPropagation());
  (s as any).sync = () => {
    if (document.activeElement !== s) s.value = get();
  };
  return h('div', { class: 'select-wrap' }, s, icon('chevDown', 16, 'select-chev'));
}

/** Small canvas showing a paint (pattern or gradient). */
export function swatchCanvas(p: Paint | null, w: number, h_: number, scale = 2): HTMLCanvasElement {
  const c = document.createElement('canvas');
  drawSwatch(c, p, w, h_, scale);
  return c;
}

export function drawSwatch(c: HTMLCanvasElement, p: Paint | null, w: number, h_: number, scale = 2) {
  c.width = w;
  c.height = h_;
  c.className = 'swatch-canvas';
  const ctx = c.getContext('2d')!;
  if (!p) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h_);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w, 0);
    ctx.lineTo(0, h_);
    ctx.stroke();
    return;
  }
  ctx.putImageData(new ImageData(paintSwatchRGBA(p, w, h_, scale), w, h_), 0, 0);
}

export function section(title: string, ...children: Child[]) {
  return h('div', { class: 'section' }, h('div', { class: 'section-title' }, h('span', {}, title)), ...children);
}

export const row = (...c: Child[]) => h('div', { class: 'row' }, ...c);

/** Positions a floating element next to an anchor, staying inside the window. */
export function placeNear(el: HTMLElement, anchor: DOMRect, prefer: 'below' | 'right' = 'below') {
  const r = el.getBoundingClientRect();
  let x = prefer === 'below' ? anchor.left : anchor.right + 4;
  let y = prefer === 'below' ? anchor.bottom + 4 : anchor.top;
  if (x + r.width > window.innerWidth - 8) x = Math.max(8, (prefer === 'below' ? anchor.right : anchor.left - 4) - r.width);
  if (y + r.height > window.innerHeight - 8) y = Math.max(8, (prefer === 'below' ? anchor.top - 4 : anchor.bottom) - r.height);
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
}
