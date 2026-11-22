/** 8x8 tile, one byte per row, MSB = leftmost pixel. A set bit is black ink. */
export type Pat = number[];

/** opaque: paint black & white bits. ink: only black bits. paper: only white bits. */
export type PaintMode = 'opaque' | 'ink' | 'paper';

export interface PatternPaint {
  kind: 'pattern';
  pat: Pat;
  mode: PaintMode;
}

export interface GradientPaint {
  kind: 'gradient';
  /** Ink density 0 (white) .. 64 (black) */
  from: number;
  to: number;
  angle: number;
  shape: 'linear' | 'radial';
  dither: 'bayer' | 'noise';
  mode: PaintMode;
  /** optional absolute start/end (set by dragging with the fill bucket); overrides angle/box */
  p0?: [number, number];
  p1?: [number, number];
}

export type Paint = PatternPaint | GradientPaint;

export type StrokeStyle = 'solid' | 'dashed' | 'dotted';

export interface Stroke {
  /** 0 = no stroke */
  width: number;
  style: StrokeStyle;
  dash: number;
  gap: number;
  paint: Paint;
}

export interface Shadow {
  on: boolean;
  dx: number;
  dy: number;
  style: 'drop' | 'extrude';
  paint: Paint;
}

export interface Outline {
  on: boolean;
  width: number;
  round: boolean;
  paint: Paint;
}

export interface Effects {
  shadow: Shadow;
  outline: Outline;
}

export type Blend = 'normal' | 'invert';

interface BaseObj {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  blend: Blend;
  fx: Effects;
}

export type ShapeKind =
  | 'rect'
  | 'roundrect'
  | 'ellipse'
  | 'triangle'
  | 'rtriangle'
  | 'diamond'
  | 'polygon'
  | 'star'
  | 'heart'
  | 'arrow';

export interface ShapeObj extends BaseObj {
  type: 'shape';
  shape: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  sides: number;
  inner: number;
  angle: number;
  flipX: boolean;
  flipY: boolean;
  stroke: Stroke;
  fill: Paint | null;
}

export interface LineObj extends BaseObj {
  type: 'line';
  points: [number, number][];
  closed: boolean;
  stroke: Stroke;
  arrowStart: boolean;
  arrowEnd: boolean;
}

export type TextAlign = 'left' | 'center' | 'right';

export interface TextObj extends BaseObj {
  type: 'text';
  x: number;
  y: number;
  text: string;
  font: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  letterSpacing: number;
  lineSpacing: number;
  align: TextAlign;
  /** alpha threshold 1..255 used to binarise anti-aliased glyphs */
  threshold: number;
  flipX: boolean;
  flipY: boolean;
  paint: Paint;
  /** inside of outline-font letters (undefined = white, null = hollow) */
  fill?: Paint | null;
}

export interface BitmapObj extends BaseObj {
  type: 'bitmap';
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 transparent, 1 black, 2 white */
  data: Uint8Array;
  rev: number;
}

export type DitherAlgo = 'bayer4' | 'bayer8' | 'floyd' | 'atkinson' | 'stucki' | 'halftone' | 'noise' | 'threshold';

export interface ImageObj extends BaseObj {
  type: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  src: { w: number; h: number; data: Uint8Array };
  algo: DitherAlgo;
  brightness: number;
  contrast: number;
  gamma: number;
  invert: boolean;
  /** white pixels become transparent */
  knockout: boolean;
  rev: number;
}

export interface GroupObj extends BaseObj {
  type: 'group';
  children: Obj[];
  componentId?: string;
  expanded?: boolean;
}

export type Obj = ShapeObj | LineObj | TextObj | BitmapObj | ImageObj | GroupObj;
export type ObjType = Obj['type'];

export type Background = 'white' | 'black' | 'transparent';

export interface DocData {
  width: number;
  height: number;
  background: Background;
  objects: Obj[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Component {
  id: string;
  name: string;
  created: number;
  width: number;
  height: number;
  objects: Obj[];
  builtin?: boolean;
}
