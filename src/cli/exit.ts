/**
 * Exit codes are part of the contract: a wrapper script must be able to tell
 * "everything ran" from "some rows are held" from "it broke".
 */
export const EXIT = {
  ok: 0,
  /** Ran, but something the user asked for was left undone. */
  held: 1,
  /** Did not run: bad usage, missing credentials, crash. */
  error: 2,
} as const;

export interface Explained {
  message: string;
  hint?: string;
}

export function explainError(error: unknown): Explained {
  if (typeof error === "string") return { message: error };
  if (!(error instanceof Error)) return { message: String(error) };

  if (/authentication method|x-api-key|401/i.test(error.message)) {
    return {
      message: "No model credentials found.",
      hint: "set ANTHROPIC_API_KEY in the environment, or run `ant auth login`",
    };
  }

  if (error.message.startsWith("ENOENT")) {
    const path = error.message.match(/'([^']+)'/)?.[1];
    return {
      message: path ? `File not found: ${path}` : error.message,
      hint: "check the path is relative to the directory you ran vesna from",
    };
  }

  return { message: error.message };
}
