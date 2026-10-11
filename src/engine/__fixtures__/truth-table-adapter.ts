import type { RuntimeGraph as MainGraph } from '../ir';
import type { RuntimeGraph } from './truth-table-ir';
import { getEvalKind } from './truth-table-dispatch';
export function comparisonGraph(graph: MainGraph): RuntimeGraph {
  const adapted = graph as RuntimeGraph;
  for (const comp of adapted.components) comp.evalKind = getEvalKind(comp.primitive);
  return adapted;
}
