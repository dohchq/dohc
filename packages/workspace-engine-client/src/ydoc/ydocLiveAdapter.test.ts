import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as ydocProjection from "@dohc/ydoc-projection";
import commonmark from "../../../ydoc-projection/src/fixtures/commonmark-edit-meaning.json";
import * as Y from "yjs";
import { EXCALIDRAW_SCENE_ROOTS } from "@dohc/workspace-contracts/live-documents";
import {
  EngineRequestDeadlineError,
} from "../daemon/engineClient";
import {
  DaemonRefusalError,
} from "../live/daemonLiveAdapter";
import type { JsonValue, Request, Response } from "../protocol";
import {
  ENGINE_DELIVERED_ORIGIN,
  IllFormedUtf16EditError,
  RemoteYdocApplyError,
  YDOC_OPEN_DEADLINE_MS,
  YdocOpenTimedOutError,
  YdocSessionQuarantinedError,
  YdocLiveAdapter,
  YdocOwnerDraftPendingError,
  type EngineTransport,
  type YdocAdapterSession,
  type YdocDeliveredHead,
} from "./ydocLiveAdapter";
import { YdocLoopbackEngine } from "../testing/ydocLoopbackEngine";
import {
  openEngineYdocProviderSession,
  YdocReleasedWithSettleFailureError,
} from "./ydocProviderSession";
import {
  YDOC_EVENT,
  YDOC_METHOD,
  type YdocSettleResult,
} from "./ydocWireContract";

const WORKSPACE = "workspace-handle-1";
const VERSION = "version-1";
const PATH = "notes/live.txt";


describe("closing a settled revision", () => {
  it.each(["untouched", "edited"])("settles an absent lineage on close only after an edit (%s)", async state => {
    const edited = state === "edited";
    const engine = new YdocLoopbackEngine();
    const settle = vi.fn();
    const onSettleError = vi.fn();
    const provider = await openEngineYdocProviderSession({
      transport: {
        ...forwardYdocBlobEgress(engine),
        onEvent: handler => engine.onEvent(handler),
        async sendRequest(request) {
          if (request.method === YDOC_METHOD.settle) {
            settle();
            // The daemon refuses NoMarker until the first durable update.
            if (!engine.requests.some(request => request.method === YDOC_METHOD.recordUpdate)) {
              throw new DaemonRefusalError({
                code: "INVALID_PARAMS", message: "workspace operation failed", retry: "no",
              }, undefined);
            }
          }
          return engine.sendRequest(request);
        },
      },
      workspace: WORKSPACE, versionId: VERSION, path: PATH,
      contentKind: "plaintext", onRemoteUpdate: () => undefined,
      scheduleSettle: () => () => undefined, onSettleError,
    });
    expect(provider.head).toBe("absent");
    expect(provider.lineage).toBe("absent");
    if (edited) {
      await provider.applyLocalUpdate(plaintextUpdate(provider.initialUpdate, text => text.insert(0, "first edit")));
    }

    await expect(provider.close()).resolves.toBeUndefined();

    expect(settle).toHaveBeenCalledTimes(edited ? 1 : 0);
    expect(onSettleError).not.toHaveBeenCalled();
    expect(engine.requests.filter(request => request.method === YDOC_METHOD.close)).toHaveLength(1);
  });

  async function fixture(onSettled?: (result: YdocSettleResult) => boolean | void | Promise<boolean | void>) {
    const engine = seedPlaintextEngine("seed");
    const provider = await openEngineYdocProviderSession({
      transport: engine, workspace: WORKSPACE, versionId: VERSION, path: PATH,
      contentKind: "plaintext", onRemoteUpdate: () => undefined,
      scheduleSettle: () => () => undefined, onSettled,
    });
    await provider.applyLocalUpdate(plaintextUpdate(provider.initialUpdate, text => text.insert(0, "edited ")));
    return { engine, provider };
  }

  it("settles and verifies once before releasing an unchanged record", async () => {
    const onSettled = vi.fn();
    const { engine, provider } = await fixture(onSettled);
    await provider.settleNow();
    await provider.close();
    expect(engine.requests.filter(request => request.method === YDOC_METHOD.settle)).toHaveLength(1);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(engine.activeSessionIds()).toHaveLength(0);
  });

  it.each([2])("keeps settling-close refusal handling after %i refusals", async refusals => {
    const engine = seedPlaintextEngine("seed");
    const closeFlags: boolean[] = [];
    const refusal = new DaemonRefusalError({
      code: "OVERLOADED", message: "engine-store-busy", retry: "afterBackoff",
    }, new Error("close refused"));
    const onSettled = vi.fn();
    const provider = await openEngineYdocProviderSession({
      transport: {
        ...forwardYdocBlobEgress(engine),
        onEvent: handler => engine.onEvent(handler),
        async sendRequest(request) {
          if (request.method === YDOC_METHOD.close) {
            closeFlags.push((request.params as { settle: boolean }).settle);
            if (closeFlags.length <= refusals) throw refusal;
          }
          if (request.method === YDOC_METHOD.recordUpdate) return recordUnderClaim(engine, request, "owner-claim", true);
          const response = await engine.sendRequest(request);
          if (request.method === YDOC_METHOD.open || request.method === YDOC_METHOD.resync) {
            return { ...response, result: { ...(response.result as Record<string, JsonValue>),
              lineageClaimId: "owner-claim", lineageOriginatedHere: true } };
          }
          return response;
        },
      }, workspace: WORKSPACE, versionId: VERSION, path: PATH,
      contentKind: "plaintext", onRemoteUpdate: () => undefined,
      scheduleSettle: () => () => undefined, onSettled,
    });
    await provider.settleNow();
    expect(provider.lineageClaimId).toBe("owner-claim");
    engine.markSessionReplicated(provider.nativeOwner!.sessionId);
    if (refusals === 2) {
      await expect(provider.close()).rejects.toBe(refusal);
      expect(engine.activeSessionIds()).toHaveLength(1);
    }
    await expect(provider.close()).resolves.toBeUndefined();
    expect(closeFlags).toEqual(refusals === 1 ? [false, true] : [false, true, false]);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(engine.activeSessionIds()).toHaveLength(0);
  });

  it.each(["persist-failed", "blocked target"])("releases and reports a claimed lineage's %s at close", async failure => {
    const engine = seedPlaintextEngine("seed");
    let failSettle = false;
    const refusal = new DaemonRefusalError({
      code: failure === "persist-failed" ? "INTERNAL" : "INVALID_PARAMS",
      message: failure, retry: "no",
    }, new Error("settle refused"));
    const onSettled = vi.fn();
    const onSettleStart = vi.fn();
    const onSettleError = vi.fn();
    const closes: boolean[] = [];
    const provider = await openEngineYdocProviderSession({
      transport: {
        ...forwardYdocBlobEgress(engine),
        onEvent: handler => engine.onEvent(handler),
        async sendRequest(request) {
          if (request.method === YDOC_METHOD.close) {
            const settle = (request.params as { settle: boolean }).settle;
            closes.push(settle);
            if (settle && failSettle && failure !== "blocked target") throw refusal;
          }
          if (request.method === YDOC_METHOD.settle && failSettle && failure !== "blocked target") throw refusal;
          if (request.method === YDOC_METHOD.recordUpdate) return recordUnderClaim(engine, request, "owner-claim", true);
          const response = await engine.sendRequest(request);
          if (request.method === YDOC_METHOD.settle && failSettle) {
            return { ...response, result: { ...(response.result as Record<string, JsonValue>), materialized: false } };
          }
          if (request.method === YDOC_METHOD.open || request.method === YDOC_METHOD.resync) {
            return { ...response, result: { ...(response.result as Record<string, JsonValue>),
              lineageClaimId: "owner-claim", lineageOriginatedHere: true } };
          }
          return response;
        },
      }, workspace: WORKSPACE, versionId: VERSION, path: PATH,
      contentKind: "plaintext", onRemoteUpdate: () => undefined,
      scheduleSettle: () => () => undefined, onSettled, onSettleStart, onSettleError,
    });
    await provider.settleNow();
    expect(provider.lineageClaimId).toBe("owner-claim");
    engine.markSessionReplicated(provider.nativeOwner!.sessionId);
    failSettle = true;
    const error = await provider.close().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(YdocReleasedWithSettleFailureError);
    expect(engine.activeSessionIds()).toHaveLength(0);
    expect(closes).toEqual([false]);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettleError).toHaveBeenCalledOnce();
    const [cause, token] = onSettleError.mock.calls[0]!;
    expect(error).toMatchObject({ cause });
    expect(token).toBeGreaterThan(1);
    expect(onSettleStart.mock.calls.at(-1)).toEqual([token]);
    if (failure !== "blocked target") expect(cause).toBe(refusal);
    else expect(String(cause)).toContain("blocked target");
  });

  it("does not certify edits arriving while the settle callback waits", async () => {
    let provider: Awaited<ReturnType<typeof openEngineYdocProviderSession>>;
    const onSettled = vi.fn(async () => {
      if (onSettled.mock.calls.length === 1) {
        await provider.applyLocalUpdate(plaintextUpdate(Y.encodeStateAsUpdate(provider.doc), text => text.insert(0, "late ")));
      }
    });
    const opened = await fixture(onSettled);
    provider = opened.provider;
    await provider.settleNow();
    await provider.close();
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it("retries verification that refused the settled artifact", async () => {
    const onSettled = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const { engine, provider } = await fixture(onSettled);
    await provider.settleNow();
    await provider.close();
    expect(engine.requests.filter(request => request.method === YDOC_METHOD.settle)).toHaveLength(2);
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

});

it("keeps owner draft durability distinct from native settlement and preserves it on close", async () => {
  const engine = new YdocLoopbackEngine();
  const path = "notes/owner.md";
  engine.seedFile({workspace: WORKSPACE, versionId: VERSION, path, objectId: "owner-object", content: "seed", contentKind: "richdoc"});
  const seedAdapter = new YdocLiveAdapter(engine);
  const seed = await seedAdapter.openSession({workspace: WORKSPACE,versionId:VERSION,path,contentKind:"richdoc"});
  engine.markSessionReplicated(seed.sessionId);
  const objectId = seed.objectId;
  await seed.close({settle:false});
  seedAdapter.dispose();
  let revision = 1;
  let accepted = false;
  const descriptor = () => ({
    binding: {workspaceId:"workspace",mainVersionId:VERSION,objectId,lineageClaimId:"a".repeat(64),currentPath:path,selectorPaths:[path],restoreFenceGeneration:0},
    relayDatabaseNamespace:"relay",revision,acceptedCursor:accepted ? 1 : 0,nativeHeadSequence:1, nativeUnsettled: false,
    outboxId:"outbox",pendingBytes:accepted ? 0 : 20,state:"active",
  });
  const transport: EngineTransport = {
    ...forwardYdocBlobEgress(engine), onEvent: handler => engine.onEvent(handler),
    async sendRequest(request) {
      if (request.method === YDOC_METHOD.recordUpdate) {
        const response = await recordUnderClaim(engine, request, "a".repeat(64));
        return {...response,result:{lineageClaimId:"a".repeat(64),lineageOriginatedHere:false,ownerDraft:{outboxId:"outbox",sequence:2,deliveryId:"delivery",updateDigest:"b".repeat(64),pendingBytes:40,state:"active"}}};
      }
      const response = await engine.sendRequest(request);
      if (request.method === YDOC_METHOD.open || request.method === YDOC_METHOD.resync) {
        return {...response,result:{...response.result as Record<string, JsonValue>,lineageClaimId:"a".repeat(64),ownerDraft:descriptor()}};
      }
      return response;
    },
  };
  const scheduler = settleScheduler();
  const onSettled = vi.fn();
  const onSettleError = vi.fn();
  const provider = await openEngineYdocProviderSession({transport,workspace:WORKSPACE,versionId:VERSION,path,contentKind:"richdoc",onRemoteUpdate:()=>undefined,onSettled,onSettleError,scheduleSettle:scheduler.schedule});
  const update = richdocUpdate(provider.initialUpdate,"pending edit");
  await provider.applyLocalUpdate(update);
  await expect(provider.settleNow()).rejects.toBeInstanceOf(YdocOwnerDraftPendingError);
  expect(onSettled).not.toHaveBeenCalled();
  expect(onSettleError.mock.calls.at(-1)?.[0]).toMatchObject({draft:{pendingBytes:40}});
  expect(engine.requests.filter(request=>request.method===YDOC_METHOD.settle)).toHaveLength(0);
  accepted = true;
  engine.emitEvent({name: YDOC_EVENT.remoteUpdate, seq: 100, sessionGeneration: 1,
    payload: {sessionId: provider.nativeOwner!.sessionId, resyncRequired: true}});
  await drain();
  expect(scheduler.armed).toHaveLength(1);
  scheduler.fire();
  await vi.waitFor(() => expect(onSettleError.mock.calls.at(-1)?.[0]).toMatchObject({draft:{pendingBytes:0,acceptedCursor:1}}));
  expect(onSettled).not.toHaveBeenCalled();
  expect(engine.requests.filter(request=>request.method===YDOC_METHOD.settle)).toHaveLength(0);
  await provider.close();
  expect(engine.activeSessionIds()).toHaveLength(0);
  revision = 2;
  const reopened = await openEngineYdocProviderSession({transport,workspace:WORKSPACE,versionId:VERSION,path,contentKind:"richdoc",onRemoteUpdate:()=>undefined,scheduleSettle:scheduler.schedule});
  expect(ydocProjection.yDocToMarkdown(reopened.doc)).toContain("pending edit");
  await expect(reopened.settleNow()).rejects.toMatchObject({draft:{revision:2}});
  await reopened.close();
});

it("wakes the owner after a held consent settle and keeps its native session usable", async () => {
  const engine = new YdocLoopbackEngine();
  engine.seedFile({workspace: WORKSPACE, versionId: VERSION, path: "held.md", content: "# Note", contentKind: "richdoc"});
  const attempts: Array<{sessionId: string; allowLossySourceSha256?: string}> = [];
  const held = new DaemonRefusalError({code: "CONFLICT", message: "markdown-write-held", retry: "no"}, undefined);
  const provider = await openEngineYdocProviderSession({
    transport: {...forwardYdocBlobEgress(engine), onEvent: handler => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.settle) {
          attempts.push(request.params as {sessionId: string; allowLossySourceSha256?: string});
          if (attempts.length === 1) throw held;
        }
        return engine.sendRequest(request);
      }},
    workspace: WORKSPACE, versionId: VERSION, path: "held.md", contentKind: "richdoc",
    onRemoteUpdate() {}, scheduleSettle: () => () => {},
  });
  const owner = provider.nativeOwner!;
  const wanted = vi.fn(), changed = vi.fn();
  owner.onSettlementWanted(wanted);
  owner.onDurableLocalChange(changed);
  await provider.applyLocalUpdate(richdocUpdate(Y.encodeStateAsUpdate(provider.doc), "Accepted edit"), {armSettle: false});
  await expect(provider.settleNow({allowLossySourceSha256: "a".repeat(64)})).rejects.toBe(held);
  expect(wanted).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledOnce();
  expect(engine.activeSessionIds()).toContain(owner.sessionId);
  expect(ydocProjection.yDocToMarkdown(provider.doc)).toContain("Accepted edit");

  await provider.settleNow();
  expect(attempts).toEqual([
    {sessionId: owner.sessionId, allowLossySourceSha256: "a".repeat(64)},
    {sessionId: owner.sessionId},
  ]);
  expect(wanted).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledOnce();
  await provider.evict();
});

it.each([193])("retains CommonMark %i source and an edited paragraph through client reopen and reconnect", async number => {
  const example = commonmark.examples.find(row => row.example === number)!;
  const source = example.markdown + "\n\nEditable paragraph.\n";
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const engine = new YdocLoopbackEngine();
  engine.seedFile({workspace: WORKSPACE, versionId: VERSION, path: "commonmark.md", content: source, contentKind: "richdoc"});
  const open = () => openEngineYdocProviderSession({
    transport: engine, workspace: WORKSPACE, versionId: VERSION, path: "commonmark.md", contentKind: "richdoc",
    onRemoteUpdate() {}, scheduleSettle: () => () => {},
  });
  const first = await open();
  const projectionSha256 = first.doc.getMap("meta").get("dohcMarkdownSourceProjectionSha256");
  const assertSource = (doc: Y.Doc) => {
    expect(doc.getMap("meta").get("dohcMarkdownSource")).toBe(source);
    expect(doc.getMap("meta").get("dohcMarkdownSourceSha256")).toBe(sourceSha256);
    expect(doc.getMap("meta").get("dohcMarkdownSourceProjectionSha256")).toBe(projectionSha256);
    expect(ydocProjection.yDocToMarkdown(doc)).toContain("Changed paragraph.");
    expect(ydocProjection.yDocToMarkdown(doc)).not.toContain("Editable paragraph.");
  };
  await first.applyLocalUpdate(ydocProjection.documentEditUpdate(Y.encodeStateAsUpdate(first.doc),
    {find: "Editable paragraph.", replacement: "Changed paragraph."}, {keepBlocks: true})!, {armSettle: false});
  assertSource(first.doc);
  const sessionId = first.nativeOwner!.sessionId;
  engine.markSessionReplicated(sessionId);
  await first.evict();

  const reopened = await open();
  expect(reopened.lineage).toBe("existing");
  expect(reopened.headSha256).toBe(sourceSha256);
  assertSource(reopened.doc);
  await reopened.nativeOwner!.resyncIfNeeded();
  await reopened.evict();

  const reconnected = await open();
  assertSource(reconnected.doc);
  expect(engine.requests.filter(request => request.method === YDOC_METHOD.settle)).toHaveLength(0);
  await reconnected.evict();
});

it.each(["old-source"])("delivers a witness clear and authoritative head to an open %s peer without losing its tail", async peerHead => {
  const source = "# Note\n\n<details>Hidden.</details>\n\nEditable.";
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const convertedHead = sha("converted file");
  const engine = new YdocLoopbackEngine();
  engine.seedFile({workspace: WORKSPACE, versionId: VERSION, path: "note.md", content: source, contentKind: "richdoc"});
  const heads = vi.fn();
  const provider = await openEngineYdocProviderSession({
    transport: {
      ...forwardYdocBlobEgress(engine),
      onEvent: handler => engine.onEvent(event => handler(event.name === YDOC_EVENT.remoteUpdate
        ? {...event, payload: {sessionId: (event.payload as {sessionId: string}).sessionId, resyncRequired: true}} : event)),
      async sendRequest(request) {
        const response = await engine.sendRequest(request);
        if (request.method !== YDOC_METHOD.open && request.method !== YDOC_METHOD.resync) return response;
        return {...response, result: {...response.result as Record<string, JsonValue>,
          headSha256: request.method === YDOC_METHOD.resync || peerHead === "converted" ? convertedHead : sha(source)}};
      },
    },
    workspace: WORKSPACE, versionId: VERSION, path: "note.md", contentKind: "richdoc",
    onRemoteUpdate(_update, head) {if (head) heads(head.sha256);}, scheduleSettle: () => () => {},
  });
  const witnessKeys = ["dohcMarkdownSource", "dohcMarkdownSourceSha256", "dohcMarkdownSourceProjectionSha256", "dohcMarkdownSourceReader"];
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(provider.doc));
  let before = Y.encodeStateVector(peer);
  const meta = peer.getMap("meta");
  meta.set(witnessKeys[0]!, source);
  meta.set(witnessKeys[1]!, sha(source));
  meta.set(witnessKeys[2]!, sha(ydocProjection.yDocToMarkdown(peer)));
  meta.set(witnessKeys[3]!, "reader-build");
  await provider.applyLocalUpdate(Y.encodeStateAsUpdate(peer, before), {armSettle: false});
  before = Y.encodeStateVector(peer);
  await provider.applyLocalUpdate(richdocUpdate(Y.encodeStateAsUpdate(provider.doc), "private unsettled tail"), {armSettle: false});
  const records = engine.requests.filter(request => request.method === YDOC_METHOD.recordUpdate).length;
  for (const key of witnessKeys) meta.delete(key);

  engine.applyRemoteUpdate(provider.nativeOwner!.sessionId, Y.encodeStateAsUpdate(peer, before));
  await vi.waitFor(() => expect(heads).toHaveBeenCalledWith(convertedHead));

  for (const key of witnessKeys) expect(provider.doc.getMap("meta").has(key)).toBe(false);
  expect(ydocProjection.yDocToMarkdown(provider.doc)).toContain("private unsettled tail");
  expect(provider.headSha256).toBe(convertedHead);
  expect(engine.requests.filter(request => request.method === YDOC_METHOD.recordUpdate)).toHaveLength(records);
  expect(engine.requests.filter(request => request.method === YDOC_METHOD.settle)).toHaveLength(0);
  peer.destroy();
  await provider.evict();
});

