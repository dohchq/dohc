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

export const DEFAULT_DISCUSSION_ACTIVITY_MAX_TOTAL_WAITERS = 4_096;
export const DEFAULT_DISCUSSION_ACTIVITY_MAX_WAITERS_PER_SHARE = 512;
export const DEFAULT_DISCUSSION_ACTIVITY_MAX_WAITERS_PER_ACTOR = 64;

export class DiscussionActivityCapacityError extends Error {
  constructor(message = "too many parked discussion activity polls") {
    super(message);
    this.name = "DiscussionActivityCapacityError";
  }
}

type Waiter = () => void;

// This hub is only a bounded wake signal. SQLite owns revisions and activity
// data, so losing this object on restart cannot invalidate a saved watermark.
export class DiscussionActivityHub {
  private readonly waitersByShare = new Map<string, Set<Waiter>>();
  private readonly waitersByActor = new Map<string, number>();
  private totalWaiters = 0;

  private readonly maxTotalWaiters: number;
  private readonly maxWaitersPerShare: number;
  private readonly maxWaitersPerActor: number;

  constructor(options: DiscussionActivityHubOptions = {}) {
    this.maxTotalWaiters =
      options.maxTotalWaiters ?? DEFAULT_DISCUSSION_ACTIVITY_MAX_TOTAL_WAITERS;
    this.maxWaitersPerShare =
      options.maxWaitersPerShare ??
      DEFAULT_DISCUSSION_ACTIVITY_MAX_WAITERS_PER_SHARE;
    this.maxWaitersPerActor =
      options.maxWaitersPerActor ??
      DEFAULT_DISCUSSION_ACTIVITY_MAX_WAITERS_PER_ACTOR;
  }

  wait(
    shareId: string,
    actorId: string,
    options: DiscussionActivityWaitOptions,
  ): Promise<void> {
    const shareWaiters = this.waitersByShare.get(shareId);
    if (
      this.totalWaiters >= this.maxTotalWaiters ||
      (shareWaiters?.size ?? 0) >= this.maxWaitersPerShare ||
      (this.waitersByActor.get(actorId) ?? 0) >= this.maxWaitersPerActor
    ) {
      throw new DiscussionActivityCapacityError();
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      let registered = shareWaiters;
      if (!registered) {
        registered = new Set();
        this.waitersByShare.set(shareId, registered);
      }
      this.totalWaiters += 1;
      this.waitersByActor.set(
        actorId,
        (this.waitersByActor.get(actorId) ?? 0) + 1,
      );

      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        registered!.delete(waiter);
        if (registered!.size === 0) this.waitersByShare.delete(shareId);
        this.totalWaiters -= 1;
        const actorWaiters = (this.waitersByActor.get(actorId) ?? 1) - 1;
        if (actorWaiters === 0) this.waitersByActor.delete(actorId);
        else this.waitersByActor.set(actorId, actorWaiters);
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const waiter = (): void => finish();
      const onAbort = (): void => finish();
      const timer = setTimeout(finish, options.holdMs);
      if (typeof timer === "object" && timer && "unref" in timer) {
        (timer as { unref: () => void }).unref();
      }

      registered.add(waiter);
      if (options.signal) {
        if (options.signal.aborted) {
          finish();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (!options.shouldPark()) finish();
    });
  }

  wake(shareId: string): void {
    const waiters = this.waitersByShare.get(shareId);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter();
  }

  stats(): { shares: number; waiters: number } {
    return { shares: this.waitersByShare.size, waiters: this.totalWaiters };
  }
}
