import { h, clear } from './dom';
import { icon } from './icons';
import { app } from '../app/state';

let layer: HTMLElement;
let toasts: HTMLElement;

export function mountOverlay() {
  layer = h('div', { class: 'overlay-layer' });
  toasts = h('div', { class: 'toasts' });
  document.body.append(layer, toasts);
}

const animOn = () => app.settings.animations;

// ------------------------------------------------------------ toasts

export function toast(msg: string, opts: { action?: { label: string; run: () => void }; ms?: number; kind?: 'info' | 'error' } = {}) {
  const t = h('div', { class: 'toast' + (opts.kind === 'error' ? ' error' : '') }, h('span', { class: 'toast-msg' }, msg));
  if (opts.action) {
    const a = opts.action;
    t.append(
      h(
        'button',
        {
          class: 'btn small',
          onclick: () => {
            a.run();
            dismiss();
          },
        },
        a.label,
      ),
    );
  }
  const dismiss = () => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 200);
  };
  t.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).tagName !== 'BUTTON') dismiss();
  });
  toasts.append(t);
  while (toasts.children.length > 4) toasts.firstElementChild?.remove();
  setTimeout(dismiss, opts.ms ?? (opts.action ? 7000 : 2600));
}

// ------------------------------------------------------------ zoom-rect transition

/** The classic "zooming rectangles" window-open effect. */
export function zoomRects(from: DOMRect, to: DOMRect, reverse = false): Promise<void> {
  if (!animOn()) return Promise.resolve();
  return new Promise((res) => {
    const n = 6;
    const els: HTMLElement[] = [];
    for (let i = 0; i < n; i++) {
      const el = h('div', { class: 'zoom-rect' });
      layer.append(el);
      els.push(el);
    }
    let frame = 0;
    const total = n + 3;
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const step = () => {
      els.forEach((el, i) => {
        const k = frame - i;
        const vis = k >= 0 && k < 4;
        el.style.display = vis ? 'block' : 'none';
        if (!vis) return;
        let t = (i + 1) / n;
        if (reverse) t = 1 - t;
        el.style.left = `${lerp(from.left, to.left, t)}px`;
        el.style.top = `${lerp(from.top, to.top, t)}px`;
        el.style.width = `${lerp(from.width, to.width, t)}px`;
        el.style.height = `${lerp(from.height, to.height, t)}px`;
      });
      frame++;
      if (frame <= total) setTimeout(step, 22);
      else {
        els.forEach((e) => e.remove());
        res();
      }
    };
    step();
  });
}

let lastClick: DOMRect | null = null;
window.addEventListener(
  'pointerdown',
  (e) => {
    lastClick = new DOMRect(e.clientX - 4, e.clientY - 4, 8, 8);
  },
  true,
);

// ------------------------------------------------------------ modal dialogs

export interface ModalButton<T> {
  label: string;
  value: T;
  primary?: boolean;
  danger?: boolean;
}

export interface ModalHandle<T> {
  el: HTMLElement;
  body: HTMLElement;
  close: (v: T) => void;
  result: Promise<T>;
}

let openModals = 0;
export const modalOpen = () => openModals > 0;

