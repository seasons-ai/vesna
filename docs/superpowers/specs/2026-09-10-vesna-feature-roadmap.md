# Vesna — Feature Development Roadmap

**Date:** 2026-09-10  
**Status:** Proposed  
**Scope:** Post-v0.1 product and engineering plan  
**Repository baseline:** `5576877`

---

## 1. Purpose

This document turns the current repository state into a staged feature roadmap.
It is intentionally outcome-oriented: each phase names the user problem, the
smallest useful feature set, architectural constraints, and acceptance criteria.
Detailed implementation plans should be written separately before work starts on
a phase.

Vesna's product promise remains:

> Do a task live, turn the successful run into a deterministic and reviewable
> flow, then spend model judgement only where determinism is insufficient.

New work must strengthen this loop rather than turn Vesna into a generic agent
framework.

## 2. Current baseline

The repository is beyond the original v0.1 walking skeleton in several areas.
The following capabilities exist today:

- live one-shot work and interactive chat;
- Anthropic, OpenAI-compatible, Responses, and Codex-auth provider paths;
- persisted and resumable conversations;
- traces and interactive crystallisation into YAML flows;
- typed flow inputs, reference resolution, DAG execution, and CSV fan-out;
- assertions, held rows, targeted healing, and external-effect receipts;
- node-level permission modes (`plan`, `ask`, and `auto`) with persisted rules;
- a full-screen TUI with conversation and spec panels, themes, and clipboard
  support;
- repository-local specs represented as typed events;
- task worktrees, a dependency scheduler, builders, and a merge queue;
- offline tests and macOS/Linux CI.

At the time this roadmap was reviewed, the baseline passes:

```text
889 tests across 82 files
TypeScript typecheck
```

The important known gaps are:

1. `script` and `shell` are permission-gated but not OS-contained.
2. A flow cannot call another flow and cannot be triggered by a file watcher.
3. Model changes cannot be evaluated safely against historical runs.
4. Trace metrics are reported as snapshots rather than useful drift trends.
5. Project-local nodes and project memory are described in the original design
   but are not loaded by the runtime.
6. Generalisation still depends on literal proposals and human confirmation;
   there is no measured corpus for improving it.
7. Work scheduling exists as an internal subsystem but is not yet a complete,
   documented user workflow.
8. Packaging is not release-ready (`package.json` is private, and there is no
   supported upgrade or migration path).

## 3. Product principles

Every roadmap item must preserve these constraints.

### 3.1 Determinism is the destination

A feature should move repeated work out of the model loop. If it introduces a
new autonomous loop, it must also define how successful work becomes inspectable
and replayable.

### 3.2 Explicit state transitions

Live, proposed, and crystal states are user-visible. Vesna never silently
crystallises, changes a pinned model, broadens a permission, or publishes a side
effect.

### 3.3 One extension surface

A capability is a registry node. The live agent and the flow engine must not grow
separate tool implementations.

### 3.4 Evidence over claims

Task completion requires machine-produced evidence. Assertion outcomes, command
exit statuses, receipts, and trace events are facts; model prose is not.

### 3.5 Partial failure is normal

Independent rows and tasks continue when one is held. Recovery targets the
smallest failed unit and never repeats a receipted external effect.

### 3.6 Security claims must match enforcement

Process separation is not a sandbox. Documentation and UI must describe the
actual boundary. Stronger claims require OS-level controls and adversarial tests.

### 3.7 Offline core

Engine, flow, policy, crystallisation, and scheduling tests remain network-free.
Provider behavior is isolated behind adapters and tested with recorded or fake
transports.

## 4. Prioritisation

Work is ordered by risk before reach:

1. make existing execution safe and diagnosable;
2. make crystals composable and triggerable;
3. make model-dependent crystals maintainable;
4. expose the existing planning and parallel-work machinery coherently;
5. improve extensibility and distribution;
6. only then attempt smarter automatic generalisation.

The roadmap uses four priority classes:

- **P0 — Trust:** incorrect behavior can damage user data, leak data, or repeat an
  irreversible effect.
- **P1 — Core loop:** directly improves live → crystal → replay → heal.
- **P2 — Adoption:** makes Vesna easier to extend, install, or operate.
- **P3 — Research:** valuable, but success must be measured before it becomes a
  product default.

## 5. Roadmap

### Phase A — Execution safety and recovery (P0)

#### Problem

The current permission layer controls whether dangerous tools are offered and
whether a particular call may proceed, but an approved `script` or `shell` call
still runs with the user's privileges. Long runs also need a clearer durable
recovery contract.

