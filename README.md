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

Talk to it, get it right, then freeze it:

```console
$ vesna chat
vesna · claude-opus-5 · /help for commands, ctrl-c to interrupt

› read reports/acme.txt and write a summary to out/acme.md
  · read      12ms
  · write      4ms

Wrote the summary.

› /crystallize client-report
  "reports/acme.txt"  ->  ${inputs.source}   at read_1.path
  wrote .vesna/flows/client-report.yaml
```

`/crystallize` is the point of the conversation: you iterate until the agent
does the thing correctly, then that exact run becomes a flow you can replay over
two hundred rows without a model in the loop.

Or in one shot, without the conversation:

```console
$ vesna do "summarise reports/acme.txt into out/acme.md"
  · read   412ms
  · write   18ms

Wrote the summary.

2 steps · 6.1s · $0.0412 · trace live_msyz1k_a7f2c9

next: vesna crystallize live_msyz1k_a7f2c9 --name client-report
```

Then freeze it:

```console
$ vesna crystallize live_msyz1k_a7f2c9 --name client-report
Proposed parameters — confirm before applying:
  "reports/acme.txt"  ->  ${inputs.path}   at read_1.path
  "out/acme.md"  ->  ${inputs.write_2_path}   at write_2.path
Wrote .vesna/flows/client-report.yaml
```

In a terminal, `crystallize` walks the proposed parameters with you — accept,
skip, or rename each one — and writes a flow that is already parameterised. Off
a terminal it accepts every suggestion, so it works in a script too.

Nothing here is hand-written: `do` records the trace, `crystallize` reads it back
by id, and values that flowed between steps are wired as references rather than
frozen as constants.

Then run it over a data file:

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

### Exit codes

Scriptable, because "some rows are held" is not the same as "it broke":

| Code | Meaning |
| --- | --- |
| `0` | everything ran |
| `1` | ran, but at least one row is held and needs repair |
| `2` | did not run — bad usage, bad flow, missing credentials |

---

## Install

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/lookoff-dev/vesna.git
cd vesna
bun install
bun test
```

### Models

Vesna talks to two provider families. The internal message shape is its own, and
each adapter translates at the edge — so a flow written against one model runs
against another.

```yaml
# .vesna/config.yaml
provider: anthropic
model: claude-opus-5
```

The second adapter speaks the OpenAI chat-completions protocol, which means one
adapter covers **OpenAI, AIMLAPI, OpenRouter, DeepSeek, Together, vLLM and
Ollama** — anything that implements it:

```yaml
provider: openai
model: llama3.1
baseUrl: http://localhost:11434/v1   # Ollama; omit for api.openai.com
prices:
  llama3.1: { input: 0, output: 0 }  # USD per million tokens
```

Vesna ships prices only for models whose rates it can state accurately. For
anything else, `prices` is where you supply them — a cost report built on an
invented number is worse than no cost report.

### Credentials

Only `vesna do` calls a model. The engine, the fan-out, and the repair path all
run offline, so most of Vesna needs no credentials at all.

Vesna reads whatever the Anthropic SDK reads, in the SDK's own order:

```bash
export ANTHROPIC_API_KEY=...   # a static key
ant auth login                 # or OAuth: refreshed automatically, no key to manage
```

For the OpenAI provider, set `OPENAI_API_KEY` — or point `baseUrl` at a local
host, which needs no credential at all.

A ChatGPT subscription is an authentication *mode* of the same provider rather
than a provider of its own. It is opted into, and needs an OAuth client of your
own: Vesna ships no client identity, its own or anyone else's.

```yaml
provider: openai
auth: subscription
oauth:
  issuer: https://auth.openai.com
  clientId: <your client id>
  baseUrl: https://chatgpt.com/backend-api/codex
```

```console
$ vesna auth login
How would you like to sign in?
  1  browser      opens https://auth.openai.com
  2  headless     print the URL to open elsewhere
  3  API key      paste a key instead
```

Every screen in the browser is the provider's; the only page Vesna serves is the
one you land on afterwards. Tokens go to `~/.config/vesna/auth.json` at mode 600
and are refreshed automatically.

A subscription token is accepted only by the Responses endpoint, so Vesna
switches wire format with the auth mode — that is why this is a mode and not
just a different key.

`vesna auth` reports which one will actually be used — including the common trap
where a stale `ANTHROPIC_API_KEY` silently shadows an OAuth profile you thought
you were using.

```console
$ vesna auth
credential: OAuth profile "default"
            OAuth profile from `ant auth login`
profiles:   default (~/.config/anthropic)
```

Subscription credentials from Claude Pro or Max are a different mechanism and
are not supported: a consumer subscription covers Anthropic's own products, not
third-party software. `ant auth login` gives the same key-free experience through
the developer platform.

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

Flow files live in `.vesna/flows/` and are committed, so a change to an
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
.vesna/
  flows/       *.yaml — crystals, committed and reviewed in pull requests
  traces/      runs, cost, assertion outcomes — gitignored
  config.yaml  model and permissions
```

Permissions are the registry: if no node exists, no capability exists.

```yaml
model: claude-opus-5
theme: vesna          # vesna · ember · dusk · mono
permissions:
  nodes: [read, write, shell, llm]
```

Colour follows the usual conventions: `NO_COLOR` wins, `FORCE_COLOR` overrides,
and piped output carries no escape codes at all.

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

---

## Licence

[Apache License 2.0](LICENSE). Contributions are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md); writing a node is the shortest path in.
