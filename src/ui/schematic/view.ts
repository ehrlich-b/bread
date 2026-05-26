// SVG schematic view. Subscribes to an EditorModel and re-renders the entire
// host on every state change. Each render owns its own requestAnimationFrame
// loop that samples the worker's SharedArrayBuffer and updates wire / LED
// colors, plus the editor surface: click-to-select, drag-to-move, R-to-rotate,
// Del-to-delete, click-pin / click-pin to wire, ESC to cancel.
//
// IMPORTANT: the data-* selectors emitted here are the contract the Playwright
// e2e suite reads. Don't rename them without updating the specs:
//   data-comp-id            — instance id on the component <g>
//   data-comp-type          — component type id on the component <g>
//   data-selected           — present and "true" on the currently selected <g>
//   data-role="canvas"      — root <svg>
//   data-role="led"         — LED circle inside an io.led group
//   data-role="seg-<a..g|dp>" — segment shape inside an io.7seg group
//   data-role="switch-handle"
//   data-role="switch-label"
//   data-role="pin"         — pin handle (clickable circle)
//   data-pin="<id>.<pin>"   — the endpoint id, used by wire-drawing tests
//   data-net-id="<id>"      — net id on every wire / junction belonging to it
//   polyline.wire           — every wire segment
//   circle.junction         — junction dot at multi-endpoint centroids

import type { CircuitJSON, ComponentInstanceJSON, NetState } from '../../engine/ir';
import type { LoadSnapshot } from '../bus';
import type { EditorModel } from '../editor';
import { resolveRenderer, type PinOffset } from './renderers';

const SVG_NS = 'http://www.w3.org/2000/svg';
const GRID = 10;
const DRAG_THRESHOLD_PX = 3;

// Viewport state lives at module scope so zoom/pan survive the host re-renders
// that EditorModel notifications trigger. Nothing else reads these — they're
// UI-only and don't belong on the editor state.
const BASE_VIEW_W = 600;
const BASE_VIEW_H = 320;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
let viewZoom = 1;
let viewPanX = 0;
let viewPanY = 0;

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

const applyViewBox = (svg: SVGSVGElement): void => {
  const vw = BASE_VIEW_W / viewZoom;
  const vh = BASE_VIEW_H / viewZoom;
  svg.setAttribute(
    'viewBox',
    `${String(viewPanX)} ${String(viewPanY)} ${String(vw)} ${String(vh)}`,
  );
};

