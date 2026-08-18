import { isRef, resolveRef, type Scope } from "../expr/resolve";
import type { Assertion, AssertionOutcome } from "./types";

export type { Assertion, AssertionOutcome } from "./types";

function read(ref: string, scope: Scope): unknown {
  return resolveRef(ref, scope);
}

function maybeRef(value: string, scope: Scope): unknown {
  return isRef(value) ? resolveRef(value, scope) : value;
}

function evaluateOne(assertion: Assertion, scope: Scope): AssertionOutcome {
  try {
    if ("non_empty" in assertion) {
      const value = read(assertion.non_empty, scope);
      const passed = Array.isArray(value)
        ? value.length > 0
        : typeof value === "string"
          ? value.length > 0
          : value !== null && value !== undefined;
      return { passed, assertion, detail: passed ? "non-empty" : "value is empty" };
    }

    if ("has_keys" in assertion) {
      const value = read(assertion.has_keys.value, scope);
      const items = Array.isArray(value) ? value : [value];
      const missing = new Set<string>();
      for (const item of items) {
        for (const key of assertion.has_keys.keys) {
          if (item === null || typeof item !== "object" || !(key in item)) missing.add(key);
        }
      }
      const passed = missing.size === 0;
      return {
        passed,
        assertion,
        detail: passed ? "all keys present" : `missing keys: ${[...missing].join(", ")}`,
      };
    }

    if ("not_matches" in assertion) {
      const value = String(read(assertion.not_matches.value, scope));
      const matched = new RegExp(assertion.not_matches.pattern).test(value);
      return {
        passed: !matched,
        assertion,
        detail: matched
          ? `matched forbidden pattern ${assertion.not_matches.pattern}`
          : "no forbidden match",
      };
    }

    const haystack = String(read(assertion.contains.value, scope));
    const needle = String(maybeRef(assertion.contains.needle, scope));
    const passed = haystack.includes(needle);
    return { passed, assertion, detail: passed ? "needle present" : `missing substring: ${needle}` };
  } catch (error) {
    return { passed: false, assertion, detail: (error as Error).message };
  }
}

export function evaluateAssertions(assertions: Assertion[], scope: Scope): AssertionOutcome[] {
  return assertions.map((assertion) => evaluateOne(assertion, scope));
}
