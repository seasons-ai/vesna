import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codexAuthPath, readCodexAuth } from "../auth/codex";
import { CODEX_DEFAULT_MODEL, type AuthMode } from "./config";

/**
 * Writing a project config file.
 *
 * `chooseStarter` guesses a first setup from what is actually on the machine.
 * `vesna init` no longer calls it, though: once machine-wide settings exist,
 * `init`'s job is pinning whatever is already in effect — a project file, the
 * machine settings, or a preset default (see `loadConfig` in ./config.ts) —
 * to this repository, not guessing a fresh one. `writeStarterConfig` renders
 * either kind of starter the same way, and keeps refusing to overwrite a
 * config someone hand-wrote.
 */

export interface Starter {
  /**
   * `chooseStarter` only ever names a dialect ("anthropic" or "openai"), but
   * pinning the settings already in effect needs the actual catalog preset id
   * (e.g. "ollama", "groq", "codex") — collapsing that back down to its
   * dialect would pin the wrong service (see `presetFor` in ./providers/catalog).
   */
  provider: string;
  auth: AuthMode;
  /** Recorded explicitly so a pin captures more than just the preset's own default. */
  model?: string;
  /** Only meaningful for a preset whose address is not implied by `provider`. */
  baseUrl?: string;
  /** Name of the key environment variable, when the preset needs one. */
  env?: string;
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

  if (starter.provider === "codex" || (starter.provider === "openai" && starter.auth === "codex")) {
    lines.push(
      `model: ${starter.model ?? CODEX_DEFAULT_MODEL}`,
      "# Credentials are borrowed read-only from the Codex CLI. Renew with `codex login`.",
    );
  } else if (starter.auth === "subscription") {
    // The one thing that is not true of this setup is "no key needed": Vesna
    // ships no OAuth client identity of its own or anyone else's, so this file
    // is the only place the missing half can come from.
    if (starter.model) lines.push(`model: ${starter.model}`);
    lines.push(
      "# Vesna's own sign-in needs an OAuth client you supply. Fill this in, then",
      "# run `vesna auth login`.",
      "# oauth:",
      "#   issuer: https://auth.openai.com",
      "#   clientId: <your client id>",
      "#   baseUrl: https://chatgpt.com/backend-api/codex",
    );
  } else if (starter.provider === "anthropic") {
    if (starter.model) lines.push(`model: ${starter.model}`);
    lines.push("# Reads whatever the Anthropic SDK reads: ANTHROPIC_API_KEY, or an OAuth profile.");
  } else {
    if (starter.model) lines.push(`model: ${starter.model}`);
    if (starter.baseUrl) lines.push(`baseUrl: ${starter.baseUrl}`);
    lines.push(
      starter.env
        ? `# Reads ${starter.env}. Set baseUrl to point at a local or compatible endpoint.`
        : "# No key needed for this endpoint. Set baseUrl to point somewhere else.",
    );
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
