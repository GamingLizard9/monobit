import { app, emit, EditorDoc, addDoc, setActiveDoc, setSelection, newDocData, setTool, type ToolId } from './state';
import * as io from './io';
import { serializeDoc, deserializeDoc, serializeLibrary, deserializeLibrary, stringify, parse } from '../core/serialize';
import { composite, composeObjects, objBounds, objExtent, clearRenderCache } from '../core/render';
import { locate, cloneFresh, moveObj, flipObj, newGroup, newBitmap, nextRev, trimBitmap, uid, defaultFx } from '../core/doc';
import { rectUnion } from '../core/raster';
import { builtinComponents, BUILTIN_VERSION } from '../core/builtins';
import { BLACK, WHITE } from '../core/patterns';
import type { Obj, Component, Rect, GroupObj, Background, DocData, ImageObj } from '../core/types';
import { toast, promptText, confirmBox } from '../ui/overlay';
import { viewport } from '../editor/viewport';
import { tools, insertObj } from '../editor/tools';

const D = () => app.active;

// ------------------------------------------------------------ documents

let untitled = 1;
export function createDoc(w: number, h: number, bg: Background = 'white', name?: string) {
  const d = new EditorDoc(name ?? `Untitled ${untitled++}`, newDocData(w, h, bg));
  addDoc(d);
  requestAnimationFrame(() => viewport.fit());
  return d;
}

export async function openDocFromText(text: string, name: string, path: string | null) {
  try {
    const data = deserializeDoc(text);
    const existing = path && app.docs.find((d) => d.path === path);
    if (existing) {
      setActiveDoc(existing);
      return;
    }
    const d = new EditorDoc(name.replace(/\.monobit$/i, ''), data);
    d.path = path;
    // replace a pristine empty untitled tab
    const a = D();
    if (a && !a.dirty && !a.path && a.data.objects.length === 0 && a.kind === 'image') closeDocNow(a);
    addDoc(d);
    if (io.isPersistentPath(path)) addRecent(path);
    requestAnimationFrame(() => viewport.fit());
    toast(`Opened ${name}`);
  } catch (e: any) {
    toast(`Could not open ${name}: ${e?.message ?? e}`, { kind: 'error' });
  }
}

export async function openDoc() {
  const f = await io.pickOpen('doc');
  if (f?.text) await openDocFromText(f.text, f.name, f.path);
}

export async function openRecent(path: string) {
  try {
    const f = await io.readPicked(path, 'doc');
    await openDocFromText(f.text!, f.name, path);
  } catch (e: any) {
    app.settings.recent = app.settings.recent.filter((p) => p !== path);
    emit('settings');
    toast(`Could not open: ${e?.message ?? e}`, { kind: 'error' });
  }
}

function addRecent(path: string) {
  app.settings.recent = [path, ...app.settings.recent.filter((p) => p !== path)].slice(0, 10);
  emit('settings');
}

export async function saveDoc(d = D(), saveAs = false): Promise<boolean> {
  if (!d) return false;
  if (d.kind === 'component') return saveComponentDoc(d);
  let path = d.path;
  if (!path || saveAs) {
    path = await io.pickSave(`${d.name}.monobit`, io.DOC_FILTER);
    if (!path) return false;
  }
  try {
    await io.writeText(path, serializeDoc(d.data));
    d.path = io.isPersistentPath(path) ? path : null;
    d.name = path.split(/[\\/]/).pop()!.replace(/\.monobit$/i, '');
    d.dirty = false;
    if (d.path) addRecent(d.path);
    emit('tabs');
    toast(`Saved ${d.name}`);
    return true;
  } catch (e: any) {
    toast(`Save failed: ${e?.message ?? e}`, { kind: 'error' });
    return false;
  }
}

function closeDocNow(d: EditorDoc) {
  const i = app.docs.indexOf(d);
  if (i < 0) return;
  app.docs.splice(i, 1);
  if (app.active === d) setActiveDoc(app.docs[Math.min(i, app.docs.length - 1)] ?? null);
  else emit('tabs');
}

