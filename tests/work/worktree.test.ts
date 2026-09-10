import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  branchName,
  createWorktree,
  hasUncommitted,
  listWorktrees,
  removeWorktree,
  runGit,
  worktreesRoot,
} from "../../src/work/worktree";

/** A real repository with one commit: git behaviour is the thing under test. */
async function repository(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vesna-wt-"));
  await runGit(["init", "-q", "-b", "main"], dir);
  await runGit(["config", "user.email", "t@example.com"], dir);
  await runGit(["config", "user.name", "Test"], dir);
  await writeFile(join(dir, "a.txt"), "one\n");
  await runGit(["add", "-A"], dir);
  await runGit(["commit", "-qm", "first"], dir);
  return dir;
}

test("worktrees live inside the project, out of the way", () => {
  expect(worktreesRoot("/work/api")).toBe("/work/api/.vesna/worktrees");
});

test("a branch says who made it and what for", () => {
  expect(branchName("abort-handling", "T2")).toBe("vesna/abort-handling/T2");
});

test("a worktree is a real checkout of the repository", async () => {
  const repo = await repository();
  const tree = await createWorktree(repo, "spec", "T1");
  expect(await readFile(join(tree.path, "a.txt"), "utf8")).toBe("one\n");
});

test("it is on a branch of its own, so the result is attributable", async () => {
  const repo = await repository();
  const tree = await createWorktree(repo, "spec", "T1");
  const head = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], tree.path);
  expect(head.stdout.trim()).toBe("vesna/spec/T1");
});

test("work in one checkout is invisible in another", async () => {
  const repo = await repository();
  const one = await createWorktree(repo, "spec", "T1");
  const two = await createWorktree(repo, "spec", "T2");

  await writeFile(join(one.path, "a.txt"), "changed by T1\n");
  expect(await readFile(join(two.path, "a.txt"), "utf8")).toBe("one\n");
  expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("one\n");
});

test("a second attempt on the same task is refused, not quietly merged into the first", async () => {
  const repo = await repository();
  await createWorktree(repo, "spec", "T1");
  await expect(createWorktree(repo, "spec", "T1")).rejects.toThrow(/already exists/);
});

test("only Vesna's own worktrees are listed", async () => {
  const repo = await repository();
  await createWorktree(repo, "spec", "T1");
  await runGit(["worktree", "add", "-b", "mine", join(repo, "..", "manual"), "HEAD"], repo);

  const found = await listWorktrees(repo);
  expect(found.map((tree) => tree.branch)).toEqual(["vesna/spec/T1"]);
});

test("uncommitted work is noticed", async () => {
  const repo = await repository();
  const tree = await createWorktree(repo, "spec", "T1");
  expect(await hasUncommitted(tree.path)).toBe(false);
  await writeFile(join(tree.path, "a.txt"), "half done\n");
  expect(await hasUncommitted(tree.path)).toBe(true);
});

test("removing a checkout with unfinished work is refused — it is the only record of it", async () => {
  const repo = await repository();
  const tree = await createWorktree(repo, "spec", "T1");
  await writeFile(join(tree.path, "a.txt"), "half done\n");

  await expect(removeWorktree(repo, tree)).rejects.toThrow(/uncommitted/);
  expect(await readFile(join(tree.path, "a.txt"), "utf8")).toBe("half done\n");
});

test("unfinished work can be discarded when that is what was meant", async () => {
  const repo = await repository();
  const tree = await createWorktree(repo, "spec", "T1");
  await writeFile(join(tree.path, "a.txt"), "half done\n");

  await removeWorktree(repo, tree, { discardChanges: true });
  expect(await listWorktrees(repo)).toEqual([]);
});

test("a clean checkout is removed without argument, branch and all", async () => {
  const repo = await repository();
  const tree = await createWorktree(repo, "spec", "T1");
  await removeWorktree(repo, tree);

  expect(await listWorktrees(repo)).toEqual([]);
  const branch = await runGit(["rev-parse", "--verify", tree.branch], repo);
  expect(branch.code).not.toBe(0);
});

test("committed work survives removal, because it is in the repository now", async () => {
  const repo = await repository();
  const tree = await createWorktree(repo, "spec", "T1");
  await writeFile(join(tree.path, "a.txt"), "finished\n");
  await runGit(["add", "-A"], tree.path);
  await runGit(["commit", "-qm", "the work"], tree.path);

  const sha = (await runGit(["rev-parse", "HEAD"], tree.path)).stdout.trim();
  await removeWorktree(repo, tree, { discardChanges: true });

  // The branch is gone, but the commit is still reachable by its own name.
  const kept = await runGit(["cat-file", "-t", sha], repo);
  expect(kept.stdout.trim()).toBe("commit");
});

test("the same task can be attempted again once the first is cleared away", async () => {
  const repo = await repository();
  const first = await createWorktree(repo, "spec", "T1");
  await removeWorktree(repo, first);
  await expect(createWorktree(repo, "spec", "T1")).resolves.toBeDefined();
});

test("outside a repository the failure says so, rather than leaving a directory behind", async () => {
  const notRepo = await mkdtemp(join(tmpdir(), "vesna-plain-"));
  await expect(createWorktree(notRepo, "spec", "T1")).rejects.toThrow(/could not create/);
});

test("the worktrees directory ignores itself, so nothing can commit a nested checkout", async () => {
  const repo = await repository();
  await createWorktree(repo, "spec", "T1");

  const status = await runGit(["status", "--porcelain"], repo);
  expect(status.stdout.trim()).toBe("");
});

test("and it keeps ignoring itself once there is real work inside", async () => {
  const repo = await repository();
  const tree = await createWorktree(repo, "spec", "T1");
  await writeFile(join(tree.path, "big.txt"), "a whole checkout\n");

  const status = await runGit(["status", "--porcelain"], repo);
  expect(status.stdout).not.toContain(".vesna");
});

test("removal refuses an arbitrary directory even when discard was requested", async () => {
  const repo = await repository();
  const outside = await mkdtemp(join(tmpdir(), "vesna-not-a-worktree-"));
  await writeFile(join(outside, "important.txt"), "keep me\n");

  await expect(
    removeWorktree(repo, { path: outside, branch: "vesna/spec/T1" }, { discardChanges: true }),
  ).rejects.toThrow(/not inside/);
  expect(await readFile(join(outside, "important.txt"), "utf8")).toBe("keep me\n");
});
