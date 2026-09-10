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
