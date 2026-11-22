import { h, clear, numField, segmented, toggle, select, drawSwatch } from './dom';
import { modal, toast } from './overlay';
import { icon } from './icons';
import { app, emit } from '../app/state';
import * as A from '../app/actions';
import * as io from '../app/io';
import { decodeToGray, DITHER_ALGOS, resampleGray, adjust, ditherGray } from '../core/dither';
import { patPaint, invertPat } from '../core/patterns';
import type { Background, DitherAlgo, Pat } from '../core/types';
import { toRGBA } from '../core/render';

// ------------------------------------------------------------ new document

const PRESETS: { name: string; w: number; h: number; note: string }[] = [
  { name: 'Icon', w: 16, h: 16, note: 'Favicons, tiny icons' },
  { name: 'Sprite', w: 32, h: 32, note: 'Characters & items' },
  { name: 'Tile', w: 64, h: 64, note: 'Tiles, stickers' },
  { name: 'Avatar', w: 128, h: 128, note: 'Profile pictures' },
  { name: 'OLED 128×64', w: 128, h: 64, note: 'SSD1306 displays' },
  { name: 'OLED 128×32', w: 128, h: 32, note: 'Small OLED bars' },
  { name: 'E-Ink 2.13″', w: 250, h: 122, note: 'Badge-size e-paper' },
  { name: 'E-Ink 2.9″', w: 296, h: 128, note: 'Name tags' },
  { name: 'Handheld', w: 160, h: 144, note: 'Retro handheld screen' },
  { name: '1-bit Console', w: 400, h: 240, note: 'Modern 1-bit handhelds' },
  { name: 'Classic Desktop', w: 512, h: 342, note: '9″ compact computer' },
  { name: 'VGA', w: 640, h: 480, note: 'Wallpapers, posters' },
];

function presetThumb(w: number, hh: number) {
  const box = 44;
  const s = Math.min(box / w, box / hh);
  return h('div', { class: 'preset-thumb' }, h('div', { class: 'preset-paper', style: `width:${Math.max(4, Math.round(w * s))}px;height:${Math.max(4, Math.round(hh * s))}px` }));
}

export async function newDocDialog() {
  const st = { w: 128, h: 128, bg: 'white' as Background, name: '' };
  const wf = numField('W', () => st.w, (v) => (st.w = v), { min: 1, max: 4096, suffix: 'px', width: 64 });
  const hf = numField('H', () => st.h, (v) => (st.h = v), { min: 1, max: 4096, suffix: 'px', width: 64 });
  const grid = h('div', { class: 'preset-grid' });
  const cards: HTMLElement[] = [];
  PRESETS.forEach((p) => {
    const c = h('button', { class: 'preset', type: 'button' }, presetThumb(p.w, p.h), h('div', { class: 'preset-name' }, p.name), h('div', { class: 'preset-size' }, `${p.w}×${p.h}`));
    c.title = p.note;
    c.addEventListener('click', () => {
      st.w = p.w;
      st.h = p.h;
      (wf as any).sync();
      (hf as any).sync();
      cards.forEach((k) => k.classList.toggle('on', k === c));
    });
    c.addEventListener('dblclick', () => m.close('ok'));
    if (p.w === 128 && p.h === 128) c.classList.add('on');
    cards.push(c);
    grid.append(c);
  });
  const body = h(
    'div',
    { class: 'newdoc' },
    grid,
    h(
      'div',
      { class: 'newdoc-side' },
      h('div', { class: 'form-label' }, 'Custom size'),
      h('div', { class: 'row' }, wf, hf),
      h('div', { class: 'form-label' }, 'Background'),
      segmented<Background>(
        [
          { value: 'white', label: 'White' },
          { value: 'black', label: 'Black' },
          { value: 'transparent', label: 'None' },
        ],
        () => st.bg,
        (v) => (st.bg = v),
      ),
      h('p', { class: 'hint' }, 'Tip: canvas size can be changed any time from Image › Canvas Size.'),
    ),
  );
  const m = modal(
    'New Image',
    body,
    [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Create', value: 'ok', primary: true },
    ],
    'cancel',
    { width: 640 },
  );
  if ((await m.result) === 'ok') A.createDoc(Math.max(1, Math.min(4096, st.w)), Math.max(1, Math.min(4096, st.h)), st.bg);
}

