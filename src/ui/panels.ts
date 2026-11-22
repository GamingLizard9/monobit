import { h, clear, numField, segmented, toggle, select, iconBtn, drawSwatch, btn } from './dom';
import { icon } from './icons';
import { app, emit, on, setSelection, activePaint, type EditorDoc } from '../app/state';
import * as A from '../app/actions';
import { locate, moveObj, TYPE_LABEL, SHAPE_NAMES, newBitmap, nextRev, defaultFx } from '../core/doc';
import { objBounds, objKey, composeObjects, toRGBA } from '../core/render';
import { FONTS, fontById, rasterText, alignOffset } from '../core/fonts';
import { DITHER_ALGOS } from '../core/dither';
import { patPaint, patEquals, BLACK, WHITE } from '../core/patterns';
import { bitmapMetrics } from '../core/bitmapfonts';
import type { Obj, Paint, ShapeKind, StrokeStyle, Shadow, Outline, GroupObj, Component } from '../core/types';
import { patternGrid, openPaintPicker, MODE_OPTS, gradientControls, swatchButton } from './paintpicker';
import { patternEditor, customPatternsChanged } from './dialogs';
import { viewport } from '../editor/viewport';
import { insertObj } from '../editor/tools';
import { editText } from './textedit';
import { toast } from './overlay';

// ------------------------------------------------------------ panel frame

const collapsedKey = (id: string) => `monobit:panel:${id}`;

export function panel(id: string, title: string, content: HTMLElement, opts: { actions?: HTMLElement[]; grow?: boolean; collapsed?: boolean } = {}) {
  let collapsed = opts.collapsed ?? false;
  try {
    const v = localStorage.getItem(collapsedKey(id));
    if (v !== null) collapsed = v === '1';
  } catch {
    /* ignore */
  }
  const chev = icon(collapsed ? 'chevRight' : 'chevDown', 16, 'panel-chev');
  const head = h('div', { class: 'panel-title' }, chev, h('span', { class: 'panel-name' }, title), h('span', { class: 'stripes' }), ...(opts.actions ?? []));
  const body = h('div', { class: 'panel-body' }, content);
  const el = h('section', { class: 'panel' + (opts.grow ? ' grow' : '') + (collapsed ? ' collapsed' : ''), 'data-panel': id }, head, body);
  head.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    collapsed = !collapsed;
    el.classList.toggle('collapsed', collapsed);
    chev.replaceWith(icon(collapsed ? 'chevRight' : 'chevDown', 16, 'panel-chev'));
    try {
      localStorage.setItem(collapsedKey(id), collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  });
  return el;
}

// ------------------------------------------------------------ patterns panel

/** Applies a paint to the selection, depending on which slot is active. */
function applyPaintToSelection(p: Paint) {
  const d = app.active;
  if (!d) return;
  const sel = d.selected().filter((o) => !o.locked);
  let changed = false;
  for (const o of sel) {
    if (app.slot === 'stroke') {
      if (o.type === 'shape' || o.type === 'line') ((o.stroke.paint = structuredClone(p)), (changed = true));
      if (o.type === 'text') ((o.paint = structuredClone(p)), (changed = true));
    } else if (o.type === 'shape') {
      o.fill = structuredClone(p);
      changed = true;
    } else if (o.type === 'text') {
      o.paint = structuredClone(p);
      changed = true;
    }
  }
  if (changed) d.commit('Change paint', 'paint');
}

