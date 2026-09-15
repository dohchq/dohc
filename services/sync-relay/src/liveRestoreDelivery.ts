import {isDeepStrictEqual} from "node:util";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";
import {parseLiveUpdateIdentifier} from "@dohc/live-session-contract/live-update-admission";
import type {LiveHostConnectionCoordinate} from "./storage";
import type {LiveCommittedDeliveryStore, StopRestoreCutCapture} from "./storage/liveCommittedDelivery";
import type {StopRestoreLookup} from "./storage/liveRestoreOperation";
import {parseNativeRestoreFenceReceipt, type NativeRestoreFenceReceipt} from "./liveRestoreFence";
import {configRecord} from "./deviceLiveHostConfig";
import {authorityInteger} from "./storage/liveDocumentAuthority";

export type StopRestoreOutcome = {kind: "pending"; reason: string} | {kind: "done"; receipt: NativeRestoreFenceReceipt};
export function snapshotStopRestoreLookup(input: StopRestoreLookup): StopRestoreLookup {
  return {operationId: parseLiveUpdateIdentifier(input.operationId), workspaceId: parseLiveUpdateIdentifier(input.workspaceId), ownerUserId: parseLiveUpdateIdentifier(input.ownerUserId)};
}

/** The consumer holds its normal document exclusion for this entire call. */
export async function deliverStopRestore(options: {
  store: LiveCommittedDeliveryStore;
  lookup: StopRestoreLookup;
  connection: {client: EngineClient; workspace: string; host: LiveHostConnectionCoordinate; deadlineMs: number; nextRequestId(): number};
  deliveryKind: "bootstrap" | "owner";
  signal?: AbortSignal;
}): Promise<StopRestoreOutcome> {
  const {store, connection: c, signal} = options, input = {...snapshotStopRestoreLookup(options.lookup), host: c.host};
  const check = () => {if (signal?.aborted) throw signal.reason;};
  const request = () => ({id: c.nextRequestId(), workspace: c.workspace, deadlineMs: c.deadlineMs});
  let capture: StopRestoreCutCapture | undefined;
  try {
    check();
    const opened = store.openStopRestoreCut(input);
    if (opened.kind === "waiting") return {kind: "pending", reason: "The saved owner adoption is unavailable."};
    if (opened.kind === "ready") {
      capture = opened.capture;
      if (capture.deliveryKind !== options.deliveryKind) throw new Error("Restore delivery kind does not match its configured host.");
      const binding = capture.binding;
      const registered = await c.client.sendRequest({...request(), method: "liveApplication.register", params: {
        binding: {...binding, selectorPaths: [...binding.selectorPaths]},
        ...(capture.resumeAdoptionId === null ? {} : {resumeAdoptionId: capture.resumeAdoptionId}),
      }}, signal);
      check();
      const registrationResult = configRecord(registered.result, [], ["registrationId", "status", "reason"]);
      if (registrationResult.status === "pending" && typeof registrationResult.reason === "string") return {kind: "pending", reason: registrationResult.reason};
      const registrationId = authorityInteger(configRecord(registered.result, ["registrationId"]).registrationId, 1);
      for (;;) {
        check();
        const next = store.nextStopRestoreCut(capture);
        if (next.kind === "done") {store.completeStopRestoreCut(capture); break;}
        const native = {...request(), registrationId};
        const response = next.kind === "bootstrap"
          ? await c.client.sendLiveBootstrap(native, next.baseline, signal)
          : await c.client.sendLiveApplication(native, next.admitted, signal);
        check();
        const result = configRecord(response.result, ["status"], ["ack", "reason"]);
        if (result.status === "pending" && typeof result.reason === "string") return {kind: "pending", reason: result.reason};
        if (next.kind === "bootstrap") {
          if (result.status !== "bootstrapped") throw new Error("Restore bootstrap did not commit.");
          store.acknowledgeStopRestoreBootstrap(capture, result.ack);
        } else {
          if (result.status !== "applied") throw new Error("Restore application did not commit.");
          store.acknowledgeStopRestoreApplication(capture, next.predecessor, result.ack);
        }
      }
    } else if (opened.receipt.kind !== options.deliveryKind) throw new Error("Restore delivery kind does not match its configured host.");
    check();
    const pending = store.pendingStopRestoreFence(input);
    if (pending.receipt) return {kind: "done", receipt: pending.receipt};
    const response = await c.client.sendRequest({...request(), method: "liveApplication.fenceRestore", params: {operation: pending.operation as never}}, signal);
    check();
    const result = configRecord(response.result, ["status", "receipt"]);
    if (result.status !== "fenced") throw new Error("Native restore fence did not commit.");
    const receipt = parseNativeRestoreFenceReceipt(result.receipt);
    if (!isDeepStrictEqual(receipt.operation, pending.operation)) throw new Error("Native restore fence acknowledgement changed the operation.");
    return {kind: "done", receipt: store.acknowledgeStopRestoreFence(input, receipt)};
  } finally {if (capture) store.closeStopRestoreCut(capture);}
}
