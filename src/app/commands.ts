import { app, emit } from './state';
import * as A from './actions';
import * as io from './io';
import { viewport, isTyping } from '../editor/viewport';
import { tools, TOOL_INFO } from '../editor/tools';
import { newDocDialog, canvasSizeDialog, exportDialog, importImage, shortcutsDialog, aboutDialog } from '../ui/dialogs';
import { DENSITY, patPaint } from '../core/patterns';
import { modalOpen } from '../ui/overlay';
import type { GroupObj } from '../core/types';

export interface Command {
  id: string;
  label: string;
  keys?: string;
  run: () => void;
  enabled?: () => boolean;
  checked?: () => boolean;
}

const hasDoc = () => !!app.active;
/** Browsers reserve some shortcuts (new window, close tab, dev tools), so the web build uses alternatives. */
const K = (desktop: string, web: string) => (io.isTauri ? desktop : web);
const hasSel = () => !!app.active?.selection.length;
const selOne = (t?: string) => () => {
  const s = app.active?.selected() ?? [];
  return s.length === 1 && (!t || s[0].type === t);
};

const toggleSetting = (k: 'grid' | 'showCheckerboard' | 'animations' | 'pixelPerfectUI' | 'splash') => () => {
  (app.settings as any)[k] = !app.settings[k];
  emit('settings', 'render');
  A.persistSettingsSoon();
  if (k === 'pixelPerfectUI') io.applyCrispZoom(app.settings.pixelPerfectUI);
};

