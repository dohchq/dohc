export class PluginCommandHostClaims {
  private readonly counts = new Map<string, number>();
  private readonly startedHosts = new Set<string>();
  private readonly drainHolds = new Map<string, number>();
  private readonly drainWaiters = new Map<string, Array<() => void>>();

  /** Claims a key's host for the duration of one command. */
  claim(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** Releases one claim made by claim(). */
  release(key: string): void {
    const count = this.counts.get(key);
    if (count === undefined) return;
    if (count <= 1) {
      this.counts.delete(key);
      const waiters = this.drainWaiters.get(key);
      if (waiters) {
        this.drainWaiters.delete(key);
        for (const resolve of waiters) resolve();
      }
      return;
    }
    this.counts.set(key, count - 1);
  }

  /** True while any command holds a claim on this key. */
  has(key: string): boolean {
    return this.counts.has(key);
  }

  /** Records that a command's own start put this key's host into
   * "running", for that command's own release to act on later. */
  markStartedHost(key: string): void {
    this.startedHosts.add(key);
  }

  /** Consumes and reports whether a command's start is this key's claim
   * to being alive. */
  consumeStartedHost(key: string): boolean {
    return this.startedHosts.delete(key);
  }

  /** True while any drain barrier is raised on this key. */
  isDraining(key: string): boolean {
    return (this.drainHolds.get(key) ?? 0) > 0;
  }

  /**
   * Raises one hold on this key's drain barrier — refusing new claims —
   * and returns the function that lowers exactly that hold. Independent
   * holds on the same key compose: the barrier stays up until every
   * returned lower has run.
   */
  raiseDrainBarrier(key: string): () => void {
    this.drainHolds.set(key, (this.drainHolds.get(key) ?? 0) + 1);
    let lowered = false;
    return () => {
      if (lowered) return;
      lowered = true;
      const count = this.drainHolds.get(key);
      if (count === undefined) return;
      if (count <= 1) {
        this.drainHolds.delete(key);
        return;
      }
      this.drainHolds.set(key, count - 1);
    };
  }

  /**
   * Raises a hold (see raiseDrainBarrier) and resolves, with the function
   * that lowers it, once every claim already outstanding for this key has
   * released — or immediately if there are none.
   */
  drain(key: string): Promise<() => void> {
    const lower = this.raiseDrainBarrier(key);
    if (!this.counts.has(key)) return Promise.resolve(lower);
    return new Promise((resolve) => {
      const waiters = this.drainWaiters.get(key) ?? [];
      waiters.push(() => resolve(lower));
      this.drainWaiters.set(key, waiters);
    });
  }

  /**
   * Clears every piece of state this key holds — claims, the started-host
   * marker, and any drain hold. Call once the host behind this key is
   * gone for good: a marker surviving into a later session that reuses
   * the same key would misattribute that session's own host to whatever
   * this one never consumed.
   */
  reset(key: string): void {
    this.counts.delete(key);
    this.startedHosts.delete(key);
    this.drainHolds.delete(key);
    const waiters = this.drainWaiters.get(key);
    if (waiters) {
      this.drainWaiters.delete(key);
      for (const resolve of waiters) resolve();
    }
  }
}
