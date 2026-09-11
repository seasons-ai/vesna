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
