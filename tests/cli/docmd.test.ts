import { test, expect } from "bun:test";
import { unattendedApprove } from "../../src/cli/docmd";
import type { Policy } from "../../src/policy/decide";

const root = "/work";
const policy = (mode: Policy["mode"], over: Partial<Policy> = {}): Policy => ({ mode, allow: {}, deny: {}, ...over });
const external = (node: string, input: Record<string, unknown> = {}) => ({ node, input, cwd: root, effect: "external" as const });

/** `vesna do` has nobody to ask, so the three modes answer for themselves. */
test("auto allows, and reports nothing", async () => {
  const lines: string[] = [];
  const approve = unattendedApprove(policy("auto"), root, (line) => lines.push(line));
  expect(await approve(external("fake__hint"))).toBe("allow");
  expect(lines).toEqual([]);
});

test("plan refuses with the chat's plan-mode words, on stderr and to the model alike", async () => {
  const lines: string[] = [];
  const approve = unattendedApprove(policy("plan"), root, (line) => lines.push(line));
  const reason = "fake__hint refused: plan mode changes nothing — shift-tab to leave it";
  expect(await approve(external("fake__hint"))).toEqual({ verdict: "deny", reason });
  expect(lines).toEqual([reason]);
});

test("ask refuses what would have been a question, and says where to ask it", async () => {
  const lines: string[] = [];
  const approve = unattendedApprove(policy("ask"), root, (line) => lines.push(line));
  const reason = "fake__hint would ask — run it in the chat, or set permissions.mode: auto";
  expect(await approve(external("fake__hint"))).toEqual({ verdict: "deny", reason });
  expect(lines).toEqual([reason]);
});

test("the always-ask list refuses even in auto", async () => {
  const lines: string[] = [];
  const approve = unattendedApprove(policy("auto"), root, (line) => lines.push(line));
  const verdict = await approve({ node: "shell", input: { command: "sudo rm -rf /" }, cwd: root, effect: "external" });
  expect(verdict).toEqual({ verdict: "deny", reason: "shell would ask — run it in the chat, or set permissions.mode: auto" });
});

test("a deny rule refuses by policy, in auto", async () => {
  const lines: string[] = [];
  const approve = unattendedApprove(policy("auto", { deny: { "fake__*": ["*"] } }), root, (line) => lines.push(line));
  expect(await approve(external("fake__hint"))).toEqual({ verdict: "deny", reason: "refused by policy: fake__hint" });
});

test("a pure node is allowed whatever the mode", async () => {
  const approve = unattendedApprove(policy("plan"), root, () => {});
  expect(await approve({ node: "read", input: { path: "a.ts" }, cwd: root, effect: "pure" })).toBe("allow");
});
