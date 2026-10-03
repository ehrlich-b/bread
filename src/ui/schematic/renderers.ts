import type { CircuitJSON } from "../../engine/ir";
// Per-component-type SVG renderer presets. Each entry knows how to draw the
// component's body inside a translated <g> and where its pins live (so the
// wire layer can route to absolute coordinates).
//
// All gate renderers use 60x40 (or 66x40 with a bubble) and pin endpoints at
// (0, 12)/(0, 28) for inputs A/B and (60, 20) or (66, 20) for output Y.
// NOT/BUF use a 40-wide body for visual differentiation. DFF is 70x60.

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface PinOffset {
  x: number;
  y: number;
}

export interface Renderer {
  size: { w: number; h: number };
  pins: Record<string, PinOffset>;
  draw(group: SVGGElement, instId: string, params: Record<string, unknown> | undefined): void;
}

export const text = (
  parent: Element,
  x: number,
  y: number,
  content: string,
  anchor: 'start' | 'middle' | 'end' = 'middle',
): SVGTextElement => {
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('x', String(x));
  t.setAttribute('y', String(y));
  t.setAttribute('text-anchor', anchor);
  t.setAttribute('class', 'label');
  t.textContent = content;
  parent.appendChild(t);
  return t;
};

export const rect = (
  parent: Element,
  x: number,
  y: number,
  w: number,
  h: number,
  cls: string,
): SVGRectElement => {
  const r = document.createElementNS(SVG_NS, 'rect');
  r.setAttribute('x', String(x));
  r.setAttribute('y', String(y));
  r.setAttribute('width', String(w));
  r.setAttribute('height', String(h));
  r.setAttribute('class', cls);
  r.setAttribute('rx', '4');
  parent.appendChild(r);
  return r;
};

const bodyPath = (parent: Element, d: string): SVGPathElement => {
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('class', 'gate-body');
  parent.appendChild(p);
  return p;
};

const bubble = (parent: Element, cx: number, cy: number): SVGCircleElement => {
  const c = document.createElementNS(SVG_NS, 'circle');
  c.setAttribute('cx', String(cx));
  c.setAttribute('cy', String(cy));
  c.setAttribute('r', '3');
  c.setAttribute('class', 'gate-body');
  parent.appendChild(c);
  return c;
};

// 2-input gate body shapes. AND-family is a D-shape; OR-family is curved-back.
// XOR adds a back-arc behind the OR shape.
const D_SHAPE = 'M 4 4 L 30 4 A 16 16 0 0 1 30 36 L 4 36 Z';
const OR_SHAPE = 'M 4 4 Q 24 4 50 20 Q 24 36 4 36 Q 12 20 4 4 Z';
const XOR_BACK = 'M -2 4 Q 6 20 -2 36';