export async function closeDoc(d = D()) {
  if (!d) return;
  if (d.dirty && (d.data.objects.length || d.path)) {
    const r = await confirmBox('Close', `Save changes to “${d.name}” before closing?`, [
      { label: 'Cancel', value: 'cancel' },
      { label: "Don't Save", value: 'discard', danger: true },
      { label: 'Save', value: 'save', primary: true },
    ]);
    if (r === 'cancel') return;
    if (r === 'save' && !(await saveDoc(d))) return;
  }
  closeDocNow(d);
}

// ------------------------------------------------------------ history

export function undo() {
  const d = D();
  if (!d) return;
  tools[app.tool].cancel?.();
  const label = d.history.undoLabel;
  d.restore(d.history.undo());
  if (label) toast(`Undo ${label}`, { ms: 1200 });
}

export function redo() {
  const d = D();
  if (!d) return;
  const label = d.history.redoLabel;
  d.restore(d.history.redo());
  if (label) toast(`Redo ${label}`, { ms: 1200 });
}

// ------------------------------------------------------------ selection & clipboard

export function selectAll() {
  const d = D();
  if (!d) return;
  setSelection(d.scopeList.filter((o) => o.visible && !o.locked).map((o) => o.id));
}

export function deselect() {
  const d = D();
  if (!d) return;
  if (d.selection.length) setSelection([]);
  else if (d.scope) exitScope();
}

export function exitScope() {
  const d = D();
  if (!d || !d.scope) return;
  const prev = d.scope;
  d.scope = locate(d.data.objects, prev)?.parent?.id ?? null;
  setSelection([prev]);
  emit('doc');
}

export function enterGroup(g?: GroupObj) {
  const d = D();
  if (!d) return;
  const target = g ?? (d.selected()[0] as GroupObj | undefined);
  if (!target || target.type !== 'group') return;
  d.scope = target.id;
  target.expanded = true;
  setSelection([]);
  emit('doc');
  toast(`Editing “${target.name}” — Esc to exit`);
}

/** Selected objects in document order. */
function orderedSelection(): Obj[] {
  const d = D()!;
  const set = new Set(d.selection);
  const out: Obj[] = [];
  const rec = (l: Obj[]) =>
    l.forEach((o) => {
      if (set.has(o.id)) out.push(o);
      else if (o.type === 'group') rec(o.children);
    });
  rec(d.data.objects);
  return out;
}

export function copy() {
  const sel = D() ? orderedSelection() : [];
  if (!sel.length) return false;
  app.clipboard = sel.map((o) => structuredClone(o));
  toast(`Copied ${sel.length} object${sel.length > 1 ? 's' : ''}`, { ms: 1200 });
  return true;
}

export function cut() {
  if (copy()) deleteSelection('Cut');
}

export function paste() {
  const d = D();
  if (!d || !app.clipboard.length) return;
  const copies = app.clipboard.map((o) => cloneFresh(o));
  // offset if pasting on top of the originals
  const ids = new Set<string>();
  const rec = (l: Obj[]) => l.forEach((o) => (ids.add(o.id), o.type === 'group' && rec(o.children)));
  rec(d.data.objects);
  const overlapping = app.clipboard.some((o) => ids.has(o.id));
  if (overlapping) copies.forEach((c) => moveObj(c, 4, 4));
  app.clipboard = copies.map((c) => structuredClone(c));
  const list = d.scopeList;
  list.push(...copies);
  d.selection = copies.map((c) => c.id);
  d.commit('Paste');
  emit('selection');
}

export function duplicate() {
  const d = D();
  if (!d) return;
  const sel = orderedSelection();
  if (!sel.length) return;
  const copies: Obj[] = [];
  for (const o of sel) {
    const l = locate(d.data.objects, o.id)!;
    const c = cloneFresh(o);
    moveObj(c, 4, 4);
    l.list.splice(l.index + 1 + copies.filter((x) => l.list.includes(x)).length, 0, c);
    copies.push(c);
  }
  d.selection = copies.map((c) => c.id);
  d.commit('Duplicate');
  emit('selection');
}

