import { useState } from "react";
import type { Ask, AskChoice, AskKind } from "../src/protocol";
import { WORDS } from "../src/words";
import { post } from "./bridge";

const LABELS: Record<AskKind, Record<AskChoice, string>> = {
  permission: { y: WORDS.allowOnce, a: WORDS.always, n: WORDS.refuse },
  approval: { y: WORDS.approve, a: WORDS.always, n: WORDS.notYet },
};

/**
 * The open question: its lines as text, one button per choice it offers.
 * A click posts the answer and greys the buttons; the block itself goes
 * only when the host's model no longer carries the ask.
 */
export function AskBlock({ ask }: { ask: Ask }) {
  const [answered, setAnswered] = useState(false);
  const answer = (choice: AskChoice) => {
    setAnswered(true);
    post({ kind: "answer", id: ask.id, value: choice });
  };
  return (
    <div className="ask">
      <div className="ask-lines">
        {ask.lines.map((line, index) => (
          <div key={index}>{line}</div>
        ))}
      </div>
      <div className="ask-buttons">
        {ask.choices.map((choice) => (
          <button
            key={choice}
            type="button"
            className={choice === "n" ? "button secondary" : "button"}
            disabled={answered}
            onClick={() => answer(choice)}
          >
            {LABELS[ask.kind][choice]}
          </button>
        ))}
      </div>
    </div>
  );
}
