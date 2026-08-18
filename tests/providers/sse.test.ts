import { test, expect } from "bun:test";
import { accumulateChatStream, parseSseLines } from "../../src/providers/sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of parseSseLines(stream)) out.push(line);
  return out;
}

test("events split across chunk boundaries are reassembled", async () => {
  const lines = await collect(streamOf(['data: {"a":', '1}\n\n', 'data: {"b":2}\n\n']));
  expect(lines).toEqual(['{"a":1}', '{"b":2}']);
});

test("the terminator is not yielded as data", async () => {
  expect(await collect(streamOf(["data: {}\n\n", "data: [DONE]\n\n"]))).toEqual(["{}"]);
});

test("comments and blank lines are ignored", async () => {
  expect(await collect(streamOf([": keep-alive\n\n", "\n", 'data: {"x":1}\n\n']))).toEqual([
    '{"x":1}',
  ]);
});

test("text deltas are forwarded as they arrive and assembled at the end", async () => {
  const seen: string[] = [];
  const result = await accumulateChatStream(
    streamOf([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ]),
    (delta) => seen.push(delta),
  );

  expect(seen).toEqual(["Hel", "lo"]);
  expect(result.message.content).toBe("Hello");
});

test("tool calls arriving in fragments are joined by index", async () => {
  const result = await accumulateChatStream(
    streamOf([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.txt\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]),
    () => {},
  );

  expect(result.message.tool_calls).toEqual([
    { id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } },
  ]);
});

test("two parallel tool calls stay separate", async () => {
  const result = await accumulateChatStream(
    streamOf([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read","arguments":"{}"}},{"index":1,"id":"b","function":{"name":"glob","arguments":"{}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]),
    () => {},
  );
  expect(result.message.tool_calls?.map((c) => c.id)).toEqual(["a", "b"]);
});

test("finish reason and usage survive the stream", async () => {
  const result = await accumulateChatStream(
    streamOf([
      'data: {"model":"m","choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n',
      'data: {"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ]),
    () => {},
  );
  expect(result.finishReason).toBe("stop");
  expect(result.usage.prompt_tokens).toBe(7);
  expect(result.model).toBe("m");
});

test("a malformed event does not abort the whole stream", async () => {
  const result = await accumulateChatStream(
    streamOf([
      "data: not json\n\n",
      'data: {"choices":[{"delta":{"content":"still here"}}]}\n\n',
      "data: [DONE]\n\n",
    ]),
    () => {},
  );
  expect(result.message.content).toBe("still here");
});
