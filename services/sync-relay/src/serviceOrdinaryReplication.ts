import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import type { SharingDeclined } from "@dohc/workspace-contracts/relay";

export interface ServiceOrdinaryReplicationConfig {
  readonly relay: { readonly baseUrl: string; readonly bearerToken: string };
  readonly identity: { readonly kind: "claim" } | {
    readonly kind: "join"; readonly replicationEpoch: string; readonly streamIdentity: string;
  };
  readonly maxPagesPerPull: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ordinary replication response.");
  return value as Record<string, unknown>;
}
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = record(value);
  if (keys.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !keys.includes(key))) {
    throw new Error("Invalid ordinary replication configuration.");
  }
  return row;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Invalid ordinary replication field.");
  }
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error("Invalid ordinary replication count.");
  return value;
}

/** Private operator inputs; the relay authenticates the supplied owner credential. */
export function parseServiceOrdinaryReplicationConfig(value: unknown): ServiceOrdinaryReplicationConfig | undefined {
  if (value === undefined) return undefined;
  const row = fields(value, ["relay", "identity", "maxPagesPerPull"]);
  const relay = fields(row.relay, ["baseUrl", "bearerToken"]);
  const baseUrl = text(relay.baseUrl);
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error("Invalid ordinary relay URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid ordinary relay URL.");
  const rawIdentity = record(row.identity);
  let identity: ServiceOrdinaryReplicationConfig["identity"];
  if (rawIdentity.kind === "claim") {
    fields(rawIdentity, ["kind"]);
    identity = Object.freeze({kind: "claim"});
  } else if (rawIdentity.kind === "join") {
    fields(rawIdentity, ["kind", "replicationEpoch", "streamIdentity"]);
    identity = Object.freeze({kind: "join", replicationEpoch: text(rawIdentity.replicationEpoch), streamIdentity: text(rawIdentity.streamIdentity)});
  } else throw new Error("Invalid ordinary relay identity.");
  const maxPagesPerPull = integer(row.maxPagesPerPull, 1);
  return Object.freeze({relay: Object.freeze({baseUrl, bearerToken: text(relay.bearerToken)}), identity, maxPagesPerPull});
}

interface OrdinaryRefusal {
  readonly workspaceId: string; readonly originId: string; readonly originSeq: number;
  readonly opKind: string; readonly code: string; readonly reason: string;
}
export interface ServiceOrdinaryPullPage {
  readonly nextCursor: number;
  readonly fetched: number; readonly applied: number; readonly refused: number; readonly skipped: number; readonly conflictsOpened: number;
  readonly refusals: readonly OrdinaryRefusal[];
  readonly sharingDeclined: readonly SharingDeclined[];
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid ordinary replication list.");
  return value;
}
function declines(value: unknown): SharingDeclined[] {
  return array(value).map(value => {
    const row = record(value);
    return {path: text(row.path), constraint: text(row.constraint), limitBytes: integer(row.limitBytes), observedBytes: integer(row.observedBytes)};
  });
}
/** One pass at a time. Native materialization must finish before the cursor commits. */
export class ServiceOrdinaryReplication {
  readonly #config: ServiceOrdinaryReplicationConfig;
  #initialized = false;
  #running = false;
  constructor(readonly connection: {
    client: Pick<EngineClient, "sendRequest">; workspace: string; workspaceId: string;
    nextRequestId(): number; deadlineMs: number; signal: AbortSignal; assertCurrent(): void;
  }, config: ServiceOrdinaryReplicationConfig) {
    this.#config = parseServiceOrdinaryReplicationConfig(config)!;
  }
  #check(signal: AbortSignal): void { signal.throwIfAborted(); this.connection.assertCurrent(); }
  async #request(method: string, params: Record<string, string | {kind: string; token: string}>, signal: AbortSignal) {
    this.#check(signal);
    const c = this.connection;
    const response = await c.client.sendRequest({id: c.nextRequestId(), workspace: c.workspace,
      deadlineMs: c.deadlineMs, method, params: {workspaceId: c.workspaceId, ...params}}, signal);
    this.#check(signal);
    return record(response.result);
  }
  async #run<T>(callerSignal: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#running) throw new Error("Ordinary replication is already running.");
    this.#running = true;
    const signal = callerSignal ? AbortSignal.any([this.connection.signal, callerSignal]) : this.connection.signal;
    try {
      this.#check(signal);
      if (!this.#initialized) {
        const identity = this.#config.identity;
        const joined = identity.kind === "join";
        const result = await this.#request(joined ? "sync.adoptJoinIdentity" : "sync.claim",
          joined ? {replicationEpoch: identity.replicationEpoch, streamIdentity: identity.streamIdentity} : {}, signal);
        if (result[joined ? "adopted" : "claimed"] !== true) throw new Error("Ordinary relay identity setup did not complete.");
        this.#initialized = true;
      }
      return await task(signal);
    } finally { this.#running = false; }
  }
  async pull(callerSignal?: AbortSignal) {
    return this.#run(callerSignal, async signal => {
      const pages: ServiceOrdinaryPullPage[] = [];
      let previous: number | undefined;
      for (let index = 0; index < this.#config.maxPagesPerPull; index++) {
        const result = await this.#request("sync.pull", {}, signal);
        if (result.status !== "complete" || typeof result.hasMore !== "boolean") throw new Error("Ordinary pull did not complete.");
        const nextCursor = integer(result.nextCursor);
        if (previous !== undefined && (nextCursor < previous || (result.hasMore && nextCursor === previous))) {
          throw new Error("Ordinary pull made no cursor progress.");
        }
        const pending = fields(result.pendingCursor, ["kind", "token"]);
        if (pending.kind !== "relay") throw new Error("Ordinary pull returned a foreign cursor.");
        const cursor = {kind: "relay", token: text(pending.token)};
        const page = {nextCursor, fetched: integer(result.fetched), applied: integer(result.applied), refused: integer(result.refused),
          skipped: integer(result.skipped), conflictsOpened: integer(result.conflictsOpened),
          refusals: array(result.refusals).map(value => {
            const row = record(value);
            return {workspaceId: text(row.workspaceId), originId: text(row.originId), originSeq: integer(row.originSeq),
              opKind: text(row.opKind), code: text(row.code), reason: text(row.reason)};
          }), sharingDeclined: declines(result.sharingDeclined)};
        const materialized = await this.#request("sync.materializePendingCursor", {pendingCursor: cursor}, signal);
        if (materialized.materialized !== true) throw new Error("Ordinary workspace materialization did not complete.");
        this.#check(signal);
        const committed = await this.#request("sync.commitCursor", {pendingCursor: cursor}, signal);
        if (committed.committed !== true) throw new Error("Ordinary relay cursor did not commit.");
        page.sharingDeclined.push(...declines(committed.sharingDeclined));
        pages.push(page);
        previous = nextCursor;
        if (!result.hasMore) return {nextCursor, hasMore: false, pages};
      }
      return {nextCursor: previous!, hasMore: true, pages};
    });
  }
  async push(callerSignal?: AbortSignal) {
    return this.#run(callerSignal, async signal => {
      const result = await this.#request("sync.push", {}, signal);
      if (result.status !== "complete" || typeof result.hasMore !== "boolean") throw new Error("Ordinary push did not complete.");
      if (array(result.ownerAdmissionPending).length > 0) throw new Error("Ordinary publication is waiting for owner admission.");
      return {pushed: integer(result.pushed), hasMore: result.hasMore, sharingDeclined: declines(result.sharingDeclined)};
    });
  }
}