// ------------------------------------------------------------ canvas size

export async function canvasSizeDialog() {
  const d = app.active;
  if (!d) return;
  const st = { w: d.data.width, h: d.data.height, lock: false, anchor: [0.5, 0.5] as [number, number] };
  const ratio = d.data.width / d.data.height;
  let wf: HTMLElement, hf: HTMLElement;
  wf = numField('W', () => st.w, (v) => {
    st.w = v;
    if (st.lock) {
      st.h = Math.max(1, Math.round(v / ratio));
      (hf as any).sync();
    }
  }, { min: 1, max: 4096, suffix: 'px', width: 64 });
  hf = numField('H', () => st.h, (v) => {
    st.h = v;
    if (st.lock) {
      st.w = Math.max(1, Math.round(v * ratio));
      (wf as any).sync();
    }
  }, { min: 1, max: 4096, suffix: 'px', width: 64 });
  const anchors = h('div', { class: 'anchor-grid' });
  const renderAnchors = () => {
    clear(anchors);
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 3; x++) {
        const on = st.anchor[0] === x / 2 && st.anchor[1] === y / 2;
        const b = h('button', { class: 'anchor' + (on ? ' on' : ''), type: 'button' });
        b.addEventListener('click', () => {
          st.anchor = [x / 2, y / 2];
          renderAnchors();
        });
        anchors.append(b);
      }
  };
  renderAnchors();
  const body = h(
    'div',
    { class: 'form' },
    h('div', { class: 'form-label' }, `Current: ${d.data.width} × ${d.data.height}`),
    h('div', { class: 'row' }, wf, hf),
    toggle('Keep proportions', () => st.lock, (v) => (st.lock = v)),
    h('div', { class: 'form-label' }, 'Anchor'),
    anchors,
  );
  const r = await modal(
    'Canvas Size',
    body,
    [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Resize', value: 'ok', primary: true },
    ],
    'cancel',
    { width: 340 },
  ).result;
  if (r === 'ok') A.resizeCanvas(Math.max(1, Math.min(4096, st.w)), Math.max(1, Math.min(4096, st.h)), st.anchor);
}

// ------------------------------------------------------------ export

export async function exportDialog() {
  const d = app.active;
  const raster = A.rasterOut();
  if (!d || !raster) return;
  const st = { fmt: 'png' as io.ExportFormat, scale: app.settings.exportScale || 1 };
  const preview = h('canvas', { class: 'export-preview' }) as HTMLCanvasElement;
  const code = h('pre', { class: 'export-code' });
  const info = h('div', { class: 'export-info' });
  const previewWrap = h('div', { class: 'export-preview-wrap' }, preview, code);
  const update = async () => {
    const f = io.EXPORT_FORMATS.find((x) => x.id === st.fmt)!;
    const s = f.scalable ? st.scale : 1;
    info.textContent = `${raster.width * s} × ${raster.height * s} px · ${f.desc}`;
    scaleField.style.display = f.scalable ? '' : 'none';
    if (f.id === 'h' || f.id === 'xbm') {
      preview.style.display = 'none';
      code.style.display = '';
      const txt = await io.exportText(f.id, raster, d.name);
      code.textContent = txt.length > 4000 ? txt.slice(0, 4000) + '\n…' : txt;
    } else {
      preview.style.display = '';
      code.style.display = 'none';
      const maxS = Math.max(1, Math.min(s, Math.floor(360 / Math.max(raster.width, raster.height)) || 1));
      preview.width = raster.width * maxS;
      preview.height = raster.height * maxS;
      const t = document.createElement('canvas');
      t.width = raster.width;
      t.height = raster.height;
      t.getContext('2d')!.putImageData(toRGBA(raster.pixels, raster.width, raster.height, true), 0, 0);
      const ctx = preview.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(t, 0, 0, preview.width, preview.height);
    }
  };
  const scaleField = h(
    'div',
    { class: 'field' },
    h('label', { class: 'form-label' }, 'Scale'),
    segmented(
      [1, 2, 3, 4, 8, 16].map((n) => ({ value: String(n), label: `${n}×` })),
      () => String(st.scale),
      (v) => {
        st.scale = +v;
        app.settings.exportScale = +v;
        update();
      },
    ),
  );
  const fmtList = h('div', { class: 'fmt-list' });
  const renderFmts = () => {
    clear(fmtList);
    for (const f of io.EXPORT_FORMATS) {
      const b = h('button', { class: 'fmt' + (st.fmt === f.id ? ' on' : ''), type: 'button' }, h('b', {}, f.label), h('small', {}, '.' + f.ext));
      b.addEventListener('click', () => {
        st.fmt = f.id;
        renderFmts();
        update();
      });
      fmtList.append(b);
    }
  };
  renderFmts();
  const body = h('div', { class: 'export' }, h('div', { class: 'export-left' }, h('div', { class: 'form-label' }, 'Format'), fmtList, scaleField), h('div', { class: 'export-right' }, previewWrap, info));
  update();
  const r = await modal(
    'Export Image',
    body,
    [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Copy', value: 'copy' },
      { label: 'Export…', value: 'ok', primary: true },
    ],
    'cancel',
    { width: 700 },
  ).result;
  if (r === 'copy') {
    try {
      await io.copyImage(raster, st.scale);
      toast('Copied to clipboard');
    } catch (e: any) {
      toast(`Copy failed: ${e?.message ?? e}`, { kind: 'error' });
    }
  }
  if (r !== 'ok') return;
  const f = io.EXPORT_FORMATS.find((x) => x.id === st.fmt)!;
  const path = await io.pickSave(`${d.name}.${f.ext}`, { name: f.label, extensions: [f.ext] });
  if (!path) return;
  try {
    const bytes = await io.exportImage(path, f.id, raster, f.scalable ? st.scale : 1, d.name);
    toast(`Exported ${path.split(/[\\/]/).pop()} (${bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1) + ' KB'})`);
  } catch (e: any) {
    toast(`Export failed: ${e?.message ?? e}`, { kind: 'error' });
  }
}

