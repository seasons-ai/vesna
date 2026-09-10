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

// `config: { configured: true }` below only stands in for the real config
// `main.ts` passes in production. None of these tests inspect the
// "there is no .vesna/config.yaml here" line that a false value would add to
// `remedy()`'s output, so the exact value here does not affect any assertion.

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
      config: { configured: true } as any,
      async verify(preset, model) {
        verified = `${preset.id}/${model}`;
        return model;
      },
    });

    expect(done).toBe(true);
    // Cast needed: TS narrows `verified` to `null` here because the only
    // assignment happens inside the `verify` callback passed to
    // `runOnboarding`, a function boundary its control-flow analysis does
    // not see across — even though the callback demonstrably runs before
    // this line. The runtime behavior is unaffected.
    expect(verified as string | null).toBe("ollama/llama3.2");
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
      config: { configured: true } as any,
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
      config: { configured: true } as any,
      async verify(_preset, model) {
        return model;
      },
    });
    expect(screen.written.join("\n")).toContain("$GROQ_API_KEY");
  });
});

test("a needed key that is absent stops before the call, and writes nothing", async () => {
  await withHome(async (home) => {
    let called = false;
    const screen = io(["groq", ""]);
    const done = await runOnboarding({
      io: screen,
      env: {},
      home,
      config: { configured: true } as any,
      async verify() {
        called = true;
        return "unreachable";
      },
    });

    expect(done).toBe(false);
    expect(called).toBe(false);
    expect(screen.written.join("\n")).toContain("$GROQ_API_KEY");
    expect(existsSync(settingsPath({}, home))).toBe(false);
  });
});

test("an anthropic credential that is not ANTHROPIC_API_KEY still lets onboarding proceed", async () => {
  await withHome(async (home) => {
    let called = false;
    const screen = io(["anthropic", ""]);
    const done = await runOnboarding({
      io: screen,
      // No ANTHROPIC_API_KEY at all — only ANTHROPIC_AUTH_TOKEN, one of the
      // other sources src/cli/preflight.ts already knows about. A check
      // against ANTHROPIC_API_KEY alone would wrongly refuse this user.
      env: { ANTHROPIC_AUTH_TOKEN: "borrowed-token" },
      home,
      config: { configured: true } as any,
      async verify(_preset, model) {
        called = true;
        return model;
      },
    });

    expect(called).toBe(true);
    expect(done).toBe(true);
  });
});

test("an anthropic preset with no credential at all still refuses", async () => {
  await withHome(async (home) => {
    let called = false;
    const screen = io(["anthropic", ""]);
    const done = await runOnboarding({
      io: screen,
      env: {},
      home,
      config: { configured: true } as any,
      async verify() {
        called = true;
        return "unreachable";
      },
    });

    expect(done).toBe(false);
    expect(called).toBe(false);
    expect(existsSync(settingsPath({}, home))).toBe(false);
  });
});

test("an unknown answer asks again instead of giving up", async () => {
  await withHome(async (home) => {
    const screen = io(["nonsense", "ollama", ""]);
    const done = await runOnboarding({
      io: screen,
      env: {},
      home,
      config: { configured: true } as any,
      async verify(_preset, model) {
        return model;
      },
    });
    expect(done).toBe(true);
    expect(readSettings(settingsPath({}, home)).provider).toBe("ollama");
  });
});

/**
 * The design says `custom` asks for a base URL and a credential. It asked for
 * neither: the preset carries no address, so onboarding wrote
 * `{provider: custom, model: local-model}` and every later run went to
 * api.openai.com. The URL is the half that can be honoured today — see the
 * README for why the credential variable is not asked for yet.
 */
test("the custom service is asked for the address it does not carry", async () => {
  await withHome(async (home) => {
    let seen: string | null = null;
    const screen = io(["custom", "http://127.0.0.1:8080/v1", ""]);
    const done = await runOnboarding({
      io: screen,
      env: {},
      home,
      config: { configured: true } as any,
      async verify(_preset, model, baseUrl) {
        seen = baseUrl ?? "none";
        return model;
      },
    });

    expect(done).toBe(true);
    expect(seen as string | null).toBe("http://127.0.0.1:8080/v1");
    // Read back through the real loader: the next run has to find the address.
    expect(readSettings(settingsPath({}, home))).toEqual({
      provider: "custom",
      model: "local-model",
      baseUrl: "http://127.0.0.1:8080/v1",
    });
  });
});

test("an empty address is asked for again rather than accepted", async () => {
  await withHome(async (home) => {
    const screen = io(["custom", "", "http://127.0.0.1:9000/v1", ""]);
    await runOnboarding({
      io: screen,
      env: {},
      home,
      config: { configured: true } as any,
      async verify(_preset, model) {
        return model;
      },
    });
    expect(readSettings(settingsPath({}, home)).baseUrl).toBe("http://127.0.0.1:9000/v1");
  });
});

/**
 * `subscription` needs an `oauth` block that only a hand-written project config
 * can supply, and onboarding never touches a project directory — so it could be
 * chosen from this menu and never completed. It stays in the catalog, because
 * it works once configured; it stops being offered here.
 */
test("the subscription preset is not offered by a menu that cannot complete it", async () => {
  await withHome(async (home) => {
    const screen = io(["subscription", "ollama", ""]);
    const done = await runOnboarding({
      io: screen,
      env: {},
      home,
      config: { configured: true } as any,
      async verify(_preset, model) {
        return model;
      },
    });

    const written = screen.written.join("\n");
    // Not in the menu, and answering it anyway says why rather than "unknown".
    expect(written).not.toMatch(/^ {2}subscription —/m);
    expect(written).toContain("oauth block");
    expect(done).toBe(true);
    expect(readSettings(settingsPath({}, home)).provider).toBe("ollama");
  });
});
