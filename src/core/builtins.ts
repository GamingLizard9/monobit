import { newShape, newText, newLine, defaultStroke, uid } from './doc';
import { BLACK, WHITE, patPaint, densityPat, defaultGradient } from './patterns';
import { composeObjects } from './render';
import type { Component, Obj, TextObj } from './types';

/** Bump when the built-in components change; libraries refresh their built-ins once. */
export const BUILTIN_VERSION = 2;

/** Center-anchored text: editing it keeps it centered. */
const centerText = (t: TextObj, cx: number) => {
  t.align = 'center';
  t.x = Math.round(cx);
  return t;
};

const noStroke = () => ({ ...defaultStroke(), width: 0 });

function comp(name: string, objects: Obj[]): Component {
  const b = composeObjects(objects);
  return { id: 'builtin-' + name.toLowerCase().replace(/\W+/g, '-'), name, created: Date.now(), width: b?.w ?? 0, height: b?.h ?? 0, objects, builtin: true };
}

export function builtinComponents(): Component[] {
  const out: Component[] = [];

  // "Hello, my name is" tag
  {
    const W = 168,
      H = 74;
    const frame = newShape('roundrect', { x: 0, y: 0, w: W, h: H }, defaultStroke(), BLACK(), { radius: 6, name: 'Tag' });
    const card = newShape('rect', { x: 4, y: 25, w: W - 8, h: H - 29 }, noStroke(), WHITE(), { name: 'Card' });
    const hello = centerText(newText(0, -3, 'HELLO', { font: 'silkscreen', size: 16, bold: true, paint: WHITE(), name: 'Hello' }), W / 2);
    const sub = centerText(newText(0, 14, 'my name is', { font: 'tiny5', size: 8, paint: WHITE(), name: 'Subtitle' }), W / 2);
    const name = newText(0, 26, 'Samantha', { font: 'arial-black', size: 26, threshold: 110, name: 'Name' });
    name.fx.shadow = { on: true, dx: 2, dy: 2, style: 'drop', paint: patPaint(densityPat(8), 'ink') };
    centerText(name, W / 2 - 1);
    const sparkle = (x: number, y: number, s: number) =>
      newShape('star', { x, y, w: s, h: s }, noStroke(), BLACK(), { sides: 4, inner: 0.25, name: 'Sparkle' });
    out.push(comp('Name Tag', [frame, card, hello, sub, name, sparkle(9, 30, 7), sparkle(W - 16, 55, 7), sparkle(13, 61, 5)]));
  }

  // classic window
  {
    const W = 128,
      H = 84;
    const win = newShape('rect', { x: 0, y: 0, w: W, h: H }, defaultStroke(), WHITE(), { name: 'Window' });
    win.fx.shadow = { on: true, dx: 2, dy: 2, style: 'drop', paint: BLACK() };
    const bar = newShape('rect', { x: 1, y: 1, w: W - 2, h: 12 }, noStroke(), patPaint([255, 0, 255, 0, 255, 0, 255, 0]), { name: 'Title stripes' });
    const div = newLine(
      [
        [0, 13],
        [W - 1, 13],
      ],
      defaultStroke(),
      { name: 'Divider' },
    );
    const close = newShape('rect', { x: 6, y: 3, w: 9, h: 9 }, defaultStroke(), WHITE(), { name: 'Close box' });
    close.fx.outline = { on: true, width: 1, round: false, paint: WHITE() };
    const title = centerText(newText(0, 3, 'Untitled', { font: 'silkscreen', size: 8, name: 'Title' }), W / 2);
    title.fx.outline = { on: true, width: 2, round: false, paint: WHITE() };
    out.push(comp('Window', [win, bar, div, close, title]));
  }

  // button
  {
    const btn = newShape('roundrect', { x: 0, y: 0, w: 60, h: 22 }, defaultStroke(), WHITE(), { radius: 5, name: 'Button' });
    btn.fx.shadow = { on: true, dx: 1, dy: 2, style: 'extrude', paint: BLACK() };
    const label = centerText(newText(0, 7, 'OK', { font: 'silkscreen', size: 8, name: 'Label' }), 30);
    out.push(comp('Button', [btn, label]));
  }

  // dithered sphere
  {
    const s = newShape('ellipse', { x: 0, y: 0, w: 48, h: 48 }, defaultStroke(), { ...defaultGradient(), shape: 'radial', from: 4, to: 56 }, { name: 'Sphere' });
    const shine = newShape('ellipse', { x: 12, y: 10, w: 9, h: 6 }, noStroke(), WHITE(), { name: 'Shine' });
    out.push(comp('Dither Sphere', [s, shine]));
  }

  // heart icon
  {
    const hrt = newShape('heart', { x: 0, y: 0, w: 15, h: 13 }, defaultStroke(), patPaint(densityPat(8)), { name: 'Heart' });
    out.push(comp('Heart', [hrt]));
  }

  // star badge
  {
    const star = newShape('star', { x: 0, y: 0, w: 44, h: 42 }, defaultStroke(), WHITE(), { sides: 8, inner: 0.72, name: 'Badge' });
    star.fx.shadow = { on: true, dx: 2, dy: 2, style: 'drop', paint: patPaint(densityPat(12), 'ink') };
    const t = centerText(newText(0, 15, 'NEW', { font: 'silkscreen', size: 8, bold: true, name: 'Label' }), 22);
    out.push(comp('Star Badge', [star, t]));
  }

  // checkbox
  {
    const box = newShape('rect', { x: 0, y: 0, w: 11, h: 11 }, defaultStroke(), WHITE(), { name: 'Box' });
    const x1 = newLine(
      [
        [2, 2],
        [8, 8],
      ],
      defaultStroke(),
      { name: 'Check' },
    );
    const x2 = newLine(
      [
        [8, 2],
        [2, 8],
      ],
      defaultStroke(),
      { name: 'Check' },
    );
    const label = newText(16, 2, 'Option', { font: 'silkscreen', size: 8, name: 'Label' });
    out.push(comp('Checkbox', [box, x1, x2, label]));
  }

  // arrow callout
  {
    const ln = newLine(
      [
        [0, 0],
        [40, 0],
      ],
      { ...defaultStroke(), width: 2, style: 'dashed', dash: 3, gap: 2 },
      { arrowEnd: true, name: 'Arrow' },
    );
    out.push(comp('Dashed Arrow', [ln]));
  }

  for (const c of out) c.objects.forEach((o) => (o.id = uid()));
  return out;
}
