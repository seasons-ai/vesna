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
