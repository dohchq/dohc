import { isDeepStrictEqual } from "node:util";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import {
  parseLiveDocumentKey,
  parseLiveUpdateDigest,
  parseLiveUpdateIdentifier,
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
export { createLiveJournalHistoryAuthority, type LiveJournalHistoryAuthority };

export type CommittedDeliveryOutcome =
  | { kind: "done"; terminalReceipt: LiveUpdateReceipt | null }
  | { kind: "pending"; reason: string };

export interface CommittedSettlement {
  settlementId: string;
  previousCursor: number;
  terminalCursor: number;
  applicationCount: number;
  localYDocSequence: number;
  momentId: string;
  markdownDigest: string;
  materialized: boolean;
}

export function settlementResult(value: unknown, terminal: LiveUpdateReceipt | null): CommittedSettlement {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native settlement response.");
  const response = value as Record<string, unknown>;
  if (Object.keys(response).sort().join() !== "settlement,status" || response.status !== "settled" || !response.settlement || typeof response.settlement !== "object" || Array.isArray(response.settlement)) throw new Error("Invalid native settlement response.");
  const row = response.settlement as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== "applicationCount,localYDocSequence,markdownDigest,materialized,momentId,previousCursor,settlementId,terminalCursor") throw new Error("Invalid native settlement fields.");
  for (const key of ["previousCursor", "terminalCursor", "applicationCount", "localYDocSequence"]) {
    if (typeof row[key] !== "number" || !Number.isSafeInteger(row[key]) || row[key] < 0) throw new Error("Invalid native settlement integer.");
  }
  if (row.terminalCursor !== (terminal?.journalCursor ?? 0) || Number(row.previousCursor) > Number(row.terminalCursor) || Number(row.applicationCount) > Number(row.terminalCursor) - Number(row.previousCursor) || typeof row.materialized !== "boolean") throw new Error("Native settlement coverage mismatch.");
  return { settlementId: parseLiveUpdateIdentifier(row.settlementId,"settlement ID"), previousCursor: Number(row.previousCursor), terminalCursor: Number(row.terminalCursor), applicationCount: Number(row.applicationCount), localYDocSequence: Number(row.localYDocSequence), momentId: parseLiveUpdateIdentifier(row.momentId,"moment ID"), markdownDigest: parseLiveUpdateDigest(row.markdownDigest), materialized: row.materialized };
}

/** Private configured-host consumer; the caller supplies an authenticated, provisioned connection. */
export class LiveCommittedDelivery {
  readonly #store: LiveCommittedDeliveryStore;
  readonly #active = new Set<string>();
  readonly #connection: {
    readonly client: EngineClient;
    readonly workspace: string;
    readonly host: LiveHostConnectionCoordinate;
    readonly deadlineMs: number;
    readonly nextRequestId: () => number;
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
    });
    this.#store = storage.createLiveCommittedDeliveryStore(history);
  }
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
    let drain;
    const aborted = () => {
      if (signal?.aborted) throw signal.reason;
    };
    try {
      aborted();
      drain = this.#store.open({ host: this.#connection.host, document });
      let registration: { id: number; binding: LiveObjectBinding } | undefined;
      for (;;) {
        aborted();
        const next = this.#store.next(drain);
        if (next.kind === "done") return next;
        const binding =
          next.kind === "bootstrap"
            ? next.baseline.binding
            : next.admitted.metadata.accepted.binding;
        if (
          !registration ||
          !isDeepStrictEqual(registration.binding, binding)
        ) {
          const response = await this.#connection.client.sendRequest({
            id: this.#connection.nextRequestId(),
            method: "liveApplication.register",
            workspace: this.#connection.workspace,
            params: {
              binding: {
                ...binding,
                selectorPaths: [...binding.selectorPaths],
              },
            },
            deadlineMs: this.#connection.deadlineMs,
          }, signal);
          aborted();
          const id = (response.result as { registrationId?: unknown })
            ?.registrationId;
          if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
            throw new Error("Invalid committed delivery registration.");
          }
          registration = { id, binding: structuredClone(binding) };
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
      }
    } finally {
      if (drain) this.#store.close(drain);
      this.#active.delete(key);
    }
  }

  async settle(document: LiveDocumentKey, signal?: AbortSignal): Promise<CommittedSettlement> {
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
      const registration = await this.#connection.client.sendRequest({ id: this.#connection.nextRequestId(), method: "liveApplication.register", workspace: this.#connection.workspace, params: { binding: { ...captured.binding, selectorPaths: [...captured.binding.selectorPaths] } }, deadlineMs: this.#connection.deadlineMs }, signal);
      aborted();
      this.#store.settlement(drain);
      const registrationId = (registration.result as {registrationId?: unknown})?.registrationId;
      if (typeof registrationId !== "number" || !Number.isSafeInteger(registrationId) || registrationId < 1) throw new Error("Invalid committed settlement registration.");
      const response = await this.#connection.client.sendRequest({ id: this.#connection.nextRequestId(), method: "liveApplication.settle", workspace: this.#connection.workspace, params: { registrationId, terminalReceipt: captured.terminalReceipt ? { ...captured.terminalReceipt } : null }, deadlineMs: this.#connection.deadlineMs }, signal);
      aborted();
      this.#store.settlement(drain);
      return settlementResult(response.result, captured.terminalReceipt);
    } finally {
      if (drain) this.#store.close(drain);
      this.#active.delete(key);
    }
  }
}
