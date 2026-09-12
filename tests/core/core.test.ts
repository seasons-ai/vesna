import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCore } from "../../src/core/core";
import type { Notification } from "../../src/core/types";
import { createSink } from "../../src/spec/sink";
import { openSession, readSessionSync } from "../../src/store/sessions";
import { appendEvent, createSpec, digestOf, readEvents, specPaths, specsRoot, writeSpecFile } from "../../src/spec/store";
import { allowing, deps, halfway, reply, toolCaller, until, writing } from "../helpers/chat";

/**
 * The same scenarios `tests/tui/app.test.ts` runs on a screen, re-run against
 * the core through `on()` alone: what a second client would see.
 */

function collect(core: ReturnType<typeof createCore>) {
  const seen: Notification[] = [];
  core.on((n) => seen.push(n));
  return seen;
}
const transcript = (seen: Notification[]) => seen.filter((n) => n.method === "transcript").map((n) => n.params);
const lastState = (seen: Notification[]) => [...seen].reverse().find((n) => n.method === "state")!.params as any;
const asks = (seen: Notification[], kind: string) =>
  seen.filter((n) => n.method === "ask" && (n.params as any).kind === kind).map((n) => n.params as any);

test("a turn is user, deltas, turn-end, and a state that is busy then not", async () => {
  const core = createCore(await deps(reply("hello there")));
  const seen = collect(core);
  await core.send("hi");
  expect(transcript(seen)[0]).toEqual({ kind: "user", text: "hi" });
  expect(transcript(seen).some((e: any) => e.kind === "delta" && e.text.includes("hello"))).toBe(true);
  expect(transcript(seen).at(-1)).toEqual({ kind: "turn-end" });
  const states = seen.filter((n) => n.method === "state").map((n) => (n.params as any).busy);
  expect(states).toContain(true);
  expect(lastState(seen).busy).toBe(false);
  // The usage after the turn is in the state, so a status line needs no session.
  expect(lastState(seen).usage).toEqual({ inputTokens: 3, outputTokens: 4, costUsd: 0 });
  await core.close();
});

test("the snapshot names the model and the service, the way the header does", async () => {
  const core = createCore(await deps(reply("x")));
  const state = core.snapshot();
  expect(state.model).toBe("test-model");
  expect(state.service).toBe("codex");
  expect(state.mode).toBe("ask");
  expect(state.spec).toBeNull();
  expect(state.chats).toBeNull();
  await core.close();
});

test("/mode changes the state and says so with the chat's words", async () => {
  const core = createCore(await deps(reply("x")));
  const seen = collect(core);
  await core.command("mode", "auto");
  expect(lastState(seen).mode).toBe("auto");
  const notices = transcript(seen).filter((e: any) => e.kind === "notice") as any[];
  expect(notices.at(-1)).toMatchObject({ text: expect.stringContaining("mode: auto"), level: "ok" });
  expect(transcript(seen).at(-1)).toEqual({ kind: "turn-end" });
  await core.close();
});

test("/mode with a name nobody has is refused, and the mode is left alone", async () => {
  const core = createCore(await deps(reply("x")));
  const seen = collect(core);
  await core.command("mode", "reckless");
  expect(transcript(seen).some((e: any) => e.kind === "notice" && /plan, ask or auto/.test(e.text))).toBe(true);
  expect(core.snapshot().mode).toBe("ask");
  await core.close();
});

test("an unknown command is reported, not sent", async () => {
  const core = createCore(await deps(reply("x")));
  const seen = collect(core);
  await core.command("nope", "");
  expect(transcript(seen)[0]).toEqual({ kind: "user", text: "/nope" });
  expect(transcript(seen)[1]).toEqual({ kind: "notice", text: "unknown command /nope - try /help", level: "warn" });
  await core.close();
});

