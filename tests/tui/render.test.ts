import { test, expect } from "bun:test";
import { progressBar, spinnerFrame, truncate } from "../../src/tui/render";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../../src/tui/glyphs";

test("a progress bar is exactly the requested width", () => {
  for (const done of [0, 3, 7, 10]) {
    expect(progressBar(done, 10, 20)).toHaveLength(20);
  }
});

test("a progress bar fills proportionally", () => {
  expect(progressBar(0, 10, 10)).toBe("··········");
  expect(progressBar(10, 10, 10)).toBe("██████████");
  expect(progressBar(5, 10, 10)).toBe("█████·····");
});

test("a progress bar survives a zero total", () => {
  expect(progressBar(0, 0, 6)).toHaveLength(6);
});

test("the spinner cycles through distinct frames and wraps around", () => {
  const frames = [0, 1, 2, 3].map((tick) => spinnerFrame(tick, UNICODE_GLYPHS.spinner));
  expect(new Set(frames).size).toBeGreaterThan(1);
  expect(spinnerFrame(0, UNICODE_GLYPHS.spinner)).toBe(spinnerFrame(1000, UNICODE_GLYPHS.spinner));
});

test("the spinner cycles through whichever frames it is given", () => {
  expect(spinnerFrame(0, ASCII_GLYPHS.spinner)).toBe("|");
  expect(spinnerFrame(4, ASCII_GLYPHS.spinner)).toBe("|");
  expect(spinnerFrame(1, UNICODE_GLYPHS.spinner)).toBe("⠙");
});

test("truncate keeps short text and ellipsises long text to the limit", () => {
  expect(truncate("short", 10)).toBe("short");
  expect(truncate("a".repeat(30), 10)).toHaveLength(10);
  expect(truncate("a".repeat(30), 10).endsWith("…")).toBe(true);
});
