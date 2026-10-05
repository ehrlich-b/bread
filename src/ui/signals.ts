import { getPinsForType } from '../engine';
import type { CircuitJSON, NetState, PinDir } from '../engine/ir';

export interface PinBundle { endpoints: string[]; dir: PinDir; label: string }

export const numberedPins = (circuit: CircuitJSON, endpoint: string): PinBundle => {
  const dot = endpoint.indexOf('.');
  const id = endpoint.slice(0, dot); const name = endpoint.slice(dot + 1);
  const inst = circuit.components.find((c) => c.id === id);
  const match = /^(.*?)(\d+)$/.exec(name);
  if (dot < 1 || !inst || !match) throw new Error('Click the lowest numbered pin of a bus, for example Q0 or D0');
  const pins = getPinsForType(inst.type, inst.params, circuit.definitions) ?? [];
  const first = pins.find((p) => p.name === name);
  if (!first) throw new Error(`Unknown pin: ${endpoint}`);
  const prefix = match[1]!; const start = Number(match[2]); const endpoints: string[] = [];
  for (let bit = start; ; bit++) {
    const pin = pins.find((p) => p.name === `${prefix}${bit}` && p.dir === first.dir);
    if (!pin) break;
    endpoints.push(`${id}.${pin.name}`);
  }
  if (endpoints.length < 2) throw new Error(`No numbered bus begins at ${endpoint}`);
  return { endpoints, dir: first.dir, label: `${id}.${prefix}[${start + endpoints.length - 1}:${start}]` };
};

export const busPairs = (circuit: CircuitJSON, from: string, to: string, width: number): Array<[string, string]> => {
  const a = numberedPins(circuit, from); const b = numberedPins(circuit, to);
  if (!Number.isInteger(width) || width < 1 || width > Math.min(a.endpoints.length, b.endpoints.length)) {
    throw new Error(`Bus width must be from 1 to ${Math.min(a.endpoints.length, b.endpoints.length)}`);
  }
  const pairs = Array.from({ length: width }, (_, bit): [string, string] => [a.endpoints[bit]!, b.endpoints[bit]!]);
  const sources = new Set(pairs.map(([source]) => source));
  if (pairs.some(([, target]) => sources.has(target))) throw new Error('Bus pin ranges overlap');
  return pairs;
};

// Immutable net merge used by both individual wires and atomic bus wiring.
export const connectSignals = (circuit: CircuitJSON, from: string, to: string): CircuitJSON | null => {
  if (from === to) return null;
  const a = circuit.nets.find((n) => n.endpoints.includes(from));
  const b = circuit.nets.find((n) => n.endpoints.includes(to));
  if (a && b && a.id === b.id) return null;
  let nets = circuit.nets;
  if (!a && !b) {
    let i = 1; while (nets.some((n) => n.id === `n${i}`)) i++;
    nets = [...nets, { id: `n${i}`, endpoints: [from, to] }];
  } else if (a && !b) {
    nets = nets.map((n) => n.id === a.id ? { ...n, endpoints: [...n.endpoints, to] } : n);
  } else if (!a && b) {
    nets = nets.map((n) => n.id === b.id ? { ...n, endpoints: [...n.endpoints, from] } : n);
  } else if (a && b) {
    nets = nets.filter((n) => n.id !== b.id).map((n) => n.id === a.id ? { ...n, endpoints: [...a.endpoints, ...b.endpoints] } : n);
  }
  return { ...circuit, nets, ...(circuit.ports ? { ports: circuit.ports.map((p) => a && b && p.internalNet === b.id ? { ...p, internalNet: a.id } : p) } : {}) };
};

export const formatSignalBits = (lsbFirst: readonly NetState[]): { hex: string; binary: string } => {
  const binary = [...lsbFirst].reverse().join('');
  const digits: string[] = [];
  for (let start = 0; start < lsbFirst.length; start += 4) {
    const bits = lsbFirst.slice(start, start + 4);
    if (bits.every((bit) => bit === 'Z')) digits.unshift('Z');
    else if (bits.some((bit) => bit === 'X' || bit === 'Z')) digits.unshift('?');
    else digits.unshift(bits.reduce<number>((sum, bit, i) => sum + (bit === 1 ? 2 ** i : 0), 0).toString(16).toUpperCase());
  }
  return { hex: digits.join(''), binary };
};
