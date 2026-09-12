import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolSpec } from "../providers/types";
import type { Shape, Stage } from "../spec/project";

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
  /**
   * Which phase of the process the open spec is in, when one is open, and
   * the shape the log already records for it, when it records one.
   */
  phase?: { stage: Stage; specPath: string; planPath: string; shape?: Shape; planApproved?: boolean; lastStop?: string };
}

export function systemPrompt(context: PromptContext): string {
  const { cwd, platform, now, tools, notes, phase } = context;

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
      "A task is finished when a check the system ran says so, not when you say so:",
      "prefer work that leaves evidence — a test, a command with an exit status — over work that leaves a claim.",
    ].join("\n"),
  ];

  const planning = planningSection(tools);
  if (planning !== null) sections.push(planning);

  if (phase !== undefined) sections.push(phaseSection(phase));

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
    "Give `plan` a short `title` for the work. It opens a spec by that name if",
    "none is open, so there is nothing to ask the user for first.",
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

/**
 * What the model should be doing right now, given where the work stands.
 *
 * The conversational phases are prompts the model follows; the mechanical
 * ones are a loop Vesna runs. The prompt says which is which so the model
 * does not try to build in a phase where building is the loop's job.
 */
export function phaseSection(phase: NonNullable<PromptContext["phase"]>): string {
  switch (phase.stage) {
    case "design":
      // Once per spec, not every turn: the log carries the classification
      // from the moment it is made, so a model told the shape does not
      // classify again — and a person's `/classify` stands over its own.
      return [
        "## Phase: design",
        phase.shape === undefined
          ? "The log has no classification yet: before anything else, call `classify` to say what shape this work is — spike, bounded, or architectural — and why. When in doubt choose the heavier shape. The person can overrule you with `/classify <shape>`."
          : `This work is classified as ${phase.shape}. Do not classify it again; the person changes the shape with \`/classify <shape>\` if they disagree.`,
        "Then understand the request: ask one question at a time, propose two or three approaches with a recommendation, and do not write code. A spike ends in an answer. A bounded change is designed here in the conversation and then built. An architectural change gets a written design next.",
      ].join("\n");
    case "spec":
      return [
        "## Phase: spec",
        `Write the design to \`${phase.specPath}\` with the write tool: the problem, the decisions with their reasons, what is out of scope, and how it will be tested. Then stop and ask the person to read it. They approve it with \`/approve spec\`; you cannot.`,
      ].join("\n");
    case "plan":
      // An approved plan is still the plan phase until /build runs it, but
      // the instruction changes: nothing to write, and a change withdraws
      // the approval — the log clears it on the next `task.added`.
      // A build the whole-branch review stopped has merged every task but
      // never reached build.done, so a plain /build finishes it — re-checking
      // what is red, running no task, and reviewing the whole branch again —
      // rather than refusing. Say that, not the recording-a-new-task route.
      if (phase.planApproved === true && phase.lastStop?.startsWith("branch review:")) {
        return [
          "## Phase: plan",
          `The last build stopped at the whole-branch review: ${phase.lastStop}. Help the person fix it in the tree; then a plain \`/build\` finishes the build — it re-checks what is red, runs no task, and reviews the whole branch again from where the build first started. Do not claim the branch is done.`,
        ].join("\n");
      }
      if (phase.planApproved === true) {
        return [
          "## Phase: plan",
          `The plan is approved: \`/build\` runs it, and only the person can start that. Do not rewrite \`${phase.planPath}\` or call \`plan\` unless the person asks for a change; any change to the plan withdraws the approval and needs \`/approve plan\` again.`,
        ].join("\n");
      }
      return [
        "## Phase: plan",
        `Write the plan to \`${phase.planPath}\`: one section per task, headed exactly \`### Task 1: <title>\`, \`### Task 2: <title>\` and so on. Each task is the smallest unit with its own test cycle, and its section contains everything a worker with no other context needs — files, the exact test code, the exact implementation, the commit message. Then call \`plan\` with the same tasks, ids \`T1\`, \`T2\` ... matching the headings, and their dependencies. Then stop. The person approves with \`/approve plan\`; you cannot, and \`/build\` will not run an unapproved plan.`,
      ].join("\n");
    case "build":
      return [
        "## Phase: build",
        "The plan is being built by `/build`: one worker per task in its own checkout, a review after each, fix rounds, then a merge. You are not the worker. Answer questions about the work, and if the person asks you to change the plan, say that the running build has to stop first.",
      ].join("\n");
    case "done":
      return "## Phase: done\nThe plan was built and reviewed. Report what was parked and what the final review found if asked.";
  }
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
