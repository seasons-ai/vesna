export type Scope = Record<string, unknown>;

export class RefError extends Error {
  constructor(ref: string) {
    super(`cannot resolve reference: ${ref}`);
    this.name = "RefError";
  }
}

export function isRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("$.");
}

export function resolveRef(ref: string, scope: Scope): unknown {
  const segments = ref.slice(2).split(".");
  let current: unknown = scope;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") throw new RefError(ref);
    if (!(segment in (current as Record<string, unknown>))) throw new RefError(ref);
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function resolveInput(
  input: Record<string, unknown>,
  scope: Scope,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = isRef(value) ? resolveRef(value, scope) : value;
  }
  return out;
}

export function refDependencies(input: Record<string, unknown>): string[] {
  const deps = new Set<string>();
  for (const value of Object.values(input)) {
    if (!isRef(value)) continue;
    const head = value.slice(2).split(".")[0];
    if (head && head !== "inputs") deps.add(head);
  }
  return [...deps];
}
