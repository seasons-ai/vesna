<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img alt="Vesna" src="assets/logo-light.svg" width="240">
</picture>

*The mark alone — for a favicon, an avatar, anywhere the wordmark does not
fit — ships as the same light/dark pair: `assets/mark.svg` for dark
backgrounds, `assets/mark-light.svg` for light ones.*

A coding agent with spec-driven development built in.

Ask it for a piece of work and it does not start typing. It records a plan,
opens a spec beside your code, and works through the tasks — and it cannot
mark one finished by saying so. To finish a task it hands Vesna a command that
fails when the work is not done, and Vesna runs that command and reads the exit
status. The evidence is produced by the system rather than asserted by the
party being checked.

The state of the work is a log of typed events, reduced into a column you can
watch. "I finished T2" in a chat message is never mistaken for the fact of it.

> Vesna is the Slavic goddess of spring — the thing that comes back on its own,
> every year, unasked and unsupervised.

**Status: v0.2.** It runs end to end and is well covered by tests, but it is
early. See [What is not built yet](#what-is-not-built-yet).

---

## The thing it does

Ask for work, and it is not called done until a check says so:

````console
$ vesna do "add a function sub to math.ts that subtracts two numbers; verify with: grep -q 'export function sub' math.ts"
  · read     0ms
  · edit     2ms
  · plan     5ms
  · task_start 1ms
  · task_verify 17ms

Added to `math.ts`:

```ts
export function sub(a: number, b: number) { return a - b; }
```

Verification passed:

```sh
grep -q 'export function sub' math.ts
```

5 steps · 18.5s · $0.0000
````

In the full-screen chat the same run opens a column on the right — the spec,
its tasks, and which of them have turned cold.

`task_verify` is the only way a task turns cold. The agent may declare a plan
and say which task it has picked up; it may not say a task is done. Vesna runs
the check and decides. A task whose check exits non-zero stays warm, and the
model sees the output rather than getting to retry the claim.

Or in one shot:

```console
$ vesna do "reply with only the number of exported functions in src/cli/flags.ts, as digits"
  · read     0ms

1

1 steps · 4.9s · $0.0000
```

### Exit codes

Scriptable, because "something was left undone" is not the same as "it broke":

| Code | Meaning |
| --- | --- |
| `0` | everything ran |
| `1` | ran, but something the user asked for was left undone |
| `2` | did not run — bad usage, missing credentials |

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

### A claim is not a fact

Every agent can say "done". Vesna separates saying it from it being so.

A task is opened by the model and closed by the system. The model proposes a
check — a test file, a typecheck, a grep — and Vesna runs it. Exit `0` closes
the task; anything else leaves it open and hands the model the output. There is
no other path to closed, which is what makes the column in the garden a record
rather than a mood.

The same rule governs the process around the code. Onboarding reports success
because a model answered, not because a settings file was written. `/provider`
refuses a service it can see has no credential rather than switching and
letting the next turn fail. A status command that says you are signed in while
the next command fails is treated as a bug, not a nuance.

### Effects

Every node declares what it does: `pure`, `write`, or `external`. The
declaration is what the approval layer reads before a call is made — reading
never asks, writing outside the project always asks, and an `external` node
(mail, a paid API) is asked about however the policy is written. A node
declares its worst case, so pick the class honestly.

---

## Adding a node

This is the whole extension surface. A node registered here is a tool the agent
can call, and the effect class you give it is what the approval layer enforces.

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
class honestly — it is what the policy keys on.

---

## Layout

```
.vesna/
  specs/            one folder per piece of work — a log of events, committed
  config.yaml       pins a service to this repository — hand-written
  permissions.yaml  what you have allowed — written by Vesna
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

## The process

Work goes through five phases, in order: `design → spec → plan → build →
done`. These are the garden's own stages — the eight-stage guess an earlier
version shipped conflated review and verify into stages of their own; they
turned out to live inside the build loop instead, once per task, not once
after all of them.

Ask for anything and the agent calls `classify` before writing a line: a
**spike** ends in an answer and keeps no code, a **bounded** change is
designed in the conversation and built without a spec file, an
**architectural** change goes through all five phases. It says why, out
loud, and you can overrule it with `/classify <shape>` — a person's
classification is the event that counts, and no tool can write one. It
classifies once per spec, not every turn: once the log carries a shape, the
agent is told it rather than asked again. When it is unsure it takes the
heavier shape: ceremony costs time, skipping it costs the review that would
have caught the defect.

```text
/spec                        what there is
/spec new <name>             start one by hand
/spec open <slug>            switch to it
/classify <shape>            overrule the agent: spike, bounded or architectural
/approve spec                closes design — the plan can be written
/approve plan                closes plan — /build may run it
/build                       run the approved plan: build, review, merge
ctrl-g                       show or hide the column
```

**Design** is the conversation itself, and the agent fills the column in as
it works. The one thing it may not do is declare a task finished — "I
finished T2" in a chat message is a claim, and a claim is not a fact. To
close a task it hands Vesna a command that fails when the work is not done,
and Vesna runs it and reads the exit status. The evidence is produced by the
system rather than asserted by the party being checked, which is the
difference between a progress bar and a guarantee — `task_verify` holds that
line for a task, and `review_verdict`, below, holds it one level up.

Design ends in `spec.md`. **`/approve spec`** is the only thing that closes
it — no tool call does; an `approved` event exists only because a person
typed the command, in that conversation, on purpose. That opens **plan**:
the model writes `plan.md`, one `### Task N:` heading per task, and calls
`plan` with tasks whose ids — `T1`, `T2`, and so on — match those headings.
**`/approve plan`** is the second and last approval a person types, and the
only thing that unlocks `/build`. A plan nobody has read is not a plan,
whatever the model wrote into it.

**Build** is a loop Vesna runs, not the model — `/build` in the chat, or
`vesna build <slug>` from the shell once a plan is approved. One task at a
time, in dependency order: cut its brief out of the plan, build it in a
worktree of its own, review the diff, fix what the review found, merge, then
the next. This is the shell route, captured verbatim against a two-task plan
("add `sub` to `math.ts`", then "add `mul`", each verified with a `grep`):

```console
$ vesna build demo-arithmetic
  · building
  · T1  building
  · T1  review: met, 0 findings
  · T1  merged e0c6c92
  · T2  building
  · T2  review: met, 0 findings
  · T2  merged 2790604
  · branch  review: met, 0 findings
  · done
$ echo $?
0
```

`/build` in the chat opens with its own line — `building N tasks — events
appear below and in the garden` — then prints the same event lines as the
shell command above, into the transcript and the garden both, from the same
formatter. Only `build.started` is skipped, because that opening line already
said as much.

A review answers through **`review_verdict`**, a tool like `task_verify`:
spec met or not, findings each with a severity, a file, and what is wrong. A
review session may read and run read-only commands and nothing else; prose
that never calls the tool is not a review, it is a failed one, and the loop
does not advance on it. The thing being checked does not get to phrase its
own result — `task_verify`'s rule, one level up.

A finding that survives a fix round starts another one, and five rounds is
the cap. Past it, an Important or Minor finding still open is written down
as a **parked** event and the task is marked done with the finding attached
— on the record, not silently dropped. A Critical still open at the cap, or
a brief still not met after five rounds, stops the whole build instead: that
is not one more round's worth of work, it is the task not doing what was
asked. Once every task has merged, one more review reads the whole branch
with the parked findings beside it; nothing is fixed automatically there — a
person decides.

A build has nobody to ask. `runTask` treats a question it cannot put to
anyone as a refusal, not a silent yes — which is exactly what happened while
writing this section: a first attempt at the run above, in a project left at
the default `ask` mode, stopped on the very first edit:

```console
$ vesna build demo-arithmetic
  · building
  · T1  building
  · stopped: T1: the worker was not allowed to: edit math.ts
vesna: T1: the worker was not allowed to: edit math.ts
$ echo $?
1
```

Set `permissions.mode: auto` in the project's `.vesna/config.yaml` before an
unattended build — see [Permission](#permission) for what `auto` still
refuses regardless.

`vesna build <slug>` exits `0` when every task merged, `1` when it stopped
for a person (a merge conflict, a fix-round cap on a Critical, a plan whose
tasks cannot be ordered, or the refusal above), `2` when it never started:

```console
$ vesna build nope
vesna: no spec called "nope"
$ echo $?
2
```

ctrl-c stops `vesna build` through the log: the task in flight is marked
failed and the build stopped as "interrupted", so the spec can be picked up
again. There is no way yet to interrupt a running build from the chat, and the
chat refuses to leave while one runs — a build killed with its process leaves
the log saying "building" with nothing left to ever say otherwise. A stopped
build leaves its task's worktree and branch behind; the next attempt names the
two `git` commands that clear them.

It lives in `.vesna/specs/<slug>/` and is worth committing: `events.jsonl`
(the log), `spec.md`, `plan.md`, and one brief, one report and one review per
task, all beside the code they describe. The panel is built by reducing the
log, not by reading prose, so the state survives a crash, the reducer is
tested without a terminal, and "I finished T2" in a chat message is never
mistaken for the fact of it.

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

Warm petal marks what a model is doing live; cold ice marks what is settled.
A theme is a table of eleven colours, and two tests keep it
honest — every meaningful colour must clear 4.5:1 against its own background,
and no two may collapse onto the same 256-colour code. Adding one is a small
pull request.

---

## What is not built yet

Named honestly, because the gap is deliberate rather than an oversight.

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
- **Builds run one task at a time.** The scheduler knows which tasks are
  independent, but parallel builds are not switched on — a later change, with
  its own isolation questions.
- **The agent is a terminal program.** There is no server mode, so there is no
  editor extension and no other client. That is the step after `/build`.
- No container sandbox, no memory directory.

---

## Testing

```bash
bun test        # the whole suite, offline
bun run typecheck
```

The garden's reducer, the policy layer, configuration precedence and the
slash commands are all tested without a terminal or a network. The TUI is driven
through a fake terminal and asserted on the rendered screen. Only the provider
adapters touch the network, and nothing in the suite does.

---

## Licence

[Apache License 2.0](LICENSE). Contributions are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md); writing a node is the shortest path in.
