import { parseLiveDocumentKey, type LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import type { LiveHostConnectionCoordinate, SyncRelayStorage } from "./storage.js";
import type { LiveJournalHistoryAuthority } from "./storage/liveJournalHistory.js";
import { configRecord } from "./deviceLiveHostConfig.js";
import { authorityInteger } from "./storage/liveDocumentAuthority.js";
import {drainOwnerOutbox,type OwnerOutboxAdmission} from "./ownerOutboxDelivery.js";
import {settlementResult,type CommittedSettlement,type CommittedDeliveryOutcome} from "./liveCommittedDelivery.js";
import {isDeepStrictEqual} from "node:util";
import type {LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import {deliverStopRestore, snapshotStopRestoreLookup} from "./liveRestoreDelivery";
import type {StopRestoreLookup} from "./storage/liveRestoreOperation";
import type {LiveRestorePreparation} from "./liveRestorePreparation";
import {LiveHostRegistrations} from "./liveHostRegistration";

type OwnerDeliveryOutcome = CommittedDeliveryOutcome & {continueDrain: boolean};

/** Relay-side delivery to an ordinary desktop owner through its curated bridge. */
export class OwnerCommittedDelivery {
  readonly #store;
  readonly #active = new Set<string>();
  readonly #registrations: LiveHostRegistrations;
  readonly #adopted = new Map<string,{registrationId: number; adoptionId: string; sequence: number; binding: LiveObjectBinding;settled?: CommittedSettlement}>();
  constructor(private readonly storage: SyncRelayStorage,history: LiveJournalHistoryAuthority,private readonly connection: {
    client: EngineClient; workspace: string; host: LiveHostConnectionCoordinate; deadlineMs: number; nextRequestId(): number;
    bounds: { maxBytes: number; maxEvents: number };
    ownerAdmission: OwnerOutboxAdmission;
    restore?: LiveRestorePreparation;
  }) {
    authorityInteger(connection.bounds.maxBytes,1); authorityInteger(connection.bounds.maxEvents,1); authorityInteger(connection.deadlineMs,1);
    this.#store = storage.createLiveCommittedDeliveryStore(history);
    this.#registrations = new LiveHostRegistrations(connection);
  }
  captureRegistration(binding: LiveObjectBinding) { return this.#registrations.capture(binding); }
  captureDocumentRegistration(document: LiveDocumentKey) {
    const saved = this.#adopted.get(JSON.stringify(parseLiveDocumentKey(document)));
    if (!saved) throw new Error("Owner registration is unavailable.");
    return this.#registrations.capture(saved.binding);
  }
  get workspace() { return this.connection.workspace; }
  async #run(value: LiveDocumentKey,settle: false,signal?: AbortSignal): Promise<OwnerDeliveryOutcome>;
  async #run(value: LiveDocumentKey,settle: true,signal?: AbortSignal): Promise<CommittedSettlement>;
  async #run(value: LiveDocumentKey,settle: boolean,signal?: AbortSignal): Promise<OwnerDeliveryOutcome | CommittedSettlement> {
    const document = parseLiveDocumentKey(value), key = JSON.stringify(document), c = this.connection;
    if (this.#active.has(key)) throw new Error("An owner delivery already holds this document.");
    this.#active.add(key);
    const check = () => { if (signal?.aborted) throw signal.reason; };
    const request = () => ({ id: c.nextRequestId(),workspace: c.workspace,deadlineMs: c.deadlineMs });
    try {
      check();
      const shareId = c.ownerAdmission.shares.get(document.workspaceId), share = shareId ? this.storage.getShare(shareId) : null;
      if (!share || share.workspaceId !== document.workspaceId) throw new Error("Owner share is unavailable.");
      const actor = {kind: "owner" as const,userId: share.granterUserId,shareId: share.shareId};
      let saved = this.#adopted.get(key);
      const existing = this.#store.existingOwnerDelivery({host: c.host, document, actor});
      if (existing && (!saved || !isDeepStrictEqual(saved.binding, existing.binding))) {
        this.#registrations.invalidate(document.objectId);
        const progress = this.#store.ownerDeliveryProgress(existing);
        const registered = await c.client.sendRequest({...request(), method: "liveApplication.register", params: {
          binding: {...existing.binding, selectorPaths: [...existing.binding.selectorPaths]}, resumeAdoptionId: progress.adoptionId,
        }}, signal);
        check(); existing.assertCurrent();
        const registration = configRecord(registered.result, [], ["registrationId", "status", "reason"]);
        if (registration.status === "pending" && typeof registration.reason === "string") {
          if (!settle) return {kind: "pending", reason: registration.reason, continueDrain: false};
          throw new Error(registration.reason);
        }
        saved = {registrationId: authorityInteger(configRecord(registered.result, ["registrationId"]).registrationId, 1),
          adoptionId: progress.adoptionId, sequence: progress.sequence, binding: existing.binding};
        this.#adopted.set(key, saved);
        this.#registrations.remember(saved.binding, saved.registrationId);
      }
      if (!saved) {
        this.#registrations.invalidate(document.objectId);
        const current = this.#store.captureOwnerCut({ host: c.host,document,actor,adoptionId: "owner-state-capture",expectedLocalSequence: 0,throughCursor: 0,...c.bounds });
        const registered = await c.client.sendRequest({ ...request(),method: "liveApplication.register",params: { binding: { ...current.binding,selectorPaths: [...current.binding.selectorPaths] } } },signal);
        check(); current.assertCurrent();
        const registrationId = authorityInteger(configRecord(registered.result,["registrationId"]).registrationId,1);
        const stateResponse = await c.client.sendRequest({ ...request(),method: "liveApplication.ownerState",params: { registrationId } },signal);
        check(); current.assertCurrent();
        const state = configRecord(stateResponse.result,["adoptionId","expectedLocalSequence","throughCursor","sessionId"]);
        if (typeof state.adoptionId !== "string" || typeof state.sessionId !== "string") throw new Error("Invalid owner adoption state.");
        const adoptedCut = this.#store.captureOwnerCut({ host: c.host,document,actor,adoptionId: state.adoptionId,
          expectedLocalSequence: authorityInteger(state.expectedLocalSequence),...c.bounds,
          ...(state.throughCursor === null ? {} : { throughCursor: authorityInteger(state.throughCursor) }) });
        const adopted = await c.client.sendLiveOwnerAdoption({ ...request(),registrationId,sessionId: state.sessionId },adoptedCut.cut,c.bounds,signal);
        check(); adoptedCut.assertCurrent();
        const result = configRecord(adopted.result,["status","adoption"]);
        if (result.status !== "adopted") throw new Error("Owner adoption did not commit.");
        this.#store.acknowledgeOwnerAdoption(adoptedCut,result.adoption);
        saved = {registrationId,adoptionId: state.adoptionId,sequence: authorityInteger(state.expectedLocalSequence),binding: adoptedCut.binding};
        this.#adopted.set(key,saved);
        this.#registrations.remember(saved.binding, saved.registrationId);
      }
      const {registrationId} = saved;
      const current = this.#store.openOwnerDelivery({host: c.host,document,actor});
      if (!isDeepStrictEqual(saved.binding,current.binding)) throw new Error("Owner binding requires reconciliation.");
      const outbox = await drainOwnerOutbox({storage: this.storage,admission: c.ownerAdmission,client: c.client,workspace: c.workspace,host: c.host,
        registrationId,binding: saved.binding,nextRequestId: c.nextRequestId,deadlineMs: c.deadlineMs,signal,assertCurrent: current.assertCurrent});
      const latest = this.#store.openOwnerDelivery({host: c.host,document,actor});
      let progress = this.#store.ownerDeliveryProgress(latest);
      let appliedCount = 0;
      for (let count = 0; count < c.bounds.maxEvents; count++) {
        const event = this.#store.nextOwnerApplication(latest); if (!event) break;
        check(); latest.assertCurrent();
        const applied = await c.client.sendLiveApplication({ ...request(),registrationId },event,signal);
        check(); latest.assertCurrent();
        const result = configRecord(applied.result,["status","ack"],["reason"]);
        if (result.status !== "applied") throw new Error("Owner application did not commit.");
        this.#store.acknowledgeOwnerDeliveryApplication(latest,result.ack);
        progress = this.#store.ownerDeliveryProgress(latest);
        appliedCount++;
      }
      if (!settle) return outbox.hasMore || this.#store.nextOwnerApplication(latest)
        ? {kind: "pending",reason: "Owner delivery pass reached its work budget.", continueDrain: outbox.admittedEntries > 0 || appliedCount > 0}
        : { kind: "done",terminalReceipt: progress.terminal, continueDrain: false };
      if (outbox.hasMore) throw new Error("Owner outbox delivery must finish before settlement.");
      if (saved.settled && saved.settled.terminalCursor === (progress.terminal?.journalCursor ?? 0)) return saved.settled;
      const response = await c.client.sendRequest({ ...request(),method: "liveApplication.settle",params: { registrationId,terminalReceipt: progress.terminal ? { ...progress.terminal } : null } },signal);
      check(); latest.assertCurrent();
      const settled = settlementResult(response.result,progress.terminal);
      if (settled.materialized) saved.settled = settled;
      return settled;
    } finally { this.#active.delete(key); }
  }
  drain(document: LiveDocumentKey,signal?: AbortSignal) { return this.#run(document,false,signal); }
  documentForRestore(value: StopRestoreLookup): LiveDocumentKey {
    const lookup = snapshotStopRestoreLookup(value);
    return parseLiveDocumentKey(this.#store.stopRestoreDocument({...lookup, host: this.connection.host}));
  }
  async stopRestore(value: StopRestoreLookup, signal?: AbortSignal) {
    const lookup = snapshotStopRestoreLookup(value), document = parseLiveDocumentKey(this.documentForRestore(lookup));
    const key = JSON.stringify(document);
    if (this.#active.has(key)) throw new Error("An owner delivery already holds this document.");
    this.#active.add(key);
    this.#registrations.invalidate(document.objectId);
    this.#adopted.delete(key);
    try {return await deliverStopRestore({store: this.#store, lookup, connection: this.connection, deliveryKind: "owner", signal});}
    finally {this.#active.delete(key);}
  }
  settle(document: LiveDocumentKey,signal?: AbortSignal) { return this.#run(document,true,signal); }
  async prepareRestore(value: StopRestoreLookup, signal?: AbortSignal) {
    const restore = this.connection.restore;
    if (!restore) throw new Error("Restore preparation is not configured on this host.");
    const lookup = snapshotStopRestoreLookup(value), document = parseLiveDocumentKey(this.documentForRestore(lookup));
    const key = JSON.stringify(document);
    if (this.#active.has(key)) throw new Error("An owner delivery already holds this document.");
    this.#active.add(key);
    this.#registrations.invalidate(document.objectId);
    this.#adopted.delete(key);
    try {return await restore.prepare({store: this.#store, lookup, connection: this.connection, deliveryKind: "owner", signal});}
    finally {this.#active.delete(key);}
  }
  async completeRestore(value: StopRestoreLookup, proposalDigest: string, signal?: AbortSignal) {
    const restore = this.connection.restore;
    if (!restore) throw new Error("Restore preparation is not configured on this host.");
    const lookup = snapshotStopRestoreLookup(value), document = parseLiveDocumentKey(this.documentForRestore(lookup));
    const key = JSON.stringify(document);
    if (this.#active.has(key)) throw new Error("An owner delivery already holds this document.");
    this.#active.add(key);
    this.#registrations.invalidate(document.objectId);
    this.#adopted.delete(key);
    try {
      return await restore.complete({store: this.#store, lookup, connection: this.connection, deliveryKind: "owner", signal}, proposalDigest);
    } finally {this.#active.delete(key);}
  }
}
