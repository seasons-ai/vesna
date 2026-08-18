import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import type { NodeDef } from "../registry/types";
import { safeResolve } from "./read";

export const editNode: NodeDef<
  { path: string; oldText: string; newText: string; replaceAll?: boolean },
  { path: string; replacements: number }
> = {
  type: "edit",
  description:
    "Replace exact text in a file. Fails if the text is absent, or appears more than once unless replaceAll is set.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      oldText: { type: "string", description: "Exact text to replace, including whitespace" },
      newText: { type: "string" },
      replaceAll: { type: "boolean" },
    },
    required: ["path", "oldText", "newText"],
  },
  effect: "write",
  async run(input, ctx) {
    const full = safeResolve(input.path, ctx);
    const before = await readFile(full, "utf8");
    const count = before.split(input.oldText).length - 1;

    // Refusing beats guessing: a silent replacement in the wrong place is the
    // failure this project exists to make loud.
    if (count === 0) throw new Error(`text not found in ${input.path}`);
    if (count > 1 && input.replaceAll !== true) {
      throw new Error(
        `text appears ${count} times in ${input.path}; pass replaceAll or include more context`,
      );
    }

    const after = input.replaceAll
      ? before.split(input.oldText).join(input.newText)
      : before.replace(input.oldText, input.newText);

    await writeFile(full, after, "utf8");
    return { path: input.path, replacements: count };
  },
};

async function filesMatching(pattern: string, cwd: string, limit: number): Promise<string[]> {
  const glob = new Bun.Glob(pattern);
  const paths: string[] = [];
  for await (const file of glob.scan({ cwd, onlyFiles: true, dot: false })) {
    paths.push(file);
    if (paths.length >= limit) break;
  }
  return paths;
}

export const globNode: NodeDef<{ pattern: string; limit?: number }, { paths: string[] }> = {
  type: "glob",
  description: "List files matching a glob pattern, relative to the working directory.",
  inputSchema: {
    type: "object",
    properties: { pattern: { type: "string" }, limit: { type: "number" } },
    required: ["pattern"],
  },
  effect: "pure",
  async run(input, ctx) {
    return { paths: await filesMatching(input.pattern, ctx.cwd, input.limit ?? 1000) };
  },
};

export const grepNode: NodeDef<
  { pattern: string; glob?: string; limit?: number },
  { matches: { path: string; line: number; text: string }[]; truncated: boolean }
> = {
  type: "grep",
  description: "Search file contents with a regular expression. Returns file, line number and line.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression" },
      glob: { type: "string", description: "Restrict the search, e.g. src/**/*.ts" },
      limit: { type: "number" },
    },
    required: ["pattern"],
  },
  effect: "pure",
  async run(input, ctx) {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern);
    } catch (error) {
      throw new Error(`invalid search pattern: ${(error as Error).message}`);
    }

    const limit = input.limit ?? 200;
    const files = await filesMatching(input.glob ?? "**/*", ctx.cwd, 5000);
    const matches: { path: string; line: number; text: string }[] = [];

    for (const file of files.sort()) {
      let content: string;
      try {
        content = await readFile(safeResolve(file, ctx), "utf8");
      } catch {
        continue; // binary or unreadable: not a search failure
      }

      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index]!;
        if (!regex.test(text)) continue;
        if (matches.length >= limit) return { matches, truncated: true };
        matches.push({ path: relative(ctx.cwd, safeResolve(file, ctx)), line: index + 1, text });
      }
    }

    return { matches, truncated: false };
  },
};
