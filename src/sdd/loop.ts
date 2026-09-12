import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Policy } from "../policy/decide";
import type { Provider } from "../providers/types";
import type { Registry } from "../registry/types";
import { project, type Finding, type RecoveryAction, type SpecEvent, type Task, type VerifyStage } from "../spec/project";
import { appendEvent, digestOf, readEvents, readSpecFile, specPaths, writeSpecFile } from "../spec/store";
import { discardBuild, resumeTask, runTask, type BuildResult } from "../work/builder";
import { mergeAll } from "../work/merge";
import { CycleError, schedule } from "../work/schedule";
import { branchExists, branchName, deleteBranch, isMerged, isRegistered, removeWorktree, runGit, worktreePath, type GitRunner } from "../work/worktree";
import { planGoal, splitPlan, writeBriefs, type PlanTask } from "./brief";
import { buildState, inFlightTask, pidAlive, readLockPid } from "./recover";
import { reviewTask, type ReviewOutcome } from "./review";
import { runVerify, VERIFY_CEILING_MS, type VerifyResult } from "./verify";

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
  /** Seam for tests; default runVerify — the task's `verify:` command, run by Vesna itself. */
  verify?: typeof runVerify;
  /** Ceiling for one run of a task's check; default VERIFY_CEILING_MS. */
  verifyTimeoutMs?: number;
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

/**
 * `AbortError` is what `fetch` rejects with; `AbortedError` is what
 * `spawnInterruptible` — and so `runVerify` — throws when the signal kills
 * the child. Both are the same cancel.
 */
function isAbort(error: Error, signal: AbortSignal | undefined): boolean {
  return error.name === "AbortError" || error.name === "AbortedError" || signal?.aborted === true;
}

/**
 * A cancel usually lands inside the worker's model call. The providers hand
 * the signal to `fetch`, which rejects with an AbortError — and `work()`
 * catches everything the session throws, so what reaches the loop is a
 * failed (or refused) result carrying the abort's own text, not the abort.
 * A cancel that lands while the worker is inside a tool call, before it has
 * changed anything, comes back as "no-changes" instead — still the person's
 * doing, not a worker that looked and found nothing to do. The signal says
 * whose doing it was: a result of any of these shapes that arrives after it
 * fired is the interruption, thrown here so it takes the same path an abort
 * from anywhere else does.
 */