it("delivers a confirmed absent head after resync and suppresses a delayed head after eviction", async () => {
  const engine = seedPlaintextEngine("seed");
  const resyncStarted = Promise.withResolvers<void>();
  const finishResync = Promise.withResolvers<void>();
  let delay = false;
  const heads = vi.fn();
  const provider = await openEngineYdocProviderSession({
    transport: {...forwardYdocBlobEgress(engine), onEvent: handler => engine.onEvent(handler),
      async sendRequest(request) {
        const response = await engine.sendRequest(request);
        if (request.method !== YDOC_METHOD.resync) return response;
        if (delay) {resyncStarted.resolve(); await finishResync.promise;}
        return {...response, result: {...response.result as Record<string, JsonValue>, headSha256: null}};
      }},
    workspace: WORKSPACE, versionId: VERSION, path: PATH, contentKind: "plaintext",
    onRemoteUpdate(_update, head) {if (head) heads(head.sha256);}, scheduleSettle: () => () => {},
  });
  const owner = provider.nativeOwner!;
  engine.emitEvent({name: YDOC_EVENT.remoteUpdate, seq: 100, sessionGeneration: 1,
    payload: {sessionId: owner.sessionId, resyncRequired: true}});
  await owner.resyncIfNeeded();
  expect(heads).toHaveBeenCalledExactlyOnceWith(null);
  expect(provider.headSha256).toBeNull();

  delay = true;
  engine.emitEvent({name: YDOC_EVENT.remoteUpdate, seq: 101, sessionGeneration: 1,
    payload: {sessionId: owner.sessionId, resyncRequired: true}});
  await resyncStarted.promise;
  await provider.evict();
  finishResync.resolve();
  await drain();
  expect(heads).toHaveBeenCalledOnce();
});

it.each(["recover", "close-during-retry", "terminal"] as ReadonlyArray<"recover" | "close" | "close-during-retry" | "terminal" | "wrong-code">)("handles a refused invalidation resync: %s", async (mode) => {
  const engine = seedPlaintextEngine("seed"), scheduler = settleScheduler();
  const transient = mode === "recover" || mode === "close" || mode === "close-during-retry";
  const refusal = new DaemonRefusalError({code: transient ? "OVERLOADED" : "INVALID_PARAMS",
    message: mode === "terminal" ? "owner-outbox-parent-mismatch" : "live-settlement-capacity",
    retry: transient ? "afterBackoff" : "no"}, new Error("daemon response"));
  let resyncs = 0;
  let releaseRetry!: () => void;
  const heldRetry = new Promise<void>(resolve => {releaseRetry = resolve;});
  const transport: EngineTransport = {
    ...forwardYdocBlobEgress(engine),
    onEvent: handler => engine.onEvent(event => handler(event.name === YDOC_EVENT.remoteUpdate
      ? {...event, payload: {sessionId: (event.payload as {sessionId: string}).sessionId, resyncRequired: true}} : event)),
    async sendRequest(request) {
      if (request.method === YDOC_METHOD.resync) {
        if (++resyncs === 1) throw refusal;
        if (mode === "close-during-retry") await heldRetry;
      }
      return engine.sendRequest(request);
    },
  };
  const errors: unknown[] = [];
  const provider = await openEngineYdocProviderSession({transport, workspace: WORKSPACE, versionId: VERSION, path: PATH,
    contentKind: "plaintext", onRemoteUpdate() {}, onSessionError: error => errors.push(error), scheduleSettle: scheduler.schedule});
  const peer = new Y.Doc(); Y.applyUpdate(peer, provider.initialUpdate);
  const vector = Y.encodeStateVector(peer); peer.getText("plainText").insert(0, "remote ");
  engine.applyRemoteUpdate(provider.nativeOwner!.sessionId, Y.encodeStateAsUpdate(peer, vector));
  await drain();
  expect(errors).toEqual([refusal]); expect(resyncs).toBe(1);
  expect(provider.doc.getText("plainText").toString()).toBe("seed");
  if (!transient) {
    expect(scheduler.armed).toHaveLength(0);
    await provider.evict();
  } else {
    expect(scheduler.armed).toHaveLength(1);
    if (mode === "close") {
      await provider.evict(); expect(scheduler.armed).toHaveLength(0); expect(resyncs).toBe(1);
    } else if (mode === "close-during-retry") {
      scheduler.fire(); await drain(); expect(resyncs).toBe(2);
      const closing = provider.close({settle: false}); await drain();
      expect(engine.activeSessionIds()).toHaveLength(1);
      releaseRetry(); await closing; expect(engine.activeSessionIds()).toHaveLength(0);
    } else {
      scheduler.fire(); await drain();
      expect(resyncs).toBe(2); expect(provider.doc.getText("plainText").toString()).toBe("remote seed");
      await provider.applyLocalUpdate(plaintextUpdate(Y.encodeStateAsUpdate(provider.doc), text => text.insert(11, " local")));
      expect(engine.sessionText(provider.nativeOwner!.sessionId)).toBe("remote seed local");
      await provider.close();
    }
  }
  peer.destroy();
});

function recordDeliveries(session: {doc: Y.Doc; headSha256: string | null | undefined; onRemoteUpdate: YdocAdapterSession["onRemoteUpdate"]}) {
  const deliveries: Array<{text: string; bytes: number; head?: YdocDeliveredHead; sessionHead: string | null | undefined}> = [];
  session.onRemoteUpdate((update, head) => deliveries.push({
    text: session.doc.getText("plainText").toString(), bytes: update.byteLength, head, sessionHead: session.headSha256,
  }));
  return deliveries;
}

function settlingTransport(engine: YdocLoopbackEngine) {
  const control: {hold: Promise<void> | null} = {hold: null};
  const base = resyncRequestTransport(engine, async () => undefined);
  let written: string | null = null;
  const transport: EngineTransport = {...base, async sendRequest(request) {
    if (request.method === YDOC_METHOD.settle && control.hold) await control.hold;
    const response = await base.sendRequest(request);
    if (request.method === YDOC_METHOD.settle) written = (response.result as {sha256: string}).sha256;
    if (request.method !== YDOC_METHOD.resync || written === null) return response;
    return {...response, result: {...response.result as Record<string, JsonValue>, headSha256: written}};
  }};
  return {transport, control};
}

