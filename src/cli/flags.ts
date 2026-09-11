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
