# Build and reuse your own chips

1. Use **New circuit** for a blank workspace. It keeps your existing My chips library.
2. Place gates from the palette and connect their visible pins. Shift-click component bodies to select the fragment you want to reuse; leave switches and LEDs outside if they are test apparatus.
3. Click **Create chip from selection**. Name the chip and each exposed signal, choose input/output/bidirectional directions, then create it. Boundary wires, terminal nets and free pins become ports; internal wires stay inside. Tied pins share a single signal port.
4. Place another copy from **My chips** in the palette. Chips can contain other user chips.
5. Click a chip's **Edit** button to inspect its internal circuit. Drive input ports with **0**, **1**, **Z** (released) or **X** (unknown); read resolved port values alongside them. All input tests start released. These test drivers are temporary and are not saved as hardware.
6. Adjust internal components and wires, rename/rebind ports with **Apply ports**, or select a component pin in **Expose pin** to add a port. **Save chip & return** updates every instance of that definition. **Cancel chip edit** discards the draft, including new chips made inside it. Save rejects an incompatible wired port change and keeps the draft open for repair.
7. Use **Download JSON** for a browser download, **Circuit JSON** to copy the same serialized file from a visible text dialog, or **Save** for a native save dialog. **Paste JSON** opens saved JSON text directly. **Open JSON** selects an existing file; **Load** uses a native open dialog where supported. The file contains the root circuit and all its user definitions. Save the chip draft before saving the project.

Undo/redo includes chip creation, the entire library, port edits and saved definition changes. Component edits rebuild the simulator and reset sequential storage, as other structural editor edits do. Runtime RAM contents, net values and test drives are not checkpoints; initial memory images in component parameters are saved.

User chip IDs are `user.<name>`. Names start with a letter and use letters, numbers, underscores or hyphens; port names start with a letter/underscore and use letters, numbers or underscores. Each saved definition has a `metadata.revision`. Libraries belong to the project file, never to a mutable global registry. Duplicate authoring IDs, broken ports, missing types and hierarchy cycles are rejected, including in unused definitions.

The simulator expands hierarchy at load time into leaf components. Packaging a NAND network improves authoring and reuse; it does not replace that network with a faster evaluator. The synthetic benchmark in `scripts/bench_hierarchy.ts` compares hierarchical loading with an equivalent already-flat circuit, with checked outputs on every input transition. Both execute the same 128 NAND leaves. This is separate from the reference CPU's measured clock and instruction rates and from the interactive Run rate of 1,000 ticks per second.

## Validation and manual evidence

The automated browser regressions build a NAND inverter through palette/pin actions, test four-state inputs, reuse it in a nested two-inverter chip, download/reopen the project, undo/redo creation and reject a breaking wired port rename. These are automated regressions, not the genuine manual CPU ascent.

The first genuine supported-browser stage built two switches, one NAND and one LED in the frozen baseline editor and passed all four truth rows. Screenshots and its action log are under `~/repos/bread-manual-evidence`. That baseline's native Save picker could not be operated by the supported browser tool, so its JSON was unsaved. The new Download JSON action passes automated browser tests, but the supported manual browser also failed to receive its blob download. The visible Circuit JSON dialog provides the serialized checkpoint without depending on a native picker or download event. Manual verification of this candidate and the larger ascent are tracked separately; no CPU construction is claimed here.
