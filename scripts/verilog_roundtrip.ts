import { readFileSync, readdirSync } from 'node:fs';
import { getPinsForType, listAllTypes } from '../src/engine';
import type { CircuitJSON, NetState } from '../src/engine/ir';
import { loadCircuit } from '../src/engine/loader';
import { Simulator } from '../src/engine/sim';
import { exportVerilog } from '../src/engine/verilog';
import { importVerilog } from '../src/engine/verilog_import';
import { parseTestbench, runTestbench, type TestbenchJSON } from '../src/engine/testbench';

export function roundTripVerilog(circuit: CircuitJSON, ticks = 256): { name: string; samples: number; comparisons: number } {
  const exported = exportVerilog(circuit); const imported = importVerilog(exported.source);
  const original = new Simulator(loadCircuit(circuit), { rateHz: 1000 });
  const restored = new Simulator(loadCircuit(imported.circuit), { rateHz: 1000 });
  const mapping = original.graph.nets.map(net => {
    const path = exported.nets[net.id]!; const id = imported.nets[path];
    if (!id) throw new Error(`${circuit.name}: missing imported wire path ${path}`);
    return [net.id, id] as const;
  });
  const switches = original.graph.components.filter(c => c.typeId === 'io.switch');
  const restoredSwitches = restored.graph.components.filter(c => c.typeId === 'io.switch');
  if (switches.length !== restoredSwitches.length) throw new Error(`${circuit.name}: changed switch count`);
  const inputNets = original.graph.nets.filter(net => net.drivers.length === 0).map(net => net.id);
  const states: NetState[] = [0, 1, 'X', 'Z'];
  let comparisons = 0;
  const compare = (sample: number): void => {
    if (original.eventsEmitted !== restored.eventsEmitted || original.events.some((event, i) => event.kind !== restored.events[i]?.kind || event.step !== restored.events[i]?.step)) throw new Error(`${circuit.name}: round-trip sample ${sample}: diagnostic trace mismatch`);
    for (const [before, after] of mapping) {
      const expected = original.readNet(before); const actual = restored.readNet(after);
      if (actual !== expected) throw new Error(`${circuit.name}: round-trip sample ${sample}, ${before}: original=${expected}, imported=${actual}`);
      comparisons++;
    }
  };
  compare(0); original.settle(); restored.settle(); compare(1);
  for (let step = 0; step < ticks; step++) {
    // Independent four-state stimulus includes power-on, floating lanes,
    // contention and deterministic transitions through sequential circuits.
    switches.forEach((c, i) => {
      const value = states[(Math.floor(step / 4 ** (i % 3)) + i) % 4]!;
      original.setComponentInput(c.id, 'Y', value); restored.setComponentInput(restoredSwitches[i]!.id, 'Y', value);
    });
    inputNets.forEach((net, i) => {
      const value = states[(Math.floor(step / 4 ** (i % 3)) + i) % 4]!;
      original.setInput(net, value); restored.setInput(imported.nets[exported.nets[net]!]!, value);
    });
    original.tick(); restored.tick(); compare(step + 2);
  }
  return { name: circuit.name, samples: ticks + 2, comparisons };
}

export function roundTripCorpus(): ReturnType<typeof roundTripVerilog>[] {
  const results = readdirSync('examples').filter(name => name.endsWith('.json')).map(name => roundTripVerilog(JSON.parse(readFileSync(`examples/${name}`, 'utf8')) as CircuitJSON));
  const types = listAllTypes();
  for (const type of [...types.primitives, ...types.behaviorals, ...types.composites]) {
    const params = { inputs: 2, width: 2, bits: 2, activeLow: false, freqHz: 100 };
    const circuit: CircuitJSON = { version: 1, kind: 'circuit', name: type, components: [{ id: 'chip', type, params }],
      nets: getPinsForType(type, params)!.map(pin => ({ id: pin.name, endpoints: [`chip.${pin.name}`] })) };
    results.push(roundTripVerilog(circuit));
  }
  return results;
}

export function roundTripTestbench(circuit: CircuitJSON, input: unknown): { name: string; samples: number; comparisons: number } {
  const exported = exportVerilog(circuit); const imported = importVerilog(exported.source); const bench = parseTestbench(input);
  const before = loadCircuit(circuit); const after = loadCircuit(imported.circuit);
  const switches = before.components.filter(c => c.typeId === 'io.switch');
  const restoredSwitches = after.components.filter(c => c.typeId === 'io.switch');
  const net = (id: string): string => {
    const mapped = imported.nets[exported.nets[id]!];
    if (!mapped) throw new Error(`${bench.name}: missing imported net ${id}`); return mapped;
  };
  const mapped: TestbenchJSON = { ...bench,
    inputs: Object.fromEntries(Object.entries(bench.inputs).map(([name, signal]) => [name, Array.isArray(signal) ? signal.map(net) : {
      ...signal, component: restoredSwitches[switches.findIndex(c => c.id === signal.component)]!.id,
    }])),
    outputs: Object.fromEntries(Object.entries(bench.outputs).map(([name, bits]) => [name, bits.map(net)])),
  };
  const samples: Uint8Array[] = [];
  const original = runTestbench(circuit, bench, { observe(sim) { samples.push(sim.graph.netValues.slice()); } });
  if (original.passed !== original.total) throw new Error(`${bench.name}: original testbench failed`);
  const indices = before.nets.map(n => after.netById.get(net(n.id))!);
  let count = 0; let comparisons = 0;
  const restored = runTestbench(imported.circuit, mapped, { observe(sim) {
    const expected = samples[count++];
    if (!expected) throw new Error(`${bench.name}: extra imported sample`);
    indices.forEach((index, i) => {
      if (sim.graph.netValues[index] !== expected[i]) throw new Error(`${bench.name}: sample ${count - 1}, ${before.nets[i]!.id}: round-trip trace mismatch`);
      comparisons++;
    });
  } });
  if (restored.passed !== restored.total || count !== samples.length) throw new Error(`${bench.name}: imported testbench/sample count failed`);
  return { name: bench.name, samples: count, comparisons };
}
