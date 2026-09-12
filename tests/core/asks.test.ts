import { test, expect } from "bun:test";
import { createAsks } from "../../src/core/asks";
import type { Notification } from "../../src/core/types";

test("an ask is emitted with a fresh id and resolves on a valid answer, which is also emitted", async () => {
  const seen: Notification[] = [];
  const asks = createAsks((n) => seen.push(n));
  const pending = asks.ask("approval", ["approve the plan? [y] yes  [n] not yet"], ["y", "n"], true);
  expect(seen).toEqual([{ method: "ask", params: { id: "a1", kind: "approval", lines: ["approve the plan? [y] yes  [n] not yet"], choices: ["y", "n"], strict: true } }]);
  expect(asks.open().map((a) => a.id)).toEqual(["a1"]);
  expect(asks.answer("a1", "y")).toBe(true);
  await expect(pending).resolves.toBe("y");
  expect(seen.at(-1)).toEqual({ method: "ask.resolved", params: { id: "a1" } });
  expect(asks.open()).toEqual([]);
});

test("an answer outside the choices, or for an unknown id, is refused and leaves the ask open", async () => {
  const asks = createAsks(() => {});
  const pending = asks.ask("permission", ["shell  ls", "[y] allow   [n] refuse"], ["y", "n"], false);
  expect(asks.answer("a1", "a")).toBe(false);
  expect(asks.answer("nope", "y")).toBe(false);
  expect(asks.answer("a1", "")).toBe(false);
  expect(asks.open()).toHaveLength(1);
  expect(asks.answer("a1", " N ")).toBe(true);
  await expect(pending).resolves.toBe("n");
});

test("ids never repeat within one registry", () => {
  const asks = createAsks(() => {});
  void asks.ask("approval", [], ["y", "n"], true);
  asks.answer("a1", "n");
  void asks.ask("approval", [], ["y", "n"], true);
  expect(asks.open().map((a) => a.id)).toEqual(["a2"]);
});
