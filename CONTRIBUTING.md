# Contributing to Vesna

The fastest useful contribution is **a new node**, and it is worth explaining why
before the mechanics.

Vesna has one extension point: the node registry. The tools the live agent can
call and the nodes a flow can use are the same objects. So a node you add is
immediately available in both places — one pull request teaches the agent a new
capability *and* lets every crystallised flow use it. There is no second
registration step and no plugin manifest.

That is also why the node's `effect` matters more than it looks: the repair path
keys on it. Get it wrong and repair either repeats a side effect or refuses to
retry something harmless.

---

## Your first node, end to end

### 1. Set up

```bash
git clone https://github.com/lookoff-dev/vesna.git
cd vesna
bun install
bun test          # should be green before you change anything
```

Requires [Bun](https://bun.sh). No other toolchain.

### 2. Write the test first

Nodes are plain objects, so the test needs no harness:

```ts
// tests/nodes/http.test.ts
import { test, expect } from "bun:test";
import { httpNode } from "../../src/nodes/http";

const ctx = { cwd: ".", signal: new AbortController().signal };

test("returns the status and parsed body", async () => {
  const result = await httpNode.run({ url: "https://example.com/api" }, ctx);
  expect(result.status).toBe(200);
});

test("is declared as an external effect", () => {
  expect(httpNode.effect).toBe("external");
});
```

Run it and watch it fail: `bun test tests/nodes/http.test.ts`

### 3. Write the node

```ts
// src/nodes/http.ts
import type { NodeDef } from "../registry/types";

export const httpNode: NodeDef<
  { url: string; method?: string; body?: unknown },
  { status: number; body: unknown }
> = {
  type: "http",
  effect: "external",
  async run(input, ctx) {
    const response = await fetch(input.url, {
      method: input.method ?? "GET",
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      signal: ctx.signal,
    });
    return { status: response.status, body: await response.json() };
  },
};
```

### 4. Register it

In `src/nodes/index.ts`, import it and add one line to `registerBuiltins`. That
is the whole wiring.

### 5. Verify

```bash
bun test
bun run typecheck
```

---

## Choosing the effect class

This is the one decision worth slowing down for.

| Effect | Meaning | Consequence |
| --- | --- | --- |
| `pure` | no observable side effect | repeated freely, including during repair |
| `write` | writes to the local filesystem | must be idempotent — running twice leaves the same state |
| `external` | sends mail, calls a paid API, mutates someone else's system | records a **receipt**; **never re-executed during repair** |

When you are unsure between `write` and `external`, pick `external`. The cost of
being too careful is a node that repair skips; the cost of being too casual is a
customer receiving the same message twice.

---

## What makes a node worth merging

- **One job.** `http` is a node. `http_and_retry_and_parse_csv` is three.
- **Declared shapes.** Give the input and output real types, not `any`. The flow
  validator and the crystallizer both read them.
- **Fails loudly.** Throw on failure. The engine classifies the throw, retries it
  per policy, and holds the row — swallowing an error defeats the entire design.
- **Respects `ctx`.** Resolve paths against `ctx.cwd` (see `safeResolve` in
  `src/nodes/read.ts`) and pass `ctx.signal` to anything cancellable.
- **No credentials in the node.** Read them from the environment.

---

## Where things live

| Path | What is there |
| --- | --- |
| `src/registry/` | node types and the registry itself |
| `src/nodes/` | built-in nodes — most contributions land here |
| `src/engine/` | DAG execution, fan-out, repair, receipts |
| `src/flow/` | flow file parsing and contract validation |
| `src/crystallize/` | trace to proposed flow |
| `src/loop/` | the live agent loop |
| `src/providers/` | model adapters and cost accounting |
| `docs/superpowers/specs/` | the design spec — read this before a structural change |

---

## Tests

```bash
bun test        # the whole suite, no network access
bun run typecheck
```

Two rules the suite depends on:

- **The engine is tested offline.** `llm` is an ordinary registry node, so engine
  tests substitute a fake registry. Do not introduce a direct provider
  dependency into `src/engine/` — it would make the suite need a network and an
  API key.
- **The receipt invariant is a property test.** If you touch repair or effects,
  `tests/engine/receipt.test.ts` must stay green. It asserts that across
  randomised failure scenarios an external effect happens exactly once.

---

## Commits and pull requests

- Conventional-commit style: `feat(nodes): add http node`, `fix(engine): ...`
- Explain **why** in the body, not what — the diff shows what.
- One concern per pull request.
- Everything in the repository is in English: code, comments, docs, commit
  messages.

---

## Bigger changes

Structural work — a new failure class, a change to crystallisation, anything
touching the flow file format — starts with the spec in
`docs/superpowers/specs/`. Open an issue describing the problem before writing
code; the design constraints there are load-bearing, and some of them exist to
prevent failure modes that are not obvious from the source.

## Licence

By contributing you agree that your contribution is licensed under the Apache
License 2.0, as stated in section 5 of the [LICENSE](LICENSE).
