import { test, expect } from "bun:test";
import { layout, type ViewState } from "../../src/tui/layout";
import { visibleWidth } from "../../src/tui/wrap";
import { createEditor } from "../../src/tui/editor";
import { UNICODE_GLYPHS } from "../../src/tui/glyphs";
import { fg24 } from "../../src/tui/color";
import { PALETTES, type Token } from "../../src/tui/palette";
import { resolveTheme } from "../../src/tui/theme";

/** The default theme at full depth, for the tests that care about colour. */
const painted = resolveTheme("vesna", { depth: 24 });
const fg = (token: Token) => fg24(PALETTES.vesna!.tokens[token]);

function view(overrides: Partial<ViewState> = {}): ViewState {
  return {
    header: "vesna · gpt-5.6-sol",
    transcript: [],
    editor: createEditor(),
    hint: "/help",
    status: "$0.00",
    scroll: 0,
    glyphs: UNICODE_GLYPHS,
    // Most tests are about arithmetic, so the default paints nothing.
    paint: (_role, text) => text,
    ...overrides,
  };
}

const size = { rows: 10, cols: 30 };

test("the frame is exactly as tall as the terminal", () => {
  expect(layout(view(), size).lines).toHaveLength(10);
});

test("no line is wider than the terminal, so nothing wraps by accident", () => {
  const long = "x".repeat(200);
  const frame = layout(view({ transcript: [long], header: long, status: long }), size);
  for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
});

test("the header is the first line", () => {
  expect(layout(view(), size).lines[0]).toContain("vesna");
});

test("the status line is the last", () => {
  expect(layout(view(), size).lines[9]).toContain("$0.00");
});

test("the hint and the status share the last line, pushed to opposite ends", () => {
  const last = layout(view(), size).lines[9]!;
  expect(last.indexOf("/help")).toBeLessThan(last.indexOf("$0.00"));
});

test("a short conversation sits at the bottom of the transcript area, not the top", () => {
  const frame = layout(view({ transcript: ["only line"] }), size);
  const index = frame.lines.findIndex((line) => line.includes("only line"));
  const inputRow = frame.lines.findIndex((line) => line.includes("›"));
  expect(index).toBe(inputRow - 2); // the line just above the separator
});

test("a long conversation shows its tail", () => {
  const transcript = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const frame = layout(view({ transcript }), size).lines.join("\n");
  expect(frame).toContain("line 99");
  expect(frame).not.toContain("line 0\n");
});

test("scrolling up moves the window back through the conversation", () => {
  const transcript = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const frame = layout(view({ transcript, scroll: 10 }), size).lines.join("\n");
  expect(frame).not.toContain("line 99");
  expect(frame).toContain("line 89");
});

test("scrolling past the beginning stops at the beginning", () => {
  const frame = layout(view({ transcript: ["a", "b"], scroll: 999 }), size).lines.join("\n");
  expect(frame).toContain("a");
});

test("the cursor sits just after the prompt on an empty box", () => {
  const frame = layout(view(), size);
  expect(frame.lines[frame.cursor.row]).toContain("›");
  expect(frame.cursor.col).toBe(2);
});

test("the cursor follows the text that has been typed", () => {
  const editor = { ...createEditor(), text: "hello", cursor: 5 };
  expect(layout(view({ editor }), size).cursor.col).toBe(7);
});

test("a multi-line message grows the box downward and the cursor goes with it", () => {
  const editor = { ...createEditor(), text: "one\ntwo", cursor: 7 };
  const frame = layout(view({ editor }), size);
  expect(frame.lines[frame.cursor.row]).toContain("two");
  expect(frame.cursor.col).toBe(5);
});

test("an input longer than the width wraps inside the box", () => {
  const text = "y".repeat(40);
  const frame = layout(view({ editor: { ...createEditor(), text, cursor: 40 } }), size);
  expect(frame.lines.filter((line) => line.includes("y")).length).toBe(2);
});

test("the box stops growing before it swallows the conversation", () => {
  const editor = { ...createEditor(), text: "line\n".repeat(40), cursor: 0 };
  const frame = layout(view({ transcript: ["visible"], editor }), size);
  expect(frame.lines).toHaveLength(10);
  expect(frame.lines.join("\n")).toContain("visible");
});

test("a terminal too small to lay out still produces a frame of the right size", () => {
  for (const rows of [1, 2, 3, 4]) {
    const frame = layout(view({ transcript: ["x"] }), { rows, cols: 10 });
    expect(frame.lines).toHaveLength(rows);
    expect(frame.cursor.row).toBeLessThan(rows);
  }
});

