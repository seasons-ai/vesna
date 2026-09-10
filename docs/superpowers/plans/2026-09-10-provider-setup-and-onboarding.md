# Provider Setup and Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Vesna work the moment it is installed — bare `vesna` opens the chat, machine-wide settings replace per-folder setup, providers become a catalog of presets, and `/provider` and `/model` change them from inside a conversation.

**Architecture:** A new machine-wide `~/.vesna/settings.yaml` that Vesna writes sits underneath the hand-written project config, which keeps winning. Providers become catalog entries — data over the three existing wire dialects — so adding a service is an entry, not code. `buildContext` returns a `ProviderHandle` that *is* a `Provider`, delegating to a swappable current one, which lets `/provider` rebuild the connection without disturbing the session, registry, store or spec sink.

**Tech Stack:** TypeScript, Bun (`bun test`), `yaml`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-10-provider-setup-and-onboarding-design.md`

## Global Constraints

- Every committed artifact — code, comments, docs, commit messages — in English.
- Never add `Co-Authored-By` or any AI attribution to a commit.
- No new runtime dependencies. `yaml` and `@anthropic-ai/sdk` are all there is.
- Settings reads and writes are **synchronous**. They happen while a frame is being drawn, and an `await` inside a keypress handler does not resolve until the next key arrives — a measured 1008ms stall in this codebase. `src/store/sessions.ts` and `src/spec/store.ts` are synchronous for this reason; follow them.
- No secrets in `settings.yaml`. It records the *name* of an environment variable. Keys and tokens stay in `~/.vesna/auth.json` and the environment.
- `VESNA_HOME` overrides the home directory for every path this plan touches, as it already does in `src/store/sessions.ts`.
- Tests live in `tests/<area>/<name>.test.ts`, use `import { test, expect } from "bun:test"`, and build fixtures under `mkdtemp(join(tmpdir(), "vesna-…"))`.
- Run `bun test` and `bun run typecheck` before every commit. The suite is at 889 tests, 0 failures; it stays there.

---

### Task 1: Machine-wide settings file

**Files:**
- Create: `src/cli/settings.ts`
- Test: `tests/cli/settings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface GlobalSettings { provider?: string; model?: string; baseUrl?: string; env?: string }`, `settingsPath(env: Record<string, string | undefined>, home: string): string`, `readSettings(path: string): GlobalSettings`, `writeSettings(path: string, settings: GlobalSettings): void`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, settingsPath, writeSettings } from "../../src/cli/settings";

function withHome(fn: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "vesna-settings-"));
  try {
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("settingsPath honours VESNA_HOME over the home directory", () => {
  expect(settingsPath({ VESNA_HOME: "/tmp/elsewhere" }, "/home/x")).toBe(
    "/tmp/elsewhere/settings.yaml",
  );
  expect(settingsPath({}, "/home/x")).toBe("/home/x/.vesna/settings.yaml");
});

test("a missing file reads as empty settings rather than throwing", () => {
  withHome((home) => {
    expect(readSettings(settingsPath({}, home))).toEqual({});
  });
});

test("what is written is what is read back", () => {
  withHome((home) => {
    const path = settingsPath({}, home);
    writeSettings(path, { provider: "ollama", model: "qwen3" });
    expect(readSettings(path)).toEqual({ provider: "ollama", model: "qwen3" });
  });
});

test("writing creates the directory and leaves a comment saying who owns the file", () => {
  withHome((home) => {
    const path = settingsPath({}, home);
    writeSettings(path, { provider: "groq" });
    expect(readFileSync(path, "utf8")).toContain("Written by Vesna");
  });
});

test("unreadable YAML reads as empty rather than crashing the program", () => {
  withHome((home) => {
    const path = settingsPath({}, home);
    writeSettings(path, { provider: "groq" });
    require("node:fs").writeFileSync(path, "provider: [unclosed\n");
    expect(readSettings(path)).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/cli/settings.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/settings`.

- [ ] **Step 3: Write the implementation**

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";

/**
 * Settings that belong to the machine rather than to a repository.
 *
 * Which model you talk to is a property of your subscription and your laptop,
 * so it should not have to be re-established in every directory. The project
 * file stays hand-written and keeps winning; this one is Vesna's to rewrite,
 * the same division `.vesna/permissions.yaml` already follows.
 *
 * Synchronous, because `/provider` writes this from inside a keypress, and an
 * await there does not resolve until the next key arrives.
 */
export interface GlobalSettings {
  /** A preset id from the catalog. */
  provider?: string;
  model?: string;
  /** Only meaningful for the `custom` preset. */
  baseUrl?: string;
  /** Name of the environment variable holding the key. Never the key itself. */
  env?: string;
}

export function settingsPath(env: Record<string, string | undefined>, home: string): string {
  return join(env.VESNA_HOME ?? join(home, ".vesna"), "settings.yaml");
}

export function readSettings(path: string): GlobalSettings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Absent is the ordinary state before the first run, not a failure.
    return {};
  }

  try {
    const raw = parseYaml(text);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return raw as GlobalSettings;
  } catch {
    // Vesna wrote this file, so a broken one is Vesna's bug or a half-finished
    // write. Refusing to start over it would strand the user with no way in.
    return {};
  }
}