it("sends its settle's head as a committed receipt, and confirms it with a fresh pair when state landed during the settle", async () => {
  const engine = seedPlaintextEngine("seed");
  const {transport, control} = settlingTransport(engine);
  const adapter = new YdocLiveAdapter(transport);
  const session = await adapter.openSession({workspace: WORKSPACE, versionId: VERSION, path: PATH, contentKind: "plaintext"});
  const deliveries = recordDeliveries(session);
  await session.applyLocalTextEdit({root: "plainText", index: 4, insert: " one"});
  const first = await session.settle();
  expect(deliveries).toEqual([{text: "seed one", bytes: 2, head: {sha256: first.sha256, committed: true}, sessionHead: first.sha256}]);

  await session.applyLocalTextEdit({root: "plainText", index: 8, insert: " two"});
  const release = Promise.withResolvers<void>();
  control.hold = release.promise;
  const settled = session.settle();
  await drain();
  engine.emitEvent({name: YDOC_EVENT.remoteUpdate, seq: 100, sessionGeneration: 1, payload: {sessionId: session.sessionId, resyncRequired: true}});
  await drain();
  expect(deliveries.slice(1)).toEqual([{text: "seed one two", bytes: 2, head: {}, sessionHead: undefined}]);
  const resyncs = engine.requests.filter(request => request.method === YDOC_METHOD.resync).length;
  release.resolve();
  const second = await settled;
  await drain();
  expect(engine.requests.filter(request => request.method === YDOC_METHOD.resync)).toHaveLength(resyncs + 1);
  expect(deliveries.slice(2)).toEqual([{text: "seed one two", bytes: 2, head: {sha256: second.sha256, committed: true}, sessionHead: second.sha256}]);
  await session.close(); adapter.dispose();
});

it("does not confirm a settle whose paired read shows another source", async () => {
  const engine = seedPlaintextEngine("seed");
  const {transport, control} = settlingTransport(engine);
  const adapter = new YdocLiveAdapter(transport);
  const session = await adapter.openSession({workspace: WORKSPACE, versionId: VERSION, path: PATH, contentKind: "plaintext"});
  const deliveries = recordDeliveries(session);
  await session.applyLocalTextEdit({root: "plainText", index: 4, insert: " one"});
  const release = Promise.withResolvers<void>();
  control.hold = release.promise;
  const settled = session.settle();
  await drain();
  const peer = new Y.Doc(); Y.applyUpdate(peer, Y.encodeStateAsUpdate(session.doc));
  const vector = Y.encodeStateVector(peer);
  peer.getMap("meta").set("dohcMarkdownSourceSha256", "b".repeat(64));
  engine.applyRemoteUpdate(session.sessionId, Y.encodeStateAsUpdate(peer, vector));
  await drain();
  expect(deliveries.every(delivery => delivery.head?.sha256 === undefined)).toBe(true);
  release.resolve();
  const result = await settled;
  await drain();
  expect(deliveries.at(-1)?.head).toEqual({sha256: result.sha256});
  expect(deliveries.some(delivery => delivery.head?.committed)).toBe(false);
  peer.destroy(); await session.close(); adapter.dispose();
});

function resyncRequestTransport(
  engine: YdocLoopbackEngine,
  onResync: () => Promise<void>,
): EngineTransport {
  return {
    ...forwardYdocBlobEgress(engine),
    onEvent: handler => engine.onEvent(event => handler(event.name === YDOC_EVENT.remoteUpdate
      ? {...event, payload: {sessionId: (event.payload as {sessionId: string}).sessionId, resyncRequired: true}}
      : event)),
    async sendRequest(request) {
      if (request.method === YDOC_METHOD.resync) await onResync();
      return engine.sendRequest(request);
    },
  };
}

it("journals what a person types while a resync is pending, without failing the session", async () => {
  const engine = seedPlaintextEngine("seed");
  let release!: () => void, resyncs = 0;
  const held = new Promise<void>(resolve => {release = resolve;});
  const localEditErrors: unknown[] = [], sessionErrors: unknown[] = [];
  const provider = await openEngineYdocProviderSession({
    transport: resyncRequestTransport(engine, async () => {resyncs++; await held;}), workspace: WORKSPACE, versionId: VERSION, path: PATH,
    contentKind: "plaintext", onRemoteUpdate() {}, scheduleSettle: settleScheduler().schedule,
    onLocalEditError: error => localEditErrors.push(error), onSessionError: error => sessionErrors.push(error),
  });
  const sessionId = provider.nativeOwner!.sessionId;
  const peer = new Y.Doc(); Y.applyUpdate(peer, provider.initialUpdate);
  const vector = Y.encodeStateVector(peer); peer.getText("plainText").insert(0, "remote ");
  engine.applyRemoteUpdate(sessionId, Y.encodeStateAsUpdate(peer, vector));
  await drain();
  expect(resyncs).toBe(1);

  const first = provider.applyLocalUpdate(plaintextUpdate(Y.encodeStateAsUpdate(provider.doc), text => text.insert(4, " one")));
  const second = provider.applyLocalUpdate(plaintextUpdate(Y.encodeStateAsUpdate(provider.doc), text => text.insert(8, " two")));
  await Promise.all([first, second]);
  expect(engine.sessionText(sessionId)).toBe("remote seed one two");

  release(); await drain();
  expect(provider.doc.getText("plainText").toString()).toBe("remote seed one two");
  await expect(provider.settleNow()).resolves.toMatchObject({materialized: true});
  expect(localEditErrors).toEqual([]);
  expect(sessionErrors).toEqual([]);
  peer.destroy(); await provider.close();
});

function seedPlaintextEngine(content = ""): YdocLoopbackEngine {
  const engine = new YdocLoopbackEngine();
  engine.seedFile({
    workspace: WORKSPACE,
    versionId: VERSION,
    path: PATH,
    content,
    contentKind: "plaintext",
  });
  return engine;
}

type BlobHandler = Parameters<NonNullable<EngineTransport["onBlob"]>>[0];
const forwardedBlobHandlers = new WeakMap<
  YdocLoopbackEngine,
  Set<BlobHandler>
>();

function forwardYdocBlobEgress(
  engine: YdocLoopbackEngine,
): Pick<EngineTransport, "helloAck" | "onBlob"> {
  return {
    helloAck: engine.helloAck,
    onBlob: (handler) => {
      let handlers = forwardedBlobHandlers.get(engine);
      if (handlers === undefined) {
        handlers = new Set();
        forwardedBlobHandlers.set(engine, handlers);
      }
      handlers.add(handler);
      const unsubscribeEngine = engine.onBlob(handler);
      return () => {
        handlers.delete(handler);
        unsubscribeEngine();
      };
    },
  };
}

function emitYdocBlob(
  engine: YdocLoopbackEngine,
  requestId: number,
  bytes: Uint8Array,
): void {
  for (const handler of forwardedBlobHandlers.get(engine) ?? []) {
    handler({
      requestId,
      streamId: requestId,
      totalBytes: bytes.byteLength,
      bytes,
    });
  }
}

async function recordUnderClaim(
  engine: YdocLoopbackEngine,
  request: Request,
  claim: string | null,
  lineageOriginatedHere = false,
): Promise<Response> {
  const params = request.params as Record<string, JsonValue>;
  if (params.expectedLineageClaimId !== claim) {
    throw new DaemonRefusalError({ code: "INVALID_PARAMS", message: "ydoc-lineage-stale", retry: "no" }, undefined);
  }
  const response = await engine.sendRequest({ ...request, params: { ...params, expectedLineageClaimId: null } });
  return {
    ...response,
    result: { ...(response.result as Record<string, JsonValue>), lineageClaimId: claim, lineageOriginatedHere },
  };
}

function plaintextUpdate(
  initialUpdate: Uint8Array,
  edit: (text: Y.Text) => void,
): Uint8Array {
  const mirror = new Y.Doc();
  mirror.getMap("frontmatter");
  mirror.getMap("meta");
  mirror.getXmlFragment("body");
  const text = mirror.getText("plainText");
  Y.applyUpdate(mirror, initialUpdate);
  const before = Y.encodeStateVector(mirror);
  edit(text);
  return Y.encodeStateAsUpdate(mirror, before);
}

function richdocUpdate(initialUpdate: Uint8Array, text: string): Uint8Array {
  const mirror = new Y.Doc();
  mirror.getMap("frontmatter");
  mirror.getMap("meta");
  mirror.getText("plainText");
  const body = mirror.getXmlFragment("body");
  Y.applyUpdate(mirror, initialUpdate);
  const before = Y.encodeStateVector(mirror);
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  body.insert(0, [paragraph]);
  return Y.encodeStateAsUpdate(mirror, before);
}

describe("seeding an absent lineage", () => {
  const recordedUpdates = (engine: YdocLoopbackEngine, seed: boolean) =>
    engine.requests.flatMap((request) => {
      if (request.method !== YDOC_METHOD.recordUpdate) return [];
      const params = request.params as { seed?: boolean; updateBase64: string };
      return (params.seed === true) === seed
        ? [new Uint8Array(Buffer.from(params.updateBase64, "base64"))]
        : [];
    });
  const clientsOf = (update: Uint8Array) =>
    new Set(Y.decodeUpdate(update).structs.map((struct) => struct.id.client));

  async function seedFor(
    contentKind: "plaintext" | "richdoc",
    content: string,
    headMomentId: string,
  ): Promise<Uint8Array> {
    const engine = new YdocLoopbackEngine();
    engine.seedFile({ workspace: WORKSPACE, versionId: VERSION, path: PATH, content, contentKind, headMomentId });
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({ workspace: WORKSPACE, versionId: VERSION, path: PATH, contentKind });
    await session.close({ settle: false });
    adapter.dispose();
    const seeds = recordedUpdates(engine, true);
    expect(seeds).toHaveLength(1);
    return seeds[0]!;
  }

  it.each(["plaintext", "richdoc"] as const)(
    "sends the same %s seed from every device that opens the same head",
    async (contentKind) => {
      const content = "# Shared\n\nStarting together.\n";
      const first = await seedFor(contentKind, content, "replicated-moment");
      expect(await seedFor(contentKind, content, "replicated-moment")).toEqual(first);
      // A later head with the same text, as after a delete and recreate, seeds
      // under another client, so its lineage never reuses the first claim.
      const later = await seedFor(contentKind, content, "later-moment");
      expect(later).not.toEqual(first);
      expect(clientsOf(later)).not.toEqual(clientsOf(first));
    },
  );

  it("authors every edit after the seed under another client", async () => {
    const engine = seedPlaintextEngine("seed");
    const adapter = new YdocLiveAdapter(engine);
    const open = () => adapter.openSession({ workspace: WORKSPACE, versionId: VERSION, path: PATH, contentKind: "plaintext" });
    const session = await open();
    // A synced workspace keeps the lineage when the document closes.
    engine.markSessionReplicated(session.sessionId);
    const [seedClient] = clientsOf(recordedUpdates(engine, true)[0]!);
    // The renderer edits its own doc and forwards each update, undo included.
    const editor = new Y.Doc();
    Y.applyUpdate(editor, session.initialUpdate);
    const forwarded: Promise<unknown>[] = [];
    editor.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "session") forwarded.push(session.applyLocalUpdate(update));
    });
    const undo = new Y.UndoManager(editor.getText("plainText"), { captureTimeout: 0 });
    editor.getText("plainText").insert(4, " typed");
    undo.undo();
    await Promise.all(forwarded);
    await session.close();
    const reopened = await open();
    await reopened.applyLocalTextEdit({ root: "plainText", index: 4, insert: " again" });
    await reopened.close();
    adapter.dispose();

    const edits = recordedUpdates(engine, false);
    expect(edits.length).toBeGreaterThanOrEqual(3);
    for (const edit of edits) expect(clientsOf(edit)).not.toContain(seedClient);
    expect(recordedUpdates(engine, true)).toHaveLength(1);
  });

  describe("a seed past the in-band cap", () => {
    const longPath = "notes/long.md";
    const content = "# Long\n\n" + "A paragraph of a long note, written outside dohc.\n\n".repeat(1_100);
    const largeSeed = { workspaceId: "workspace-1", maxBytes: 64 * 1024 };
    const seedLongNote = () => {
      const engine = new YdocLoopbackEngine();
      engine.seedFile({ workspace: WORKSPACE, versionId: VERSION, path: longPath, content, contentKind: "richdoc" });
      return engine;
    };
    const openLong = (adapter: YdocLiveAdapter, withLargeSeed: boolean) =>
      adapter.openSession({
        workspace: WORKSPACE,
        versionId: VERSION,
        path: longPath,
        contentKind: "richdoc",
        ...(withLargeSeed ? { largeSeed } : {}),
      });

    it("refuses a blob that does not match the digest the open named", async () => {
      const engine = seedLongNote();
      const blobReads = new Set<number>();
      const transport: EngineTransport = {
        helloAck: engine.helloAck,
        onEvent: (handler) => engine.onEvent(handler),
        onBlob: (handler) =>
          engine.onBlob((blob) => {
            if (!blobReads.has(blob.requestId)) return handler(blob);
            const bytes = new Uint8Array(blob.bytes);
            bytes[0] = bytes[0]! ^ 1;
            handler({ ...blob, bytes });
          }),
        async sendRequest(request) {
          if (request.method === "versionedText.readBlob") blobReads.add(request.id);
          return engine.sendRequest(request);
        },
      };
      const adapter = new YdocLiveAdapter(transport);
      await expect(openLong(adapter, true)).rejects.toThrow("does not match the digest");
      expect(recordedUpdates(engine, true)).toEqual([]);
      expect(engine.activeSessionIds()).toEqual([]);
      adapter.dispose();
    });
  });
});


function findPartiallyAppliedMalformedUpdate(fullUpdate: Uint8Array): Uint8Array {
  for (let cut = 1; cut < fullUpdate.byteLength; cut += 1) {
    const candidate = fullUpdate.slice(0, cut);
    const scratch = new Y.Doc();
    const text = scratch.getText("plainText");
    try {
      Y.applyUpdate(scratch, candidate);
    } catch {
      if (text.length > 0) return candidate;
    }
  }
  throw new Error("The fixture did not expose a non-atomic Yjs apply prefix.");
}

