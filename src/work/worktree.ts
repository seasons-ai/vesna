import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
  const path = join(worktreesRoot(repo), `${spec}-${task}`);

  // A branch that already exists means a previous attempt is still around, and
  // reusing it silently would mix two attempts into one history.
  const existing = await git(["rev-parse", "--verify", branch], repo);
  if (existing.code === 0) {
    throw new WorktreeError(`branch ${branch} already exists — remove that worktree first`);
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

export async function removeWorktree(
  repo: string,
  tree: Worktree,
  options: { discardChanges?: boolean } = {},
  git: GitRunner = runGit,
): Promise<void> {
  if (options.discardChanges !== true && (await hasUncommitted(tree.path, git))) {
    throw new WorktreeError(
      `${tree.path} has uncommitted changes — commit them, or remove it with discardChanges`,
    );
  }

  await git(["worktree", "remove", "--force", tree.path], repo);
  // git leaves the directory behind if it never fully registered the worktree.
  await rm(tree.path, { recursive: true, force: true });
  await git(["branch", "-D", tree.branch], repo);
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "unknown error";
}