export function writeSettings(path: string, settings: GlobalSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const header = [
    "# Written by Vesna. Safe to edit, safe to delete.",
    "# A .vesna/config.yaml in a project overrides everything here.",
    "",
  ].join("\n");
  writeFileSync(path, `${header}${toYaml(settings)}`);
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test tests/cli/settings.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/settings.ts tests/cli/settings.test.ts
git commit -F - <<'MSG'
feat: machine-wide settings Vesna owns

Which model you talk to is a property of your subscription and your
laptop, not of a repository, so it should not have to be established
again in every directory.

This file is Vesna's to rewrite, the way .vesna/permissions.yaml
already is; the project config stays hand-written and keeps winning.
Reads and writes are synchronous because /provider will write this
from inside a keypress, where an await does not resolve until the next
key arrives.
MSG
```

---

### Task 2: The preset catalog

**Files:**
- Create: `src/providers/catalog.ts`
- Test: `tests/providers/catalog.test.ts`

**Interfaces:**
- Consumes: `CODEX_BASE_URL` from `src/cli/context.ts`; `DEFAULT_MODEL` from `src/providers/types.ts`.
- Produces: `type Dialect = "anthropic" | "openai" | "responses"`, `interface Preset { id: string; label: string; dialect: Dialect; model: string; baseUrl?: string; env?: string; auth?: "key" | "subscription" | "codex" }`, `PRESETS: readonly Preset[]`, `findPreset(id: string): Preset | undefined`, `presetFor(provider: string, auth: string | undefined): Preset | undefined`.

`presetFor` is the backward-compatibility seam: it maps an old `provider` + `auth` pair onto a preset so existing configs keep working.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { PRESETS, findPreset, presetFor } from "../../src/providers/catalog";

test("every preset names a dialect Vesna can actually build", () => {
  for (const preset of PRESETS) {
    expect(["anthropic", "openai", "responses"]).toContain(preset.dialect);
    expect(preset.model).not.toBe("");
    expect(preset.label).not.toBe("");
  }
});

test("every openai-dialect preset except the built-in one carries a base URL", () => {
  for (const preset of PRESETS) {
    if (preset.dialect !== "openai") continue;
    if (preset.id === "custom") continue;
    expect(preset.baseUrl).toBeDefined();
  }
});

test("preset ids are unique", () => {
  const ids = PRESETS.map((preset) => preset.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("the services a first-time user is likely to have are all present", () => {
  const ids = PRESETS.map((preset) => preset.id);
  for (const expected of [
    "anthropic", "openai", "codex", "openrouter",
    "groq", "ollama", "lmstudio", "vllm", "custom",
  ]) {
    expect(ids).toContain(expected);
  }
});

test("local presets need no key", () => {
  for (const id of ["ollama", "lmstudio", "vllm"]) {
    expect(findPreset(id)?.env).toBeUndefined();
  }
});

test("an unknown id is undefined rather than a throw", () => {
  expect(findPreset("nope")).toBeUndefined();
});

test("configs written before the catalog still resolve", () => {
  expect(presetFor("openai", "codex")?.id).toBe("codex");
  expect(presetFor("openai", "subscription")?.id).toBe("subscription");
  expect(presetFor("openai", "key")?.id).toBe("openai");
  expect(presetFor("anthropic", "key")?.id).toBe("anthropic");
});

test("a preset name in the provider field wins over the legacy pair", () => {
  expect(presetFor("groq", "key")?.id).toBe("groq");
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/providers/catalog.test.ts`
Expected: FAIL — cannot resolve `../../src/providers/catalog`.

- [ ] **Step 3: Write the implementation**

```ts
import { DEFAULT_MODEL } from "./types";

/**
 * Services, not wire formats.
 *
 * `provider: openai` used to name a dialect, which meant connecting a local
 * server required knowing that the openai provider accepts a baseUrl at all.
 * OpenRouter, Groq, Ollama, LM Studio and vLLM are all that same dialect with
 * a different address, key variable and default model — so they are data.
 *
 * Adding a service is an entry here. It is not a code change.
 */
export type Dialect = "anthropic" | "openai" | "responses";

export interface Preset {
  id: string;
  label: string;
  dialect: Dialect;
  model: string;
  baseUrl?: string;
  /** Name of the environment variable holding the key, when one is needed. */
  env?: string;
  /** How the credential is obtained. Absent means a plain key. */
  auth?: "key" | "subscription" | "codex";
}

export const PRESETS: readonly Preset[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    dialect: "anthropic",
    model: DEFAULT_MODEL,
    env: "ANTHROPIC_API_KEY",
  },
  {
    id: "openai",
    label: "OpenAI",
    dialect: "openai",
    model: "gpt-5.6",
    baseUrl: "https://api.openai.com/v1",
    env: "OPENAI_API_KEY",
  },
  {
    id: "codex",
    label: "ChatGPT subscription, borrowed from the Codex CLI",
    dialect: "responses",
    model: "gpt-5.6-sol",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    auth: "codex",
  },
  {
    id: "subscription",
    label: "ChatGPT subscription, Vesna's own sign-in",
    dialect: "responses",
    model: "gpt-5.6-sol",
    auth: "subscription",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    dialect: "openai",
    model: "anthropic/claude-sonnet-5",
    baseUrl: "https://openrouter.ai/api/v1",
    env: "OPENROUTER_API_KEY",
  },
  {
    id: "groq",
    label: "Groq",
    dialect: "openai",
    model: "llama-3.3-70b-versatile",
    baseUrl: "https://api.groq.com/openai/v1",
    env: "GROQ_API_KEY",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    dialect: "openai",
    model: "llama3.2",
    baseUrl: "http://127.0.0.1:11434/v1",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    dialect: "openai",
    model: "local-model",
    baseUrl: "http://127.0.0.1:1234/v1",
  },
  {
    id: "vllm",
    label: "vLLM (local)",
    dialect: "openai",
    model: "local-model",
    baseUrl: "http://127.0.0.1:8000/v1",
  },
  {
    id: "custom",
    label: "Anything else that speaks the OpenAI API",
    dialect: "openai",
    model: "local-model",
  },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/**
 * What an older config means.
 *
 * Before the catalog, `provider` was a dialect and `auth` said how to get a
 * credential for it. Those pairs still name exactly one service each, so they
 * are translated rather than rejected: a config someone wrote last month is
 * not a mistake.
 */
export function presetFor(provider: string, auth: string | undefined): Preset | undefined {
  const named = findPreset(provider);
  if (named !== undefined && named.id !== "openai" && named.id !== "anthropic") return named;

  if (provider === "openai") {
    if (auth === "codex") return findPreset("codex");
    if (auth === "subscription") return findPreset("subscription");
    return findPreset("openai");
  }
  return named;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test tests/providers/catalog.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/providers/catalog.ts tests/providers/catalog.test.ts
git commit -F - <<'MSG'
feat: a catalog of provider presets

`provider: openai` named a wire format, so connecting a local server
meant knowing that the openai provider accepts a baseUrl at all — a
fact nothing in the config hinted at.

OpenRouter, Groq, Ollama, LM Studio and vLLM are all that same dialect
with a different address, key variable and default model, so they
become data. Adding a service is now an entry in a list.

presetFor translates the old provider+auth pair onto a preset, because
a config written last month is not a mistake.
MSG
```

---

### Task 3: Configuration precedence

**Files:**
- Modify: `src/cli/config.ts`
- Test: `tests/cli/precedence.test.ts`

**Interfaces:**
- Consumes: `GlobalSettings`, `readSettings`, `settingsPath` (Task 1); `Preset`, `findPreset`, `presetFor` (Task 2).
- Produces: `loadConfig(root: string, env?: Record<string, string | undefined>, home?: string): Promise<VesnaConfig>` with two new optional parameters for testing, and `VesnaConfig.preset: Preset` added to the existing shape. `VesnaConfig.configured` changes meaning to "there is something to work with".

Keep `VesnaConfig.provider`, `auth`, `model` and `baseUrl` populated as they are today — every existing caller reads them, and this task is about where the values come from, not about renaming them.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/cli/config";
import { settingsPath, writeSettings } from "../../src/cli/settings";

function withDirs(fn: (root: string, home: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "vesna-prec-root-"));
  const home = mkdtempSync(join(tmpdir(), "vesna-prec-home-"));
  return fn(root, home).finally(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
}

function project(root: string, yaml: string) {
  mkdirSync(join(root, ".vesna"), { recursive: true });
  writeFileSync(join(root, ".vesna", "config.yaml"), yaml);
}

test("with nothing anywhere, the built-in default applies and nothing is configured", async () => {
  await withDirs(async (root, home) => {
    const config = await loadConfig(root, {}, home);
    expect(config.preset.id).toBe("anthropic");
    expect(config.configured).toBe(false);
  });
});

test("global settings supply the provider when the project says nothing", async () => {
  await withDirs(async (root, home) => {
    writeSettings(settingsPath({}, home), { provider: "groq", model: "llama-3.3-70b-versatile" });
    const config = await loadConfig(root, {}, home);
    expect(config.preset.id).toBe("groq");
    expect(config.model).toBe("llama-3.3-70b-versatile");
    expect(config.configured).toBe(true);
  });
});

test("the project config beats global settings", async () => {
  await withDirs(async (root, home) => {
    writeSettings(settingsPath({}, home), { provider: "groq" });
    project(root, "provider: anthropic\n");
    const config = await loadConfig(root, {}, home);
    expect(config.preset.id).toBe("anthropic");
  });
});

test("a project model applies over a global one", async () => {
  await withDirs(async (root, home) => {
    writeSettings(settingsPath({}, home), { provider: "groq", model: "global-model" });
    project(root, "provider: groq\nmodel: project-model\n");
    expect((await loadConfig(root, {}, home)).model).toBe("project-model");
  });
});

test("a preset supplies the model when neither file names one", async () => {
  await withDirs(async (root, home) => {
    writeSettings(settingsPath({}, home), { provider: "ollama" });
    expect((await loadConfig(root, {}, home)).model).toBe("llama3.2");
  });
});

test("a preset supplies the base URL, and the project can override it", async () => {
  await withDirs(async (root, home) => {
    writeSettings(settingsPath({}, home), { provider: "ollama" });
    expect((await loadConfig(root, {}, home)).baseUrl).toBe("http://127.0.0.1:11434/v1");

    project(root, "provider: ollama\nbaseUrl: http://10.0.0.2:11434/v1\n");
    expect((await loadConfig(root, {}, home)).baseUrl).toBe("http://10.0.0.2:11434/v1");
  });
});

test("a config written before the catalog still resolves", async () => {
  await withDirs(async (root, home) => {
    project(root, "provider: openai\nauth: codex\n");
    const config = await loadConfig(root, {}, home);
    expect(config.preset.id).toBe("codex");
    expect(config.provider).toBe("openai");
    expect(config.auth).toBe("codex");
  });
});

test("a project that pins a provider is reported, so a command can say so", async () => {
  await withDirs(async (root, home) => {
    project(root, "provider: anthropic\n");
    expect((await loadConfig(root, {}, home)).pinned).toBe(true);

    const other = mkdtempSync(join(tmpdir(), "vesna-prec-none-"));
    expect((await loadConfig(other, {}, home)).pinned).toBe(false);
    rmSync(other, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/cli/precedence.test.ts`
Expected: FAIL — `loadConfig` takes one argument and `config.preset` is undefined.

- [ ] **Step 3: Write the implementation**

In `src/cli/config.ts`, add to the `VesnaConfig` interface:

```ts
  /** The resolved service, from the catalog. */
  preset: Preset;
  /** True when the project config names a provider, so a command can say it cannot change it here. */
  pinned: boolean;
```

Change the signature and the resolution. `loadConfig` keeps reading the project file exactly as it does today; the new part is the fallback chain underneath it:

```ts
export async function loadConfig(
  root: string,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): Promise<VesnaConfig> {
  // …existing project-file reading, producing `raw` and `text`…

  const settings = readSettings(settingsPath(env, home));

  const pinned = typeof raw.provider === "string" && raw.provider !== "";
  const providerName =
    (pinned ? (raw.provider as string) : undefined) ?? settings.provider ?? "anthropic";
  const preset =
    presetFor(providerName, typeof raw.auth === "string" ? raw.auth : undefined) ??
    findPreset("anthropic")!;

  const model = raw.model ?? settings.model ?? preset.model;
  const baseUrl = raw.baseUrl ?? settings.baseUrl ?? preset.baseUrl;

  return {
    // `configured` used to mean "a project file exists". It now means "there
    // is something to work with", which is the question every caller was
    // actually asking.
    configured: text !== null || settings.provider !== undefined,
    preset,
    pinned,
    provider: preset.dialect === "anthropic" ? "anthropic" : "openai",
    auth: preset.auth ?? "key",
    model,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    // …the rest of the existing fields, unchanged…
  };
}
```

Import `homedir` from `node:os`, `readSettings`/`settingsPath` from `./settings`, and `findPreset`/`presetFor`/`type Preset` from `../providers/catalog`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test tests/cli/precedence.test.ts && bun test && bun run typecheck`
Expected: the new file passes 8 tests; the whole suite stays green. If an existing test asserted that `configured` is false when only a global file exists, update it — the meaning changed deliberately, and the spec says so.

- [ ] **Step 5: Commit**

```bash
git add src/cli/config.ts tests/cli/precedence.test.ts
git commit -F - <<'MSG'
feat: settings fall back from project to machine to preset

Precedence is now flag, then project config, then machine settings,
then the preset's own default. A directory with no .vesna in it is a
working directory rather than an unconfigured one.

`configured` changes meaning with it: it reported whether a project
file existed, and now reports whether there is anything to work with,
which is the question every caller was already asking.

`pinned` is new and exists so that /provider can tell the truth. When
a project names a provider, the command cannot change it here, and
silently doing nothing would be the worse failure.
MSG
```

---

### Task 4: Move `authCommand` out of the dispatcher

**Files:**
- Create: `src/cli/authcmd.ts`
- Modify: `src/cli/main.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `authCommand(target: string | undefined, config: VesnaConfig, theme: Theme, root: string): Promise<number>`, moved verbatim.

Pure refactor. No behaviour changes, no new tests — the existing auth tests are the proof.

- [ ] **Step 1: Confirm the current state is green**

Run: `bun test tests/cli`
Expected: PASS. Note the count.

- [ ] **Step 2: Move the function**

Cut `authCommand` from `src/cli/main.ts` into a new `src/cli/authcmd.ts`, exporting it, and carry its imports with it: `homedir` from `node:os`, `browserLogin`, `authPath`/`saveAuth`, `inspectCredential`/`problem`/`remedy`/`usable`, `createStdioPrompt`, `EXIT`, and the `VesnaConfig` and `Theme` types. Add the file comment:

```ts
/**
 * The auth command, which is a screenful of reporting rather than a branch.
 *
 * It lived in main.ts, where 130 lines of one function sat between the
 * dispatcher and the commands it dispatches to. Nothing else about it changes.
 */
```

In `main.ts`, replace the definition with `import { authCommand } from "./authcmd";` and drop imports that no longer have a user there.

- [ ] **Step 3: Run the whole suite and the typechecker**

Run: `bun test && bun run typecheck`
Expected: PASS with the same count as Step 1. Any drop means something moved that should not have.

- [ ] **Step 4: Commit**

```bash
git add src/cli/authcmd.ts src/cli/main.ts
git commit -F - <<'MSG'
refactor: move the auth command out of the dispatcher

130 lines of one function sat between main's dispatcher and the
commands it dispatches to. The work ahead adds cases to that switch,
and this is the file it has to stay readable in.

No behaviour change; the existing auth tests are the proof.
MSG
```

---

### Task 5: A provider you can swap

**Files:**
- Modify: `src/cli/context.ts`
- Test: `tests/cli/handle.test.ts`

**Interfaces:**
- Consumes: `Preset` (Task 2), `VesnaConfig.preset` (Task 3).
- Produces: `interface ProviderHandle extends Provider { readonly preset: Preset; readonly model: string; switch(preset: Preset, model: string, baseUrl?: string): Promise<void> }`, and `buildContext` returning `provider: ProviderHandle` in place of the bare `Provider`.

The handle *is* a `Provider` — `id` is a getter and `complete` delegates — so `createLlmNode(provider, prices)` and every other consumer keep their current signatures. That is the whole reason to prefer it over rebuilding the context or threading `() => Provider` through every call site.

`buildProvider` changes to take a `Preset` plus a model and base URL rather than reading a `VesnaConfig`, so the handle can build a second one later.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { createProviderHandle } from "../../src/cli/context";
import { findPreset } from "../../src/providers/catalog";
import type { CompletionRequest, CompletionResult, Provider } from "../../src/providers/types";

function stub(id: string): Provider {
  return {
    id,
    async complete(_request: CompletionRequest): Promise<CompletionResult> {
      return {
        content: [{ type: "text", text: id }],
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: id,
      };
    },
  };
}

const anthropic = findPreset("anthropic")!;
const ollama = findPreset("ollama")!;

test("the handle answers as the provider it currently holds", async () => {
  const handle = await createProviderHandle(anthropic, "claude-opus-5", undefined, async (p) =>
    stub(p.id),
  );
  const result = await handle.complete({ model: "m", messages: [] });
  expect(result.model).toBe("anthropic");
  expect(handle.id).toBe("anthropic");
});

test("switching changes who answers, without a new handle", async () => {
  const handle = await createProviderHandle(anthropic, "claude-opus-5", undefined, async (p) =>
    stub(p.id),
  );
  await handle.switch(ollama, "qwen3");
  expect((await handle.complete({ model: "m", messages: [] })).model).toBe("ollama");
  expect(handle.preset.id).toBe("ollama");
  expect(handle.model).toBe("qwen3");
});

test("a build that throws leaves the working provider in place", async () => {
  const handle = await createProviderHandle(anthropic, "claude-opus-5", undefined, async (p) => {
    if (p.id === "ollama") throw new Error("refused");
    return stub(p.id);
  });
  await expect(handle.switch(ollama, "qwen3")).rejects.toThrow("refused");
  expect(handle.preset.id).toBe("anthropic");
  expect((await handle.complete({ model: "m", messages: [] })).model).toBe("anthropic");
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/cli/handle.test.ts`
Expected: FAIL — `createProviderHandle` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/cli/context.ts`, replace `buildProvider(config)` with a preset-driven builder and add the handle:

```ts
export interface ProviderHandle extends Provider {
  readonly preset: Preset;
  readonly model: string;
  switch(preset: Preset, model: string, baseUrl?: string): Promise<void>;
}

export type BuildProvider = (
  preset: Preset,
  baseUrl: string | undefined,
) => Promise<Provider>;

export async function buildProviderFor(
  preset: Preset,
  baseUrl: string | undefined,
): Promise<Provider> {
  if (preset.dialect === "anthropic") return createAnthropicProvider();

  if (preset.dialect === "responses" && preset.auth === "codex") {
    const path = codexAuthPath(process.env, homedir());
    const auth = await readCodexAuth(path);
    return createResponsesProvider({
      id: preset.id,
      baseUrl: baseUrl ?? preset.baseUrl ?? CODEX_BASE_URL,
      token: createCodexTokenSource({ path }),
      alwaysStream: true,
      ...(auth?.accountId ? { accountId: auth.accountId } : {}),
    });
  }

  if (preset.dialect === "responses") {
    throw new Error(
      "auth: subscription needs an oauth block in .vesna/config.yaml (issuer, clientId, baseUrl)",
    );
  }

  return createOpenAICompatibleProvider({ baseUrl: baseUrl ?? preset.baseUrl, id: preset.id });
}

/**
 * One reference the rest of the program holds, pointing at a provider that can
 * change underneath it.
 *
 * It satisfies Provider itself, so the llm node and every other consumer keep
 * the signature they have. Rebuilding the whole context on a switch would have
 * destroyed the registry, the spec sink and everything the session had
 * accumulated; threading `() => Provider` everywhere would have spread late
 * binding across every signature to make one point mutable.
 */
export async function createProviderHandle(
  preset: Preset,
  model: string,
  baseUrl: string | undefined,
  build: BuildProvider = buildProviderFor,
): Promise<ProviderHandle> {
  let current = await build(preset, baseUrl);
  let currentPreset = preset;
  let currentModel = model;

  return {
    get id() {
      return current.id;
    },
    get preset() {
      return currentPreset;
    },
    get model() {
      return currentModel;
    },
    complete(request) {
      return current.complete(request);
    },
    async switch(next, nextModel, nextBaseUrl) {
      // Build before assigning: a switch to something unreachable must leave
      // the conversation on the provider that still works.
      const built = await build(next, nextBaseUrl);
      current = built;
      currentPreset = next;
      currentModel = nextModel;
    },
  };
}
```

The subscription branch keeps its existing behaviour: retain the `config.oauth` path by passing the oauth block through from `buildContext` when `preset.auth === "subscription"`. Keep that code where it is today — move it into `buildProviderFor` behind an extra optional `oauth` parameter rather than deleting it.

In `buildContext`, replace `const provider = await buildProvider(config)` with:

```ts
const provider = await createProviderHandle(config.preset, config.model, config.baseUrl);
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test tests/cli/handle.test.ts && bun test && bun run typecheck`
Expected: the new file passes 3 tests; the suite stays green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/context.ts tests/cli/handle.test.ts
git commit -F - <<'MSG'
feat: a provider handle that can be swapped mid-session

/provider has to change who answers without disturbing the session,
the registry, the store or the open spec. The handle satisfies Provider
itself, so the llm node and every other consumer keep the signature
they already have.

Rebuilding the whole context would have destroyed everything the
session accumulated; threading `() => Provider` through every call site
would have spread late binding everywhere to make one point mutable.

A switch builds before it assigns, so pointing at an unreachable
endpoint leaves the conversation on the provider that still works.
MSG
```

---

### Task 6: Carrying history across a switch

**Files:**
- Create: `src/loop/carry.ts`
- Test: `tests/loop/carry.test.ts`

**Interfaces:**
- Consumes: `AgentMessage`, `ContentBlock` from `src/providers/types.ts`.
- Produces: `interface Carried { messages: AgentMessage[]; dropped: number }`, `carryHistory(messages: AgentMessage[]): Carried`.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { carryHistory } from "../../src/loop/carry";
import type { AgentMessage } from "../../src/providers/types";

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }] });

test("a plain conversation crosses untouched", () => {
  const messages = [user("hello"), { role: "assistant", content: [{ type: "text", text: "hi" }] }];
  const carried = carryHistory(messages as AgentMessage[]);
  expect(carried.messages).toEqual(messages as AgentMessage[]);
  expect(carried.dropped).toBe(0);
});

test("an answered tool call crosses, because nothing about it is dialect-specific", () => {
  const messages: AgentMessage[] = [
    user("read it"),
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "c1", name: "read", input: { path: "a" } }],
    },
    { role: "user", content: [{ type: "tool_result", callId: "c1", content: "ok" }] },
  ];
  const carried = carryHistory(messages);
  expect(carried.dropped).toBe(0);
  expect(carried.messages).toHaveLength(3);
});

