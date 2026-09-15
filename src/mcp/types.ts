/**
 * The shapes shared between the config, the client and registration. An MCP
 * server is configured once (`McpServerConfig`), speaks tools described by
 * `McpTool`, and reports itself as one line of `McpStatus` for `/mcp` and the
 * extension.
 */

/** A tool's effect, as the config may downgrade it. Never upward: a server
 * cannot declare itself `write` and have Vesna trust `pure`. */
export type McpEffect = "pure" | "write";

export interface McpServerConfig {
  command: string;
  args: string[];
  /** Names of environment variables passed through from Vesna's own — never
   * the values, which stay out of the config, the trace and any message. */
  env: string[];
  /** Per-tool effect override; a tool not listed here is `external`. */
  tools: Record<string, McpEffect>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The server's own claim, shown as a hint and trusted for nothing else. */
  readOnlyHint: boolean;
}

export type McpServerStatus = "starting" | "up" | "down";

export interface McpStatus {
  name: string;
  status: McpServerStatus;
  tools: number;
  problem?: string;
}

/** A server key doubles as the prefix of every tool name it offers. */
export const SERVER_KEY = /^[a-z][a-z0-9-]*$/;

/** What a joined `<server>__<tool>` node type must look like to register. */
export const TOOL_TYPE = /^[A-Za-z0-9_-]{1,64}$/;

export const PROTOCOL_VERSION = "2025-06-18";
