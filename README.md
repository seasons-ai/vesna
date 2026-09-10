<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img alt="Vesna" src="assets/logo-light.svg" width="240">
</picture>

*The mark alone — for a favicon, an avatar, anywhere the wordmark does not
fit — ships as the same light/dark pair: `assets/mark.svg` for dark
backgrounds, `assets/mark-light.svg` for light ones.*

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

**Status: v0.1, a walking skeleton.** It runs end to end and is well covered by
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
npm install -g @seasons-ai/vesna     # needs Bun: the CLI runs TypeScript directly
```

Or from source:

```bash
git clone https://github.com/seasons-ai/vesna.git
cd vesna
bun install
bun test
```

### The first run

`vesna` with nothing configured sets itself up, then continues into the chat in
the same process. It asks which service to talk to, asks for a model, and then
makes a real call — a short one — before writing anything. A setup that reports
success because a file was written, rather than because a model answered, is
the kind of claim this codebase does not accept from its own agent either.

```console
$ vesna
Which service should Vesna talk to?
  anthropic — Anthropic
  openai — OpenAI
  codex — ChatGPT subscription, borrowed from the Codex CLI
  openrouter — OpenRouter
  groq — Groq — key found in $GROQ_API_KEY
  ollama — Ollama (local)
  lmstudio — LM Studio (local)
  vllm — vLLM (local)
  custom — Anything else that speaks the OpenAI API
service: ollama
model [llama3.2]: qwen3
verified — Ollama (local) answered as qwen3
```

What it writes is `~/.vesna/settings.yaml`, which belongs to Vesna and to this
machine. No project directory is touched: which model you talk to is a property
of your subscription and your laptop, not of a repository, and nothing should
have to exist in a folder before you can work in it.

```yaml
# Written by Vesna. Safe to edit, safe to delete.
# A .vesna/config.yaml in a project overrides everything here.
provider: ollama
model: qwen3
```

The address is not there because the service already carries one. A `baseUrl:`
appears when you point a service somewhere else, when the service has no
address of its own, or after a `/provider` switch records the one it used.

Keys are never written here. This file records the *name* of an environment
variable at most; the value stays in your environment.

Because the file is Vesna's, a value in it that matches no service is reported
rather than fatal. The settings are ignored, and the commands that need a
service — a chat, `vesna do`, `vesna auth`, `vesna init` — refuse and name the
file and the valid ids, while `vesna --help`, `vesna --version`, `vesna doctor`
and a `--dry-run` go on working. A provider named in a project's
`.vesna/config.yaml` still stops everything: a person wrote that line, in that
directory, on purpose.

### Services

`provider:` names a service from a catalog, not a wire format. Adding one is an
entry in `src/providers/catalog.ts` — data, not a code change.

| id | what it is | what it needs |
| --- | --- | --- |
| `anthropic` | Anthropic | `ANTHROPIC_API_KEY`, or an OAuth profile |
| `openai` | OpenAI | `OPENAI_API_KEY` |
| `codex` | ChatGPT subscription, borrowed from the Codex CLI | a `codex login` you already did |
| `openrouter` | OpenRouter | `OPENROUTER_API_KEY` |
| `groq` | Groq | `GROQ_API_KEY` |
| `ollama`, `lmstudio`, `vllm` | local servers | nothing |
| `custom` | anything else speaking the OpenAI API | a `baseUrl` you supply |
| `subscription` | ChatGPT subscription, Vesna's own sign-in | an `oauth` block you write by hand |

Underneath are three wire dialects — Anthropic's, OpenAI chat-completions, and
OpenAI Responses — and each preset says which one it speaks. The internal
message shape is Vesna's own and each adapter translates at the edge, so a flow
written against one model runs against another.

Two entries come with caveats, and they are caveats rather than plans:

- **`custom`** ships no address, because "anything else" cannot have one. It
  asks for a `baseUrl` during the first run, and refuses to build without one
  rather than quietly falling back to api.openai.com. It cannot take an API key
  yet: a key belongs to a named environment variable, and `custom` names none.
  Use it for endpoints that need no credential; for one that does, add an
  entry to the catalog naming the variable to read — that is a data change, not
  a code change.
- **`subscription`** needs an OAuth client identity that Vesna does not ship —
  its own or anyone else's — so it can only be set up by hand, in a project
  config (below). It is deliberately not offered by the first-run menu, which
  writes machine settings and never touches a project directory, and
  `/provider subscription` is refused for the same reason: it writes that same
  machine default, and a directory with no `oauth` block of its own could not
  build what it names.

### Changing your mind

Both from inside the conversation, and both remembered on the machine:

```console
› /provider
anthropic     needs $ANTHROPIC_API_KEY   Anthropic
openai        needs $OPENAI_API_KEY      OpenAI
codex         borrowed from codex        ChatGPT subscription, borrowed from the Codex CLI
subscription  oauth in config.yaml       ChatGPT subscription, Vesna's own sign-in
openrouter    needs $OPENROUTER_API_KEY  OpenRouter
groq          $GROQ_API_KEY              Groq
ollama        no key needed              Ollama (local)  (current)
lmstudio      no key needed              LM Studio (local)
vllm          no key needed              vLLM (local)
custom        needs a baseUrl            Anything else that speaks the OpenAI API

