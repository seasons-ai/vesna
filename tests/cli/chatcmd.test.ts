import { test, expect } from "bun:test";
import {
  CHAT_COMMANDS,
  approvalQuestion,
  approveOutcome,
  buildBusy,
  buildFailed,
  buildStart,
  cancelElsewhere,
  classifyOutcome,
  parseChatInput,
  quitCancelling,
  quitTimedOut,
  recoverOutcome,
  specSwitchBlocked,
} from "../../src/cli/chatcmd";
import { project } from "../../src/spec/project";

test("plain text is a message, not a command", () => {
  expect(parseChatInput("read src/a.ts")).toEqual({ kind: "message", text: "read src/a.ts" });
});

test("a leading slash is a command", () => {
  expect(parseChatInput("/exit")).toEqual({ kind: "command", name: "exit", argument: "" });
});

test("a command carries the rest of the line as one argument", () => {
  expect(parseChatInput("/spec new client report")).toEqual({
    kind: "command",
    name: "spec",
    argument: "new client report",
  });
});

test("an unknown command is reported rather than sent to the model", () => {
  expect(parseChatInput("/nope")).toEqual({ kind: "unknown", name: "nope" });
});

test("a blank line is nothing at all", () => {
  expect(parseChatInput("   ")).toEqual({ kind: "blank" });
});

test("a path that happens to start with a slash is still a message", () => {
  expect(parseChatInput("/Users/me/file.ts is broken")).toEqual({
    kind: "unknown",
    name: "Users/me/file.ts",
  });
});

test("every advertised command is recognised by the parser", () => {
  for (const command of CHAT_COMMANDS) {
    expect(parseChatInput(`/${command.name}`).kind).toBe("command");
  }
});

test("the help listing covers exit and provider, the two that matter", () => {
  const names = CHAT_COMMANDS.map((c) => c.name);
  expect(names).toContain("exit");
  expect(names).toContain("provider");
});

const open = project([{ t: "created", id: "x", title: "X" }]);

test("/approve is a command", () => {
  expect(CHAT_COMMANDS.map((c) => c.name)).toContain("approve");
});

test("approving the spec names what was approved", () => {
  expect(approveOutcome("spec", open, true)).toEqual({
    kind: "approved",
    what: "spec",
    message: "approved: spec — the plan can be written now",
  });
});

test("approving the plan says what it unlocks", () => {
  expect(approveOutcome("plan", open, true)).toEqual({
    kind: "approved",
    what: "plan",
    message: "approved: plan — /build will run it",
  });
});

test("approving with no spec open is refused", () => {
  expect(approveOutcome("plan", null, true)).toEqual({
    kind: "refused",
    message: "nothing to approve — no spec is open",
  });
});

test("approving something that is not spec or plan is refused, naming both", () => {
  expect(approveOutcome("everything", open, true)).toEqual({
    kind: "refused",
    message: 'approve what? "spec" or "plan"',
  });
});

test("approving with nowhere to write it says so, not \"approved\" in a different tone", () => {
  expect(approveOutcome("plan", open, false)).toEqual({
    kind: "refused",
    message: "cannot approve — nothing is recording this conversation",
  });
});

test("/classify is a command", () => {
  expect(CHAT_COMMANDS.map((c) => c.name)).toContain("classify");
});

test("/classify <shape> is a person's call, and says it stands over the agent's", () => {
  for (const shape of ["spike", "bounded", "architectural"] as const) {
    expect(classifyOutcome(shape, open, true)).toEqual({
      kind: "classified",
      shape,
      message: `classified: ${shape} — your call, which stands over the agent's`,
    });
  }
});

test("/classify with no spec open is refused", () => {
  expect(classifyOutcome("bounded", null, true)).toEqual({
    kind: "refused",
    message: "nothing to classify — no spec is open",
  });
});

test("/classify with a shape that is not one of the three is refused, naming them", () => {
  for (const argument of ["", "huge", "Bounded"]) {
    expect(classifyOutcome(argument, open, true)).toEqual({
      kind: "refused",
      message: 'classify as what? "spike", "bounded" or "architectural"',
    });
  }
});

test("/classify with nowhere to write it says so", () => {
  expect(classifyOutcome("bounded", open, false)).toEqual({
    kind: "refused",
    message: "cannot classify — nothing is recording this conversation",
  });
});

test("/build is a command", () => {
  expect(CHAT_COMMANDS.map((c) => c.name)).toContain("build");
});

test("/build with no spec is refused", () => {
  expect(buildStart(null, "idle")).toEqual({ kind: "refused", message: "nothing to build — no spec is open" });
});

