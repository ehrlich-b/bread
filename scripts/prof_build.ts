import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/engine/behavioral/index';
import '../src/engine/primitives/index';
import type { CircuitJSON } from '../src/engine/ir';
import { loadCircuit } from '../src/engine/loader';
import '../src/stdlib/index';

const here = dirname(fileURLToPath(import.meta.url));
const path = resolve(here, '..', 'examples', 'ben_eater_8bit.json');
const circuit = JSON.parse(readFileSync(path, 'utf8')) as CircuitJSON;
const g = loadCircuit(circuit);
const cnt: Record<string, number> = {};
for (const c of g.components) cnt[c.typeId] = (cnt[c.typeId] || 0) + 1;
console.log(cnt);
console.log('components', g.components.length, 'nets', g.nets.length);
