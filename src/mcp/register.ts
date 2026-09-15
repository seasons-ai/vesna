/**
 * Every tool an MCP server lists becomes a node in the registry, named
 * `<server>__<tool>`, so a provider sees it as any other tool and the
 * policy matches it as any other node. The effect is `external` unless the
 * config lowers it; the server's own read-only claim is a hint at the end of
 * the description's first line, never a permission.
 *
 * Servers start side by side. One that is down after `initialize` registers
 * nothing and says why in its status; the rest are unaffected. The handle
 * that comes back closes every server at once, and its statuses are read
 * live, so a server that dies mid-session shows as down.
 */
import type { NodeDef, Registry } from "../registry/types";
import { createMcpClient, type McpClient, type Spawner } from "./client";
import { TOOL_TYPE, type McpServerConfig, type McpStatus, type McpTool } from "./types";

/** The hint appended to the first line of a tool the server calls read-only. */
export const READ_ONLY_MARKER = " (the server says read-only)";

export interface McpHandle {
  servers: McpStatus[];
  /** Closes every server; safe to call more than once. */
  close(): Promise<void>;
}

export interface RegisterMcpOptions {
  /** Vesna's own environment; the client filters it before a child sees any. */
  env: Record<string, string | undefined>;
  cwd: string;
  /** Where a line about a server goes — an unset variable, a skipped tool. */
  report: (line: string) => void;
  spawn?: Spawner;
  initializeCeilingMs?: number;
}

/** The description a model reads: `<server>: <tool> — <description>`, the
 * read-only hint closing its first line. */
export function describeTool(server: string, tool: McpTool): string {
  const marker = tool.readOnlyHint ? READ_ONLY_MARKER : "";
  const newline = tool.description.indexOf("\n");
  const first = newline >= 0 ? tool.description.slice(0, newline) : tool.description;
  const rest = newline >= 0 ? tool.description.slice(newline) : "";
  const head = first === "" ? `${server}: ${tool.name}` : `${server}: ${tool.name} — ${first}`;
  return `${head}${marker}${rest}`;
}

function toNode(server: string, config: McpServerConfig, client: McpClient, tool: McpTool): NodeDef {
  return {
    type: `${server}__${tool.name}`,
    effect: config.tools[tool.name] ?? "external",
    origin: "mcp",
    description: describeTool(server, tool),
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    async run(input: Record<string, unknown>, ctx) {
      const result = await client.call(tool.name, input, ctx.signal);
      // A thrown error is what the session turns into the tool error the
      // model sees; a returned string is the node's output.
      if (result.isError) throw new Error(result.text);
      return result.text;
    },
  };
}

interface Started {
  name: string;
  client: McpClient;
  tools: number;
}

async function startServer(
  registry: Registry,
  name: string,
  config: McpServerConfig,
  options: RegisterMcpOptions,
): Promise<Started> {
  for (const key of new Set(config.env)) {
    if (options.env[key] === undefined) options.report(`mcp ${name}: ${key} is not set`);
  }
  const client = createMcpClient(name, config, {
    env: options.env,
    cwd: options.cwd,
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.initializeCeilingMs !== undefined ? { initializeCeilingMs: options.initializeCeilingMs } : {}),
  });
  const { tools } = await client.initialize();
  let registered = 0;
  if (client.status() === "up") {
    for (const tool of tools) {
      const node = toNode(name, config, client, tool);
      if (!TOOL_TYPE.test(node.type)) {
        options.report(`mcp ${name}: tool ${tool.name} skipped — name does not fit`);
        continue;
      }
      if (registry.get(node.type) !== undefined) {
        options.report(`mcp ${name}: tool ${tool.name} skipped — already registered`);
        continue;
      }
      registry.register(node);
      registered += 1;
    }
  }
  return { name, client, tools: registered };
}

function statusOf(started: Started): McpStatus {
  const problem = started.client.problem();
  return {
    name: started.name,
    status: started.client.status(),
    tools: started.tools,
    ...(problem === undefined ? {} : { problem }),
  };
}

export async function registerMcp(
  registry: Registry,
  servers: Record<string, McpServerConfig> | undefined,
  options: RegisterMcpOptions,
): Promise<McpHandle> {
  const started = await Promise.all(
    Object.entries(servers ?? {}).map(([name, config]) => startServer(registry, name, config, options)),
  );
  let closing: Promise<void> | undefined;
  return {
    get servers() {
      return started.map(statusOf);
    },
    close() {
      if (closing === undefined) {
        closing = Promise.all(started.map((entry) => entry.client.close())).then(() => undefined);
      }
      return closing;
    },
  };
}