test("a call with no answer is dropped, because both APIs reject it", () => {
  const messages: AgentMessage[] = [
    user("read it"),
    {
      role: "assistant",
      content: [
        { type: "text", text: "reading" },
        { type: "tool_call", id: "c1", name: "read", input: { path: "a" } },
      ],
    },
  ];
  const carried = carryHistory(messages);
  expect(carried.dropped).toBe(1);
  expect(carried.messages[1]!.content).toEqual([{ type: "text", text: "reading" }]);
});

test("a result with no call is dropped too", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "tool_result", callId: "ghost", content: "ok" }] },
  ];
  expect(carryHistory(messages).dropped).toBe(1);
});

test("a message left empty by dropping is removed rather than sent blank", () => {
  const messages: AgentMessage[] = [
    user("go"),
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "c1", name: "read", input: {} }],
    },
  ];
  const carried = carryHistory(messages);
  expect(carried.messages).toHaveLength(1);
  expect(carried.messages[0]).toEqual(user("go"));
});

test("two unanswered calls count as two", () => {
  const messages: AgentMessage[] = [
    user("go"),
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "c1", name: "read", input: {} },
        { type: "tool_call", id: "c2", name: "read", input: {} },
      ],
    },
  ];
  expect(carryHistory(messages).dropped).toBe(2);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/loop/carry.test.ts`
Expected: FAIL — cannot resolve `../../src/loop/carry`.

- [ ] **Step 3: Write the implementation**

```ts
import type { AgentMessage, ContentBlock } from "../providers/types";

