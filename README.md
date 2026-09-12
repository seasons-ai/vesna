<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img alt="Vesna" src="assets/logo-light.svg" width="240">
</picture>

*The mark alone — for a favicon, an avatar, anywhere the wordmark does not
fit — ships as the same light/dark pair: `assets/mark.svg` for dark
backgrounds, `assets/mark-light.svg` for light ones.*

[![stars](https://img.shields.io/github/stars/seasons-ai/vesna?style=flat&color=e8a4b8)](https://github.com/seasons-ai/vesna/stargazers)
[![npm](https://img.shields.io/npm/v/@seasons-ai/vesna?style=flat&color=9fc5e8)](https://www.npmjs.com/package/@seasons-ai/vesna)
[![downloads](https://img.shields.io/npm/dm/@seasons-ai/vesna?style=flat&color=9fc5e8)](https://www.npmjs.com/package/@seasons-ai/vesna)
[![ci](https://img.shields.io/github/actions/workflow/status/seasons-ai/vesna/ci.yml?style=flat&branch=main)](https://github.com/seasons-ai/vesna/actions/workflows/ci.yml)
[![licence](https://img.shields.io/badge/licence-MIT-lightgrey?style=flat)](LICENSE)

A coding agent with spec-driven development built in.

**Status: v0.3.** Early, tested, and honest about what it does not do yet.

## Who this is for

Vesna is built for the moment when work with a coding agent stops being a
chat and becomes a process: a request is classified, designed, written up,
planned, and approved — then built by subagents in parallel git worktrees,
each task reviewed by a fresh reviewer that can read and cannot write, each
merged only when its review passes. The person approves twice and reads the
result; the runtime does the rest, and shows every step as it happens.

It is for two kinds of people. Those who want that process done for them,
fast, with the evidence on screen. And those who want to learn how
spec-driven development works by watching one run — the column on the right
is the whole method, live.

## The idea

A task is finished when a check the system ran says so, not when the agent
says so. `task_verify` takes a command that fails when the work is not done;
Vesna runs it and reads the exit status. A review counts only if the
reviewer answered through `review_verdict`, not in prose. A plan builds only
if a person typed `/approve plan`; no tool can. The state of the work is a
log of typed events, so "I finished T2" in a chat message is never mistaken
for the fact of it.

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

## Install

```bash
npm install -g @seasons-ai/vesna     # needs Bun: the CLI runs TypeScript directly
```

Then run `vesna`. With nothing configured it asks which service to use,
finds any key already in your environment, and proves the choice with one
real call before writing anything:

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

That writes `~/.vesna/settings.yaml` — a machine-wide default that any folder
uses until a project pins its own with `vesna init`:

```yaml
# Written by Vesna. Safe to edit, safe to delete.
# A .vesna/config.yaml in a project overrides everything here.
provider: ollama
model: qwen3
```

Switch from inside a conversation with `/provider` and `/model`; both list
what is available and say whether a credential was found. `custom` needs a
`baseUrl`; `subscription` needs an `oauth` block in a project's config.

## The process

Five phases, in order: `design → spec → plan → build → done`. Ask for
anything and the agent calls `classify` first — a **spike** ends in an
answer, a **bounded** change is designed in the conversation and built, an
**architectural** one goes through every phase. Overrule it with
`/classify <shape>`; a person's word is final.

```text
/spec                        what there is
/spec new <name>             start one by hand
/spec open <slug>            switch to it
/classify <shape>            overrule the agent: spike, bounded or architectural
/approve spec                closes design — the plan can be written
/approve plan                closes plan — /build may run it
/build                       run the approved plan: build, review, merge
/build cancel                stop it after the task in flight is interrupted
/build resume                a build a killed process left: continue that task
/build retry <task>          redo one task from scratch
/build abort                 abandon the interrupted build
ctrl-g                       show or hide the column
```

`/build` runs the approved plan one task at a time, in dependency order: a
brief cut from `plan.md`, a worker in its own worktree, a reviewer that must
answer through `review_verdict`, up to five fix rounds, then a merge. After
the last task a review of the whole branch stops the build on "not met" or a
critical finding. Every step is an event; the garden shows it live. The same
loop from the shell:

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

An unattended build cannot ask you anything. In the default `ask` mode the
first write is a question, and a question nobody can answer is a refusal:

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
unattended build, and know what that means: under `auto` the approval gate
binds you, not the model's shell. Exit codes: `0` done, `1` stopped for a
person, `2` never started —

```console
$ vesna build nope
vesna: no spec called "nope"
$ echo $?
2
```

`ctrl-c` and `/build cancel` end a build through the log: the task in flight
marked failed, the build stopped. A process killed outright writes nothing,
so the log still says "building" — and the next `/build` refuses:

```console
$ vesna build demo-arithmetic
vesna: a build of "demo-arithmetic" was interrupted — /build resume, /build retry <task>, or /build abort
  from the shell: vesna build demo-arithmetic --resume | --retry <task> | --abort
$ echo $?
2
```

`resume` continues the interrupted task in the checkout it was left in,
`retry <task>` throws that checkout away and builds the task again, `abort`
abandons the build. A merged task's worktree and branch are removed; a
stopped task's are kept, so there is something to look at.

## Permission

Three modes in `.vesna/config.yaml` — `plan` looks and changes nothing, `ask`
asks before each new kind of action and remembers your answer, `auto` allows
everything but the always-ask list: secrets, the spec's event log, `sudo`,
`rm -r`, force pushes, publishing. Reading never asks. A reviewer's shell is
held to a read-only allowlist.

This is policy, not a sandbox. `shell` and `script` run with your own
privileges; the classifier that decides what is read-only has needed a fix in
every review it has had. Containment is on the roadmap, not claimed.

## Roadmap

**Now — a stable SDD agent, and the automation around it.** Recoverable
builds have shipped: a process killed mid-build can be resumed, retried, or
abandoned from the chat or the shell, and a merged task's worktree is cleaned
up. Next in this line: verification declared in the plan and re-run after
the merge.

**Next — the editor.** The agent as a server, and a VS Code extension that
shows the spec, the plan, the garden and the review findings as editor
objects — the process beside the code it is about.

**Later** — parallel independent tasks, containment for workers and
reviewers, and an evaluation suite that measures whether the reviewer catches
what it should.

Detail, and what counts as done for each, in [docs/roadmap.md](docs/roadmap.md).

## Contributing

An issue first, then a pull request — [CONTRIBUTING.md](CONTRIBUTING.md) has
the three rules and why. Vulnerabilities go to [SECURITY.md](SECURITY.md),
not a public issue.

## Contributors

<a href="https://github.com/Lookoff-AIMLAPI"><img src="https://avatars.githubusercontent.com/u/227839683?v=4" width="40" height="40" alt="Lookoff-AIMLAPI" style="border-radius:50%"></a> — started it, and keeps the reviewer honest.

Merged a contribution? Add yourself here — avatar, link, and one sentence if
you like. See [CONTRIBUTING.md](CONTRIBUTING.md#contributors) for the three
limits on the sentence.

---

## Licence

[MIT](LICENSE).
