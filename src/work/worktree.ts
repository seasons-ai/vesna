import { existsSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * A private copy of the repository for one task.
 *
 * Two builders in one directory overwrite each other's files, and the first
 * sign of it is a diff that makes no sense. A worktree gives each one its own
 * checkout and its own branch, so the result of a task is a commit rather than
 * a pile of changes nobody can attribute.
 *
 * Removal never discards work by default. An agent that stopped halfway leaves
 * changes behind, and those changes are the only record of what it tried.
 */

export interface Worktree {
  path: string;
  branch: string;
}

export interface GitRunner {
  (args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

export const runGit: GitRunner = async (args, cwd) => {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
};

/** Where a task's checkout lives. Inside the project, and git-ignored. */
export function worktreesRoot(repo: string): string {
  return join(repo, ".vesna", "worktrees");
}

/** A branch name that says who made it and what for. */
export function branchName(spec: string, task: string): string {
  return `vesna/${spec}/${task}`;
}

/** Where a specific task's own checkout lives — the one formula every caller shares. */
export function worktreePath(repo: string, spec: string, task: string): string {
  return join(worktreesRoot(repo), `${spec}-${task}`);
}

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

export async function createWorktree(
  repo: string,
  spec: string,
  task: string,
  git: GitRunner = runGit,
): Promise<Worktree> {
  const branch = branchName(spec, task);
  const path = worktreePath(repo, spec, task);

  // A branch that already exists means a previous attempt is still around, and
  // reusing it silently would mix two attempts into one history. The message
  // names the two commands that clear it, because "remove that worktree" is
  // not something a person can type.
  const existing = await git(["rev-parse", "--verify", branch], repo);
  if (existing.code === 0) {
    throw new WorktreeError(
      `branch ${branch} already exists — a previous attempt is still around: git worktree remove --force ${path} && git branch -D ${branch}`,
    );
  }

  await ensureIgnored(repo);

  const made = await git(["worktree", "add", "-b", branch, path, "HEAD"], repo);
  if (made.code !== 0) {
    throw new WorktreeError(`could not create a worktree: ${firstLine(made.stderr)}`);
  }

  return { path, branch };
}

/**
 * The directory ignores itself.
 *
 * A worktree is a whole checkout, and it lives inside the repository it came
 * from. Without this, `git status` fills with it and an agent running
 * `git add -A` can commit a nested copy of the project — which is a mess to
 * find and a worse one to undo.
 */
async function ensureIgnored(repo: string): Promise<void> {
  const root = worktreesRoot(repo);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, ".gitignore"), "*\n");
}

export async function listWorktrees(
  repo: string,
  git: GitRunner = runGit,
): Promise<Worktree[]> {
  const result = await git(["worktree", "list", "--porcelain"], repo);
  if (result.code !== 0) return [];

  const found: Worktree[] = [];
  let path: string | null = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    if (line.startsWith("branch ") && path !== null) {
      const branch = line.slice("branch refs/heads/".length);
      // Only ours: the user's own worktrees are not Vesna's to manage.
      if (branch.startsWith("vesna/")) found.push({ path, branch });
      path = null;
    }
  }
  return found;
}

/** True when the checkout holds changes that are not committed anywhere. */
export async function hasUncommitted(path: string, git: GitRunner = runGit): Promise<boolean> {
  const result = await git(["status", "--porcelain"], path);
  return result.code === 0 && result.stdout.trim() !== "";
}

// A path that does not exist cannot be resolved, and that is an answer rather
// than a failure: nothing lives inside a directory that is not there.
async function settle(candidate: string): Promise<string> {
  try {
    return await realpath(resolve(candidate));
  } catch {
    return resolve(candidate);
  }
}

/**
 * Whether `tree` is a live, present worktree git itself currently knows about.
 *
 * `git worktree list` reports paths already resolved through symlinks, so a
 * raw string comparison against `tree.path` falsely says "not registered"
 * for any repository reached through one — every macOS tmp directory among
 * them. Both sides are realpath'd the same way before comparing.
 *
 * A directory that is gone is never registered, even when git's own
 * administrative files still name it (git keeps a removed worktree's entry
 * in `worktree list` until something prunes it): there is nothing there for
 * a caller to act on as a worktree, and running git inside a path that does
 * not exist throws rather than answering.
 */
