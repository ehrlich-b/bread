// Built-in primitive registry. Importing this module registers the M0 set
// (gates + DFF). Future modules (composites, behavioral) plug in similarly.

import './gates';
import './dff';

export { getPrimitive, listPrimitives, registerPrimitive } from './registry';
