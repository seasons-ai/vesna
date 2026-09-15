import { test, expect } from "bun:test";
import { join } from "node:path";

/** A smoke test: the fixture is a real process, and it answers `initialize`. */
test("the fake MCP server answers initialize over a pipe", async () => {
  const child = Bun.spawn(["bun", join(import.meta.dir, "mcp-server.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.flush();

    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += Buffer.from(chunk).toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        buffer = buffer.slice(0, newline);
        break;
      }
    }
    const message = JSON.parse(buffer);
    expect(message.result.protocolVersion).toBe("2025-06-18");
  } finally {
    child.kill();
  }
});
