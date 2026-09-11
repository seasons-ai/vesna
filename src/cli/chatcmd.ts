import { PRESETS, findPreset, needsAddress, needsOauth, type Preset } from "../providers/catalog";
import type { Approvable, SpecTree } from "../spec/project";

export interface ChatCommand {
  name: string;
  help: string;
}

export const CHAT_COMMANDS: ChatCommand[] = [
  { name: "cost", help: "tokens and cost so far" },
  { name: "mode", help: "plan, ask or auto (shift-tab cycles)" },
  { name: "spec", help: "list specs, /spec new <name>, /spec open <slug>" },
  { name: "approve", help: "approve the spec or the plan: /approve spec, /approve plan" },
  { name: "chats", help: "show or hide the conversations column (ctrl-b)" },
  { name: "history", help: "conversations from this folder: /history [all]" },
  { name: "resume", help: "reopen one: /resume 2" },
  { name: "theme", help: "list palettes, or switch: /theme hanami" },
  { name: "copy", help: "copy the last answer to the clipboard" },
  { name: "clear", help: "start a fresh conversation" },
  { name: "provider", help: "list services, or switch: /provider ollama" },
  { name: "model", help: "list models, or switch: /model qwen3" },
  { name: "help", help: "this list" },
  { name: "exit", help: "leave" },
];

/**
 * The commands the line-based chat implements.
 *
 * `CHAT_COMMANDS` is the full-screen chat's list, and `src/cli/chat.ts` — what
 * `--plain` and every non-TTY run gets — handles only these. The rest need a
 * screen: a conversations column, a spec pane, a palette, a provider switch
 * that rebuilds a running session.
 */
export const PLAIN_CHAT_COMMANDS: readonly string[] = [
  "cost",
  "clear",
  "help",
  "exit",
];

/** What to say when a command exists, but not on this surface. */
export function fullScreenOnly(name: string): string {
  return `/${name} needs the full-screen chat — run \`vesna\` in a terminal, without --plain`;
}

/** The line under `/help` in the line-based chat, so the rest are not a secret. */
export function moreInFullScreen(): string {
  return "the full-screen chat has more: /provider, /model, /mode, /spec, /history, /theme";
}

export type ChatInput =
  | { kind: "blank" }
  | { kind: "message"; text: string }
  | { kind: "command"; name: string; argument: string }
  | { kind: "unknown"; name: string };

export function parseChatInput(line: string): ChatInput {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "blank" };
  if (!trimmed.startsWith("/")) return { kind: "message", text: trimmed };

  const withoutSlash = trimmed.slice(1);
  const space = withoutSlash.indexOf(" ");
  const name = space === -1 ? withoutSlash : withoutSlash.slice(0, space);
  const argument = space === -1 ? "" : withoutSlash.slice(space + 1).trim();

  if (!CHAT_COMMANDS.some((command) => command.name === name)) {
    return { kind: "unknown", name };
  }
  return { kind: "command", name, argument };
}

export type ApproveOutcome =
  | { kind: "approved"; what: Approvable; message: string }
  | { kind: "refused"; message: string };

/**
 * The one event no tool can emit. A person typed this; that is the whole
 * meaning of it, so the wording says what the keystroke unlocked.
 *
 * `canWrite` is whether there is anywhere to put the event — a `SpecSink`
 * wired up. Without one, saying "approved" would announce an effect that
 * never happened: nothing was written, so the refusal has to say so in its
 * own words rather than reuse the "approved" wording in a different tone.
 */
export function approveOutcome(
  argument: string,
  tree: SpecTree | null,
  canWrite: boolean,
): ApproveOutcome {
  if (tree === null) return { kind: "refused", message: "nothing to approve — no spec is open" };
  if (!canWrite) {
    return {
      kind: "refused",
      message: "cannot approve — nothing is recording this conversation",
    };
  }
  const what = argument.trim();
  if (what === "spec") {
    return { kind: "approved", what, message: "approved: spec — the plan can be written now" };
  }
  if (what === "plan") {
    return { kind: "approved", what, message: "approved: plan — /build will run it" };
  }
  return { kind: "refused", message: 'approve what? "spec" or "plan"' };
}

/** One line per catalog entry: id, where its credential comes from, label. */
export function describeProviders(
  current: string,
  env: Record<string, string | undefined>,
): string[] {
  // Measured, not guessed: `needs $OPENROUTER_API_KEY` is 25 characters, so a
  // fixed 22-column middle ran the label straight into the variable name.
  const ids = column(PRESETS.map((preset) => preset.id));
  const needs = column(PRESETS.map((preset) => requirement(preset, env)));
  return PRESETS.map((preset) => {
    const mark = preset.id === current ? "  (current)" : "";
    return `${preset.id.padEnd(ids)}${requirement(preset, env).padEnd(needs)}${preset.label}${mark}`;
  });
}