#### Deliverables

1. **Container sandbox for untrusted execution**
   - Add `sandbox: process | container` configuration.
   - Support `vesna run ... --sandbox container` and the same setting for live
     tool calls.
   - Mount only declared inputs and an explicit writable output directory.
   - Disable network by default; allow it only through an explicit policy.
   - Enforce CPU, memory, process-count, and wall-clock limits.
   - Record the sandbox mode and effective grants in every trace.

2. **Durable interruption and resume**
   - Persist node state atomically before and after execution.
   - Add `vesna resume-run <run-id>` for incomplete deterministic runs.
   - Treat interrupted external nodes conservatively: an ambiguous side effect is
     held for human reconciliation, never retried automatically.

3. **Receipt reconciliation**
   - Give external nodes an optional idempotency key and receipt-inspection hook.
   - Add a command that shows ambiguous, confirmed, and absent receipts.
   - Preserve the invariant that one logical row causes at most one external
     effect.

4. **Threat-model documentation**
   - Document boundaries for process, container, credentials, network, and host
     filesystem access.
   - Add adversarial tests for path escape, symlink escape, environment leakage,
     child-process escape, and network access.

#### Acceptance criteria

- A container-mode script cannot read an unmounted host file or reach the
  network when network access is disabled.
- Killing Vesna at every persisted transition leaves a run that can be resumed
  without re-running a completed pure/write node or a receipted external node.
- An external effect with an uncertain outcome is held with an actionable reason.
- Existing process mode remains available but is labelled as uncontained.
- The complete offline suite and typecheck remain green on macOS and Linux.

### Phase B — Flow composition and triggers (P1)

#### Problem

Crystals are useful individually, but users cannot build larger workflows from
reviewed flows or run one when a new file arrives. Copying nodes between flow
files creates drift and weakens reuse.

#### Deliverables

1. **`flow` node**
   - Call a named flow through the registry like any other node.
   - Validate child inputs and expose typed child outputs.
   - Detect recursive flow references before execution.
   - Propagate cancellation, trace lineage, held state, and cost.
   - Keep external receipts unique across parent and child traces.

2. **Declared flow outputs**
   - Extend the flow schema with a typed `outputs` section.
   - Preserve backward compatibility for existing flows.
   - Include outputs in validation, crystallisation, inspect, and dry-run views.

3. **File watcher**
   - Add `vesna watch <flow> --on '<glob>'`.
   - Debounce duplicate filesystem events and wait for files to become stable.
   - Persist trigger cursors so restart does not silently lose work.
   - Define explicit handling for rename, delete, and repeated content.

4. **Trigger abstraction**
   - Keep watch scheduling outside the flow engine.
   - Represent each trigger as an ordinary flow invocation with recorded inputs,
     so future cron or webhook triggers do not create a second execution model.

#### Acceptance criteria

- A parent flow can invoke a child flow and consume a declared typed output.
- Recursive composition fails validation before any node runs.
- A held child identifies the parent node, child flow, row, and failed child node.
- Restarting a watcher neither loses a settled file nor invokes the same content
  twice under the documented deduplication policy.
- Existing flow files continue to parse and run unchanged.

### Phase C — Model lifecycle and drift detection (P1)

#### Problem

An `llm` node may be pinned, but Vesna cannot yet prove that a newer model is a
safe replacement. `doctor` needs trend windows and comparison baselines rather
than only aggregate counters.

#### Deliverables

1. **Trace corpus management**
   - Mark selected historical inputs as regression fixtures.
   - Redact or exclude secrets before fixtures become repository artifacts.
   - Define retention and deletion commands for personal traces.

2. **Model upgrade evaluation**
   - Add `vesna upgrade <flow> --to <provider/model> --check`.
   - Replay only model-dependent nodes where possible.
   - Compare assertions, cost, latency, and output changes against the pinned
     model.
   - Write no flow change until the user explicitly accepts the report.

3. **Drift-aware doctor**
   - Report rolling assertion pass rate, latency, and cost per node.
   - Compare configurable windows and highlight statistically meaningful changes.
   - Separate model drift, input drift, and infrastructure errors where traces
     provide enough evidence; otherwise report the classification as unknown.

4. **Flow provenance**
   - Record crystallisation trace id, provider/model, schema version, and Vesna
     version in flow metadata without making execution depend on volatile data.

#### Acceptance criteria