test("the cursor never lands outside the frame", () => {
  const editor = { ...createEditor(), text: "z".repeat(500), cursor: 500 };
  const frame = layout(view({ editor }), size);
  expect(frame.cursor.row).toBeLessThan(frame.lines.length);
  expect(frame.cursor.col).toBeLessThanOrEqual(30);
});

test("every line is exactly as wide as the terminal, not merely no wider", () => {
  const frame = layout(view({ transcript: ["short", "a bit longer"] }), size);
  for (const line of frame.lines) expect(visibleWidth(line)).toBe(30);
});

test("the blank lines above a short conversation are filled too", () => {
  const frame = layout(view({ transcript: ["only"] }), size);
  expect(frame.lines.filter((line) => visibleWidth(line) !== 30)).toEqual([]);
});

test("lines stay full width at every window size", () => {
  for (const rows of [1, 2, 3, 4, 10, 40]) {
    for (const cols of [8, 20, 30, 120]) {
      const frame = layout(view({ transcript: ["x".repeat(200)] }), { rows, cols });
      for (const line of frame.lines) expect(visibleWidth(line)).toBe(cols);
    }
  }
});

test("padding is plain space, so a wrapped colour cannot bleed into it", () => {
  const painted = "\x1b[38;5;217mpetal\x1b[39m";
  const frame = layout(view({ transcript: [painted] }), size);
  const row = frame.lines.find((line) => line.includes("petal"))!;
  expect(row.endsWith(" ")).toBe(true);
  // The foreground closes before the padding; a full reset here would kill
  // the line's own background too.
  expect(row).toContain("\x1b[39m");
});

test("there is one surface entry per line, so the screen can pair them up", () => {
  const frame = layout(view(), size);
  expect(frame.surfaces).toHaveLength(frame.lines.length);
});

test("the input rows sit on the panel surface and the rest on the canvas", () => {
  const panel = "\x1b[48;5;235m";
  const editor = { ...createEditor(), text: "one\ntwo", cursor: 7 };
  const frame = layout(view({ editor, panel }), size);
  const surfaces = frame.surfaces ?? [];
  expect(surfaces).toHaveLength(frame.lines.length);
  const rows = surfaces
    .map((surface, index) => (surface === panel ? index : -1))
    .filter((index) => index >= 0);

  // Exactly the two input rows, immediately above the status line.
  expect(rows).toHaveLength(2);
  expect(rows.at(-1)).toBe(frame.lines.length - 2);
  expect(frame.lines[rows[0]!]).toContain("one");
});

test("with no panel every row falls back to the canvas", () => {
  const frame = layout(view(), size);
  const surfaces = frame.surfaces ?? [];
  expect(surfaces).toHaveLength(frame.lines.length);
  expect(surfaces.every((surface) => surface === undefined)).toBe(true);
});

test("the rule, the prompt glyph and the input text are painted by the theme", () => {
  const editor = { ...createEditor(), text: "typed", cursor: 5 };
  const frame = layout(
    view({ editor, paint: (role, text) => painted.paint(role, text) }),
    size,
  );

  // Nothing here knows about the theme module; the frame is painted through
  // the callback the view carries, which keeps `layout` a pure function.
  const rule = frame.lines.find((line) => line.includes("\u2500"))!;
  expect(rule).toContain(fg("rule"));

  const box = frame.lines.find((line) => line.includes("typed"))!;
  expect(box).toContain(fg("petal"));
  expect(box).toContain(fg("text"));
});

test("painting does not cost the frame its width invariant", () => {
  const editor = { ...createEditor(), text: "typed", cursor: 5 };
  for (const rows of [1, 2, 3, 4, 10, 40]) {
    for (const cols of [8, 20, 30, 120]) {
      const frame = layout(
        view({ editor, transcript: ["x".repeat(200)], paint: (role, text) => painted.paint(role, text) }),
        { rows, cols },
      );
      for (const line of frame.lines) expect(visibleWidth(line)).toBe(cols);
    }
  }
});

test("a status that nearly fills the line cannot push the frame over its width", () => {
  // Not a narrow-terminal curiosity: `room` reaches zero whenever the status
  // is one column short of the window, and an unguarded `fit` then returns the
  // whole hint. A line wider than the window wraps in a real terminal and
  // desynchronises the differential redraw for good.
  const hint = "/help \u00b7 alt-enter newline \u00b7 ctrl-c twice to leave";
  for (const status of ["1.2k tok \u00b7 $0.0412", "0 tok \u00b7 $0.0000", "$0.00"]) {
    for (let cols = 1; cols <= 60; cols += 1) {
      const frame = layout(view({ hint, status }), { rows: 10, cols });
      for (const line of frame.lines) {
        expect(`${cols}: ${visibleWidth(line)}`).toBe(`${cols}: ${cols}`);
      }
    }
  }
});
