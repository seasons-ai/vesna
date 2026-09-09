import { test, expect } from "bun:test";
import { layout, panelWidths, type ViewState } from "../../src/tui/layout";
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

test("a clickable row keeps its identity through the window into the frame", () => {
  const transcript = ["› hi", "  ⧉ copy", "answer", "  ⧉ copy"];
  const frame = layout(view({ transcript, targets: [undefined, "m1", undefined, "m2"] }), size);

  const found = frame.targets.filter((id) => id !== undefined);
  expect(found).toEqual(["m1", "m2"]);
  // And each id sits on the row that actually shows its button.
  for (const [row, id] of frame.targets.entries()) {
    if (id !== undefined) expect(frame.lines[row]).toContain("copy");
  }
});

test("there is one target entry per line, so a click can index straight in", () => {
  const frame = layout(view({ transcript: ["a", "b"], targets: [undefined, "m1"] }), size);
  expect(frame.targets).toHaveLength(frame.lines.length);
});

test("a row scrolled out of view carries no target, so a stale click cannot fire", () => {
  const transcript = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const targets = transcript.map((_, i) => (i === 0 ? "top" : undefined));
  const frame = layout(view({ transcript, targets }), size);
  expect(frame.targets).not.toContain("top");
});

test("without any targets the frame still reports one entry per line", () => {
  const frame = layout(view({ transcript: ["a"] }), size);
  expect(frame.targets).toHaveLength(frame.lines.length);
  expect(frame.targets.every((id) => id === undefined)).toBe(true);
});

const pane = (lines: string[]) => ({ lines, targets: lines.map(() => undefined) });

test("with no panels the conversation still owns the whole width", () => {
  expect(panelWidths(100, { left: false, right: false })).toEqual({ left: 0, right: 0 });
});

test("a panel is given a workable share, never a sliver", () => {
  const { left, right } = panelWidths(120, { left: true, right: true });
  expect(left).toBeGreaterThanOrEqual(22);
  expect(right).toBeGreaterThanOrEqual(24);
  // And the conversation keeps the majority.
  expect(120 - left - right - 2).toBeGreaterThan(left + right);
});

test("a narrow window drops the left panel first — it is the one you asked for", () => {
  const { left, right } = panelWidths(86, { left: true, right: true });
  expect(left).toBe(0);
  expect(right).toBeGreaterThan(0);
});

test("a very narrow window drops both rather than squeezing the conversation", () => {
  expect(panelWidths(70, { left: true, right: true })).toEqual({ left: 0, right: 0 });
});

test("a panel that was not asked for takes no width", () => {
  expect(panelWidths(140, { left: false, right: true }).left).toBe(0);
});

test("the conversation is laid out in the space the panels leave", () => {
  const wide = layout(view({ transcript: ["a word here"] }), { rows: 12, cols: 120 });
  const withPanels = layout(
    view({ transcript: ["a word here"], left: pane(["chats"]), right: pane(["garden"]) }),
    { rows: 12, cols: 120 },
  );
  expect(withPanels.lines).toHaveLength(wide.lines.length);
  for (const line of withPanels.lines) expect(visibleWidth(line)).toBe(120);
});

test("both panels appear, on their own sides", () => {
  const frame = layout(
    view({ transcript: ["talking"], left: pane(["CHATS"]), right: pane(["GARDEN"]) }),
    { rows: 12, cols: 120 },
  );
  // A panel's first line sits beside the header, not beside the first reply.
  const row = frame.lines.find((line) => line.includes("CHATS"))!;
  expect(row.indexOf("CHATS")).toBeLessThan(row.indexOf("GARDEN"));
  expect(frame.lines.join("\n")).toContain("talking");
});

test("a panel shorter than the window does not leave a ragged edge", () => {
  const frame = layout(
    view({ transcript: ["x"], right: pane(["one line only"]) }),
    { rows: 14, cols: 120 },
  );
  for (const line of frame.lines) expect(visibleWidth(line)).toBe(120);
});

test("the cursor still lands in the input box, not in a panel", () => {
  const editor = { ...createEditor(), text: "typing", cursor: 6 };
  const frame = layout(
    view({ editor, left: pane(["CHATS"]), right: pane(["GARDEN"]) }),
    { rows: 12, cols: 120 },
  );
  const { left } = panelWidths(120, { left: true, right: true });
  expect(frame.cursor.col).toBe(left + 1 + 2 + 6);
});

test("a click in the left panel is attributed to the left panel", () => {
  const left = { lines: ["one", "two"], targets: ["s1", "s2"] };
  const frame = layout(view({ transcript: ["x"], left }), { rows: 12, cols: 120 });
  expect(frame.leftTargets.filter((id) => id !== undefined)).toEqual(["s1", "s2"]);
  expect(frame.targets.filter((id) => id !== undefined)).toEqual([]);
});

test("a row can carry a target in a panel and another in the conversation", () => {
  const left = { lines: ["chat"], targets: ["session-1"] };
  const frame = layout(
    view({ transcript: ["hi", "  copy"], targets: [undefined, "message-1"], left }),
    { rows: 14, cols: 120 },
  );
  // Resolved by column, so neither one hides the other.
  expect(frame.leftTargets).toContain("session-1");
  expect(frame.targets).toContain("message-1");
  expect(frame.columns.left).toBeGreaterThan(0);
});
