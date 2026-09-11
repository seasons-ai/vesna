import { join } from "node:path";
import type { Policy } from "../policy/decide";
import type { Provider } from "../providers/types";
import type { Registry } from "../registry/types";
import { project, type Finding, type SpecEvent, type Task } from "../spec/project";
import { appendEvent, readEvents, readSpecFile, specPaths, writeSpecFile } from "../spec/store";
import { resumeTask, runTask, type BuildResult } from "../work/builder";
import { mergeAll } from "../work/merge";
import { schedule } from "../work/schedule";
import { runGit, type GitRunner } from "../work/worktree";
import { splitPlan, writeBriefs } from "./brief";
import { reviewTask, type ReviewOutcome } from "./review";

/**
 * The loop.
 *
 * For each task the plan names, in dependency order: cut its brief, build it
 * in a checkout of its own, review the diff, fix what the review found, and
 * merge — then the next. Merging per task rather than all at the end is not
 * optional: a task that depends on another's code has to branch from a tree
 * that has it.
 *
 * Every step is an event in the spec's log, so the garden shows it as it
 * happens and a person who comes back later can read what was decided.
 */
export interface BuildLoopRequest {
  root: string;
  specsRoot: string;
  slug: string;
  provider: Provider;
  registry: Registry;
  policy: Policy;
  model?: string;
  /** Fix rounds per task. Five is the cap; past it, rounds do not converge. */
  maxRounds?: number;
  maxUsd?: number;
  signal?: AbortSignal;
  git?: GitRunner;
  onEvent?: (event: SpecEvent) => void;
  /** Seams for tests. Defaults are the real functions. */
  build?: typeof runTask;
  resume?: typeof resumeTask;
  review?: typeof reviewTask;
  merge?: typeof mergeAll;
}

export type BuildOutcome =
  | { status: "done" }
  | { status: "stopped"; reason: string }
  | { status: "could-not-start"; reason: string };

class Stop extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export function renderFindings(findings: Finding[]): string {
  return findings
    .map((f) => `- [${f.severity}] ${f.file}${f.line !== undefined ? `:${f.line}` : ""} — ${f.text}`)
    .join("\n");
}

const blocking = (f: Finding) => f.severity !== "minor";

function isAbort(error: Error, signal: AbortSignal | undefined): boolean {
  return error.name === "AbortError" || signal?.aborted === true;
}

/**
 * A review call, made safe against a provider that throws instead of
 * answering. An abort — the person interrupted, or the signal already says so
 * — propagates untouched; anything else becomes a no-verdict outcome carrying
 * the error's message, so the caller can treat it exactly like a reviewer
 * that never called `review_verdict`.
 */
async function safeReview(
  review: typeof reviewTask,
  request: Parameters<typeof reviewTask>[0],
  signal: AbortSignal | undefined,
): Promise<{ outcome: ReviewOutcome; failReason?: string }> {
  try {
    return { outcome: await review(request) };
  } catch (error) {
    const err = error as Error;
    if (isAbort(err, signal)) throw err;
    return { outcome: { kind: "no-verdict", text: err.message, costUsd: 0 }, failReason: err.message };
  }
}

