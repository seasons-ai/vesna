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

import { readdirSync, readFileSync } from "node:fs";

/** How long a child gets to exit on SIGTERM before it is killed outright. */
const GRACE_MS = 300;

/**
 * Every process under `pid`, deepest first.
 *
 * `/bin/sh -c "cmd"` is dash on Linux, and dash forks `cmd` rather than
 * exec-ing it; bash on macOS execs a lone command. So a signal to the child
 * pid reaches the real work on one platform and only the shell on the other,
 * where the work survives as an orphan holding the pipes — the abort lands
 * five seconds late and the file it was meant to prevent gets written. The
 * only signal that reaches everything is one sent to every descendant.
 *
 * Linux is read from /proc, which needs no tools; elsewhere `pgrep -P`.
 */
export function descendantsOf(pid: number): number[] {
  const children = new Map<number, number[]>();
  if (process.platform === "linux") {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        // Field 4 of /proc/<pid>/stat is the parent pid; the comm field
        // before it may contain spaces, so split after its closing paren.
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        if (!children.has(ppid)) children.set(ppid, []);
        children.get(ppid)!.push(Number(entry));
      } catch {
        // Gone between readdir and read.
      }
    }
  } else {
    const walk = (parent: number) => {
      const out = Bun.spawnSync(["pgrep", "-P", String(parent)]);
      const kids = out.stdout.toString().trim().split("\n").filter(Boolean).map(Number);
      if (kids.length > 0) children.set(parent, kids);
      for (const kid of kids) walk(kid);
    };
    walk(pid);
  }
  const found: number[] = [];
  const visit = (parent: number) => {
    for (const kid of children.get(parent) ?? []) {
      visit(kid);
      found.push(kid);
    }
  };
  visit(pid);
  return found;
}

export function killAll(pids: number[], signal: "SIGTERM" | "SIGKILL"): void {
  for (const target of pids) {
    try {
      process.kill(target, signal);
    } catch {
      // Already gone.
    }
  }
}

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
  /** True when the ceiling, not the signal, stopped the child. */
  timedOut: boolean;
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
  let timedOut = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  // Resolved once the SIGKILL sweep below has actually run. A backgrounded
  // grandchild that has released the pipes (`cmd >/dev/null 2>&1 & wait`)
  // lets `child.exited` resolve the moment the root dies from SIGTERM, well
  // before GRACE_MS is up — so without waiting for this, the `finally` below
  // would cancel the sweep before it ever fires and the grandchild survives.
  let swept: Promise<void> | undefined;

  const stop = () => {
    if (aborted) return;
    aborted = true;
    // The tree is captured BEFORE the first signal. Once the shell dies its
    // children are reparented to init and no walk from child.pid finds them.
    const tree = [...descendantsOf(child.pid), child.pid];
    // SIGTERM goes to the root only. Sending it down the tree kills a
    // well-behaved `sleep` under a script that traps TERM, and the script
    // then runs its next line — the write the abort was meant to prevent —
    // inside the grace period. The root gets its chance to exit cleanly.
    child.kill("SIGTERM");
    // SIGTERM is a request. A child that traps it needs the one that cannot
    // be trapped, and the whole point is that nothing outlives the turn — so
    // the kill goes to everything captured, deepest first, plus anything
    // those have spawned since.
    swept = new Promise((resolve) => {
      killer = setTimeout(() => {
        const now = new Set<number>();
        for (const pid of tree) for (const kid of descendantsOf(pid)) now.add(kid);
        for (const pid of tree) now.add(pid);
        killAll([...now], "SIGKILL");
        resolve();
      }, GRACE_MS);
    });
  };

  options.signal.addEventListener("abort", stop, { once: true });
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          stop();
        }, options.timeoutMs);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const code = await child.exited;
    // The root exiting says nothing about the rest of the tree: a
    // backgrounded grandchild can outlive it. On the kill path, the promise
    // must not settle until the sweep has actually run.
    if (aborted) await swept;
    if (aborted && options.signal.aborted) throw new AbortedError();
    return { stdout, stderr, code, timedOut };
  } finally {
    options.signal.removeEventListener("abort", stop);
    if (timer !== undefined) clearTimeout(timer);
    // Only cancel the sweep on the normal, non-aborted path — once `stop()`
    // has run, the sweep must complete (awaited above), never be cut short.
    if (!aborted && killer !== undefined) clearTimeout(killer);
  }
}
