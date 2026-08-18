import { test, expect } from "bun:test";
import {
  createResponsesProvider,
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

function sseServer(frames: string[]) {
  let sentBody: any;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      sentBody = await request.json();
      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return { server, url: `http://localhost:${server.port}`, body: () => sentBody };
}

test("streaming: text deltas arrive live and the final response is parsed", async () => {
  const host = sseServer([
    'data: {"type":"response.output_text.delta","delta":"Read"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"ing."}\n\n',
    'data: {"type":"response.completed","response":{"model":"gpt-5.5","status":"completed",' +
      '"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Reading."}]},' +
      '{"type":"function_call","call_id":"c1","name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"}],' +
      '"usage":{"input_tokens":9,"output_tokens":4}}}\n\n',
    "data: [DONE]\n\n",
  ]);

  try {
    const deltas: string[] = [];
    const result = await createResponsesProvider({
      baseUrl: host.url,
      token: async () => "tok",
    }).complete({
      model: "gpt-5.5",
      messages: [{ role: "user", content: [{ type: "text", text: "read a.txt" }] }],
      onText: (delta) => deltas.push(delta),
    });

    expect(host.body().stream).toBe(true);
    expect(deltas).toEqual(["Read", "ing."]);
    expect(result.content).toEqual([
      { type: "text", text: "Reading." },
      { type: "tool_call", id: "c1", name: "read", input: { path: "a.txt" } },
    ]);
    expect(result.usage.inputTokens).toBe(9);
    expect(result.model).toBe("gpt-5.5");
  } finally {
    host.server.stop(true);
  }
});

test("streaming: a failed response surfaces its error rather than an empty turn", async () => {
  const host = sseServer([
    'data: {"type":"response.failed","response":{"error":{"message":"model overloaded"}}}\n\n',
    "data: [DONE]\n\n",
  ]);
  try {
    await expect(
      createResponsesProvider({ baseUrl: host.url, token: async () => "t" }).complete({
        model: "m",
        messages: [{ role: "user", content: [] }],
        onText: () => {},
      }),
    ).rejects.toThrow(/model overloaded/);
  } finally {
    host.server.stop(true);
  }
});

test("without onText the request stays non-streaming", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json();
      return Response.json({ output: [], stream_echo: body.stream ?? null });
    },
  });
  try {
    const result = await createResponsesProvider({
      baseUrl: `http://localhost:${server.port}`,
      token: async () => "t",
    }).complete({ model: "m", messages: [{ role: "user", content: [] }] });
    expect(result.content).toEqual([]);
  } finally {
    server.stop(true);
  }
});
