# Simulator comparison — 2026-10-10

Retain main's hand-inlined typed-array simulator and recommend archiving the
competing truth-table rewrite. The requested acceptance gate is at least 25%
faster across the selected representative workloads, with identical results
and no feature loss. The CPU cases pass the speed gate; the hierarchical
128-NAND workload gains only 18.8%, so the complete gate fails. No
`proposal/truth-table-sim` branch is created. The source branch is preserved.

The comparison uses the integrated feature set on main and the final
`9d17e9302c64ad458012ac9956ffe42351331b65` table algorithm as an isolated test
fixture. Both use the same loader, circuits, behavioral leaves and primitive
semantics, including main's additional TTL chips. The table algorithm is
unchanged apart from imports and a constructor adapter supplying its internal
`evalKind` metadata. It is never imported by the production simulator.

## Correctness

Both backends pass the same 991 Vitest tests, including Icarus export/import oracles, the
full-net trace lock, original CPU ISA programs, SAP-1 gallery, clocks, four-state
resolution, editor interleavings and main's TTL additions. The identical 99
differential/callback/reentry vectors also pass against the table backend.
These include 64 seeded random circuits × 256 ticks, exhaustive compiled
input arities, driver masks, graph mutation, exceptions and synchronous reentry.

Before timing each workload, the benchmark checks 2,049 snapshots of every net,
component state, committed driver, diagnostic and probe waveform directly
between main and tables. It repeats those checks after every alternating
measured block, outside the timed region. No expected trace or assertion is
weakened. The serverless main browser suite passes all 117 tests.

## Speed

| Workload | Main operations/s | Truth-table operations/s | Gain | Gate |
| --- | ---: | ---: | ---: | --- |
| eater-0-probes | 47,447 | 84,763 | +78.6% | PASS |
| eater-8-probes | 46,538 | 82,973 | +78.3% | PASS |
| original-cpu-active-loop | 8,465 | 14,954 | +76.7% | PASS |
| hierarchy-128-nand | 21,010 | 24,952 | +18.8% | FAIL |

Eater and the original CPU report ticks/s; Eater clock Hz is ticks/s divided by
two. Hierarchy reports forced-input transitions/s, each including a full
settlement through 128 NAND leaves. The CPU cases reproduce the existing
Eater/probe benchmark and original-CPU differential loop. Hierarchy reproduces
`bench_hierarchy.ts` at depth seven. It is a synthetic combinational workload,
retained in the gate to cover work beyond free-running CPU circuits.

Seven trials use 100,000 measured ticks and 10,000 warmup ticks per backend;
hierarchy scales these to 5,000 transitions and 500 warmup transitions. The
backends share a process, alternate execution order every 1,000 operations,
and alternate which runs first across trials. Medians are computed separately
for each backend. All per-trial rates are retained in the [raw JSON](benchmarks/2026-10-10-simulators.json).

Host: Apple M4, macOS arm64, Node v26.10.0. The process runs with macOS
background QoS and nice(15); browser rendering, loader construction, correctness
checks and memory sampling are excluded from throughput. These are headless
integration results, not unrestricted performance-core or interactive UI rates.

## Memory and construction

| Workload | Main heap MiB | Tables heap MiB | Main buffers KiB | Tables buffers KiB | Main RSS MiB | Tables RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| eater-0-probes | 2.001 | 2.064 | 29.95 | 63.03 | 76.66 | 67.24 |
| eater-8-probes | 2.029 | 2.093 | 157.95 | 191.03 | 76.54 | 67.55 |
| original-cpu-active-loop | 7.839 | 8.098 | 89.88 | 166.18 | 115.08 | 103.51 |
| hierarchy-128-nand | 0.943 | 0.917 | 6.77 | 17.41 | 72.84 | 71.65 |

Memory figures are medians of three fresh child processes per workload/backend.
After parsing the shared circuit inputs, each child forces GC twice, records a
baseline, constructs the graph/simulator, runs 1,000 operations, forces GC twice,
and records usage while retaining the simulator. Heap and ArrayBuffer columns
are deltas from that baseline. RSS is absolute process resident memory and
includes allocator/runtime overhead, so it is not a graph-size estimate.
Probe buffers are included. Raw JSON also records peak RSS and graph counts.

Tables add about 3% retained heap on CPU workloads and 33–76 KiB of net/driver/
truth-table buffers. RSS is lower in these samples, which reflects runtime and
allocator behavior rather than proving a smaller simulator graph.

| Workload | Main construction ms | Tables construction ms |
| --- | ---: | ---: |
| eater-0-probes | 18.57 | 35.86 |
| eater-8-probes | 29.76 | 22.10 |
| original-cpu-active-loop | 61.11 | 124.29 |
| hierarchy-128-nand | 22.28 | 24.74 |

Construction includes loading, simulator construction and initial settling,
but excludes the subsequent 1,000 operations. Three samples show CPU startup
costs and substantial variance in the probe case; no construction-speed claim
is used in the acceptance gate.

## Reproduce offline

```sh
npm test -- --maxWorkers=2 --minWorkers=1
BREAD_DIFFERENTIAL_BACKEND=truth-table npm test -- --maxWorkers=2 --minWorkers=1 src/engine/differential.test.ts src/engine/sim.callbacks.test.ts src/engine/sim.reentry.test.ts
BREAD_TEST_BACKEND=truth-table npm test -- --maxWorkers=2 --minWorkers=1
npm run typecheck
npm run build
npm run demo:check
BREAD_E2E_IN_MEMORY=1 CI=1 npm run e2e -- --workers=1
taskpolicy -b nice -n 15 node --expose-gc --import tsx scripts/bench_simulators.ts 7 100000
```

All tools and browser assets used here were already installed. No network,
push, gh or SSH operations are part of this workflow.
