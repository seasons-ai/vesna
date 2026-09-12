import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppDeps } from "../../src/tui/app";
import { resolveTheme } from "../../src/tui/theme";
import { createRegistry } from "../../src/registry/registry";
import type { CompletionRequest, CompletionResult, Provider } from "../../src/providers/types";
import type { VesnaConfig } from "../../src/cli/config";
import type { ProviderHandle } from "../../src/cli/context";
import { findPreset, type Preset } from "../../src/providers/catalog";
import type { BuildResult } from "../../src/work/builder";
import type { ReviewOutcome } from "../../src/sdd/review";
import type { MergeReport } from "../../src/work/merge";

/**
 * The fakes the chat is driven with, shared by the TUI's tests and the core's:
 * the same provider, the same deps, the same build seams, so a scenario that
 * passes on the screen can be re-run against the core through `on()` alone.
 */

/** Waits for a predicate, so tests never race the app. */
export async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export function provider(behaviour: (request: CompletionRequest) => Promise<CompletionResult>): Provider {
  return { id: "fake", complete: behaviour };
}

export function done(text: string): CompletionResult {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    model: "fake",
    usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

export function reply(text: string): Provider {
  return provider(async () => done(text));
}

/**
 * Fakes for `/build`'s call into `runBuild`, modeled on `tests/sdd/loop.test.ts`'s
 * own fakes: a worker that "builds" a task without touching a real checkout,
 * a reviewer that hands back a fixed queue of verdicts (clean by default),
 * a merge that always succeeds, and a git runner that answers the two calls
 * `runBuild` itself makes (`rev-parse --abbrev-ref` and a bare `rev-parse`)
 * plus a no-op for every diff in between — `build` and `review` are what is
 * faked away, so nothing here ever needs a real branch to exist.
 */
export function buildFakes(overrides: Partial<{ reviews: (ReviewOutcome | Error)[] }> = {}) {
  const built = (task: string, n: number): BuildResult => ({
    task,
    status: "committed",
    branch: `vesna/work/${task}`,
    worktree: `/wt/${task}`,
    commit: `sha-${task}-${n}`,
    refusals: [],
    costUsd: 0.01,
    text: "did it",
  });
  const clean: ReviewOutcome = {
    kind: "verdict",
    verdict: { spec: "met", findings: [], summary: "ok" },
    costUsd: 0.01,
  };
  const reviews = [...(overrides.reviews ?? [])];
  return {
    build: async (r: { task: string }) => built(r.task, 1),
    resume: async (r: { task: string }) => built(r.task, 2),
    review: async (): Promise<ReviewOutcome> => {
      const next = reviews.shift() ?? clean;
      if (next instanceof Error) throw next;
      return next;
    },
    merge: async (_repo: string, c: { task: string; branch: string }[]): Promise<MergeReport> => ({
      merged: [{ task: c[0]!.task, branch: c[0]!.branch }],
      pending: [],
    }),
    git: async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "start-sha", stderr: "" };
      return { code: 0, stdout: "diff", stderr: "" };
    },
  };
}

/**
 * A ProviderHandle whose `switch` is observed rather than actually talking to
 * anything, so /provider and /model can be driven end to end: what each was
 * asked to become, what a host that refuses the connection looks like (via
 * `fail`), and — via `requests`, the `model` field of every completion
 * request actually sent — whether a switch that *says* it worked also
 * changed what the next turn asks for.
 */
export function providerHandle(options: { fail?: string } = {}) {
  let preset = findPreset("codex")!;
  let model = preset.model;
  // Mirrors what a real startup resolves when nothing overrides it
  // (src/cli/config.ts): the preset's own address.
  let baseUrl = preset.baseUrl;
  const calls: { preset: Preset; model: string; baseUrl?: string }[] = [];
  const requests: string[] = [];
  const handle: ProviderHandle = {
    id: "fake",
    get preset() {
      return preset;
    },
    get model() {
      return model;
    },
    get baseUrl() {
      return baseUrl;
    },
    async complete(request) {
      requests.push(request.model);
      return done("x");
    },
    async switch(next, nextModel, nextBaseUrl) {
      calls.push({ preset: next, model: nextModel, ...(nextBaseUrl ? { baseUrl: nextBaseUrl } : {}) });
      if (options.fail !== undefined) throw new Error(options.fail);
      preset = next;
      model = nextModel;
      baseUrl = nextBaseUrl;
    },
  };
  return { handle, calls, requests };
}

/**
 * A turn that stops halfway until the test lets it go, so "while the turn is
 * running" is a state the test controls rather than a sleep it hopes wins.
 */
export function halfway(first: string, second: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    release,
    provider: provider(async (request) => {
      request.onText?.(first);
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve);
        request.signal?.addEventListener("abort", () =>
          reject(new Error("The operation was aborted")),
        );
      });
      request.onText?.(second);
      return done(first + second);
    }),
  };
}

export async function deps(p: Provider, overrides: Partial<AppDeps> = {}): Promise<AppDeps> {
  const root = await mkdtemp(join(tmpdir(), "vesna-app-"));
  const config: VesnaConfig = {
    configured: true,
    preset: findPreset("codex")!,
    pinned: true,
    provider: "openai",
    auth: "codex",
    model: "test-model",
    theme: "mono",
    prices: {},
    permissions: { nodes: [] },
    // Deterministic across machines: these tests assert on the real glyphs,
    // regardless of what locale happens to be set where they run.
    ascii: false,
  };
  return {
    registry: createRegistry(),
    provider: p,
    config,
    theme: resolveTheme("mono", { depth: 0 }),
    root,
    ...overrides,
  };
}

/** A node with a path, and one with nothing a rule could match on. */
export function toolCaller(name: string, input: Record<string, unknown>): Provider {
  let turn = 0;
  return {
    id: "fake",
    async complete() {
      turn += 1;
      return {
        content:
          turn === 1
            ? [{ type: "tool_call" as const, id: "c1", name, input }]
            : [{ type: "text" as const, text: "finished" }],
        stopReason: "end_turn",
        model: "m",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

/** The test deps permit no nodes at all; these tests need one. */
export async function allowing(provider: Provider, registry: ReturnType<typeof createRegistry>) {
  const base = await deps(provider, { registry });
  return {
    ...base,
    config: { ...base.config, permissions: { nodes: ["put"] } },
    policy: { mode: "ask" as const, allow: {}, deny: {} },
  };
}

export function writing() {
  const registry = createRegistry();
  const ran: string[] = [];
  registry.register({
    type: "put",
    effect: "write",
    description: "write",
    inputSchema: { type: "object" },
    async run(input: any) {
      ran.push(String(input.path ?? input.check ?? "?"));
      return {};
    },
  });
  return { registry, ran };
}
