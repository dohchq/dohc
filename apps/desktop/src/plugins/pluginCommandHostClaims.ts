export class PluginCommandHostClaims {
  private readonly counts = new Map<string, number>();
  // Keys whose host a command's own cold start put into "running" —
  // claim: false means that start never took a panelStartedHosts-style
  // claim, so without this a surface-less plugin a command started stayed
  // running forever: stopPluginHostIfUnclaimed's own "did an on-demand
  // start put this host into running" check had nothing to find (round-9
  // finding 1).
  private readonly startedHosts = new Set<string>();
  // Keys a rebuild's old-runtime stop is waiting to drain — set the
  // instant drain() is called (synchronously, before its promise
  // executor returns), so a caller that checks isDraining() before
  // claim() can never lose the race: JS runs both on one thread with no
  // await between the check and the claim (round-10 finding 2).
  private readonly draining = new Map<string, () => void>();

  claim(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  release(key: string): void {
    const count = this.counts.get(key);
    if (count === undefined) return;
    if (count <= 1) {
      this.counts.delete(key);
      this.draining.get(key)?.();
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
   * True while an old-runtime stop is waiting on this key's claims to
   * drain. A caller about to claim a new command must check this first
   * and refuse instead of joining — otherwise the wait a rebuild is doing
   * before it disposes the transport would never end, chasing new
   * arrivals instead of the claims that existed when it began
   * (round-10 finding 2).
   */
  isDraining(key: string): boolean {
    return this.draining.has(key);
  }

  /**
   * Marks a key draining and resolves once every claim already
   * outstanding for it has released — or immediately, if there are none.
   * Call exactly once per key, before disposing a host claims might still
   * be mid-command against: severing the transport under a claim already
   * running would dispose it after only some of that command's side
   * effects ran. The caller is expected to have every new claim on this
   * key check isDraining() and refuse before this settles, or a claim
   * could still land after the drain begins and this would wait on it too.
   */
  drain(key: string): Promise<void> {
    if (!this.counts.has(key)) return Promise.resolve();
    return new Promise((resolve) => {
      this.draining.set(key, () => {
        this.draining.delete(key);
        resolve();
      });
    });
  }
}
