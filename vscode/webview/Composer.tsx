import { useState, type KeyboardEvent } from "react";
import { WORDS } from "../src/words";
import { parseLine, post } from "./bridge";

/**
 * The textarea at the bottom. Enter posts the line (a message, or a
 * command when it starts with `/`) and clears the box; shift-enter is a
 * newline. While a question is open the box is disabled and says so —
 * enter never answers. While the core is busy the box stays open and the
 * badge counts what is queued behind the running turn.
 */
export function Composer({ asking, queued }: { asking: boolean; queued: number }) {
  const [text, setText] = useState("");

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const message = parseLine(text);
    if (message === null) return;
    post(message);
    setText("");
  };

  return (
    <div className="composer">
      <textarea
        className="composer-input"
        rows={3}
        value={text}
        disabled={asking}
        placeholder={asking ? WORDS.answerAbove : WORDS.composerPlaceholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {queued > 0 && (
        <span className="badge">
          {queued} {WORDS.queued}
        </span>
      )}
    </div>
  );
}
