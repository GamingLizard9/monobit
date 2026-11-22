import { h, clear, numField, segmented, toggle, select, iconBtn, drawSwatch } from './dom';
import { icon } from './icons';
import { app, emit, on, setActiveDoc } from '../app/state';
import { COMMANDS, cmd, runCommand, setPaletteOpener } from '../app/commands';
import * as A from '../app/actions';
import * as io from '../app/io';
import { TOOL_INFO } from '../editor/tools';
import { viewport, ZOOMS } from '../editor/viewport';
import { FONTS, fontById } from '../core/fonts';
import { SHAPE_NAMES } from '../core/doc';
import type { ShapeKind, StrokeStyle } from '../core/types';
import { popover, closePopover, modal } from './overlay';
import { newDocDialog } from './dialogs';

// ------------------------------------------------------------ title bar

export function titleBar() {
  const title = h('span', { class: 'title-text', 'data-tauri-drag-region': true }, 'MONOBIT');
  const bar = h(
    'div',
    { class: 'titlebar', 'data-tauri-drag-region': true },
    h('div', { class: 'tb-left' }, h('img', { class: 'tb-logo', src: '/app-icon-64.png', alt: '' })),
    h('span', { class: 'stripes', 'data-tauri-drag-region': true }),
    title,
    h('span', { class: 'stripes', 'data-tauri-drag-region': true }),
    h(
      'div',
      { class: 'tb-buttons' },
      iconBtn('minus', 'Minimize', () => io.windowAction('minimize'), { cls: 'wbtn' }),
      iconBtn('maximize', 'Maximize', () => io.windowAction('maximize'), { cls: 'wbtn' }),
      iconBtn('close', 'Close', () => runCommand('file.quit'), { cls: 'wbtn close' }),
    ),
  );
  const upd = () => {
    const d = app.active;
    const t = d ? `${d.name}${d.dirty ? ' •' : ''} — MONOBIT` : 'MONOBIT';
    title.textContent = t;
    io.setWindowTitle(d ? `${d.name} — Monobit` : 'Monobit');
  };
  on('tabs', upd);
  upd();
  if (!io.isTauri) bar.classList.add('browser');
  return bar;
}

// ------------------------------------------------------------ menu bar

type MenuItem = string | '-' | { label: string; sub: () => MenuItem[] } | { label: string; run: () => void; disabled?: boolean };

