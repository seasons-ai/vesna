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

test("a pinned project is told the machine default moved, not this directory", () => {
  const outcome = modelSwitchOutcome("qwen3", { pinned: true, dropped: 0 });
  expect(outcome.kind).toBe("pinned");
  expect(outcome.message).toContain(".vesna/config.yaml");
  expect(outcome.message).toContain("qwen3");
  expect(outcome.message).toContain("unchanged here");
});

test("a failed model switch reads the same as a failed provider switch", () => {
  const message = switchFailed("qwen3", new Error("connect ECONNREFUSED 127.0.0.1:11434"));
  expect(message).toBe("could not switch to qwen3: connect ECONNREFUSED 127.0.0.1:11434");
});
