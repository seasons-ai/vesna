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
  /**
   * Which node types the project lets a session have at all — the same
   * `permits(config, type)` the chat applies. The process's own nodes are
   * refused on top of it, whatever this says.
   */
  permit?: (type: string) => boolean;
  /** The project's own instructions, from .vesna/AGENTS.md. */
  notes?: string;
  model?: string;
  maxTurns?: number;
  /** Refused once this much has been spent, so a loop cannot run away. */
  maxUsd?: number;
  signal?: AbortSignal;
  git?: GitRunner;
}

/**
 * The tools the process itself is driven by. They are bound to the root's
 * spec log — `plan` opens a spec, `task_start` and `task_verify` move a task,
 * `classify` records a shape — and a worker reaching for one would write the
 * process's own record from inside a task: a stray spec on the shell route,
 * a task reset to todo or marked done before any review on the chat route.
 * A worker builds; it does not run the process.
 */
export const PROCESS_NODES: ReadonlySet<string> = new Set(["plan", "task_start", "task_verify", "classify"]);

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

  return await work(request, tree, request.objective, `${request.task}: built by vesna`);
}

export interface ResumeRequest extends Omit<BuildRequest, "spec" | "objective"> {
  worktree: { path: string; branch: string };
  /** The findings, already rendered as the message the worker reads. */
  message: string;
}

/**
 * A fix round. The same checkout, a fresh session, the findings as its
 * objective. The worker's memory across rounds is its report file, not its
 * context: a context that has argued itself into a corner is not the thing to
 * hand the corner back to.
 */
export async function resumeTask(request: ResumeRequest): Promise<BuildResult> {
  const tree: Worktree = { path: request.worktree.path, branch: request.worktree.branch };
  return await work(request, tree, request.message, `${request.task}: fix`);
}

async function work(
  request: Omit<BuildRequest, "spec" | "objective">,
  tree: Worktree,
  objective: string,
  commitMessage: string,
): Promise<BuildResult> {
  const git = request.git ?? runGit;
  const refusals: string[] = [];
  const session = createSession(request.provider, request.registry, {
    cwd: tree.path,
    ...(request.model ? { model: request.model } : {}),
    maxTurns: request.maxTurns ?? 16,
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.notes !== undefined ? { notes: request.notes } : {}),
    permit: (type) => !PROCESS_NODES.has(type) && (request.permit === undefined || request.permit(type)),
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
    text = (await session.send(objective)).text;
  } catch (failure) {
    error = (failure as Error).message;
  }

  let committed: string | null = null;
  try {
    committed = await commit(tree, commitMessage, git);
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
async function commit(tree: Worktree, message: string, git: GitRunner): Promise<string | null> {
  const added = await git(["add", "-A"], tree.path);
  if (added.code !== 0) throw new Error(`git add failed: ${gitDetail(added)}`);

  const staged = await git(["diff", "--cached", "--quiet"], tree.path);
  // --quiet has exactly two ordinary outcomes: 0 is clean, 1 is different.
  if (staged.code === 0) return null;
  if (staged.code !== 1) throw new Error(`git diff failed: ${gitDetail(staged)}`);

  const made = await git(["commit", "-qm", message], tree.path);
  if (made.code !== 0) throw new Error(`git commit failed: ${gitDetail(made)}`);

  const sha = await git(["rev-parse", "HEAD"], tree.path);
  if (sha.code !== 0) throw new Error(`could not read commit: ${gitDetail(sha)}`);
  return sha.stdout.trim();
}

/** Removes a build's checkout — worktree and branch both — discarding whatever changes it holds. */
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
