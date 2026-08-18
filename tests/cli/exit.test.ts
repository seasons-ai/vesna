import { test, expect } from "bun:test";
import { EXIT, explainError } from "../../src/cli/exit";
import { ContractError } from "../../src/flow/parse";

test("exit codes distinguish success, held work and failure", () => {
  expect(EXIT.ok).toBe(0);
  expect(EXIT.held).toBe(1);
  expect(EXIT.error).toBe(2);
});

test("a missing credential is explained, not dumped as a stack trace", () => {
  const explained = explainError(
    new Error("Could not resolve authentication method. Expected one of apiKey, authToken"),
  );
  expect(explained.message).toContain("No model credentials");
  expect(explained.hint).toContain("ANTHROPIC_API_KEY");
});

test("a contract error is reported as the flow being wrong, with its own message", () => {
  const explained = explainError(new ContractError("node a references unknown node: ghost"));
  expect(explained.message).toContain("references unknown node: ghost");
  expect(explained.hint).toContain("flow");
});

test("a missing file names the path", () => {
  const explained = explainError(
    new Error("ENOENT: no such file or directory, open '/tmp/x/clients.csv'"),
  );
  expect(explained.message).toContain("clients.csv");
});

test("an unknown error still yields a message rather than throwing", () => {
  expect(explainError("something odd").message).toBe("something odd");
});
