import type { RunResult } from "../engine/run";
import type { LiveTrace } from "../loop/trace";

export interface RowRecord {
  index: number;
  inputs: Record<string, unknown>;
  result: RunResult;
}

export interface RunRecord {
  runId: string;
  flowName: string;
  startedAt: string;
  rows: RowRecord[];
}

export interface TraceStore {
  createRun(flowName: string): string;
  writeRow(runId: string, row: RowRecord): Promise<void>;
  readRun(runId: string): Promise<RunRecord>;
  listRuns(): Promise<string[]>;

  /** Live traces are what `crystallize` consumes, so the loop must persist them. */
  saveLiveTrace(trace: LiveTrace): Promise<string>;
  readLiveTrace(id: string): Promise<LiveTrace>;
  listLiveTraces(): Promise<string[]>;
}
