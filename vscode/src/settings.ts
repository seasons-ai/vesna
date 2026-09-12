/**
 * The two settings the server start reads: `vesna.command` (default
 * `vesna`, resolved on PATH) and `vesna.args` (default none). Read once per
 * server start, through a getter so this stays free of `vscode`.
 *
 * The args sit between the command and `serve`: `<command> <args...>
 * serve`. That is what lets `vesna.command: "bun"` with `vesna.args:
 * ["/path/to/bin/vesna"]` run a checkout — `serve` itself takes no
 * options, so nothing is lost by putting it last.
 */
export interface Settings {
  command: string;
  args: string[];
}

export const DEFAULT_COMMAND = "vesna";

export function readSettings(get: (key: string) => unknown): Settings {
  const command = get("command");
  const args = get("args");
  return {
    command: typeof command === "string" && command.trim() !== "" ? command.trim() : DEFAULT_COMMAND,
    args: Array.isArray(args) && args.every((a) => typeof a === "string") ? [...(args as string[])] : [],
  };
}
