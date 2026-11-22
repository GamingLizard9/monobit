import type { DocData, Obj, Paint, ShapeKind, StrokeStyle, Component, Background, GroupObj, Pat, TextAlign } from '../core/types';
import { uid, locate } from '../core/doc';
import { BLACK, WHITE } from '../core/patterns';

// ------------------------------------------------------------ event bus

export type EventName = 'render' | 'doc' | 'selection' | 'tool' | 'paint' | 'view' | 'tabs' | 'library' | 'settings' | 'history' | 'cursor';
const listeners = new Map<EventName, Set<() => void>>();
export function on(evt: EventName, cb: () => void) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt)!.add(cb);
  return () => listeners.get(evt)!.delete(cb);
}
const pending = new Set<EventName>();
let scheduled = false;
/** Events are coalesced per animation frame. */
export function emit(...evts: EventName[]) {
  evts.forEach((e) => pending.add(e));
  if (evts.some((e) => e !== 'render' && e !== 'doc' && e !== 'cursor')) pending.add('render');
  if (pending.has('doc')) pending.add('render');
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const list = [...pending];
    pending.clear();
    for (const e of list) listeners.get(e)?.forEach((cb) => cb());
  });
}

// ------------------------------------------------------------ history

const snap = (d: DocData): DocData => structuredClone(d);

export class History {
  private states: { data: DocData; label: string; key?: string; t: number }[] = [];
  private index = -1;
  constructor(initial: DocData) {
    this.states.push({ data: snap(initial), label: 'Open', t: Date.now() });
    this.index = 0;
  }
  commit(d: DocData, label: string, mergeKey?: string) {
    const top = this.states[this.index];
    this.states.length = this.index + 1;
    if (mergeKey && top.key === mergeKey && Date.now() - top.t < 1200 && this.index > 0) {
      this.states[this.index] = { data: snap(d), label, key: mergeKey, t: Date.now() };
      return;
    }
    this.states.push({ data: snap(d), label, key: mergeKey, t: Date.now() });
    if (this.states.length > 200) this.states.shift();
    this.index = this.states.length - 1;
  }
  get canUndo() {
    return this.index > 0;
  }
  get canRedo() {
    return this.index < this.states.length - 1;
  }
  get undoLabel() {
    return this.canUndo ? this.states[this.index].label : '';
  }
  get redoLabel() {
    return this.canRedo ? this.states[this.index + 1].label : '';
  }
  undo(): DocData | null {
    if (!this.canUndo) return null;
    this.index--;
    return snap(this.states[this.index].data);
  }
  redo(): DocData | null {
    if (!this.canRedo) return null;
    this.index++;
    return snap(this.states[this.index].data);
  }
  /** Current committed state (used to cancel live edits). */
  current(): DocData {
    return snap(this.states[this.index].data);
  }
  get entries() {
    return this.states.map((s, i) => ({ label: s.label, current: i === this.index, future: i > this.index }));
  }
  jump(i: number): DocData | null {
    if (i < 0 || i >= this.states.length) return null;
    this.index = i;
    return snap(this.states[i].data);
  }
}

// ------------------------------------------------------------ documents

export interface View {
  zoom: number;
  panX: number;
  panY: number;
}

export class EditorDoc {
  id = uid();
  path: string | null = null;
  dirty = false;
  selection: string[] = [];
  /** id of the group currently entered for editing (null = top level) */
  scope: string | null = null;
  view: View = { zoom: 0, panX: 0, panY: 0 };
  history: History;
  kind: 'image' | 'component' = 'image';
  componentId?: string;

  constructor(
    public name: string,
    public data: DocData,
  ) {
    this.history = new History(data);
  }

  get scopeGroup(): GroupObj | null {
    if (!this.scope) return null;
    const l = locate(this.data.objects, this.scope);
    return l && l.obj.type === 'group' ? l.obj : null;
  }

  /** The list new objects go into and selection operates on. */
  get scopeList(): Obj[] {
    return this.scopeGroup?.children ?? this.data.objects;
  }

  selected(): Obj[] {
    return this.selection.map((id) => locate(this.data.objects, id)?.obj).filter((o): o is Obj => !!o);
  }

