/**
 * A build in a process of its own, for the tests that kill one outright.
 *
 * A seam cannot reproduce a SIGKILL: the loop's `finally` still runs, the
 * lock is released, and the log is written to the end. Only a process that
 * is really gone leaves what a closed terminal or an OOM leaves — a lock
 * naming a dead pid and a log that stops mid-task. `bun tests/fixtures/
 * build-child.ts <root>` runs one build of the spec "work" in `<root>` with
 * a worker that writes the file its brief names, and prints the outcome.
 * With `--command` it goes through `buildCommand` instead — the shell's
 * entry, signal handlers included — and exits with its code.
 */
import { join } from "node:path";
import { buildCommand } from "../../src/cli/buildcmd";
import { runBuild } from "../../src/sdd/loop";
import { resolveTheme } from "../../src/tui/theme";
import { createRegistry } from "../../src/registry/registry";
import { writeNode } from "../../src/nodes/write";
import { readNode } from "../../src/nodes/read";
import type { CompletionResult, Provider } from "../../src/providers/types";

/** Writes the file the brief asks for (`Write <name>.`), then answers. */
export function writesWhatTheBriefNames(): Provider {
  let turn = 0;
  return {
    id: "fake",
    async complete(request): Promise<CompletionResult> {
      turn += 1;
      const named = /Write (\S+)\./.exec(JSON.stringify(request.messages))?.[1];
      const content =
        turn === 1 && named !== undefined
          ? [{ type: "tool_call" as const, id: "c1", name: "write", input: { path: named, text: `${named}\n` } }]
          : [{ type: "text" as const, text: "done" }];
      return {
        content,
        stopReason: "end_turn",
        model: "m",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

if (import.meta.main) {
  const root = process.argv[2];
  if (root === undefined) {
    console.error("usage: bun tests/fixtures/build-child.ts <root>");
    process.exit(2);
  }
  const registry = createRegistry();
  registry.register(writeNode);
  registry.register(readNode);
  const review = async () => ({ kind: "verdict" as const, verdict: { spec: "met" as const, findings: [], summary: "ok" }, costUsd: 0 });
  if (process.argv[3] === "--command") {
    const code = await buildCommand("work", root, {
      provider: writesWhatTheBriefNames(),
      registry,
      policy: { mode: "auto", allow: {}, deny: {} },
      theme: resolveTheme("mono", { depth: 0 }),
      seams: { review },
    });
    process.exit(code);
  }
  const outcome = await runBuild({
    root,
    specsRoot: join(root, ".vesna", "specs"),
    slug: "work",
    provider: writesWhatTheBriefNames(),
    registry,
    policy: { mode: "auto", allow: {}, deny: {} },
    review,
  });
  console.log(JSON.stringify(outcome));
}
