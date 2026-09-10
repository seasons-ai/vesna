import { runGit, type GitRunner } from "./worktree";

/**
 * Bringing finished work back.
 *
 * One branch at a time, and it stops at the first conflict. Merging the rest
 * on top of a half-resolved tree buries the conflict under later changes and
 * leaves a state nobody can reason about — and the person who has to sort it
 * out is the one who was not watching.
 *
 * The branches are not deleted. A merge that went in can be reverted; a branch
 * that was deleted to tidy up cannot be examined.
 */

export interface MergeCandidate {
  task: string;
  branch: string;
}

export interface MergeReport {
  merged: { task: string; branch: string }[];
  /** The one that stopped the queue, if any. */
  conflict?: { task: string; branch: string; files: string[] };
  /** A non-conflict git failure that stopped the queue. */
  error?: { task: string; branch: string; message: string };
  /** Never attempted, because the queue stopped first. */
  pending: string[];
}

export async function mergeAll(
  repo: string,
  candidates: MergeCandidate[],
  git: GitRunner = runGit,
): Promise<MergeReport> {
  const merged: { task: string; branch: string }[] = [];

  for (const [index, candidate] of candidates.entries()) {
    const attempt = await git(
      ["merge", "--no-ff", "-m", `merge ${candidate.task}`, candidate.branch],
      repo,
    );

    if (attempt.code === 0) {
      merged.push(candidate);
      continue;
    }

    const files = await conflictedFiles(repo, git);
    const mergeHead = await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], repo);
    if (mergeHead.code === 0) {
      // A failed merge can leave the repository half-merged even when the
      // failure was not a content conflict (for example, a commit hook).
      const aborted = await git(["merge", "--abort"], repo);
      if (aborted.code !== 0) {
        return {
          merged,
          error: {
            task: candidate.task,
            branch: candidate.branch,
            message: `merge failed and could not be aborted: ${detail(aborted)}`,
          },
          pending: candidates.slice(index + 1).map((rest) => rest.task),
        };
      }
    }

    if (files.length > 0) {
      return {
        merged,
        conflict: { task: candidate.task, branch: candidate.branch, files },
        pending: candidates.slice(index + 1).map((rest) => rest.task),
      };
    }

    return {
      merged,
      error: { task: candidate.task, branch: candidate.branch, message: detail(attempt) },
      pending: candidates.slice(index + 1).map((rest) => rest.task),
    };
  }

  return { merged, pending: [] };
}

async function conflictedFiles(repo: string, git: GitRunner): Promise<string[]> {
  const result = await git(["diff", "--name-only", "--diff-filter=U"], repo);
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function detail(result: { stdout: string; stderr: string }): string {
  return (result.stderr || result.stdout).trim().split("\n")[0] || "unknown git error";
}
