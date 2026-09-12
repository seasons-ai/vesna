import type { RecoveryAction, SpecEvent } from "../spec/project";
import { specsRoot } from "../spec/store";
import { runBuild, type BuildLoopRequest, type BuildOutcome, renderFindings } from "../sdd/loop";
import type { Policy } from "../policy/decide";
import type { Provider } from "../providers/types";
import type { Registry } from "../registry/types";
import type { Theme } from "../tui/theme";
import { EXIT } from "./exit";

/**
 * The loop from the shell. Prints each event as it happens and exits with
 * what happened: done, stopped for a person, or never started. This is the
 * surface a later client calls once someone has approved the plan from
 * wherever they are.
 */
export function exitFor(outcome: BuildOutcome): 0 | 1 | 2 {
  if (outcome.status === "done") return EXIT.ok;
  if (outcome.status === "stopped") return EXIT.held;
  return EXIT.error;
}

export function describeEvent(event: SpecEvent): string | null {
  switch (event.t) {
    case "build.started":
      return "building";
    case "task.started":
      return `${event.id}  building`;
    case "review.done": {
      const n = event.findings.length;
      const where = event.round === 0 ? "review" : `review round ${event.round}`;
      return `${event.task}  ${where}: ${event.spec === "met" ? "met" : "not met"}, ${n} finding${n === 1 ? "" : "s"}`;
    }
    case "review.failed":
      return `${event.task}  review: no verdict`;
    case "task.done":
      return `${event.id}  merged${event.commit ? ` ${event.commit.slice(0, 7)}` : ""}`;
    case "task.failed":
      return `${event.id}  failed${event.reason ? `: ${event.reason}` : ""}`;
    case "parked":
      return `${event.task}  parked: ${renderFindings([event.finding]).slice(2)}`;
    case "ruling":
      return `ruling: ${event.text}`;
    case "build.stopped":
      return `stopped: ${event.reason}`;
    case "build.done":
      return "done";
    default:
      return null;
  }
}

/**
 * The shell's spelling of the chat's `/build resume|retry <task>|abort` —
 * one flag at a time, mirroring the recovery the loop itself accepts.
 */
export function recoveryFromFlags(
  flags: Record<string, string>,
): { recovery?: { action: RecoveryAction; task?: string }; error?: string } {
  const set = (["resume", "retry", "abort"] as const).filter((f) => flags[f] !== undefined);
  if (set.length === 0) return {};
  if (set.length > 1) return { error: "one of --resume, --retry <task>, --abort — not two" };
  const action = set[0]!;
  if (action === "retry") {
    const task = flags.retry;
    if (task === undefined || task === "true") return { error: "--retry needs a task: --retry T2" };
    return { recovery: { action, task } };
  }
  return { recovery: { action } };
}

export async function buildCommand(
  slug: string | undefined,
  root: string,
  deps: {
    provider: Provider;
    registry: Registry;
    policy: Policy;
    theme: Theme;
    permit?: (type: string) => boolean;
    notes?: string;
    model?: string;
    /** Seams for tests, the same ones `runBuild` takes. */
    seams?: Pick<BuildLoopRequest, "build" | "resume" | "review" | "merge" | "git">;
  },
  flags: Record<string, string> = {},
): Promise<number> {
  if (slug === undefined || slug === "") {
    console.error("vesna: build needs a spec — vesna build <slug>");
    return EXIT.error;
  }

  const parsed = recoveryFromFlags(flags);
  if (parsed.error !== undefined) {
    console.error(`vesna: ${parsed.error}`);
    return EXIT.error;
  }

  // ctrl-c reaches the build as its own signal, so the log ends with
  // `build.stopped "interrupted"` and the task in flight is marked failed.
  // Killing the process instead leaves `building` true with nothing left to
  // ever clear it. The handler lives only as long as the build: after it,
  // ctrl-c ends the process the ordinary way again.
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);
  let outcome: BuildOutcome;
  try {
    outcome = await runBuild({
      root,
      specsRoot: specsRoot(root),
      slug,
      provider: deps.provider,
      registry: deps.registry,
      policy: deps.policy,
      ...(deps.permit ? { permit: deps.permit } : {}),
      ...(deps.notes !== undefined ? { notes: deps.notes } : {}),
      ...(deps.model ? { model: deps.model } : {}),
      ...(parsed.recovery ? { recovery: parsed.recovery } : {}),
      signal: controller.signal,
      ...deps.seams,
      onEvent: (event) => {
        const line = describeEvent(event);
        if (line !== null) console.log(`  ${deps.theme.paint("petal", "·")} ${line}`);
      },
    });
  } finally {
    process.off("SIGINT", onSigint);
  }
  if (outcome.status !== "done") {
    console.error(`vesna: ${outcome.reason}`);
    // The loop's refusals name the chat's words — "/build resume", "/build
    // retry T2" — wherever they come from. A shell user gets the flags
    // under any of them, not only the first one that was written.
    if (outcome.status === "could-not-start" && outcome.reason.includes("/build ")) {
      console.error(`  from the shell: vesna build ${slug} --resume | --retry <task> | --abort`);
    }
  }
  return exitFor(outcome);
}