const MENUS: { title: string; items: () => MenuItem[] }[] = [
  {
    title: 'File',
    items: () => [
      'file.new',
      'file.open',
      {
        label: 'Open Recent',
        sub: () =>
          app.settings.recent.length
            ? [
                ...app.settings.recent.map((p) => ({ label: p.split(/[\\/]/).pop()!, run: () => A.openRecent(p) })),
                '-' as const,
                {
                  label: 'Clear Recent',
                  run: () => {
                    app.settings.recent = [];
                    A.persistSettingsSoon();
                  },
                },
              ]
            : [{ label: '(none)', run: () => {}, disabled: true }],
      },
      '-',
      'file.save',
      'file.saveAs',
      '-',
      'file.import',
      'file.export',
      'file.copyImage',
      '-',
      'file.libImport',
      'file.libExport',
      '-',
      'file.close',
      ...(io.isTauri ? ['file.quit'] : []),
    ],
  },
  {
    title: 'Edit',
    items: () => ['edit.undo', 'edit.redo', '-', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.duplicate', 'edit.delete', '-', 'edit.selectAll', 'edit.deselect', '-', 'edit.swap', 'edit.defaults'],
  },
  {
    title: 'Object',
    items: () => [
      'obj.group',
      'obj.ungroup',
      'obj.enter',
      'obj.exit',
      '-',
      { label: 'Arrange', sub: () => ['obj.front', 'obj.forward', 'obj.backward', 'obj.back'] },
      { label: 'Align', sub: () => ['obj.alignL', 'obj.alignC', 'obj.alignR', '-', 'obj.alignT', 'obj.alignM', 'obj.alignB', '-', 'obj.distH', 'obj.distV'] },
      'obj.flipH',
      'obj.flipV',
      '-',
      'obj.lock',
      'obj.hide',
      '-',
      'obj.component',
      'obj.syncComponent',
      '-',
      'obj.rasterize',
      'obj.mergeDown',
    ],
  },
  {
    title: 'Image',
    items: () => ['img.size', 'img.crop', 'img.trim', '-', 'img.bgWhite', 'img.bgBlack', 'img.bgNone', '-', 'img.flatten'],
  },
  {
    title: 'View',
    items: () => ['view.zoomIn', 'view.zoomOut', 'view.fit', 'view.actual', '-', 'view.grid', 'view.tile8', 'view.tile16', 'view.checker', '-', 'view.theme', ...(io.isTauri ? ['view.crisp'] : []), 'view.anim', 'view.splash', '-', 'view.palette'],
  },
  { title: 'Help', items: () => ['help.keys', 'help.about'] },
];

let openMenu: { idx: number; el: HTMLElement } | null = null;

function buildMenu(items: MenuItem[], onDone: () => void, depth = 0): HTMLElement {
  const m = h('div', { class: 'menu' + (depth ? ' submenu' : '') });
  for (const it of items) {
    if (it === '-') {
      m.append(h('div', { class: 'menu-sep' }));
      continue;
    }
    if (typeof it === 'string') {
      const c = cmd(it);
      const enabled = !c.enabled || c.enabled();
      const row = h(
        'button',
        { class: 'menu-item' + (enabled ? '' : ' disabled'), type: 'button' },
        h('span', { class: 'menu-check' }, c.checked?.() ? icon('check') : ''),
        h('span', { class: 'menu-label' }, c.label),
        h('span', { class: 'menu-keys' }, c.keys ?? ''),
      );
      if (enabled)
        row.addEventListener('click', () => {
          onDone();
          setTimeout(() => c.run(), 10);
        });
      m.append(row);
      continue;
    }
    if ('sub' in it) {
      const row = h('div', { class: 'menu-item has-sub' }, h('span', { class: 'menu-check' }), h('span', { class: 'menu-label' }, it.label), h('span', { class: 'menu-keys' }, icon('chevRight')));
      let sub: HTMLElement | null = null;
      const openSub = () => {
        m.querySelectorAll(':scope > .submenu').forEach((s) => s.remove());
        sub = buildMenu(it.sub(), onDone, depth + 1);
        m.append(sub);
        const r = row.getBoundingClientRect(),
          mr = m.getBoundingClientRect();
        sub.style.left = `${r.right - mr.left - 2}px`;
        sub.style.top = `${r.top - mr.top - 3}px`;
      };
      row.addEventListener('pointerenter', openSub);
      row.addEventListener('click', openSub);
      m.append(row);
      continue;
    }
    const row = h('button', { class: 'menu-item' + (it.disabled ? ' disabled' : ''), type: 'button' }, h('span', { class: 'menu-check' }), h('span', { class: 'menu-label' }, it.label), h('span', { class: 'menu-keys' }));
    if (!it.disabled)
      row.addEventListener('click', () => {
        onDone();
        setTimeout(it.run, 10);
      });
    row.addEventListener('pointerenter', () => m.querySelectorAll(':scope > .submenu').forEach((s) => s.remove()));
    m.append(row);
  }
  // hovering a plain item closes sibling submenus
  m.querySelectorAll(':scope > button.menu-item').forEach((b) => b.addEventListener('pointerenter', () => m.querySelectorAll(':scope > .submenu').forEach((s) => s.remove())));
  return m;
}

export function menuBar() {
  const bar = h('div', { class: 'menubar' });
  const close = () => {
    if (!openMenu) return;
    openMenu.el.remove();
    bar.querySelectorAll('.menubar-item').forEach((b) => b.classList.remove('open'));
    openMenu = null;
    window.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e: PointerEvent) => {
    if (!openMenu) return;
    const t = e.target as Node;
    if (!openMenu.el.contains(t) && !bar.contains(t)) close();
  };
  const open = (i: number, btn: HTMLElement) => {
    if (openMenu?.idx === i) return;
    close();
    const el = buildMenu(MENUS[i].items(), close);
    el.classList.add('dropdown');
    document.body.append(el);
    const r = btn.getBoundingClientRect();
    el.style.left = `${r.left}px`;
    el.style.top = `${r.bottom}px`;
    btn.classList.add('open');
    openMenu = { idx: i, el };
    setTimeout(() => window.addEventListener('pointerdown', outside, true));
  };
  MENUS.forEach((m, i) => {
    const b = h('button', { class: 'menubar-item', type: 'button' }, m.title);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (openMenu?.idx === i) close();
      else open(i, b);
    });
    b.addEventListener('pointerenter', () => openMenu && open(i, b));
    bar.append(b);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openMenu) {
      e.stopPropagation();
      close();
    }
  }, true);
  window.addEventListener('blur', close);
  bar.append(h('div', { class: 'menubar-spacer' }));
  const palBtn = h('button', { class: 'menubar-item palette-btn', type: 'button', title: 'Command palette (Ctrl+Shift+P)' }, '⌘ Commands');
  palBtn.addEventListener('click', () => openCommandPalette());
  bar.append(palBtn);
  return bar;
}

