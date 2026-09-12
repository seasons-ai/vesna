/**
 * The mode in the status bar: `$(sparkle) vesna: <mode>`, or `vesna:
 * building <task>` while a build runs, with a spinning icon while the core
 * is busy. The text and the icon are pure functions of the state; the
 * wiring takes the item it is handed, so nothing here imports `vscode` at
 * runtime and `bun test` can check the words.
 */
import type * as vscode from "vscode";
import type { State } from "./protocol";
import type { Store } from "./state";
import { WORDS } from "./words";

/** The task in flight: the first `running` task of the spec, or null. */
function inFlight(state: State): string | null {
  return state.spec?.tasks.find((task) => task.state === "running")?.id ?? null;
}

export function statusText(state: State | null): string {
  if (state === null) return WORDS.statusNone;
  if (state.building) return WORDS.statusBuilding(inFlight(state));
  return WORDS.statusMode(state.mode);
}

export function statusIcon(state: State | null): string {
  return state?.busy === true ? "$(sync~spin)" : "$(sparkle)";
}

/** The command the item runs when clicked; `extension.ts` registers it. */
export const CYCLE_MODE_COMMAND = "vesna.cycleMode";

/** Draws the store's state on `item` on every change; returns the unsubscribe. */
export function wireStatusBar(item: vscode.StatusBarItem, store: Store): () => void {
  const draw = (state: State | null): void => {
    item.text = `${statusIcon(state)} ${statusText(state)}`;
    item.tooltip = state === null ? "Vesna" : `Vesna — click to change the mode (${state.mode})`;
  };
  item.command = CYCLE_MODE_COMMAND;
  draw(store.model.state);
  item.show();
  return store.subscribe((model) => draw(model.state));
}