function interruptedResult(result: BuildResult, signal: AbortSignal | undefined): void {
  if (
    (result.status === "failed" || result.status === "refused" || result.status === "no-changes") &&
    signal?.aborted === true
  ) {
    throw Object.assign(new Error("interrupted"), { name: "AbortError" });
  }
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
  const verify = request.verify ?? runVerify;
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
  // The approval named the text the person read. A plan edited since — a
  // `verify:` line added or removed, a task reworded — is a plan nobody
  // approved, whatever the log's `approved` flag says. An old log with no
  // digest has nothing to compare and is taken at its word.
  if (tree.digests.plan !== undefined && digestOf(paths.plan) !== tree.digests.plan) {
    return { status: "could-not-start", reason: "plan.md changed after it was approved — approve it again" };
  }

  let planTasks;
  try {
    planTasks = splitPlan(planText);
  } catch (error) {
    return { status: "could-not-start", reason: (error as Error).message };
  }
  if (planTasks.length === 0) return { status: "could-not-start", reason: "plan.md names no tasks" };
  if (tree.tasks.length === 0) return { status: "could-not-start", reason: "the log names no tasks" };

  const lockPath = join(paths.dir, "build.lock");
  const holder = readLockPid(lockPath);
  const state = buildState(tree, holder !== null && pidAlive(holder));
  const inFlight = inFlightTask(tree);

  if (request.recovery === undefined) {
    // Judged before "every task is merged": a process killed during the
    // whole-branch review — the longest step — leaves every task done and
    // the build still open. That is a dead build a person recovers, not a
    // finished spec; refusing it as finished would leave it dead forever.
    if (state === "dead") {
      return {
        status: "could-not-start",
        reason: `a build of "${slug}" was interrupted — /build resume, /build retry <task>, or /build abort`,
      };
    }
    // A finished spec has no work left: running it again would build nothing
    // and then pay for a review of an empty diff, overwriting the real one.
    // But every task merged is a finished spec only when the build finished:
    // a build the branch review stopped, or a red merge-stage check on the
    // last task, has every task done and something left to do — the
    // re-check and the review. That is a finishing build, and a plain start
    // is how a person asks for it once the base is fixed.
    if (tree.tasks.every((task) => task.state === "done")) {
      if (tree.finished) return { status: "could-not-start", reason: "nothing to build — every task is merged" };
      // A log from before bases were recorded has no range to finish over:
      // the fallback to the sha read now (below, for a resume) would hand
      // the review `HEAD...HEAD` — nothing — and write `build.done` over a
      // branch nobody re-read. Refused, with the same words the chat uses.
      if (tree.buildBase === undefined) {
        return { status: "could-not-start", reason: "nothing to finish — this build started before Vesna recorded where builds start" };
      }
    }
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

  if (request.recovery === undefined) {
    // A stop — any reason — keeps the in-flight task's checkout, because
    // it may be the only record of what the worker did. Building that task
    // again would collide on its branch, and the collision's own message
    // names two git commands to run by hand; the way forward the spec gives
    // is `retry`, which discards the checkout itself. Checked only on an
    // idle build: a dead one was refused above, and a running one's lock
    // answers for it below.
    if (state === "idle") {
      for (const task of tree.tasks) {
        if (task.state === "done") continue;
        const checkout = { path: worktreePath(request.root, slug, task.id), branch: branchName(slug, task.id) };
        if ((await isRegistered(request.root, checkout, git)) || (await branchExists(request.root, checkout.branch, git))) {
          return {
            status: "could-not-start",
            reason: `${task.id} has a checkout left by a stopped build — /build retry ${task.id} redoes it`,
          };
        }
      }
    }
  } else {
    const { action } = request.recovery;
    // retry is the one recovery an idle build takes: a stop leaves the
    // failed task's checkout behind, and retry is what removes it. resume
    // has nothing to continue on an idle build, abort nothing to abandon.
    const recoverable = action === "retry" ? state !== "running" : state === "dead";
    if (!recoverable) return { status: "could-not-start", reason: "nothing to recover — no interrupted build" };

    if (action === "resume") {
      // resume has one thing to continue — the task the build left running —
      // and nowhere to put an explicit name that disagrees with it.
      if (request.recovery.task !== undefined && request.recovery.task !== inFlight) {
        return { status: "could-not-start", reason: `only the interrupted task "${inFlight}" can be resumed` };
      }
      // Before writing anything: a checkout that is not actually there — the
      // process died before `git worktree add` ran, or a person removed the
      // directory by hand — is nothing to resume into. Handing `resumeTask`
      // an unverified path would run the worker in a plain directory whose
      // nearest `.git` is the main repository, and its commit would land on
      // the base branch instead of a branch of its own.
      if (inFlight !== undefined) {
        const checkout = { path: worktreePath(request.root, slug, inFlight), branch: branchName(slug, inFlight) };
        if (!(await isRegistered(request.root, checkout, git))) {
          return {
            status: "could-not-start",
            reason: `the checkout of "${inFlight}" is gone — /build retry ${inFlight} or /build abort`,
          };
        }
      }
    }

    if (action === "retry") {
      const target = request.recovery.task;
      if (target === undefined) return { status: "could-not-start", reason: "retry needs a task — /build retry <task>" };
      // A dead build with no task in flight — killed between one task's
      // merge and the next start, or during the whole-branch review — has
      // nothing a retry could redo: resume builds what is left, abort
      // abandons it.
      if (state === "dead" && inFlight === undefined) {
        return {
          status: "could-not-start",
          reason: "nothing is open to retry — /build resume finishes the build, /build abort abandons it",
        };
      }
      const t = tree.tasks.find((x) => x.id === target);
      if (t === undefined) return { status: "could-not-start", reason: `${target} is not a task of this spec` };
      if (t.state === "done") return { status: "could-not-start", reason: `${target} is merged — it cannot be retried` };
      // On a dead build the task is the one left running. Retrying another
      // would discard nothing and then rebuild the in-flight one from
      // scratch, colliding on its kept branch, with a build.recovered in the
      // log naming a task the failure had nothing to do with.
      if (state === "dead" && target !== inFlight) {
        return {
          status: "could-not-start",
          reason: `only the interrupted task "${inFlight}" can be retried while it is in flight — /build retry ${inFlight}`,
        };
      }
    }
  }

  const lock = takeLock(lockPath);
  if (!lock.ok) {
    return { status: "could-not-start", reason: `a build of "${slug}" is already running (pid ${lock.pid})` };
  }

  // Tasks merged in this run — and one the last run merged without living
  // to say so. See `one` below for what the set guards.
  const done = new Set<string>();
  // The in-flight task whose branch git already holds: the process died
  // after the merge and before `task.done`. Its worker is never run again.
  let merged: { id: string; branch: string; head: string } | undefined;

  // A merged task's leftovers. `removeWorktree` deletes the branch itself
  // once the checkout is clean, so one call does both. Guarded on the
  // worktree existing: a seam-based test's fake `build`/`resume` invent a
  // worktree path that is never actually created, and `removeWorktree`
  // resolves it with real `fs.realpath` regardless of the injected `git`
  // seam — calling it on an invented path throws. But a real worktree can
  // also go missing on disk (an operator's `rm -rf`) while git still
  // registers the branch; that case must not walk away leaving the branch
  // behind, so it falls to `deleteBranch`, which touches only refs and
  // never the path.
  const cleanupMerged = async (branch: string, path: string) => {
    if (existsSync(path)) {
      await removeWorktree(request.root, { path, branch }, { discardChanges: true }, git);
    } else {
      await deleteBranch(request.root, branch, git);
    }
  };

  // One run of a task's check, and its record. A timeout is a failure with
  // no code at either stage. After the review a code is `verify.done`
  // whatever it is — a fix round follows a non-zero one. After the merge
  // only zero is done; every other outcome is written by the caller, after
  // `task.done`, in the order the spec fixes — `mergeFailure` is that event.
  const runCheck = async (
    taskId: string,
    command: string,
    stage: VerifyStage,
    cwd: string,
    logName: string,
  ): Promise<VerifyResult> => {
    const r = await verify({
      command,
      cwd,
      logPath: join(paths.verify, logName),
      ...(request.signal ? { signal: request.signal } : {}),
      timeoutMs: request.verifyTimeoutMs ?? VERIFY_CEILING_MS,
    });
    if (r.timedOut) {
      if (stage === "review") emit({ t: "verify.failed", task: taskId, stage, code: null, reason: "timeout" });
    } else if (stage === "review" || r.code === 0) {
      emit({ t: "verify.done", task: taskId, stage, code: r.code!, ms: r.ms });
    }
    return r;
  };
  const mergeFailure = (taskId: string, r: VerifyResult): SpecEvent =>
    r.timedOut
      ? { t: "verify.failed", task: taskId, stage: "merge", code: null, reason: "timeout" }
      : { t: "verify.failed", task: taskId, stage: "merge", code: r.code };
  const mergeFailed = (taskId: string) => new Stop(`${taskId}: verify failed after merge — see verify/${taskId}-merge.log`);

  try {
    if (request.recovery !== undefined) {
      const { action } = request.recovery;
      const target = action === "retry" ? request.recovery.task : inFlight;

      // Before acting on the in-flight task, ask git whether its merge
      // already happened. A kill during the merge-stage check — a `bun
      // test` of up to ten minutes, on every verify-bearing task — leaves
      // the branch merged on the base and the task `running` in the log,
      // and no worker can move that: its "nothing to change" is a merged
      // branch's truth, not a failure. The log did not know yet; recording
      // the merge first, from what git holds, is the honest answer for
      // every recovery — a `retry` of such a task converges to done rather
      // than rebuilding on a base that already holds it. `task.done` goes
      // before `build.recovered` so the reducer, which sends a retried or
      // aborted task back to todo, finds it done and leaves it alone.
      if (target !== undefined && target === inFlight) {
        const branch = branchName(slug, target);
        const base = (await runLoopGit(git, ["rev-parse", "--abbrev-ref", "HEAD"], request.root)).stdout.trim();
        if (await isMerged(request.root, branch, base, git)) {
          const head = (await runLoopGit(git, ["rev-parse", branch], request.root)).stdout.trim();
          merged = { id: target, branch, head };
          done.add(target);
          emit({ t: "task.done", id: target, commit: head });
        }
      }
      emit({ t: "build.recovered", action, ...(target !== undefined ? { task: target } : {}) });

      // Inside the try, alongside the build it recovers, so that a throw
      // from git here — as unlikely as `isRegistered` now makes it — still
      // runs the `finally` below and never leaves the lock held.
      //
      // A merged task's checkout is not discarded: it is a leftover of a
      // merge, removed the way every merge's is — by the recovered task's
      // own pass through `attempt`, or right here on an abort.
      if (action !== "resume" && target !== undefined && merged === undefined) {
        const path = worktreePath(request.root, slug, target);
        const branch = branchName(slug, target);
        const checkout = { path, branch };
        // A checkout that is really there and registered is removed the
        // usual way. Anything else — never created, removed by hand while
        // git still remembers it, or a stray directory nobody registered —
        // is a state, not an error: retry and abort both tolerate it by
        // clearing whatever is at the path themselves and letting
        // `deleteBranch` prune and clear git's own bookkeeping.
        if (request.discard !== undefined) {
          await request.discard(request.root, { task: target, worktree: path, branch } as BuildResult, git);
        } else if (await isRegistered(request.root, checkout, git)) {
          await discardBuild(request.root, { task: target, worktree: path, branch } as BuildResult, git);
        } else {
          await rm(path, { recursive: true, force: true });
          await deleteBranch(request.root, branch, git);
        }
      }

      if (action === "abort") {
        if (merged !== undefined) await cleanupMerged(merged.branch, worktreePath(request.root, slug, merged.id));
        emit({ t: "build.stopped", reason: "abandoned" });
        return { status: "stopped", reason: "abandoned" };
      }
    }

    const briefs = writeBriefs(specsRoot, slug, planTasks);
    const planById = new Map<string, PlanTask>(planTasks.map((t) => [t.id, t]));

    // Neither diff range assumes anything about the repository: the base
    // branch is read rather than guessed to be `main`, and the whole-branch
    // diff at the end (below) runs from the commit the build actually
    // started at rather than a fixed point that presumes a branch name.
    // Both are read before `build.started` is written: the event names the
    // base, and a git failure here is a Stop like any other — the catch
    // below records it, and the lock's `finally` releases it.
    const baseBranch = (await runLoopGit(git, ["rev-parse", "--abbrev-ref", "HEAD"], request.root)).stdout.trim();
    const headSha = (await runLoopGit(git, ["rev-parse", "HEAD"], request.root)).stdout.trim();
    // The range the whole-branch review covers is the build's, not this
    // process's: a resume or a finishing start names the base the first
    // start named — `tree` was read before this start's own event — so the
    // review at the end reads the whole build. A log from before bases were
    // recorded reviews from here, as it always did.
    const buildBase = tree.buildBase ?? headSha;
    emit({ t: "build.started", base: buildBase });

    // A base branch left red: a merge-stage check that failed stopped the
    // build with the task merged, and the next start would otherwise build
    // the remaining tasks on top of it and end "done" over a mark that
    // still says the check never passed. So a plain start re-runs the
    // merge-stage check for every done task whose check was declared and
    // never passed — in task order, on the root, before anything is
    // scheduled — and stops exactly as the merge did if it is still red.
    // A person fixing the base by hand is what turns it green; nothing on
    // it moves here. Recoveries skip this: an in-flight task is what they
    // are about, and a red base has no build to recover.
    if (request.recovery === undefined) {
      for (const task of tree.tasks) {
        if (task.state !== "done" || task.evidence.vesna !== false) continue;
        const command = planById.get(task.id)?.verify;
        if (command === undefined) continue;
        const r = await runCheck(task.id, command, "merge", request.root, `${task.id}-merge.log`);
        if (r.code !== 0) {
          emit(mergeFailure(task.id, r));
          throw mergeFailed(task.id);
        }
      }
    }

    // Whatever ends a task early — a Stop, an interrupt, a plain error from
    // a worker's own commit — the task in flight is recorded as failed
    // before the build is recorded as stopped. Without that the log keeps
    // it "running", with an agent name, forever. An abort is "interrupted"
    // only when it is the person's own signal; an AbortError from anywhere
    // else is an abort nobody asked for, and the log says so.
    //
    // Except after `task.done`: a merged task is done whatever happens next
    // — a check that fails on the base branch, or a cancel that lands while
    // it runs. Writing `task.failed` over that would flip a merged task to
    // failed in the log, and no recovery could move it: retry would find
    // the work already on main. Only the build stops.
    const one = async (task: Task): Promise<BuildResult> => {
      try {
        return await attempt(task);
      } catch (error) {
        const err = error as Error;
        if (done.has(task.id)) throw error;
        const reason = err instanceof Stop
          ? err.reason.replace(new RegExp(`^${task.id}: `), "")
          : isAbort(err, request.signal)
            ? (request.signal?.aborted ? "interrupted" : "aborted")
            : err.message;
        emit({ t: "task.failed", id: task.id, reason });
        throw error;
      }
    };

    const attempt = async (task: Task): Promise<BuildResult> => {
      const brief = readSpecFile(briefs[task.id] ?? "") ?? task.title;
      // The plan's `verify:` line, if any. Declared before the task starts:
      // the log commits Vesna to running the check before anything the
      // worker does could make skipping it convenient.
      const check = planById.get(task.id)?.verify;
      if (merged?.id !== task.id) {
        if (check !== undefined) emit({ t: "verify.declared", task: task.id });
        emit({ t: "task.started", id: task.id, agent: "vesna build" });
      }

      // This task's check, at either stage.
      const checkAt = (stage: VerifyStage, cwd: string, logName: string) => runCheck(task.id, check!, stage, cwd, logName);

      // Everything after a merge. Merged is merged: the --no-ff commit on
      // the base branch carries the task's history, and its worktree and
      // branch are leftovers. A stopped task keeps both, because a person
      // may want to look — except the stop below, after a merge, which has
      // nothing to look at in the checkout: the merged tree is what failed.
      const settle = async (result: BuildResult): Promise<BuildResult> => {
        const cleanup = () => cleanupMerged(result.branch, result.worktree);
        // Already written for the task a killed run merged; see `merged`.
        const taskDone = () => {
          if (done.has(task.id)) return;
          done.add(task.id);
          emit({ t: "task.done", id: task.id, ...(result.commit ? { commit: result.commit } : {}) });
        };

        if (check === undefined) {
          taskDone();
        } else {
          // The check again, on the base branch this time: what passed in
          // the checkout may not pass merged. `task.done` is written either
          // way — the merge happened, and the log says what happened — and on
          // a failure it comes first, then the failure, then the stop. Nothing
          // on the base branch moves without a person.
          let r: VerifyResult;
          try {
            r = await checkAt("merge", request.root, `${task.id}-merge.log`);
          } catch (error) {
            // A cancel (or anything else) landing inside the check does not
            // unmerge: the task is done, its leftovers go as after any
            // merge, and the check itself proved nothing — no verify event.
            taskDone();
            await cleanup();
            throw error;
          }
          taskDone();
          if (r.code !== 0) {
            emit(mergeFailure(task.id, r));
            await cleanup();
            throw mergeFailed(task.id);
          }
        }

        await cleanup();
        return result;
      };

      // The task the last run merged and died over: `task.done` is already
      // written (above, before `build.recovered`), the killed run declared
      // the check and started the task, and the worker and reviewer have
      // both spoken. What is left is what would have followed the merge —
      // the check on the base branch, and the cleanup.
      if (merged?.id === task.id) {
        return settle({
          task: task.id, status: "committed", branch: merged.branch,
          worktree: worktreePath(request.root, slug, task.id), commit: merged.head,
          refusals: [], costUsd: 0, text: "",
        });
      }

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

      const resuming = request.recovery?.action === "resume" && inFlight === task.id;
      let result = resuming
        ? await resume({
            ...common,
            worktree: { path: worktreePath(request.root, slug, task.id), branch: branchName(slug, task.id) },
            message: brief,
          })
        : await build({ ...common, spec: slug, objective: brief });
      let report = `# ${task.id}\n\n${result.text}\n`;
      writeSpecFile(join(paths.reports, `${task.id}.md`), report);
      interruptedResult(result, request.signal);

      if (result.status === "refused") {
        throw new Stop(`${task.id}: the worker was not allowed to: ${result.refusals.join("; ")}`);
      }
      if (result.status === "failed") throw new Stop(`${task.id}: ${result.error ?? "the build failed"}`);
      if (result.status === "no-changes") {
        // On a resume, "changed nothing" is measured against the base the
        // branch was cut from, not the head the resume started at: a
        // process killed during the task's own review left the whole commit
        // on the branch, and a worker that looks and leaves it alone has
        // answered correctly. A branch ahead of base goes to review with
        // the commit it holds; one at base is a worker that changed nothing.
        const ahead = resuming
          ? Number((await runLoopGit(git, ["rev-list", "--count", `${baseBranch}..${result.branch}`], request.root)).stdout.trim()) > 0
          : false;
        if (!ahead) throw new Stop(`${task.id}: the worker changed nothing`);
        const head = (await runLoopGit(git, ["rev-parse", result.branch], request.root)).stdout.trim();
        result = { ...result, status: "committed", commit: head };
      }

      let round = 0;
      let silent = 0;
      let attempt = 0;
      let open: Finding[] | undefined;
      // Whether `open` is the check's finding rather than the reviewer's.
      // The reviewer never runs the command, so it cannot judge whether a
      // failed check was addressed: the review after a verify failure is
      // a fresh one, not a scoped re-review of that finding.
      let openIsVerify = false;
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
            ...(open !== undefined && !openIsVerify ? { findings: open } : {}),
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
        openIsVerify = false;
        // The reviewer is satisfied on one of two paths: nothing open, or
        // the cap reached with only Important findings, which are parked.
        let satisfied = verdict.spec === "met" && open.length === 0;
        if (!satisfied && round >= maxRounds) {
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
          satisfied = true;
        }

        if (satisfied) {
          if (check === undefined) break;
          // Now the third witness, on every path that leads to the merge.
          // Run in the task's own checkout, on the same fix-round counter
          // as the review: a check that fails is one more finding for the
          // worker, with the command and the output's tail, and a check
          // still failing at the cap stops the build like a brief still
          // not met.
          const r = await checkAt("review", result.worktree, `${task.id}-review-r${round}.log`);
          if (r.code === 0) break;
          open = [{
            severity: "important",
            file: "verify",
            text: `verify failed: \`${check}\` ${r.timedOut ? "timed out" : `exited ${r.code}`}\n${r.tail}`,
          }];
          openIsVerify = true;
          if (round >= maxRounds) throw new Stop(`${task.id}: verify still fails after ${maxRounds} fix rounds`);
        }

        round += 1;
        const message = [
          `Review round ${round} found the following. Fix each, re-run the tests that cover it, and say what you changed.`,
          "",
          verdict.spec === "not_met" ? "The reviewer judged the brief NOT MET." : "",
          renderFindings(open),
        ].join("\n");
        const resumed = await resume({ ...common, worktree: { path: result.worktree, branch: result.branch }, message });
        interruptedResult(resumed, request.signal);
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

      const outcome = await merge(request.root, [{ task: task.id, branch: result.branch }], git);
      if (outcome.conflict) throw new Stop(`${task.id}: merge conflict in ${outcome.conflict.files.join(", ")}`);
      if (outcome.error) throw new Stop(`${task.id}: ${outcome.error.message}`);

      return settle(result);
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
    const whole = await runLoopGit(git, ["diff", `${buildBase}...HEAD`], request.root);
    const parked = project(readEvents(specsRoot, slug))?.parked ?? [];
    // A slug is a filename, not a requirement: a reviewer briefed on nothing
    // else infers what the branch was supposed to do from it, and two specs
    // whose slugs read differently but whose plans ask the same thing get
    // judged differently. The title and the plan's own goal are what the
    // person actually asked for.
    const goal = planGoal(planText);
    const branchRequest = {
      cwd: request.root,
      provider: request.provider,
      brief: `The whole branch for "${tree.title}" (spec ${slug}).${goal ? ` Goal: ${goal}.` : ""} Parked findings from the task reviews:\n${renderFindings(parked.map((p) => p.finding)) || "(none)"}`,
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
