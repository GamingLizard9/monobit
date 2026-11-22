import '@fontsource/silkscreen/400.css';
import '@fontsource/silkscreen/700.css';
import '@fontsource/press-start-2p/400.css';
import '@fontsource/vt323/400.css';
import '@fontsource/pixelify-sans/400.css';
import '@fontsource/tiny5/400.css';
import '@fontsource/micro-5/400.css';
import '@fontsource/jersey-10/400.css';
import '@fontsource/jacquard-12/400.css';
import '@fontsource/sixtyfour/400.css';
import '@fontsource/workbench/400.css';
import '@fontsource/bytesized/400.css';
import '@fontsource/dotgothic16/400.css';
import '@fontsource/doto/400.css';
import '@fontsource/doto/900.css';
import '@fontsource/handjet/400.css';
import './styles.css';

import { app, on, emit } from './app/state';
import * as A from './app/actions';
import * as io from './app/io';
import { bindKeys } from './app/commands';
import { loadFonts, onFontsChanged } from './core/fonts';
import { clearRenderCache } from './core/render';
import { BAYER4 } from './core/patterns';
import { h } from './ui/dom';
import { titleBar, menuBar, optionsBar, toolbox, tabBar, statusBar } from './ui/shell';
import { patternsPanel, inspectorPanel, layersPanel, libraryPanel, previewPanel, historyPanel } from './ui/panels';
import { mountOverlay, toast } from './ui/overlay';
import { editText } from './ui/textedit';
import { viewport } from './editor/viewport';
import { hooks } from './editor/tools';

function applyTheme() {
  document.documentElement.dataset.theme = app.settings.theme;
  document.documentElement.classList.toggle('no-anim', !app.settings.animations);
}

// ------------------------------------------------------------ splash

function splash(): { done: () => Promise<void> } {
  if (!app.settings.splash) return { done: async () => {} };
  const cv = h('canvas', { class: 'splash-logo' }) as HTMLCanvasElement;
  const bar = h('div', { class: 'splash-bar' }, h('div', { class: 'splash-fill' }));
  const el = h('div', { class: 'splash' }, h('div', { class: 'splash-inner' }, cv, h('div', { class: 'splash-sub' }, '1-BIT PIXEL STUDIO'), bar));
  document.body.append(el);
  const W = 120,
    H = 28,
    S = 4;
  cv.width = W * S;
  cv.height = H * S;
  // rasterise the logotype once
  const m = document.createElement('canvas');
  m.width = W;
  m.height = H;
  const mx = m.getContext('2d', { willReadFrequently: true })!;
  let mask: Uint8Array | null = null;
  const buildMask = () => {
    mx.clearRect(0, 0, W, H);
    mx.font = '16px "Silkscreen"';
    mx.textBaseline = 'alphabetic';
    mx.fillStyle = '#000';
    const tw = mx.measureText('MONOBIT').width;
    mx.fillText('MONOBIT', Math.round((W - tw) / 2), 19);
    const d = mx.getImageData(0, 0, W, H).data;
    mask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) mask[i] = d[i * 4 + 3] > 127 ? 1 : 0;
  };
  document.fonts.load('16px "Silkscreen"').then(buildMask, buildMask);
  const ctx = cv.getContext('2d')!;
  let level = 0;
  let stop = false;
  const draw = () => {
    if (stop) return;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#000';
    if (mask) {
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const on = mask[y * W + x];
          // shadow: dithered, logo: solid; both dissolve in by Bayer level
          const sh = !on && y > 1 && x > 1 && mask[(y - 2) * W + (x - 2)];
          if (on && BAYER4[y & 3][x & 3] < level) ctx.fillRect(x * S, y * S, S, S);
          else if (sh && (x + y) % 2 === 0 && BAYER4[y & 3][x & 3] < level - 4) ctx.fillRect(x * S, y * S, S, S);
        }
      if (level < 20) level++;
    }
    setTimeout(draw, 45);
  };
  draw();
  const start = performance.now();
  return {
    done: async () => {
      const wait = Math.max(0, 1300 - (performance.now() - start));
      await new Promise((r) => setTimeout(r, wait));
      el.classList.add('done');
      // dither-dissolve the splash away
      for (let k = 15; k >= 0; k--) {
        el.style.setProperty('--mask', `url(${densityMaskURL(k)})`);
        await new Promise((r) => setTimeout(r, 28));
      }
      stop = true;
      el.remove();
    },
  };
}

