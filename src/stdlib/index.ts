// Standard library: register the JSON composites we ship. Side-effect import.
//
// Implementation note: we read the JSON files synchronously via fs at module
// init. When the engine eventually ships in a browser worker (M3+), this will
// move to bundler-handled JSON imports.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerComposite } from '../engine/composites/registry';
import type { CircuitJSON } from '../engine/ir';

const here = dirname(fileURLToPath(import.meta.url));

const load = (filename: string): CircuitJSON => {
  return JSON.parse(readFileSync(resolve(here, filename), 'utf8')) as CircuitJSON;
};

registerComposite('ttl.74LS00',  load('ttl.74LS00.json'));
registerComposite('ttl.74LS04',  load('ttl.74LS04.json'));
registerComposite('ttl.74LS08',  load('ttl.74LS08.json'));
registerComposite('ttl.74LS32',  load('ttl.74LS32.json'));
registerComposite('ttl.74LS86',  load('ttl.74LS86.json'));
registerComposite('ttl.74LS173', load('ttl.74LS173.json'));
registerComposite('ttl.74LS283', load('ttl.74LS283.json'));
