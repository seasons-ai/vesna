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

test("a needed key that is absent stops before the call, and writes nothing", async () => {
  await withHome(async (home) => {
    let called = false;
    const screen = io(["groq", ""]);
    const done = await runOnboarding({
      io: screen,
      env: {},
      home,
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