export function patternsPanel() {
  const slotSeg = h('div', { class: 'seg slot-seg' });
  const slotBtn = (s: 'stroke' | 'fill', label: string) => {
    const c = h('canvas') as HTMLCanvasElement;
    const b = h('button', { class: 'seg-btn', type: 'button' }, c, h('span', {}, label));
    b.addEventListener('click', () => ((app.slot = s), emit('paint')));
    return { b, c };
  };
  const sb = slotBtn('stroke', 'Stroke'),
    fb = slotBtn('fill', 'Fill');
  slotSeg.append(sb.b, fb.b);

  const setActive = (p: Paint) => {
    if (app.slot === 'stroke') app.strokePaint = p;
    else {
      app.fillPaint = p;
      app.fillOn = true;
    }
    emit('paint');
    applyPaintToSelection(p);
  };
  const grid = patternGrid(
    () => activePaint(),
    (pat) => setActive({ kind: 'pattern', pat, mode: activePaint().mode }),
    30,
  );
  // custom pattern management
  grid.addEventListener('contextmenu', (e) => {
    const t = (e.target as HTMLElement).closest('.swatch') as HTMLElement | null;
    if (!t || !t.title.startsWith('Custom')) return;
    e.preventDefault();
    const i = parseInt(t.title.slice(7)) - 1;
    app.settings.customPatterns.splice(i, 1);
    customPatternsChanged();
    (grid as any).sync();
    toast('Custom pattern removed');
  });
  const modeSeg = h('div', {});
  const gradWrap = h('div', {});
  const kindSeg = h('div', {});
  const renderMode = () => {
    clear(modeSeg).append(
      segmented(
        MODE_OPTS,
        () => activePaint().mode,
        (v) => setActive({ ...structuredClone(activePaint()), mode: v } as Paint),
      ),
    );
    const p = activePaint();
    clear(kindSeg).append(
      segmented(
        [
          { value: 'pattern', label: 'Pattern' },
          { value: 'gradient', label: 'Gradient' },
        ],
        () => p.kind,
        (v) => setActive(v === 'pattern' ? patPaint(BLACK().pat, p.mode) : { kind: 'gradient', from: 0, to: 64, angle: 0, shape: 'linear', dither: 'bayer', mode: p.mode }),
      ),
    );
    clear(gradWrap);
    if (p.kind === 'gradient')
      gradWrap.append(
        gradientControls(
          () => activePaint(),
          (np, final) => {
            if (app.slot === 'stroke') app.strokePaint = np;
            else app.fillPaint = np;
            if (final) {
              emit('paint');
              applyPaintToSelection(np);
            }
          },
        ),
      );
    grid.style.display = p.kind === 'pattern' ? '' : 'none';
  };
  const sync = () => {
    drawSwatch(sb.c, app.strokePaint, 14, 14, 1);
    drawSwatch(fb.c, app.fillPaint, 14, 14, 1);
    sb.b.classList.toggle('on', app.slot === 'stroke');
    fb.b.classList.toggle('on', app.slot === 'fill');
    (grid as any).sync();
    renderMode();
  };
  on('paint', sync);
  on('settings', () => (grid as any).sync());
  sync();
  const addBtn = iconBtn('plus', 'New custom pattern…', async () => {
    const cur = activePaint();
    const pat = await patternEditor(cur.kind === 'pattern' ? cur.pat : undefined);
    if (pat) {
      app.settings.customPatterns.push(pat);
      customPatternsChanged();
      setActive(patPaint(pat, activePaint().mode));
    }
  });
  const content = h('div', { class: 'patterns-panel' }, h('div', { class: 'row between' }, slotSeg, kindSeg), grid, gradWrap, h('div', { class: 'pattern-label' }, 'Mode'), modeSeg);
  return panel('patterns', 'Patterns', content, { actions: [addBtn] });
}

// ------------------------------------------------------------ inspector

type Syncable = HTMLElement & { sync?: () => void };

