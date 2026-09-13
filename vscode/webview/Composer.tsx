import { useEffect, useState, type KeyboardEvent } from "react";
import { WORDS } from "../src/words";
import { completions, parseLine, post } from "./bridge";

/**
 * The textarea at the bottom. Enter posts the line (a message, or a
 * command when it starts with `/`) and clears the box; shift-enter is a
 * newline. While a question is open the box is disabled and says so —
 * enter never answers. While the core is busy the box stays open and the
 * badge counts what is queued behind the running turn.
 *
 * A line the host could not deliver comes back as `rejected` and is put
 * where it was, unless something new has been typed since. While the line
 * is a bare `/prefix`, the command names it could become are listed above
 * the box; Tab or a click completes the first (or the clicked) one.
 */
export function Composer({
  asking,
  queued,
  rejected,
}: {
  asking: boolean;
  queued: number;
  rejected: { text: string; seq: number } | null;
}) {
  const [text, setText] = useState("");

  useEffect(() => {
    if (rejected === null) return;
    setText((current) => (current === "" ? rejected.text : current));
  }, [rejected]);

  const options = completions(text);
  const complete = (name: string): void => setText(`/${name} `);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Tab" && options.length > 0 && !event.shiftKey) {
      event.preventDefault();
      complete(options[0]!);
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const message = parseLine(text);
    if (message === null) return;
    post(message);
    setText("");
  };

  return (
    <div className="composer">
      {options.length > 0 && !asking && (
        <ul className="completions" role="listbox">
          {options.map((name) => (
            <li key={name} role="option" aria-selected={name === options[0]}>
              <button type="button" className="completion" onMouseDown={(e) => e.preventDefault()} onClick={() => complete(name)}>
                /{name}
              </button>
            </li>
          ))}
        </ul>
      )}
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
