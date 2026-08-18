import { test, expect } from "bun:test";
import {
  fromResponsesOutput,
  toResponsesInput,
  toResponsesTools,
} from "../../src/providers/responses";
import type { AgentMessage } from "../../src/providers/types";

const conversation: AgentMessage[] = [
  { role: "user", content: [{ type: "text", text: "read the report" }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Reading it." },
      { type: "tool_call", id: "call_1", name: "read", input: { path: "a.txt" } },
    ],
  },
  { role: "user", content: [{ type: "tool_result", callId: "call_1", content: '{"text":"body"}' }] },
];

test("a tool is declared flat, not nested under a function key", () => {
  expect(
    toResponsesTools([{ name: "read", description: "Read a file", input_schema: { type: "object" } }]),
  ).toEqual([
    { type: "function", name: "read", description: "Read a file", parameters: { type: "object" }, strict: false },
  ]);
});

test("a text turn becomes a plain message item", () => {
  expect(toResponsesInput(conversation)[0]).toEqual({ role: "user", content: "read the report" });
});

test("a tool call is echoed back as a function_call item with call_id", () => {
  const items = toResponsesInput(conversation);
  expect(items).toContainEqual({
    type: "function_call",
    call_id: "call_1",
    name: "read",
    arguments: '{"path":"a.txt"}',
  });
});

test("a tool result becomes function_call_output, not a tool role message", () => {
  const items = toResponsesInput(conversation);
  expect(items.at(-1)).toEqual({
    type: "function_call_output",
    call_id: "call_1",
    output: '{"text":"body"}',
  });
});

test("an output message parses into neutral text", () => {
  const parsed = fromResponsesOutput([
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "All done." }],
    },
  ]);
  expect(parsed).toEqual([{ type: "text", text: "All done." }]);
});

test("an output function_call parses into a neutral tool call", () => {
  const parsed = fromResponsesOutput([
    { type: "function_call", call_id: "call_9", name: "write", arguments: '{"path":"o.md"}' },
  ]);
  expect(parsed).toEqual([
    { type: "tool_call", id: "call_9", name: "write", input: { path: "o.md" } },
  ]);
});

test("malformed arguments yield an empty input rather than throwing mid-loop", () => {
  const parsed = fromResponsesOutput([
    { type: "function_call", call_id: "c", name: "x", arguments: "{not json" },
  ]);
  expect(parsed).toEqual([{ type: "tool_call", id: "c", name: "x", input: {} }]);
});

test("a refusal block is surfaced as text, not silently dropped", () => {
  const parsed = fromResponsesOutput([
    {
      type: "message",
      role: "assistant",
      content: [{ type: "refusal", refusal: "I can't help with that." }],
    },
  ]);
  expect(parsed).toEqual([{ type: "text", text: "I can't help with that." }]);
});

test("unknown item types are ignored rather than crashing the parse", () => {
  expect(fromResponsesOutput([{ type: "reasoning", summary: [] } as any])).toEqual([]);
});
