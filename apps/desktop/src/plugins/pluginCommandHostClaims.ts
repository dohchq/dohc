export class PluginCommandHostClaims {
  private readonly counts = new Map<string, number>();
  // Keys whose host a command's own cold start put into "running" —
  // claim: false means that start never took a panelStartedHosts-style
  // claim, so without this a surface-less plugin a command started stayed
  // running forever: stopPluginHostIfUnclaimed's own "did an on-demand
  // start put this host into running" check had nothing to find (round-9
  // finding 1).
  private readonly startedHosts = new Set<string>();

  claim(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  release(key: string): void {
    const count = this.counts.get(key);
    if (count === undefined) return;
    if (count <= 1) {
      this.counts.delete(key);
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
}
