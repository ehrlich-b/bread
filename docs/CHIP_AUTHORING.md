# Build and reuse your own chips

1. **New circuit** clears the workspace while keeping **My chips**. Place and wire gates, then Shift-click bodies to select a reusable fragment. Leave external switches and LEDs outside the selection.
2. **Create chip from selection** names the chip and its input/output/bidirectional ports. Boundary wires, terminal nets and free pins become ports; tied pins share one signal port.
3. Place copies from **My chips**, including inside other chips. **Edit** opens the internal circuit; drive inputs with **0**, **1**, **Z** or **X** and inspect resolved values. Test drivers start released and are never saved as hardware.
4. Change wiring, **Apply ports** to rename/rebind ports, or **Expose pin** to add one. **Save chip & return** updates every instance. Incompatible wired port changes keep the draft open for repair. **Cancel chip edit** discards the draft, including chips created inside it.
5. Save the chip draft before saving the project. **Save** uses a native dialog, **Download JSON** downloads a file, and **Circuit JSON** exposes text to copy. Reopen through **Load**, **Open JSON** or **Paste JSON**. The file includes the root circuit, definitions and initial memory images.

Undo/redo includes chip creation, library changes and port edits. Structural
edits rebuild simulation and reset sequential state. Live RAM writes, register
values and temporary test drives are not serialized.

Chip IDs are `user.<name>`; names start with a letter and contain letters,
numbers, underscores or hyphens. Port names also allow an initial underscore
but no hyphens. Definitions carry `metadata.revision` and belong to the project.
Validation rejects duplicate IDs, broken ports, missing types and hierarchy
cycles, even in unused definitions.

Hierarchy flattens to leaf evaluators at load time. The
[hierarchy benchmark](../scripts/bench_hierarchy.ts) compares load cost and
checked execution of the same 128 NAND leaves in nested and flat circuits.
Packaging gates does not reduce evaluator count.

[Browser tests](../e2e/chips.spec.ts) cover a NAND inverter, four-state inputs,
nested reuse, download/reopen, undo/redo and rejection of a breaking port
rename. The [four-bit CPU](CPU_ASCENT.md) demonstrates a larger reusable library.
