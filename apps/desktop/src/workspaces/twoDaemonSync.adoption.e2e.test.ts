

import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { mintLocalhostCa } from "../../../../services/share-web/src/testing/localhostCa";
import { HostedLogClientClosedError, startServerProxy } from "../../e2e/helpers/selfHostOnboarding";
import { DatabaseSync } from "node:sqlite";

import { readFile, readdir, writeFile } from "node:fs/promises";

import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { stableJsonStringify } from "../../../../services/sync-relay/src/canonicalJson";
import * as Y from "yjs";

import { patchFrontmatter } from "@dohc/ydoc-projection/frontmatter-map";

import { OwnerKnownRefusals } from "@dohc/workspace-engine-client/owner-ydoc-drainer";

import { DaemonRefusalError, OwnerYDocOutbox, openEngineYdocProviderSession, YdocAdapterError, YdocOwnerDraftPendingError, VersionedLiveAdapter, WorkspaceDaemonRequester, type AutomationClaim } from "@dohc/workspace-engine-client";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { collectionRecordWrites } from "@dohc/automation-executor/collection-record-edits";
import { createAutomationRunStore } from "@dohc/automation-executor/automation-run-store";
import { preparedAutomationStoreFolder, readersTrustLocalState } from "../testing/preparedLocalState";
import { createAutomationFormulaEvaluator } from "@dohc/automation-executor/automation-evaluator-host";
import { runCollectionAutomation } from "@dohc/automation-executor/collection-automation-run";
import { undoCollectionAutomationRuns } from "../../../../packages/automation-executor/src/collectionAutomationUndo";
import { createAutomationTargets } from "../../../../packages/automation-executor/src/automationTargets";
import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";

import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";

import { createWorkspaceEngineCapture, type WorkspaceEngineCapture } from "./workspaceEngineCapture";

import { desktopRecordEditContext } from "./desktopRecordEdits";

import { createTestScratch } from "./testTemp";

import { SECRET_FILE_STORE_RELATIVE_PATH } from "./workspaceDataKey";

import { selfHostLiveProfile } from "../../../../services/sync-relay/src/selfHostLiveProfile";
import { runNativeOwnerDeliveryPass } from "./nativeOwnerDelivery";

import { readyOwnerDeliveryDocuments } from "./serverOwnerDelivery";
import { startServerOwnerDelivery } from "./serverOwnerDelivery";
import { relayShareOperations } from "../ipc/shareOperations";

import { registerOperations } from "../ipc/operationTable";
import { createRelaySharesIpcHandlers } from "../ipc/relaySharesIpc";
import { LIVE_STOP_WAITING, liveStopRelayError } from "../ipc/liveEditingStop";
import { createPresencePollRegistry } from "../collab/presencePollRegistry";

import { engine, waitForHostedLog, compiledRelayMain, LiveDaemonCapture, pushUntilDrained, openJoinedDaemonCapture, pullAndExpect, heldStopCase } from "./twoDaemonSync.fixture";

