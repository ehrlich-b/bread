// Built-in behavioral component registry. Importing this module registers the
// shipped set. Worker bundles, test files, and the demo loader pull this in
// for its side effects.

import './gen_clock';
import './io_led';
import './io_switch';

export { getBehavioral, listBehavioral, registerBehavioral } from './registry';
