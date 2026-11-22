import { Buf, line, ellipseRect, fillRows } from '../core/raster';
import { renderObj } from '../core/render';
import { newShape, defaultStroke } from '../core/doc';
import { BLACK } from '../core/patterns';
import type { ShapeKind } from '../core/types';

type Grid = Uint8Array; // 16x16, 1 = ink
const S = 16;

const fromArt = (rows: string[]): Grid => {
  const g = new Uint8Array(S * S);
  rows.forEach((r, y) => [...r].forEach((c, x) => c === '#' && (g[y * S + x] = 1)));
  return g;
};

const draw = (fn: (plot: (x: number, y: number) => void, g: Grid) => void): Grid => {
  const g = new Uint8Array(S * S);
  fn((x, y) => {
    if (x >= 0 && y >= 0 && x < S && y < S) g[y * S + x] = 1;
  }, g);
  return g;
};

const rect = (plot: (x: number, y: number) => void, x0: number, y0: number, x1: number, y1: number, fill = false) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (fill || x === x0 || x === x1 || y === y0 || y === y1) plot(x, y);
};

const ART: Record<string, string[]> = {
  select: [
    '................',
    '..#.............',
    '..##............',
    '..###...........',
    '..####..........',
    '..#####.........',
    '..######........',
    '..#######.......',
    '..########......',
    '..#########.....',
    '..######........',
    '..##..##........',
    '..#....##.......',
    '.......##.......',
    '........##......',
    '................',
  ],
  pencil: [
    '................',
    '...........##...',
    '..........#..#..',
    '.........#.#..#.',
    '........#...#.#.',
    '.......#...#.#..',
    '......#...#.#...',
    '.....#...#.#....',
    '....#...#.#.....',
    '...#...#.#......',
    '..##..#.#.......',
    '..#.##.#........',
    '..#..##.........',
    '.#####..........',
    '.##.............',
    '................',
  ],
  eraser: [
    '................',
    '................',
    '.........###....',
    '........#####...',
    '.......#######..',
    '......#######...',
    '.....#######....',
    '....#.#####.....',
    '...#...###......',
    '..#.....#.......',
    '..#....#........',
    '...#..#.........',
    '....##..........',
    '................',
    '..###########...',
    '................',
  ],
  fill: [
    '................',
    '......#.........',
    '.....#.#........',
    '.....#..#.......',
    '.....#.###......',
    '....#.#.#.#.....',
    '...#..#.#..#....',
    '..#...#.#...#...',
    '.#....###....#..',
    '.#############..',
    '..###########.#.',
    '...#########..#.',
    '....#######..###',
    '.....#####...###',
    '......###.....#.',
    '................',
  ],
  text: [
    '................',
    '.##############.',
    '.##....##....##.',
    '.#.....##.....#.',
    '.......##.......',
    '.......##.......',
    '.......##.......',
    '.......##.......',
    '.......##.......',
    '.......##.......',
    '.......##.......',
    '.......##.......',
    '.......##.......',
    '.....######.....',
    '................',
    '................',
  ],
  picker: [
    '................',
    '...........###..',
    '..........#####.',
    '..........#####.',
    '.......#.######.',
    '........#####...',
    '.......#.###....',
    '......#...#.#...',
    '.....#...#......',
    '....#...#.......',
    '...#...#........',
    '..#...#.........',
    '..#..#..........',
    '.#.##...........',
    '.#..............',
    '................',
  ],
  hand: [
    '................',
    '.......##.......',
    '....##.#.###....',
    '...#..##.#..#...',
    '...#..##.#..#.#.',
    '....#..#.#..##.#',
    '....#..#.#..#..#',
    '..##.#.......#.#',
    '.#..##.........#',
    '.#...#........#.',
    '..#...........#.',
    '...#..........#.',
    '....#........#..',
    '.....#.......#..',
    '......#######...',
    '................',
  ],
  eye: [
    '................',
    '................',
    '................',
    '................',
    '.....######.....',
    '...##......##...',
    '..#....##....#..',
    '.#....####....#.',
    '..#....##....#..',
    '...##......##...',
    '.....######.....',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  eyeOff: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '.#............#.',
    '..##........##..',
    '....########....',
    '...#..#..#..#...',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  lock: [
    '................',
    '................',
    '................',
    '......####......',
    '.....#....#.....',
    '.....#....#.....',
    '.....#....#.....',
    '....########....',
    '....########....',
    '....###..###....',
    '....###..###....',
    '....########....',
    '....########....',
    '................',
    '................',
    '................',
  ],
  unlock: [
    '................',
    '................',
    '................',
    '........####....',
    '.......#....#...',
    '.......#....#...',
    '.......#........',
    '....#######.....',
    '....#.....#.....',
    '....#.....#.....',
    '....#.....#.....',
    '....#######.....',
    '................',
    '................',
    '................',
    '................',
  ],
  component: [
    '................',
    '.......##.......',
    '......####......',
    '.....##..##.....',
    '......####......',
    '..##...##...##..',
    '.####......####.',
    '##..##....##..##',
    '.####......####.',
    '..##...##...##..',
    '......####......',
    '.....##..##.....',
    '......####......',
    '.......##.......',
    '................',
    '................',
  ],
  image: [
    '................',
    '................',
    '.##############.',
    '.#............#.',
    '.#.........##.#.',
    '.#.........##.#.',
    '.#............#.',
    '.#....#.......#.',
    '.#...###......#.',
    '.#..#####..#..#.',
    '.#.#######.##.#.',
    '.#############..',
    '.##############.',
    '................',
    '................',
    '................',
  ],
  folder: [
    '................',
    '................',
    '..#####.........',
    '.#.....#........',
    '.#......#######.',
    '.#............#.',
    '.##############.',
    '.#............#.',
    '.#............#.',
    '.#............#.',
    '.#............#.',
    '.#............#.',
    '.##############.',
    '................',
    '................',
    '................',
  ],
  save: [
    '................',
    '.#############..',
    '.#..#######..##.',
    '.#..#######...#.',
    '.#..####.##...#.',
    '.#..####.##...#.',
    '.#............#.',
    '.#.##########.#.',
    '.#.#........#.#.',
    '.#.#.######.#.#.',
    '.#.#........#.#.',
    '.#.#.######.#.#.',
    '.#.#........#.#.',
    '.##############.',
    '................',
    '................',
  ],
  bitmap: [
    '................',
    '................',
    '.#.#.#.#.#.#.#..',
    '................',
    '.#.###.#.#.#.#..',
    '...###..........',
    '.#.###.###.#.#..',
    '.......###......',
    '.#.#.#.###.#.#..',
    '...........###..',
    '.#.#.#.#.#.###..',
    '................',
    '.#.#.#.#.#.#.#..',
    '................',
    '................',
    '................',
  ],
};

const PROGRAMMATIC: Record<string, () => Grid> = {
  line: () =>
    draw((p) => {
      line(2, 13, 13, 2, p);
      rect(p, 1, 12, 3, 14, true);
      rect(p, 12, 1, 14, 3, true);
    }),
  shape: () =>
    draw((p, g) => {
      rect(p, 1, 1, 9, 9);
      const c = new Buf(5, 5, 11, 11);
      ellipseRect(5, 5, 15, 15, (x, y) => c.set(x, y, 1));
      fillRows(c);
      // knock out a 1px gap around the circle so it reads as "in front"
      c.forEachSet((x, y) => {
        for (const [dx, dy] of [
          [-1, 0],
          [0, -1],
        ])
          if (!c.get(x + dx, y + dy)) g[(y + dy) * S + x + dx] = 0;
      });
      c.forEachSet((x, y) => p(x, y));
    }),
  zoom: () =>
    draw((p) => {
      ellipseRect(1, 1, 10, 10, p);
      ellipseRect(2, 2, 9, 9, p);
      for (let i = 0; i < 5; i++) {
        p(9 + i, 10 + i);
        p(10 + i, 10 + i);
        p(10 + i, 9 + i);
      }
    }),
  plus: () =>
    draw((p) => {
      rect(p, 7, 3, 8, 12, true);
      rect(p, 3, 7, 12, 8, true);
    }),
  minus: () => draw((p) => rect(p, 3, 7, 12, 8, true)),
  close: () =>
    draw((p) => {
      for (let i = 0; i < 9; i++) {
        p(3 + i, 3 + i);
        p(4 + i, 3 + i);
        p(12 - i, 3 + i);
        p(11 - i, 3 + i);
      }
    }),
  trash: () =>
    draw((p) => {
      rect(p, 3, 3, 12, 3, true);
      rect(p, 6, 1, 9, 2);
      rect(p, 4, 5, 11, 14);
      for (const x of [6, 9]) line(x, 7, x, 12, p);
    }),
  up: () =>
    draw((p) => {
      for (let i = 0; i < 5; i++) line(7 - i, 4 + i, 8 + i, 4 + i, p);
      rect(p, 6, 9, 9, 12, true);
    }),
  down: () =>
    draw((p) => {
      for (let i = 0; i < 5; i++) line(7 - i, 11 - i, 8 + i, 11 - i, p);
      rect(p, 6, 3, 9, 6, true);
    }),
  duplicate: () =>
    draw((p) => {
      rect(p, 1, 1, 9, 9);
      rect(p, 5, 5, 14, 14, true);
      rect(p, 6, 6, 13, 13, false);
    }),
  group: () =>
    draw((p) => {
      for (let x = 1; x <= 14; x += 2) {
        p(x, 1);
        p(x, 14);
      }
      for (let y = 1; y <= 14; y += 2) {
        p(1, y);
        p(14, y);
      }
      rect(p, 4, 4, 8, 8, true);
      rect(p, 7, 7, 11, 11);
    }),
  chevDown: () => draw((p) => [0, 1, 2, 3].forEach((i) => line(4 + i, 6 + i, 11 - i, 6 + i, p))),
  chevRight: () => draw((p) => [0, 1, 2, 3].forEach((i) => line(6 + i, 4 + i, 6 + i, 11 - i, p))),
  check: () =>
    draw((p) => {
      line(2, 8, 5, 11, p);
      line(2, 9, 5, 12, p);
      line(5, 11, 13, 3, p);
      line(5, 12, 13, 4, p);
    }),
  maximize: () =>
    draw((p) => {
      rect(p, 2, 2, 13, 13);
      rect(p, 2, 3, 13, 4, true);
    }),
  flipH: () =>
    draw((p) => {
      for (let y = 1; y < 15; y += 2) p(7, y);
      for (let i = 0; i < 6; i++) line(5 - i, 7 - i, 5 - i, 8 + i, p);
      for (let i = 0; i < 6; i++) {
        p(9 + i, 7 - i);
        p(9 + i, 8 + i);
      }
      line(9, 2, 9, 13, p);
    }),
  flipV: () =>
    draw((p) => {
      for (let x = 1; x < 15; x += 2) p(x, 7);
      for (let i = 0; i < 6; i++) line(7 - i, 5 - i, 8 + i, 5 - i, p);
      for (let i = 0; i < 6; i++) {
        p(7 - i, 9 + i);
        p(8 + i, 9 + i);
      }
      line(2, 9, 13, 9, p);
    }),
  enter: () =>
    draw((p) => {
      rect(p, 1, 1, 14, 14);
      line(4, 8, 11, 8, p);
      line(8, 5, 11, 8, p);
      line(8, 11, 11, 8, p);
    }),
  grid: () =>
    draw((p) => {
      for (let i = 1; i < 16; i += 4) {
        line(i, 1, i, 13, p);
        line(1, i, 13, i, p);
      }
    }),
  swap: () =>
    draw((p) => {
      line(3, 3, 11, 3, p);
      line(11, 3, 11, 11, p);
      line(9, 9, 11, 11, p);
      line(13, 9, 11, 11, p);
      line(1, 5, 3, 3, p);
      line(1, 1, 3, 3, p);
    }),
  text_small: () => fromArt(ART.text),
};

const cache = new Map<string, string>();

function gridToURL(g: Grid, w = S, h = S): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) if (g[i]) img.data.set([0, 0, 0, 255], i * 4);
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

