export type Assertion =
  | { non_empty: string }
  | { has_keys: { value: string; keys: string[] } }
  | { not_matches: { value: string; pattern: string } }
  | { contains: { value: string; needle: string } };

export interface AssertionOutcome {
  passed: boolean;
  assertion: Assertion;
  detail: string;
}
