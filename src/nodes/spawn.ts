/**
 * Spawning a child that an interrupt can actually reach.
 *
 * Bun.spawn takes a signal, but on its own an abort leaves the caller with a
 * resolved-looking process and no error: the turn moves on while the command
 * keeps writing files. Worse, a child that ignores SIGTERM survives entirely.
 * So the abort is wired by hand — terminate, wait a moment, then kill — and
 * the promise rejects, because a node that returns normally after being
 * interrupted is indistinguishable from one that succeeded.
 */

/** How long a child gets to exit on SIGTERM before it is killed outright. */
const GRACE_MS = 300;

export class AbortedError extends Error {
  constructor() {
    super("interrupted");
    this.name = "AbortedError";
  }
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SpawnOptions {
  cwd: string;
  signal: AbortSignal;
  env?: Record<string, string>;
  /** Killed after this long regardless of the signal. */
  timeoutMs?: number;
}

export async function spawnInterruptible(
  argv: string[],
  options: SpawnOptions,
): Promise<SpawnResult> {
  // Checked before spawning: an already-aborted turn must not start the work
  // at all, or an interrupt becomes a race with process creation.
  if (options.signal.aborted) throw new AbortedError();

  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(options.env ? { env: options.env } : {}),
  });

  let aborted = false;
  let killer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    aborted = true;
    child.kill("SIGTERM");
    // SIGTERM is a request. A child that traps it needs the one that cannot
    // be trapped, and the whole point is that nothing outlives the turn.
    killer = setTimeout(() => child.kill("SIGKILL"), GRACE_MS);
  };

  options.signal.addEventListener("abort", stop, { once: true });
  const timer =
    options.timeoutMs === undefined ? undefined : setTimeout(stop, options.timeoutMs);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const code = await child.exited;
    if (aborted && options.signal.aborted) throw new AbortedError();
    return { stdout, stderr, code };
  } finally {
    options.signal.removeEventListener("abort", stop);
    if (timer !== undefined) clearTimeout(timer);
    if (killer !== undefined) clearTimeout(killer);
  }
}
