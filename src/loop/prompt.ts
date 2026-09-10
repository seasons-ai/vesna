import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolSpec } from "../providers/types";

/**
 * Who Vesna tells the model it is.
 *
 * Without this the agent is a general assistant holding tools it does not know
 * it has: asked whether it can see the machine it is running on, it answers no,
 * while `read` and `shell` sit unused in its own tool list.
 *
 * The tool section is generated from the tools actually passed, never written
 * by hand. A project can withhold nodes, and a prompt that promised them would
 * only trade one wrong answer for another.
 */

export interface PromptContext {
  cwd: string;
  platform: string;
  now: Date;
  tools: ToolSpec[];
  /** Contents of .vesna/AGENTS.md, when the project has one. */
  notes?: string;
}

export function systemPrompt(context: PromptContext): string {
  const { cwd, platform, now, tools, notes } = context;

  const sections: string[] = [
    [
      "You are Vesna, an agent working in a terminal on the user's machine.",
      "",
      `Working directory: ${cwd}`,
      `Platform: ${platform}`,
      `Today: ${now.toISOString().slice(0, 10)}`,
    ].join("\n"),
    toolSection(tools),
    [
      "How to work:",
      "- Act rather than describe. If a tool answers the question, call it and answer from what you found.",
      "- Read a file before you change it. Never guess at contents you could have read.",
      "- Make the smallest change that does the job, and say what you changed.",
      "- Report failures plainly, with the actual output. Do not smooth them over.",
      "- Answer in the language the user writes to you in.",
    ].join("\n"),
    [
      "A run that works can be frozen into a deterministic flow and replayed without a model,",
      "so prefer explicit inputs and repeatable steps over one-off improvisation.",
    ].join("\n"),
  ];

  const planning = planningSection(tools);
  if (planning !== null) sections.push(planning);

  if (notes !== undefined && notes !== "") {
    sections.push(["# Project instructions", "", notes].join("\n"));
  }

  return sections.join("\n\n");
}

/**
 * Tools alone do not get used.
 *
 * The planning nodes were offered for a while and never called once: the model
 * did thirty-one shell calls and no planning, because nothing told it that
 * work of several steps is worth recording, or that the panel showing it needs
 * a spec the user has to open.
 */
function planningSection(tools: ToolSpec[]): string | null {
  const has = (name: string) => tools.some((tool) => tool.name === name);
  if (!has("plan")) return null;

  const lines = [
    "When a request takes several steps, record it with `plan` before starting:",
    "the stage, the acceptance criteria, and the tasks. The user watches that",
    "panel to see where the work stands, and an unrecorded plan is invisible.",
    "",
    "`plan` needs an open spec. If it refuses because there is none, say so and",
    "ask the user to run `/spec new <name>` — do not carry on silently, and do",
    "not invent somewhere else to put the plan.",
  ];

  if (has("task_start")) {
    lines.push("", "Say which task you are on with `task_start` as you pick it up.");
  }

  if (has("task_verify")) {
    lines.push(
      "",
      "You cannot mark a task finished by saying so. `task_verify` takes a command",
      "that fails when the work is not done — a test, a typecheck, a grep — and the",
      "exit status decides. If it fails, read the output and fix the work.",
    );
  }

  return lines.join("\n");
}

function toolSection(tools: ToolSpec[]): string {
  if (tools.length === 0) {
    return [
      "You have no tools in this project: you cannot read or change anything here.",
      "Answer from what you are told, and say plainly when a task needs access you do not have.",
    ].join("\n");
  }

  const listed = tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
  return [
    "You act on this machine through these tools, and they operate on real files:",
    "",
    listed,
    "",
    "Never tell the user you cannot see their files or their machine. You can — use a tool",
    "and find out. Only say you have no access to something after a tool has told you so.",
  ].join("\n");
}

/** The project's own instructions, if it has any. */
export async function readProjectNotes(root: string): Promise<string | undefined> {
  try {
    const text = (await readFile(join(root, ".vesna", "AGENTS.md"), "utf8")).trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}
