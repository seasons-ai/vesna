# Spec-driven development, built in

Status: approved, not yet implemented
Date: 2026-09-11

## The problem

Vesna's one real claim is that a task is closed by the system, not by the party
being checked. `task_verify` holds that line for a single task. Nothing holds it
for the work around the task.

Yesterday an eleven-task change was built through a process that found a
credential leak before it shipped: a design conversation, a written spec, a
plan, one fresh worker per task, a review after every task, fix rounds with a
cap, and a review of the whole branch at the end. Three real defects lived in
lines no single task's diff touched; only the cross-task reading caught them.

That process ran because the person driving chose to follow it. It lived in
markdown instructions the model could have skipped, in a directory the
repository ignores, and it was orchestrated by hand — dispatching workers,
packaging diffs, resuming implementers with findings. Nothing in Vesna knew it
was happening.

The machinery for the mechanical half already exists and starts nothing.
`src/work/` holds a worktree per task, a builder that runs a session with
nobody to ask, a scheduler over the task graph, and a merge queue that stops
at the first conflict. All four are tested. None is reachable from a command.

## What this is not

The crystallization thesis is gone (see the commit that removed it). This is
its replacement as the thing Vesna is for: not turning work into replayable
flows, but running the process that makes work trustworthy, with the parts
that cost money or correctness owned by the runtime rather than suggested to
the model.

Two prohibitions were considered and dropped by the author: refusing a merge
that has no review, and refusing a commit whose message claims something the
diff does not support. Neither is in scope. The one gate that remains is the
one without which `/build` would be a button the model could press itself.

## Decisions

### 1. A hybrid: conversation where understanding is at stake, a state machine where money is

Brainstorming and writing a spec are dialogue. A state machine there would be
rigid where it needs to be attentive. Building and reviewing are mechanical and
expensive, and a model that skips a review because it felt confident is the
failure this exists to remove.

So the design and spec phases are prompts the model follows, recorded as events
as they happen. Writing the plan is one model call with a fixed prompt and a
file as its output. Build and review are a loop Vesna runs, calling the model
once per step with a step-specific prompt and reading its answer through tools
rather than prose.

### 2. Phases are the garden's stages

The garden already projects a log of typed events into stages. Its stages
become the SDD phases:

```
design → spec → plan → build → done
```

`design` is the conversation that produces a spec. `spec` means one is written
and waiting for approval. `plan` means the spec is approved and a plan is
written or being written. `build` means the plan is approved and tasks are
running. `done` means every task merged and the final review passed.

The existing `plan → spec → build` ordering was a guess made before the process
was run for real; the real order puts the spec before the plan. `STAGES` and
its tests change accordingly.

### 3. The spec folder is the workspace

`.vesna/specs/<slug>/` already holds `events.jsonl`. It now also holds:

```
events.jsonl      the log; every phase change, approval, task, review, ruling
spec.md           the design, written in the design phase
plan.md           the tasks, written in the plan phase
briefs/<task>.md  one per task, extracted from the plan
reports/<task>.md the worker's report, then each fix-round report appended
reviews/<task>.md each review's findings, verbatim
```

Committed, like the events are. A process that produced a branch belongs
beside the branch. The hidden `.superpowers/` directory that held this before,
and was destroyed by a cleanup step at least once, is not used.

### 4. Classification is announced and overridable

Not every request is a project. When asked for work, the agent says which of
three shapes it sees — `spike`, `bounded`, `architectural` — and records that
as an event. A spike ends in an answer and keeps no code. A bounded change is
designed in the conversation and built without a spec file. An architectural
change goes through every phase.

The person can override in a message, and the override is the event that
counts. Getting this wrong in the heavier direction costs ceremony; getting it
wrong in the lighter direction costs the review that would have caught the
defect. When in doubt the agent takes the heavier shape and says so.

### 5. Approval is an event only a person can write

`approved` events carry what was approved — `spec` or `plan` — and are appended
only when the person says so in the conversation. The model has no tool that
writes one.

`/build` refuses a spec whose log has no `approved: plan`. This is the single
prohibition in the design. Without it the model could plan and build in one
breath, and the plan's purpose — a reviewable statement of intent that a person
has read — would be decorative.

### 6. `/build` is a loop Vesna runs

For a spec with an approved plan, in dependency order from the scheduler:

1. **Brief.** The task's text is extracted from `plan.md` into
   `briefs/<task>.md`. The worker reads the brief, never the plan.
2. **Build.** `runTask` from `src/work/builder.ts`, unchanged in principle: a
   fresh session in a worktree, with the brief as its objective and no one to
   ask. It commits or refuses. Its report goes to `reports/<task>.md`.