export function deleteSelection(label = 'Delete') {
  const d = D();
  if (!d || !d.selection.length) return;
  for (const id of d.selection) {
    const l = locate(d.data.objects, id);
    if (l) l.list.splice(l.index, 1);
  }
  d.selection = [];
  d.commit(label);
  emit('selection');
}

export function nudge(dx: number, dy: number) {
  const d = D();
  if (!d) return;
  const sel = d.selected().filter((o) => !o.locked);
  if (!sel.length) return;
  sel.forEach((o) => moveObj(o, dx, dy));
  d.commit('Nudge', 'nudge');
}

// ------------------------------------------------------------ arrange

export function group() {
  const d = D();
  if (!d) return;
  const sel = orderedSelection();
  if (sel.length < 1) return;
  const first = locate(d.data.objects, sel[0].id)!;
  const list = first.list;
  const inSame = sel.every((o) => list.includes(o));
  if (!inSame) return toast('Objects must share the same parent to group', { kind: 'error' });
  const idx = Math.max(...sel.map((o) => list.indexOf(o)));
  const g = newGroup(sel, `Group`);
  for (const o of sel) list.splice(list.indexOf(o), 1);
  list.splice(idx - sel.length + 1, 0, g);
  d.selection = [g.id];
  d.commit('Group');
  emit('selection');
}

export function ungroup() {
  const d = D();
  if (!d) return;
  const groups = d.selected().filter((o): o is GroupObj => o.type === 'group');
  if (!groups.length) return;
  const newSel: string[] = [];
  for (const g of groups) {
    const l = locate(d.data.objects, g.id)!;
    // group-level effects are pushed down so the look is preserved
    const fx = g.fx;
    const kids = g.children;
    if (fx.shadow.on || fx.outline.on) for (const k of kids) if (!k.fx.shadow.on && !k.fx.outline.on) k.fx = structuredClone(fx);
    l.list.splice(l.index, 1, ...kids);
    newSel.push(...kids.map((k) => k.id));
    if (d.scope === g.id) d.scope = null;
  }
  d.selection = newSel;
  d.commit('Ungroup');
  emit('selection');
}

export function arrange(mode: 'front' | 'forward' | 'backward' | 'back') {
  const d = D();
  if (!d) return;
  const sel = orderedSelection();
  if (!sel.length) return;
  const byList = new Map<Obj[], Obj[]>();
  for (const o of sel) {
    const l = locate(d.data.objects, o.id)!;
    if (!byList.has(l.list)) byList.set(l.list, []);
    byList.get(l.list)!.push(o);
  }
  for (const [list, objs] of byList) {
    if (mode === 'front' || mode === 'back') {
      for (const o of objs) list.splice(list.indexOf(o), 1);
      if (mode === 'front') list.push(...objs);
      else list.unshift(...objs);
    } else if (mode === 'forward') {
      for (let i = objs.length - 1; i >= 0; i--) {
        const k = list.indexOf(objs[i]);
        if (k < list.length - 1 && !objs.includes(list[k + 1])) [list[k], list[k + 1]] = [list[k + 1], list[k]];
      }
    } else {
      for (const o of objs) {
        const k = list.indexOf(o);
        if (k > 0 && !objs.includes(list[k - 1])) [list[k], list[k - 1]] = [list[k - 1], list[k]];
      }
    }
  }
  d.commit({ front: 'Bring to front', forward: 'Bring forward', backward: 'Send backward', back: 'Send to back' }[mode]);
}

