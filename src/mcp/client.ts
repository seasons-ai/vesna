/**
 * An MCP client over stdio: newline-delimited JSON-RPC 2.0 to a process this
 * client spawns. It implements the part Vesna uses — `initialize`, the
 * `notifications/initialized` notification, `tools/list` paged by cursor,
 * `tools/call` — and nothing more; a request the server sends back is
 * refused with `-32601`, since Vesna offers nothing in this version.
 *
 * A server is a state, not an exception. One that cannot start, dies, stays
 * mute past the ceiling, or is closed is `down` with a reason, and every
 * call from then on answers `server <name> is down: <reason>` as an error
 * result the model can read. Nothing restarts it: a person edits the config
 * and starts a new session.
 *
 * The child's environment is `PATH` and `HOME` plus the names the config
 * lists — never the rest of Vesna's environment, so a secret reaches the one
 * server it was named for and no other.
 */
import pkg from "../../package.json" with { type: "json" };
import { descendantsOf, killAll } from "../nodes/spawn";
import { errorResponse, METHOD_NOT_FOUND } from "../serve/rpc";
import { PROTOCOL_VERSION, type McpServerConfig, type McpServerStatus, type McpTool } from "./types";

/** How long a child gets to exit on SIGTERM before it is killed outright. */
const GRACE_MS = 300;
const DEFAULT_INITIALIZE_CEILING_MS = 15_000;
const DEFAULT_CALL_CEILING_MS = 60_000;
/** Variables every server needs to run at all, passed whether named or not. */
const ALWAYS_PASSED = ["PATH", "HOME"];
/** A `tools/list` that pages forever is a broken server, not a large one. */
const MAX_PAGES = 1000;

export interface ChildLike {
  pid: number;
  stdin: { write(s: string): unknown; flush?(): unknown; end(): unknown };
  stdout: AsyncIterable<Uint8Array>;
  /** Not read by the client; a test may pipe it to watch the server. */
  stderr?: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

export type Spawner = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; cwd: string },
) => ChildLike;

export interface CallResult {
  text: string;
  isError: boolean;
}

export interface McpClient {
  /** Starts the server and lists its tools. Never rejects: a server that
   * fails is `down` and the list is empty. */
  initialize(): Promise<{ tools: McpTool[] }>;
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallResult>;
  /** Stops the server; safe to call more than once. */
  close(): Promise<void>;
  status(): McpServerStatus;
  /** Why the server is down, once it is. */
  problem(): string | undefined;
}

export interface McpClientOptions {
  spawn?: Spawner;
  /** Vesna's own environment, filtered before the child sees any of it. */
  env: Record<string, string | undefined>;
  cwd: string;
  initializeCeilingMs?: number;
  callCeilingMs?: number;
}

/** The default spawner: Bun's, with stdio piped and the server's stderr dropped. */
export function bunSpawner(
  command: string,
  args: string[],
  options: { env: Record<string, string>; cwd: string; stderr?: "pipe" | "ignore" },
): ChildLike {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: options.stderr ?? "ignore",
  });
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    ...(options.stderr === "pipe" ? { stderr: child.stderr as AsyncIterable<Uint8Array> } : {}),
    exited: child.exited,
    kill: (signal) => child.kill(signal),
  };
}

/** What the child may see of Vesna's environment: the essentials plus the names listed. */
export function childEnv(config: McpServerConfig, env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [...ALWAYS_PASSED, ...config.env]) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

type RpcErrorShape = { code: number; message: string };

/** How a request came back — or did not. */
type Outcome =
  | { kind: "result"; result: unknown }
  | { kind: "error"; error: RpcErrorShape }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "down" };

