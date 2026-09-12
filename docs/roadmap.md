# Roadmap

What exists, what is being built, and what comes after — in that order, with
what would count as done. The decisions behind each piece are in the commit
messages that made it; this file records the state.

## Shipped

**A coding agent with spec-driven development built in** (`0.3.x`).

- Five phases in the garden — `design → spec → plan → build → done` — reduced
  from a log of typed events in `.vesna/specs/<slug>/`.
- `classify` announces the shape of a request (spike, bounded, architectural);
  `/classify <shape>` lets a person overrule it.
- `/approve spec` and `/approve plan` are the only source of approvals. No tool
  can write one. Changing the plan withdraws its approval.
- `/build` and `vesna build <slug>` run an approved plan: per task, in
  dependency order — a brief cut from `plan.md`, a worker in its own git
  worktree, a fresh read-only reviewer that answers through `review_verdict`,
  up to five fix rounds, then a merge; then a review of the whole branch that
  stops the build on "not met" or a critical finding.
- Machine-wide settings in `~/.vesna/settings.yaml`; a catalog of provider
  presets; `/provider` and `/model`; onboarding that ends with a real call.
- Approvals, read-only tool policy, per-node effect classes, an always-ask
  list for secrets and the event log.

**Recoverable builds** (`0.4.0`). Done as declared: a process
killed mid-build leaves a spec the next `vesna build` refuses until a person
says `--resume`, `--retry <task>` or `--abort` — the same three words as
`/build resume|retry|abort` in the chat — and each is recorded as a
`build.recovered` event, never by editing `events.jsonl`; `/build cancel` and
`ctrl-c` end a build with `build.stopped`, the task in flight marked failed;
a merged task's worktree and branch are removed, an aborted or retried one's
discarded, a stopped one's kept for a person to read.

**Verification in the plan** (`0.5.0`). Done as declared: a
task in `plan.md` declares its check on the line under its heading
(`verify: bun test tests/x.test.ts`); Vesna runs it independently of the
worker — in the task's worktree after the review passes, where a failure is a
fix round on the shared counter, and on the base branch after the merge, where
a failure keeps the merge, writes `verify.failed` and stops the build — with
both logs in `.vesna/specs/<slug>/verify/`; the garden shows which of the
three — worker, reviewer, Vesna — produced a done task's evidence. Beside it:
an approval carries the sha256 of the text it approves and `/build` refuses a
plan that changed since; the chat asks `approve the plan? [y] yes  [n] not
yet` after a turn that leaves one waiting; the bottom line names the
permission mode and the key that cycles it.

**`0.3.2` — trust patch.** Tagged and published. The whole-branch review
gates `done`. The README version follows `package.json` under test. This
roadmap replaces a stale one. One `vesna build` per spec at a time. CI installs
the packed tarball and runs it, not just the checkout.

**Finishing a stopped build** (`0.6.0`). Done as declared: `build.started` names the
sha of the base branch's head, and the reducer's `buildBase` keeps the first
one after the most recent `build.done` — a resume's own `build.started`
carries the same `base`, so the whole-branch review always diffs
`buildBase...HEAD`, the range for the whole build rather than whatever a
resume's own start would have named. A spec whose every task is done but
whose build never finished — the branch review stopped it, or the last
task's merge-stage check is still red on the base — is a finishing build: a
plain `/build` re-runs the red check if there is one, runs no task, reviews
`buildBase...HEAD` again, and ends `build.done` or `build.stopped` as that
review decides; a spec whose build did finish keeps the old refusal,
`nothing to build — every task is merged`. An all-done build left dead and
then aborted keeps its range — only `build.done` closes one — so the next
plain `/build` finishes it over the original range. No build id is needed:
the range `buildBase...HEAD` already names what an id would have named.

**The agent as a server** (`0.7.0`). Done as declared: the TUI is a
client of the same core — `src/core/` owns the session and its turns, the
policy and its questions, the spec and the approval, the build and its
controller; `src/tui/app.ts` subscribes and draws, and
`tests/core/border.test.ts` reads both clients' imports so neither reaches
the agent past the core. `vesna --plain` is the second client, in-process
like the first. `vesna serve` is the core over JSON-RPC 2.0 on stdio with
LSP framing: `initialize`, `send`, `command`, `answer`, `interrupt`,
`shutdown`, `exit`; notifications `transcript`, `state`, `ask`,
`ask.resolved`; `capabilities` in the `initialize` result is the version
handshake. One process and one client at a time, on stdio only: a socket
is a later spec's.

Every console block in the README is verbatim output.

**The editor extension** (`vscode/`, `0.1.0`). A VS Code extension on
`vesna serve`: a side-panel chat with streaming markdown, a card per tool
call from `transcript.step`, and the questions as buttons `y`/`a`/`n`; the
garden as a tree view; `spec.md` and `plan.md` opened as documents; review
findings as diagnostics on the lines they name; the mode in the status bar.
Done when a plan can be approved and a build watched from the editor
without a terminal — met per `vscode/CHECKLIST.md`'s verified items:
activation against a real repo, the status bar's mode cycling, restart
after a killed server, the garden drawn from real server state, and a
finding surfacing as a diagnostic and a Problems entry. Not yet verified
live, honestly: `notFound`/`tooOld` end to end, a no-folder or multi-root
workspace, the 12 s kill path against a genuinely hung server, a real turn
(a permission question, Always, the approve-the-plan buttons, a queued
`send`), Cancel replacing Build mid-build, and the running/failed/blocked
task icons against a live build rather than the pure mapping's unit tests.
Published on the Marketplace as `seasons-ai.vesna` once `release-vscode.yml`
runs on its first `vscode-v*` tag.

## Next

**MCP in the core.** An MCP client added to the tool registry — servers
declared in `.vesna/config.yaml`, their tools reachable under the same
read-only policy as everything else Vesna calls. The registry itself as an
MCP server, so another agent can drive Vesna's tools. Then a `claude-code`
provider on top, driving the `claude` CLI against that server instead of a
model API directly. Done when a configured MCP server's tools show up
policy-gated in a turn, and a `claude-code` provider turn calls one through
the registry's own server.

## Later

**Parallel independent tasks.** The scheduler already orders by dependency and
accepts a concurrency; the loop passes 1. Done when independent tasks build and
review in parallel, merge in a deterministic order, and a dependent task starts
only from the integrated tree — with a concurrency cap and a budget.

**Containment.** `shell` and `script` run with the user's own privileges; the
read-only classifier is policy, not a sandbox, and has needed a fix in every
review. Done when a runner abstraction can put a worker or a reviewer in a
container with no network and a read-only mount of the repository, the mode is
visible in the prompt and the trace, and an uncontained run is never a silent
fallback.

**An evaluation suite.** A corpus of small repositories and tasks, run through
the whole process, measuring task success, false "done", cost, turns, and
whether the reviewer catches seeded defects.

**More clients.** The protocol `vesna serve` speaks is the one the editor
extension is built on; after it, a chat bot that can approve a plan from a
phone. A socket transport and several clients on one session come with the
first client that needs them.

## Not planned

Crystallizing runs into replayable flows. It was the original thesis; an
experiment showed a crystallized flow of a real task contained no model step
and reported success while answering nothing. Removed, with the reasoning in
the commit that removed it.