export function inspectorPanel() {
  const body = h('div', { class: 'inspector' });
  let fields: Syncable[] = [];
  let lastKey = '';
  const reg = <T extends HTMLElement>(e: T): T => (fields.push(e as Syncable), e);

  const d = () => app.active as EditorDoc;
  const edit = (label: string, o: Obj, fn: () => void, final = true, field = '') => {
    fn();
    if (final) d().commit(label, `${o.id}:${field || label}`);
    else emit('render');
  };

  const paintSwatch = (label: string, get: () => Paint | null, set: (p: Paint | null) => void, o: Obj, allowNone = false) => {
    const c = h('canvas') as HTMLCanvasElement;
    const b = h('button', { class: 'swatch wide', type: 'button', title: `Edit ${label.toLowerCase()} paint` }, c);
    const draw = () => drawSwatch(c, get(), 64, 20, 2);
    draw();
    b.addEventListener('click', () =>
      openPaintPicker(
        b.getBoundingClientRect(),
        get(),
        (p, final) => {
          set(p);
          draw();
          if (final) d().commit(`${label} paint`, `${o.id}:${label}paint`);
          else emit('render');
        },
        allowNone,
      ),
    );
    // "use current" button: drop the active palette paint in
    const use = iconBtn('picker', 'Use the active pattern from the Patterns panel', () => {
      set(structuredClone(activePaint()));
      draw();
      d().commit(`${label} paint`);
    });
    const el = h('div', { class: 'field paint-field' }, h('label', { class: 'num-label' }, label), b, use) as Syncable;
    el.sync = draw;
    return reg(el);
  };

  const keyFor = () => {
    const doc = app.active;
    if (!doc) return 'none';
    const sel = doc.selected();
    return (
      doc.id +
      '|' +
      doc.scope +
      '|' +
      sel
        .map((o) => {
          let k = o.id + o.type + o.fx.shadow.on + o.fx.outline.on + (o.fx.shadow.paint.kind + o.fx.outline.paint.kind);
          if (o.type === 'shape') k += o.shape + o.stroke.style + (o.fill?.kind ?? 'none') + o.stroke.width;
          if (o.type === 'line') k += o.stroke.style + o.points.length;
          if (o.type === 'text') k += o.font + fontById(o.font).pixel;
          if (o.type === 'group') k += o.componentId ?? '' + o.children.length;
          return k;
        })
        .join(',')
    );
  };

  const build = () => {
    fields = [];
    clear(body);
    const doc = app.active;
    if (!doc) {
      body.append(h('p', { class: 'hint pad' }, 'No image open.'));
      return;
    }
    const sel = doc.selected();
    if (!sel.length) return buildDoc(doc);
    if (sel.length > 1) return buildMulti(sel);
    buildObj(sel[0]);
  };

  const buildDoc = (doc: EditorDoc) => {
    body.append(
      h('div', { class: 'insp-head' }, icon('image'), h('b', {}, doc.kind === 'component' ? 'Component' : 'Image')),
      h('div', { class: 'section' }, h('div', { class: 'section-title' }, h('span', {}, 'Canvas')), h('div', { class: 'kv' }, h('span', {}, 'Size'), h('b', {}, `${doc.data.width} × ${doc.data.height}`)), h('div', { class: 'kv' }, h('span', {}, 'Objects'), h('b', {}, String(doc.data.objects.length)))),
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-title' }, h('span', {}, 'Background')),
        reg(
          segmented(
            [
              { value: 'white', label: 'White' },
              { value: 'black', label: 'Black' },
              { value: 'transparent', label: 'None' },
            ],
            () => doc.data.background,
            (v) => A.setBackground(v as any),
          ),
        ),
      ),
      h('div', { class: 'section' }, h('div', { class: 'row wrap' }, btn('Canvas size…', () => import('./dialogs').then((m) => m.canvasSizeDialog())), btn('Trim', A.trimCanvas), btn('New pixel layer', () => addPixelLayer()))),
      h('p', { class: 'hint pad' }, doc.scope ? 'You are editing inside a group. Press Esc or double-click empty space to leave.' : 'Select an object to edit it. Double-click a group or component to edit what’s inside.'),
    );
  };

  const buildMulti = (sel: Obj[]) => {
    body.append(
      h('div', { class: 'insp-head' }, icon('group'), h('b', {}, `${sel.length} objects`)),
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-title' }, h('span', {}, 'Arrange')),
        h('div', { class: 'row wrap' }, btn('Group', A.group, { icon: 'group' }), btn('Component', A.makeComponent, { icon: 'component' }), btn('Rasterize', A.rasterize, { icon: 'bitmap' })),
        h('div', { class: 'row wrap' }, btn('Distribute ↔', () => A.distribute('x')), btn('Distribute ↕', () => A.distribute('y'))),
      ),
    );
    effectsSection(sel[0], sel);
  };

  const buildObj = (o: Obj) => {
    const nameIn = h('input', { class: 'text-input name-input', value: o.name }) as HTMLInputElement;
    nameIn.addEventListener('change', () => edit('Rename', o, () => (o.name = nameIn.value || o.name)));
    nameIn.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') nameIn.blur();
    });
    const head = h(
      'div',
      { class: 'insp-head' },
      icon(typeIcon(o)),
      nameIn,
      iconBtn(o.visible ? 'eye' : 'eyeOff', 'Visible', () => A.toggleVisible(o), { active: !o.visible }),
      iconBtn(o.locked ? 'lock' : 'unlock', 'Lock', () => A.toggleLock(o), { active: o.locked }),
    );
    body.append(head);
    body.append(h('div', { class: 'insp-type' }, o.type === 'group' && o.componentId ? `Component · ${app.library.find((c) => c.id === (o as GroupObj).componentId)?.name ?? 'missing'}` : o.type === 'shape' ? SHAPE_NAMES[o.shape] : TYPE_LABEL[o.type]));

    // geometry
    const geo = h('div', { class: 'grid2' });
    const b0 = () => objBounds(o) ?? { x: 0, y: 0, w: 0, h: 0 };
    geo.append(
      reg(numField('X', () => b0().x, (v, f) => edit('Move', o, () => moveObj(o, v - b0().x, 0), f, 'x'), { width: 44 })),
      reg(numField('Y', () => b0().y, (v, f) => edit('Move', o, () => moveObj(o, 0, v - b0().y), f, 'y'), { width: 44 })),
    );
    if (o.type === 'shape' || o.type === 'image') {
      geo.append(
        reg(numField('W', () => o.w, (v, f) => edit('Resize', o, () => (o.w = v), f, 'w'), { min: 1, max: 4096, width: 44 })),
        reg(numField('H', () => o.h, (v, f) => edit('Resize', o, () => (o.h = v), f, 'h'), { min: 1, max: 4096, width: 44 })),
      );
    } else {
      const b = b0();
      geo.append(h('div', { class: 'kv' }, h('span', {}, 'Size'), h('b', {}, `${b.w} × ${b.h}`)));
    }
    body.append(sectionEl('Position', geo));

    if (o.type === 'shape') {
      const s = h('div', {});
      s.append(
        reg(
          select(
            (Object.keys(SHAPE_NAMES) as ShapeKind[]).map((k) => ({ value: k, label: SHAPE_NAMES[k] })),
            () => o.shape,
            (v) => edit('Shape type', o, () => ((o.shape = v), (o.name = SHAPE_NAMES[v]))),
          ),
        ),
      );
      const g = h('div', { class: 'grid2' });
      if (o.shape === 'roundrect') g.append(reg(numField('Radius', () => o.radius, (v, f) => edit('Radius', o, () => (o.radius = v), f), { min: 1, max: 256, width: 40 })));
      if (o.shape === 'polygon' || o.shape === 'star') g.append(reg(numField(o.shape === 'star' ? 'Points' : 'Sides', () => o.sides, (v, f) => edit('Sides', o, () => (o.sides = v), f), { min: 3, max: 32, width: 40 })));
      if (o.shape === 'star') g.append(reg(numField('Inner', () => o.inner, (v, f) => edit('Inner radius', o, () => (o.inner = v), f), { min: 0.1, max: 0.95, step: 0.05, width: 40 })));
      if (!['rect', 'roundrect', 'ellipse'].includes(o.shape)) g.append(reg(numField('Angle', () => o.angle, (v, f) => edit('Rotate', o, () => (o.angle = v), f), { min: -360, max: 360, step: 1, suffix: '°', width: 40 })));
      s.append(g);
      body.append(sectionEl('Shape', s));
      body.append(strokeSection(o, o.stroke, true));
      const fillRow = h('div', {});
      fillRow.append(
        reg(toggle('Fill', () => !!o.fill, (v) => edit('Fill', o, () => (o.fill = v ? structuredClone(app.fillPaint) : null)))),
      );
      if (o.fill) fillRow.append(paintSwatch('Fill', () => o.fill, (p) => (o.fill = p), o, true));
      body.append(sectionEl('Fill', fillRow));
    }

    if (o.type === 'line') {
      body.append(strokeSection(o, o.stroke, false));
      body.append(
        sectionEl(
          'Ends',
          h(
            'div',
            { class: 'row wrap' },
            reg(toggle('Start arrow', () => o.arrowStart, (v) => edit('Arrow', o, () => (o.arrowStart = v)))),
            reg(toggle('End arrow', () => o.arrowEnd, (v) => edit('Arrow', o, () => (o.arrowEnd = v)))),
            o.points.length > 2 ? reg(toggle('Closed', () => o.closed, (v) => edit('Close path', o, () => (o.closed = v)))) : null,
          ),
        ),
      );
    }

    if (o.type === 'text') {
      const ta = h('textarea', { class: 'text-input', rows: 3, spellcheck: false }) as HTMLTextAreaElement;
      ta.value = o.text;
      ta.addEventListener('input', () => edit('Edit text', o, () => (o.text = ta.value), false));
      ta.addEventListener('change', () => edit('Edit text', o, () => (o.text = ta.value)));
      ta.addEventListener('keydown', (e) => e.stopPropagation());
      (ta as Syncable).sync = () => document.activeElement !== ta && (ta.value = o.text);
      reg(ta);
      const f = fontById(o.font);
      const t = h(
        'div',
        {},
        ta,
        reg(
          select(
            FONTS.map((fd) => ({ value: fd.id, label: fd.label, group: fd.bitmap ? 'Bitmap fonts' : fd.pixel ? 'Pixel fonts' : 'Outline fonts (thresholded)' })),
            () => o.font,
            (v) =>
              edit('Font', o, () => {
                o.font = v;
                const nf = fontById(v);
                if (nf.pixel) o.size = nf.native * Math.max(1, Math.round(o.size / nf.native));
                app.opts.font = v;
              }),
            'font-select',
          ),
        ),
        h(
          'div',
          { class: 'grid2' },
          reg(numField('Size', () => o.size, (v, fin) => edit('Font size', o, () => (o.size = v), fin), { min: 4, max: 400, step: f.pixel ? f.native : 1, suffix: f.pixel ? `×${Math.round(o.size / f.native)}` : 'px', width: 40 })),
          reg(numField('Spacing', () => o.letterSpacing, (v, fin) => edit('Letter spacing', o, () => (o.letterSpacing = v), fin), { min: -20, max: 100, width: 40 })),
          reg(numField('Leading', () => o.lineSpacing, (v, fin) => edit('Line spacing', o, () => (o.lineSpacing = v), fin), { min: -50, max: 200, width: 40 })),
          !f.pixel ? reg(numField('Threshold', () => o.threshold, (v, fin) => edit('Threshold', o, () => (o.threshold = v), fin), { min: 1, max: 255, width: 40, title: 'Lower = bolder, higher = thinner' })) : null,
        ),
        reg(
          segmented(
            [
              { value: 'left', label: 'Left' },
              { value: 'center', label: 'Center' },
              { value: 'right', label: 'Right' },
            ],
            () => o.align,
            (v) =>
              edit('Align text', o, () => {
                // keep the text where it is; only the anchor (and multi-line alignment) changes
                const w = rasterText(o).box.w;
                o.x += alignOffset(v as any, w) - alignOffset(o.align, w);
                o.align = v as any;
              }),
          ),
        ),
        h('p', { class: 'hint' }, 'Alignment is the anchor: the left edge, center or right edge stays put as the text changes. It also aligns multiple lines.'),
        h(
          'div',
          { class: 'row wrap' },
          reg(toggle('Bold', () => o.bold, (v) => edit('Bold', o, () => (o.bold = v)))),
          reg(toggle('Italic', () => o.italic, (v) => edit('Italic', o, () => (o.italic = v)))),
          reg(toggle('Underline', () => o.underline, (v) => edit('Underline', o, () => (o.underline = v)))),
        ),
        paintSwatch('Paint', () => o.paint, (p) => (o.paint = p ?? BLACK()), o),
        f.bitmap && bitmapMetrics(f.id).outline ? paintSwatch('Inside', () => (o.fill === undefined ? WHITE() : o.fill), (p) => (o.fill = p), o, true) : null,
        h('div', { class: 'row' }, btn('Edit on canvas', () => editText(o, false))),
      );
      body.append(sectionEl('Text', t));
    }

    if (o.type === 'image') {
      body.append(
        sectionEl(
          'Dithering',
          h(
            'div',
            {},
            reg(select(DITHER_ALGOS.map((a) => ({ value: a.id, label: a.label })), () => o.algo, (v) => edit('Dither', o, () => (o.algo = v)))),
            h(
              'div',
              { class: 'grid2' },
              reg(numField('Brightness', () => o.brightness, (v, f) => edit('Brightness', o, () => (o.brightness = v), f), { min: -100, max: 100, width: 40 })),
              reg(numField('Contrast', () => o.contrast, (v, f) => edit('Contrast', o, () => (o.contrast = v), f), { min: -100, max: 100, width: 40 })),
              reg(numField('Gamma', () => o.gamma, (v, f) => edit('Gamma', o, () => (o.gamma = v), f), { min: 0.2, max: 3, step: 0.05, width: 40 })),
            ),
            h(
              'div',
              { class: 'row wrap' },
              reg(toggle('Invert', () => o.invert, (v) => edit('Invert', o, () => (o.invert = v)))),
              reg(toggle('White = transparent', () => o.knockout, (v) => edit('Knockout', o, () => (o.knockout = v)))),
            ),
            h(
              'div',
              { class: 'row wrap' },
              btn('Original ratio', () => edit('Resize', o, () => (o.h = Math.max(1, Math.round((o.w * o.src.h) / o.src.w))))),
              btn('Rasterize', A.rasterize),
            ),
          ),
        ),
      );
    }

    if (o.type === 'bitmap') {
      body.append(
        sectionEl(
          'Pixel Layer',
          h(
            'div',
            { class: 'row wrap' },
            btn('Trim', A.trimLayer),
            btn('Clear', () => edit('Clear layer', o, () => (o.data.fill(0), (o.rev = nextRev())))),
            btn('Invert', () =>
              edit('Invert layer', o, () => {
                for (let i = 0; i < o.data.length; i++) o.data[i] = o.data[i] === 1 ? 2 : o.data[i] === 2 ? 1 : 0;
                o.rev = nextRev();
              }),
            ),
            btn('Merge down', A.mergeDown),
          ),
        ),
      );
    }

    if (o.type === 'group') {
      const g = o;
      const comp = g.componentId ? app.library.find((c) => c.id === g.componentId) : null;
      body.append(
        sectionEl(
          g.componentId ? 'Component' : 'Group',
          h(
            'div',
            {},
            h('div', { class: 'kv' }, h('span', {}, 'Contains'), h('b', {}, `${g.children.length} object${g.children.length === 1 ? '' : 's'}`)),
            h(
              'div',
              { class: 'row wrap' },
              btn('Edit contents', () => A.enterGroup(g), { icon: 'enter' }),
              btn('Ungroup', A.ungroup),
              !g.componentId ? btn('Make component', A.makeComponent, { icon: 'component' }) : null,
            ),
            comp
              ? h(
                  'div',
                  { class: 'row wrap' },
                  btn('Reset to master', () => A.syncInstance(g)),
                  btn('Edit master', () => A.editComponent(comp)),
                  btn('Detach', () => A.detachInstance(g)),
                )
              : g.componentId
                ? h('p', { class: 'hint' }, 'The master component was deleted from the library.')
                : null,
            g.componentId ? h('p', { class: 'hint' }, 'Edits you make inside this copy stay local. “Reset” pulls the library version back in.') : null,
          ),
        ),
      );
    }

    // blend
    body.append(
      sectionEl(
        'Blend',
        reg(
          segmented(
            [
              { value: 'normal', label: 'Normal' },
              { value: 'invert', label: 'Invert (XOR)' },
            ],
            () => o.blend,
            (v) => edit('Blend', o, () => (o.blend = v as any)),
          ),
        ),
      ),
    );
    effectsSection(o, [o]);
  };

  const strokeSection = (o: Obj, s: { width: number; style: StrokeStyle; dash: number; gap: number; paint: Paint }, allowZero: boolean) => {
    const el = h('div', {});
    el.append(
      h(
        'div',
        { class: 'grid2' },
        reg(numField('Width', () => s.width, (v, f) => edit('Stroke width', o, () => (s.width = v), f), { min: allowZero ? 0 : 1, max: 64, width: 40 })),
        s.style === 'dashed' ? reg(numField('Dash', () => s.dash, (v, f) => edit('Dash', o, () => (s.dash = v), f), { min: 1, max: 64, width: 40 })) : null,
        s.style !== 'solid' ? reg(numField('Gap', () => s.gap, (v, f) => edit('Gap', o, () => (s.gap = v), f), { min: 1, max: 64, width: 40 })) : null,
      ),
      reg(
        segmented<StrokeStyle>(
          [
            { value: 'solid', label: 'Solid' },
            { value: 'dashed', label: 'Dashed' },
            { value: 'dotted', label: 'Dotted' },
          ],
          () => s.style,
          (v) => edit('Stroke style', o, () => (s.style = v)),
        ),
      ),
      paintSwatch('Stroke', () => s.paint, (p) => (s.paint = p ?? BLACK()), o),
    );
    return sectionEl('Stroke', el);
  };

  const effectsSection = (o: Obj, all: Obj[]) => {
    const forAll = (fn: (x: Obj) => void) => all.forEach(fn);
    const sh = o.fx.shadow,
      ol = o.fx.outline;
    const setSh = (fn: (s: Shadow) => void, final = true, f = '') => edit('Shadow', o, () => forAll((x) => fn(x.fx.shadow)), final, 'shadow' + f);
    const setOl = (fn: (s: Outline) => void, final = true, f = '') => edit('Outline', o, () => forAll((x) => fn(x.fx.outline)), final, 'outline' + f);
    const el = h('div', {});
    el.append(reg(toggle('Drop shadow', () => sh.on, (v) => setSh((s) => (s.on = v)))));
    if (sh.on) {
      el.append(
        h(
          'div',
          { class: 'grid2' },
          reg(numField('X', () => sh.dx, (v, f) => setSh((s) => (s.dx = v), f, 'x'), { min: -64, max: 64, width: 40 })),
          reg(numField('Y', () => sh.dy, (v, f) => setSh((s) => (s.dy = v), f, 'y'), { min: -64, max: 64, width: 40 })),
        ),
        reg(
          segmented(
            [
              { value: 'drop', label: 'Drop' },
              { value: 'extrude', label: 'Extrude' },
            ],
            () => sh.style,
            (v) => setSh((s) => (s.style = v as any)),
          ),
        ),
        paintSwatch('Shadow', () => sh.paint, (p) => forAll((x) => (x.fx.shadow.paint = structuredClone(p ?? BLACK()))), o),
      );
    }
    el.append(reg(toggle('Outline', () => ol.on, (v) => setOl((s) => (s.on = v)))));
    if (ol.on) {
      el.append(
        h('div', { class: 'grid2' }, reg(numField('Width', () => ol.width, (v, f) => setOl((s) => (s.width = v), f, 'w'), { min: 1, max: 16, width: 40 })), reg(toggle('Round', () => ol.round, (v) => setOl((s) => (s.round = v))))),
        paintSwatch('Outline', () => ol.paint, (p) => forAll((x) => (x.fx.outline.paint = structuredClone(p ?? BLACK()))), o),
      );
    }
    el.append(
      h(
        'div',
        { class: 'row wrap' },
        btn('Reset effects', () => edit('Reset effects', o, () => forAll((x) => (x.fx = defaultFx())))),
      ),
    );
    body.append(sectionEl('Effects', el));
  };

  const refresh = () => {
    const k = keyFor();
    if (k !== lastKey) {
      lastKey = k;
      build();
    } else fields.forEach((f) => f.sync?.());
  };
  on('selection', refresh);
  on('doc', refresh);
  on('history', () => {
    lastKey = '';
    refresh();
  });
  on('tabs', refresh);
  refresh();
  return panel('inspector', 'Properties', body, { grow: true });
}

