# Vesna — Design Spec

**Date:** 2026-08-18
**Status:** Approved for planning
**Scope:** v0.1 walking skeleton (thin vertical slice through every layer)

---

## 1. Summary

Vesna is an open-source coding agent that turns its own work into deterministic,
version-controlled workflows.

The first time a task is solved, an LLM does it live: expensive, slow, and
non-deterministic. Vesna records the trace, derives a graph of typed nodes from
it, and — after the human confirms the generalization — freezes that graph into a
**crystal**: a callable flow with declared inputs and per-node assertions.

Every later run of that task is an ordinary program. Tokens are spent only on the
nodes that genuinely require judgment. When an assertion fails, that single node,
for that single input row, melts back into live mode, is repaired by the model, and
re-freezes.

The name is the Slavic goddess of spring — the thing that comes back on its own,
every year, unasked and unsupervised. That is what a crystal is meant to become.

## 2. Why this, and not another agent framework

Research across r/AI_Agents, r/automation, r/n8n, r/LocalLLaMA and r/ClaudeAI
(August 2026) surfaced six recurring, independently-reported complaints:

| Reported pain | What Vesna does about it |
| --- | --- |
| Silent failure — "live submission, no pdf, zap still shows green", `{{client_name}}` shipped to a customer | Every node carries assertions; a wrong output is an event, not a swallowed exception |
| "A bug in one of our 20 agents took forever to find" | One reviewable graph with per-node traces instead of N opaque loops |
| "AI agents are overrated, deterministic automation is still king" | Determinism is the destination, reached automatically rather than chosen upfront |
| Unpredictable cost — bills tripling overnight | Crystallized nodes burn no tokens; per-node cost is tracked and trended |
| Compounding error: six steps at 95% is 74% end-to-end | Crystallized steps stop being probabilistic |
| Users are unmoved by capability; they buy "so it just does this by itself every day?" | That sentence is the product |

Dozens of projects already offer a TUI, multi-provider support, themes and a
project memory directory. None of that is a differentiator. The crystallization
loop is.

## 3. Goals and non-goals

### Goals

1. A live agent loop good enough to solve real repository tasks.
2. Crystallization of a completed live run into a reviewable flow file.
3. Deterministic replay of a flow, including fan-out over a data file.
4. Per-node assertions, partial-failure handling, and targeted repair.
5. A node registry that is the single extension point for contributors.

### Non-goals for v0.1

Distributed execution. A web UI. A database. Vector stores. Multi-user support or
RBAC. A hosted cloud. Automatic generalization without human confirmation.

### Success criteria

- A user can solve a task live, crystallize it, and re-run it over a CSV of 200
  rows in a single sitting.
- The engine's full test suite runs with no network access.
- A new contributor can add a working node without reading the engine.

## 4. Core concepts

### 4.1 Three states of a task

- **Live** — the LLM solves from scratch. Maximum capability, maximum cost.
- **Proposed** — Vesna presents the derived graph and the literals it believes are
  parameters. The human edits and confirms.
- **Crystal** — a deterministic flow. The LLM runs only where a node is declared
  to need judgment.

State transitions are explicit user actions. Vesna never crystallizes silently.

### 4.2 A flow is a function, not a script

Every flow declares typed inputs, which gives it one signature and four call
sites: the CLI, the TUI, a `flow` node inside another flow, and a file watcher.

```bash
vesna run client-report --client "Acme" --report q3.pdf
vesna run client-report --map clients.csv        # fan-out, one run per row
vesna watch client-report --on 'inbox/*.pdf'
```

### 4.3 Flow file format

```yaml
name: client-report
inputs:
  client: { type: string, required: true }
  report: { type: file,   required: true }

nodes:
  - id: parse
    use: script
    effect: pure
    in: { file: $.inputs.report }
    assert:
      - non_empty: $.out.rows
      - has_keys: { value: $.out.rows, keys: [sku, qty, total] }

  - id: summary
    use: llm
    effect: pure
    model: <provider>/<model-id>   # pinned at crystallization time
    in: { rows: $.parse.rows, client: $.inputs.client }
    assert:
      - not_matches: { value: $.out.text, pattern: '\{\{.*\}\}' }
      - contains: { value: $.out.text, needle: $.inputs.client }

  - id: send
    use: http
    effect: external
    in: { to: $.inputs.client, body: $.summary.text }
```

