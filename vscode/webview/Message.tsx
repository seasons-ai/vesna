import { useMemo } from "react";
import type { Entry } from "../src/state";
import { render } from "./markdown";

type MessageEntry = Extract<Entry, { kind: "user" | "assistant" }>;

/**
 * A person's message is a right-aligned bubble of plain text. The
 * assistant's is markdown, re-rendered as it streams; the HTML comes from
 * `render()` alone, which escapes anything raw.
 */
export function Message({ entry }: { entry: MessageEntry }) {
  if (entry.kind === "user") return <div className="message user">{entry.text}</div>;
  return <AssistantMessage text={entry.text} open={entry.open} />;
}

function AssistantMessage({ text, open }: { text: string; open: boolean }) {
  const html = useMemo(() => render(text), [text]);
  return (
    <div className={open ? "message assistant open" : "message assistant"} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
