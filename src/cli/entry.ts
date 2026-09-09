import pkg from "../../package.json" with { type: "json" };

/**
 * How the binary is addressed before any command runs.
 *
 * Asking for help is not a mistake, and it used to exit 2 — which made
 * `vesna --help` fail a shell script and any CI step that ran it.
 */

export const VERSION: string = pkg.version;

export function isHelp(command: string | undefined): boolean {
  return command === undefined || command === "help" || command === "--help" || command === "-h";
}

export function isVersion(command: string | undefined): boolean {
  return command === "version" || command === "--version" || command === "-v";
}
