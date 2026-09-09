import { appendEvent } from "./store";
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
}

export function createSink(root: string): SpecSink {
  return {
    slug: null,
    get open() {
      return this.slug !== null;
    },
    emit(event) {
      if (this.slug === null) return;
      appendEvent(root, this.slug, event);
    },
  };
}
