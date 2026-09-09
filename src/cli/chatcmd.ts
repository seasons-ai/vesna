export interface ChatCommand {
  name: string;
  help: string;
}

export const CHAT_COMMANDS: ChatCommand[] = [
  { name: "crystallize", help: "freeze this conversation into a flow: /crystallize <name>" },
  { name: "cost", help: "tokens and cost so far" },
  { name: "history", help: "conversations from this folder: /history [all]" },
  { name: "resume", help: "reopen one: /resume 2" },
  { name: "theme", help: "list palettes, or switch: /theme hanami" },
  { name: "copy", help: "copy the last answer to the clipboard" },
  { name: "clear", help: "start a fresh conversation" },
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