function sectionEl(title: string, ...c: (HTMLElement | null)[]) {
  return h('div', { class: 'section' }, h('div', { class: 'section-title' }, h('span', {}, title)), ...c);
}

function typeIcon(o: Obj): string {
  if (o.type === 'group') return o.componentId ? 'component' : 'group';
  if (o.type === 'shape') return 'shape-' + o.shape;
  if (o.type === 'text') return 'text';
  if (o.type === 'line') return 'line';
  if (o.type === 'image') return 'image';
  return 'bitmap';
}

function addPixelLayer() {
  const d = app.active;
  if (!d) return;
  const b = newBitmap(0, 0, d.data.width, d.data.height, 'Pixels');
  insertObj(b);
  d.commit('New pixel layer');
  A.switchTool('pencil');
}

// ------------------------------------------------------------ thumbnails

const thumbCache = new Map<string, { key: string; url: string }>();

function thumbURL(objs: Obj[], cacheId: string, w: number, hh: number): string {
  const key = objs.map(objKey).join('|');
  const hit = thumbCache.get(cacheId);
  if (hit && hit.key === key) return hit.url;
  const buf = composeObjects(objs);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hh;
  const ctx = c.getContext('2d')!;
  if (buf && buf.w && buf.h) {
    const s = Math.min(w / buf.w, hh / buf.h);
    const scale = s >= 1 ? Math.floor(s) : s;
    const t = document.createElement('canvas');
    t.width = buf.w;
    t.height = buf.h;
    t.getContext('2d')!.putImageData(toRGBA(buf.data, buf.w, buf.h, false), 0, 0);
    ctx.imageSmoothingEnabled = scale < 1;
    const dw = Math.max(1, Math.round(buf.w * scale)),
      dh = Math.max(1, Math.round(buf.h * scale));
    ctx.drawImage(t, Math.floor((w - dw) / 2), Math.floor((hh - dh) / 2), dw, dh);
  }
  const url = c.toDataURL();
  thumbCache.set(cacheId, { key, url });
  return url;
}

