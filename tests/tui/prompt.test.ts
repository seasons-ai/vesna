import { test, expect } from "bun:test";
import { confirmParameters, type PromptIO } from "../../src/tui/prompt";
import { resolveTheme } from "../../src/tui/theme";
import type { ProposedParameter } from "../../src/crystallize/propose";

const theme = resolveTheme("mono", { color: false });

const parameters: ProposedParameter[] = [
  { literal: "reports/acme.txt", suggestedName: "source", sites: [{ nodeId: "read_1", field: "path" }] },
  { literal: "out/acme.md", suggestedName: "dest", sites: [{ nodeId: "write_2", field: "path" }] },
];

function scriptedIO(answers: string[]): PromptIO & { output: string[] } {
  const output: string[] = [];
  let index = 0;
  return {
    output,
    write(text) {
      output.push(text);
    },
    async question() {
      return answers[index++] ?? "";
    },
  };
}

test("an empty answer accepts the suggested name", async () => {
  const io = scriptedIO(["", ""]);
  const accepted = await confirmParameters(parameters, io, theme);
  expect([...accepted.keys()].sort()).toEqual(["dest", "source"]);
  expect(accepted.get("source")).toBe("source");
});

test("answering n skips that parameter entirely", async () => {
  const io = scriptedIO(["n", ""]);
  const accepted = await confirmParameters(parameters, io, theme);
  expect(accepted.has("source")).toBe(false);
  expect(accepted.has("dest")).toBe(true);
});

test("any other answer renames the parameter", async () => {
  const io = scriptedIO(["report_path", "n"]);
  const accepted = await confirmParameters(parameters, io, theme);
  expect(accepted.get("source")).toBe("report_path");
});

test("the literal and its sites are shown before each question", async () => {
  const io = scriptedIO(["", ""]);
  await confirmParameters(parameters, io, theme);
  const shown = io.output.join("\n");
  expect(shown).toContain("reports/acme.txt");
  expect(shown).toContain("read_1.path");
});

test("non-interactive mode accepts every suggestion without asking", async () => {
  const io = scriptedIO([]);
  let asked = 0;
  const counting: PromptIO = {
    write: io.write,
    async question() {
      asked += 1;
      return "";
    },
  };
  const accepted = await confirmParameters(parameters, counting, theme, { interactive: false });
  expect(asked).toBe(0);
  expect(accepted.size).toBe(2);
});

test("no parameters means no questions and an empty result", async () => {
  const io = scriptedIO([]);
  expect((await confirmParameters([], io, theme)).size).toBe(0);
});
