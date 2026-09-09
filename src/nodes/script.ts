import type { NodeDef } from "../registry/types";
import { spawnInterruptible } from "./spawn";

// Runs the body in a separate process with a fresh environment, its own cwd
// and a timeout. That is the whole of the containment, and it is worth being
// blunt about what it is not: the child keeps the privileges of the user who
// started Vesna. node:fs, Bun.file, node:net, node:http and Bun.spawn are all
// reachable from inside, so overwriting globalThis.fetch below stops the
// obvious call and nothing more. Real containment needs OS-level isolation,
// which is not built; until it is, `permissions.nodes` is the actual control.
//
// The payload travels in an environment variable rather than argv: argv layout
// differs between runtimes, and a large script body would eventually exceed the
// argument length limit.
const PAYLOAD_VAR = "VESNA_SCRIPT_PAYLOAD";

const RUNNER = `
const payload = JSON.parse(process.env.${PAYLOAD_VAR});
globalThis.fetch = () => {
  throw new Error("fetch is disabled here; note this is a speed bump, not a sandbox");
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
  description:
    "Evaluate a short JavaScript body in a separate process with the same privileges as Vesna itself. This is NOT a sandbox: it can read and write any file the user can, and open network connections. Prefer read, write, glob or grep when one of them will do. Assign the result to `output`.",
  inputSchema: { type: "object", properties: { body: { type: "string" }, args: { type: "object" }, timeoutMs: { type: "number" } }, required: ["body"] },
  // Not pure. The body is arbitrary code with the user's own privileges, and
  // declaring otherwise would exempt it from the approval that matters most.
  effect: "external",
  async run(input, ctx) {
    const timeoutMs = input.timeoutMs ?? 10_000;

    const { stdout, stderr, code } = await spawnInterruptible(["bun", "-e", RUNNER], {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        [PAYLOAD_VAR]: JSON.stringify({ body: input.body, args: input.args ?? {} }),
      },
    });

    if (stdout.trim().length === 0) {
      const detail = stderr.trim().split("\n")[0] ?? `exit ${code}`;
      throw new Error(`script produced no result (timed out or crashed): ${detail}`);
    }

    const parsed = JSON.parse(stdout);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.output;
  },
};