export function iconURL(name: string): string {
  if (cache.has(name)) return cache.get(name)!;
  let g: Grid | null = null;
  if (ART[name]) g = fromArt(ART[name]);
  else if (PROGRAMMATIC[name]) g = PROGRAMMATIC[name]();
  else if (name.startsWith('shape-')) g = shapeIcon(name.slice(6) as ShapeKind);
  if (!g) g = new Uint8Array(S * S);
  const url = gridToURL(g);
  cache.set(name, url);
  return url;
}

/** Shape icons come straight from the real renderer, so they always match the canvas. */
function shapeIcon(kind: ShapeKind): Grid {
  const o = newShape(kind, { x: 1, y: kind === 'arrow' ? 3 : 1, w: 14, h: kind === 'arrow' ? 10 : 14 }, defaultStroke(BLACK()), null, {
    sides: kind === 'star' ? 5 : 6,
    radius: 4,
    id: 'icon-' + kind,
  });
  o.stroke.width = 1;
  const s = renderObj(o);
  const g = new Uint8Array(S * S);
  s.pix.forEachSet((x, y, v) => {
    if (v === 1 && x >= 0 && y >= 0 && x < S && y < S) g[y * S + x] = 1;
  });
  return g;
}

/** An <i> element that renders the icon in currentColor. */
export function icon(name: string, size = 16, cls = ''): HTMLElement {
  const el = document.createElement('i');
  el.className = 'icon ' + cls;
  const url = iconURL(name);
  el.style.cssText = `width:${size}px;height:${size}px;-webkit-mask-image:url(${url});mask-image:url(${url});-webkit-mask-size:${size}px ${size}px;mask-size:${size}px ${size}px;`;
  return el;
}

/** Cursor data-URL (black icon with white halo) for canvas tools. */
export function cursorFor(name: string, hx: number, hy: number, fallback = 'crosshair'): string {
  const g = name === 'crosshair' ? crosshair() : (ART[name] ? fromArt(ART[name]) : PROGRAMMATIC[name]?.()) ?? null;
  if (!g) return fallback;
  const scale = 2;
  const c = document.createElement('canvas');
  c.width = c.height = S * scale;
  const ctx = c.getContext('2d')!;
  // white halo
  ctx.fillStyle = '#fff';
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++)
      if (g[y * S + x])
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx,
              ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < S && ny < S) ctx.fillRect(nx * scale, ny * scale, scale, scale);
          }
  ctx.fillStyle = '#000';
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (g[y * S + x]) ctx.fillRect(x * scale, y * scale, scale, scale);
  return `url(${c.toDataURL()}) ${hx * scale} ${hy * scale}, ${fallback}`;
}

function crosshair(): Grid {
  return draw((p) => {
    for (let i = 0; i < 16; i++) {
      if (i < 6 || i > 9) {
        p(7, i);
        p(i, 7);
      }
    }
  });
}