function settleScheduler(): {
  armed: ReadonlyArray<{ fn: () => void; ms: number }>;
  delays: number[];
  schedule: (fn: () => void, ms: number) => () => void;
  fire: () => void;
} {
  const armed: Array<{ fn: () => void; ms: number }> = [];
  const delays: number[] = [];
  return {
    armed,
    delays,
    schedule(fn, ms) {
      const entry = { fn, ms };
      armed.push(entry);
      delays.push(ms);
      return () => {
        const index = armed.indexOf(entry);
        if (index >= 0) armed.splice(index, 1);
      };
    },
    fire() {
      const entry = armed.shift();
      if (entry === undefined) {
        throw new Error("No settle timer is armed.");
      }
      entry.fn();
    },
  };
}

async function drain(): Promise<void> {
  for (let tick = 0; tick < 100; tick += 1) await Promise.resolve();
}

describe("YdocLiveAdapter", () => {

  it("keeps scene roots as Y.Maps across initial and remote updates", async () => {
    const engine = new YdocLoopbackEngine();
    const adapter = new YdocLiveAdapter(engine);
    const first = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: "drawing.excalidraw",
      contentKind: "scene",
    });
    await first.applyLocalEdit((doc) => {
      doc.getMap(EXCALIDRAW_SCENE_ROOTS.revisions).set("revision", "one");
      doc.getMap(EXCALIDRAW_SCENE_ROOTS.appState).set("gridSize", "20");
    });
    await first.evict();

    const reopened = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: "drawing.excalidraw",
      contentKind: "scene",
    });
    expect(reopened.doc.get(EXCALIDRAW_SCENE_ROOTS.revisions)).toBeInstanceOf(
      Y.Map,
    );
    expect(
      reopened.doc.getMap(EXCALIDRAW_SCENE_ROOTS.revisions).get("revision"),
    ).toBe("one");

    const remote = new Y.Doc();
    remote.getMap(EXCALIDRAW_SCENE_ROOTS.revisions);
    remote.getMap(EXCALIDRAW_SCENE_ROOTS.appState);
    remote.getMap(EXCALIDRAW_SCENE_ROOTS.assets).set("asset", "two");
    engine.applyRemoteUpdate(
      reopened.sessionId,
      Y.encodeStateAsUpdate(remote),
    );
    expect(reopened.doc.get(EXCALIDRAW_SCENE_ROOTS.assets)).toBeInstanceOf(
      Y.Map,
    );
    expect(reopened.doc.getMap(EXCALIDRAW_SCENE_ROOTS.assets).get("asset")).toBe(
      "two",
    );

    await reopened.evict();
    adapter.dispose();
  });

  it("refuses scene settlement and retains its lineage on close", async () => {
    const materialized: Array<{ path: string; content: string }> = [];
    const engine = new YdocLoopbackEngine({
      materialize: (input) => materialized.push(input),
    });
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: "drawing.excalidraw",
      contentKind: "scene",
    });
    await session.applyLocalEdit((doc) => {
      doc.getMap(EXCALIDRAW_SCENE_ROOTS.revisions).set("revision", "one");
    });

    await expect(session.settle()).rejects.toThrow(
      "The Y.Doc loopback cannot project scene documents. Use the workspace engine to settle scenes.",
    );
    expect(materialized).toHaveLength(0);
    expect(
      engine.responses.some((response) => {
        const result = response.result as Record<string, unknown>;
        return result.materialized === true;
      }),
    ).toBe(false);

    await expect(session.close({ settle: true })).rejects.toThrow(
      "The Y.Doc loopback cannot project scene documents. Use the workspace engine to settle scenes.",
    );
    expect(engine.activeSessionIds()).toHaveLength(1);

    await expect(session.close()).resolves.toBeUndefined();
    expect(engine.activeSessionIds()).toHaveLength(0);

    const reopened = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: "drawing.excalidraw",
      contentKind: "scene",
    });
    expect(reopened.lineage).toBe("existing");
    expect(
      reopened.doc
        .getMap(EXCALIDRAW_SCENE_ROOTS.revisions)
        .get("revision"),
    ).toBe("one");
    await reopened.close({ settle: false });
    adapter.dispose();
  });

  it("rejects and quarantines an opaque ill-formed edit without wedging Yjs", async () => {
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(() =>
      session.applyLocalEdit((doc) => {
        doc.getText("plainText").insert(0, "\ud800");
      }),
    ).toThrow(IllFormedUtf16EditError);
    expect(engine.recordedUpdates).toHaveLength(0);
    expect(engine.requests.map((request) => request.method)).not.toContain(
      YDOC_METHOD.recordUpdate,
    );
    const text = session.doc.getText("plainText").toString();
    expect(text.charCodeAt(0)).toBe(0xd800);
    expect(() =>
      session.applyLocalEdit((doc) => {
        doc.getText("plainText").insert(1, "safe");
      }),
    ).toThrow(YdocSessionQuarantinedError);
    expect(engine.recordedUpdates).toHaveLength(0);

    await session.close({ settle: false });
    adapter.dispose();
  });

  it("rejects the R11a surrogate-split lineage before a structured transaction", async () => {
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });

    await session.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "😀",
    });

    // This is the exact makeSurrogateProbe lineage asserted by
    // crates/dohc-engine-collab/tests/cross_engine.rs:264.
    expect(() =>
      session.applyLocalTextEdit({
        root: "plainText",
        index: 1,
        insert: "X",
      }),
    ).toThrow(IllFormedUtf16EditError);
    expect(session.doc.getText("plainText").toString()).toBe("😀");
    expect(engine.sessionText(session.sessionId)).toBe("😀");
    expect(engine.recordedUpdates).toHaveLength(1);

    await session.close({ settle: true });
    adapter.dispose();
  });

  it("rejects a split masked behind offsetting U+FFFD deletions (BYPASS-1)", async () => {
    // Reviewer repro: a single raw transaction deletes two pre-existing U+FFFD
    // while a mid-surrogate split adds two, netting to zero. Aggregate counting
    // misses it; deleted-U+FFFD accounting rejects it. Divergence vs the real
    // R11a engine: yrs="😀x" vs editor="�x�"
    // (crates/dohc-engine-collab).
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    // The pre-existing U+FFFD arrives the way a REMOTE update would
    // (ENGINE_DELIVERED_ORIGIN bypasses the local-edit validator below) — a
    // captured file whose own bytes hold raw U+FFFD can no longer open as a
    // live session at all: the seed is now a real LOCAL_EDITOR_ORIGIN
    // recordUpdate, and this same validator would refuse it before
    // the session ever existed.
    session.doc.transact(() => {
      session.doc.getText("plainText").insert(0, "��😀");
    }, ENGINE_DELIVERED_ORIGIN);

    expect(() =>
      session.applyLocalEdit((doc) => {
        const text = doc.getText("plainText");
        text.delete(0, 2);
        text.insert(1, "x");
      }),
    ).toThrow(IllFormedUtf16EditError);
    expect(engine.recordedUpdates).toHaveLength(0);
    expect(engine.requests.map((request) => request.method)).not.toContain(
      YDOC_METHOD.recordUpdate,
    );

    await session.close({ settle: false });
    adapter.dispose();
  });

  it("treats a failed remote apply prefix as authoritative and converges on full delivery", async () => {
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    const source = new Y.Doc();
    const sourceText = source.getText("plainText");
    for (let index = 0; index < 400; index += 1) {
      sourceText.insert(sourceText.length, `${index.toString(16)}·`);
    }
    const fullUpdate = Y.encodeStateAsUpdate(source);
    const malformed = findPartiallyAppliedMalformedUpdate(fullUpdate);
    const surfacedErrors: RemoteYdocApplyError[] = [];
    session.onRemoteApplyError(() => {
      throw new Error("listener failure");
    });
    session.onRemoteApplyError((error) => {
      surfacedErrors.push(error);
    });

    expect(() => engine.emitRemoteUpdate(session.sessionId, malformed)).not.toThrow();

    const surfaced = surfacedErrors[0];
    expect(surfaced).toBeInstanceOf(RemoteYdocApplyError);
    expect(session.doc.getText("plainText").length).toBeGreaterThan(0);
    expect(Array.from(surfaced?.postAttemptStateUpdate ?? [])).toEqual(
      Array.from(session.currentStateUpdate()),
    );

    engine.applyRemoteUpdate(session.sessionId, fullUpdate);

    expect(session.doc.getText("plainText").toString()).toBe(
      sourceText.toString(),
    );
    expect(Array.from(Y.encodeStateVector(session.doc))).toEqual(
      Array.from(Y.encodeStateVector(source)),
    );

    await session.close({ settle: true });
    adapter.dispose();
  });

  it("round-trips CJK, astral emoji, and RTL text without UTF-16 drift", async () => {
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    const content = "漢字かな交じり文 · emoji 🧭👩🏽‍🚀 · العربية שלום";
    const update = plaintextUpdate(session.initialUpdate, (text) => {
      text.insert(0, content);
    });

    await session.applyLocalUpdate(update);
    const settled = await session.settle();

    expect(session.doc.getText("plainText").toString()).toBe(content);
    expect(engine.sessionText(session.sessionId)).toBe(content);
    expect(settled.content).toBe(content);
    expect([...(settled.content ?? "")]).toEqual([...content]);

    await session.close({ settle: false });
    adapter.dispose();
  });

  it("takes the claim its own lost record made and keeps its document", async () => {
    const engine = seedPlaintextEngine("local");
    let claimed = false;
    let loseResponse = false;
    const withClaim = (response: Response): Response =>
      claimed
        ? {
            ...response,
            result: {
              ...(response.result as Record<string, JsonValue>),
              lineageClaimId: "own-claim",
              lineageOriginatedHere: true,
            },
          }
        : response;
    const transport: EngineTransport = {
      ...forwardYdocBlobEgress(engine),
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.recordUpdate) {
          const response = await recordUnderClaim(engine, request, claimed ? "own-claim" : null, claimed);
          if (loseResponse) {
            loseResponse = false;
            claimed = true;
            throw new Error("daemon response lost");
          }
          return withClaim(response);
        }
        if (request.method === YDOC_METHOD.resync) {
          return withClaim(await engine.sendRequest(request));
        }
        return engine.sendRequest(request);
      },
    };
    const adapter = new YdocLiveAdapter(transport);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    const openedDoc = session.doc;
    const replacements: Y.Doc[] = [];
    session.onLineageReplaced((doc) => replacements.push(doc));
    loseResponse = true;

    await session.applyLocalTextEdit({
      root: "plainText",
      index: "local".length,
      insert: " claimed",
    });
    await session.applyLocalTextEdit({
      root: "plainText",
      index: "local claimed".length,
      insert: " after",
    });

    expect(session.doc).toBe(openedDoc);
    expect(replacements).toEqual([]);
    expect(session.lineageClaimId).toBe("own-claim");
    await expect(session.settle()).resolves.toMatchObject({
      content: "local claimed after",
    });
    await session.close({ settle: false });
    adapter.dispose();
  });

  it("acknowledges nothing the engine answers under a claim the editor never held", async () => {
    const engine = seedPlaintextEngine("losing root");
    const winner = new Y.Doc();
    winner.getText("plainText").insert(0, "winning root");
    const winnerUpdate = Y.encodeStateAsUpdate(winner);
    const handover = Promise.withResolvers<void>();
    let claim: string | null = null;
    let misanswer = false;
    const transport: EngineTransport = {
      ...forwardYdocBlobEgress(engine),
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.recordUpdate && misanswer) {
          misanswer = false;
          claim = "foreign-claim";
          const response = await recordUnderClaim(engine, request, null);
          return { ...response, result: { ...(response.result as Record<string, JsonValue>), lineageClaimId: claim } };
        }
        if (request.method === YDOC_METHOD.recordUpdate) return recordUnderClaim(engine, request, claim);
        if (request.method === YDOC_METHOD.resync && claim !== null) {
          await handover.promise;
          emitYdocBlob(engine, request.id, winnerUpdate);
          return {
            id: request.id,
            result: { headSha256: null, lineageClaimId: claim, lineageOriginatedHere: false, recoveredPaths: [], artifactAssets: [] },
          };
        }
        return engine.sendRequest(request);
      },
    };
    const adapter = new YdocLiveAdapter(transport);
    const session = await adapter.openSession({ workspace: WORKSPACE, versionId: VERSION, path: PATH, contentKind: "plaintext" });
    const losingDoc = session.doc;
    const acknowledged: string[] = [];
    session.onLocalUpdateAcknowledged((id) => acknowledged.push(id));
    const replacements: Y.Doc[] = [];
    session.onLineageReplaced((doc) => replacements.push(doc));
    misanswer = true;

    await expect(
      session.applyLocalTextEdit({ root: "plainText", index: "losing root".length, insert: " edit" }),
    ).rejects.toMatchObject({ code: "lineage-changed" });

    // Not acknowledged, still pending, and nothing of the other lineage merged.
    expect(acknowledged).toEqual([]);
    expect(session.missingLocalState).toBe(true);
    expect(session.lineageClaimId).toBeNull();
    expect(session.doc).toBe(losingDoc);
    expect(losingDoc.getText("plainText").toString()).toBe("losing root edit");
    expect(replacements).toEqual([]);

    // Typing on the losing document before the handover is refused at once,
    // without quarantining the session.
    let typed: unknown;
    try {
      void session.applyLocalTextEdit({ root: "plainText", index: 0, insert: "more " });
    } catch (error) {
      typed = error;
    }
    expect(typed).toMatchObject({ code: "lineage-changed" });

    handover.resolve();
    await vi.waitFor(() => expect(replacements).toHaveLength(1));
    expect(session.doc.getText("plainText").toString()).toBe("winning root");
    expect(losingDoc.getText("plainText").toString()).toBe("more losing root edit");
    expect(session.lineageClaimId).toBe("foreign-claim");
    expect(session.missingLocalState).toBe(false);
    expect(acknowledged).toEqual([]);

    await session.applyLocalTextEdit({ root: "plainText", index: "winning root".length, insert: " fresh" });
    expect(session.doc.getText("plainText").toString()).toBe("winning root fresh");
    expect(acknowledged).toHaveLength(1);
    await session.evict();
    adapter.dispose();
  });

  it("sends no queued edit of a lineage that changed, then records on the winner", async () => {
    const engine = seedPlaintextEngine("losing root");
    const winner = new Y.Doc();
    winner.getText("plainText").insert(0, "winning root");
    const winnerUpdate = Y.encodeStateAsUpdate(winner);
    const firstEdit = Promise.withResolvers<void>();
    let claim: string | null = null;
    const records: Uint8Array[] = [];
    let resyncs = 0;
    const transport: EngineTransport = {
      ...forwardYdocBlobEgress(engine),
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.recordUpdate) {
          records.push(Buffer.from((request.params as { updateBase64: string }).updateBase64, "base64"));
          if (records.length === 2) {
            // A restore replaces the lineage while the first edit is in flight.
            await firstEdit.promise;
            claim = "winning-claim";
          }
          return recordUnderClaim(engine, request, claim);
        }
        if (request.method === YDOC_METHOD.resync) {
          resyncs += 1;
          if (claim === null) return engine.sendRequest(request);
          emitYdocBlob(engine, request.id, winnerUpdate);
          return {
            id: request.id,
            result: { headSha256: null, lineageClaimId: claim, lineageOriginatedHere: false, recoveredPaths: [], artifactAssets: [] },
          };
        }
        return engine.sendRequest(request);
      },
    };
    const adapter = new YdocLiveAdapter(transport);
    const session = await adapter.openSession({ workspace: WORKSPACE, versionId: VERSION, path: PATH, contentKind: "plaintext" });
    const losingDoc = session.doc;
    const replacements: Y.Doc[] = [];
    session.onLineageReplaced((doc) => replacements.push(doc));
    const edits = [" one", " two", " three"].map((insert) =>
      session.applyLocalTextEdit({ root: "plainText", index: losingDoc.getText("plainText").length, insert }),
    );
    await drain();
    expect(records).toHaveLength(2);

    firstEdit.resolve();
    for (const edit of edits) await expect(edit).rejects.toMatchObject({ code: "lineage-changed" });
    await vi.waitFor(() => expect(replacements).toHaveLength(1));

    // The queued edits of the losing document never reached the engine.
    expect(records).toHaveLength(2);
    expect(resyncs).toBe(2);
    expect(losingDoc.getText("plainText").toString()).toBe("losing root one two three");
    expect(session.doc.getText("plainText").toString()).toBe("winning root");
    expect(session.missingLocalState).toBe(false);

    // The winner takes edits again: no quarantine, and the edit stands on
    // the winner's own history.
    await session.applyLocalTextEdit({ root: "plainText", index: "winning root".length, insert: " fresh" });
    expect(records).toHaveLength(3);
    const settled = new Y.Doc();
    Y.applyUpdate(settled, winnerUpdate);
    Y.applyUpdate(settled, records[2]!);
    expect(settled.store.pendingStructs).toBeNull();
    expect(settled.getText("plainText").toString()).toBe("winning root fresh");
    await session.close({ settle: false });
    adapter.dispose();
  });

  it("reports a DEBOUNCED settle failure to onSettleError, not only to onSessionError", async () => {
    // AUDIT-SILENTSAVE. The debounced settle is the only path that writes the
    // user's edits to their file. Its failure used to go to onSessionError
    // alone, and the desktop wires that to a reconnect handler which returns
    // early for anything that is not a reconnect error — so a refusal was
    // dropped with no log and no UI, and the doc kept reading "Saved" over a
    // file that never received a byte.
    const engine = seedPlaintextEngine();
    const settleFailure = new Error("injected settle refusal");
    const transport: EngineTransport = {
      ...forwardYdocBlobEgress(engine),
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.settle) throw settleFailure;
        return engine.sendRequest(request);
      },
    };
    const settleErrors: unknown[] = [];
    const settleStarts: number[] = [];
    const settled: unknown[] = [];
    // Capture the debounced callback so the test drives the real debounced
    // path (the one that swallowed the failure) rather than settleNow.
    const scheduler = settleScheduler();
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      settleDebounceMs: 100,
      onRemoteUpdate: () => undefined,
      onSettleStart: () => settleStarts.push(settleStarts.length),
      onSettleError: (error) => settleErrors.push(error),
      onSettled: (result) => {
        settled.push(result);
      },
      scheduleSettle: scheduler.schedule,
    });

    const update = plaintextUpdate(provider.initialUpdate, (text) => {
      text.insert(0, "typed but never saved");
    });
    await provider.applyLocalUpdate(update);

    expect(scheduler.armed).toHaveLength(1);
    scheduler.fire();
    // The debounced settle rejects internally. Drain to quiescence, not until
    // the error lands: the retry decision happens a microtask after
    // onSettleError, so stopping at the error made the last assertion below
    // pass whether or not the provider re-armed.
    await drain();

    expect(settleErrors[0]).toBe(settleFailure);
    // A settle started, so a caller can show "saving" honestly...
    expect(settleStarts).toHaveLength(1);
    // ...and it never reported success, so nothing may claim the file is saved.
    expect(settled).toEqual([]);
    // An ordinary settle failure is not retried: a refusal that trying again
    // cannot help (stale target, invalid input) would only repeat itself.
    expect(scheduler.armed).toHaveLength(0);

    await provider.close({ settle: false });
  });

  async function openAgainstABlockedSettle(
    text: string,
    options?: {
      settleDebounceMs?: number;
      blocker?: "file-locked" | "engine-store-busy" | "settlement-materialization-pending" | "markdown-reader-retryable";
      replicated?: boolean;
    },
  ) {
    const engine = seedPlaintextEngine();
    const blocked = { held: true };
    const refusal = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: options?.blocker ?? "file-locked",
        retry: "afterBackoff",
      },
      new Error("daemon response"),
    );
    const transport: EngineTransport = {
      ...forwardYdocBlobEgress(engine),
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.settle && blocked.held) {
          throw refusal;
        }
        if (options?.replicated && request.method === YDOC_METHOD.recordUpdate) {
          return recordUnderClaim(engine, request, "owner-claim", true);
        }
        const response = await engine.sendRequest(request);
        if (options?.replicated && (request.method === YDOC_METHOD.open || request.method === YDOC_METHOD.resync)) {
          return { ...response, result: { ...(response.result as Record<string, JsonValue>), lineageClaimId: "owner-claim", lineageOriginatedHere: true } };
        }
        return response;
      },
    };
    const settleErrors: unknown[] = [];
    const settled: unknown[] = [];
    const scheduler = settleScheduler();
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      // Omitted deliberately when the caller wants the DEFAULT debounce: the
      // ladder's first rung is that default, which is the only place the
      // default is observable without a wall clock.
      ...(options?.settleDebounceMs !== undefined
        ? { settleDebounceMs: options.settleDebounceMs }
        : {}),
      onRemoteUpdate: () => undefined,
      onSettleError: (error) => settleErrors.push(error),
      onSettled: (result) => {
        settled.push(result);
      },
      scheduleSettle: scheduler.schedule,
    });
    await provider.applyLocalUpdate(
      plaintextUpdate(provider.initialUpdate, (body) => {
        body.insert(0, text);
      }),
    );
    return {
      engine,
      provider,
      blocked,
      refusal,
      settleErrors,
      settled,
      scheduler,
      delays: scheduler.delays,
    };
  }

  it("retries a file-locked settle on a doubling delay until the lock releases", async () => {
    // A settle refused `file-locked` leaves the write durably pending
    // in the engine — the only missing piece is a later attempt. The provider
    // re-arms itself on a doubling delay, so the save lands when the external
    // handle releases instead of waiting for an unrelated future edit.
    const { provider, blocked, refusal, settleErrors, settled, delays, scheduler } =
      await openAgainstABlockedSettle("typed against a locked file", {
        settleDebounceMs: 100,
      });

    // Fire the armed settle; while the lock holds, every failure re-arms the
    // next attempt itself: debounce, then doubling — 100, 100, 200, 400 —
    // and every failure still reaches onSettleError (nothing goes quiet).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(scheduler.armed).toHaveLength(1);
      scheduler.fire();
      await drain();
    }
    expect(settleErrors).toEqual([refusal, refusal, refusal]);
    expect(delays).toEqual([100, 100, 200, 400]);

    // The lock releases; the pending retry lands the write by itself.
    blocked.held = false;
    scheduler.fire();
    await drain();
    expect(settled).toHaveLength(1);
    // Success re-arms nothing.
    expect(scheduler.armed).toHaveLength(0);

    await provider.close({ settle: false });
  });

  it("waits out occupied live capacity while a settle replays unsent edits, and sends each edit once", async () => {
    vi.useFakeTimers();
    try {
      const engine = seedPlaintextEngine();
      const refusal = new DaemonRefusalError({ code: "OVERLOADED", message: "live-settlement-capacity",
        retry: "afterBackoff" }, new Error("daemon response"));
      let refuse = (_key: string) => true;
      const sent: string[] = [];
      const transport: EngineTransport = {
        ...forwardYdocBlobEgress(engine),
        onEvent: handler => engine.onEvent(handler),
        async sendRequest(request) {
          if (request.method === YDOC_METHOD.recordUpdate) {
            sent.push(request.idempotencyKey ?? "");
            if (refuse(request.idempotencyKey ?? "")) throw refusal;
          }
          return engine.sendRequest(request);
        },
      };
      const settleErrors: unknown[] = [];
      const provider = await openEngineYdocProviderSession({ transport, workspace: WORKSPACE, versionId: VERSION,
        path: PATH, contentKind: "plaintext", onRemoteUpdate: () => undefined,
        onSettleError: error => settleErrors.push(error), scheduleSettle: settleScheduler().schedule });
      await expect(provider.applyLocalUpdate(plaintextUpdate(provider.initialUpdate, text => text.insert(0, "first ")),
        { idempotencyKey: "first" })).rejects.toBe(refusal);
      await expect(provider.applyLocalUpdate(plaintextUpdate(Y.encodeStateAsUpdate(provider.doc),
        text => text.insert(text.length, "second")), { idempotencyKey: "second" })).rejects.toBe(refusal);
      // The replay lands the first edit, then the capacity is taken once.
      let refused = false;
      refuse = key => key === "second" && !refused && (refused = true);
      sent.length = 0;
      const outcome: unknown[] = [];
      provider.settleNow().then(result => outcome.push(result), error => outcome.push(error));
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toEqual([]);
      expect(settleErrors).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(outcome).toEqual([expect.objectContaining({ content: "first second" })]);
      expect(settleErrors).toEqual([]);
      // The retry resends only the edit the engine did not take.
      expect(sent).toEqual(["first", "second", "second"]);
      await provider.close({ settle: false });
    } finally { vi.useRealTimers(); }
  });

  it("cancels a busy debounced settle before giving close its one budget", async () => {
    vi.useFakeTimers();
    const fixture = await openAgainstABlockedSettle("preserved during busy teardown", {
      blocker: "engine-store-busy",
    });
    try {
      fixture.engine.markSessionReplicated(fixture.provider.nativeOwner!.sessionId);
      fixture.scheduler.fire();
      await vi.advanceTimersByTimeAsync(100);
      let finished = false;
      const closing = fixture.provider.close().then(
        () => { finished = true; return undefined; },
        error => { finished = true; return error; },
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(finished).toBe(true);
      expect(await closing).toBeInstanceOf(YdocReleasedWithSettleFailureError);
      expect(fixture.engine.activeSessionIds()).toHaveLength(0);
      fixture.blocked.held = false;
      const reopened = await openEngineYdocProviderSession({
        transport: { ...forwardYdocBlobEgress(fixture.engine),
          onEvent: handler => fixture.engine.onEvent(handler),
          sendRequest: request => fixture.engine.sendRequest(request) },
        workspace: WORKSPACE, versionId: VERSION, path: PATH, contentKind: "plaintext",
        onRemoteUpdate: () => undefined, scheduleSettle: () => () => undefined,
      });
      expect(reopened.doc.getText("plainText").toString()).toContain("preserved during busy teardown");
      await reopened.close({ settle: false });
    } finally {
      fixture.blocked.held = false;
      await vi.runAllTimersAsync();
      await fixture.provider.close({ settle: false });
      vi.useRealTimers();
    }
  });

  async function openAgainstABusyJournal(text: string, refusals: number, authorCapacity = false) {
    const engine = seedPlaintextEngine();
    const busy = new DaemonRefusalError(
      {
        code: authorCapacity ? "LIMIT_EXCEEDED" : "OVERLOADED",
        message: authorCapacity ? "ydoc-author-capacity" : "engine-store-busy",
        retry: "afterBackoff",
      },
      new Error("daemon response"),
    );
    let remaining = refusals;
    const methods: string[] = [];
    const transport: EngineTransport = {
      ...forwardYdocBlobEgress(engine),
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        methods.push(request.method);
        if (request.method === YDOC_METHOD.recordUpdate && remaining > 0) {
          remaining -= 1;
          throw busy;
        }
        return engine.sendRequest(request);
      },
    };
    const settled: YdocSettleResult[] = [];
    const settleErrors: unknown[] = [];
    const scheduler = settleScheduler();
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      settleDebounceMs: 100,
      onRemoteUpdate: () => undefined,
      onSettleError: (error) => settleErrors.push(error),
      onSettled: (result) => {
        settled.push(result);
      },
      scheduleSettle: scheduler.schedule,
    });
    const update = plaintextUpdate(provider.initialUpdate, (body) => {
      body.insert(0, text);
    });
    const journaled = provider.applyLocalUpdate(update);
    return { provider, busy, settled, settleErrors, scheduler, journaled, methods };
  }

  it("refuses to release a session still holding text the engine never got", async () => {
    vi.useFakeTimers();
    try {
      // The pre-close settle is the last chance to hand the
      // engine text a transient refusal left unsent, and the doc holding that
      // text goes away with the release. Releasing anyway produced the one
      // outcome nothing downstream can repair: the caller sees a clean
      // "released, settle failed", arms a retry that reopens and settles what
      // the lineage holds, and reports a save of a document missing the edit.
      //
      // So the teardown is refused while local state is unsent, and the close
      // ladder above retries the whole thing.
      //
      const { provider, journaled } = await openAgainstABusyJournal(
        "typed and never sent",
        // The write, its recovery replay, and every resend the close attempts.
        99,
      );
      await expect(journaled).rejects.toThrow("engine-store-busy");

      const closing = provider
        .close()
        .then(() => null)
        .catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(10_000);
      const closeFailure = await closing;
      expect(closeFailure).not.toBeNull();
      // Not the released-with-failed-settle shape: the session is still here.
      expect(closeFailure).not.toBeInstanceOf(YdocReleasedWithSettleFailureError);
      expect(String(closeFailure)).toContain("engine-store-busy");
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a terminal pre-close failure instead of wedging on it", async () => {
    // The narrowness guard for the refusal above. Only a TRANSIENT failure is
    // worth holding the session for, because only that class is retried. A
    // terminal one cannot be waited out, so refusing the teardown would strand
    // the entry forever holding a daemon lease nobody can release — worse than
    // reporting the loss.
    //
    const engine = seedPlaintextEngine();
    const busy = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: "engine-store-busy",
        retry: "afterBackoff",
      },
      new Error("daemon response"),
    );
    const terminal = new DaemonRefusalError(
      { code: "INVALID_PARAMS", message: "conflict-stale-target", retry: "no" },
      new Error("daemon response"),
    );
    // The journal is refused busy (leaving state unsent); every later record
    // is refused terminally, so the close's resend cannot be waited out.
    let records = 0;
    const transport: EngineTransport = {
      ...forwardYdocBlobEgress(engine),
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.recordUpdate) {
          records += 1;
          throw records <= 2 ? busy : terminal;
        }
        return engine.sendRequest(request);
      },
    };
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      onSettleError: () => undefined,
      scheduleSettle: () => () => undefined,
    });
    await provider
      .applyLocalUpdate(
        plaintextUpdate(provider.initialUpdate, (body) => {
          body.insert(0, "typed against a terminal engine");
        }),
      )
      .catch(() => undefined);

    // The release completes and reports, rather than holding the session.
    const outcome = await provider
      .close()
      .then(() => null)
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(YdocReleasedWithSettleFailureError);
  });

  it.each([
    ["evict", "saved"], ["evict", "refused"], ["close", "unavailable"],
  ] as const)("handles unsent state before terminal %s: %s", async (release, recovery) => {
    const engine = seedPlaintextEngine();
    const busy = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: "engine-store-busy",
        retry: "afterBackoff",
      },
      new Error("daemon response"),
    );
    const terminal = new DaemonRefusalError(
      { code: "INVALID_PARAMS", message: "conflict-stale-target", retry: "no" },
      new Error("daemon response"),
    );
    let records = 0;
    const evictions: string[] = [];
    let beginHandoff!: () => void;
    let completeHandoff!: () => void;
    const handoffStarted = new Promise<void>(resolve => { beginHandoff = resolve; });
    const handoffCompleted = new Promise<void>(resolve => { completeHandoff = resolve; });
    const preserveUnsentState = vi.fn(async (doc: Y.Doc) => {
      evictions.push(doc.getText("plainText").toString());
      beginHandoff();
      if (recovery === "refused") throw new Error("draft storage refused");
      await handoffCompleted;
    });
    const transport: EngineTransport = {
      ...forwardYdocBlobEgress(engine),
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.recordUpdate) {
          records += 1;
          throw records <= 2 ? busy : terminal;
        }
        if (request.method === YDOC_METHOD.evict || request.method === YDOC_METHOD.close) evictions.push(release);
        return engine.sendRequest(request);
      },
    };
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      onSettleError: () => undefined,
      preserveUnsentState: recovery === "unavailable" ? undefined : preserveUnsentState,
      scheduleSettle: () => () => undefined,
    });
    await provider
      .applyLocalUpdate(
        plaintextUpdate(provider.initialUpdate, (body) => {
          body.insert(0, "typed against a terminal engine");
        }),
      )
      .catch(() => undefined);

    const completeText = provider.doc.getText("plainText").toString();
    expect(completeText).toContain("typed against a terminal engine");
    const releaseProvider = () => release === "close" ? provider.close({ settle: false }) : provider.evict();
    if (recovery === "saved") {
      const releasing = releaseProvider();
      const outcome = releasing.catch((error: unknown) => error);
      expect(await Promise.race([handoffStarted.then(() => true), outcome.then(() => false)])).toBe(true);
      expect(evictions).toEqual([completeText]);
      completeHandoff();
      expect(await outcome).toBeUndefined();
      expect(evictions).toEqual([completeText, release]);
    } else if (recovery === "refused") {
      await expect(releaseProvider()).rejects.toThrow("draft storage refused");
      expect(evictions).not.toContain(release);
    } else {
      if (release === "close") await expect(releaseProvider()).rejects.toBeInstanceOf(YdocReleasedWithSettleFailureError);
      else await expect(releaseProvider()).resolves.toBeUndefined();
      expect(evictions).toEqual([release]);
    }
  });

  it("debounces on its own timers when the caller supplies no scheduler", async () => {
    // Every other provider test in this file replaces the settle scheduler, so
    // this is the one place the provider's own setTimeout/clearTimeout runs. A
    // debounce that never fires never writes the file; a cancel that never
    // clears wakes a released session and reports a failure against a document
    // the user already closed. The clock is driven, not waited on.
    vi.useFakeTimers();
    try {
      const engine = seedPlaintextEngine();
      const settled: unknown[] = [];
      const sessionErrors: unknown[] = [];
      const provider = await openEngineYdocProviderSession({
        transport: engine,
        workspace: WORKSPACE,
        versionId: VERSION,
        path: PATH,
        contentKind: "plaintext",
        settleDebounceMs: 50,
        onRemoteUpdate: () => undefined,
        onSessionError: (error) => sessionErrors.push(error),
        onSettled: (result) => {
          settled.push(result);
        },
      });

      await provider.applyLocalUpdate(
        plaintextUpdate(provider.initialUpdate, (text) => {
          text.insert(0, "debounced onto the provider's own timer");
        }),
      );
      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveLength(1);

      // A second edit arms another timer. `close` runs its cancel before its
      // first await, so the arm and the cancel land in the same tick.
      const pending = provider.applyLocalUpdate(
        plaintextUpdate(provider.initialUpdate, (text) => {
          text.insert(0, "armed then cancelled");
        }),
      );
      await provider.close({ settle: false });
      await pending.catch(() => undefined);
      const settlesAtClose = engine.requests.filter(
        (request) => request.method === YDOC_METHOD.settle,
      ).length;
      await vi.advanceTimersByTimeAsync(500);

      expect(
        engine.requests.filter(
          (request) => request.method === YDOC_METHOD.settle,
        ),
      ).toHaveLength(settlesAtClose);
      expect(sessionErrors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a settle after a SYNCHRONOUS local edit failure", async () => {
    // An ill-formed edit throws out of applyLocalUpdate without ever attaching
    // to the journal chain, so the chain the settle awaits resolves clean.
    // Settling anyway would write an artifact missing the edit the user just
    // made, and report success for it.
    const engine = seedPlaintextEngine();
    const settleErrors: unknown[] = [];
    const provider = await openEngineYdocProviderSession({
      transport: engine,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      onSettleError: (error) => settleErrors.push(error),
      scheduleSettle: () => () => undefined,
    });

    expect(() =>
      provider.applyLocalUpdate(
        plaintextUpdate(provider.initialUpdate, (text) => {
          text.insert(0, "\ud800");
        }),
      ),
    ).toThrow(IllFormedUtf16EditError);

    await expect(provider.settleNow()).rejects.toBeInstanceOf(
      IllFormedUtf16EditError,
    );
    expect(settleErrors[0]).toBeInstanceOf(IllFormedUtf16EditError);
    expect(engine.requests.map((request) => request.method)).not.toContain(
      YDOC_METHOD.settle,
    );

    await provider.close({ settle: false });
  });

  it("waits for an in-flight settle before releasing the session", async () => {
    // Releasing while a settle is still at the engine races the write against
    // the lease teardown: close resolves, the capture layer lifts its path
    // guard, and the settle that was still landing the artifact finishes
    // against a session that is already gone.
    const engine = seedPlaintextEngine("seed");
    let releaseSettle!: () => void;
    const settleGate = new Promise<void>((resolve) => {
      releaseSettle = resolve;
    });
    const order: string[] = [];
    const transport: EngineTransport = {
      ...forwardYdocBlobEgress(engine),
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.settle) {
          await settleGate;
          order.push("settled");
        }
        if (request.method === YDOC_METHOD.close) order.push("released");
        return engine.sendRequest(request);
      },
    };
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      scheduleSettle: () => () => undefined,
    });
    // A recorded update, so the settle below finds durable state instead
    // of hitting the daemon's NoMarker guard.
    await provider.applyLocalUpdate(
      plaintextUpdate(provider.initialUpdate, (text) => {
        text.insert(0, "typed");
      }),
    );

    const settling = provider.settleNow();
    const closing = provider.close({ settle: false });
    await drain();
    // The close is parked on the settle chain: nothing has been released.
    expect(order).toEqual([]);

    releaseSettle();
    await settling;
    await closing;

    expect(order).toEqual(["settled", "released"]);
    expect(engine.activeSessionIds()).toHaveLength(0);
  });

  it("never escalates to a settling close when the caller forbids it", async () => {
    const engine = seedPlaintextEngine();
    const unsettledClose = new Error("injected unsettled close");
    const closes: Array<boolean | undefined> = [];
    const transport: EngineTransport = {
      ...forwardYdocBlobEgress(engine),
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.close) {
          const settle = (request.params as { settle?: boolean }).settle;
          closes.push(settle);
          if (settle === false) throw unsettledClose;
        }
        return engine.sendRequest(request);
      },
    };
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      scheduleSettle: () => () => undefined,
    });

    await expect(
      provider.close({ settle: false, settleOnRefusal: false }),
    ).rejects.toBe(unsettledClose);
    // One close attempt, and it did not settle. The settling retry is what
    // would have materialized the path.
    expect(closes).toEqual([false]);
  });

  it("rejects edits while a failed provider close is incomplete, then converges on retry", async () => {
    const engine = seedPlaintextEngine();
    const firstCloseFailure = new Error("injected plain close failure");
    const settlingCloseFailure = new Error("injected settling close failure");
    const closes: Array<boolean | undefined> = [];
    let allowClose = false;
    const transport: EngineTransport = {
      ...forwardYdocBlobEgress(engine),
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.close) {
          const settle = (request.params as { settle?: boolean }).settle;
          closes.push(settle);
          if (!allowClose) {
            throw settle === false
              ? firstCloseFailure
              : settlingCloseFailure;
          }
        }
        return engine.sendRequest(request);
      },
    };
    const provider = await openEngineYdocProviderSession({
      transport,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      scheduleSettle: () => () => undefined,
    });
    const update = plaintextUpdate(provider.initialUpdate, (text) => {
      text.insert(0, "must reject");
    });

    await expect(provider.close({ settle: false })).rejects.toBe(
      settlingCloseFailure,
    );
    await expect(provider.applyLocalUpdate(update)).rejects.toBe(
      settlingCloseFailure,
    );
    expect(engine.recordedUpdates).toHaveLength(0);

    allowClose = true;
    await expect(provider.close({ settle: false })).resolves.toBeUndefined();
    expect(closes).toEqual([false, true, false]);
    expect(engine.activeSessionIds()).toHaveLength(0);
  });

  it("round-trips the full provider lifecycle through typed R03 requests, responses, and events", async () => {
    const engine = seedPlaintextEngine("seed");
    const remoteUpdates: Array<{update: Uint8Array; head?: YdocDeliveredHead}> = [];
    const provider = await openEngineYdocProviderSession({
      transport: engine,
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      onRemoteUpdate: (update, head) => remoteUpdates.push({update, ...(head ? {head} : {})}),
      scheduleSettle: () => () => undefined,
    });
    const update = plaintextUpdate(provider.initialUpdate, (text) => {
      text.insert(text.length, " local");
    });

    provider.applyLocalUpdate(update);
    const settled = await provider.settleNow({ summary: "manual settle" });
    engine.applyRemoteUpdate(
      engine.activeSessionIds()[0]!,
      plaintextUpdate(provider.initialUpdate, (text) => {
        text.insert(0, "remote: ");
      }),
    );
    // `settle: true` (not `false`): the remote update left the projection
    // past the manual settle's `last_settled_sha`, and a local-only close
    // refuses a prune the artifact does not already cover (durable.rs
    // close_session). `settle: true` runs the ladder's normal pre-close
    // settle first, which is what covers it.
    await provider.close({ settle: true });

    expect(settled?.content).toBe("seed local");
    expect(settled?.projection).toEqual({
      contentKind: "plaintext",
      sourceStateVectorSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      destructive: false,
    });
    expect(provider.doc.getText("plainText").toString()).toBe("remote: seed local");
    // The remote edit arrives once. Each settle sends only its committed head.
    const receipts = remoteUpdates.filter((delivery) => delivery.head !== undefined);
    expect(remoteUpdates.length - receipts.length).toBe(1);
    expect(receipts[0]).toEqual({update: new Uint8Array([0, 0]), head: {sha256: settled!.sha256, committed: true}});
    expect(receipts.every((delivery) => delivery.head?.committed && delivery.update.byteLength === 2)).toBe(true);
    expect(engine.activeSessionIds()).toHaveLength(0);

    expect(engine.requests.map((request) => request.method)).toEqual([
      YDOC_METHOD.open,
      // The captured seed ("seed") now journals through a real recordUpdate
      // (#721/#728: `ydoc_open_state_on_store` returns `seedContent` for a
      // head-present open with no lineage yet, and the adapter records it),
      // ahead of the manual local edit's own recordUpdate.
      YDOC_METHOD.recordUpdate,
      YDOC_METHOD.recordUpdate,
      YDOC_METHOD.settle,
      YDOC_METHOD.settle,
      YDOC_METHOD.close,
    ]);
    expect(engine.responses.map((response) => response.id)).toEqual(
      engine.requests.map((request) => request.id),
    );
    expect(engine.requests[0]).toMatchObject({
      id: 1,
      method: YDOC_METHOD.open,
      workspace: WORKSPACE,
      params: { versionId: VERSION, path: PATH, contentKind: "plaintext" },
    });
    expect(engine.requests[1]).toMatchObject({
      idempotencyKey: "session-1:1",
      params: {
        sessionId: "session-1",
        updateBase64: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/),
      },
    });
    expect(engine.requests[2]).toMatchObject({
      idempotencyKey: "session-1:2",
      params: {
        sessionId: "session-1",
        updateBase64: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/),
      },
    });
    expect(engine.requests[3]?.params).toEqual({
      sessionId: "session-1",
      summary: "manual settle",
    });
    expect(engine.requests[4]?.params).toEqual({
      sessionId: "session-1",
      summary: "session close",
    });
    expect(engine.requests[5]?.params).toEqual({
      sessionId: "session-1",
      settle: false,
    });
    expect(engine.events[0]).toMatchObject({
      seq: 1,
      sessionGeneration: 1,
      name: YDOC_EVENT.remoteUpdate,
      payload: {
        sessionId: "session-1",
        updateBase64: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/),
      },
    });
  });

});

