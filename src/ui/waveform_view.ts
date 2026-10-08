import type { WaveformSnapshot } from '../engine/probes';
import type { EditorModel } from './editor';
import { valueAtTick, waveformSegments } from './waveform';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ROW_HEIGHT = 44;
const AXIS_HEIGHT = 24;

export const mountWaveform = (host: HTMLElement, editor: EditorModel): (() => void) => {
  host.setAttribute('aria-label', 'Waveform viewer');
  const toolbar = document.createElement('div'); toolbar.className = 'waveform-toolbar';
  const title = document.createElement('strong'); title.textContent = 'Waveforms';
  const status = document.createElement('output'); status.setAttribute('aria-label', 'Waveform capture');
  const legend = document.createElement('small'); legend.textContent = '0 low · 1 high · X unknown · Z released · buses in hex';
  const followLabel = document.createElement('label'); followLabel.textContent = ' Follow latest ';
  const follow = document.createElement('input'); follow.type = 'checkbox'; follow.checked = true; followLabel.prepend(follow);
  const cursorLabel = document.createElement('label'); cursorLabel.textContent = 'Cursor tick ';
  const cursor = document.createElement('input'); cursor.type = 'number'; cursor.step = '1'; cursor.setAttribute('aria-label', 'Waveform cursor tick'); cursorLabel.append(cursor);
  const body = document.createElement('div'); body.className = 'waveform-body';
  const labels = document.createElement('div'); labels.className = 'waveform-labels';
  const viewport = document.createElement('div'); viewport.className = 'waveform-scroll'; viewport.tabIndex = 0; viewport.setAttribute('aria-label', 'Waveform timeline');
  const svg = document.createElementNS(SVG_NS, 'svg'); svg.dataset.role = 'waveform'; viewport.append(svg);
  const empty = document.createElement('p'); empty.textContent = 'Use Probe net or Probe bus, then click a wire or pin on the canvas.';
  let snapshot = editor.bus.waveform ?? null;
  let scale = 1;
  let cursorTick: number | null = null;
  let running = false;

  const range = (): [number, number] => [snapshot?.ticks[0] ?? 0, (snapshot?.ticks.at(-1) ?? 0) + 1];
  const width = (): number => Math.max(viewport.clientWidth || 600, (range()[1] - range()[0]) * scale);
  const draw = (): void => {
    svg.replaceChildren();
    if (!snapshot) return;
    const [first, end] = range();
    svg.setAttribute('width', String(width()));
    svg.setAttribute('height', String(AXIS_HEIGHT + snapshot.probes.length * ROW_HEIGHT));
    const visibleStart = first + viewport.scrollLeft / scale;
    const visibleEnd = Math.min(end, visibleStart + (viewport.clientWidth || 600) / scale);
    const text = (x: number, y: number, value: string, parent: SVGElement = svg): void => {
      const el = document.createElementNS(SVG_NS, 'text'); el.setAttribute('x', String(x)); el.setAttribute('y', String(y)); el.textContent = value; parent.append(el);
    };
    const spacing = 10 ** Math.ceil(Math.log10(80 / scale));
    for (let tick = Math.ceil(visibleStart / spacing) * spacing; tick < visibleEnd; tick += spacing) text((tick - first) * scale + 2, 16, String(tick));
    snapshot.probes.forEach((probe, index) => {
      const y = AXIS_HEIGHT + index * ROW_HEIGHT;
      const row = document.createElementNS(SVG_NS, 'g'); row.dataset.probeId = probe.id; row.setAttribute('aria-label', `Waveform ${probe.label}`); svg.append(row);
      for (const segment of waveformSegments(snapshot!, index, visibleStart, visibleEnd)) {
        const x1 = (segment.start - first) * scale; const x2 = (segment.end - first) * scale;
        const group = document.createElementNS(SVG_NS, 'g'); group.dataset.value = segment.text; group.dataset.binary = segment.binary;
        group.dataset.startTick = String(segment.start); group.dataset.endTick = String(segment.end); group.setAttribute('class', `waveform-segment waveform-${segment.kind}`);
        const tip = document.createElementNS(SVG_NS, 'title'); tip.textContent = `${probe.label}: ${segment.text} (${segment.binary}), ticks ${segment.start}–${segment.end}`; group.append(tip);
        const line = document.createElementNS(SVG_NS, 'path');
        if (probe.nets.length > 1) {
          const bevel = Math.min(4, (x2 - x1) / 2);
          line.setAttribute('d', `M ${x1} ${y + 22} L ${x1 + bevel} ${y + 8} H ${x2 - bevel} L ${x2} ${y + 22} L ${x2 - bevel} ${y + 36} H ${x1 + bevel} Z`);
        } else {
          const level = segment.kind === '1' ? y + 8 : segment.kind === '0' ? y + 36 : y + 22;
          line.setAttribute('d', `M ${x1} ${y + 22} V ${level} H ${x2} V ${y + 22}`);
        }
        group.append(line);
        if (x2 - x1 >= 22 || segment.kind === 'X' || segment.kind === 'Z') text(x1 + 5, y + 26, segment.text, group);
        row.append(group);
      }
    });
    if (cursorTick !== null && cursorTick >= first && cursorTick < end) {
      const line = document.createElementNS(SVG_NS, 'line'); const x = (cursorTick - first) * scale;
      line.setAttribute('x1', String(x)); line.setAttribute('x2', String(x)); line.setAttribute('y1', '0'); line.setAttribute('y2', String(AXIS_HEIGHT + snapshot.probes.length * ROW_HEIGHT)); line.setAttribute('class', 'waveform-cursor'); svg.append(line);
    }
  };

  const refresh = (): void => {
    labels.replaceChildren();
    const hasProbes = Boolean(snapshot?.probes.length);
    body.hidden = !hasProbes; empty.hidden = hasProbes;
    if (!snapshot || !hasProbes) { status.textContent = 'No probes'; svg.replaceChildren(); return; }
    const [first, end] = range();
    status.textContent = `${running ? 'Running' : 'Paused'} · ticks ${first}–${end - 1} · ${snapshot.ticks.length}/${snapshot.capacity} samples`;
    cursor.min = String(first); cursor.max = String(end - 1);
    cursor.value = cursorTick === null ? '' : String(cursorTick);
    const axis = document.createElement('div'); axis.className = 'waveform-label-axis'; axis.textContent = 'Probe / cursor value'; labels.append(axis);
    snapshot.probes.forEach((probe, index) => {
      const row = document.createElement('div'); row.className = 'waveform-label-row';
      const name = document.createElement('span'); name.textContent = probe.label; name.title = probe.nets.join(', ');
      const value = document.createElement('output'); value.setAttribute('aria-label', `Cursor ${probe.label}`);
      const atCursor = cursorTick === null ? null : valueAtTick(snapshot!, index, cursorTick);
      value.textContent = atCursor ? `${atCursor.text} (${atCursor.binary})` : '—';
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove probe ${probe.label}`);
      remove.addEventListener('click', () => { void editor.removeProbe(probe.id).catch(() => {}); });
      row.append(name, value, remove); labels.append(row);
    });
    draw();
  };
  const button = (name: string, action: () => void): HTMLButtonElement => {
    const el = document.createElement('button'); el.type = 'button'; el.textContent = name; el.addEventListener('click', action); return el;
  };
  const zoom = (factor: number): void => {
    const tick = range()[0] + viewport.scrollLeft / scale;
    scale = Math.max(0.02, Math.min(32, scale * factor));
    draw(); viewport.scrollLeft = (tick - range()[0]) * scale; draw();
  };
  toolbar.append(title, button('Zoom waveform in', () => zoom(2)), button('Zoom waveform out', () => zoom(0.5)), button('Fit waveform', () => {
    scale = Math.max(0.02, Math.min(32, (viewport.clientWidth || 600) / (range()[1] - range()[0]))); viewport.scrollLeft = 0; draw();
  }), followLabel, cursorLabel, status);
  body.append(labels, viewport); host.append(toolbar, legend, empty, body);
  cursor.addEventListener('input', () => { cursorTick = cursor.value === '' ? null : Math.trunc(Number(cursor.value)); refresh(); });
  svg.addEventListener('click', event => {
    if (!snapshot?.ticks.length) return;
    cursorTick = Math.max(range()[0], Math.min(range()[1] - 1, range()[0] + Math.floor((event.clientX - svg.getBoundingClientRect().left) / scale))); refresh();
  });
  viewport.addEventListener('scroll', draw);
  const unsub = editor.bus.on('waveform', next => {
    const oldFirst = range()[0]; const viewedTick = oldFirst + viewport.scrollLeft / scale;
    // A reload or probe edit starts a new recording. Cursor ticks remain
    // meaningful during rolling capture, and become unavailable if evicted.
    if (!next || next.ticks.at(-1)! < (snapshot?.ticks.at(-1) ?? -1)) cursorTick = null;
    snapshot = next; refresh();
    viewport.scrollLeft = follow.checked ? Math.max(0, width() - viewport.clientWidth) : Math.max(0, (viewedTick - range()[0]) * scale);
    draw();
  });
  const unsubMetrics = editor.bus.on('metrics', metrics => { running = metrics.running; refresh(); });
  refresh();
  return () => { unsub(); unsubMetrics(); host.replaceChildren(); };
};
