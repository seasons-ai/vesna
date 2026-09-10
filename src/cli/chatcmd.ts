import { PRESETS, findPreset } from "../providers/catalog";

export interface ChatCommand {
  name: string;
  help: string;
}

export const CHAT_COMMANDS: ChatCommand[] = [
  { name: "crystallize", help: "freeze this conversation into a flow: /crystallize <name>" },
  { name: "cost", help: "tokens and cost so far" },
  { name: "mode", help: "plan, ask or auto (shift-tab cycles)" },
  { name: "spec", help: "list specs, /spec new <name>, /spec open <slug>" },
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

/** One line per catalog entry: id, where its credential comes from, label. */
export function describeProviders(
  current: string,
  env: Record<string, string | undefined>,
): string[] {
  return PRESETS.map((preset) => {
    const mark = preset.id === current ? "  (current)" : "";
    const credential =
      preset.env === undefined
        ? preset.auth === "codex"
          ? "borrowed from codex"
          : "no key needed"
        : env[preset.env]
          ? `$${preset.env}`
          : `needs $${preset.env}`;
    return `${preset.id.padEnd(13)}${credential.padEnd(22)}${preset.label}${mark}`;
  });
}

export type SwitchOutcome =
  | { kind: "unknown"; message: string }
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

/** One line per model on offer, the current one marked. */
export function describeModels(models: string[], current: string): string[] {
  return models.map((model) => `${model}${model === current ? "  (current)" : ""}`);
}

export type ModelSwitchOutcome =
  | { kind: "pinned"; message: string }
  | { kind: "switched"; message: string };

/**
 * `/model` never rejects a name as unknown — the roster comes from the
 * endpoint itself or a fixed list, not a catalog to validate against — so
 * unlike `switchOutcome` there is no "unknown" case here. What it does share
 * with `/provider` is which file gets to say no: a project that pins its
 * provider in `.vesna/config.yaml` also owns the model that goes with it, so
 * the same `pinned` flag applies and the switch only ever touches the machine
 * default.
 */
export function modelSwitchOutcome(model: string, state: { pinned: boolean }): ModelSwitchOutcome {
  if (state.pinned) {
    return {
      kind: "pinned",
      message:
        "this project pins its provider in .vesna/config.yaml — " +
        `changed the machine default model to ${model}, unchanged here`,
    };
  }
  return { kind: "switched", message: `model: ${model}` };
}