describe("the ydoc.open deadline", () => {
  function silentDaemon(): EngineTransport & { armed: number[] } {
    const armed: number[] = [];
    return {
      armed,
      sendRequest(request) {
        const deadlineMs = request.deadlineMs;
        if (deadlineMs === undefined || deadlineMs === null) {
          return new Promise<never>(() => undefined);
        }
        armed.push(deadlineMs);
        return new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(
              new EngineRequestDeadlineError(
                request.id,
                request.method,
                deadlineMs,
              ),
            );
          }, deadlineMs);
        });
      },
      onEvent: () => () => undefined,
    };
  }

  it("refuses at the bound when the daemon never answers, naming the limit and the wait", async () => {
    // What the bound's SIZE has to clear is measured in
    // ydocOpenMeasurement.e2e.test.ts. What is pinned here is that the open
    // ends at whatever that bound is, and not one tick before it.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
    });
    try {
      const transport = silentDaemon();
      const adapter = new YdocLiveAdapter(transport);
      const opening = adapter.openSession({
        workspace: WORKSPACE,
        versionId: VERSION,
        path: PATH,
        contentKind: "plaintext",
      });
      const settled = vi.fn();
      void opening.then(settled, settled);

      await vi.advanceTimersByTimeAsync(YDOC_OPEN_DEADLINE_MS - 1);
      expect(transport.armed).toEqual([YDOC_OPEN_DEADLINE_MS]);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const error: unknown = await opening.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(YdocOpenTimedOutError);
      const timedOut = error as YdocOpenTimedOutError;
      expect(timedOut.limitMs).toBe(YDOC_OPEN_DEADLINE_MS);
      expect(timedOut.waitedMs).toBe(YDOC_OPEN_DEADLINE_MS);
      expect(timedOut.path).toBe(PATH);
      expect(timedOut.message).toContain(
        `The ydoc.open deadlineMs limit of ${YDOC_OPEN_DEADLINE_MS}ms was reached`,
      );
      expect(timedOut.message).toContain(
        `the caller waited ${YDOC_OPEN_DEADLINE_MS}ms`,
      );
      expect(timedOut.cause).toBeInstanceOf(EngineRequestDeadlineError);
      adapter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resurrects an evicted lineage, and prunes a closed one", async () => {
    // The loopback used to keep the CRDT rows inside the
    // session, so an evict took the document with it and the reopen found the
    // file. That models less than the daemon — which keeps the lineage across
    // an eviction and resurrects it — so any test driving it would certify a
    // convergence that never happens.
    const engine = seedPlaintextEngine("on disk");
    const transport: EngineTransport = {
      ...forwardYdocBlobEgress(engine),
      onEvent: (handler) => engine.onEvent(handler),
      sendRequest: (request) => engine.sendRequest(request),
    };
    const open = async () =>
      await openEngineYdocProviderSession({
        transport,
        workspace: WORKSPACE,
        versionId: VERSION,
        path: PATH,
        contentKind: "plaintext",
        onRemoteUpdate: () => undefined,
        scheduleSettle: () => () => undefined,
      });

    const first = await open();
    await first.applyLocalUpdate(
      plaintextUpdate(first.initialUpdate, (text) => {
        text.insert(0, "typed and never settled: ");
      }),
    );
    await first.evict();

    const resurrected = await open();
    expect(resurrected.lineage, "delete the lineage in `evict` too -> this open seeds 'on disk' instead of resurrecting the edited document, and the desktop's #665 convergence test would pass against a fake that can lose the document.").toBe("existing");
    expect(resurrected.doc.getText("plainText").toString()).toBe(
      "typed and never settled: on disk",
    );

    // The other half, and the reason evict is a separate verb: a local-only
    // close prunes those rows, so the next open reseeds from the file.
    await resurrected.close({ settle: false });
    const reseeded = await open();
    expect(reseeded.lineage).toBe("absent");
    expect(reseeded.doc.getText("plainText").toString()).toBe("on disk");
    await reseeded.close({ settle: false });
  });

  it("keys the lineage by object identity, so a rename resurrects it and a reused path does not", async () => {
    const OLD_PATH = "notes/original.md";
    const NEW_PATH = "notes/renamed.md";
    const engine = new YdocLoopbackEngine();
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: OLD_PATH,
      content: "original content",
      contentKind: "plaintext",
      objectId: "object-original",
    });
    const adapter = new YdocLiveAdapter(engine);

    const first = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: OLD_PATH,
      contentKind: "plaintext",
    });
    await first.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "typed, never settled: ",
    });
    await first.evict();

    // A different object lands at the old path (delete + unrelated
    // recreate).
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: OLD_PATH,
      content: "a completely different file",
      contentKind: "plaintext",
      objectId: "object-new",
    });
    const reusedPath = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: OLD_PATH,
      contentKind: "plaintext",
    });
    expect(reusedPath.lineage).toBe("absent");
    expect(reusedPath.doc.getText("plainText").toString()).toBe(
      "a completely different file",
    );
    // The captured head already covers this recorded seed, so a non-settling
    // close can prune the local-only lineage without materializing anything.
    await reusedPath.close({ settle: false });

    // The same object, renamed to a new path.
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: NEW_PATH,
      content: "original content",
      contentKind: "plaintext",
      objectId: "object-original",
    });
    const renamed = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: NEW_PATH,
      contentKind: "plaintext",
    });
    expect(renamed.lineage).toBe("existing");
    expect(renamed.doc.getText("plainText").toString()).toBe(
      "typed, never settled: original content",
    );
    await renamed.close({ settle: true });
    adapter.dispose();
  });

  it("captured-head coverage is scoped by workspace and version, not object id alone", async () => {
    const OTHER_VERSION = "version-2";
    const engine = new YdocLoopbackEngine();
    const adapter = new YdocLiveAdapter(engine);

    // No file seeded in this scope at all — the session's object id is
    // plain-derived from its own path, and nothing in `files` matches it
    // yet.
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(session.lineage).toBe("absent");
    await session.applyLocalTextEdit({
      root: "plainText",
      index: 0,
      insert: "same object id, wrong scope: ",
    });

    // A different version's fixture reuses the same (derived) object id
    // string, with content matching this session's content — a plausible
    // fixture collision the daemon's DocKey always keeps apart. This is
    // the only `files` entry with this object id, in either scope.
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: OTHER_VERSION,
      path: PATH,
      content: "same object id, wrong scope: ",
      contentKind: "plaintext",
      objectId: session.objectId,
    });

    await expect(session.close({ settle: false })).rejects.toThrow(
      /ydoc-unsettled-close/,
    );
    adapter.dispose();
  });

  it("an explicit settle:true close on an untouched absent-lineage session refuses instead of materializing an empty projection", async () => {
    const materialized: Array<{ path: string; content: string }> = [];
    const engine = new YdocLoopbackEngine({
      materialize: (input) => materialized.push(input),
    });
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(session.lineage).toBe("absent");

    await expect(session.close({ settle: true })).rejects.toThrow();
    expect(materialized).toHaveLength(0);

    // The session is still the daemon's: a non-settling close succeeds
    // cleanly.
    await session.close({ settle: false });
    adapter.dispose();
  });

  it("object-alias-collision is scoped to the target workspace, not global", async () => {
    const OTHER_WORKSPACE = "workspace-handle-other";
    const engine = new YdocLoopbackEngine();
    const adapter = new YdocLiveAdapter(engine);

    // Learn the id this workspace's path would derive, side-effect-free
    // (no edit, so evicting leaves no lineage behind).
    const probe = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    const derivedId = probe.objectId;
    await probe.evict();

    // A different workspace's fixture happens to reuse that exact id
    // string.
    engine.seedFile({
      workspace: OTHER_WORKSPACE,
      versionId: VERSION,
      path: PATH,
      content: "unrelated workspace's file",
      contentKind: "plaintext",
      objectId: derivedId,
    });

    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
    });
    expect(session.objectId).toBe(derivedId);
    expect(session.lineage).toBe("absent");
    await session.close({ settle: false });
    adapter.dispose();
  });

});