// ------------------------------------------------------------ layers

export function layersPanel() {
  const list = h('div', { class: 'layers' });
  let dragId: string | null = null;
  let renaming: string | null = null;

  const row = (o: Obj, depth: number, doc: EditorDoc, inScope: boolean) => {
    const selected = doc.selection.includes(o.id);
    const isScope = doc.scope === o.id;
    const r = h('div', {
      class: 'layer' + (selected ? ' on' : '') + (o.visible ? '' : ' hidden') + (o.locked ? ' locked' : '') + (isScope ? ' scope' : '') + (inScope ? '' : ' out-scope'),
      draggable: 'true',
      style: `--depth:${depth}`,
    });
    const exp =
      o.type === 'group'
        ? iconBtn(o.expanded ? 'chevDown' : 'chevRight', o.expanded ? 'Collapse' : 'Expand', () => {
            o.expanded = !o.expanded;
            render();
          }, { cls: 'layer-exp' })
        : h('span', { class: 'layer-exp' });
    const th = h('img', { class: 'layer-thumb', src: thumbURL([o], o.id, 28, 22), alt: '' });
    const name = h('span', { class: 'layer-name' }, o.name);
    if (renaming === o.id) {
      const inp = h('input', { class: 'text-input layer-rename', value: o.name }) as HTMLInputElement;
      const done = (save: boolean) => {
        if (renaming !== o.id) return;
        renaming = null;
        if (save && inp.value.trim()) {
          o.name = inp.value.trim();
          doc.commit('Rename');
        } else render();
      };
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') done(false);
      });
      inp.addEventListener('blur', () => done(true));
      name.replaceWith(inp);
      setTimeout(() => (inp.focus(), inp.select()));
      r.append(exp, th, inp);
    } else r.append(exp, th, name);
    if (o.type === 'group' && o.componentId) r.append(h('span', { class: 'badge', title: 'Component instance' }, icon('component', 16)));
    r.append(
      iconBtn(o.locked ? 'lock' : 'unlock', o.locked ? 'Unlock' : 'Lock', () => A.toggleLock(o), { cls: 'layer-lock' + (o.locked ? ' active' : '') }),
      iconBtn(o.visible ? 'eye' : 'eyeOff', o.visible ? 'Hide' : 'Show', () => A.toggleVisible(o), { cls: 'layer-eye' }),
    );
    r.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button,input')) return;
      const l = locate(doc.data.objects, o.id);
      const parentScope = l?.parent?.id ?? null;
      if (doc.scope !== parentScope) {
        doc.scope = parentScope;
        emit('doc');
      }
      if (e.shiftKey || e.ctrlKey) {
        const s = new Set(doc.selection);
        s.has(o.id) ? s.delete(o.id) : s.add(o.id);
        setSelection([...s]);
      } else setSelection([o.id]);
    });
    r.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      renaming = o.id;
      render();
    });
    r.addEventListener('dragstart', (e) => {
      dragId = o.id;
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', o.id);
      r.classList.add('dragging');
    });
    r.addEventListener('dragend', () => {
      dragId = null;
      list.querySelectorAll('.drop-before,.drop-after,.drop-inside,.dragging').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-inside', 'dragging'));
    });
    const zone = (e: DragEvent): 'before' | 'after' | 'inside' => {
      const b = r.getBoundingClientRect();
      const t = (e.clientY - b.top) / b.height;
      if (o.type === 'group' && t > 0.3 && t < 0.7) return 'inside';
      return t < 0.5 ? 'before' : 'after';
    };
    r.addEventListener('dragover', (e) => {
      if (!dragId || dragId === o.id) return;
      e.preventDefault();
      r.classList.remove('drop-before', 'drop-after', 'drop-inside');
      r.classList.add('drop-' + zone(e));
    });
    r.addEventListener('dragleave', () => r.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    r.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragId && dragId !== o.id) A.moveInList(dragId, o.id, zone(e));
      dragId = null;
    });
    return r;
  };

  const render = () => {
    clear(list);
    const doc = app.active;
    if (!doc) return;
    const scopeIds = new Set(doc.scopeList.map((o) => o.id));
    const rec = (objs: Obj[], depth: number) => {
      for (let i = objs.length - 1; i >= 0; i--) {
        const o = objs[i];
        list.append(row(o, depth, doc, scopeIds.has(o.id)));
        if (o.type === 'group' && o.expanded) rec(o.children, depth + 1);
      }
    };
    rec(doc.data.objects, 0);
    if (!doc.data.objects.length) list.append(h('div', { class: 'empty' }, h('p', {}, 'No layers yet.'), h('p', { class: 'hint' }, 'Draw with the pencil, or add shapes, lines and text.')));
    list.querySelector('.layer.on')?.scrollIntoView({ block: 'nearest' });
  };
  on('doc', render);
  on('selection', render);
  on('tabs', render);
  render();
  const actions = [
    iconBtn('bitmap', 'New pixel layer', addPixelLayer),
    iconBtn('group', 'Group (Ctrl+G)', A.group),
    iconBtn('up', 'Bring forward', () => A.arrange('forward')),
    iconBtn('down', 'Send backward', () => A.arrange('backward')),
    iconBtn('trash', 'Delete', () => A.deleteSelection()),
  ];
  return panel('layers', 'Layers', list, { actions, grow: true });
}