/**
 * History, moved to a different provider.
 *
 * Almost nothing has to happen here, and that is worth stating: ContentBlock is
 * Vesna's own shape, providers translate at the edge, tool-call identifiers are
 * opaque strings everywhere, and reasoning never enters history because there
 * is no such block. So a conversation crosses intact.
 *
 * One thing genuinely cannot cross. A tool call with no result after it — what
 * an interrupt in the middle of a tool leaves behind — is rejected by both
 * APIs. Those are dropped, and only those, and the caller is told how many so
 * it can say so rather than pretend the transcript is whole.
 */
export interface Carried {
  messages: AgentMessage[];
  dropped: number;
}

export function carryHistory(messages: AgentMessage[]): Carried {
  const answered = new Set<string>();
  const called = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_result") answered.add(block.callId);
      if (block.type === "tool_call") called.add(block.id);
    }
  }

  let dropped = 0;
  const kept: AgentMessage[] = [];

  for (const message of messages) {
    const content = message.content.filter((block: ContentBlock) => {
      if (block.type === "tool_call" && !answered.has(block.id)) {
        dropped += 1;
        return false;
      }
      if (block.type === "tool_result" && !called.has(block.callId)) {
        dropped += 1;
        return false;
      }
      return true;
    });

    // A message emptied by the filter would be sent as a blank turn, which is
    // its own kind of malformed.
    if (content.length > 0) kept.push({ role: message.role, content });
  }

  return { messages: kept, dropped };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test tests/loop/carry.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/loop/carry.ts tests/loop/carry.test.ts