// ------------------------------------------------------------ command palette

function openCommandPalette() {
  const input = h('input', { class: 'text-input', placeholder: 'Type a command…' }) as HTMLInputElement;
  const list = h('div', { class: 'palette-list' });
  let sel = 0;
  let items = COMMANDS;
  const render = () => {
    const q = input.value.toLowerCase().trim();
    items = COMMANDS.filter((c) => (!c.enabled || c.enabled()) && (!q || q.split(/\s+/).every((w) => (c.label + ' ' + c.id).toLowerCase().includes(w))));
    sel = Math.min(sel, Math.max(0, items.length - 1));
    clear(list);
    items.slice(0, 40).forEach((c, i) => {
      const r = h('div', { class: 'palette-item' + (i === sel ? ' on' : '') }, h('span', {}, c.label), h('span', { class: 'menu-keys' }, c.keys ?? ''));
      r.addEventListener('click', () => {
        m.close(0);
        setTimeout(c.run, 30);
      });
      list.append(r);
    });
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => ((sel = 0), render()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') (sel = Math.min(items.length - 1, sel + 1)), render(), e.preventDefault();
    if (e.key === 'ArrowUp') (sel = Math.max(0, sel - 1)), render(), e.preventDefault();
    if (e.key === 'Enter' && items[sel]) {
      e.preventDefault();
      const c = items[sel];
      m.close(0);
      setTimeout(c.run, 30);
    }
  });
  const m = modal('Commands', h('div', { class: 'palette' }, input, list), [], 0, { width: 480, cls: 'palette-modal' });
  render();
}
setPaletteOpener(openCommandPalette);

// ------------------------------------------------------------ tool options bar

const SHAPES: ShapeKind[] = ['rect', 'roundrect', 'ellipse', 'triangle', 'rtriangle', 'diamond', 'polygon', 'star', 'heart', 'arrow'];

function strokeControls(includeWidth = true) {
  const o = app.opts;
  const save = () => (emit('tool'), A.persistSettingsSoon());
  const els: HTMLElement[] = [];
  if (includeWidth) els.push(numField('Width', () => o.strokeWidth, (v) => ((o.strokeWidth = v), A.persistSettingsSoon()), { min: app.tool === 'line' ? 1 : 0, max: 32, width: 36 }));
  els.push(
    segmented<StrokeStyle>(
      [
        { value: 'solid', label: 'Solid' },
        { value: 'dashed', label: 'Dashed' },
        { value: 'dotted', label: 'Dotted' },
      ],
      () => o.strokeStyle,
      (v) => ((o.strokeStyle = v), save()),
    ),
  );
  if (o.strokeStyle === 'dashed') els.push(numField('Dash', () => o.dash, (v) => ((o.dash = v), A.persistSettingsSoon()), { min: 1, max: 64, width: 32 }));
  if (o.strokeStyle !== 'solid') els.push(numField('Gap', () => o.gap, (v) => ((o.gap = v), A.persistSettingsSoon()), { min: 1, max: 64, width: 32 }));
  return els;
}

