import type { NodeDef } from "../registry/types";
import type { Shape } from "../spec/project";
import type { SpecSink } from "../spec/sink";

/**
 * What shape of work a request is.
 *
 * Not every request is a project. A spike ends in an answer and keeps no
 * code. A bounded change is designed in the conversation and built without a
 * spec file. An architectural change goes through every phase. The agent says
 * which it sees, out loud and on the record, so the person can overrule it
 * before any ceremony is spent — or skipped.
 */
export const SHAPES: readonly Shape[] = ["spike", "bounded", "architectural"];

export interface ClassifyInput {
  shape: Shape;
  /** Names the spec when none is open. Ignored for a spike. */
  title?: string;
  /** One sentence. Shown to the person, who may disagree. */
  why: string;
}

export function createClassifyNode(
  sink: SpecSink,
): NodeDef<ClassifyInput, { shape: Shape; spec: string }> {
  return {
    type: "classify",
    description:
      "Say what shape of work the request is, before doing any of it: spike (an answer, no code kept), bounded (a change to a flow that already exists, designed in chat), or architectural (a new subsystem — spec, plan, and build). When in doubt choose the heavier shape and say so. The person can overrule you.",
    inputSchema: {
      type: "object",
      properties: {
        shape: { type: "string", enum: [...SHAPES] },
        title: { type: "string", description: "A short name for the work, used to open a spec." },
        why: { type: "string", description: "One sentence on why this shape." },
      },
      required: ["shape", "why"],
    },
    effect: "pure",
    async run(input) {
      if (!SHAPES.includes(input.shape)) {
        throw new Error(`unknown shape "${input.shape}" — one of ${SHAPES.join(", ")}`);
      }
      // A spike is not tracked: nothing it produces is kept, so a spec for
      // it would be a folder with nothing in it.
      if (input.shape === "spike") return { shape: input.shape, spec: "" };

      const slug = sink.ensure(input.title ?? "untitled work");
      sink.emit({ t: "classified", shape: input.shape, by: "agent" });
      return { shape: input.shape, spec: slug };
    },
  };
}
