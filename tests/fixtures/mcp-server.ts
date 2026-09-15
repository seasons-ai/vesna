/**
 * A stand-in MCP server for the client and registration tests: speaks
 * newline-delimited JSON-RPC 2.0 on stdio and nothing else on stdout — every
 * note it needs to leave goes to stderr instead, so a test reading stdout as
 * JSON lines never trips over stray text.
 *
 * Tools: `echo { text }` returns the text; `slow { ms }` sleeps then answers
 * `"slept"`; `fail {}` answers with `isError: true`; `hint {}` is declared
 * `readOnlyHint: true` and answers `"hinted"`. `tools/list` pages: no cursor
 * (or any cursor but `"2"`) returns `[echo]` with `nextCursor: "2"`;
 * `cursor: "2"` returns `[slow, fail, hint]` with none. An unknown tool name
 * is a `-32602` error; an unknown method is `-32601`.
 *
 * Behaviour toggles read from the environment, for the tests that need them:
 * `FAKE_MCP_DIE=1` exits 1 right after answering `initialize`; `FAKE_MCP_MUTE
 * =1` never answers it; `FAKE_MCP_SAMPLE=1` sends the client an unsolicited
 * `sampling/createMessage` request (id 900) after `initialize` and logs the
 * client's response to stderr; `FAKE_MCP_PRINT_ENV=NAME` makes `echo` append
 * the named environment variable's value to its text, to prove a
 * passed-through secret reaches the server and nothing else.
 */
import { createInterface } from "node:readline";

export const PROTOCOL_VERSION = "2025-06-18";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

const ECHO: ToolDef = {
  name: "echo",
  description: "returns the text it is given",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};
const SLOW: ToolDef = {
  name: "slow",
  description: "sleeps for the given number of milliseconds, then answers",
  inputSchema: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
};
const FAIL: ToolDef = {
  name: "fail",
  description: "always answers with isError",
  inputSchema: { type: "object", properties: {} },
};
const HINT: ToolDef = {
  name: "hint",
  description: "a tool the server marks read-only",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
};

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function note(text: string): void {
  process.stderr.write(`${text}\n`);
}

async function handleToolsCall(id: number | string, params: Record<string, unknown> | undefined): Promise<void> {
  const name = typeof params?.name === "string" ? params.name : "";
  const args = (params?.arguments ?? {}) as Record<string, unknown>;
  switch (name) {
    case "echo": {
      let text = typeof args.text === "string" ? args.text : "";
      const printEnv = process.env.FAKE_MCP_PRINT_ENV;
      if (printEnv !== undefined) {
        const value = process.env[printEnv];
        text += ` env:${value ?? "unset"}`;
      }
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
      return;
    }
    case "slow": {
      const ms = typeof args.ms === "number" ? args.ms : 0;
      await new Promise((resolve) => setTimeout(resolve, ms));
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "slept" }] } });
      return;
    }
    case "fail": {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "it failed" }], isError: true } });
      return;
    }
    case "hint": {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "hinted" }] } });
      return;
    }
    default: {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool "${name}"` } });
    }
  }
}

async function handle(message: RpcMessage): Promise<void> {
  if (message.method === undefined) {
    // A response from the client, not a request to us.
    if (message.id === 900) note(`sample-response: ${JSON.stringify(message)}`);
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    if (process.env.FAKE_MCP_MUTE === "1") return;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "0" },
      },
    });
    if (process.env.FAKE_MCP_DIE === "1") process.exit(1);
    if (process.env.FAKE_MCP_SAMPLE === "1") {
      send({ jsonrpc: "2.0", id: 900, method: "sampling/createMessage", params: {} });
    }
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    if (params?.cursor === "2") {
      send({ jsonrpc: "2.0", id, result: { tools: [SLOW, FAIL, HINT] } });
    } else {
      send({ jsonrpc: "2.0", id, result: { tools: [ECHO], nextCursor: "2" } });
    }
    return;
  }
  if (method === "tools/call") {
    if (id === undefined) return;
    await handleToolsCall(id, params);
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method "${method}"` } });
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let message: RpcMessage;
  try {
    message = JSON.parse(trimmed) as RpcMessage;
  } catch {
    note(`could not parse line as JSON: ${trimmed}`);
    return;
  }
  void handle(message);
});
