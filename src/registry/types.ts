export type EffectClass = "pure" | "write" | "external";

export interface NodeContext {
  cwd: string;
  signal: AbortSignal;
}

export interface NodeDef<I = any, O = any> {
  type: string;
  effect: EffectClass;
  run(input: I, ctx: NodeContext): Promise<O>;
}

export interface Registry {
  register(def: NodeDef): void;
  get(type: string): NodeDef | undefined;
  list(): string[];
}
