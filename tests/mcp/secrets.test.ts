import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/cli/config";
import { registerMcp } from "../../src/mcp/register";
import { createRegistry } from "../../src/registry/registry";
import { createCore } from "../../src/core/core";
import type { Notification } from "../../src/core/types";
import { openSession, readSessionSync } from "../../src/store/sessions";
import { deps, toolCaller, until } from "../helpers/chat";

/**
 * A secret named in `mcp.<server>.env` is the server's business once it
 * reaches the child process — the fixture echoes it back in its tool
 * result, and that result is exactly where the value belongs: inside the
 * one message the model asked for. Everywhere else Vesna writes — the
 * session recorded to disk, the live notice and ask notifications, the
 * state snapshot, `registerMcp`'s own report lines, and the config's
 * problem list — must never carry it.
 */

const FIXTURE = join(import.meta.dir, "..", "fixtures", "mcp-server.ts");

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("a secret named in mcp.env reaches the server and nowhere else Vesna writes", async () => {
  const secret = `hunter2-${Math.random().toString(36).slice(2)}`;
  const root = await mkdtemp(join(tmpdir(), "vesna-secrets-cfg-"));
  const home = await mkdtemp(join(tmpdir(), "vesna-secrets-home-"));
  const sessionsRootDir = await mkdtemp(join(tmpdir(), "vesna-secrets-sessions-"));
  try {
    await mkdir(join(root, ".vesna"), { recursive: true });
    await writeFile(
      join(root, ".vesna", "config.yaml"),
      [
        "mcp:",
        "  fake:",
        "    command: bun",
        `    args: ["${FIXTURE}"]`,
        "    env: [SECRET_X, FAKE_MCP_PRINT_ENV]",
      ].join("\n"),
    );

    // The environment Vesna itself runs with. SECRET_X is a stand-in for a
    // real credential, and FAKE_MCP_PRINT_ENV tells the fixture which
    // variable to echo back — neither value is ever written to the config,
    // only their names.
    const env = { ...process.env, SECRET_X: secret, FAKE_MCP_PRINT_ENV: "SECRET_X" };
    const config = await loadConfig(root, env, home);
    expect(config.mcp?.fake?.env).toEqual(["SECRET_X", "FAKE_MCP_PRINT_ENV"]);

    const registry = createRegistry();
    const reportLines: string[] = [];
    const handle = await registerMcp(registry, config.mcp, {
      env,
      cwd: root,
      report: (line) => reportLines.push(line),
    });

    const record = await openSession({ root: sessionsRootDir, cwd: root, model: "test-model" });
    const base = await deps(toolCaller("fake__echo", { text: "hi" }), { registry });
    const core = createCore({
      ...base,
      config: { ...base.config, ...config, permissions: { nodes: ["fake__echo"] } },
      policy: { mode: "auto", allow: {}, deny: {} },
      mcp: handle,
      record,
    });

    const seen: Notification[] = [];
    core.on((n) => seen.push(n));
    await core.send("go");

    // `remember` fires the write without awaiting it; the usage event is
    // recorded last in a turn, so waiting for it means the messages event
    // ahead of it — the one carrying the tool result — is already on disk.
    await until(
      () => readSessionSync(sessionsRootDir, record.id)?.events.some((e) => e.t === "usage") === true,
      "the turn's events on disk",
    );

    // The server's business: the value is exactly what the model saw.
    const read = readSessionSync(sessionsRootDir, record.id)!;
    const toolResultTexts = read.events
      .filter((e): e is Extract<(typeof read.events)[number], { t: "messages" }> => e.t === "messages")
      .flatMap((e) => e.added)
      .flatMap((m) => m.content)
      .filter((c): c is Extract<typeof c, { type: "tool_result" }> => c.type === "tool_result")
      .map((c) => c.content);
    expect(toolResultTexts.some((text) => text.includes(`env:${secret}`))).toBe(true);

    // Nowhere else in the record: every occurrence anywhere in the stored
    // session is accounted for by the tool-result strings above.
    const wholeRecord = JSON.stringify(read);
    const totalOccurrences = occurrences(wholeRecord, secret);
    const toolResultOccurrences = toolResultTexts.reduce((sum, text) => sum + occurrences(text, secret), 0);
    expect(totalOccurrences).toBeGreaterThan(0);
    expect(toolResultOccurrences).toBe(totalOccurrences);

    // The live notice and ask notifications never carry it either.
    const notices = seen.filter((n) => n.method === "transcript" && (n.params as any).kind === "notice");
    expect(JSON.stringify(notices)).not.toContain(secret);
    const asks = seen.filter((n) => n.method === "ask");
    expect(JSON.stringify(asks)).not.toContain(secret);

    // The whole state, as a client would see it over `/mcp` or the header.
    expect(JSON.stringify(core.snapshot())).not.toContain(secret);

    // registerMcp's own report lines — an unset env name, a skipped tool —
    // never carry a value, only names.
    expect(reportLines.join("\n")).not.toContain(secret);

    // The config's problem list: names only, never values.
    expect(JSON.stringify(config.mcpProblems ?? [])).not.toContain(secret);

    await core.close();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(sessionsRootDir, { recursive: true, force: true });
  }
});
