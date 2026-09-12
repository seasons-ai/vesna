import { join } from "node:path";
import { specPaths, writeSpecFile } from "../spec/store";

/**
 * A task's text, cut out of the plan.
 *
 * A worker reads its brief and never the plan. The plan is the whole
 * argument; the brief is the one task, with the exact values to use. A worker
 * handed the plan reads the other tasks, and starts doing them.
 */
export interface PlanTask {
  id: string;
  title: string;
  text: string;
  /** The check Vesna runs itself, from the task's `verify:` line. */
  verify?: string;
}

const HEADING = /^### Task (\d+): (.+)$/;
const VERIFY = /^verify:(.*)$/;
const GOAL = /^\*\*Goal:\*\*\s*(.+)$/m;
// A fenced code block opens with 3+ backticks or tildes (up to 3 leading
// spaces, per CommonMark) and closes with a matching line of the same
// character, at least as long. A `### Task N:` line inside one is somebody's
// example, not the plan's own structure.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function splitPlan(markdown: string): PlanTask[] {
  // A plan.md saved with CRLF (or old-Mac lone-CR) line endings must split
  // exactly like one saved with LF: every line-ending check below assumes a
  // bare "\n", and a stray "\r" left on each line would keep `### Task`
  // headings from ever matching.
  markdown = markdown.replace(/\r\n?/g, "\n");
  const tasks: PlanTask[] = [];
  let current: PlanTask | null = null;
  const body: string[] = [];
  let fenceChar = "";
  let fenceLen = 0;
  let sawBody = false;

  const flush = () => {
    if (current === null) return;
    // A horizontal rule between tasks is the plan's punctuation, not the task's.
    while (body.length > 0 && /^(---|\s*)$/.test(body[body.length - 1]!)) body.pop();
    tasks.push({ ...current, text: `${current.text}\n${body.join("\n")}`.trimEnd() });
    body.length = 0;
  };

  for (const line of markdown.split("\n")) {
    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1]!;
      if (fenceChar === "") {
        fenceChar = marker[0]!;
        fenceLen = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
        fenceChar = "";
        fenceLen = 0;
      }
    }

    const inFence = fenceChar !== "";
    const match = inFence ? null : line.match(HEADING);
    if (match) {
      const number = match[1]!;
      const id = `T${number}`;
      if ((current !== null && current.id === id) || tasks.some((task) => task.id === id)) {
        throw new Error(`plan names Task ${number} twice`);
      }
      flush();
      current = { id, title: match[2]!.trim(), text: line };
      sawBody = false;
      continue;
    }

    const verify = inFence || current === null ? null : line.match(VERIFY);
    if (verify) {
      const number = current!.id.slice(1);
      if (current!.verify !== undefined) throw new Error(`Task ${number}: verify: given twice`);
      const command = verify[1]!.trim();
      if (command === "") throw new Error(`Task ${number}: verify: is empty`);
      if (sawBody) throw new Error(`Task ${number}: verify: must be the first line of the task`);
      current!.verify = command;
      continue;
    }

    if (current !== null && line.trim() !== "") sawBody = true;
    if (current !== null) body.push(line);
  }
  flush();
  return tasks;
}

/**
 * The plan's stated goal, if it declared one — the `**Goal:**` line near the
 * top of plan.md. A plan without one is normal, not malformed, so this
 * tolerates absence rather than throwing.
 */
export function planGoal(markdown: string): string | undefined {
  const match = markdown.replace(/\r\n?/g, "\n").match(GOAL);
  const goal = match?.[1]?.trim();
  return goal !== undefined && goal !== "" ? goal : undefined;
}

export function writeBriefs(
  specsRoot: string,
  slug: string,
  tasks: PlanTask[],
): Record<string, string> {
  const { briefs } = specPaths(specsRoot, slug);
  const paths: Record<string, string> = {};
  for (const task of tasks) {
    const path = join(briefs, `${task.id}.md`);
    writeSpecFile(path, `${task.text}\n`);
    paths[task.id] = path;
  }
  return paths;
}
