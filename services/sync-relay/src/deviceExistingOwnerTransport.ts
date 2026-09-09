import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { WebSocket } from "ws";
import { EngineClient, FrameDecoder, FrameType, encodeFrame, DEFAULT_MAX_BLOB_BYTES, NATIVE_RESTORE_STATUS, type Frame } from "@dohc/workspace-engine-client/daemon";
import { DeviceCreditWindow } from "@dohc/service-http";
import { deviceLiveHostReceive, type DeviceControlLimits, type DeviceLiveHostStart } from "@dohc/live-session-contract/device-control";
import { parseAdmittedLiveUpdateMetadata, type LiveUpdateStructRange } from "@dohc/live-session-contract/live-update-admission";
import { parseLiveObjectBinding, type LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { DeviceEngineConnection } from "./deviceEngineConnection.js";
import { configRecord } from "./deviceLiveHostConfig.js";
import {parseNativeRestoreFence, parseNativeRestoreFenceReceipt} from "./liveRestoreFence.js";
import {parseOwnerLiveSyncConfig} from "./liveSyncConfig.js";

export interface ExistingOwnerSession {
  readonly nativeSessionId: string;
  /** Includes workspace attachment, renderer sender, session and lineage generation. */
  assertCurrent(): void;
  /** Resolves only after the renderer has queued new edits and flushed the old queue. */
  prepareHandoff(signal: AbortSignal): Promise<void>;
  finishHandoff(adopted: boolean): Promise<void>;
  remoteApplied(update: Uint8Array): Promise<void>;
  onDurableLocalChange(handler: () => void): () => void;
}

export interface ExistingOwnerDeviceConfig {
  client: EngineClient;
  workspaces: readonly { workspaceId: string; workspaceHandle: string }[];
  ownerFor(binding: LiveObjectBinding): ExistingOwnerSession;
  maxQueuedBytes: number;
  maxFrameBytes: number;
  maxUploads: number;
  maxRegistrations: number;
  aggregateBytes: number;
  maxAdoptionBytes: number;
  maxAdoptionEvents: number;
  /** Explicit private input and output bound. Omission disables restore forwarding. */
  maxRestoreBytes?: number;
  /** Explicit bridge input/output bounds. Native sync provisioning is separate. */
  sync?: {maxClientVectorBytes: number; maxOutputBytes: number};
  requestDeadlineMs: number;
}

interface Attachment {
  id: number; size: number; digest: string; bytes: Buffer; offset: number; started: boolean; finished: boolean;
}
interface Operation {
  id: number; method: string; workspace: string; params: Record<string, unknown>; signal: AbortController;
  timer: ReturnType<typeof setTimeout>; streams: Attachment[]; charge: number;
}
interface Registration { nativeId: number; binding: LiveObjectBinding; owner: ExistingOwnerSession; adopted: boolean; adopting?: boolean; outboxId?: string; handoffTimer?: ReturnType<typeof setTimeout>;
  stopChanges?: () => void; dirty?: boolean; }

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("Invalid device owner integer.");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 512) throw new Error("Invalid device owner identifier.");
  return value;
}
function restoreOperation(method: string): "prepare" | "apply" | "settle" | "resume" | undefined {
  switch (method) {
    case "liveApplication.prepareRestore": return "prepare";
    case "liveApplication.applyRestore": return "apply";
    case "liveApplication.settleRestore": return "settle";
    case "liveApplication.resumeRestore": return "resume";
  }
}

