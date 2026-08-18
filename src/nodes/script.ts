import type { NodeDef } from "../registry/types";

// Runs in a separate process with a minimal environment and no network.
// This is process isolation, not VM isolation — see the security section of
// the design spec. The body assigns its result to `output`.
//
// The payload travels in an environment variable rather than argv: argv layout
// differs between runtimes, and a large script body would eventually exceed the
// argument length limit.
const PAYLOAD_VAR = "VESNA_SCRIPT_PAYLOAD";

const RUNNER = `
const payload = JSON.parse(process.env.${PAYLOAD_VAR});
globalThis.fetch = () => {
  throw new Error("network access is disabled in the script sandbox");
};
const input = payload.args ?? {};
try {
  const fn = new Function(
    "input",
    "return (async () => { let output; " + payload.body + " ; return output; })();"
  );
  const output = await fn(input);
  process.stdout.write(JSON.stringify({ ok: true, output: output ?? null }));
} catch (error) {
  const message = error && error.message ? error.message : String(error);
  process.stdout.write(JSON.stringify({ ok: false, message }));
}
`;

export const scriptNode: NodeDef<
  { body: string; args?: Record<string, unknown>; timeoutMs?: number },
  unknown
> = {
  type: "script",
  description: "Evaluate a short JavaScript body in a sandbox with no network access. Assign the result to `output`.",
  inputSchema: { type: "object", properties: { body: { type: "string" }, args: { type: "object" }, timeoutMs: { type: "number" } }, required: ["body"] },
  effect: "pure",
  async run(input, ctx) {
    const timeoutMs = input.timeoutMs ?? 10_000;

    const proc = Bun.spawn(["bun", "-e", RUNNER], {
      cwd: ctx.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        [PAYLOAD_VAR]: JSON.stringify({ body: input.body, args: input.args ?? {} }),
      },
    });

    const timer = setTimeout(() => proc.kill(), timeoutMs);
    let stdout: string;
    let stderr: string;
    let code: number;
    try {
      [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      code = await proc.exited;
    } finally {
      clearTimeout(timer);
    }

    if (stdout.trim().length === 0) {
      const detail = stderr.trim().split("\n")[0] ?? `exit ${code}`;
      throw new Error(`script produced no result (timed out or crashed): ${detail}`);
    }

    const parsed = JSON.parse(stdout);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.output;
  },
};
