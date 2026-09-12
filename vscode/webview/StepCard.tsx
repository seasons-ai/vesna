import { useState } from "react";
import type { Entry } from "../src/state";

type StepEntry = Extract<Entry, { kind: "step" }>;

/** How much of a step's input or output the card shows before cutting it with `…`. */
const CAP = 8 * 1024;

/**
 * One tool call. Collapsed it is a line — `nodeType · detail · Nms`; open
 * it shows the input as JSON and the output as text or JSON, each capped.
 * Whether it is open is the card's own, keyed by the entry's id through
 * React's `key` in the transcript.
 */
export function StepCard({ entry }: { entry: StepEntry }) {
  const [expanded, setExpanded] = useState(false);
  const { step, detail } = entry;
  const summary = [step.nodeType, detail, `${step.durationMs}ms`].filter((part) => part !== undefined).join(" · ");
  return (
    <div className={expanded ? "step expanded" : "step"}>
      <button type="button" className="step-summary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className="step-chevron" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        {summary}
      </button>
      {expanded && (
        <div className="step-body">
          <div className="step-label">input</div>
          <pre className="code">{clip(asJson(step.input))}</pre>
          <div className="step-label">output</div>
          <pre className="code">{clip(typeof step.output === "string" ? step.output : asJson(step.output))}</pre>
        </div>
      )}
    </div>
  );
}

function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function clip(text: string): string {
  return text.length > CAP ? `${text.slice(0, CAP)}…` : text;
}
