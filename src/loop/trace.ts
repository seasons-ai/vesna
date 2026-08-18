import type { Usage } from "../providers/types";

export interface TraceStep {
  id: string;
  nodeType: string;
  input: Record<string, unknown>;
  output: unknown;
  durationMs: number;
}

export interface Fingerprint {
  cwd: string;
  gitSha: string | null;
  /** Names only. Values are never recorded. */
  envNames: string[];
}

export interface LiveTrace {
  prompt: string;
  steps: TraceStep[];
  finalText: string;
  usage: Usage;
  costUsd: number;
  environment: Fingerprint;
}

export async function fingerprint(cwd: string): Promise<Fingerprint> {
  let gitSha: string | null = null;
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe", stderr: "ignore" });
    const text = (await new Response(proc.stdout).text()).trim();
    gitSha = (await proc.exited) === 0 && text.length > 0 ? text : null;
  } catch {
    gitSha = null;
  }
  return { cwd, gitSha, envNames: Object.keys(process.env).sort() };
}
