import { WaiterRegistry } from "@dohc/service-http";

export interface DiscussionActivityWaitOptions {
  holdMs: number;
  signal?: AbortSignal;
  // Called only after the waiter is registered. Returning false settles the
  // wait synchronously, closing the observation-to-park race.
  shouldPark: () => boolean;
  // A personal agent's wait holds one slot per workspace in its reach, so it
  // parks in its own pool and can't use up the slots link readers and the
  // owner's devices wait in.
  personal?: boolean;
}

export interface DiscussionActivityHubOptions {
  maxTotalWaiters?: number;
  maxWaitersPerShare?: number;
  maxWaitersPerActor?: number;
  maxPersonalWaiters?: number;
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

/** An account's change feed for one workspace waits apart from both. */
export function accountFeedWaitGroup(workspaceId: string): string {
  return `account-feed:${workspaceId}`;
}

// This hub is only a bounded wake signal. SQLite owns revisions and activity
// data, so losing this object on restart cannot invalidate a saved watermark.
export class DiscussionActivityHub {
  private readonly waiters: WaiterRegistry;
  private readonly personal: WaiterRegistry;

  constructor(options: DiscussionActivityHubOptions = {}) {
    const perGroup = options.maxWaitersPerShare ?? 512;
    const perActor = options.maxWaitersPerActor ?? 64;
    this.waiters = new WaiterRegistry({
      maxTotal: options.maxTotalWaiters ?? 4_096,
      maxPerGroup: perGroup,
      maxPerActor: perActor,
    });
    this.personal = new WaiterRegistry({
      maxTotal: options.maxPersonalWaiters ?? 1_024,
      maxPerGroup: perGroup,
      maxPerActor: perActor,
    });
  }

  wait(shareId: string, actorId: string, options: DiscussionActivityWaitOptions): Promise<void> {
    const waiters = options.personal ? this.personal : this.waiters;
    if (waiters.atCapacity(shareId, actorId)) {
      throw new DiscussionActivityCapacityError();
    }
    return waiters.park(shareId, actorId, {
      holdMs: options.holdMs,
      signal: options.signal,
      settle: () => undefined,
      shouldPark: options.shouldPark,
    });
  }

  wake(shareId: string): void {
    this.waiters.wake(shareId, undefined);
  }

  /** The workspace log changed: wakes its link readers, its owner's devices, its personal agents, and its account change feeds. */
  wakeLog(workspaceId: string): void {
    this.waiters.wake(linkLogWaitGroup(workspaceId), undefined);
    this.waiters.wake(ownerLogWaitGroup(workspaceId), undefined);
    this.personal.wake(ownerLogWaitGroup(workspaceId), undefined);
    this.waiters.wake(accountFeedWaitGroup(workspaceId), undefined);
  }

  stats(): { shares: number; waiters: number } {
    const shared = this.waiters.stats();
    const personal = this.personal.stats();
    return { shares: shared.groups + personal.groups, waiters: shared.waiters + personal.waiters };
  }
}
