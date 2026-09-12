import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The border of the core, as a test of its own: the TUI reaches the agent
 * only through the core, and the core knows nothing of the screen. Read
 * from the files rather than the module graph, so a stray import fails
 * here with its name, not somewhere in a scenario.
 */

// Everything the agent is made of. `../loop/trace` is not listed: `detailOf`
// is the presentation helper that turns a step's input into the label the
// screen prints, and a client is allowed to label what it draws.
const FORBIDDEN_IN_TUI = [
  "../loop/session",
  "../loop/carry",
  "../policy/store",
  "../spec/store",
  "../spec/sink",
  "../spec/project\"",
  "../sdd/loop",
  "../sdd/recover",
  "../sdd/brief",
  "../store/sessions",
  "../cli/buildcmd",
  "../cli/config",
  "../cli/context",
  "../cli/preflight",
  "../cli/settings",
  "../providers/",
  "../registry/",
];
// `Mode` is the one word of the policy a client needs, and only as a type.
const TYPE_ONLY_IN_TUI = ["../policy/decide"];

const FORBIDDEN_IN_CORE = ["../tui/", "./screen", "./theme", "./glyphs", "./keys", "./clipboard", "./editor", "./layout", "./render", "./transcript"];

function importsOf(relative: string): string[] {
  const src = readFileSync(join(import.meta.dir, relative), "utf8");
  // A multi-line import is one statement: join the lines up to its `from`.
  const lines: string[] = [];
  let open: string | null = null;
  for (const line of src.split("\n")) {
    if (open !== null) {
      open += ` ${line.trim()}`;
      if (/from\s+["']/.test(line) || line.trim().endsWith(";")) {
        lines.push(open);
        open = null;
      }
      continue;
    }
    if (!line.startsWith("import ")) continue;
    if (/from\s+["']/.test(line) || line.trim().endsWith(";")) lines.push(line);
    else open = line;
  }
  return lines;
}

test("the TUI reaches the agent only through the core", () => {
  const imports = importsOf("../../src/tui/app.ts");
  for (const bad of FORBIDDEN_IN_TUI) {
    const offending = imports.filter((line) => line.includes(bad));
    expect(offending, `app.ts imports ${bad}`).toEqual([]);
  }
  for (const typeOnly of TYPE_ONLY_IN_TUI) {
    const offending = imports.filter((line) => line.includes(typeOnly) && !line.startsWith("import type "));
    expect(offending, `app.ts imports a value from ${typeOnly}`).toEqual([]);
  }
});

test("the core knows nothing of the screen", () => {
  const imports = importsOf("../../src/core/core.ts");
  for (const bad of FORBIDDEN_IN_CORE) {
    const offending = imports.filter((line) => line.includes(bad));
    expect(offending, `core.ts imports ${bad}`).toEqual([]);
  }
});
