import { isInvalidInputRefusal, VersionedLiveAdapter, type AutomationClaim } from "@dohc/workspace-engine-client";
import type { SyncRelayStorage } from "./storage";

// A live-shared record changes on the live host: its engine accepts each
// frame the relay admitted as local, the owner's and each collaborator's
// alike, and claims the change for the automations subscribed there (ADR
// 0008). The claims stay in the live host's engine, so a live host restart
// loses none. The server's executor drains them beside its own copy's
// claims and runs each against its copy, once its copy has pulled the change.

type Ledger = Pick<VersionedLiveAdapter,
  | "subscribeAutomation" | "unsubscribeAutomation" | "claimNextAutomation" | "settleAutomationClaim"
  | "releaseAutomationClaim" | "retryAutomationClaim" | "listAutomationClaims" | "listAutomationFailures"
  | "getAutomationClaim" | "pruneAutomationHistory">;

/** The live host's claim ledger for one workspace, while the live host holds its live-shared documents. */
export interface LiveClaimLedger {
  readonly engine: Ledger;
  /** Changes when the live host starts again, so its subscriptions are sent again. */
  readonly incarnation: string;
}

type Subscription = Parameters<VersionedLiveAdapter["subscribeAutomation"]>[0];

/** The relay journal cursor recorded for a live frame's claim, or null. */
function liveCursorOf(claim: AutomationClaim): number | null {
  const cursor = claim.change.liveCursor;
  return typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor > 0 ? cursor : null;
}

/**
 * The engine the server's executor drives for one workspace: its own copy,
 * and the live host's claim ledger beside it. Subscriptions go to both. A
 * claim comes from the copy first, then from the live host; a live claim is
 * served only once the relay has logged its change and the copy has pulled
 * past it, so the run reads the record as the change left it. Until then it
 * is held here, and `waiting` says so. Each claim's settle, release, and
 * retry go back to the engine that served it.
 */
export class ServerClaimEngine extends VersionedLiveAdapter {
  private readonly wanted = new Map<string, Subscription>();
  private readonly dropped = new Map<string, string>();
  /** The live host incarnation that holds every wanted subscription, or null. */
  private mirrored: string | null = null;
  private readonly fromLive = new Set<string>();
  private readonly held: AutomationClaim[] = [];
  /** The relay log head the copy has pulled through. */
  private pulledHead: number | null = null;

  constructor(
    copy: ConstructorParameters<typeof VersionedLiveAdapter>,
    private readonly live: {
      ledger(): LiveClaimLedger | null;
      storage: Pick<SyncRelayStorage, "automationWorkspaceLogSeq" | "automationWorkspaceLogHead" | "liveClaimLogSeq">;
      /** Pulls the copy through at least the relay log head at the call. */
      sync(): Promise<void>;
      onFailuresChanged(): void;
      onError(context: string, error: unknown): void;
    },
  ) {
    super(...copy);
  }

  /** A live claim waits for its change to reach the relay, or the live host started again: drain once more after the next relay write. */
  waiting(): boolean {
    const ledger = this.live.ledger();
    return this.held.length > 0 || (ledger !== null && ledger.incarnation !== this.mirrored);
  }

  override async subscribeAutomation(input: Subscription) {
    const result = await super.subscribeAutomation(input);
    this.wanted.set(input.automationId, input);
    this.dropped.delete(input.automationId);
    await this.mirror(this.live.ledger(), [input]);
    return result;
  }

  override async unsubscribeAutomation(input: Parameters<VersionedLiveAdapter["unsubscribeAutomation"]>[0]) {
    const result = await super.unsubscribeAutomation(input);
    this.wanted.delete(input.automationId);
    this.dropped.set(input.automationId, input.path);
    await this.mirror(this.live.ledger(), []);
    return result;
  }

