import { test, expect } from "bun:test";
import {
  CHAT_COMMANDS,
  approveOutcome,
  buildFailed,
  buildStart,
  classifyOutcome,
  parseChatInput,
  quitBlocked,
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

test("leaving while a build runs is refused, because killing the process wedges the spec", () => {
  expect(quitBlocked()).toBe("a build is running — wait for it to stop before leaving");
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
