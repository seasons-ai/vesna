/**
 * The server's life: spawn `<command> <args...> serve`, `initialize`, check
 * the capabilities, hand back a client — and later shut it down within a
 * ceiling. Reports through callbacks and takes the spawner as an argument,
 * so it runs under `bun test` with a fake child and no `vscode`.
 *
 * The extension never restarts the server on its own: an exit is reported
 * as a status and that is all. Only a stop this module was asked for goes
 * unreported, so a restart or a too-old server never reads as a crash.
 */
import { createClient, RpcError, type Client, type Duplex } from "./client";
import { REQUIRED_CAPABILITIES, type InitializeResult, type Notification } from "./protocol";
import type { ServerStatus } from "./state";

/** The part of a Node `ChildProcess` this module touches — a real one fits, so does a fake. */
export interface ChildLike {
  stdin: {
    write(chunk: Uint8Array): boolean;
    end(): void;
    on(event: "error", handler: (error: Error) => void): unknown;
  } | null;
  stdout: { on(event: "data", handler: (chunk: Buffer) => void): unknown } | null;
  stderr: { on(event: "data", handler: (chunk: Buffer) => void): unknown } | null;
  on(event: "exit", handler: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", handler: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
  readonly exitCode: number | null;
  readonly signalCode?: string | null;
}

export type Spawner = (
  command: string,
  args: string[],
  opts: { cwd: string; stdio: ["pipe", "pipe", "pipe"] },
) => ChildLike;

export const CLIENT_NAME = "vscode-vesna";
export const STDERR_LINES = 20;
export const STOP_CEILING_MS = 12_000;

export interface StartOptions {
  command: string;
  args: string[];
  cwd: string;
  extensionVersion: string;
  spawn: Spawner;
  onStatus: (status: ServerStatus) => void;
  onNotification: (n: Notification) => void;
}

export interface Started {
  client: Client | null;
  child: ChildLike | null;
}

/** The last `count` lines of `text`, without a trailing newline. */
export function lastLines(text: string, count: number): string {
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

/** `text` cut to its last `count` lines, a trailing newline (and an unfinished last line) kept as is. */
function tail(text: string, count: number): string {
  const parts = text.split("\n");
  return parts.slice(Math.max(0, parts.length - count - 1)).join("\n");
}

/** Whether every required capability is present at or above its required value. */
export function capable(capabilities: Record<string, number> | undefined): boolean {
  if (capabilities === null || typeof capabilities !== "object") return false;
  return Object.entries(REQUIRED_CAPABILITIES).every(([key, needed]) => {
    const have = capabilities[key];
    return typeof have === "number" && have >= needed;
  });
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function duplexOf(child: ChildLike): Duplex {
  return {
    write(bytes) {
      child.stdin?.write(bytes);
    },
    onData(handler) {
      child.stdout?.on("data", (chunk) => handler(new Uint8Array(chunk)));
    },
    onClose(handler) {
      child.on("exit", (code) => handler(code));
    },
    end() {
      child.stdin?.end();
    },
  };
}

/** Children whose stop this module asked for — their exit is not news. */
const stopping = new WeakSet<ChildLike>();

const gone = (child: ChildLike): boolean => child.exitCode !== null || (child.signalCode ?? null) !== null;

export async function startServer(opts: StartOptions): Promise<Started> {
  const { onStatus, onNotification } = opts;
  onStatus({ kind: "starting" });

  let child: ChildLike;
  try {
    child = opts.spawn(opts.command, [...opts.args, "serve"], { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    onStatus(
      isEnoent(error)
        ? { kind: "notFound", command: opts.command }
        : { kind: "exited", code: null, stderr: (error as Error)?.message ?? String(error) },
    );
    return { client: null, child: null };
  }

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = tail(stderr + chunk.toString(), STDERR_LINES);
  });
  // Writing after the server left raises EPIPE on stdin; nobody needs to hear it.
  child.stdin?.on("error", () => {});

  const report = (status: ServerStatus): void => {
    if (!stopping.has(child)) onStatus(status);
  };

  // Whichever comes first: the handshake, or the process going away.
  let fail!: (reason: "gone") => void;
  const failed = new Promise<"gone">((resolve) => {
    fail = resolve;
  });

  child.on("error", (error) => {
    report(
      isEnoent(error)
        ? { kind: "notFound", command: opts.command }
        : { kind: "exited", code: null, stderr: error.message },
    );
    fail("gone");
  });

  const client = createClient(duplexOf(child));
  client.onClose((code) => {
    report({ kind: "exited", code, stderr: lastLines(stderr, STDERR_LINES) });
    fail("gone");
  });

  // Nothing reaches the panel before the handshake's own state has: what
  // arrives in the same chunk as the response is held until then.
  let ready = false;
  const held: Notification[] = [];
  client.on((n) => {
    if (ready) onNotification(n);
    else held.push(n);
  });

  let result: InitializeResult;
  try {
    const outcome = await Promise.race([
      client.initialize({ clientName: CLIENT_NAME, clientVersion: opts.extensionVersion }),
      failed,
    ]);
    if (outcome === "gone") return { client: null, child: null };
    result = outcome;
  } catch (error) {
    // A closed pipe was already reported by `onClose`; anything else is the
    // server refusing the handshake, which is as good as it having left.
    if (!(error instanceof RpcError && error.code === -32000)) {
      report({ kind: "exited", code: null, stderr: (error as Error)?.message ?? String(error) });
      void stopServer(client, child);
    }
    return { client: null, child: null };
  }

  if (!capable(result.capabilities)) {
    report({ kind: "tooOld", server: result.serverVersion, extension: opts.extensionVersion });
    await stopServer(client, child);
    return { client: null, child: null };
  }

  onNotification({ method: "state", params: result.state });
  for (const n of held.splice(0)) onNotification(n);
  ready = true;
  onStatus({ kind: "up" });
  return { client, child };
}

function waitExit(child: ChildLike, ceilingMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (gone(child)) return resolve(true);
    const timer = setTimeout(() => resolve(false), ceilingMs);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * `shutdown`, then `exit`, then wait for the process up to `ceilingMs`
 * (the server's own ceiling is 10 s), then kill it. The ceiling spans the
 * whole of it: a server that never answers `shutdown` is killed too.
 */
export async function stopServer(client: Client, child: ChildLike, ceilingMs = STOP_CEILING_MS): Promise<void> {
  stopping.add(child);
  if (gone(child)) return;
  const left = waitExit(child, ceilingMs);
  void (async () => {
    try {
      await client.shutdown();
    } catch {
      // The server may already be gone, or refuse: `exit` goes out regardless.
    }
    try {
      client.exit();
    } catch {
      // Nothing to write to: the process is leaving or has left.
    }
  })();
  if (!(await left)) child.kill("SIGKILL");
}
