import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTraceStore } from "../../src/store/trace";

async function withStore(fn: (store: ReturnType<typeof createTraceStore>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vesna-trace-"));
  try {
    await fn(createTraceStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const okResult = { status: "ok" as const, nodes: [] };

test("writes and reads back a run with its rows", async () => {
  await withStore(async (store) => {
    const runId = store.createRun("client-report");
    await store.writeRow(runId, { index: 0, inputs: { client: "Acme" }, result: okResult });
    await store.writeRow(runId, { index: 1, inputs: { client: "Globex" }, result: okResult });

    const record = await store.readRun(runId);
    expect(record.flowName).toBe("client-report");
    expect(record.rows).toHaveLength(2);
    expect(record.rows[1]!.inputs).toEqual({ client: "Globex" });
  });
});

test("rows are returned in index order regardless of write order", async () => {
  await withStore(async (store) => {
    const runId = store.createRun("f");
    await store.writeRow(runId, { index: 2, inputs: {}, result: okResult });
    await store.writeRow(runId, { index: 0, inputs: {}, result: okResult });
    const record = await store.readRun(runId);
    expect(record.rows.map((r) => r.index)).toEqual([0, 2]);
  });
});

test("lists created runs", async () => {
  await withStore(async (store) => {
    const a = store.createRun("f");
    const b = store.createRun("f");
    const runs = await store.listRuns();
    expect(runs.sort()).toEqual([a, b].sort());
  });
});

const liveTrace = {
  prompt: "summarize the report",
  finalText: "done",
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0.001,
  environment: { cwd: ".", gitSha: null, envNames: [] },
  steps: [
    { id: "t1", nodeType: "read", input: { path: "a.txt" }, output: { text: "x" }, durationMs: 2 },
  ],
};

test("saves a live trace and reads it back by id", async () => {
  await withStore(async (store) => {
    const id = await store.saveLiveTrace(liveTrace as any);
    expect(id).toMatch(/^live_/);
    const loaded = await store.readLiveTrace(id);
    expect(loaded.prompt).toBe("summarize the report");
    expect(loaded.steps).toHaveLength(1);
  });
});

test("lists saved live traces, newest first", async () => {
  await withStore(async (store) => {
    const first = await store.saveLiveTrace(liveTrace as any);
    await Bun.sleep(2);
    const second = await store.saveLiveTrace(liveTrace as any);
    expect(await store.listLiveTraces()).toEqual([second, first]);
  });
});

test("reading an unknown live trace fails with a useful message", async () => {
  await withStore(async (store) => {
    await expect(store.readLiveTrace("live_nope")).rejects.toThrow(/live_nope/);
  });
});
