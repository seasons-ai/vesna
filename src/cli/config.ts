import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_MODEL } from "../providers/types";

export interface VesnaConfig {
  model: string;
  permissions: { nodes: string[] };
}

export async function loadConfig(root: string): Promise<VesnaConfig> {
  let raw: any = {};
  try {
    raw = parseYaml(await readFile(join(root, ".agent", "config.yaml"), "utf8")) ?? {};
  } catch {
    raw = {};
  }
  return {
    model: raw.model ?? DEFAULT_MODEL,
    // Permissions are the registry: no node, no capability.
    permissions: { nodes: raw.permissions?.nodes ?? ["read", "write", "shell", "script", "llm"] },
  };
}
