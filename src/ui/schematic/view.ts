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
//   data-wire-net="<id>"    — net id on an invisible wire hit stroke
//   polyline.wire           — every wire segment
//   data-wire-group         — visual bundle identity; never a simulation net
//   data-role="wire-bundle" — thick trunk with width and live value
//   data-role="wire-bit"    — individual, probeable fan-in/out paths
//   circle.junction         — junction dot at multi-endpoint centroids

import type { CircuitJSON, ComponentInstanceJSON, NetState } from '../../engine/ir';
import type { LoadSnapshot } from '../bus';
import type { EditorModel } from '../editor';
import { runtimeSignalNet } from '../inspector/signals';
import { showBusDialog } from '../bus_dialog';
import { shortcutBlocked } from '../shortcuts';
import { waveformValue } from '../waveform';
import { resolveRenderer, type PinOffset } from './renderers';
import { groupWires, type WireGroup } from './wire_groups';
import { mountTouch } from './touch';
import type { TouchPoint } from './gestures';

const SVG_NS = 'http://www.w3.org/2000/svg';
const GRID = 10;
const DRAG_THRESHOLD_PX = 3;

// Viewport state lives at module scope so zoom/pan survive the host re-renders
// that EditorModel notifications trigger. Nothing else reads these — they're
// UI-only and don't belong on the editor state.
const BASE_VIEW_W = 600;
const BASE_VIEW_H = 320;
const MIN_ZOOM = 0.05;
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
  outward: PinOffset;
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
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  };
};