› /provider groq
provider: groq  model llama-3.3-70b-versatile

› /model
llama-3.3-70b-versatile  (current)
llama-3.1-8b-instant

› /model llama-3.1-8b-instant
model: llama-3.1-8b-instant
```

The conversation carries across a change of provider; only an unanswered tool
call left behind by an interrupt is dropped, and you are told when that
happens. A service whose credential is missing is refused here rather than
switched to, because the alternative is a chat that reports success and a next
run that exits 1.

`/model` with no argument asks the endpoint itself what it serves — a question
to a service you are already talking to, not a scan of your machine. Anthropic
and the two subscription endpoints have a fixed roster instead, so for those it
is a written-down list.

### Pinning a project

A repository that must use one service says so in `.vesna/config.yaml`, and
that file wins over the machine settings. Write it with `vesna init`, which
pins whatever is in effect right now:

```console
$ vesna init
Wrote /work/acme/.vesna/config.yaml
            Groq / llama-3.3-70b-versatile, pinned from the settings currently in effect
```

```yaml
# .vesna/config.yaml
provider: groq
auth: key
model: llama-3.3-70b-versatile
baseUrl: https://api.groq.com/openai/v1

# Not written by init: rates are yours to state.
prices:
  llama-3.3-70b-versatile: { input: 0.59, output: 0.79 }  # USD per million tokens
```

A project that pins its provider owns the model that goes with it, so
`/provider` and `/model` there change the machine default instead, and say that
this directory is unchanged. `/model` moves only that default's model, never
its provider — and only where the machine already defaults to the same service
this directory is talking to. The roster you picked the name from is that
service's, so setting it beside a different provider's name would leave the two
halves of one file describing two services. The two files are never mixed: the machine settings
supply a model or an address only when they name the same service the project
pinned, because a provider, a model and an address are one tuple — half of one
service and half of another is a request to the wrong host with the wrong key.

`vesna init` never overwrites an existing config. The file is yours.

Vesna ships prices only for models whose rates it can state accurately. For
anything else, `prices` is where you supply them — a cost report built on an
invented number is worse than no cost report.

### Credentials

The engine, the fan-out and the repair path run offline; only live work — the
chat, `vesna do`, and a node that melted back into live mode — calls a model.

Each service reads the variable its own catalog entry names, and only that one.
An `OPENAI_API_KEY` sitting in your environment is never sent to Groq.

```bash
export ANTHROPIC_API_KEY=...   # a static key
ant auth login                 # or OAuth: refreshed automatically, no key to manage
```

For Anthropic, Vesna reads whatever the Anthropic SDK reads, in the SDK's own
order. `vesna auth` reports which one will actually be used — including the
common trap where a stale `ANTHROPIC_API_KEY` silently shadows an OAuth profile
you thought you were using.

```console
$ vesna auth
provider:   groq  model llama-3.3-70b-versatile
            Groq
