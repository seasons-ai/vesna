import type { RunResult } from "../engine/run";

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
}