export function optionsBar() {
  const bar = h('div', { class: 'optionsbar' });
  const render = () => {
    clear(bar);
    const o = app.opts;
    const info = TOOL_INFO.find((t) => t.id === app.tool)!;
    bar.append(h('div', { class: 'opt-tool' }, icon(info.icon), h('span', {}, info.label)));
    const save = () => A.persistSettingsSoon();
    const add = (...els: (HTMLElement | null)[]) => els.forEach((e) => e && bar.append(e));
    const sep = () => h('div', { class: 'opt-sep' });
    switch (app.tool) {
      case 'select':
        add(
          iconBtn('flipH', 'Flip horizontal (Shift+H)', () => A.flip('x')),
          iconBtn('flipV', 'Flip vertical (Shift+V)', () => A.flip('y')),
          sep(),
          ...(
            [
              ['left', 'Align left'],
              ['hcenter', 'Align centers'],
              ['right', 'Align right'],
              ['top', 'Align top'],
              ['vcenter', 'Align middles'],
              ['bottom', 'Align bottom'],
            ] as [A.AlignMode, string][]
          ).map(([m, t]) => alignBtn(m, t)),
          sep(),
          iconBtn('up', 'Bring forward (Ctrl+])', () => A.arrange('forward')),
          iconBtn('down', 'Send backward (Ctrl+[)', () => A.arrange('backward')),
          iconBtn('group', 'Group (Ctrl+G)', A.group),
          iconBtn('component', 'Make component (Ctrl+K)', A.makeComponent),
          h('div', { class: 'opt-hint' }, 'Align uses the canvas for one object, or the selection for several.'),
        );
        break;
      case 'pencil':
      case 'eraser':
        add(
          numField('Size', () => o.brushSize, (v) => ((o.brushSize = v), save()), { min: 1, max: 32, suffix: 'px', width: 36 }),
          segmented(
            [
              { value: 'square', label: 'Square' },
              { value: 'round', label: 'Round' },
            ],
            () => (o.brushRound ? 'round' : 'square'),
            (v) => ((o.brushRound = v === 'round'), save()),
          ),
          sep(),
          toggle('Pixel-perfect', () => o.pixelPerfect, (v) => ((o.pixelPerfect = v), save()), 'Removes doubled corner pixels from 1px strokes'),
          toggle('Mirror ↔', () => o.symX, (v) => ((o.symX = v), save(), emit('render'))),
          toggle('Mirror ↕', () => o.symY, (v) => ((o.symY = v), save(), emit('render'))),
        );
        break;
      case 'fill':
        add(
          toggle('Contiguous', () => o.fillContiguous, (v) => ((o.fillContiguous = v), save())),
          toggle('Sample all layers', () => o.fillSampleAll, (v) => ((o.fillSampleAll = v), save())),
          toggle('Diagonal', () => o.fillDiagonal, (v) => ((o.fillDiagonal = v), save()), 'Leak through diagonal gaps'),
          h('div', { class: 'opt-hint' }, 'Click a shape or text to set its fill. Shift-click to always fill pixels.'),
        );
        break;
      case 'line':
        add(
          segmented(
            [
              { value: 'line', label: 'Line' },
              { value: 'polyline', label: 'Polyline' },
            ],
            () => o.lineMode,
            (v) => ((o.lineMode = v as any), save()),
          ),
          sep(),
          ...strokeControls(),
          sep(),
          toggle('Start arrow', () => o.arrowStart, (v) => ((o.arrowStart = v), save())),
          toggle('End arrow', () => o.arrowEnd, (v) => ((o.arrowEnd = v), save())),
        );
        break;
      case 'shape': {
        const shapes = h('div', { class: 'seg shape-seg' });
        for (const k of SHAPES) {
          const b = h('button', { class: 'seg-btn' + (o.shapeKind === k ? ' on' : ''), title: SHAPE_NAMES[k], type: 'button' }, icon('shape-' + k));
          b.addEventListener('click', () => {
            o.shapeKind = k;
            save();
            render();
          });
          shapes.append(b);
        }
        add(shapes, sep(), ...strokeControls());
        if (o.shapeKind === 'roundrect') add(numField('Radius', () => o.radius, (v) => ((o.radius = v), save()), { min: 1, max: 128, width: 36 }));
        if (o.shapeKind === 'polygon' || o.shapeKind === 'star') add(numField(o.shapeKind === 'star' ? 'Points' : 'Sides', () => o.sides, (v) => ((o.sides = v), save()), { min: 3, max: 32, width: 32 }));
        if (o.shapeKind === 'star') add(numField('Inner', () => o.inner, (v) => ((o.inner = v), save()), { min: 0.1, max: 0.95, step: 0.05, width: 40 }));
        break;
      }
      case 'text':
        add(
          select(
            FONTS.map((f) => ({ value: f.id, label: f.label, group: f.bitmap ? 'Bitmap fonts' : f.pixel ? 'Pixel fonts' : 'Outline fonts (thresholded)' })),
            () => o.font,
            (v) => {
              o.font = v;
              const f = fontById(v);
              if (f.pixel) o.fontSize = f.native * Math.max(1, Math.round(o.fontSize / f.native));
              save();
              render();
            },
            'font-select',
          ),
          numField('Size', () => o.fontSize, (v) => ((o.fontSize = v), save()), { min: 4, max: 400, suffix: 'px', width: 40, step: fontById(o.font).pixel ? fontById(o.font).native : 1 }),
          segmented(
            [
              { value: 'left', label: 'Left' },
              { value: 'center', label: 'Center' },
              { value: 'right', label: 'Right' },
            ],
            () => o.textAlign,
            (v) => ((o.textAlign = v as any), save()),
          ),
          h('div', { class: 'opt-hint' }, fontById(o.font).pixel ? `Pixel font · crisp at multiples of ${fontById(o.font).native}px` : 'Outline font · adjust Threshold in Properties'),
        );
        break;
      case 'zoom':
        add(
          h('button', { class: 'btn small', onclick: () => viewport.fit() }, 'Fit'),
          h('button', { class: 'btn small', onclick: () => runCommand('view.actual') }, '100%'),
          h('button', { class: 'btn small', onclick: () => viewport.zoomStep(1) }, 'Zoom in'),
          h('button', { class: 'btn small', onclick: () => viewport.zoomStep(-1) }, 'Zoom out'),
        );
        break;
      default:
        add(h('div', { class: 'opt-hint' }, info.hint));
    }
  };
  on('tool', render);
  render();
  return bar;
}

