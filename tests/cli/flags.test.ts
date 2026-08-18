import { test, expect } from "bun:test";
import { parseFlags } from "../../src/cli/flags";

test("a flag with a value keeps the value", () => {
  expect(parseFlags(["--map", "rows.csv"])).toEqual({ map: "rows.csv" });
});

test("a flag with no value is present rather than absent", () => {
  expect(parseFlags(["--dry-run"])).toEqual({ "dry-run": "true" });
});

test("a bare flag does not swallow the flag that follows it", () => {
  expect(parseFlags(["--dry-run", "--path", "out.txt"])).toEqual({
    "dry-run": "true",
    path: "out.txt",
  });
});

test("two bare flags both survive", () => {
  expect(parseFlags(["--plain", "--yes"])).toEqual({ plain: "true", yes: "true" });
});

test("positional arguments are ignored", () => {
  expect(parseFlags(["report", "--path", "a"])).toEqual({ path: "a" });
});

test("a value that looks negative is still a value", () => {
  expect(parseFlags(["--offset", "-1"])).toEqual({ offset: "-1" });
});
