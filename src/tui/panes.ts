import type { Glyphs } from "./glyphs";
import type { Pane } from "./layout";
import type { Role, Theme } from "./theme";
import type { SessionSummary } from "../store/sessions";
import type { SpecTree, StageState, TaskState } from "../spec/project";

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

/**
 * The marks. Warm for what is alive or proposed, cold for what is settled —
 * the same distinction the palette makes, so the glyph and the colour say the
 * same thing rather than two different things.
 */
const STAGE_MARK: Record<StageState, { glyph: string; role: Role }> = {
  todo: { glyph: "○", role: "faint" },
  active: { glyph: "❀", role: "petal" },
  done: { glyph: "◆", role: "ice" },
};

const TASK_MARK: Record<TaskState, { glyph: string; role: Role }> = {
  todo: { glyph: "○", role: "faint" },
  blocked: { glyph: "!", role: "warn" },
  running: { glyph: "●", role: "petal" },
  done: { glyph: "✓", role: "ice" },
  failed: { glyph: "×", role: "error" },
};

const ASCII_MARKS: Record<string, string> = {
  "○": "o",
  "❀": "*",
  "◆": "#",
  "●": "@",
  "✓": "+",
  "×": "x",
  "!": "!",
};

/**
 * The state of the work in hand.
 *
 * Finished stages are collapsed and the active one is opened: a tree that
 * shows every node at once stops being read. What is blocked stays visible
 * whatever stage it belongs to, because that is the thing a person can act on.
 */
export function gardenPane(tree: SpecTree, options: PaneOptions): Pane {
  const { theme, glyphs, width } = options;
  const ascii = glyphs.mark === "*";
  const mark = (glyph: string) => (ascii ? (ASCII_MARKS[glyph] ?? glyph) : glyph);

  const lines: { text: string; id?: string }[] = [
    { text: theme.paint("text", truncate(tree.title, width)) },
    {
      text: theme.paint(
        "muted",
        truncate(`build ${tree.progress.done}/${tree.progress.total}`, width),
      ),
    },
    { text: "" },
  ];

  for (const { stage, state } of tree.stages) {
    const { glyph, role } = STAGE_MARK[state];
    lines.push({
      text: `${theme.paint(role, mark(glyph))} ${theme.paint(state === "todo" ? "faint" : "text", truncate(stage, width - 2))}`,
    });

    if (state !== "active") continue;

    if (stage === "spec") {
      for (const criterion of tree.criteria) {
        const met = criterion.evidence !== undefined;
        lines.push({
          text: `  ${theme.paint(met ? "ice" : "faint", mark(met ? "✓" : "○"))} ${theme.paint(
            met ? "text" : "muted",
            truncate(criterion.text, width - 4),
          )}`,
        });
      }
    }

    if (stage === "build") {
      for (const task of tree.tasks) {
        const { glyph: taskGlyph, role: taskRole } = TASK_MARK[task.state];
        lines.push({
          text: `  ${theme.paint(taskRole, mark(taskGlyph))} ${theme.paint("text", truncate(task.title, width - 4))}`,
          id: `task:${task.id}`,
        });
        if (task.agent !== undefined) {
          lines.push({
            text: `    ${theme.paint("petal", mark("❀"))} ${theme.paint("muted", truncate(task.agent, width - 6))}`,
          });
        }
      }
    }
  }

  // Blocked work is what a person can unblock, so it is never folded away.
  const blocked = tree.tasks.filter((task) => task.state === "blocked" || task.state === "failed");
  const buildActive = tree.stages.some((s) => s.stage === "build" && s.state === "active");
  if (blocked.length > 0 && !buildActive) {
    lines.push({ text: "" });
    for (const task of blocked) {
      const { glyph, role } = TASK_MARK[task.state];
      lines.push({
        text: `${theme.paint(role, mark(glyph))} ${theme.paint("muted", truncate(task.title, width - 2))}`,
        id: `task:${task.id}`,
      });
    }
  }

  return sized(lines, options.rows);
}