function alignBtn(m: A.AlignMode, title: string) {
  const b = h('button', { class: 'icon-btn align-btn', title, type: 'button', onclick: () => A.align(m) });
  b.append(alignIcon(m));
  return b;
}

function alignIcon(m: A.AlignMode) {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const x = c.getContext('2d')!;
  x.fillStyle = '#000';
  const vert = m === 'left' || m === 'hcenter' || m === 'right';
  if (vert) {
    const lx = m === 'left' ? 1 : m === 'right' ? 14 : 7;
    x.fillRect(lx, 1, 1, 14);
    const pos = (w: number) => (m === 'left' ? 3 : m === 'right' ? 13 - w : 8 - w / 2);
    x.fillRect(pos(10), 3, 10, 4);
    x.fillRect(pos(6), 9, 6, 4);
  } else {
    const ly = m === 'top' ? 1 : m === 'bottom' ? 14 : 7;
    x.fillRect(1, ly, 14, 1);
    const pos = (hh: number) => (m === 'top' ? 3 : m === 'bottom' ? 13 - hh : 8 - hh / 2);
    x.fillRect(3, pos(10), 4, 10);
    x.fillRect(9, pos(6), 4, 6);
  }
  const url = c.toDataURL();
  const el = h('i', { class: 'icon', style: `width:16px;height:16px;-webkit-mask-image:url(${url});mask-image:url(${url})` });
  return el;
}

// ------------------------------------------------------------ toolbox

export function toolbox() {
  const box = h('div', { class: 'toolbox' });
  const grid = h('div', { class: 'tool-grid' });
  const btns = new Map<string, HTMLElement>();
  for (const t of TOOL_INFO) {
    const b = h('button', { class: 'tool-btn', type: 'button', title: `${t.label} (${t.key})` }, icon(t.icon, 16));
    b.addEventListener('click', () => A.switchTool(t.id as any));
    btns.set(t.id, b);
    grid.append(b);
  }
  const syncTools = () => btns.forEach((b, id) => b.classList.toggle('on', id === app.tool));
  on('tool', syncTools);
  syncTools();

  // paint slots (stroke in front, fill behind)
  const sCan = h('canvas') as HTMLCanvasElement;
  const fCan = h('canvas') as HTMLCanvasElement;
  const strokeSlot = h('button', { class: 'slot slot-stroke', title: 'Stroke / pencil paint (click to make active)', type: 'button' }, sCan);
  const fillSlot = h('button', { class: 'slot slot-fill', title: 'Fill paint (click to make active)', type: 'button' }, fCan);
  strokeSlot.addEventListener('click', () => ((app.slot = 'stroke'), emit('paint')));
  fillSlot.addEventListener('click', () => ((app.slot = 'fill'), emit('paint')));
  const sNone = toggle('Stroke', () => app.strokeOn, (v) => ((app.strokeOn = v), emit('paint')), 'Shapes get a border');
  const fNone = toggle('Fill', () => app.fillOn, (v) => ((app.fillOn = v), emit('paint')), 'Shapes get a fill');
  const slots = h(
    'div',
    { class: 'slots' },
    h('div', { class: 'slot-stack' }, fillSlot, strokeSlot),
    h('div', { class: 'slot-actions' }, iconBtn('swap', 'Swap (X)', A.swapPaints), h('button', { class: 'icon-btn mini-default', title: 'Default black/white (D)', type: 'button', onclick: A.defaultPaints }, h('span', { class: 'mini-b' }), h('span', { class: 'mini-w' }))),
  );
  const syncSlots = () => {
    drawSwatch(sCan, app.strokePaint, 30, 30, 1);
    drawSwatch(fCan, app.fillPaint, 30, 30, 1);
    strokeSlot.classList.toggle('active', app.slot === 'stroke');
    fillSlot.classList.toggle('active', app.slot === 'fill');
    strokeSlot.classList.toggle('off', !app.strokeOn);
    fillSlot.classList.toggle('off', !app.fillOn);
    (sNone as any).sync();
    (fNone as any).sync();
  };
  on('paint', syncSlots);
  syncSlots();
  box.append(grid, h('div', { class: 'toolbox-sep' }), slots, h('div', { class: 'slot-toggles' }, sNone, fNone));
  return box;
}

