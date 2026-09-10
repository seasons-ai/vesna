import type { NodeDef } from "../registry/types";
import type { SpecSink } from "../spec/sink";
import type { Stage } from "../spec/project";
import { STAGES } from "../spec/project";
import { spawnInterruptible } from "./spawn";

/**
 * How the agent fills in the garden.
 *
 * It may declare a plan and say which task it has picked up. It may not say a
 * task is finished: "I finished T2" is a claim, and a claim is not a fact. To
 * finish something it hands Vesna a command, and Vesna runs it and reads the
 * exit status. The evidence is produced by the system rather than asserted by
 * the party being checked, which is the whole difference between a progress
 * bar and a guarantee.
 */

export interface PlanInput {
  /** What this piece of work is called. Names the spec when there is none yet. */
  title?: string;
  stage?: string;
  criteria?: { id: string; text: string }[];
  tasks?: { id: string; title: string; dependsOn?: string[] }[];
}

export function createPlanNodes(sink: SpecSink): NodeDef[] {
  const plan: NodeDef<PlanInput, { recorded: number; spec: string; opened: boolean }> = {
    type: "plan",
    description:
      "Record the plan for the work in hand: the stage you are entering, the acceptance criteria, and the tasks. Declaring a task does not start or finish it.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "A short name for this piece of work. Used to open a spec if none is open yet.",
        },
        stage: {
          type: "string",
          enum: [...STAGES],
          description: "The stage being entered.",
        },
        criteria: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, text: { type: "string" } },
            required: ["id", "text"],
          },
        },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              dependsOn: { type: "array", items: { type: "string" } },
            },
            required: ["id", "title"],
          },
        },
      },
    },
    effect: "pure",
    async run(input) {
      // Planning opens a spec when there is none. Refusing here made the whole
      // panel unreachable to anyone who had not already read the source.
      const title = input.title ?? input.tasks?.[0]?.title ?? "untitled work";
      const slug = sink.ensure(title);

      let recorded = 0;
      const named = (STAGES as readonly string[]).includes(input.stage ?? "")
        ? (input.stage as Stage)
        : undefined;
      // Recording tasks is entering the build stage. Making the model say so
      // separately means a plan that forgets shows a count and no tasks.
      const stage = named ?? ((input.tasks?.length ?? 0) > 0 ? "build" : undefined);
      if (stage !== undefined) {
        sink.emit({ t: "stage.entered", stage });
        recorded += 1;
      }
      for (const criterion of input.criteria ?? []) {
        sink.emit({ t: "criterion.added", id: criterion.id, text: criterion.text });
        recorded += 1;
      }
      for (const task of input.tasks ?? []) {
        sink.emit({
          t: "task.added",
          id: task.id,
          title: task.title,
          ...(task.dependsOn ? { dependsOn: task.dependsOn } : {}),
        });
        recorded += 1;
      }
      return { recorded, spec: slug, opened: sink.created };
    },
  };

  const start: NodeDef<{ id: string }, { started: string }> = {
    type: "task_start",
    description: "Say which task you are working on now, so the user can see where you are.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    effect: "pure",
    async run(input) {
      if (!sink.open) throw new Error("record a plan first, with the plan tool");
      sink.emit({ t: "task.started", id: input.id });
      return { started: input.id };
    },
  };

  const verify: NodeDef<
    { id: string; check: string },
    { passed: boolean; evidence: string; output: string }
  > = {
    type: "task_verify",
    description:
      "Finish a task by proving it. Give a command that fails when the work is not done — a test, a typecheck. Vesna runs it and records the result. There is no way to mark a task done without this.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        check: { type: "string", description: "A shell command that exits non-zero on failure." },
      },
      required: ["id", "check"],
    },
    effect: "write",
    async run(input, ctx) {
      if (!sink.open) throw new Error("record a plan first, with the plan tool");

      const result = await spawnInterruptible(["/bin/sh", "-c", input.check], {
        cwd: ctx.cwd,
        signal: ctx.signal,
      });

      const output = `${result.stdout}${result.stderr}`.trim().split("\n").slice(-20).join("\n");

      if (result.code === 0) {
        sink.emit({ t: "task.done", id: input.id });
        sink.emit({ t: "criterion.met", id: input.id, evidence: input.check });
        return { passed: true, evidence: input.check, output };
      }

      // A failing check is not an error in the tool: it is the answer, and the
      // model needs to see it to fix the work rather than retry the claim.
      sink.emit({ t: "task.failed", id: input.id, reason: `${input.check} exited ${result.code}` });
      return { passed: false, evidence: input.check, output };
    },
  };

  return [plan, start, verify] as NodeDef[];
}