interface Pending {
  settle(outcome: Outcome): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function seconds(ms: number): string {
  return `${ms / 1000} s`;
}

/** A `tools/list` item as `McpTool`; anything without a name is not a tool. */
function toTool(item: unknown): McpTool | undefined {
  if (!isRecord(item) || typeof item.name !== "string" || item.name === "") return undefined;
  const annotations = isRecord(item.annotations) ? item.annotations : {};
  return {
    name: item.name,
    description: typeof item.description === "string" ? item.description : "",
    inputSchema: isRecord(item.inputSchema) ? item.inputSchema : { type: "object", properties: {} },
    readOnlyHint: annotations.readOnlyHint === true,
  };
}

/** The `content[]` of a `tools/call` result as one text, the spec's way. */
function renderContent(result: unknown): CallResult {
  if (!isRecord(result)) return { text: "", isError: false };
  const items = Array.isArray(result.content) ? result.content : [];
  const parts: string[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else parts.push(`[${typeof item.type === "string" ? item.type : "unknown"}]`);
  }
  return { text: parts.join("\n"), isError: result.isError === true };
}

export function createMcpClient(name: string, config: McpServerConfig, options: McpClientOptions): McpClient {
  const spawn = options.spawn ?? bunSpawner;
  const initializeCeilingMs = options.initializeCeilingMs ?? DEFAULT_INITIALIZE_CEILING_MS;
  const callCeilingMs = options.callCeilingMs ?? DEFAULT_CALL_CEILING_MS;

  let status: McpServerStatus = "starting";
  let problem: string | undefined;
  let child: ChildLike | undefined;
  let exited = false;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let initializing: Promise<{ tools: McpTool[] }> | undefined;
  let closing: Promise<void> | undefined;
  let terminating: Promise<void> | undefined;

  const note = (text: string) => {
    process.stderr.write(`mcp ${name}: ${text}\n`);
  };

  /** The first reason wins: a server closed after dying still says it died. */
  const markDown = (reason: string) => {
    if (status === "down") return;
    status = "down";
    problem = reason;
    const waiting = [...pending.values()];
    pending.clear();
    for (const entry of waiting) entry.settle({ kind: "down" });
  };

  const send = (message: object): boolean => {
    if (child === undefined || exited) return false;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      child.stdin.flush?.();
      return true;
    } catch (error) {
      // The pipe is gone; the exit handler usually explains why within the
      // grace, and if the child is somehow still alive, this is the reason.
      setTimeout(() => markDown(`could not write to the server: ${(error as Error).message}`), GRACE_MS);
      return false;
    }
  };

  const onMessage = (message: Record<string, unknown>) => {
    const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined;
    if (typeof message.method === "string") {
      // A request from the server wants an answer; a notification wants nothing.
      if (id !== undefined) send(errorResponse(id, METHOD_NOT_FOUND, `vesna offers no ${message.method}`));
      return;
    }
    if (typeof id !== "number" || (!("result" in message) && !("error" in message))) {
      note("ignored a message that is neither a request nor a response");
      return;
    }
    const entry = pending.get(id);
    // No entry: the call was abandoned (ceiling, abort) and its late answer
    // is nobody's business.
    if (entry === undefined) return;
    pending.delete(id);
    if ("error" in message) {
      const error = isRecord(message.error) ? message.error : {};
      entry.settle({
        kind: "error",
        error: {
          code: typeof error.code === "number" ? error.code : 0,
          message: typeof error.message === "string" ? error.message : "unknown error",
        },
      });
    } else {
      entry.settle({ kind: "result", result: message.result });
    }
  };

