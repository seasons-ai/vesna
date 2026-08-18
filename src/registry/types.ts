export type EffectClass = "pure" | "write" | "external";

export interface NodeContext {
  cwd: string;
  signal: AbortSignal;
}

export interface NodeDef<I = any, O = any> {
  type: string;
  effect: EffectClass;
  /** What the node does, written for the model that decides whether to call it. */
  description: string;
  /** JSON Schema for `run`'s input. This is what the agent sees as the tool schema. */
  inputSchema: Record<string, unknown>;
  run(input: I, ctx: NodeContext): Promise<O>;
}

export interface Registry {
  register(def: NodeDef): void;
  get(type: string): NodeDef | undefined;
  list(): string[];
}
