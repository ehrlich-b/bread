import type { RuntimeComponent as MainComponent, RuntimeGraph as MainGraph } from '../ir';
export * from '../ir';
export interface RuntimeComponent extends MainComponent { evalKind: number; }
export interface RuntimeGraph extends MainGraph { components: RuntimeComponent[]; }
