import type { Ask, AskChoice, AskKind, Notification } from "./types";

/**
 * The questions the core puts to whoever is looking. Each has an id so a
 * client can answer the right one and a second client can drop it once
 * answered. Only a listed choice resolves an ask: a strict question ignores
 * enter, and the mapping of keys to choices is the client's business.
 */
export function createAsks(emit: (n: Notification) => void) {
  const open = new Map<string, { ask: Ask; resolve: (choice: AskChoice) => void }>();
  let next = 1;
  return {
    ask(kind: AskKind, lines: string[], choices: AskChoice[], strict: boolean): Promise<AskChoice> {
      const id = `a${next++}`;
      const ask: Ask = { id, kind, lines, choices, strict };
      return new Promise<AskChoice>((resolve) => {
        open.set(id, { ask, resolve });
        emit({ method: "ask", params: ask });
      });
    },
    answer(id: string, value: string): boolean {
      const entry = open.get(id);
      if (entry === undefined) return false;
      const choice = value.trim().slice(0, 1).toLowerCase();
      if (!(entry.ask.choices as string[]).includes(choice)) return false;
      open.delete(id);
      emit({ method: "ask.resolved", params: { id } });
      entry.resolve(choice as AskChoice);
      return true;
    },
    open(): Ask[] {
      return [...open.values()].map((e) => e.ask);
    },
  };
}