/** Wide enough for the longest entry, with a gap after it. */
function column(values: string[]): number {
  return Math.max(...values.map((value) => value.length)) + 2;
}

/**
 * The middle column: what stands between this preset and a working call.
 *
 * Two of them need something that is not a credential at all, and saying "no
 * key needed" of those was true and useless — `custom` has no address, and
 * `subscription` needs an oauth block only a project config can carry.
 */
function requirement(preset: Preset, env: Record<string, string | undefined>): string {
  if (needsAddress(preset)) return "needs a baseUrl";
  if (needsOauth(preset)) return "oauth in config.yaml";
  if (preset.env === undefined) {
    return preset.auth === "codex" ? "borrowed from codex" : "no key needed";
  }
  return env[preset.env] ? `$${preset.env}` : `needs $${preset.env}`;
}

/**
 * The two moving parts of the chat header: which model is answering, and which
 * service it is being asked through.
 *
 * It takes the model and the preset rather than a `VesnaConfig` on purpose.
 * The config is a snapshot of how the process started, and after `/provider`
 * or `/model` the pair actually in effect lives on the provider handle — the
 * header is the one line the user reads to know who is answering, so it has to
 * be given the live values rather than reach for a frozen object itself.
 *
 * The service is the preset's id, not `VesnaConfig.provider`, which is the
 * wire dialect: that value is `openai` for Groq, OpenRouter, Ollama, LM Studio
 * and OpenAI alike, so the header used to name the protocol rather than who is
 * on the other end of it. The id is also the argument `/provider` takes.
 */
export function describeHeader(model: string, preset: Preset): { model: string; service: string } {
  return { model, service: preset.id };
}

export type SwitchOutcome =
  | { kind: "unknown"; message: string }
  /** A real preset that names no address, so there is nowhere to switch to yet. */
  | { kind: "unaddressed"; message: string }
  /** A real preset that only a hand-written project file can complete. */
  | { kind: "handwritten"; message: string }
  | { kind: "pinned"; message: string }
  | { kind: "switched"; message: string };

export function switchOutcome(
  id: string,
  state: {
    pinned: boolean;
    dropped: number;
    /**
     * The preset actually in effect, from the resolved config — never the
     * raw `.vesna/config.yaml` string. `pinned` is true whenever that file
     * names a provider at all, even a typo that resolves to nothing and
     * falls back to a default (src/cli/config.ts), so naming the pin from
     * the raw string here could tell the user "this project pins gruq" when
     * nothing of the sort was ever resolved.
     */
    active?: string;
  },
): SwitchOutcome {
  const preset = findPreset(id);
  if (preset === undefined) {
    return { kind: "unknown", message: `no provider called "${id}" — /provider for the list` };
  }
  if (needsAddress(preset)) {
    // Ahead of the pinned branch on purpose: that branch persists the machine
    // default, and a machine default with no address is the same bug one run
    // later. `custom` is the only preset this catches today — it exists to be
    // pointed somewhere, and nothing in a chat can point it.
    return {
      kind: "unaddressed",
      message:
        `${preset.id} has no address of its own — put a "baseUrl:" for it in ` +
        "~/.vesna/settings.yaml or .vesna/config.yaml, then start Vesna again",
    };
  }
  if (needsOauth(preset)) {
    // The same reasoning as `needsAddress` above, on the other half a chat
    // cannot supply. `subscription` needs an `oauth` block, and the only file
    // that carries one is a hand-written `.vesna/config.yaml` in some one
    // directory — so a switch that consults this project's block and then
    // writes `provider: subscription` into `~/.vesna/settings.yaml` states a
    // fact about this folder in the file every other folder reads. Ahead of
    // the pinned branch for the same reason: that branch persists the machine
    // default too.
    return {
      kind: "handwritten",
      message:
        `${preset.id} is set up by hand — put an "oauth:" block (issuer, clientId, ` +
        "baseUrl) for it in .vesna/config.yaml, then start Vesna again",
    };
  }
  if (state.pinned) {
    const named = state.active !== undefined ? ` (currently ${state.active})` : "";
    return {
      kind: "pinned",
      message:
        `this project pins its provider${named} in .vesna/config.yaml — ` +
        `changed the machine default to ${id}, unchanged here`,
    };
  }
  const base = `provider: ${preset.id}  model ${preset.model}`;
  if (state.dropped === 0) return { kind: "switched", message: base };
  const plural = state.dropped === 1 ? "call" : "calls";
  return {
    kind: "switched",
    message: `${base}  ·  dropped ${state.dropped} unanswered tool ${plural}`,
  };
}

