import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `parseFlags` hands a flag the *next* argument when that argument does not
 * start with `--`, so `--dry-run ""` sets `flags["dry-run"]` to the empty
 * string rather than leaving it bare. The provider gate in `main` read that
 * with `!== undefined` (true for `""`) while the `run` command itself read it
 * with plain truthiness (false for `""`) — so a command that looked like a
 * dry run to the gate looked like a real run to the command it was supposed
 * to stop, and the flow actually executed, reaching a provider the user
 * never configured.
 *
 * Both call sites now read presence through `isFlagSet`, so they agree:
 * `--dry-run ""` is a dry run to both of them. This drives the real binary
 * end to end and checks that agreement is what it looks like in practice —
 * the plan is printed and the flow does not run — rather than asserting a
 * refusal that was never the fix.
 */

const BIN = join(import.meta.dir, "..", "..", "bin", "vesna");

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), "vesna-dry-run-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "vesna-dry-run-cwd-"));
  await mkdir(join(home, ".vesna"), { recursive: true });
  await writeFile(join(home, ".vesna", "settings.yaml"), "provider: gruq\n");
  await mkdir(join(cwd, ".vesna", "flows"), { recursive: true });
  await writeFile(
    join(cwd, ".vesna", "flows", "probe.yaml"),
    ["name: probe", "nodes:", "  - id: think", "    use: llm", "    in:", '      prompt: "hi"', ""].join("\n"),
  );
  return { home, cwd };
}

async function run(where: { home: string; cwd: string }, args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    VESNA_HOME: join(where.home, ".vesna"),
  };
  // No credential must be reachable by accident, or a real completion could
  // mask the gate this test is checking.
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.GROQ_API_KEY;
  const child = Bun.spawn(["bun", BIN, ...args], {
    cwd: where.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

test("--dry-run swallowing an empty argument still behaves like a dry run", async () => {
  const where = await sandbox();

  const plain = await run(where, ["run", "probe"]);
  expect(plain.status).toBe(2);
  expect(plain.stderr).toContain("gruq");

  const dryRun = await run(where, ["run", "probe", "--dry-run"]);
  expect(dryRun.status).toBe(0);
  expect(dryRun.stdout).toContain("order:    think");

  // `--dry-run ""` makes `parseFlags` assign the empty string as the flag's
  // value instead of leaving it bare. Both the provider gate and the `run`
  // command now read presence through `isFlagSet`, so they agree this is
  // still a dry run: the plan prints, and — the assertion that carries this
  // test — nothing indicates the flow actually executed.
  const spoofed = await run(where, ["run", "probe", "--dry-run", ""]);
  expect(spoofed.status).toBe(0);
  expect(spoofed.stdout).toContain("order:    think");
  // A held row is only ever printed once the flow has actually run past the
  // gate; its absence is the evidence that it did not.
  expect(spoofed.stdout).not.toContain("held");
}, 30_000);