test("a permission is an ask with the prompt's two lines; a is remembered and says so", async () => {
  const { registry, ran } = writing();
  const caller = toolCaller("put", { path: "src/a.ts" });
  const core = createCore(await allowing(caller, registry));
  const seen = collect(core);
  const turn = core.send("run it");
  await until(() => seen.some((n) => n.method === "ask"), "the question");
  const ask = seen.find((n) => n.method === "ask")!.params as any;
  expect(ask.kind).toBe("permission");
  expect(ask.strict).toBe(false);
  expect(ask.lines[0]).toMatch(/^put\s/);
  expect(ask.lines[1]).toMatch(/^\[y\] allow once   \[a\] always /);
  expect(ask.choices).toEqual(["y", "a", "n"]);
  // A stray key decides nothing: the ask stays open.
  expect(core.answer(ask.id, "q")).toBe(false);
  expect(core.answer(ask.id, "a")).toBe(true);
  await turn;
  expect(seen.some((n) => n.method === "ask.resolved" && (n.params as any).id === ask.id)).toBe(true);
  expect(transcript(seen).some((e: any) => e.kind === "notice" && e.text.startsWith("allowed, and remembered"))).toBe(true);
  expect(ran).toEqual(["src/a.ts"]);
  await core.close();
});

test("a on something with no pattern allows it once, never refuses it", async () => {
  const { registry, ran } = writing();
  // Neither a path nor a command: nothing a rule could be made from.
  const caller = toolCaller("put", { note: "bun test" });
  const core = createCore(await allowing(caller, registry));
  const seen = collect(core);
  const turn = core.send("go");
  await until(() => seen.some((n) => n.method === "ask"), "the question");
  const ask = seen.find((n) => n.method === "ask")!.params as any;
  expect(ask.lines).toEqual(["put  ", "[y] allow   [n] refuse"]);
  expect(core.answer(ask.id, "a")).toBe(true);
  await turn;
  expect(transcript(seen).some((e: any) => e.kind === "notice" && /^allowed once/.test(e.text))).toBe(true);
  expect(transcript(seen).some((e: any) => e.kind === "notice" && /refused/.test(e.text))).toBe(false);
  expect(ran).toHaveLength(1);
  await core.close();
});

test("n refuses, and the action does not happen", async () => {
  const { registry, ran } = writing();
  const caller = toolCaller("put", { path: "src/a.ts" });
  const core = createCore(await allowing(caller, registry));
  const seen = collect(core);
  const turn = core.send("go");
  await until(() => seen.some((n) => n.method === "ask"), "the question");
  const ask = seen.find((n) => n.method === "ask")!.params as any;
  expect(core.answer(ask.id, "n")).toBe(true);
  await turn;
  expect(transcript(seen).some((e: any) => e.kind === "notice" && e.text === "refused" && e.level === "warn")).toBe(true);
  expect(ran).toEqual([]);
  await core.close();
});

test("plan mode refuses to change anything, and says why, with no ask", async () => {
  const { registry, ran } = writing();
  const caller = toolCaller("put", { path: "src/a.ts" });
  const core = createCore(await allowing(caller, registry));
  const seen = collect(core);
  await core.command("mode", "plan");
  await core.send("go");
  expect(seen.some((n) => n.method === "ask")).toBe(false);
  expect(transcript(seen).some((e: any) => e.kind === "notice" && /plan mode/i.test(e.text))).toBe(true);
  expect(ran).toEqual([]);
  await core.close();
});

/**
 * A spec whose plan is written and waits for a person: the spec approved, two
 * tasks in the log, and a plan.md whose first task declares a check.
 */
async function unapprovedPlan(p = reply("x")) {
  const base = await deps(p);
  const specs = specsRoot(base.root);
  const sink = createSink(specs);
  const slug = "gate";
  createSpec(specs, slug);
  appendEvent(specs, slug, { t: "approved", what: "spec" });
  appendEvent(specs, slug, { t: "task.added", id: "T1", title: "a" });
  appendEvent(specs, slug, { t: "task.added", id: "T2", title: "b" });
  writeSpecFile(specPaths(specs, slug).plan, "### Task 1: a\nverify: bun test\n\n### Task 2: b\n");
  const core = createCore({ ...base, sink });
  const seen = collect(core);
  await core.command("spec", `open ${slug}`);
  return { core, seen, specs, slug };
}