// ------------------------------------------------------------ image import

export async function importImage(dataUrl?: string, name = 'Image') {
  if (!app.active) A.createDoc(128, 128);
  if (!dataUrl) {
    const f = await io.pickOpen('image');
    if (!f?.dataUrl) return;
    dataUrl = f.dataUrl;
    name = f.name.replace(/\.\w+$/, '');
  }
  let src: { w: number; h: number; data: Uint8Array };
  try {
    src = await decodeToGray(dataUrl);
  } catch {
    return toast('Could not read that image', { kind: 'error' });
  }
  const d = app.active!;
  const fit = Math.min(1, d.data.width / src.w, d.data.height / src.h);
  const st = {
    algo: 'atkinson' as DitherAlgo,
    brightness: 0,
    contrast: 0,
    gamma: 1,
    invert: false,
    knockout: false,
    w: Math.max(1, Math.round(src.w * fit)),
    h: Math.max(1, Math.round(src.h * fit)),
  };
  const ratio = src.w / src.h;
  const cv = h('canvas', { class: 'import-preview' }) as HTMLCanvasElement;
  const orig = h('canvas', { class: 'import-preview' }) as HTMLCanvasElement;
  let raf = 0;
  const render = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const w = st.w,
        hh = st.h;
      const g = resampleGray(src.data, src.w, src.h, w, hh);
      const og = Float32Array.from(g);
      adjust(g, st);
      const ink = ditherGray(g, w, hh, st.algo);
      const px = new Uint8Array(w * hh);
      for (let i = 0; i < px.length; i++) px[i] = ink[i] ? 1 : st.knockout ? 0 : 2;
      const scale = Math.max(1, Math.floor(260 / Math.max(w, hh)));
      for (const [c, data] of [
        [cv, toRGBA(px, w, hh, true)],
        [orig, (() => {
          const im = new ImageData(w, hh);
          for (let i = 0; i < og.length; i++) im.data.set([og[i], og[i], og[i], 255], i * 4);
          return im;
        })()],
      ] as [HTMLCanvasElement, ImageData][]) {
        c.width = w * scale;
        c.height = hh * scale;
        const t = document.createElement('canvas');
        t.width = w;
        t.height = hh;
        t.getContext('2d')!.putImageData(data, 0, 0);
        const ctx = c.getContext('2d')!;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(t, 0, 0, c.width, c.height);
      }
    });
  };
  let wf: HTMLElement, hf: HTMLElement;
  wf = numField('W', () => st.w, (v) => {
    st.w = v;
    st.h = Math.max(1, Math.round(v / ratio));
    (hf as any).sync();
    render();
  }, { min: 1, max: 2048, suffix: 'px', width: 56 });
  hf = numField('H', () => st.h, (v) => {
    st.h = v;
    st.w = Math.max(1, Math.round(v * ratio));
    (wf as any).sync();
    render();
  }, { min: 1, max: 2048, suffix: 'px', width: 56 });
  const controls = h(
    'div',
    { class: 'import-controls' },
    h('div', { class: 'form-label' }, 'Dither'),
    select(DITHER_ALGOS.map((a) => ({ value: a.id, label: a.label })), () => st.algo, (v) => ((st.algo = v), render())),
    h('div', { class: 'form-label' }, 'Size'),
    h('div', { class: 'row' }, wf, hf),
    h('div', { class: 'form-label' }, 'Adjust'),
    numField('Brightness', () => st.brightness, (v) => ((st.brightness = v), render()), { min: -100, max: 100 }),
    numField('Contrast', () => st.contrast, (v) => ((st.contrast = v), render()), { min: -100, max: 100 }),
    numField('Gamma', () => st.gamma, (v) => ((st.gamma = v), render()), { min: 0.2, max: 3, step: 0.05 }),
    h('div', { class: 'row' }, toggle('Invert', () => st.invert, (v) => ((st.invert = v), render())), toggle('White = transparent', () => st.knockout, (v) => ((st.knockout = v), render()))),
    h('p', { class: 'hint' }, 'All of these stay editable after import in the Properties panel.'),
  );
  const body = h('div', { class: 'import' }, h('div', { class: 'import-previews' }, h('figure', {}, orig, h('figcaption', {}, 'Source')), h('figure', {}, cv, h('figcaption', {}, '1-bit'))), controls);
  render();
  const r = await modal(
    'Import Image',
    body,
    [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Place', value: 'ok', primary: true },
    ],
    'cancel',
    { width: 860 },
  ).result;
  if (r !== 'ok') return;
  A.insertImage(src, name, { ...st, w: st.w, h: st.h });
  const o = app.active!.selected()[0];
  if (o && o.type === 'image') {
    o.w = st.w;
    o.h = st.h;
    o.x = Math.round((app.active!.data.width - st.w) / 2);
    o.y = Math.round((app.active!.data.height - st.h) / 2);
    app.active!.commit('Place image', 'place');
  }
}

