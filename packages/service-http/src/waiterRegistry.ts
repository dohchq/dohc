export interface WaiterCaps {
  maxTotal: number;
  maxPerGroup: number;
  maxPerActor: number;
}

type Waiter<T> = (value: T) => void;

/**
 * Parked long-poll waiters, capped in total, per group, and per actor. A
 * waiter settles on wake, abort, or timeout; every path releases its slot.
 * The registry holds no data: a hub that parks here still owns its revisions.
 */
export class WaiterRegistry<T = void> {
  private readonly byGroup = new Map<string, Set<Waiter<T>>>();
  private readonly byActor = new Map<string, number>();
  private total = 0;

  constructor(private readonly caps: WaiterCaps) {}

  atCapacity(group: string, actorId?: string): boolean {
    return (
      this.total >= this.caps.maxTotal ||
      (this.byGroup.get(group)?.size ?? 0) >= this.caps.maxPerGroup ||
      (actorId !== undefined && (this.byActor.get(actorId) ?? 0) >= this.caps.maxPerActor)
    );
  }

  /**
   * Parks until `wake(group)`, the signal aborts, or `holdMs` passes. `settle`
   * supplies the value for the abort and timeout paths. `shouldPark` runs after
   * registration so a change that lands between the caller's check and the
   * park settles the wait at once instead of being missed.
   */
  park(
    group: string,
    actorId: string | undefined,
    options: {
      holdMs: number;
      signal?: AbortSignal;
      settle: () => T;
      shouldPark?: () => boolean;
    },
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      let settled = false;
      let waiters = this.byGroup.get(group);
      if (!waiters) {
        waiters = new Set();
        this.byGroup.set(group, waiters);
      }
      const registered = waiters;
      this.total += 1;
      if (actorId !== undefined) this.byActor.set(actorId, (this.byActor.get(actorId) ?? 0) + 1);

      const finish = (value: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        registered.delete(waiter);
        if (registered.size === 0) this.byGroup.delete(group);
        this.total -= 1;
        if (actorId !== undefined) {
          const count = (this.byActor.get(actorId) ?? 1) - 1;
          if (count <= 0) this.byActor.delete(actorId);
          else this.byActor.set(actorId, count);
        }
        options.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const waiter: Waiter<T> = (value) => finish(value);
      const onAbort = (): void => finish(options.settle());
      // Never keep the process alive only to hold a poll open.
      const timer = setTimeout(() => finish(options.settle()), options.holdMs);
      timer.unref();

      registered.add(waiter);
      if (options.signal) {
        if (options.signal.aborted) {
          finish(options.settle());
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
      if (options.shouldPark && !options.shouldPark()) finish(options.settle());
    });
  }

  /** Settles every waiter parked on `group` with `value`. */
  wake(group: string, value: T): void {
    const waiters = this.byGroup.get(group);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter(value);
  }

  waiting(group: string): number {
    return this.byGroup.get(group)?.size ?? 0;
  }

  stats(): { groups: number; waiters: number } {
    return { groups: this.byGroup.size, waiters: this.total };
  }
}
