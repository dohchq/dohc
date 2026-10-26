import {
  activityPathsAffectWorkspaceListing,
  isWorkspaceVisibilityPolicyPath,
  type WorkspacePathListing,
  type WorkspaceActivityEvent,
} from "../ipc/bridgeContract";
import type { FileObservationFact } from "@dohc/workspace-engine-client/daemon";
import type { WorkspaceFileListingEntry } from "./workspaceFiles";

type ListingPromise = Promise<WorkspacePathListing>;
interface ListingEntry {
  attachmentId: symbol;
  listing: ListingPromise;
  settled: boolean;
  files: Map<string, WorkspaceFileListingEntry>;
  changed: Set<string>;
  refreshing?: ListingPromise;
}

// Complete listings only. The cache never constructs a delta: callers either
// receive one previously completed/in-flight listing or run the whole owned
// workspace lister. Content facts retain the path set and update its identity.
export class WorkspaceFileListingCache {
  readonly #listings = new Map<string, ListingEntry>();

  constructor(private readonly platform: NodeJS.Platform = process.platform,
    private readonly refreshContent?: (workspaceId: string, attachmentId: symbol, paths: readonly string[]) => Promise<readonly WorkspaceFileListingEntry[]>) {}
  private revision = 0;

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
          ? this.refresh(options.workspaceId, cached).then((listing) => ({ ...listing, cached: true }))
          : cached.listing;
      }
    }

    const entry: ListingEntry = {
      attachmentId: options.attachmentId,
      listing: Promise.resolve({ files: [], folders: [] }),
      settled: false,
      files: new Map<string, WorkspaceFileListingEntry>(),
      changed: new Set<string>(),
    };
    const listing = Promise.resolve().then(options.load).then(async result => {
        for (let offset = 0; offset < result.files.length; offset += 128) {
          for (const file of result.files.slice(offset, offset + 128)) entry.files.set(file.path, file);
          if (offset + 128 < result.files.length) await new Promise<void>(resolve => setImmediate(resolve));
        }
        for (const path of entry.changed) {
          const file = entry.files.get(path);
          if (file) file.contentIdentity = `observation:${++this.revision}`;
        }
        entry.settled = true;
        return result;
      }).catch(error => {
        if (this.#listings.get(options.workspaceId) === entry) {
          this.#listings.delete(options.workspaceId);
        }
        throw error;
      });
    entry.listing = listing;
    this.#listings.set(options.workspaceId, entry);
    return listing;
  }

  private refresh(workspaceId: string, entry: ListingEntry): ListingPromise {
    if (entry.refreshing) return entry.refreshing.then(() => this.refresh(workspaceId, entry));
    if (!entry.changed.size) return entry.listing;
    const refreshing = this.refreshMetadata(workspaceId, entry);
    entry.refreshing = refreshing;
    void refreshing.finally(() => { if (entry.refreshing === refreshing) delete entry.refreshing; }).catch(() => undefined);
    return refreshing;
  }

  private async refreshMetadata(workspaceId: string, entry: ListingEntry): ListingPromise {
    const result = await entry.listing;
    const paths = [...entry.changed].filter(path => entry.files.has(path));
    const identities = new Map(paths.map(path => [path, entry.files.get(path)?.contentIdentity]));
    entry.changed.clear();
    if (paths.length && this.refreshContent) {
      try {
        const metadata = await this.refreshContent(workspaceId, entry.attachmentId, paths);
        if (this.#listings.get(workspaceId) === entry) for (const update of metadata) {
          const file = entry.files.get(update.path);
          if (file && file.contentIdentity === identities.get(update.path)) {
            if (update.icon) file.icon = update.icon; else delete file.icon;
          }
        }
      } catch (error) {
        for (const path of paths) entry.changed.add(path);
        throw error;
      }
    }
    return result;
  }

  observe(workspaceId: string, attachmentId: symbol, facts: readonly FileObservationFact[]): void {
    const entry = this.#listings.get(workspaceId);
    if (!entry || entry.attachmentId !== attachmentId) return;
    for (const fact of facts) {
      // Rules are read separately on every IPC response; they cannot change this path cache.
      if (isWorkspaceVisibilityPolicyPath(fact.path, this.platform)) continue;
      // A file removed and written again between two engine scans reads as
      // changed. A listing walked between them lacks it, so its paths are stale.
      if (fact.kind !== "changed" || (entry.settled && !entry.files.has(fact.path))) {
        this.#listings.delete(workspaceId);
        return;
      }
      entry.changed.add(fact.path);
      const file = entry.files.get(fact.path);
      if (file) file.contentIdentity = `observation:${++this.revision}`;
    }
  }

  // Invalidate from the event the renderer actually receives. The broadcast
  // has already omitted empty, oversized, or truncated path sets, so every
  // pathless event takes the conservative full-refresh branch here too.
  invalidate(event: WorkspaceActivityEvent): void {
    if (!event.workspaceId) {
      this.#listings.clear();
      return;
    }
    if (event.pathSetChanged === false) return;
    if (
      !event.paths?.length ||
      activityPathsAffectWorkspaceListing(event.paths.filter(path => !isWorkspaceVisibilityPolicyPath(path, this.platform)), this.platform)
    ) {
      this.#listings.delete(event.workspaceId);
    }
  }
}