// ------------------------------------------------------------ library

export function libraryPanel() {
  const grid = h('div', { class: 'library' });
  const search = h('input', { class: 'text-input lib-search', placeholder: 'Search components…' }) as HTMLInputElement;
  search.addEventListener('input', () => render());
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const card = (c: Component) => {
    const thumb = h('img', { class: 'lib-thumb', src: thumbURL(c.objects, 'lib:' + c.id, 96, 64), alt: '', draggable: false });
    const el = h(
      'div',
      { class: 'lib-card', draggable: 'true', title: `${c.name} — double-click or drag onto the canvas` },
      thumb,
      h('div', { class: 'lib-name' }, c.name),
      h(
        'div',
        { class: 'lib-actions' },
        iconBtn('plus', 'Insert', () => A.instantiate(c)),
        iconBtn('pencil', 'Edit master', () => A.editComponent(c)),
        iconBtn('text', 'Rename', () => A.renameComponent(c)),
        iconBtn('trash', 'Delete', () => A.deleteComponent(c)),
      ),
    );
    el.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (!app.active) A.createDoc(128, 128);
      A.instantiate(c);
    });
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer!.setData('application/x-monobit-component', c.id);
      e.dataTransfer!.effectAllowed = 'copy';
      const img = new Image();
      img.src = thumb.src;
      e.dataTransfer!.setDragImage(thumb, 48, 32);
    });
    return el;
  };
  const render = () => {
    clear(grid);
    const q = search.value.toLowerCase().trim();
    const items = app.library.filter((c) => !q || c.name.toLowerCase().includes(q));
    items.forEach((c) => grid.append(card(c)));
    if (!items.length) grid.append(h('div', { class: 'empty' }, h('p', {}, q ? 'No matches.' : 'Library is empty.'), h('p', { class: 'hint' }, 'Select objects and press Ctrl+K to save them as a reusable component.')));
  };
  on('library', render);
  render();
  viewport.onDropComponent = (id, x, y) => A.insertComponentById(id, x, y);
  const content = h('div', { class: 'library-wrap' }, search, grid);
  return panel('library', 'Library', content, { actions: [iconBtn('plus', 'Save selection as component (Ctrl+K)', A.makeComponent)], grow: true });
}

