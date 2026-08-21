export class PluginCommandHostClaims {
  private readonly counts = new Map<string, number>();
  // Keys whose host a command's own cold start put into "running" —
  // claim: false means that start never took a panelStartedHosts-style
  // claim, so without this a surface-less plugin a command started stayed
  // running forever: stopPluginHostIfUnclaimed's own "did an on-demand
  // start put this host into running" check had nothing to find (round-9
  // finding 1).
  private readonly startedHosts = new Set<string>();
  // Keys a rebuild's old-runtime stop is refusing new claims for — the
  // barrier itself. Set the instant drain() is called (synchronously,
  // before its promise executor returns), so a caller that checks
  // isDraining() before claim() can never lose the race: JS runs both on
  // one thread with no await between the check and the claim (round-10
  // finding 2). Cleared only by the caller's own clearDrain(), not by
  // drain()'s promise resolving — the caller's real teardown
  // (PluginHost.stop()) still runs after every claim has drained, and a
  // command arriving in that window must be refused too, or it reaches a
  // host mid-dispose instead of a clean "try again" (round-11).
  private readonly draining = new Set<string>();
  // The resolver a pending drain() is waiting to fire once this key's
  // claims reach zero — separate from `draining` itself, which outlives
  // this resolving on the caller's own schedule.
  private readonly drainResolvers = new Map<string, () => void>();

  claim(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  release(key: string): void {
    const count = this.counts.get(key);
    if (count === undefined) return;
    if (count <= 1) {
      this.counts.delete(key);
      this.drainResolvers.get(key)?.();
      this.drainResolvers.delete(key);
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
   * True while an old-runtime stop is refusing new claims on this key —
   * from the moment drain() is called until the caller's own clearDrain().
   * A caller about to claim a new command must check this first and
   * refuse instead of joining — otherwise the wait a rebuild is doing
   * before it disposes the transport would never end, chasing new
   * arrivals instead of the claims that existed when it began
   * (round-10 finding 2).
   */
  isDraining(key: string): boolean {
    return this.draining.has(key);
  }

  /**
   * Marks a key draining — refusing new claims — and resolves once every
   * claim already outstanding for it has released, or immediately if
   * there are none. Marks even with zero claims outstanding: a rebuild
   * that finds nothing to wait for still has real work left (disposing
   * the transport), and a command racing in during that window must be
   * refused too, or it reaches a host mid-dispose instead of getting the
   * retryable refusal (round-11). The marker itself outlives this
   * resolving — call clearDrain() once that real work is actually done.
   */
  drain(key: string): Promise<void> {
    this.draining.add(key);
    if (!this.counts.has(key)) return Promise.resolve();
    return new Promise((resolve) => {
      this.drainResolvers.set(key, resolve);
    });
  }

  /**
   * Clears a key's draining barrier. Call once the caller's own teardown
   * — the host stop this barrier exists to protect — has actually
   * finished, not when drain()'s promise resolves: that only means every
   * claim that existed has released, and the stop it unblocks still has
   * to run (round-11).
   */
  clearDrain(key: string): void {
    this.draining.delete(key);
  }
}
