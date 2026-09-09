import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/** A directory name that cannot surprise: lowercase, dashes, nothing else. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug === "" ? "spec" : slug;
}

function eventsPath(root: string, slug: string): string {
  return join(root, slug, "events.jsonl");
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
