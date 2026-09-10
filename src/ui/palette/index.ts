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
  { group: 'I/O', type: 'io.7seg', label: '7-segment' },
  { group: 'I/O', type: 'gen.clock', label: 'Clock 1Hz', params: { freqHz: 1 } },
  { group: 'I/O', type: 'gen.555', label: '555 1Hz', params: { freqHz: 1 } },

  { group: 'Gates', type: 'prim.AND', label: 'AND', params: { inputs: 2 } },
  { group: 'Gates', type: 'prim.OR', label: 'OR', params: { inputs: 2 } },
  { group: 'Gates', type: 'prim.NAND', label: 'NAND', params: { inputs: 2 } },
  { group: 'Gates', type: 'prim.NOR', label: 'NOR', params: { inputs: 2 } },
  { group: 'Gates', type: 'prim.XOR', label: 'XOR', params: { inputs: 2 } },
  { group: 'Gates', type: 'prim.XNOR', label: 'XNOR', params: { inputs: 2 } },
  { group: 'Gates', type: 'prim.NOT', label: 'NOT' },
  { group: 'Gates', type: 'prim.BUF', label: 'BUF' },
  { group: 'Gates', type: 'prim.TRISTATE', label: 'Tristate', params: { oeActiveLow: false } },

  { group: 'Storage', type: 'prim.DFF', label: 'DFF' },
  { group: 'Storage', type: 'prim.LATCH', label: 'D Latch' },

  { group: 'Sources', type: 'prim.CONST_0', label: 'GND' },
  { group: 'Sources', type: 'prim.CONST_1', label: 'Vcc' },
  { group: 'Sources', type: 'prim.PULLUP', label: 'Pull-up' },
  { group: 'Sources', type: 'prim.PULLDOWN', label: 'Pull-down' },

  { group: 'Logic blocks', type: 'prim.MUX2', label: 'MUX2 ×4', params: { width: 4 } },
  { group: 'Logic blocks', type: 'prim.DEMUX2', label: 'DEMUX2 ×4', params: { width: 4 } },
  { group: 'Logic blocks', type: 'prim.DECODER', label: '3→8 decoder', params: { bits: 3, activeLow: false } },
  { group: 'Logic blocks', type: 'prim.ADDER', label: 'Adder ×4', params: { width: 4 } },

  { group: 'TTL', type: 'ttl.74LS00', label: '74LS00' },
  { group: 'TTL', type: 'ttl.74LS02', label: '74LS02' },
  { group: 'TTL', type: 'ttl.74LS04', label: '74LS04' },
  { group: 'TTL', type: 'ttl.74LS08', label: '74LS08' },
  { group: 'TTL', type: 'ttl.74LS32', label: '74LS32' },
  { group: 'TTL', type: 'ttl.74LS86', label: '74LS86' },
  { group: 'TTL', type: 'ttl.74LS107', label: '74LS107' },
  { group: 'TTL', type: 'ttl.74LS138', label: '74LS138' },
  { group: 'TTL', type: 'ttl.74LS139', label: '74LS139' },
  { group: 'TTL', type: 'ttl.74LS157', label: '74LS157' },
  { group: 'TTL', type: 'ttl.74LS161', label: '74LS161' },
  { group: 'TTL', type: 'ttl.74LS173', label: '74LS173' },
  { group: 'TTL', type: 'ttl.74LS245', label: '74LS245' },
  { group: 'TTL', type: 'ttl.74LS273', label: '74LS273' },
  { group: 'TTL', type: 'ttl.74LS283', label: '74LS283' },
  { group: 'TTL', type: 'ttl.74LS374', label: '74LS374' },

  { group: 'Memory', type: 'mem.6116', label: '6116 SRAM' },
  { group: 'Memory', type: 'mem.28C16', label: '28C16 EEPROM' },
  { group: 'Memory', type: 'mem.74LS189', label: '74LS189 RAM' },
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
