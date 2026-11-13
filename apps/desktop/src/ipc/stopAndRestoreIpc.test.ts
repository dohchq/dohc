import { SyncedDeletionRevivalError } from "../workspaces/syncedDeletionRefusal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { mockDaemonSessions } from "../testing/liveEngineSessions";
import { createTestScratch } from "../workspaces/testTemp";
import { createCaptureLiveStores } from "../workspaces/workspaceEngineCaptureLiveStore";
import { createWorkspaceEngineCapture, type WorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import type { VersionedTextMoment } from "@dohc/workspace-contracts/engine";
import { parseAutomationsFile, writeAutomationsFile, type Automation } from "@dohc/workspace-contracts/automations";
import { collectionAutomationId } from "@dohc/automation-executor/automation-plan";
import { CollectionAutomations, type KeptAutomationField } from "@dohc/automation-executor/collection-automations";
import { CHANNELS } from "./channels";
import { SHARED_LIVE_RESTORE_BODY, sharedLiveRestoreDetail, sharedLiveRestoreTitle } from "./errorWords";
import { registerStopAndRestoreIpc } from "./stopAndRestoreIpc";
import { liveStopWaitingError } from "./liveEditingStop";
import { stopAndRestoreRecoveryOperations } from "./bridgeContract";
import { newRun } from "@dohc/automation-executor/collection-automation-run";
import { createAutomationRunStore, type PendingRestore } from "@dohc/automation-executor/automation-run-store";
import { preparedAutomationStoreFolder, readersTrustLocalState } from "../testing/preparedLocalState";
import {
  LiveDocumentMutationError,
  LivePageOwnedError,
  RestoreHeadChangedError,
  type WorkspaceEngineMomentDetail,
} from "../workspaces/workspaceEngineCapture";
import type { LocalPersonAuthor } from "../workspaces/desktopRecordEdits";

// The run store reads `.dohc/local` as the engine's open leaves it.
beforeEach(() => readersTrustLocalState());

const KEPT = { id: "f".repeat(32), path: "trip/Tasks/Untitled.md", field: "Finished on", recordId: null };
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
type Pass = { undone: number; left: number; reverted: number; missing: number; keptFields: KeptAutomationField[]; otherKept: number; errorMessage: string | null };
const NOTHING: Pass = { undone: 0, left: 0, reverted: 0, missing: 0, keptFields: [], otherKept: 0, errorMessage: null };
const SCHEMA = "trip/packing/collection.yaml";
// A 2,004-character path: its words would pass the 2,000 characters a refused file's detail may have.
const LONG_PATH = `${`${"a".repeat(199)}/`.repeat(10)}a.md`;
const OWNER: LocalPersonAuthor = { kind: "human", humanId: "user_owner" };

function grant(overrides: Record<string, unknown>) {
  return {
    shareId: "share-1", workspaceId: WORKSPACE_ID, grantId: "grant-edit", recipientUserId: "user_ana",
    access: "edit", revokedAtMs: null, recipientEmail: "ana@example.com", ...overrides,
  };
}

const schemaMoment: VersionedTextMoment = {
  id: "m-schema", workspaceId: WORKSPACE_ID, versionId: "main", objectId: "o-schema", path: SCHEMA, recordedAtMs: 1,
  operation: "write", metadata: { origin: "sync" },
  payload: { before: { path: SCHEMA, text: "name: A\n" }, after: { path: SCHEMA, text: "name: B\n" } },
};

function fixture(options: {
  engineCapture?: WorkspaceEngineCapture;
  rootPath?: string;
  granted?: unknown[];
  ledger?: Record<string, unknown[]>;
  links?: unknown[][];
  // How many link revokes the relay refuses because the link's dependents changed.
  revokeConflicts?: number;
  // A link revoke that fails for another reason.
  revokeError?: Error;
  afterRevoke?: () => Promise<void>;
  moment?: VersionedTextMoment | null;
  protectedMoment?: boolean;
  changed?: boolean;
  otherWindow?: boolean;
  restoreError?: Error;
  stopLiveEditing?: (path: string, objectId: string) => Promise<{keptEdits: "none" | "kept" | "recovered"}>;
  undoRunsOf?: CollectionAutomations["undoRunsOf"];
  serverRestore?: (definitions: ReadonlyArray<{ collectionPath: string; id: string; definitionHash: string }>, again: boolean, retentionId: string) => Promise<Pass>;
  syncNow?: () => Promise<void>;
  ledgerError?: () => Error | null;
  runStore?: ReturnType<typeof createAutomationRunStore>;
  runStoreError?: Error;
  receiptError?: Error;
  beforeReceipt?: () => Promise<void>;
  retainRunsForRestore?: CollectionAutomations["retainRunsForRestore"];
  releaseError?: () => Error | null;
  releaseWait?: () => Promise<void>;
  releaseAllowed?: () => boolean;
  canRelease?: () => boolean;
} = {}) {
  const handlers = new Map<string, (event: { sender: string }, payload: unknown) => unknown>();
  const calls: Array<{ path: string; method: string }> = [];
  const releases: string[] = [];
  // The account main has settled on; a test signs in as someone else mid-request.
  const account = { person: OWNER };
  const granted = options.granted ?? [
    grant({}),
    grant({ grantId: "grant-view", shareId: "share-2", access: "view" }),
    grant({ grantId: "grant-old", shareId: "share-3", revokedAtMs: 5 }),
    grant({ grantId: "grant-bob", recipientUserId: "user_bob" }),
    grant({ grantId: "grant-elsewhere", workspaceId: "other" }),
    { grantId: "grant-link", principalKind: "link" },
  ];
  const ledger = options.ledger ?? {
    "grant-edit": [{ writes: [{ committedAtMs: 2, files: [{ path: SCHEMA, objectId: "o-schema", momentId: "m-schema", created: false }] }], nextAfterOriginSeq: 0 },
      { writes: [], nextAfterOriginSeq: null }],
  };
  const links = options.links ?? [[]];
  let conflicts = options.revokeConflicts ?? 0;
  const bodies: unknown[] = [];
  const pendingEntries = new Map<string, PendingRestore>();
  const relayJson = vi.fn(async (_credentials: string, path: string, init?: RequestInit): Promise<unknown> => {
    calls.push({ path, method: init?.method ?? "GET" });
    if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
    if (path === "/sync/shares") return { granted, received: [] };
    const page = /\/shares\/links(?:\?cursor=(\d+))?$/.exec(path);
    if (page) {
      const index = page[1] === undefined ? 0 : Number(page[1]);
      return { links: links[index] ?? [], ...(index + 1 < links.length ? { nextCursor: String(index + 1) } : {}) };
    }
    const read = /\/collection-writes\/([^?]+)\?afterOriginSeq=(-?\d+)$/.exec(path);
    const ledgerError = read ? options.ledgerError?.() : null;
    if (ledgerError) throw ledgerError;
    if (read) {
      const pages = ledger[decodeURIComponent(read[1]!)] ?? [{ writes: [], nextAfterOriginSeq: null }];
      return pages[Number(read[2]) + 1];
    }
    if (init?.method === "POST" && path.endsWith("/revoke")) {
      for (const value of granted) {
        const row = value as {grantId: string; revokedAtMs: number | null};
        if (path.includes(`/grants/${row.grantId}/`)) row.revokedAtMs = 3;
      }
      await options.afterRevoke?.();
    }
    return {};
  });
  const endLink = vi.fn(async (_credentials: string, path: string, init: RequestInit): Promise<"ended" | "dependents-changed"> => {
    calls.push({ path, method: init.method ?? "GET" });
    if (typeof init.body === "string") bodies.push(JSON.parse(init.body));
    if (options.revokeError) throw options.revokeError;
    if (conflicts > 0) {
      conflicts -= 1;
      return "dependents-changed";
    }
    for (const list of links) for (const link of list as Array<{ status: string }>) link.status = "revoked";
    await options.afterRevoke?.();
    return "ended";
  });
  // Each restore's own moment, which puts the file back as it was before the person.
  const restores = new Map<string, VersionedTextMoment>();
  const capture = {
    findRestoreReceipt: vi.fn(async () => null),
    publicationApplied: vi.fn(async () => true),
    readMoment: vi.fn(async (momentId: string): Promise<WorkspaceEngineMomentDetail | null> => {
      if (options.protectedMoment) return { protected: true, moment: { ...schemaMoment, momentOrder: 1, protected: true } as never };
      const restore = restores.get(momentId);
      if (restore) return { protected: false, moment: restore };
      return options.moment === null ? null : { protected: false, moment: options.moment ?? schemaMoment };
    }),
    listObjectMomentsAfter: vi.fn(async (objectId: string) =>
      [...restores.values()].filter((restore) => restore.objectId === objectId).map((restore) => restore.id).reverse()),
    restoreFileToBeforeMoment: vi.fn(async (momentId: string, _person: LocalPersonAuthor, _options?: { expectedHeadMomentId?: string }) => {
      if (options.changed) throw new RestoreHeadChangedError(SCHEMA);
      if (options.restoreError) throw options.restoreError;
      const theirs = options.moment ?? schemaMoment;
      const before = theirs.payload.before;
      restores.set(`back-${momentId}`, {
        ...theirs, id: `back-${momentId}`, metadata: { origin: "restore" },
        ...(before ? { payload: { before: theirs.payload.after, after: before } } : { operation: "delete" }),
      });
      return { restored: "text" as const, restoredMomentId: `back-${momentId}`, path: SCHEMA };
    }),
  };
  const queuePull = vi.fn();
  const barrier = vi.fn(async () => undefined);
  const receiptBatches: number[] = [];
  const sharesChanged = vi.fn();
  const automationsFor = (runStore = options.runStore) => ({ undoRunsOf: options.undoRunsOf,
    makeWritesDurable: barrier,
    retainRunsForRestore: options.retainRunsForRestore ?? (async () => undefined),
    pendingRestores: () => options.runStoreError ? Promise.reject(options.runStoreError) : runStore?.pendingRestores() ?? Promise.resolve(structuredClone([...pendingEntries.values()])),
    savePendingRestore: async (entry: Parameters<CollectionAutomations["savePendingRestore"]>[0], whilePending?: string) => {
      if (runStore) await runStore.savePendingRestore(entry, whilePending);
      else pendingEntries.set(entry.id, structuredClone({claims: [], ...pendingEntries.get(entry.id), ...entry}));
    },
    recordRestoreIntents: async (id: string, momentIds: readonly string[]) => {
      if (runStore) await runStore.recordRestoreIntents(id, momentIds);
      else {const session = pendingEntries.get(id)?.session; if (session) session.intents = [...new Set([...(session.intents ?? []), ...momentIds])];}
    },
    recordRestoreReceipts: async (id: string, receipts: readonly {path: string; restoredMomentId: string}[], originalMomentIds: readonly string[] = []) => {
      if (options.receiptError) throw options.receiptError;
      await barrier(); await options.beforeReceipt?.(); receiptBatches.push(receipts.length);
      if (runStore) await runStore.recordRestoreReceipts(id, receipts, originalMomentIds);
      else {const session = pendingEntries.get(id)?.session; if (session) {session.receipts.push(...receipts); session.intents = session.intents?.filter(id => !originalMomentIds.includes(id));}}
    },
    undoRestoreReceipts: async (id: string, momentIds: readonly string[], originalMomentIds: readonly string[] = []) => {
      await barrier(); await options.beforeReceipt?.(); receiptBatches.push(momentIds.length);
      if (runStore) await runStore.undoRestoreReceipts(id, momentIds, originalMomentIds);
      else {const session = pendingEntries.get(id)?.session; if (session) {session.receipts = session.receipts.filter(file => !momentIds.includes(file.restoredMomentId)); session.intents = session.intents?.filter(id => !originalMomentIds.includes(id));}}
    },
    removePendingRestore: async (id: string) => {if (runStore) await runStore.removePendingRestore(id); else pendingEntries.delete(id);},
  } as unknown as CollectionAutomations);
  let automations = automationsFor();
  const recovery = registerStopAndRestoreIpc<string, { sender: string }, { workspaceId: string; rootPath: string }, {
    workspace: { workspaceId: string; rootPath: string };
    state: { collectionAutomations: CollectionAutomations };
    assertCurrent(): void;
  }, string>({
    currentAutomations: () => automations, canReleaseRuns: () => options.canRelease?.() ?? true,
    hasOtherWorkspaceWindow: () => options.otherWindow ?? false,
    registerHandler: (channel, handler) => handlers.set(channel, handler),
    assertTrustedSender: () => undefined,
    withRendererWorkspaceOperation: async (_sender, _workspaceId, _message, work) => await work({
      workspace: { workspaceId: WORKSPACE_ID, rootPath: options.rootPath ?? "/missing-root" },
      state: { collectionAutomations: automations },
      assertCurrent: () => undefined,
    }),
    remoteForWorkspace: async () => ({ credentials: "token", credentialGeneration: 1 }),
    currentCredentialGeneration: () => 1,
    relayJson: relayJson as <Result>(credentials: string, path: string, init?: RequestInit) => Promise<Result>,
    endLink,
    sharesChanged,
    requireEngineCapture: async () => ({ capture: options.engineCapture ?? capture }),
    localPerson: async () => account.person,
    stopLiveEditing: async (_operation, path, objectId) => await options.stopLiveEditing?.(path, objectId) ?? { keptEdits: "none" },
    queuePull,
    deletePath: async () => undefined,
    notifyRenderer: () => undefined,
    assertOriginalWorkspace: () => undefined,
    syncNow: async () => { await options.syncNow?.(); },
    serverRuns: {releaseRestore: async (_workspaceId, retentionId) => {
      releases.push(retentionId); await options.releaseWait?.();
      const error = options.releaseError?.(); if(error) throw error;
      return options.releaseAllowed?.() ?? true;
    }, restore: async (_workspaceId, definitions, again, retentionId) => {
      if (definitions.length === 0) {releases.push(retentionId); await options.releaseWait?.(); const error = options.releaseError?.(); if(error) throw error; return NOTHING;}
      return (await options.serverRestore?.(definitions, again, retentionId)) ?? NOTHING;
    } },
  });
  const call = (channel: string, payload: Record<string, unknown>) =>
    handlers.get(channel)!({ sender: "window" }, { workspaceId: WORKSPACE_ID, ...payload });
  return { call, calls, bodies, capture, queuePull, sharesChanged, account, releases, recovery, barrier, receiptBatches,
    reopen: (store: ReturnType<typeof createAutomationRunStore>) => {const old = automations; automations = automationsFor(store); return old;} };
}

async function capturedFiles(paths: string[], edits = ["shared edit"]) {
  const rootPath = await createTestScratch("dohc-stop-restore-policy-");
  const attachmentId = Symbol("stop-restore-policy");
  const loopback = new VersionedLoopbackEngine();
  const sessions = mockDaemonSessions({ rootPath, workspaceId: WORKSPACE_ID, loopback });
  const store = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath, attachmentId }, sessions).store;
  await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
  const files = [];
  for (const path of paths) {
    await mkdir(dirname(join(rootPath, path)), { recursive: true });
    await writeFile(join(rootPath, path), "owner original");
    const target = { workspaceId: WORKSPACE_ID, versionId: "main", path, metadata: { origin: "sync" as const } };
    await store.writeTextFile({ ...target, text: "owner original" });
    for (const text of edits) {
      const changed = await store.writeTextFile({ ...target, text, publish: true });
      files.push({ path, objectId: changed.moment.objectId, momentId: changed.moment.id, created: false });
    }
  }
  const engineCapture = createWorkspaceEngineCapture({ workspaceId: WORKSPACE_ID, rootPath, attachmentId, rustEngineSessions: sessions, store });
  const f = fixture({ engineCapture, rootPath, ledger: {
    "grant-edit": [{ writes: [{ committedAtMs: 2, files }], nextAfterOriginSeq: null }],
  } });
  const writePolicy = async (policy: string) => {
    await mkdir(join(rootPath, ".dohc"), { recursive: true });
    await writeFile(join(rootPath, ".dohc/files.toml"), policy);
  };
  return { ...f, rootPath, store, engineCapture, writePolicy, files, loopback };
}