export function moveInList(id: string, targetId: string, where: 'before' | 'after' | 'inside') {
  const d = D();
  if (!d || id === targetId) return;
  const src = locate(d.data.objects, id);
  const dst = locate(d.data.objects, targetId);
  if (!src || !dst) return;
  // no dropping a group into itself
  if (src.obj.type === 'group' && locate(src.obj.children, targetId)) return;
  src.list.splice(src.index, 1);
  if (where === 'inside' && dst.obj.type === 'group') {
    dst.obj.children.push(src.obj);
    dst.obj.expanded = true;
  } else {
    const l = locate(d.data.objects, targetId)!;
    // layer panel lists top-most first: "before" in the panel = above = later in the array
    l.list.splice(where === 'before' ? l.index + 1 : l.index, 0, src.obj);
  }
  d.commit('Reorder');
}

export function flip(axis: 'x' | 'y') {
  const d = D();
  if (!d) return;
  const sel = d.selected().filter((o) => !o.locked);
  if (!sel.length) return;
  let r: Rect | null = null;
  for (const o of sel) r = rectUnion(r, objBounds(o));
  if (!r) return;
  const c2 = axis === 'x' ? r.x * 2 + r.w : r.y * 2 + r.h;
  sel.forEach((o) => flipObj(o, axis, c2));
  d.commit(axis === 'x' ? 'Flip horizontal' : 'Flip vertical');
}

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export function align(mode: AlignMode) {
  const d = D();
  if (!d) return;
  const sel = d.selected().filter((o) => !o.locked);
  if (!sel.length) return;
  let ref: Rect | null = null;
  if (sel.length === 1) ref = { x: 0, y: 0, w: d.data.width, h: d.data.height };
  else for (const o of sel) ref = rectUnion(ref, objBounds(o));
  if (!ref) return;
  for (const o of sel) {
    const b = objBounds(o);
    if (!b) continue;
    let dx = 0,
      dy = 0;
    if (mode === 'left') dx = ref.x - b.x;
    if (mode === 'right') dx = ref.x + ref.w - (b.x + b.w);
    if (mode === 'hcenter') dx = Math.round(ref.x + ref.w / 2 - (b.x + b.w / 2));
    if (mode === 'top') dy = ref.y - b.y;
    if (mode === 'bottom') dy = ref.y + ref.h - (b.y + b.h);
    if (mode === 'vcenter') dy = Math.round(ref.y + ref.h / 2 - (b.y + b.h / 2));
    moveObj(o, dx, dy);
  }
  d.commit('Align');
}

export function distribute(axis: 'x' | 'y') {
  const d = D();
  if (!d) return;
  const sel = d.selected().filter((o) => !o.locked);
  if (sel.length < 3) return toast('Select 3 or more objects to distribute');
  const items = sel.map((o) => ({ o, b: objBounds(o)! })).filter((i) => i.b);
  items.sort((a, b) => (axis === 'x' ? a.b.x - b.b.x : a.b.y - b.b.y));
  const first = items[0].b,
    last = items[items.length - 1].b;
  const total = items.reduce((s, i) => s + (axis === 'x' ? i.b.w : i.b.h), 0);
  const span = axis === 'x' ? last.x + last.w - first.x : last.y + last.h - first.y;
  const gap = (span - total) / (items.length - 1);
  let pos = axis === 'x' ? first.x : first.y;
  for (const it of items) {
    const cur = axis === 'x' ? it.b.x : it.b.y;
    const t = Math.round(pos);
    if (axis === 'x') moveObj(it.o, t - cur, 0);
    else moveObj(it.o, 0, t - cur);
    pos += (axis === 'x' ? it.b.w : it.b.h) + gap;
  }
  d.commit('Distribute');
}

export function toggleLock(o?: Obj) {
  const d = D();
  if (!d) return;
  const targets = o ? [o] : d.selected();
  const v = !targets.every((t) => t.locked);
  targets.forEach((t) => (t.locked = v));
  if (v) d.selection = d.selection.filter((id) => !targets.some((t) => t.id === id));
  d.commit(v ? 'Lock' : 'Unlock');
  emit('selection');
}

export function toggleVisible(o?: Obj) {
  const d = D();
  if (!d) return;
  const targets = o ? [o] : d.selected();
  const v = !targets.every((t) => t.visible);
  targets.forEach((t) => (t.visible = v));
  d.commit(v ? 'Show' : 'Hide');
}