  override async claimNextAutomation(input: Parameters<VersionedLiveAdapter["claimNextAutomation"]>[0]) {
    const own = await super.claimNextAutomation(input);
    if (own !== null) return own;
    const ledger = this.live.ledger();
    if (ledger === null) return null;
    // A live host that started again gets every subscription here.
    await this.mirror(ledger, []);
    // One live claim at a time, in the live host's order: nothing newer runs before it.
    for (;;) {
      if (this.held.length === 0) {
        const claim = await ledger.engine.claimNextAutomation(input);
        if (claim === null) return null;
        this.fromLive.add(claim.claimId);
        this.held.push(claim);
      }
      const next = this.held[0]!;
      if (liveCursorOf(next) === null && !("originId" in next.trigger)) {
        if (!(await this.pullThrough(0))) return null;
        await this.settleAutomationClaim({ claimId: next.claimId, state: "failed",
          error: "This automation could not run because the live host did not record which change triggered it. Update your dohc server, then change the record again." });
        this.held.shift();
        this.live.onFailuresChanged();
        continue;
      }
      if (!(await this.pulledPast(next))) return null;
      this.held.shift();
      return next;
    }
  }

  override async settleAutomationClaim(input: Parameters<VersionedLiveAdapter["settleAutomationClaim"]>[0]) {
    if (!this.fromLive.has(input.claimId)) return await super.settleAutomationClaim(input);
    const settled = await this.ledgerFor("settle").settleAutomationClaim(input);
    this.fromLive.delete(input.claimId);
    return settled;
  }

  override async releaseAutomationClaim(input: Parameters<VersionedLiveAdapter["releaseAutomationClaim"]>[0]) {
    if (!this.fromLive.has(input.claimId)) return await super.releaseAutomationClaim(input);
    const released = await this.ledgerFor("release").releaseAutomationClaim(input);
    this.fromLive.delete(input.claimId);
    return released;
  }

  /** A failed claim from either engine, however old: the copy's first. */
  override async retryAutomationClaim(input: Parameters<VersionedLiveAdapter["retryAutomationClaim"]>[0]) {
    try {
      return await super.retryAutomationClaim(input);
    } catch (error) {
      const ledger = this.live.ledger();
      if (!isInvalidInputRefusal(error) || ledger === null) throw error;
      return await ledger.engine.retryAutomationClaim(input);
    }
  }

  /** Both engines' claims of an automation, newest first. The live host's count only while it answers. */
  override async listAutomationClaims(input: Parameters<VersionedLiveAdapter["listAutomationClaims"]>[0]) {
    const own = await super.listAutomationClaims(input);
    const live = await this.fromLedger((ledger) => ledger.listAutomationClaims(input));
    if (live === null) return own;
    const limit = input.limit ?? 20;
    const combined = [...own.claims, ...live.claims].sort((left, right) =>
      right.createdAtMs - left.createdAtMs || Buffer.compare(Buffer.from(right.claimId), Buffer.from(left.claimId)));
    const claims = combined.slice(0, limit);
    const last = claims.at(-1);
    const more = combined.length > limit || own.next !== null || live.next !== null;
    return { claims, next: more && last ? `${last.createdAtMs}:${last.claimId}` : null };
  }

  override async getAutomationClaim(input: Parameters<VersionedLiveAdapter["getAutomationClaim"]>[0]) {
    const own = await super.getAutomationClaim(input);
    return own.claim !== null ? own : await this.fromLedger((ledger) => ledger.getAutomationClaim(input)) ?? own;
  }

  override async pruneAutomationHistory(input: Parameters<VersionedLiveAdapter["pruneAutomationHistory"]>[0]) {
    const own = await super.pruneAutomationHistory(input);
    const live = await this.fromLedger((ledger) => ledger.pruneAutomationHistory(input));
    return live === null ? own : { pruned: own.pruned + live.pruned, more: own.more || live.more };
  }

  /** Each automation's newest failed claim, from whichever engine failed it last. */
  override async listAutomationFailures() {
    const own = await super.listAutomationFailures();
    const live = await this.fromLedger((ledger) => ledger.listAutomationFailures());
    if (live === null) return own;
    const newest = new Map(own.failures.map((failure) => [failure.automationId, failure]));
    for (const failure of live.failures) {
      const other = newest.get(failure.automationId);
      if (!other || failure.updatedAtMs > other.updatedAtMs) newest.set(failure.automationId, failure);
    }
    return { ...own, failures: [...newest.values()] };
  }

