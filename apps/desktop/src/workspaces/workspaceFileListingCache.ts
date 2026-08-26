import {
  activityPathsAffectWorkspaceListing,
  type ListWorkspaceFilesResult,
  type WorkspaceActivityEvent,
} from "../ipc/bridgeContract";

type ListingPromise = Promise<ListWorkspaceFilesResult>;

// Complete listings only. The cache never constructs a delta: callers either
// receive one previously completed/in-flight listing or run the whole owned
// workspace lister. Forced reads are the safe default because local file
// mutations refresh the explorer before the watcher can publish activity.
export class WorkspaceFileListingCache {
  readonly #listings = new Map<string, ListingPromise>();

  list(options: {
    workspaceId: string;
    allowCached: boolean;
    load: () => ListingPromise;
  }): ListingPromise {
    if (options.allowCached) {
      const cached = this.#listings.get(options.workspaceId);
      if (cached) return cached;
    }

    const listing = Promise.resolve().then(options.load);
    this.#listings.set(options.workspaceId, listing);
    void listing.catch(() => {
      if (this.#listings.get(options.workspaceId) === listing) {
        this.#listings.delete(options.workspaceId);
      }
    });
    return listing;
  }

  // Invalidate from the event the renderer actually receives. The broadcast
  // has already omitted empty, oversized, or truncated path sets, so every
  // pathless event takes the conservative full-refresh branch here too.
  invalidate(event: WorkspaceActivityEvent): void {
    if (!event.workspaceId) {
      this.#listings.clear();
      return;
    }
    if (
      !event.paths?.length ||
      activityPathsAffectWorkspaceListing(event.paths)
    ) {
      this.#listings.delete(event.workspaceId);
    }
  }
}
