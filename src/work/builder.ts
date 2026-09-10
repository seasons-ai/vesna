import { createSession } from "../loop/session";
import { decide, type Policy } from "../policy/decide";
import type { Provider } from "../providers/types";
import type { Registry } from "../registry/types";
import { createWorktree, removeWorktree, runGit, type GitRunner, type Worktree } from "./worktree";

/**
 * One task, done in a checkout of its own.
 *
 * A builder has nobody to ask. It runs while the user is reading something
 * else, so a question it cannot put to anyone becomes a refusal rather than a
 * silent yes: the task comes back saying what it was not allowed to do, and a
 * rule can be written for next time. Turning `ask` into `allow` for unattended
 * work would be the same mistake as claiming a sandbox that was not one.
 */

export interface BuildRequest {
  repo: string;
  spec: string;
  task: string;
  objective: string;
  provider: Provider;
  registry: Registry;
  policy: Policy;
  model?: string;
  maxTurns?: number;
  /** Refused once this much has been spent, so a loop cannot run away. */
  maxUsd?: number;
  signal?: AbortSignal;
  git?: GitRunner;
}

export interface BuildResult {
  task: string;
  status: "committed" | "no-changes" | "refused" | "failed";
  branch: string;
  worktree: string;
  commit?: string;
  /** What it was not allowed to do, so a rule can be written for next time. */
  refusals: string[];
  costUsd: number;
  text: string;
  error?: string;
}

export async function runTask(request: BuildRequest): Promise<BuildResult> {
  const git = request.git ?? runGit;
  let tree: Worktree;
  try {
    tree = await createWorktree(request.repo, request.spec, request.task, git);
  } catch (error) {
    return {
      task: request.task,
      status: "failed",
      branch: "",
      worktree: "",
      refusals: [],
      costUsd: 0,
      text: "",
      error: (error as Error).message,
    };
  }

  const refusals: string[] = [];
  const session = createSession(request.provider, request.registry, {
    cwd: tree.path,
    ...(request.model ? { model: request.model } : {}),
    maxTurns: request.maxTurns ?? 16,
    ...(request.signal ? { signal: request.signal } : {}),
    async approve(action) {
      if (request.maxUsd !== undefined && session.costUsd >= request.maxUsd) {
        refusals.push(`budget of $${request.maxUsd.toFixed(2)} reached`);
        return "deny";
      }
      const verdict = decide({ ...action, cwd: tree.path }, request.policy, tree.path);
      if (verdict === "allow") return "allow";
      // No user is watching, so a question is a refusal with a reason.
      refusals.push(`${action.node} ${describe(action.input)}`);
      return "deny";
    },
  });

  let text = "";
  let error: string | undefined;
  try {
    text = (await session.send(request.objective)).text;
  } catch (failure) {
    error = (failure as Error).message;
  }

  let committed: string | null = null;
  try {
    committed = await commit(tree, request.task, git);
  } catch (failure) {
    const message = (failure as Error).message;
    error = error === undefined ? message : `${error}; ${message}`;
  }

  return {
    task: request.task,
    status:
      error !== undefined
        ? "failed"
        : refusals.length > 0
          ? "refused"
          : committed === null
            ? "no-changes"
            : "committed",
    branch: tree.branch,
    worktree: tree.path,
    ...(committed ? { commit: committed } : {}),
    refusals,
    costUsd: session.costUsd,
    text,
    ...(error !== undefined ? { error } : {}),
  };
}

/** Commits whatever the builder produced. Null when it produced nothing. */
async function commit(tree: Worktree, task: string, git: GitRunner): Promise<string | null> {
  const added = await git(["add", "-A"], tree.path);
  if (added.code !== 0) throw new Error(`git add failed: ${gitDetail(added)}`);

  const staged = await git(["diff", "--cached", "--quiet"], tree.path);
  // --quiet has exactly two ordinary outcomes: 0 is clean, 1 is different.
  if (staged.code === 0) return null;
  if (staged.code !== 1) throw new Error(`git diff failed: ${gitDetail(staged)}`);

  const made = await git(["commit", "-qm", `${task}: built by vesna`], tree.path);
  if (made.code !== 0) throw new Error(`git commit failed: ${gitDetail(made)}`);

  const sha = await git(["rev-parse", "HEAD"], tree.path);
  if (sha.code !== 0) throw new Error(`could not read commit: ${gitDetail(sha)}`);
  return sha.stdout.trim();
}

/** Discards a build's checkout. The branch survives when there is a commit on it. */
export async function discardBuild(
  repo: string,
  result: BuildResult,
  git: GitRunner = runGit,
): Promise<void> {
  if (result.worktree === "") return;
  await removeWorktree(
    repo,
    { path: result.worktree, branch: result.branch },
    { discardChanges: true },
    git,
  );
}

function describe(input: Record<string, unknown>): string {
  const path = input.path ?? input.command;
  return typeof path === "string" ? path : "";
}

function gitDetail(result: { stdout: string; stderr: string }): string {
  return (result.stderr || result.stdout).trim().split("\n")[0] || "unknown git error";
}
