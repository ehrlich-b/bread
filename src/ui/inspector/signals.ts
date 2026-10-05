import { getPinsForType } from '../../engine';
import { getComposite } from '../../engine/composites/registry';
import type { CircuitJSON, ComponentInstanceJSON, NetState } from '../../engine/ir';
import type { LoadSnapshot } from '../bus';
import { formatSignalBits } from '../signals';

export const runtimeSignalNet = (circuit: CircuitJSON, inst: ComponentInstanceJSON, pin: string): string => {
  const explicit = circuit.nets.find((net) => net.endpoints.includes(`${inst.id}.${pin}`));
  if (explicit) return explicit.id;
  const def = circuit.definitions?.find((d) => d.name === inst.type) ?? getComposite(inst.type);
  const port = def?.ports?.find((p) => p.name === pin);
  return port ? `${inst.id}__${port.internalNet}` : `__floating__${inst.id}__${pin}`;
};

export const buildSignalReadout = (circuit: CircuitJSON, inst: ComponentInstanceJSON): { element: HTMLElement; refresh(snapshot: LoadSnapshot): void } => {
  const element = document.createElement('details'); element.open = true; element.className = 'signal-readout';
  const summary = document.createElement('summary'); summary.textContent = 'Live signals'; element.append(summary);
  const pins = getPinsForType(inst.type, inst.params, circuit.definitions) ?? [];
  const used = new Set<string>();
  const refs: Array<{ output: HTMLOutputElement; nets: string[] }> = [];
  for (const pin of pins) {
    if (used.has(pin.name)) continue;
    const match = /^(.*?)(\d+)$/.exec(pin.name);
    let names = [pin.name]; let label = pin.name;
    if (match) {
      const prefix = match[1]!;
      const family = pins.filter((p) => p.dir === pin.dir && new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+$`).test(p.name))
        .sort((a, b) => Number(a.name.slice(prefix.length)) - Number(b.name.slice(prefix.length)));
      if (family.length > 1 && family.every((p, i) => Number(p.name.slice(prefix.length)) === Number(family[0]!.name.slice(prefix.length)) + i)) {
        names = family.map((p) => p.name);
        label = `${prefix}[${family.at(-1)!.name.slice(prefix.length)}:${family[0]!.name.slice(prefix.length)}]`;
      }
    }
    for (const name of names) used.add(name);
    const row = document.createElement('div'); const title = document.createElement('span'); title.textContent = label;
    const output = document.createElement('output'); output.setAttribute('aria-label', `Live ${label}`);
    output.title = names.map((name) => `${name}: ${runtimeSignalNet(circuit, inst, name)}`).join('\n');
    row.append(title, output); element.append(row);
    refs.push({ output, nets: names.map((name) => runtimeSignalNet(circuit, inst, name)) });
  }
  return { element, refresh(snapshot) {
    for (const ref of refs) {
      const bits = ref.nets.map((net): NetState => {
        const index = snapshot.netIndex.get(net); const value = index === undefined ? 3 : snapshot.netsView[index];
        return value === 0 ? 0 : value === 1 ? 1 : value === 2 ? 'Z' : 'X';
      });
      const value = formatSignalBits(bits);
      const text = bits.length === 1 ? value.binary : `${value.hex}\n${value.binary}`;
      if (ref.output.textContent !== text) ref.output.textContent = text;
    }
  } };
};
