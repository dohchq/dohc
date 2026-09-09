import { createHash } from "node:crypto";
import {
  createLiveFrameSession, encodeLiveFrame, encodeLiveFrameSync, LiveFrameError,
  type LiveFrame, type LiveFrameBegin, type LiveFrameLease, type LiveFrameSessionPolicy, type LiveFrameSync,
} from "@dohc/live-session-contract/live-frame";
import type { RedeemedLiveTicket } from "@dohc/live-session-contract/live-ticket";
import type { LiveUpdateHostApplicationAck, LiveUpdateRefusal, LiveUpdateRetry } from "@dohc/live-session-contract/live-update-admission";

export interface NamedFrameAppliedUpdate { readonly journalCursor: number; readonly updateBytes: Uint8Array }
export interface NamedFrameSync extends LiveFrameSync {
  readonly appliedThroughJournalCursor: number;
  nextApplied(this: void, signal: AbortSignal): Promise<LiveFrameLease<NamedFrameAppliedUpdate>>;
  close(this: void): void;
}
export type NamedFrameSubmissionResult =
  | { readonly result: "success"; readonly ack: LiveUpdateHostApplicationAck }
  | { readonly result: "refused"; readonly reason: LiveUpdateRefusal }
  | { readonly result: "retry"; readonly reason: LiveUpdateRetry };