export const COMMANDS: Command[] = [
  // file
  { id: 'file.new', label: 'New…', keys: K('Ctrl+N', 'Alt+N'), run: newDocDialog },
  { id: 'file.open', label: 'Open…', keys: 'Ctrl+O', run: A.openDoc },
  { id: 'file.save', label: 'Save', keys: 'Ctrl+S', run: () => A.saveDoc(), enabled: hasDoc },
  { id: 'file.saveAs', label: 'Save As…', keys: 'Ctrl+Shift+S', run: () => A.saveDoc(undefined, true), enabled: () => hasDoc() && app.active!.kind === 'image' },
  { id: 'file.import', label: 'Import Image…', keys: 'Ctrl+I', run: () => importImage() },
  { id: 'file.export', label: 'Export…', keys: 'Ctrl+E', run: exportDialog, enabled: hasDoc },
  { id: 'file.copyImage', label: 'Copy Image to Clipboard', keys: K('Ctrl+Shift+C', 'Alt+Shift+C'), run: A.copyImageToClipboard, enabled: hasDoc },
  { id: 'file.close', label: 'Close Tab', keys: K('Ctrl+W', 'Alt+W'), run: () => A.closeDoc(), enabled: hasDoc },
  { id: 'file.libExport', label: 'Export Library…', run: A.exportLibrary },
  { id: 'file.libImport', label: 'Import Library…', run: A.importLibrary },
  {
    id: 'file.quit',
    label: 'Quit',
    keys: K('Ctrl+Q', ''),
    run: async () => {
      await A.saveSession();
      io.windowAction('close');
    },
  },
  // edit
  { id: 'edit.undo', label: 'Undo', keys: 'Ctrl+Z', run: A.undo, enabled: () => !!app.active?.history.canUndo },
  { id: 'edit.redo', label: 'Redo', keys: 'Ctrl+Y', run: A.redo, enabled: () => !!app.active?.history.canRedo },
  { id: 'edit.cut', label: 'Cut', keys: 'Ctrl+X', run: A.cut, enabled: hasSel },
  { id: 'edit.copy', label: 'Copy', keys: 'Ctrl+C', run: A.copy, enabled: hasSel },
  { id: 'edit.paste', label: 'Paste', keys: 'Ctrl+V', run: A.paste, enabled: () => hasDoc() && app.clipboard.length > 0 },
  { id: 'edit.duplicate', label: 'Duplicate', keys: 'Ctrl+D', run: A.duplicate, enabled: hasSel },
  { id: 'edit.delete', label: 'Delete', keys: 'Delete', run: () => A.deleteSelection(), enabled: hasSel },
  { id: 'edit.selectAll', label: 'Select All', keys: 'Ctrl+A', run: A.selectAll, enabled: hasDoc },
  { id: 'edit.deselect', label: 'Deselect', keys: 'Ctrl+Shift+A', run: A.deselect, enabled: hasSel },
  { id: 'edit.swap', label: 'Swap Stroke & Fill', keys: 'X', run: A.swapPaints },
  { id: 'edit.defaults', label: 'Default Paints', keys: 'D', run: A.defaultPaints },
  // object
  { id: 'obj.group', label: 'Group', keys: 'Ctrl+G', run: A.group, enabled: hasSel },
  { id: 'obj.ungroup', label: 'Ungroup', keys: 'Ctrl+Shift+G', run: A.ungroup, enabled: () => !!app.active?.selected().some((o) => o.type === 'group') },
  { id: 'obj.enter', label: 'Edit Group Contents', keys: 'Enter', run: () => A.enterGroup(), enabled: selOne('group') },
  { id: 'obj.exit', label: 'Exit Group', keys: 'Esc', run: A.exitScope, enabled: () => !!app.active?.scope },
  { id: 'obj.front', label: 'Bring to Front', keys: 'Ctrl+Shift+]', run: () => A.arrange('front'), enabled: hasSel },
  { id: 'obj.forward', label: 'Bring Forward', keys: 'Ctrl+]', run: () => A.arrange('forward'), enabled: hasSel },
  { id: 'obj.backward', label: 'Send Backward', keys: 'Ctrl+[', run: () => A.arrange('backward'), enabled: hasSel },
  { id: 'obj.back', label: 'Send to Back', keys: 'Ctrl+Shift+[', run: () => A.arrange('back'), enabled: hasSel },
  { id: 'obj.flipH', label: 'Flip Horizontal', keys: 'Shift+H', run: () => A.flip('x'), enabled: hasSel },
  { id: 'obj.flipV', label: 'Flip Vertical', keys: 'Shift+V', run: () => A.flip('y'), enabled: hasSel },
  { id: 'obj.alignL', label: 'Align Left', run: () => A.align('left'), enabled: hasSel },
  { id: 'obj.alignC', label: 'Align Center', run: () => A.align('hcenter'), enabled: hasSel },
  { id: 'obj.alignR', label: 'Align Right', run: () => A.align('right'), enabled: hasSel },
  { id: 'obj.alignT', label: 'Align Top', run: () => A.align('top'), enabled: hasSel },
  { id: 'obj.alignM', label: 'Align Middle', run: () => A.align('vcenter'), enabled: hasSel },
  { id: 'obj.alignB', label: 'Align Bottom', run: () => A.align('bottom'), enabled: hasSel },
  { id: 'obj.distH', label: 'Distribute Horizontally', run: () => A.distribute('x'), enabled: hasSel },
  { id: 'obj.distV', label: 'Distribute Vertically', run: () => A.distribute('y'), enabled: hasSel },
  { id: 'obj.lock', label: 'Lock / Unlock', keys: 'Ctrl+L', run: () => A.toggleLock(), enabled: hasSel },
  { id: 'obj.hide', label: 'Hide / Show', keys: 'Ctrl+Shift+H', run: () => A.toggleVisible(), enabled: hasSel },
  { id: 'obj.rasterize', label: 'Rasterize to Pixels', run: A.rasterize, enabled: hasSel },
  { id: 'obj.mergeDown', label: 'Merge Down', keys: 'Ctrl+M', run: A.mergeDown, enabled: selOne() },
  { id: 'obj.component', label: 'Make Component…', keys: 'Ctrl+K', run: A.makeComponent, enabled: hasSel },
  {
    id: 'obj.syncComponent',
    label: 'Reset to Component',
    run: () => {
      const g = app.active?.selected()[0] as GroupObj;
      if (g?.componentId) A.syncInstance(g);
    },
    enabled: () => !!(app.active?.selected()[0] as GroupObj | undefined)?.componentId,
  },
  // image
  { id: 'img.size', label: 'Canvas Size…', keys: 'Ctrl+Alt+C', run: canvasSizeDialog, enabled: hasDoc },
  { id: 'img.crop', label: 'Crop to Selection', run: A.cropToSelection, enabled: hasSel },
  { id: 'img.trim', label: 'Trim to Content', run: A.trimCanvas, enabled: hasDoc },
  { id: 'img.bgWhite', label: 'Background: White', run: () => A.setBackground('white'), enabled: hasDoc, checked: () => app.active?.data.background === 'white' },
  { id: 'img.bgBlack', label: 'Background: Black', run: () => A.setBackground('black'), enabled: hasDoc, checked: () => app.active?.data.background === 'black' },
  { id: 'img.bgNone', label: 'Background: Transparent', run: () => A.setBackground('transparent'), enabled: hasDoc, checked: () => app.active?.data.background === 'transparent' },
  { id: 'img.flatten', label: 'Flatten Image', run: A.flattenAll, enabled: hasDoc },
  // view
  { id: 'view.zoomIn', label: 'Zoom In', keys: 'Ctrl+=', run: () => viewport.zoomStep(1), enabled: hasDoc },
  { id: 'view.zoomOut', label: 'Zoom Out', keys: 'Ctrl+-', run: () => viewport.zoomStep(-1), enabled: hasDoc },
  { id: 'view.fit', label: 'Fit on Screen', keys: 'Ctrl+0', run: () => viewport.fit(), enabled: hasDoc },
  { id: 'view.actual', label: 'Actual Pixels (100%)', keys: 'Ctrl+1', run: () => viewport.setZoom(Math.max(1, Math.round(viewport.dpr))), enabled: hasDoc },
  { id: 'view.grid', label: 'Pixel Grid', keys: "Ctrl+'", run: toggleSetting('grid'), checked: () => app.settings.grid },
  {
    id: 'view.tile8',
    label: 'Tile Grid (8px)',
    run: () => {
      app.settings.tileGrid = app.settings.tileGrid === 8 ? 0 : 8;
      emit('settings');
      A.persistSettingsSoon();
    },
    checked: () => app.settings.tileGrid === 8,
  },
  {
    id: 'view.tile16',
    label: 'Tile Grid (16px)',
    run: () => {
      app.settings.tileGrid = app.settings.tileGrid === 16 ? 0 : 16;
      emit('settings');
      A.persistSettingsSoon();
    },
    checked: () => app.settings.tileGrid === 16,
  },
  { id: 'view.checker', label: 'Show Transparency Checkerboard', run: toggleSetting('showCheckerboard'), checked: () => app.settings.showCheckerboard },
  {
    id: 'view.theme',
    label: 'Inverted Interface (Dark)',
    keys: K('Ctrl+Shift+I', 'Alt+Shift+I'),
    run: () => {
      app.settings.theme = app.settings.theme === 'dark' ? 'light' : 'dark';
      emit('settings');
      A.persistSettingsSoon();
    },
    checked: () => app.settings.theme === 'dark',
  },
  { id: 'view.crisp', label: 'Pixel-Perfect UI Scaling', run: toggleSetting('pixelPerfectUI'), checked: () => app.settings.pixelPerfectUI },
  { id: 'view.anim', label: 'Interface Animations', run: toggleSetting('animations'), checked: () => app.settings.animations },
  { id: 'view.splash', label: 'Show Splash on Launch', run: toggleSetting('splash'), checked: () => app.settings.splash },
  { id: 'view.palette', label: 'Command Palette…', keys: 'Ctrl+Shift+P', run: () => openPalette() },
  // help
  { id: 'help.keys', label: 'Keyboard Shortcuts', keys: 'F1', run: shortcutsDialog },
  { id: 'help.about', label: 'About Monobit', run: aboutDialog },
];