test("an unapproved plan is asked about after the turn; only y writes the approval, with the digest", async () => {
  const { core, seen, specs, slug } = await unapprovedPlan();
  // `send` resolves once the turn has ended and the question is up — it does
  // not wait for the answer, or a client awaiting it before answering would hang.
  await core.send("hi");
  expect(asks(seen, "approval")).toHaveLength(1);
  const ask = asks(seen, "approval")[0];
  expect(ask.strict).toBe(true);
  expect(ask.choices).toEqual(["y", "n"]);
  expect(ask.lines.at(-1)).toBe("approve the plan? [y] yes  [n] not yet");
  expect(ask.lines.some((line: string) => line.includes("verify: bun test"))).toBe(true);
  expect(seen.some((n) => n.method === "ask.resolved")).toBe(false);
  expect(core.answer(ask.id, "\r")).toBe(false);
  expect(core.answer(ask.id, "y")).toBe(true);
  await until(() => readEvents(specs, slug).some((e: any) => e.t === "approved" && e.what === "plan"), "the approval");
  const approved = readEvents(specs, slug).find((e: any) => e.t === "approved" && e.what === "plan") as any;
  expect(approved.digest).toBe(digestOf(join(specs, slug, "plan.md")));
  await until(() => lastState(seen).spec?.approved.plan === true, "the state");
  expect(transcript(seen).some((e: any) => e.kind === "notice" && e.text === "approved: plan — /build will run it" && e.level === "ok")).toBe(true);
  // Asked once: the next turn finds the plan approved.
  await core.send("again");
  expect(asks(seen, "approval")).toHaveLength(1);
  await core.close();
});

test("n leaves the log alone and the question comes back after the next turn", async () => {
  const { core, seen, specs, slug } = await unapprovedPlan();
  await core.send("hello");
  const first = asks(seen, "approval")[0];
  expect(core.answer(first.id, "n")).toBe(true);
  await until(() => transcript(seen).some((e: any) => e.kind === "notice" && e.text === "not yet"), "the answer");
  expect(readEvents(specs, slug).some((e: any) => e.t === "approved" && e.what === "plan")).toBe(false);
  await core.send("more");
  expect(asks(seen, "approval")).toHaveLength(2);
  expect(asks(seen, "approval")[1].id).not.toBe(first.id);
  await core.close();
});

test("y writes the digest of the plan the question was asked about, not of a plan edited while it was up", async () => {
  const { core, seen, specs, slug } = await unapprovedPlan();
  const asked = digestOf(specPaths(specs, slug).plan);
  await core.send("hello");
  writeSpecFile(specPaths(specs, slug).plan, "### Task 1: a\nverify: bun test tests/other.test.ts\n\n### Task 2: b\n");
  expect(digestOf(specPaths(specs, slug).plan)).not.toBe(asked);
  core.answer(asks(seen, "approval")[0].id, "y");
  await until(() => readEvents(specs, slug).some((e: any) => e.t === "approved" && e.what === "plan"), "the approval");
  const approved = readEvents(specs, slug).find((e: any) => e.t === "approved" && e.what === "plan") as any;
  expect(approved.digest).toBe(asked);
  await core.close();
});

test("/approve plan writes the digest too, and the state follows", async () => {
  const { core, seen, specs, slug } = await unapprovedPlan();
  await core.command("approve", "plan");
  const approved = readEvents(specs, slug).find((e: any) => e.t === "approved" && e.what === "plan") as any;
  expect(approved.digest).toBe(digestOf(specPaths(specs, slug).plan));
  expect(lastState(seen).spec.approved.plan).toBe(true);
  await core.close();
});

test("/approve with no sink refuses honestly", async () => {
  const core = createCore(await deps(reply("x")));
  const seen = collect(core);
  await core.command("spec", "new gate");
  await core.command("approve", "plan");
  expect(transcript(seen).some((e: any) => e.kind === "notice" && /cannot approve/.test(e.text))).toBe(true);
  expect(transcript(seen).some((e: any) => e.kind === "notice" && /^approved: plan/.test(e.text))).toBe(false);
  await core.close();
});

test("interrupt aborts the turn and the transcript says interrupted", async () => {
  const slow = halfway("work", "ing");
  const core = createCore(await deps(slow.provider));
  const seen = collect(core);
  const turn = core.send("hi");
  await until(() => transcript(seen).some((e: any) => e.kind === "delta"), "the first delta");
  expect(lastState(seen).busy).toBe(true);
  core.interrupt();
  await turn;
  expect(transcript(seen).some((e: any) => e.kind === "notice" && e.text === "interrupted" && e.level === "warn")).toBe(true);
  expect(transcript(seen).some((e: any) => e.kind === "delta" && e.text === "ing")).toBe(false);
  expect(lastState(seen).busy).toBe(false);
  await core.close();
});

