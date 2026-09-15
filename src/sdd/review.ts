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
  /**
   * Tools offered beside the builtins — the MCP servers' `pure` ones, as
   * `reviewerTools` picks them. Filtered again here: this is the one place
   * the reviewer's registry is built, so it is the place that line holds.
   */
  extraTools?: NodeDef[];
  model?: string;
  maxTurns?: number;
  signal?: AbortSignal;
}

const SEVERITIES: readonly Severity[] = ["critical", "important", "minor"];

export function createVerdictNode(holder: { verdict?: Verdict }): NodeDef<unknown, Verdict> {
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
    // The schema is a hint to the model, not an enforcement mechanism: nothing
    // in the session loop validates a tool call's arguments against it. So a
    // malformed call is parsed here, on the one path a verdict can reach the
    // holder through — throwing leaves the holder untouched, which is what
    // makes a bad call no verdict instead of a trusted one.
    async run(input) {
      const verdict = parseVerdict(input);
      holder.verdict = verdict;
      return verdict;
    },
  };
}

function parseVerdict(input: unknown): Verdict {
  if (typeof input !== "object" || input === null) {
    throw new Error("review_verdict: expected an object");
  }
  const record = input as Record<string, unknown>;

  if (record.spec !== "met" && record.spec !== "not_met") {
    throw new Error(
      `review_verdict: "spec" must be "met" or "not_met", got ${JSON.stringify(record.spec)}`,
    );
  }

  if (!Array.isArray(record.findings)) {
    throw new Error(
      `review_verdict: "findings" must be an array, got ${JSON.stringify(record.findings)}`,
    );
  }
  const findings = record.findings.map((item, index) => parseFinding(item, index));

  if (typeof record.summary !== "string") {
    throw new Error(
      `review_verdict: "summary" must be a string, got ${JSON.stringify(record.summary)}`,
    );
  }

  return { spec: record.spec, findings, summary: record.summary };
}

function parseFinding(item: unknown, index: number): Finding {
  if (typeof item !== "object" || item === null) {
    throw new Error(`review_verdict: findings[${index}] must be an object`);
  }
  const record = item as Record<string, unknown>;

  if (typeof record.severity !== "string" || !SEVERITIES.includes(record.severity as Severity)) {
    throw new Error(
      `review_verdict: findings[${index}].severity must be one of ${SEVERITIES.join(", ")}, got ${JSON.stringify(record.severity)}`,
    );
  }
  if (typeof record.file !== "string") {
    throw new Error(
      `review_verdict: findings[${index}].file must be a string, got ${JSON.stringify(record.file)}`,
    );
  }
  if (typeof record.text !== "string") {
    throw new Error(
      `review_verdict: findings[${index}].text must be a string, got ${JSON.stringify(record.text)}`,
    );
  }
  if (record.line !== undefined && !Number.isInteger(record.line)) {
    throw new Error(
      `review_verdict: findings[${index}].line must be an integer, got ${JSON.stringify(record.line)}`,
    );
  }

  return {
    severity: record.severity as Severity,
    file: record.file,
    text: record.text,
    ...(record.line !== undefined ? { line: record.line as number } : {}),
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
    // The tool has no "addressed" field, so the answer is carried by what
    // is left out: a finding that is not reported again is one the fix
    // addressed. Saying so is what stops a reviewer re-listing every
    // finding it was handed, which reads as none of them fixed.
    lines.push(
      "This is a scoped re-review of a fix. The findings below are what the fix was meant to address. Report only findings that are NOT addressed, plus any new breakage; leave addressed findings out entirely — an empty findings list means all were addressed. Do not re-review the rest of the task.",
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
  for (const node of request.extraTools ?? []) {
    if (node.origin === "mcp" && node.effect === "pure") registry.register(node);
  }
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
