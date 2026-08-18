import { test, expect } from "bun:test";
import { createOpenAICompatibleProvider } from "../../src/providers/openai";

/** A stand-in for any OpenAI-compatible host: OpenAI, AIMLAPI, Ollama, vLLM. */
function fakeHost(handler: (body: any) => unknown) {
  const seen: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json();
      seen.push({ body, auth: request.headers.get("authorization"), url: request.url });
      return Response.json(handler(body));
    },
  });
  return { seen, url: `http://localhost:${server.port}/v1`, stop: () => server.stop(true) };
}

const okReply = {
  model: "gpt-test",
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "Reading it.",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 120, completion_tokens: 34, prompt_tokens_details: { cached_tokens: 10 } },
};

test("posts to /chat/completions with the tools and messages translated", async () => {
  const host = fakeHost(() => okReply);
  try {
    const provider = createOpenAICompatibleProvider({ baseUrl: host.url, apiKey: "k", id: "test" });
    await provider.complete({
      model: "gpt-test",
      system: "be brief",
      messages: [{ role: "user", content: [{ type: "text", text: "read a.txt" }] }],
      tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }],
    });

    const sent = host.seen[0]!;
    expect(sent.url).toEndWith("/v1/chat/completions");
    expect(sent.auth).toBe("Bearer k");
    expect(sent.body.model).toBe("gpt-test");
    expect(sent.body.messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(sent.body.tools[0]).toEqual({
      type: "function",
      function: { name: "read", description: "Read a file", parameters: { type: "object" } },
    });
  } finally {
    host.stop();
  }
});

test("parses tool calls and usage back into the neutral shape", async () => {
  const host = fakeHost(() => okReply);
  try {
    const result = await createOpenAICompatibleProvider({ baseUrl: host.url }).complete({
      model: "gpt-test",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });

    expect(result.content).toEqual([
      { type: "text", text: "Reading it." },
      { type: "tool_call", id: "c1", name: "read", input: { path: "a.txt" } },
    ]);
    expect(result.stopReason).toBe("tool_calls");
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 34,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
    });
  } finally {
    host.stop();
  }
});

test("a tool result is sent as its own message with role tool", async () => {
  const host = fakeHost(() => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
  try {
    await createOpenAICompatibleProvider({ baseUrl: host.url }).complete({
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "c1", name: "read", input: {} }],
        },
        { role: "user", content: [{ type: "tool_result", callId: "c1", content: "body" }] },
      ],
    });

    const messages = host.seen[0]!.body.messages;
    expect(messages.at(-1)).toEqual({ role: "tool", tool_call_id: "c1", content: "body" });
  } finally {
    host.stop();
  }
});

test("an error status is reported with the host's own detail, not a bare throw", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("model not found", { status: 404 }),
  });
  try {
    const provider = createOpenAICompatibleProvider({
      baseUrl: `http://localhost:${server.port}/v1`,
      id: "ollama",
    });
    await expect(
      provider.complete({ model: "nope", messages: [{ role: "user", content: [] }] }),
    ).rejects.toThrow(/ollama returned 404: model not found/);
  } finally {
    server.stop(true);
  }
});

test("no api key means no authorization header, which is how local hosts work", async () => {
  const host = fakeHost(() => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await createOpenAICompatibleProvider({ baseUrl: host.url }).complete({
      model: "llama3.1",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(host.seen[0]!.auth).toBeNull();
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    host.stop();
  }
});

test("streaming: deltas arrive live and the turn assembles correctly", async () => {
  const frames = [
    'data: {"model":"gpt-test","choices":[{"delta":{"content":"Read"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"ing it."}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"path\\""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"a.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"usage":{"prompt_tokens":11,"completion_tokens":4}}\n\n',
    "data: [DONE]\n\n",
  ];
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

  try {
    const deltas: string[] = [];
    const result = await createOpenAICompatibleProvider({
      baseUrl: `http://localhost:${server.port}/v1`,
    }).complete({
      model: "gpt-test",
      messages: [{ role: "user", content: [{ type: "text", text: "read a.txt" }] }],
      onText: (delta) => deltas.push(delta),
    });

    expect(sentBody.stream).toBe(true);
    expect(deltas).toEqual(["Read", "ing it."]);
    expect(result.content).toEqual([
      { type: "text", text: "Reading it." },
      { type: "tool_call", id: "c1", name: "read", input: { path: "a.txt" } },
    ]);
    expect(result.stopReason).toBe("tool_calls");
    expect(result.usage.inputTokens).toBe(11);
  } finally {
    server.stop(true);
  }
});

test("without onText the request is not a stream", async () => {
  let sentBody: any;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      sentBody = await request.json();
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    },
  });
  try {
    await createOpenAICompatibleProvider({ baseUrl: `http://localhost:${server.port}/v1` }).complete({
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(sentBody.stream).toBeUndefined();
  } finally {
    server.stop(true);
  }
});