endpoint:   https://api.groq.com/openai/v1
credential: GROQ_API_KEY
```

The same verdict is used by the check that runs before a conversation and by
`/provider`, so no surface can tell you that you are signed in while the next
command fails. That covers having somewhere to send the request at all: a
`custom` with no `baseUrl` is refused here, not reported against the address
the OpenAI dialect would otherwise have fallen back to.

A ChatGPT subscription comes in two forms. `codex` borrows the credentials the
Codex CLI already holds — read-only, never refreshed, renewed with `codex
login`. `subscription` is Vesna's own sign-in, and needs an OAuth client of
your own, since Vesna ships no client identity:

```yaml
# .vesna/config.yaml — hand-written; nothing generates this
provider: subscription
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
switches wire format with the service — that is why these are two catalog
entries and not one key swapped for another.

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
theme: vesna          # vesna · hanami · washi · mono
permissions:
  nodes: [read, write, shell, llm]
```

Colour follows the usual conventions: `NO_COLOR` wins, `FORCE_COLOR` overrides,
and piped output carries no escape codes at all.

---

## The garden

Ask for work of several steps and a column opens on the right showing where it
stands — the stages, the acceptance criteria once
there are any, the tasks and who is working on them.

You do not have to start it: recording a plan opens a spec named after the
work, and says so. The commands are there for when you want to steer.

```text
/spec                       what there is
/spec new <name>            start one by hand
/spec open <slug>           switch to it
ctrl-g                      show or hide the column
```

The agent fills it in as it works. It may declare the plan and say which task
it has picked up. It may **not** say a task is finished — "I finished T2" is a
claim, and a claim is not a fact. To finish something it hands Vesna a command
that fails when the work is not done, and Vesna runs it and reads the exit
status:

```text
· plan 1ms
· task_start 0ms
· write 1ms  hello.txt
· task_verify 17ms          grep 'HELLO' hello.txt → 0
```

Only then does the task turn cold. The evidence is produced by the system
rather than asserted by the party being checked, which is the difference
between a progress bar and a guarantee.

It lives in `.vesna/specs/<slug>/` and is worth committing: a spec describes
work on this repository, so it belongs beside the code and can be reviewed with
it. That is the opposite of a conversation, which is personal and lives under
your home directory.

The column is built by reducing a log of typed events, not by reading prose. So
the state survives a crash, the reducer is tested without a terminal, and "I
finished T2" in a chat message is never mistaken for the fact of it. Warm marks
mean live or proposed, cold ones mean settled — the same distinction the palette
makes.

## Permission

`permissions.nodes` decides which tools exist. What each call may actually do
is a separate question, and Vesna asks it:

```text
  write  src/auth/token.ts
  [y] allow once   [a] always src/auth/**   [n] refuse
```

Answering `a` writes the rule to `.vesna/permissions.yaml` — a file Vesna owns
and may rewrite. Your `config.yaml` is never touched: rewriting it would cost
you your comments and layout.

Three modes, and `shift-tab` cycles them. The current one sits in the status
line, because a mode you cannot see is worse than no mode at all.

| Mode | What the agent may do |
|---|---|
| `plan` | look and propose; nothing is changed, and no rule opens a hole in it |
| `ask` | you are asked before anything changes |
| `auto` | changes go ahead, except the irreversible |

```yaml
permissions:
  mode: ask            # plan, ask or auto
  # Every registered node, unless you list the ones you want.
  nodes: [read, write, shell]
  allow:
    shell: ["bun test*"]
  deny:
    write: ["**/*.env"]
