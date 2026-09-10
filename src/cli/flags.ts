/**
 * Whether a boolean flag was passed at all, any value included.
 *
 * `parseFlags` assigns the *following* argument as a flag's value whenever
 * that argument does not itself start with `--` — so `--dry-run ""` sets
 * `flags["dry-run"]` to the empty string rather than leaving it bare. A
 * presence check has to use this, not `flags[name]` truthiness, or an empty
 * string reads as "not passed" in exactly the case that matters most: a flag
 * that gates something.
 */
export function isFlagSet(flags: Record<string, string>, name: string): boolean {
  return flags[name] !== undefined;
}

/**
 * `--name value` and bare `--name`.
 *
 * A bare flag must not consume what follows it: `--dry-run --path out.txt`
 * has to leave `path` set, or the run fails claiming an input is missing.
 */
export function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) continue;

    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[arg.slice(2)] = "true";
      continue;
    }
    flags[arg.slice(2)] = next;
    index += 1;
  }
  return flags;
}
