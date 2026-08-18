import type { NodeDef } from "../registry/types";

export const shellNode: NodeDef<
  { command: string },
  { stdout: string; stderr: string; code: number }
> = {
  type: "shell",
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