git commit -F - <<'MSG'
feat: carry a conversation across a change of provider

Almost nothing has to happen here, which was worth finding out before
writing code to do more. ContentBlock is Vesna's own shape, providers
translate at the edge, call identifiers are opaque strings everywhere,
and reasoning never enters history because no such block exists.

What cannot cross is an unpaired tool call — what an interrupt in the
middle of a tool leaves behind — which both APIs reject. Those are
dropped and counted, so the transcript can say a piece is missing
instead of implying it is whole.
MSG
```

---

### Task 7: `/provider`

**Files:**
- Modify: `src/cli/chatcmd.ts`, `src/tui/app.ts`
- Test: `tests/cli/providercmd.test.ts`

**Interfaces:**
- Consumes: `PRESETS`/`findPreset` (Task 2), `VesnaConfig.pinned` (Task 3), `ProviderHandle` (Task 5), `carryHistory` (Task 6), `readSettings`/`writeSettings`/`settingsPath` (Task 1).
- Produces: `describeProviders(current: string, env: Record<string, string | undefined>): string[]` and `switchOutcome(...)` in `src/cli/chatcmd.ts`, so the decision is testable without a terminal.

Keeping the wording in a pure function is how the other TUI logic in this codebase stays tested: `app.ts` renders, it does not decide.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { CHAT_COMMANDS, parseChatInput } from "../../src/cli/chatcmd";
import { describeProviders, switchOutcome } from "../../src/cli/chatcmd";

test("/provider is a command the parser knows", () => {
  expect(CHAT_COMMANDS.map((c) => c.name)).toContain("provider");
  expect(parseChatInput("/provider ollama")).toEqual({
    kind: "command",
    name: "provider",
    argument: "ollama",
  });
});

test("the listing marks the current one and says where a key was found", () => {
  const lines = describeProviders("groq", { GROQ_API_KEY: "x" });
  expect(lines.some((line) => line.includes("groq") && line.includes("current"))).toBe(true);
  expect(lines.some((line) => line.includes("$GROQ_API_KEY"))).toBe(true);
  expect(lines.some((line) => line.includes("ollama") && line.includes("no key needed"))).toBe(
    true,
  );
});

test("an unknown name is refused with the list, not silently ignored", () => {
  const outcome = switchOutcome("nope", { pinned: false, dropped: 0 });
  expect(outcome.kind).toBe("unknown");
});

test("switching reports the loss only when there was one", () => {
  expect(switchOutcome("ollama", { pinned: false, dropped: 0 }).message).toBe(
    "provider: ollama  model llama3.2",
  );
  expect(switchOutcome("ollama", { pinned: false, dropped: 2 }).message).toContain(
    "dropped 2 unanswered tool calls",
  );
  expect(switchOutcome("ollama", { pinned: false, dropped: 1 }).message).toContain(
    "dropped 1 unanswered tool call",
  );
});

test("a pinned project is told it is pinned, rather than seeing nothing happen", () => {
  const outcome = switchOutcome("ollama", { pinned: true, dropped: 0 });
  expect(outcome.kind).toBe("pinned");
  expect(outcome.message).toContain(".vesna/config.yaml");
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/cli/providercmd.test.ts`
Expected: FAIL — `describeProviders` is not exported and `provider` is not in `CHAT_COMMANDS`.