describe("no-edit settle skip", () => {

  it.each([
    {
      name: "heading",
      source: "# Shared\n\nStarting together.\n\n",
      canonical: "# Shared\n\nStarting together.\n",
    },
    {
      name: "backtick-bearing code language",
      source: "~~~lang`tick\ncode\n~~~\n\nStarting together.\n\n",
      canonical: "~~~lang`tick\ncode\n~~~\n\nStarting together.\n",
    },
  ])("the first richdoc seed carries its exact captured Markdown across the wire ($name)", async ({ source, canonical }) => {
    const engine = new YdocLoopbackEngine();
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: "shared.md",
      content: source,
      contentKind: "richdoc",
    });
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: "shared.md",
      contentKind: "richdoc",
    });
    const records = engine.requests.filter(
      (request) => request.method === YDOC_METHOD.recordUpdate,
    );
    expect(records).toHaveLength(1);
    const seed = records[0]!.params as { seed: boolean; updateBase64: string };
    expect(seed.seed).toBe(true);
    const receiver = new Y.Doc();
    Y.applyUpdate(receiver, Buffer.from(seed.updateBase64, "base64"));
    try {
      expect(ydocProjection.yDocToMarkdown(receiver)).toBe(canonical);
      const meta = receiver.getMap("meta");
      expect(meta.get("dohcMarkdownSource")).toBe(source);
      expect(meta.get("dohcMarkdownSourceSha256")).toBe(
        createHash("sha256").update(source).digest("hex"),
      );
      expect(meta.get("dohcMarkdownSourceProjectionSha256")).toBe(
        createHash("sha256").update(canonical).digest("hex"),
      );

      const paragraph = receiver.getXmlFragment("body").get(1) as Y.XmlElement;
      const text = paragraph.get(0) as Y.XmlText;
      text.insert(text.length, " Both desktops see this edit.");
      expect(ydocProjection.yDocToMarkdown(receiver)).toBe(
        `${canonical.trimEnd()} Both desktops see this edit.\n`,
      );
      expect(meta.get("dohcMarkdownSourceProjectionSha256")).not.toBe(
        createHash("sha256")
          .update(ydocProjection.yDocToMarkdown(receiver))
          .digest("hex"),
      );
    } finally {
      receiver.destroy();
      await session.close();
      adapter.dispose();
    }
  });

  it("a replayed prior state never declares a seed and still materializes", async () => {
    const materialize = vi.fn();
    const engine = new YdocLoopbackEngine({ materialize });
    engine.seedFile({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      content: "seeded body",
      contentKind: "plaintext",
    });
    const adapter = new YdocLiveAdapter(engine);
    // The capture rebind path: a replacement generation opens with
    // `seedAbsentLineage: false` and re-establishes the renderer's canonical
    // doc — file content plus unsettled prior edits — as its first update.
    const session = await adapter.openSession({
      workspace: WORKSPACE,
      versionId: VERSION,
      path: PATH,
      contentKind: "plaintext",
      seedAbsentLineage: false,
    });
    const canonical = new Y.Doc();
    canonical.getMap("frontmatter");
    canonical.getMap("meta");
    canonical.getXmlFragment("body");
    canonical.getText("plainText").insert(0, "prior edit seeded body");
    await session.applyLocalUpdate(Y.encodeStateAsUpdate(canonical));
    await session.close();
    adapter.dispose();

    const records = engine.requests.filter(
      (request) => request.method === YDOC_METHOD.recordUpdate,
    );
    expect(records).toHaveLength(1);
    // The replayed state is not a seed: declaring it would let the engine
    // skip the settle write and prune the prior edits unlanded.
    expect(records[0]?.params).not.toHaveProperty("seed");
    expect(materialize).toHaveBeenCalledWith({
      path: PATH,
      content: "prior edit seeded body",
    });
  });
});

