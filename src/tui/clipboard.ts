/**
 * Getting text out of the terminal and into the system clipboard.
 *
 * Two mechanisms, because neither covers everything. A local session has a
 * clipboard binary; a session over ssh does not, and there the terminal itself
 * can be asked with OSC 52 — the escape sequence travels the connection where
 * a subprocess on the far end would only reach the far machine's clipboard.
 */

type Env = Record<string, string | undefined>;

/**
 * The most an OSC 52 payload may be. Terminals cut the sequence off well
 * before this, and a silently truncated paste is worse than a refusal.
 */
const OSC52_LIMIT = 100_000;

export interface CopyIo {
  platform: string;
  env: Env;
  /** Runs the command with `input` on stdin; true when it succeeded. */
  run(argv: string[], input: string): Promise<boolean>;
  write(text: string): void;
}

export type CopyResult = "command" | "osc52" | "empty" | "too-large";

export function clipboardCommand(platform: string, env: Env): string[] | undefined {
  if (platform === "darwin") return ["pbcopy"];
  if (platform === "win32") return ["clip.exe"];
  if (platform === "linux") {
    if (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY !== "") return ["wl-copy"];
    if (env.DISPLAY !== undefined && env.DISPLAY !== "") {
      return ["xclip", "-selection", "clipboard"];
    }
  }
  return undefined;
}

/** Asks the terminal itself to set the clipboard. Works across ssh. */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

export async function copyToClipboard(text: string, io: CopyIo): Promise<CopyResult> {
  // Copying whitespace would wipe whatever the user already had.
  if (text.trim() === "") return "empty";

  const argv = clipboardCommand(io.platform, io.env);
  if (argv !== undefined) {
    try {
      if (await io.run(argv, text)) return "command";
    } catch {
      // The binary may simply not be installed; the escape sequence is next.
    }
  }

  const sequence = osc52(text);
  if (sequence.length > OSC52_LIMIT) return "too-large";
  io.write(sequence);
  return "osc52";
}

/** The real thing: a subprocess, and stdout for the escape sequence. */
export function systemCopyIo(): CopyIo {
  return {
    platform: process.platform,
    env: process.env,
    async run(argv, input) {
      const child = Bun.spawn(argv, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      child.stdin.write(input);
      await child.stdin.end();
      return (await child.exited) === 0;
    },
    write: (text) => void process.stdout.write(text),
  };
}