- [ ] **Step 3: Write the implementation**

Add to `CHAT_COMMANDS` in `src/cli/chatcmd.ts`, before `help`:

```ts
  { name: "provider", help: "list services, or switch: /provider ollama" },
  { name: "model", help: "list models, or switch: /model qwen3" },
```

And, in the same file:

```ts
import { PRESETS, findPreset } from "../providers/catalog";

export function describeProviders(
  current: string,
  env: Record<string, string | undefined>,
): string[] {
  return PRESETS.map((preset) => {
    const mark = preset.id === current ? "  (current)" : "";
    const credential =
      preset.env === undefined
        ? preset.auth === "codex"
          ? "borrowed from codex"
          : "no key needed"
        : env[preset.env]
          ? `$${preset.env}`
          : `needs $${preset.env}`;
    return `${preset.id.padEnd(13)}${credential.padEnd(22)}${preset.label}${mark}`;
  });
}

export type SwitchOutcome =
  | { kind: "unknown"; message: string }
  | { kind: "pinned"; message: string }
  | { kind: "switched"; message: string };

export function switchOutcome(
  id: string,
  state: { pinned: boolean; dropped: number },
): SwitchOutcome {
  const preset = findPreset(id);
  if (preset === undefined) {
    return { kind: "unknown", message: `no provider called "${id}" — /provider for the list` };
  }
  if (state.pinned) {
    return {
      kind: "pinned",
      message:
        `this project pins its provider in .vesna/config.yaml — ` +
        `changed the machine default to ${id}, unchanged here`,
    };
  }
  const base = `provider: ${preset.id}  model ${preset.model}`;
  if (state.dropped === 0) return { kind: "switched", message: base };
  const plural = state.dropped === 1 ? "call" : "calls";
  return {
    kind: "switched",
    message: `${base}  ·  dropped ${state.dropped} unanswered tool ${plural}`,
  };
}
```

In `src/tui/app.ts`, add a handler alongside the existing `/theme` one. It lists when the argument is empty; otherwise it calls `switchOutcome`, and on `switched` or `pinned` it writes the new value with `writeSettings`, calls `carryHistory` on the session messages, and — only when not pinned — awaits `deps.provider.switch(preset, preset.model, preset.baseUrl)`. Report with `transcript.notice(outcome.message, outcome.kind === "unknown" ? "warn" : "ok")`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test tests/cli/providercmd.test.ts && bun test && bun run typecheck`
Expected: the new file passes 5 tests; the suite stays green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/chatcmd.ts src/tui/app.ts tests/cli/providercmd.test.ts
git commit -F - <<'MSG'
feat: /provider switches service from inside the conversation

Changing where the answers come from meant leaving, editing YAML and
coming back. It now takes one line, and the session, the open spec and
everything the conversation has accumulated survive it.

The wording lives in pure functions rather than in the renderer, so
what the command decides is tested without a terminal — the split the
rest of the TUI logic already follows.

A project that pins its provider is told so. The command changes the
machine default and says it did not change this directory, because a
command that appears to succeed and changes nothing is worse than one
that refuses.
MSG
```

---

### Task 8: `/model`

**Files:**
- Modify: `src/cli/chatcmd.ts`, `src/tui/app.ts`
- Create: `src/providers/models.ts`
- Test: `tests/providers/models.test.ts`

**Interfaces:**
- Consumes: `Preset` (Task 2), `ProviderHandle` (Task 5).
- Produces: `listModels(preset: Preset, baseUrl: string | undefined, fetchImpl?: typeof fetch): Promise<string[]>` in `src/providers/models.ts`. `/model` is already registered in `CHAT_COMMANDS` by Task 7.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { listModels } from "../../src/providers/models";
import { findPreset } from "../../src/providers/catalog";

test("a built-in list is returned for providers with no models endpoint", async () => {
  const models = await listModels(findPreset("anthropic")!, undefined, async () => {
    throw new Error("must not be called");
  });
  expect(models.length).toBeGreaterThan(0);
  expect(models).toContain("claude-opus-5");
});

test("an openai-compatible endpoint is asked for its own list", async () => {
  const models = await listModels(
    findPreset("ollama")!,
    "http://127.0.0.1:11434/v1",
    async (input) => {
      expect(String(input)).toBe("http://127.0.0.1:11434/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "qwen3" }, { id: "llama3.2" }] }), {
        status: 200,
      });
    },
  );
  expect(models).toEqual(["llama3.2", "qwen3"]);
});

test("an endpoint that is not running falls back to the preset's model", async () => {
  const models = await listModels(findPreset("ollama")!, "http://127.0.0.1:11434/v1", async () => {
    throw new Error("ECONNREFUSED");
  });
  expect(models).toEqual(["llama3.2"]);
});