it.skipIf(engine.missing).each(["existing id", heldStopCase])("settles open Collection adoption with native owner delivery and recipient sync (%s)", async name => {
  const body = "# Keep this body\n";
  const stopQuarantine = name === heldStopCase;
  const workspaceId = name === heldStopCase ? "native-stale-quarantine" : `native-open-adoption-${name.replaceAll(" ", "-")}`;
  const rootA = await createTestScratch("dohc-native-adoption-owner-");
  const rootB = await createTestScratch("dohc-native-adoption-peer-");
  const relayRoot = await createTestScratch("dohc-native-adoption-relay-");
  const ca = await mintLocalhostCa(relayRoot);
  const previousRoots = getCACertificates("default");
  setDefaultCACertificates([...previousRoots, ca.ca]);
  const trustEnv = { NODE_EXTRA_CA_CERTS: ca.caPath, DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
    DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath, DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0" };
  for (const [name, value] of Object.entries(trustEnv)) vi.stubEnv(name, value);
  const proxy = await startServerProxy(ca);
  let relayServer: Awaited<ReturnType<typeof spawnSyncRelay>> | undefined;
  let owner: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | undefined;
  let capture: WorkspaceEngineCapture | undefined;
  let delivery: ReturnType<typeof startServerOwnerDelivery> | undefined;
  let peer: LiveDaemonCapture | undefined;
  let preStopFeed: ReturnType<typeof proxy.holdNextHostedLogResponse> | undefined;
  const errors: string[] = [];
  let resyncSignals = 0;
  const recordError = (context: string, error: unknown) => {
    if (error instanceof YdocAdapterError && error.code === "resync-needed") {
      resyncSignals++;
      return;
    }
    errors.push(`${context}: ${String(error)}`);
  };
  const path = "tasks/pending.md", recordId = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  try {
    const relayOptions = { dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain,
      editLinks: { engineExecutable: engine.require(), publicOrigin: proxy.origin, trustEnv },
      linkBoundary: { linkKey: "native-adoption-link-key-".repeat(2), relayExchangeKey: "native-adoption-exchange-".repeat(2),
        publicViewerOrigin: proxy.origin } };
    relayServer = await spawnSyncRelay(relayOptions);
    proxy.routeRelayTo(relayServer.baseUrl);
    const relayConnection = { baseUrl: proxy.origin, token: `test:${workspaceId}` };
    const profile = selfHostLiveProfile();
    const nativeConfigPath = join(rootA, "owner-ingress.json");
    await writeFile(nativeConfigPath, JSON.stringify(profile.nativeIngress));
    owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: rootA }, { maxRestarts: 0,
      allowInsecureLoopbackForTests: false, privateOwnerHost: { configPath: nativeConfigPath, client: profile.nativeClient } });
    const source = owner;
    const relay = source.relay.bind({ ...source.workspace, relay: relayConnection });
    await relay.claim();
    await source.chats.ensureGeneralChannel({ workspaceId });
    await pushUntilDrained(relay);
    const adapter = await source.sessions.run(source.workspace, async ({client, workspace}) => new VersionedLiveAdapter(client, workspace, {workspaceId}));
    await adapter.ensureMainVersion({workspaceId});
    await adapter.writeTextFile({workspaceId, versionId: "main", path, text: `---\nid: ${recordId}\n---\n\n${body}`,
      publish: true, metadata: {origin: "api"}, author: {kind: "human", humanId: "local-person"}});
    capture = createWorkspaceEngineCapture({...source.workspace, rustEngineSessions: source.sessions, settleDebounceMs: 60_000,
      openRustYDocProviderSession: options => openEngineYdocProviderSession({...options,
        onResyncNeeded: error => { recordError("session resync", error); options.onResyncNeeded?.(error); }}),
      onError: recordError});
    const seeded = await capture.openYDocSession({path, contentKind: "richdoc", onRemoteUpdate: () => undefined});
    await seeded.applyDecidedLocalUpdate(doc => {
      const scratch = new Y.Doc();
      try {
        Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
        const before = Y.encodeStateVector(scratch);
        patchFrontmatter(scratch, new Map([["beforeActivation", "ordinary-owner"]]));
        return Y.encodeStateAsUpdate(scratch, before);
      } finally { scratch.destroy(); }
    }, undefined, { actorOriginId: "local-person", attribution: { actorKind: "human" }, idempotencyKey: "native-baseline" });
    await seeded.settleNow();
    await pushUntilDrained(relay);
    await seeded.close();
    const share = await fetch(`${proxy.origin}/sync/${workspaceId}/shares`, {method: "POST",
      headers: {authorization: `Bearer ${relayConnection.token}`, "content-type": "application/json"},
      body: JSON.stringify({recipientEmail: "native-recipient@dohc.test", paths: ["tasks"], access: "edit"})});
    expect(share.status).toBe(200);
    const shareResult = await share.json() as { shareId: string };
    const enrollment = await fetch(`${proxy.origin}/sync/${workspaceId}/live-host`, {method: "POST",
      headers: {authorization: `Bearer ${relayConnection.token}`, "content-type": "application/json"},
      body: JSON.stringify({shareId: shareResult.shareId})});
    expect([200, 202]).toContain(enrollment.status);
    let discoveryPayload: unknown;
    const discovery = async () => {
      const response = await fetch(`${proxy.origin}/sync/${workspaceId}/live-host`, {headers: {authorization: `Bearer ${relayConnection.token}`}});
      expect(response.status).toBe(200);
      discoveryPayload = await response.json();
      return readyOwnerDeliveryDocuments(discoveryPayload, workspaceId);
    };
    try { await expect.poll(async () => (await discovery()).length, {timeout: 120_000}).toBe(1); }
    catch (error) { throw new Error(JSON.stringify({ discoveryPayload, diagnostics: relayServer.diagnostics() }), { cause: error }); }
    const document = (await discovery())[0]!;
    const config = {...profile.owner, nativeConfigPath, nativeClient: profile.nativeClient, relayUrl: proxy.origin, documents: [document]};
    const refusals = new OwnerKnownRefusals();
    const pass = (signal: AbortSignal) => source.sessions.run(source.workspace, async ({client, workspace}) =>
      runNativeOwnerDeliveryPass({client: source.nativeClient(), workspaceHandle: workspace, document, config, refusals, signal, bearer: relayConnection.token, accountId: workspaceId, assertCurrent() {}}));
    expect(["empty", "acknowledged"]).toContain(await pass(AbortSignal.timeout(60_000)));
    let saveState: string | undefined;
    const session = await capture.openYDocSession({path, contentKind: "richdoc", onRemoteUpdate: () => undefined,
      onSaveState: state => { saveState = state; }});

    await adapter.writeTextFile({workspaceId, versionId: "main", path: "tasks/collection.yaml", text: "fields:\n  Name:\n    type: text\n",
      publish: true, metadata: {origin: "api"}});
    await expect.poll(async () => (await adapter.listPendingCollectionAdoptions()).adoptions.length, {timeout: 60_000}).toBe(1);
    await pushUntilDrained(relay);
    const pending = (await adapter.listPendingCollectionAdoptions()).adoptions[0]!;
    const bindingDb = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), { readOnly: true });
    try {
      expect(bindingDb.prepare("SELECT adoption_state FROM collection_records WHERE workspace_id=? AND file_path=?")
        .get(workspaceId, path)).toEqual({ adoption_state: "pending" });
    } finally { bindingDb.close(); }
    await session.applyDecidedLocalUpdate(doc => {
      const scratch = new Y.Doc();
      try {Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc)); const before = Y.encodeStateVector(scratch);
        patchFrontmatter(scratch, new Map([["Name", "Manual"]])); return Y.encodeStateAsUpdate(scratch, before);
      } finally {scratch.destroy();}
    }, undefined, {actorOriginId: "local-person", attribution: {actorKind: "human"}, idempotencyKey: "native-name"});
    const db = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), {readOnly: true});
    const outboxId = String(db.prepare("SELECT outbox_id FROM owner_ydoc_outboxes WHERE workspace_id=? AND object_id=? AND pending_bytes>0").get(workspaceId, document.binding.objectId)!.outbox_id);
    db.close();
    const pendingOutbox = await source.sessions.run(source.workspace, async ({client, workspace}) => new OwnerYDocOutbox(client, workspace).readPending(outboxId));
    expect(pendingOutbox.entries.some(entry => entry.personEdit)).toBe(true);
    await expect(session.settleNow()).rejects.toMatchObject({name: "YdocOwnerDraftPendingError"});
    expect((await adapter.listPendingCollectionAdoptions()).adoptions).toHaveLength(1);
    await capture.flush();
    expect(await adapter.flushCapture()).toMatchObject({settled: true});
    expect(saveState).toBe("pending-share");
    capture.start();
    const beforeDeliveryResyncSignals = resyncSignals;
    delivery = startServerOwnerDelivery({workspaceIds: () => [workspaceId], attemptTimeoutMs: 60_000, retryDelayMs: 250,
      async runPass(_workspaceId, _index, signal) {
        const result = await pass(signal);
        await relay.pull(apply => capture!.runRelaySync(apply));
        return {documentCount: 1, acknowledged: result === "acknowledged"};
      },
      onError: error => recordError("owner delivery", error)});
    // Keep the original session while the adapter resyncs it after delivery.
    // A recorded failure ends each poll; the assertion outside reports it.
    await expect.poll(async () => {
      if (errors.length) return true;
      const pending = (await adapter.listPendingCollectionAdoptions()).adoptions.length;
      const {settled} = await adapter.flushCapture();
      return pending === 0 && settled;
    }, {timeout: 120_000}).toBe(true);
    expect(errors).toEqual([]);
    await capture.flush();
    // Adoption can finish before the owner's field edit is accepted and materialized.
    await expect.poll(async () => {
      if (errors.length) return true;
      const pending = (await adapter.listPendingCollectionAdoptions()).adoptions.length;
      const {settled} = await adapter.flushCapture();
      return pending === 0 && settled && (await readFile(join(rootA, path), "utf8")).includes("Name: Manual");
    }, {timeout: 120_000}).toBe(true);
    expect(errors).toEqual([]);
    // Adoption can settle before the original session's final owner receipt arrives.
    await expect.poll(async () => {
      if (errors.length) return true;
      try { await session.settleNow(); }
      catch (error) {
        if (!(error instanceof YdocOwnerDraftPendingError)) {
          recordError("original session settle", error);
          throw error;
        }
      }
      return saveState === "saved-to-host";
    }, {timeout: 120_000}).toBe(true);
    expect(errors).toEqual([]);
    expect(resyncSignals, "delivery must resync the original pending-share session").toBeGreaterThan(beforeDeliveryResyncSignals);
    const markdown = await readFile(join(rootA, path), "utf8");
    expect(markdown).toContain("Name: Manual");
    expect(markdown).toContain("beforeActivation: ordinary-owner");
    expect(markdown).toContain(`id: ${pending.recordId}`);
    expect(markdown).toContain(body.trimEnd());
    await capture.flush();
    expect((await adapter.listPendingCollectionAdoptions()).adoptions).toEqual([]);
    console.log(`native owner delivery ${name}: ${resyncSignals} resync signals recovered on the original session`);
    const ownerSettlement = (await capture.listMoments({limit: 100})).moments.find(moment => moment.path === path);
    expect(ownerSettlement).toBeDefined();
    const ownerAuthors = [{kind: "human", humanId: workspaceId, humanName: workspaceId}];
    const confirmedOwnerAuthors = ownerAuthors.map(author => ({...author, relayConfirmed: true}));
    expect.soft(ownerSettlement!.authors).toEqual(confirmedOwnerAuthors);
    const publicationDb = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), {readOnly: true});
    try {
      expect.soft(publicationDb.prepare("SELECT admission_json,authors_json FROM live_settlement_publication_admissions WHERE workspace_id=? AND moment_id=?")
        .get(workspaceId, ownerSettlement!.id)).toMatchObject({
          admission_json: expect.stringContaining('"status":"accepted"'), authors_json: stableJsonStringify(ownerAuthors),
        });
    } finally {publicationDb.close();}
    // Publish owner operations before the peer imports settlement coverage.
    await pushUntilDrained(relay);
    // The unchanged seed has no journal interval, so it leaves no settlement to publish and nothing for the relay to refuse.
    const refusedDb = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), {readOnly: true});
    try {
      expect(refusedDb.prepare("SELECT origin_id,origin_seq FROM live_settlement_publication_admissions WHERE workspace_id=? AND json_extract(admission_json,'$.status')='refused'").all(workspaceId)).toEqual([]);
    } finally {refusedDb.close();}
    expect(await source.sessions.run(source.workspace, async ({client, workspace}) =>
      new WorkspaceDaemonRequester(client).request("sync.refusalNotices", {workspaceId}, {workspace}))).toEqual({notices: []});
    peer = await openJoinedDaemonCapture({workspaceId, rootPath: rootB, relay: relayConnection});
    await pullAndExpect(peer, rootB, path, markdown);
    const imported = (await peer.capture.listMoments({limit: 100})).moments.find(moment => moment.id === ownerSettlement?.id);
    expect(imported).toBeDefined();
    expect.soft(imported!.authors).toEqual(confirmedOwnerAuthors);
    await delivery.stop();
    delivery = undefined;
    const formula = createAutomationFormulaEvaluator();
    try {
      const parsed = parseAutomationsFile("version: 1\nautomations:\n  - id: finish\n    name: Finish\n    when: {button: Finish}\n    do: [{set: {Name: Automation}}]\n");
      if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw new Error("Invalid test automation");
      const automation = parsed.entries[0].automation;
      const collectionId = (await adapter.listCollections()).collections.find(entry => entry.path === "tasks")!.objectId;
      const claim: AutomationClaim = {
        claimId: "atc_pending", automationId: `collection:${collectionId}#finish`, trigger: { key: "pending-button" },
        recordId, collectionPath: "tasks", depth: 0, state: "running", attempts: 1, run: 1,
        createdAtMs: Date.now(), updatedAtMs: Date.now(),
        change: { kind: "button", authorOriginId: null, actorKind: "human", onBehalfOf: "local-person", sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 },
      };
      // The run reads its progress as it would while the engine holds `.dohc/local`.
      readersTrustLocalState();
      const store = createAutomationRunStore(preparedAutomationStoreFolder(rootA));
      const signal = new AbortController().signal;
      const edits = (signal: AbortSignal) => collectionRecordWrites(desktopRecordEditContext({
        capture: capture!, workspaceRoot: rootA, person: {kind: "human", humanId: "local-person"},
        withAdapter: work => work(adapter), signal,
        onCaptureSettled: () => () => undefined,
      }));
      const dependencies = {
        isButtonField: async () => true,
        withReads: async <T,>(work: (engine: VersionedLiveAdapter) => Promise<T>) => work(adapter),
        withRecordWrites: async <T,>(signal: AbortSignal, work: (writes: ReturnType<typeof edits>) => Promise<T>) => work(edits(signal)),
        collectionIdOf: () => collectionId, collectionPathOf: () => "tasks",
        targets: createAutomationTargets({ isCollection: path => path === "tasks", readText: async () => null,
          readSchemaFields: async () => new Set(["Name"]), withHost: async () => null }),
        readCode: async () => null, personName: () => "Owner", evaluator: formula.forWorkspace(workspaceId), store, nowMs: Date.now,
        chat: { hasMessage: async () => false, directory: async () => null, write: async () => { throw new Error("No chat in this test"); } },
        makeDurable: async () => { await adapter.makeAutomationWritesDurable(); },
        postNotice: async () => { throw new Error("No notices in this test"); }, readMessageBody: async () => null, recipientVerdicts: async () => [],
      };
      await expect(runCollectionAutomation(dependencies, { claim, automation, collection: {path: "tasks", name: "Tasks"},
        roster: {kind: "owner", ownerUserId: "local-person", grants: []}, signal, stopped: signal })).resolves.toEqual({kind: "done"});
      const runs = (await store.runsOf(claim.automationId, claim.claimId)).runs;
      expect(runs[0]!.applied.flatMap(entry => entry.writes)).toMatchObject([
        {kind: "field", recordId, path, field: "Name", before: "Manual", after: "Automation", sharedFileUpdate: {appendKey: expect.any(String)}},
      ]);
      const write = runs[0]!.applied.flatMap(entry => entry.writes).find(write => write.kind === "field");
      if (write?.kind !== "field" || !write.sharedFileUpdate) throw new Error("Missing recorded draft");
      expect(await adapter.sharedFileUpdateStates([write.sharedFileUpdate])).toEqual(["pending"]);
      // Both run Undo and Stop and restore use this document reversal.
      // A journaled reversal is pending until its own receipt arrives.
      const undo = {...dependencies, trash: async () => { throw new Error("No added records"); }};
      const reversal = await undoCollectionAutomationRuns(undo, runs, signal);
      expect(reversal).toMatchObject({undone: {reverted: 0}, undoWrites: [{draft: {appendKey: expect.any(String)}}]});
      await expect(undoCollectionAutomationRuns(undo, runs, signal)).resolves.toMatchObject({undone: {reverted: 0}});
      expect(session.doc.getMap("frontmatter").get("Name")).toBe("Manual");
      expect(await adapter.sharedFileUpdateStates(reversal.undoWrites.map(write => write.draft))).toEqual(["pending"]);
      // Host acknowledgement alone leaves the accepted native lineage dirty.
      await expect.poll(() => pass(signal), {timeout: 120_000}).toBe("empty");
      await expect.poll(async () => {
        try { return await adapter.sharedFileUpdateStates(reversal.undoWrites.map(write => write.draft)); }
        catch (error) {
          if (error instanceof DaemonRefusalError && error.wireCode === "OVERLOADED" &&
              error.message === "live-settlement-capacity") return null;
          throw error;
        }
      }, {timeout: REAL_DAEMON_DEADLINE_MS}).toEqual(["settled"]);
      await expect.poll(async () => {
        await pass(signal);
        await relay.pull(apply => capture!.runRelaySync(apply));
        await capture!.flush();
        return readFile(join(rootA, path), "utf8");
      }, {timeout: 120_000}).toBe(markdown).catch(error => {
        const db = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), {readOnly: true});
        try {
          throw new Error(JSON.stringify({
            markers: db.prepare("SELECT head_update_seq,settled_update_seq,last_settled_sha,settle_prior_update_seq,path FROM ydoc_docs").all(),
            snapshots: db.prepare("SELECT path,blob_sha256 FROM snapshots").all(),
            materializations: db.prepare("SELECT target_path,status,content_sha256 FROM materialization_jobs").all(),
          }), {cause: error});
        } finally {db.close();}
      });
    } finally { await formula.close(); }
    await expect.poll(async () => {
      await capture!.flush();
      await pushUntilDrained(relay);
      await peer!.relay.pull(apply => peer!.capture.runRelaySync(apply));
      return readFile(join(rootB, path), "utf8");
    }, {timeout: 120_000}).toBe(markdown);
    expect(await source.sessions.run(source.workspace, async ({client, workspace}) =>
      new WorkspaceDaemonRequester(client).request("sync.refusalNotices", {workspaceId}, {workspace}))).toEqual({notices: []});
    expect(errors).toEqual([]);
    if (stopQuarantine) {
      await session.applyDecidedLocalUpdate(doc => {
        const scratch = new Y.Doc();
        try {Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc)); const before = Y.encodeStateVector(scratch);
          patchFrontmatter(scratch, new Map([["Name", "Quarantined edit"]])); return Y.encodeStateAsUpdate(scratch, before);
        } finally {scratch.destroy();}
      }, undefined, {actorOriginId: "local-person", attribution: {actorKind: "human"}, idempotencyKey: "quarantine-edit"});

      const db = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), {readOnly: true});
      const outboxId = String(db.prepare("SELECT outbox_id FROM owner_ydoc_outboxes WHERE workspace_id=? AND object_id=? AND pending_bytes>0").get(workspaceId, document.binding.objectId)!.outbox_id);
      db.close();
      const readPending = () => source.sessions.run(source.workspace, async ({client, workspace}) => {
        const outbox = new OwnerYDocOutbox(client, workspace);
        try {return await outbox.readPending(outboxId);} finally {outbox.dispose();}
      });
      expect((await readPending()).entries).not.toHaveLength(0);
      await source.sessions.run(source.workspace, async ({client, workspace}) => {
        const outbox = new OwnerYDocOutbox(client, workspace);
        try {await outbox.quarantine({outboxId, reason: "stale-binding"});} finally {outbox.dispose();}
      });
      await session.close({settle: false});
      const handlers = new Map<string, (event: {sender: {id: number}}, payload: unknown) => unknown>();
      const credentials = {serverUrl: proxy.origin, relayUrl: proxy.origin, userId: workspaceId, email: "owner@dohc.test", token: relayConnection.token};
      const unexpected = (): never => {throw new Error("Unexpected Stop dependency");};
      let stopRefusalStatus: number | undefined;
      const ownerHandlers = createRelaySharesIpcHandlers({
        remoteForWorkspace: async () => ({credentials, credentialGeneration: 1}), currentCredentialGeneration: () => 1,
        currentCredentials: () => credentials, warmCredentialCache: async () => {}, relayShareJson: unexpected,
        relayShareJsonWithCredentials: async <R,>(_credentials: unknown, endpoint: string, init?: RequestInit): Promise<R> => {
          const response = await fetch(`${proxy.origin}${endpoint}`, {...init, headers: {authorization: `Bearer ${relayConnection.token}`, "content-type": "application/json"}});
          if (!response.ok) {
            const text = await response.text();
            let data: unknown = null;
            try {data = JSON.parse(text);} catch {/* Not JSON: fail below with the relay's answer. */}
            // A Stop refusal reaches Stop as main's relayShareJsonWithCredentials throws it.
            const stopRefusal = liveStopRelayError(data);
            if (stopRefusal) {stopRefusalStatus = response.status; throw stopRefusal;}
            expect(response.ok, `${init?.method ?? "GET"} ${endpoint} answered ${response.status}: ${text}`).toBe(true);
          }
          return await response.json() as R;
        }, relayShareErrorCopy: unexpected, relayShareDiscussionActivityPolls: createPresencePollRegistry(),
        listOwnerLiveStops: () => source.sessions.run(source.workspace, async ({workspace}) => source.nativeClient().ownerYDocStopList({id:0,workspace,deadlineMs:REAL_DAEMON_DEADLINE_MS})),
        ownerLiveStop: (_workspace, action, stopPath, binding, acceptedCursor) => source.sessions.run(source.workspace, async ({workspace}) => {
          const client = source.nativeClient(), request = {id: 0, workspace, deadlineMs: REAL_DAEMON_DEADLINE_MS};
          if (action === "clear") {await client.ownerYDocStopClear(request, binding as {mainVersionId: string; objectId: string; currentPath: string});return;}
          if (action==="retired") {await client.ownerYDocStopRetired(request,binding!);return;}
          return action === "request" ? client.ownerYDocStopRequest(request, binding as {mainVersionId: string; objectId: string; currentPath: string})
            : client.ownerYDocRelease(request, binding as import("@dohc/live-session-contract").LiveObjectBinding, {acceptedCursor: acceptedCursor!});
        }), liveDocument: async (_workspace, target) => {
          const resolved = await source.sessions.run(source.workspace, async ({client, workspace}) =>
            new VersionedLiveAdapter(client, workspace, {workspaceId: source.workspace.workspaceId}).resolveFiles({workspaceId: source.workspace.workspaceId, targets: [target]}));
          const [file] = resolved.results;
          return file?.status === "found" ? {mainVersionId: resolved.versionId, objectId: file.objectId, currentPath: file.path} : null;
        }, pushRecorded: async () => {}, withoutEditors: (_workspace, _path, change) => change(), ownerLiveQuarantines: () => [], unwrittenOwnerLiveReleases: async () => [], retryOwnerLiveQuarantine: unexpected, retryOwnerLiveRelease: unexpected, saveOwnerLiveRecoveryCopy: unexpected,
        sendRendererActivity: () => {},
        sharesChanged: unexpected, reconcileReceivedShares: unexpected,
      });
      registerOperations({
        handle: (channel, handler) => {handlers.set(channel, handler);},
        assertTrustedSender() {},
        withActiveWorkspace: async (_event: {sender: {id: number}}, id, _message, work) => {
          expect(id).toBe(workspaceId);
          return work({workspace: source.workspace, assertCurrent() {}});
        },
      }, relayShareOperations, ownerHandlers);
      const stop = () => Promise.resolve(handlers.get(relayShareOperations.stopOwnerLiveDocument.channel)!({sender: {id: 1}}, {workspaceId, path}));
      const resume = () => Promise.resolve(handlers.get(relayShareOperations.resumeOwnerLiveDocument.channel)!({sender: {id: 1}}, {workspaceId, path}));
      // The session host's store, once it has one.
      const hostStore = async () => {
        const stores = join(relayRoot, "relay-deployment", "live-host");
        const store = (await readdir(stores)).find(entry => /^[0-9a-f]{64}$/u.test(entry));
        return store === undefined ? undefined : join(stores, store);
      };
      // The document's state in the session host's store.
      const hostDocumentState = async () => {
        const store = await hostStore();
        if (!store) return undefined;
        const db = new DatabaseSync(join(store, SECRET_FILE_STORE_RELATIVE_PATH), {readOnly: true});
        try {return (db.prepare("SELECT state FROM hosted_documents WHERE object_id=?").get(document.binding.objectId) as {state: string} | undefined)?.state;}
        finally {db.close();}
      };
      // This computer's Stops that still owe the server a retirement.
      const owedStops = async () => (await source.sessions.run(source.workspace, async ({workspace}) =>
        source.nativeClient().ownerYDocStopList({id: 0, workspace, deadlineMs: REAL_DAEMON_DEADLINE_MS}))).filter(row => row.retirementOwed);
      if (name === heldStopCase) {
        // A hosted pull holds the session host's only request slot, so Stop can't
        // drain or prepare there, and the relay answers that edits are pending.
        preStopFeed = proxy.holdNextHostedLogResponse(workspaceId);
        const response = await waitForHostedLog(preStopFeed, preStopFeed.captured, "pre-Stop capture");
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({ ok: true,
          scope: { documents: expect.arrayContaining([{ objectId: document.binding.objectId, path }]) } });
        expect(await hostDocumentState()).toBe("ready");
        const refused = await stop().then(() => {throw new Error("Stop succeeded while the session host was held.");}, (error: unknown) => error);
        expect(stopRefusalStatus).toBe(409);
        // The relay's edits-pending answer only means "not yet", so this computer keeps its Stop.
        expect((refused as Error).message).toBe(LIVE_STOP_WAITING);
        expect(await owedStops()).toMatchObject([{state: "requested", binding: document.binding}]);
        preStopFeed.release();
        try { await waitForHostedLog(preStopFeed, preStopFeed.delivered, "pre-Stop delivery"); }
        catch (error) {
          // A host that gave up on the held pull retries it, and the release lets that retry through.
          if (!(error instanceof HostedLogClientClosedError)) throw error;
        }
        // The session host holds the document again before Stop is sent again.
        await expect.poll(async () => (await discovery()).length, {timeout: 120_000}).toBe(1);
      }
      await stop();
      await expect.poll(async () => (await discovery()).length, {timeout: 60_000}).toBe(0);
      if (name === heldStopCase) expect(await owedStops()).toEqual([]);

      await expect(readPending()).rejects.toThrow("owner-outbox-not-found");
      expect(await readFile(join(rootA, path), "utf8")).toContain("Name: Quarantined edit");
      const releasedMoment = (await capture.listMoments({limit: 100})).moments.find(moment => moment.path === path);
      expect(releasedMoment?.authors).toContainEqual({kind: "human", humanId: "local-person"});
      await expect.poll(hostDocumentState, {timeout: 120_000}).toBe("parked");
      // An ordinary owner edit that reaches the peer through ordinary sync.
      const editOrdinary = async (value: string, key: string) => {
        const ordinary = await capture!.openYDocSession({path, contentKind: "richdoc", onRemoteUpdate: () => undefined});
        await expect(ordinary.applyDecidedLocalUpdate(doc => {
          const scratch = new Y.Doc();
          try {Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc)); const before = Y.encodeStateVector(scratch);
            patchFrontmatter(scratch, new Map([["Name", value]])); return Y.encodeStateAsUpdate(scratch, before);
          } finally {scratch.destroy();}
        }, undefined, {actorOriginId: "local-person", attribution: {actorKind: "human"}, idempotencyKey: key})).resolves.toBeDefined();
        await ordinary.settleNow();await ordinary.close();
        expect(await readFile(join(rootA, path), "utf8")).toContain(`Name: ${value}`);
        await expect.poll(async () => {
          await pushUntilDrained(relay);
          await peer!.relay.pull(apply => peer!.capture.runRelaySync(apply));
          return readFile(join(rootB, path), "utf8");
        }, {timeout: 120_000}).toContain(`Name: ${value}`);
      };
      await editOrdinary("Local after stop", "after-stop");
      const liveRow = async () => {
        const ready = (await discovery()).some(row => row.binding.currentPath === path);
        const row = (discoveryPayload as {documents: Array<{path: string}>}).documents.find(row => row.path === path);
        return {ready, row};
      };
      const ready = {ready: true, row: expect.objectContaining({path, status: "ready"})};
      // The operator's reports that the session host holds the document.
      const reports = () => relayServer!.diagnostics().stderr.split(`Live editing of ${path} in workspace ${workspaceId} is held`).length - 1;
      // The relay's activations, the session host's copy and the relay's log, for a row that never became ready.
      const notReady = async (error: unknown): Promise<never> => {
        const db = new DatabaseSync(relayOptions.dbPath, {readOnly: true});
        let activations: unknown;
        try {
          activations = db.prepare(`SELECT activation_id,predecessor_activation_id,object_id,lineage_claim_id,completion_json IS NOT NULL AS completed,
            retire_requested_at_ms,retire_restore_generation,retired_at_ms FROM sync_relay_service_activations WHERE workspace_id=?`).all(workspaceId);
        } finally {db.close();}
        throw new Error(JSON.stringify({discoveryPayload, activations, hostDocument: await hostDocumentState(),
          diagnostics: relayServer!.diagnostics()}), {cause: error});
      };
      await resume();
      // A successor captures the stopped edit, and the session host's copy has it.
      await expect.poll(liveRow, {timeout: 120_000}).toEqual(ready).catch(notReady);
      expect(await hostDocumentState()).toBe("ready");
      expect(reports()).toBe(0);
      // The settlement commits before the engine writes the file.
      await expect.poll(async () => readFile(join((await hostStore())!, path), "utf8"), {timeout: 10_000}).toContain("Name: Local after stop");
      // The peer keeps the stopped edit.
      await expect.poll(async () => {
        await peer!.relay.pull(apply => peer!.capture.runRelaySync(apply));
        return readFile(join(rootB, path), "utf8");
      }, {timeout: 120_000}).toContain("Name: Local after stop");
      // A relay restart starts the session host from its store, and the document is ready again.
      await relayServer.stop();
      relayServer = await spawnSyncRelay(relayOptions);
      proxy.routeRelayTo(relayServer.baseUrl);
      await expect.poll(liveRow, {timeout: 120_000}).toEqual(ready).catch(notReady);
      expect(await hostDocumentState()).toBe("ready");
      expect(reports()).toBe(0);
      // Another document of the workspace also starts live editing.
      const other = "notes/other.md";
      await adapter.writeTextFile({workspaceId, versionId: "main", path: other, text: "# Other\n",
        publish: true, metadata: {origin: "api"}, author: {kind: "human", humanId: "local-person"}});
      const otherSession = await capture.openYDocSession({path: other, contentKind: "richdoc", onRemoteUpdate: () => undefined});
      await otherSession.settleNow(); await otherSession.close();
      await pushUntilDrained(relay);
      const otherShare = await fetch(`${proxy.origin}/sync/${workspaceId}/shares`, {method: "POST",
        headers: {authorization: `Bearer ${relayConnection.token}`, "content-type": "application/json"},
        body: JSON.stringify({recipientEmail: "native-recipient@dohc.test", paths: ["notes"], access: "edit"})});
      expect(otherShare.status).toBe(200);
      const otherEnrollment = await fetch(`${proxy.origin}/sync/${workspaceId}/live-host`, {method: "POST",
        headers: {authorization: `Bearer ${relayConnection.token}`, "content-type": "application/json"},
        body: JSON.stringify({shareId: (await otherShare.json() as {shareId: string}).shareId})});
      expect([200, 202]).toContain(otherEnrollment.status);
      // Discovery lists documents by path.
      await expect.poll(async () => (await discovery()).map(row => row.binding.currentPath), {timeout: 120_000}).toEqual([other, path]);
      expect(await liveRow()).toEqual(ready);
    }
    await session.close({settle: false});
  } finally {
    preStopFeed?.destroy();
    await delivery?.stop(); await peer?.close();
    try {await capture?.stop().catch(() => undefined);} finally {await owner?.close(); await relayServer?.stop(); await proxy.close();
      setDefaultCACertificates(previousRoots); vi.unstubAllEnvs();}
  }
}, 420_000);