describe("stop and restore in main", () => {
  async function pendingFileUndo(kind: "person" | "link" = "person") {
    const root = await createTestScratch("dohc-restore-undo-pass-");
    const store = createAutomationRunStore(preparedAutomationStoreFolder(root));
    const target = kind === "person" ? {kind, userId: "user_ana"} : {kind, grantId: "grant-link"};
    await store.savePendingRestore({id: "pending-pass", claims: ["held-run"], session: {
      grants: [kind === "person" ? "grant-edit" : "grant-link"], target, label: "Ana",
      definitions: [{collectionPath: "trip", id: "bump", definitionHash: "hash"}],
      filesUndone: false, receipts: [{path: SCHEMA, restoredMomentId: "back-schema"}],
      result: {status: "restored", restored: [{path: SCHEMA, restoredMomentId: "back-schema"}], review: [],
        runsUndone: 0, runsLeft: 1, runChangesKept: 0, fieldsMissing: 0, keptFields: [],
        wroteAutomations: true, sendsMessages: false, unfinished: {step: "files", message: "Interrupted"}},
    }});
    return {rootPath: root, store, target};
  }

  it.each(["retry"])("finishes a refused file Undo and releases the pending session on %s", async (action: string) => {
    const {store, target, rootPath} = await pendingFileUndo();
    const runs = vi.fn(async () => ({...NOTHING, undone: 1}));
    const f = fixture({rootPath, runStore: store, granted: [grant({revokedAtMs: 3})],
      restoreError: new RestoreHeadChangedError(SCHEMA), undoRunsOf: runs, releaseAllowed: () => false});
    await expect(f.call(CHANNELS.undoStopAndRestore, {target, restoredMomentIds: []})).resolves.toMatchObject({
      files: [{momentId: "back-schema", kind: "refused"}], errorMessage: null,
    });
    const saved = (await createAutomationRunStore(preparedAutomationStoreFolder(rootPath)).pendingRestores())[0]!.session!;
    expect(saved.filesUndone).toBe(true);
    expect(saved.undoingFiles).toBeUndefined();
    expect(saved.receipts).toEqual([{path: SCHEMA, restoredMomentId: "back-schema"}]);
    expect(saved.result).toMatchObject({review: [{path: SCHEMA, reason: "restore-refused"}]});
    if (action === "retry") {
      await expect(f.call(CHANNELS.stopAndRestore, {target})).resolves.toMatchObject({
        unfinished: null, runsUndone: 1, review: [{path: SCHEMA, reason: "restore-refused"}],
      });
      expect(runs).toHaveBeenCalled();
      expect(f.capture.restoreFileToBeforeMoment).toHaveBeenCalledTimes(1);
    } else await expect(f.call(stopAndRestoreRecoveryOperations.dismissStopAndRestore.channel, {target})).resolves.toBeUndefined();
    expect(await store.unfinishedUndos()).toEqual(new Set());
    await vi.waitFor(() => expect(f.releases).toContain("pending-pass"));
  });

  it.each(["person"] as const)("keeps a reactivated %s grant after a crash immediately after revocation", async (kind: "person" | "link") => {
    const {store, target, rootPath} = await pendingFileUndo(kind);
    const entry = (await store.pendingRestores())[0]!;
    entry.session!.undoingFiles = true;
    await store.savePendingRestore(entry);
    const grantId = entry.session!.grants[0]!;
    const rows = [grant({})];
    const links = [[{shareId: "share-link", grantId, status: "active", dependents: []}]];
    const f = fixture({rootPath, runStore: store, granted: rows, links,
      afterRevoke: async () => {throw Error("Crash after revocation");}});
    await expect(f.call(CHANNELS.stopAndRestore, {target})).rejects.toThrow("Crash after revocation");
    expect(kind === "person" ? rows[0]!.revokedAtMs : links[0]![0]!.status).toBe(kind === "person" ? 3 : "revoked");
    const reopened = createAutomationRunStore(preparedAutomationStoreFolder(rootPath));
    expect((await reopened.pendingRestores())[0]!.session!.nextGrants).toEqual([grantId]);
    const newMoment = {...schemaMoment, id: "reactivated-write", objectId: "reactivated-object", path: "notes/reactivated.txt"};
    const retry = fixture({rootPath, runStore: reopened, granted: rows, links, moment: newMoment,
      undoRunsOf: async () => NOTHING, ledger: {[grantId]: [{writes: [{committedAtMs: 4,
        files: [{path: newMoment.path, objectId: newMoment.objectId, momentId: newMoment.id, created: false}]}], nextAfterOriginSeq: null}]}});
    retry.capture.restoreFileToBeforeMoment.mockImplementationOnce(async () => ({restored: "text", path: SCHEMA, restoredMomentId: "undo-old"}))
      .mockImplementationOnce(async momentId => {
        expect(momentId).toBe(newMoment.id);
        return {restored: "text", path: newMoment.path, restoredMomentId: `back-${newMoment.id}`};
      });
    await expect(retry.call(CHANNELS.stopAndRestore, {target})).resolves.toMatchObject({unfinished: {step: "files"}});
    expect((await reopened.pendingRestores()).find(entry => entry.session)?.session!.restoreGrants).toEqual([grantId]);
    await expect(retry.call(CHANNELS.stopAndRestore, {target})).resolves.toMatchObject({unfinished: null,
      restored: [{path: newMoment.path, restoredMomentId: `back-${newMoment.id}`}]});
    expect(retry.calls.some(call => call.path.includes(`/collection-writes/${grantId}?`))).toBe(true);
  });

  it.each(["person"] as const)("does not revoke a reactivated %s grant when saving the follow-up intent fails", async (kind: "person" | "link") => {
    const {store, target, rootPath} = await pendingFileUndo(kind);
    const entry = (await store.pendingRestores())[0]!;
    entry.session!.undoingFiles = true;
    await store.savePendingRestore(entry);
    vi.spyOn(store, "savePendingRestore").mockRejectedValueOnce(Error("Save failed"));
    const f = fixture({rootPath, runStore: store, granted: [grant({})],
      links: [[{shareId: "share-link", grantId: "grant-link", status: "active", dependents: []}]]});
    await expect(f.call(CHANNELS.stopAndRestore, {target})).rejects.toThrow("dohc could not save Stop and restore progress.");
    expect(f.calls.filter(call => call.method === "POST" && call.path.endsWith("/revoke"))).toEqual([]);
  });

  it.each(["before receipts"])("retries unjournaled file batches after a crash %s", async boundary => {
    const root = await createTestScratch("dohc-restore-crash-batch-");
    const originals = Array.from({length: 3}, (_, i) => ({...schemaMoment, id: `m-${i}`, objectId: `o-${i}`, path: `notes/${i}.txt`}));
    const all = [...originals]; const writes = new Map<string, {path: string; restoredMomentId: string; restored: "text"}>();
    const capture = {
      readMoment: async (id: string) => ({moment: all.find(m => m.id === id)!}),
      listObjectMomentsAfter: async (objectId: string, id: string) => all.filter(m => m.objectId === objectId).slice(1).map(m => m.id).reverse(),
      restoreFileToBeforeMoment: async (id: string, _person: unknown, options: {requestId: string}) => {
        const prior = writes.get(options.requestId); if (prior) return prior;
        const original = all.find(m => m.id === id)!;
        const receipt = {path: original.path, restoredMomentId: `back-${id}`, restored: "text" as const};
        writes.set(options.requestId, receipt);
        all.push({...original, id: receipt.restoredMomentId, metadata: {origin: "restore", correlationId: options.requestId}});
        return receipt;
      },
      publicationApplied: async (id: string, key: string) => writes.get(key)?.restoredMomentId === id,
    } as unknown as WorkspaceEngineCapture;
    const granted = [grant({})];
    const ledger = {"grant-edit": [{writes: [{committedAtMs: 2, files: originals.map(m => ({path: m.path, objectId: m.objectId, momentId: m.id, created: false}))}], nextAfterOriginSeq: null}]};
    const options = {rootPath: root, granted, ledger, engineCapture: capture};
    const store = createAutomationRunStore(preparedAutomationStoreFolder(root));
    const first = fixture({...options, runStore: store, beforeReceipt: async () => {if (boundary === "before receipts") throw Error("crash");}});
    if (boundary === "before barrier") first.barrier.mockRejectedValueOnce(Error("crash"));
    const target = {kind: "person", userId: "user_ana"};
    expect(await first.call(CHANNELS.stopAndRestore, {target})).toMatchObject({restored: [], unfinished: {message: "crash"}});
    expect(writes.size).toBe(3); expect((await store.pendingRestores())[0]?.session?.receipts).toEqual([]);
    const restartedStore = createAutomationRunStore(preparedAutomationStoreFolder(root));
    const restarted = fixture({...options, runStore: restartedStore});
    const done = await restarted.call(CHANNELS.stopAndRestore, {target}) as {restored: unknown[]};
    expect(done).toMatchObject({review: [], unfinished: null}); expect(done.restored).toHaveLength(3);
    expect(writes.size).toBe(3); expect(restarted.receiptBatches).toEqual([3]);
    // Undo has the same stable key for a pending journal and a completed restore.
    const ids = originals.map(m => `back-${m.id}`);
    await restartedStore.savePendingRestore({id: "undo-session", claims: [], session: {target: {kind: "person", userId: "user_ana"},
      grants: [], label: "Ana", definitions: [], filesUndone: false, receipts: ids.map((id, i) => ({path: originals[i]!.path, restoredMomentId: id})), result: {status: "waiting"}}});
    const undoneFirst = fixture({...options, runStore: restartedStore, beforeReceipt: async () => {if (boundary === "before receipts") throw Error("crash");}});
    if (boundary === "before barrier") undoneFirst.barrier.mockRejectedValueOnce(Error("crash"));
    expect(await undoneFirst.call(CHANNELS.undoStopAndRestore, {target, restoredMomentIds: ids})).toMatchObject({files: [], errorMessage: "crash"});
    expect((await restartedStore.pendingRestores())[0]?.session?.receipts).toHaveLength(3); expect(writes.size).toBe(6);
    const undoneRetry = fixture({...options, runStore: createAutomationRunStore(preparedAutomationStoreFolder(root))});
    const undo = await undoneRetry.call(CHANNELS.undoStopAndRestore, {target, restoredMomentIds: ids}) as {files: unknown[]};
    expect(undo).toMatchObject({errorMessage: null}); expect(undo.files).toHaveLength(3);
    expect(undoneRetry.receiptBatches).toEqual([3]); expect(writes.size).toBe(6);
    expect((await restartedStore.pendingRestores())[0]?.session?.receipts).toEqual([]);
    const completed = fixture({...options, runStore: restartedStore});
    expect(await completed.call(CHANNELS.undoStopAndRestore, {restoredMomentIds: ids})).toMatchObject({errorMessage: null});
    expect(completed.barrier).toHaveBeenCalledOnce(); expect(writes.size).toBe(6);
  });

  it("acknowledges an in-flight release through the reopened attachment without losing a new restore", async () => {
    const root = await createTestScratch("dohc-release-reopen-");
    let current = true;
    const oldStore = createAutomationRunStore(preparedAutomationStoreFolder(root), () => {if (!current) throw Error("closed");});
    await oldStore.savePendingRestore({id: "R1", claims: [], serverRelease: true});
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {release = resolve;});
    const f = fixture({runStore: oldStore, releaseWait: () => blocked});
    await f.call(stopAndRestoreRecoveryOperations.pendingStopAndRestores.channel, {});
    await vi.waitFor(() => expect(f.releases).toEqual(["R1"]));
    current = false;
    const newStore = createAutomationRunStore(preparedAutomationStoreFolder(root));
    const old = f.reopen(newStore);
    const remove = vi.spyOn(old, "removePendingRestore");
    const next = {id: "R2", claims: ["B"], session: {grants: ["grant-B"],
      target: {kind: "person" as const, userId: "user_bob"}, label: "Bob", definitions: [],
      filesUndone: false, receipts: [], result: {status: "waiting"}}};
    await newStore.savePendingRestore(next);
    release();
    await vi.waitFor(async () => expect(await newStore.pendingRestores()).toEqual([next]));
    expect(remove).not.toHaveBeenCalled();
    expect(await createAutomationRunStore(preparedAutomationStoreFolder(root)).pendingRestores()).toEqual([next]);
  });

  it.each([false])("uses real retention through session saves with unrelated claims at the cap: %s", async atCap => {
    const root = await createTestScratch("dohc-restore-real-retention-");
    const store = createAutomationRunStore(preparedAutomationStoreFolder(root));
    if(atCap) await store.savePendingRestore({id: "other-restore", claims: Array.from({length: 10000}, (_, i) => `other-${i}`)});
    const files = automationsFile();
    const parsed = parseAutomationsFile(files.moment.payload.after.text);
    if(parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw Error("No definition");
    const definition = parsed.entries[0].automation;
    const automationId = collectionAutomationId("trip/packing", definition.id);
    const claims = ["newer", "older"].map((claimId, index) => ({claimId, automationId, createdAtMs: 2 - index, updatedAtMs: 2 - index}));
    for (const claim of claims) await store.save({...newRun(claim as Parameters<typeof newRun>[0], definition, "retention", claim.createdAtMs),
      settled: true, outcome: {state: "done"}, finishedAtMs: claim.createdAtMs});
    // Real retention selection and durable store; only engine/index reads are controlled.
    const executor = new CollectionAutomations({store} as ConstructorParameters<typeof CollectionAutomations>[0]);
    const reads = executor as unknown as {automationIdAt(): Promise<string>; indexAutomation(): Promise<void>; everyClaim(): Promise<typeof claims>};
    vi.spyOn(reads, "automationIdAt").mockResolvedValue(automationId);
    vi.spyOn(reads, "indexAutomation").mockResolvedValue(undefined);
    vi.spyOn(reads, "everyClaim").mockResolvedValue(claims);
    const undoRunsOf = vi.fn(async () => ({...NOTHING, errorMessage: "Resolve the conflict."}));
    const f = fixture({...files, rootPath: root, runStore: store, retainRunsForRestore: executor.retainRunsForRestore.bind(executor), undoRunsOf});
    const result = await f.call(CHANNELS.stopAndRestore, {target: {kind: "person", userId: "user_ana"}});
    if(atCap) {
      expect(result).toMatchObject({restored: [{restoredMomentId: "back-m-auto"}], unfinished: {step: "runs",
        message: "dohc can keep up to 10,000 runs for Undo. Finish or dismiss another unfinished Stop and restore."}});
      expect(undoRunsOf).not.toHaveBeenCalled();
      const message = "dohc can keep up to 10,000 runs for Undo. Finish or dismiss another unfinished Stop and restore.";
      const target = {kind: "person", userId: "user_ana"};
      const retry = fixture({rootPath: root, runStore: store, undoRunsOf: async () => ({...NOTHING, errorMessage: message}),
        granted: [grant({revokedAtMs: 3}), grant({grantId: "grant-view", shareId: "share-2", access: "view"}), grant({grantId: "grant-old", shareId: "share-3", revokedAtMs: 5})]});
      await retry.call(CHANNELS.undoStopAndRestore, {target, restoredMomentIds: ["back-m-auto"]});
      expect(await retry.call(CHANNELS.stopAndRestore, {target})).toMatchObject({unfinished: {step: "runs", message}});
      return;
    }
    const restarted = createAutomationRunStore(preparedAutomationStoreFolder(root));
    expect(await restarted.unfinishedUndos()).toEqual(new Set(["newer", "older"]));
    await restarted.expire(31 * 24 * 60 * 60 * 1000, async () => "gone", null);
    expect((await restarted.runsOf(automationId, "older")).runs).toHaveLength(1);
  });

  it.each(["complete"] as const)("releases locally offline on %s and retries server release after restart", async (action: string) => {
    const root = await createTestScratch("dohc-restore-offline-");
    const store = createAutomationRunStore(preparedAutomationStoreFolder(root));
    const target = {kind: "person" as const, userId: "user_ana"};
    if(action === "dismiss") await store.savePendingRestore({id: "restore-test", claims: ["older"], session: {grants: ["grant-edit"], target,
      label: "Ana", definitions: [], filesUndone: true, receipts: [], result: {status: "waiting"}}});
    const f = fixture({rootPath: root, runStore: store, releaseError: () => Error("Offline")});
    if(action === "dismiss") await expect(f.call(stopAndRestoreRecoveryOperations.dismissStopAndRestore.channel, {target})).resolves.toBeUndefined();
    else await expect(f.call(CHANNELS.stopAndRestore, {target})).resolves.toMatchObject({restored: [{path: SCHEMA}], unfinished: null});
    const restarted = createAutomationRunStore(preparedAutomationStoreFolder(root));
    expect(await restarted.unfinishedUndos()).toEqual(new Set());
    const recovery = fixture({rootPath: root, runStore: restarted});
    expect(await recovery.call(stopAndRestoreRecoveryOperations.pendingStopAndRestores.channel, {})).toEqual([]);
    await vi.waitFor(async () => expect(await restarted.pendingRestores()).toEqual([]));
    expect(recovery.releases).toHaveLength(1);
  });

  it("continues mixed-file Stop and Undo past a synced deletion refusal", async () => {
    const f = await capturedFiles(["docs/a.md", "notes/guarded.md", "docs/z.md"]);
    const restore = f.engineCapture.restoreFileToBeforeMoment.bind(f.engineCapture);
    const refusal = new SyncedDeletionRevivalError();
    let blocked = f.files[1]!.momentId;
    vi.spyOn(f.engineCapture, "restoreFileToBeforeMoment").mockImplementation(async (id, ...args) => {
      if (id === blocked) throw refusal;
      return restore(id, ...args);
    });
    try {
      const target = {kind: "person", userId: "user_ana"};
      const result = await f.call(CHANNELS.stopAndRestore, {target}) as {restored: {path: string; restoredMomentId: string}[]};
      expect(result).toMatchObject({restored: [{path: "docs/a.md"}, {path: "docs/z.md"}],
        review: [{path: "notes/guarded.md", reason: "restore-refused", detail: refusal.message, refusal: "synced-deletion"}], unfinished: null});
      blocked = result.restored[1]!.restoredMomentId;
      expect(await f.call(CHANNELS.undoStopAndRestore, {target, restoredMomentIds: result.restored.map(file => file.restoredMomentId)}))
        .toMatchObject({files: [{kind: "refused", momentId: blocked, detail: refusal.message, refusal: "synced-deletion"}, {kind: "restored"}], errorMessage: null});
      expect(await readFile(join(f.rootPath, "docs/a.md"), "utf8")).toBe("shared edit");
      expect(await readFile(join(f.rootPath, "docs/z.md"), "utf8")).toBe("owner original");
      expect(await readFile(join(f.rootPath, "notes/guarded.md"), "utf8")).toBe("shared edit");
    } finally { await f.engineCapture.stop(); }
  });

  it.each([CHANNELS.stopAndRestore])("reports unreadable policy for every file in %s", async channel => {
    // The files dohc can't read, never the TOML parser's text.
    const unreadable = [".dohc/files.toml"];
    const f = await capturedFiles(["notes/a.md", "docs/b.md"]);
    try {
      await f.writePolicy("[[rule] invalid");
      const result = await f.call(channel, channel === CHANNELS.stopAndRestore
        ? { target: { kind: "person", userId: "user_ana" } }
        : { restoredMomentIds: f.files.map(file => file.momentId) });
      expect(result).toMatchObject(channel === CHANNELS.stopAndRestore
        ? { restored: [], review: [{ path: "docs/b.md", reason: "rules-unreadable", unreadable }, { path: "notes/a.md", reason: "rules-unreadable", unreadable }], unfinished: null }
        : { files: [{ kind: "rules-unreadable", unreadable }, { kind: "rules-unreadable", unreadable }] });
      expect(await readFile(join(f.rootPath, "notes/a.md"), "utf8")).toBe("shared edit");
      expect(await readFile(join(f.rootPath, "docs/b.md"), "utf8")).toBe("shared edit");
    } finally { await f.engineCapture.stop(); }
  });

  it("revokes only the person's grants on this workspace that can write, then restores from every grant's ledger", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toEqual({
      status: "restored",
      restored: [{ path: SCHEMA, restoredMomentId: "back-m-schema" }],
      review: [],
      runsUndone: 0,
      runsLeft: 0,
      runChangesKept: 0,
      wroteAutomations: false,
      sendsMessages: false,
      keptFields: [], fieldsMissing: 0,
      unfinished: null,
    });
    expect(f.capture.restoreFileToBeforeMoment).toHaveBeenCalledWith("m-schema", OWNER, { expectedHeadMomentId: "m-schema", requestId: expect.any(String) });
    expect(f.calls.filter((call) => call.method === "POST").map((call) => call.path))
      .toEqual(["/sync/shares/share-1/grants/grant-edit/revoke"]);
    expect(f.sharesChanged).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(f.calls.filter((call) => call.path.includes("collection-writes")).map((call) => call.path)).toEqual([
      `/sync/${WORKSPACE_ID}/collection-writes/grant-edit?afterOriginSeq=-1`,
      `/sync/${WORKSPACE_ID}/collection-writes/grant-edit?afterOriginSeq=0`,
      `/sync/${WORKSPACE_ID}/collection-writes/grant-view?afterOriginSeq=-1`,
      `/sync/${WORKSPACE_ID}/collection-writes/grant-old?afterOriginSeq=-1`,
    ]);
  });

  // One field that runs here and on the owner's server wrote in turn. Each
  // computer keeps its own copy, and a sync carries a change through the
  // relay. Each run's Undo follows the executor's rule: a field goes back
  // only while it holds what the run wrote, and a kept field is tried again.
  function twoComputers(runs: { here: ReadonlyArray<readonly [number, number]>; server: ReadonlyArray<readonly [number, number]> }, value: number) {
    const relay = { value };
    const copies = { here: { value, changed: false }, server: { value, changed: false } };
    const push = (copy: { value: number; changed: boolean }) => {
      if (copy.changed) relay.value = copy.value;
      copy.changed = false;
    };
    type Run = { before: number; after: number; done: boolean; kept: boolean };
    const state = (list: ReadonlyArray<readonly [number, number]>): Run[] => list.map(([before, after]) => ({ before, after, done: false, kept: false })).reverse();
    const hosts = { here: state(runs.here), server: state(runs.server) };
    const pass = (host: "here" | "server", again: boolean): Pass => {
      const copy = copies[host];
      const result = { ...NOTHING };
      for (const run of hosts[host]) {
        if (again ? !run.kept : run.done && !run.kept) continue;
        if (!run.done) result.undone += 1;
        run.done = true;
        if (copy.value === run.after) {
          copy.value = run.before;
          copy.changed = true;
          run.kept = false;
          result.reverted += 1;
        } else {
          run.kept = true;
        }
      }
      // The runs write one field, so its hash is the same on both computers.
      return { ...result, keptFields: hosts[host].some((run) => run.kept) ? [{ ...KEPT, path: host === "server" ? "trip/Tasks/Old.md" : KEPT.path }] : [] };
    };
    return {
      relay, copies,
      undoRunsOf: vi.fn(async (_definitions: unknown, _trash: unknown, again?: boolean) => pass("here", again ?? false)),
      serverRestore: vi.fn(async (_definitions: unknown, again: boolean) => {
        copies.server.value = relay.value;
        const result = pass("server", again);
        push(copies.server);
        return result;
      }),
      syncNow: async () => {
        push(copies.here);
        copies.here.value = relay.value;
      },
    };
  }

  function automationsFile() {
    const file = "trip/packing/automations.yaml";
    const stamp = {
      id: "stamp", name: "Stamp", enabled: true, when: { kind: "record-added", table: null }, if: null,
      do: [{ kind: "set", values: [{ field: "Status", value: { kind: "literal", value: "New" } }], records: null, operation: null }],
    } as unknown as Automation;
    const written = writeAutomationsFile([{ status: "valid", automation: stamp }]);
    if (written.status !== "ok") throw new Error("The test's automation does not write.");
    return {
      moment: { ...schemaMoment, id: "m-auto", objectId: "o-auto", path: file, payload: { before: null, after: { path: file, text: written.text } } } satisfies VersionedTextMoment,
      ledger: { "grant-edit": [{ writes: [{ committedAtMs: 2, files: [{ path: file, objectId: "o-auto", momentId: "m-auto", created: true }] }], nextAfterOriginSeq: null }] },
    };
  }

  // Undoing runs goes server, sync, here, sync. A try that one of those
  // stops tells which step it did not finish; trying again continues from
  // where it stopped, counts each run once across the tries, and a third try
  // changes nothing.
  const STOPPED = "dohc stopped here.";

  it.each([
    ["the sync after the Undo here", 3],
  ] as const)("continues after %s stopped a try, and repeats safely", async (_stage, stage) => {
    for (const runs of [{ here: [[1, 2]], server: [[0, 1]] }] as const) {
      const computers = twoComputers(runs, 2);
      let failed = false;
      // Fails the first time the try reaches this stage, before it acts.
      const failAt = (at: number) => {
        if (at !== stage || failed) return false;
        failed = true;
        return true;
      };
      let syncs = 0;
      const f = fixture({
        ...automationsFile(),
        serverRestore: async (definitions, again) => failAt(0) ? { ...NOTHING, errorMessage: STOPPED } : await computers.serverRestore(definitions, again),
        undoRunsOf: async (definitions, trash, again) => failAt(2) ? { ...NOTHING, errorMessage: STOPPED } : await computers.undoRunsOf(definitions, trash, again),
        syncNow: async () => {
          syncs += 1;
          if (failAt(syncs % 2 === 1 ? 1 : 3)) throw new Error(STOPPED);
          await computers.syncNow();
        },
      });
      const stop = () => f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } }) as Promise<{ runsUndone: number }>;

      const first = await stop();
      expect(first).toMatchObject({ restored: [{ restoredMomentId: "back-m-auto" }], unfinished: { step: "runs", message: STOPPED } });
      const second = await stop();
      expect(second).toMatchObject({ restored: [], review: [], runsLeft: 0, keptFields: [], fieldsMissing: 0, unfinished: null });
      expect(first.runsUndone + second.runsUndone).toBe(2);
      expect([computers.relay.value, computers.copies.here.value, computers.copies.server.value]).toEqual([0, 0, 0]);

      await expect(stop()).resolves.toMatchObject({ restored: [], runsUndone: 0, runsLeft: 0, keptFields: [], unfinished: null });
      expect([computers.relay.value, computers.copies.here.value, computers.copies.server.value]).toEqual([0, 0, 0]);
      // The file went back once; later tries pass it over.
      expect(f.capture.restoreFileToBeforeMoment).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the fields a computer's runs kept when a later try stops before that computer's pass", async () => {
    // Someone set 9 after the runs, so both computers' runs keep the field.
    const computers = twoComputers({ here: [[0, 1]], server: [[1, 2]] }, 9);
    let syncs = 0;
    let serverFails = false;
    const f = fixture({
      ...automationsFile(),
      ...computers,
      serverRestore: async (definitions, again) => serverFails ? { ...NOTHING, errorMessage: STOPPED } : await computers.serverRestore(definitions, again),
      syncNow: async () => {
        syncs += 1;
        // The first try stops at the sync after the Undo here.
        if (syncs === 2) throw new Error(STOPPED);
        await computers.syncNow();
      },
    });
    const stop = () => f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } });
    await expect(stop()).resolves.toMatchObject({ runsUndone: 2, keptFields: [KEPT], unfinished: { step: "runs" } });
    // The next try stops before either computer's pass finishes, and still counts the field.
    serverFails = true;
    await expect(stop()).resolves.toMatchObject({ runsUndone: 0, keptFields: [KEPT], unfinished: { step: "runs" } });
    serverFails = false;
    await expect(stop()).resolves.toMatchObject({ runsUndone: 0, keptFields: [KEPT], unfinished: null });
    expect(computers.relay.value).toBe(9);
  });

  it("refuses a ledger path that leaves the workspace, and a person with no share here", async () => {
    const f = fixture({ ledger: { "grant-edit": [{ writes: [{ committedAtMs: 1, files: [{ path: "../outside", objectId: "o", momentId: "m", created: true }] }], nextAfterOriginSeq: null }] } });
    // Access already stopped, so the answer says what is still to finish.
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      restored: [], unfinished: { step: "files", message: "dohc could not read the relay's list of their changes." },
    });
    expect(f.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
    await expect(fixture().call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_nobody" } }))
      .rejects.toThrow("This person no longer has a share of this workspace.");
  });

  it("reviews a shared live file History refuses, and reports any other restore failure", async () => {
    const live = fixture({ restoreError: new LiveDocumentMutationError("dohc could not restore it. This action is unavailable for shared live files.") });
    await expect(live.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      review: [{ path: SCHEMA, reason: "restore-refused", detail: `${sharedLiveRestoreTitle(SCHEMA)}
${SHARED_LIVE_RESTORE_BODY}` }],
      unfinished: null,
    });
    const long = fixture({ restoreError: new LiveDocumentMutationError("dohc could not restore it. This action is unavailable for shared live files."),
      moment: { ...schemaMoment, path: LONG_PATH },
      ledger: { "grant-edit": [{ writes: [{ committedAtMs: 2, files: [{ path: LONG_PATH, objectId: "o-schema", momentId: "m-schema", created: false }] }], nextAfterOriginSeq: null }] } });
    await expect(long.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      review: [{ path: LONG_PATH, reason: "restore-refused", detail: sharedLiveRestoreDetail(LONG_PATH) }],
      unfinished: null,
    });
    const down = fixture({ restoreError: new Error("The workspace engine is not running.") });
    await expect(down.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      review: [],
      unfinished: { step: "files", message: "The workspace engine is not running." },
    });
  });

  it("stops live editing for a page they created, then removes it; a Stop that waits keeps it for review", async () => {
    const LIVE = "dohc can't restore it while it has live editing on";
    const ledger = { "grant-edit": [{ writes: [{ committedAtMs: 2, files: [{ path: SCHEMA, objectId: "o-schema", momentId: "m-schema", created: true }] }], nextAfterOriginSeq: null }] };
    const options: NonNullable<Parameters<typeof fixture>[0]> = { ledger, restoreError: new LivePageOwnedError(LIVE),
      stopLiveEditing: vi.fn(async () => { delete options.restoreError; return { keptEdits: "none" as const }; }) };
    await expect(fixture(options).call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } }))
      .resolves.toMatchObject({ restored: [{ path: SCHEMA, removed: true }], review: [], unfinished: null });
    expect(options.stopLiveEditing).toHaveBeenCalledWith(SCHEMA, "o-schema");
    const waiting = fixture({ ledger, restoreError: new LivePageOwnedError(LIVE),
      stopLiveEditing: async () => { throw liveStopWaitingError(new Error("timed out")); } });
    await expect(waiting.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      restored: [], review: [{ path: SCHEMA, reason: "restore-refused", detail: expect.stringContaining("dohc is waiting for the server to stop live editing") }],
      unfinished: null,
    });
  });

  const link = (overrides: Record<string, unknown> = {}) => ({
    shareId: "share-link", grantId: "grant-link", status: "active", access: "edit", selector: { paths: ["trip"], versionId: null },
    dependents: [{ grantId: "grant-dep" }], ...overrides,
  });
  const linkLedger = {
    "grant-link": [{ writes: [{ committedAtMs: 2, files: [{ path: SCHEMA, objectId: "o-schema", momentId: "m-schema", created: false }] }], nextAfterOriginSeq: null }],
  };
  const byLink = { target: { kind: "link", grantId: "grant-link" } };

  it("ends a whole link, with its dependents, then restores every write in its ledger", async () => {
    const f = fixture({ links: [[link({ grantId: "grant-other" })], [link()]], ledger: linkLedger });
    await expect(f.call(CHANNELS.stopAndRestore, byLink)).resolves.toMatchObject({
      status: "restored",
      restored: [{ path: SCHEMA, restoredMomentId: "back-m-schema" }],
    });
    expect(f.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/sync/shares/share-link/revoke"]);
    expect(f.bodies).toEqual([{ grantId: "grant-link", workspaceId: WORKSPACE_ID, expectedDependentGrantIds: ["grant-dep"] }]);
    expect(f.sharesChanged).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(f.calls.filter((call) => call.path.includes("collection-writes")).map((call) => call.path))
      .toEqual([`/sync/${WORKSPACE_ID}/collection-writes/grant-link?afterOriginSeq=-1`]);
  });

  it("stops at once, restoring nothing, when ending the link fails for another reason", async () => {
    const f = fixture({ links: [[link()]], ledger: linkLedger, revokeError: new Error("dohc could not reach your server.") });
    await expect(f.call(CHANNELS.stopAndRestore, byLink)).rejects.toThrow("dohc could not reach your server.");
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(f.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
    expect(f.sharesChanged).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("names the person signed in here when the request arrived, never one the renderer sends", async () => {
    const f = fixture();
    const mallory = { kind: "human", humanId: "user_mallory" };
    for (const [channel, payload] of [
      [CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" }, person: mallory }],
      [CHANNELS.undoStopAndRestore, { restoredMomentIds: ["back-1"], author: mallory }],
    ] as const) {
      await expect(f.call(channel, payload)).rejects.toThrow();
    }
    expect(f.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();

    // Another account settles while the restore waits on the relay: the restore stays the first person's.
    const restored = f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } });
    f.account.person = { kind: "human", humanId: "user_other" };
    await restored;
    expect(f.capture.restoreFileToBeforeMoment).toHaveBeenCalledWith("m-schema", OWNER, { expectedHeadMomentId: "m-schema", requestId: expect.any(String) });
  });
});

describe("renderer-held restore guards", () => {
  it.each(["retained"])("reviews files protected by %s state", async source => {
    const f = fixture({otherWindow: source === "other-window"});
    const result = await f.call(CHANNELS.stopAndRestore, {target: {kind: "person", userId: "user_ana"}, reviewPaths: source === "retained" ? [SCHEMA] : []});
    expect(result).toMatchObject({status: "restored", restored: [], review: [{path: SCHEMA, reason: "restore-refused"}], unfinished: null});
    expect(f.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
  });

});