// ------------------------------------------------------------ pattern editor

export async function patternEditor(initial?: Pat): Promise<Pat | null> {
  const pat = [...(initial ?? [0, 0, 0, 0, 0, 0, 0, 0])];
  const grid = h('div', { class: 'pat-grid' });
  const prev = h('canvas', { class: 'pat-preview' }) as HTMLCanvasElement;
  let painting: number | null = null;
  const cells: HTMLElement[] = [];
  const refresh = () => {
    cells.forEach((c, i) => c.classList.toggle('on', ((pat[i >> 3] >> (7 - (i & 7))) & 1) === 1));
    drawSwatch(prev, patPaint(pat), 160, 160, 2);
  };
  for (let i = 0; i < 64; i++) {
    const c = h('div', { class: 'pat-cell' });
    const set = (v: number) => {
      const y = i >> 3,
        bit = 0x80 >> (i & 7);
      pat[y] = v ? pat[y] | bit : pat[y] & ~bit;
      refresh();
    };
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      painting = ((pat[i >> 3] >> (7 - (i & 7))) & 1) ^ 1;
      set(painting);
    });
    c.addEventListener('pointerenter', () => painting !== null && set(painting));
    cells.push(c);
    grid.append(c);
  }
  window.addEventListener('pointerup', () => (painting = null));
  const shift = (dx: number, dy: number) => {
    const out = [...pat];
    for (let y = 0; y < 8; y++) {
      const r = pat[(y - dy + 8) & 7];
      out[y] = dx ? ((r >> dx) | (r << (8 - dx))) & 255 : r;
    }
    pat.splice(0, 8, ...out);
    refresh();
  };
  const tools = h(
    'div',
    { class: 'row wrap' },
    h('button', { class: 'btn small', onclick: () => (pat.splice(0, 8, ...invertPat(pat)), refresh()) }, 'Invert'),
    h('button', { class: 'btn small', onclick: () => (pat.fill(0), refresh()) }, 'Clear'),
    h('button', { class: 'btn small', onclick: () => shift(1, 0) }, '→'),
    h('button', { class: 'btn small', onclick: () => shift(7, 0) }, '←'),
    h('button', { class: 'btn small', onclick: () => shift(0, 1) }, '↓'),
    h('button', { class: 'btn small', onclick: () => shift(0, 7) }, '↑'),
  );
  refresh();
  const body = h('div', { class: 'pat-editor' }, h('div', {}, grid, tools), h('div', { class: 'pat-side' }, h('div', { class: 'form-label' }, 'Tiled preview'), prev));
  const r = await modal(
    'Pattern Editor',
    body,
    [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Save Pattern', value: 'ok', primary: true },
    ],
    'cancel',
    { width: 520 },
  ).result;
  return r === 'ok' ? pat : null;
}

