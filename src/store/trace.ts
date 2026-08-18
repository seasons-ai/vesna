import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LiveTrace } from "../loop/trace";
import type { RowRecord, RunRecord, TraceStore } from "./types";

export function createTraceStore(root: string): TraceStore {
  return {
    createRun(flowName) {
      const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      mkdirSync(join(root, runId, "rows"), { recursive: true });
      writeFileSync(
        join(root, runId, "meta.json"),
        JSON.stringify({ runId, flowName, startedAt: new Date().toISOString() }, null, 2),
      );
      return runId;
    },

    async writeRow(runId, row) {
      await Bun.write(join(root, runId, "rows", `${row.index}.json`), JSON.stringify(row, null, 2));
    },

    async readRun(runId) {
      const meta = JSON.parse(await readFile(join(root, runId, "meta.json"), "utf8"));
      const files = await readdir(join(root, runId, "rows"));
      const rows: RowRecord[] = [];
      for (const file of files) {
        rows.push(JSON.parse(await readFile(join(root, runId, "rows", file), "utf8")));
      }
      rows.sort((a, b) => a.index - b.index);
      return { ...meta, rows };
    },

    async listRuns() {
      try {
        return (await readdir(root)).filter((entry) => entry.startsWith("run_"));
      } catch {
        return [];
      }
    },

    async saveLiveTrace(trace) {
      const id = `live_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      mkdirSync(join(root, "live"), { recursive: true });
      await Bun.write(join(root, "live", `${id}.json`), JSON.stringify(trace, null, 2));
      return id;
    },

    async readLiveTrace(id) {
      try {
        return JSON.parse(await readFile(join(root, "live", `${id}.json`), "utf8"));
      } catch {
        throw new Error(`no live trace with id ${id}`);
      }
    },

    async listLiveTraces() {
      try {
        const files = await readdir(join(root, "live"));
        return files
          .filter((file) => file.endsWith(".json"))
          .map((file) => file.replace(/\.json$/, ""))
          .sort()
          .reverse();
      } catch {
        return [];
      }
    },
  };
}
