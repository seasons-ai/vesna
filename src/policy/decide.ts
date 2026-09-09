import { isAbsolute, relative, resolve } from "node:path";

/**
 * Whether an action may proceed.
 *
 * `permissions.nodes` was a switch per node type: turn on `shell` and the model
 * may run anything, turn it off and the agent is useless. There was no middle,
 * and the middle is where the work is.
 *
 * One rule format serves both modes. `ask` fills it in as the user answers,
 * `auto` reads it, and a person can edit it by hand. Two policy languages —
 * one for asking, one for automating — is how these systems stop being
 * understandable.
 */

export type Mode = "ask" | "auto";
export type Decision = "allow" | "deny" | "ask";

export interface Policy {
  mode: Mode;
  /** Patterns that may proceed without a question, per node type. */
  allow: Record<string, string[]>;
  /** Patterns that may never proceed. Beats allow. */
  deny: Record<string, string[]>;
}

export interface Action {
  node: string;
  input: Record<string, unknown>;
  cwd: string;
}

/**
 * Things that are asked about however the policy is written, because getting
 * them wrong cannot be undone by editing a file afterwards. Kept short on
 * purpose: a long list here is a policy nobody can reason about.
 */
const ALWAYS_ASK_PATHS = [
  "**/.env",
  "**/.env.*",
  ".env",
  ".env.*",
  "**/*.pem",
  "**/*.key",
  "**/.ssh/**",
  ".ssh/**",
  "**/.aws/**",
  "**/id_rsa*",
];

const ALWAYS_ASK_COMMANDS = [
  /(^|\s|&&|\|)\s*sudo\s/,
  /(^|\s|&&|\|)\s*rm\s+(-\w*\s+)*-\w*[rR]/,
  /git\s+push\b[^|;]*--force/,
  /git\s+reset\b[^|;]*--hard/,
  /git\s+clean\b[^|;]*-\w*[fd]/,
  /\bnpm\s+publish\b/,
  /\bbun\s+publish\b/,
  /\|\s*(sh|bash|zsh)\b/,
  /\bmkfs\b|\bdd\s+if=/,
];

/** Nodes whose writes must stay inside the project unless a human agrees. */
const CONFINED = new Set(["write", "edit"]);

/** What a rule is matched against, or undefined when there is nothing to match. */
export function facetOf(action: Action, cwd: string): string | undefined {
  const path = action.input.path;
  if (typeof path === "string" && path !== "") {
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    const inside = relative(cwd, absolute);
    // A path under the working directory reads better relative; anything else
    // keeps its absolute form so a rule cannot match it by accident.
    return inside !== "" && !inside.startsWith("..") ? inside : absolute;
  }

  const command = action.input.command;
  if (typeof command === "string" && command !== "") return command;

  return undefined;
}

const escape = (piece: string) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** Path glob: `*` stops at a separator, `**` crosses them. */
export function matchesPath(value: string, pattern: string): boolean {
  const source = pattern
    .split("**")
    .map((part) => part.split("*").map(escape).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`).test(value);
}

/**
 * Command glob: `*` crosses everything. A command line is not a path, and
 * `bun test*` must cover `bun test tests/a.ts` or the rule is useless.
 */
export function matchesCommand(value: string, pattern: string): boolean {
  return new RegExp(`^${pattern.split("*").map(escape).join(".*")}$`).test(value);
}

/** Nodes matched on a command line rather than a path. */
const COMMANDS = new Set(["shell", "script"]);

function listed(patterns: string[] | undefined, facet: string, node: string): boolean {
  const match = COMMANDS.has(node) ? matchesCommand : matchesPath;
  return (patterns ?? []).some((pattern) => match(facet, pattern));
}

function alwaysAsk(action: Action, facet: string | undefined, cwd: string): boolean {
  if (action.node === "shell" || action.node === "script") {
    const command = typeof action.input.command === "string" ? action.input.command : "";
    if (ALWAYS_ASK_COMMANDS.some((pattern) => pattern.test(command))) return true;
  }

  if (facet === undefined) return false;

  if (CONFINED.has(action.node)) {
    // Absolute here means the facet fell outside the working directory.
    if (isAbsolute(facet)) return true;
    if (listed(ALWAYS_ASK_PATHS, facet, action.node)) return true;
  }
  return false;
}

export function decide(action: Action, policy: Policy, cwd: string): Decision {
  const facet = facetOf(action, cwd);

  // Deny first: the always-ask list exists to stop something being allowed
  // silently, and refusing outright is stricter than asking.
  if (facet !== undefined && listed(policy.deny[action.node], facet, action.node)) return "deny";

  // Then the list no rule may switch off.
  if (alwaysAsk(action, facet, cwd)) return "ask";

  if (facet !== undefined && listed(policy.allow[action.node], facet, action.node)) {
    return "allow";
  }

  return policy.mode === "auto" ? "allow" : "ask";
}
