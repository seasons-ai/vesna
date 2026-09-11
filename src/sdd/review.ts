import { createSession } from "../loop/session";
import { globNode, grepNode, readNode, shellNode } from "../nodes/index";
import { isReadOnlyCommand } from "../policy/readonly";
import type { Provider } from "../providers/types";
import { createRegistry } from "../registry/registry";
import type { NodeDef } from "../registry/types";
import type { Finding, Severity } from "../spec/project";

/**
 * A review is a verdict, not an opinion.
 *
 * The reviewer is a fresh session that may read and may not write, and it
 * must answer by calling `review_verdict`. Prose that never calls it is not a
 * review: the loop cannot act on "looks fine to me", and a reviewer that gets
 * to phrase its own result is the thing being checked deciding what checking
 * means. `task_verify` holds that line for the worker; this holds it for the
 * reviewer.
 */
export interface Verdict {
  spec: "met" | "not_met";
  findings: Finding[];
  summary: string;
}

export type ReviewOutcome =
  | { kind: "verdict"; verdict: Verdict; costUsd: number }
  | { kind: "no-verdict"; text: string; costUsd: number };

export interface ReviewRequest {
  cwd: string;
  provider: Provider;
  brief: string;
  report: string;
  diff: string;
  /** For a scoped re-review: the findings the fix was meant to address. */
  findings?: Finding[];
  model?: string;
  maxTurns?: number;
  signal?: AbortSignal;
}

const SEVERITIES: readonly Severity[] = ["critical", "important", "minor"];

export function createVerdictNode(holder: { verdict?: Verdict }): NodeDef<Verdict, Verdict> {
  return {
    type: "review_verdict",
    description:
      "Deliver your review. This is the only way to finish one: spec is met or not_met, findings each with a severity (critical: wrong or unsafe; important: must fix before merge; minor: worth noting), a file, a line when you have one, and what is wrong. A review without this call did not happen.",
    inputSchema: {
      type: "object",
      properties: {
        spec: { type: "string", enum: ["met", "not_met"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: [...SEVERITIES] },
              file: { type: "string" },
              line: { type: "integer" },
              text: { type: "string" },
            },
            required: ["severity", "file", "text"],
          },
        },
        summary: { type: "string" },
      },
      required: ["spec", "findings", "summary"],
    },
    effect: "pure",
    async run(input) {
      holder.verdict = input;
      return input;
    },
  };
}

export function reviewPrompt(request: ReviewRequest): string {
  const lines = [
    "You are reviewing one task in a repository. You may read files and run read-only commands. You cannot change anything.",
    "",
    "Answer by calling `review_verdict` exactly once. A review that does not call it is treated as a failed review, not a pass.",
    "",
    "Judge two things. Spec compliance: does the diff do what the brief asks, with the exact values it names, and nothing extra? Task quality: correctness, tests that would actually fail against broken code, duplication, error paths that swallow information, names that mislead.",
    "",
  ];
  if (request.findings !== undefined) {
    lines.push(
      "This is a scoped re-review of a fix. For each finding below, decide whether it is ADDRESSED or NOT ADDRESSED in the diff, and report new breakage the fix introduced. Do not re-review the rest of the task.",
      "",
      ...request.findings.map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} — ${f.text}`),
      "",
    );
  }
  lines.push(
    "## The brief",
    "",
    request.brief,
    "",
    "## The worker's report",
    "",
    request.report,
    "",
    "## The diff",
    "",
    "```diff",
    request.diff,
    "```",
  );
  return lines.join("\n");
}

export async function reviewTask(request: ReviewRequest): Promise<ReviewOutcome> {
  // Its own registry, so the reviewer is never offered a way to write.
  const registry = createRegistry();
  registry.register(readNode);
  registry.register(grepNode);
  registry.register(globNode);
  registry.register(shellNode);
  const holder: { verdict?: Verdict } = {};
  registry.register(createVerdictNode(holder));

  const session = createSession(request.provider, registry, {
    cwd: request.cwd,
    ...(request.model ? { model: request.model } : {}),
    maxTurns: request.maxTurns ?? 12,
    ...(request.signal ? { signal: request.signal } : {}),
    async approve(action) {
      if (action.node === "shell") {
        const command = typeof action.input.command === "string" ? action.input.command : "";
        return isReadOnlyCommand(command) ? "allow" : "deny";
      }
      return "allow";
    },
  });

  const result = await session.send(reviewPrompt(request));

  if (holder.verdict === undefined) {
    return { kind: "no-verdict", text: result.text, costUsd: session.costUsd };
  }
  return { kind: "verdict", verdict: holder.verdict, costUsd: session.costUsd };
}
