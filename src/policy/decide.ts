import { isAbsolute, relative, resolve } from "node:path";
import { isReadOnlyCommand } from "./readonly";

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

/**
 * Three rungs of freedom.
 *
 * `plan` looks and proposes and changes nothing, which is what you want while
 * deciding what to do. `ask` is the working default. `auto` is for work you
 * have already decided to trust.
 */
export type Mode = "plan" | "ask" | "auto";

export const MODES: readonly Mode[] = ["plan", "ask", "auto"];
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
  /** What the node does. Reading changes nothing and is never asked about. */
  effect?: "pure" | "write" | "external";
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
  // The spec's log. `approved` is written by a person's keystroke and
  // nothing else; a model that could append it under `auto` would be
  // approving its own plan.
  "**/.vesna/specs/**/events.jsonl",
  ".vesna/specs/**/events.jsonl",
];

/** A shell command that names the spec's log and is not merely reading it. */
const EVENT_LOG = /\.vesna\/specs\/[^\s'"]*events\.jsonl/;

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

  // Nodes name their command differently — shell calls it `command`, the
  // verifier calls it `check` — and a rule has to be possible for all of them.
  for (const field of ["command", "check"]) {
    const value = action.input[field];
    if (typeof value === "string" && value !== "") return value;
  }

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
    if (EVENT_LOG.test(command) && !isReadOnlyCommand(command)) return true;
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

  // A node with nothing to match on cannot be remembered, so asking about it
  // would ask forever. Reading is also simply not worth a question. The effect
  // class the registry already declares is exactly the right line to draw.
  // A node declares its worst case, but a command's real effect is visible in
  // the command. Asking permission to run `ls` teaches the user to stop
  // reading the question, which costs more than it ever saves.
  const harmless =
    action.effect === "pure" ||
    (action.node === "shell" &&
      typeof action.input.command === "string" &&
      isReadOnlyCommand(action.input.command));

  // Deny first: the always-ask list exists to stop something being allowed
  // silently, and refusing outright is stricter than asking.
  if (facet !== undefined && listed(policy.deny[action.node], facet, action.node)) return "deny";

  // Then the list no rule may switch off.
  if (alwaysAsk(action, facet, cwd)) return "ask";

  if (harmless) return "allow";

  // Nothing changes in plan mode, and no rule opens a hole in it: a mode that
  // some earlier "always allow" could quietly defeat would not be worth having.
  if (policy.mode === "plan") return "deny";

  if (facet !== undefined && listed(policy.allow[action.node], facet, action.node)) {
    return "allow";
  }

  return policy.mode === "auto" ? "allow" : "ask";
}
