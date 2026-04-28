// Chip palette. Lists every component the user can drop onto the schematic.
// Clicking an entry asks the editor to enter placement mode; clicking
// elsewhere on the schematic background then issues an addComponent.
// The active entry is highlighted via aria-pressed for the e2e to read.

import type { EditorModel } from '../editor';

export interface PaletteEntry {
  type: string;
  label: string;
  params?: Record<string, unknown>;
  group?: string;
}

export const PALETTE: PaletteEntry[] = [
  { group: 'I/O', type: 'io.switch', label: 'Switch' },
  { group: 'I/O', type: 'io.led', label: 'LED' },
  { group: 'I/O', type: 'gen.clock', label: 'Clock 1Hz', params: { freqHz: 1 } },
  { group: 'Gates', type: 'prim.AND', label: 'AND', params: { inputs: 2 } },
  { group: 'Gates', type: 'prim.OR', label: 'OR', params: { inputs: 2 } },
  { group: 'Gates', type: 'prim.NAND', label: 'NAND', params: { inputs: 2 } },
  { group: 'Gates', type: 'prim.NOR', label: 'NOR', params: { inputs: 2 } },
  { group: 'Gates', type: 'prim.XOR', label: 'XOR', params: { inputs: 2 } },
  { group: 'Gates', type: 'prim.XNOR', label: 'XNOR', params: { inputs: 2 } },
  { group: 'Gates', type: 'prim.NOT', label: 'NOT' },
  { group: 'Gates', type: 'prim.BUF', label: 'BUF' },
  { group: 'Memory', type: 'prim.DFF', label: 'DFF' },
];

export const mountPalette = (host: HTMLElement, editor: EditorModel): (() => void) => {
  host.innerHTML = '';
  host.classList.add('palette');

  // Group entries by their declared group, preserving first-seen order.
  const groups: Array<{ name: string; entries: PaletteEntry[] }> = [];
  for (const e of PALETTE) {
    const groupName = e.group ?? 'Other';
    let g = groups.find((x) => x.name === groupName);
    if (!g) {
      g = { name: groupName, entries: [] };
      groups.push(g);
    }
    g.entries.push(e);
  }

  const buttons: Array<{ btn: HTMLButtonElement; type: string }> = [];

  for (const g of groups) {
    const heading = document.createElement('div');
    heading.className = 'palette-group';
    heading.textContent = g.name;
    host.appendChild(heading);
    for (const entry of g.entries) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'palette-entry';
      btn.dataset.paletteType = entry.type;
      btn.textContent = entry.label;
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => {
        const cur = editor.state.placement;
        if (cur && cur.type === entry.type) {
          editor.clearPlacement();
        } else {
          editor.setPlacement(entry.type, entry.params);
        }
      });
      host.appendChild(btn);
      buttons.push({ btn, type: entry.type });
    }
  }

  const refresh = (): void => {
    const placement = editor.state.placement;
    for (const { btn, type } of buttons) {
      btn.setAttribute('aria-pressed', placement?.type === type ? 'true' : 'false');
    }
  };
  refresh();

  return editor.subscribe(refresh);
};
