import { test, expect } from "bun:test";
import type { Node } from "../src/garden";
import { treeItemFor } from "../src/gardenView";

function node(over: Partial<Node> & Pick<Node, "id" | "label" | "icon">): Node {
  return { children: [], ...over };
}

test("the root is expanded and carries the description", () => {
  const item = treeItemFor(node({ id: "spec:abort", label: "Reliable cancellation", description: "build 1/2", icon: "active", children: [node({ id: "stage:spec", label: "spec", icon: "done" })] }));
  expect(item).toEqual({ id: "spec:abort", label: "Reliable cancellation", description: "build 1/2", collapsible: "expanded", icon: "circle-filled", contextValue: undefined, open: undefined });
});

test("a stage with children is expanded, one without is a leaf", () => {
  const build = node({ id: "stage:build", label: "build", icon: "active", children: [node({ id: "task:T1", label: "T1  one", icon: "done" })] });
  const design = node({ id: "stage:design", label: "design", icon: "done" });
  expect(treeItemFor(build).collapsible).toBe("expanded");
  expect(treeItemFor(design).collapsible).toBe("none");
});

test("a task with children is collapsed, one without is a leaf", () => {
  const withWitness = node({ id: "task:T1", label: "T1  one", icon: "done", open: "/repo/briefs/T1.md", children: [node({ id: "task:T1:witness", label: "✓ worker", icon: "witness" })] });
  const bare = node({ id: "task:T2", label: "T2  two", icon: "todo", open: "/repo/briefs/T2.md" });
  expect(treeItemFor(withWitness).collapsible).toBe("collapsed");
  expect(treeItemFor(bare).collapsible).toBe("none");
});

test("a node with an open path keeps it, and a retry command marks the item task-open", () => {
  const retryable = node({ id: "task:T2", label: "T2  two", icon: "failed", open: "/repo/briefs/T2.md", command: { name: "build", argument: "retry T2" } });
  const done = node({ id: "task:T1", label: "T1  one", icon: "done", open: "/repo/briefs/T1.md" });
  expect(treeItemFor(retryable).open).toBe("/repo/briefs/T2.md");
  expect(treeItemFor(retryable).contextValue).toBe("task-open");
  expect(treeItemFor(done).contextValue).toBeUndefined();
  expect(treeItemFor(node({ id: "stage:done", label: "done", icon: "todo" })).open).toBeUndefined();
});

test("every icon maps to a codicon", () => {
  const icons: Record<Node["icon"], string> = {
    todo: "circle-outline",
    active: "circle-filled",
    done: "pass",
    running: "sync~spin",
    failed: "error",
    blocked: "warning",
    review: "book",
    parked: "pinned",
    witness: "verified",
  };
  for (const [icon, codicon] of Object.entries(icons) as [Node["icon"], string][]) {
    expect(treeItemFor(node({ id: `x:${icon}`, label: icon, icon })).icon).toBe(codicon);
  }
});