export const renderers: Record<string, Renderer> = {
  'io.switch': {
    size: { w: 70, h: 40 },
    pins: { Y: { x: 70, y: 20 } },
    draw(group, instId) {
      rect(group, 0, 0, 70, 40, 'gate-body');
      text(group, 35, 16, instId, 'middle');
      const handle = document.createElementNS(SVG_NS, 'rect');
      handle.setAttribute('x', '8');
      handle.setAttribute('y', '22');
      handle.setAttribute('width', '54');
      handle.setAttribute('height', '14');
      handle.setAttribute('rx', '3');
      handle.setAttribute('class', 'switch-handle');
      handle.setAttribute('data-role', 'switch-handle');
      handle.setAttribute('fill', 'var(--led-off)');
      group.appendChild(handle);
      const stateLabel = document.createElementNS(SVG_NS, 'text');
      stateLabel.setAttribute('x', '35');
      stateLabel.setAttribute('y', '34');
      stateLabel.setAttribute('text-anchor', 'middle');
      stateLabel.setAttribute('class', 'label');
      stateLabel.setAttribute('data-role', 'switch-label');
      stateLabel.textContent = '0';
      group.appendChild(stateLabel);
    },
  },
  'gen.clock': {
    size: { w: 70, h: 40 },
    pins: { Y: { x: 70, y: 20 } },
    draw(group, instId, params) {
      rect(group, 0, 0, 70, 40, 'gate-body');
      const freq = (params?.freqHz as number | undefined) ?? 1;
      text(group, 35, 16, instId, 'middle');
      text(group, 35, 32, `${String(freq)} Hz`, 'middle');
    },
  },
  'gen.555': {
    size: { w: 70, h: 40 },
    pins: { OUT: { x: 70, y: 20 } },
    draw(group, instId, params) {
      rect(group, 0, 0, 70, 40, 'gate-body');
      const freq = (params?.freqHz as number | undefined) ?? 1;
      text(group, 35, 16, '555', 'middle');
      text(group, 35, 32, `${String(freq)} Hz`, 'middle');
      text(group, 35, 56, instId, 'middle');
    },
  },
  'io.7seg': sevenSegRenderer(),
  'io.led': {
    size: { w: 40, h: 40 },
    pins: { A: { x: 0, y: 20 } },
    draw(group, instId) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', '24');
      c.setAttribute('cy', '20');
      c.setAttribute('r', '14');
      c.setAttribute('class', 'led');
      c.setAttribute('data-role', 'led');
      c.setAttribute('fill', 'var(--led-off)');
      group.appendChild(c);
      text(group, 24, 56, instId, 'middle');
    },
  },
  'prim.AND': {
    size: { w: 60, h: 40 },
    pins: { A: { x: 0, y: 12 }, B: { x: 0, y: 28 }, Y: { x: 60, y: 20 } },
    draw(group, instId) {
      bodyPath(group, D_SHAPE);
      text(group, 22, 24, '&', 'middle');
      text(group, 30, 56, instId, 'middle');
    },
  },
  'prim.NAND': {
    size: { w: 66, h: 40 },
    pins: { A: { x: 0, y: 12 }, B: { x: 0, y: 28 }, Y: { x: 66, y: 20 } },
    draw(group, instId) {
      bodyPath(group, D_SHAPE);
      bubble(group, 60, 20);
      text(group, 22, 24, '&', 'middle');
      text(group, 33, 56, instId, 'middle');
    },
  },
  'prim.OR': {
    size: { w: 60, h: 40 },
    pins: { A: { x: 0, y: 12 }, B: { x: 0, y: 28 }, Y: { x: 60, y: 20 } },
    draw(group, instId) {
      bodyPath(group, OR_SHAPE);
      text(group, 22, 24, '≥1', 'middle');
      text(group, 30, 56, instId, 'middle');
    },
  },
  'prim.NOR': {
    size: { w: 66, h: 40 },
    pins: { A: { x: 0, y: 12 }, B: { x: 0, y: 28 }, Y: { x: 66, y: 20 } },
    draw(group, instId) {
      bodyPath(group, OR_SHAPE);
      bubble(group, 60, 20);
      text(group, 22, 24, '≥1', 'middle');
      text(group, 33, 56, instId, 'middle');
    },
  },
  'prim.XOR': {
    size: { w: 60, h: 40 },
    pins: { A: { x: 0, y: 12 }, B: { x: 0, y: 28 }, Y: { x: 60, y: 20 } },
    draw(group, instId) {
      bodyPath(group, OR_SHAPE);
      const back = document.createElementNS(SVG_NS, 'path');
      back.setAttribute('d', XOR_BACK);
      back.setAttribute('class', 'gate-stroke');
      group.appendChild(back);
      text(group, 22, 24, '=1', 'middle');
      text(group, 30, 56, instId, 'middle');
    },
  },
  'prim.XNOR': {
    size: { w: 66, h: 40 },
    pins: { A: { x: 0, y: 12 }, B: { x: 0, y: 28 }, Y: { x: 66, y: 20 } },
    draw(group, instId) {
      bodyPath(group, OR_SHAPE);
      const back = document.createElementNS(SVG_NS, 'path');
      back.setAttribute('d', XOR_BACK);
      back.setAttribute('class', 'gate-stroke');
      group.appendChild(back);
      bubble(group, 60, 20);
      text(group, 22, 24, '=1', 'middle');
      text(group, 33, 56, instId, 'middle');
    },
  },
  'prim.NOT': {
    size: { w: 46, h: 40 },
    pins: { A: { x: 0, y: 20 }, Y: { x: 46, y: 20 } },
    draw(group, instId) {
      bodyPath(group, 'M 4 4 L 4 36 L 38 20 Z');
      bubble(group, 42, 20);
      text(group, 23, 56, instId, 'middle');
    },
  },
  'prim.BUF': {
    size: { w: 40, h: 40 },
    pins: { A: { x: 0, y: 20 }, Y: { x: 40, y: 20 } },
    draw(group, instId) {
      bodyPath(group, 'M 4 4 L 4 36 L 38 20 Z');
      text(group, 20, 56, instId, 'middle');
    },
  },
  'prim.DFF': {
    size: { w: 70, h: 60 },
    pins: {
      D: { x: 0, y: 15 },
      CLK: { x: 0, y: 45 },
      Q: { x: 70, y: 15 },
      Qn: { x: 70, y: 45 },
    },
    draw(group, instId) {
      rect(group, 0, 0, 70, 60, 'gate-body');
      text(group, 35, 14, instId, 'middle');
      text(group, 9, 19, 'D', 'start');
      text(group, 9, 49, '▷', 'start');
      text(group, 61, 19, 'Q', 'end');
      text(group, 61, 49, 'Q̅', 'end');
      text(group, 35, 38, 'D-FF', 'middle');
    },
  },
  'mem.28C16': mem28C16Renderer(),
};

