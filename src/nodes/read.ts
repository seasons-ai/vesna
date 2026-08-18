import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { NodeContext, NodeDef } from "../registry/types";

/** Resolves a node-supplied path and refuses anything outside the working directory. */
export function safeResolve(path: string, ctx: NodeContext): string {
  const full = resolve(ctx.cwd, path);
  const rel = relative(ctx.cwd, full);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path is outside the working directory: ${path}`);
  }
  return full;
}

export const readNode: NodeDef<{ path: string }, { text: string }> = {
  type: "read",
  description: "Read a UTF-8 text file from the working directory",
  inputSchema: { type: "object", properties: { path: { type: "string", description: "Path relative to the working directory" } }, required: ["path"] },
  effect: "pure",
  async run(input, ctx) {
    return { text: await readFile(safeResolve(input.path, ctx), "utf8") };
  },
};