const buildPinLookup = (circuit: CircuitJSON): Map<string, PinLookup> => {
  const out = new Map<string, PinLookup>();
  for (const inst of circuit.components) {
    const renderer = resolveRenderer(inst.type, inst.params, circuit.definitions);
    if (!renderer) continue;
    const [px, py] = positionOf(inst);
    const rot = rotationOf(inst);
    for (const [pinName, off] of Object.entries(renderer.pins)) {
      const r = rotatePin(off, renderer.size, rot);
      const normal = rotatePin({ x: off.x + (off.x === 0 ? -1 : off.x === renderer.size.w ? 1 : 0),
        y: off.y + (off.y === 0 ? -1 : off.y === renderer.size.h ? 1 : 0) }, renderer.size, rot);
      out.set(`${inst.id}.${pinName}`, {
        abs: { x: px + r.x, y: py + r.y },
        outward: { x: normal.x - r.x, y: normal.y - r.y },
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
  let grouped = true;
  let lastTouch = -Infinity;
  const rememberTouch = (): void => { lastTouch = performance.now(); };
  const rememberPointer = (event: PointerEvent): void => {
    const target = event.target as Element | null;
    // A fresh pointer on a menu button is a deliberate action, unlike the
    // compatibility click retargeted there when a canvas long press ends.
    if (event.pointerType !== 'touch' || !target?.closest('svg[data-role="canvas"]')) lastTouch = -Infinity;
  };
  // A tap is dispatched through the existing click handlers below. Suppress
  // the browser's subsequent compatibility click, even after a re-render.
  const suppressTouchClick = (event: MouseEvent): void => {
    if (!event.isTrusted) return;
    const target = event.target as Element | null;
    const recentTouch = performance.now() - lastTouch < 700;
    if (target !== host && !target?.closest('svg[data-role="canvas"]')
      && !(recentTouch && target?.closest('.touch-actions'))) return;
    const pointerType = (event as PointerEvent).pointerType;
    if (pointerType === 'touch' || (!pointerType && event.detail > 0 && recentTouch)) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  host.addEventListener('click', suppressTouchClick, { capture: true });
  host.addEventListener('pointerdown', rememberPointer, { capture: true });
  const toggleGrouping = (): boolean => { grouped = !grouped; return grouped; };
  let dispose = renderOnce(host, editor, grouped, toggleGrouping, rememberTouch);
  const unsub = editor.subscribe(() => {
    dispose();
    dispose = renderOnce(host, editor, grouped, toggleGrouping, rememberTouch);
  });
  return () => {
    dispose();
    unsub();
    host.removeEventListener('click', suppressTouchClick, { capture: true });
    host.removeEventListener('pointerdown', rememberPointer, { capture: true });
  };
};

const renderOnce = (host: HTMLElement, editor: EditorModel, grouped: boolean, toggleGrouping: () => boolean, rememberTouch: () => void): (() => void) => {
  const { circuit, snapshot, switchValues, placement, selection } = editor.state;
  host.innerHTML = '';
  host.classList.toggle('placing', placement !== null);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('aria-label', 'Circuit canvas');
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
  const componentGroups = new Map<string, SVGGElement>();
  const overlayLayer = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(overlayLayer);
  const fit = document.createElement('button'); fit.type = 'button';
  fit.textContent = 'Fit circuit'; fit.className = 'schematic-fit';
  fit.addEventListener('click', () => {
    if (circuit.components.length === 0) return;
    const bounds = compLayer.getBBox();
    viewZoom = clamp(Math.min(BASE_VIEW_W / (bounds.width + 80), BASE_VIEW_H / (bounds.height + 80)), MIN_ZOOM, MAX_ZOOM);
    viewPanX = bounds.x - (BASE_VIEW_W / viewZoom - bounds.width) / 2;
    viewPanY = bounds.y - (BASE_VIEW_H / viewZoom - bounds.height) / 2;
    applyViewBox(svg);
  });
  host.append(fit);
  const groupToggle = document.createElement('button'); groupToggle.type = 'button';
  groupToggle.textContent = 'Group wires'; groupToggle.className = 'schematic-group';
  groupToggle.setAttribute('aria-pressed', String(grouped));
  groupToggle.title = 'Bundle consecutive bus bits. Turn off to show individual wires.';
  groupToggle.addEventListener('click', () => {
    grouped = toggleGrouping();
    groupToggle.setAttribute('aria-pressed', String(grouped));
    wireLayer.innerHTML = '';
    ({ wires, bundles } = buildWires(circuit, pinAbs, snapshot, wireLayer, grouped));
  });
  host.append(groupToggle);

  const pinAbs = buildPinLookup(circuit);

  // ---- Wire-drawing state (local) --------------------------------------
  let wireFrom: { ep: string; abs: PinOffset; handle: SVGCircleElement } | null = null;
  let pendingLine: SVGPolylineElement | null = null;
  let disposeBusDialog: (() => void) | null = null;
  // Drag suppression: set when a real drag completes, consumed by the next
  // click on the same component <g>. Prevents the post-drag click from
  // re-selecting after we just committed a move.
  let dragJustEnded = false;
  let touchMenu: HTMLDivElement | null = null;
  const closeTouchMenu = (): void => { touchMenu?.remove(); touchMenu = null; };

  const cancelWire = (): void => {
    if (wireFrom) {
      wireFrom.handle.classList.remove('pin-active');
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
      wireFrom = { ep, abs: lookup.abs, handle };
      handle.classList.add('pin-active');
      return;
    }
    const from = wireFrom.ep;
    cancelWire();
    if (from === ep) return;
    if (editor.state.busWiring) {
      try { disposeBusDialog?.(); disposeBusDialog = showBusDialog(editor, from, ep); }
      catch (error) { editor.reportError(error); }
    } else void editor.connect(from, ep);
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
        const renderer = resolveRenderer(p.type, p.params, circuit.definitions);
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
    const netId = target?.closest('[data-net-id]')?.getAttribute('data-net-id')
      ?? target?.closest('[data-wire-net]')?.getAttribute('data-wire-net');
    if (editor.state.probing === 'net' && netId) {
      void editor.addNetProbe(netId).then(() => editor.setProbing(null)).catch(() => {});
      return;
    }
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
    if (shortcutBlocked(e) || e.repeat || e.altKey) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeTouchMenu();
      cancelWire();
      if (editor.state.placement) editor.clearPlacement();
      if (editor.state.probing) editor.setProbing(null);
      if (editor.state.busWiring) editor.setBusWiring(false);
      return;
    }
    // Undo / redo. Cmd-Z / Ctrl-Z, Cmd-Shift-Z / Ctrl-Shift-Z. Also Ctrl-Y
    // for the Windows-style redo. These don't depend on selection.
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) void editor.redo().catch(() => {});
      else void editor.undo().catch(() => {});
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      void editor.redo().catch(() => {});
      return;
    }
    if (mod) return;
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault(); fit.click(); return;
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
      for (const id of sel) void editor.removeComponent(id).catch(() => {});
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      for (const id of sel) {
        void editor.rotateComponent(id).catch(() => {});
      }
    }
  };
  document.addEventListener('keydown', onKey);

  // ---- Components -----------------------------------------------------
  for (const inst of circuit.components) {
    const renderer = resolveRenderer(inst.type, inst.params, circuit.definitions);
    const g = document.createElementNS(SVG_NS, 'g');
    componentGroups.set(inst.id, g);
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
    renderer.draw(g, inst.label || inst.id, inst.params);

    if (inst.type === 'io.switch') {
      const handle = g.querySelector('[data-role="switch-handle"]') as SVGRectElement;
      const label = g.querySelector('[data-role="switch-label"]') as SVGTextElement;
      const value = switchValues.get(inst.id) ?? 0;
      handle.setAttribute('fill', value === 1 ? 'var(--led-on)' : 'var(--led-off)');
      label.textContent = String(value);
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
      if (circuit.probes?.some(probe => probe.nets.includes(runtimeSignalNet(circuit, inst, pinName)))) pin.dataset.probed = 'true';
      g.appendChild(pin);
      pin.addEventListener('click', (e) => {
        if (editor.state.placement) return;
        e.stopPropagation();
        if (editor.state.probing) {
          void editor.addPinProbe(`${inst.id}.${pinName}`, editor.state.probing === 'bus').then(() => editor.setProbing(null)).catch(() => {});
        } else startOrFinishWire(`${inst.id}.${pinName}`, pin);
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
      if (inst.type === 'io.switch' && !e.shiftKey && !e.metaKey) {
        // The model reports failures and orders the toggle with pending reloads.
        void editor.toggleSwitch(inst.id).catch(() => {});
        return;
      }
      const additive = e.shiftKey || e.metaKey;
      editor.select(inst.id, additive ? 'add' : 'replace');
    });

    compLayer.appendChild(g);
  }

  let { wires, bundles } = buildWires(circuit, pinAbs, snapshot, wireLayer, grouped);
  const leds = buildLedRefs(circuit, snapshot, componentGroups);
  const segs = buildSegRefs(circuit, snapshot, componentGroups);

  // Touch never changes the mouse drag threshold or keyboard contracts.
  // Keep previews local until release; a second finger or cancellation rolls
  // a component preview back without creating an undo entry.
  let touchDrag: {
    start: TouchPoint; sx: number; sy: number; panX: number; panY: number;
    component?: { inst: ComponentInstanceJSON; group: SVGGElement; size: { w: number; h: number } };
  } | null = null;
  const cancelTouchDrag = (): void => {
    const component = touchDrag?.component;
    if (component) component.group.setAttribute('transform', transformFor(component.inst, component.size));
    touchDrag = null;
  };
  const showTouchMenu = (target: Element, point: TouchPoint): void => {
    closeTouchMenu();
    const menu = document.createElement('div'); menu.className = 'touch-actions';
    menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', 'Canvas actions');
    const button = (label: string, action: () => void): HTMLButtonElement => {
      const el = document.createElement('button'); el.type = 'button'; el.textContent = label;
      el.addEventListener('click', () => { closeTouchMenu(); action(); }); menu.append(el); return el;
    };
    const id = target.closest('[data-comp-id]')?.getAttribute('data-comp-id');
    const endpoint = target.closest('[data-pin]')?.getAttribute('data-pin');
    const net = target.closest('[data-net-id]')?.getAttribute('data-net-id')
      ?? target.closest('[data-wire-net]')?.getAttribute('data-wire-net');
    if (id) {
      button('Select', () => editor.select(id));
      button('Rotate', () => { void editor.rotateComponent(id).catch(() => {}); });
      button('Delete', () => { void editor.removeComponent(id).catch(() => {}); });
    }
    if (endpoint) {
      button('Probe pin', () => { void editor.addPinProbe(endpoint, false).catch(() => {}); });
      button('Probe bus', () => { void editor.addPinProbe(endpoint, true).catch(() => {}); });
    } else if (net) {
      button('Probe net', () => { void editor.addNetProbe(net).catch(() => {}); });
    } else {
      button('Probe pin', () => editor.setProbing('net'));
    }
    if (!id) {
      button('Undo', () => { void editor.undo().catch(() => {}); }).disabled = !editor.canUndo();
      button('Redo', () => { void editor.redo().catch(() => {}); }).disabled = !editor.canRedo();
    }
    button('Cancel action', () => {
      cancelWire(); editor.clearPlacement(); editor.setProbing(null); editor.setBusWiring(false);
    });
    button('Close actions', () => {});
    touchMenu = menu; host.append(menu);
    const bounds = host.getBoundingClientRect(); const size = menu.getBoundingClientRect();
    menu.style.left = `${clamp(point.x - bounds.x, 0, Math.max(0, bounds.width - size.width - 2))}px`;
    menu.style.top = `${clamp(point.y - bounds.y, 0, Math.max(0, bounds.height - size.height - 2))}px`;
  };
  const disposeTouch = mountTouch(svg, {
    begin: (target, point) => {
      closeTouchMenu(); cancelTouchDrag();
      const ctm = svg.getScreenCTM(); if (!ctm) return;
      if (target.closest('[data-pin]') || target.closest('[data-role="switch-handle"]')) return;
      const id = target.closest('[data-comp-id]')?.getAttribute('data-comp-id');
      const inst = circuit.components.find(component => component.id === id);
      const renderer = inst && resolveRenderer(inst.type, inst.params, circuit.definitions);
      touchDrag = { start: point, sx: ctm.a, sy: ctm.d, panX: viewPanX, panY: viewPanY };
      if (!editor.state.placement && inst && renderer) {
        touchDrag.component = { inst, group: componentGroups.get(inst.id)!, size: renderer.size };
      }
    },
    tap: (target, point) => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: point.x, clientY: point.y }));
    },
    drag: (_target, _start, point, commit) => {
      if (!touchDrag) return;
      const drag = touchDrag;
      const dx = (point.x - drag.start.x) / drag.sx; const dy = (point.y - drag.start.y) / drag.sy;
      if (drag.component) {
        const { inst, group, size } = drag.component; const initial = positionOf(inst);
        const x = commit ? Math.round((initial[0] + dx) / GRID) * GRID : initial[0] + dx;
        const y = commit ? Math.round((initial[1] + dy) / GRID) * GRID : initial[1] + dy;
        group.setAttribute('transform', transformFor({ ...inst, position: [x, y] }, size));
        if (commit) {
          touchDrag = null;
          if (x !== initial[0] || y !== initial[1]) void editor.updateComponent(inst.id, { position: [x, y] }).catch(() => {});
        }
      } else {
        viewPanX = drag.panX - dx; viewPanY = drag.panY - dy; applyViewBox(svg);
        if (commit) touchDrag = null;
      }
    },
    pinchStart: () => { closeTouchMenu(); cancelTouchDrag(); cancelWire(); },
    pinch: ({ from, to, scale }) => {
      const anchor = clientToLocal(svg, from.x, from.y); if (!anchor) return;
      zoomBy(svg, scale, anchor.x, anchor.y);
      const next = clientToLocal(svg, to.x, to.y); if (!next) return;
      viewPanX += anchor.x - next.x; viewPanY += anchor.y - next.y; applyViewBox(svg);
    },
    hold: showTouchMenu,
    cancel: cancelTouchDrag,
  }, rememberTouch);

  let disposed = false;
  let rafHandle = 0;
  const tick = (): void => {
    if (disposed) return;
    for (const w of wires) {
      const v = decodeNet(snapshot.netsView[w.netIdx]!);
      if (v === w.value) continue;
      w.value = v;
      w.line.setAttribute('class', NET_CLASS[v]);
      w.line.dataset.value = String(v);
    }
    for (const bundle of bundles) {
      let changed = !bundle.initialized;
      for (let bit = 0; bit < bundle.netIndices.length; bit++) {
        const value = snapshot.netsView[bundle.netIndices[bit]!]!;
        if (bundle.values[bit] !== value) { bundle.values[bit] = value; changed = true; }
      }
      if (!changed) continue;
      bundle.initialized = true;
      const value = waveformValue(Array.from(bundle.values, decodeNet));
      bundle.line.setAttribute('class', `wire wire-bus${value.kind === 'bus' ? '' : ` wire-${value.kind}`}`);
      bundle.line.dataset.value = value.text;
      bundle.line.dataset.binary = value.binary;
      bundle.label.textContent = `/${bundle.netIndices.length} ${value.kind === 'bus' ? '0x' : ''}${value.text}`;
      bundle.hint.textContent = `${value.text} (${value.binary})\n${bundle.description}`;
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
    disposeTouch(); closeTouchMenu();
    disposeBusDialog?.();
    document.removeEventListener('keydown', onKey);
  };
};

