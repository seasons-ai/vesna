/**
 * The garden as a tree: the same stages, tasks, witnesses, reviews and
 * parked findings the TUI's `gardenPane` draws, reduced here to plain data
 * so the tree view (Task 7) has nothing left to compute.
 *
 * Pure — no `vscode` import, no I/O. `open` paths are built with
 * `node:path`'s `join` from `state.root`, so the adapter only has to hand
 * them to the editor.
 */
import { join } from "node:path";
import type { Evidence, SpecTree, State, Task } from "./protocol";

export interface Node {
  id: string;
  label: string;
  description?: string;
  icon: "todo" | "active" | "done" | "running" | "failed" | "blocked" | "review" | "parked" | "witness";
  children: Node[];
  open?: string;
  command?: { name: string; argument: string };
}

/** One witness segment: a check, a dash for one never declared, a cross for one that failed. */
function witness(ok: boolean | null, name: string): string {
  return ok === null ? `— ${name}` : ok ? `✓ ${name}` : `× ${name}`;
}

/** The witness line under a done task, worded exactly like the TUI's. */
export function marks(evidence: Evidence): string {
  return [witness(evidence.worker, "worker"), witness(evidence.reviewer, "reviewer"), witness(evidence.vesna, "vesna")].join(
    "  ",
  );
}

/** A review's label, worded exactly like the TUI's `gardenPane`. */
function reviewLabel(review: SpecTree["reviews"][string]): string {
  if (review.spec === "no_verdict") return `review ${review.round}: no verdict`;
  if (review.spec === "not_met") return `review ${review.round}: not met`;
  return `review ${review.round}: ${review.open.length} open`;
}

function specDir(root: string, slug: string): string {
  return join(root, ".vesna", "specs", slug);
}

function taskNode(root: string, slug: string, spec: SpecTree, task: Task): Node {
  const children: Node[] = [];

  if (task.state === "done") {
    children.push({ id: `task:${task.id}:witness`, label: marks(task.evidence), icon: "witness", children: [] });
  }

  const review = spec.reviews[task.id];
  if (review !== undefined) {
    children.push({ id: `task:${task.id}:review`, label: reviewLabel(review), icon: "review", children: [] });
  }

  spec.parked
    .filter((p) => p.task === task.id)
    .forEach((parked, index) => {
      const where = `${parked.finding.file}${parked.finding.line !== undefined ? `:${parked.finding.line}` : ""}`;
      children.push({
        id: `task:${task.id}:parked:${index}`,
        label: `parked: ${where} — ${parked.finding.text}`,
        icon: "parked",
        children: [],
      });
    });

  const node: Node = {
    id: `task:${task.id}`,
    label: `${task.id}  ${task.title}`,
    icon: task.state,
    open: join(specDir(root, slug), "briefs", `${task.id}.md`),
    children,
  };
  if (task.state !== "done") {
    node.command = { name: "build", argument: `retry ${task.id}` };
  }
  return node;
}

/** Whether the garden, as a whole, reads as done, active or not yet begun. */
function overallIcon(spec: SpecTree): "todo" | "active" | "done" {
  const done = spec.stages.find((s) => s.stage === "done");
  if (done?.state === "done") return "done";
  return spec.stages.some((s) => s.state === "active") ? "active" : "todo";
}

/**
 * The garden as a tree, or `[]` when there is no spec to draw. A single
 * root carries the spec's title and its build progress; the stages hang
 * off it, and the tasks hang off `build`.
 */
export function gardenTree(state: State): Node[] {
  const spec = state.spec;
  if (spec === null) return [];
  const slug = state.specSlug ?? spec.id;

  const stages: Node[] = spec.stages.map(({ stage, state: stageState }) => {
    const node: Node = { id: `stage:${stage}`, label: stage, icon: stageState, children: [] };
    if (stage === "spec") node.open = join(specDir(state.root, slug), "spec.md");
    if (stage === "plan") node.open = join(specDir(state.root, slug), "plan.md");
    if (stage === "build") node.children = spec.tasks.map((task) => taskNode(state.root, slug, spec, task));
    return node;
  });

  const root: Node = {
    id: `spec:${spec.id}`,
    label: spec.title,
    description: `build ${spec.progress.done}/${spec.progress.total}`,
    icon: overallIcon(spec),
    children: stages,
  };
  return [root];
}