Flow files live in `.agent/flows/` and are committed to git, so a change to an
automation arrives as a reviewable diff.

### 4.4 Nodes are the single extension point

A node declares an input schema, an output schema, an effect class, and a `run`
function. **The agent's tools and a flow's nodes are the same objects.** One
contributed node upgrades both the live agent and every crystal at once — this is
the project's contribution surface and the reason the registry sits at the center
of the architecture.

Effect classes:

- `pure` — no observable side effects; safe to repeat freely.
- `write` — writes to the local filesystem; idempotent by construction.
- `external` — sends mail, calls a paid API, mutates a third-party system.

## 5. Architecture

```
  cli ──┐
        ├──► loop   (live agent) ──┐
  tui ──┘                          ├──► registry ──► providers
        └──► engine (crystals)  ───┘        │
                                            └──► sandbox (script node)
  crystallizer ──► store ◄── loop, engine
```

Dependencies point one way only. The TUI and CLI are two skins over the same
event stream and contain no logic of their own.

| Module | Owns | Knows nothing about |
| --- | --- | --- |
| `providers` | model streaming behind one interface | flows, TUI, nodes |
| `registry` | typed nodes: schemas, effect class, `run` | graphs, ordering, the agent |
| `engine` | flow validation, DAG execution, fan-out, assertions | LLMs, TUI |
| `loop` | the live agent cycle, permissions, compaction | flows, crystals |
| `store` | traces, cost, assertion history | everything else |
| `crystallizer` | trace to proposed graph | the hot path |
| `tui` / `cli` | rendering and input | everything but events |

Because `llm` is an ordinary registry node, the engine has no dependency on any
provider. Substituting a fake registry makes the entire engine testable offline.

`crystallizer` is deliberately isolated. It is the only module containing risky
generalization logic; if it proves unreliable, everything else still works and
flows can be authored by hand.

### 5.1 Project layout

```
.agent/
  flows/       *.yaml — crystals, committed and reviewed in PRs
  nodes/       project-local nodes
  memory/      markdown artifacts
  traces/      runs, cost, assertion outcomes — gitignored
  config.yaml  providers, theme, permissions
```

Memory is flat markdown with no vector store and no database. A published
benchmark of eight memory systems over 2176 tasks found a plain markdown wiki
outperformed every product; there is no reason to rebuild what a file tree
already wins at.

### 5.2 Stack

TypeScript on Bun. Distributed as a scoped npm package with a single binary
entry point. Chosen for the largest contributor pool in agent tooling, first-party
provider SDKs, and one-command installation.

## 6. Data flows

### 6.1 Live run to trace

Each tool call is recorded as node type, input, output, duration, tokens, cost and
model, alongside the message thread and an environment fingerprint: working
directory, git SHA, and the **names** — never the values — of environment
variables read.

### 6.2 Trace to proposed graph

1. **Reverse data reachability.** Starting from the final output, walk backwards
   along "output of X fed input of Y" edges. Steps that are unreachable were
   exploration, not work, and are dropped. This is a graph traversal, not a
   heuristic: it is deterministic and explainable.
2. **Typing** is trivial, because the surviving steps were already registry nodes.
3. **Parameterization.** Literals that originated in the user's prompt or in run
   arguments are proposed as `inputs`. The human confirms or edits them.
4. **Assertion synthesis** from what was actually observed: output shape,
   non-emptiness, key sets, absence of unsubstituted placeholders. The model
   proposes a small number of semantic assertions on top, also for confirmation.

### 6.3 Fan-out and partial failure

`--map clients.csv` produces one independent run per row under a shared run id,
with a default concurrency of four.

A row whose assertion fails is marked **`held`, not `failed`**; the remaining rows
complete. The run summary reads `199 ok · 1 held`.

```bash
vesna heal <run-id>
```

wakes the model for held rows only, on the failed node only, with the expectation
and the actual value in context. On success Vesna offers to update the node, and
the next run is deterministic again.

Per-row state is persisted under `.agent/traces/<run-id>/`, so `heal` survives a
closed terminal.

