import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "@dohc/ydoc-projection/body-fragment";
import {
  createLiveFrameSession, decodeLiveFrameSync, encodeLiveFrame, LiveFrameError,
  type LiveFrame, type LiveFrameBegin, type LiveFrameSessionPolicy, type LiveMembershipFrame,
} from "@dohc/live-session-contract/live-frame";
import { parseLiveObjectBinding, type LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import type { LiveUpdateHostApplicationAck } from "@dohc/live-session-contract/live-update-admission";

export interface NamedLiveProviderLimits {
  readonly frames: LiveFrameSessionPolicy;
  readonly maxPendingUpdateBytes: number;
  readonly maxPendingUpdates: number;
  readonly maxDeliveryAttempts: number;
}

/** The authenticated adapter supplies one ordered binary route. close must settle pending sends. */
export interface NamedLiveTransport {
  /** Borrow bytes until completion; completion means transport release, not host application. */
  send(bytes: Uint8Array): Promise<void>;
  close(): void;
}

export interface NamedLiveProviderState {
  readonly status: "disconnected" | "connecting" | "syncing" | "live" | "quarantined" | "closed";
  readonly reason: string | null;
  readonly binding: LiveObjectBinding | null;
  readonly hostEpoch: number | null;
  readonly pendingUpdates: number;
  readonly pendingBytes: number;
  /** Host application evidence reported by the authenticated route; this is not settlement. */
  readonly lastApplied: LiveUpdateHostApplicationAck | null;
  /** A bounded current subset. An overflowed snapshot cannot establish departures by omission. */
  readonly membership: LiveMembershipFrame | null;
}

interface PendingUpdate {
  readonly id: string;
  readonly bytes: Uint8Array;
  digest?: string;
  readonly epochs: number[];
}
interface Transfer {
  readonly begin: LiveFrameBegin;
  readonly bytes: Uint8Array;
  begun: boolean;
  offset: number;
}
interface Route {
  readonly transport: NamedLiveTransport;
  readonly protocol: ReturnType<typeof createLiveFrameSession>;
  readonly controls: LiveFrame[];
  epoch?: number;
  maxFrameBytes: number;
  nextTransfer: number;
  transfer?: Transfer;
  vectorSent: boolean;
  awaitingAck: boolean;
  pumping: boolean;
  receiving: Promise<void>;
  grantedBytes: number;
  grantedFrames: number;
  receivedCursor: number;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function sameBinding(left: LiveObjectBinding, right: LiveObjectBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
const REMOTE = Symbol("named-live-remote");

/**
 * Client protocol only. The route adapter must authenticate, validate admission,
 * apply through the current host, and emit ACKs only from that durable result.
 * The editor must honor status before mutating doc. A refused edit keeps doc as
 * an in-memory draft; reconnecting a quarantined provider is deliberately forbidden.
 */
export function createNamedLiveProvider(input: NamedLiveProviderLimits,
  expectedDocument?: Pick<LiveObjectBinding, "workspaceId" | "objectId">) {
  const expected = expectedDocument && { ...expectedDocument };
  const limits: NamedLiveProviderLimits = {
    frames: { ...input.frames, receive: { ...input.frames.receive } },
    maxPendingUpdateBytes: input.maxPendingUpdateBytes,
    maxPendingUpdates: input.maxPendingUpdates,
    maxDeliveryAttempts: input.maxDeliveryAttempts,
  };
  // Reuse the codec's role-specific policy validation before a route exists.
  createLiveFrameSession("client", limits.frames).close();
  for (const value of [limits.maxPendingUpdateBytes, limits.maxPendingUpdates, limits.maxDeliveryAttempts]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Invalid named provider limits.");
  }
  const doc = new Y.Doc();
  const body = getDohcYDocBodyFragment(doc);
  const pending: PendingUpdate[] = [];
  const listeners = new Set<(state: NamedLiveProviderState) => void>();
  let route: Route | undefined;
  let status: NamedLiveProviderState["status"] = "disconnected", reason: string | null = null;
  let binding: LiveObjectBinding | null = null, hostEpoch: number | null = null;
  let pendingBytes = 0, incomingBytes = 0, incomingFrames = 0, sending = false;
  let lastApplied: LiveUpdateHostApplicationAck | null = null;
  let membership: LiveMembershipFrame | null = null;
  let highestObservedCursor = 0;
  const state = (): NamedLiveProviderState => ({ status, reason,
    binding: binding && { ...binding, selectorPaths: [...binding.selectorPaths] }, hostEpoch,
    pendingUpdates: pending.length, pendingBytes, lastApplied: lastApplied && { ...lastApplied },
    membership: membership && { ...membership, members: [...membership.members] } });
  function notify() {
    for (const listener of listeners) {
      try { listener(state()); } catch { /* A view listener cannot change delivery ownership. */ }
    }
  }
  const current = (held: Route) => route === held;
  function retire(next: NamedLiveProviderState["status"], why: string | null) {
    const previous = route;
    route = undefined; status = next; reason = why; membership = null;
    previous?.protocol.close();
    if (previous) {
      previous.controls.length = 0;
      previous.transfer = undefined;
      try { previous.transport.close(); } catch { /* The route is already retired. */ }
    }
    notify();
  }
  const quarantine = (why: string) => retire("quarantined", why);

  function grant(held: Route, bytes: number, frames: number) {
    held.grantedBytes += bytes; held.grantedFrames += frames;
    if (!Number.isSafeInteger(held.grantedBytes) || !Number.isSafeInteger(held.grantedFrames)) {
      quarantine("credit-exhausted"); return;
    }
    // Coalesce outstanding cumulative credit; controls never grow with inbound traffic.
    const credit: LiveFrame = { kind: "credit", grantedBytes: held.grantedBytes, grantedFrames: held.grantedFrames };
    const existing = held.controls.findIndex(frame => frame.kind === "credit");
    if (existing < 0) held.controls.push(credit); else held.controls[existing] = credit;
  }

  async function pump(held: Route): Promise<void> {
    if (!current(held) || held.pumping) return;
    held.pumping = true;
    try {
      while (current(held)) {
        let control = held.controls[0];
        if (!control && !held.transfer) {
          if (held.epoch === undefined) return;
          if (!held.vectorSent) {
            const bytes = Y.encodeStateVector(doc);
            if (bytes.length > limits.frames.receive.maxStateVectorBytes) { quarantine("vector-limit"); return; }
            const hash = await digest(bytes);
            if (!current(held)) return;
            held.transfer = { begin: { kind: "begin", purpose: "client-vector", transferId: held.nextTransfer++, totalBytes: bytes.length, digest: hash }, bytes, begun: false, offset: 0 };
          } else if (status === "live" && pending.length && !held.awaitingAck) {
            const update = pending[0]!;
            if (update.epochs.length >= limits.maxDeliveryAttempts) { quarantine("delivery-attempt-limit"); return; }
            update.digest ??= await digest(update.bytes);
            if (!current(held)) return;
            update.epochs.push(held.epoch);
            held.transfer = { begin: { kind: "begin", purpose: "submit-update", deliveryId: update.id, transferId: held.nextTransfer++, totalBytes: update.bytes.length, digest: update.digest }, bytes: update.bytes, begun: false, offset: 0 };
          } else return;
          control = held.controls[0];
        }
        const transfer = held.transfer;
        let frame: LiveFrame;
        if (control) frame = control;
        else if (!transfer!.begun) frame = transfer!.begin;
        else {
          const available = held.protocol.usage().outgoing;
          const overhead = encodeLiveFrame({ kind: "chunk", transferId: 1, offset: 0, bytes: new Uint8Array(1) }, held.maxFrameBytes).length - 1;
          const length = Math.min(held.maxFrameBytes, limits.frames.maxQueuedBytes - available.queuedBytes, available.promisedBytes) - overhead;
          if (available.promisedFrames < 1 || available.queuedFrames >= limits.frames.maxQueuedFrames || length < 1) return;
          frame = { kind: "chunk", transferId: transfer!.begin.transferId, offset: transfer!.offset,
            bytes: transfer!.bytes.subarray(transfer!.offset, transfer!.offset + length) };
        }
        let lease;
        try { lease = held.protocol.send(frame); }
        catch (error) {
          // A grant can wait on an inbound lease; receive releases it before re-granting and pumping.
          if (error instanceof LiveFrameError && error.reason === "credit") return;
          throw error;
        }
        if (control) held.controls.shift();
        else if (frame.kind === "begin") transfer!.begun = true;
        else if (frame.kind === "chunk") {
          transfer!.offset += frame.bytes.length;
          if (transfer!.offset === transfer!.bytes.length) {
            if (transfer!.begin.purpose === "client-vector") held.vectorSent = true;
            else held.awaitingAck = true;
            held.transfer = undefined;
          }
        }
        sending = true;
        try { await held.transport.send(lease.value); }
        finally { sending = false; lease.release(); }
      }
    } catch (error) {
      if (current(held)) {
        if (error instanceof LiveFrameError) quarantine(`outbound-${error.reason}`);
        else retire("disconnected", "transport-failed");
      }
    } finally { held.pumping = false; }
  }

  async function receive(held: Route, bytes: Uint8Array): Promise<void> {
    if (!current(held)) return;
    if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) ||
        bytes.byteLength > limits.frames.receive.maxFrameBytes ||
        bytes.byteLength > limits.frames.maxQueuedBytes - incomingBytes || incomingFrames >= limits.frames.maxQueuedFrames) {
      quarantine("inbound-limit"); return;
    }
    const owned = bytes.slice();
    incomingBytes += owned.length; incomingFrames++;
    const work = held.receiving.then(async () => {
      if (!current(held)) return;
      const lease = held.protocol.receive(owned);
      const { frame, transfer } = lease.value;
      try {
        if (frame.kind === "welcome") {
          if (hostEpoch !== null && frame.hostEpoch < hostEpoch) { quarantine("stale-host"); return; }
          held.epoch = frame.hostEpoch; hostEpoch = frame.hostEpoch;
          held.maxFrameBytes = Math.min(held.maxFrameBytes, frame.receivePolicy.maxFrameBytes);
          status = "syncing"; notify();
        } else if (frame.kind === "membership") {
          membership = frame; notify();
        } else if (frame.kind === "result") {
          const update = pending[0];
          if (!update || !held.awaitingAck) { quarantine("unexpected-result"); return; }
          if (frame.result === "success") {
            if (!update.epochs.includes(frame.ack.acceptingHostEpoch)) { quarantine("foreign-ack-epoch"); return; }
            pending.shift(); pendingBytes -= update.bytes.length; held.awaitingAck = false;
            lastApplied = { ...frame.ack };
            highestObservedCursor = Math.max(highestObservedCursor, frame.ack.journalCursor);
            notify();
          } else if (frame.result === "retry") retire("disconnected", frame.reason);
          else quarantine(frame.reason);
        } else if (frame.kind === "close") {
          if (frame.reason === "route-fenced" || frame.reason === "protocol-invalid") quarantine(frame.reason);
          else retire("disconnected", frame.reason);
        }
        if (transfer && current(held)) {
          const { begin, bytes: content } = transfer.value;
          const hash = await digest(content);
          if (!current(held)) return;
          if (hash !== begin.digest) { quarantine("digest-mismatch"); return; }
          if (begin.purpose === "initial-sync") {
            const sync = decodeLiveFrameSync(content, limits.frames.receive);
            if (sync.binding.mainVersionId !== "main" ||
                (expected && (sync.binding.workspaceId !== expected.workspaceId || sync.binding.objectId !== expected.objectId)) ||
                (binding && !sameBinding(binding, sync.binding))) { quarantine("binding-changed"); return; }
            if (begin.appliedThroughJournalCursor < highestObservedCursor) { quarantine("stale-sync-cut"); return; }
            const hostVector = Y.decodeStateVector(sync.hostVector);
            Y.decodeUpdate(sync.missingStateUpdate);
            // Yjs observers run synchronously; record attribution before they can retire the route.
            binding = parseLiveObjectBinding(sync.binding);
            held.receivedCursor = begin.appliedThroughJournalCursor;
            highestObservedCursor = begin.appliedThroughJournalCursor;
            Y.applyUpdate(doc, sync.missingStateUpdate, REMOTE);
            if (!current(held)) return;
            const appliedVector = Y.decodeStateVector(Y.encodeStateVector(doc));
            if ([...hostVector].some(([client, clock]) => (appliedVector.get(client) ?? 0) < clock)) {
              quarantine("incomplete-sync"); return;
            }
            held.controls.push({ kind: "sync-applied", appliedThroughJournalCursor: begin.appliedThroughJournalCursor });
            status = "live"; notify();
          } else if (begin.purpose === "applied-update") {
            if (begin.journalCursor <= held.receivedCursor) { quarantine("stale-update-cursor"); return; }
            Y.decodeUpdate(content);
            held.receivedCursor = begin.journalCursor;
            highestObservedCursor = Math.max(highestObservedCursor, begin.journalCursor);
            Y.applyUpdate(doc, content, REMOTE);
            if (!current(held)) return;
          } else quarantine("unexpected-transfer");
        }
      } finally { transfer?.release(); lease.release(); }
      if (current(held)) {
        if (frame.kind === "begin" || frame.kind === "chunk") grant(held, owned.length, 1);
        void pump(held);
      }
    }).catch(() => { if (current(held)) quarantine("invalid-frame"); }).finally(() => {
      incomingBytes -= owned.length; incomingFrames--;
    });
    held.receiving = work;
    await work;
  }

  function localUpdate(bytes: Uint8Array, origin: unknown) {
    if (origin === REMOTE || status === "closed" || status === "quarantined") return;
    if (status !== "live") { quarantine("edit-while-unavailable"); return; }
    if (bytes.length > limits.frames.receive.maxUpdateBytes || bytes.length > limits.maxPendingUpdateBytes - pendingBytes ||
        pending.length >= limits.maxPendingUpdates) { quarantine("pending-update-limit"); return; }
    pending.push({ id: crypto.randomUUID(), bytes: bytes.slice(), epochs: [] });
    pendingBytes += bytes.length;
    notify();
    if (route) void pump(route);
  }
  doc.on("update", localUpdate);

  return {
    doc, body, state,
    subscribe(listener: (value: NamedLiveProviderState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect(transport: NamedLiveTransport) {
      if (status === "closed" || status === "quarantined") throw new Error("The provider cannot reconnect.");
      if (sending || incomingFrames) throw new Error("The previous transport still owns work.");
      if (route) retire("disconnected", "replaced");
      const held: Route = { transport, protocol: createLiveFrameSession("client", limits.frames),
        controls: [{ kind: "hello", receivePolicy: limits.frames.receive }], maxFrameBytes: limits.frames.receive.maxFrameBytes,
        nextTransfer: 1, vectorSent: false, awaitingAck: false, pumping: false, receiving: Promise.resolve(),
        grantedBytes: 0, grantedFrames: 0, receivedCursor: 0 };
      route = held; status = "connecting"; reason = null;
      grant(held, limits.frames.maxQueuedBytes, limits.frames.maxQueuedFrames);
      notify(); void pump(held);
      return {
        receive: (bytes: Uint8Array) => receive(held, bytes),
        disconnect() { if (current(held)) retire("disconnected", "transport-closed"); },
        /** Waits for currently admitted receive work; adapter send completion is separate. */
        settled: () => held.receiving,
      };
    },
    close() { retire("closed", null); doc.off("update", localUpdate); listeners.clear(); },
  };
}
