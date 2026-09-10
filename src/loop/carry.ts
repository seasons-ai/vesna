import type { AgentMessage, ContentBlock } from "../providers/types";

/**
 * History, moved to a different provider.
 *
 * Almost nothing has to happen here, and that is worth stating: ContentBlock is
 * Vesna's own shape, providers translate at the edge, tool-call identifiers are
 * opaque strings everywhere, and reasoning never enters history because there
 * is no such block. So a conversation crosses intact.
 *
 * One thing genuinely cannot cross. A tool call with no result after it — what
 * an interrupt in the middle of a tool leaves behind — is rejected by both
 * APIs. Those are dropped, and only those, and the caller is told how many so
 * it can say so rather than pretend the transcript is whole.
 */
export interface Carried {
  messages: AgentMessage[];
  dropped: number;
}

export function carryHistory(messages: AgentMessage[]): Carried {
  const answered = new Set<string>();
  const called = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_result") answered.add(block.callId);
      if (block.type === "tool_call") called.add(block.id);
    }
  }

  let dropped = 0;
  const kept: AgentMessage[] = [];

  for (const message of messages) {
    const content = message.content.filter((block: ContentBlock) => {
      if (block.type === "tool_call" && !answered.has(block.id)) {
        dropped += 1;
        return false;
      }
      if (block.type === "tool_result" && !called.has(block.callId)) {
        dropped += 1;
        return false;
      }
      return true;
    });

    // A message emptied by the filter would be sent as a blank turn, which is
    // its own kind of malformed.
    if (content.length > 0) kept.push({ role: message.role, content });
  }

  return { messages: kept, dropped };
}