- An upgrade report is reproducible from a named fixture set.
- Accepting an upgrade produces a small reviewable flow diff; rejecting it
  changes nothing.
- Missing prices are reported as unknown, never estimated silently.
- `doctor` can compare two time windows and link every aggregate to source traces.
- Fixture export detects likely credentials and refuses unsafe output by default.

### Phase D — Integrated spec-to-merge workflow (P1)

#### Problem

The repository contains a spec event store, task scheduler, isolated worktree
builder, and merge queue. These pieces need one user-facing lifecycle with clear
control points and recovery behavior.

#### Deliverables

1. **Plan compiler**
   - Convert approved spec tasks into a validated dependency graph.
   - Reject missing dependencies and cycles before launching builders.
   - Require a verification command or other machine-checkable criterion for
     every task.

2. **Work command and TUI controls**
   - Add a documented command to execute an approved plan.
   - Show queued, running, blocked, failed, verified, and merged states in the
     garden.
   - Allow pause, resume, cancel, and retry of one failed task.

3. **Builder contracts**
   - Give each builder a private worktree and explicit file scope where known.
   - Capture patch, test output, token/cost data, and verification evidence.
   - Prevent a builder from marking its own task done without the verifier event.

4. **Merge queue hardening**
   - Rebase or merge against the latest target before verification.
   - Re-run task verification after integration.
   - Stop dependent merges when integration invalidates evidence.

#### Acceptance criteria

- Two independent tasks can run concurrently in separate worktrees and merge in
  deterministic queue order.
- A failed dependency prevents downstream task execution with a visible reason.
- Cancellation starts no new builders and waits for active writers to settle.
- Only system-produced successful verification can produce `task.done`.
- Restarting Vesna reconstructs plan state from events without model inference.

### Phase E — Extensibility, packaging, and operations (P2)

#### Problem

Contributors can add built-in nodes, but projects cannot safely load local nodes.
Installation is source-oriented, schema evolution is implicit, and support
information is scattered.

#### Deliverables

1. **Project-local nodes**
   - Load nodes from `.vesna/nodes/` through an explicit allowlist.
   - Validate unique names, input/output schemas, effect classes, and runtime
     compatibility before registration.
   - Display source and trust status in `vesna inspect` and permission prompts.
   - Do not execute node module top-level code merely to inspect metadata.

2. **Project memory**
   - Load bounded markdown context from `.vesna/memory/` using deterministic
     ordering and explicit size limits.
   - Show exactly which files entered a model request.
   - Keep memory optional and separate from conversation history.

3. **Versioned schemas and migrations**
   - Version flow, trace, session, permission, and spec-event formats.
   - Add forward-compatible readers where practical and explicit migration
     commands where not.
   - Never rewrite committed flow files without a preview and confirmation.

4. **Release packaging**
   - Publish a reproducible npm package with a working `vesna` binary.
   - Define supported Bun and operating-system versions.
   - Add release notes, checksums/provenance, and upgrade instructions.
   - Add a CLI compatibility smoke test against the packed artifact.

5. **Diagnostics bundle**
   - Add an opt-in, redacted support bundle containing versions, configuration
     shape, logs, and trace metadata but no credentials or content by default.

#### Acceptance criteria

- A local node can be enabled for one project without modifying Vesna source.
- Merely listing a local node cannot execute its implementation.
- Memory inclusion is deterministic, bounded, and visible to the user.
- Old supported flows either run unchanged or fail with a precise migration path.
- A clean machine can install the packed artifact and complete the offline demo.

### Phase F — Measured generalisation (P3)

#### Problem

Automatic generalisation from one successful trace is ambiguous. Shipping a
confident heuristic without measurement would create brittle one-example flows.

#### Deliverables

1. **Anonymised evaluation corpus format**
   - Store trace, intended parameters, accepted graph, and later corrections.
   - Provide local export with mandatory review and redaction.

2. **Generalisation benchmark**
   - Measure literal parameter precision/recall, edge correctness, dropped-step
     correctness, assertion usefulness, and first-replay success.
   - Include adversarial cases where similar literals must remain constants.

3. **Ranked proposals with explanations**
   - Keep human confirmation mandatory.
   - Explain provenance for each candidate: prompt span, CLI argument, repeated
     value, path segment, or data-flow relationship.
   - Prefer abstention over a low-confidence parameter.

4. **Multi-example refinement**
   - Optionally compare several successful traces of the same task.
   - Propose stable constants and varying inputs from observed evidence.
   - Show conflicts rather than resolving them invisibly with a model.

