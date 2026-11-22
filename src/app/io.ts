/**
 * Bridge to the Rust backend in the desktop app, and the web implementation of the same API.
 *
 * Web build: files go through the File System Access API where the browser has it (Chrome, Edge) so
 * Save writes back in place and Recent works; elsewhere it falls back to file inputs and downloads.
 * App data (settings, library, session) lives in IndexedDB.
 */
import { toB64 } from '../core/serialize';
import * as enc from '../core/encoders';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

// ------------------------------------------------------------ web: IndexedDB

const KV = 'kv';
const HANDLES = 'handles';
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('monobit', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(KV);
      r.result.createObjectStore(HANDLES);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function idb<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => res(req.result as T);
    tx.onerror = tx.onabort = () => rej(tx.error ?? req.error);
  });
}

// ------------------------------------------------------------ web: file handles

/** Browser has the File System Access API (real open/save dialogs and save-in-place). */
const hasFsa = !isTauri && typeof window !== 'undefined' && 'showSaveFilePicker' in window;
const WEB_PATH = /^web:([\w-]+)\//;

/** A "path" in the web build is `web:<handle id>/<file name>`; the handle itself lives in IndexedDB. */
async function rememberHandle(h: any): Promise<string> {
  const id = crypto.randomUUID();
  await idb(HANDLES, 'readwrite', (s) => s.put(h, id));
  return `web:${id}/${h.name}`;
}

async function handleFor(path: string, mode: 'read' | 'readwrite'): Promise<any> {
  const id = WEB_PATH.exec(path)?.[1];
  const h = id && (await idb<any>(HANDLES, 'readonly', (s) => s.get(id)));
  if (!h) throw new Error('file is no longer available');
  if ((await h.queryPermission({ mode })) !== 'granted' && (await h.requestPermission({ mode })) !== 'granted')
    throw new Error('permission denied');
  return h;
}

async function writeHandle(path: string, data: Blob) {
  const w = await (await handleFor(path, 'readwrite')).createWritable();
  await w.write(data);
  await w.close();
}

const isAbort = (e: any) => e?.name === 'AbortError';
const pickerTypes = (f: Filter, mime = 'application/octet-stream') => [{ description: f.name, accept: { [mime]: f.extensions.map((e) => '.' + e) } }];

/** Whether a document path can be reopened / saved back to later (vs. a one-shot download name). */
export const isPersistentPath = (path: string | null | undefined): path is string => !!path && (isTauri || WEB_PATH.test(path));

/** Forget stored web file handles that nothing refers to any more. */
export async function pruneHandles(keep: (string | null | undefined)[]) {
  if (isTauri) return;
  try {
    const ids = new Set(keep.map((p) => p && WEB_PATH.exec(p)?.[1]).filter(Boolean));
    const all = await idb<IDBValidKey[]>(HANDLES, 'readonly', (s) => s.getAllKeys());
    for (const k of all) if (!ids.has(k as string)) await idb(HANDLES, 'readwrite', (s) => s.delete(k));
  } catch {
    /* ignore */
  }
}

const readAs = (f: Blob, asText: boolean) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    if (asText) r.readAsText(f);
    else r.readAsDataURL(f);
  });

export interface Filter {
  name: string;
  extensions: string[];
}

export const DOC_FILTER: Filter = { name: 'Monobit Document', extensions: ['monobit'] };
export const IMAGE_FILTER: Filter = { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] };

export interface PickedFile {
  path: string | null;
  name: string;
  /** text contents (docs) */
  text?: string;
  /** data URL (images) */
  dataUrl?: string;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const mimeFor = (name: string) => {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'bmp' ? 'image/bmp' : ext === 'webp' ? 'image/webp' : 'image/png';
};

function browserPick(accept: string, asText: boolean): Promise<PickedFile | null> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return resolve(null);
      resolve({ path: null, name: f.name, [asText ? 'text' : 'dataUrl']: await readAs(f, asText) });
    };
    inp.click();
  });
}

const OPEN_DOC_FILTER: Filter = { name: 'Monobit Document or Library', extensions: ['monobit', 'json'] };