/** A browser owns this capture, never the shared native host or its registration. */
export interface NamedFrameHostSession {
  readonly ticket: RedeemedLiveTicket;
  readonly invalidated: AbortSignal;
  assertCurrent(): void;
  openSync(clientVector: Uint8Array, signal: AbortSignal): Promise<NamedFrameSync>;
  submit(input: { deliveryId: string; updateDigest: string; updateBytes: Uint8Array }, signal: AbortSignal): Promise<NamedFrameSubmissionResult>;
  close(): void;
}
export interface NamedFrameTransport {
  /** Borrows bytes until this promise settles. close must settle pending sends. */
  send(bytes: Uint8Array): Promise<void>;
  close(): void;
}
interface Transfer {
  begin: LiveFrameBegin;
  bytes: Uint8Array;
  begun: boolean;
  offset: number;
  release(): void;
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Private ordered frame endpoint. No listener, route, or admission policy is installed. */
export function createNamedLiveFrameSession(options: {
  host: NamedFrameHostSession;
  frames: LiveFrameSessionPolicy;
  transport: NamedFrameTransport;
}) {
  const { host, transport } = options;
  const frames = { ...options.frames, receive: { ...options.frames.receive } };
  const protocol = createLiveFrameSession("server", frames);
  const lifetime = new AbortController();
  const tasks = new Set<Promise<void>>();
  let closed = false, pumping = false, pulling = false, submitting = false, opening = false;
  let sync: Pick<NamedFrameSync, "nextApplied" | "close"> | undefined, transfer: Transfer | undefined;
  let result: Extract<LiveFrame, { kind: "result" }> | undefined;
  let greeted = false, credit: Extract<LiveFrame, { kind: "credit" }> | undefined;
  let grantedBytes = 0, grantedFrames = 0, nextTransfer = 1;
  let maxFrameBytes = Math.min(frames.receive.maxFrameBytes, frames.maxQueuedBytes);
  let peerSyncBytes = frames.receive.maxSyncBytes;

  function check() { lifetime.signal.throwIfAborted(); host.assertCurrent(); }
  function close() {
    if (closed) return;
    closed = true;
    lifetime.abort(new Error("Named frame session closed."));
    host.invalidated.removeEventListener("abort", close);
    protocol.close();
    credit = undefined; result = undefined;
    transfer?.release(); transfer = undefined;
    try { sync?.close(); } catch { /* Release the remaining capture and transport too. */ }
    sync = undefined;
    try { host.close(); } catch { /* This browser capture is already invalid. */ }
    try { transport.close(); } catch { /* The transport must still settle its borrowed sends. */ }
  }
  function run(action: () => Promise<void>) {
    const task = action().catch(() => { close(); });
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  }
  function grant(bytes: number, count: number) {
    grantedBytes += bytes; grantedFrames += count;
    if (!Number.isSafeInteger(grantedBytes) || !Number.isSafeInteger(grantedFrames)) throw new Error("Frame credit exhausted.");
    credit = { kind: "credit", grantedBytes, grantedFrames };
  }
  function outgoing(begin: Omit<Extract<LiveFrameBegin, { purpose: "initial-sync" }>, "kind" | "transferId" | "totalBytes" | "digest"> |
      Omit<Extract<LiveFrameBegin, { purpose: "applied-update" }>, "kind" | "transferId" | "totalBytes" | "digest">,
    bytes: Uint8Array, release: () => void) {
    if (transfer || !Number.isSafeInteger(nextTransfer)) throw new Error("Frame transfer already owned.");
    transfer = { begin: { kind: "begin", ...begin, transferId: nextTransfer++, totalBytes: bytes.length, digest: digest(bytes) },
      bytes, begun: false, offset: 0, release };
  }
  function startPull() {
    if (closed || pulling || transfer || !sync || !protocol.usage().live) return;
    const available = protocol.usage().outgoing;
    // Keep the native read dormant until a BEGIN can use output credit.
    if (available.promisedFrames < 1 || available.promisedBytes < encodeLiveFrame({ kind: "begin", purpose: "applied-update",
      transferId: nextTransfer, totalBytes: 1, digest: "0".repeat(64), journalCursor: 1 }, maxFrameBytes).length) return;
    const held = sync;
    pulling = true;
    run(async () => {
      let update: LiveFrameLease<NamedFrameAppliedUpdate> | undefined;
      try {
        update = await held.nextApplied(lifetime.signal);
        check();
        if (sync !== held) throw new Error("Sync capture changed.");
        const lease = update;
        outgoing({ purpose: "applied-update", journalCursor: lease.value.journalCursor }, lease.value.updateBytes, () => lease.release());
        update = undefined;
      } finally { pulling = false; update?.release(); }
      pump();
    });
  }
  function pump() {
    if (closed || pumping) return;
    pumping = true;
    run(async () => {
      try {
        while (!closed) {
          check();
          let frame: LiveFrame;
          const held = transfer;
          if (!greeted) frame = { kind: "welcome", hostEpoch: host.ticket.hostEpoch, receivePolicy: frames.receive };
          else if (credit) frame = credit;
          else if (result) frame = result;
          else if (held && !held.begun) frame = held.begin;
          else if (held) {
            const available = protocol.usage().outgoing;
            const overhead = encodeLiveFrame({ kind: "chunk", transferId: 1, offset: 0, bytes: new Uint8Array(1) }, maxFrameBytes).length - 1;
            const length = Math.min(maxFrameBytes, available.promisedBytes) - overhead;
            if (available.promisedFrames < 1 || length < 1) return;
            frame = { kind: "chunk", transferId: held.begin.transferId, offset: held.offset,
              bytes: held.bytes.subarray(held.offset, held.offset + length) };
          } else { startPull(); return; }
          let lease;
          try { lease = protocol.send(frame); }
          catch (error) { if (error instanceof LiveFrameError && error.reason === "credit") return; throw error; }
          if (frame.kind === "welcome") greeted = true;
          else if (frame.kind === "credit") credit = undefined;
          else if (frame.kind === "result") result = undefined;
          else if (frame.kind === "begin") held!.begun = true;
          else if (frame.kind === "chunk") held!.offset += frame.bytes.length;
          try { await transport.send(lease.value); check(); }
          finally { lease.release(); }
          if (held && transfer === held && held.offset === held.bytes.length) { transfer = undefined; held.release(); }
          if (frame.kind === "result" && frame.result !== "success") { close(); return; }
        }
      } finally { pumping = false; }
    });
  }
  function receive(bytes: Uint8Array) {
    if (closed) return;
    let received: ReturnType<typeof protocol.receive> | undefined;
    let completed: NonNullable<ReturnType<typeof protocol.receive>["value"]["transfer"]> | undefined;
    try {
      check();
      received = protocol.receive(bytes);
      const { frame } = received.value;
      completed = received.value.transfer;
      if (frame.kind === "hello") {
        maxFrameBytes = Math.min(maxFrameBytes, frame.receivePolicy.maxFrameBytes);
        peerSyncBytes = Math.min(peerSyncBytes, frame.receivePolicy.maxSyncBytes);
      } else if (frame.kind === "close") { close(); return; }
      if (completed) {
        const held = completed, { begin, bytes: updateBytes } = held.value;
        if (digest(updateBytes) !== begin.digest) throw new Error("Transfer digest mismatch.");
        if (begin.purpose === "client-vector") {
          if (opening || sync) throw new Error("Sync already opened.");
          opening = true;
          run(async () => {
            let opened: NamedFrameSync | undefined;
            try {
              opened = await host.openSync(updateBytes, lifetime.signal); check();
              const bytes = encodeLiveFrameSync({ binding: opened.binding, hostVector: opened.hostVector,
                missingStateUpdate: opened.missingStateUpdate }, { ...frames.receive, maxSyncBytes: peerSyncBytes });
              const cursor = opened.appliedThroughJournalCursor;
              sync = { nextApplied: opened.nextApplied, close: opened.close }; opened = undefined;
              outgoing({ purpose: "initial-sync", appliedThroughJournalCursor: cursor }, bytes, () => {});
            } finally { opening = false; held.release(); opened?.close(); }
            pump();
          });
        } else if (begin.purpose === "submit-update") {
          if (submitting || result) throw new Error("Submission already owned.");
          submitting = true;
          run(async () => {
            try {
              const accepted = await host.submit({ deliveryId: begin.deliveryId, updateDigest: begin.digest, updateBytes }, lifetime.signal);
              check();
              result = accepted.result === "success" ? { kind: "result", ...accepted } :
                { kind: "result", deliveryId: begin.deliveryId, updateDigest: begin.digest, ...accepted };
            } finally { submitting = false; held.release(); }
            pump();
          });
        } else throw new Error("Unexpected client transfer.");
        completed = undefined;
      }
      received.release(); received = undefined;
      if (frame.kind === "begin" || frame.kind === "chunk") grant(bytes.length, 1);
      pump();
    } catch { completed?.release(); close(); }
    finally { received?.release(); }
  }
  host.invalidated.addEventListener("abort", close, { once: true });
  if (host.invalidated.aborted) close();
  if (!closed) { grant(frames.maxQueuedBytes, frames.maxQueuedFrames); pump(); }
  return { receive, close, usage: () => ({ ...protocol.usage(), pulling, submitting, opening }),
    async settled() { while (tasks.size) await Promise.allSettled([...tasks]); } };
}
