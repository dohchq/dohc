import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import {
  parseLiveDocumentKey,
  type LiveDocumentKey,
  type LiveUpdateReceipt,
} from "@dohc/live-session-contract/live-update-admission";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import type { SyncRelayStorage, LiveHostConnectionCoordinate } from "./storage";
import {
  createLiveJournalHistoryAuthority,
  type LiveJournalHistoryAuthority,
} from "./storage/liveJournalHistory";
import { LiveCommittedDeliveryStore } from "./storage/liveCommittedDelivery";
import { snapshotHostCoordinate } from "./liveTicketInputs";
import {cancelStopRestore, deliverStopRestore, snapshotStopRestoreLookup} from "./liveRestoreDelivery";
import type {StopRestoreLookup} from "./storage/liveRestoreOperation";
import type {LiveRestorePreparation} from "./liveRestorePreparation";
import {LiveHostRegistrations, sameLiveHostDocument} from "./liveHostRegistration";
import {settlementResponse, settlementPending, type SettlementOutcome} from "./liveSettlement";
export { createLiveJournalHistoryAuthority, type LiveJournalHistoryAuthority };

export type CommittedDeliveryOutcome =
  | { kind: "done"; terminalReceipt: LiveUpdateReceipt | null }
  | { kind: "pending"; reason: string };