function densityMaskURL(level: number) {
  const c = document.createElement('canvas');
  c.width = c.height = 4;
  const x = c.getContext('2d')!;
  x.fillStyle = '#000';
  for (let y = 0; y < 4; y++) for (let i = 0; i < 4; i++) if (BAYER4[y][i] < level) x.fillRect(i, y, 1, 1);
  return c.toDataURL();
}

// ------------------------------------------------------------ boot

async function boot() {
  if (import.meta.env.DEV && location.search.includes('reset')) {
    localStorage.clear();
    history.replaceState(null, '', location.pathname);
  }
  await A.loadSettings();
  applyTheme();
  const sp = splash();
  io.applyCrispZoom(app.settings.pixelPerfectUI);
  mountOverlay();

  hooks.vp = viewport;
  hooks.toast = (m) => toast(m);
  hooks.editText = editText;

  const center = h('div', { class: 'center' }, tabBar());
  const root = h(
    'div',
    { class: 'app' },
    titleBar(),
    menuBar(),
    optionsBar(),
    h('div', { class: 'workspace' }, toolbox(), center, h('div', { class: 'dock dock-a' }, patternsPanel(), inspectorPanel()), h('div', { class: 'dock dock-b' }, previewPanel(), layersPanel(), libraryPanel(), historyPanel())),
    statusBar(),
  );
  document.getElementById('app')!.replaceWith(root);
  viewport.mount(center);
  center.append(h('div', { class: 'empty-state' }, h('p', {}, 'No image open'), h('p', { class: 'hint' }, 'Ctrl+N for a new image · Ctrl+O to open')));
  on('tabs', () => center.classList.toggle('no-doc', !app.active));

  bindKeys();
  on('settings', () => {
    applyTheme();
    A.persistSettingsSoon();
  });
  on('tool', A.persistSettingsSoon);
  on('doc', A.persistSessionSoon);
  on('tabs', A.persistSessionSoon);
  on('paint', A.persistSessionSoon);

  await loadFonts();
  onFontsChanged(() => {
    clearRenderCache();
    emit('doc');
  });
  // fonts may finish late (outline fonts/system fallbacks): refresh once more
  document.fonts.ready.then(() => {
    clearRenderCache();
    emit('doc', 'library');
  });

  await A.loadLibrary();
  const hadSession = await A.restoreSession();
  if (!hadSession) {
    // first launch: a welcome canvas featuring the name tag component
    const d = A.createDoc(296, 128, 'white', 'Welcome');
    const tag = app.library.find((c) => c.id === 'builtin-name-tag');
    if (tag) {
      A.instantiate(tag, 148, 64);
      d.history = new (d.history.constructor as any)(d.data);
      d.dirty = false;
    }
    app.tool = 'select';
  }
  const lf = await io.launchFile().catch(() => null);
  if (lf) await A.openRecent(lf);
  io.onLaunchFiles((p) => A.openRecent(p));
  io.pruneHandles([...app.settings.recent, ...app.docs.map((d) => d.path)]);

  emit('tabs', 'tool', 'paint', 'library', 'settings', 'doc', 'selection', 'history');
  requestAnimationFrame(() => viewport.resize());
  if (import.meta.env.DEV) {
    const w = window as any;
    w.__monobit = { app, viewport, A, emit };
    // dev helper: shows a region of the composite at a large integer scale
    w.__show = (scale = 4, x0 = 0, y0 = 0, ww?: number, hh?: number) => {
      const p = viewport.paperCanvas;
      ww ??= p.width;
      hh ??= p.height;
      let o = document.getElementById('dbg') as HTMLCanvasElement | null;
      if (!o) {
        o = document.createElement('canvas');
        o.id = 'dbg';
        o.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#888;image-rendering:pixelated';
        document.body.append(o);
      }
      o.width = ww * scale;
      o.height = hh * scale;
      const c = o.getContext('2d')!;
      c.imageSmoothingEnabled = false;
      c.drawImage(p, x0, y0, ww, hh, 0, 0, ww * scale, hh * scale);
    };
    w.__hide = () => document.getElementById('dbg')?.remove();
  }

  if (io.isTauri) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    w.onCloseRequested(async (e) => {
      e.preventDefault();
      await A.saveSession().catch(() => {});
      await w.destroy();
    });
  }
  window.addEventListener('beforeunload', () => {
    A.saveSession();
  });
  // browser storage is async, so also save whenever the page is hidden (tab switch, close, app switch)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') A.saveSession();
  });
  await sp.done();
}

boot();
