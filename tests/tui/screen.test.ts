import { test, expect } from "bun:test";
import { createScreen, type Terminal } from "../../src/tui/screen";
import type { Frame } from "../../src/tui/layout";

function fake(rows = 4, cols = 20) {
  const writes: string[] = [];
  const terminal: Terminal = {
    write: (text) => void writes.push(text),
    size: () => ({ rows, cols }),
  };
  return { terminal, writes, last: () => writes[writes.length - 1] ?? "" };
}

const frame = (lines: string[], row = 0, col = 0): Frame => ({ lines, cursor: { row, col } });

test("entering takes over the alternate screen so the shell scrollback survives", () => {
  const host = fake();
  createScreen(host.terminal).enter();
  expect(host.writes.join("")).toContain("\x1b[?1049h");
});

test("entering asks the terminal to bracket pastes", () => {
  const host = fake();
  createScreen(host.terminal).enter();
  expect(host.writes.join("")).toContain("\x1b[?2004h");
});

test("leaving undoes everything it turned on, in reverse", () => {
  const host = fake();
  const screen = createScreen(host.terminal);
  screen.enter();
  host.writes.length = 0;
  screen.leave();
  const output = host.writes.join("");
  expect(output).toContain("\x1b[?2004l");
  expect(output).toContain("\x1b[?25h");
  expect(output).toContain("\x1b[?1049l");
  expect(output.indexOf("\x1b[?2004l")).toBeLessThan(output.indexOf("\x1b[?1049l"));
});

test("the first draw writes every line", () => {
  const host = fake();
  const screen = createScreen(host.terminal);
  screen.draw(frame(["a", "b", "c", "d"]));
  const output = host.last();
  for (const line of ["a", "b", "c", "d"]) expect(output).toContain(line);
});

test("a redraw touches only the lines that changed", () => {
  const host = fake();
  const screen = createScreen(host.terminal);
  screen.draw(frame(["a", "b", "c", "d"]));
  screen.draw(frame(["a", "B", "c", "d"]));
  const output = host.last();
  // A repaint is a move followed by a clear; a bare move is just the cursor.
  expect(output).toContain("\x1b[2;1H\x1b[2K");
  expect(output).toContain("B");
  expect(output).not.toContain("\x1b[1;1H\x1b[2K");
  expect(output).not.toContain("\x1b[3;1H\x1b[2K");
});

test("an unchanged frame still repositions the cursor and writes nothing else", () => {
  const host = fake();
  const screen = createScreen(host.terminal);
  screen.draw(frame(["a", "b"], 1, 3));
  screen.draw(frame(["a", "b"], 0, 5));
  expect(host.last()).toContain("\x1b[1;6H");
  expect(host.last()).not.toContain("\x1b[2;1H");
});

test("the cursor is placed in one-based terminal coordinates", () => {
  const host = fake();
  createScreen(host.terminal).draw(frame(["a", "b"], 1, 2));
  expect(host.last()).toContain("\x1b[2;3H");
});

test("each drawn line is cleared first, so shorter text cannot leave a tail", () => {
  const host = fake();
  const screen = createScreen(host.terminal);
  screen.draw(frame(["long line here"]));
  screen.draw(frame(["hi"]));
  expect(host.last()).toContain("\x1b[2K");
});

test("a resize forces a full repaint rather than a diff against a stale frame", () => {
  let rows = 4;
  const writes: string[] = [];
  const terminal: Terminal = { write: (t) => void writes.push(t), size: () => ({ rows, cols: 20 }) };
  const screen = createScreen(terminal);
  screen.draw(frame(["a", "b", "c", "d"]));
  rows = 5;
  writes.length = 0;
  screen.draw(frame(["a", "b", "c", "d", "e"]));
  const output = writes.join("");
  expect(output).toContain("\x1b[1;1H\x1b[2K"); // repainted despite being identical
  expect(output).toContain("e");
});

test("a draw is one write, so the screen cannot tear halfway through", () => {
  const host = fake();
  const screen = createScreen(host.terminal);
  screen.draw(frame(["a", "b", "c"]));
  expect(host.writes).toHaveLength(1);
});

const SURFACE = "\x1b[48;5;234m";

test("entering clears the screen with the canvas colour, not the terminal's", () => {
  const host = fake();
  createScreen(host.terminal, { surface: SURFACE }).enter();
  const output = host.writes.join("");
  expect(output.indexOf(SURFACE)).toBeLessThan(output.indexOf("\x1b[2J"));
});

test("each drawn line is written on the canvas and closed afterwards", () => {
  const host = fake();
  createScreen(host.terminal, { surface: SURFACE }).draw(frame(["a", "b"]));
  expect(host.last()).toContain(`\x1b[2K${SURFACE}a\x1b[0m`);
});

test("the canvas is re-established for every line, so one reset cannot strip the rest", () => {
  const host = fake();
  createScreen(host.terminal, { surface: SURFACE }).draw(frame(["a", "b", "c"]));
  expect(host.last().split(SURFACE)).toHaveLength(4);
});

test("a row with its own surface gets that one instead of the canvas", () => {
  const PANEL = "\x1b[48;5;235m";
  const host = fake();
  createScreen(host.terminal, { surface: SURFACE }).draw({
    lines: ["a", "b"],
    surfaces: [undefined, PANEL],
    cursor: { row: 0, col: 0 },
  });
  expect(host.last()).toContain(`\x1b[2K${SURFACE}a\x1b[0m`);
  expect(host.last()).toContain(`\x1b[2K${PANEL}b\x1b[0m`);
});

test("without a surface nothing extra is emitted at all", () => {
  const host = fake();
  createScreen(host.terminal).draw(frame(["a"]));
  expect(host.last()).not.toContain("\x1b[48;");
  expect(host.last()).toContain("\x1b[2Ka");
});

test("leaving resets the colour before handing the terminal back", () => {
  const host = fake();
  const screen = createScreen(host.terminal, { surface: SURFACE });
  screen.enter();
  host.writes.length = 0;
  screen.leave();
  const output = host.writes.join("");
  expect(output.indexOf("\x1b[0m")).toBeLessThan(output.indexOf("\x1b[?1049l"));
});
