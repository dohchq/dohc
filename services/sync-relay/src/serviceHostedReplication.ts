import { decodeHostedSyncResult, hostedWindowCovers, type HostedWindow, type HostedSyncMethodResultMap } from "@dohc/workspace-engine-client/relay-wire";
import { EngineRequestError, type EngineClient } from "@dohc/workspace-engine-client/daemon";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import type { SharingDeclined } from "@dohc/workspace-contracts/relay";
import { configRecord } from "./deviceLiveHostConfig";
import { parseServiceRelayAttachment, type ServiceOrdinaryReplicationConfig } from "./serviceOrdinaryReplication";

export interface ServiceHostedReplicationConfig {
  readonly relay: ServiceOrdinaryReplicationConfig["relay"];
  /** The workspace identity its enrollments name. The relay checks it on every hosted request. */
  readonly identity: { readonly replicationEpoch: string; readonly streamIdentity: string };
  readonly maxPagesPerPull: number;
}

/** Private operator inputs; the relay authenticates the supplied service credential. */
export function parseServiceHostedReplicationConfig(value: unknown): ServiceHostedReplicationConfig {
  const row = configRecord(value, ["relay", "identity", "maxPagesPerPull"]);
  const identity = configRecord(row.identity, ["replicationEpoch", "streamIdentity"]);
  const maxPagesPerPull = row.maxPagesPerPull;
  if (typeof maxPagesPerPull !== "number" || !Number.isSafeInteger(maxPagesPerPull) || maxPagesPerPull < 1) {
    throw new Error("Invalid hosted replication page limit.");
  }
  return Object.freeze({relay: parseServiceRelayAttachment(row.relay), identity: Object.freeze({
    replicationEpoch: parseLiveUpdateIdentifier(identity.replicationEpoch, "replication epoch"),
    streamIdentity: parseLiveUpdateIdentifier(identity.streamIdentity, "stream identity")}), maxPagesPerPull});
}

type HostedPass = HostedSyncMethodResultMap["sync.pullHosted"];
export type ServiceHostedHold = HostedPass["held"][number];
export type ServiceHostedNewlyHeld = HostedPass["newlyHeld"][number];
export interface ServiceHostedPullPage {
  /** False when the pass adopted a new scope, or the scope moved before its commit: none of it committed. */
  readonly committed: boolean;
  /** The pass adopted a new scope instead of reading, so it says nothing of any document. */
  readonly adoptedScope: boolean;
  readonly fetched: number; readonly applied: number; readonly refused: number; readonly skipped: number; readonly conflictsOpened: number;
  readonly refusals: HostedPass["refusals"];
  readonly sharingDeclined: readonly SharingDeclined[];
  /** The paths the page wrote or deleted, in any version. */
  readonly changedPaths: readonly string[];
  /** How many of each report did not fit the engine's answer. The engine keeps them all. */
  readonly omitted: {readonly refusals: number; readonly sharingDeclined: number; readonly changedPaths: number};
  /** The documents the pass left held within `heldWindow`. None may be edited live until a later capture succeeds. */
  readonly held: readonly ServiceHostedHold[];
  /** Where `held` speaks for every document. Past it, the page says nothing of what is held. */
  readonly heldWindow: HostedWindow;
  /**
   * Documents the pass moved from ready to held, wherever they fall. Unless
   * `complete`, it may leave some out: the pass left some out, or an earlier
   * pass's page never arrived, though that pass may have held documents.
   */
  readonly newlyHeld: {readonly listed: readonly ServiceHostedNewlyHeld[]; readonly complete: boolean};
  /**
   * The documents that left the scope and are not gone from the replica,
   * within `window`, after the commit's parking when it read them. Inside
   * the window, a document not listed is not departed.
   */
  readonly departed: {readonly listed: readonly string[]; readonly window: HostedWindow};
}

const isDivergence = (error: unknown) => error instanceof EngineRequestError &&
  error.wireError?.code === "INVALID_PARAMS" && error.wireError.message === "relay-origin-diverged";

/**
 * The session host's hosted replica of one workspace: only the documents
 * shared with live editing. One pass at a time. Native materialization must
 * finish before the cursor commits. Once the relay reports rows at this
 * replica's origin that it never wrote, nothing more runs.
 */
