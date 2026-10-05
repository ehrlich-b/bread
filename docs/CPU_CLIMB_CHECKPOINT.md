# Initial NAND-to-CPU baseline — 2026-10-02

This is the historical baseline, preserved to distinguish early source-only
work from later manual evidence. At that point the supported browser tool was
unavailable in the source environment and no manual circuit had been built.
The later local browser task built 14 reusable modules and a CPU through the
editor. See [current ascent status and evidence](CPU_ASCENT.md). The baseline
findings and pending steps below describe the original state, not the current
capabilities. Bundled SAP-1 and full-adder imports remain reference checks.

## Capability and ownership

- Workspace: `/Users/ehrlich/repos/bread`; start: clean `main` at `f240834`.
- Local branch: `codex/cpu-climb-capability-baseline`. No push, deployment, tag,
  release, paid resource, or external infrastructure change.
- No `AGENTS.md` was found in the repository or existing ancestor locations.
  README and roadmap were read first.
- Browser and Chrome skills are installed. Their required interactive tool,
  `mcp__node_repl__js`, is absent from the available/deferred tool catalog. There
  is no tool-search facility to expose it, nor any desktop interaction tool.
  `open_in_codex` can open a tab but does not inspect or operate it. Its screen
  capture tool is restricted to active voice chats and is unavailable for this
  text task. No browser control library was invoked through an unsupported
  execution route.
- Shell tests are available. The default sandbox cannot bind the local dev
  server; automatic approval review allowed the existing Playwright suite to
  launch its own server/browser. This does not provide a manual UI surface.
- Port 5173 was occupied by an unrelated application. Its process was preserved.
  Automated tests ran with a separate test-owned server on port 5187. That server
  ends with the Playwright run; there is no interactive editor left under agent
  control.
- Remote host/path: `github.com`, `ehrlich-b/bread.git`. On 2026-10-03 a fresh
  `gh repo view --json isPrivate,nameWithOwner,url` returned `isPrivate: false`.
  Public repository visibility is verified; unpushed local changes remain local.
- A source-only archive of commit `583ae7e` was prepared and uploaded to Library
  before the later instruction to withhold all exports/transfers. That upload
  exceeded the intended preparation scope and was disclosed. It has not been
  refreshed, and does not include the subsequent reference program tests or
  evidence. The local archive remains under `/tmp/bread-cpu-climb-baseline/`.
  Further export/transfer is on hold pending separately verified scope/approval.
  Source ownership remains on this local branch; coordinate source edits before
  applying changes from another environment.

## Completed changes and evidence

The editor previously computed the next circuit and undo target before waiting
for earlier worker requests. Serializing only requests allowed later edits to
overwrite earlier ones. The fix resolves each action against committed state
inside the queue, handles repeated wiring as a no-op, reserves pending placement
IDs, and computes relative rotations when their action executes. Fourteen
regressions cover rapid placement, selection deletion, fan-out/merging, inspector
edits, repeated undo/redo/rotation, and rejected transitions. Eight of the first
nine regressions failed before the fix. See [editor tests](../src/ui/editor.test.ts)
and [before-fix output](evidence/cpu-climb-2026-10-02/editor-before-fix.txt).

The blink smoke tests expected an isolation-status string that the app no longer
sets. They now check the actual browser isolation flag and the schematic SVG.
The isolated suite passed all 32 existing browser tests. It continues to be
ordinary automated testing; its imported netlists are not manual checkpoints.

Five [reference program tests](../src/stdlib/eater.programs.test.ts) compare the
bundled CPU to a separate integer ISA interpreter: addition/subtraction,
load/store, a countdown with taken/untaken JZ and JMP, an overflow carry branch,
and repeated OUT instructions. They compare ordered outputs, A/B, PC, flags,
all 16 addressed RAM bytes, halt, and state stability while the raw clock keeps
ticking. The oracle imports no microcode, TTL definitions, or gate logic.

The Fibonacci integration test now checks three complete ordered output cycles,
including the repeated initial `1`. The previous set-of-values assertion hid
that duplicate, and README/roadmap/example descriptions incorrectly omitted it.
Documentation now agrees with the program. This is a reference-machine
documentation correction, not a CPU implementation change.