  commit(label: string, mergeKey?: string) {
    this.history.commit(this.data, label, mergeKey);
    this.dirty = true;
    emit('doc', 'history', 'tabs');
  }

  restore(d: DocData | null) {
    if (!d) return;
    this.data = d;
    this.selection = this.selection.filter((id) => locate(d.objects, id));
    if (this.scope && !locate(d.objects, this.scope)) this.scope = null;
    this.dirty = true;
    emit('doc', 'history', 'selection', 'tabs');
  }

  get title() {
    return this.name + (this.dirty ? ' •' : '');
  }
}

// ------------------------------------------------------------ tool state

export type ToolId = 'select' | 'pencil' | 'eraser' | 'fill' | 'line' | 'shape' | 'text' | 'picker' | 'hand' | 'zoom';

export interface ToolOpts {
  brushSize: number;
  brushRound: boolean;
  pixelPerfect: boolean;
  symX: boolean;
  symY: boolean;
  shapeKind: ShapeKind;
  radius: number;
  sides: number;
  inner: number;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  dash: number;
  gap: number;
  lineMode: 'line' | 'polyline';
  arrowStart: boolean;
  arrowEnd: boolean;
  font: string;
  fontSize: number;
  textAlign: TextAlign;
  fillContiguous: boolean;
  fillSampleAll: boolean;
  fillDiagonal: boolean;
}

export interface Settings {
  theme: 'light' | 'dark';
  pixelPerfectUI: boolean;
  grid: boolean;
  gridMin: number;
  tileGrid: number;
  showCheckerboard: boolean;
  recent: string[];
  customPatterns: Pat[];
  exportScale: number;
  splash: boolean;
  animations: boolean;
  builtinVersion?: number;
  tool: ToolOpts;
}

export const defaultToolOpts = (): ToolOpts => ({
  brushSize: 1,
  brushRound: true,
  pixelPerfect: true,
  symX: false,
  symY: false,
  shapeKind: 'rect',
  radius: 4,
  sides: 6,
  inner: 0.45,
  strokeWidth: 1,
  strokeStyle: 'solid',
  dash: 4,
  gap: 2,
  lineMode: 'line',
  arrowStart: false,
  arrowEnd: false,
  font: 'silkscreen',
  fontSize: 16,
  textAlign: 'left',
  fillContiguous: true,
  fillSampleAll: true,
  fillDiagonal: false,
});

export const defaultSettings = (): Settings => ({
  theme: 'light',
  pixelPerfectUI: false,
  grid: true,
  gridMin: 8,
  tileGrid: 0,
  showCheckerboard: true,
  recent: [],
  customPatterns: [],
  exportScale: 4,
  splash: true,
  animations: true,
  tool: defaultToolOpts(),
});

export const app = {
  docs: [] as EditorDoc[],
  active: null as EditorDoc | null,
  tool: 'pencil' as ToolId,
  slot: 'stroke' as 'stroke' | 'fill',
  strokePaint: BLACK() as Paint,
  fillPaint: WHITE() as Paint,
  strokeOn: true,
  fillOn: true,
  library: [] as Component[],
  settings: defaultSettings(),
  get opts() {
    return this.settings.tool;
  },
  /** cursor position in doc pixels (for status bar) */
  cursor: null as { x: number; y: number } | null,
  hint: '',
  clipboard: [] as Obj[],
};

export function activePaint(): Paint {
  return app.slot === 'stroke' ? app.strokePaint : app.fillPaint;
}

export function setActiveDoc(d: EditorDoc | null) {
  app.active = d;
  emit('tabs', 'doc', 'selection', 'history', 'view');
}

export function newDocData(width: number, height: number, background: Background = 'white'): DocData {
  return { width, height, background, objects: [] };
}

export function addDoc(d: EditorDoc) {
  app.docs.push(d);
  setActiveDoc(d);
}

export function setSelection(ids: string[]) {
  const d = app.active;
  if (!d) return;
  d.selection = ids;
  emit('selection');
}

export function setTool(t: ToolId) {
  app.tool = t;
  emit('tool');
}
