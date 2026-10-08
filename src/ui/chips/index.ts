import { getPinsForType } from '../../engine';
import type { NetState, PortJSON } from '../../engine/ir';
import type { EditorModel } from '../editor';
import { chipSelection } from './model';

const button = (label: string, action: () => void): HTMLButtonElement => {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label; b.addEventListener('click', action);
  return b;
};
const input = (label: string, value: string): HTMLInputElement => {
  const el = document.createElement('input'); el.setAttribute('aria-label', label); el.value = value; return el;
};
const select = (label: string, values: string[], value: string): HTMLSelectElement => {
  const el = document.createElement('select'); el.setAttribute('aria-label', label);
  for (const v of values) { const opt = document.createElement('option'); opt.value = v; opt.textContent = v; el.append(opt); }
  el.value = value; return el;
};
const directions = ['in', 'out', 'inout'];

export function mountChips(host: HTMLElement, editor: EditorModel): () => void {
  const run = (action: Promise<void>): void => { void action.catch(() => {}); };
  const dialog = document.createElement('dialog');
  dialog.className = 'chip-dialog';
  dialog.setAttribute('aria-label', 'Create chip');
  document.body.append(dialog);
  const openCreate = (): void => {
    try {
      const selected = new Set(editor.state.selection);
      const fragment = chipSelection(editor.state.circuit, selected);
      dialog.innerHTML = '';
      const title = document.createElement('h2'); title.textContent = 'Create chip';
      const hint = document.createElement('p'); hint.textContent = 'Boundary wires and free pins become ports. Name each signal before creating your reusable chip.';
      const nameLabel = document.createElement('label'); nameLabel.textContent = 'Chip name ';
      const name = input('Chip name', ''); name.placeholder = 'e.g. NandNot'; nameLabel.append(name);
      const rows = (fragment.body.ports ?? []).map((port, i) => {
        const row = document.createElement('div'); row.className = 'port-row';
        const portName = input(`Port ${i + 1} name`, port.name);
        const dir = select(`Port ${i + 1} direction`, directions, port.dir);
        const binding = document.createElement('small');
        binding.textContent = fragment.body.nets.find((n) => n.id === port.internalNet)!.endpoints.join(', ');
        row.append(portName, dir, binding); dialog.append(row);
        return { port, portName, dir, row };
      });
      const error = document.createElement('p'); error.setAttribute('role', 'alert');
      const create = button('Create and replace selection', () => {
        create.disabled = true;
        const ports = rows.map(({ port, portName, dir }) => ({ ...port, name: portName.value.trim(), dir: dir.value as PortJSON['dir'] }));
        void editor.createChip(name.value, ports, selected).then(() => dialog.close()).catch((e: unknown) => {
          error.textContent = e instanceof Error ? e.message : String(e);
        }).finally(() => { create.disabled = false; });
      });
      dialog.replaceChildren(title, hint, nameLabel, ...rows.map((r) => r.row), error, create, button('Cancel', () => dialog.close()));
      dialog.showModal(); name.focus();
    } catch (error) { editor.reportError(error); }
  };
  let raf = 0;
  let outputs: Array<{ node: HTMLOutputElement; net: string }> = [];
  const refresh = (): void => {
    host.innerHTML = ''; outputs = [];
    const state = editor.state;
    const title = document.createElement('strong');
    title.textContent = state.editingChip ? `Editing ${state.editingChip.slice(5)}` : 'Reusable chips';
    const create = button('Create chip from selection', openCreate);
    create.disabled = !state.selection.size;
    const hint = document.createElement('small');
    hint.textContent = 'Shift-click components to select a group. Create a chip, then place it from My chips.';
    host.append(title, create, hint);
    if (state.editingChip) {
      const actions = document.createElement('div'); actions.className = 'chip-actions';
      actions.append(button('Save chip & return', () => run(editor.saveChip())), button('Cancel chip edit', () => run(editor.cancelChip())));
      host.append(actions);
      const info = document.createElement('small'); info.textContent = 'Saved edits update every instance. Input tests start released (Z); structural edits reset storage.';
      host.append(info);
      const portRows = (state.circuit.ports ?? []).map((port, i) => {
        const row = document.createElement('div'); row.className = 'port-editor';
        const portName = input(`Edit port ${i + 1} name`, port.name);
        const dir = select(`Edit port ${i + 1} direction`, directions, port.dir);
        const net = select(`Edit port ${i + 1} net`, state.circuit.nets.map((n) => n.id), port.internalNet);
        const value = document.createElement('output'); value.setAttribute('aria-label', `${port.name} value`); outputs.push({ node: value, net: port.internalNet });
        row.append(portName, dir, net, value);
        if (port.dir !== 'out') {
          const drives = document.createElement('div'); drives.className = 'port-drives';
          for (const v of [0, 1, 'Z', 'X'] as NetState[]) {
            const b = button(String(v), () => { void editor.setPortInput(port.internalNet, v).catch((e: unknown) => editor.reportError(e)); });
            b.setAttribute('aria-label', `Drive ${port.name} ${v}`); drives.append(b);
          }
          row.append(drives);
        }
        const remove = button(`Remove port ${port.name}`, () => run(editor.removePort(port.name)));
        row.append(remove); host.append(row);
        return { portName, dir, net };
      });
      host.append(button('Apply ports', () => run(editor.updatePorts(portRows.map((r) => ({ name: r.portName.value.trim(), dir: r.dir.value as PortJSON['dir'], internalNet: r.net.value }))))));
      const freePins = state.circuit.components.flatMap((c) => (getPinsForType(c.type, c.params, state.circuit.definitions) ?? []).map((p) => `${c.id}.${p.name}`));
      const pin = select('Expose pin', freePins, freePins[0] ?? '');
      const portName = input('New port name', '');
      const dir = select('New port direction', directions, 'in');
      const add = button('Expose pin as port', () => run(editor.exposePin(pin.value, portName.value.trim(), dir.value as PortJSON['dir'])));
      host.append(pin, portName, dir, add);
    }
    if (state.note) { const note = document.createElement('p'); note.setAttribute('role', 'status'); note.textContent = state.note; host.append(note); }
    if (state.error) { const error = document.createElement('p'); error.setAttribute('role', 'alert'); error.textContent = state.error; host.append(error); }
  };
  const sample = (): void => {
    for (const { node, net } of outputs) {
      node.textContent = editor.state.snapshot.netIndex.has(net) ? String(editor.bus.readNet(net)) : 'missing net';
    }
    raf = requestAnimationFrame(sample);
  };
  refresh(); sample();
  const unsub = editor.subscribe(refresh);
  return () => { unsub(); cancelAnimationFrame(raf); dialog.remove(); host.innerHTML = ''; };
}
