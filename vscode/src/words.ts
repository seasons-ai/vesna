import type { Mode } from "./protocol";

/**
 * Every word a person can see in the extension, in one place, so a change to
 * what it says is a change to this file and nothing else.
 */
export const WORDS = {
  allowOnce: "Allow once",
  always: "Always",
  refuse: "Refuse",
  approve: "Approve",
  notYet: "Not yet",
  stop: "Stop",
  restart: "Restart",
  queued: "queued",
  answerAbove: "answer the question above",
  composerPlaceholder: "Message Vesna, or /command",
  noFolder: "Open a folder to start Vesna.",
  multiRoot: (name: string) => `Several folders are open; Vesna runs in ${name}.`,
  notFound: (command: string) => `${command} was not found on PATH.`,
  installHint: "npm i -g @seasons-ai/vesna",
  exited: (code: number | null) => `Vesna exited${code === null ? "" : ` with code ${code}`}.`,
  tooOld: (server: string, extension: string) =>
    `This Vesna (${server}) is too old for this extension (${extension}).`,
  statusMode: (mode: string) => `vesna: ${mode}`,
  statusBuilding: (task: string | null) => `vesna: building${task === null ? "" : ` ${task}`}`,
  statusNone: "vesna",
  newSpecPrompt: "Title of the new spec",
  openSpecPrompt: "Which spec to open",
  noSpecs: "No specs yet — Vesna: New Spec makes one.",
  noSpecOpen: "No spec is open.",
  notRunning: "Vesna is not running — Restart it from the panel.",
} as const;

export const NEXT_MODE: Record<Mode, Mode> = { plan: "ask", ask: "auto", auto: "plan" };

export const COMMAND_NAMES = [
  "cost",
  "mode",
  "spec",
  "classify",
  "approve",
  "build",
  "chats",
  "history",
  "resume",
  "clear",
  "provider",
  "model",
  "help",
] as const;
