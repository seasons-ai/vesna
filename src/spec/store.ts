import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { project, type SpecEvent, type SpecTree } from "./project";

/**
 * Specs on disk, in the project rather than the home directory.
 *
 * A spec describes work on this repository: it belongs beside the code, can be
 * reviewed with it, and is worth committing. That is the opposite of a
 * conversation, which is personal and lives under the user's home.
 *
 * Synchronous throughout, for the reason the session store is: this is read
 * while a frame is being drawn, and an await inside a keypress does not
 * resolve until the next key arrives.
 */

export interface SpecSummary {
  slug: string;
  title: string;
}

export function specsRoot(projectRoot: string): string {
  return join(projectRoot, ".vesna", "specs");
}

/**
 * A directory name that cannot surprise: lowercase, dashes, nothing else.
 *
 * A name in another script loses almost everything to that rule — two Russian
 * titles sharing one latin word both became that word, and the second silently
 * continued the first one's spec. So anything that did not survive intact is
 * given a short digest of the whole name, which keeps different names apart
 * and keeps the same name stable across sessions.
 */
export function slugify(name: string): string {
  const kept = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  // Punctuation is not meaning, so losing it costs nothing. Losing letters is
  // what makes two different names into the same directory.
  const meaningful = name.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  const latin = name.match(/[A-Za-z0-9]/g)?.length ?? 0;
  if (latin === meaningful) return kept === "" ? "spec" : kept;

  const digest = createHash("sha256").update(name).digest("hex").slice(0, 6);
  return kept === "" ? `spec-${digest}` : `${kept}-${digest}`;
}

/**
 * Where a spec's files are. The folder is the process's workspace: the log,
 * the design, the plan, one brief per task, the workers' reports and the
 * reviews, all committed beside the code they describe. The hidden directory
 * that held these before was destroyed by a cleanup step at least once.
 */
export interface SpecPaths {
  dir: string;
  events: string;
  spec: string;
  plan: string;
  briefs: string;
  reports: string;
  reviews: string;
}

export function specPaths(root: string, slug: string): SpecPaths {
  const dir = join(root, slug);
  return {
    dir,
    events: join(dir, "events.jsonl"),
    spec: join(dir, "spec.md"),
    plan: join(dir, "plan.md"),
    briefs: join(dir, "briefs"),
    reports: join(dir, "reports"),
    reviews: join(dir, "reviews"),
  };
}

export function writeSpecFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function readSpecFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function eventsPath(root: string, slug: string): string {
  return specPaths(root, slug).events;
}

export function createSpec(root: string, name: string): SpecSummary {
  const slug = slugify(name);
  mkdirSync(join(root, slug), { recursive: true });

  const path = eventsPath(root, slug);
  // Refuse to start a second history in the same folder: the log is the spec,
  // and two beginnings in one file cannot be told apart afterwards.
  if (readEvents(root, slug).length > 0) {
    throw new Error(`a spec called "${slug}" already exists — /spec open ${slug}`);
  }

  writeFileSync(path, "");
  appendEvent(root, slug, { t: "created", id: slug, title: name });
  return { slug, title: name };
}

export function appendEvent(root: string, slug: string, event: SpecEvent): void {
  mkdirSync(join(root, slug), { recursive: true });
  appendFileSync(eventsPath(root, slug), `${JSON.stringify(event)}\n`);
}

export function readEvents(root: string, slug: string): SpecEvent[] {
  let text: string;
  try {
    text = readFileSync(eventsPath(root, slug), "utf8");
  } catch {
    return [];
  }

  const events: SpecEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A torn line costs its own event and no others.
    }
  }
  return events;
}

export function readSpec(root: string, slug: string): SpecTree | null {
  return project(readEvents(root, slug));
}

/** sha256 hex of the file's bytes; null when there is no such file. */
export function digestOf(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

export function listSpecs(root: string): SpecSummary[] {
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const found: SpecSummary[] = [];
  for (const slug of names.sort()) {
    const tree = readSpec(root, slug);
    if (tree !== null) found.push({ slug, title: tree.title });
  }
  return found;
}