test("/build on an unapproved plan is refused, naming the command", () => {
  const t = project([{ t: "created", id: "x", title: "X" }, { t: "task.added", id: "T1", title: "a" }]);
  expect(buildStart(t, "idle")).toEqual({ kind: "refused", message: "the plan is not approved — /approve plan" });
});

test("/build on an approved plan starts, and says how many tasks", () => {
  const t = project([
    { t: "created", id: "x", title: "X" },
    { t: "task.added", id: "T1", title: "a" },
    { t: "task.added", id: "T2", title: "b" },
    { t: "approved", what: "plan" },
  ]);
  expect(buildStart(t, "idle")).toEqual({ kind: "start", message: "building 2 tasks — events appear below and in the garden" });
});

test("/build on a spec whose every task is merged is refused, so no review of an empty diff is paid for", () => {
  const t = project([
    { t: "created", id: "x", title: "X" },
    { t: "task.added", id: "T1", title: "a" },
    { t: "task.added", id: "T2", title: "b" },
    { t: "approved", what: "plan" },
    { t: "build.started" },
    { t: "task.started", id: "T1" },
    { t: "task.done", id: "T1" },
    { t: "task.started", id: "T2" },
    { t: "task.done", id: "T2" },
    { t: "build.done" },
  ]);
  expect(buildStart(t, "idle")).toEqual({ kind: "refused", message: "nothing to build — every task is merged" });
});

test("/build while a build is running is refused", () => {
  const t = project([
    { t: "created", id: "x", title: "X" },
    { t: "task.added", id: "T1", title: "a" },
    { t: "approved", what: "plan" },
    { t: "build.started" },
  ]);
  expect(buildStart(t, "running")).toEqual({ kind: "refused", message: "a build is already running" });
});

test("a rejected build says so in the loop's own words, not a generic crash message", () => {
  expect(buildFailed(new Error("git add failed: boom"))).toBe("build failed: git add failed: boom");
});

test("switching specs mid-build is refused, so the running build's events are not redirected", () => {
  expect(specSwitchBlocked()).toBe("a build is running — wait for it to stop before switching specs");
});