interface WireRef {
  line: SVGElement;
  netIdx: number;
  value?: NetState;
}

interface BundleRef {
  line: SVGPolylineElement;
  label: SVGTextElement;
  hint: SVGTitleElement;
  description: string;
  netIndices: number[];
  values: Uint8Array;
  initialized: boolean;
}

const buildWires = (
  circuit: CircuitJSON,
  pinAbs: Map<string, PinLookup>,
  snapshot: LoadSnapshot,
  wireLayer: SVGGElement,
  grouped: boolean,
): { wires: WireRef[]; bundles: BundleRef[] } => {
  const wires: WireRef[] = [];
  const bundles: BundleRef[] = [];
  const model = grouped ? groupWires(circuit) : { groups: [], singles: circuit.nets };
  const singles = [...model.singles];
  const probed = new Set(circuit.probes?.flatMap(probe => probe.nets));

  // Hit strokes stay behind every visible wire and component. Their width
  // is in screen pixels so touch targets remain usable when zoomed out.
  const hitLayer = document.createElementNS(SVG_NS, 'g'); wireLayer.appendChild(hitLayer);
  const addHit = (tag: 'path' | 'polyline', attr: 'd' | 'points', geometry: string, net: string): void => {
    const hit = document.createElementNS(SVG_NS, tag);
    hit.setAttribute(attr, geometry); hit.setAttribute('class', 'wire-hit');
    hit.setAttribute('data-wire-net', net); hitLayer.appendChild(hit);
  };

  const title = (el: SVGElement, text: string): SVGTitleElement => {
    const hint = document.createElementNS(SVG_NS, 'title'); hint.textContent = text; el.appendChild(hint);
    return hint;
  };

  const addGroup = (group: WireGroup): void => {
    if (group.nets.some(net => !snapshot.netIndex.has(net.id) || net.endpoints.some(ep => !pinAbs.has(ep)))) {
      singles.push(...group.nets); return;
    }
    const layer = document.createElementNS(SVG_NS, 'g'); layer.dataset.wireGroup = group.id;
    wireLayer.appendChild(layer);
    const paths = group.nets.map(() => [] as string[]);
    const branches = group.branches.map(branch => {
      const pins = branch.endpoints.map(ep => pinAbs.get(ep)!);
      const join = { x: pins.reduce((sum, pin) => sum + pin.abs.x + 24 * pin.outward.x, 0) / pins.length,
        y: pins.reduce((sum, pin) => sum + pin.abs.y + 24 * pin.outward.y, 0) / pins.length };
      pins.forEach((pin, bit) => {
        const tip = { x: pin.abs.x + 12 * pin.outward.x, y: pin.abs.y + 12 * pin.outward.y };
        paths[branch.lanes[bit]!]!.push(`M ${pin.abs.x} ${pin.abs.y} L ${tip.x} ${tip.y} L ${join.x} ${join.y}`);
      });
      return { ...branch, join };
    });
    const center = { x: branches.reduce((sum, branch) => sum + branch.join.x, 0) / branches.length,
      y: branches.reduce((sum, branch) => sum + branch.join.y, 0) / branches.length };
    const addTrunk = (lanes: number[], pts: PinOffset[]): void => {
      if (lanes.length === 1) {
        paths[lanes[0]!]!.push(`M ${pts.map(p => `${p.x} ${p.y}`).join(' L ')}`); return;
      }
      const line = document.createElementNS(SVG_NS, 'polyline');
      line.setAttribute('points', pointsAttr(pts)); line.setAttribute('class', 'wire wire-bus wire-Z');
      line.dataset.role = 'wire-bundle'; line.dataset.width = String(lanes.length);
      const description = lanes.map(lane => `${lane}: ${group.nets[lane]!.endpoints.join(' ↔ ')}`).join('\n')
        + '\nProbe or edit a bit at its pin or fan-out wire.';
      const hint = title(line, description);
      if (lanes.some(lane => probed.has(group.nets[lane]!.id))) line.dataset.probed = 'true';
      const label = document.createElementNS(SVG_NS, 'text');
      // Put the label above the longest route segment, away from the pins.
      let a = pts[0]!; let b = pts[1]!;
      for (let i = 1; i < pts.length - 1; i++) {
        const from = pts[i]!; const to = pts[i + 1]!;
        if (Math.hypot(to.x - from.x, to.y - from.y) > Math.hypot(b.x - a.x, b.y - a.y)) { a = from; b = to; }
      }
      label.setAttribute('x', String((a.x + b.x) / 2 + (a.x === b.x ? 8 : 0)));
      label.setAttribute('y', String((a.y + b.y) / 2 - 8));
      label.setAttribute('class', 'wire-bus-label'); label.dataset.role = 'wire-bundle-label';
      label.textContent = `/${lanes.length}`;
      layer.appendChild(line); layer.appendChild(label);
      bundles.push({ line, label, hint, description, netIndices: lanes.map(lane => snapshot.netIndex.get(group.nets[lane]!.id)!),
        values: new Uint8Array(lanes.length), initialized: false });
    };
    if (branches.length === 2 && branches.every(branch => branch.lanes.length === group.nets.length)) {
      addTrunk(branches[0]!.lanes, manhattanPath(branches[0]!.join, branches[1]!.join));
    } else {
      for (const branch of branches) addTrunk(branch.lanes, manhattanPath(branch.join, center));
    }
    group.nets.forEach((net, lane) => {
      const geometry = paths[lane]!.join(' ');
      addHit('path', 'd', geometry, net.id);
      const path = document.createElementNS(SVG_NS, 'path'); path.setAttribute('d', geometry);
      path.setAttribute('class', 'wire wire-Z'); path.dataset.role = 'wire-bit';
      path.setAttribute('data-net-id', net.id);
      title(path, `${net.id}: ${net.endpoints.join(' ↔ ')}`);
      if (probed.has(net.id)) path.dataset.probed = 'true';
      layer.appendChild(path); wires.push({ line: path, netIdx: snapshot.netIndex.get(net.id)! });
    });
  };
  for (const group of model.groups) addGroup(group);

  const addSegment = (net: { id: string }, netIdx: number, pts: PinOffset[]): void => {
    const geometry = pointsAttr(pts);
    addHit('polyline', 'points', geometry, net.id);
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('points', geometry);
    line.setAttribute('class', 'wire wire-Z');
    line.setAttribute('data-net-id', net.id);
    if (probed.has(net.id)) line.dataset.probed = 'true';
    wireLayer.appendChild(line);
    wires.push({ line, netIdx });
  };

  for (const net of singles) {
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

  return { wires, bundles };
};

interface LedRef {
  el: SVGCircleElement;
  netIdx: number | null;
}

const buildLedRefs = (
  circuit: CircuitJSON,
  snapshot: LoadSnapshot,
  componentGroups: Map<string, SVGGElement>,
): LedRef[] => {
  const leds: LedRef[] = [];
  for (const inst of circuit.components) {
    if (inst.type !== 'io.led') continue;
    const g = componentGroups.get(inst.id);
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
  componentGroups: Map<string, SVGGElement>,
): SegRef[] => {
  const segs: SegRef[] = [];
  for (const inst of circuit.components) {
    if (inst.type !== 'io.7seg') continue;
    const g = componentGroups.get(inst.id);
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
