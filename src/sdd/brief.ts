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
}

const HEADING = /^### Task (\d+): (.+)$/;

export function splitPlan(markdown: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  let current: PlanTask | null = null;
  const body: string[] = [];

  const flush = () => {
    if (current === null) return;
    // A horizontal rule between tasks is the plan's punctuation, not the task's.
    while (body.length > 0 && /^(---|\s*)$/.test(body[body.length - 1]!)) body.pop();
    tasks.push({ ...current, text: `${current.text}\n${body.join("\n")}`.trimEnd() });
    body.length = 0;
  };

  for (const line of markdown.split("\n")) {
    const match = line.match(HEADING);
    if (match) {
      flush();
      current = { id: `T${match[1]}`, title: match[2]!.trim(), text: line };
      continue;
    }
    if (current !== null) body.push(line);
  }
  flush();
  return tasks;
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
