import { WaiterRegistry } from "@dohc/service-http";

export interface DiscussionActivityWaitOptions {
  holdMs: number;
  signal?: AbortSignal;
  // Called only after the waiter is registered. Returning false settles the
  // wait synchronously, closing the observation-to-park race.
  shouldPark: () => boolean;
}

export interface DiscussionActivityHubOptions {
  maxTotalWaiters?: number;
  maxWaitersPerShare?: number;
  maxWaitersPerActor?: number;
}

export class DiscussionActivityCapacityError extends Error {
  constructor(message = "too many parked discussion activity polls") {
    super(message);
    this.name = "DiscussionActivityCapacityError";
  }
}

// Readers of one workspace log wait in two groups, each with its own group
// cap, so accountless readers of a shared link cannot use up the capacity
// the owner's devices wait in.
export function linkLogWaitGroup(workspaceId: string): string {
  return `log:${workspaceId}`;
}

export function ownerLogWaitGroup(workspaceId: string): string {
  return `owner-log:${workspaceId}`;
}

// This hub is only a bounded wake signal. SQLite owns revisions and activity
// data, so losing this object on restart cannot invalidate a saved watermark.
export class DiscussionActivityHub {
  private readonly waiters: WaiterRegistry;

  constructor(options: DiscussionActivityHubOptions = {}) {
    this.waiters = new WaiterRegistry({
      maxTotal: options.maxTotalWaiters ?? 4_096,
      maxPerGroup: options.maxWaitersPerShare ?? 512,
      maxPerActor: options.maxWaitersPerActor ?? 64,
    });
  }

  wait(shareId: string, actorId: string, options: DiscussionActivityWaitOptions): Promise<void> {
    if (this.waiters.atCapacity(shareId, actorId)) {
      throw new DiscussionActivityCapacityError();
    }
    return this.waiters.park(shareId, actorId, {
      holdMs: options.holdMs,
      signal: options.signal,
      settle: () => undefined,
      shouldPark: options.shouldPark,
    });
  }

  wake(shareId: string): void {
    this.waiters.wake(shareId, undefined);
  }

  /** The workspace log changed: wakes its link readers and its owner's devices. */
  wakeLog(workspaceId: string): void {
    this.waiters.wake(linkLogWaitGroup(workspaceId), undefined);
    this.waiters.wake(ownerLogWaitGroup(workspaceId), undefined);
  }

  stats(): { shares: number; waiters: number } {
    const { groups, waiters } = this.waiters.stats();
    return { shares: groups, waiters };
  }
}
