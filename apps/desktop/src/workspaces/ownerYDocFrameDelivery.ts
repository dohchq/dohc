import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {connectOwnerLiveTransport, type OwnerLiveTransport} from "@dohc/sync-relay/owner-live-transport";
import {createLiveFrameSession, decodeLiveFrameSync, encodeLiveFrame, LiveFrameError,
  type LiveFrame, type LiveFrameBegin, type LiveFrameSessionPolicy} from "@dohc/live-session-contract/live-frame";
import {parseLiveObjectBinding, type LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import type {LiveUpdateReceipt} from "@dohc/live-session-contract/live-update-admission";
import type {FreshOwnerAuthority, OwnerAuthorityResult, OwnerYDocDelivery, OwnerYDocDeliveryEnvelope,
  OwnerYDocDeliveryResult} from "./ownerYDocOutbox";

/** Native lifecycle operations retain the expected binding revision and native head. */
export interface OwnerAcceptedState {
  readState(binding: LiveObjectBinding, signal: AbortSignal): Promise<{stateVector: Uint8Array; journalCursor: number}>;
  /** Return retry when the native operation cannot durably install this exact cut. */
  applyInitialSync(input: {binding: LiveObjectBinding; hostVector: Uint8Array; missingStateUpdate: Uint8Array;
    appliedThroughJournalCursor: number}, signal: AbortSignal): Promise<"applied" | "retry">;
  applyAcceptedFrame(input: {binding: LiveObjectBinding; previousAcceptedCursor: number; journalCursor: number;
    updateBytes: Uint8Array}, signal: AbortSignal): Promise<"applied" | "retry">;
  /** Exact durable cursor/digest association; a higher checkpoint cursor is insufficient. */
  isReceiptApplied(input: {binding: LiveObjectBinding; receipt: LiveUpdateReceipt}, signal: AbortSignal): Promise<boolean>;
}

export interface OwnerYDocFrameDeliveryOptions {
  relayUrl: string;
  shareId: string;
  frames: LiveFrameSessionPolicy;
  attemptTimeoutMs: number;
  signal: AbortSignal;
  freshBearer(signal: AbortSignal): Promise<string>;
  acceptedState: OwnerAcceptedState;
  connect?: typeof connectOwnerLiveTransport;
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, {once: true});
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
interface Transfer {begin: LiveFrameBegin; bytes: Uint8Array; begun: boolean; offset: number}
interface Attempt {
  binding: LiveObjectBinding;
  signal: AbortSignal;
  abort: AbortController;
  protocol: ReturnType<typeof createLiveFrameSession>;
  ready: ReturnType<typeof deferred<OwnerAuthorityResult>>;
  delivered: ReturnType<typeof deferred<OwnerYDocDeliveryResult>>;
  authority?: FreshOwnerAuthority;
  transport?: OwnerLiveTransport;
  controls: LiveFrame[];
  transfer?: Transfer;
  vector: Uint8Array;
  vectorSent: boolean;
  submitted: boolean;
  pumping: boolean;
  receiving: Promise<void>;
  incomingBytes: number;
  incomingFrames: number;
  grantedBytes: number;
  grantedFrames: number;
  nextTransfer: number;
  maxFrameBytes: number;
  cursor: number;
  envelope?: Pick<OwnerYDocDeliveryEnvelope, "deliveryId" | "update" | "updateDigest">;
  receipt?: LiveUpdateReceipt;
  stopTimer?: ReturnType<typeof setTimeout>;
}

/** One stored head per authenticated route. The workspace lifecycle has not mounted this adapter. */
export class OwnerYDocFrameDelivery implements OwnerYDocDelivery {
  private active?: Attempt;
  private disposed = false;
  private readonly options: OwnerYDocFrameDeliveryOptions;

  constructor(options: OwnerYDocFrameDeliveryOptions) {
    this.options = {...options, frames: {...options.frames, receive: {...options.frames.receive}}};
    createLiveFrameSession("client", this.options.frames).close();
    if (!Number.isSafeInteger(options.attemptTimeoutMs) || options.attemptTimeoutMs < 1 || options.attemptTimeoutMs > 2_147_483_647) throw new TypeError("Invalid owner attempt timeout.");
    this.routeUrl({workspaceId: "check", objectId: "check", lineageClaimId: "a".repeat(64)});
  }

  dispose(): void {this.disposed = true; if (this.active) this.stop(this.active);}

  private current(attempt: Attempt): boolean {return this.active === attempt && !this.disposed && !attempt.signal.aborted;}
  private check(attempt: Attempt): void {if (!this.current(attempt)) throw new Error("Owner attempt replaced.");}
  private stop(attempt: Attempt, result: OwnerYDocDeliveryResult = {kind: "retry"}): void {
    if (this.active === attempt) this.active = undefined;
    clearTimeout(attempt.stopTimer);
    attempt.protocol.close();
    attempt.abort.abort();
    attempt.transport?.close();
    attempt.controls.length = 0;
    attempt.transfer = undefined;
    attempt.ready.resolve(result.kind === "receipt" ? {kind: "retry"} : result);
    attempt.delivered.resolve(result);
  }

  private routeUrl(binding: Pick<LiveObjectBinding, "workspaceId" | "objectId" | "lineageClaimId">): URL {
    const url = new URL(this.options.relayUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new TypeError("Invalid owner relay URL.");
    if (!this.options.shareId || /[\u0000-\u001f\u007f]/.test(this.options.shareId)) throw new TypeError("Invalid owner share selector.");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/sync/workspaces/${encodeURIComponent(binding.workspaceId)}/live/owner`;
    url.searchParams.set("objectId", binding.objectId); url.searchParams.set("lineageClaimId", binding.lineageClaimId); url.searchParams.set("shareId", this.options.shareId);
    return url;
  }

  async freshOwnerAuthority(bindingValue: LiveObjectBinding): Promise<OwnerAuthorityResult> {
    if (this.active) this.stop(this.active);
    if (this.disposed || this.options.signal.aborted) return {kind: "retry"};
    const binding = parseLiveObjectBinding(bindingValue), abort = new AbortController();
    const attempt: Attempt = {binding, abort, signal: AbortSignal.any([abort.signal, this.options.signal]),
      protocol: createLiveFrameSession("client", this.options.frames), ready: deferred(), delivered: deferred(),
      controls: [{kind: "hello", receivePolicy: this.options.frames.receive}], vector: new Uint8Array(), vectorSent: false,
      submitted: false, pumping: false, receiving: Promise.resolve(), incomingBytes: 0, incomingFrames: 0,
      grantedBytes: 0, grantedFrames: 0, nextTransfer: 1, maxFrameBytes: this.options.frames.receive.maxFrameBytes, cursor: 0};
    this.active = attempt;
    attempt.signal.addEventListener("abort", () => {if (this.active === attempt) this.stop(attempt);}, {once: true});
    attempt.stopTimer = setTimeout(() => this.stop(attempt), this.options.attemptTimeoutMs);
    attempt.stopTimer.unref();
    try {
      const state = await abortable(this.options.acceptedState.readState(binding, attempt.signal), attempt.signal); this.check(attempt);
      if (!(state.stateVector instanceof Uint8Array) || state.stateVector.length > this.options.frames.receive.maxStateVectorBytes ||
          !Number.isSafeInteger(state.journalCursor) || state.journalCursor < 0) throw new Error("Invalid native accepted state.");
      attempt.vector = Uint8Array.from(state.stateVector); attempt.cursor = state.journalCursor;
      const bearer = await abortable(this.options.freshBearer(attempt.signal), attempt.signal); this.check(attempt);
      const transport = await abortable((this.options.connect ?? connectOwnerLiveTransport)({url: this.routeUrl(binding), bearer,
        maxFrameBytes: attempt.maxFrameBytes, signal: attempt.signal, receive: bytes => this.receive(attempt, bytes), closed: () => {if (this.active === attempt) this.stop(attempt);}}), attempt.signal);
      if (!this.current(attempt)) {transport.close(); return {kind: "retry"};}
      attempt.transport = transport;
      this.grant(attempt, this.options.frames.maxQueuedBytes, this.options.frames.maxQueuedFrames);
      void this.pump(attempt);
      return await attempt.ready.promise;
    } catch {this.stop(attempt); return {kind: "retry"};}
  }

  async deliver(authority: FreshOwnerAuthority, envelopeValue: OwnerYDocDeliveryEnvelope): Promise<OwnerYDocDeliveryResult> {
    const attempt = this.active;
    if (!attempt || !this.current(attempt) || attempt.authority !== authority || attempt.envelope || !isDeepStrictEqual(attempt.binding, envelopeValue.binding)) return {kind: "retry"};
    if (envelopeValue.update.length > this.options.frames.receive.maxUpdateBytes || digest(envelopeValue.update) !== envelopeValue.updateDigest) {this.stop(attempt); return {kind: "retry"};}
    attempt.envelope = {deliveryId: envelopeValue.deliveryId, updateDigest: envelopeValue.updateDigest, update: Uint8Array.from(envelopeValue.update)};
    void this.pump(attempt);
    return attempt.delivered.promise;
  }

  private grant(attempt: Attempt, bytes: number, frames: number): void {
    attempt.grantedBytes += bytes; attempt.grantedFrames += frames;
    const credit: LiveFrame = {kind: "credit", grantedBytes: attempt.grantedBytes, grantedFrames: attempt.grantedFrames};
    const index = attempt.controls.findIndex(frame => frame.kind === "credit");
    if (index < 0) attempt.controls.push(credit); else attempt.controls[index] = credit;
  }

  private async pump(attempt: Attempt): Promise<void> {
    if (!this.current(attempt) || attempt.pumping || !attempt.transport) return;
    attempt.pumping = true;
    try {
      while (this.current(attempt)) {
        let control = attempt.controls[0];
        if (!control && !attempt.transfer) {
          if (!attempt.authority) return;
          if (!attempt.vectorSent) {
            attempt.transfer = {begin: {kind: "begin", purpose: "client-vector", transferId: attempt.nextTransfer++, totalBytes: attempt.vector.length, digest: digest(attempt.vector)}, bytes: attempt.vector, begun: false, offset: 0};
          } else if (attempt.authority && attempt.envelope && !attempt.submitted) {
            const entry = attempt.envelope;
            attempt.transfer = {begin: {kind: "begin", purpose: "submit-update", deliveryId: entry.deliveryId, transferId: attempt.nextTransfer++, totalBytes: entry.update.length, digest: entry.updateDigest}, bytes: entry.update, begun: false, offset: 0};
          } else return;
          control = attempt.controls[0];
        }
        const transfer = attempt.transfer;
        let frame: LiveFrame;
        if (control) frame = control;
        else if (!transfer!.begun) frame = transfer!.begin;
        else {
          const outgoing = attempt.protocol.usage().outgoing;
          const overhead = encodeLiveFrame({kind: "chunk", transferId: 1, offset: 0, bytes: new Uint8Array(1)}, attempt.maxFrameBytes).length - 1;
          const length = Math.min(attempt.maxFrameBytes, this.options.frames.maxQueuedBytes - outgoing.queuedBytes, outgoing.promisedBytes) - overhead;
          if (outgoing.promisedFrames < 1 || outgoing.queuedFrames >= this.options.frames.maxQueuedFrames || length < 1) return;
          frame = {kind: "chunk", transferId: transfer!.begin.transferId, offset: transfer!.offset, bytes: transfer!.bytes.subarray(transfer!.offset, transfer!.offset + length)};
        }
        let lease;
        try {lease = attempt.protocol.send(frame);} catch (error) {if (error instanceof LiveFrameError && error.reason === "credit") return; throw error;}
        if (control) attempt.controls.shift();
        else if (frame.kind === "begin") transfer!.begun = true;
        else if (frame.kind === "chunk") {transfer!.offset += frame.bytes.length; if (transfer!.offset === transfer!.bytes.length) {
          if (transfer!.begin.purpose === "client-vector") attempt.vectorSent = true; else attempt.submitted = true; attempt.transfer = undefined;
        }}
        try {await abortable(attempt.transport.send(lease.value), attempt.signal);} finally {lease.release();}
      }
    } catch {this.stop(attempt);} finally {attempt.pumping = false;}
  }

  private receive(attempt: Attempt, bytes: Uint8Array): void {
    if (!this.current(attempt)) return;
    if (bytes.length > this.options.frames.receive.maxFrameBytes || bytes.length > this.options.frames.maxQueuedBytes - attempt.incomingBytes || attempt.incomingFrames >= this.options.frames.maxQueuedFrames) {this.stop(attempt); return;}
    const owned = Uint8Array.from(bytes); attempt.incomingBytes += owned.length; attempt.incomingFrames++;
    attempt.receiving = attempt.receiving.then(async () => {
      this.check(attempt);
      const lease = attempt.protocol.receive(owned), {frame, transfer} = lease.value;
      try {
        if (frame.kind === "welcome") {
          attempt.maxFrameBytes = Math.min(attempt.maxFrameBytes, frame.receivePolicy.maxFrameBytes);
          attempt.authority = Object.freeze({value: Object.freeze({}), hostEpoch: frame.hostEpoch});
        } else if (frame.kind === "close") {this.stop(attempt); return;}
        else if (frame.kind === "result") {
          const entry = attempt.envelope;
          if (!entry || !attempt.submitted) throw new Error("Unexpected owner result.");
          const receipt = frame.result === "success" ? frame.ack : frame;
          if (receipt.deliveryId !== entry.deliveryId || receipt.updateDigest !== entry.updateDigest) throw new Error("Owner result mismatch.");
          if (frame.result === "success") {
            if (frame.ack.acceptingHostEpoch > attempt.authority!.hostEpoch) throw new Error("Owner result epoch mismatch.");
            const {deliveryId, updateDigest, journalCursor, acceptingHostEpoch} = frame.ack;
            attempt.receipt = {deliveryId, updateDigest, journalCursor, acceptingHostEpoch};
            await this.finishReceipt(attempt);
          }
          else if (frame.result === "refused" && ["stale-binding", "restore-fenced"].includes(frame.reason)) this.stop(attempt, {kind: "quarantine", reason: frame.reason});
          else this.stop(attempt);
        }
        if (transfer && this.current(attempt)) {
          const {begin, bytes: update} = transfer.value;
          if (digest(update) !== begin.digest) throw new Error("Owner transfer digest mismatch.");
          if (begin.purpose === "initial-sync") {
            const sync = decodeLiveFrameSync(update, this.options.frames.receive);
            if (!isDeepStrictEqual(sync.binding, attempt.binding)) {this.stop(attempt, {kind: "quarantine", reason: "binding-changed", observedBinding: sync.binding}); return;}
            if (begin.appliedThroughJournalCursor < attempt.cursor) throw new Error("Owner sync moved backward.");
            const applied = await abortable(this.options.acceptedState.applyInitialSync({...sync, appliedThroughJournalCursor: begin.appliedThroughJournalCursor}, attempt.signal), attempt.signal); this.check(attempt);
            if (applied !== "applied") {this.stop(attempt); return;}
            attempt.cursor = begin.appliedThroughJournalCursor;
            attempt.controls.push({kind: "sync-applied", appliedThroughJournalCursor: attempt.cursor});
            attempt.ready.resolve({kind: "authority", authority: attempt.authority!});
          } else if (begin.purpose === "applied-update") {
            if (begin.journalCursor <= attempt.cursor) throw new Error("Owner feed moved backward.");
            const applied = await abortable(this.options.acceptedState.applyAcceptedFrame({binding: attempt.binding, previousAcceptedCursor: attempt.cursor, journalCursor: begin.journalCursor, updateBytes: update}, attempt.signal), attempt.signal); this.check(attempt);
            if (applied !== "applied") {this.stop(attempt); return;}
            attempt.cursor = begin.journalCursor;
            await this.finishReceipt(attempt);
          } else throw new Error("Unexpected owner transfer.");
        }
      } finally {transfer?.release(); lease.release();}
      if (this.current(attempt)) {if (frame.kind === "begin" || frame.kind === "chunk") this.grant(attempt, owned.length, 1); void this.pump(attempt);}
    }).catch(() => this.stop(attempt)).finally(() => {attempt.incomingBytes -= owned.length; attempt.incomingFrames--;});
  }

  private async finishReceipt(attempt: Attempt): Promise<void> {
    if (!attempt.receipt) return;
    const applied = await abortable(this.options.acceptedState.isReceiptApplied({binding: attempt.binding, receipt: attempt.receipt}, attempt.signal), attempt.signal); this.check(attempt);
    if (applied) this.stop(attempt, {kind: "receipt", receipt: attempt.receipt});
  }
}
