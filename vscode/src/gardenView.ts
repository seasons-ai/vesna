/**
 * The garden in the explorer: `garden.ts` builds the nodes, this module is
 * the `TreeDataProvider` that hands them to VS Code. `treeItemFor` is the
 * whole mapping from a `Node` to what a `TreeItem` shows, as plain data, so
 * `bun test` can check it; the provider takes the `vscode` constructors it
 * needs at construction, so nothing here imports `vscode` at runtime.
 */
import type * as vscode from "vscode";
import { gardenTree, type Node } from "./garden";
import type { State } from "./protocol";

export type Collapsible = "expanded" | "collapsed" | "none";

export interface ItemShape {
  id: string;
  label: string;
  description: string | undefined;
  collapsible: Collapsible;
  /** A codicon name, for `ThemeIcon`. */
  icon: string;
  contextValue: "task-open" | undefined;
  open: string | undefined;
}

const CODICON: Record<Node["icon"], string> = {
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

/**
 * Stages and the root open expanded, a task with a witness, a review or a
 * parked finding beneath it starts folded, and anything childless is a leaf.
 */
function collapsibleFor(node: Node): Collapsible {
  if (node.children.length === 0) return "none";
  return node.id.startsWith("task:") ? "collapsed" : "expanded";
}

export function treeItemFor(node: Node): ItemShape {
  return {
    id: node.id,
    label: node.label,
    description: node.description,
    collapsible: collapsibleFor(node),
    icon: CODICON[node.icon],
    contextValue: node.command !== undefined ? "task-open" : undefined,
    open: node.open,
  };
}

/** The slice of the `vscode` namespace the provider constructs things from. */
export type TreeApi = Pick<typeof vscode, "EventEmitter" | "TreeItem" | "TreeItemCollapsibleState" | "ThemeIcon" | "Uri">;

export const GARDEN_VIEW_ID = "vesna.garden";

export class GardenProvider implements vscode.TreeDataProvider<Node> {
  private roots: Node[] = [];
  private readonly changed: vscode.EventEmitter<Node | undefined>;
  readonly onDidChangeTreeData: vscode.Event<Node | undefined>;

  constructor(private readonly api: TreeApi) {
    this.changed = new api.EventEmitter<Node | undefined>();
    this.onDidChangeTreeData = this.changed.event;
  }

  /** Rebuilds the tree from `state` (empty with no state or no spec) and redraws it. */
  refresh(state: State | null): void {
    this.roots = state === null ? [] : gardenTree(state);
    this.changed.fire(undefined);
  }

  getChildren(element?: Node): Node[] {
    return element === undefined ? this.roots : element.children;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const { api } = this;
    const shape = treeItemFor(node);
    const collapsible = {
      expanded: api.TreeItemCollapsibleState.Expanded,
      collapsed: api.TreeItemCollapsibleState.Collapsed,
      none: api.TreeItemCollapsibleState.None,
    }[shape.collapsible];
    const item = new api.TreeItem(shape.label, collapsible);
    item.id = shape.id;
    item.description = shape.description;
    item.iconPath = new api.ThemeIcon(shape.icon);
    item.contextValue = shape.contextValue;
    if (shape.open !== undefined) {
      item.command = { command: "vscode.open", title: "Open", arguments: [api.Uri.file(shape.open)] };
      item.tooltip = shape.open;
    }
    return item;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
