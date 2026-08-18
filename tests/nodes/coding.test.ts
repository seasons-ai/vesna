import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editNode, globNode, grepNode } from "../../src/nodes/coding";

async function withProject(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "vesna-coding-"));
  await mkdir(join(dir, "src", "deep"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  await writeFile(join(dir, "src", "deep", "b.ts"), "const shared = 'value';\n");
  await writeFile(join(dir, "notes.md"), "a note about shared things\n");
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal });

test("edit replaces a unique occurrence", async () => {
  await withProject(async (dir) => {
    const result: any = await editNode.run(
      { path: "src/a.ts", oldText: "const a = 1", newText: "const a = 42" },
      ctx(dir),
    );
    expect(result.replacements).toBe(1);
    expect(await readFile(join(dir, "src", "a.ts"), "utf8")).toContain("const a = 42");
  });
});

test("edit refuses when the text is not there, rather than doing nothing quietly", async () => {
  await withProject(async (dir) => {
    await expect(
      editNode.run({ path: "src/a.ts", oldText: "not present", newText: "x" }, ctx(dir)),
    ).rejects.toThrow(/not found/i);
  });
});

test("edit refuses an ambiguous match instead of guessing which one", async () => {
  await withProject(async (dir) => {
    await expect(
      editNode.run({ path: "src/a.ts", oldText: "export const", newText: "const" }, ctx(dir)),
    ).rejects.toThrow(/2 times/);
  });
});

test("edit replaces every occurrence when asked explicitly", async () => {
  await withProject(async (dir) => {
    const result: any = await editNode.run(
      { path: "src/a.ts", oldText: "export const", newText: "const", replaceAll: true },
      ctx(dir),
    );
    expect(result.replacements).toBe(2);
  });
});

test("edit stays inside the working directory", async () => {
  await withProject(async (dir) => {
    await expect(
      editNode.run({ path: "../escape.txt", oldText: "a", newText: "b" }, ctx(dir)),
    ).rejects.toThrow(/outside/);
  });
});

test("glob finds files by pattern, relative to the working directory", async () => {
  await withProject(async (dir) => {
    const result: any = await globNode.run({ pattern: "src/**/*.ts" }, ctx(dir));
    expect(result.paths.sort()).toEqual(["src/a.ts", "src/deep/b.ts"]);
  });
});

test("glob returns an empty list rather than failing on no match", async () => {
  await withProject(async (dir) => {
    expect((await globNode.run({ pattern: "**/*.rs" }, ctx(dir))).paths).toEqual([]);
  });
});

test("grep reports the file, line number and matching line", async () => {
  await withProject(async (dir) => {
    const result: any = await grepNode.run({ pattern: "shared" }, ctx(dir));
    const paths = result.matches.map((m: any) => m.path).sort();
    expect(paths).toEqual(["notes.md", "src/deep/b.ts"]);
    const hit = result.matches.find((m: any) => m.path === "src/deep/b.ts");
    expect(hit.line).toBe(1);
    expect(hit.text).toContain("shared");
  });
});

test("grep can be narrowed to a glob", async () => {
  await withProject(async (dir) => {
    const result: any = await grepNode.run({ pattern: "shared", glob: "**/*.ts" }, ctx(dir));
    expect(result.matches.map((m: any) => m.path)).toEqual(["src/deep/b.ts"]);
  });
});

test("grep honours a result limit so a huge tree cannot flood the context", async () => {
  await withProject(async (dir) => {
    const result: any = await grepNode.run({ pattern: "e", limit: 1 }, ctx(dir));
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});

test("an invalid regex is reported as such, not as a crash", async () => {
  await withProject(async (dir) => {
    await expect(grepNode.run({ pattern: "(" }, ctx(dir))).rejects.toThrow(/pattern/i);
  });
});

test("the three tools declare honest effect classes", () => {
  expect(editNode.effect).toBe("write");
  expect(globNode.effect).toBe("pure");
  expect(grepNode.effect).toBe("pure");
});
