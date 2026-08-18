import type { Registry } from "../registry/types";
import { editNode, globNode, grepNode } from "./coding";
import { readNode } from "./read";
import { scriptNode } from "./script";
import { shellNode } from "./shell";
import { writeNode } from "./write";

export { readNode, writeNode, shellNode, scriptNode, editNode, globNode, grepNode };

export function registerBuiltins(registry: Registry): void {
  registry.register(readNode);
  registry.register(writeNode);
  registry.register(shellNode);
  registry.register(scriptNode);
  registry.register(editNode);
  registry.register(globNode);
  registry.register(grepNode);
}
