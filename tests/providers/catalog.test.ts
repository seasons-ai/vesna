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