// ------------------------------------------------------------ shortcuts & about

export const SHORTCUTS: [string, string][] = [
  ['V / B / E / G', 'Select · Pencil · Eraser · Fill'],
  ['L / U / T / I', 'Line · Shape · Text · Pattern picker'],
  ['H / Z / Space', 'Hand · Zoom · Temporary pan'],
  ['[ / ]', 'Brush or stroke size'],
  ['X / D', 'Swap stroke & fill · Default paints'],
  ['1 … 0', 'Quick density patterns'],
  ['Ctrl+N / O / S', 'New · Open · Save'],
  ['Ctrl+Shift+S', 'Save as'],
  ['Ctrl+I / Ctrl+E', 'Import image · Export'],
  ['Ctrl+Z / Ctrl+Y', 'Undo · Redo'],
  ['Ctrl+C / X / V / D', 'Copy · Cut · Paste · Duplicate'],
  ['Ctrl+G / Ctrl+Shift+G', 'Group · Ungroup'],
  ['Ctrl+K', 'Make component'],
  ['Ctrl+] / Ctrl+[', 'Bring forward · Send backward'],
  ['Ctrl+Shift+] / [', 'Bring to front · Send to back'],
  ['Arrows (+Shift)', 'Nudge 1px (8px)'],
  ['Enter / Esc', 'Enter group · Exit group / deselect'],
  ["Ctrl+' / Ctrl+0 / Ctrl+1", 'Grid · Fit · Actual pixels'],
  ['Ctrl+wheel', 'Zoom at cursor'],
  ['Ctrl+Shift+P', 'Command palette'],
];

export function shortcutsDialog() {
  const t = h('div', { class: 'shortcuts' }, ...SHORTCUTS.map(([k, v]) => h('div', { class: 'sc-row' }, h('kbd', {}, k), h('span', {}, v))));
  modal('Keyboard Shortcuts', t, [{ label: 'Close', value: 0, primary: true }], 0, { width: 560 });
}

export function aboutDialog() {
  const logo = h('canvas', { class: 'about-logo' }) as HTMLCanvasElement;
  const body = h(
    'div',
    { class: 'about' },
    logo,
    h('h2', {}, 'MONOBIT'),
    h('p', {}, 'A 1-bit pixel art studio.'),
    h('p', { class: 'hint' }, 'Version 1.0 · Built with Tauri & Rust'),
    h('p', { class: 'hint' }, 'Bundled typefaces are licensed under the SIL Open Font License: Silkscreen, Press Start 2P, VT323, Pixelify Sans, Tiny5, Micro 5, Jersey 10, Jacquard 12, Sixtyfour, Workbench, Bytesized, DotGothic16, Doto, Handjet.'),
  );
  // animated dissolve-in logo
  logo.width = 64;
  logo.height = 64;
  const img = new Image();
  img.src = import.meta.env.BASE_URL + 'app-icon-64.png';
  let lvl = 0;
  const ctx = logo.getContext('2d')!;
  const tick = () => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#000';
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if ((((x * 7 + y * 13) ^ (x * y)) & 15) < lvl) ctx.fillRect(x, y, 1, 1);
    if (img.complete && lvl >= 16) ctx.drawImage(img, 0, 0);
    lvl++;
    if (lvl <= 17) setTimeout(tick, 40);
  };
  tick();
  modal('About Monobit', body, [{ label: 'OK', value: 0, primary: true }], 0, { width: 420 });
}

export function customPatternsChanged() {
  emit('settings');
  A.persistSettingsSoon();
}

export { icon };
