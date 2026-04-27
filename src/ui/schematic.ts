// Hardcoded SVG schematic for the M3 demo. Reads positions and pin offsets
// from a per-type render preset; draws each component, then runs straight-
// line wires between the connected pin endpoints. A single requestAnimation
// Frame loop samples the worker's SharedArrayBuffer and updates wire colors
// and LED fills. M4 will replace this with a real, editable schematic.

import type { CircuitJSON, NetState } from '../engine/ir';
import type { LoadSnapshot, WorkerBus } from './bus';

const SVG_NS = 'http://www.w3.org/2000/svg';

interface PinOffset {
  x: number;
  y: number;
}

interface Renderer {
  size: { w: number; h: number };
  pins: Record<string, PinOffset>;
  draw(group: SVGGElement, instId: string, params: Record<string, unknown> | undefined): void;
}

const text = (parent: Element, x: number, y: number, content: string, anchor: 'start' | 'middle' | 'end' = 'middle'): SVGTextElement => {
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('x', String(x));
  t.setAttribute('y', String(y));
  t.setAttribute('text-anchor', anchor);
  t.setAttribute('class', 'label');
  t.textContent = content;
  parent.appendChild(t);
  return t;
};

const rect = (parent: Element, x: number, y: number, w: number, h: number, cls: string): SVGRectElement => {
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

const renderers: Record<string, Renderer> = {
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
      // D-shape: rect on the left half, half-ellipse on the right.
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M 4 4 L 30 4 A 16 16 0 0 1 30 36 L 4 36 Z');
      path.setAttribute('class', 'gate-body');
      group.appendChild(path);
      text(group, 22, 24, '&', 'middle');
      text(group, 30, 56, instId, 'middle');
    },
  },
};

type Position = [number, number];

const positionOf = (inst: { position?: Position } | undefined): Position => {
  return inst?.position ?? [0, 0];
};

interface PinLookup {
  abs: PinOffset;
  type: string;
}

const buildPinLookup = (circuit: CircuitJSON): Map<string, PinLookup> => {
  const out = new Map<string, PinLookup>();
  for (const inst of circuit.components) {
    const renderer = renderers[inst.type];
    if (!renderer) continue;
    const [px, py] = positionOf(inst);
    for (const [pinName, off] of Object.entries(renderer.pins)) {
      out.set(`${inst.id}.${pinName}`, {
        abs: { x: px + off.x, y: py + off.y },
        type: inst.type,
      });
    }
  }
  return out;
};

const NET_CLASS: Record<NetState, string> = {
  0: 'wire wire-0',
  1: 'wire wire-1',
  Z: 'wire wire-Z',
  X: 'wire wire-X',
};

const LED_FILL: Record<NetState, string> = {
  0: 'var(--led-off)',
  1: 'var(--led-on)',
  Z: 'var(--led-z)',
  X: 'var(--led-x)',
};

export const mountSchematic = (
  host: HTMLElement,
  circuit: CircuitJSON,
  snapshot: LoadSnapshot,
  bus: WorkerBus,
): void => {
  host.innerHTML = '';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 600 320');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  host.appendChild(svg);

  // Wires layer goes under components so connectors don't overdraw the gate body.
  const wireLayer = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(wireLayer);
  const compLayer = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(compLayer);

  const pinAbs = buildPinLookup(circuit);

  // Track switch local state so click toggles flip immediately, without waiting
  // for a round-trip via the worker.
  const switchState = new Map<string, NetState>();

  for (const inst of circuit.components) {
    const renderer = renderers[inst.type];
    if (!renderer) {
      // Unknown type renders as a placeholder rect so the demo still works
      // if the circuit grows components beyond the preset.
      const [x, y] = positionOf(inst);
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('transform', `translate(${String(x)} ${String(y)})`);
      rect(g, 0, 0, 60, 40, 'gate-body');
      text(g, 30, 24, inst.type, 'middle');
      compLayer.appendChild(g);
      continue;
    }
    const [x, y] = positionOf(inst);
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('transform', `translate(${String(x)} ${String(y)})`);
    g.dataset.compId = inst.id;
    g.dataset.compType = inst.type;
    renderer.draw(g, inst.id, inst.params);
    compLayer.appendChild(g);

    if (inst.type === 'io.switch') {
      switchState.set(inst.id, 0);
      const handle = g.querySelector('[data-role="switch-handle"]') as SVGRectElement;
      const label = g.querySelector('[data-role="switch-label"]') as SVGTextElement;
      const refreshSwitch = (v: NetState): void => {
        handle.setAttribute('fill', v === 1 ? 'var(--led-on)' : 'var(--led-off)');
        label.textContent = String(v);
      };
      g.addEventListener('click', () => {
        const cur = switchState.get(inst.id) ?? 0;
        const next: NetState = cur === 1 ? 0 : 1;
        switchState.set(inst.id, next);
        refreshSwitch(next);
        void bus.setInput(inst.id, 'Y', next);
      });
    }
  }

  // Build wires per net.
  const wires: Array<{ line: SVGPolylineElement; netIdx: number }> = [];
  for (const net of circuit.nets) {
    const pts: PinOffset[] = [];
    for (const ep of net.endpoints) {
      const lookup = pinAbs.get(ep);
      if (lookup) pts.push(lookup.abs);
    }
    if (pts.length < 2) continue;
    // Naive routing: chain the points with a small horizontal stub on each
    // end, then a vertical jog to connect them.
    const [a, b] = [pts[0]!, pts[1]!];
    const midX = (a.x + b.x) / 2;
    const polyPoints = [
      `${String(a.x)},${String(a.y)}`,
      `${String(midX)},${String(a.y)}`,
      `${String(midX)},${String(b.y)}`,
      `${String(b.x)},${String(b.y)}`,
    ];
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', polyPoints.join(' '));
    line.setAttribute('class', 'wire wire-Z');
    wireLayer.appendChild(line);
    const netIdx = snapshot.netIndex.get(net.id);
    if (netIdx !== undefined) wires.push({ line, netIdx });
  }

  // Per-LED reference + the index of its input net for fast lookup in rAF.
  interface LedRef {
    el: SVGCircleElement;
    netIdx: number | null;
  }
  const leds: LedRef[] = [];
  for (const inst of circuit.components) {
    if (inst.type !== 'io.led') continue;
    const g = compLayer.querySelector(`[data-comp-id="${inst.id}"]`) as SVGGElement | null;
    if (!g) continue;
    const c = g.querySelector('[data-role="led"]') as SVGCircleElement | null;
    if (!c) continue;
    // Find the net wired to this LED's A pin.
    const ep = `${inst.id}.A`;
    const net = circuit.nets.find((n) => n.endpoints.includes(ep));
    const netIdx = net ? snapshot.netIndex.get(net.id) ?? null : null;
    leds.push({ el: c, netIdx });
  }

  const tick = (): void => {
    for (const w of wires) {
      const v = decodeNet(snapshot.netsView[w.netIdx]!);
      w.line.setAttribute('class', NET_CLASS[v]);
    }
    for (const led of leds) {
      if (led.netIdx === null) continue;
      const v = decodeNet(snapshot.netsView[led.netIdx]!);
      led.el.setAttribute('fill', LED_FILL[v]);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const decodeNet = (byte: number): NetState => {
  if (byte === 0) return 0;
  if (byte === 1) return 1;
  if (byte === 2) return 'Z';
  return 'X';
};