/** Private configured-host consumer; the caller supplies an authenticated, provisioned connection. */
export class LiveCommittedDelivery {
  readonly #store: LiveCommittedDeliveryStore;
  readonly #active = new Set<string>();
  readonly #registrations: LiveHostRegistrations;
  readonly #connection: {
    readonly client: EngineClient;
    readonly workspace: string;
    readonly host: LiveHostConnectionCoordinate;
    readonly deadlineMs: number;
    readonly nextRequestId: () => number;
    readonly restore?: LiveRestorePreparation;
  };
  constructor(
    storage: SyncRelayStorage,
    history: LiveJournalHistoryAuthority,
    connection: {
      client: EngineClient;
      workspace: string;
      host: LiveHostConnectionCoordinate;
      deadlineMs: number;
      nextRequestId(): number;
      restore?: LiveRestorePreparation;
    },
  ) {
    if (
      !Number.isSafeInteger(connection.deadlineMs) ||
      connection.deadlineMs < 1 ||
      connection.deadlineMs > 0xffff_ffff
    ) {
      throw new TypeError(
        "Committed delivery requires an explicit positive request deadline.",
      );
    }
    this.#connection = Object.freeze({
      client: connection.client,
      workspace: connection.workspace,
      host: Object.freeze(snapshotHostCoordinate(connection.host)),
      deadlineMs: connection.deadlineMs,
      nextRequestId: connection.nextRequestId.bind(connection),
      restore: connection.restore,
    });
    this.#store = storage.createLiveCommittedDeliveryStore(history);
    this.#registrations = new LiveHostRegistrations(this.#connection);
  }
  captureRegistration(binding: LiveObjectBinding) { return this.#registrations.capture(binding); }
  get workspace() { return this.#connection.workspace; }
  async drain(
    document: LiveDocumentKey,
    signal?: AbortSignal,
  ): Promise<CommittedDeliveryOutcome> {
    document = parseLiveDocumentKey(document);
    const key = JSON.stringify([
      document.workspaceId,
      document.mainVersionId,
      document.objectId,
      document.lineageClaimId,
    ]);
    if (this.#active.has(key))
      throw new Error("A committed delivery drain already owns this document.");
    this.#active.add(key);
    let drain: ReturnType<LiveCommittedDeliveryStore["open"]> | undefined;
    const aborted = () => {
      if (signal?.aborted) throw signal.reason;
    };
    try {
      aborted();
      drain = this.#store.open({ host: this.#connection.host, document });
      let registration = await this.#registrations.ensure(drain.baseline.binding, signal);
      // A materialized settlement released the host's author coverage, and nothing applied since.
      let settledSinceApply = false;
      for (;;) {
        aborted();
        const next = this.#store.next(drain);
        if (next.kind === "done") return next;
        const binding =
          next.kind === "bootstrap"
            ? next.baseline.binding
            : next.admitted.metadata.accepted.binding;
        if (
          !sameLiveHostDocument(registration.binding, binding)
        ) {
          registration = await this.#registrations.ensure(binding, signal);
          aborted();
          // Re-read current authority and progress after the registration await.
          continue;
        }
        const request = {
          id: this.#connection.nextRequestId(),
          workspace: this.#connection.workspace,
          registrationId: registration.id,
          deadlineMs: this.#connection.deadlineMs,
        };
        const response =
          next.kind === "bootstrap"
            ? await this.#connection.client.sendLiveBootstrap(
                request,
                next.baseline,
                signal,
              )
            : await this.#connection.client.sendLiveApplication(
                request,
                next.admitted,
                signal,
              );
        aborted();
        const result = response.result as {
          status?: unknown;
          ack?: unknown;
          reason?: unknown;
        };
        if (result?.status === "pending") {
          if (typeof result.reason !== "string")
            throw new Error("Invalid committed delivery pending result.");
          if (result.reason === "settlement-required" && next.kind !== "bootstrap") {
            // The host's author coverage is full. Settle once through what it
            // applied, then offer the identical event again.
            if (settledSinceApply) throw new Error("The host still requires settlement after settling everything it applied.");
            const settled = await settlementResponse(this.#connection.client.sendRequest({ id: this.#connection.nextRequestId(), method: "liveApplication.settle",
              workspace: this.#connection.workspace, params: { registrationId: registration.id, terminalReceipt: next.predecessor ? { ...next.predecessor } : null },
              deadlineMs: this.#connection.deadlineMs }, signal), next.predecessor);
            aborted();
            if (settlementPending(settled)) return settled;
            // Its file write has not landed; the next pass retries after it does.
            if (!settled.materialized) return { kind: "pending", reason: "settlement-materialization-pending" };
            settledSinceApply = true;
            continue;
          }
          return { kind: "pending", reason: result.reason };
        }
        if (next.kind === "bootstrap") {
          if (result?.status !== "bootstrapped")
            throw new Error("Invalid durable bootstrap acknowledgement.");
          this.#store.acknowledgeBootstrap(drain, result.ack);
        } else {
          if (result?.status !== "applied")
            throw new Error("Invalid durable application acknowledgement.");
          this.#store.acknowledge(drain, next.predecessor, result.ack);
        }
        settledSinceApply = false;
      }
    } finally {
      if (drain) this.#store.close(drain);
      this.#active.delete(key);
    }
  }

  documentForRestore(value: StopRestoreLookup): LiveDocumentKey {
    const lookup = snapshotStopRestoreLookup(value);
    return parseLiveDocumentKey(this.#store.stopRestoreDocument({...lookup, host: this.#connection.host}));
  }
  async stopRestore(value: StopRestoreLookup, signal?: AbortSignal) {
    const lookup = snapshotStopRestoreLookup(value), document = this.documentForRestore(lookup);
    const key = JSON.stringify([document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId]);
    if (this.#active.has(key)) throw new Error("A committed delivery operation already owns this document.");
    this.#active.add(key);
    this.#registrations.invalidate(document.objectId);
    try {return await deliverStopRestore({store: this.#store, lookup, connection: this.#connection, deliveryKind: "bootstrap", signal});}
    finally {this.#active.delete(key);}
  }

  async prepareRestore(value: StopRestoreLookup, signal?: AbortSignal) {
    const restore = this.#connection.restore;
    if (!restore) throw new Error("Restore preparation is not configured on this host.");
    const lookup = snapshotStopRestoreLookup(value), document = this.documentForRestore(lookup);
    const key = JSON.stringify([document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId]);
    if (this.#active.has(key)) throw new Error("A committed delivery operation already owns this document.");
    this.#active.add(key);
    this.#registrations.invalidate(document.objectId);
    try {return await restore.prepare({store: this.#store, lookup, connection: this.#connection, deliveryKind: "bootstrap", signal});}
    finally {this.#active.delete(key);}
  }

  async reviewRestore(value: StopRestoreLookup, signal?: AbortSignal) {
    const restore = this.#connection.restore;
    if (!restore) throw new Error("Restore preparation is not configured on this host.");
    const lookup = snapshotStopRestoreLookup(value), document = this.documentForRestore(lookup);
    const key = JSON.stringify([document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId]);
    if (this.#active.has(key)) throw new Error("A restore operation already owns this document.");
    this.#active.add(key);
    try {return await restore.review({store: this.#store, lookup, connection: this.#connection, deliveryKind: "bootstrap", signal});}
    finally {this.#active.delete(key);}
  }

  async confirmRestore(value: StopRestoreLookup, proposalDigest: string, signal?: AbortSignal) {
    const restore = this.#connection.restore;
    if (!restore) throw new Error("Restore preparation is not configured on this host.");
    const lookup = snapshotStopRestoreLookup(value), document = this.documentForRestore(lookup);
    const key = JSON.stringify([document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId]);
    if (this.#active.has(key)) throw new Error("A restore operation already owns this document.");
    this.#active.add(key);
    try {return await restore.confirm({store: this.#store, lookup, connection: this.#connection, deliveryKind: "bootstrap", signal}, proposalDigest);}
    finally {this.#active.delete(key);}
  }

  async declineRestore(value: StopRestoreLookup, signal?: AbortSignal) {
    const lookup = snapshotStopRestoreLookup(value), document = this.documentForRestore(lookup);
    const key = JSON.stringify([document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId]);
    if (this.#active.has(key)) throw new Error("A restore operation already owns this document.");
    this.#active.add(key);
    try {return await cancelStopRestore({store: this.#store, lookup, connection: this.#connection, signal});}
    finally {this.#active.delete(key);}
  }

  async completeRestore(value: StopRestoreLookup, proposalDigest: string, signal?: AbortSignal) {
    const restore = this.#connection.restore;
    if (!restore) throw new Error("Restore preparation is not configured on this host.");
    const lookup = snapshotStopRestoreLookup(value), document = this.documentForRestore(lookup);
    const key = JSON.stringify([document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId]);
    if (this.#active.has(key)) throw new Error("A committed delivery operation already owns this document.");
    this.#active.add(key);
    this.#registrations.invalidate(document.objectId);
    try {return await restore.complete({store: this.#store, lookup, connection: this.#connection, deliveryKind: "bootstrap", signal}, proposalDigest);}
    finally {this.#active.delete(key);}
  }

  async settle(document: LiveDocumentKey, signal?: AbortSignal): Promise<SettlementOutcome> {
    document = parseLiveDocumentKey(document);
    const key = JSON.stringify([document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId]);
    if (this.#active.has(key)) throw new Error("A committed delivery operation already owns this document.");
    this.#active.add(key);
    let drain;
    const aborted = () => { if (signal?.aborted) throw signal.reason; };
    try {
      aborted();
      drain = this.#store.openSettlement({ host: this.#connection.host, document });
      const captured = this.#store.settlement(drain);
      const registration = await this.#registrations.ensure(captured.binding, signal);
      aborted();
      this.#store.settlement(drain);
      const registrationId = registration.id;
      const response = await settlementResponse(this.#connection.client.sendRequest({ id: this.#connection.nextRequestId(), method: "liveApplication.settle", workspace: this.#connection.workspace, params: { registrationId, terminalReceipt: captured.terminalReceipt ? { ...captured.terminalReceipt } : null }, deadlineMs: this.#connection.deadlineMs }, signal), captured.terminalReceipt);
      aborted();
      this.#store.settlement(drain);
      return response;
    } finally {
      if (drain) this.#store.close(drain);
      this.#active.delete(key);
    }
  }
}