test("a malformed answer falls back rather than throwing", async () => {
  const models = await listModels(
    findPreset("ollama")!,
    "http://127.0.0.1:11434/v1",
    async () => new Response("not json", { status: 200 }),
  );
  expect(models).toEqual(["llama3.2"]);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/providers/models.test.ts`
Expected: FAIL — cannot resolve `../../src/providers/models`.

- [ ] **Step 3: Write the implementation**

```ts
import type { Preset } from "./catalog";

/**
 * What you can ask for.
 *
 * For the two services with a fixed roster the list is written down. For
 * anything speaking the OpenAI API it is asked of the endpoint itself — a
 * question to a service already configured and already being talked to, which
 * is a different thing from scanning the machine for servers.
 */
const BUILT_IN: Record<string, string[]> = {
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  codex: ["gpt-5.6-sol"],
  subscription: ["gpt-5.6-sol"],
};

export async function listModels(
  preset: Preset,
  baseUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const known = BUILT_IN[preset.id];
  if (known !== undefined) return known;

  const base = baseUrl ?? preset.baseUrl;
  if (base === undefined) return [preset.model];

  try {
    const response = await fetchImpl(`${base.replace(/\/$/, "")}/models`);
    if (!response.ok) return [preset.model];
    const body: any = await response.json();
    const ids = (body?.data ?? [])
      .map((entry: any) => entry?.id)
      .filter((id: unknown): id is string => typeof id === "string" && id !== "");
    // An endpoint that is up but has nothing loaded should not erase the
    // model the user already has configured.
    return ids.length > 0 ? ids.sort() : [preset.model];
  } catch {
    // Not running, wrong address, no network: the preset's own model is still
    // a true answer to "what can I ask for".
    return [preset.model];
  }
}
```

In `src/tui/app.ts`, handle `/model`: with no argument, call `listModels` and print each with the current one marked; with an argument, `await deps.provider.switch(deps.provider.preset, argument, config.baseUrl)`, persist with `writeSettings`, and notice `model: <name>`. Respect `pinned` the same way `/provider` does, reusing `switchOutcome`'s `pinned` branch wording adapted to the model.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test tests/providers/models.test.ts && bun test && bun run typecheck`
Expected: the new file passes 4 tests; the suite stays green.

- [ ] **Step 5: Commit**

```bash
git add src/providers/models.ts src/cli/chatcmd.ts src/tui/app.ts tests/providers/models.test.ts
git commit -F - <<'MSG'
feat: /model lists and switches the model

For Anthropic and the subscription the roster is written down. For
anything speaking the OpenAI API the endpoint is asked for its own
list — a question to a service already configured and already in use,
which is not the same as scanning the machine for servers.

Every failure falls back to the model already configured, because an
endpoint that is down does not make the current answer untrue.
MSG
```

---

### Task 9: Onboarding

**Files:**
- Create: `src/cli/onboard.ts`
- Test: `tests/cli/onboard.test.ts`

**Interfaces:**
- Consumes: `PRESETS`/`findPreset` (Task 2), `writeSettings`/`settingsPath` (Task 1), `buildProviderFor` (Task 5).
- Produces: `interface OnboardIo { write(text: string): void; question(prompt: string): Promise<string> }`, `needsOnboarding(config: VesnaConfig): boolean`, `runOnboarding(options: { io: OnboardIo; env: Record<string, string | undefined>; home: string; verify(preset: Preset, model: string, baseUrl?: string): Promise<string> }): Promise<boolean>`.

`verify` is injected so the test can assert it was called without reaching the network. It returns the model name that answered.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsOnboarding, runOnboarding } from "../../src/cli/onboard";
import { readSettings, settingsPath } from "../../src/cli/settings";

function io(answers: string[]) {
  const written: string[] = [];
  return {
    written,
    write: (text: string) => written.push(text),
    question: async () => answers.shift() ?? "",
  };
}

function withHome(fn: (home: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "vesna-onboard-"));
  return fn(home).finally(() => rmSync(home, { recursive: true, force: true }));
}

test("onboarding is needed when there is nothing to work with", () => {
  expect(needsOnboarding({ configured: false } as any)).toBe(true);
  expect(needsOnboarding({ configured: true } as any)).toBe(false);
});

test("a choice is written to the machine settings and verified with a real call", async () => {
  await withHome(async (home) => {
    let verified: string | null = null;
    const screen = io(["ollama", ""]);
    const done = await runOnboarding({
      io: screen,
      env: {},
      home,
      async verify(preset, model) {
        verified = `${preset.id}/${model}`;
        return model;
      },
    });

    expect(done).toBe(true);
    expect(verified).toBe("ollama/llama3.2");
    expect(readSettings(settingsPath({}, home)).provider).toBe("ollama");
  });
});

test("a failed verification does not report success and does not write settings", async () => {
  await withHome(async (home) => {
    const screen = io(["ollama", ""]);
    const done = await runOnboarding({
      io: screen,
      env: {},
      home,
      async verify() {
        throw new Error("connection refused");
      },
    });

    expect(done).toBe(false);
    expect(screen.written.join("\n")).toContain("connection refused");
    expect(existsSync(settingsPath({}, home))).toBe(false);
  });
});

test("a key already in the environment is offered rather than asked for", async () => {
  await withHome(async (home) => {
    const screen = io(["groq", ""]);
    await runOnboarding({
      io: screen,
      env: { GROQ_API_KEY: "sk-test" },
      home,
      async verify(_preset, model) {
        return model;
      },
    });
    expect(screen.written.join("\n")).toContain("$GROQ_API_KEY");
  });
});

