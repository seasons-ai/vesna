import { createInterface } from "node:readline/promises";
import type { PromptIO } from "./prompt";

export interface StdioPrompt extends PromptIO {
  close(): void;
}

/** True when a human is actually there to answer. Scripts and CI are not. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function createStdioPrompt(): StdioPrompt {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    write(text) {
      console.log(text);
    },
    async question(prompt) {
      return rl.question(prompt);
    },
    close() {
      rl.close();
    },
  };
}