export function rasterize() {
  const d = D();
  if (!d) return;
  const sel = orderedSelection();
  if (!sel.length) return;
  const buf = composeObjects(sel);
  if (!buf) return;
  const l = locate(d.data.objects, sel[sel.length - 1].id)!;
  const bm = newBitmap(buf.x, buf.y, buf.w, buf.h, sel.length === 1 ? `${sel[0].name} (pixels)` : 'Rasterized');
  bm.data = buf.data;
  bm.rev = nextRev();
  l.list.splice(l.index + 1, 0, bm);
  for (const o of sel) {
    const k = locate(d.data.objects, o.id);
    if (k) k.list.splice(k.index, 1);
  }
  d.selection = [bm.id];
  d.commit('Rasterize');
  emit('selection');
}

export function mergeDown() {
  const d = D();
  if (!d) return;
  const sel = d.selected();
  if (sel.length !== 1) return;
  const l = locate(d.data.objects, sel[0].id)!;
  if (l.index === 0) return;
  const below = l.list[l.index - 1];
  d.selection = [below.id, sel[0].id];
  rasterize();
}

export function trimLayer() {
  const d = D();
  const o = d?.selected()[0];
  if (o?.type !== 'bitmap') return;
  trimBitmap(o);
  d!.commit('Trim layer');
}

// ------------------------------------------------------------ canvas

export function setBackground(bg: Background) {
  const d = D();
  if (!d) return;
  d.data.background = bg;
  d.commit('Background');
}

export function resizeCanvas(w: number, h: number, anchor: [number, number]) {
  const d = D();
  if (!d) return;
  const dx = Math.round((w - d.data.width) * anchor[0]),
    dy = Math.round((h - d.data.height) * anchor[1]);
  d.data.objects.forEach((o) => moveObj(o, dx, dy));
  d.data.width = w;
  d.data.height = h;
  d.commit('Canvas size');
  requestAnimationFrame(() => viewport.fit());
}

export function cropTo(r: Rect) {
  const d = D();
  if (!d) return;
  r = { x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)) };
  d.data.objects.forEach((o) => moveObj(o, -r.x, -r.y));
  d.data.width = r.w;
  d.data.height = r.h;
  d.commit('Crop');
  requestAnimationFrame(() => viewport.fit());
}

export function cropToSelection() {
  const d = D();
  if (!d) return;
  let r: Rect | null = null;
  for (const o of d.selected()) r = rectUnion(r, objExtent(o));
  if (!r) return toast('Select something to crop to');
  cropTo(r);
}

