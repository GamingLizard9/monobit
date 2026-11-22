import { h } from './dom';
import { app, emit } from '../app/state';
import { locate } from '../core/doc';
import { objBounds } from '../core/render';
import { viewport } from '../editor/viewport';
import type { TextObj } from '../core/types';

let current: { obj: TextObj; el: HTMLElement; isNew: boolean; finish: () => void } | null = null;

/** Floating retro editor for text objects; updates the canvas live as you type. */
export function editText(obj: TextObj, isNew: boolean) {
  current?.finish();
  const d = app.active;
  if (!d) return;
  const ta = h('textarea', { class: 'text-edit-area', spellcheck: false, rows: 2 }) as HTMLTextAreaElement;
  ta.value = obj.text;
  const done = h('button', { class: 'btn small primary', type: 'button' }, 'Done');
  const el = h('div', { class: 'window text-editor' }, h('div', { class: 'window-title' }, h('span', { class: 'stripes' }), h('span', { class: 'title-text' }, 'Text'), h('span', { class: 'stripes' })), ta, h('div', { class: 'text-edit-foot' }, h('span', { class: 'hint' }, 'Enter = new line · Ctrl+Enter = done'), done));
  document.body.append(el);
  const place = () => {
    const b = objBounds(obj) ?? { x: obj.x, y: obj.y, w: 1, h: 1 };
    const r = viewport.docRectToClient(b);
    const er = el.getBoundingClientRect();
    let x = r.left,
      y = r.bottom + 10;
    if (y + er.height > window.innerHeight - 30) y = Math.max(40, r.top - er.height - 10);
    x = Math.max(8, Math.min(window.innerWidth - er.width - 8, x));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };
  place();
  ta.focus();
  ta.select();
  requestAnimationFrame(() => document.activeElement !== ta && ta.focus());
  ta.addEventListener('input', () => {
    obj.text = ta.value;
    emit('render');
    place();
  });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if ((e.key === 'Enter' && (e.ctrlKey || e.metaKey)) || e.key === 'Escape') {
      e.preventDefault();
      finish();
    }
  });
  const outside = (e: PointerEvent) => {
    if (!el.contains(e.target as Node)) finish();
  };
  setTimeout(() => window.addEventListener('pointerdown', outside, true));
  done.addEventListener('click', () => finish());
  const finish = () => {
    if (!current || current.el !== el) return;
    window.removeEventListener('pointerdown', outside, true);
    el.classList.add('closing');
    setTimeout(() => el.remove(), 120);
    current = null;
    const doc = app.active;
    if (!doc) return;
    if (!obj.text.trim()) {
      const l = locate(doc.data.objects, obj.id);
      if (l) l.list.splice(l.index, 1);
      doc.selection = doc.selection.filter((id) => id !== obj.id);
      if (!isNew) doc.commit('Delete text');
      emit('doc', 'selection');
      return;
    }
    if (obj.name === 'Text' || obj.name.startsWith('“')) obj.name = `“${obj.text.split('\n')[0].slice(0, 18)}”`;
    doc.selection = [obj.id];
    doc.commit(isNew ? 'Add text' : 'Edit text');
    emit('selection');
  };
  current = { obj, el, isNew, finish };
}

export function finishTextEdit() {
  current?.finish();
}
