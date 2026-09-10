import { test, expect } from "bun:test";
import { CHAT_COMMANDS, parseChatInput } from "../../src/cli/chatcmd";
import { describeModels, modelSwitchOutcome, switchFailed } from "../../src/cli/chatcmd";

test("/model is a command the parser knows", () => {
  expect(CHAT_COMMANDS.map((c) => c.name)).toContain("model");
  expect(parseChatInput("/model qwen3")).toEqual({
    kind: "command",
    name: "model",
    argument: "qwen3",
  });
});

test("the listing marks the current model and leaves the others alone", () => {
  expect(describeModels(["llama3.2", "qwen3"], "qwen3")).toEqual([
    "llama3.2",
    "qwen3  (current)",
  ]);
});

test("switching reports the model it switched to, and the loss only when there was one", () => {
  expect(modelSwitchOutcome("qwen3", { pinned: false, dropped: 0 }).message).toBe("model: qwen3");
  expect(modelSwitchOutcome("qwen3", { pinned: false, dropped: 2 }).message).toContain(
    "dropped 2 unanswered tool calls",
  );
  expect(modelSwitchOutcome("qwen3", { pinned: false, dropped: 1 }).message).toContain(
    "dropped 1 unanswered tool call",
  );
});

// The machine default is a whole service, not a loose model field. Announcing
// "the machine default model is now qwen3" without naming whose model moved is
// how `/model` came to change the machine's *provider* to whatever this
// directory happened to pin.
test("a pinned project is told which machine default moved, not this directory", () => {
  const outcome = modelSwitchOutcome("qwen3", {
    pinned: true,
    dropped: 0,
    machineProvider: "ollama",
  });
  expect(outcome.kind).toBe("pinned");
  expect(outcome.message).toBe(
    "this project pins its provider in .vesna/config.yaml — changed the machine " +
      "default model for ollama to qwen3, unchanged here",
  );
});

test("a pinned project with no machine default at all is told nothing happened", () => {
  const outcome = modelSwitchOutcome("qwen3", { pinned: true, dropped: 0 });
  expect(outcome.kind).toBe("no-default");
  expect(outcome.message).toBe(
    "this project pins its provider in .vesna/config.yaml, and there is no machine " +
      "default to change — nothing happened",
  );
});

test("a failed model switch reads the same as a failed provider switch", () => {
  const message = switchFailed("qwen3", new Error("connect ECONNREFUSED 127.0.0.1:11434"));
  expect(message).toBe("could not switch to qwen3: connect ECONNREFUSED 127.0.0.1:11434");
});
