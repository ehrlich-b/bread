// Test-only entry point: run all existing simulator vectors on the frozen backend.
export { TruthTableSimulator as Simulator, DEFAULT_MAX_ITERATIONS } from './truth-table-sim';
export type { SimEvent, SimulatorOptions } from './truth-table-sim';
import { NET_STATES } from '../nets';
export const decodeNet = (value: number) => NET_STATES[value] ?? 0;