| Verification | Result | Evidence |
| --- | --- | --- |
| Original unit suite | 301 passed | [baseline](evidence/cpu-climb-2026-10-02/vitest-baseline.txt) |
| Final unit suite | 320 passed, 28 files | [final](evidence/cpu-climb-2026-10-02/vitest-final.txt) |
| TypeScript | passed | [typecheck](evidence/cpu-climb-2026-10-02/typecheck.txt) |
| Production build | passed | [build](evidence/cpu-climb-2026-10-02/build.txt) |
| Existing automated browser suite | 32 passed | [browser suite](evidence/cpu-climb-2026-10-02/e2e.txt) |

Independent review has not yet occurred. The hierarchy UI has not been
implemented or manually verified.

## Performance, with limits

Host: macOS 15.6.1, arm64, Node v25.6.1. Both measurements use the bundled
Fibonacci reference, 307 flattened components, 344 nets, 20,000 warmup ticks,
and 200,000 timed ticks. Rates are single local samples, not hardware-independent
guarantees. No engine optimization was made.

| Measurement | Result | Meaning |
| --- | --- | --- |
| Existing pure tick benchmark | 154,379 ticks/s, 77,190 inferred cycles/s | No timed output observation; [raw output](evidence/cpu-climb-2026-10-02/bench-unobserved.txt) |
| Correctness-observed benchmark | 151,462 ticks/s, 75,731 counted cycles/s, 15,146 counted instructions/s | 100,000 rising edges, 20,000 T4→T0 instruction completions, 2,222 checked OUTs during timing; observation cost included; [metrics](evidence/cpu-climb-2026-10-02/bench-observed.json) |
| Interactive Run request | 1,000 ticks/s | Source setting, not an observed throughput or frame-rate result |
| Render frame rate | unmeasured | Needs interactive profiling in the parent browser |

Reproduce the observed run with
`node --import tsx scripts/bench_eater_observed.ts 200000`. It checks three
Fibonacci cycles during warmup and every timed OUT against a sequence calculated
with integer arithmetic. It refuses undefined architectural bits and oscillation.
Clock edge counts and instruction completions are observed, not estimated from
the tick count. The full unit/program suite is a separate correctness gate.

The ordinary `tsx` CLI requires an IPC socket blocked by this sandbox. Using its
supported Node import route runs the same TypeScript locally without that CLI
socket. The unobserved command is
`node --import tsx scripts/bench_eater.ts 200000`.

A Node CPU profile places 46.2% of samples in `settle`, 15.5% in `tick`, and
12.9% in `computeNetValue`. This profile includes startup/warmup and TypeScript
loader overhead; it is evidence of hot paths, not an allocation or browser
profile. [Profile summary](evidence/cpu-climb-2026-10-02/profile.txt); raw profile
is `/tmp/bread-cpu-climb-baseline/eater-reference.cpuprofile`.

The observed timed run emitted 30,595 diagnostics. In a separate 5,000-tick
sample, all 765 warnings were bus contention; there were no oscillations. At
the end of each warned settle, there were zero conflicting strong drivers and
zero X-valued warned nets. These observations identify transient propagation
contention in that sample, not a proof that every possible program is free of
contention. No warning suppression or four-state behavior change was made.
[Warning details](evidence/cpu-climb-2026-10-02/diagnostics.json),
[settled checks](evidence/cpu-climb-2026-10-02/diagnostics-after-settle.json).
Event retention and per-event UI logging need scrutiny before a high-speed
interactive mode: the current engine event array and DOM log grow without a
bound.

Hierarchy is an authoring facility in this engine, not a runtime accelerator.
`loadCircuit` recursively flattens every composite to leaf evaluators before
simulation. There is no hierarchical execution backend to compare against
flattening. Do not claim a speedup just from packaging NAND gates into a chip.
Any eventual primitive promotion must first preserve four-state and sequential
behavior against the manually authored module.

