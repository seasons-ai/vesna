import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeAll } from "../../src/work/merge";
import { createWorktree, runGit } from "../../src/work/worktree";

async function repository(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vesna-merge-"));
  await runGit(["init", "-q", "-b", "main"], dir);
  await runGit(["config", "user.email", "t@example.com"], dir);
  await runGit(["config", "user.name", "Test"], dir);
  await writeFile(join(dir, "a.txt"), "one\n");
  await runGit(["add", "-A"], dir);
  await runGit(["commit", "-qm", "first"], dir);
  return dir;
}

/** Builds a branch that writes `text` into `file`. */
async function branchThatWrites(repo: string, task: string, file: string, text: string) {
  const tree = await createWorktree(repo, "spec", task);
  await writeFile(join(tree.path, file), text);
  await runGit(["add", "-A"], tree.path);
  await runGit(["commit", "-qm", task], tree.path);
  return { task, branch: tree.branch };
}

test("nothing to merge is a clean report, not an error", async () => {
  expect(await mergeAll(await repository(), [])).toEqual({ merged: [], pending: [] });
});

test("work on separate files all comes back", async () => {
  const repo = await repository();
  const one = await branchThatWrites(repo, "T1", "one.txt", "1\n");
  const two = await branchThatWrites(repo, "T2", "two.txt", "2\n");

  const report = await mergeAll(repo, [one, two]);
  expect(report.merged.map((entry) => entry.task)).toEqual(["T1", "T2"]);
  expect(report.conflict).toBeUndefined();
  expect(await readFile(join(repo, "one.txt"), "utf8")).toBe("1\n");
  expect(await readFile(join(repo, "two.txt"), "utf8")).toBe("2\n");
});

test("a conflict stops the queue and names what clashed", async () => {
  const repo = await repository();
  const one = await branchThatWrites(repo, "T1", "a.txt", "from T1\n");
  const two = await branchThatWrites(repo, "T2", "a.txt", "from T2\n");

  const report = await mergeAll(repo, [one, two]);
  expect(report.merged.map((entry) => entry.task)).toEqual(["T1"]);
  expect(report.conflict!.task).toBe("T2");
  expect(report.conflict!.files).toEqual(["a.txt"]);
});

test("the repository is left usable after a conflict, not half merged", async () => {
  const repo = await repository();
  const one = await branchThatWrites(repo, "T1", "a.txt", "from T1\n");
  const two = await branchThatWrites(repo, "T2", "a.txt", "from T2\n");
  await mergeAll(repo, [one, two]);

  const status = await runGit(["status", "--porcelain"], repo);
  expect(status.stdout.trim()).toBe("");
  // T1 is in, and no conflict markers survived anywhere.
  expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("from T1\n");
});

test("what never got its turn is reported, not silently dropped", async () => {
  const repo = await repository();
  const one = await branchThatWrites(repo, "T1", "a.txt", "from T1\n");
  const two = await branchThatWrites(repo, "T2", "a.txt", "from T2\n");
  const three = await branchThatWrites(repo, "T3", "c.txt", "3\n");

  const report = await mergeAll(repo, [one, two, three]);
  expect(report.pending).toEqual(["T3"]);
});

test("a conflicted branch is kept, so the work can still be looked at", async () => {
  const repo = await repository();
  const one = await branchThatWrites(repo, "T1", "a.txt", "from T1\n");
  const two = await branchThatWrites(repo, "T2", "a.txt", "from T2\n");
  await mergeAll(repo, [one, two]);

  const kept = await runGit(["rev-parse", "--verify", two.branch], repo);
  expect(kept.code).toBe(0);
});

test("a merge is its own commit, so it can be reverted as a unit", async () => {
  const repo = await repository();
  const one = await branchThatWrites(repo, "T1", "one.txt", "1\n");
  await mergeAll(repo, [one]);

  const parents = await runGit(["rev-list", "--parents", "-n", "1", "HEAD"], repo);
  expect(parents.stdout.trim().split(" ")).toHaveLength(3);
});
