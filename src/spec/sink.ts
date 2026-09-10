import { appendEvent, createSpec, readSpec, slugify } from "./store";
import type { SpecEvent } from "./project";

/**
 * Where plan events go.
 *
 * The nodes are registered once, at startup, while the spec they write to
 * changes as the user opens one. So they hold this rather than a slug: one
 * small mutable seam, named for what it is, instead of rebuilding the registry
 * every time somebody switches specs.
 *
 * With no spec open the events are dropped. Declaring a plan outside a spec is
 * not an error worth stopping a conversation for — there is simply nowhere to
 * put it.
 */
export interface SpecSink {
  /** The spec currently open, or null. */
  slug: string | null;
  emit(event: SpecEvent): void;
  /** True when there is somewhere to write, for a node that wants to say so. */
  readonly open: boolean;
  /**
   * Opens a spec for this work, making one if there is none.
   *
   * Requiring `/spec new` before a plan could be recorded made the panel
   * unreachable by anyone who had not read the source: they asked for work,
   * nothing appeared, and there was no hint of what was missing. Making one
   * here is not doing it silently — the conversation says so, and a whole
   * column appears.
   */
  ensure(title: string): string;
  /** True when the last `ensure` had to make one. */
  readonly created: boolean;
}

export function createSink(root: string): SpecSink {
  let justCreated = false;

  return {
    slug: null,
    get created() {
      return justCreated;
    },

    ensure(title) {
      justCreated = false;
      if (this.slug !== null) return this.slug;

      const slug = slugify(title);
      // An existing spec of the same name is continued rather than refused:
      // the user asking twice for the same work means one piece of work.
      if (readSpec(root, slug) === null) {
        createSpec(root, title);
        justCreated = true;
      }
      this.slug = slug;
      return slug;
    },

    get open() {
      return this.slug !== null;
    },
    emit(event) {
      if (this.slug === null) return;
      appendEvent(root, this.slug, event);
    },
  };
}