Interactive clock speed also needs separate treatment: Run passes 1,000 as
both the wall-clock tick request and the clock generator's time resolution.
With the reference's 2 Hz generator, the half-period is 250 ticks, so the
requested CPU clock remains 2 Hz. Raising only the worker tick request changes
the clock's tick resolution rather than accelerating its requested frequency.
The headless benchmarks use `rateHz=1`, so their generator toggles each tick.

## Source-confirmed blockers and first manual checkpoint

No port authoring, new-chip workspace, user-component palette registration,
chip edit propagation, or project-contained user library is mounted by
`src/app/main.ts`. The palette is a static `PALETTE` array. The file controls
load one `CircuitJSON`. The composite registry is module-global and rejects
replacement. `loadCircuit` rejects `kind="composite"` as a top-level input.
These are source findings; confirm discoverability and errors in the actual UI
when a supported manual control surface is available.

The first pending manual checkpoint is intentionally small:

1. Open the transferred Bread app with COOP/COEP and establish a blank schematic
   through supported editor actions. Record the actual clearing/new-file flow.
2. Place two switches, one NAND, and one LED using the palette. Connect their
   visible pins using the editor wire tool. Save the resulting circuit through
   the user-facing Save action; keep that downloaded file as the checkpoint.
3. Toggle all four input rows and record Y: `00→1`, `01→1`, `10→1`, `11→0`.
   Repeat a wire action, move/rotate/undo/redo, save/reopen, and recheck the table.
4. Capture genuine screenshots and a sequence of user-visible actions. Do not
   replace this stage with a generated JSON circuit or direct app-state writes.
5. Build a tied-input NAND inverter and two-NAND AND through those same actions.
   Check floating inputs and the UI's presentation of `X`/`Z` separately.

No step above has been executed manually during this run.

## Next implementation and ascent scope

Priorities are ordered by the missing dependency, not by implementation size.

1. Parent establishes supported browser control. Any source export/transfer must
   first receive separate scope/approval under the latest instruction. Keep
   manual artifacts and automated reference checks in separate folders.
2. Implement the smallest reusable-chip workflow: New circuit/New chip, a named
   chip workspace, expose an existing pin/net as a named input/output/inout port,
   an input test panel, Save chip, a My chips palette section, Edit chip, and a
   clear return-to-parent path. Port testing uses a temporary harness, so switch
   drivers/LED testers never leak into saved chip bodies. Use the existing
   composite IR and generic pin renderer.
3. Save self-contained project definitions with stable user type IDs and a
   versioned project envelope; retain the existing circuit format for ordinary
   imports. Main thread and worker must receive the same user definitions.
   Keep built-ins protected and clear project-scoped registrations on switching
   projects. Validate cycles, names, missing nets, unknown types and port edits
   before committing. Preserve the old project/run state on failure and display
   actionable errors. A breaking port edit must identify affected instances.
   Undo/redo must include definitions and chip-edit context, not just the canvas.
4. Test save/reopen/revisions, nested chips, cycle rejection, four-state/tristate
   boundaries, sequential clock/reset, edit propagation and repeated actions.
   Obtain independent review and verify the complete creation/reuse flow in UI.
5. Manually author and prove NAND-derived NOT/AND/OR/XOR, mux, half/full adder,
   then a ripple adder. Reuse only components authored through the UI. Build a
   NAND latch and clocked storage with explicit reset, then registers, ALU,
   counter and control/datapath blocks. Keep a saved circuit, table/trace,
   screenshot and action log per milestone.
6. Assemble a useful small accumulator CPU with arithmetic, memory load/store,
   and conditional branches/loops. The existing SRAM/EEPROM may supply storage
   and microcode through supported inspector actions. All custom datapath and
   control wiring must be performed visibly. Compare programs to an independent
   ISA oracle; the bundled CPU remains a separately labeled reference.
7. Profile that manually authored CPU before optimizing. Measure checked cycles
   and instructions/sec, interactive speed, event/message/log costs, load-time
   flattening and render responsiveness separately. A fast-forward control needs
   distinct virtual time resolution and wall-clock speed, bounded worker batches,
   responsive pause/step, and bounded/coalesced diagnostic presentation.

The mountain test is incomplete until these manual milestones are executed.