describe("immutable original-record recovery", () => {
  it.each([
    { code: "CANCELLED", retry: "no", message: "answer lost after commit" },
    { code: "INTERNAL", retry: "afterBackoff", message: "response-wire-limit-exceeded" },
  ] as const)("keeps a committed $code / $message record pending until its keyed retry dedupes", async wireError => {
    const engine = seedPlaintextEngine("abc");
    const resyncEntered = Promise.withResolvers<void>();
    const releaseResync = Promise.withResolvers<void>();
    const attempts: Request[] = [];
    const refused = vi.fn();
    let fail = false;
    const adapter = new YdocLiveAdapter({
      ...forwardYdocBlobEgress(engine), onEvent: handler => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.resync) {
          resyncEntered.resolve();
          await releaseResync.promise;
        }
        if (request.method === YDOC_METHOD.recordUpdate) {
          attempts.push(structuredClone(request));
          const response = await engine.sendRequest(request);
          if (fail) {
            fail = false;
            throw new DaemonRefusalError(wireError, undefined);
          }
          return response;
        }
        return engine.sendRequest(request);
      },
    });
    const session = await adapter.openSession({ workspace: WORKSPACE, versionId: VERSION, path: PATH });
    session.onLocalUpdateRefused(refused);
    const before = engine.recordedUpdates.length;
    attempts.length = 0;
    fail = true;
    try {
      const editing = session.applyLocalTextEdit({ root: "plainText", index: 3, insert: "d" },
        { idempotencyKey: "uncertain-original" });
      await resyncEntered.promise;
      expect(session.missingLocalState).toBe(true);
      expect(session.doc.getText("plainText").toString()).toBe("abcd");
      expect(refused).not.toHaveBeenCalled();
      releaseResync.resolve();
      await editing;
      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.idempotencyKey).toBe(attempts[0]?.idempotencyKey);
      expect(attempts[1]?.params).toEqual(attempts[0]?.params);
      expect(engine.recordedUpdates.length - before).toBe(1);
      expect(session.missingLocalState).toBe(false);
      expect(refused).not.toHaveBeenCalled();
      await expect(session.settle()).resolves.toMatchObject({ content: "abcd" });
    } finally { releaseResync.resolve(); await session.evict(); adapter.dispose(); }
  });

  it("retires a refused client's causal tail and records an independent keyed client", async () => {
    const engine = seedPlaintextEngine("abc");
    const refusal = new DaemonRefusalError({ code: "INVALID_PARAMS", message: "future-refusal", retry: "no" }, undefined);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const refused = vi.fn();
    const adapter = new YdocLiveAdapter({
      ...forwardYdocBlobEgress(engine), onEvent: handler => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.idempotencyKey === "refused") {
          entered.resolve(); await release.promise; throw refusal;
        }
        return engine.sendRequest(request);
      },
    });
    const session = await adapter.openSession({ workspace: WORKSPACE, versionId: VERSION, path: PATH });
    session.onLocalUpdateRefused(refused);
    const client = new Y.Doc();
    Y.applyUpdate(client, session.initialUpdate);
    const firstVector = Y.encodeStateVector(client);
    client.getText("plainText").insert(3, " refused");
    const first = session.applyLocalUpdate(Y.encodeStateAsUpdate(client, firstVector), { idempotencyKey: "refused" });
    await entered.promise;
    const secondVector = Y.encodeStateVector(client);
    client.getText("plainText").insert(client.getText("plainText").length, " dependent");
    const dependent = session.applyLocalUpdate(Y.encodeStateAsUpdate(client, secondVector), { idempotencyKey: "dependent" });
    const independent = session.applyLocalUpdate(plaintextUpdate(session.initialUpdate, text => text.insert(3, " independent")),
      { idempotencyKey: "independent", actorOriginId: "other-agent" });
    release.resolve();
    await expect(first).rejects.toBe(refusal);
    await expect(dependent).rejects.toBe(refusal);
    await independent;
    expect(refused.mock.calls.map(([id]) => id)).toEqual(["refused", "dependent"]);
    expect(session.missingLocalState).toBe(false);
    await expect(session.settle()).resolves.toMatchObject({ content: "abc independent" });
    client.destroy(); await session.evict(); adapter.dispose();
  });

  it.each(["recovery", "resend"] as const)("restores an acknowledged base as a neutral seed before originals during %s", async mode => {
    const engine = seedPlaintextEngine("abc");
    let fail = false;
    const attempts: Request[] = [];
    const busy = new DaemonRefusalError({ code: "OVERLOADED", message: "engine-store-busy", retry: "afterBackoff" }, undefined);
    const adapter = new YdocLiveAdapter({
      ...forwardYdocBlobEgress(engine), onEvent: handler => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.recordUpdate) {
          attempts.push(structuredClone(request));
          if (fail) {
            if (mode === "recovery") fail = false;
            throw mode === "resend" ? busy : new Error("lost native state");
          }
        }
        return engine.sendRequest(request);
      },
    });
    const session = await adapter.openSession({ workspace: WORKSPACE, versionId: VERSION, path: PATH });
    await session.applyLocalTextEdit({ root: "plainText", index: 0, deleteLength: 1 });
    engine.discardSessionState(session.sessionId);
    attempts.length = 0;
    fail = true;
    const edit = session.applyLocalTextEdit({ root: "plainText", index: 2, insert: "d" },
      { idempotencyKey: "bob-original", actorOriginId: "bob-agent",
        attribution: { actorKind: "agent", onBehalfOf: "bob", depth: 1 } });
    if (mode === "resend") {
      await expect(edit).rejects.toBe(busy);
      fail = false;
      attempts.length = 0;
      await session.resendMissingState();
    } else await edit;
    const delivered = mode === "resend" ? attempts : attempts.slice(1);
    expect(delivered).toHaveLength(2);
    expect(delivered[0]?.params).toMatchObject({ seed: true });
    expect(delivered[0]?.params).not.toHaveProperty("actorOriginId");
    expect(delivered[0]?.params).not.toHaveProperty("attribution");
    expect(delivered[1]).toMatchObject({ idempotencyKey: "bob-original",
      params: { actorOriginId: "bob-agent", attribution: { onBehalfOf: "bob" } } });
    const base = new Y.Doc();
    Y.applyUpdate(base, Buffer.from((delivered[0]?.params as { updateBase64: string }).updateBase64, "base64"));
    expect(base.getText("plainText").toString()).toBe("bc");
    expect(session.missingLocalState).toBe(false);
    await expect(session.settle()).resolves.toMatchObject({ content: "bcd" });
    base.destroy(); await session.close({ settle: false }); adapter.dispose();
  });

  it.each([
    { code: "INVALID_PARAMS" as const, message: "future-update-refusal" },
    { code: "SHARE_READ_ONLY" as const, message: "share-read-only" },
  ])("removes a definitive $message refusal and saves later typing", async ({ code, message }) => {
    const engine = seedPlaintextEngine("abc");
    const refusal = new DaemonRefusalError({ code, message, retry: "no" }, undefined);
    let refuse = false;
    const refused = vi.fn();
    const replacing = vi.fn();
    const scheduler = settleScheduler();
    const provider = await openEngineYdocProviderSession({
      transport: { ...forwardYdocBlobEgress(engine), onEvent: handler => engine.onEvent(handler),
        async sendRequest(request) {
          if (refuse && request.method === YDOC_METHOD.recordUpdate) { refuse = false; throw refusal; }
          return engine.sendRequest(request);
        } },
      workspace: WORKSPACE, versionId: VERSION, path: PATH,
      onRemoteUpdate() {}, onLocalUpdateRefused: refused, onLineageReplaced: replacing,
      scheduleSettle: scheduler.schedule,
    });
    const oldDoc = provider.doc;
    refuse = true;
    const first = provider.applyLocalUpdate(plaintextUpdate(provider.initialUpdate, text => text.insert(3, " refused")),
      { idempotencyKey: "refused-original" });
    const dependent = provider.applyLocalUpdate(plaintextUpdate(Y.encodeStateAsUpdate(provider.doc),
      text => text.insert(text.length, " dependent")), { idempotencyKey: "dependent-original" });
    await expect(first).rejects.toBe(refusal);
    await expect(dependent).rejects.toBe(refusal);
    expect(refused).toHaveBeenCalledWith("refused-original", refusal);
    expect(refused).toHaveBeenCalledWith("dependent-original", refusal);
    expect(refused).toHaveBeenCalledTimes(2);
    expect(replacing).toHaveBeenCalledWith(provider.doc, [], undefined);
    expect(refused.mock.invocationCallOrder[0]).toBeLessThan(replacing.mock.invocationCallOrder[0]!);
    expect(provider.doc).not.toBe(oldDoc);
    expect(provider.doc.getText("plainText").toString()).toBe("abc");
    await provider.applyLocalUpdate(plaintextUpdate(Y.encodeStateAsUpdate(provider.doc), text => text.insert(3, " later")));
    await expect(provider.settleNow()).resolves.toMatchObject({ content: "abc later" });
    expect(engine.requests.filter(request => request.method === YDOC_METHOD.resync)).toHaveLength(0);
    await provider.close({ settle: false });
  });

  it("retries a lost acknowledgement with the same bytes, ID and author snapshot", async () => {
    const engine = seedPlaintextEngine("abc");
    const attempts: Request[] = [];
    let loseAck = false;
    const adapter = new YdocLiveAdapter({
      ...forwardYdocBlobEgress(engine),
      onEvent: handler => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.recordUpdate && loseAck) {
          attempts.push(structuredClone(request));
          const response = await engine.sendRequest(request);
          if (attempts.length === 1) throw new Error("acknowledgement lost");
          return response;
        }
        return engine.sendRequest(request);
      },
    });
    const session = await adapter.openSession({ workspace: WORKSPACE, versionId: VERSION, path: PATH });
    const before = engine.recordedUpdates.length;
    const attribution = { actorKind: "automation" as const, onBehalfOf: "alice", depth: 2,
      run: { claimId: "run-a", automationName: "Original name" } };
    loseAck = true;
    const deleting = session.applyLocalTextEdit({ root: "plainText", index: 0, deleteLength: 1 },
      { actorOriginId: "automation-a", attribution });
    attribution.onBehalfOf = "bob";
    attribution.depth = 9;
    attribution.run.automationName = "Renamed";
    await deleting;
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.params).toEqual(attempts[0]?.params);
    expect(attempts[1]?.idempotencyKey).toBe(attempts[0]?.idempotencyKey);
    expect(attempts[0]?.params).toMatchObject({ actorOriginId: "automation-a",
      attribution: { onBehalfOf: "alice", depth: 2, run: { automationName: "Original name" } } });
    expect(engine.recordedUpdates.length - before).toBe(1);
    expect(session.missingLocalState).toBe(false);
    await session.close();
    adapter.dispose();
  });

  it("replays mixed pending authors separately, including an original deletion-only record", async () => {
    const engine = seedPlaintextEngine("abc");
    let busy = false;
    const accepted: Request[] = [];
    const refused: Request[] = [];
    const adapter = new YdocLiveAdapter({
      ...forwardYdocBlobEgress(engine), onEvent: handler => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === YDOC_METHOD.recordUpdate) {
          if (busy) {
            refused.push(structuredClone(request));
            throw new DaemonRefusalError({ code: "OVERLOADED", message: "engine-store-busy", retry: "afterBackoff" }, undefined);
          }
          accepted.push(structuredClone(request));
        }
        return engine.sendRequest(request);
      },
    });
    const session = await adapter.openSession({ workspace: WORKSPACE, versionId: VERSION, path: PATH });
    accepted.length = 0;
    busy = true;
    const first = session.applyLocalTextEdit({ root: "plainText", index: 0, deleteLength: 1 },
      { actorOriginId: "alice-agent", attribution: { actorKind: "agent", onBehalfOf: "alice", depth: 1 } });
    const second = session.applyLocalTextEdit({ root: "plainText", index: 2, insert: "d" },
      { actorOriginId: "bob-agent", attribution: { actorKind: "agent", onBehalfOf: "bob", depth: 3 } });
    await expect(first).rejects.toBeInstanceOf(DaemonRefusalError);
    await expect(second).rejects.toBeInstanceOf(DaemonRefusalError);
    busy = false;
    await session.resendMissingState();
    expect(accepted).toHaveLength(2);
    expect(accepted.map(request => request.params)).toEqual([refused[0]?.params, refused[2]?.params]);
    expect(accepted.map(request => request.idempotencyKey)).toEqual([refused[0]?.idempotencyKey, refused[2]?.idempotencyKey]);
    const deletion = Y.decodeUpdate(Buffer.from((accepted[0]?.params as { updateBase64: string }).updateBase64, "base64"));
    expect(deletion.structs).toHaveLength(0);
    expect(deletion.ds.clients.size).toBeGreaterThan(0);
    await expect(session.settle()).resolves.toMatchObject({ content: "bcd" });
    await session.close({ settle: false });
    adapter.dispose();
  });

  it.each(["author", "bytes"])("refuses changed %s reuse even when the local document already holds the update", async change => {
    const engine = seedPlaintextEngine();
    const adapter = new YdocLiveAdapter(engine);
    const session = await adapter.openSession({ workspace: WORKSPACE, versionId: VERSION, path: PATH });
    const source = new Y.Doc();
    const update = (() => { source.getText("plainText").insert(0, "a"); return Y.encodeStateAsUpdate(source); })();
    const options = { idempotencyKey: "fixed-id", actorOriginId: "automation-a",
      attribution: { actorKind: "automation" as const, onBehalfOf: "alice", depth: 2,
        run: { claimId: "run-a", automationName: "Original name" } } };
    await session.applyLocalUpdate(update, options);
    const before = engine.recordedUpdates.length;
    await session.applyLocalUpdate(update, options);
    expect(engine.recordedUpdates).toHaveLength(before);
    const changed = structuredClone(options);
    if (change === "author") changed.actorOriginId = "automation-b";
    if (change === "run name") changed.attribution.run.automationName = "New name";
    if (change === "run claim") changed.attribution.run.claimId = "run-b";
    if (change === "bytes") source.getText("plainText").insert(1, "b");
    await expect(session.applyLocalUpdate(change === "bytes" ? Y.encodeStateAsUpdate(source) : update, changed))
      .rejects.toThrow("idempotency-key-reuse-mismatch");
    expect(engine.recordedUpdates).toHaveLength(before);
    await session.evict();
    adapter.dispose();
    source.destroy();
  });
});
