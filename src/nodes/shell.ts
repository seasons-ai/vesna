import type { NodeDef } from "../registry/types";
import { spawnInterruptible } from "./spawn";

export const shellNode: NodeDef<
  { command: string },
  { stdout: string; stderr: string; code: number }
> = {
  type: "shell",
  description: "Run a shell command in the working directory",
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  effect: "write",
  async run(input, ctx) {
    return await spawnInterruptible(["/bin/sh", "-c", input.command], {
      cwd: ctx.cwd,
      signal: ctx.signal,
    });
  },
};
