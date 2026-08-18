# Vesna

An agent that turns its own work into deterministic, reviewable workflows.

The first time you ask for something, a model does it live: expensive, slow, and
different every time. Vesna records what happened, derives a graph of typed nodes
from it, and — once you confirm the generalisation — freezes that graph into a
**crystal**: a callable flow with declared inputs and per-node assertions.

Every later run is an ordinary program. Tokens are spent only on the nodes that
genuinely need judgement. When an assertion fails, that one node, for that one
row, melts back into live mode, gets repaired, and re-freezes.

> Vesna is the Slavic goddess of spring — the thing that comes back on its own,
> every year, unasked and unsupervised. That is what a crystal is meant to become.

**Status: v0.1, a walking skeleton.** It runs end to end and is covered by 92
tests, but it is early. See [What is not built yet](#what-is-not-built-yet).

---

## The thing it does

```console
$ vesna crystallize trace.json --name client-report
Proposed parameters — confirm before applying:
  "reports/acme.txt"  ->  ${inputs.path}   at read_1.path
  "out/acme.md"  ->  ${inputs.write_2_path}   at write_2.path
Wrote .agent/flows/client-report.yaml
```

You edit that file to confirm which literals are really parameters, then run it
over a data file:

```console
$ vesna run client-report --map clients.csv
run_msyurd00_90pf2f: 2 ok · 1 held
  row 2 held at read_1: ENOENT: no such file or directory, open '.../reports/initech.txt'
```

**Two rows finished. One is held, and it says where and why.** A wrong result is
an event, not a swallowed exception — no green checkmark above an empty file.

Fix the cause, then repair only what held:

```console
$ vesna heal run_msyurd00_90pf2f --flow client-report
run_msyurd00_90pf2f: 3 ok · 0 held
```

```console
$ vesna doctor
read_1   runs 3  asserts 100%  $0.0000/run
write_2  runs 3  asserts 100%  $0.0000/run
```

---

## Install

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/lookoff-dev/vesna.git
cd vesna
bun install
bun test
```

Set `ANTHROPIC_API_KEY` for anything that calls a model. Nothing else does —
the engine, the fan-out, and the repair path all run offline.

---

## Concepts

### Flows are functions

A flow declares typed inputs, so it has one signature and several call sites:

```bash
vesna run client-report --client Acme      # once
vesna run client-report --map clients.csv  # fan out, one run per row
```

```yaml
name: client-report
inputs:
  client: { type: string, required: true }
nodes:
  - id: read_1
    use: read
    in:
      path: reports/${inputs.client}.txt
    assert:
      - non_empty: $.out.text
  - id: write_2
    use: write
    in:
      path: out/${inputs.client}.md
      text: "${inputs.client}: ${read_1.text}"
```

`$.inputs.client` as a whole value keeps its type. `${inputs.client}` inside a
larger string interpolates. Both contribute to execution order, so a node that
reads `out/${parse.name}.md` runs after `parse`.

Flow files live in `.agent/flows/` and are committed, so a change to an
automation arrives as a reviewable diff.

### Assertions make failure loud

Each node declares what must be true of its output.

| Assertion | Catches |
| --- | --- |
| `non_empty: $.out.rows` | an empty result that would otherwise pass silently |
| `has_keys: { value: $.out.rows, keys: [sku, qty] }` | a parse that lost a column |
| `not_matches: { value: $.out.text, pattern: '\{\{.*\}\}' }` | an unsubstituted placeholder shipped to a customer |
| `contains: { value: $.out.text, needle: $.inputs.client }` | the right shape with the wrong content |

A failed assertion holds that row. The others keep going.

### Four failures, not one

| Class | Meaning | Response |
| --- | --- | --- |
| `contract_error` | input does not match the schema | caught before execution; no tokens spent |
| `permission_denied` | a node reached where it may not | never retried, always surfaced |
| `node_error` | the node itself failed | retried, then held |
| `assert_failed` | it succeeded but produced the wrong thing | held, repaired via `heal` |

Collapsing these into one `catch` is what produces a green checkmark above a
wrong result: "it crashed" and "it worked incorrectly" need opposite responses
and look identical from outside.

### Effects and the receipt rule

Every node declares an effect: `pure`, `write`, or `external`. An `external`
node — sending mail, calling a paid API — records a **receipt** when it runs.

**Nodes with a receipt are never re-executed during repair.** Without that rule
the first repair would send every message a second time, which is worse than not
repairing at all. It is covered by a property test over randomised failure
scenarios, not a single example.

---

## Adding a node

This is the whole extension surface. A node registered here is available both as
a tool the live agent can call **and** as a node any flow can use — one
contribution upgrades both.

```ts
import type { NodeDef } from "./src/registry/types";

export const slackNode: NodeDef<{ channel: string; text: string }, { ts: string }> = {
  type: "slack",
  effect: "external", // so repair never double-posts
  async run(input, ctx) {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.SLACK_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: input.channel, text: input.text }),
      signal: ctx.signal,
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error);
    return { ts: body.ts };
  },
};
```

Register it in `src/nodes/index.ts` and it is usable everywhere. Pick the effect
class honestly — it is what the receipt rule keys on.

---

## Layout

```
.agent/
  flows/       *.yaml — crystals, committed and reviewed in pull requests
  traces/      runs, cost, assertion outcomes — gitignored
  config.yaml  model and permissions
```

Permissions are the registry: if no node exists, no capability exists.

```yaml
model: claude-opus-5
permissions:
  nodes: [read, write, shell, llm]
```

---

## What is not built yet

Named honestly, because the gap is deliberate rather than an oversight.

- **Generalisation is not automatic.** Vesna proposes which literals look like
  parameters; you confirm them. Guessing wrong produces a flow that works exactly
  once, and that is an open problem, not a solved one.
- **The `script` sandbox is process isolation, not VM isolation.** Networking is
  off and the filesystem is confined to the working directory, but model-authored
  code still runs on your machine. Scripts appear in pull-request diffs, so review
  is part of the security model.
- No `watch` command, no flow-calling-flow, no `vesna upgrade` for model changes,
  no container sandbox, no memory directory.

---

## Testing

```bash
bun test        # 92 tests, no network access
bun run typecheck
```

The engine is tested against a fake registry, so DAG execution, fan-out,
`held`/`heal` and the receipt invariant all run in milliseconds and offline. The
crystallizer is tested against fixture traces. Only the provider adapter touches
the network, and nothing in the suite does.