### 6.4 The receipt invariant

Every `external` node writes a **receipt** into the trace when it executes.
**Nodes with a recorded receipt are never re-executed during `heal`.**

Without this rule the first repair would send every email a second time,
reproducing precisely the failure mode Vesna exists to prevent. This is an engine
invariant, covered by property tests from the first commit.

## 7. Error handling

| Class | Meaning | Response |
| --- | --- | --- |
| `contract_error` | input does not satisfy the declared schema | caught during graph validation, before execution; no tokens spent |
| `permission_denied` | a node reached for something not permitted | never retried; always surfaced to the human |
| `node_error` | the node itself failed — network, 5xx, timeout | retried per the node's policy, then `held` |
| `assert_failed` | the node succeeded but produced the wrong output | immediately `held`; repaired via `heal` |

Collapsing these four into one `catch` is what produces a green checkmark above an
empty PDF: "it crashed" and "it worked incorrectly" demand opposite responses and
look identical from the outside.

## 8. Trust boundaries

### 8.1 Permissions are the registry

If no node exists, no capability exists. Permissions are declared in
`config.yaml` per node type, and per pattern for `http` and `shell`. The live
agent and crystals pass through the same check — one mechanism, not two that
drift apart.

### 8.2 The `script` node

`script` executes model-authored code and is the only hole in the model. It runs
in a separate process with networking disabled by default, filesystem access
limited to explicitly passed paths, a timeout, and a memory cap.

This is **process isolation, not VM isolation**, and the README will say so
plainly rather than implying a stronger guarantee. Users needing stricter
containment run `vesna run --sandbox docker`.

One structural mitigation that ordinary agents lack: `script` bodies live in the
flow YAML and therefore appear in pull-request diffs. Review is part of the
security model, not an addition to it.

### 8.3 Model pinning

The `model` field of an `llm` node is pinned in the flow file rather than resolved
from the current default. Changing a default never silently changes a crystal's
behaviour.

Upgrading is explicit:

```bash
vesna upgrade client-report --to <model id>
```

Vesna replays the flow's assertions against inputs saved in prior traces before
offering the switch — a regression test across a model change, which teams
currently perform blind and discover through customer complaints.

### 8.4 Drift detection

Traces accumulate, so per-node assertion pass rate, cost and duration are
trendable.

```
vesna doctor
  client-report › summary   asserts 96% -> 81% over 14 days
  client-report › send      $0.004 -> $0.019 per run
```

Silent failure becomes an observable trend. This falls out of assertions plus
traces; it is not a separate subsystem.

## 9. Testing strategy

- **The engine is tested with no network at all.** Because `llm` is a registry
  node, tests substitute a fake registry. DAG execution, fan-out, `held`/`heal`,
  receipts and contract validation are millisecond unit tests.
- **The crystallizer is tested against fixture traces** committed to the
  repository, as snapshot tests from trace to graph. No model is called.
- **Only provider adapters require network,** covered by contract tests against
  recorded cassettes.
- **The receipt invariant is a property test,** not an example: randomized failure
  scenarios must always yield exactly one external effect per row.

Implementation follows test-driven development.

## 10. Risks

**Generalizing a single trace is the hard problem, and it is not solved here.**
When the agent repaired `src/auth/login.ts`, the flow could reasonably mean "fix
that file" or "fix whichever file the failing test points at". Guessing wrong
produces a flow that works exactly once.

v0.1 therefore performs **no automatic generalization**: Vesna proposes the
parameters it inferred and a human confirms them in an interactive prompt — the
CLI in v0.1, the TUI once it lands. Automatic generalization is deferred to a
later cycle, once a corpus of real flows exists to evaluate it against.

Secondary risk: if everything ends up inside `script` nodes, the declarative
design collapses into code generation with extra steps. Mitigation is to treat
each `script` node in a proposed graph as a signal that the registry is missing a
node, and to surface that count in `vesna doctor`.

## 11. v0.1 deliverable

A thin vertical slice: a minimal live agent loop, a bare CLI, and one real task
crystallized and re-run over a data file end to end. The TUI, themes, and the
broader node catalogue follow in the next cycle, once there is something worth
rendering.