// ------------------------------------------------------------ tabs

export function tabBar() {
  const bar = h('div', { class: 'tabs' });
  let dragFrom: number | null = null;
  const render = () => {
    clear(bar);
    app.docs.forEach((d, i) => {
      const t = h(
        'div',
        { class: 'tab' + (d === app.active ? ' on' : '') + (d.kind === 'component' ? ' comp' : ''), draggable: 'true', title: d.path ?? d.name },
        d.kind === 'component' ? icon('component', 16, 'tab-icon') : null,
        h('span', { class: 'tab-name' }, d.name),
        d.dirty ? h('span', { class: 'tab-dirty' }, '•') : null,
        iconBtn('close', 'Close tab (Ctrl+W)', () => A.closeDoc(d), { cls: 'tab-close' }),
      );
      t.addEventListener('pointerdown', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          A.closeDoc(d);
        } else if (e.button === 0 && d !== app.active) setActiveDoc(d);
      });
      t.addEventListener('dragstart', () => (dragFrom = i));
      t.addEventListener('dragover', (e) => e.preventDefault());
      t.addEventListener('drop', () => {
        if (dragFrom === null || dragFrom === i) return;
        const [m] = app.docs.splice(dragFrom, 1);
        app.docs.splice(i, 0, m);
        dragFrom = null;
        emit('tabs');
      });
      bar.append(t);
    });
    bar.append(iconBtn('plus', 'New image (Ctrl+N)', newDocDialog, { cls: 'tab-new' }));
  };
  on('tabs', render);
  render();
  return bar;
}

// ------------------------------------------------------------ status bar

export function statusBar() {
  const hint = h('span', { class: 'st-hint' });
  const pos = h('span', { class: 'st-pos' });
  const size = h('span', { class: 'st-size' });
  const selInfo = h('span', { class: 'st-sel' });
  const zoomBtn = h('button', { class: 'st-zoom', type: 'button', title: 'Zoom' });
  zoomBtn.addEventListener('click', () => {
    const list = h('div', { class: 'menu' });
    const dpr = viewport.dpr;
    for (const z of ZOOMS) {
      const pct = Math.round((z / dpr) * 100);
      if (pct < 10) continue;
      const it = h('button', { class: 'menu-item', type: 'button' }, h('span', { class: 'menu-check' }), h('span', { class: 'menu-label' }, `${pct}%`));
      it.addEventListener('click', () => {
        viewport.setZoom(z);
        closePopover();
      });
      list.append(it);
    }
    const fit = h('button', { class: 'menu-item', type: 'button' }, h('span', { class: 'menu-check' }), h('span', { class: 'menu-label' }, 'Fit'));
    fit.addEventListener('click', () => (viewport.fit(), closePopover()));
    list.prepend(fit);
    popover(list, zoomBtn.getBoundingClientRect());
  });
  const upd = () => {
    const d = app.active;
    const info = TOOL_INFO.find((t) => t.id === app.tool)!;
    hint.textContent = d?.scope ? `In group — ${info.hint}` : info.hint;
    pos.textContent = app.cursor ? `X ${app.cursor.x}  Y ${app.cursor.y}` : 'X –  Y –';
    size.textContent = d ? `${d.data.width} × ${d.data.height}` : '';
    zoomBtn.textContent = d ? `${Math.round(viewport.cssZoom * 100)}%` : '';
    const sel = d?.selected() ?? [];
    selInfo.textContent = sel.length ? (sel.length === 1 ? sel[0].name : `${sel.length} objects`) : '';
  };
  ['tool', 'cursor', 'view', 'selection', 'tabs', 'doc'].forEach((e) => on(e as any, upd));
  upd();
  return h('div', { class: 'statusbar' }, hint, h('span', { class: 'st-spacer' }), selInfo, pos, size, zoomBtn);
}
