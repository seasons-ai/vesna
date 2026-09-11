import type { SpecEvent } from "../spec/project";
import { specsRoot } from "../spec/store";
import { runBuild, type BuildOutcome, renderFindings } from "../sdd/loop";
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
  },
): Promise<number> {
  if (slug === undefined || slug === "") {
    console.error("vesna: build needs a spec — vesna build <slug>");
    return EXIT.error;
  }
  const outcome = await runBuild({
    root,
    specsRoot: specsRoot(root),
    slug,
    provider: deps.provider,
    registry: deps.registry,
    policy: deps.policy,
    ...(deps.permit ? { permit: deps.permit } : {}),
    ...(deps.notes !== undefined ? { notes: deps.notes } : {}),
    ...(deps.model ? { model: deps.model } : {}),
    onEvent: (event) => {
      const line = describeEvent(event);
      if (line !== null) console.log(`  ${deps.theme.paint("petal", "·")} ${line}`);
    },
  });
  if (outcome.status !== "done") console.error(`vesna: ${outcome.reason}`);
  return exitFor(outcome);
}
