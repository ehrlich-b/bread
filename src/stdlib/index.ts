// Standard library: register the JSON composites we ship. Side-effect import.
//
// Composite JSON is pulled in via static `import` so the same module works in
// Node (tsx/vitest with resolveJsonModule) and in the browser worker (Vite
// inlines JSON at build time). No filesystem access; portable.

import { registerComposite } from '../engine/composites/registry';
import type { CircuitJSON } from '../engine/ir';
import ls00 from './ttl.74LS00.json';
import ls02 from './ttl.74LS02.json';
import ls04 from './ttl.74LS04.json';
import ls08 from './ttl.74LS08.json';
import ls32 from './ttl.74LS32.json';
import ls86 from './ttl.74LS86.json';
import ls107 from './ttl.74LS107.json';
import ls138 from './ttl.74LS138.json';
import ls139 from './ttl.74LS139.json';
import ls157 from './ttl.74LS157.json';
import ls161 from './ttl.74LS161.json';
import ls173 from './ttl.74LS173.json';
import ls245 from './ttl.74LS245.json';
import ls273 from './ttl.74LS273.json';
import ls283 from './ttl.74LS283.json';
import eaterRegister8bit from './eater.register_8bit.json';
import eaterAlu8bit from './eater.alu_8bit.json';
import eaterRamModule from './eater.ram_module.json';
import eaterProgramCounter from './eater.program_counter.json';
import eaterInstructionRegister from './eater.instruction_register.json';
import eaterFlagsRegister from './eater.flags_register.json';
import eaterOutputDisplay from './eater.output_display.json';
import eaterControlUnit from './eater.control_unit.json';
import { generateMicrocodeHiHex, generateMicrocodeLoHex } from './eater.microcode';

registerComposite('ttl.74LS00', ls00 as CircuitJSON);
registerComposite('ttl.74LS02', ls02 as CircuitJSON);
registerComposite('ttl.74LS04', ls04 as CircuitJSON);
registerComposite('ttl.74LS08', ls08 as CircuitJSON);
registerComposite('ttl.74LS32', ls32 as CircuitJSON);
registerComposite('ttl.74LS86', ls86 as CircuitJSON);
registerComposite('ttl.74LS107', ls107 as CircuitJSON);
registerComposite('ttl.74LS138', ls138 as CircuitJSON);
registerComposite('ttl.74LS139', ls139 as CircuitJSON);
registerComposite('ttl.74LS157', ls157 as CircuitJSON);
registerComposite('ttl.74LS161', ls161 as CircuitJSON);
registerComposite('ttl.74LS173', ls173 as CircuitJSON);
registerComposite('ttl.74LS245', ls245 as CircuitJSON);
registerComposite('ttl.74LS273', ls273 as CircuitJSON);
registerComposite('ttl.74LS283', ls283 as CircuitJSON);

registerComposite('eater.register_8bit', eaterRegister8bit as CircuitJSON);
registerComposite('eater.alu_8bit', eaterAlu8bit as CircuitJSON);
registerComposite('eater.ram_module', eaterRamModule as CircuitJSON);
registerComposite('eater.program_counter', eaterProgramCounter as CircuitJSON);
registerComposite('eater.instruction_register', eaterInstructionRegister as CircuitJSON);
registerComposite('eater.flags_register', eaterFlagsRegister as CircuitJSON);
registerComposite('eater.output_display', eaterOutputDisplay as CircuitJSON);

// The control unit's microcode is generated at module-load time so the source
// JSON stays readable; we patch the contents into the rom_hi / rom_lo params
// before handing the composite to the registry.
const controlUnit = eaterControlUnit as CircuitJSON;
for (const c of controlUnit.components) {
  if (c.id === 'rom_hi') c.params = { ...(c.params ?? {}), contents: generateMicrocodeHiHex() };
  if (c.id === 'rom_lo') c.params = { ...(c.params ?? {}), contents: generateMicrocodeLoHex() };
}
registerComposite('eater.control_unit', controlUnit);