export async function runBuild(request: BuildLoopRequest): Promise<BuildOutcome> {
  const { specsRoot, slug } = request;
  const git = request.git ?? runGit;
  const build = request.build ?? runTask;
  const resume = request.resume ?? resumeTask;
  const review = request.review ?? reviewTask;
  const merge = request.merge ?? mergeAll;
  const maxRounds = request.maxRounds ?? 5;
  const paths = specPaths(specsRoot, slug);

  const emit = (event: SpecEvent) => {
    appendEvent(specsRoot, slug, event);
    request.onEvent?.(event);
  };

  const tree = project(readEvents(specsRoot, slug));
  if (tree === null) return { status: "could-not-start", reason: `no spec called "${slug}"` };
  if (!tree.approved.plan) {
    return { status: "could-not-start", reason: "the plan is not approved — /approve plan" };
  }
  const planText = readSpecFile(paths.plan);
  if (planText === null) return { status: "could-not-start", reason: "there is no plan.md to build" };

  let planTasks;
  try {
    planTasks = splitPlan(planText);
  } catch (error) {
    return { status: "could-not-start", reason: (error as Error).message };
  }
  if (planTasks.length === 0) return { status: "could-not-start", reason: "plan.md names no tasks" };
  if (tree.tasks.length === 0) return { status: "could-not-start", reason: "the log names no tasks" };

  // The diff range assumes nothing about the repository's default branch: a
  // fork on `master` (or anything else) works exactly as one on `main` does.
  const baseBranch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], request.root)).stdout.trim();

  const briefs = writeBriefs(specsRoot, slug, planTasks);
  emit({ t: "build.started" });

  const one = async (task: Task): Promise<BuildResult> => {
    const brief = readSpecFile(briefs[task.id] ?? "") ?? task.title;
    emit({ t: "task.started", id: task.id, agent: "vesna build" });

    const common = {
      repo: request.root,
      task: task.id,
      provider: request.provider,
      registry: request.registry,
      policy: request.policy,
      ...(request.model ? { model: request.model } : {}),
      ...(request.maxUsd !== undefined ? { maxUsd: request.maxUsd } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      git,
    };

    let result = await build({ ...common, spec: slug, objective: brief });
    let report = `# ${task.id}\n\n${result.text}\n`;
    writeSpecFile(join(paths.reports, `${task.id}.md`), report);

    if (result.status === "refused") {
      throw new Stop(`${task.id}: the worker was not allowed to: ${result.refusals.join("; ")}`);
    }
    if (result.status === "failed") throw new Stop(`${task.id}: ${result.error ?? "the build failed"}`);

    let round = 0;
    let silent = 0;
    let open: Finding[] | undefined;
    for (;;) {
      const diff = await git(["diff", `${baseBranch}...${result.branch}`], request.root);

      const { outcome, failReason } = await safeReview(
        review,
        {
          cwd: result.worktree,
          provider: request.provider,
          brief,
          report,
          diff: diff.stdout,
          ...(open !== undefined ? { findings: open } : {}),
          ...(request.model ? { model: request.model } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        },
        request.signal,
      );

      if (outcome.kind === "no-verdict") {
        silent += 1;
        emit({ t: "review.failed", task: task.id, round, reason: failReason ?? "no verdict" });
        writeSpecFile(join(paths.reviews, `${task.id}-r${round}.md`), `(no verdict)\n\n${outcome.text}\n`);
        if (silent >= 2) throw new Stop(`${task.id}: the reviewer produced no verdict twice`);
        continue;
      }
      silent = 0;
      const { verdict } = outcome;
      emit({ t: "review.done", task: task.id, round, spec: verdict.spec, findings: verdict.findings });
      writeSpecFile(
        join(paths.reviews, `${task.id}-r${round}.md`),
        `spec: ${verdict.spec}\n\n${verdict.summary}\n\n${renderFindings(verdict.findings)}\n`,
      );

      open = verdict.findings.filter(blocking);
      if (verdict.spec === "met" && open.length === 0) break;

      if (round >= maxRounds) {
        const critical = open.find((f) => f.severity === "critical");
        if (critical !== undefined) {
          throw new Stop(
            `${task.id}: a critical finding is still open after ${maxRounds} fix rounds — ${critical.text}`,
          );
        }
        for (const finding of verdict.findings) emit({ t: "parked", task: task.id, finding });
        break;
      }

      round += 1;
      const message = [
        `Review round ${round} found the following. Fix each, re-run the tests that cover it, and say what you changed.`,
        "",
        verdict.spec === "not_met" ? "The reviewer judged the brief NOT MET." : "",
        renderFindings(open),
      ].join("\n");
      result = await resume({ ...common, worktree: { path: result.worktree, branch: result.branch }, message });
      report += `\n## Fix round ${round}\n\n${result.text}\n`;
      writeSpecFile(join(paths.reports, `${task.id}.md`), report);
      if (result.status === "failed") throw new Stop(`${task.id}: fix round ${round} failed — ${result.error}`);
    }

    const merged = await merge(request.root, [{ task: task.id, branch: result.branch }], git);
    if (merged.conflict) throw new Stop(`${task.id}: merge conflict in ${merged.conflict.files.join(", ")}`);
    if (merged.error) throw new Stop(`${task.id}: ${merged.error.message}`);

    emit({ t: "task.done", id: task.id, ...(result.commit ? { commit: result.commit } : {}) });
    return result;
  };

  // The whole-branch review at the end diffs from where the build began, not
  // from some fixed point in the branch's past — `main~0` was never right
  // either, since `main` may not even be the branch this repo is on.
  const startSha = (await git(["rev-parse", "HEAD"], request.root)).stdout.trim();

  try {
    await schedule<BuildResult>({
      tasks: tree.tasks,
      concurrency: 1,
      run: one,
      succeeded: () => true,
      ...(request.signal ? { signal: request.signal } : {}),
    });

    // One more pair of eyes over the whole branch, with the parked findings
    // beside it. Nothing is fixed here; the person decides.
    const whole = await git(["diff", `${startSha}...HEAD`], request.root);
    const parked = project(readEvents(specsRoot, slug))?.parked ?? [];
    const { outcome: final, failReason: finalFailReason } = await safeReview(
      review,
      {
        cwd: request.root,
        provider: request.provider,
        brief: `The whole branch for spec "${slug}". Parked findings from the task reviews:\n${renderFindings(parked.map((p) => p.finding)) || "(none)"}`,
        report: "(whole-branch review)",
        diff: whole.stdout,
        ...(request.model ? { model: request.model } : {}),
      },
      request.signal,
    );
    if (final.kind === "verdict") {
      emit({ t: "review.done", task: "branch", round: 0, spec: final.verdict.spec, findings: final.verdict.findings });
      writeSpecFile(join(paths.reviews, "branch.md"), `${final.verdict.summary}\n\n${renderFindings(final.verdict.findings)}\n`);
    } else {
      emit({ t: "review.failed", task: "branch", round: 0, reason: finalFailReason ?? "no verdict" });
    }

    emit({ t: "build.done" });
    return { status: "done" };
  } catch (error) {
    if (error instanceof Stop) {
      emit({ t: "build.stopped", reason: error.reason });
      return { status: "stopped", reason: error.reason };
    }
    throw error;
  }
}