// io.7seg rendering: pins on the left (a, b, c, d, e, f, g, dp from top),
// segment polygons on the right inside a recessed display panel. Each segment
// carries a data-role="seg-<name>" attribute so view.ts can find it for live
// fill updates from the SAB. Segments default to the 'seg-off' fill; when
// their pin's net resolves to 1 they switch to 'seg-on'.
function sevenSegRenderer(): Renderer {
  const PIN_PITCH = 14;
  const PIN_TOP = 14;
  const WIDTH = 90;
  const HEIGHT = PIN_TOP + 8 * PIN_PITCH + 12; // 8 pins → height 138
  const DISPLAY_X = 30;

  const pinNames = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'];
  const pins: Record<string, PinOffset> = {};
  for (let i = 0; i < pinNames.length; i++) {
    pins[pinNames[i]!] = { x: 0, y: PIN_TOP + i * PIN_PITCH };
  }

  const seg = (group: SVGGElement, name: string, x: number, y: number, w: number, h: number): void => {
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('x', String(x));
    r.setAttribute('y', String(y));
    r.setAttribute('width', String(w));
    r.setAttribute('height', String(h));
    r.setAttribute('rx', '1.5');
    r.setAttribute('class', 'seg-off');
    r.setAttribute('data-role', `seg-${name}`);
    r.setAttribute('fill', 'var(--seg-off)');
    group.appendChild(r);
  };

  return {
    size: { w: WIDTH, h: HEIGHT },
    pins,
    draw(group, instId) {
      rect(group, 0, 0, WIDTH, HEIGHT, 'gate-body');
      // Pin labels just inside the body.
      for (let i = 0; i < pinNames.length; i++) {
        text(group, 8, PIN_TOP + i * PIN_PITCH + 4, pinNames[i]!, 'start');
      }
      // Display panel — a darker inset rectangle that the segments sit on.
      const panel = document.createElementNS(SVG_NS, 'rect');
      panel.setAttribute('x', String(DISPLAY_X));
      panel.setAttribute('y', '12');
      panel.setAttribute('width', String(WIDTH - DISPLAY_X - 6));
      panel.setAttribute('height', String(HEIGHT - 24));
      panel.setAttribute('rx', '4');
      panel.setAttribute('class', 'seg-panel');
      group.appendChild(panel);

      // Geometry: a 7-seg shape inside the panel. Segments are simple rounded
      // rectangles — readable enough at our scale, and the data-role attrs
      // are what the live updater finds.
      const segLeft = DISPLAY_X + 8;
      const segRight = WIDTH - 18;
      const segWidth = segRight - segLeft;
      const segTop = 18;
      const segMid = HEIGHT / 2 - 2;
      const segBot = HEIGHT - 26;
      const vertW = 4;
      const horizH = 4;

      seg(group, 'a', segLeft, segTop, segWidth, horizH);
      seg(group, 'g', segLeft, segMid, segWidth, horizH);
      seg(group, 'd', segLeft, segBot, segWidth, horizH);
      seg(group, 'f', segLeft, segTop + 4, vertW, segMid - segTop - 4);
      seg(group, 'b', segRight - vertW, segTop + 4, vertW, segMid - segTop - 4);
      seg(group, 'e', segLeft, segMid + 4, vertW, segBot - segMid - 4);
      seg(group, 'c', segRight - vertW, segMid + 4, vertW, segBot - segMid - 4);
      // Decimal point as a small filled square next to segment d.
      const dp = document.createElementNS(SVG_NS, 'rect');
      dp.setAttribute('x', String(segRight + 1));
      dp.setAttribute('y', String(segBot));
      dp.setAttribute('width', '4');
      dp.setAttribute('height', '4');
      dp.setAttribute('class', 'seg-off');
      dp.setAttribute('data-role', 'seg-dp');
      dp.setAttribute('fill', 'var(--seg-off)');
      group.appendChild(dp);

      text(group, WIDTH / 2, HEIGHT + 14, instId, 'middle');
    },
  };
}

