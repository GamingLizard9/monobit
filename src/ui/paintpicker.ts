import { h, clear, numField, segmented, drawSwatch } from './dom';
import { popover, closePopover } from './overlay';
import { DENSITY, TEXTURES, patPaint, patEquals, defaultGradient } from '../core/patterns';
import { app } from '../app/state';
import type { Paint, PaintMode } from '../core/types';

export const MODE_OPTS: { value: PaintMode; label: string; title: string }[] = [
  { value: 'opaque', label: 'Opaque', title: 'Paint both black and white pixels' },
  { value: 'ink', label: 'Black only', title: 'White pixels of the pattern are transparent' },
  { value: 'paper', label: 'White only', title: 'Black pixels of the pattern are transparent' },
];

export function swatchButton(p: Paint | null, size: number, onClick: (e: MouseEvent) => void, title = '') {
  const c = h('canvas') as HTMLCanvasElement;
  drawSwatch(c, p, size, size, 2);
  const b = h('button', { class: 'swatch', type: 'button', title }, c);
  b.addEventListener('click', onClick);
  return b;
}

/** All patterns (density, textures, custom) as a grid. */
export function patternGrid(current: () => Paint | null, choose: (pat: number[]) => void, size = 28) {
  const wrap = h('div', { class: 'pattern-sets' });
  const render = () => {
    clear(wrap);
    const cur = current();
    const group = (label: string, pats: { pat: number[]; name: string }[]) => {
      const g = h('div', { class: 'pattern-grid' });
      for (const p of pats) {
        const sel = cur && cur.kind === 'pattern' && patEquals(cur, { kind: 'pattern', pat: p.pat, mode: cur.mode });
        const b = swatchButton(patPaint(p.pat), size, () => choose([...p.pat]), p.name);
        if (sel) b.classList.add('on');
        g.append(b);
      }
      wrap.append(h('div', { class: 'pattern-label' }, label), g);
    };
    group(
      'Density',
      DENSITY.map((pat, i) => ({ pat, name: i === 0 ? 'White' : i === 15 ? 'Black' : `${Math.round((i / 15) * 100)}% ink` })),
    );
    group('Textures', TEXTURES);
    if (app.settings.customPatterns.length) group('Custom', app.settings.customPatterns.map((pat, i) => ({ pat, name: `Custom ${i + 1}` })));
  };
  render();
  (wrap as any).sync = render;
  return wrap;
}

export function gradientControls(get: () => Paint, set: (p: Paint, final: boolean) => void) {
  const g = () => get() as Extract<Paint, { kind: 'gradient' }>;
  const upd = (fn: (x: Extract<Paint, { kind: 'gradient' }>) => void, final: boolean) => {
    const c = structuredClone(g());
    fn(c);
    set(c, final);
  };
  const preview = h('canvas', { class: 'grad-preview' }) as HTMLCanvasElement;
  const redraw = () => drawSwatch(preview, g(), 200, 40, 1);
  redraw();
  const wrap = h(
    'div',
    { class: 'grad-controls' },
    preview,
    h(
      'div',
      { class: 'row' },
      segmented(
        [
          { value: 'linear', label: 'Linear' },
          { value: 'radial', label: 'Radial' },
        ],
        () => g().shape,
        (v) => (upd((x) => (x.shape = v as any), true), redraw()),
      ),
      segmented(
        [
          { value: 'bayer', label: 'Ordered' },
          { value: 'noise', label: 'Noise' },
        ],
        () => g().dither,
        (v) => (upd((x) => (x.dither = v as any), true), redraw()),
      ),
    ),
    h(
      'div',
      { class: 'row' },
      numField('From', () => Math.round((g().from / 64) * 100), (v, f) => (upd((x) => (x.from = Math.round((v / 100) * 64)), f), redraw()), { min: 0, max: 100, suffix: '%', width: 36 }),
      numField('To', () => Math.round((g().to / 64) * 100), (v, f) => (upd((x) => (x.to = Math.round((v / 100) * 64)), f), redraw()), { min: 0, max: 100, suffix: '%', width: 36 }),
      numField('Angle', () => g().angle, (v, f) => (upd((x) => (x.angle = v), f), redraw()), { min: -360, max: 360, step: 15, suffix: '°', width: 36 }),
    ),
  );
  return wrap;
}

/** Popover for choosing any paint (patterns, gradient, mode, none). */
export function openPaintPicker(anchor: DOMRect, current: Paint | null, onChange: (p: Paint | null, final: boolean) => void, allowNone = false) {
  let cur: Paint | null = current ? structuredClone(current) : null;
  const body = h('div', { class: 'paint-picker' });
  const render = () => {
    clear(body);
    const tabs = h('div', { class: 'row' });
    const kind = cur?.kind ?? 'none';
    const mk = (k: 'pattern' | 'gradient' | 'none', label: string) => {
      const b = h('button', { class: 'seg-btn' + (kind === k ? ' on' : ''), type: 'button' }, label);
      b.addEventListener('click', () => {
        if (k === 'none') cur = null;
        else if (k === 'pattern') cur = patPaint(DENSITY[15], cur?.mode ?? 'opaque');
        else cur = defaultGradient(cur?.mode ?? 'opaque');
        onChange(cur, true);
        render();
      });
      return b;
    };
    const seg = h('div', { class: 'seg' }, mk('pattern', 'Pattern'), mk('gradient', 'Gradient'), allowNone ? mk('none', 'None') : null);
    tabs.append(seg);
    body.append(tabs);
    if (cur?.kind === 'pattern')
      body.append(
        patternGrid(
          () => cur,
          (pat) => {
            cur = { kind: 'pattern', pat, mode: cur?.mode ?? 'opaque' };
            onChange(cur, true);
            render();
          },
          24,
        ),
      );
    if (cur?.kind === 'gradient')
      body.append(
        gradientControls(
          () => cur!,
          (p, f) => {
            cur = p;
            onChange(cur, f);
          },
        ),
      );
    if (cur)
      body.append(
        h('div', { class: 'pattern-label' }, 'Mode'),
        segmented(
          MODE_OPTS,
          () => cur!.mode,
          (v) => {
            cur = { ...cur!, mode: v } as Paint;
            onChange(cur, true);
            render();
          },
        ),
      );
  };
  render();
  popover(body, anchor);
}

export { closePopover };
