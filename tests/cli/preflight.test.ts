import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCredential, problem, remedy, usable, type Credential } from "../../src/cli/preflight";
import type { VesnaConfig } from "../../src/cli/config";
import { findPreset } from "../../src/providers/catalog";

function config(over: Partial<VesnaConfig> = {}): VesnaConfig {
  return {
    configured: true,
    preset: findPreset("codex")!,
    pinned: true,
    provider: "openai",
    auth: "codex",
    model: "m",
    theme: "vesna",
    prices: {},
    permissions: { nodes: [] },
    ...over,
  };
}

async function home(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vesna-home-"));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  return dir;
}

const jwt = (claims: object) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

test("a live codex token is usable", () => {
  const c: Credential = { mode: "codex", state: "valid", path: "/p", endpoint: "e" };
  expect(usable(c)).toBe(true);
});

test("an expired codex token is NOT usable — Vesna never refreshes a borrowed one", () => {
  const c: Credential = { mode: "codex", state: "expired", path: "/p", endpoint: "e" };
  expect(usable(c)).toBe(false);
  expect(remedy(config(), c).join(" ")).toContain("codex login");
});

test("an expired subscription token IS usable — it refreshes itself on next use", () => {
  const c: Credential = { mode: "subscription", state: "expired", path: "/p", endpoint: "e" };
  expect(usable(c)).toBe(true);
});

test("a missing subscription token points at the sign-in command", () => {
  const c: Credential = { mode: "subscription", state: "missing", path: "/p", endpoint: null };
  expect(usable(c)).toBe(false);
  expect(remedy(config({ auth: "subscription" }), c).join(" ")).toContain("vesna auth login");
});

test("an openai key is usable, and its absence names the variable", () => {
  expect(usable({ mode: "openai-key", state: "valid", reason: "key", endpoint: "e" })).toBe(true);
  const missing: Credential = { mode: "openai-key", state: "missing", reason: "key", endpoint: "e" };
  expect(usable(missing)).toBe(false);
  expect(remedy(config({ auth: "key" }), missing).join(" ")).toContain("OPENAI_API_KEY");
});

test("a local endpoint needs no credential at all", () => {
  expect(usable({ mode: "openai-key", state: "valid", reason: "local", endpoint: "http://localhost:1234" })).toBe(true);
});

test("anthropic is usable for a key, a token, or a profile, and not otherwise", () => {
  const of = (source: any): Credential => ({ mode: "anthropic", source, dir: "/d", profiles: [] });
  expect(usable(of({ kind: "api_key", note: "" }))).toBe(true);
  expect(usable(of({ kind: "auth_token", note: "" }))).toBe(true);
  expect(usable(of({ kind: "profile", profile: "default", note: "" }))).toBe(true);
  expect(usable(of({ kind: "none", note: "" }))).toBe(false);
  expect(usable(of({ kind: "missing_profile", profile: "x", note: "" }))).toBe(false);
});

test("an unconfigured project is told to run init before anything else", () => {
  const c: Credential = { mode: "anthropic", source: { kind: "none", note: "" }, dir: "/d", profiles: [] };
  const lines = remedy(config({ configured: false, provider: "anthropic", auth: "key" }), c).join("\n");
  expect(lines).toContain("vesna init");
  expect(lines).toContain("config.yaml");
});

test("a configured project is not told to run init — its problem is the credential", () => {
  const c: Credential = { mode: "codex", state: "missing", path: "/p", endpoint: "e" };
  expect(remedy(config(), c).join("\n")).not.toContain("vesna init");
});

test("codex mode reads the real token file and reports it live", async () => {
  const dir = await home({
    ".codex/auth.json": JSON.stringify({
      tokens: { access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) },
    }),
  });
  const c = await inspectCredential(config(), {}, dir);
  expect(c.mode).toBe("codex");
  expect((c as any).state).toBe("valid");
});

test("codex mode notices an expired token rather than trying it", async () => {
  const dir = await home({
    ".codex/auth.json": JSON.stringify({ tokens: { access_token: jwt({ exp: 1000 }) } }),
  });
  expect((await inspectCredential(config(), {}, dir) as any).state).toBe("expired");
});

test("codex mode with no file at all is missing, not a crash", async () => {
  expect((await inspectCredential(config(), {}, await home()) as any).state).toBe("missing");
});

test("key mode sees the environment variable", async () => {
  const c = await inspectCredential(config({ auth: "key" }), { OPENAI_API_KEY: "sk" }, await home());
  expect(usable(c)).toBe(true);
});