/** Curated remote host facade. It never forwards an arbitrary daemon method. */
export function startExistingOwnerDeviceTransport(options: {
  config: ExistingOwnerDeviceConfig; start: DeviceLiveHostStart; ws: WebSocket; limits: DeviceControlLimits; stop(): void;
}) {
  const { config, start, ws, limits } = options;
  for (const value of [config.maxQueuedBytes,config.maxUploads,config.maxRegistrations,config.aggregateBytes,config.maxAdoptionBytes,config.maxAdoptionEvents]) integer(value,1);
  integer(config.requestDeadlineMs,1,2_147_483_647);
  integer(config.maxFrameBytes,1_048_576,16_777_216);
  const maxRestoreBytes = config.maxRestoreBytes === undefined ? undefined : integer(config.maxRestoreBytes,5,DEFAULT_MAX_BLOB_BYTES);
  const noticeCharge = config.maxFrameBytes * 3;
  const operationBudget = config.aggregateBytes - noticeCharge;
  if (operationBudget < config.maxFrameBytes) throw new Error("Owner notification cannot fit its transport budget.");
  const sync = parseOwnerLiveSyncConfig(config.sync, operationBudget, config.maxFrameBytes);
  if (maxRestoreBytes !== undefined && maxRestoreBytes * 5 + config.maxFrameBytes > operationBudget) throw new Error("Invalid owner restore transport budget.");
  if (config.maxAdoptionBytes * 3 + config.maxFrameBytes > operationBudget || config.maxQueuedBytes < Math.max(limits.maxPayloadBytes + 16,config.maxFrameBytes + 36)) throw new Error("Invalid existing owner transport budget.");
  const workspaces = new Map(config.workspaces.map(row => [row.workspaceHandle, row.workspaceId]));
  if (!workspaces.size || workspaces.size !== config.workspaces.length || new Set(workspaces.values()).size !== workspaces.size) throw new Error("Invalid existing owner workspaces.");
  const retired = new AbortController(), operations = new Map<number,Operation>(), registrations = new Map<number,Registration>();
  const decoder = new FrameDecoder(config.maxFrameBytes,256*1024);
  const receive = deviceLiveHostReceive(limits,{ maxPayloadBytes: limits.maxPayloadBytes,maxPendingBytes: config.maxQueuedBytes });
  const credit = new DeviceCreditWindow(receive.maxPendingBytes,receive.maxPayloadBytes);
  let received = 0, charged = 0, lastId = 0, lastStream = 0, ready = false, attached = false, closed = false, requestId = 0, eventSeq = 0;
  let notifying = false;
  let notificationReservation = noticeCharge;
  const next = () => integer(++requestId,1);
  const stop = () => { if (closed) return; closed = true; retired.abort(new Error("Owner device connection retired."));
    for (const operation of operations.values()) { clearTimeout(operation.timer); operation.signal.abort(retired.signal.reason); }
    operations.clear(); connection.close();
    for (const registration of registrations.values()) { clearTimeout(registration.handoffTimer); registration.stopChanges?.(); registration.stopChanges = undefined; void registration.owner.finishHandoff(false).catch(() => undefined); }
    registrations.clear(); notificationReservation = 0; options.stop(); };
  const connection = new DeviceEngineConnection(ws,limits,start.receive,config.maxQueuedBytes,stop);
  const check = () => { if (closed || retired.signal.aborted) throw new Error("Owner device connection retired."); };
  const write = (bytes: Buffer,signal?: AbortSignal): Promise<void> => new Promise((resolve,reject) => {
    check(); signal?.throwIfAborted();
    const cleanup = () => {connection.offDrain(drained); connection.offClose(gone); signal?.removeEventListener("abort",aborted);};
    const drained = () => { cleanup(); resolve(); };
    const gone = () => { cleanup(); reject(new Error("Owner device connection retired.")); };
    const aborted = () => {cleanup(); reject(signal!.reason);};
    connection.onDrain(drained); connection.onClose(gone);
    signal?.addEventListener("abort",aborted,{once:true});
    try { if (connection.write(bytes)) drained(); }
    catch (error) { cleanup(); reject(error); }
  });
  const send = (value: unknown,signal?: AbortSignal) => write(encodeFrame(FrameType.Control,0,Buffer.from(JSON.stringify(value)),config.maxFrameBytes),signal);
  const notifyChanges = () => {
    if (notifying || closed || !ready) return;
    notifying = true;
    queueMicrotask(() => {void (async () => {
      try {
        for (;;) {
          check();
          const registration = [...registrations.values()].find(entry => entry.adopted && entry.dirty);
          if (!registration) break;
          if (operations.size > 0) break;
          registration.owner.assertCurrent();
          registration.dirty = false;
          await send({type: "event", name: "liveApplication.ownerOutboxChanged", seq: integer(++eventSeq, 1), sessionGeneration: 1,
            payload: {registrationId: registration.nativeId, binding: registration.binding}}, retired.signal);
          // A change while this notification drains leaves dirty set for the next pass.
        }
      } catch {stop();}
      finally {notifying = false;}
    })();});
  };
  const observeOwner = (registration: Registration) => {
    if (registration.stopChanges) return;
    registration.stopChanges = registration.owner.onDurableLocalChange(() => {
      if (closed || registrations.get(registration.nativeId) !== registration) return;
      try {registration.owner.assertCurrent(); registration.dirty = true; notifyChanges();}
      catch {stop();}
    });
  };
  const registrationFor = (operation: Operation): Registration => {
    const registration = registrations.get(integer(operation.params.registrationId,1));
    if (!registration || workspaces.get(operation.workspace) !== registration.binding.workspaceId) throw new Error("Owner registration is unavailable.");
    return registration;
  };
  const sendBlob = async (operation: Operation, bytes: Buffer, signal: AbortSignal, assertCurrent: () => void) => {
    const digest = createHash("sha256").update(bytes).digest("hex"), streamId = operation.id;
    assertCurrent();
    await send({type: "blobStart", requestId: operation.id, streamId, totalBytes: bytes.length, sha256: digest}, signal);
    for (let offset = 0; offset < bytes.length || offset === 0; offset += 256 * 1024) {
      assertCurrent();
      const end = Math.min(offset + 256 * 1024, bytes.length);
      await write(encodeFrame(FrameType.BlobChunk, end === bytes.length ? 1 : 0,
        {streamId, bytes: bytes.subarray(offset, end)}, 256 * 1024), signal);
    }
    assertCurrent();
    return {streamId, byteLength: bytes.length, digest};
  };
  async function execute(operation: Operation): Promise<void> {
    let result: unknown;
    let owner: ExistingOwnerSession | undefined;
    let registration: Registration | undefined, armedHandoff = false;
    try {
      check();
      const signal = AbortSignal.any([retired.signal,operation.signal.signal]);
      const request = { id: next(),workspace: operation.workspace,deadlineMs: config.requestDeadlineMs };
      const restoring = restoreOperation(operation.method);
      if (operation.method === "liveApplication.hosts") {
        if (operation.workspace || Object.keys(operation.params).length) throw new Error("Invalid owner discovery.");
        result = { relayNamespace: start.relayNamespace,host: start.host,workspaces: config.workspaces,ownerSessions: { maxBytes: config.maxAdoptionBytes,maxEvents: config.maxAdoptionEvents } };
      } else if (restoring) {
        if (maxRestoreBytes === undefined) throw new Error("Owner restore forwarding is not configured.");
        const bytes = operation.streams[0]!.bytes;
        if (bytes.length < 5 || bytes.readUInt32LE(0) !== bytes.length - 4) throw new Error("Invalid owner restore header framing.");
        const header = configRecord(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(4))),
          ["fence","point",...(restoring === "prepare" ? [] : ["candidateDigest","nativeSourceManifestDigest","admitted"]),...(restoring === "resume" ? ["settlementId"] : [])]);
        const fence = parseNativeRestoreFenceReceipt(header.fence).operation;
        if (workspaces.get(operation.workspace) !== fence.oldBinding.workspaceId || fence.relayDatabaseNamespace !== start.relayNamespace || fence.hostId !== start.host.hostId) throw new Error("Restore host identity mismatch.");
        const outputBound = Math.min(maxRestoreBytes,integer(operation.params.maxOutputBytes,5,DEFAULT_MAX_BLOB_BYTES));
        const output = await config.client.sendLiveRestore(request,restoring,bytes,outputBound,signal);
        check(); signal.throwIfAborted();
        if (output.bytes.length > outputBound) throw new Error("Owner restore response exceeds its bound.");
        const digest = createHash("sha256").update(output.bytes).digest("hex"), streamId = operation.id;
        await send({type:"blobStart",requestId:operation.id,streamId,totalBytes:output.bytes.length,sha256:digest},signal);
        const chunkBytes = 256 * 1024;
        for (let offset = 0; offset < output.bytes.length || offset === 0; offset += chunkBytes) {
          const end = Math.min(offset + chunkBytes,output.bytes.length);
          await write(encodeFrame(FrameType.BlobChunk,end === output.bytes.length ? 1 : 0,{streamId,bytes:output.bytes.subarray(offset,end)},chunkBytes),signal);
        }
        result = {status:NATIVE_RESTORE_STATUS[restoring],streamId,byteLength:output.bytes.length,digest};
      } else if (operation.method === "liveApplication.fenceRestore") {
        const params = configRecord(operation.params,["operation"]), fence = parseNativeRestoreFence(params.operation);
        if (workspaces.get(operation.workspace) !== fence.oldBinding.workspaceId || fence.relayDatabaseNamespace !== start.relayNamespace || fence.hostId !== start.host.hostId) throw new Error("Restore host identity mismatch.");
        const response = await config.client.sendRequest({...request, method: operation.method, params: {operation: fence as never}}, signal);
        const value = configRecord(response.result,["status","receipt"]);
        if (value.status !== "fenced") throw new Error("Native restore fence did not commit.");
        const receipt = parseNativeRestoreFenceReceipt(value.receipt);
        if (!isDeepStrictEqual(receipt.operation, fence)) throw new Error("Native restore fence acknowledgement mismatch.");
        for (const [id, entry] of registrations) if (entry.binding.workspaceId === fence.oldBinding.workspaceId && entry.binding.mainVersionId === fence.oldBinding.mainVersionId && entry.binding.objectId === fence.oldBinding.objectId) {
          clearTimeout(entry.handoffTimer); entry.stopChanges?.(); entry.stopChanges = undefined; registrations.delete(id);
        }
        result = {status: "fenced", receipt};
      } else if (operation.method === "liveApplication.register") {
        const params = configRecord(operation.params,["binding"],["resumeAdoptionId"]), binding = parseLiveObjectBinding(params.binding);
        const resumeAdoptionId = params.resumeAdoptionId === undefined ? undefined : string(params.resumeAdoptionId);
        if (workspaces.get(operation.workspace) !== binding.workspaceId) throw new Error("Owner workspace mismatch.");
        const existing = [...registrations.values()].find(row => isDeepStrictEqual(row.binding,binding));
        if (existing && resumeAdoptionId === undefined) { owner = existing.owner; owner.assertCurrent(); await send({type: "response",id: operation.id,result: {registrationId: existing.nativeId}},signal); return; }
        if (!existing && registrations.size >= config.maxRegistrations) throw new Error("Owner registration capacity exceeded.");
        try {owner = existing?.owner ?? config.ownerFor(binding); owner.assertCurrent();}
        catch (error) {
          if (resumeAdoptionId === undefined) throw error;
          owner = undefined;
          await send({type: "response",id: operation.id,result: {status: "pending",reason: "The existing owner session is unavailable."}},signal); return;
        }
        const nativeId = existing?.nativeId ?? integer(configRecord((await config.client.sendRequest({...request,method: operation.method,params: {binding: {...binding,selectorPaths: [...binding.selectorPaths]}}},signal)).result,["registrationId"]).registrationId,1);
        registration = existing ?? {nativeId,binding,owner,adopted: false};
        registrations.set(nativeId,registration);
        observeOwner(registration);
        owner.assertCurrent();
        if (resumeAdoptionId !== undefined) {
          if (existing?.handoffTimer) throw new Error("Owner handoff is already active.");
          const response = await config.client.sendRequest({...request,id: next(),method: "liveApplication.ownerState",params: {registrationId: nativeId,sessionId: owner.nativeSessionId}},signal);
          owner.assertCurrent();
          const state = configRecord(response.result,["adoptionId","expectedLocalSequence","throughCursor","outboxId","pendingBytes","outboxState"]);
          if (state.throughCursor === null) {
            await send({type: "response",id: operation.id,result: {status: "pending",reason: "The existing owner adoption is unavailable."}},signal); return;
          }
          integer(state.throughCursor);
          if (state.adoptionId !== resumeAdoptionId) throw new Error("Owner adoption identity mismatch.");
          registration.adopted = true;
          registration.dirty = true;
        }
        result = {registrationId: nativeId};
      } else {
        registration = registrationFor(operation); owner = registration.owner; owner.assertCurrent();
        const native = { ...request,registrationId: registration.nativeId,sessionId: owner.nativeSessionId };
        if (["liveApplication.syncOpen", "liveApplication.appliedRead", "liveApplication.ack"].includes(operation.method)) {
          if (!registration.adopted) throw new Error("Owner adoption must finish first.");
          const current = () => {
            check(); signal.throwIfAborted(); owner!.assertCurrent();
            if (registrations.get(registration!.nativeId) !== registration) throw new Error("Owner registration is unavailable.");
          };
          if (operation.method === "liveApplication.ack") {
            const params = configRecord(operation.params, ["registrationId", "deliveryId", "updateDigest"]);
            const ack = await config.client.readLiveApplicationAck(native,
              {deliveryId: string(params.deliveryId), updateDigest: string(params.updateDigest)}, signal);
            current(); result = ack === null ? {status: "missing"} : {status: "applied", ack};
          } else {
            if (!sync) throw new Error("Owner sync forwarding is not configured.");
            if (operation.method === "liveApplication.syncOpen") {
              const cut = await config.client.openLiveAppliedSync(native, operation.streams[0]!.bytes,
                {maxInputBytes: sync.maxClientVectorBytes, maxOutputBytes: sync.maxOutputBytes}, signal);
              current();
              if (!isDeepStrictEqual(cut.binding, registration.binding) || cut.hostVector.length + cut.missingStateUpdate.length > sync.maxOutputBytes) throw new Error("Owner sync cut differs from its registration.");
              const bytes = Buffer.concat([cut.hostVector, cut.missingStateUpdate]);
              const output = await sendBlob(operation, bytes, signal, current);
              result = {status: "sync", binding: cut.binding, position: cut.position, observedLocalYDocHeadSequence: cut.observedLocalYDocHeadSequence,
                hostVectorByteLength: cut.hostVector.length, ...output};
            } else {
              const params = configRecord(operation.params, ["registrationId", "after"]);
              const after = params.after as Parameters<EngineClient["readNextLiveApplied"]>[1];
              const update = await config.client.readNextLiveApplied(native, after, sync.maxOutputBytes, signal);
              current();
              result = update === null ? {status: "empty", after} : {status: "update", position: update.position, ack: update.ack,
                ...await sendBlob(operation, update.updateBytes, signal, current)};
            }
          }
          current();
        } else if (operation.method === "liveApplication.ownerState") {
          configRecord(operation.params,["registrationId"]);
          if (registration.handoffTimer) throw new Error("Owner handoff is already active.");
          registration.handoffTimer = setTimeout(stop,config.requestDeadlineMs); registration.handoffTimer.unref();
          armedHandoff = true;
          await owner.prepareHandoff(signal); owner.assertCurrent();
          const response = await config.client.sendRequest({ ...request,method: operation.method,params: { registrationId: registration.nativeId,sessionId: owner.nativeSessionId } },signal);
          owner.assertCurrent(); const state = configRecord(response.result,["adoptionId","expectedLocalSequence","throughCursor","outboxId","pendingBytes","outboxState"]);
          result = {adoptionId: state.adoptionId,expectedLocalSequence: state.expectedLocalSequence,
            throughCursor: state.throughCursor === null && state.outboxId === null ? 0 : state.throughCursor,sessionId: String(registration.nativeId)};
        } else if (operation.method === "liveApplication.ownerOutbox") {
          configRecord(operation.params,["registrationId"]);
          if (!registration.adopted) throw new Error("Owner adoption must finish first.");
          const response = await config.client.sendRequest({...request,method: "liveApplication.ownerState",params: {registrationId: registration.nativeId,sessionId: owner.nativeSessionId}},signal);
          owner.assertCurrent();
          const state = configRecord(response.result,["adoptionId","expectedLocalSequence","throughCursor","outboxId","pendingBytes","outboxState"]);
          registration.outboxId = state.outboxId === null ? undefined : string(state.outboxId);
          result = {outboxId: registration.outboxId ?? null,pendingBytes: integer(state.pendingBytes),state: state.outboxState};
        } else if (operation.method === "liveApplication.readOwnerOutbox" || operation.method === "liveApplication.acknowledgeOwnerOutbox") {
          if (!registration.adopted || !registration.outboxId) throw new Error("Owner outbox is unavailable.");
          const reading = operation.method === "liveApplication.readOwnerOutbox";
          const params = configRecord(operation.params,reading ? ["registrationId"] : ["registrationId","receipts"],reading ? ["cursor"] : []);
          const response = await config.client.sendRequest({...request,method: reading ? "ydoc.ownerOutbox.readPending" : "ydoc.ownerOutbox.acknowledge",
            params: {outboxId: registration.outboxId,...(reading ? (params.cursor === undefined ? {} : {cursor: params.cursor as never}) : {receipts: params.receipts as never})}},signal);
          owner.assertCurrent(); result = response.result;
        } else if (operation.method === "liveApplication.adoptOwner") {
          if (!registration.handoffTimer || registration.adopting) throw new Error("Owner handoff was not prepared.");
          if (operation.params.sessionId !== String(registration.nativeId)) throw new Error("Owner session mismatch.");
          registration.adopting = true; armedHandoff = true;
          const response = await config.client.forwardLiveOwnerAdoption(native,operation.streams[0]!.bytes,config.maxAdoptionBytes,signal);
          owner.assertCurrent();
          const adopted = configRecord(response.result,["status","adoption"]);
          if (adopted.status !== "adopted") throw new Error("Owner adoption did not commit.");
          registration.adopted = true; result = response.result;
        } else if (operation.method === "liveApplication.apply") {
          if (!registration.adopted) throw new Error("Owner adoption must finish first.");
          const update = operation.streams[0]!.bytes, packed = operation.streams[1]!.bytes, firstSeen: LiveUpdateStructRange[] = [];
          for (let offset = 0; offset < packed.length; offset += 16) firstSeen.push({ clientId: Number(packed.readBigUInt64LE(offset)),startClock: packed.readUInt32LE(offset+8),endClock: packed.readUInt32LE(offset+12) });
          const metadata = parseAdmittedLiveUpdateMetadata({ accepted: operation.params.accepted,firstSeen });
          const response = await config.client.sendLiveApplication(native,{ metadata,updateBytes: update },signal);
          owner.assertCurrent();
          if ((response.result as { status?: unknown }).status === "applied") await owner.remoteApplied(update);
          owner.assertCurrent(); result = response.result;
        } else if (operation.method === "liveApplication.settle") {
          if (!registration.adopted) throw new Error("Owner adoption must finish first.");
          const params = configRecord(operation.params,["registrationId","terminalReceipt"]);
          result = (await config.client.sendRequest({ ...request,method: operation.method,params: { registrationId: registration.nativeId,terminalReceipt: params.terminalReceipt as never } },signal)).result;
          owner.assertCurrent();
        } else throw new Error("Owner device method is unavailable.");
      }
      check(); if (operation.signal.signal.aborted) throw operation.signal.signal.reason;
      if (registration && ["liveApplication.syncOpen", "liveApplication.appliedRead", "liveApplication.ack"].includes(operation.method)) {
        owner!.assertCurrent();
        if (registrations.get(registration.nativeId) !== registration) throw new Error("Owner registration is unavailable.");
      }
      if (operation.method === "liveApplication.adoptOwner") {
        await owner!.finishHandoff(true);
        check(); signal.throwIfAborted(); owner!.assertCurrent();
        clearTimeout(registration!.handoffTimer); registration!.handoffTimer = undefined; registration!.adopting = false;
        registration!.dirty = true;
        armedHandoff = false;
      }
      await send({ type: "response",id: operation.id,result },signal);
      check(); signal.throwIfAborted();
      if (registration?.adopted) notifyChanges();
    } catch {
      if (owner) {try {owner.assertCurrent();} catch {stop();}}
      if (owner && armedHandoff) {
        clearTimeout(registration?.handoffTimer); if (registration) { registration.handoffTimer = undefined; registration.adopting = false; }
        await owner.finishHandoff(false).catch(() => undefined);
      }
      if (!closed && !operation.signal.signal.aborted) await send({ type: "error",id: operation.id,error: { code: "FORBIDDEN",message: "owner-device-operation-refused",retryability: "no" } },operation.signal.signal).catch(() => {if (!operation.signal.signal.aborted) stop();});
    } finally { operations.delete(operation.id); charged -= operation.charge; clearTimeout(operation.timer); notifyChanges(); }
  }
  function attachment(id: unknown,size: unknown,digest: unknown,maximum: number): Attachment {
    const streamId = integer(id,lastStream+1), length = integer(size,0,maximum), hash = string(digest);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid owner stream digest.");
    lastStream = streamId;
    return { id: streamId,size: length,digest: hash,bytes: Buffer.alloc(length),offset: 0,started: false,finished: false };
  }
  function frame(frame: Frame): void {
    check();
    if (frame.kind === "blobChunk") {
      const operation = [...operations.values()].find(row => row.streams.some(stream => stream.id === frame.streamId));
      const stream = operation?.streams.find(row => row.id === frame.streamId);
      if (!operation || !stream || !stream.started || stream.finished || stream.offset + frame.payload.length > stream.size || (!frame.payload.length && !frame.fin)) throw new Error("Invalid owner stream chunk.");
      frame.payload.copy(stream.bytes,stream.offset); stream.offset += frame.payload.length;
      if (frame.fin) {
        if (stream.offset !== stream.size || createHash("sha256").update(stream.bytes).digest("hex") !== stream.digest) throw new Error("Owner stream digest mismatch.");
        stream.finished = true;
        if (operation.streams.every(row => row.finished)) void execute(operation);
      } else if (stream.offset === stream.size) throw new Error("Owner stream has no terminal flag.");
      return;
    }
    const value = JSON.parse(frame.payload.toString("utf8")) as Record<string,unknown>;
    if (!ready) {
      const hello = configRecord(value,["type","protocolVersion","authToken","capabilities","maxFrameBytes","lastSessionGeneration"]);
      if (hello.type !== "hello" || hello.protocolVersion !== 2 || hello.authToken !== start.authToken || !Array.isArray(hello.capabilities) || !hello.capabilities.includes("blobs")) throw new Error("Invalid owner handshake.");
      ready = true;
      void send({ type: "helloAck",protocolVersion: 2,sessionGeneration: 1,capabilities: ["blobs"],limits: { maxFrameBytes: Math.min(integer(hello.maxFrameBytes,1_048_576),config.maxFrameBytes),maxBlobChunkBytes: 256*1024,maxStringBytes: 1_048_576,maxCollectionLen: 100_000,maxBatchLen: 1,maxJsonDepth: 32 } }).catch(stop);
      return;
    }
    if (value.type === "cancel") { const operation = operations.get(integer(value.id,1)); operation?.signal.abort(new Error("Owner operation cancelled.")); return; }
    if (value.type === "blobStart") {
      const operation = operations.get(integer(value.requestId,1)), stream = operation?.streams.find(row => row.id === value.streamId);
      if (!stream || stream.started || value.totalBytes !== stream.size || value.sha256 !== stream.digest) throw new Error("Invalid owner stream start.");
      stream.started = true; return;
    }
    if (value.type !== "request" || operations.size >= config.maxUploads) throw new Error("Owner operation capacity exceeded.");
    const id = integer(value.id,lastId+1), method = string(value.method), workspace = value.workspace == null ? "" : string(value.workspace);
    const restoring = restoreOperation(method);
    if ((!restoring && !["liveApplication.hosts","liveApplication.register","liveApplication.fenceRestore","liveApplication.ownerState","liveApplication.ownerOutbox","liveApplication.readOwnerOutbox","liveApplication.acknowledgeOwnerOutbox","liveApplication.adoptOwner","liveApplication.apply","liveApplication.settle","liveApplication.syncOpen","liveApplication.appliedRead","liveApplication.ack"].includes(method)) || (restoring && maxRestoreBytes === undefined) || (method !== "liveApplication.hosts" && !workspaces.has(workspace)) || value.idempotencyKey != null) throw new Error("Owner method is unavailable.");
    const params = value.params as Record<string,unknown>;
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Invalid owner params.");
    const updateBytes = method === "liveApplication.apply" ? integer(params.updateByteLength,2,20_971_520) : 0;
    const rangeBytes = method === "liveApplication.apply" ? integer(params.rangeCount,0,Math.floor((updateBytes-2)/5))*16 : 0;
    if (restoring) {
      configRecord(params,["streamId","byteLength","digest","maxOutputBytes"]);
      integer(params.maxOutputBytes,5,DEFAULT_MAX_BLOB_BYTES);
    }
    const syncing = method === "liveApplication.syncOpen", appliedRead = method === "liveApplication.appliedRead";
    if ((syncing || appliedRead) && !sync) throw new Error("Owner sync forwarding is not configured.");
    if (syncing) configRecord(params, ["registrationId", "streamId", "byteLength", "digest"]);
    const bytes = syncing ? integer(params.byteLength,1,sync!.maxClientVectorBytes) : restoring ? integer(params.byteLength,5,maxRestoreBytes!) : method === "liveApplication.adoptOwner" ? integer(params.byteLength,1,config.maxAdoptionBytes) : updateBytes + rangeBytes;
    const charge = bytes * 3 + (syncing || appliedRead ? 3 * sync!.maxOutputBytes : restoring ? 2 * maxRestoreBytes! : 0) + config.maxFrameBytes;
    if (!Number.isSafeInteger(charge) || charged + charge + notificationReservation > config.aggregateBytes) throw new Error("Owner operation capacity exceeded.");
    charged += charge; lastId = id;
    const signal = new AbortController(), timer = setTimeout(stop,Math.min(integer(value.deadlineMs ?? config.requestDeadlineMs,1),config.requestDeadlineMs)); timer.unref();
    const operation: Operation = { id,method,workspace,params,signal,timer,streams: [],charge };
    operations.set(id,operation);
    if (syncing) operation.streams = [attachment(params.streamId,params.byteLength,params.digest,sync!.maxClientVectorBytes)];
    else if (restoring) operation.streams = [attachment(params.streamId,params.byteLength,params.digest,maxRestoreBytes!)];
    else if (method === "liveApplication.adoptOwner") operation.streams = [attachment(params.streamId,params.byteLength,params.digest,config.maxAdoptionBytes)];
    else if (method === "liveApplication.apply") {
      const accepted = configRecord(params.accepted,["receipt","binding","authority","receivedAtMs"]);
      const receipt = configRecord(accepted.receipt,["deliveryId","updateDigest","journalCursor","acceptingHostEpoch"]);
      // The sender allocates the update stream first and the range stream second.
      operation.streams = [attachment(params.updateStreamId,updateBytes,receipt.updateDigest,20_971_520),attachment(params.rangeStreamId,rangeBytes,params.rangeDigest,Math.floor((updateBytes-2)/5)*16)];
    } else void execute(operation);
  }
  const startup = (async () => {
    await config.client.ready();
    for (const workspace of config.workspaces) {
      check(); await config.client.sendRequest({ id: next(),method: "liveApplication.provisionOwner",workspace: workspace.workspaceHandle,
        params: { relayNamespace: start.relayNamespace,host: start.host },deadlineMs: config.requestDeadlineMs },retired.signal);
    }
    check(); attached = true; connection.control(Buffer.from(JSON.stringify({ type: "liveHost.transport",version: 1,receive })));
  })().catch(stop);
  return {
    receive(bytes: Buffer) { try { check(); if (!attached) throw new Error("Early owner bytes."); credit.receive(bytes.length); decoder.push(bytes,frame); received += bytes.length+16; credit.acknowledge(received); connection.acknowledge(received); } catch { stop(); } },
    credit(total: number) { try { connection.credit(total); } catch { stop(); } },
    async close() { stop(); await startup; },
  };
}
