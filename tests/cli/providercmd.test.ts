import { test, expect } from "bun:test";
import { CHAT_COMMANDS, parseChatInput } from "../../src/cli/chatcmd";
import {
  describeHeader,
  describeProviders,
  switchBlocked,
  switchFailed,
  switchOutcome,
} from "../../src/cli/chatcmd";
import { findPreset } from "../../src/providers/catalog";

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

// `pinned` in VesnaConfig is true whenever the project file names a provider
// at all, even a typo that resolves to nothing and falls back to a default
// (src/cli/config.ts). Naming that resolved default here — rather than the
// raw string, which the pinned message never even receives — is what keeps
// this command from telling a user "this project pins gruq" when the config
// never named anything real.
test("a pinned project names the resolved provider, never an unresolved typo", () => {
  const outcome = switchOutcome("ollama", { pinned: true, dropped: 0, active: "anthropic" });
  expect(outcome.kind).toBe("pinned");
  expect(outcome.message).toContain("anthropic");
  expect(outcome.message).not.toContain("gruq");
});

test("a failed switch names the provider and the error, not just a generic refusal", () => {
  const message = switchFailed("ollama", new Error("connect ECONNREFUSED 127.0.0.1:11434"));
  expect(message).toBe("could not switch to ollama: connect ECONNREFUSED 127.0.0.1:11434");
});

// The header is drawn from these two values every frame. They come in as
// arguments rather than being read off a config, because after a switch the
// pair in effect lives on the provider handle and the config is stale.
// The service, not the dialect: "openai/key" was the same string for Groq,
// OpenRouter, Ollama and OpenAI itself. The id is also what `/provider` takes,
// so the header names the argument that would bring you back here.
test("the header names the model and the service it is being asked through", () => {
  expect(describeHeader("llama3.2", findPreset("ollama")!)).toEqual({
    model: "llama3.2",
    service: "ollama",
  });
  expect(describeHeader("llama-3.3-70b-versatile", findPreset("groq")!)).toEqual({
    model: "llama-3.3-70b-versatile",
    service: "groq",
  });
  expect(describeHeader("gpt-5.6-sol", findPreset("codex")!)).toEqual({
    model: "gpt-5.6-sol",
    service: "codex",
  });
  expect(describeHeader("claude-opus-5", findPreset("anthropic")!)).toEqual({
    model: "claude-opus-5",
    service: "anthropic",
  });
});

// The refusal repeats the verdict `vesna auth` and the pre-chat check already
// give, rather than inventing a second opinion for this one surface.
test("a switch blocked by a missing credential says which one, and how to supply it", () => {
  const blocked = switchBlocked("groq", "GROQ_API_KEY is not set", [
    "  export GROQ_API_KEY=...   # or point baseUrl at a local host",
  ]);
  expect(blocked.message).toBe("not switching to groq: GROQ_API_KEY is not set");
  expect(blocked.hints).toEqual([
    "  export GROQ_API_KEY=...   # or point baseUrl at a local host",
  ]);
});

// `custom` names no address, so switching to it from a chat used to persist
// `{provider: custom, model: local-model}` with nowhere to send it — and every
// later run went to api.openai.com, unauthenticated.
test("switching to a service with no address is refused, and says where to put one", () => {
  const outcome = switchOutcome("custom", { pinned: false, dropped: 0 });
  expect(outcome.kind).toBe("unaddressed");
  expect(outcome.message).toBe(
    'custom has no address of its own — put a "baseUrl:" for it in ~/.vesna/settings.yaml ' +
      "or .vesna/config.yaml, then start Vesna again",
  );
});

test("a service with no address is refused even where only the machine default would move", () => {
  expect(switchOutcome("custom", { pinned: true, dropped: 0 }).kind).toBe("unaddressed");
});
