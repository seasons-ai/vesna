import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";

/**
 * Settings that belong to the machine rather than to a repository.
 *
 * Which model you talk to is a property of your subscription and your laptop,
 * so it should not have to be re-established in every directory. The project
 * file stays hand-written and keeps winning; this one is Vesna's to rewrite,
 * the same division `.vesna/permissions.yaml` already follows.
 *
 * Synchronous, because `/provider` writes this from inside a keypress, and an
 * await there does not resolve until the next key arrives.
 */
export interface GlobalSettings {
  /** A preset id from the catalog. */
  provider?: string;
  model?: string;
  /** Only meaningful for the `custom` preset. */
  baseUrl?: string;
  /** Name of the environment variable holding the key. Never the key itself. */
  env?: string;
}

export function settingsPath(env: Record<string, string | undefined>, home: string): string {
  return join(env.VESNA_HOME ?? join(home, ".vesna"), "settings.yaml");
}

export function readSettings(path: string): GlobalSettings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Absent is the ordinary state before the first run, not a failure.
    return {};
  }

  try {
    const raw = parseYaml(text);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return raw as GlobalSettings;
  } catch {
    // Vesna wrote this file, so a broken one is Vesna's bug or a half-finished
    // write. Refusing to start over it would strand the user with no way in.
    return {};
  }
}

export function writeSettings(path: string, settings: GlobalSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const header = [
    "# Written by Vesna. Safe to edit, safe to delete.",
    "# A .vesna/config.yaml in a project overrides everything here.",
    "",
  ].join("\n");
  writeFileSync(path, `${header}${toYaml(settings)}`);
}