test("an unknown answer asks again instead of giving up", async () => {
  await withHome(async (home) => {
    const screen = io(["nonsense", "ollama", ""]);
    const done = await runOnboarding({
      io: screen,
      env: {},
      home,
      async verify(_preset, model) {
        return model;
      },
    });
    expect(done).toBe(true);
    expect(readSettings(settingsPath({}, home)).provider).toBe("ollama");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/cli/onboard.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/onboard`.

- [ ] **Step 3: Write the implementation**

Write `src/cli/onboard.ts` with `needsOnboarding` returning `!config.configured`, and `runOnboarding` doing exactly three things in order: print the catalog (marking presets whose `env` is set in `env`, and saying `$NAME` for them), read a preset id in a loop until one resolves, read a model (empty accepts the preset default), then call `verify`. On success, `writeSettings`, print the model that answered, and return `true`. On failure, print the error message and return `false` without writing.

The file comment states the rule it exists to keep:

```ts
/**
 * The first five minutes.
 *
 * It ends with a real call, not with a written file. This codebase already
 * refuses to take a claim for a fact — task_verify will not mark a task done
 * on the agent's word, it runs a command and reads the exit status — and an
 * onboarding that announces success without ever reaching a model is the same
 * lie told to the user instead of by the agent.
 *
 * Nothing is written until the call succeeds. A settings file pointing at an
 * endpoint that never answered is worse than no settings file: it turns the
 * next run into a puzzle rather than a fresh start.
 */
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test tests/cli/onboard.test.ts && bun test && bun run typecheck`
Expected: the new file passes 5 tests; the suite stays green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/onboard.ts tests/cli/onboard.test.ts
git commit -F - <<'MSG'
feat: onboarding that ends with a real call

This codebase already refuses to take a claim for a fact: task_verify
will not mark a task done on the agent's word, it runs a command and
reads the exit status. An onboarding that writes a file and announces
success without reaching a model tells the user that same lie.

So it makes the call, and writes nothing until the call answers. A
settings file pointing at an endpoint that never replied is worse than
no file at all — it turns the next run into a puzzle instead of a
fresh start.
MSG
```

---

### Task 10: The bare command, and what `init` becomes

**Files:**
- Modify: `src/cli/main.ts`
- Test: `tests/cli/dispatch.test.ts`

**Interfaces:**
- Consumes: `needsOnboarding`/`runOnboarding` (Task 9), everything prior.
- Produces: `route(argv: string[], state: { configured: boolean }): "chat" | "onboard" | "usage" | "error" | string` exported from `src/cli/main.ts`, so dispatch is testable without starting a terminal.

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test";
import { route } from "../../src/cli/main";

test("bare vesna opens the chat when there is something to work with", () => {
  expect(route([], { configured: true })).toBe("chat");
});

test("bare vesna onboards when there is not", () => {
  expect(route([], { configured: false })).toBe("onboard");
});

test("an explicit command is still itself, configured or not", () => {
  expect(route(["do", "task"], { configured: true })).toBe("do");
  expect(route(["auth"], { configured: false })).toBe("auth");
  expect(route(["chat"], { configured: true })).toBe("chat");
});

test("help and version are answers, not misuse", () => {
  expect(route(["--help"], { configured: false })).toBe("usage");
  expect(route(["--version"], { configured: false })).toBe("version");
});

test("an unknown first word stays an error rather than becoming a task", () => {
  expect(route(["fix the tests"], { configured: true })).toBe("error");
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `bun test tests/cli/dispatch.test.ts`
Expected: FAIL — `route` is not exported from `src/cli/main`.

- [ ] **Step 3: Write the implementation**

In `src/cli/main.ts`:

```ts
const COMMANDS = new Set([
  "init", "chat", "do", "run", "heal", "crystallize",
  "flows", "traces", "auth", "doctor",
]);

/**
 * What the arguments ask for.
 *
 * Bare `vesna` is the whole point of this: the program should do its job when
 * you run it, and set itself up when it cannot. An unrecognised first word
 * stays an error — reading it as a task would let a mistyped command start
 * work nobody asked for.
 */
export function route(argv: string[], state: { configured: boolean }): string {
  const [command] = argv;
  if (isHelp(command)) return "usage";
  if (isVersion(command)) return "version";
  if (command === undefined) return state.configured ? "chat" : "onboard";
  if (COMMANDS.has(command)) return command;
  return "error";
}
```

Wire it into `main`: compute `earlyConfig` first, then `route(argv, { configured: earlyConfig.configured })`. On `"onboard"`, run `runOnboarding`; if it returns `true`, reload the config and fall through into the chat in the same process. On `"usage"` print `USAGE`, on `"version"` print `VERSION`, on `"error"` print the existing unknown-command message.

Update the usage text: `vesna` first, and `init` described by what it now does.

```ts
const USAGE = [
  "usage:",
  "  vesna                                   open the chat; sets you up on the first run",
  "  vesna do \"<task>\"                       solve a task live and record a trace",
  "  vesna init                              pin the current settings to this repository",
  // …the remaining lines unchanged, with `chat [--plain]` kept as an explicit alias…
].join("\n");
```

Change `init` to write a project config from the effective settings rather than from `chooseStarter`: it now means "pin what I am using to this repository", which is what it is for once machine-wide settings exist. Keep `writeStarterConfig`'s refusal to overwrite.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test tests/cli/dispatch.test.ts && bun test && bun run typecheck`
Expected: the new file passes 5 tests; the suite stays green.

- [ ] **Step 5: Verify by hand, from an installed package**

```bash
npm pack
cd "$(mktemp -d)" && npm install --silent "$OLDPWD"/seasons-ai-vesna-*.tgz
VESNA_HOME="$PWD/home" ./node_modules/.bin/vesna
```

Expected: onboarding appears, not usage. Choose a provider you have, watch the verification call, land in the chat. Then run it again and expect the chat directly, with no questions.

- [ ] **Step 6: Commit**

```bash
git add src/cli/main.ts src/cli/init.ts tests/cli/dispatch.test.ts
git commit -F - <<'MSG'
feat: running vesna runs vesna

The bare command printed usage for a program you had not configured,
and the thing people want was behind the one word they had no reason
to guess. It now opens the chat, and sets you up first when there is
nothing to work with — continuing into the chat in the same process
rather than telling you to run another command.

An unrecognised first word stays an error. Reading it as a task would
let a mistyped command start work nobody asked for.

init keeps its name and changes its meaning to match the new layout:
it pins the settings you are using to this repository, which is what
it is for once settings live on the machine.
MSG
```

---

## Self-review

**Spec coverage.** Section 1 (two settings files, precedence, pinned reporting) → Tasks 1 and 3, with the pinned wording in Task 7. Section 2 (catalog, legacy compatibility, custom) → Task 2. Section 3 (`/provider`, `/model`, `GET /v1/models`, persistence) → Tasks 7 and 8. Section 4 (`ProviderHandle`, rejected alternatives, unpaired-call drop and its message) → Tasks 5 and 6. Section 5 (onboarding, catalog annotation, real call) → Task 9. Section 6 (bare command, `chat` alias, unknown word) → Task 10. Section 7 (`init` redefined) → Task 10. Non-goals: no port scanning (nothing in any task probes), no secrets in settings (Task 1 stores only `env`, Task 9 never writes a key), no third dialect (Task 2's `Dialect` is the existing three). Testing section → the tests named in each task, all six bullets covered.

**Placeholders.** None: every code step carries the code, every test step carries the assertions, and no task refers to another for its content.

**Type consistency.** `Preset` is defined once in Task 2 and used unchanged in 3, 5, 7, 8 and 9. `ProviderHandle.switch(preset, model, baseUrl?)` is defined in Task 5 and called with that shape in 7 and 8. `carryHistory` returns `{ messages, dropped }` in Task 6 and `dropped` is what Task 7 passes to `switchOutcome`. `settingsPath(env, home)` and `writeSettings(path, settings)` keep their argument order across 1, 3, 7, 8 and 9. `readSettings` returns `GlobalSettings` everywhere.
