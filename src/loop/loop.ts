import type { Provider } from "../providers/types";
import type { Registry } from "../registry/types";
import { createSession, type SessionOptions } from "./session";
import type { LiveTrace } from "./trace";

export type LiveOptions = SessionOptions;

/**
 * One prompt, run to completion. A thin wrapper over a session so there is a
 * single agent loop: `vesna do` is simply a conversation with one message.
 */
export async function runLive(
  prompt: string,
  provider: Provider,
  registry: Registry,
  options: LiveOptions,
): Promise<LiveTrace> {
  const session = createSession(provider, registry, options);
  await session.send(prompt);
  return session.toTrace();
}
