export class PluginCommandHostClaims {
  private readonly counts = new Map<string, number>();
  // Keys whose host a command's own cold start put into "running" —
  // claim: false means that start never took a panelStartedHosts-style
  // claim, so without this a surface-less plugin a command started stayed
  // running forever: stopPluginHostIfUnclaimed's own "did an on-demand
  // start put this host into running" check had nothing to find (round-9
  // finding 1).
  private readonly startedHosts = new Set<string>();
  // Refcounted holds on this key's drain barrier. Every independent
  // caller that raises one — a rebuild's whole action, and separately the
  // old-runtime stop nested inside it; a workspace disposal — keeps the
  // barrier up until it lowers its OWN hold, so one caller's clear can
  // never undo a hold a different caller, or a caller nested inside it,
  // is still relying on. The barrier's owner is whichever caller raised
  // it (round-13 findings 1 and 2).
  private readonly drainHolds = new Map<string, number>();
  // Waiters for a key's claims to reach zero. Every drain() call for the
  // same key registers its own resolver here, and release() fires all of
  // them once the count hits zero — two concurrent drains on one key
  // (a rebuild's own wide drain and its nested stop's narrower one)
  // never silently replace each other's resolver (round-13 finding 6).
  private readonly drainWaiters = new Map<string, Array<() => void>>();

  claim(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

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

  has(key: string): boolean {
    return this.counts.has(key);
  }

  /**
   * Records that a command's own cold start — not a panel or web app —
   * put this host into "running". Call once, only when that exact start
   * performed the zero-to-running transition; a command that found the
   * host already running never owns it this way.
   */
  markStartedHost(key: string): void {
    this.startedHosts.add(key);
  }

  /**
   * Consumes and reports whether a command's cold start is (or was) this
   * host's on-demand claim to being alive — the command-claim counterpart
   * to panelStartedHosts.delete(). Callers check hasAnotherPanel and the
   * web-app registry, and this claims map's own has(), before reaching
   * this the same way panelStartedHosts.delete() is only reached once
   * those pass — so a marker a panel took over mid-command is never spent
   * on a stop the panel still needs; it survives, unconsumed, for that
   * panel's own eventual close to spend instead.
   */
  consumeStartedHost(key: string): boolean {
    return this.startedHosts.delete(key);
  }

  /**
   * True while at least one caller's hold on this key's drain barrier is
   * still up. A caller about to claim a new command must check this
   * first and refuse instead of joining — otherwise a rebuild's own wait
   * for its existing claims to drain would never end, chasing new
   * arrivals instead of the claims that existed when it began
   * (round-10 finding 2).
   */
  isDraining(key: string): boolean {
    return (this.drainHolds.get(key) ?? 0) > 0;
  }

  /**
   * Raises one independent hold on this key's drain barrier — refusing
   * new claims — without waiting for anything. Holds compose by count:
   * the barrier only comes down once every raised hold has been
   * individually lowered via lowerDrainBarrier(), so a rebuild's own wide
   * hold (raised before it is even enqueued) and the narrower hold its
   * own old-runtime stop raises inside it can nest without one's lower
   * undoing the other's still-active hold (round-13 findings 1 and 2).
   * Never lower a hold you did not raise.
   */
  raiseDrainBarrier(key: string): void {
    this.drainHolds.set(key, (this.drainHolds.get(key) ?? 0) + 1);
  }

  /**
   * Lowers exactly one hold this same caller previously raised via
   * raiseDrainBarrier() (directly, or through drain()). A no-op on a key
   * with no hold outstanding, so a caller whose own raise never actually
   * happened — an early return before it — can still call this
   * unconditionally in a finally.
   */
  lowerDrainBarrier(key: string): void {
    const count = this.drainHolds.get(key);
    if (count === undefined) return;
    if (count <= 1) {
      this.drainHolds.delete(key);
      return;
    }
    this.drainHolds.set(key, count - 1);
  }

  /**
   * Raises one hold (see raiseDrainBarrier) and resolves once every claim
   * already outstanding for this key has released, or immediately if
   * there are none. The hold this raises is the caller's own to lower,
   * separately, via lowerDrainBarrier() — resolving only means claims are
   * empty, not that the caller's own protected work is done.
   */
  drain(key: string): Promise<void> {
    this.raiseDrainBarrier(key);
    if (!this.counts.has(key)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.drainWaiters.get(key) ?? [];
      waiters.push(resolve);
      this.drainWaiters.set(key, waiters);
    });
  }
}
