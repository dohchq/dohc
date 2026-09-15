import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { EngineClient, NativeAppliedPosition } from "@dohc/workspace-engine-client/daemon";
import { parseRedeemedLiveTicket, type RedeemedLiveTicket } from "@dohc/live-session-contract/live-ticket";
import { parseLiveUpdateDigest, parseLiveUpdateIdentifier, parseServerDerivedLiveUpdateAuthority, type ServerDerivedLiveUpdateAuthority, type LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import type { LiveFrameLease } from "@dohc/live-session-contract/live-frame";
import { parseLiveObjectBinding, type LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import type { CurrentLiveBindingRequest, LiveHostConnectionCoordinate, SyncRelayStorage } from "./storage.js";
import { snapshotCurrentBindingRequest } from "./storage/liveDocumentAuthority.js";
import type { OwnerOutboxAdmission } from "./ownerOutboxDelivery.js";
import type { NamedFrameAppliedUpdate, NamedFrameHostSession, NamedFrameSync } from "./namedLiveFrameSession.js";
import type { NamedFrameChanges } from "./liveHostChanges.js";
export { createNamedFrameChanges, type NamedFrameChanges } from "./liveHostChanges.js";

export interface NamedFrameNativeHost {
  readonly client: Pick<EngineClient, "openLiveAppliedSync" | "readNextLiveApplied" | "readLiveApplicationAck">;
  readonly workspace: string;
  readonly registrationId: number;
  readonly coordinate: LiveHostConnectionCoordinate;
  readonly binding: LiveObjectBinding;
  readonly invalidated: AbortSignal;
  readonly changes: NamedFrameChanges;
  readonly deadlineMs: number;
  nextRequestId(): number;
  /** Uses the existing service/device delivery consumer and signals shared changes on completion. */
  drain(document: LiveDocumentKey, signal: AbortSignal): Promise<unknown>;
}
export interface NamedFrameHostBounds {
  readonly maxClientVectorBytes: number;
  readonly maxSyncOutputBytes: number;
  readonly maxAppliedUpdateBytes: number;
  readonly maxSubmissionBytes: number;
  readonly maxAdmissionBytes: number;
}

/** Wraps an established authenticated native registration. It never owns host retirement. */
export function captureNamedLiveFrameHost(options: {
  ticket: RedeemedLiveTicket;
  actor: CurrentLiveBindingRequest["actor"];
  storage: SyncRelayStorage;
  native: NamedFrameNativeHost;
  bounds: NamedFrameHostBounds;
  validate: OwnerOutboxAdmission["validate"];
}): NamedFrameHostSession & {readonly ticket: RedeemedLiveTicket} {
  const ticket = parseRedeemedLiveTicket(options.ticket);
  Object.freeze(ticket.binding.selectorPaths);
  Object.freeze(ticket.binding);
  Object.freeze(ticket.authority);
  Object.freeze(ticket);
  if (ticket.authority.principalKind !== "named" && ticket.authority.principalKind !== "link") throw new TypeError("Invalid live host capture.");
  return { ...captureLiveFrameHost({...options, binding: ticket.binding, authority: ticket.authority, hostEpoch: ticket.hostEpoch}), ticket };
}

/** The owner route supplies the authenticated account, never an identity from a frame. */
export function captureOwnerLiveFrameHost(options: {
  authenticatedUserId: string;
  shareId: string;
  storage: SyncRelayStorage;
  native: NamedFrameNativeHost;
  bounds: NamedFrameHostBounds;
  validate: OwnerOutboxAdmission["validate"];
}): NamedFrameHostSession {
  const binding = parseLiveObjectBinding(options.native.binding);
  const document = {workspaceId: binding.workspaceId, mainVersionId: binding.mainVersionId,
    objectId: binding.objectId, lineageClaimId: binding.lineageClaimId};
  const request = snapshotCurrentBindingRequest({document,
    actor: {kind: "owner", userId: options.authenticatedUserId, shareId: options.shareId}});
  const current = options.storage.resolveCurrentLiveDocumentBinding(request);
  if (current.kind !== "current") throw new Error("Owner live authority is unavailable.");
  return captureLiveFrameHost({...options, actor: request.actor, binding: current.binding,
    authority: current.authority, hostEpoch: current.host.hostEpoch});
}

function captureLiveFrameHost(options: {
  actor: CurrentLiveBindingRequest["actor"];
  binding: LiveObjectBinding;
  authority: ServerDerivedLiveUpdateAuthority;
  hostEpoch: NamedFrameNativeHost["coordinate"]["hostEpoch"];
  storage: SyncRelayStorage;
  native: NamedFrameNativeHost;
  bounds: NamedFrameHostBounds;
  validate: OwnerOutboxAdmission["validate"];
}): NamedFrameHostSession {
  const binding = parseLiveObjectBinding(options.binding);
  Object.freeze(binding.selectorPaths); Object.freeze(binding);
  const authority = Object.freeze(parseServerDerivedLiveUpdateAuthority(options.authority));
  const hostEpoch = options.hostEpoch;
  const { storage } = options;
  const original = options.native;
  const native = { ...original, coordinate: { ...original.coordinate }, binding: parseLiveObjectBinding(original.binding),
    nextRequestId: original.nextRequestId.bind(original), drain: original.drain.bind(original) };
  const bounds = { ...options.bounds };
  const validate = options.validate;
  for (const value of [bounds.maxClientVectorBytes, bounds.maxSyncOutputBytes, bounds.maxAppliedUpdateBytes,
    bounds.maxSubmissionBytes, bounds.maxAdmissionBytes, native.registrationId, native.deadlineMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Invalid named native frame bound.");
  }
  if (native.deadlineMs > 0xffff_ffff) throw new TypeError("Invalid live host capture.");
  if (bounds.maxSyncOutputBytes < 2 || bounds.maxAppliedUpdateBytes < 2) throw new TypeError("Invalid named native frame bound.");
  for (const field of ["workspaceId", "mainVersionId", "objectId", "lineageClaimId", "currentPath", "restoreFenceGeneration"] as const) {
    if (native.binding[field] !== binding[field]) throw new Error("Native registration binding changed.");
  }
  const document: LiveDocumentKey = { workspaceId: binding.workspaceId, mainVersionId: binding.mainVersionId,
    objectId: binding.objectId, lineageClaimId: binding.lineageClaimId };
  const actor = Object.freeze(snapshotCurrentBindingRequest({ document, actor: options.actor }).actor);
  if (actor.kind !== authority.principalKind) throw new TypeError("Live host actor kind changed.");
  const standing = storage.captureStanding();
  const lifetime = new AbortController();
  let opened = false, submitting = false;
  let unsubscribe: (() => void) | undefined;
  const close = () => {
    lifetime.abort(new Error("Named host capture closed."));
    unsubscribe?.(); unsubscribe = undefined;
    native.invalidated.removeEventListener("abort", close);
    storage.unavailable.removeEventListener("abort", close);
  };
  function check(caller?: AbortSignal) {
    caller?.throwIfAborted(); lifetime.signal.throwIfAborted();
    try {
      standing();
      const current = storage.resolveCurrentLiveDocumentBinding({ document, actor });
      if (native.invalidated.aborted || current.kind !== "current" || hostEpoch !== native.coordinate.hostEpoch ||
        !isDeepStrictEqual(current.binding, binding) || !isDeepStrictEqual(current.authority, authority) ||
        !isDeepStrictEqual(current.host, native.coordinate)) throw new Error("Named host standing changed.");
    } catch (error) { close(); throw error; }
  }
  const request = () => ({ id: native.nextRequestId(), workspace: native.workspace, registrationId: native.registrationId, deadlineMs: native.deadlineMs });
  const signalFor = (caller: AbortSignal) => AbortSignal.any([caller, lifetime.signal]);
  native.invalidated.addEventListener("abort", close, { once: true });
  storage.unavailable.addEventListener("abort", close, { once: true });
  try {
    unsubscribe = native.changes.subscribe(() => { try { check(); } catch { /* check invalidates this capture. */ } });
    check();
  } catch (error) { close(); throw error; }

  function pendingChange(signal: AbortSignal) {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    const remove = native.changes.subscribe(resolve, document);
    signal.addEventListener("abort", resolve, { once: true });
    if (signal.aborted) resolve();
    return { promise, dispose() { remove(); signal.removeEventListener("abort", resolve); } };
  }
  return {
    hostEpoch, invalidated: lifetime.signal, assertCurrent: () => check(), close,
    async openSync(clientVector, caller): Promise<NamedFrameSync> {
      check(caller);
      if (opened || clientVector.byteLength > bounds.maxClientVectorBytes) throw new Error("Named sync is unavailable.");
      opened = true;
      const signal = signalFor(caller);
      await native.drain(document, signal); check(signal);
      const initial = await native.client.openLiveAppliedSync(request(), clientVector,
        { maxInputBytes: bounds.maxClientVectorBytes, maxOutputBytes: bounds.maxSyncOutputBytes }, signal);
      check(signal);
      if (!isDeepStrictEqual(initial.binding, native.binding)) { close(); throw new Error("Native sync binding changed."); }
      let position: NativeAppliedPosition = { ...initial.position };
      let held = false, pulling = false;
      const feed = new AbortController();
      const feedSignal = AbortSignal.any([signal, feed.signal]);
      return {
        binding, hostVector: initial.hostVector, missingStateUpdate: initial.missingStateUpdate,
        appliedThroughJournalCursor: position.journalCursor,
        close() { feed.abort(); },
        async nextApplied(callerSignal): Promise<LiveFrameLease<NamedFrameAppliedUpdate>> {
          const signal = AbortSignal.any([feedSignal, callerSignal]);
          check(signal);
          if (held || pulling) throw new Error("An applied read already owns output.");
          pulling = true;
          try {
            for (;;) {
              // Arm before reading. A commit during an empty read resolves this same wake.
              const changed = pendingChange(signal);
              try {
                const next = await native.client.readNextLiveApplied(request(), position, bounds.maxAppliedUpdateBytes, signal);
                check(signal);
                if (next) {
                  if (next.position.eventCount !== position.eventCount + 1 || next.position.journalCursor <= position.journalCursor ||
                    next.ack.journalCursor !== next.position.journalCursor) throw new Error("Native applied cursor changed.");
                  position = { ...next.position };
                  held = true;
                  let released = false;
                  return { value: { journalCursor: next.position.journalCursor, updateBytes: next.updateBytes },
                    release() { if (!released) { released = true; held = false; } } };
                }
                await changed.promise; check(signal);
              } finally { changed.dispose(); }
            }
          } finally { pulling = false; }
        },
      };
    },
    async submit(input, caller) {
      check(caller);
      if (submitting) throw new Error("A named submission already owns admission.");
      submitting = true;
      const signal = signalFor(caller);
      try {
        const deliveryId = parseLiveUpdateIdentifier(input.deliveryId), updateDigest = parseLiveUpdateDigest(input.updateDigest);
        const updateBytes = input.updateBytes;
        if (updateBytes.length < 1 || updateBytes.length > bounds.maxSubmissionBytes) return { result: "refused", reason: "capacity-refused" };
        if (createHash("sha256").update(updateBytes).digest("hex") !== updateDigest) return { result: "refused", reason: "invalid-update" };
        const read = storage.readLiveUpdateJournalCut({ document });
        if (read.kind !== "cut") return { result: "refused", reason: read.reason };
        const cut = read.cut;
        if (cut.checkpoint.bytes.length + cut.suffix.reduce((sum, row) => sum + row.bytes.length, updateBytes.length) > bounds.maxAdmissionBytes) {
          return { result: "refused", reason: "capacity-refused" };
        }
        const validation = validate({ document, currentPath: binding.currentPath, checkpoint: cut.checkpoint.bytes,
          suffix: cut.suffix.map(row => row.bytes), candidate: updateBytes });
        check(signal);
        const committed = storage.commitLiveUpdateJournal({ host: native.coordinate, actor, expectedAuthority: authority,
          metadata: { deliveryId, updateDigest, binding }, cutToken: cut, validation, updateBytes, receivedAtMs: Date.now() });
        if (committed.result.kind === "refused") return { result: "refused", reason: committed.result.reason };
        if (committed.result.kind === "retry") return { result: "retry", reason: committed.result.reason };
        // An ambiguous drain can still have committed the application. Read the exact durable ACK.
        try { await native.drain(document, signal); } catch { check(signal); }
        check(signal);
        const ack = await native.client.readLiveApplicationAck(request(), { deliveryId, updateDigest }, signal);
        check(signal);
        if (!ack) return { result: "retry", reason: "application-pending" };
        if (ack.deliveryId !== deliveryId || ack.updateDigest !== updateDigest || ack.journalCursor !== committed.result.receipt.journalCursor ||
          ack.acceptingHostEpoch !== committed.result.receipt.acceptingHostEpoch) throw new Error("Native application ACK identity changed.");
        return { result: "success", ack };
      } finally { submitting = false; }
    },
  };
}
