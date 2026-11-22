import type { DocData, Component } from './types';

/** Run-length encode (value, count≤255) pairs — pixel art compresses extremely well. */
function rle(a: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < a.length) {
    const v = a[i];
    let n = 1;
    while (i + n < a.length && a[i + n] === v && n < 255) n++;
    out.push(v, n);
    i += n;
  }
  return Uint8Array.from(out);
}

function unrle(a: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i + 1 < a.length; i += 2) {
    out.fill(a[i], o, o + a[i + 1]);
    o += a[i + 1];
  }
  return out;
}

export function toB64(a: Uint8Array): string {
  let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const replacer = (_k: string, v: unknown) => {
  if (v instanceof Uint8Array) {
    const r = rle(v);
    return r.length < v.length ? { $rle: toB64(r), n: v.length } : { $u8: toB64(v) };
  }
  return v;
};

const reviver = (_k: string, v: any) => {
  if (v && typeof v === 'object') {
    if (typeof v.$rle === 'string') return unrle(fromB64(v.$rle), v.n);
    if (typeof v.$u8 === 'string') return fromB64(v.$u8);
  }
  return v;
};

export const FILE_VERSION = 1;

export interface FileDoc extends DocData {
  name?: string;
}

export function stringify(value: unknown, pretty = false): string {
  return JSON.stringify(value, replacer, pretty ? 1 : undefined);
}

export function parse<T = unknown>(s: string): T {
  return JSON.parse(s, reviver) as T;
}

export function serializeDoc(d: DocData): string {
  return stringify({ app: 'monobit', version: FILE_VERSION, doc: d });
}

export function deserializeDoc(s: string): DocData {
  const parsed = parse<any>(s);
  const d: DocData = parsed?.doc ?? parsed;
  if (!d || typeof d.width !== 'number' || !Array.isArray(d.objects)) throw new Error('Not a Monobit document');
  d.background ??= 'white';
  return d;
}

export function serializeLibrary(c: Component[]): string {
  return stringify({ app: 'monobit-library', version: FILE_VERSION, components: c });
}

export function deserializeLibrary(s: string): Component[] {
  const p = parse<any>(s);
  return Array.isArray(p?.components) ? p.components : [];
}
