import type { Registry } from "../registry/types";
import { readNode } from "./read";
import { scriptNode } from "./script";
import { shellNode } from "./shell";
import { writeNode } from "./write";

export { readNode, writeNode, shellNode, scriptNode };

export function registerBuiltins(registry: Registry): void {
  registry.register(readNode);
  registry.register(writeNode);
  registry.register(shellNode);
  registry.register(scriptNode);
}
