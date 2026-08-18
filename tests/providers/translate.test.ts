import { test, expect } from "bun:test";
import { fromAnthropicContent, toAnthropicMessages } from "../../src/providers/anthropic";
import { fromOpenAIMessage, toOpenAIMessages } from "../../src/providers/openai";
import type { AgentMessage } from "../../src/providers/types";

const conversation: AgentMessage[] = [
  { role: "user", content: [{ type: "text", text: "read the report" }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Reading it now." },
      { type: "tool_call", id: "c1", name: "read", input: { path: "a.txt" } },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", callId: "c1", content: '{"text":"body"}' }],
  },
];

test("anthropic: a tool call becomes tool_use and comes back unchanged", () => {
  const wire = toAnthropicMessages(conversation);
  const assistant = wire[1]!.content as any[];
  expect(assistant[1]).toEqual({
    type: "tool_use",
    id: "c1",
    name: "read",
    input: { path: "a.txt" },
  });
  expect(fromAnthropicContent(assistant)).toEqual(conversation[1]!.content);
});

test("anthropic: a tool result carries tool_use_id", () => {
  const wire = toAnthropicMessages(conversation);
  expect((wire[2]!.content as any[])[0]).toMatchObject({
    type: "tool_result",
    tool_use_id: "c1",
  });
});

test("openai: a tool call becomes tool_calls with stringified arguments", () => {
  const wire = toOpenAIMessages(conversation, "be brief");
  expect(wire[0]).toEqual({ role: "system", content: "be brief" });

  const assistant = wire[2] as any;
  expect(assistant.role).toBe("assistant");
  expect(assistant.tool_calls[0]).toEqual({
    id: "c1",
    type: "function",
    function: { name: "read", arguments: '{"path":"a.txt"}' },
  });
});

test("openai: a tool result becomes its own message with role tool", () => {
  const wire = toOpenAIMessages(conversation, undefined) as any[];
  const toolMessage = wire.find((message) => message.role === "tool");
  expect(toolMessage).toEqual({
    role: "tool",
    tool_call_id: "c1",
    content: '{"text":"body"}',
  });
});

test("openai: a response with tool calls parses back into neutral blocks", () => {
  const parsed = fromOpenAIMessage({
    role: "assistant",
    content: "On it.",
    tool_calls: [
      { id: "c9", type: "function", function: { name: "write", arguments: '{"path":"o.md"}' } },
    ],
  });
  expect(parsed).toEqual([
    { type: "text", text: "On it." },
    { type: "tool_call", id: "c9", name: "write", input: { path: "o.md" } },
  ]);
});

test("openai: malformed tool arguments do not crash the parse", () => {
  const parsed = fromOpenAIMessage({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "not json" } }],
  });
  expect(parsed).toEqual([{ type: "tool_call", id: "c1", name: "x", input: {} }]);
});

test("openai: a plain text response yields a single text block", () => {
  expect(fromOpenAIMessage({ role: "assistant", content: "done" })).toEqual([
    { type: "text", text: "done" },
  ]);
});

test("both dialects preserve a multi-turn conversation's shape", () => {
  expect(toAnthropicMessages(conversation)).toHaveLength(3);
  // OpenAI splits the tool result into its own message, so one more.
  expect(toOpenAIMessages(conversation, undefined)).toHaveLength(3);
});
