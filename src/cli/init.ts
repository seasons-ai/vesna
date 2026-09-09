import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codexAuthPath, readCodexAuth } from "../auth/codex";
import { CODEX_DEFAULT_MODEL, type AuthMode, type ProviderId } from "./config";

/**
 * Writing the config a first-time user would have written anyway.
 *
 * The starter is chosen from what is actually on the machine rather than from
 * a fixed default, so `vesna init` followed by `vesna chat` works without a
 * detour through the documentation.
 */

export interface Starter {
  provider: ProviderId;
  auth: AuthMode;
}

type Env = Record<string, string | undefined>;

export async function chooseStarter(env: Env, home: string): Promise<Starter> {
  const codex = await readCodexAuth(codexAuthPath(env, home));
  const codexLive =
    codex?.accessToken !== undefined &&
    (codex.expiresAt === undefined || codex.expiresAt > Date.now());

  // A subscription already signed in elsewhere spends nothing extra, so it
  // outranks a key even when both are present.
  if (codexLive) return { provider: "openai", auth: "codex" };
  if (set(env.ANTHROPIC_API_KEY) || set(env.ANTHROPIC_AUTH_TOKEN)) {
    return { provider: "anthropic", auth: "key" };
  }
  if (set(env.OPENAI_API_KEY)) return { provider: "openai", auth: "key" };

  // Nothing to go on. Write the default anyway: an explicit file the user can
  // edit beats an invisible fallback they have to discover.
  return { provider: "anthropic", auth: "key" };
}

function set(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

export async function writeStarterConfig(root: string, starter: Starter): Promise<string> {
  const dir = join(root, ".vesna");
  const path = join(dir, "config.yaml");

  await mkdir(dir, { recursive: true });
  try {
    // Refuse rather than merge: a config is hand-written, and losing someone's
    // settings to a convenience command is not a trade worth making.
    await writeFile(path, render(starter), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${path} already exists — edit it, or delete it and run init again`);
    }
    throw error;
  }
  return path;
}

function render(starter: Starter): string {
  const lines = [
    "# Vesna configuration. Everything here has a default; delete what you do not need.",
    `provider: ${starter.provider}`,
    `auth: ${starter.auth}`,
  ];

  if (starter.provider === "openai" && starter.auth === "codex") {
    lines.push(
      `model: ${CODEX_DEFAULT_MODEL}`,
      "# Credentials are borrowed read-only from the Codex CLI. Renew with `codex login`.",
    );
  } else if (starter.provider === "anthropic") {
    lines.push("# Reads whatever the Anthropic SDK reads: ANTHROPIC_API_KEY, or an OAuth profile.");
  } else {
    lines.push("# Reads OPENAI_API_KEY. Set baseUrl to point at a local or compatible endpoint.");
  }

  lines.push(
    "",
    "# vesna, hanami, washi, or mono.",
    "theme: vesna",
    "",
    "# Nodes the agent is allowed to call. No node, no capability.",
    "permissions:",
    "  nodes: [read, write, shell, script, llm]",
    "",
  );
  return lines.join("\n");
}
