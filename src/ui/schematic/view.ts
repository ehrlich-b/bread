// SVG schematic view. Subscribes to an EditorModel and re-renders the entire
// host on every state change. Each render owns its own requestAnimationFrame
// loop that samples the worker's SharedArrayBuffer and updates wire / LED
// colors. M4 slice 1 keeps the routing naive (M-shape between pin endpoints);
// real orthogonal routing arrives in slice 3.
//
// IMPORTANT: the data-* selectors emitted here are the contract the Playwright
// e2e suite reads. Don't rename them without updating e2e/blink_demo.spec.ts.
//   data-comp-id          — instance id on the component <g>
//   data-comp-type        — component type id on the component <g>
//   data-role="led"       — LED circle inside an io.led group
//   data-role="switch-handle"
//   data-role="switch-label"
//   polyline.wire         — every wire segment

import type { CircuitJSON, NetState } from '../../engine/ir';
import type { LoadSnapshot } from '../bus';
import type { EditorModel } from '../editor';
import { renderers, type PinOffset } from './renderers';

const SVG_NS = 'http://www.w3.org/2000/svg';

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

type Position = [number, number];

const positionOf = (inst: { position?: Position } | undefined): Position => {
  return inst?.position ?? [0, 0];
};

const decodeNet = (byte: number): NetState => {
  if (byte === 0) return 0;
  if (byte === 1) return 1;
  if (byte === 2) return 'Z';
  return 'X';
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

export const mountSchematic = (host: HTMLElement, editor: EditorModel): (() => void) => {
  let dispose = renderOnce(host, editor);
  const unsub = editor.subscribe(() => {
    dispose();
    dispose = renderOnce(host, editor);
  });
  return () => {
    dispose();
    unsub();
  };
};

const renderOnce = (host: HTMLElement, editor: EditorModel): (() => void) => {
  const { circuit, snapshot } = editor.state;
  host.innerHTML = '';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 600 320');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  host.appendChild(svg);

  const wireLayer = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(wireLayer);
  const compLayer = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(compLayer);

  const pinAbs = buildPinLookup(circuit);
  const switchState = new Map<string, NetState>();

  for (const inst of circuit.components) {
    const renderer = renderers[inst.type];
    const [x, y] = positionOf(inst);
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('transform', `translate(${String(x)} ${String(y)})`);
    g.dataset.compId = inst.id;
    g.dataset.compType = inst.type;
    if (!renderer) {
      // Unknown type: placeholder rect so the user can still see and remove it.
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('width', '60');
      r.setAttribute('height', '40');
      r.setAttribute('class', 'gate-body');
      r.setAttribute('rx', '4');
      g.appendChild(r);
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', '30');
      t.setAttribute('y', '24');
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('class', 'label');
      t.textContent = inst.type;
      g.appendChild(t);
      compLayer.appendChild(g);
      continue;
    }
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
        void editor.bus.setInput(inst.id, 'Y', next);
      });
    }
  }

  const wires = buildWires(circuit, pinAbs, snapshot, wireLayer);
  const leds = buildLedRefs(circuit, snapshot, compLayer);

  let disposed = false;
  let rafHandle = 0;
  const tick = (): void => {
    if (disposed) return;
    for (const w of wires) {
      const v = decodeNet(snapshot.netsView[w.netIdx]!);
      w.line.setAttribute('class', NET_CLASS[v]);
    }
    for (const led of leds) {
      if (led.netIdx === null) continue;
      const v = decodeNet(snapshot.netsView[led.netIdx]!);
      led.el.setAttribute('fill', LED_FILL[v]);
    }
    rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);

  return () => {
    disposed = true;
    cancelAnimationFrame(rafHandle);
  };
};

interface WireRef {
  line: SVGPolylineElement;
  netIdx: number;
}

const buildWires = (
  circuit: CircuitJSON,
  pinAbs: Map<string, PinLookup>,
  snapshot: LoadSnapshot,
  wireLayer: SVGGElement,
): WireRef[] => {
  const wires: WireRef[] = [];
  for (const net of circuit.nets) {
    const pts: PinOffset[] = [];
    for (const ep of net.endpoints) {
      const lookup = pinAbs.get(ep);
      if (lookup) pts.push(lookup.abs);
    }
    if (pts.length < 2) continue;
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
  return wires;
};

interface LedRef {
  el: SVGCircleElement;
  netIdx: number | null;
}

const buildLedRefs = (
  circuit: CircuitJSON,
  snapshot: LoadSnapshot,
  compLayer: SVGGElement,
): LedRef[] => {
  const leds: LedRef[] = [];
  for (const inst of circuit.components) {
    if (inst.type !== 'io.led') continue;
    const g = compLayer.querySelector(`[data-comp-id="${inst.id}"]`) as SVGGElement | null;
    if (!g) continue;
    const c = g.querySelector('[data-role="led"]') as SVGCircleElement | null;
    if (!c) continue;
    const ep = `${inst.id}.A`;
    const net = circuit.nets.find((n) => n.endpoints.includes(ep));
    const netIdx = net ? snapshot.netIndex.get(net.id) ?? null : null;
    leds.push({ el: c, netIdx });
  }
  return leds;
};
