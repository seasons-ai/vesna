import { createHash } from "node:crypto";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "../providers/types";

/**
 * Conversations on disk.
 *
 * Until now a chat existed only in memory: `saveLiveTrace` ran on
 * `/crystallize` and nowhere else, so every conversation that did not end in a
 * flow — which is most of them — vanished when the terminal closed.
 *
 * Written as it happens rather than at exit, because the process can be
 * killed and an exit handler is not a place to be putting data. Kept under the
 * user's home rather than the repository: a conversation holds half-formed
 * thinking, local paths and sometimes someone else's code, and none of that
 * belongs in `git status`.
 */

export type SessionEvent =
  | { t: "user"; text: string }
  | { t: "answer"; raw: string }
  | { t: "step"; nodeType: string; durationMs: number; detail?: string }
  | { t: "notice"; text: string; tone: string }
  /** What the model itself saw, so resuming is the conversation and not a summary. */
  | { t: "messages"; added: AgentMessage[] }
  /** A mid-conversation `/provider` or `/model`: from here on, someone else answered. */
  | { t: "model"; model: string }
  | { t: "usage"; inputTokens: number; outputTokens: number; costUsd: number };

export interface SessionSummary {
  id: string;
  cwd: string;
  model: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  messages: number;
  costUsd: number;
}

export interface OpenSession {
  id: string;
  dir: string;
  append(event: SessionEvent): Promise<void>;
}

type Env = Record<string, string | undefined>;

export function sessionsRoot(env: Env, home: string): string {
  const base = env.VESNA_HOME !== undefined && env.VESNA_HOME !== "" ? env.VESNA_HOME : join(home, ".vesna");
  return join(base, "sessions");
}

/**
 * A stable directory name for a working directory. Hashed rather than escaped
 * so a path with slashes, spaces or non-ascii cannot produce a surprising name;
 * the readable path is kept in the summary.
 */
export function folderKey(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

/** How long a listing entry may be before it crowds out the columns beside it. */
const TITLE_LIMIT = 60;

export function titleOf(firstMessage: string): string {
  const line = firstMessage.split("\n").find((part) => part.trim() !== "")?.trim() ?? "";
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line;
}

function newId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function openSession(options: {
  root: string;
  cwd: string;
  model: string;
  now?: Date;
}): Promise<OpenSession> {
  const now = options.now ?? new Date();
  const id = newId(now);
  const dir = join(options.root, folderKey(options.cwd), id);
  await mkdir(dir, { recursive: true });

  const summary: SessionSummary = {
    id,
    cwd: options.cwd,
    model: options.model,
    title: "",
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    messages: 0,
    costUsd: 0,
  };

  const metaPath = join(dir, "meta.json");
  const eventsPath = join(dir, "events.jsonl");
  await writeFile(metaPath, JSON.stringify(summary, null, 2));

  return {
    id,
    dir,
    async append(event) {
      await appendFile(eventsPath, `${JSON.stringify(event)}\n`);

      // The summary is what the browser reads, so it is kept current rather
      // than recomputed by walking every conversation on every listing.
      if (event.t === "user") {
        summary.messages += 1;
        if (summary.title === "") summary.title = titleOf(event.text);
      }
      // The model recorded at `openSession` is the one the process started
      // with; a switch mid-conversation makes it wrong for everything after.
      if (event.t === "model") summary.model = event.model;
      if (event.t === "usage") summary.costUsd = event.costUsd;
      summary.updatedAt = new Date().toISOString();
      await writeFile(metaPath, JSON.stringify(summary, null, 2));
    },
  };
}

/**
 * Reading is synchronous on purpose.
 *
 * The panel is drawn inside a keypress, and an await there sat unresolved
 * until the next key arrived — the frame showed an empty list for as long as
 * the user did nothing. This is a walk over a few small files; doing it
 * synchronously costs microseconds and removes the whole question.
 */
export function listSessionsSync(root: string, options: { cwd?: string } = {}): SessionSummary[] {
  const folders = options.cwd === undefined ? subdirectories(root) : [folderKey(options.cwd)];

  const found: SessionSummary[] = [];
  for (const folder of folders) {
    const path = join(root, folder);
    for (const id of subdirectories(path)) {
      const summary = readSummary(join(path, id));
      // A session with nothing said in it is a started terminal, not history.
      if (summary !== null && summary.messages > 0) found.push(summary);
    }
  }

  return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listSessions(
  root: string,
  options: { cwd?: string } = {},
): Promise<SessionSummary[]> {
  return listSessionsSync(root, options);
}

export function readSessionSync(
  root: string,
  id: string,
): { summary: SessionSummary; events: SessionEvent[] } | null {
  const dir = locate(root, id);
  if (dir === null) return null;

  const summary = readSummary(dir);
  if (summary === null) return null;

  let text: string;
  try {
    text = readFileSync(join(dir, "events.jsonl"), "utf8");
  } catch {
    text = "";
  }

  const events: SessionEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // One torn line — a process killed mid-write — must not cost the rest.
    }
  }
  return { summary, events };
}

export async function readSession(
  root: string,
  id: string,
): Promise<{ summary: SessionSummary; events: SessionEvent[] } | null> {
  return readSessionSync(root, id);
}

export async function deleteSession(root: string, id: string): Promise<void> {
  const dir = locate(root, id);
  if (dir === null) return;
  // Removed, not marked: these hold words the user may not want kept.
  await rm(dir, { recursive: true, force: true });
}

function locate(root: string, id: string): string | null {
  for (const folder of subdirectories(root)) {
    const candidate = join(root, folder, id);
    if (readSummary(candidate) !== null) return candidate;
  }
  return null;
}

function readSummary(dir: string): SessionSummary | null {
  try {
    return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

function subdirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
