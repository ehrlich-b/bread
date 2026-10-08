import type { NetState } from '../engine/ir';
import type { WaveformSnapshot } from '../engine/probes';
import { NET_STATES } from '../engine/nets';

export interface WaveformValue {
  text: string;
  binary: string;
  kind: '0' | '1' | 'X' | 'Z' | 'bus';
}
export interface WaveformSegment extends WaveformValue { start: number; end: number }

const offsetFor = (snapshot: WaveformSnapshot, probe: number): number => snapshot.probes.slice(0, probe).reduce((sum, p) => sum + p.nets.length, 0);

export function waveformValue(bits: readonly NetState[]): WaveformValue {
  const binary = [...bits].reverse().join('');
  if (bits.length === 1) return { text: binary, binary, kind: binary as WaveformValue['kind'] };
  const digits: string[] = [];
  for (let i = 0; i < bits.length; i += 4) {
    const nibble = bits.slice(i, i + 4);
    digits.unshift(nibble.every(bit => bit === 'Z') ? 'Z' : nibble.some(bit => bit === 'X') ? 'X'
      : nibble.some(bit => bit === 'Z') ? '?' : nibble.reduce<number>((sum, bit, n) => sum + (bit === 1 ? 2 ** n : 0), 0).toString(16).toUpperCase());
  }
  return { text: digits.join(''), binary, kind: bits.some(bit => bit === 'X') ? 'X' : bits.some(bit => bit === 'Z') ? 'Z' : 'bus' };
}

const readValue = (snapshot: WaveformSnapshot, probe: number, sample: number, offset: number): WaveformValue => {
  const start = sample * snapshot.stride + offset;
  const bits = Array.from(snapshot.values.subarray(start, start + snapshot.probes[probe]!.nets.length), byte => NET_STATES[byte]!);
  return waveformValue(bits);
};

export function valueAtTick(snapshot: WaveformSnapshot, probe: number, tick: number): WaveformValue | null {
  if (!snapshot.probes[probe] || !snapshot.ticks.length || tick < snapshot.ticks[0]! || tick > snapshot.ticks.at(-1)!) return null;
  let lo = 0; let hi = snapshot.ticks.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (snapshot.ticks[mid]! <= tick) lo = mid + 1; else hi = mid;
  }
  return readValue(snapshot, probe, lo - 1, offsetFor(snapshot, probe));
}

// Compress identical adjacent samples and clip to the visible tick window.
// Comparison uses the exact bits, so mixed X/Z buses never lose transitions.
export function waveformSegments(snapshot: WaveformSnapshot, probe: number, start: number, end: number): WaveformSegment[] {
  if (!snapshot.probes[probe] || end <= start) return [];
  const segments: WaveformSegment[] = [];
  const offset = offsetFor(snapshot, probe);
  for (let sample = 0; sample < snapshot.ticks.length; sample++) {
    const tick = snapshot.ticks[sample]!;
    const next = snapshot.ticks[sample + 1] ?? tick + 1;
    if (next <= start) continue;
    if (tick >= end) break;
    const value = readValue(snapshot, probe, sample, offset);
    const previous = segments.at(-1);
    if (previous && previous.binary === value.binary) previous.end = Math.min(next, end);
    else segments.push({ ...value, start: Math.max(tick, start), end: Math.min(next, end) });
  }
  return segments;
}
