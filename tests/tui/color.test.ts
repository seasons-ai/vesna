import { test, expect } from "bun:test";
import {
  bg24, bg8, contrastRatio, fg24, fg8, nearest256, parseHex, relativeLuminance,
} from "../../src/tui/color";

test("a hex string parses into channel bytes", () => {
  expect(parseHex("#14161F")).toEqual({ r: 0x14, g: 0x16, b: 0x1f });
});

test("the leading hash is optional and case does not matter", () => {
  expect(parseHex("e3e6ef")).toEqual(parseHex("#E3E6EF"));
});

test("luminance runs from black to white", () => {
  expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
  expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 5);
});

test("black on white is the maximum contrast WCAG defines", () => {
  expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 2);
});

test("contrast does not care which colour is named first", () => {
  expect(contrastRatio("#14161F", "#E3E6EF")).toBeCloseTo(
    contrastRatio("#E3E6EF", "#14161F"), 6,
  );
});

test("a colour against itself has no contrast at all", () => {
  expect(contrastRatio("#BE4674", "#BE4674")).toBeCloseTo(1, 6);
});

test("the ratios the spec was written from still hold", () => {
  expect(contrastRatio("#14161F", "#E3E6EF")).toBeCloseTo(14.46, 1);
  expect(contrastRatio("#FBF7F4", "#7B6E77")).toBeCloseTo(4.54, 1);
});

test("pure colours land on their own cube entries", () => {
  expect(nearest256("#000000")).toBe(16);
  expect(nearest256("#FFFFFF")).toBe(231);
});

test("a near-black lands in the grey ramp, not on pure black", () => {
  expect(nearest256("#14161F")).toBe(234);
});

test("the two palette collisions the spec fixed stay fixed", () => {
  expect(nearest256("#14161F")).not.toBe(nearest256("#1C202C"));
  expect(nearest256("#BE4674")).not.toBe(nearest256("#B03A4A"));
});

test("every 24-bit sequence names all three channels", () => {
  expect(fg24("#F3AFC2")).toBe("\x1b[38;2;243;175;194m");
  expect(bg24("#14161F")).toBe("\x1b[48;2;20;22;31m");
});

test("the 8-bit sequences use the indexed form", () => {
  expect(fg8(217)).toBe("\x1b[38;5;217m");
  expect(bg8(234)).toBe("\x1b[48;5;234m");
});
