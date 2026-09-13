/**
 * The two message shapes between the webview and the extension host, and
 * the one parse the composer does. No React, no DOM — `test/bridge.test.ts`
 * imports this under Bun.
 */
import type { PanelModel } from "../src/state";
import { COMMAND_NAMES } from "../src/words";

/** Webview → host. Exactly these five; nothing else crosses. */
export type ToHost =
  | { kind: "send"; text: string }
  | { kind: "command"; name: string; argument: string; typed: string }
  | { kind: "answer"; id: string; value: string }
  | { kind: "interrupt" }
  | { kind: "restart" };

/**
 * Host → webview: the whole model every time it changes, or a line the
 * host could not deliver (no server, or the request rejected) handed back
 * so the composer can put it where it was.
 */
export type ToWebview = { kind: "model"; model: PanelModel } | { kind: "rejected"; text: string };

export function isRejected(message: unknown): message is { kind: "rejected"; text: string } {
  return (
    message !== null &&
    typeof message === "object" &&
    (message as { kind?: unknown }).kind === "rejected" &&
    typeof (message as { text?: unknown }).text === "string"
  );
}

/**
 * The command names the line could still become: only while it is a bare
 * `/prefix` with no space yet — after the space the name is decided. The
 * match is case-insensitive; the list is `COMMAND_NAMES` in its order.
 */
export function completions(line: string): string[] {
  if (!line.startsWith("/") || line.includes(" ") || line.includes("\n")) return [];
  const prefix = line.slice(1).toLowerCase();
  return COMMAND_NAMES.filter((name) => name.startsWith(prefix));
}

/**
 * Splits a composer line the way the root's `parseChatInput` does: trim;
 * a `/` prefix makes a command whose name runs to the first space and whose
 * argument is the rest, trimmed; anything else is a message. Blank → null.
 * Whether the name is a known command is the server's call, not ours.
 */
export function parseLine(line: string): ToHost | null {
  const typed = line.trim();
  if (typed === "") return null;
  if (!typed.startsWith("/")) return { kind: "send", text: typed };
  const withoutSlash = typed.slice(1);
  const space = withoutSlash.indexOf(" ");
  const name = space === -1 ? withoutSlash : withoutSlash.slice(0, space);
  const argument = space === -1 ? "" : withoutSlash.slice(space + 1).trim();
  return { kind: "command", name, argument, typed };
}

/** The part of VS Code's webview API this panel uses. */
export interface HostApi {
  postMessage(message: ToHost): void;
}

let host: HostApi | null = null;

/** `index.tsx` calls this once with the result of `acquireVsCodeApi()`, which VS Code hands out once. */
export function bindHost(api: HostApi): void {
  host = api;
}

export function post(message: ToHost): void {
  if (host === null) throw new Error("the webview is not bound to a host");
  host.postMessage(message);
}