export async function pickOpen(kind: 'doc' | 'image'): Promise<PickedFile | null> {
  if (!isTauri) {
    if (!hasFsa) return browserPick(kind === 'doc' ? '.monobit,.json,application/json' : 'image/*', kind === 'doc');
    try {
      const types = kind === 'doc' ? pickerTypes(OPEN_DOC_FILTER) : [{ description: 'Images', accept: { 'image/*': IMAGE_FILTER.extensions.map((e) => '.' + e) } }];
      const [h] = await (window as any).showOpenFilePicker({ multiple: false, types, id: kind === 'doc' ? 'monobit-docs' : 'monobit-images' });
      const f: File = await h.getFile();
      // only documents get a reusable path (for Save and Recent); imported images are one-shot
      if (kind === 'image') return { path: null, name: f.name, dataUrl: await readAs(f, false) };
      return { path: await rememberHandle(h), name: f.name, text: await readAs(f, true) };
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const path = await open({ multiple: false, filters: [kind === 'doc' ? DOC_FILTER : IMAGE_FILTER] });
  if (!path || Array.isArray(path)) return null;
  return readPicked(path as string, kind);
}

export async function readPicked(path: string, kind: 'doc' | 'image'): Promise<PickedFile> {
  if (!isTauri) {
    const f: File = await (await handleFor(path, 'read')).getFile();
    return { path, name: f.name, [kind === 'doc' ? 'text' : 'dataUrl']: await readAs(f, kind === 'doc') };
  }
  if (kind === 'doc') return { path, name: baseName(path), text: await invoke<string>('read_text_file', { path }) };
  const b64 = await invoke<string>('read_binary_file', { path });
  return { path, name: baseName(path), dataUrl: `data:${mimeFor(path)};base64,${b64}` };
}

export async function pickSave(defaultName: string, filter: Filter): Promise<string | null> {
  if (!isTauri) {
    if (!hasFsa) return defaultName; // will be downloaded under this name
    try {
      const h = await (window as any).showSaveFilePicker({ suggestedName: defaultName, types: pickerTypes(filter), id: 'monobit-save' });
      return rememberHandle(h);
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
  }
  const { save } = await import('@tauri-apps/plugin-dialog');
  return (await save({ defaultPath: defaultName, filters: [filter] })) ?? null;
}

function download(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Writes to a web file handle path, or downloads when the path is just a file name. */
async function webWrite(path: string, data: Blob) {
  if (WEB_PATH.test(path)) await writeHandle(path, data);
  else download(baseName(path), data);
}

export async function writeText(path: string, contents: string) {
  if (!isTauri) return webWrite(path, new Blob([contents], { type: 'application/json' }));
  await invoke('write_text_file', { path, contents });
}

// app data store: IndexedDB in the browser (localStorage only as a last resort, e.g. private windows)

const LS = 'monobit:';

export async function storeRead(name: string): Promise<string | null> {
  if (!isTauri) {
    try {
      const v = await idb<string | undefined>(KV, 'readonly', (s) => s.get(name));
      if (v !== undefined) return v;
      // one-time move from the older localStorage-based web storage
      const legacy = localStorage.getItem(LS + name);
      if (legacy !== null) {
        await idb(KV, 'readwrite', (s) => s.put(legacy, name));
        localStorage.removeItem(LS + name);
      }
      return legacy;
    } catch {
      try {
        return localStorage.getItem(LS + name);
      } catch {
        return null;
      }
    }
  }
  return invoke<string | null>('store_read', { name });
}

export async function storeWrite(name: string, contents: string) {
  if (!isTauri) {
    try {
      await idb(KV, 'readwrite', (s) => s.put(contents, name));
    } catch {
      try {
        localStorage.setItem(LS + name, contents);
      } catch {
        /* quota */
      }
    }
    return;
  }
  await invoke('store_write', { name, contents });
}

export async function storeDelete(name: string) {
  if (!isTauri) {
    try {
      await idb(KV, 'readwrite', (s) => s.delete(name));
      localStorage.removeItem(LS + name);
    } catch {
      /* ignore */
    }
    return;
  }
  await invoke('store_delete', { name });
}

export async function launchFile(): Promise<string | null> {
  if (!isTauri) return null;
  return invoke<string | null>('launch_file');
}

/** Installed web app: `.monobit` files opened from the OS (manifest `file_handlers`). */
export function onLaunchFiles(open: (path: string) => void) {
  const lq = !isTauri && (window as any).launchQueue;
  if (!lq) return;
  lq.setConsumer(async (params: { files?: any[] }) => {
    for (const h of params.files ?? []) if (h.kind === 'file') open(await rememberHandle(h));
  });
}

export type ExportFormat = 'png' | 'bmp' | 'pbm' | 'h' | 'xbm';
export const EXPORT_FORMATS: { id: ExportFormat; label: string; ext: string; desc: string; scalable: boolean }[] = [
  { id: 'png', label: 'PNG', ext: 'png', desc: 'True 1-bit PNG (2-bit indexed if transparent)', scalable: true },
  { id: 'bmp', label: 'BMP', ext: 'bmp', desc: 'Monochrome 1bpp bitmap', scalable: true },
  { id: 'pbm', label: 'PBM', ext: 'pbm', desc: 'Netpbm portable bitmap', scalable: true },
  { id: 'h', label: 'C Header', ext: 'h', desc: 'Byte array for Arduino / Adafruit GFX / u8g2', scalable: false },
  { id: 'xbm', label: 'XBM', ext: 'xbm', desc: 'X11 bitmap source', scalable: false },
];

export interface RasterOut {
  width: number;
  height: number;
  pixels: Uint8Array;
}

function rasterToCanvas(r: RasterOut, scale: number) {
  const c = document.createElement('canvas');
  c.width = r.width * scale;
  c.height = r.height * scale;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(r.width, r.height);
  for (let i = 0; i < r.pixels.length; i++) {
    const v = r.pixels[i];
    const col = v === 1 ? 0 : 255;
    img.data.set([col, col, col, v === 0 ? 0 : 255], i * 4);
  }
  const t = document.createElement('canvas');
  t.width = r.width;
  t.height = r.height;
  t.getContext('2d')!.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(t, 0, 0, c.width, c.height);
  return c;
}

const EXPORT_MIME: Record<ExportFormat, string> = { png: 'image/png', bmp: 'image/bmp', pbm: 'image/x-portable-bitmap', h: 'text/x-c', xbm: 'image/x-xbitmap' };

async function encodeWeb(format: ExportFormat, r: RasterOut, scale: number, name: string): Promise<Uint8Array | string> {
  const px: enc.Pixels = { w: r.width, h: r.height, data: r.pixels };
  if (px.w === 0 || px.h === 0 || px.data.length !== px.w * px.h) throw new Error(`raster size mismatch (${px.w}x${px.h} vs ${px.data.length} bytes)`);
  switch (format) {
    case 'png':
      return enc.encodePng(enc.scaled(px, scale));
    case 'bmp':
      return enc.encodeBmp(enc.scaled(px, scale));
    case 'pbm':
      return enc.encodePbm(enc.scaled(px, scale));
    case 'h':
      return enc.encodeCHeader(px, name);
    case 'xbm':
      return enc.encodeXbm(px, name);
  }
}

export async function exportImage(path: string, format: ExportFormat, r: RasterOut, scale: number, name: string): Promise<number> {
  if (!isTauri) {
    const out = await encodeWeb(format, r, scale, name);
    const blob = new Blob([out as BlobPart], { type: EXPORT_MIME[format] });
    await webWrite(path, blob);
    return blob.size;
  }
  return invoke<number>('export_image', {
    path,
    format,
    raster: { width: r.width, height: r.height, pixels: toB64(r.pixels) },
    scale,
    name,
  });
}

export async function copyImage(r: RasterOut, scale: number) {
  if (isTauri) {
    await invoke('copy_image', { raster: { width: r.width, height: r.height, pixels: toB64(r.pixels) }, scale });
    return;
  }
  const c = rasterToCanvas(r, scale);
  const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'));
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

export async function exportText(format: 'h' | 'xbm', r: RasterOut, name: string): Promise<string> {
  if (!isTauri) return (await encodeWeb(format, r, 1, name)) as string;
  return invoke<string>('export_text', { format, raster: { width: r.width, height: r.height, pixels: toB64(r.pixels) }, name });
}

// ------------------------------------------------------------ window controls

export async function windowAction(a: 'minimize' | 'maximize' | 'close') {
  if (!isTauri) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const w = getCurrentWindow();
  if (a === 'minimize') await w.minimize();
  else if (a === 'maximize') await w.toggleMaximize();
  else await w.destroy();
}

export async function setWindowTitle(t: string) {
  document.title = t;
  if (!isTauri) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow()
    .setTitle(t)
    .catch(() => {});
}

let zoomApplied = 1;
/** Snap the webview zoom so CSS pixels land on whole device pixels (crisp pixel UI on 125%/150% displays). */
export async function applyCrispZoom(enabled: boolean) {
  const base = window.devicePixelRatio / zoomApplied;
  const target = enabled ? Math.max(1, Math.round(base)) / base : 1;
  if (Math.abs(target - zoomApplied) < 0.001) return;
  if (isTauri) {
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      await getCurrentWebview().setZoom(target);
      zoomApplied = target;
    } catch {
      /* not supported */
    }
  }
}
