import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Policy } from "../policy/decide";
import type { Provider } from "../providers/types";
import type { Registry } from "../registry/types";
import { project, type Finding, type RecoveryAction, type SpecEvent, type Task } from "../spec/project";
import { appendEvent, readEvents, readSpecFile, specPaths, writeSpecFile } from "../spec/store";
import { discardBuild, resumeTask, runTask, type BuildResult } from "../work/builder";
import { mergeAll } from "../work/merge";
import { CycleError, schedule } from "../work/schedule";
import { branchName, deleteBranch, removeWorktree, runGit, worktreesRoot, type GitRunner } from "../work/worktree";
import { splitPlan, writeBriefs } from "./brief";
import { buildState, inFlightTask, pidAlive, readLockPid } from "./recover";
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
  /** Which node types the project lets a worker have; see BuildRequest. */
  permit?: (type: string) => boolean;
  /** The project's own instructions, handed to every worker. */
  notes?: string;
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
  /** How to treat a build a killed process left behind. Absent means: refuse if there is one. */
  recovery?: { action: RecoveryAction; task?: string };
  /** Seam for tests; default discardBuild. */
  discard?: typeof discardBuild;
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

/**
 * One build per spec at a time. Two would race on the same branches, the
 * same worktrees and the same log, and the loser would not know it lost.
 * The lock names the process holding it, so a refusal can say who; a lock
 * whose process is gone is a crash's leftover, not a build, and is taken over.
 */
function takeLock(path: string): { ok: true } | { ok: false; pid: number } {
  const pid = readLockPid(path);
  if (pid !== null && pidAlive(pid)) return { ok: false, pid };
  if (pid !== null || existsSync(path)) releaseLock(path);
  try {
    // wx: create, never overwrite — so two takers racing past the check
    // above cannot both believe they hold it.
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
  } catch {
    return { ok: false, pid: NaN };
  }
  return { ok: true };
}

function releaseLock(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone is the state we wanted.
  }
}

/** Where a task's own checkout lives — confirmed against `createWorktree`. */
function worktreePathFor(root: string, spec: string, task: string): string {
  return join(worktreesRoot(root), `${spec}-${task}`);
}

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

/**
 * A git call the loop itself issues — not one buried inside `runTask`,
 * `mergeAll`, or their worktree helpers, which answer for their own
 * failures. A non-zero exit here means the repository is in a state the loop
 * cannot reason about: reading `""` as a branch name or a commit and
 * pressing on would hand the reviewer an empty diff and record its verdict
 * as if it meant something.
 */