#### Acceptance criteria

- Every proposal strategy has a versioned benchmark result.
- The default strategy beats the current literal baseline on held-out examples
  without reducing first-replay success.
- Users can inspect, rename, reject, or add parameters before writing a flow.
- No confidence threshold enables silent crystallisation.

## 6. Cross-cutting engineering work

The following applies to every phase.

### 6.1 Compatibility

- Add explicit schema versions before making the first incompatible format
  change.
- Test at least one fixture from every supported historical schema.
- Unknown newer schemas fail read-only with a clear upgrade message.

### 6.2 Observability

Every new runtime path emits typed events with:

- run, row, flow, and node identity where applicable;
- start/end timestamps and duration;
- failure class rather than only an error string;
- provider/model and token/cost fields when a model is involved;
- effective permission and sandbox decision;
- parent/child lineage for composed flows and planned work.

Content remains local unless a user explicitly exports it.

### 6.3 Test strategy

- Write reducer, graph, policy, and engine tests without network access.
- Use property tests for at-most-once effects, resume transitions, and composed
  flow receipts.
- Use fake clocks and filesystem adapters for watchers and retention.
- Keep provider wire tests separate from product logic.
- Add integration smoke tests for both macOS and Linux; add Windows only after
  path, process, terminal, and sandbox behavior have an explicit support design.

### 6.4 Documentation

A feature is incomplete until:

- `README.md` describes the user path and limitations;
- `--help` exposes the command and exit behavior;
- configuration fields have examples and precedence rules;
- failure and recovery behavior are documented;
- security-sensitive claims have a matching test or are labelled as assumptions.

## 7. Suggested release sequence

| Release | Primary outcome | Included phases |
| --- | --- | --- |
| `0.2` | Existing execution can be trusted and resumed | Phase A |
| `0.3` | Crystals compose and react to files | Phase B |
| `0.4` | Model-dependent flows can be upgraded with evidence | Phase C |
| `0.5` | A spec can drive isolated, verified parallel work | Phase D |
| `0.6` | Projects can extend and install Vesna cleanly | Phase E |
| `0.7` experimental | Generalisation improves against a benchmark | Phase F |

Release numbers express ordering, not dates. A phase ships when its acceptance
criteria are met; unfinished work is not hidden behind an optimistic version.

## 8. Success metrics

Metrics are local and opt-in for aggregate export.

### Core loop

- percentage of live traces successfully crystallised;
- first deterministic replay success rate;
- percentage of replayed nodes that avoid model calls;
- held rows repaired without replaying unaffected nodes;
- external effects duplicated per logical row (target: zero).

### Reliability

- assertion pass rate by flow/node and version;
- interrupted runs resumed successfully;
- median time from held state to verified recovery;
- ambiguous external receipts requiring manual reconciliation.

### Maintainability

- median flow diff size for model upgrades;
- percentage of flows readable by the current schema version without migration;
- time for a contributor to add and test a node;
- offline test duration and flake rate.

### Generalisation research

- parameter proposal precision and recall;
- graph edge accuracy;
- exploration-step removal accuracy;
- user edits per accepted proposal;
- first-replay success compared with the literal baseline.

## 9. Explicit non-goals for this roadmap

- a hosted multi-tenant cloud service;
- organisation RBAC and billing;
- a browser UI;
- distributed flow execution;
- a marketplace that executes unreviewed third-party code;
- autonomous silent crystallisation;
- claiming process-level isolation is a security sandbox;
- replacing ordinary version control, CI, or package managers.

These may be reconsidered after the local single-user product proves the full
live → crystal → replay → heal loop on real work.

## 10. Recommended execution plan

Repository review at `5576877` confirms that interruption signals and ambiguous
external receipts already have unit coverage, but deterministic runs are still
persisted only after a row completes. The next work should therefore extend that
foundation rather than redesign it.

### Milestone 1 — Durable run state machine

1. Write a short implementation spec defining persisted states for run, row, and
   node (`pending`, `running`, `output_saved`, `asserted`, `held`, `complete`).
2. Define atomic file replacement and compatibility behavior for today's
   `meta.json` and per-row JSON records.
3. Persist transitions before and after each node rather than only after the row.
4. Implement `vesna resume-run <run-id>` using recorded outputs and receipts.
5. Add crash-point tests at node start, output save, assertion save, confirmed
   receipt save, and attempted receipt save.

**Exit gate:** killing execution at every transition resumes without repeating a
completed pure/write node or any confirmed/ambiguous external effect.