3. **Review.** A second fresh session, given the brief, the report and the
   diff, under a read-only policy. It must answer through a `review_verdict`
   tool — spec compliance as a boolean, quality findings each with a severity
   and a location. Prose that does not call the tool is not a review, and the
   loop treats a review without a verdict as a failure of the reviewer, not a
   pass.
4. **Fix rounds.** A verdict with a failed spec check or a Critical or
   Important finding resumes the worker with the findings, then runs a scoped
   re-review over the fix diff. Five rounds at most. At the cap, an Important
   or Minor finding still open is recorded as a `parked` event with the
   reviewer's text, and the task is marked complete with it attached rather
   than silently dropped. A Critical still open at the cap stops the build for
   a person (see §8): five rounds that could not close a Critical is a
   structural problem, not one more round's worth of work.
5. **Merge.** The task's branch joins the merge queue. `mergeAll` stops at the
   first conflict and reports it; the conflicting task's branch is left for a
   person.

When every task is merged, one more review session reads the whole branch —
the diff from the base to the head — with the parked findings alongside, and
answers through the same tool. Its findings are recorded; nothing is fixed
automatically at this stage. The person decides.

Every step is an event. The garden shows the task warm while it builds, marks
it with the review's outcome, and turns it cold on merge — the same marks it
uses now, with review states added.

### 7. Reviewers answer with a tool, not with text

`review_verdict` is a node like `task_verify`. Its input schema is the verdict:

```ts
{
  spec: "met" | "not_met";
  findings: { severity: "critical" | "important" | "minor";
              file: string; line?: number; text: string }[];
  summary: string;
}
```

It has effect `pure`, so no policy asks about it, and it is the only node a
review session is offered besides `read` and `shell` restricted to a read-only
command set. The reviewer cannot write, and cannot end its turn with an opinion
the loop has to parse.

This is `task_verify`'s principle applied one level up: the thing being checked
does not get to phrase its own result.

### 8. Rulings are events

When the loop must decide something the plan does not settle — a finding that
conflicts with the plan's text, a worker that reports the brief is wrong — it
records a `ruling` event with what was decided and why, and continues. A person
reads the rulings when the build finishes. A build that stops to ask about
every ambiguity is a build a person has to babysit, which is what the worker
having nobody to ask was meant to avoid.

The four things that stop a build and wait for a person are the ones a ruling
cannot cover: a merge conflict, a worker that refused for policy reasons every
path it tried, the fix-round cap on a finding the reviewer marked Critical, and
a plan whose tasks cannot be ordered.

### 9. The same loop from the command line

`vesna build <slug>` runs the loop non-interactively for a spec with an
approved plan, printing events as they happen, and exits `0` when done, `1`
when it stopped for a person, `2` when it could not start. It is the surface a
later client — an editor, a chat bot — calls after the person approves from
wherever they are.

## Non-goals

- No prohibition on merging without review, and no check of commit messages
  against diffs. Both were considered and set aside.
- No editor extension and no server mode. The loop is written so a client can
  drive it, but no client other than the terminal is built here.
- No parallel builds. The scheduler knows which tasks are independent; this
  design runs them one at a time. Parallelism is a later change with its own
  isolation questions.
- No automatic fixing after the final review.

## Testing

Test-first throughout, and none of it needs a network.

- **Stages.** The reducer projects the five phases in order; an approval event
  moves the stage; a build event on an unapproved plan is rejected by the
  reducer, not just by the command.
- **Classification.** The event is recorded with the shape the agent named; an
  override event replaces it; the heavier shape wins a tie.
- **The gate.** `/build` on a spec with no `approved: plan` refuses and names
  what is missing. With one, it starts.
- **The loop, on a fake provider.** A two-task plan with a dependency: the
  second task does not start before the first merges; a review verdict with an
  Important finding produces a fix round; the fifth round's leftovers become
  `parked` events; a merge conflict stops the loop with exit `1`.
- **The reviewer.** A session that returns prose without calling
  `review_verdict` is recorded as a failed review, and the loop does not
  advance on it.
- **The command.** `vesna build` exit codes for done, stopped, and could-not-start.

## Files

New: `src/sdd/loop.ts` (the build loop), `src/sdd/review.ts` (the reviewer
session and `review_verdict` node), `src/sdd/brief.ts` (plan → briefs),
`src/sdd/classify.ts`, `src/cli/buildcmd.ts`.

Changed: `src/spec/project.ts` (stages, new events), `src/spec/store.ts`
(the folder layout), `src/tui/panes.ts` (review marks), `src/tui/app.ts`
(`/build`, approval), `src/cli/main.ts` (`build` command), `src/loop/prompt.ts`
(phase prompts), `src/work/builder.ts` (report file, resume with findings).

Reused unchanged in principle: `src/work/worktree.ts`, `src/work/schedule.ts`,
`src/work/merge.ts`, `src/nodes/plan.ts`.
