import type { ProbeSequence } from '../engine/probes';

// Shared with the worker: capture grades live OUT loads at every tick, even
// when a high rate or a busy UI lets the waveform ring wrap between deliveries.
export const TUTORIAL_FIBONACCI: ProbeSequence = {
  id: 'tutorial.fibonacci', clock: 'gated_clk', enable: { net: 'ctl_oi', value: 0 },
  nets: Array.from({ length: 8 }, (_, bit) => `display__${bit < 4 ? 'nlo' : 'nhi'}${bit % 4}`),
  values: [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233],
};
