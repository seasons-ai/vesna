import { test, expect } from "bun:test";
import { createDecoder, frame } from "../src/client";
import { ServerLink } from "../src/link";
import type { State } from "../src/protocol";
import type { ChildLike, Spawner } from "../src/server";
import { createStore } from "../src/state";

/** The same hand-driven child as in server.test.ts, kept small. */
class FakeChild implements ChildLike {
  written: Uint8Array[] = [];
  killed: string[] = [];
  exitCode: number | null = null;
  signalCode: string | null = null;
  private handlers: Record<string, ((...args: any[]) => void)[]> = {};
  stdin = {
    write: (chunk: Uint8Array) => {
      this.written.push(chunk);
      return true;
    },
    end: () => {},
    on: () => this.stdin,
  };
  stdout = { on: (event: string, handler: (...args: any[]) => void) => this.listen(`stdout:${event}`, handler) };
  stderr = { on: () => this.stderr };
  on(event: string, handler: (...args: any[]) => void): this {
    return this.listen(event, handler);
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(String(signal ?? "SIGTERM"));
    // A SIGKILL takes effect: the process is gone, by signal.
    if (signal === "SIGKILL" && this.alive()) {
      this.signalCode = "SIGKILL";
      for (const handler of this.handlers["exit"] ?? []) handler(null, "SIGKILL");
    }
    return true;
  }
  private listen(key: string, handler: (...args: any[]) => void): this {
    (this.handlers[key] ??= []).push(handler);
    return this;
  }
  sent(): any[] {
    const decoder = createDecoder();
    return this.written.flatMap((bytes) => decoder.push(bytes));
  }
  say(message: unknown): void {
    for (const handler of this.handlers["stdout:data"] ?? []) handler(Buffer.from(frame(message)));
  }
  exit(code: number): void {
    if (!this.alive()) return;
    this.exitCode = code;
    for (const handler of this.handlers["exit"] ?? []) handler(code, null);
  }
  alive(): boolean {
    return this.exitCode === null && this.signalCode === null;
  }
}

function makeState(): State {
  return {
    mode: "plan",
    busy: false,
    building: false,
    buildState: "idle",
    model: "m",
    service: "s",
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    spec: null,
    specSlug: null,
    chats: null,
    chatId: null,
    root: "/repo",
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(settings = () => ({ command: "vesna", args: [] as string[] })) {
  const children: FakeChild[] = [];
  const calls: { command: string; args: string[] }[] = [];
  const spawn: Spawner = (command, args) => {
    calls.push({ command, args: [...args] });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const store = createStore();
  const link = new ServerLink({
    root: "/repo",
    extensionVersion: "0.1.0",
    store,
    onNotification: (n) => store.dispatch({ kind: "notification", n }),
    spawn,
    settings,
    handshakeMs: 40,
    restartCeilingMs: 40,
  });
  return { children, calls, store, link };
}

function answer(child: FakeChild): void {
  const [request] = child.sent();
  child.say({
    jsonrpc: "2.0",
    id: request.id,
    result: { serverVersion: "0.9.0", capabilities: { transcript: 1, state: 1, ask: 1 }, state: makeState() },
  });
}

test("start spawns with the settings it is given, and the panel goes starting → up", async () => {
  const h = harness(() => ({ command: "/opt/bun", args: ["/x/bin/vesna"] }));
  const starting = h.link.start();
  await tick();
  expect(h.calls).toEqual([{ command: "/opt/bun", args: ["/x/bin/vesna", "serve"] }]);
  expect(h.store.model.server).toEqual({ kind: "starting" });
  answer(h.children[0]!);
  await starting;
  expect(h.store.model.server).toEqual({ kind: "up" });
  expect(h.link.current()).not.toBeNull();
});

test("two restarts over mute servers leave exactly one child alive", async () => {
  const h = harness();
  void h.link.start();
  await tick();
  expect(h.children).toHaveLength(1);
  void h.link.restart();
  await tick();
  await tick();
  expect(h.children).toHaveLength(2);
  expect(h.children[0]!.alive()).toBe(false);
  expect(h.children[0]!.killed).toEqual(["SIGKILL"]);
  void h.link.restart();
  await tick();
  await tick();
  expect(h.children).toHaveLength(3);
  expect(h.children.map((c) => c.alive())).toEqual([false, false, true]);
});

test("a mute server is reported unresponsive after the handshake ceiling and its child is gone", async () => {
  const h = harness();
  await h.link.start();
  expect(h.store.model.server).toEqual({ kind: "unresponsive" });
  expect(h.children[0]!.alive()).toBe(false);
  expect(h.link.current()).toBeNull();
});

test("restart over a live server stops it with shutdown and exit, then starts anew", async () => {
  const h = harness();
  const starting = h.link.start();
  await tick();
  answer(h.children[0]!);
  await starting;
  const restarting = h.link.restart();
  await tick();
  expect(h.children[0]!.sent().map((m) => m.method)).toEqual(["initialize", "shutdown", "exit"]);
  h.children[0]!.exit(0);
  await tick();
  await tick();
  expect(h.children).toHaveLength(2);
  answer(h.children[1]!);
  await restarting;
  expect(h.store.model.server).toEqual({ kind: "up" });
  expect(h.children[0]!.killed).toEqual([]);
});

test("stop with a ceiling kills a server that ignores shutdown once the ceiling passes", async () => {
  const h = harness();
  const starting = h.link.start();
  await tick();
  answer(h.children[0]!);
  await starting;
  await h.link.stop(30);
  expect(h.children[0]!.killed).toEqual(["SIGKILL"]);
  expect(h.link.current()).toBeNull();
});
