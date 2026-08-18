import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NodeDef } from "../registry/types";
import { safeResolve } from "./read";

export const writeNode: NodeDef<{ path: string; text: string }, { path: string; bytes: number }> = {
  type: "write",
  description: "Write a UTF-8 text file inside the working directory",
  inputSchema: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } }, required: ["path", "text"] },
  effect: "write",
  async run(input, ctx) {
    const full = safeResolve(input.path, ctx);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, input.text, "utf8");
    return { path: input.path, bytes: Buffer.byteLength(input.text, "utf8") };
  },
};
