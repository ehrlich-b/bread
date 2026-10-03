// Built-in behavioral component registry. Importing this module registers the
// shipped set. Worker bundles, test files, and the demo loader pull this in
// for its side effects.

import './gen_555';
import './gen_clock';
import './io_7seg';
import './io_led';
import './io_switch';
import './mem_28c16';
import './mem_6116';
import './mem_74ls189';
import './mem_rom';

export { getBehavioral, listBehavioral, registerBehavioral } from './registry';
