import {isDeepStrictEqual} from "node:util";
import {OwnerYDocOutbox} from "@dohc/workspace-engine-client";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";
import {OwnerYDocFrameDelivery, type OwnerAcceptedState} from "./ownerYDocFrameDelivery";
import {OwnerYDocOutboxDrainer} from "./ownerYDocOutbox";
import type {DesktopOwnerDeliveryConfig, DesktopOwnerDeliveryDocument} from "./desktopOwnerDelivery";

/** The authority lease and engine session must remain held until this pass settles. */
export async function runNativeOwnerDeliveryPass(options: {
  client: EngineClient;
  workspaceHandle: string;
  document: DesktopOwnerDeliveryDocument;
  config: DesktopOwnerDeliveryConfig;
  signal: AbortSignal;
  bearer: string;
  assertCurrent(): void;
}) {
  const {client, document, config, signal} = options;
  const pending = new Set<Promise<unknown>>();
  const check = () => {signal.throwIfAborted(); options.assertCurrent();};
  async function guarded<T>(work: (signal: AbortSignal) => Promise<T>, attemptSignal = signal): Promise<T> {
    check();
    const currentSignal = AbortSignal.any([signal, attemptSignal]);
    currentSignal.throwIfAborted();
    const task = work(currentSignal); pending.add(task);
    try {const result = await task; currentSignal.throwIfAborted(); check(); return result;} finally {pending.delete(task);}
  }
  const target = {binding: document.binding, relayDatabaseNamespace: document.relayDatabaseNamespace};
  const request = () => ({id: 0, workspace: options.workspaceHandle, deadlineMs: config.attemptTimeoutMs});
  let position: {revision: number; acceptedCursor: number; nativeHeadSequence: number} | undefined;
  function bound(binding: typeof document.binding) {
    check();
    if (!isDeepStrictEqual(binding, target.binding)) throw new Error("Owner delivery binding changed.");
  }
  function prior() {
    if (!position) throw new Error("Owner accepted state has not been read.");
    return {expectedRevision: position.revision, expectedNativeHeadSequence: position.nativeHeadSequence,
      previousAcceptedCursor: position.acceptedCursor};
  }
  const acceptedState: OwnerAcceptedState = {
    async readState(binding, attemptSignal) {
      bound(binding);
      const state = await guarded(signal => client.ownerYDocReadState(request(), target, signal), attemptSignal);
      position = state;
      return {stateVector: state.stateVector, journalCursor: state.acceptedCursor};
    },
    async applyInitialSync(input, attemptSignal) {
      bound(input.binding);
      position = await guarded(signal => client.ownerYDocApplyInitialSync(request(), {...target, ...prior(),
        journalCursor: input.appliedThroughJournalCursor, hostVector: input.hostVector,
        updateBytes: input.missingStateUpdate}, signal), attemptSignal);
      return "applied";
    },
    async applyAcceptedFrame(input, attemptSignal) {
      bound(input.binding);
      if (input.previousAcceptedCursor !== position?.acceptedCursor) return "retry";
      position = await guarded(signal => client.ownerYDocApplyAcceptedFrame(request(), {...target, ...prior(),
        journalCursor: input.journalCursor, updateBytes: input.updateBytes}, signal), attemptSignal);
      return "applied";
    },
    async isReceiptApplied(input, attemptSignal) {
      bound(input.binding);
      return guarded(signal => client.ownerYDocIsReceiptApplied(request(), {...target, receipt: input.receipt}, signal), attemptSignal);
    },
  };
  const outbox = new OwnerYDocOutbox({sendRequest: request => guarded(() => client.sendRequest(request, signal))}, options.workspaceHandle);
  const delivery = new OwnerYDocFrameDelivery({relayUrl: config.relayUrl, shareId: document.shareId,
    frames: config.frames, attemptTimeoutMs: config.attemptTimeoutMs, signal, acceptedState,
    freshBearer: async () => {check(); return options.bearer;}});
  const drainer = new OwnerYDocOutboxDrainer(outbox, document.outboxId, delivery);
  try {return await drainer.drainOnce();}
  finally {drainer.dispose(); delivery.dispose(); outbox.dispose(); await Promise.allSettled([...pending]);}
}
