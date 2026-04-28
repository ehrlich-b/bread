// SVG schematic view. Subscribes to an EditorModel and re-renders the entire
// host on every state change. Each render owns its own requestAnimationFrame
// loop that samples the worker's SharedArrayBuffer and updates wire / LED
// colors, plus a wire-drawing UI: click a pin to start a wire, click another
// pin to land it. ESC cancels.
//
// IMPORTANT: the data-* selectors emitted here are the contract the Playwright
// e2e suite reads. Don't rename them without updating the specs:
//   data-comp-id            — instance id on the component <g>
//   data-comp-type          — component type id on the component <g>
//   data-role="canvas"      — root <svg>
//   data-role="led"         — LED circle inside an io.led group
//   data-role="switch-handle"
//   data-role="switch-label"
//   data-role="pin"         — pin handle (clickable circle)
//   data-pin="<id>.<pin>"   — the endpoint id, used by wire-drawing tests
//   data-net-id="<id>"      — net id on every wire / junction belonging to it
//   polyline.wire           — every wire segment
//   circle.junction         — junction dot at multi-endpoint centroids

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

// Manhattan path between two points: horizontal stub from `a`, vertical jog,
// horizontal stub to `b`. Mirrors the M3 routing — slice 7/M7 may upgrade.
const manhattanPath = (a: PinOffset, b: PinOffset): PinOffset[] => {
  const midX = Math.round((a.x + b.x) / 2);
  return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
};

const pointsAttr = (pts: PinOffset[]): string =>
  pts.map((p) => `${String(p.x)},${String(p.y)}`).join(' ');

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
  const { circuit, snapshot, placement } = editor.state;
  host.innerHTML = '';
  host.classList.toggle('placing', placement !== null);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 600 320');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.dataset.role = 'canvas';
  host.appendChild(svg);

  const wireLayer = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(wireLayer);
  const compLayer = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(compLayer);
  // Layer for the in-progress wire rubber band — drawn above components so
  // it doesn't hide behind them as the cursor crosses gates.
  const overlayLayer = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(overlayLayer);

  const pinAbs = buildPinLookup(circuit);

  // ---- Wire-drawing state (local to this render) ------------------------
  let wireFrom: { ep: string; abs: PinOffset } | null = null;
  let pendingLine: SVGPolylineElement | null = null;

  const cancelWire = (): void => {
    if (wireFrom) {
      const prev = svg.querySelector(`[data-pin="${wireFrom.ep}"]`);
      prev?.classList.remove('pin-active');
    }
    wireFrom = null;
    if (pendingLine) {
      pendingLine.remove();
      pendingLine = null;
    }
  };

  const startOrFinishWire = (ep: string, handle: SVGCircleElement): void => {
    if (wireFrom === null) {
      const lookup = pinAbs.get(ep);
      if (!lookup) return;
      wireFrom = { ep, abs: lookup.abs };
      handle.classList.add('pin-active');
      return;
    }
    const from = wireFrom.ep;
    cancelWire();
    if (from === ep) return;
    void editor.connect(from, ep);
  };

  // Capture-phase listener so it fires before any component-level click.
  // During placement we drop a new instance and consume the event; otherwise
  // we let the click fall through to pins, switches, and selection.
  svg.addEventListener(
    'click',
    (e) => {
      const p = editor.state.placement;
      if (!p) return;
      e.stopPropagation();
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const local = pt.matrixTransform(ctm.inverse());
      const renderer = renderers[p.type];
      const sz = renderer?.size ?? { w: 60, h: 40 };
      const id = editor.generateId(p.type);
      const position: [number, number] = [
        Math.round(local.x - sz.w / 2),
        Math.round(local.y - sz.h / 2),
      ];
      editor.clearPlacement();
      void editor.addComponent({
        id,
        type: p.type,
        position,
        ...(p.params ? { params: p.params } : {}),
      });
    },
    { capture: true },
  );

  // Mouse-move on the canvas updates the rubber-band wire while a wireFrom is
  // pending. Bypass when no wire in progress to avoid pointless work.
  svg.addEventListener('mousemove', (e) => {
    if (!wireFrom) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const local = pt.matrixTransform(ctm.inverse());
    const path = manhattanPath(wireFrom.abs, { x: local.x, y: local.y });
    if (!pendingLine) {
      pendingLine = document.createElementNS(SVG_NS, 'polyline');
      pendingLine.setAttribute('class', 'wire wire-pending');
      overlayLayer.appendChild(pendingLine);
    }
    pendingLine.setAttribute('points', pointsAttr(path));
  });

  // Empty-canvas click cancels an in-progress wire.
  svg.addEventListener('click', (e) => {
    if (!wireFrom) return;
    if (editor.state.placement) return;
    const target = e.target as Element | null;
    if (target?.closest('[data-pin]')) return;
    cancelWire();
  });

  // ESC cancels placement and/or in-progress wire. Document-scoped because the
  // SVG can lose focus once the user starts moving toward a target.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    cancelWire();
    if (editor.state.placement) editor.clearPlacement();
  };
  document.addEventListener('keydown', onKey);

  for (const inst of circuit.components) {
    const renderer = renderers[inst.type];
    const [x, y] = positionOf(inst);
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('transform', `translate(${String(x)} ${String(y)})`);
    g.dataset.compId = inst.id;
    g.dataset.compType = inst.type;
    if (!renderer) {
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

    if (inst.type === 'io.switch') {
      let switchVal: NetState = 0;
      const handle = g.querySelector('[data-role="switch-handle"]') as SVGRectElement;
      const label = g.querySelector('[data-role="switch-label"]') as SVGTextElement;
      const refreshSwitch = (v: NetState): void => {
        handle.setAttribute('fill', v === 1 ? 'var(--led-on)' : 'var(--led-off)');
        label.textContent = String(v);
      };
      g.addEventListener('click', () => {
        // Wire mode and placement mode both pre-empt switch toggles via
        // capture/stopPropagation, so by the time we get here we know we
        // want a real toggle.
        switchVal = switchVal === 1 ? 0 : 1;
        refreshSwitch(switchVal);
        void editor.bus.setInput(inst.id, 'Y', switchVal);
      });
    }

    // Pin handles: clickable circles at each pin endpoint.
    for (const [pinName, off] of Object.entries(renderer.pins)) {
      const pin = document.createElementNS(SVG_NS, 'circle');
      pin.setAttribute('cx', String(off.x));
      pin.setAttribute('cy', String(off.y));
      pin.setAttribute('r', '5');
      pin.setAttribute('class', 'pin');
      pin.setAttribute('data-role', 'pin');
      pin.setAttribute('data-pin', `${inst.id}.${pinName}`);
      g.appendChild(pin);
      pin.addEventListener('click', (e) => {
        if (editor.state.placement) return;
        e.stopPropagation();
        startOrFinishWire(`${inst.id}.${pinName}`, pin);
      });
    }

    compLayer.appendChild(g);
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
    document.removeEventListener('keydown', onKey);
  };
};

