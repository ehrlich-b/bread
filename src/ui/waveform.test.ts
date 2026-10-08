import { describe, expect, it } from 'vitest';
import type { WaveformSnapshot } from '../engine/probes';
import { valueAtTick, waveformSegments, waveformValue } from './waveform';

const snapshot: WaveformSnapshot = {
  probes: [{ id: 'clock', label: 'clock', nets: ['clk'] }, { id: 'data', label: 'data', nets: ['d0', 'd1', 'd2', 'd3'] }],
  ticks: Float64Array.of(10, 11, 12, 13, 14), stride: 5, capacity: 5,
  values: Uint8Array.of(0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 0, 1, 0, 3, 3, 0, 2, 1, 2, 2, 2, 2, 2),
};

describe('waveform rendering model', () => {
  it('draws 0, 1, X and Z distinctly and formats arbitrary-width buses as hex', () => {
    expect([0, 1, 'X', 'Z'].map(bit => waveformValue([bit as 0 | 1 | 'X' | 'Z']).kind)).toEqual(['0', '1', 'X', 'Z']);
    expect(waveformValue([0, 1, 0, 1, 1])).toEqual({ text: '1A', binary: '11010', kind: 'bus' });
    expect(waveformValue(['Z', 'Z', 'Z', 'Z'])).toEqual({ text: 'Z', binary: 'ZZZZ', kind: 'Z' });
    expect(waveformValue([1, 'Z', 0, 0])).toEqual({ text: '?', binary: '00Z1', kind: 'Z' });
    expect(waveformValue([1, 'X', 0, 0])).toEqual({ text: 'X', binary: '00X1', kind: 'X' });
  });
  it('compresses equal samples and clips segments to a scrolled or zoomed viewport', () => {
    expect(waveformSegments(snapshot, 0, 10, 15)).toEqual([
      { start: 10, end: 12, text: '0', binary: '0', kind: '0' },
      { start: 12, end: 13, text: '1', binary: '1', kind: '1' },
      { start: 13, end: 14, text: 'X', binary: 'X', kind: 'X' },
      { start: 14, end: 15, text: 'Z', binary: 'Z', kind: 'Z' },
    ]);
    expect(waveformSegments(snapshot, 0, 11.5, 12.5).map(s => [s.start, s.end])).toEqual([[11.5, 12], [12, 12.5]]);
    expect(waveformSegments(snapshot, 1, 10, 15).map(s => s.text)).toEqual(['A', '5', 'X', 'Z']);
    expect(waveformSegments(snapshot, 9, 10, 15)).toEqual([]);
    expect(waveformSegments(snapshot, 0, 15, 15)).toEqual([]);
  });
  it('reads exact four-state values at the cursor and rejects evicted or future ticks', () => {
    expect(valueAtTick(snapshot, 1, 11)?.text).toBe('A');
    expect(valueAtTick(snapshot, 1, 12)).toEqual({ text: '5', binary: '0101', kind: 'bus' });
    expect(valueAtTick(snapshot, 1, 13)?.binary).toBe('1Z0X');
    expect(valueAtTick(snapshot, 0, 14)?.text).toBe('Z');
    expect(valueAtTick(snapshot, 0, 9)).toBeNull(); expect(valueAtTick(snapshot, 0, 15)).toBeNull();
    expect(valueAtTick(snapshot, 2, 12)).toBeNull();
  });
  it('preserves transitions with identical hex summaries but different X/Z lanes', () => {
    const mixed: WaveformSnapshot = { ...snapshot, probes: [snapshot.probes[1]!], ticks: Float64Array.of(0, 1), stride: 4, values: Uint8Array.of(3, 0, 0, 0, 0, 3, 0, 0) };
    expect(waveformSegments(mixed, 0, 0, 2).map(s => s.binary)).toEqual(['000X', '00X0']);
  });
});