// ------------------------------------------------------------ preview (navigator)

export function previewPanel() {
  const cv = h('canvas', { class: 'preview-canvas' }) as HTMLCanvasElement;
  let scale = 1;
  const wrap = h('div', { class: 'preview-wrap' }, cv);
  const seg = segmented(
    [
      { value: '1', label: '1×' },
      { value: '2', label: '2×' },
      { value: '3', label: '3×' },
    ],
    () => String(scale),
    (v) => {
      scale = +v;
      draw(viewport.paperCanvas);
    },
  );
  const draw = (paper: HTMLCanvasElement) => {
    const maxW = Math.max(60, wrap.clientWidth - 8);
    let s = scale;
    if (paper.width * s > maxW * 1.5) s = Math.max(0.25, maxW / paper.width);
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(paper.width * s));
    cv.height = Math.max(1, Math.round(paper.height * s));
    cv.style.width = `${cv.width / dpr}px`;
    cv.style.height = `${cv.height / dpr}px`;
    const ctx = cv.getContext('2d')!;
    ctx.imageSmoothingEnabled = s < 1;
    ctx.drawImage(paper, 0, 0, cv.width, cv.height);
  };
  viewport.onComposite = draw;
  cv.addEventListener('pointerdown', (e) => {
    const d = app.active;
    if (!d) return;
    const r = cv.getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * d.data.width,
      fy = ((e.clientY - r.top) / r.height) * d.data.height;
    d.view.panX = Math.round(viewport.canvas.width / 2 - fx * d.view.zoom);
    d.view.panY = Math.round(viewport.canvas.height / 2 - fy * d.view.zoom);
    emit('view');
  });
  return panel('preview', 'Preview', h('div', {}, wrap, h('div', { class: 'row center' }, seg)), { collapsed: false });
}

// ------------------------------------------------------------ history

export function historyPanel() {
  const list = h('div', { class: 'history' });
  const render = () => {
    clear(list);
    const d = app.active;
    if (!d) return;
    const entries = d.history.entries;
    entries.forEach((e, i) => {
      const r = h('div', { class: 'hist' + (e.current ? ' on' : '') + (e.future ? ' future' : '') }, h('span', { class: 'hist-n' }, String(i)), h('span', {}, e.label));
      r.addEventListener('click', () => d.restore(d.history.jump(i)));
      list.append(r);
    });
    list.querySelector('.hist.on')?.scrollIntoView({ block: 'nearest' });
  };
  on('history', render);
  on('tabs', render);
  render();
  return panel('history', 'History', list, { collapsed: true });
}

export { patEquals, swatchButton };
