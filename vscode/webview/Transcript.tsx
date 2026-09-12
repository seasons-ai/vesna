import { useLayoutEffect, useRef } from "react";
import type { Entry } from "../src/state";
import { Message } from "./Message";
import { StepCard } from "./StepCard";

/** How far above the bottom a person may be for the transcript to still follow new text. */
const FOLLOW_SLACK_PX = 80;

/**
 * The entries in order, in the one element that scrolls. It follows the
 * bottom while the last message is still streaming or a new entry arrives,
 * unless the person has scrolled up to read — then it stays where they are.
 */
export function Transcript({ entries }: { entries: Entry[] }) {
  const box = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastSeen = useRef<number | null>(null);

  const last = entries[entries.length - 1];
  const lastId = last?.id ?? null;
  const streaming = last !== undefined && last.kind === "assistant" && last.open;

  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const arrived = lastId !== lastSeen.current;
    lastSeen.current = lastId;
    if ((arrived || streaming) && following.current) element.scrollTop = element.scrollHeight;
  });

  const onScroll = () => {
    const element = box.current;
    if (element === null) return;
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX;
  };

  return (
    <div className="transcript" ref={box} onScroll={onScroll}>
      {entries.map((entry) => {
        switch (entry.kind) {
          case "user":
          case "assistant":
            return <Message key={entry.id} entry={entry} />;
          case "step":
            return <StepCard key={entry.id} entry={entry} />;
          case "notice":
            return (
              <div key={entry.id} className={`notice ${entry.level}`}>
                {entry.text}
              </div>
            );
        }
      })}
    </div>
  );
}
