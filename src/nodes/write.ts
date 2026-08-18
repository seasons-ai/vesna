import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NodeDef } from "../registry/types";
import { safeResolve } from "./read";

export const writeNode: NodeDef<{ path: string; text: string }, { path: string; bytes: number }> = {
  type: "write",
  effect: "write",
  async run(input, ctx) {
    const full = safeResolve(input.path, ctx);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, input.text, "utf8");
    return { path: input.path, bytes: Buffer.byteLength(input.text, "utf8") };
  },
};