### Milestone 2 — Container runner

1. Introduce a runner abstraction shared by live tools and flow nodes.
2. Keep today's process runner as the explicit `process` mode and label it
   uncontained in help, prompts, inspect output, and traces.
3. Add a Linux container backend with declared mounts, a writable output
   directory, network-off default, and CPU/memory/process/time limits.
4. Decide and document macOS behavior explicitly: supported container runtime or
   a precise unavailable result, never silent fallback to process mode.
5. Add adversarial filesystem, symlink, environment, child-process, and network
   tests.

**Exit gate:** container mode cannot read an unmounted host fixture or contact a
local test server, and the effective isolation policy is present in the trace.

### Milestone 3 — Flow contracts and composition

1. Add schema versions before changing flow or trace formats further.
2. Add typed declared flow outputs and expose them through parse, validation,
   inspect, dry-run, and crystallisation.
3. Implement a registry-backed `flow` node with preflight recursion detection.
4. Propagate cancellation, lineage, costs, held details, and receipt identity
   through parent and child runs.

**Exit gate:** an old flow runs unchanged; a parent consumes a typed child output;
a recursive graph fails before execution; a held child is traceable from the
parent row to the exact child node.

### Milestone 4 — File triggers

1. Put trigger scheduling outside the engine and represent a trigger as an
   ordinary recorded flow invocation.
2. Implement `vesna watch <flow> --on '<glob>'` with file-settle detection,
   debounce, and content-based deduplication.
3. Persist trigger cursors atomically and test restart, rename, delete, and
   repeated-content semantics with fake clocks and filesystem adapters.

**Exit gate:** restart loses no settled input and runs no content twice under the
documented policy.

### Milestone 5 — Model lifecycle

1. Add trace retention/deletion and reviewed fixture export with credential
   detection and redaction.
2. Implement named regression fixture sets.
3. Implement `vesna upgrade <flow> --to <provider/model> --check`, replaying only
   model-dependent nodes where possible.
4. Upgrade `doctor` from lifetime snapshots to linked rolling-window comparisons
   for assertion rate, latency, and known cost.
5. Add flow provenance metadata and explicit acceptance of model changes.

**Exit gate:** the same fixture set reproduces an upgrade report; rejecting it
changes no file; accepting it produces only the expected model/provenance diff.

### Milestone 6 — Productise spec-to-merge

1. Add verification commands to the persisted task contract and compile approved
   tasks into a validated DAG.
2. Expose one documented work command and TUI controls for start, pause, resume,
   cancel, and retry.
3. Persist builder attempts, patches, cost, refusals, and verifier evidence as
   typed events.
4. Rebase/merge each candidate onto the latest target and rerun its verification
   before emitting `task.done`.
5. Reconstruct the entire queue from events after restart.

**Exit gate:** two independent tasks build concurrently, merge in stable order,
and only successful post-integration machine verification can finish a task.

### Milestone 7 — Extensibility and release readiness

1. Load bounded, deterministically ordered `.vesna/memory/` context and show the
   exact included files.
2. Design metadata-only discovery and an allowlist for `.vesna/nodes/` before
   importing project code.
3. Version and migrate flow, trace, session, permission, and spec-event formats.
4. Remove `private: true`, define supported Bun/OS versions, and test the packed
   npm artifact on a clean installation.
5. Add an opt-in redacted diagnostics bundle and release/upgrade documentation.

**Exit gate:** a clean machine installs the package and runs the offline demo; a
local node can be inspected without executing its top-level implementation.

### Milestone 8 — Generalisation research

Do not make automatic generalisation a product default yet. First define an
anonymised corpus format, collect reviewed examples, version the current literal
strategy as the baseline, and measure parameter precision/recall, edge accuracy,
dropped-step accuracy, assertion usefulness, and first-replay success. Only ship
a new default when it improves held-out results without lowering replay success.

## 11. Review cadence and stop rules

- Ship one milestone at a time; do not parallelise work across a format boundary
  that the durable-state or schema-version design has not settled.
- Keep `bun test` network-free and TypeScript clean at every merge.
- Review the four core local metrics after each release: first-replay success,
  deterministic node share, held-repair success, and duplicate external effects.
- Stop or redesign any feature that adds an autonomous loop without a clear path
  to a reviewable deterministic flow.
- Defer hosted service, browser UI, distributed execution, marketplace, RBAC, and
  billing until the local live → crystal → replay → heal loop has real usage data.