export function modal<T>(title: string, body: HTMLElement, buttons: ModalButton<T>[], cancelValue: T, opts: { width?: number; cls?: string } = {}): ModalHandle<T> {
  openModals++;
  const backdrop = h('div', { class: 'modal-backdrop' });
  const btnRow = h('div', { class: 'modal-buttons' });
  const win = h(
    'div',
    { class: 'window modal ' + (opts.cls ?? ''), style: opts.width ? `width:${opts.width}px` : '' },
    h('div', { class: 'window-title' }, h('span', { class: 'stripes' }), h('span', { class: 'title-text' }, title), h('span', { class: 'stripes' })),
    h('div', { class: 'modal-body' }, body),
    btnRow,
  );
  let resolve!: (v: T) => void;
  const result = new Promise<T>((r) => (resolve = r));
  let closed = false;
  const close = (v: T) => {
    if (closed) return;
    closed = true;
    openModals--;
    window.removeEventListener('keydown', onKey, true);
    const r = win.getBoundingClientRect();
    win.classList.add('closing');
    backdrop.classList.add('closing');
    const finish = () => {
      backdrop.remove();
      resolve(v);
    };
    if (animOn()) {
      win.style.opacity = '0';
      zoomRects(r, lastClick ?? new DOMRect(r.left + r.width / 2, r.top + r.height / 2, 1, 1)).then(finish);
    } else finish();
  };
  for (const b of buttons) {
    const el = h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), type: 'button' }, b.label);
    el.addEventListener('click', () => close(b.value));
    btnRow.append(el);
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(cancelValue);
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
      const p = buttons.find((b) => b.primary);
      if (p) {
        e.preventDefault();
        e.stopPropagation();
        // let pending input changes commit first
        (document.activeElement as HTMLElement)?.blur?.();
        setTimeout(() => close(p.value));
      }
    }
    e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  backdrop.append(win);
  layer.append(backdrop);
  // open animation
  const from = lastClick ?? new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 1, 1);
  if (animOn()) {
    // invisible (but focusable) while the zoom rectangles play
    win.style.opacity = '0';
    const to = win.getBoundingClientRect();
    (win.querySelector('input:not([type=checkbox]),textarea,select') as HTMLElement | null)?.focus();
    zoomRects(from, to).then(() => {
      win.style.opacity = '';
      win.classList.add('opened');
    });
  } else {
    win.classList.add('opened');
    setTimeout(() => (win.querySelector('input,textarea,select') as HTMLElement | null)?.focus());
  }
  return { el: win, body: win.querySelector('.modal-body') as HTMLElement, close, result };
}

export async function promptText(title: string, label: string, value: string, okLabel = 'OK'): Promise<string | null> {
  const input = h('input', { class: 'text-input', type: 'text', value }) as HTMLInputElement;
  input.addEventListener('focus', () => input.select());
  const body = h('div', { class: 'form' }, h('label', { class: 'form-label' }, label), input);
  const m = modal<string | null>(
    title,
    body,
    [
      { label: 'Cancel', value: null },
      { label: okLabel, value: '__ok__', primary: true },
    ],
    null,
    { width: 360 },
  );
  const r = await m.result;
  return r === '__ok__' ? input.value.trim() : null;
}

export async function confirmBox(title: string, message: string, buttons: ModalButton<string>[]): Promise<string> {
  const body = h('div', { class: 'confirm' }, h('div', { class: 'confirm-icon' }, icon('component', 32)), h('p', {}, message));
  return modal(title, body, buttons, 'cancel', { width: 420 }).result;
}

// ------------------------------------------------------------ popovers

let openPop: { el: HTMLElement; close: () => void } | null = null;

export function popover(el: HTMLElement, anchor: DOMRect, onClose?: () => void) {
  closePopover();
  const wrap = h('div', { class: 'popover' }, el);
  layer.append(wrap);
  const r = wrap.getBoundingClientRect();
  let x = anchor.left,
    y = anchor.bottom + 4;
  if (x + r.width > window.innerWidth - 8) x = window.innerWidth - 8 - r.width;
  if (y + r.height > window.innerHeight - 8) y = Math.max(8, anchor.top - r.height - 4);
  wrap.style.left = `${Math.max(8, x)}px`;
  wrap.style.top = `${y}px`;
  const outside = (e: PointerEvent) => {
    if (!wrap.contains(e.target as Node)) close();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const close = () => {
    window.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('keydown', key, true);
    wrap.classList.add('closing');
    setTimeout(() => wrap.remove(), 120);
    openPop = null;
    onClose?.();
  };
  setTimeout(() => {
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', key, true);
  });
  openPop = { el: wrap, close };
  return close;
}

export function closePopover() {
  openPop?.close();
}

export { clear };