test("the question is not asked after an interrupted turn, and returns after the next completed one", async () => {
  const slow = halfway("work", "ing");
  const { core, seen } = await unapprovedPlan(slow.provider);
  const turn = core.send("go");
  await until(() => transcript(seen).some((e: any) => e.kind === "delta"), "the turn to start");
  core.interrupt();
  await turn;
  expect(asks(seen, "approval")).toHaveLength(0);
  slow.release();
  await core.send("again");
  expect(asks(seen, "approval")).toHaveLength(1);
  await core.close();
});

test("a provider that fell over is an error notice, and the core is not busy after it", async () => {
  const core = createCore(await deps({ id: "fake", complete: async () => { throw new Error("the provider fell over"); } }));
  const seen = collect(core);
  await core.send("go");
  expect(transcript(seen).some((e: any) => e.kind === "notice" && e.text === "the provider fell over" && e.level === "error")).toBe(true);
  expect(lastState(seen).busy).toBe(false);
  await core.close();
});

test("/spec new puts the tree in the state, and the state carries the slug", async () => {
  const core = createCore(await deps(reply("x")));
  const seen = collect(core);
  await core.command("spec", "new Reliable cancellation");
  expect(lastState(seen).specSlug).toBe("reliable-cancellation");
  expect(lastState(seen).spec.title).toBe("Reliable cancellation");
  expect(transcript(seen).some((e: any) => e.kind === "notice" && e.text === "spec reliable-cancellation" && e.level === "ok")).toBe(true);
  await core.close();
});

test("/spec open puts the tree in the state, and the state carries the slug", async () => {
  const base = await deps(reply("x"));
  const specs = specsRoot(base.root);
  const made = createSpec(specs, "Cancellation work");
  const sink = createSink(specs);
  const core = createCore({ ...base, sink });
  const seen = collect(core);
  expect(core.snapshot().specSlug).toBeNull();
  await core.command("spec", `open ${made.slug}`);
  expect(lastState(seen).specSlug).toBe(made.slug);
  expect(lastState(seen).spec.title).toBe("Cancellation work");
  // The nodes write to whichever spec is open.
  expect(sink.slug).toBe(made.slug);
  expect(transcript(seen).some((e: any) => e.kind === "notice" && e.text === `spec ${made.slug}`)).toBe(true);
  await core.close();
});

test("/spec open on a name nobody has is refused, and the state is left alone", async () => {
  const core = createCore(await deps(reply("x")));
  const seen = collect(core);
  await core.command("spec", "open nothing");
  expect(transcript(seen).some((e: any) => e.kind === "notice" && /no spec called "nothing"/.test(e.text))).toBe(true);
  expect(core.snapshot().spec).toBeNull();
  await core.close();
});

test("/spec lists what there is and marks the open one", async () => {
  const core = createCore(await deps(reply("x")));
  const seen = collect(core);
  await core.command("spec", "new first thing");
  await core.command("spec", "new second thing");
  await core.command("spec", "");
  const listing = transcript(seen).filter((e: any) => e.kind === "notice").map((e: any) => `${e.level}:${e.text}`);
  expect(listing).toContain("muted:  first-thing  first thing");
  expect(listing).toContain("ok:* second-thing  second thing");
  expect(listing.at(-1)).toBe("muted:/spec open <slug>");
  await core.close();
});

test("/classify writes a person's classification to the log, and the state takes the person's word", async () => {
  const base = await deps(reply("x"));
  const sink = createSink(specsRoot(base.root));
  const core = createCore({ ...base, sink });
  const seen = collect(core);
  await core.command("spec", "new Shaped work");
  sink.emit({ t: "classified", shape: "architectural", by: "agent" });
  await core.command("classify", "bounded");
  expect(readEvents(specsRoot(base.root), sink.slug!)).toContainEqual({ t: "classified", shape: "bounded", by: "person" });
  expect(lastState(seen).spec.shape).toBe("bounded");
  await core.close();
});