```

`auto` allows everything except a short list that cannot be undone by editing a
file afterwards: writes outside the project, credential paths, `sudo`,
`rm -rf`, a force push, a hard reset, publishing a package, piping a download
into a shell. No rule switches those off — an explicit `deny` is the only thing
that overrides the list, because refusing is stricter than asking.

Reading is never asked about. A node declares its worst case — `shell` can do
anything, so it counts as a write — but a command's real effect is visible in
the command, and `ls`, `git status`, `cat` and the rest go through without a
question. The list is conservative: a redirection, a pipe into something
unrecognised, a substitution, a chained second command, or a name nobody knows
all ask. A false "safe" is silent and permanent; an extra question is merely
annoying.

## Conversations are kept

Every chat is written to `~/.vesna/sessions` as it happens — not at exit, so a
killed terminal loses nothing — and grouped by the folder it was held in.

`ctrl-b`, or `/chats`, opens a column of them beside the conversation; click one
to reopen it. The column is the first thing to go when the window is too narrow
to hold it and the conversation both.

```text
/chats          show or hide that column
/history        conversations from this folder
/history all    every folder
/resume 2       reopen one, with the model's own memory of it
```

Resuming restores the conversation rather than a summary of it: the screen
shows what was said, and the model is seeded with the messages it actually saw.

They live under your home directory, never in the repository. A conversation
holds half-formed thinking, local paths and sometimes someone else's code, and
none of that belongs in `git status`. `VESNA_HOME` moves them.

## Copying a message

Every message carries a `⧉ copy` button on the line beneath it — click it and
the message goes to the clipboard as it was written, markdown and all, not as
it was drawn on screen. `/copy` does the same for the last answer without a
mouse.

Over ssh a subprocess would only reach the far machine's clipboard, so Vesna
falls back to OSC 52 and asks the terminal itself.

## Telling the agent about your project

Drop a `.vesna/AGENTS.md` next to your config and it is appended to the agent's
system prompt, every turn:

```markdown
Run `bun test` before you claim anything works.
Never edit files under `migrations/` — they are generated.
```

The rest of the prompt is built from the registry rather than written by hand,
so it describes exactly the nodes this project allows and never promises one it
has withheld. `permissions.nodes` is the single switch: a node that is not
permitted is not offered to the model at all.

## Themes

`vesna` (default), `hanami`, `washi`, and `mono`. `/theme` in a conversation
lists them and `/theme washi` switches immediately — the whole screen repaints,
including everything already said. That lasts the session; to keep it, set it
in `.vesna/config.yaml`:

```yaml
theme: hanami
```

Warm petal marks what a model is doing live; cold ice marks what has been
crystallised. A theme is a table of eleven colours, and two tests keep it
honest — every meaningful colour must clear 4.5:1 against its own background,
and no two may collapse onto the same 256-colour code. Adding one is a small
pull request.

---

## What is not built yet

Named honestly, because the gap is deliberate rather than an oversight.

- **Generalisation is not automatic.** Vesna proposes which literals look like
  parameters; you confirm them. Guessing wrong produces a flow that works exactly
  once, and that is an open problem, not a solved one.
- **`script` is not a sandbox. It runs model-authored code with your own
  privileges.** An earlier version of this README claimed the filesystem was
  confined to the working directory and the network was off. Neither is true,
  and the claim was checked and withdrawn rather than quietly softened. The
  child process gets a fresh environment, its own `cwd`, and a timeout; that
  is all. `globalThis.fetch` is overwritten, which stops the obvious call and
  nothing else — `node:net`, `node:http`, `Bun.connect`, `Bun.spawn`,
  `node:fs` and `Bun.file` are all reachable, so a script can read any file
  your user can read and open any connection your user can open.

  Treat the `script` node the way you would treat `eval` on text a model wrote.
  The real control is `permissions.nodes`: remove `script` and `shell` there and
  the model is never offered them. Actual containment needs OS-level isolation
  and is not built.
- No `watch` command, no flow-calling-flow, no `vesna upgrade` for model changes,
  no container sandbox, no memory directory.

---

## Testing

```bash
bun test        # the whole suite, offline
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
