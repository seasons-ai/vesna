import type { Glyphs } from "./glyphs";
import type { Pane } from "./layout";
import type { Theme } from "./theme";
import type { SessionSummary } from "../store/sessions";

/**
 * What the columns beside the conversation show.
 *
 * Both are built to an exact width and an exact height, because the layout
 * composes them into rows and a pane that runs long would push the frame out
 * of shape.
 */

export interface PaneOptions {
  theme: Theme;
  glyphs: Glyphs;
  width: number;
  rows: number;
}

/** Trims plain text to a column. Applied before painting, so no escapes yet. */
function truncate(text: string, limit: number): string {
  if (limit <= 0) return "";
  return [...text].length <= limit ? text : `${[...text].slice(0, limit - 1).join("")}…`;
}

function heading(text: string, options: PaneOptions): string {
  return options.theme.paint("muted", truncate(text, options.width));
}

/** Pads or trims a pane to exactly the height it was given. */
function sized(lines: { text: string; id?: string }[], rows: number): Pane {
  const kept = lines.slice(0, rows);
  while (kept.length < rows) kept.push({ text: "" });
  return { lines: kept.map((line) => line.text), targets: kept.map((line) => line.id) };
}

/**
 * The conversations you can switch to.
 *
 * The one you are in is shown but not offered: resuming the conversation you
 * are already having is not a thing, and leaving it out entirely would make
 * the panel look like it had lost your place.
 */
export function chatsPane(
  sessions: SessionSummary[],
  current: string | undefined,
  folder: string,
  options: PaneOptions,
): Pane {
  const { theme, glyphs, width } = options;
  const lines: { text: string; id?: string }[] = [
    { text: heading(folder.split("/").slice(-2).join("/"), options) },
    { text: "" },
  ];

  if (sessions.length === 0) {
    lines.push({ text: theme.paint("faint", truncate("no conversations yet", width)) });
    return sized(lines, options.rows);
  }

  for (const session of sessions) {
    const here = session.id === current;
    // Two columns of chrome before the title: the marker and its space.
    const title = truncate(session.title === "" ? "untitled" : session.title, width - 2);
    const mark = here ? theme.paint("petal", glyphs.bullet) : " ";
    lines.push({
      text: `${mark} ${theme.paint(here ? "text" : "muted", title)}`,
      ...(here ? {} : { id: `session:${session.id}` }),
    });
  }

  return sized(lines, options.rows);
}
