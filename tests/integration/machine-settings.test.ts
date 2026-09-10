import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What a one-character typo in `~/.vesna/settings.yaml` costs.
 *
 * `loadConfig` runs before `route` has looked at the arguments, so a value in
 * the machine file that matched no preset used to throw there and take every
 * command down with it: `vesna --help` exited 2, which is the breakage
 * src/cli/entry.ts exists to prevent, and it happened for a file the user may
 * never have opened. The exit status is the whole assertion — a shell script
 * and a CI step read nothing else.
 */

const BIN = join(import.meta.dir, "..", "..", "bin", "vesna");

async function sandbox(settings: string) {
  const home = await mkdtemp(join(tmpdir(), "vesna-machine-home-"));
  // A directory with no .vesna/config.yaml of its own: nothing pins a
  // provider here, so the machine file is the only thing that names one.
  const cwd = await mkdtemp(join(tmpdir(), "vesna-machine-cwd-"));
  await mkdir(join(home, ".vesna"), { recursive: true });
  await writeFile(join(home, ".vesna", "settings.yaml"), settings);
  return { home, cwd };
}

async function run(where: { home: string; cwd: string }, args: string[]) {
  const child = Bun.spawn(["bun", BIN, ...args], {
    cwd: where.cwd,
    env: { ...process.env, VESNA_HOME: join(where.home, ".vesna") },
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

test("an unusable machine file leaves the commands that need no provider alone", async () => {
  const where = await sandbox("provider: gruq\n");

  const help = await run(where, ["--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("usage:");

  expect((await run(where, ["--version"])).status).toBe(0);
  expect((await run(where, ["doctor"])).status).toBe(0);
}, 30_000);

/**
 * Ignored, not forgiven. `provider: gruq` resolving quietly to Anthropic is
 * what f5620a9 removed; the report simply waits until something asks for a
 * service.
 */
test("an unusable machine file is still refused by a command that needs a service", async () => {
  const where = await sandbox("provider: gruq\n");

  const auth = await run(where, ["auth"]);
  expect(auth.status).toBe(2);
  expect(auth.stderr).toContain('names an unknown provider "gruq"');
  expect(auth.stderr).toContain("settings.yaml");
  // The list is the point: the fix has to be guessable from the message.
  expect(auth.stderr).toContain("ollama");
}, 30_000);

test("a machine file naming a real service leaves every one of them working", async () => {
  const where = await sandbox("provider: ollama\nmodel: llama3.2\n");

  expect((await run(where, ["--help"])).status).toBe(0);
  const auth = await run(where, ["auth"]);
  expect(auth.status).toBe(0);
  expect(auth.stdout).toContain("ollama");
}, 30_000);