  const onLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      note(`ignored a line that is not JSON: ${trimmed.slice(0, 120)}`);
      return;
    }
    if (!isRecord(parsed)) {
      note("ignored a line that is not a JSON-RPC message");
      return;
    }
    onMessage(parsed);
  };

  const readLines = async (stream: AsyncIterable<Uint8Array>) => {
    const decoder = new TextDecoder();
    let tail = "";
    try {
      for await (const chunk of stream) {
        tail += decoder.decode(chunk, { stream: true });
        let newline = tail.indexOf("\n");
        while (newline >= 0) {
          onLine(tail.slice(0, newline));
          tail = tail.slice(newline + 1);
          newline = tail.indexOf("\n");
        }
      }
      tail += decoder.decode();
      if (tail.trim() !== "") onLine(tail);
    } catch {
      // The pipe broke under us; the exit handler says what happened.
    }
  };

  const request = (method: string, params: unknown, ceilingMs: number, signal?: AbortSignal): Promise<Outcome> => {
    if (status === "down") return Promise.resolve({ kind: "down" });
    if (signal?.aborted) return Promise.resolve({ kind: "aborted" });
    const id = nextId;
    nextId += 1;
    return new Promise<Outcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => settle({ kind: "aborted" });
      const settle = (outcome: Outcome) => {
        pending.delete(id);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      pending.set(id, { settle });
      if (!send({ jsonrpc: "2.0", id, method, params })) {
        // The exit handler, or the write-failure timer, settles this one.
        return;
      }
      timer = setTimeout(() => settle({ kind: "timeout" }), ceilingMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  const notify = (method: string, params: unknown) => {
    send({ jsonrpc: "2.0", method, params });
  };

  /**
   * SIGTERM to the root, then SIGKILL to the whole tree after the grace, the
   * way `spawnInterruptible` does it: a server started through `npx` or a
   * shell wrapper is a tree, and a signal to its root alone leaves the real
   * server orphaned, alive, and holding the pipes. The tree is captured
   * before the first signal — once the root dies its children are
   * reparented and no walk from its pid finds them.
   */
  const terminate = (): Promise<void> => {
    if (terminating !== undefined) return terminating;
    const target = child;
    if (target === undefined || exited) return Promise.resolve();
    terminating = (async () => {
      // An in-memory child has no pid and no tree; pid 0 must never be walked.
      const tree = target.pid > 0 ? [...descendantsOf(target.pid), target.pid] : [];
      try {
        target.stdin.end();
      } catch {
        // Already closed.
      }
      target.kill("SIGTERM");
      const grace = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), GRACE_MS));
      const gone = await Promise.race([target.exited.then(() => true), grace]);
      // A root that left within the grace may still have left children
      // behind; they get the same grace, then the kill nothing can trap.
      if (!gone || tree.length > 1) {
        await grace;
        const now = new Set<number>();
        for (const pid of tree) for (const kid of descendantsOf(pid)) now.add(kid);
        for (const pid of tree) now.add(pid);
        killAll([...now], "SIGKILL");
        target.kill("SIGKILL");
        await target.exited;
      }
    })();
    return terminating;
  };

  const listTools = async (): Promise<McpTool[]> => {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const outcome = await request("tools/list", cursor === undefined ? {} : { cursor }, initializeCeilingMs);
      if (outcome.kind === "result") {
        const result = isRecord(outcome.result) ? outcome.result : {};
        for (const item of Array.isArray(result.tools) ? result.tools : []) {
          const tool = toTool(item);
          if (tool !== undefined) tools.push(tool);
        }
        const next = typeof result.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : undefined;
        if (next === undefined || seen.has(next)) return tools;
        seen.add(next);
        cursor = next;
        continue;
      }
      if (outcome.kind === "error") markDown(`tools/list failed: ${outcome.error.code}: ${outcome.error.message}`);
      else if (outcome.kind === "timeout") markDown("did not answer tools/list in time");
      await terminate();
      return [];
    }
    markDown(`tools/list never ran out of pages after ${MAX_PAGES}`);
    await terminate();
    return [];
  };

  const start = async (): Promise<{ tools: McpTool[] }> => {
    // Closed before it ever started: nothing to spawn.
    if (status === "down") return { tools: [] };
    try {
      child = spawn(config.command, config.args, { env: childEnv(config, options.env), cwd: options.cwd });
    } catch (error) {
      markDown(`could not start: ${(error as Error).message}`);
      return { tools: [] };
    }
    const spawned = child;
    void readLines(spawned.stdout);
    spawned.exited.then(
      (code) => {
        exited = true;
        markDown(`exited with code ${code}`);
      },
      (error) => {
        exited = true;
        markDown(`exited: ${(error as Error).message}`);
      },
    );

    const outcome = await request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "vesna", version: pkg.version },
      },
      initializeCeilingMs,
    );
    if (outcome.kind !== "result") {
      if (outcome.kind === "timeout") markDown("did not answer initialize in time");
      else if (outcome.kind === "error") markDown(`initialize failed: ${outcome.error.code}: ${outcome.error.message}`);
      await terminate();
      return { tools: [] };
    }
    notify("notifications/initialized", {});
    const tools = await listTools();
    // The server can die between the last page and here; a dead server has
    // no tools to offer.
    if (status !== "starting") return { tools: [] };
    status = "up";
    return { tools };
  };

  return {
    initialize() {
      if (initializing === undefined) initializing = start();
      return initializing;
    },

    async call(toolName, args, signal) {
      if (status === "down") return { text: `server ${name} is down: ${problem}`, isError: true };
      if (child === undefined) return { text: `server ${name} is not started`, isError: true };
      const outcome = await request("tools/call", { name: toolName, arguments: args }, callCeilingMs, signal);
      switch (outcome.kind) {
        case "result":
          return renderContent(outcome.result);
        case "error":
          return { text: `${outcome.error.code}: ${outcome.error.message}`, isError: true };
        case "timeout":
          return { text: `${toolName} did not answer in ${seconds(callCeilingMs)}`, isError: true };
        case "aborted":
          return { text: "interrupted", isError: true };
        case "down":
          return { text: `server ${name} is down: ${problem}`, isError: true };
      }
    },

    close() {
      if (closing !== undefined) return closing;
      closing = (async () => {
        markDown("closed");
        await terminate();
      })();
      return closing;
    },

    status: () => status,
    problem: () => problem,
  };
}