// 28C16 DIP layout: 11 address pins on the left, 8 data + 3 control pins on
// the right. The chip is drawn as a rounded body with a notch indicator on
// top so it reads as an IC at a glance. Pin labels sit just inside the body
// at each pin's y; pin numbers are deliberately omitted because we don't
// model the real chip's VCC/GND on pins 12/24, and labels alone disambiguate.
function mem28C16Renderer(): Renderer {
  const PITCH = 16;
  const TOP = 26;
  const BOTTOM = 12;
  const WIDTH = 130;
  const ROWS = 11;
  const HEIGHT = TOP + ROWS * PITCH + BOTTOM;

  const leftPins = [
    'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10',
  ];
  const rightPins = [
    'IO0', 'IO1', 'IO2', 'IO3', 'IO4', 'IO5', 'IO6', 'IO7', '/CE', '/OE', '/WE',
  ];

  const pins: Record<string, PinOffset> = {};
  for (let i = 0; i < ROWS; i++) {
    pins[leftPins[i]!] = { x: 0, y: TOP + i * PITCH };
    pins[rightPins[i]!] = { x: WIDTH, y: TOP + i * PITCH };
  }

  return {
    size: { w: WIDTH, h: HEIGHT },
    pins,
    draw(group, instId) {
      rect(group, 0, 0, WIDTH, HEIGHT, 'gate-body');
      // Notch: a small filled half-circle on the top edge, centered.
      const notch = document.createElementNS(SVG_NS, 'path');
      notch.setAttribute('d', `M ${String(WIDTH / 2 - 8)} 0 A 8 8 0 0 0 ${String(WIDTH / 2 + 8)} 0 Z`);
      notch.setAttribute('class', 'gate-stroke');
      notch.setAttribute('fill', 'transparent');
      group.appendChild(notch);
      text(group, WIDTH / 2, 18, '28C16', 'middle');
      text(group, WIDTH / 2, HEIGHT + 14, instId, 'middle');
      for (let i = 0; i < ROWS; i++) {
        const y = TOP + i * PITCH + 4;
        text(group, 8, y, leftPins[i]!, 'start');
        text(group, WIDTH - 8, y, rightPins[i]!, 'end');
      }
    },
  };
}

// Resolve a renderer for an instance: hand-crafted entry if present, else a
// generic IC body built from the engine's pin spec. Returns null only for
// component types the engine doesn't know about either (a malformed circuit).
import { buildGenericRenderer } from './generic_renderer';

export const resolveRenderer = (
  typeId: string,
  params?: Record<string, unknown>,
  definitions?: readonly CircuitJSON[],
): Renderer | null => {
  const r = renderers[typeId];
  if (r) return r;
  return buildGenericRenderer(typeId, params, definitions);
};
