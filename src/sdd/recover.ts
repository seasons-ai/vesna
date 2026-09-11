import { existsSync, readFileSync } from "node:fs";
import type { SpecTree } from "../spec/project";

/**
 * Whether a spec's build is running, dead, or there is none.
 *
 * A killed process writes no `build.stopped`: the log says `building` and
 * nothing in it will ever say otherwise. What tells a dead build from a live
 * one is the lock — a live process holds it, a dead one's pid is gone. The
 * answer is a person's to act on; nothing here acts.
 */
export type BuildState = "running" | "dead" | "idle";

export function buildState(tree: SpecTree, lockAlive: boolean): BuildState {
  if (!tree.building) return "idle";
  return lockAlive ? "running" : "dead";
}

/** The task a build left running — the one a resume continues or a retry redoes. */
export function inFlightTask(tree: SpecTree): string | undefined {
  return tree.tasks.find((task) => task.state === "running")?.id;
}

/** The pid a lock file names, or null: no file, unreadable, or not a real pid. */
export function readLockPid(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const pid = Number(JSON.parse(readFileSync(path, "utf8")).pid);
    // pid 0 is "this process group" to kill(2) and would read as alive forever.
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and is not ours — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
