export type Scope = Record<string, unknown>;

/** Matches a `${inputs.client}` placeholder inside a larger string. */
const TEMPLATE = /\$\{([^}]+)\}/g;

export class RefError extends Error {
  constructor(ref: string) {
    super(`cannot resolve reference: ${ref}`);
    this.name = "RefError";
  }
}

/** A whole-value reference: the value *is* the reference, so its type survives. */
export function isRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("$.");
}

/** A string with placeholders embedded in it. The result is always a string. */
export function isTemplate(value: unknown): value is string {
  return typeof value === "string" && TEMPLATE.test(resetLastIndex(value));
}

function resetLastIndex(value: string): string {
  TEMPLATE.lastIndex = 0;
  return value;
}

function readPath(path: string, scope: Scope, original: string): unknown {
  let current: unknown = scope;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") throw new RefError(original);
    if (!(segment in (current as Record<string, unknown>))) throw new RefError(original);
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function resolveRef(ref: string, scope: Scope): unknown {
  return readPath(ref.slice(2), scope, ref);
}

export function resolveTemplate(template: string, scope: Scope): string {
  return resetLastIndex(template).replace(TEMPLATE, (_match, path: string) =>
    String(readPath(path.trim(), scope, template)),
  );
}

export function resolveInput(
  input: Record<string, unknown>,
  scope: Scope,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isRef(value)) out[key] = resolveRef(value, scope);
    else if (isTemplate(value)) out[key] = resolveTemplate(value, scope);
    else out[key] = value;
  }
  return out;
}

function headOf(path: string): string | undefined {
  return path.trim().split(".")[0];
}

/**
 * Node ids an input depends on. Templates count too — otherwise a node reading
 * `out/${parse.name}.md` would be scheduled before `parse` had run.
 */
export function refDependencies(input: Record<string, unknown>): string[] {
  const deps = new Set<string>();

  const add = (path: string | undefined) => {
    if (path && path !== "inputs") deps.add(path);
  };

  for (const value of Object.values(input)) {
    if (isRef(value)) {
      add(headOf(value.slice(2)));
      continue;
    }
    if (typeof value !== "string") continue;
    for (const match of resetLastIndex(value).matchAll(TEMPLATE)) {
      add(headOf(match[1]!));
    }
  }
  return [...deps];
}
