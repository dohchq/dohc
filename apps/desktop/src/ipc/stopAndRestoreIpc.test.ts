import { SyncedDeletionRevivalError } from "../workspaces/syncedDeletionRefusal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { mockDaemonSessions } from "../testing/liveEngineSessions";
import { createTestScratch } from "../workspaces/testTemp";
import { createCaptureLiveStores } from "../workspaces/workspaceEngineCaptureLiveStore";
import { createWorkspaceEngineCapture, type WorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import { createServerRuns } from "../automations/serverRuns";
import type { VersionedTextMoment } from "@dohc/workspace-contracts/engine";
import { parseAutomationsFile, writeAutomationsFile, type Automation } from "@dohc/workspace-contracts/automations";
import { collectionAutomationId, definitionHash } from "@dohc/automation-executor/automation-plan";
import { CollectionAutomations, type KeptAutomationField } from "@dohc/automation-executor/collection-automations";
import { CHANNELS } from "./channels";
import { registerStopAndRestoreIpc } from "./stopAndRestoreIpc";
import { KeptAutomationFieldShape, stopAndRestoreRecoveryOperations } from "./bridgeContract";
import { newRun } from "@dohc/automation-executor/collection-automation-run";
import { AutomationStoreNotOpenedError, createAutomationRunStore, type PendingRestore } from "@dohc/automation-executor/automation-run-store";
import { preparedAutomationStoreFolder, readersTrustLocalState } from "../testing/preparedLocalState";
import {
  LiveDocumentMutationError,
  RestoreHeadChangedError,
  RestoreLocalChangesError,
  type WorkspaceEngineMomentDetail,
} from "../workspaces/workspaceEngineCapture";
import type { LocalPersonAuthor } from "../workspaces/desktopRecordEdits";
import {restoreRequestId, restoreReceiptOf} from "../workspaces/restoreWriteIdentity";

// The run store reads `.dohc/local` as the engine's open leaves it.
beforeEach(() => readersTrustLocalState());

const KEPT = { id: "f".repeat(32), path: "trip/Tasks/Untitled.md", field: "Finished on", recordId: null };
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
type Pass = { undone: number; left: number; reverted: number; missing: number; keptFields: KeptAutomationField[]; otherKept: number; errorMessage: string | null };
const NOTHING: Pass = { undone: 0, left: 0, reverted: 0, missing: 0, keptFields: [], otherKept: 0, errorMessage: null };
const SCHEMA = "trip/packing/collection.yaml";
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

async function capturedFiles(paths: string[]) {
  const rootPath = await createTestScratch("dohc-stop-restore-policy-");
  const attachmentId = Symbol("stop-restore-policy");
  const sessions = mockDaemonSessions({ rootPath, workspaceId: WORKSPACE_ID, loopback: new VersionedLoopbackEngine() });
  const store = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath, attachmentId }, sessions).store;
  await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
  const files = [];
  for (const path of paths) {
    await mkdir(dirname(join(rootPath, path)), { recursive: true });
    await writeFile(join(rootPath, path), "owner original");
    const target = { workspaceId: WORKSPACE_ID, versionId: "main", path, metadata: { origin: "sync" as const } };
    await store.writeTextFile({ ...target, text: "owner original" });
    const changed = await store.writeTextFile({ ...target, text: "shared edit", publish: true });
    files.push({ path, objectId: changed.moment.objectId, momentId: changed.moment.id, created: false });
  }
  const engineCapture = createWorkspaceEngineCapture({ workspaceId: WORKSPACE_ID, rootPath, attachmentId, rustEngineSessions: sessions, store });
  const f = fixture({ engineCapture, rootPath, ledger: {
    "grant-edit": [{ writes: [{ committedAtMs: 2, files }], nextAfterOriginSeq: null }],
  } });
  const writePolicy = async (policy: string) => {
    await mkdir(join(rootPath, ".dohc"), { recursive: true });
    await writeFile(join(rootPath, ".dohc/files.toml"), policy);
  };
  return { ...f, rootPath, store, engineCapture, writePolicy, files };
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

  it.each(["retry", "dismiss"])("finishes a refused file Undo and releases the pending session on %s", async action => {
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

  it.each(["receipts", "intents"])("dismisses an interrupted file Undo with unresolved %s", async remaining => {
    const {store, target, rootPath} = await pendingFileUndo();
    const entry = (await store.pendingRestores())[0]!;
    entry.session!.undoingFiles = true;
    if (remaining === "intents") {entry.session!.receipts = []; entry.session!.intents = ["original-schema"];}
    await store.savePendingRestore(entry);
    const f = fixture({rootPath, runStore: store, releaseAllowed: () => false});
    await expect(f.call(stopAndRestoreRecoveryOperations.dismissStopAndRestore.channel, {target})).resolves.toBeUndefined();
    expect(await store.unfinishedUndos()).toEqual(new Set());
    const released = (await store.pendingRestores())[0]!;
    expect(released.session).toBeUndefined();
    expect(released.serverRelease).toBe(true);
    await vi.waitFor(() => expect(f.releases).toContain("pending-pass"));
  });

  it.each(["missing person", "deleted link"])("resumes an interrupted file Undo after checking the %s", async changed => {
    const {store, target, rootPath} = await pendingFileUndo(changed === "deleted link" ? "link" : "person");
    const first = fixture({rootPath, runStore: store, restoreError: Error("Interrupted Undo")});
    await expect(first.call(CHANNELS.undoStopAndRestore, {target, restoredMomentIds: []})).resolves.toMatchObject({errorMessage: "Interrupted Undo"});
    expect((await createAutomationRunStore(preparedAutomationStoreFolder(rootPath)).pendingRestores())[0]!.session).toMatchObject({undoingFiles: true, filesUndone: false});
    const runs = vi.fn(async () => NOTHING);
    const retry = fixture({rootPath, runStore: createAutomationRunStore(preparedAutomationStoreFolder(rootPath)), undoRunsOf: runs,
      granted: [], links: [[]]});
    await expect(retry.call(CHANNELS.stopAndRestore, {target})).resolves.toMatchObject({unfinished: null, restored: []});
    expect(retry.capture.restoreFileToBeforeMoment).toHaveBeenCalledWith("back-schema", OWNER, expect.anything());
    expect(runs).toHaveBeenCalled();
    expect(retry.calls.some(call => call.path.includes("shares"))).toBe(true);
    await vi.waitFor(async () => expect(await store.pendingRestores()).toEqual([]));
    expect(retry.releases).toContain("pending-pass");
  });

  it.each(["person", "link"] as const)("revokes current %s access before resuming Undo and queues a new restore", async kind => {
    const {store, target, rootPath} = await pendingFileUndo(kind);
    const entry = (await store.pendingRestores())[0]!;
    entry.session!.undoingFiles = true;
    await store.savePendingRestore(entry);
    const newMoment = {...schemaMoment, id: "new-write", objectId: "new-object", path: "notes/new.txt"};
    const newGrant = kind === "person" ? "new-grant" : "grant-link";
    const rows = [grant({revokedAtMs: 3}), grant({grantId: "new-grant", shareId: "new-share"})];
    const f = fixture({rootPath, runStore: store, undoRunsOf: async () => NOTHING, moment: newMoment,
      granted: rows, links: [[{shareId: "new-link", grantId: "grant-link", status: "active", dependents: []}]],
      ledger: {"grant-edit": [{writes: [], nextAfterOriginSeq: null}], [newGrant]: [{writes: [{committedAtMs: 4,
        files: [{path: newMoment.path, objectId: newMoment.objectId, momentId: newMoment.id, created: false}]}], nextAfterOriginSeq: null}]}});
    f.capture.restoreFileToBeforeMoment.mockImplementationOnce(async () => {
      expect(f.calls.some(call => call.method === "POST" && call.path.endsWith("/revoke"))).toBe(true);
      return {restored: "text", path: SCHEMA, restoredMomentId: "undo-old"};
    }).mockImplementationOnce(async momentId => {
      expect(momentId).toBe(newMoment.id);
      return {restored: "text", path: newMoment.path, restoredMomentId: "back-new-write"};
    });
    await expect(f.call(CHANNELS.stopAndRestore, {target})).resolves.toMatchObject({
      restored: [], unfinished: {step: "files"},
    });
    expect(f.calls.filter(call => call.method === "POST").map(call => call.path)).toEqual([
      kind === "person" ? "/sync/shares/new-share/grants/new-grant/revoke" : "/sync/shares/new-link/revoke",
    ]);
    const pending = (await createAutomationRunStore(preparedAutomationStoreFolder(rootPath)).pendingRestores()).find(entry => entry.session)!;
    expect(pending.id).not.toBe("pending-pass");
    expect(pending.session).toMatchObject({filesUndone: false, receipts: []});
    expect(pending.session!.grants).toContain(newGrant);
    expect(pending.session!.restoreGrants).toEqual([newGrant]);
    if (kind === "person") rows.splice(0, 1);
    await expect(f.call(CHANNELS.stopAndRestore, {target})).resolves.toMatchObject({
      restored: [{path: newMoment.path, restoredMomentId: "back-new-write"}], unfinished: null,
    });
    expect(f.calls.some(call => call.path.includes(`/collection-writes/${newGrant}?`))).toBe(true);
    if (kind === "person") expect(f.calls.some(call => call.path.includes("/collection-writes/grant-edit?"))).toBe(false);
    await vi.waitFor(async () => expect(await store.pendingRestores()).toEqual([]));
    expect(f.releases).toContain("pending-pass");
    expect(f.releases).toContain(pending.id);
  });

  it("keeps a waiting session's refused file in review on the next Stop", async () => {
    const {store, target, rootPath} = await pendingFileUndo();
    const f = fixture({rootPath, runStore: store, granted: [grant({revokedAtMs: 3})],
      restoreError: new RestoreHeadChangedError(SCHEMA), undoRunsOf: async () => NOTHING});
    f.capture.readMoment.mockResolvedValueOnce(null);
    await expect(f.call(CHANNELS.stopAndRestore, {target})).resolves.toEqual({status: "waiting"});
    expect((await store.pendingRestores())[0]!.session!.receipts).toHaveLength(1);
    await expect(f.call(CHANNELS.undoStopAndRestore, {target, restoredMomentIds: []})).resolves.toMatchObject({
      files: [{kind: "refused"}], errorMessage: null,
    });
    expect((await createAutomationRunStore(preparedAutomationStoreFolder(rootPath)).pendingRestores())[0]!.session!.result).toMatchObject({
      status: "restored", review: [{path: SCHEMA, reason: "restore-refused"}],
    });
    await expect(f.call(CHANNELS.stopAndRestore, {target})).resolves.toMatchObject({
      review: [{path: SCHEMA, reason: "restore-refused"}], unfinished: null,
    });
    await vi.waitFor(async () => expect(await store.pendingRestores()).toEqual([]));
  });

  it("carries old Undo refusals through a waiting follow-up restore", async () => {
    const {store, target, rootPath} = await pendingFileUndo();
    const entry = (await store.pendingRestores())[0]!;
    entry.session!.undoingFiles = true;
    await store.savePendingRestore(entry);
    const moment = {...schemaMoment, id: "new-write", objectId: "new-object", path: "notes/new.txt"};
    const f = fixture({rootPath, runStore: store, undoRunsOf: async () => NOTHING, moment,
      granted: [grant({revokedAtMs: 3}), grant({grantId: "new-grant", shareId: "new-share"})],
      ledger: {"new-grant": [{writes: [{committedAtMs: 4, files: [{path: moment.path, objectId: moment.objectId,
        momentId: moment.id, created: false}]}], nextAfterOriginSeq: null}]}});
    f.capture.restoreFileToBeforeMoment.mockRejectedValueOnce(new RestoreHeadChangedError(SCHEMA))
      .mockResolvedValueOnce({restored: "text", path: moment.path, restoredMomentId: "back-new-write"});
    await expect(f.call(CHANNELS.stopAndRestore, {target})).resolves.toMatchObject({
      review: [{path: SCHEMA, reason: "restore-refused"}], unfinished: {step: "files"},
    });
    f.capture.readMoment.mockResolvedValueOnce(null);
    await expect(f.call(CHANNELS.stopAndRestore, {target})).resolves.toEqual({status: "waiting"});
    expect((await store.pendingRestores()).find(entry => entry.session)?.session!.result).toMatchObject({
      review: [{path: SCHEMA, reason: "restore-refused"}],
    });
    await expect(f.call(CHANNELS.stopAndRestore, {target})).resolves.toMatchObject({
      restored: [{path: moment.path}], review: [{path: SCHEMA, reason: "restore-refused"}], unfinished: null,
    });
    expect(f.calls.some(call => call.path.includes("/collection-writes/grant-edit?"))).toBe(false);
    await vi.waitFor(async () => expect(await store.pendingRestores()).toEqual([]));
  });

  it.each(["Undo", "runs", "handoff"])("keeps the follow-up Stop after an interrupted %s", async boundary => {
    const {store, target, rootPath} = await pendingFileUndo();
    const entry = (await store.pendingRestores())[0]!;
    entry.session!.undoingFiles = true;
    await store.savePendingRestore(entry);
    const rows = [grant({revokedAtMs: 3}), grant({grantId: "new-grant", shareId: "new-share"})];
    const f = fixture({rootPath, runStore: store, granted: rows, undoRunsOf: async () => NOTHING});
    if (boundary === "Undo") f.barrier.mockRejectedValueOnce(Error("Interrupted Undo"));
    if (boundary === "runs") {
      const failing = fixture({rootPath, runStore: store, granted: rows, undoRunsOf: async () => {throw Error("Interrupted runs");}});
      await expect(failing.call(CHANNELS.stopAndRestore, {target})).resolves.toMatchObject({unfinished: {step: "runs"}});
    } else {
      if (boundary === "handoff") {
        const save = store.savePendingRestore;
        let interrupted = false;
        vi.spyOn(store, "savePendingRestore").mockImplementation(async update => {
          if (update.id === "pending-pass" && update.serverRelease && !interrupted) {
            interrupted = true; throw Error("Interrupted handoff");
          }
          await save(update);
        });
      }
      if (boundary === "handoff") await expect(f.call(CHANNELS.stopAndRestore, {target})).rejects.toThrow("Interrupted handoff");
      else await expect(f.call(CHANNELS.stopAndRestore, {target})).resolves.toMatchObject({unfinished: {message: `Interrupted ${boundary}`}});
    }
    expect(rows[1]).toMatchObject({revokedAtMs: 3});
    const restartedStore = createAutomationRunStore(preparedAutomationStoreFolder(rootPath));
    const saved = (await restartedStore.pendingRestores()).find(entry => entry.id === "pending-pass")!;
    expect(saved.session).toMatchObject({nextGrants: ["new-grant"]});
    if (boundary === "handoff") {
      expect((await restartedStore.pendingRestores()).find(entry => entry.id === "pending-pass:next")?.session).toBeDefined();
      rows.push(grant({grantId: "third-grant", shareId: "third-share"}));
    }
    const retry = fixture({rootPath, runStore: restartedStore, granted: rows, undoRunsOf: async () => NOTHING,
      ledger: {"grant-edit": [{writes: [], nextAfterOriginSeq: null}], "new-grant": [{writes: [], nextAfterOriginSeq: null}]}});
    await expect(retry.call(CHANNELS.stopAndRestore, {target})).resolves.toMatchObject({unfinished: {step: "files"}});
    const next = (await restartedStore.pendingRestores()).find(entry => entry.session)!;
    expect(next.id).toBe("pending-pass:next");
    expect(next.session!.grants).toEqual(boundary === "handoff" ? ["grant-edit", "new-grant", "third-grant"] : ["grant-edit", "new-grant"]);
    expect(next.session!.restoreGrants).toEqual(boundary === "handoff" ? ["new-grant", "third-grant"] : ["new-grant"]);
    await expect(retry.call(CHANNELS.stopAndRestore, {target})).resolves.toMatchObject({unfinished: null});
    expect(retry.calls.some(call => call.path.includes("/collection-writes/new-grant?"))).toBe(true);
    if (boundary === "handoff") expect(retry.calls.some(call => call.path.includes("/collection-writes/third-grant?"))).toBe(true);
    await vi.waitFor(async () => expect(await restartedStore.pendingRestores()).toEqual([]));
  });

  it.each(["person", "link"] as const)("keeps a reactivated %s grant after a crash immediately after revocation", async kind => {
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

  it.each(["person", "link"] as const)("recovers a reused %s grant when the first progress read fails", async kind => {
    const {store, target, rootPath} = await pendingFileUndo(kind);
    const entry = (await store.pendingRestores())[0]!;
    entry.session!.undoingFiles = true;
    await store.savePendingRestore(entry);
    vi.spyOn(store, "pendingRestores").mockRejectedValueOnce(Error("Transient read failure"));
    const grantId = entry.session!.grants[0]!;
    const rows = [grant({})];
    const links = [[{shareId: "share-link", grantId, status: "active", dependents: []}]];
    const newMoment = {...schemaMoment, id: "later-write", objectId: "later-object", path: "notes/later.txt"};
    const f = fixture({rootPath, runStore: store, granted: rows, links, moment: newMoment,
      undoRunsOf: async () => NOTHING, ledger: {[grantId]: [{writes: [{committedAtMs: 4,
        files: [{path: newMoment.path, objectId: newMoment.objectId, momentId: newMoment.id, created: false}]}], nextAfterOriginSeq: null}]}});
    f.capture.restoreFileToBeforeMoment.mockImplementationOnce(async () => {
      expect(kind === "person" ? rows[0]!.revokedAtMs : links[0]![0]!.status).toBe(kind === "person" ? 3 : "revoked");
      const reopened = createAutomationRunStore(preparedAutomationStoreFolder(rootPath));
      expect((await reopened.pendingRestores())[0]!.session!.nextGrants).toEqual([grantId]);
      return {restored: "text", path: SCHEMA, restoredMomentId: "undo-old"};
    }).mockImplementationOnce(async momentId => {
      expect(momentId).toBe(newMoment.id);
      return {restored: "text", path: newMoment.path, restoredMomentId: `back-${newMoment.id}`};
    });
    await expect(f.call(CHANNELS.stopAndRestore, {target})).resolves.toMatchObject({unfinished: {step: "files"}});
    expect((await store.pendingRestores()).find(entry => entry.session)?.session!.restoreGrants).toEqual([grantId]);
    await expect(f.call(CHANNELS.stopAndRestore, {target})).resolves.toMatchObject({unfinished: null,
      restored: [{path: newMoment.path, restoredMomentId: `back-${newMoment.id}`}]});
    expect(f.capture.restoreFileToBeforeMoment).toHaveBeenCalledTimes(2);
    expect(f.calls.some(call => call.path.includes(`/collection-writes/${grantId}?`))).toBe(true);
  });

  it.each(["person", "link"] as const)("does not revoke a reactivated %s grant when saving the follow-up intent fails", async kind => {
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

  it("does not offer Try again when the owner dismisses during run Undo", async () => {
    const {store, target, rootPath} = await pendingFileUndo();
    const entry = (await store.pendingRestores())[0]!;
    entry.session!.undoingFiles = true;
    await store.savePendingRestore(entry);
    const rows = [grant({revokedAtMs: 3}), grant({grantId: "new-grant", shareId: "new-share"})];
    let reached!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => {reached = resolve;});
    const blocked = new Promise<void>(resolve => {resume = resolve;});
    const f = fixture({rootPath, runStore: store, granted: rows, undoRunsOf: async () => NOTHING,
      serverRestore: async () => {reached(); await blocked; return NOTHING;}});
    const trying = Promise.resolve(f.call(CHANNELS.stopAndRestore, {target}));
    try {
      await entered;
      expect(rows[1]).toMatchObject({revokedAtMs: 3});
      await f.call(stopAndRestoreRecoveryOperations.dismissStopAndRestore.channel, {target});
    } finally {resume();}
    await expect(trying).resolves.toMatchObject({status: "restored", unfinished: null});
    await vi.waitFor(async () => expect(await store.pendingRestores()).toEqual([]));
    expect(f.releases).toContain("pending-pass");
  });

  it.each(["first batch", "mid-batch", "before barrier", "before receipts", "retry", "mid-Undo"])("keeps every file reversible after an unjournaled batch: %s", async boundary => {
    const root = await createTestScratch("dohc-restore-intents-");
    const originals = Array.from({length: 150}, (_, i) => ({...schemaMoment, id: `intent-${i}`, objectId: `object-${i}`, path: `notes/${i}.txt`}));
    const all = [...originals], writes = new Map<string, {path: string; restoredMomentId: string; restored: "text"}>();
    let undoCrash = false;
    const capture = {
      readMoment: async (id: string) => ({moment: all.find(m => m.id === id)!}),
      listObjectMomentsAfter: async (objectId: string) => all.filter(m => m.objectId === objectId).slice(1).map(m => m.id).reverse(),
      findRestoreReceipt: async (id: string, key: string) => {
        const original = all.find(m => m.id === id)!;
        for (const saved of all) {const receipt = restoreReceiptOf(saved, original, key); if (receipt) return {...receipt, restored: "text"};}
        return null;
      },
      publicationApplied: async () => true,
      restoreFileToBeforeMoment: async (id: string, _person: unknown, options: {requestId: string}) => {
        const prior = writes.get(options.requestId); if (prior) return prior;
        if (undoCrash && id.startsWith("back-") && writes.size === 170) throw Error("crash");
        if (boundary === "mid-batch" && !id.startsWith("back-") && writes.size === 125) throw Error("crash");
        const original = all.find(m => m.id === id)!;
        const receipt = {path: original.path, restoredMomentId: `back-${id}`, restored: "text" as const};
        writes.set(options.requestId, receipt);
        all.push({...original, id: receipt.restoredMomentId, metadata: {origin: "restore", correlationId: options.requestId}});
        return receipt;
      },
    } as unknown as WorkspaceEngineCapture;
    const options = {rootPath: root, granted: [grant({})], engineCapture: capture, undoRunsOf: async () => NOTHING,
      ledger: {"grant-edit": [{writes: [{committedAtMs: 2, files: originals.map(m => ({path: m.path, objectId: m.objectId, momentId: m.id, created: false}))}], nextAfterOriginSeq: null}]}};
    const store = createAutomationRunStore(preparedAutomationStoreFolder(root));
    let appends = 0;
    const first = fixture({...options, runStore: store, beforeReceipt: async () => {if ((boundary === "before receipts" || boundary === "retry" || boundary === "mid-Undo") && ++appends === 2) throw Error("crash");}});
    if (boundary === "before barrier" || boundary === "mid-batch") first.barrier.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error("crash"));
    if (boundary === "first batch") first.barrier.mockRejectedValueOnce(Error("crash"));
    const target = {kind: "person", userId: "user_ana"};
    const failed = await first.call(CHANNELS.stopAndRestore, {target}) as {restored: {restoredMomentId: string}[]};
    expect(failed).toMatchObject({unfinished: {message: "crash"}}); expect(failed.restored).toHaveLength(boundary === "first batch" ? 0 : 100);
    const committed = boundary === "first batch" ? 100 : boundary === "mid-batch" ? 125 : 150;
    expect(writes.size).toBe(committed);
    const restartedStore = createAutomationRunStore(preparedAutomationStoreFolder(root)), restarted = fixture({...options, runStore: restartedStore});
    let ids = failed.restored.map(r => r.restoredMomentId);
    if (boundary === "mid-Undo") {
      undoCrash = true;
      restarted.barrier.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error("crash"));
      expect(await restarted.call(CHANNELS.undoStopAndRestore, {target, restoredMomentIds: ids})).toMatchObject({errorMessage: "crash"});
      expect(writes.size).toBe(170);
      const interrupted = (await createAutomationRunStore(preparedAutomationStoreFolder(root)).pendingRestores())[0]!.session!;
      expect(interrupted).toMatchObject({filesUndone: false, undoingFiles: true, intents: []});
      expect(interrupted.receipts).toHaveLength(150);
      undoCrash = false;
      const retry = fixture({...options, runStore: createAutomationRunStore(preparedAutomationStoreFolder(root))});
      expect(await retry.call(CHANNELS.stopAndRestore, {target})).toMatchObject({unfinished: null});
      expect(writes.size).toBe(300);
      expect((await createAutomationRunStore(preparedAutomationStoreFolder(root)).pendingRestores()).every(entry => !entry.session)).toBe(true);
      return;
    }
    if (boundary === "retry") {
      const retried = await restarted.call(CHANNELS.stopAndRestore, {target}) as {restored: {restoredMomentId: string}[]};
      expect(retried).toMatchObject({unfinished: null, review: []}); expect(retried.restored).toHaveLength(50);
      ids = [...ids, ...retried.restored.map(r => r.restoredMomentId)]; expect(new Set(ids).size).toBe(150);
    }
    const undone = await restarted.call(CHANNELS.undoStopAndRestore, {target, restoredMomentIds: boundary === "retry" ? [...ids, ...ids] : ids}) as {files: unknown[]};
    expect(undone).toMatchObject({errorMessage: null}); expect(undone.files).toHaveLength(committed); expect(writes.size).toBe(committed * 2);
    const pending = (await restartedStore.pendingRestores())[0]?.session;
    if (boundary !== "retry") {expect(pending?.receipts).toEqual([]); expect(pending?.intents).toEqual([]);}
  });

  it("keeps file restore available after an empty Undo of a failed ledger read", async () => {
    let unreadable = true;
    const f = fixture({ledgerError: () => unreadable ? Error("Cannot read changes") : null});
    const target = {kind: "person", userId: "user_ana"};
    expect(await f.call(CHANNELS.stopAndRestore, {target})).toMatchObject({restored: [], unfinished: {step: "files"}});
    expect(await f.call(CHANNELS.undoStopAndRestore, {target, restoredMomentIds: []})).toMatchObject({files: [], errorMessage: null});
    const pending = await f.call(stopAndRestoreRecoveryOperations.pendingStopAndRestores.channel, {}) as {filesUndone: boolean}[];
    expect(pending[0]?.filesUndone).toBe(false);
    unreadable = false;
    expect(await f.call(CHANNELS.stopAndRestore, {target})).toMatchObject({restored: [{restoredMomentId: "back-m-schema"}], unfinished: null});
  });

  it.each(["before barrier", "before receipts"])("retries unjournaled file batches after a crash %s", async boundary => {
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

  it("batches 201 completed-restore reversals behind three barriers", async () => {
    const f = fixture();
    const result = await f.call(CHANNELS.undoStopAndRestore, {restoredMomentIds: Array.from({length: 201}, (_, i) => `m-${i}`)}) as {files: unknown[]};
    expect(result.files).toHaveLength(201); expect(f.barrier).toHaveBeenCalledTimes(3);
  });
  it("keeps an unflushed restore out of the result and the failure snapshot", async () => {
    const root = await createTestScratch("dohc-restore-barrier-");
    const store = createAutomationRunStore(preparedAutomationStoreFolder(root));
    const f = fixture({runStore: store, receiptError: Error("WAL sync failed")});
    expect(await f.call(CHANNELS.stopAndRestore, {target: {kind: "person", userId: "user_ana"}}))
      .toMatchObject({restored: [], unfinished: {step: "files", message: "WAL sync failed"}});
    expect((await store.pendingRestores())[0]?.session?.receipts).toEqual([]);
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
  it("stops server restore passes and releases a retain that lands after dismissal", async () => {
    const root = await createTestScratch("dohc-release-inflight-retain-");
    const store = createAutomationRunStore(preparedAutomationStoreFolder(root));
    let resume!: () => void;
    const blocked = new Promise<void>(resolve => {resume = resolve;});
    const retained = new Set<string>();
    const serverRestore = vi.fn(async (_definitions: Parameters<CollectionAutomations["undoRunsOf"]>[0], _again: boolean, id: string) => {
      await blocked; retained.add(id); return {...NOTHING, reverted: 1};
    });
    const undoHere = vi.fn(async () => NOTHING);
    const f = fixture({...automationsFile(), runStore: store, serverRestore, undoRunsOf: undoHere, releaseWait: async () => {retained.clear();}});
    const target = {kind: "person", userId: "user_ana"};
    const trying = f.call(CHANNELS.stopAndRestore, {target});
    await vi.waitFor(() => expect(serverRestore).toHaveBeenCalledTimes(1));
    const [entry] = await store.pendingRestores();
    await f.call(stopAndRestoreRecoveryOperations.dismissStopAndRestore.channel, {target});
    try { expect(f.releases).toEqual([]); } // Release waits in the background for the outstanding retain.
    finally { resume(); await trying; }
    await vi.waitFor(async () => expect(await store.pendingRestores()).toEqual([]));
    expect(f.releases).toContain(entry!.id);
    expect(serverRestore).toHaveBeenCalledTimes(1);
    expect(undoHere).not.toHaveBeenCalled();
    expect(retained.size).toBe(0);
  });
  it("keeps releases queued without requests while the workspace is local, then retries when remote", async () => {
    const root = await createTestScratch("dohc-release-local-");
    const store = createAutomationRunStore(preparedAutomationStoreFolder(root));
    await store.savePendingRestore({id: "queued", claims: [], serverRelease: true});
    let remote = false;
    const f = fixture({runStore: store, canRelease: () => remote});
    await f.call(stopAndRestoreRecoveryOperations.pendingStopAndRestores.channel, {});
    f.recovery.retryServerReleases();
    expect(f.releases).toEqual([]);
    expect(await store.pendingRestores()).toEqual([{id: "queued", claims: [], serverRelease: true}]);
    remote = true; f.recovery.retryServerReleases();
    await vi.waitFor(async () => expect(await store.pendingRestores()).toEqual([]));
    expect(f.releases).toEqual(["queued"]);
  });
  it("retries a queued release when the original account signs in again", async () => {
    const root = await createTestScratch("dohc-release-account-");
    const store = createAutomationRunStore(preparedAutomationStoreFolder(root));
    await store.savePendingRestore({id: "queued", claims: [], serverRelease: true});
    let allowed = false;
    const f = fixture({rootPath: root, runStore: store, releaseAllowed: () => allowed});
    expect(await f.call(stopAndRestoreRecoveryOperations.pendingStopAndRestores.channel, {})).toEqual([]);
    await vi.waitFor(() => expect(f.releases).toHaveLength(1));
    expect(await store.pendingRestores()).toEqual([{id: "queued", claims: [], serverRelease: true}]);
    allowed = true; f.recovery.retryServerReleases();
    await vi.waitFor(async () => expect(await store.pendingRestores()).toEqual([]));
  });
  it("lists pending restores and dismisses without waiting for server release", async () => {
    const root = await createTestScratch("dohc-restore-background-");
    const store = createAutomationRunStore(preparedAutomationStoreFolder(root));
    const target = {kind: "person" as const, userId: "user_ana"};
    await store.savePendingRestore({id: "queued", claims: [], serverRelease: true});
    await store.savePendingRestore({id: "live", claims: ["older"], session: {grants: ["grant"], target, label: "Ana",
      definitions: [], filesUndone: true, receipts: [], result: {status: "waiting"}}});
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {release = resolve;});
    const f = fixture({rootPath: root, runStore: store, releaseWait: () => blocked});
    try {
      const pending = f.call(stopAndRestoreRecoveryOperations.pendingStopAndRestores.channel, {});
      await pending;
      await vi.waitFor(() => expect(f.releases).toHaveLength(1));
      const dismissed = Promise.resolve(f.call(stopAndRestoreRecoveryOperations.dismissStopAndRestore.channel, {target}));
      const local = new Promise<void>(resolve => {
        const save = store.savePendingRestore;
        vi.spyOn(store, "savePendingRestore").mockImplementation(async entry => {await save(entry); resolve();});
      });
      await local;
      await dismissed;
      expect(await store.unfinishedUndos()).toEqual(new Set());
    } finally {release();}
  });
  it.each([false, true])("uses real retention through session saves with unrelated claims at the cap: %s", async atCap => {
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

  it("restores files when retaining automation claims exceeds the keep limit", async () => {
    const f = fixture({...automationsFile(), retainRunsForRestore: async () => {throw Error("dohc cannot undo more than 10,000 claims at once. Undo some runs in run history.");},
      undoRunsOf: async () => ({...NOTHING, errorMessage: "dohc cannot undo more than 10,000 claims at once. Undo some runs in run history."})});
    const result = await f.call(CHANNELS.stopAndRestore, {target: {kind: "person", userId: "user_ana"}});
    expect(result).toMatchObject({restored: [{restoredMomentId: "back-m-auto"}], unfinished: {step: "runs"}});
    expect(f.calls.some(call => call.method === "POST" && call.path.endsWith("/revoke"))).toBe(true);
  });
  it.each(["dismiss", "complete"] as const)("releases locally offline on %s and retries server release after restart", async action => {
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
  it.each(["dismiss", "missing-share"] as const)("releases both hosts' retained claims on %s", async action => {
    const root = await createTestScratch("dohc-restore-release-");
    const store = createAutomationRunStore(preparedAutomationStoreFolder(root));
    const target = {kind: "person" as const, userId: "user_ana"};
    await store.savePendingRestore({id: "restore-test", claims: ["older"], session: {grants: ["grant-edit"], target,
      label: "Ana", definitions: [], filesUndone: true, receipts: [], result: {status: "waiting"}}});
    const f = fixture({rootPath: root, runStore: store, granted: []});
    if (action === "dismiss") await f.call(stopAndRestoreRecoveryOperations.dismissStopAndRestore.channel, {target});
    else await expect(f.call(CHANNELS.stopAndRestore, {target})).rejects.toThrow("This person no longer has a share");
    await vi.waitFor(() => expect(f.releases).toEqual(["restore-test"]));
    await vi.waitFor(async () => expect(await createAutomationRunStore(preparedAutomationStoreFolder(root)).pendingRestores()).toEqual([]));
  });
  it.each(["person", "link"] as const)("stops %s access before reading a broken run store", async kind => {
    const f = fixture({runStoreError: new Error("Unreadable progress"), links: [[{shareId: "link-share", grantId: "grant-link", status: "active", dependents: []}]]});
    const target = kind === "person" ? {kind, userId: "user_ana"} : {kind, grantId: "grant-link"};
    await expect(f.call(CHANNELS.stopAndRestore, {target})).rejects.toThrow("Access stopped. dohc could not read unfinished Stop and restore progress.");
    expect(f.calls.some(call => call.method === "POST" && call.path.endsWith("/revoke"))).toBe(true);
  });
  it("shows no unfinished progress while the workspace is still opening, and still reports a broken run store", async () => {
    const opening = fixture({runStoreError: new AutomationStoreNotOpenedError("dohc has not finished opening this workspace. Try again when it opens.")});
    expect(await opening.call(stopAndRestoreRecoveryOperations.pendingStopAndRestores.channel, {})).toEqual([]);
    const broken = fixture({runStoreError: new Error("Unreadable progress")});
    await expect(broken.call(stopAndRestoreRecoveryOperations.pendingStopAndRestores.channel, {})).rejects.toThrow("Unreadable progress");
  });
  it("starts fresh when new access exists after an unfinished restore's files were undone", async () => {
    const root = await createTestScratch("dohc-restore-new-access-");
    const store = createAutomationRunStore(preparedAutomationStoreFolder(root));
    const target = {kind: "person" as const, userId: "user_ana"};
    await store.savePendingRestore({id: "person:user_ana", claims: [], session: {grants: ["grant-old"], target, label: "Ana", definitions: [], filesUndone: true,
      receipts: [], result: {status: "waiting"}}});
    const f = fixture({rootPath: root, runStore: store});
    await f.call(CHANNELS.stopAndRestore, {target});
    expect(f.capture.restoreFileToBeforeMoment).toHaveBeenCalledTimes(1);
  });
  it("recovers an unfinished restore after restart and finishes runs after Undo of the files", async () => {
    const root = await createTestScratch("dohc-restore-restart-");
    const target = {kind: "person", userId: "user_ana"};
    const definition = {id: "bump", name: "Bump", enabled: true, when: {kind: "record-added", table: null}, if: null,
      do: [{kind: "set", values: [{field: "Count", value: {kind: "literal", value: 2}}], records: null, operation: null}]} as unknown as Automation;
    const written = writeAutomationsFile([{status: "valid", automation: definition}]);
    if (written.status !== "ok") throw new Error("Invalid test automation");
    const moment = {...schemaMoment, path: "trip/automations.yaml", payload: {
      before: {path: "trip/automations.yaml", text: "version: 1\nautomations: []\n"},
      after: {path: "trip/automations.yaml", text: written.text},
    }};
    const first = fixture({rootPath: root, runStore: createAutomationRunStore(preparedAutomationStoreFolder(root)), moment,
      ledger: {"grant-edit": [{writes: [{committedAtMs: 2, files: [{path: moment.path, objectId: moment.objectId, momentId: moment.id, created: false}]}], nextAfterOriginSeq: null}]},
      undoRunsOf: async () => ({...NOTHING, errorMessage: "Resolve the conflict."}),
    });
    const outcome = await first.call(CHANNELS.stopAndRestore, {target}) as {restored: {restoredMomentId: string}[]};
    const resumedRuns = vi.fn(async () => NOTHING);
    const restarted = fixture({rootPath: root, runStore: createAutomationRunStore(preparedAutomationStoreFolder(root)), undoRunsOf: resumedRuns,
      granted: [grant({revokedAtMs: 3}), grant({grantId: "grant-view", shareId: "share-2", access: "view"}), grant({grantId: "grant-old", shareId: "share-3", revokedAtMs: 5})]});
    const saved = await restarted.call(stopAndRestoreRecoveryOperations.pendingStopAndRestores.channel, {}) as unknown[];
    expect(saved).toHaveLength(1);
    await restarted.call(CHANNELS.undoStopAndRestore, {target, restoredMomentIds: outcome.restored.map(file => file.restoredMomentId)});
    await restarted.call(CHANNELS.stopAndRestore, {target});
    expect(resumedRuns).toHaveBeenCalled();
    expect(restarted.capture.restoreFileToBeforeMoment).toHaveBeenCalledTimes(1);
    expect(await restarted.call(stopAndRestoreRecoveryOperations.pendingStopAndRestores.channel, {})).toEqual([]);
  });
  it("reviews a retired file and restores the following admitted file", async () => {
    const f = await capturedFiles(["notes/a.md", "docs/b.md"]);
    try {
      await f.writePolicy('[[rule]]\npath = "notes/**"\ntracked = false\n');
      await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
        status: "restored", restored: [{ path: "docs/b.md" }],
        review: [{ path: "notes/a.md", reason: "restore-refused", detail: "History no longer tracks this file. Track it in .dohc/files.toml, then try again." }], unfinished: null,
      });
      expect(await readFile(join(f.rootPath, "notes/a.md"), "utf8")).toBe("shared edit");
      expect(await readFile(join(f.rootPath, "docs/b.md"), "utf8")).toBe("owner original");
    } finally { await f.engineCapture.stop(); }
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

  it("reports each Undo outcome and continues past a retired file", async () => {
    const f = await capturedFiles(["docs/old.md", "notes/middle.md", "docs/new.md"]);
    try {
      const stopped = await f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } }) as { restored: { path: string; restoredMomentId: string }[] };
      expect(stopped.restored).toHaveLength(3);
      await f.writePolicy('[[rule]]\npath = "notes/**"\ntracked = false\n');
      await expect(f.call(CHANNELS.undoStopAndRestore, { restoredMomentIds: stopped.restored.map(row => row.restoredMomentId) })).resolves.toMatchObject({ files: [
        { momentId: stopped.restored[2]!.restoredMomentId, kind: "restored", receipt: { path: "docs/new.md" } },
        { momentId: stopped.restored[1]!.restoredMomentId, kind: "refused", detail: "History no longer tracks this file. Track it in .dohc/files.toml, then try again." },
        { momentId: stopped.restored[0]!.restoredMomentId, kind: "restored", receipt: { path: "docs/old.md" } },
      ] });
      expect(await readFile(join(f.rootPath, "docs/new.md"), "utf8")).toBe("shared edit");
      expect(await readFile(join(f.rootPath, "notes/middle.md"), "utf8")).toBe("owner original");
      expect(await readFile(join(f.rootPath, "docs/old.md"), "utf8")).toBe("shared edit");
    } finally { await f.engineCapture.stop(); }
  });

  it.each([CHANNELS.stopAndRestore, CHANNELS.undoStopAndRestore])("reports unreadable policy for every file in %s", async channel => {
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
  it("refuses Undo after the owner untracks the restored path", async () => {
    const f = await capturedFiles(["notes/a.md"]);
    try {
      const result = await f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } }) as { restored: { restoredMomentId: string }[] };
      expect(result.restored).toHaveLength(1);
      expect(await readFile(join(f.rootPath, "notes/a.md"), "utf8")).toBe("owner original");
      await f.writePolicy('[[rule]]\npath = "notes/**"\ntracked = false\n');
      const before = await f.store.listMoments({ workspaceId: WORKSPACE_ID, limit: 20 });
      await expect(f.call(CHANNELS.undoStopAndRestore, { restoredMomentIds: result.restored.map(row => row.restoredMomentId) }))
        .resolves.toEqual({ files: [{ momentId: result.restored[0]!.restoredMomentId, kind: "refused", detail: "History no longer tracks this file. Track it in .dohc/files.toml, then try again." }], errorMessage: null });
      expect(await readFile(join(f.rootPath, "notes/a.md"), "utf8")).toBe("owner original");
      expect(await f.store.listMoments({ workspaceId: WORKSPACE_ID, limit: 20 })).toEqual(before);
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

  it("undoes the runs of the automations the person wrote here and on the owner's server", async () => {
    const file = "trip/packing/automations.yaml";
    const stamp = {
      id: "stamp", name: "Stamp", enabled: true,
      when: { kind: "record-added", table: null },
      if: null,
      do: [{ kind: "set", values: [{ field: "Status", value: { kind: "literal", value: "New" } }], records: null, operation: null }],
    } as unknown as Automation;
    const written = writeAutomationsFile([{ status: "valid", automation: stamp }]);
    if (written.status !== "ok") throw new Error("The test's automation does not write.");
    const moment: VersionedTextMoment = {
      ...schemaMoment, id: "m-auto", objectId: "o-auto", path: file,
      payload: { before: null, after: { path: file, text: written.text } },
    };
    const definitions = [{ collectionPath: "trip/packing", id: "stamp", definitionHash: definitionHash(stamp) }];
    const undoRunsOf = vi.fn(async (_definitions: unknown, _trash: unknown, again?: boolean) => (again ? NOTHING : { ...NOTHING, undone: 1, reverted: 1 }));
    const serverRestore = vi.fn(async (_definitions: unknown, again: boolean) => (again ? NOTHING : { ...NOTHING, undone: 2, left: 1, reverted: 2, missing: 1 }));
    const f = fixture({
      moment, undoRunsOf, serverRestore,
      ledger: { "grant-edit": [{ writes: [{ committedAtMs: 2, files: [{ path: file, objectId: "o-auto", momentId: "m-auto", created: true }] }], nextAfterOriginSeq: null }] },
    });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({ runsUndone: 3, runsLeft: 1, keptFields: [], fieldsMissing: 1, unfinished: null });
    // A second pass finds nothing kept to try again, and ends.
    expect(undoRunsOf.mock.calls.map((call) => [call[0], call[2]])).toEqual([[definitions, false], [definitions, true]]);
    expect(serverRestore.mock.calls.map(call => call.slice(0, 2))).toEqual([[definitions, false], [definitions, true]]);
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

  it.each([
    ["here, then on the server", { here: [[0, 1]], server: [[1, 2]] }],
    ["on the server, then here", { here: [[1, 2]], server: [[0, 1]] }],
  ] as const)("puts back a field that runs wrote %s, whichever computer's Undo goes first", async (_order, runs) => {
    const computers = twoComputers(runs, 2);
    const f = fixture({ ...automationsFile(), ...computers });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } }))
      .resolves.toMatchObject({ runsUndone: 2, runsLeft: 0, keptFields: [], fieldsMissing: 0, unfinished: null });
    expect([computers.relay.value, computers.copies.here.value, computers.copies.server.value]).toEqual([0, 0, 0]);
  });

  it("stops undoing when a sync between passes fails, and says so", async () => {
    const computers = twoComputers({ here: [[0, 1]], server: [[1, 2]] }, 2);
    const f = fixture({ ...automationsFile(), ...computers, syncNow: async () => { throw new Error("dohc could not sync this workspace with your server, so it stopped undoing runs part way. Try again."); } });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } }))
      .resolves.toMatchObject({ unfinished: { step: "runs", message: "dohc could not sync this workspace with your server, so it stopped undoing runs part way. Try again." } });
    // The server's pass ran; nothing ran here over a copy that did not sync.
    expect(computers.undoRunsOf).not.toHaveBeenCalled();
  });

  it("reports what a pass undid before a sync failed", async () => {
    // The server's run came first, so its Undo keeps the field until the run here is undone.
    const computers = twoComputers({ here: [[1, 2]], server: [[0, 1]] }, 2);
    let syncs = 0;
    // The syncs of the first pass go through; the second pass's first sync fails.
    const syncNow = async () => {
      syncs += 1;
      if (syncs === 3) throw new Error("dohc could not sync this workspace with your server, so it stopped undoing runs part way. Try again.");
      await computers.syncNow();
    };
    const f = fixture({ ...automationsFile(), ...computers, syncNow });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      runsUndone: 2, runsLeft: 0, keptFields: [], unfinished: { step: "runs", message: "dohc could not sync this workspace with your server, so it stopped undoing runs part way. Try again." },
    });
  });

  // Undoing runs goes server, sync, here, sync. A try that one of those
  // stops tells which step it did not finish; trying again continues from
  // where it stopped, counts each run once across the tries, and a third try
  // changes nothing.
  const STOPPED = "dohc stopped here.";
  it("shows a recovery sentence when the server restore contract does not match", async () => {
    const server = createServerRuns(async () => ({
      status: 200, body: { ok: true, ...NOTHING, keptFields: 1 }, asker: { account: "owner", current: () => true },
    }));
    const f = fixture({ ...automationsFile(), serverRestore: async (definitions, again) => server.restore(WORKSPACE_ID, definitions, again, "restore-test") });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      unfinished: { step: "runs", message: "Your server runs a different version of dohc. Update it, then try again." },
    });
  });

  it.each(["local undo", "sync before local undo", "sync after local undo"] as const)(
    "shows a readable sentence for a Zod error from %s", async source => {
      const parsed = z.string().safeParse(42);
      if (parsed.success) throw new Error("The test expected a validation failure.");
      const error = parsed.error;
      let syncs = 0;
      const undoRunsOf = vi.fn(async () => {
        if (source === "local undo") throw error;
        return { ...NOTHING, undone: 1, reverted: 1 };
      });
      const f = fixture({
        ...automationsFile(),
        serverRestore: async () => ({ ...NOTHING, undone: 1, reverted: 1 }),
        undoRunsOf,
        syncNow: async () => {
          syncs += 1;
          if (source === "sync before local undo" || (source === "sync after local undo" && syncs === 2)) throw error;
        },
      });
      await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
        runsUndone: source === "sync after local undo" ? 2 : 1,
        unfinished: { step: "runs", message: "dohc could not finish undoing these runs." },
      });
      expect(undoRunsOf).toHaveBeenCalledTimes(source === "sync before local undo" ? 0 : 1);
    },
  );

  it.each(["../outside", "/outside", "C:/outside", "trip/../outside", "trip\\outside", "trip//outside"])("rejects kept field path %s", (path) => {
    expect(KeptAutomationFieldShape.safeParse({ ...KEPT, path }).success).toBe(false);
  });

  it("accepts normalized Collection and document paths, and an unlocated field", () => {
    for (const path of ["Budget", KEPT.path, null]) expect(KeptAutomationFieldShape.parse({ ...KEPT, path })).toEqual({ ...KEPT, path });
  });

  it("uses the latest finished host's path when this computer's next pass fails", async () => {
    let failing = false;
    const serverField = { ...KEPT, path: "trip/Tasks/moved.md" };
    const f = fixture({
      ...automationsFile(),
      serverRestore: async () => ({ ...NOTHING, keptFields: [failing ? serverField : KEPT] }),
      undoRunsOf: async () => ({ ...NOTHING, keptFields: [KEPT], errorMessage: failing ? STOPPED : null }),
    });
    const stop = () => f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } });
    await expect(stop()).resolves.toMatchObject({ keptFields: [KEPT], unfinished: null });
    failing = true;
    await expect(stop()).resolves.toMatchObject({ keptFields: [serverField], unfinished: { step: "runs", message: STOPPED } });
  });
  it.each([
    ["the server's Undo", 0],
    ["the sync before the Undo here", 1],
    ["the Undo here", 2],
    ["the sync after the Undo here", 3],
  ] as const)("continues after %s stopped a try, and repeats safely", async (_stage, stage) => {
    for (const runs of [{ here: [[0, 1]], server: [[1, 2]] }, { here: [[1, 2]], server: [[0, 1]] }] as const) {
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

  it("reports the fields an earlier try found kept when a retry stops before undoing runs", async () => {
    const computers = twoComputers({ here: [[0, 1]], server: [[1, 2]] }, 9);
    let ledgerFails = false;
    const f = fixture({ ...automationsFile(), ...computers, ledgerError: () => ledgerFails ? new Error("dohc could not reach your server.") : null });
    const stop = () => f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } });
    await expect(stop()).resolves.toMatchObject({ keptFields: [KEPT], unfinished: null });
    ledgerFails = true;
    await expect(stop()).resolves.toMatchObject({
      keptFields: [KEPT], runChangesKept: 1, unfinished: { step: "files", message: "dohc could not reach your server." },
    });
  });

  it("keeps a value someone set after the runs, and counts the field once", async () => {
    // Runs wrote 0 to 1 here and 1 to 2 on the server; then someone set 9.
    const computers = twoComputers({ here: [[0, 1]], server: [[1, 2]] }, 9);
    const f = fixture({ ...automationsFile(), ...computers });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } }))
      .resolves.toMatchObject({ runsUndone: 2, runsLeft: 0, keptFields: [KEPT], unfinished: null });
    expect(computers.relay.value).toBe(9);
    // One pass to undo, one that restores nothing and ends.
    expect(computers.serverRestore).toHaveBeenCalledTimes(2);
  });

  it("pulls and restores nothing while a change the person wrote has not arrived", async () => {
    const f = fixture({ moment: null });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toEqual({ status: "waiting" });
    expect(f.queuePull).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(f.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
  });

  it.each(["capture-recovery", "capture-recovery-cleared"] as const)("excludes %s from the Stop and restore ledger lookup", async origin => {
    const f = fixture({moment: {...schemaMoment, metadata: {origin}}});
    await f.call(CHANNELS.stopAndRestore, {target: {kind: "person", userId: "user_ana"}});
    expect(f.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
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

  it("sends a file the engine finds changed at restore to review", async () => {
    const f = fixture({ changed: true });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      restored: [],
      review: [{ path: SCHEMA, reason: "changed-since" }],
    });
  });

  it("keeps local content and unsettled drafts for review with the engine's reason", async () => {
    const f = fixture({ restoreError: new RestoreLocalChangesError(SCHEMA) });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      restored: [], review: [{ path: SCHEMA, reason: "restore-refused", detail: "Changed on this device since the last saved version" }],
      unfinished: null,
    });
  });

  it("reviews a shared live file History refuses, and reports any other restore failure", async () => {
    const live = fixture({ restoreError: new LiveDocumentMutationError("dohc could not restore it. This action is unavailable for shared live files.") });
    await expect(live.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      review: [{ path: SCHEMA, reason: "restore-refused", detail: "dohc could not restore it. This action is unavailable for shared live files." }],
      unfinished: null,
    });
    const down = fixture({ restoreError: new Error("The workspace engine is not running.") });
    await expect(down.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      review: [],
      unfinished: { step: "files", message: "The workspace engine is not running." },
    });
  });

  it("lists a protected file it cannot restore here for the owner to check, instead of waiting for it", async () => {
    const f = fixture({ protectedMoment: true });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toMatchObject({
      restored: [],
      review: [{ path: SCHEMA, reason: "restore-refused", detail: "Its contents are protected. Restore it from its History." }],
      unfinished: null,
    });
    expect(f.queuePull).not.toHaveBeenCalled();
    expect(f.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
  });

  it("says access stays stopped when reading their changes fails after it stopped access", async () => {
    const f = fixture({ ledgerError: () => new Error("dohc could not reach your server.") });
    await expect(f.call(CHANNELS.stopAndRestore, { target: { kind: "person", userId: "user_ana" } })).resolves.toEqual({
      status: "restored", restored: [], review: [], runsUndone: 0, runsLeft: 0, runChangesKept: 0,
      wroteAutomations: false, sendsMessages: false, keptFields: [], fieldsMissing: 0,
      unfinished: { step: "files", message: "dohc could not reach your server." },
    });
    expect(f.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/sync/shares/share-1/grants/grant-edit/revoke"]);
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

  it("restores through a link already ended, without ending it again", async () => {
    const f = fixture({ links: [[link({ status: "revoked" })]], ledger: linkLedger });
    await expect(f.call(CHANNELS.stopAndRestore, byLink)).resolves.toMatchObject({ restored: [{ path: SCHEMA }] });
    expect(f.calls.filter((call) => call.method === "POST")).toEqual([]);
    expect(f.sharesChanged).not.toHaveBeenCalled();
  });

  it("lists the link again when someone opened it meanwhile, and gives up after a few tries", async () => {
    const f = fixture({ links: [[link()]], ledger: linkLedger, revokeConflicts: 1 });
    await expect(f.call(CHANNELS.stopAndRestore, byLink)).resolves.toMatchObject({ restored: [{ path: SCHEMA }] });
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(2);

    const busy = fixture({ links: [[link()]], ledger: linkLedger, revokeConflicts: 3 });
    await expect(busy.call(CHANNELS.stopAndRestore, byLink)).rejects.toThrow("People kept opening this link while dohc ended it. Try again.");
    expect(busy.calls.filter((call) => call.method === "POST")).toHaveLength(3);
    expect(busy.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
    expect(busy.sharesChanged).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("stops at once, restoring nothing, when ending the link fails for another reason", async () => {
    const f = fixture({ links: [[link()]], ledger: linkLedger, revokeError: new Error("dohc could not reach your server.") });
    await expect(f.call(CHANNELS.stopAndRestore, byLink)).rejects.toThrow("dohc could not reach your server.");
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(f.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
    expect(f.sharesChanged).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("refuses a link this workspace does not have", async () => {
    const f = fixture({ links: [[link({ grantId: "grant-other" })]] });
    await expect(f.call(CHANNELS.stopAndRestore, byLink)).rejects.toThrow("This share link no longer exists.");
    expect(f.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("returns completed Undo outcomes when an unexpected error stops later restores", async () => {
    const f = fixture();
    f.capture.restoreFileToBeforeMoment.mockImplementationOnce(async momentId => ({
      restored: "text", restoredMomentId: `undo-${momentId}`, path: SCHEMA,
    })).mockRejectedValueOnce(new Error("The workspace engine is not running."));
    await expect(f.call(CHANNELS.undoStopAndRestore, { restoredMomentIds: ["old", "middle", "new"] })).resolves.toEqual({
      files: [{ momentId: "new", kind: "restored", receipt: { path: SCHEMA, restoredMomentId: "undo-new" } }],
      errorMessage: "The workspace engine is not running.",
    });
    expect(f.capture.restoreFileToBeforeMoment.mock.calls).toEqual([["new", OWNER, {expectedHeadMomentId: "new", requestId: restoreRequestId(`undo:${WORKSPACE_ID}`, "new")}], ["middle", OWNER, {expectedHeadMomentId: "middle", requestId: restoreRequestId(`undo:${WORKSPACE_ID}`, "middle")}]]);
  });

  it("undoes the restores newest first", async () => {
    const f = fixture();
    await f.call(CHANNELS.undoStopAndRestore, { restoredMomentIds: ["back-1", "back-2"] });
    expect(f.capture.restoreFileToBeforeMoment.mock.calls).toEqual([["back-2", OWNER, {expectedHeadMomentId: "back-2", requestId: restoreRequestId(`undo:${WORKSPACE_ID}`, "back-2")}], ["back-1", OWNER, {expectedHeadMomentId: "back-1", requestId: restoreRequestId(`undo:${WORKSPACE_ID}`, "back-1")}]]);
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
  it.each(["retained", "other-window"])("reviews files protected by %s state", async source => {
    const f = fixture({otherWindow: source === "other-window"});
    const result = await f.call(CHANNELS.stopAndRestore, {target: {kind: "person", userId: "user_ana"}, reviewPaths: source === "retained" ? [SCHEMA] : []});
    expect(result).toMatchObject({status: "restored", restored: [], review: [{path: SCHEMA, reason: "restore-refused"}], unfinished: null});
    expect(f.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
  });
  it.each([{paths: ["../a.md"]}, {paths: ["C:/a.md"]}, {paths: Array.from({length: 4097}, () => "a.md")}])("rejects an invalid or unbounded retained-path list", async ({paths: reviewPaths}) => {
    const f = fixture();
    await expect(f.call(CHANNELS.stopAndRestore, {target: {kind: "person", userId: "user_ana"}, reviewPaths})).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it("refuses Undo for renderer-held drafts and continues with other files", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.undoStopAndRestore, {restoredMomentIds: ["back"], reviewPaths: [SCHEMA]})).resolves.toMatchObject({files: [{kind: "refused"}], errorMessage: null});
    expect(f.capture.restoreFileToBeforeMoment).not.toHaveBeenCalled();
  });
});