test("/clear empties the transcript and starts a fresh conversation", async () => {
  const seenByModel: number[] = [];
  const core = createCore(await deps({
    id: "fake",
    complete: async (request) => {
      seenByModel.push(request.messages.length);
      return { content: [{ type: "text", text: "x" }], stopReason: "end_turn", model: "m", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    },
  }));
  const seen = collect(core);
  await core.send("one");
  await core.command("clear", "");
  expect(transcript(seen).some((e: any) => e.kind === "clear")).toBe(true);
  expect(transcript(seen).some((e: any) => e.kind === "notice" && e.text === "new conversation")).toBe(true);
  await core.send("two");
  expect(seenByModel).toEqual([1, 1]);
  await core.close();
});

test("a build in flight keeps the approval question quiet, and shows in the state", async () => {
  const { core, seen } = await unapprovedPlan();
  core.setBuilding(true);
  expect(lastState(seen).building).toBe(true);
  expect(lastState(seen).buildState).toBe("running");
  await core.send("hi");
  expect(asks(seen, "approval")).toHaveLength(0);
  core.setBuilding(false);
  expect(lastState(seen).building).toBe(false);
  await core.close();
});

test("/history lists what was said in this folder, and /resume brings it back for the model", async () => {
  const store = await mkdtemp(join(tmpdir(), "vesna-core-hist-"));
  const base = await deps(reply("x"));
  const old = await openSession({ root: store, cwd: base.root, model: "m" });
  await old.append({ t: "user", text: "the original question" });
  await old.append({ t: "answer", raw: "## The original answer" });
  await old.append({ t: "step", nodeType: "read", durationMs: 3, detail: "a.txt" });
  await old.append({
    t: "messages",
    added: [
      { role: "user", content: [{ type: "text", text: "the original question" }] },
      { role: "assistant", content: [{ type: "text", text: "an earlier reply" }] },
    ],
  });
  const seenByModel: string[] = [];
  const spy = {
    id: "fake",
    complete: async (request: { messages: unknown }) => {
      seenByModel.push(JSON.stringify(request.messages));
      return { content: [{ type: "text" as const, text: "new answer" }], stopReason: "end_turn" as const, model: "m", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    },
  };
  const core = createCore({ ...base, provider: spy, sessionsRoot: store });
  const seen = collect(core);
  expect(core.snapshot().chats).toBeNull();

  await core.command("history", "");
  const listing = transcript(seen).filter((e: any) => e.kind === "notice").map((e: any) => e.text);
  expect(listing[0]).toBe(base.root);
  expect(listing.some((line) => /^ 1  .*the original question$/.test(line))).toBe(true);
  expect(listing.at(-1)).toBe("/resume <number> to reopen · /history all");
  expect(lastState(seen).chats.map((c: any) => c.id)).toEqual([old.id]);

  await core.command("resume", "1");
  const replay = transcript(seen).slice(transcript(seen).findIndex((e: any) => e.kind === "clear"));
  expect(replay[0]).toEqual({ kind: "clear" });
  expect(replay[1]).toEqual({ kind: "user", text: "the original question" });
  expect(replay[2]).toEqual({ kind: "delta", text: "## The original answer" });
  expect(replay[3]).toEqual({ kind: "turn-end" });
  expect((replay[4] as any).step).toMatchObject({ nodeType: "read", durationMs: 3, input: { detail: "a.txt" } });
  expect(replay.some((e: any) => e.kind === "notice" && e.text === "resumed · the original question")).toBe(true);

  await core.send("and now?");
  expect(seenByModel[0]).toContain("an earlier reply");
  await core.close();
});

test("/resume with a number nobody listed refuses instead of guessing; a listed id resumes", async () => {
  const store = await mkdtemp(join(tmpdir(), "vesna-core-hist-"));
  const base = await deps(reply("x"));
  const old = await openSession({ root: store, cwd: base.root, model: "m" });
  await old.append({ t: "user", text: "an old chat" });
  const core = createCore({ ...base, sessionsRoot: store });
  const seen = collect(core);
  await core.command("resume", "7");
  expect(transcript(seen).some((e: any) => e.kind === "notice" && /from the last \/history listing/.test(e.text))).toBe(true);
  // A click on the conversations column names the chat by id.
  await core.command("chats", "");
  expect(lastState(seen).chats).toHaveLength(1);
  await core.command("resume", old.id);
  expect(transcript(seen).some((e: any) => e.kind === "notice" && e.text === "resumed · an old chat")).toBe(true);
  await core.close();
});

test("a conversation is written down as it happens: the user line, the answer and the usage", async () => {
  const store = await mkdtemp(join(tmpdir(), "vesna-core-hist-"));
  const record = await openSession({ root: store, cwd: "/w", model: "m" });
  const core = createCore(await deps(reply("an answer"), { record, sessionsRoot: store }));
  await core.send("remember this");
  await until(() => readSessionSync(store, record.id)?.events.some((e) => e.t === "usage") === true, "the record");
  const events = readSessionSync(store, record.id)!.events;
  expect(events).toContainEqual({ t: "user", text: "remember this" });
  expect(events).toContainEqual({ t: "answer", raw: "an answer" });
  await core.command("mode", "auto");
  expect(events.filter((e) => e.t === "user")).toHaveLength(1);
  await core.close();
});

// Fix round 1: what a second client sees, and what the core does with more
// than one thing at a time.

test("a command is quoted back as typed, to every subscriber, before its effect", async () => {
  const core = createCore(await deps(reply("x")));
  const first = collect(core);
  const second = collect(core);
  await core.command("mode", "auto");
  await core.command("spec", "");
  await core.command("nope", "with words");
  for (const seen of [first, second]) {
    const entries = transcript(seen) as any[];
    expect(entries[0]).toEqual({ kind: "user", text: "/mode auto" });
    expect(entries[1].kind).toBe("notice");
    expect(entries[1].text.startsWith("mode: auto")).toBe(true);
    expect(entries.some((e) => e.kind === "user" && e.text === "/spec")).toBe(true);
    expect(entries.some((e) => e.kind === "user" && e.text === "/nope with words")).toBe(true);
    expect(entries.filter((e) => e.kind === "user")).toHaveLength(3);
  }
  await core.close();
});

test("a message is quoted back once", async () => {
  const core = createCore(await deps(reply("x")));
  const seen = collect(core);
  await core.send("do it");
  expect(transcript(seen).filter((e: any) => e.kind === "user")).toEqual([{ kind: "user", text: "do it" }]);
  await core.close();
});

test("two sends run one after the other: deltas never interleave, and idle is only ever between turns", async () => {
  const slow = halfway("work", "ing");
  const core = createCore(await deps(slow.provider));
  const seen = collect(core);
  const one = core.send("one");
  const two = core.send("two");
  await until(() => transcript(seen).some((e: any) => e.kind === "delta"), "the first delta");
  // The second turn has not started: nothing of it is quoted back yet.
  expect(transcript(seen).filter((e: any) => e.kind === "user")).toEqual([{ kind: "user", text: "one" }]);
  slow.release();
  await Promise.all([one, two]);
  const kinds = transcript(seen).map((e: any) => (e.kind === "delta" ? `delta:${e.text}` : e.kind === "user" ? `user:${e.text}` : e.kind));
  expect(kinds).toEqual([
    "user:one", "delta:work", "delta:ing", "turn-end",
    "user:two", "delta:work", "delta:ing", "turn-end",
  ]);
  // Idle is never reported while a turn is open.
  let open = false;
  for (const n of seen) {
    if (n.method === "transcript" && n.params.kind === "user") open = true;
    if (n.method === "transcript" && n.params.kind === "turn-end") open = false;
    if (n.method === "state" && !(n.params as any).busy) expect(open).toBe(false);
  }
  expect(lastState(seen).busy).toBe(false);
  await core.close();
});

test("a message typed behind the approval question waits for the answer, and the question is asked once", async () => {
  const { core, seen, specs, slug } = await unapprovedPlan();
  const hello = core.send("hello");
  const more = core.send("more");
  await hello;
  expect(asks(seen, "approval")).toHaveLength(1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(asks(seen, "approval")).toHaveLength(1);
  expect(transcript(seen).some((e: any) => e.kind === "user" && e.text === "more")).toBe(false);
  expect(core.answer(asks(seen, "approval")[0].id, "y")).toBe(true);
  await more;
  expect(readEvents(specs, slug).some((e: any) => e.t === "approved" && e.what === "plan")).toBe(true);
  expect(transcript(seen).some((e: any) => e.kind === "user" && e.text === "more")).toBe(true);
  expect(asks(seen, "approval")).toHaveLength(1);
  // The approval landed before "more" was quoted back.
  const entries = transcript(seen) as any[];
  const approvedAt = entries.findIndex((e) => e.kind === "notice" && /^approved: plan/.test(e.text));
  const moreAt = entries.findIndex((e) => e.kind === "user" && e.text === "more");
  expect(approvedAt).toBeGreaterThanOrEqual(0);
  expect(moreAt).toBeGreaterThan(approvedAt);
  await core.close();
});

test("a command typed during a turn waits for the turn", async () => {
  const slow = halfway("work", "ing");
  const core = createCore(await deps(slow.provider));
  const seen = collect(core);
  const turn = core.send("go");
  await until(() => transcript(seen).some((e: any) => e.kind === "delta"), "the turn to start");
  const listing = core.command("spec", "");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(transcript(seen).some((e: any) => e.kind === "user" && e.text === "/spec")).toBe(false);
  slow.release();
  await Promise.all([turn, listing]);
  const entries = transcript(seen) as any[];
  expect(entries.findIndex((e) => e.kind === "user" && e.text === "/spec")).toBeGreaterThan(entries.findIndex((e) => e.kind === "turn-end"));
  expect(entries.some((e) => e.kind === "notice" && e.text === "no specs yet — /spec new <name>")).toBe(true);
  await core.close();
});

test("a mode change applies at once, even during a turn", async () => {
  const slow = halfway("work", "ing");
  const core = createCore(await deps(slow.provider));
  const seen = collect(core);
  const turn = core.send("go");
  await until(() => transcript(seen).some((e: any) => e.kind === "delta"), "the turn to start");
  await core.command("mode", "auto");
  expect(core.snapshot().mode).toBe("auto");
  expect(lastState(seen).mode).toBe("auto");
  expect(lastState(seen).busy).toBe(true);
  const entries = transcript(seen) as any[];
  expect(entries.some((e) => e.kind === "user" && e.text === "/mode auto")).toBe(true);
  expect(entries.some((e) => e.kind === "notice" && e.text.startsWith("mode: auto"))).toBe(true);
  // The command's own turn-end is there; the turn's is not, since it has not ended.
  expect(entries.filter((e) => e.kind === "turn-end")).toHaveLength(1);
  expect(entries.some((e) => e.kind === "delta" && e.text === "ing")).toBe(false);
  slow.release();
  await turn;
  await core.close();
});

test("close answers an open permission with no, and the pending send settles", async () => {
  const { registry, ran } = writing();
  const caller = toolCaller("put", { path: "src/a.ts" });
  const core = createCore(await allowing(caller, registry));
  const seen = collect(core);
  const turn = core.send("go");
  await until(() => seen.some((n) => n.method === "ask"), "the question");
  const ask = seen.find((n) => n.method === "ask")!.params as any;
  await core.close();
  await turn;
  expect(seen.some((n) => n.method === "ask.resolved" && (n.params as any).id === ask.id)).toBe(true);
  expect(ran).toEqual([]);
});

test("close answers an open approval with no, and nothing answers after it", async () => {
  const { core, seen, specs, slug } = await unapprovedPlan();
  await core.send("hi");
  const ask = asks(seen, "approval")[0];
  await core.close();
  expect(seen.some((n) => n.method === "ask.resolved" && (n.params as any).id === ask.id)).toBe(true);
  expect(transcript(seen).some((e: any) => e.kind === "notice" && e.text === "not yet")).toBe(true);
  expect(core.answer(ask.id, "y")).toBe(false);
  expect(readEvents(specs, slug).some((e: any) => e.t === "approved" && e.what === "plan")).toBe(false);
});

test("after close, send and command are silent no-ops", async () => {
  let calls = 0;
  const core = createCore(await deps({ id: "fake", complete: async () => { calls += 1; return { content: [{ type: "text", text: "x" }], stopReason: "end_turn", model: "m", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }; } }));
  await core.close();
  const seen = collect(core);
  await core.send("x");
  await core.command("mode", "auto");
  expect(calls).toBe(0);
  expect(core.snapshot().mode).toBe("ask");
  expect(seen).toEqual([]);
});

test("the turn's final usage is in a state before turn-end, and idle comes after it", async () => {
  const core = createCore(await deps(reply("x")));
  const seen = collect(core);
  await core.send("hi");
  const usageAt = seen.findIndex((n) => n.method === "state" && (n.params as any).usage.inputTokens === 3);
  const turnEndAt = seen.findIndex((n) => n.method === "transcript" && n.params.kind === "turn-end");
  const idleAt = seen.findIndex((n) => n.method === "state" && !(n.params as any).busy);
  expect(usageAt).toBeGreaterThanOrEqual(0);
  expect((seen[usageAt]!.params as any).busy).toBe(true);
  expect(usageAt).toBeLessThan(turnEndAt);
  expect(turnEndAt).toBeLessThan(idleAt);
  expect(idleAt).toBe(seen.length - 1);
  await core.close();
});