  /**
   * The workspace closed, or its copy's engine stopped: every live claim
   * this engine took and has not answered goes back to the live host, which
   * still runs. The executor's own answers go through the copy, which may be
   * gone. A claim whose run already wrote runs again, and resumes after the
   * steps its run store recorded.
   */
  async close(): Promise<void> {
    this.held.length = 0;
    const ledger = this.live.ledger();
    for (const claimId of [...this.fromLive]) {
      this.fromLive.delete(claimId);
      await ledger?.engine.releaseAutomationClaim({ claimId })
        .catch((error: unknown) => this.live.onError(`hand back live claim "${claimId}"`, error));
    }
  }

  private ledgerFor(action: string): Ledger {
    const ledger = this.live.ledger();
    // The executor keeps the claim owed and answers again at its next drain.
    if (ledger === null) throw new Error(`The live host is not running, so the ${action} waits for it.`);
    return ledger.engine;
  }

  private async fromLedger<T>(read: (ledger: Ledger) => Promise<T>): Promise<T | null> {
    const ledger = this.live.ledger();
    if (ledger === null) return null;
    try {
      return await read(ledger.engine);
    } catch (error) {
      this.live.onError("read the live host's automation claims", error);
      return null;
    }
  }

  /**
   * Sends subscriptions to the live host: every wanted one to an
   * incarnation that has not had them, else only `changed`, and the
   * unsubscribes it has not had. A failure leaves the rest for the next
   * drain; the copy's own subscriptions stand either way.
   */
  private async mirror(ledger: LiveClaimLedger | null, changed: readonly Subscription[]): Promise<void> {
    if (ledger === null) return;
    const fresh = ledger.incarnation !== this.mirrored;
    try {
      for (const subscription of fresh ? this.wanted.values() : changed) await ledger.engine.subscribeAutomation(subscription);
      for (const [automationId, path] of [...this.dropped]) {
        await ledger.engine.unsubscribeAutomation({ automationId, path });
        this.dropped.delete(automationId);
      }
      this.mirrored = ledger.incarnation;
    } catch (error) {
      this.mirrored = null;
      this.live.onError("send automation subscriptions to the live host", error);
    }
  }

  /**
   * Whether the copy holds the change the live claim ran on. A live frame's
   * claim names the relay journal cursor it came in: the relay logged the
   * change with the moment of the settlement that carried its document past
   * that cursor, one settlement after the frame. A claim keyed by a journal
   * coordinate reached the relay once the relay logged it. The copy pulls
   * through it if it has not yet. Claims with neither coordinate fail in
   * claimNextAutomation after the copy's first successful pull.
   */
  private async pulledPast(claim: AutomationClaim): Promise<boolean> {
    const { workspaceId } = this;
    const trigger = claim.trigger;
    const liveCursor = liveCursorOf(claim);
    const seq = liveCursor !== null
      ? this.live.storage.liveClaimLogSeq({ workspaceId, liveCursor })
      : "originId" in trigger
        ? this.live.storage.automationWorkspaceLogSeq({ workspaceId, originId: trigger.originId, originSeq: trigger.originSeq })
        : null;
    if (seq === null) return false;
    return this.pullThrough(seq);
  }

  private async pullThrough(seq: number): Promise<boolean> {
    if (this.pulledHead === null || seq > this.pulledHead) {
      const head = this.live.storage.automationWorkspaceLogHead(this.workspaceId);
      try {
        await this.live.sync();
      } catch (error) {
        // The claim stays held, and the next drain pulls again.
        this.live.onError("pull the change a live claim ran on", error);
        return false;
      }
      this.pulledHead = Math.max(this.pulledHead ?? 0, head);
    }
    return true;
  }
}
