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

**Finishing a stopped build.** Done as declared: `build.started` names the
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
`nothing to build — every task is merged`. No build id is needed: the range
`buildBase...HEAD` already names what an id would have named.

Every console block in the README is verbatim output.

## In progress

Nothing at the moment — see Next.

## Next

Nothing at the moment — see Later.

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

**The agent as a server.** One protocol, several clients: the terminal first,
then an editor extension that shows the spec, the plan, the garden and review
findings as editor objects, then a chat bot that can approve a plan from a
phone. Done when the TUI is a client of the same core.

**An evaluation suite.** A corpus of small repositories and tasks, run through
the whole process, measuring task success, false "done", cost, turns, and
whether the reviewer catches seeded defects.

## Not planned

Crystallizing runs into replayable flows. It was the original thesis; an
experiment showed a crystallized flow of a real task contained no model step
and reported success while answering nothing. Removed, with the reasoning in
the commit that removed it.
