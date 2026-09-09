import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellNode } from "../../src/nodes/shell";
import { scriptNode } from "../../src/nodes/script";

/**
 * Interrupting a turn has to reach the process the turn started.
 *
 * A child left running after ctrl-c keeps writing files and burning CPU on
 * behalf of a conversation that has already moved on, and the user has no way
 * to see it, let alone stop it.
 */

const dir = () => mkdtemp(join(tmpdir(), "vesna-abort-"));

test("aborting a shell command stops it rather than letting it finish", async () => {
  const cwd = await dir();
  const marker = join(cwd, "finished.txt");
  const controller = new AbortController();

  const running = shellNode.run(
    { command: `sleep 2; echo done > ${JSON.stringify(marker)}` },
    { cwd, signal: controller.signal },
  );

  await new Promise((resolve) => setTimeout(resolve, 150));
  controller.abort();
  await expect(running).rejects.toThrow(/abort|interrupt/i);

  // Well past when the command would have written, had it survived.
  await new Promise((resolve) => setTimeout(resolve, 2200));
  await expect(readFile(marker, "utf8")).rejects.toThrow();
});

test("a signal already aborted stops the command before it starts", async () => {
  const cwd = await dir();
  const marker = join(cwd, "ran.txt");
  await expect(
    shellNode.run(
      { command: `echo done > ${JSON.stringify(marker)}` },
      { cwd, signal: AbortSignal.abort() },
    ),
  ).rejects.toThrow(/abort|interrupt/i);
  await expect(readFile(marker, "utf8")).rejects.toThrow();
});

test("a shell command that finishes normally is untouched by the plumbing", async () => {
  const cwd = await dir();
  const result = await shellNode.run(
    { command: "echo hello" },
    { cwd, signal: new AbortController().signal },
  );
  expect(result.stdout.trim()).toBe("hello");
  expect(result.code).toBe(0);
});

test("aborting a script stops it too", async () => {
  const cwd = await dir();
  const controller = new AbortController();

  const running = scriptNode.run(
    { body: `await new Promise((r) => setTimeout(r, 4000)); output = 1;`, timeoutMs: 30_000 },
    { cwd, signal: controller.signal },
  );

  await new Promise((resolve) => setTimeout(resolve, 150));
  controller.abort();
  await expect(running).rejects.toThrow(/abort|interrupt|no result/i);
});

test("a child that ignores SIGTERM is still killed", async () => {
  const cwd = await dir();
  const marker = join(cwd, "stubborn.txt");
  await writeFile(join(cwd, "stubborn.sh"), `trap '' TERM\nsleep 5\necho done > ${marker}\n`);

  const controller = new AbortController();
  const running = shellNode.run(
    { command: "sh stubborn.sh" },
    { cwd, signal: controller.signal },
  );

  await new Promise((resolve) => setTimeout(resolve, 150));
  controller.abort();
  await expect(running).rejects.toThrow(/abort|interrupt/i);

  await new Promise((resolve) => setTimeout(resolve, 5200));
  await expect(readFile(marker, "utf8")).rejects.toThrow();
}, 15_000);
