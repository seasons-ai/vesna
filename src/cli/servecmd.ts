import { homedir } from "node:os";
import { createCore } from "../core/core";
import { serve } from "../serve/server";
import { openSession, sessionsRoot, type OpenSession } from "../store/sessions";
import { buildContext } from "./context";
import { VERSION } from "./entry";
import { EXIT } from "./exit";

/**
 * `vesna serve`: the agent behind JSON-RPC on stdin/stdout, for an editor.
 *
 * stdout carries frames and nothing else — no banner, no log line — so every
 * startup problem is reported by `main.ts` on stderr before this runs, and
 * anything `buildContext` throws leaves through `bin/vesna` the same way.
 * The core gets what the TUI's gets: the conversation is recorded under the
 * sessions root, so `/history` and `/resume` mean the same over a pipe.
 */
export async function serveCommand(root: string): Promise<number> {
  const { registry, config, provider, notes, policy, sink } = await buildContext(root);
  const sessions = sessionsRoot(process.env, homedir());
  let record: OpenSession | undefined;
  try {
    record = await openSession({ root: sessions, cwd: root, model: config.model });
  } catch {
    // A home that cannot be written to is no reason to refuse the conversation.
    record = undefined;
  }
  const core = createCore({
    registry, provider, config, root, notes, policy, sink,
    ...(record ? { record } : {}),
    sessionsRoot: sessions,
  });

  let code: number = EXIT.ok;
  await serve(
    core,
    {
      input: Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>,
      write: (bytes) => void process.stdout.write(bytes),
      exit: (c) => {
        code = c;
        process.exitCode = c;
        // Frames written to a pipe may still be in flight; leave once they are out.
        process.stdout.write("", () => process.exit(c));
      },
    },
    { serverVersion: VERSION },
  );
  return code;
}