export class ServiceHostedReplication {
  readonly #config: ServiceHostedReplicationConfig;
  #created = false;
  #running = false;
  #diverged = false;
  #departedNone = false;
  // Where the next pass lists held and departed documents from: after the last one a cut list named,
  // so every one is named within a few passes however many there are. Each moves once activation heard the page.
  #heldAfter: string | undefined;
  #departedAfter: string | undefined;
  // Whether a pass ran whose page never reached activation, as when its reply or its commit's was lost.
  #unheard = false;
  constructor(readonly connection: {
    client: Pick<EngineClient, "sendRequest">; workspace: string; workspaceId: string;
    nextRequestId(): number; deadlineMs: number; signal: AbortSignal; assertCurrent(): void;
  }, config: ServiceHostedReplicationConfig) {
    this.#config = parseServiceHostedReplicationConfig(config);
  }
  /** The workspace identity whose store this replica uses. */
  get identity(): ServiceHostedReplicationConfig["identity"] { return this.#config.identity; }
  /** Whether the replica's origin diverged from the relay's. Its workspace stays detached, and its store is kept. */
  get diverged(): boolean { return this.#diverged; }
  /** Whether the replica checked its origin: a create on this instance succeeded. */
  get checked(): boolean { return this.#created; }
  /** Whether the last page's departed list, from the first to the last, names no document. */
  get departedNone(): boolean { return this.#departedNone; }
  #check(signal: AbortSignal): void { signal.throwIfAborted(); this.connection.assertCurrent(); }
  async #request(method: string, params: Record<string, string | {kind: string; token: string}>, signal: AbortSignal) {
    this.#check(signal);
    const c = this.connection;
    let response;
    try {
      response = await c.client.sendRequest({id: c.nextRequestId(), workspace: c.workspace,
        deadlineMs: c.deadlineMs, method, params: {workspaceId: c.workspaceId, ...params}}, signal);
    } catch (error) {
      if (isDivergence(error)) this.#diverged = true;
      throw error;
    }
    this.#check(signal);
    return response.result;
  }
  async #run<T>(callerSignal: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#diverged) throw new Error("Hosted replica origin diverged from the relay.");
    if (this.#running) throw new Error("Hosted replication is already running.");
    this.#running = true;
    const signal = callerSignal ? AbortSignal.any([this.connection.signal, callerSignal]) : this.connection.signal;
    try {
      this.#check(signal);
      if (!this.#created) {
        const {replicationEpoch, streamIdentity} = this.#config.identity;
        decodeHostedSyncResult("sync.createHostedReplica",
          await this.#request("sync.createHostedReplica", {replicationEpoch, streamIdentity}, signal));
        this.#created = true;
      }
      return await task(signal);
    } finally { this.#running = false; }
  }
  /**
   * Creates the replica, as the first hosted call of this instance does, which
   * fails as diverged when the relay holds rows at its origin it never wrote.
   */
  async create(callerSignal?: AbortSignal): Promise<void> {
    await this.#run(callerSignal, async () => {});
  }
  /**
   * Runs up to maxPagesPerPull hosted passes. `onPage` hears each pass once it
   * committed, or committed nothing, before the next is asked for. Each pass
   * lists the held and departed documents after where the last such list
   * `onPage` heard stopped, and from the first once a list reached the last.
   * A retirement that failed after its commit fails the pull; the next pull
   * retries it first.
   */
  async pull(callerSignal?: AbortSignal, onPage?: (page: ServiceHostedPullPage) => void) {
    return this.#run(callerSignal, async signal => {
      const pages: ServiceHostedPullPage[] = [];
      for (let index = 0; index < this.#config.maxPagesPerPull; index++) {
        const after = this.#heldAfter, departedAfter = this.#departedAfter, unheard = this.#unheard;
        this.#check(signal);
        this.#unheard = true;
        const pass = decodeHostedSyncResult("sync.pullHosted", await this.#request("sync.pullHosted",
          {...after === undefined ? {} : {heldAfter: after}, ...departedAfter === undefined ? {} : {departedAfter}}, signal));
        const heldWindow = {after, through: pass.heldThrough};
        let departed = {listed: pass.departed, window: {after: departedAfter, through: pass.departedThrough}};
        const within = ({listed, window}: typeof departed) => listed.every(objectId => hostedWindowCovers(window, objectId));
        if (!pass.held.every(hold => hostedWindowCovers(heldWindow, hold.objectId)) || !within(departed)) {
          throw new Error("hosted sync.pullHosted result: documents before where their list starts");
        }
        const sharingDeclined = [...pass.sharingDeclined];
        // A pass that adopted a scope, or whose scope moved, applied nothing: pull again.
        let committed = false, hasMore = true, retirement: HostedSyncMethodResultMap["sync.commitCursor"]["retirement"] = null;
        const pendingCursor = pass.pendingCursor;
        if (pendingCursor) {
          decodeHostedSyncResult("sync.materializePendingCursor",
            await this.#request("sync.materializePendingCursor", {pendingCursor}, signal));
          this.#check(signal);
          const commit = decodeHostedSyncResult("sync.commitCursor", await this.#request("sync.commitCursor", {pendingCursor}, signal));
          ({committed, retirement} = commit);
          // Its list starts where the pass's did. Unread, the pass's stands: only a retirement removes a document from it.
          if (commit.departed) {
            departed = {listed: commit.departed, window: {after: departedAfter, through: commit.departedThrough}};
            if (!within(departed)) throw new Error("hosted sync.commitCursor result: documents before where their list starts");
          }
          hasMore = !committed || pass.hasMore || commit.hasMore;
          sharingDeclined.push(...commit.sharingDeclined);
        }
        const page = {committed, adoptedScope: !pendingCursor, fetched: pass.fetched, applied: pass.applied, refused: pass.refused, skipped: pass.skipped,
          conflictsOpened: pass.conflictsOpened, refusals: pass.refusals, sharingDeclined, changedPaths: pass.changedPaths.map(row => row.path),
          omitted: {refusals: pass.refusalsOmitted, sharingDeclined: pass.sharingDeclinedOmitted, changedPaths: pass.changedPathsOmitted},
          held: pass.held, heldWindow, newlyHeld: {listed: pass.newlyHeld, complete: !unheard && pass.newlyHeldOmitted === 0}, departed};
        pages.push(page);
        onPage?.(page);
        // A pass that adopted a scope says nothing of any document, so what an earlier one never said waits for the next.
        this.#unheard = page.adoptedScope && unheard;
        this.#heldAfter = pass.heldThrough ?? undefined;
        this.#departedAfter = departed.window.through ?? undefined;
        this.#departedNone = departedAfter === undefined && departed.window.through === null && departed.listed.length === 0;
        if (retirement) throw new Error(`Hosted retirement failed: ${retirement.message}`);
        if (!hasMore) return {hasMore: false, pages};
      }
      return {hasMore: true, pages};
    });
  }
  async #push(signal: AbortSignal) {
    const result = decodeHostedSyncResult("sync.push", await this.#request("sync.push", {}, signal));
    return {pushed: result.pushed, hasMore: result.hasMore, sharingDeclined: result.sharingDeclined,
      admissionPending: result.ownerAdmissionPending.length > 0};
  }
  async push(callerSignal?: AbortSignal) {
    return this.#run(callerSignal, async signal => {
      const {admissionPending, ...page} = await this.#push(signal);
      if (admissionPending) throw new Error("Hosted publication is waiting for owner admission.");
      return page;
    });
  }
  /**
   * Pushes up to maxPagesPerPull pages, stopping once a page pushes nothing or
   * waits for owner admission. The caller checks what it needed reached the relay.
   */
  async publish(callerSignal?: AbortSignal) {
    return this.#run(callerSignal, async signal => {
      let pushed = 0, hasMore = true;
      for (let index = 0; index < this.#config.maxPagesPerPull && hasMore; index++) {
        const page = await this.#push(signal);
        pushed += page.pushed; hasMore = page.hasMore;
        if (page.pushed === 0 || page.admissionPending) break;
      }
      return {pushed, hasMore};
    });
  }
}
