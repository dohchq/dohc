import {isDeepStrictEqual} from "node:util";
import {AutomationRunWait} from "@dohc/automation-executor/button-presser";
import {OwnerYDocOutbox, isTransientEngineRefusal} from "@dohc/workspace-engine-client";
import {OwnerYDocOutboxDrainer, type OwnerYDocDelivery} from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import type {LiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";
import type {NamedFrameHostSession, NamedFrameSync} from "./namedLiveFrameSession";
import type {AutomationReplica} from "./automationReplicas";
import {automationRecordPresser, AutomationRecordPresserChanged} from "./automationRecordPresser";

export class AutomationRecordBindingChanged extends Error {
  constructor(readonly reason: "stale-binding" | "restore-fenced" | "binding-changed", readonly observedBinding?: LiveObjectBinding) {
    super("The shared file changed. This update was not accepted.");
  }
}

/** The server uses desktop's durable queue and receipt rules with an in-process host. */
export function automationRecordDelivery(options: {
  replica: Pick<AutomationReplica, "client" | "workspace" | "workspaceId" | "nextRequestId">;
  namespace: string;
  ownerUserId: string;
  capture(binding: LiveObjectBinding, signal: AbortSignal): Promise<NamedFrameHostSession>;
}) {
  const {replica} = options;
  const request = () => ({id: replica.nextRequestId(), workspace: replica.workspace, deadlineMs: 30_000});
  const target = (binding: LiveObjectBinding) => ({binding, relayDatabaseNamespace: options.namespace});

  async function open(binding: LiveObjectBinding, host: NamedFrameHostSession, signal: AbortSignal, recovery = false) {
    const preparation = await replica.client.ownerYDocPrepareEnrollment(request(), {...target(binding), recovery}, signal);
    const state = preparation.status === "observed"
      ? await replica.client.ownerYDocReadState(request(), target(binding), signal) : null;
    const sync = await host.openSync(state?.stateVector ?? Uint8Array.of(0), signal);
    try {
      if (!isDeepStrictEqual(sync.binding, binding)) throw new AutomationRecordBindingChanged("binding-changed", sync.binding);
      if (preparation.status === "capture") {
        await replica.client.ownerYDocEnroll(request(), {...target(binding), recovery, captured: preparation.captured,
          journalCursor: sync.appliedThroughJournalCursor, hostVector: sync.hostVector, checkpoint: sync.missingStateUpdate}, signal);
      } else if (sync.appliedThroughJournalCursor !== state!.acceptedCursor) {
        await replica.client.ownerYDocApplyInitialSync(request(), {...target(binding), expectedRevision: state!.revision,
          expectedNativeHeadSequence: state!.nativeHeadSequence, previousAcceptedCursor: state!.acceptedCursor,
          journalCursor: sync.appliedThroughJournalCursor, hostVector: sync.hostVector, updateBytes: sync.missingStateUpdate}, signal);
      }
      return sync;
    } catch (error) {sync.close(); throw error;}
  }

  async function synchronize(binding: LiveObjectBinding, signal: AbortSignal, recovery = false) {
    signal.throwIfAborted();
    try {
      const host = await options.capture(binding, signal);
      try {const sync = await open(binding, host, signal, recovery); sync.close();}
      finally {host.close();}
    } catch (error) {
      signal.throwIfAborted();
      if (!isTransientEngineRefusal(error)) throw error;
      throw new AutomationRunWait("The shared file is busy. Try again.", "busy");
    }
  }

  /** Delivers the record's queued updates. False when it found no outbox to deliver them from. */
  async function drain(binding: LiveObjectBinding, signal: AbortSignal, knownOutboxId?: string): Promise<boolean> {
    let outboxId = knownOutboxId;
    if (!outboxId) {
      const preparation = await replica.client.ownerYDocPrepareEnrollment(request(), target(binding), signal);
      if (preparation.status !== "observed" || preparation.draft.outboxId === null) return false;
      outboxId = preparation.draft.outboxId;
    }
    const outbox = new OwnerYDocOutbox({sendRequest: input => replica.client.sendRequest(input, signal)}, replica.workspace);
    let host: NamedFrameHostSession | undefined;
    let sync: NamedFrameSync | undefined;
    const delivery: OwnerYDocDelivery = {
      async freshOwnerAuthority() {
        try {
          // A pass captures once; the host rechecks standing at every admission.
          host ??= await options.capture(binding, signal);
          sync ??= await open(binding, host, signal);
          host.assertCurrent();
          return {kind: "authority", authority: {value: host, hostEpoch: host.hostEpoch}};
        } catch (error) {
          if (error instanceof AutomationRecordBindingChanged) return {kind: "quarantine", reason: error.reason,
            ...(error.observedBinding ? {observedBinding: error.observedBinding} : {})};
          throw error;
        }
      },
      async deliver(_authority, entry) {
        const declared = entry.agentDeclaration;
        let recipientAuthority;
        try {
          recipientAuthority = entry.automationDeclaration?.attribution.onBehalfOf === options.ownerUserId ? undefined
            : await automationRecordPresser(replica, entry.automationDeclaration, signal);
        } catch (error) {
          if (!(error instanceof AutomationRecordPresserChanged)) throw error;
          await replica.client.ownerYDocRefuseEntry(request(), {outboxId: entry.outboxId, deliveryId: entry.deliveryId,
            updateDigest: entry.updateDigest, reason: "authority-refused"}, signal);
          return {kind: "not-accepted"};
        }
        const result = await host!.submit({deliveryId: entry.deliveryId, updateDigest: entry.updateDigest, updateBytes: entry.update,
          ...(recipientAuthority ? "hostPressId" in recipientAuthority ? {trustedAutomationPress: recipientAuthority}
            : {trustedAutomationGrant: recipientAuthority} : {}),
          ...(entry.automationDeclaration ? {trustedAutomation: entry.automationDeclaration} : declared ? {authorContext: {kind: "account", accountId: options.ownerUserId,
            agent: {agentId: declared.agentId, ...(declared.onBehalfOf === null ? {} : {onBehalfOf: declared.onBehalfOf}), depth: declared.depth}}} : {})}, signal).catch(error => {
          if (isTransientEngineRefusal(error)) return {result: "retry", reason: "admission-unavailable"} as const;
          throw error;
        });
        if (result.result === "retry") return {kind: "retry"};
        if (result.result === "refused") {
          if (["stale-binding", "restore-fenced", "binding-changed"].includes(result.reason)) return {kind: "quarantine", reason: result.reason};
          if (result.reason === "stale-session") return {kind: "retry"};
          await replica.client.ownerYDocRefuseEntry(request(), {outboxId: entry.outboxId, deliveryId: entry.deliveryId,
            updateDigest: entry.updateDigest, reason: result.reason === "capacity-refused"
              ? "This update exceeds the shared file's limits. Reduce the change, then try again." : result.reason}, signal);
          return {kind: "not-accepted"};
        }
        // Install incremental accepted frames before acknowledging this exact receipt.
        let state = await replica.client.ownerYDocReadState(request(), target(binding), signal);
        while (state.acceptedCursor < result.ack.journalCursor) {
          const frame = await sync!.nextApplied(signal);
          try {
            if (frame.value.journalCursor <= state.acceptedCursor) continue;
            const next = await replica.client.ownerYDocApplyAcceptedFrame(request(), {...target(binding), expectedRevision: state.revision,
              expectedNativeHeadSequence: state.nativeHeadSequence, previousAcceptedCursor: state.acceptedCursor,
              journalCursor: frame.value.journalCursor, updateBytes: frame.value.updateBytes}, signal);
            state = {...state, ...next};
          } finally {frame.release();}
        }
        const {localYDocSequence: _sequence, applicationReplayed: _replayed, ...receipt} = result.ack;
        if (!await replica.client.ownerYDocIsReceiptApplied(request(), {...target(binding), receipt}, signal)) return {kind: "retry"};
        return {kind: "receipt", receipt};
      },
    };
    const drainer = new OwnerYDocOutboxDrainer(outbox, outboxId, delivery);
    try {
      for (let count = 0; count < 128; count++) {
        const result = await drainer.drainOnce();
        if (result === "empty" || result === "frozen") return true;
        if (result === "retry") throw new AutomationRunWait("The shared file update is waiting for acceptance. Try again.", "busy");
      }
      throw new Error("The shared file still has updates waiting for acceptance. Try again.");
    } finally {drainer.dispose(); outbox.dispose(); sync?.close(); host?.close();}
  }
  return {synchronize, drain};
}
