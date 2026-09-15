import type { SessionOptions } from "../loop/session";
import { decide, type Policy } from "../policy/decide";
import { policyRefusal, wouldAsk } from "./chatcmd";

/**
 * The policy for `vesna do`, where nobody is at the keyboard.
 *
 * The same `decide` the chat runs, with one difference: what the chat would
 * put to a person is refused here, and the line says where the question can
 * be answered. The model reads the same words as its tool result, so it
 * knows the refusal is the surface's and not the user's.
 */
export function unattendedApprove(
  policy: Policy,
  root: string,
  report: (line: string) => void,
): NonNullable<SessionOptions["approve"]> {
  return async (action) => {
    const verdict = decide(action, policy, root);
    if (verdict === "allow") return "allow";
    const reason = verdict === "deny" ? policyRefusal(action.node, policy.mode) : wouldAsk(action.node);
    report(reason);
    return { verdict: "deny", reason };
  };
}
