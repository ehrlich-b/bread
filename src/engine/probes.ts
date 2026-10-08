import type { ProbeJSON, RuntimeGraph } from './ir';

export const PROBE_CAPACITY = 8192;

export interface WaveformSnapshot {
  probes: ProbeJSON[];
  ticks: Float64Array;
  // One byte per lane (0, 1, Z=2, X=3), tick-major, then probe-major.
  values: Uint8Array;
  stride: number;
  capacity: number;
}

export function validateProbes(probes: ProbeJSON[] | undefined, graph: RuntimeGraph): void {
  if (probes === undefined) return;
  if (!Array.isArray(probes)) throw new Error('Probes must be an array');
  const ids = new Set<string>();
  for (const probe of probes) {
    if (!probe || typeof probe.id !== 'string' || !probe.id.trim() || ids.has(probe.id)) throw new Error('Probe IDs must be nonempty and unique');
    if (typeof probe.label !== 'string' || !probe.label.trim()) throw new Error(`Probe ${probe.id}: add a label`);
    if (!Array.isArray(probe.nets) || !probe.nets.length) throw new Error(`Probe ${probe.id}: add at least one net`);
    for (const net of probe.nets) {
      if (typeof net !== 'string' || !graph.netById.has(net)) throw new Error(`Probe ${probe.id}: unknown net ${String(net)}`);
    }
    ids.add(probe.id);
  }
}

// The scheduler never calls this. Its caller selects an observed burst only
// when probes exist, keeping the zero-probe simulator path unchanged.
export class ProbeCapture {
  private readonly indices: Uint32Array;
  private readonly ticks: Float64Array;
  private readonly values: Uint8Array;
  private readonly probes: ProbeJSON[];
  private next = 0;
  private count = 0;
  readonly stride: number;

  constructor(probes: ProbeJSON[], graph: RuntimeGraph, readonly capacity = PROBE_CAPACITY) {
    validateProbes(probes, graph);
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Probe capacity must be a positive integer');
    this.probes = probes.map(probe => ({ ...probe, nets: [...probe.nets] }));
    this.indices = Uint32Array.from(probes.flatMap(probe => probe.nets.map(net => graph.netById.get(net)!)));
    this.stride = this.indices.length;
    this.ticks = new Float64Array(capacity);
    this.values = new Uint8Array(capacity * this.stride);
  }

  record(tick: number, netValues: Uint8Array): void {
    // Paused input settling replaces the current tick; it never invents time.
    const previous = (this.next + this.capacity - 1) % this.capacity;
    const replace = this.count > 0 && this.ticks[previous] === tick;
    const slot = replace ? previous : this.next;
    this.ticks[slot] = tick;
    const offset = slot * this.stride;
    for (let lane = 0; lane < this.stride; lane++) this.values[offset + lane] = netValues[this.indices[lane]!]!;
    if (!replace) {
      this.next = (this.next + 1) % this.capacity;
      this.count = Math.min(this.count + 1, this.capacity);
    }
  }

  snapshot(): WaveformSnapshot {
    const ticks = new Float64Array(this.count);
    const values = new Uint8Array(this.count * this.stride);
    const oldest = (this.next + this.capacity - this.count) % this.capacity;
    const firstCount = Math.min(this.count, this.capacity - oldest);
    ticks.set(this.ticks.subarray(oldest, oldest + firstCount));
    ticks.set(this.ticks.subarray(0, this.count - firstCount), firstCount);
    values.set(this.values.subarray(oldest * this.stride, (oldest + firstCount) * this.stride));
    values.set(this.values.subarray(0, (this.count - firstCount) * this.stride), firstCount * this.stride);
    return { probes: this.probes.map(probe => ({ ...probe, nets: [...probe.nets] })), ticks, values, stride: this.stride, capacity: this.capacity };
  }
}
