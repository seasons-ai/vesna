import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The README's status line names a version, and a version named by hand
 * drifts: it said v0.2 while the package was 0.3.1. The line now has to
 * agree with package.json, and this is the check that keeps it so.
 */
const root = join(import.meta.dir, "..", "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("the README's status line names the version package.json ships", () => {
  const line = readme.match(/^\*\*Status: v(\d+\.\d+)\.\*\*/m);
  expect(line).not.toBeNull();
  // The status names the minor line, not the patch: a patch does not change
  // what the README describes, and rewriting it per patch invites the drift.
  const minor = version.split(".").slice(0, 2).join(".");
  expect(line![1]).toBe(minor);
});

/**
 * The process section's command table is where a reader learns the words.
 * `/build` grew four of them — cancel, resume, retry <task>, abort — and a
 * table that names three of the four would send someone to a command that
 * exists without telling them. The refusal the README shows spells out the
 * same three recoveries, so the two must agree.
 */
test("the README's command table names every word /build takes", () => {
  const table = readme.match(/```text\n([\s\S]*?)```/)?.[1] ?? "";
  const rows = table.split("\n").filter((line) => line.startsWith("/build"));
  const words = rows.map((row) => row.split(/\s{2,}/)[0]);
  expect(words).toEqual(["/build", "/build cancel", "/build resume", "/build retry <task>", "/build abort"]);
  expect(readme).toContain("was interrupted — /build resume, /build retry <task>, or /build abort");
});