export function trimCanvas() {
  const d = D();
  if (!d) return;
  const px = composite(d.data, { background: false });
  const W = d.data.width;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -1,
    y1 = -1;
  for (let i = 0; i < px.length; i++)
    if (px[i] === 1 || (px[i] === 2 && d.data.background !== 'white')) {
      const x = i % W,
        y = (i - x) / W;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  if (x1 < 0) return toast('Nothing to trim');
  cropTo({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
}

export function flattenAll() {
  const d = D();
  if (!d || !d.data.objects.length) return;
  const px = composite(d.data, { background: false });
  const bm = newBitmap(0, 0, d.data.width, d.data.height, 'Flattened');
  bm.data = px;
  d.data.objects = [bm];
  d.selection = [bm.id];
  d.scope = null;
  d.commit('Flatten');
  emit('selection');
}

// ------------------------------------------------------------ paints

export function swapPaints() {
  [app.strokePaint, app.fillPaint] = [app.fillPaint, app.strokePaint];
  emit('paint');
}

export function defaultPaints() {
  app.strokePaint = BLACK();
  app.fillPaint = WHITE();
  emit('paint');
}

// ------------------------------------------------------------ export

export function rasterOut(d = D()): io.RasterOut | null {
  if (!d) return null;
  return { width: d.data.width, height: d.data.height, pixels: composite(d.data) };
}

export async function copyImageToClipboard() {
  const r = rasterOut();
  if (!r) return;
  try {
    await io.copyImage(r, 1);
    toast('Image copied to clipboard');
  } catch (e: any) {
    toast(`Copy failed: ${e?.message ?? e}`, { kind: 'error' });
  }
}

// ------------------------------------------------------------ image import

export function insertImage(src: { w: number; h: number; data: Uint8Array }, name: string, opts: Partial<ImageObj> = {}) {
  const d = D();
  if (!d) return;
  const maxW = d.data.width,
    maxH = d.data.height;
  const s = Math.min(1, maxW / src.w, maxH / src.h);
  const w = Math.max(1, Math.round(src.w * s)),
    h = Math.max(1, Math.round(src.h * s));
  const o: ImageObj = {
    id: uid(),
    name,
    visible: true,
    locked: false,
    blend: 'normal',
    fx: defaultFx(),
    type: 'image',
    x: Math.round((maxW - w) / 2),
    y: Math.round((maxH - h) / 2),
    w,
    h,
    src,
    algo: 'atkinson',
    brightness: 0,
    contrast: 0,
    gamma: 1,
    invert: false,
    knockout: false,
    rev: nextRev(),
    ...opts,
  };
  insertObj(o);
  d.commit('Import image');
  setTool('select');
}

// ------------------------------------------------------------ components / library

export async function saveLibrary() {
  await io.storeWrite('library.json', serializeLibrary(app.library));
}

export async function loadLibrary() {
  let raw: string | null = null;
  try {
    raw = await io.storeRead('library.json');
  } catch {
    raw = null;
  }
  if (raw) {
    try {
      app.library = deserializeLibrary(raw);
    } catch {
      app.library = builtinComponents();
    }
    // refresh the built-in presets when they've been improved (user components are untouched)
    if ((app.settings.builtinVersion ?? 1) < BUILTIN_VERSION) {
      const fresh = builtinComponents();
      app.library = app.library.map((c) => fresh.find((f) => f.id === c.id) ?? c);
      for (const f of fresh) if (!app.library.some((c) => c.id === f.id)) app.library.push(f);
      app.settings.builtinVersion = BUILTIN_VERSION;
      persistSettingsSoon();
      await saveLibrary();
    }
  } else {
    app.settings.builtinVersion = BUILTIN_VERSION;
    persistSettingsSoon();
    app.library = builtinComponents();
    await saveLibrary();
  }
  emit('library');
}

export function libraryAdd(c: Component) {
  app.library.unshift(c);
  emit('library');
  saveLibrary();
}

export async function makeComponent() {
  const d = D();
  if (!d) return;
  const sel = orderedSelection();
  if (!sel.length) return toast('Select objects to turn into a component');
  const suggested = sel.length === 1 ? sel[0].name : 'Component';
  const name = await promptText('New Component', 'Component name', suggested, 'Create');
  if (!name) return;
  const objs = sel.map((o) => structuredClone(o));
  const b = composeObjects(objs);
  const c: Component = { id: 'c' + uid(), name, created: Date.now(), width: b?.w ?? 0, height: b?.h ?? 0, objects: objs };
  libraryAdd(c);
  // replace the selection with a linked instance
  const first = locate(d.data.objects, sel[sel.length - 1].id)!;
  const list = first.list;
  if (sel.every((o) => list.includes(o))) {
    const idx = Math.max(...sel.map((o) => list.indexOf(o)));
    const g = newGroup(sel, name);
    g.componentId = c.id;
    for (const o of sel) list.splice(list.indexOf(o), 1);
    list.splice(idx - sel.length + 1, 0, g);
    d.selection = [g.id];
    d.commit('Create component');
    emit('selection');
  }
  toast(`Component “${name}” added to library`);
}

function componentBounds(c: Component): Rect | null {
  let r: Rect | null = null;
  for (const o of c.objects) r = rectUnion(r, objExtent(o));
  return r;
}

export function instantiate(c: Component, cx?: number, cy?: number): GroupObj | null {
  const d = D();
  if (!d) return null;
  const kids = c.objects.map((o) => cloneFresh(o));
  const g = newGroup(kids, c.name);
  g.componentId = c.id;
  const b = objExtent(g) ?? componentBounds(c);
  if (b) {
    const tx = cx ?? Math.round(d.data.width / 2),
      ty = cy ?? Math.round(d.data.height / 2);
    moveObj(g, Math.round(tx - b.x - b.w / 2), Math.round(ty - b.y - b.h / 2));
  }
  insertObj(g);
  d.commit(`Insert ${c.name}`);
  setTool('select');
  return g;
}

export function insertComponentById(id: string, x?: number, y?: number) {
  const c = app.library.find((k) => k.id === id);
  if (c) instantiate(c, x, y);
}

/** Replace an instance's children with the library master, keeping its position. */
export function syncInstance(g: GroupObj, label = true) {
  const c = app.library.find((k) => k.id === g.componentId);
  if (!c) return false;
  const old = objExtent(g);
  const kids = c.objects.map((o) => cloneFresh(o));
  const tmp = newGroup(kids);
  const nb = objExtent(tmp);
  if (old && nb) kids.forEach((k) => moveObj(k, old.x - nb.x, old.y - nb.y));
  g.children = kids;
  if (label) D()?.commit('Reset to component');
  return true;
}

export function detachInstance(g: GroupObj) {
  delete g.componentId;
  D()?.commit('Detach component');
  emit('selection');
}

export async function renameComponent(c: Component) {
  const n = await promptText('Rename Component', 'Name', c.name, 'Rename');
  if (!n) return;
  c.name = n;
  emit('library');
  saveLibrary();
}

export async function deleteComponent(c: Component) {
  const r = await confirmBox('Delete Component', `Remove “${c.name}” from the library? Placed copies stay in your images.`, [
    { label: 'Cancel', value: 'cancel' },
    { label: 'Delete', value: 'delete', danger: true, primary: true },
  ]);
  if (r !== 'delete') return;
  app.library = app.library.filter((k) => k !== c);
  emit('library');
  saveLibrary();
}

export function editComponent(c: Component) {
  const existing = app.docs.find((d) => d.kind === 'component' && d.componentId === c.id);
  if (existing) return setActiveDoc(existing);
  const objs = c.objects.map((o) => structuredClone(o));
  const g = newGroup(objs);
  const b = objExtent(g) ?? { x: 0, y: 0, w: 32, h: 32 };
  const pad = 8;
  objs.forEach((o) => moveObj(o, pad - b.x, pad - b.y));
  const d = new EditorDoc(`◆ ${c.name}`, { width: b.w + pad * 2, height: b.h + pad * 2, background: 'transparent', objects: objs });
  d.kind = 'component';
  d.componentId = c.id;
  addDoc(d);
  requestAnimationFrame(() => viewport.fit());
  toast('Editing component — Save (Ctrl+S) updates the library');
}

async function saveComponentDoc(d: EditorDoc): Promise<boolean> {
  const c = app.library.find((k) => k.id === d.componentId);
  if (!c) {
    toast('This component no longer exists in the library', { kind: 'error' });
    return false;
  }
  c.objects = d.data.objects.map((o) => structuredClone(o));
  const b = composeObjects(c.objects);
  c.width = b?.w ?? 0;
  c.height = b?.h ?? 0;
  d.dirty = false;
  emit('library', 'tabs');
  await saveLibrary();
  const instances: { doc: EditorDoc; g: GroupObj }[] = [];
  for (const doc of app.docs)
    if (doc.kind === 'image') {
      const rec = (l: Obj[]) =>
        l.forEach((o) => {
          if (o.type === 'group') {
            if (o.componentId === c.id) instances.push({ doc, g: o });
            rec(o.children);
          }
        });
      rec(doc.data.objects);
    }
  if (instances.length)
    toast(`Saved “${c.name}”. ${instances.length} placed cop${instances.length > 1 ? 'ies' : 'y'} in open images.`, {
      action: {
        label: 'Update all',
        run: () => {
          const touched = new Set<EditorDoc>();
          for (const { doc, g } of instances) {
            const prev = app.active;
            app.active = doc;
            syncInstance(g, false);
            app.active = prev;
            touched.add(doc);
          }
          touched.forEach((t) => t.commit('Update component'));
          clearRenderCache();
          emit('doc');
        },
      },
    });
  else toast(`Saved component “${c.name}”`);
  return true;
}

export async function exportLibrary() {
  const path = await io.pickSave('monobit-library.json', { name: 'Monobit Library', extensions: ['json'] });
  if (!path) return;
  await io.writeText(path, serializeLibrary(app.library));
  toast('Library exported');
}

export async function importLibrary() {
  const f = await io.pickOpen('doc');
  if (!f?.text) return;
  try {
    const comps = deserializeLibrary(f.text);
    if (!comps.length) throw new Error('no components found');
    let n = 0;
    for (const c of comps) if (!app.library.some((k) => k.id === c.id)) (app.library.push(c), n++);
    emit('library');
    saveLibrary();
    toast(`Imported ${n} component${n === 1 ? '' : 's'}`);
  } catch (e: any) {
    toast(`Import failed: ${e?.message ?? e}`, { kind: 'error' });
  }
}

// ------------------------------------------------------------ persistence: settings & session

let settingsTimer = 0;
export function persistSettingsSoon() {
  clearTimeout(settingsTimer);
  settingsTimer = window.setTimeout(() => io.storeWrite('settings.json', JSON.stringify(app.settings)), 400);
}

export async function loadSettings() {
  try {
    const raw = await io.storeRead('settings.json');
    if (raw) {
      const s = JSON.parse(raw);
      app.settings = { ...app.settings, ...s, tool: { ...app.settings.tool, ...(s.tool ?? {}) } };
    }
  } catch {
    /* defaults */
  }
}

interface SessionDoc {
  name: string;
  path: string | null;
  dirty: boolean;
  kind: 'image' | 'component';
  componentId?: string;
  data: DocData;
  view: EditorDoc['view'];
}

let sessionTimer = 0;
export function persistSessionSoon() {
  clearTimeout(sessionTimer);
  sessionTimer = window.setTimeout(saveSession, 1500);
}

export function saveSession() {
  const docs: SessionDoc[] = app.docs.map((d) => ({ name: d.name, path: d.path, dirty: d.dirty, kind: d.kind, componentId: d.componentId, data: d.data, view: d.view }));
  const s = stringify({ active: app.active ? app.docs.indexOf(app.active) : 0, docs, paints: { s: app.strokePaint, f: app.fillPaint, so: app.strokeOn, fo: app.fillOn } });
  return io.storeWrite('session.json', s);
}

export async function restoreSession(): Promise<boolean> {
  try {
    const raw = await io.storeRead('session.json');
    if (!raw) return false;
    const s = parse<any>(raw);
    if (s.paints) {
      app.strokePaint = s.paints.s ?? app.strokePaint;
      app.fillPaint = s.paints.f ?? app.fillPaint;
      app.strokeOn = s.paints.so ?? true;
      app.fillOn = s.paints.fo ?? true;
    }
    const docs: SessionDoc[] = s.docs ?? [];
    for (const sd of docs) {
      const d = new EditorDoc(sd.name, sd.data);
      d.path = sd.path;
      d.dirty = sd.dirty;
      d.kind = sd.kind ?? 'image';
      d.componentId = sd.componentId;
      d.view = sd.view ?? d.view;
      app.docs.push(d);
    }
    if (!app.docs.length) return false;
    const m = Math.max(0, ...app.docs.map((d) => +(d.name.match(/^Untitled (\d+)$/)?.[1] ?? 0)));
    untitled = m + 1;
    setActiveDoc(app.docs[Math.min(app.docs.length - 1, s.active ?? 0)]);
    return true;
  } catch {
    return false;
  }
}

export function switchTool(t: ToolId) {
  tools[app.tool].cancel?.();
  setTool(t);
}