export async function isRegistered(repo: string, tree: Worktree, git: GitRunner = runGit): Promise<boolean> {
  if (!existsSync(tree.path)) return false;
  const path = await settle(tree.path);
  const registeredPaths = await Promise.all(
    (await listWorktrees(repo, git)).map(async (candidate) => ({
      path: await settle(candidate.path),
      branch: candidate.branch,
    })),
  );
  return registeredPaths.some((candidate) => candidate.path === path && candidate.branch === tree.branch);
}

export async function removeWorktree(
  repo: string,
  tree: Worktree,
  options: { discardChanges?: boolean } = {},
  git: GitRunner = runGit,
): Promise<void> {
  const root = await settle(worktreesRoot(repo));
  const path = await settle(tree.path);
  const inside = relative(root, path);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new WorktreeError(`${tree.path} is not inside Vesna's worktrees directory`);
  }

  if (!(await isRegistered(repo, tree, git))) {
    throw new WorktreeError(`${tree.path} is not a registered Vesna worktree`);
  }

  if (options.discardChanges !== true && (await hasUncommitted(path, git))) {
    throw new WorktreeError(
      `${tree.path} has uncommitted changes — commit them, or remove it with discardChanges`,
    );
  }

  const removed = await git(["worktree", "remove", "--force", path], repo);
  if (removed.code !== 0) {
    throw new WorktreeError(`could not remove worktree: ${firstLine(removed.stderr)}`);
  }
  // A successful git removal may leave an empty administrative directory behind.
  await rm(path, { recursive: true, force: true });

  const deleted = await git(["branch", "-D", tree.branch], repo);
  if (deleted.code !== 0) {
    throw new WorktreeError(`worktree removed, but could not delete branch: ${firstLine(deleted.stderr)}`);
  }
}

/**
 * Whether a branch exists — with or without a worktree checked out on it.
 *
 * Answered from `branch --list`'s own output, matched against the name,
 * rather than from an exit code: a branch left behind by a stopped build is
 * a fact about the refs, and the check has to be a positive sighting of the
 * name, not the absence of an error.
 */
export async function branchExists(repo: string, branch: string, git: GitRunner = runGit): Promise<boolean> {
  const result = await git(["branch", "--list", branch], repo);
  if (result.code !== 0) return false;
  return result.stdout.split("\n").some((line) => line.replace(/^[*+]?\s*/, "").trim() === branch);
}

/**
 * Whether a task's branch is already merged into `base` — the state a
 * process killed after the merge and before `task.done` leaves behind.
 *
 * "Merged" is not just "an ancestor of the base": a branch created at HEAD
 * that nothing was ever committed to is an ancestor too, and it is empty,
 * not merged. Vesna merges with --no-ff, so a merged branch's head is the
 * second parent of a merge commit and never on the base's first-parent
 * line; an empty branch's head always is. The branch has to be sighted
 * positively first — a name git does not know is not merged, whatever the
 * exit codes of the questions that follow would say.
 */
export async function isMerged(repo: string, branch: string, base: string, git: GitRunner = runGit): Promise<boolean> {
  if (!(await branchExists(repo, branch, git))) return false;
  const ancestor = await git(["merge-base", "--is-ancestor", branch, base], repo);
  if (ancestor.code !== 0) return false;
  const head = await git(["rev-parse", "--verify", `${branch}^{commit}`], repo);
  if (head.code !== 0) return false;
  const line = await git(["rev-list", "--first-parent", base], repo);
  if (line.code !== 0) return false;
  const sha = head.stdout.trim();
  return !line.stdout.split("\n").some((entry) => entry.trim() === sha);
}

/**
 * Deletes a branch. Used after its merge went in: the merge is --no-ff, so
 * the merge commit carries the branch's whole history and can be reverted
 * as a unit, and the ref itself is a leftover. A branch that is already
 * gone is the state that was wanted.
 *
 * Prunes first: a worktree whose directory went missing without going
 * through `removeWorktree` (an operator's `rm -rf`, say) leaves git's own
 * bookkeeping still pointing at it, and git then refuses to delete the
 * branch as "used by worktree". Pruning drops that stale record — it never
 * touches a working tree that still exists — so this is safe to run every
 * time, not only when a directory is actually known to be gone.
 */
export async function deleteBranch(repo: string, branch: string, git: GitRunner = runGit): Promise<void> {
  await git(["worktree", "prune"], repo);
  const result = await git(["branch", "-D", branch], repo);
  if (result.code !== 0 && !/not found/i.test(result.stderr)) {
    throw new WorktreeError(`could not delete branch ${branch}: ${result.stderr.trim().split("\n")[0]}`);
  }
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "unknown error";
}