// Zoom around an SVG-space anchor: the point at (centerX, centerY) stays put
// in screen coordinates while the viewBox shrinks/grows. The math is the
// fractional-position invariant: (anchor - new_pan) / new_vw == (anchor - pan) / vw.
const zoomBy = (svg: SVGSVGElement, factor: number, centerX: number, centerY: number): void => {
  const newZoom = clamp(viewZoom * factor, MIN_ZOOM, MAX_ZOOM);
  if (newZoom === viewZoom) return;
  const ratio = newZoom / viewZoom;
  viewPanX = centerX - (centerX - viewPanX) / ratio;
  viewPanY = centerY - (centerY - viewPanY) / ratio;
  viewZoom = newZoom;
  applyViewBox(svg);
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

// 7-seg segments only have two visible states: lit when their net resolves
// to 1, otherwise dark. Z/X collapse to dark since a real LED segment
// without forward current does not glow.
const SEG_FILL: Record<NetState, string> = {
  0: 'var(--seg-off)',
  1: 'var(--seg-on)',
  Z: 'var(--seg-off)',
  X: 'var(--seg-off)',
};

const SEG_PINS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'] as const;

type Position = [number, number];

const positionOf = (inst: { position?: Position } | undefined): Position => {
  return inst?.position ?? [0, 0];
};

const rotationOf = (inst: { rotation?: number } | undefined): number => {
  const r = ((inst?.rotation ?? 0) % 360 + 360) % 360;
  return Math.round(r / 90) * 90;
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

// Apply an SVG-clockwise rotation about (sz.w/2, sz.h/2) to a local pin offset.
// Used for absolute pin placement during wire routing — the SVG <g> transform
// handles the visual rotation independently.
const rotatePin = (p: PinOffset, sz: { w: number; h: number }, deg: number): PinOffset => {
  if (deg === 0) return p;
  const cx = sz.w / 2;
  const cy = sz.h / 2;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - cx;
  const dy = p.y - cy;
  return {
    x: cx + dx * cos + dy * sin,
    y: cy - dx * sin + dy * cos,
  };
};

const buildPinLookup = (circuit: CircuitJSON): Map<string, PinLookup> => {
  const out = new Map<string, PinLookup>();
  for (const inst of circuit.components) {
    const renderer = resolveRenderer(inst.type, inst.params);
    if (!renderer) continue;
    const [px, py] = positionOf(inst);
    const rot = rotationOf(inst);
    for (const [pinName, off] of Object.entries(renderer.pins)) {
      const r = rotatePin(off, renderer.size, rot);
      out.set(`${inst.id}.${pinName}`, {
        abs: { x: px + r.x, y: py + r.y },
        type: inst.type,
      });
    }
  }
  return out;
};

const manhattanPath = (a: PinOffset, b: PinOffset): PinOffset[] => {
  const midX = Math.round((a.x + b.x) / 2);
  return [a, { x: midX, y: a.y }, { x: midX, y: b.y }, b];
};

const pointsAttr = (pts: PinOffset[]): string =>
  pts.map((p) => `${String(p.x)},${String(p.y)}`).join(' ');

const clientToLocal = (
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): PinOffset | null => {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const local = pt.matrixTransform(ctm.inverse());
  return { x: local.x, y: local.y };
};

const transformFor = (inst: ComponentInstanceJSON, sz: { w: number; h: number }): string => {
  const [x, y] = positionOf(inst);
  const r = rotationOf(inst);
  if (r === 0) return `translate(${String(x)} ${String(y)})`;
  return `translate(${String(x)} ${String(y)}) rotate(${String(r)} ${String(sz.w / 2)} ${String(sz.h / 2)})`;
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
  const { circuit, snapshot, placement, selection } = editor.state;
  host.innerHTML = '';
  host.classList.toggle('placing', placement !== null);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.dataset.role = 'canvas';
  applyViewBox(svg);
  host.appendChild(svg);

  // Grid pattern: 10px dots in user coords, so they stay aligned to the snap
  // grid as the viewBox pans/zooms. The pattern lives in <defs> and a fixed
  // huge background rect draws it across the whole pannable area.
  const defs = document.createElementNS(SVG_NS, 'defs');
  const pattern = document.createElementNS(SVG_NS, 'pattern');
  pattern.setAttribute('id', 'schematic-grid');
  pattern.setAttribute('x', '0');
  pattern.setAttribute('y', '0');
  pattern.setAttribute('width', String(GRID));
  pattern.setAttribute('height', String(GRID));
  pattern.setAttribute('patternUnits', 'userSpaceOnUse');
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', String(GRID / 2));
  dot.setAttribute('cy', String(GRID / 2));
  dot.setAttribute('r', '0.8');
  dot.setAttribute('class', 'grid-dot');
  pattern.appendChild(dot);
  defs.appendChild(pattern);
  svg.appendChild(defs);

  const gridBg = document.createElementNS(SVG_NS, 'rect');
  gridBg.setAttribute('x', '-2000');
  gridBg.setAttribute('y', '-2000');
  gridBg.setAttribute('width', '4000');
  gridBg.setAttribute('height', '4000');
  gridBg.setAttribute('fill', 'url(#schematic-grid)');
  gridBg.setAttribute('class', 'grid-bg');
  svg.appendChild(gridBg);

  const wireLayer = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(wireLayer);
  const compLayer = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(compLayer);
  const overlayLayer = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(overlayLayer);

  const pinAbs = buildPinLookup(circuit);

  // ---- Wire-drawing state (local) --------------------------------------
  let wireFrom: { ep: string; abs: PinOffset } | null = null;
  let pendingLine: SVGPolylineElement | null = null;
  // Drag suppression: set when a real drag completes, consumed by the next
  // click on the same component <g>. Prevents the post-drag click from
  // re-selecting after we just committed a move.
  let dragJustEnded = false;

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

  // ---- Background canvas: placement + selection clear ------------------
  svg.addEventListener(
    'click',
    (e) => {
      const p = editor.state.placement;
      if (p) {
        e.stopPropagation();
        const local = clientToLocal(svg, e.clientX, e.clientY);
        if (!local) return;
        const renderer = resolveRenderer(p.type, p.params);
        const sz = renderer?.size ?? { w: 60, h: 40 };
        const id = editor.generateId(p.type);
        const x = Math.round((local.x - sz.w / 2) / GRID) * GRID;
        const y = Math.round((local.y - sz.h / 2) / GRID) * GRID;
        editor.clearPlacement();
        void editor.addComponent({
          id,
          type: p.type,
          position: [x, y],
          ...(p.params ? { params: p.params } : {}),
        });
      }
    },
    { capture: true },
  );

  svg.addEventListener('mousemove', (e) => {
    if (!wireFrom) return;
    const local = clientToLocal(svg, e.clientX, e.clientY);
    if (!local) return;
    if (!pendingLine) {
      pendingLine = document.createElementNS(SVG_NS, 'polyline');
      pendingLine.setAttribute('class', 'wire wire-pending');
      overlayLayer.appendChild(pendingLine);
    }
    pendingLine.setAttribute('points', pointsAttr(manhattanPath(wireFrom.abs, local)));
  });

  // Empty-canvas click clears wire-in-progress AND deselects.
  svg.addEventListener('click', (e) => {
    if (editor.state.placement) return;
    const target = e.target as Element | null;
    if (target?.closest('[data-pin]')) return;
    if (target?.closest('[data-comp-id]')) return;
    if (wireFrom) {
      cancelWire();
      return;
    }
    if (editor.state.selection.size > 0) editor.clearSelection();
  });

  // ---- Zoom / pan ------------------------------------------------------
  // Plain wheel pans (matches Figma / trackpad two-finger scroll).
  // Cmd/Ctrl+wheel — including trackpad pinch, which browsers report with
  // ctrlKey=true — zooms toward the cursor. preventDefault is required to
  // suppress the browser's default page scroll / zoom.
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const local = clientToLocal(svg, e.clientX, e.clientY);
        if (!local) return;
        const factor = Math.exp(-e.deltaY * 0.002);
        zoomBy(svg, factor, local.x, local.y);
        return;
      }
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      viewPanX += e.deltaX / ctm.a;
      viewPanY += e.deltaY / ctm.d;
      applyViewBox(svg);
    },
    { passive: false },
  );

  // Middle-mouse drag pans. Component / pin mousedown handlers all bail on
  // e.button !== 0 so this only fires on a plain middle press.
  svg.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const initPanX = viewPanX;
    const initPanY = viewPanY;
    const onMove = (em: MouseEvent): void => {
      viewPanX = initPanX - (em.clientX - startX) / ctm.a;
      viewPanY = initPanY - (em.clientY - startY) / ctm.d;
      applyViewBox(svg);
    };
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // ---- Document-level keyboard ----------------------------------------
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      cancelWire();
      if (editor.state.placement) editor.clearPlacement();
      return;
    }
    // Don't steal keys while the user is typing in an input.
    const ae = document.activeElement;
    if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement || ae instanceof HTMLSelectElement) {
      return;
    }
    // Undo / redo. Cmd-Z / Ctrl-Z, Cmd-Shift-Z / Ctrl-Shift-Z. Also Ctrl-Y
    // for the Windows-style redo. These don't depend on selection.
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) void editor.redo();
      else void editor.undo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      void editor.redo();
      return;
    }
    // Zoom controls. Center the zoom on the viewBox midpoint so a centered
    // circuit stays centered. `0` resets the view.
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      const vw = BASE_VIEW_W / viewZoom;
      const vh = BASE_VIEW_H / viewZoom;
      zoomBy(svg, 1.2, viewPanX + vw / 2, viewPanY + vh / 2);
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      const vw = BASE_VIEW_W / viewZoom;
      const vh = BASE_VIEW_H / viewZoom;
      zoomBy(svg, 1 / 1.2, viewPanX + vw / 2, viewPanY + vh / 2);
      return;
    }
    if (e.key === '0') {
      e.preventDefault();
      viewZoom = 1;
      viewPanX = 0;
      viewPanY = 0;
      applyViewBox(svg);
      return;
    }
    const sel = editor.state.selection;
    if (sel.size === 0) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      for (const id of sel) void editor.removeComponent(id);
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      for (const id of sel) {
        const inst = editor.state.circuit.components.find((c) => c.id === id);
        if (!inst) continue;
        const next = (rotationOf(inst) + 90) % 360;
        void editor.updateComponent(id, { rotation: next });
      }
    }
  };
  document.addEventListener('keydown', onKey);

  // ---- Components -----------------------------------------------------
  for (const inst of circuit.components) {
    const renderer = resolveRenderer(inst.type, inst.params);
    const g = document.createElementNS(SVG_NS, 'g');
    g.dataset.compId = inst.id;
    g.dataset.compType = inst.type;
    if (selection.has(inst.id)) g.dataset.selected = 'true';
    if (!renderer) {
      g.setAttribute('transform', `translate(${String(positionOf(inst)[0])} ${String(positionOf(inst)[1])})`);
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
    g.setAttribute('transform', transformFor(inst, renderer.size));
    renderer.draw(g, inst.id, inst.params);

    let switchVal: NetState = 0;
    let refreshSwitch: ((v: NetState) => void) | null = null;
    if (inst.type === 'io.switch') {
      const handle = g.querySelector('[data-role="switch-handle"]') as SVGRectElement;
      const label = g.querySelector('[data-role="switch-label"]') as SVGTextElement;
      refreshSwitch = (v: NetState): void => {
        handle.setAttribute('fill', v === 1 ? 'var(--led-on)' : 'var(--led-off)');
        label.textContent = String(v);
      };
    }

    // Pin handles
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

    // Drag-to-move + click-to-select
    g.addEventListener('mousedown', (e) => {
      if (editor.state.placement) return;
      const target = e.target as Element | null;
      if (target?.closest('[data-pin]')) return;
      if (target?.closest('[data-role="switch-handle"]')) return;
      if (e.button !== 0) return;
      e.preventDefault();

      const startClient = { x: e.clientX, y: e.clientY };
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const sx = ctm.a;
      const sy = ctm.d;
      const initial = positionOf(inst);
      let moved = false;
      let curX = initial[0];
      let curY = initial[1];

      const onMove = (em: MouseEvent): void => {
        const dx = (em.clientX - startClient.x) / sx;
        const dy = (em.clientY - startClient.y) / sy;
        if (!moved && Math.abs(em.clientX - startClient.x) < DRAG_THRESHOLD_PX && Math.abs(em.clientY - startClient.y) < DRAG_THRESHOLD_PX) {
          return;
        }
        moved = true;
        curX = initial[0] + dx;
        curY = initial[1] + dy;
        g.setAttribute('transform', transformFor({ ...inst, position: [curX, curY] }, renderer.size));
      };

      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (!moved) return;
        const sx2 = Math.round(curX / GRID) * GRID;
        const sy2 = Math.round(curY / GRID) * GRID;
        dragJustEnded = true;
        // Reset the suppress-flag after the click event has had a chance to fire.
        setTimeout(() => {
          dragJustEnded = false;
        }, 0);
        if (sx2 === initial[0] && sy2 === initial[1]) return;
        void editor.updateComponent(inst.id, { position: [sx2, sy2] });
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    g.addEventListener('click', (e) => {
      if (editor.state.placement) return;
      if (dragJustEnded) return;
      const target = e.target as Element | null;
      if (target?.closest('[data-pin]')) return;
      if (wireFrom) return;
      e.stopPropagation();
      // Switches preserve their M3 contract: a plain click toggles. Hold
      // Shift/Cmd to fall through to selection so they're still editable.
      if (inst.type === 'io.switch' && refreshSwitch && !e.shiftKey && !e.metaKey) {
        switchVal = switchVal === 1 ? 0 : 1;
        refreshSwitch(switchVal);
        void editor.bus.setInput(inst.id, 'Y', switchVal);
        return;
      }
      const additive = e.shiftKey || e.metaKey;
      editor.select(inst.id, additive ? 'add' : 'replace');
    });

    compLayer.appendChild(g);
  }

  const wires = buildWires(circuit, pinAbs, snapshot, wireLayer);
  const leds = buildLedRefs(circuit, snapshot, compLayer);
  const segs = buildSegRefs(circuit, snapshot, compLayer);

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
    for (const s of segs) {
      if (s.netIdx === null) continue;
      const v = decodeNet(snapshot.netsView[s.netIdx]!);
      s.el.setAttribute('fill', SEG_FILL[v]);
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

interface SegRef {
  el: SVGRectElement;
  netIdx: number | null;
}

// Each io.7seg instance contributes 8 segment refs (a/b/c/d/e/f/g/dp). A
// segment without a wired pin gets netIdx=null and is skipped in tick().
const buildSegRefs = (
  circuit: CircuitJSON,
  snapshot: LoadSnapshot,
  compLayer: SVGGElement,
): SegRef[] => {
  const segs: SegRef[] = [];
  for (const inst of circuit.components) {
    if (inst.type !== 'io.7seg') continue;
    const g = compLayer.querySelector(`[data-comp-id="${inst.id}"]`) as SVGGElement | null;
    if (!g) continue;
    for (const pin of SEG_PINS) {
      const el = g.querySelector(`[data-role="seg-${pin}"]`) as SVGRectElement | null;
      if (!el) continue;
      const ep = `${inst.id}.${pin}`;
      const net = circuit.nets.find((n) => n.endpoints.includes(ep));
      const netIdx = net ? snapshot.netIndex.get(net.id) ?? null : null;
      segs.push({ el, netIdx });
    }
  }
  return segs;
};
