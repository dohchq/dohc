import {
  activityPathsAffectWorkspaceListing,
  type ListWorkspaceFilesResult,
  type WorkspaceActivityEvent,
} from "../ipc/bridgeContract";

type ListingPromise = Promise<ListWorkspaceFilesResult>;
interface ListingEntry {
  attachmentId: symbol;
  listing: ListingPromise;
  settled: boolean;
}

// Complete listings only. The cache never constructs a delta: callers either
// receive one previously completed/in-flight listing or run the whole owned
// workspace lister. Forced reads are the safe default because local file
// mutations refresh the explorer before the watcher can publish activity.
export class WorkspaceFileListingCache {
  readonly #listings = new Map<string, ListingEntry>();

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  list(options: {
    workspaceId: string;
    attachmentId: symbol;
    allowCached: boolean;
    load: () => ListingPromise;
  }): ListingPromise {
    if (options.allowCached) {
      const cached = this.#listings.get(options.workspaceId);
      if (cached?.attachmentId === options.attachmentId) {
        // Do not store the marker in the cached snapshot: it describes this
        // read, not the listing. An in-flight reuse is still the current walk,
        // so it stays unmarked and does not cause a redundant revalidation.
        return cached.settled
          ? cached.listing.then((listing) => ({ ...listing, cached: true }))
          : cached.listing;
      }
    }

    const listing = Promise.resolve().then(options.load);
    const entry = {
      attachmentId: options.attachmentId,
      listing,
      settled: false,
    };
    this.#listings.set(options.workspaceId, entry);
    void listing.then(
      () => {
        entry.settled = true;
      },
      () => {
        if (this.#listings.get(options.workspaceId) === entry) {
          this.#listings.delete(options.workspaceId);
        }
      },
    );
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
      activityPathsAffectWorkspaceListing(event.paths, this.platform)
    ) {
      this.#listings.delete(event.workspaceId);
    }
  }
}