interface WireRef {
  line: SVGPolylineElement;
  netIdx: number;
}

// Build wires for every net. 2-endpoint nets get a single Manhattan path;
// 3+ endpoint nets render as a star from each endpoint to the centroid plus
// a junction dot. Every segment gets the same data-net-id so the rAF loop
// can update them as one.
const buildWires = (
  circuit: CircuitJSON,
  pinAbs: Map<string, PinLookup>,
  snapshot: LoadSnapshot,
  wireLayer: SVGGElement,
): WireRef[] => {
  const wires: WireRef[] = [];

  const addSegment = (net: { id: string }, netIdx: number, pts: PinOffset[]): void => {
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', pointsAttr(pts));
    line.setAttribute('class', 'wire wire-Z');
    line.setAttribute('data-net-id', net.id);
    wireLayer.appendChild(line);
    wires.push({ line, netIdx });
  };

  for (const net of circuit.nets) {
    const pts: PinOffset[] = [];
    for (const ep of net.endpoints) {
      const lookup = pinAbs.get(ep);
      if (lookup) pts.push(lookup.abs);
    }
    if (pts.length < 2) continue;
    const netIdx = snapshot.netIndex.get(net.id);
    if (netIdx === undefined) continue;

    if (pts.length === 2) {
      addSegment(net, netIdx, manhattanPath(pts[0]!, pts[1]!));
      continue;
    }

    const cx = Math.round(pts.reduce((s, p) => s + p.x, 0) / pts.length);
    const cy = Math.round(pts.reduce((s, p) => s + p.y, 0) / pts.length);
    const center: PinOffset = { x: cx, y: cy };
    for (const p of pts) addSegment(net, netIdx, manhattanPath(p, center));

    const junction = document.createElementNS(SVG_NS, 'circle');
    junction.setAttribute('cx', String(cx));
    junction.setAttribute('cy', String(cy));
    junction.setAttribute('r', '3');
    junction.setAttribute('class', 'junction');
    junction.setAttribute('data-net-id', net.id);
    wireLayer.appendChild(junction);
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