test("key mode treats a localhost baseUrl as needing nothing", async () => {
  const c = await inspectCredential(
    config({ auth: "key", baseUrl: "http://localhost:11434/v1" }),
    {},
    await home(),
  );
  expect(usable(c)).toBe(true);
});

test("anthropic mode reports what the SDK would find", async () => {
  const c = await inspectCredential(
    config({ provider: "anthropic", auth: "key" }),
    { ANTHROPIC_API_KEY: "sk-ant" },
    await home(),
  );
  expect(c.mode).toBe("anthropic");
  expect(usable(c)).toBe(true);
});

test("every unusable credential offers at least one concrete next step", () => {
  const unusable: Credential[] = [
    { mode: "codex", state: "missing", path: "/p", endpoint: "e" },
    { mode: "codex", state: "expired", path: "/p", endpoint: "e" },
    { mode: "subscription", state: "missing", path: "/p", endpoint: null },
    { mode: "openai-key", state: "missing", reason: "key", endpoint: "e" },
    { mode: "anthropic", source: { kind: "none", note: "" }, dir: "/d", profiles: [] },
  ];
  for (const c of unusable) {
    expect(usable(c)).toBe(false);
    expect(remedy(config(), c).length).toBeGreaterThan(0);
  }
});

test("each failure states what is wrong in its own words", () => {
  expect(problem({ mode: "codex", state: "missing", path: "/p", endpoint: "e" })).toContain("no codex");
  expect(problem({ mode: "codex", state: "expired", path: "/p", endpoint: "e" })).toContain("expired");
  expect(problem({ mode: "subscription", state: "missing", path: "/p", endpoint: null })).toContain("not signed in");
  expect(problem({ mode: "openai-key", state: "missing", reason: "key", endpoint: "e" })).toContain("OPENAI_API_KEY");
  expect(
    problem({ mode: "anthropic", source: { kind: "none", note: "" }, dir: "/d", profiles: [] }),
  ).toContain("Anthropic");
});

test("a profile named but absent is called out by name, not lumped in with 'none'", () => {
  const said = problem({
    mode: "anthropic",
    source: { kind: "missing_profile", profile: "work", note: "" },
    dir: "/d",
    profiles: [],
  });
  expect(said).toContain("work");
});

// The credential guard must read the preset's own key variable, not a
// hardcoded OPENAI_API_KEY — every openai-dialect preset names its own
// (groq, openrouter, custom, ...), and the guard has to agree with `usable`
// on all of them or a correctly configured user is refused a chat.

test("a groq preset is usable from GROQ_API_KEY alone, with no OPENAI_API_KEY set", async () => {
  const c = await inspectCredential(
    config({ preset: findPreset("groq")!, provider: "openai", auth: "key" }),
    { GROQ_API_KEY: "gsk-live" },
    await home(),
  );
  expect(usable(c)).toBe(true);
});

test("a groq preset with neither variable set is not usable, and names GROQ_API_KEY", async () => {
  const conf = config({ preset: findPreset("groq")!, provider: "openai", auth: "key" });
  const c = await inspectCredential(conf, {}, await home());
  expect(usable(c)).toBe(false);
  expect(problem(c)).toContain("GROQ_API_KEY");
  expect(problem(c)).not.toContain("OPENAI_API_KEY");
  expect(remedy(conf, c).join(" ")).toContain("GROQ_API_KEY");
  expect(remedy(conf, c).join(" ")).not.toContain("OPENAI_API_KEY");
});

test("an ollama preset needs no variable at all, even with nothing set", async () => {
  const c = await inspectCredential(
    config({ preset: findPreset("ollama")!, provider: "openai", auth: "key" }),
    {},
    await home(),
  );
  expect(usable(c)).toBe(true);
});

test("anthropic behaviour is unchanged by the preset-aware guard", async () => {
  const usableCred = await inspectCredential(
    config({ preset: findPreset("anthropic")!, provider: "anthropic", auth: "key" }),
    { ANTHROPIC_API_KEY: "sk-ant" },
    await home(),
  );
  expect(usable(usableCred)).toBe(true);

  const missingCred = await inspectCredential(
    config({ preset: findPreset("anthropic")!, provider: "anthropic", auth: "key" }),
    {},
    await home(),
  );
  expect(usable(missingCred)).toBe(false);
});

test("codex behaviour is unchanged by the preset-aware guard", async () => {
  const dir = await home({
    ".codex/auth.json": JSON.stringify({
      tokens: { access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) },
    }),
  });
  const c = await inspectCredential(
    config({ preset: findPreset("codex")!, provider: "openai", auth: "codex" }),
    {},
    dir,
  );
  expect(usable(c)).toBe(true);
});
