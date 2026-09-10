import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import type { VesnaConfig } from "../cli/config";
import type { Mode, Policy } from "./decide";

/**
 * Where the rules live.
 *
 * Two files on purpose. `config.yaml` is hand-written and Vesna never rewrites
 * it — doing so would cost the user their comments and layout, the same reason
 * `/theme` does not persist. Rules learned from answering a question go in
 * `permissions.yaml`, which Vesna owns and may rewrite freely.
 *
 * Both use the same format, so a learned rule can be moved into the config by
 * hand and behaves identically.
 */

const LEARNED = "permissions.yaml";

const HEADER = [
  "# Written by Vesna as you answer permission questions.",
  "# Safe to edit or delete; safe to move into .vesna/config.yaml by hand.",
  "",
].join("\n");

function learnedPath(root: string): string {
  return join(root, ".vesna", LEARNED);
}

function merge(
  a: Record<string, string[]> = {},
  b: Record<string, string[]> = {},
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[key] = [...new Set([...(a[key] ?? []), ...(b[key] ?? [])])];
  }
  return out;
}

async function readLearned(root: string): Promise<{ allow?: Record<string, string[]> }> {
  try {
    const parsed = parseYaml(await readFile(learnedPath(root), "utf8"));
    // A file Vesna wrote that no longer parses is a bug, not a grant.
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function loadPolicy(root: string, config: VesnaConfig): Promise<Policy> {
  const learned = await readLearned(root);
  const wanted = config.permissions.mode;
  const mode: Mode = wanted === "auto" || wanted === "plan" ? wanted : "ask";

  return {
    mode,
    allow: merge(config.permissions.allow, learned.allow),
    deny: merge(config.permissions.deny, {}),
  };
}

export async function rememberAllow(root: string, node: string, pattern: string): Promise<void> {
  const learned = await readLearned(root);
  const allow = learned.allow ?? {};
  const existing = allow[node] ?? [];
  if (existing.includes(pattern)) return;

  allow[node] = [...existing, pattern];
  const path = learnedPath(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, HEADER + toYaml({ allow }));
}

/**
 * What "always allow this" should mean.
 *
 * A rule for one exact file is answered again on the next file in the same
 * directory, which teaches the user to stop reading the question. A rule for
 * the directory is the answer they meant.
 */
export function suggestPattern(node: string, facet: string): string {
  if (node === "shell" || node === "script") {
    return `${facet.split(/\s+/).slice(0, 2).join(" ")}*`;
  }
  const directory = facet.includes("/") ? facet.slice(0, facet.lastIndexOf("/")) : "";
  return directory === "" ? facet : `${directory}/**`;
}
