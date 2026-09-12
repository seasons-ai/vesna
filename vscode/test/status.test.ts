import { test, expect } from "bun:test";
import type { SpecTree, State, Task } from "../src/protocol";
import { statusIcon, statusText } from "../src/status";

function task(id: string, state: Task["state"]): Task {
  return { id, title: id, state, dependsOn: [], evidence: { worker: false, reviewer: false, vesna: null } };
}

function spec(tasks: Task[]): SpecTree {
  return {
    id: "s",
    title: "S",
    stages: [],
    criteria: [],
    tasks,
    progress: { done: 0, total: tasks.length },
    approved: { spec: true, plan: true },
    digests: {},
    building: true,
    ignored: 0,
    reviews: {},
    parked: [],
    rulings: [],
    finished: false,
  };
}

function makeState(over: Partial<State> = {}): State {
  return {
    mode: "plan",
    busy: false,
    building: false,
    buildState: "idle",
    model: "m",
    service: "s",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    spec: null,
    specSlug: null,
    chats: null,
    chatId: null,
    root: "/repo",
    ...over,
  };
}

test("no state yet: just the name", () => {
  expect(statusText(null)).toBe("vesna");
});

test("the mode, when nothing is building", () => {
  expect(statusText(makeState({ mode: "plan" }))).toBe("vesna: plan");
  expect(statusText(makeState({ mode: "auto" }))).toBe("vesna: auto");
});

test("building: the first running task is the one in flight", () => {
  const state = makeState({
    building: true,
    spec: spec([task("T1", "done"), task("T2", "running"), task("T3", "running")]),
  });
  expect(statusText(state)).toBe("vesna: building T2");
});

test("building with no running task yet: just building", () => {
  expect(statusText(makeState({ building: true, spec: spec([task("T1", "todo")]) }))).toBe("vesna: building");
  expect(statusText(makeState({ building: true, spec: null }))).toBe("vesna: building");
});

test("the icon spins while busy", () => {
  expect(statusIcon(null)).toBe("$(sparkle)");
  expect(statusIcon(makeState({ busy: false }))).toBe("$(sparkle)");
  expect(statusIcon(makeState({ busy: true }))).toBe("$(sync~spin)");
});