/** The wording for a switch whose provider rejected the connection. */
export function switchFailed(id: string, error: Error): string {
  return `could not switch to ${id}: ${error.message}`;
}

/**
 * The wording for a switch refused because the service cannot authenticate.
 *
 * `problem` and `hints` come from `src/cli/preflight.ts`, so this says exactly
 * what `vesna auth` and the check before a conversation say — a switch that
 * succeeded here and then failed on the next run is the disagreement that
 * module exists to prevent.
 */
export function switchBlocked(
  id: string,
  problem: string,
  hints: string[],
): { message: string; hints: string[] } {
  return { message: `not switching to ${id}: ${problem}`, hints };
}

/** One line per model on offer, the current one marked. */
export function describeModels(models: string[], current: string): string[] {
  return models.map((model) => `${model}${model === current ? "  (current)" : ""}`);
}

export type ModelSwitchOutcome =
  | { kind: "pinned"; message: string }
  /** Pinned here, and no machine default to move the model onto. */
  | { kind: "no-default"; message: string }
  /** Pinned here, and the machine default is a different service entirely. */
  | { kind: "other-service"; message: string }
  | { kind: "switched"; message: string };

/**
 * `/model` never rejects a name as unknown — the roster comes from the
 * endpoint itself or a fixed list, not a catalog to validate against — so
 * unlike `switchOutcome` there is no "unknown" case here. What it does share
 * with `/provider` is which file gets to say no: a project that pins its
 * provider in `.vesna/config.yaml` also owns the model that goes with it, so
 * the same `pinned` flag applies and the switch only ever touches the machine
 * default.
 *
 * `dropped` exists for the same reason it does in `switchOutcome`: switching
 * rebuilds the session, and a rebuild can strand an unanswered tool call left
 * behind by an earlier interrupt. The dialect never changes underneath
 * `/model`, so in practice this is always 0 — but the count comes from the
 * same `carryHistory` call `/provider` makes, not a special case.
 *
 * `machineProvider` is the service `~/.vesna/settings.yaml` already names, and
 * it is what the pinned message reports. A model belongs to a provider: the
 * pinned branch used to write `provider: <this project's preset>` alongside
 * the new model, so setting a model in a directory that pins codex moved the
 * whole machine default onto codex. When there is no machine default at all
 * there is nothing to move a model onto — a `model:` with no provider beside
 * it is inherited by nobody (see `loadConfig`) — so that is its own outcome
 * rather than a file written for the look of it.
 *
 * `active` is the service the name came from: `/model` with no argument lists
 * the roster of whatever is answering here, so the name the user then types is
 * that service's. Moving it onto the machine default is only honest while the
 * two are the same service. Where they differ — machine default ollama, this
 * directory pinning codex — writing the model alone still produces a settings
 * file whose provider and model come from two different places, which is the
 * `/provider` tuple split again on the model axis. Required rather than
 * optional so a call site cannot leave it out and get the old behaviour back.
 */
export function modelSwitchOutcome(
  model: string,
  state: { pinned: boolean; dropped: number; active: string; machineProvider?: string },
): ModelSwitchOutcome {
  if (state.pinned && state.machineProvider === undefined) {
    return {
      kind: "no-default",
      message:
        "this project pins its provider in .vesna/config.yaml, and there is no machine " +
        "default to change — nothing happened",
    };
  }
  if (state.pinned && state.machineProvider !== state.active) {
    return {
      kind: "other-service",
      message:
        `this project pins ${state.active} in .vesna/config.yaml, and the machine default ` +
        `is ${state.machineProvider} — ${model} is a ${state.active} model, so it cannot ` +
        `become the ${state.machineProvider} default; nothing happened`,
    };
  }
  if (state.pinned) {
    return {
      kind: "pinned",
      message:
        "this project pins its provider in .vesna/config.yaml — changed the machine " +
        `default model for ${state.machineProvider} to ${model}, unchanged here`,
    };
  }
  const base = `model: ${model}`;
  if (state.dropped === 0) return { kind: "switched", message: base };
  const plural = state.dropped === 1 ? "call" : "calls";
  return {
    kind: "switched",
    message: `${base}  ·  dropped ${state.dropped} unanswered tool ${plural}`,
  };
}
