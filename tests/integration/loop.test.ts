import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { proposeFlow } from "../../src/crystallize/propose";
import { runMapped } from "../../src/engine/fanout";
import { healRun } from "../../src/engine/heal";
import { parseFlow } from "../../src/flow/parse";
import { runLive } from "../../src/loop/loop";
import { registerBuiltins } from "../../src/nodes";
import { createRegistry } from "../../src/registry/registry";
import { createTraceStore } from "../../src/store/trace";
import type { Provider } from "../../src/providers/types";

const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Stands in for the model: read the report, write a summary, then stop. */
function scriptedAgent(): Provider {
  const turns = [
    [{ type: "tool_use", id: "u1", name: "read", input: { path: "reports/acme.txt" } }],
    [
      {
        type: "tool_use",
        id: "u2",
        name: "write",
        input: { path: "out/acme.md", text: "revenue: 120" },
      },
    ],
    [{ type: "text", text: "Wrote the summary." }],
  ];
  let index = 0;
  return {
    id: "scripted",
    async complete(request) {
      const content = turns[index] ?? [{ type: "text", text: "done" }];
      index += 1;
      return {
        content,
        stopReason: content.some((b: any) => b.type === "tool_use") ? "tool_use" : "end_turn",
        usage,
        model: request.model,
      };
    },
  };
}

test("do -> crystallize -> run -> heal composes end to end, with no network", async () => {
  const root = await mkdtemp(join(tmpdir(), "vesna-e2e-"));
  try {
    await mkdir(join(root, "reports"), { recursive: true });
    await mkdir(join(root, "out"), { recursive: true });
    await writeFile(join(root, "reports", "acme.txt"), "revenue: 120");
    await writeFile(join(root, "reports", "globex.txt"), "revenue: 340");
    // initech is deliberately absent so one row holds.

    const registry = createRegistry();
    registerBuiltins(registry);
    const store = createTraceStore(join(root, ".agent", "traces"));

    // 1. Solve it live.
    const trace = await runLive(
      "summarise reports/acme.txt into out/acme.md",
      scriptedAgent(),
      registry,
      { cwd: root },
    );
    expect(trace.steps.map((s) => s.nodeType)).toEqual(["read", "write"]);

    // 2. The trace is durable, and crystallize reads it back by id.
    const traceId = await store.saveLiveTrace(trace);
    const reloaded = await store.readLiveTrace(traceId);
    const proposal = proposeFlow(reloaded, "client-report");
    expect(proposal.flow.nodes.map((n) => n.id)).toEqual(["read_1", "write_2"]);
    expect(proposal.parameters.length).toBeGreaterThan(0);

    // 3. A human confirms the parameters — here, by hand, as the design intends.
    const flow = parseFlow(
      toYaml({
        ...proposal.flow,
        inputs: { client: { type: "string", required: true } },
        nodes: [
          { ...proposal.flow.nodes[0]!, in: { path: "reports/${inputs.client}.txt" } },
          {
            ...proposal.flow.nodes[1]!,
            in: { path: "out/${inputs.client}.md", text: "$.read_1.text" },
          },
        ],
      }),
    );

    // 4. Fan out. One row holds, the others finish.
    const rows = [{ client: "acme" }, { client: "globex" }, { client: "initech" }];
    const first = await runMapped(flow, registry, rows, { store, cwd: root });
    expect(first.ok).toBe(2);
    expect(first.held).toBe(1);
    expect(await readFile(join(root, "out", "acme.md"), "utf8")).toBe("revenue: 120");

    // 5. Fix the cause, repair only what held.
    await writeFile(join(root, "reports", "initech.txt"), "revenue: 999");
    const record = await store.readRun(first.runId);
    const healed = await healRun(flow, registry, record, { store, cwd: root });
    expect(healed.ok).toBe(3);
    expect(healed.held).toBe(0);
    expect(await readFile(join(root, "out", "initech.md"), "utf8")).toBe("revenue: 999");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
