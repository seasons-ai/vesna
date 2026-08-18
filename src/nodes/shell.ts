import type { NodeDef } from "../registry/types";

export const shellNode: NodeDef<
  { command: string },
  { stdout: string; stderr: string; code: number }
> = {
  type: "shell",
  description: "Run a shell command in the working directory",
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  effect: "write",
  async run(input, ctx) {
    const proc = Bun.spawn(["/bin/sh", "-c", input.command], {
      cwd: ctx.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { stdout, stderr, code };
  },
};
