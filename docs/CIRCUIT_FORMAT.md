# Circuit JSON Format

The canonical IR for both saved circuits and composite chip definitions. Versioned, machine-readable, lossless round-trip with the editor.

## Top-level

```json
{
  "version": 1,
  "kind": "circuit",
  "name": "ben_eater_8bit",
  "description": "optional human description",
  "components": [ ... ],
  "nets": [ ... ],
  "ports": [ ... ],
  "metadata": { "createdAt": "2026-04-26T16:00:00Z", "schemaCheck": "..." }
}
```

`kind` is `"circuit"` for top-level circuits and `"composite"` for chips intended for reuse as subcircuits. Composites have `ports`; circuits typically don't.

## Components

```json
{
  "id": "U1",
  "type": "ttl.74LS00",
  "position": [120, 80],
  "rotation": 0,
  "params": {},
  "label": "optional human label"
}
```

- `type` resolves against the registry: built-in primitive, built-in behavioral, or stdlib/user composite by ID. Resolution is name-only; the registry must contain the type at load time, or load fails.
- `position` and `rotation` are schematic-view layout metadata. The engine ignores them.
- `params` is type-specific. The engine validates against the type's parameter schema. Examples:
  - `prim.NAND`: `{ "inputs": 4 }`.
  - `prim.MUX2`: `{ "width": 8 }`.
  - `gen.555`: `{ "frequencyHz": 1 }`.

## Nets

```json
{
  "id": "n_clk",
  "name": "CLK",
  "endpoints": ["U1.CLK", "U2.CLK", "U3.CLK"],
  "waypoints": [[100, 50], [200, 50]]
}
```

- `endpoints` are `componentId.pinName` references.
- `waypoints` are schematic-view routing hints (orthogonal segments). Engine ignores them.
- `name` is optional, user-friendly. Useful for buses, probes, and Verilog export.

A net with one endpoint is dangling; the engine warns but doesn't error (the user may be in the middle of editing).

A net referenced by zero endpoints is invalid; load fails.

## Ports (composites only)

A composite chip declares its external pins:

```json
"ports": [
  { "name": "1A", "dir": "in",  "internalNet": "n_1A" },
  { "name": "1B", "dir": "in",  "internalNet": "n_1B" },
  { "name": "1Y", "dir": "out", "internalNet": "n_1Y" }
]
```

When a circuit instantiates a composite (via `"type": "ttl.74LS00"`), the loader stitches each port into the parent circuit by replacing port references with the actual nets at the call site. This flattening happens once at load time; runtime simulation sees a single flat graph.

## Full example: 74LS00 composite

```json
{
  "version": 1,
  "kind": "composite",
  "name": "ttl.74LS00",
  "description": "Quad 2-input NAND gate.",
  "components": [
    { "id": "g1", "type": "prim.NAND", "params": { "inputs": 2 } },
    { "id": "g2", "type": "prim.NAND", "params": { "inputs": 2 } },
    { "id": "g3", "type": "prim.NAND", "params": { "inputs": 2 } },
    { "id": "g4", "type": "prim.NAND", "params": { "inputs": 2 } }
  ],
  "nets": [
    { "id": "n1A", "endpoints": ["g1.A"] },
    { "id": "n1B", "endpoints": ["g1.B"] },
    { "id": "n1Y", "endpoints": ["g1.Y"] },
    { "id": "n2A", "endpoints": ["g2.A"] },
    { "id": "n2B", "endpoints": ["g2.B"] },
    { "id": "n2Y", "endpoints": ["g2.Y"] },
    { "id": "n3A", "endpoints": ["g3.A"] },
    { "id": "n3B", "endpoints": ["g3.B"] },
    { "id": "n3Y", "endpoints": ["g3.Y"] },
    { "id": "n4A", "endpoints": ["g4.A"] },
    { "id": "n4B", "endpoints": ["g4.B"] },
    { "id": "n4Y", "endpoints": ["g4.Y"] }
  ],
  "ports": [
    { "name": "1A", "dir": "in",  "internalNet": "n1A" },
    { "name": "1B", "dir": "in",  "internalNet": "n1B" },
    { "name": "1Y", "dir": "out", "internalNet": "n1Y" },
    { "name": "2A", "dir": "in",  "internalNet": "n2A" },
    { "name": "2B", "dir": "in",  "internalNet": "n2B" },
    { "name": "2Y", "dir": "out", "internalNet": "n2Y" },
    { "name": "3A", "dir": "in",  "internalNet": "n3A" },
    { "name": "3B", "dir": "in",  "internalNet": "n3B" },
    { "name": "3Y", "dir": "out", "internalNet": "n3Y" },
    { "name": "4A", "dir": "in",  "internalNet": "n4A" },
    { "name": "4B", "dir": "in",  "internalNet": "n4B" },
    { "name": "4Y", "dir": "out", "internalNet": "n4Y" }
  ]
}
```

## Validation

The editor-facing contract is `schema/circuit.schema.json` (JSON Schema 2020-12). Configure your editor to validate circuit JSON files against it for autocomplete and inline error messages.

The runtime loader in `src/engine/loader.ts` performs an equivalent structural check in TypeScript, plus extra rules that the schema can't express:

- Every `type` resolves against the primitive or composite registry.
- Every pin reference (`componentId.pinName`) matches the resolved type's pinout.
- Each pin is on at most one net.
- Cyclic composite imports rejected (engine refuses to load).
- Multiple drivers on the same net are *allowed* at the IR level — they resolve at runtime via tristate logic. The validator does not flag them; runtime contention warnings handle reporting.

If the schema and the loader's runtime checks ever diverge, the loader is authoritative — but the schema is a bug and should be updated.

## Versioning

`version` is a monotonic integer. Migrations live in `src/engine/loader.ts` as `migrate_v1_to_v2`, etc. The loader applies migrations in order. We never mutate a saved file in place.

## What the format does not include

- Schematic styling (colors, line weights). Editor uses defaults; user can override per-instance via `metadata.style` if needed.
- Simulation state (current net values, FF state, RAM contents). That's runtime, not persisted. Snapshot/restore is a separate feature (M7).
- Test inputs / expected outputs. Those go in a sibling `*.test.json` file (see [ROADMAP.md](ROADMAP.md) M7).

## Patches (incremental edits)

For mutate operations across the worker boundary:

```json
{
  "patch": [
    { "op": "addComponent", "value": { "id": "U7", "type": "ttl.74LS04" } },
    { "op": "removeComponent", "id": "U3" },
    { "op": "addNet", "value": { "id": "n_new", "endpoints": ["U7.1A", "U2.Y"] } },
    { "op": "splitNet", "id": "n_old", "atEndpoint": "U2.Y" }
  ]
}
```

Patches are validated, applied atomically, and rolled back on any failure. The engine pauses, applies, and resumes if it was running.
