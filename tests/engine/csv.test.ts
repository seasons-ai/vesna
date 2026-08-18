import { test, expect } from "bun:test";
import { parseCsv } from "../../src/engine/csv";

test("parses a header and rows into objects", () => {
  expect(parseCsv("client,report\nAcme,q3.pdf\nGlobex,q4.pdf")).toEqual([
    { client: "Acme", report: "q3.pdf" },
    { client: "Globex", report: "q4.pdf" },
  ]);
});

test("supports quoted fields containing commas", () => {
  expect(parseCsv(`name,note\n"Acme, Inc.",ok`)).toEqual([{ name: "Acme, Inc.", note: "ok" }]);
});

test("ignores trailing blank lines", () => {
  expect(parseCsv("a\n1\n\n")).toEqual([{ a: "1" }]);
});
