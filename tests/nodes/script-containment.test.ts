import { test, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scriptNode } from "../../src/nodes/script";

/**
 * What the `script` node actually contains, written down so the documentation
 * cannot drift away from it again.
 *
 * The README once said the filesystem was confined to the working directory
 * and the network was off. Both were false. These tests fail the day either
 * becomes true, which is the point: whoever builds real isolation has to come
 * here and say so, and whoever writes the next security paragraph can read
 * what is enforced instead of guessing.
 */

const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal });

async function elsewhere(): Promise<{ dir: string; secret: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "vesna-outside-"));
  const path = join(dir, "outside.txt");
  const secret = "outside-the-working-directory";
  await writeFile(path, secret);
  return { dir, secret, path };
}

test("a script reads files outside its working directory — there is no confinement", async () => {
  const { path, secret } = await elsewhere();
  const inside = await mkdtemp(join(tmpdir(), "vesna-cwd-"));

  const output = await scriptNode.run(
    { body: `const fs = await import("node:fs"); output = fs.readFileSync(${JSON.stringify(path)}, "utf8");` },
    ctx(inside),
  );
  expect(output).toBe(secret);
});

test("Bun.file reaches outside too, so blocking one API would prove nothing", async () => {
  const { path, secret } = await elsewhere();
  const inside = await mkdtemp(join(tmpdir(), "vesna-cwd-"));

  const output = await scriptNode.run(
    { body: `output = await Bun.file(${JSON.stringify(path)}).text();` },
    ctx(inside),
  );
  expect(output).toBe(secret);
});

test("the socket APIs are present, so disabling fetch is a speed bump", async () => {
  const inside = await mkdtemp(join(tmpdir(), "vesna-cwd-"));
  const output = (await scriptNode.run(
    {
      body: `
        const net = await import("node:net");
        const http = await import("node:http");
        output = {
          net: typeof net.connect === "function",
          http: typeof http.request === "function",
          spawn: typeof Bun.spawn === "function",
        };
      `,
    },
    ctx(inside),
  )) as Record<string, boolean>;

  expect(output).toEqual({ net: true, http: true, spawn: true });
});

test("fetch itself is refused, and the error says what that is worth", async () => {
  const inside = await mkdtemp(join(tmpdir(), "vesna-cwd-"));
  await expect(
    scriptNode.run({ body: `output = await fetch("http://example.com");` }, ctx(inside)),
  ).rejects.toThrow(/not a sandbox/i);
});

test("the description tells the model the truth about its own privileges", () => {
  const said = scriptNode.description.toLowerCase();
  expect(said).toContain("not a sandbox");
  // The word the old description used, and the reason a model trusted it.
  expect(said).not.toMatch(/\bin a sandbox\b/);
});

test("a script still cannot outlive its timeout", async () => {
  const inside = await mkdtemp(join(tmpdir(), "vesna-cwd-"));
  await expect(
    scriptNode.run({ body: `await new Promise(() => {});`, timeoutMs: 300 }, ctx(inside)),
  ).rejects.toThrow(/timed out|no result/i);
});
