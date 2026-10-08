# Declarative testbenches

A testbench names circuit inputs and outputs and checks a sequence of vectors.
Version 1 is JSON, validated against [the schema](../schema/testbench.schema.json)
by both the Node runner and the UI. Bindings, widths and loop references are
also checked before simulation. No extra chips are needed.

```json
{
  "version": 1,
  "name": "Buffer truth table",
  "circuit": "buffer.json",
  "inputs": { "D": ["data_net"] },
  "outputs": { "Q": ["output_net"] },
  "vectors": [
    {
      "for": { "value": { "from": 0, "to": 1 } },
      "vectors": [
        { "drive": { "D": { "var": "value" } }, "expect": { "Q": { "var": "value" } } }
      ]
    },
    { "drive": { "D": "Z" }, "expect": { "Q": "X" } }
  ]
}
```

## Signals and values

`inputs` and `outputs` map names to arrays of runtime net IDs in
**least-significant-bit first** order. A bus is just several net IDs. Input
nets receive external drivers: `Z` releases that driver, leaving any circuit
drivers active. To change a switch rather than contend with its existing
driver, use an input binding such as
`"A": { "component": "a", "pin": "Y" }`. This form supports `io.switch` only.
Flattened composite net IDs work too; the SAP-1 corpus demonstrates them.
These maps provide testbench names without requiring `io.pin_input` or
`io.pin_output` components.

Values are nonnegative JSON integers that fit the signal width, or
**most-significant-bit first** strings such as `"10XZ"`. Signals may have up
to 53 bits. `"X"` and `"Z"` alone apply to every bit; expected `"-"` means
don't-care for every bit. Mixed expectations such as `"1-0X"` check only the
specified bits. Expected `X` and `Z` are exact states, never don't-care.
Pure logic inputs read released `Z` as `X`, following ordinary engine rules.

## Vectors, clocks and loops

Each vector optionally has `label`, `drive`, and `expect` maps. Inputs omitted
from `drive` retain their previous values; outputs omitted from `expect` are
unchecked. The circuit starts from power-on state on every run. It settles
once initially and after all drives in each vector, before checking outputs.
An optional `rateHz` sets the simulation time base (default: 1,000 ticks/s).
It does not change clock component frequencies or pace the runner in real time.

A vector may additionally select **one** timing operation:

| Field | Behavior before checking outputs |
| --- | --- |
| `"clock": "CLK"` | Drive a one-bit input through `0`, `1`, `0`, settling each phase after the data has settled. Autonomous clocks do not advance. |
| `"ticks": 20` | Advance 20 engine ticks, including autonomous clocks. |
| `"wait": { "rising": "CLK", "when": { "OI": 0 }, "maxTicks": 1000 }` | Tick until the named one-bit output rises `0→1`, with the optional output conditions satisfied **before** that tick. Fail if no qualifying edge arrives within the bound. |

Expectations are read after the operation. Edge sampling preserves repeated
OUT values; waiting for an output value to change would lose repeated writes.
Contention can be checked with expected `X`; oscillation always fails.

A loop uses `for` and a nested `vectors` array. Each variable takes either an
explicit list (`"bit": [0, 1]`) or an inclusive ascending range
(`"row": { "from": 0, "to": 7 }`). Multiple variables form a Cartesian
product in written order; nested loops are allowed. Values can reference
`{ "var": "row" }`, extract a bit with `{ "var": "row", "bit": 2 }`, or
select an entry with `{ "table": [0, 1, 1, 0], "index": "row" }`.
There is no executable expression language or random input generation.

Runs are limited to 10,000 expanded vectors, 100,000 simulation settlements
including ticks, and 16 nested loops. Before allocating expanded vectors, the
runner also limits their aggregate signal values to 100,000: each `drive`,
`expect`, and `wait.when` entry, plus each clock or rising-edge signal, counts
once per expanded vector. Signal bit operations are limited to 1,000,000,
counting each driven or expected bit, three drives per clock bit, and each
wait condition bit plus two edge reads per possible tick (`maxTicks`). These
budgets sum across all loops and vectors, even if a run stops or replays early.
Oversized runs report a budget error before preparing values. At least one
output bit must be checked.

## Running and debugging

From Node:

```sh
node --import tsx scripts/testbench.ts examples/testbenches/full_adder.json
node --import tsx scripts/testbench.ts examples/testbenches/register_bus_4bit.json
node --import tsx scripts/testbench.ts examples/testbenches/sap1_fibonacci.json
```

`circuit` resolves relative to the testbench file. An optional second CLI
argument overrides it. The CLI stops at the first failure, prints its vector
number, label, inputs, expected and actual bits, and exits nonzero on failure
or invalid input. The engine API is `runTestbench(circuit, testbench, options)`;
`stopOnFailure: false` checks every vector, and `capture: true` records probes.
`throughVector` optionally stops after a numbered vector for diagnostic replay.

In the **Testbench** panel, load a JSON file or paste it, then click **Run
testbench**. The runner pauses the open circuit and tests a fresh copy in the
worker. Its circuit file hint is ignored in the UI. Results list pass/fail
for every vector and show mismatch details. The live circuit's storage and
switches stay as they were; editing its structure clears obsolete results.

With probes present, failures can focus the waveform cursor. In testbench
recordings the waveform tick coordinate is the reported **settlement step**,
starting with initial settle at 0; clock pulse phases each get their own
sample. Capture retains the latest 8,192 samples; selecting an evicted failure
replays deterministically through that vector to recover its waveform.
Ordinary run/pause/step
recordings resume when the next live waveform is delivered.

The [bundled corpus](../examples/testbenches) checks all eight full-adder
combinations, all sixteen register values with shared-bus release/contention,
and three ordered SAP-1 Fibonacci OUT cycles, including both initial ones.
Vitest runs these same files in CI. The format takes inspiration from Digital's
named test-case columns, loops, bit expansion and clock markers, with a smaller
JSON-only vocabulary.