export const cmd = (id: string) => COMMANDS.find((c) => c.id === id)!;

export function runCommand(id: string) {
  const c = cmd(id);
  if (c && (!c.enabled || c.enabled())) c.run();
}

export let openPalette: () => void = () => {};
export const setPaletteOpener = (f: () => void) => (openPalette = f);

// ------------------------------------------------------------ keyboard

function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k === 'Escape') k = 'Esc';
  else if (k === '+') k = '=';
  else if (e.code.startsWith('Bracket')) k = e.code === 'BracketLeft' ? '[' : ']';
  else if (e.code === 'Quote') k = "'";
  else if (e.code === 'Minus') k = '-';
  else if (e.code === 'Equal') k = '=';
  else if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join('+');
}

const BROWSER_KEYS = new Set(['Ctrl+=', 'Ctrl+-', 'Ctrl+0', 'Ctrl+Shift+=', 'Ctrl+Shift+-', 'F5', 'Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+P', 'Ctrl+F', 'Ctrl+U', 'Ctrl+J', 'Ctrl+H', 'F3', 'F7', 'Ctrl+Shift+J', 'Alt+ArrowLeft', 'Alt+ArrowRight', 'Ctrl+Shift+Delete']);

export function bindKeys() {
  // the desktop webview should feel like an app, not a browser
  window.addEventListener(
    'keydown',
    (e) => {
      if (BROWSER_KEYS.has(comboOf(e))) e.preventDefault();
    },
    true,
  );
  window.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) e.preventDefault();
  });
  window.addEventListener('keydown', (e) => {
    if (modalOpen() || isTyping()) return;
    const combo = comboOf(e);
    // tool-specific keys first (e.g. polyline Enter/Esc)
    if (tools[app.tool].key?.(e)) {
      e.preventDefault();
      return;
    }
    if (combo === 'Esc') {
      e.preventDefault();
      A.deselect();
      return;
    }
    if (combo === 'Backspace') return runCommand('edit.delete');
    const c = COMMANDS.find((x) => x.keys && (x.keys === combo || (combo === 'Ctrl+Shift+Z' && x.id === 'edit.redo')));
    if (c) {
      e.preventDefault();
      if (!c.enabled || c.enabled()) c.run();
      return;
    }
    if (combo === 'Ctrl+Shift+Z') return void (e.preventDefault(), A.redo());
    // arrows nudge
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key] && !e.ctrlKey) {
      e.preventDefault();
      const m = e.shiftKey ? 8 : 1;
      A.nudge(arrows[e.key][0] * m, arrows[e.key][1] * m);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // tools
    const t = TOOL_INFO.find((ti) => ti.key === combo);
    if (t) {
      if (t.id === 'shape' && app.tool === 'shape') {
        // pressing U again cycles shape kinds
        const kinds = ['rect', 'roundrect', 'ellipse', 'triangle', 'rtriangle', 'diamond', 'polygon', 'star', 'heart', 'arrow'] as const;
        app.opts.shapeKind = kinds[(kinds.indexOf(app.opts.shapeKind) + 1) % kinds.length];
        emit('tool');
      }
      A.switchTool(t.id as any);
      return;
    }
    if (combo === 'R' || combo === 'O') {
      app.opts.shapeKind = combo === 'R' ? 'rect' : 'ellipse';
      A.switchTool('shape');
      emit('tool');
      return;
    }
    if (combo === '[' || combo === ']') {
      const d = combo === ']' ? 1 : -1;
      if (app.tool === 'pencil' || app.tool === 'eraser') app.opts.brushSize = Math.max(1, Math.min(32, app.opts.brushSize + d));
      else app.opts.strokeWidth = Math.max(0, Math.min(32, app.opts.strokeWidth + d));
      emit('tool');
      A.persistSettingsSoon();
      return;
    }
    if (/^[0-9]$/.test(combo)) {
      // 1 = white … 9 = dark, 0 = black
      const n = combo === '0' ? 15 : Math.round(((+combo - 1) * 15) / 9);
      const p = patPaint(DENSITY[n]);
      if (app.slot === 'stroke') app.strokePaint = p;
      else app.fillPaint = p;
      emit('paint');
    }
  });
  // paste images from the system clipboard
  window.addEventListener('paste', (e) => {
    if (isTyping()) return;
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    if (!item) return;
    const f = item.getAsFile();
    if (!f) return;
    e.preventDefault();
    const r = new FileReader();
    r.onload = () => importImage(r.result as string, 'Pasted image');
    r.readAsDataURL(f);
  });
}