const deadTree = project([
  { t: "created", id: "x", title: "X" },
  { t: "task.added", id: "T1", title: "a" }, { t: "task.added", id: "T2", title: "b" },
  { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  { t: "build.started" }, { t: "task.started", id: "T1" }, { t: "task.done", id: "T1" },
  { t: "task.started", id: "T2" },
]);
const idleTree = project([
  { t: "created", id: "x", title: "X" },
  { t: "task.added", id: "T1", title: "a" },
  { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
]);

test("/build on a dead build refuses with the three actions", () => {
  expect(buildStart(deadTree, "dead")).toEqual({
    kind: "refused",
    message: "a build was interrupted — /build resume, /build retry <task>, or /build abort",
  });
});

test("/build on a running build still says so", () => {
  expect(buildStart(deadTree, "running")).toEqual({ kind: "refused", message: "a build is already running" });
});

test("/build resume names the task it continues", () => {
  expect(recoverOutcome("resume", deadTree, "dead")).toEqual({
    kind: "recover", action: "resume", task: "T2", message: "resuming T2 in its own checkout",
  });
});

test("/build retry T2 names the task it redoes", () => {
  expect(recoverOutcome("retry T2", deadTree, "dead")).toEqual({
    kind: "recover", action: "retry", task: "T2", message: "retrying T2 from scratch",
  });
});

test("/build retry without a task says which are open", () => {
  expect(recoverOutcome("retry", deadTree, "dead")).toEqual({
    kind: "refused", message: "retry which task? T2 is open",
  });
});

test("/build abort says what stays merged", () => {
  expect(recoverOutcome("abort", deadTree, "dead")).toEqual({
    kind: "recover", action: "abort", task: "T2", message: "abandoning the build — T1 stays merged, T2 is discarded",
  });
});

test("/build cancel on a running build is a cancel; on anything else it is refused", () => {
  expect(recoverOutcome("cancel", deadTree, "running")).toEqual({ kind: "cancel", message: "cancelling — the build stops after the task in flight is interrupted" });
  expect(recoverOutcome("cancel", idleTree, "idle")).toEqual({ kind: "refused", message: "nothing to cancel — no build is running" });
});

test("a recovery on a build that is not dead is refused", () => {
  expect(recoverOutcome("resume", idleTree, "idle")).toEqual({ kind: "refused", message: "nothing to recover — no interrupted build" });
});

test("an unknown /build argument names the five", () => {
  expect(recoverOutcome("faster", idleTree, "idle")).toEqual({
    kind: "refused", message: "/build takes nothing, or cancel, resume, retry <task>, abort",
  });
});

test("quitting mid-build says what it is doing, and what it did if the build did not stop", () => {
  expect(quitCancelling()).toBe("cancelling the build before leaving…");
  expect(quitTimedOut()).toBe("the build did not stop in time — leaving anyway; the next /build will treat it as interrupted");
});

test("/build retry with nothing open — a dead build finished every task before crashing — says so, not 'are open'", () => {
  const finishedButDead = project([
    { t: "created", id: "x", title: "X" },
    { t: "task.added", id: "T1", title: "a" },
    { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
    { t: "build.started" }, { t: "task.started", id: "T1" }, { t: "task.done", id: "T1" },
  ]);
  expect(recoverOutcome("retry", finishedButDead, "dead")).toEqual({
    kind: "refused",
    message: "nothing is open to retry — /build resume finishes the build, /build abort abandons it",
  });
});

// After a clean stop the spec is idle and the failed task keeps its checkout:
// `/build retry <task>` is the way to redo it, so it is accepted on idle for
// any task that is not merged. resume and abort stay dead-only.
const stoppedTree = project([
  { t: "created", id: "x", title: "X" },
  { t: "task.added", id: "T1", title: "a" }, { t: "task.added", id: "T2", title: "b" },
  { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  { t: "build.started" }, { t: "task.started", id: "T1" }, { t: "task.done", id: "T1" },
  { t: "task.started", id: "T2" }, { t: "task.failed", id: "T2", reason: "interrupted" },
  { t: "build.stopped", reason: "interrupted" },
]);

test("/build retry <task> after a clean stop is a recovery on an idle build", () => {
  expect(recoverOutcome("retry T2", stoppedTree, "idle")).toEqual({
    kind: "recover", action: "retry", task: "T2", message: "retrying T2 from scratch",
  });
  expect(recoverOutcome("retry T1", stoppedTree, "idle")).toEqual({
    kind: "refused", message: "T1 is merged — it cannot be retried",
  });
  expect(recoverOutcome("retry", stoppedTree, "idle")).toEqual({
    kind: "refused", message: "retry which task? T2 is open",
  });
});

test("/build resume and /build abort after a clean stop are still refused — nothing is interrupted", () => {
  expect(recoverOutcome("resume", stoppedTree, "idle")).toEqual({ kind: "refused", message: "nothing to recover — no interrupted build" });
  expect(recoverOutcome("abort", stoppedTree, "idle")).toEqual({ kind: "refused", message: "nothing to recover — no interrupted build" });
  expect(recoverOutcome("retry T2", stoppedTree, "running")).toEqual({ kind: "refused", message: "nothing to recover — no interrupted build" });
});

// Killed during the whole-branch review: every task merged, the build open.
// The chat's words have to be the ones the loop then honours.
const deadInBranchReview = project([
  { t: "created", id: "x", title: "X" },
  { t: "task.added", id: "T1", title: "a" }, { t: "task.added", id: "T2", title: "b" },
  { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  { t: "build.started" }, { t: "task.started", id: "T1" }, { t: "task.done", id: "T1" },
  { t: "task.started", id: "T2" }, { t: "task.done", id: "T2" },
]);

test("/build on a build killed during the whole-branch review is interrupted, not finished", () => {
  expect(buildStart(deadInBranchReview, "dead")).toEqual({
    kind: "refused",
    message: "a build was interrupted — /build resume, /build retry <task>, or /build abort",
  });
});

test("/build resume on a build killed during the whole-branch review resumes the build, with no task to name", () => {
  expect(recoverOutcome("resume", deadInBranchReview, "dead")).toEqual({
    kind: "recover", action: "resume", message: "resuming the build in its own checkout",
  });
  expect(recoverOutcome("abort", deadInBranchReview, "dead")).toEqual({
    kind: "recover", action: "abort", message: "abandoning the build — T1, T2 stay merged",
  });
  expect(recoverOutcome("retry T2", deadInBranchReview, "dead")).toEqual({
    kind: "refused", message: "nothing is open to retry — /build resume finishes the build, /build abort abandons it",
  });
});

// On a dead build the only task a retry can redo is the one in flight.
const deadWithTodo = project([
  { t: "created", id: "x", title: "X" },
  { t: "task.added", id: "T1", title: "a" }, { t: "task.added", id: "T2", title: "b" }, { t: "task.added", id: "T3", title: "c" },
  { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  { t: "build.started" }, { t: "task.started", id: "T1" }, { t: "task.done", id: "T1" },
  { t: "task.started", id: "T2" },
]);

test("/build retry on a dead build names only the in-flight task, and refuses any other", () => {
  expect(recoverOutcome("retry", deadWithTodo, "dead")).toEqual({
    kind: "refused", message: "retry which task? T2 is open",
  });
  expect(recoverOutcome("retry T3", deadWithTodo, "dead")).toEqual({
    kind: "refused", message: 'only the interrupted task "T2" can be retried while it is in flight — /build retry T2',
  });
  expect(recoverOutcome("retry T2", deadWithTodo, "dead")).toEqual({
    kind: "recover", action: "retry", task: "T2", message: "retrying T2 from scratch",
  });
});

// Idle with every task done: nothing is open to retry, but unlike the dead
// state, resume and abort are not "just refused for now" — they are refused
// because there is no build to recover at all. The wording has to say that,
// not point at commands that are refused right next to it.
const idleAllDone = project([
  { t: "created", id: "x", title: "X" },
  { t: "task.added", id: "T1", title: "a" },
  { t: "approved", what: "spec" }, { t: "approved", what: "plan" },
  { t: "build.started" }, { t: "task.started", id: "T1" }, { t: "task.done", id: "T1" },
  { t: "build.done" },
]);

test("/build retry with nothing open on an idle spec says every task is merged, not the dead build's wording", () => {
  expect(recoverOutcome("retry T1", idleAllDone, "idle")).toEqual({
    kind: "refused",
    message: "nothing to retry — every task is merged",
  });
  expect(recoverOutcome("retry", idleAllDone, "idle")).toEqual({
    kind: "refused",
    message: "nothing to retry — every task is merged",
  });
});

// The plan-approval check `buildStart` makes has to hold for retry too: an
// idle spec whose plan is not (or no longer) approved cannot be retried into
// a build the loop will only refuse a moment later.
const idleUnapprovedPlan = project([
  { t: "created", id: "x", title: "X" },
  { t: "task.added", id: "T1", title: "a" }, { t: "task.added", id: "T2", title: "b" },
  { t: "approved", what: "spec" },
  { t: "build.started" }, { t: "task.started", id: "T1" }, { t: "task.done", id: "T1" },
  { t: "task.started", id: "T2" }, { t: "task.failed", id: "T2", reason: "interrupted" },
  { t: "build.stopped", reason: "interrupted" },
]);

test("/build retry on an idle spec whose plan is not approved refuses with the same text buildStart uses", () => {
  expect(recoverOutcome("retry T2", idleUnapprovedPlan, "idle")).toEqual({
    kind: "refused",
    message: "the plan is not approved — /approve plan",
  });
});

test("a /build of any kind while this process holds a build says it is running, in the same words buildStart uses", () => {
  expect(buildBusy()).toBe("a build is already running");
  expect(buildStart(deadTree, "running")).toEqual({ kind: "refused", message: buildBusy() });
});

test("/build cancel on a build another process holds says where to stop it", () => {
  expect(cancelElsewhere()).toBe("that build is running in another process — stop it there");
});

const unapprovedPlan = project([
  { t: "created", id: "x", title: "X" },
  { t: "approved", what: "spec" },
  { t: "task.added", id: "T1", title: "The reducer" },
  { t: "task.added", id: "T2", title: "A title that is much too long for one column" },
])!;

test("with a spec written and not approved, the question is about the spec", () => {
  const t = project([{ t: "created", id: "x", title: "X" }])!;
  expect(approvalQuestion(t, { specWritten: true, plan: null })).toEqual({
    what: "spec", lines: ["approve the spec? [y] yes  [n] not yet"],
  });
  expect(approvalQuestion(t, { specWritten: false, plan: null })).toBeNull();
});

test("with a plan written and not approved, the tasks and their checks come first", () => {
  const plan = [
    { id: "T1", title: "The reducer", text: "", verify: "bun test tests/spec/project.test.ts" },
    { id: "T2", title: "A title that is much too long for one column", text: "" },
  ];
  expect(approvalQuestion(unapprovedPlan, { specWritten: true, plan })).toEqual({
    what: "plan",
    lines: [
      "T1  The reducer              verify: bun test tests/spec/project.test.ts",
      "T2  A title that is much to… no verify — worker and reviewer only",
      "approve the plan? [y] yes  [n] not yet",
    ],
  });
});

test("nothing is asked once both are approved, or with no spec at all", () => {
  const done = project([{ t: "created", id: "x", title: "X" }, { t: "approved", what: "spec" }, { t: "approved", what: "plan" }])!;
  expect(approvalQuestion(done, { specWritten: true, plan: [{ id: "T1", title: "a", text: "" }] })).toBeNull();
  expect(approvalQuestion(null, { specWritten: true, plan: null })).toBeNull();
});