async function runLoopGit(
  git: GitRunner,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await git(args, cwd);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n")[0] || "unknown git error";
    throw new Stop(`git ${args[0]} failed: ${detail}`);
  }
  return result;
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
  // A finished spec has no work left: running it again would build nothing
  // and then pay for a review of an empty diff, overwriting the real one.
  if (tree.tasks.every((task) => task.state === "done")) {
    return { status: "could-not-start", reason: "nothing to build — every task is merged" };
  }

  // A task the log knows and the plan does not — or the reverse — is not a
  // task that can be built: the worker would read no brief at all, or build
  // something the log never agreed to run. Caught here, before anything
  // starts, rather than as a one-line title standing in for a brief.
  const planIds = new Set(planTasks.map((t) => t.id));
  const logIds = new Set(tree.tasks.map((t) => t.id));
  for (const id of logIds) {
    if (!planIds.has(id)) return { status: "could-not-start", reason: `${id} is in the log but not in plan.md` };
  }
  for (const id of planIds) {
    if (!logIds.has(id)) return { status: "could-not-start", reason: `${id} is in plan.md but not in the log` };
  }

  const lockPath = join(paths.dir, "build.lock");
  const holder = readLockPid(lockPath);
  const state = buildState(tree, holder !== null && pidAlive(holder));
  const discard = request.discard ?? discardBuild;

  if (request.recovery === undefined) {
    if (state === "dead") {
      return {
        status: "could-not-start",
        reason: `a build of "${slug}" was interrupted — /build resume, /build retry <task>, or /build abort`,
      };
    }
  } else {
    if (state !== "dead") return { status: "could-not-start", reason: "nothing to recover — no interrupted build" };
    const running = inFlightTask(tree);
    const { action } = request.recovery;
    const target = action === "retry" ? request.recovery.task : running;
    if (action === "retry") {
      if (target === undefined) return { status: "could-not-start", reason: "retry needs a task — /build retry <task>" };
      const t = tree.tasks.find((x) => x.id === target);
      if (t === undefined) return { status: "could-not-start", reason: `${target} is not a task of this spec` };
      if (t.state === "done") return { status: "could-not-start", reason: `${target} is merged — it cannot be retried` };
    }
    emit({ t: "build.recovered", action, ...(target !== undefined ? { task: target } : {}) });
    if (action !== "resume" && target !== undefined) {
      await discard(
        request.root,
        {
          task: target,
          worktree: worktreePathFor(request.root, slug, target),
          branch: branchName(slug, target),
        } as BuildResult,
        git,
      );
    }
    if (action === "abort") {
      releaseLock(lockPath);
      emit({ t: "build.stopped", reason: "abandoned" });
      return { status: "stopped", reason: "abandoned" };
    }
  }

  const lock = takeLock(lockPath);
  if (!lock.ok) {
    return { status: "could-not-start", reason: `a build of "${slug}" is already running (pid ${lock.pid})` };
  }

  try {
    // Inside the try so a failure here — a briefs path that is a file, say —
    // still releases the lock in `finally` rather than leaving this
    // process's own pid holding the spec.
    const briefs = writeBriefs(specsRoot, slug, planTasks);
    emit({ t: "build.started" });

    // Neither diff range assumes anything about the repository: the base
    // branch is read rather than guessed to be `main`, and the whole-branch
    // diff at the end (below) runs from the commit the build actually
    // started at rather than a fixed point that presumes a branch name.
    const baseBranch = (await runLoopGit(git, ["rev-parse", "--abbrev-ref", "HEAD"], request.root)).stdout.trim();
    const startSha = (await runLoopGit(git, ["rev-parse", "HEAD"], request.root)).stdout.trim();

    // Whatever ends a task early — a Stop, an interrupt, a plain error from
    // a worker's own commit — the task in flight is recorded as failed
    // before the build is recorded as stopped. Without that the log keeps
    // it "running", with an agent name, forever. An abort is "interrupted"
    // only when it is the person's own signal; an AbortError from anywhere
    // else is an abort nobody asked for, and the log says so.
    const one = async (task: Task): Promise<BuildResult> => {
      try {
        return await attempt(task);
      } catch (error) {
        const err = error as Error;
        const reason = err instanceof Stop
          ? err.reason.replace(new RegExp(`^${task.id}: `), "")
          : isAbort(err, request.signal)
            ? (request.signal?.aborted ? "interrupted" : "aborted")
            : err.message;
        emit({ t: "task.failed", id: task.id, reason });
        throw error;
      }
    };

    const inFlight = inFlightTask(tree);

    const attempt = async (task: Task): Promise<BuildResult> => {
      const brief = readSpecFile(briefs[task.id] ?? "") ?? task.title;
      emit({ t: "task.started", id: task.id, agent: "vesna build" });

      const common = {
        repo: request.root,
        task: task.id,
        provider: request.provider,
        registry: request.registry,
        policy: request.policy,
        ...(request.permit ? { permit: request.permit } : {}),
        ...(request.notes !== undefined ? { notes: request.notes } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.maxUsd !== undefined ? { maxUsd: request.maxUsd } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        git,
      };

      const resuming = request.recovery?.action === "resume" && request.recovery.task === undefined
        ? inFlight === task.id
        : request.recovery?.action === "resume" && request.recovery.task === task.id;
      let result = resuming
        ? await resume({
            ...common,
            worktree: { path: worktreePathFor(request.root, slug, task.id), branch: branchName(slug, task.id) },
            message: brief,
          })
        : await build({ ...common, spec: slug, objective: brief });
      let report = `# ${task.id}\n\n${result.text}\n`;
      writeSpecFile(join(paths.reports, `${task.id}.md`), report);

      if (result.status === "refused") {
        throw new Stop(`${task.id}: the worker was not allowed to: ${result.refusals.join("; ")}`);
      }
      if (result.status === "failed") throw new Stop(`${task.id}: ${result.error ?? "the build failed"}`);
      if (result.status === "no-changes") throw new Stop(`${task.id}: the worker changed nothing`);

      let round = 0;
      let silent = 0;
      let attempt = 0;
      let open: Finding[] | undefined;
      for (;;) {
        const diff = await runLoopGit(git, ["diff", `${baseBranch}...${result.branch}`], request.root);

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
          attempt += 1;
          emit({ t: "review.failed", task: task.id, round, reason: failReason ?? "no verdict" });
          // Suffixed by attempt: a silent retry at the same round must not
          // overwrite the last silent attempt's record.
          writeSpecFile(
            join(paths.reviews, `${task.id}-r${round}-attempt${attempt}.md`),
            `(no verdict)\n\n${outcome.text}\n`,
          );
          if (silent >= 2) throw new Stop(`${task.id}: the reviewer produced no verdict twice`);
          continue;
        }
        silent = 0;
        attempt = 0;
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
          // Five rounds that never got the brief to "met" is not one more
          // Important finding to park — it is the task not doing what was
          // asked, and that stops the build exactly like a Critical would.
          if (verdict.spec === "not_met") {
            throw new Stop(`${task.id}: the brief is still not met after ${maxRounds} fix rounds`);
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
        const resumed = await resume({ ...common, worktree: { path: result.worktree, branch: result.branch }, message });
        // A refusal is neither a fix nor "no changes": the worker was
        // stopped short, and whatever it did before that is partial. The
        // first round stops on it; a fix round must too, or the partial
        // work is reviewed and merged as if it were the fix.
        if (resumed.status === "refused") {
          report += `\n## Fix round ${round} (refused)\n\n${resumed.text}\n`;
          writeSpecFile(join(paths.reports, `${task.id}.md`), report);
          throw new Stop(
            `${task.id}: fix round ${round}: the worker was not allowed to: ${resumed.refusals.join("; ")}`,
          );
        }
        if (resumed.status === "no-changes") {
          // The worker looked and made no change — a valid answer to "fix
          // this", distinct from having fixed it. `result` (and the commit
          // the branch actually holds) is left exactly as it was.
          report += `\n## Fix round ${round} (no changes)\n\n${resumed.text}\n`;
          writeSpecFile(join(paths.reports, `${task.id}.md`), report);
        } else {
          result = resumed;
          report += `\n## Fix round ${round}\n\n${result.text}\n`;
          writeSpecFile(join(paths.reports, `${task.id}.md`), report);
          if (result.status === "failed") throw new Stop(`${task.id}: fix round ${round} failed — ${result.error}`);
        }
      }

      const merged = await merge(request.root, [{ task: task.id, branch: result.branch }], git);
      if (merged.conflict) throw new Stop(`${task.id}: merge conflict in ${merged.conflict.files.join(", ")}`);
      if (merged.error) throw new Stop(`${task.id}: ${merged.error.message}`);

      emit({ t: "task.done", id: task.id, ...(result.commit ? { commit: result.commit } : {}) });

      // Merged is merged: the --no-ff commit on the base branch carries the
      // task's history, and its worktree and branch are leftovers. A stopped
      // task keeps both, because a person may want to look. `removeWorktree`
      // deletes the branch itself once the checkout is clean, so one call
      // does both. Guarded on the worktree existing: a seam-based test's
      // fake `build`/`resume` invent a worktree path that is never actually
      // created, and `removeWorktree` resolves it with real `fs.realpath`
      // regardless of the injected `git` seam — calling it on an invented
      // path throws. But a real worktree can also go missing on disk (an
      // operator's `rm -rf`) while git still registers the branch; that
      // case must not walk away leaving the branch behind, so it falls to
      // `deleteBranch`, which touches only refs and never the path.
      if (existsSync(result.worktree)) {
        await removeWorktree(request.root, { path: result.worktree, branch: result.branch }, { discardChanges: true }, git);
      } else {
        await deleteBranch(request.root, result.branch, git);
      }

      return result;
    };

    const scheduled = await schedule<BuildResult>({
      tasks: tree.tasks,
      concurrency: 1,
      run: one,
      succeeded: () => true,
      ...(request.signal ? { signal: request.signal } : {}),
    });

    // An interrupt, whether it landed before the first task or partway
    // through, ends the build here — never at "done", which would say
    // everything the plan asked for actually happened.
    if (request.signal?.aborted) {
      emit({ t: "build.stopped", reason: "interrupted" });
      return { status: "stopped", reason: "interrupted" };
    }
    // A task the scheduler never ran (a missing dependency, one whose
    // dependency failed) is not a build that finished; the log must not say
    // "done" over work that was silently never attempted.
    if (scheduled.skipped.length > 0) {
      throw new Stop(scheduled.skipped.map((s) => `${s.id}: skipped — ${s.reason}`).join("; "));
    }

    // One more pair of eyes over the whole branch, with the parked findings
    // beside it. This one is a gate, not a note: "done" over a review that
    // said the branch does not meet its brief would be the panel lying at
    // the end of the process it exists to make honest. Not met or a
    // critical stops the build for a person; important and minor are parked
    // on the branch where the person will read them; no verdict gets one
    // retry, as a task review does.
    const whole = await runLoopGit(git, ["diff", `${startSha}...HEAD`], request.root);
    const parked = project(readEvents(specsRoot, slug))?.parked ?? [];
    const branchRequest = {
      cwd: request.root,
      provider: request.provider,
      brief: `The whole branch for spec "${slug}". Parked findings from the task reviews:\n${renderFindings(parked.map((p) => p.finding)) || "(none)"}`,
      report: "(whole-branch review)",
      diff: whole.stdout,
      ...(request.model ? { model: request.model } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    };
    let final: Extract<ReviewOutcome, { kind: "verdict" }> | undefined;
    for (let attempt = 0; attempt < 2 && final === undefined; attempt += 1) {
      const { outcome, failReason } = await safeReview(review, branchRequest, request.signal);
      if (outcome.kind === "verdict") {
        final = outcome;
        break;
      }
      emit({ t: "review.failed", task: "branch", round: attempt, reason: failReason ?? "no verdict" });
      writeSpecFile(join(paths.reviews, `branch-attempt${attempt}.md`), `(no verdict)\n\n${outcome.text}\n`);
    }
    if (final === undefined) throw new Stop("branch review: the reviewer produced no verdict twice");

    const { verdict } = final;
    emit({ t: "review.done", task: "branch", round: 0, spec: verdict.spec, findings: verdict.findings });
    writeSpecFile(join(paths.reviews, "branch.md"), `spec: ${verdict.spec}\n\n${verdict.summary}\n\n${renderFindings(verdict.findings)}\n`);

    if (verdict.spec === "not_met") {
      throw new Stop(`branch review: the brief is not met${verdict.summary ? ` — ${verdict.summary}` : ""}`);
    }
    const critical = verdict.findings.find((f: Finding) => f.severity === "critical");
    if (critical !== undefined) {
      const where = `${critical.file}${critical.line !== undefined ? `:${critical.line}` : ""}`;
      throw new Stop(`branch review: a critical finding — ${where} ${critical.text}`);
    }
    for (const finding of verdict.findings) emit({ t: "parked", task: "branch", finding });

    emit({ t: "build.done" });
    return { status: "done" };
  } catch (error) {
    if (error instanceof Stop) {
      emit({ t: "build.stopped", reason: error.reason });
      return { status: "stopped", reason: error.reason };
    }
    if (error instanceof CycleError) {
      emit({ t: "build.stopped", reason: error.message });
      return { status: "stopped", reason: error.message };
    }
    // An interrupt that lands while a task is in flight surfaces here as
    // the task's own abort error rather than through the check above. It
    // is the person's doing, and the log has to say so — otherwise the
    // build that ctrl-c ended leaves `building` true with nothing left to
    // clear it. An abort nobody asked for still propagates.
    if (request.signal?.aborted && isAbort(error as Error, request.signal)) {
      emit({ t: "build.stopped", reason: "interrupted" });
      return { status: "stopped", reason: "interrupted" };
    }
    throw error;
  } finally {
    releaseLock(lockPath);
  }
}
