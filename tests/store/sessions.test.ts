import { test, expect } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteSession,
  folderKey,
  listSessions,
  openSession,
  readSession,
  sessionsRoot,
  titleOf,
} from "../../src/store/sessions";

const root = () => mkdtemp(join(tmpdir(), "vesna-sessions-"));

test("sessions live under the user's home, never inside a repository", () => {
  expect(sessionsRoot({}, "/home/me")).toBe("/home/me/.vesna/sessions");
});

test("VESNA_HOME moves them, for anyone who keeps a tidy home directory", () => {
  expect(sessionsRoot({ VESNA_HOME: "/data/vesna" }, "/home/me")).toBe("/data/vesna/sessions");
});

test("an empty VESNA_HOME falls back rather than yielding a path at the root", () => {
  expect(sessionsRoot({ VESNA_HOME: "" }, "/home/me")).toBe("/home/me/.vesna/sessions");
});

test("each working directory gets its own stable key", () => {
  expect(folderKey("/a/b")).toBe(folderKey("/a/b"));
  expect(folderKey("/a/b")).not.toBe(folderKey("/a/c"));
});

test("the key is short and safe as a directory name", () => {
  expect(folderKey("/a/b")).toMatch(/^[0-9a-f]{12}$/);
});

test("a title is derived from the first thing the user said", () => {
  expect(titleOf("add abort handling to shell nodes")).toBe("add abort handling to shell nodes");
});

test("a multi-line opening becomes one line", () => {
  expect(titleOf("fix the parser\n\nit breaks on tables")).toBe("fix the parser");
});

test("a very long opening is cut rather than wrapped into the listing", () => {
  const title = titleOf("x".repeat(200));
  expect(title.length).toBeLessThanOrEqual(60);
  expect(title.endsWith("…")).toBe(true);
});

test("a conversation is on disk from the first message, not at exit", async () => {
  const dir = await root();
  const session = await openSession({ root: dir, cwd: "/work/api", model: "m" });
  await session.append({ t: "user", text: "hello" });

  // Nothing closed, nothing flushed by hand: a killed process must still leave it.
  const found = await listSessions(dir);
  expect(found).toHaveLength(1);
  expect(found[0]!.title).toBe("hello");
});

test("the listing carries what the browser needs without reading the events", async () => {
  const dir = await root();
  const session = await openSession({ root: dir, cwd: "/work/api", model: "gpt-5" });
  await session.append({ t: "user", text: "first question" });
  await session.append({ t: "usage", inputTokens: 100, outputTokens: 20, costUsd: 0.5 });

  const [summary] = await listSessions(dir);
  expect(summary!.cwd).toBe("/work/api");
  expect(summary!.model).toBe("gpt-5");
  expect(summary!.messages).toBe(1);
  expect(summary!.costUsd).toBe(0.5);
});

test("sessions are listed newest first", async () => {
  const dir = await root();
  for (const text of ["oldest", "middle", "newest"]) {
    const session = await openSession({ root: dir, cwd: "/work/api", model: "m" });
    await session.append({ t: "user", text });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect((await listSessions(dir)).map((s) => s.title)).toEqual(["newest", "middle", "oldest"]);
});

test("listing can be narrowed to one working directory", async () => {
  const dir = await root();
  const here = await openSession({ root: dir, cwd: "/work/api", model: "m" });
  await here.append({ t: "user", text: "about the api" });
  const there = await openSession({ root: dir, cwd: "/work/web", model: "m" });
  await there.append({ t: "user", text: "about the web" });

  expect((await listSessions(dir, { cwd: "/work/api" })).map((s) => s.title)).toEqual([
    "about the api",
  ]);
  expect(await listSessions(dir)).toHaveLength(2);
});

test("a conversation reads back exactly as it was written", async () => {
  const dir = await root();
  const session = await openSession({ root: dir, cwd: "/w", model: "m" });
  await session.append({ t: "user", text: "read a.txt" });
  await session.append({ t: "step", nodeType: "read", durationMs: 3, detail: "a.txt" });
  await session.append({ t: "answer", raw: "## Done\n\n- read it" });

  const loaded = await readSession(dir, session.id);
  expect(loaded!.events).toEqual([
    { t: "user", text: "read a.txt" },
    { t: "step", nodeType: "read", durationMs: 3, detail: "a.txt" },
    { t: "answer", raw: "## Done\n\n- read it" },
  ]);
});

test("the model's own history survives, so resuming is not a retelling", async () => {
  const dir = await root();
  const session = await openSession({ root: dir, cwd: "/w", model: "m" });
  const added = [
    { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "hello" }] },
  ];
  await session.append({ t: "messages", added });

  const loaded = await readSession(dir, session.id);
  expect(loaded!.events[0]).toEqual({ t: "messages", added });
});

test("a session with no messages yet is not offered in the listing", async () => {
  const dir = await root();
  await openSession({ root: dir, cwd: "/w", model: "m" });
  expect(await listSessions(dir)).toEqual([]);
});

test("a corrupt event line does not take the rest of the conversation with it", async () => {
  const dir = await root();
  const session = await openSession({ root: dir, cwd: "/w", model: "m" });
  await session.append({ t: "user", text: "before" });
  await writeFile(join(session.dir, "events.jsonl"), "{not json\n", { flag: "a" });
  await session.append({ t: "user", text: "after" });

  const loaded = await readSession(dir, session.id);
  expect(loaded!.events).toEqual([
    { t: "user", text: "before" },
    { t: "user", text: "after" },
  ]);
});

test("reading a session that is not there is empty, not an error", async () => {
  expect(await readSession(await root(), "nope")).toBeNull();
});

test("deleting really deletes, because these hold other people's words", async () => {
  const dir = await root();
  const session = await openSession({ root: dir, cwd: "/w", model: "m" });
  await session.append({ t: "user", text: "private" });

  await deleteSession(dir, session.id);
  expect(await listSessions(dir)).toEqual([]);
  const remaining = await readdir(join(dir, folderKey("/w"))).catch(() => []);
  expect(remaining).toEqual([]);
});

test("deleting something already gone is quiet, not a crash", async () => {
  await expect(deleteSession(await root(), "nope")).resolves.toBeUndefined();
});

test("a directory that no longer exists is still listed, so history is not hidden", async () => {
  const dir = await root();
  const session = await openSession({ root: dir, cwd: "/gone/for/good", model: "m" });
  await session.append({ t: "user", text: "still here" });

  const [summary] = await listSessions(dir);
  expect(summary!.cwd).toBe("/gone/for/good");
  expect(summary!.title).toBe("still here");
});
