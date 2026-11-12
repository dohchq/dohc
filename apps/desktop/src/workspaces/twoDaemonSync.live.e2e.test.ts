import { parseHostEpoch } from "@dohc/live-session-contract";
import { createHash } from "node:crypto";
import { restoreDirectWrites } from "./stopAndRestore";
import type { VersionedTextMoment } from "@dohc/workspace-contracts/engine";
import { DatabaseSync } from "node:sqlite";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { stableJsonStringify } from "../../../../services/sync-relay/src/canonicalJson";
import * as Y from "yjs";
import { patchFrontmatter } from "@dohc/ydoc-projection/frontmatter-map";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import { createWorkspaceEngineCapture, type WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { createTestScratch } from "./testTemp";
import { deferred } from "../testing/deferred";
import { SECRET_FILE_STORE_RELATIVE_PATH } from "./workspaceDataKey";
import { createRelaySyncEngine, type CloudSyncEngine } from "./relaySyncEngine";
import { selfHostLiveProfile } from "../../../../services/sync-relay/src/selfHostLiveProfile";
import { engine, compiledRelayMain, LiveDaemonCapture, pullCaptured, pushUntilDrained, openLiveDaemonCapture, openJoinedDaemonCapture, writeAndCapture, OpenEditor, openEditor } from "./twoDaemonSync.fixture";

it.skipIf(engine.missing)("watched scheduling preserves the exact relay op sequence and keeps private paths out", async () => {
  const workspaceId = "watched-op-sequence", token = `test:${workspaceId}`;
  const root = await createTestScratch("dohc-watched-ops-");
  const relayRoot = await createTestScratch("dohc-watched-relay-");
  const snapshot = await createTestScratch("dohc-watched-snapshot-");
  const dbPath = join(relayRoot, "relay", "relay.sqlite");
  let relay = await spawnSyncRelay({dbPath, compiledMain: compiledRelayMain});
  let owner: LiveDaemonCapture | null = null;
  let sync: CloudSyncEngine | undefined;
  let editor: OpenEditor | undefined;
  try {
    owner = await openLiveDaemonCapture({workspaceId, rootPath: root, relay: {baseUrl: relay.baseUrl, token}});
    await owner.relay.claim();
    await owner.chats.ensureGeneralChannel({workspaceId}); await pushUntilDrained(owner.relay);
    await writeAndCapture(owner, root, "note.txt", "saved base\n");
    const seededEditor = await openEditor(owner, "note.txt");
    await seededEditor.session.settleNow(); await seededEditor.session.close({settle: false}); seededEditor.doc.destroy();
    await mkdir(join(root, "node_modules"), {recursive: true});
    await writeFile(join(root, "node_modules/private.txt"), "excluded-private-content");
    await writeFile(join(root, "node_modules/private.env"), "TOKEN=never-visible-in-log\n");
    owner.capture.observeFileEvents([
      {path: "node_modules/private.txt", operation: "update"},
      {path: "node_modules/private.env", operation: "update"},
    ]);
    await owner.capture.flush(); await pushUntilDrained(owner.relay);
    await owner.close(); owner = null; await relay.stop();
    const initialLog = new DatabaseSync(dbPath, {readOnly: true});
    const initialUpdates = (initialLog.prepare("SELECT COUNT(*) AS count FROM sync_relay_log WHERE workspace_id = ? AND op_kind = 'ydoc.update'").get(workspaceId) as {count: number}).count;
    initialLog.close();
    await cp(root, join(snapshot, "owner"), {recursive: true});
    await cp(relayRoot, join(snapshot, "relay"), {recursive: true});
    const sequences: unknown[][] = [];
    for (const watched of [false, true]) {
      // Reuse the same durable journal, identity, lineage and initial Y.Doc bytes.
      await cp(join(snapshot, "owner"), root, {recursive: true, force: true});
      await cp(join(snapshot, "relay"), relayRoot, {recursive: true, force: true});
      relay = await spawnSyncRelay({dbPath, compiledMain: compiledRelayMain});
      const connection = {baseUrl: relay.baseUrl, token};
      owner = await openLiveDaemonCapture({workspaceId, rootPath: root, relay: connection, settleDebounceMs: 60_000});
      editor = await openEditor(owner, "note.txt"); editor.doc.clientID = 777;
      const accepted: number[] = [];
      const operations = owner.relay;
      let report!: (value: {hasMore: boolean; watched: boolean}) => void;
      sync = createRelaySyncEngine({rootDir: root, relay: connection, capture: owner.capture, onChange: () => {},
        operations: {...operations, push: async () => {const result = await operations.push(); accepted.push(result.pushed); return result;}},
        // The real registry/held-read transition is covered by the held-read suites.
        // Hold the injected watch steady here to compare only upload scheduling.
        waitForChange: (_since, signal) => new Promise((resolve, reject) => {
          report = resolve; signal.addEventListener("abort", () => reject(signal.reason), {once: true});
        })});
      await sync.start();
      await vi.waitFor(() => expect(report).toBeTypeOf("function"));
      report({hasMore: false, watched});
      const observing = deferred<void>();
      const detach = owner.capture.onDurableLocalChange(() => observing.resolve());
      const before = accepted.length;
      for (let index = 0; index < 30; index += 1) {
        const vector = Y.encodeStateVector(editor.doc);
        editor.doc.getText("plainText").insert(editor.doc.getText("plainText").length, String.fromCharCode(97 + index % 26));
        await editor.session.applyDecidedLocalUpdate(() => Y.encodeStateAsUpdate(editor!.doc, vector));
      }
      await observing.promise; detach();
      if (watched) await vi.waitFor(() => expect(accepted.slice(before).some(count => count > 0)).toBe(true));
      else expect(accepted.length).toBe(before);
      await sync.stop(); sync = undefined;
      await pushUntilDrained(owner.relay);
      const database = new DatabaseSync(dbPath, {readOnly: true});
      try {
        const rows = database.prepare("SELECT origin_seq, op_kind, payload_json FROM sync_relay_log WHERE workspace_id = ? ORDER BY origin_seq").all(workspaceId) as Array<{origin_seq: number; op_kind: string; payload_json: string}>;
        expect(rows.filter(row => row.op_kind === "ydoc.update")).toHaveLength(initialUpdates + 30);
        for (let index = 1; index < rows.length; index += 1) expect(rows[index]!.origin_seq).toBe(rows[index - 1]!.origin_seq + 1);
        for (const row of rows) {
          expect(row.payload_json).not.toContain("node_modules/private.txt");
          expect(row.payload_json).not.toContain("excluded-private-content");
          expect(row.payload_json).not.toContain("never-visible-in-log");
          expect(row.payload_json).not.toContain("node_modules/private.env");
        }
        sequences.push(rows.map(row => [row.origin_seq, row.op_kind, createHash("sha256").update(stableJsonStringify(JSON.parse(row.payload_json))).digest("hex")]));
      } finally {database.close();}
      await editor.session.close({settle: false}); editor.doc.destroy(); editor = undefined;
      await owner.close(); owner = null; await relay.stop();
    }
    expect(sequences[1]).toEqual(sequences[0]);
  } finally {
    await sync?.stop(); await editor?.session.close({settle: false}); editor?.doc.destroy();
    await owner?.close(); await relay.stop();
  }
}, 120_000);

it.skipIf(engine.missing)("keeps mixed accepted text for Stop and restore on a second owner with a lease", async () => {
  const workspaceId = "two-daemon-drain-coverage", path = "tasks/one.md";
  const rootA = await createTestScratch("dohc-drain-owner-");
  const rootB = await createTestScratch("dohc-drain-peer-");
  const relayRoot = await createTestScratch("dohc-drain-relay-");
  const relayServer = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
  const relayConnection = { baseUrl: relayServer.baseUrl, token: `test:${workspaceId}` };
  let owner: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | undefined;
  let capture: WorkspaceEngineCapture | undefined;
  let peer: LiveDaemonCapture | undefined;
  const doc = markdownToYDoc("---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nName: Recipient record\n---\n\nOriginal body.\n");
  const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
  try {
    const profile = selfHostLiveProfile();
    const configPath = join(rootA, "owner-ingress.json");
    await writeFile(configPath, JSON.stringify(profile.nativeIngress));
    owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: rootA }, { maxRestarts: 0,
      privateOwnerHost: { configPath, client: profile.nativeClient }, allowInsecureLoopbackForTests: true });
    const source = owner;
    const relay = source.relay.bind({ ...source.workspace, relay: relayConnection });
    await relay.claim();
    await source.chats.ensureGeneralChannel({ workspaceId });
    await pushUntilDrained(relay);
    const baselineBytes = Y.encodeStateAsUpdate(doc), baseline = yDocToMarkdown(doc);
    const binding = { workspaceId, mainVersionId: "main", objectId: "record-one", currentPath: path,
      lineageClaimId: hash(baselineBytes), selectorPaths: ["tasks"], restoreFenceGeneration: 0 };
    const client = source.nativeClient();
    let id = 1000;
    const { handle, registrationId } = await source.sessions.run(source.workspace, async ({ workspace }) => {
      const request = (method: string, params: Record<string, unknown>) => client.sendRequest({ id: ++id, method,
        workspace, params: params as Parameters<typeof client.sendRequest>[0]["params"], deadlineMs: REAL_DAEMON_DEADLINE_MS });
      await request("versions.ensureMain", { workspaceId });
      const files = new VersionedLiveAdapter(client, workspace, { workspaceId });
      await files.writeTextFile({ workspaceId, versionId: "main", path: "tasks/collection.yaml",
        text: "fields:\n  Name: {type: text}\n  OwnerNote: {type: text}\n", publish: true, metadata: { origin: "api" } });
      await request("liveApplication.provisionOwner", { relayNamespace: "drain-relay", host: {
        hostId: "owner-A", hostEpoch: 1, instanceId: "instance", connectionId: "connection" } });
      const registered = await request("liveApplication.register", { binding });
      return { handle: workspace, registrationId: (registered.result as { registrationId: number }).registrationId };
    });
    const bootstrapped = await client.sendLiveBootstrap({ id: ++id, workspace: handle, registrationId, deadlineMs: REAL_DAEMON_DEADLINE_MS }, {
      bootstrapId: "recipient-baseline", bootstrapMomentId: "recipient-baseline-moment", baselineMomentRelaySequence: 1,
      baselineRegisteredAtMs: 100, baselineDigest: binding.lineageClaimId, projectedMarkdownDigest: hash(baseline),
      projectedMarkdownByteLength: Buffer.byteLength(baseline), baselineBytes,
    });
    expect(bootstrapped.result).toMatchObject({ status: "bootstrapped" });
    capture = createWorkspaceEngineCapture({ ...source.workspace, rustEngineSessions: source.sessions, settleDebounceMs: 60_000 });
    await writeFile(join(rootA, path), baseline);
    const hosted = await capture.openYDocSession({ path, contentKind: "richdoc", onRemoteUpdate: () => undefined });
    await hosted.settleNow();
    await pushUntilDrained(relay);
    peer = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: relayConnection, holdEditorResync: true });
    await pullCaptured(peer.relay, peer.capture);
    const lease = await peer.capture.openYDocSession({ path, contentKind: "richdoc", onRemoteUpdate: () => undefined });
    expect(lease.objectId).toBe(binding.objectId);
    expect(lease.lineageClaimId).toBe(binding.lineageClaimId);
    await lease.settleNow();
    try {
      for (const [cursor, field, value, recipient] of [[1, "OwnerNote", "Owner text", false], [2, "Name", "Recipient text", true]] as const) {
        const vector = Y.encodeStateVector(doc);
        patchFrontmatter(doc, new Map([[field, value]]));
        const updateBytes = Y.encodeStateAsUpdate(doc, vector);
        const receipt = { deliveryId: `delivery-${cursor}`, updateDigest: hash(updateBytes), journalCursor: cursor, acceptingHostEpoch: parseHostEpoch(1) };
        const applied = await client.sendLiveApplication({ id: ++id, workspace: handle, registrationId, deadlineMs: REAL_DAEMON_DEADLINE_MS }, {
          updateBytes, metadata: { accepted: { receipt, binding, authority: recipient
            ? { principalKind: "named", principalId: "recipient", grantId: "edit-grant", grantGeneration: 1 }
            : { principalKind: "owner", principalId: workspaceId, grantId: null, grantGeneration: null }, receivedAtMs: 200 + cursor }, firstSeen: [],
            ...(recipient ? { canonicalVersion: 2, authorSnapshot: [{ kind: "human", humanId: "recipient", humanName: "Recipient" }], firstSeenDeletes: [] } : {}) },
        });
        expect(applied.result).toMatchObject({ status: "applied" });
      }
      await pullCaptured(relay, capture);
      await pushUntilDrained(relay);
      await peer.relay.pull(async (apply) => apply(async () => undefined));
      const parked = new DatabaseSync(join(rootB, SECRET_FILE_STORE_RELATIVE_PATH), { readOnly: true });
      try {
        expect((parked.prepare("SELECT count(*) AS n FROM ydoc_deferred_updates").get() as { n: number }).n,
          JSON.stringify({ operations: parked.prepare("SELECT op_kind,apply_disposition FROM replication_log").all(),
            documents: parked.prepare("SELECT object_id,lineage_claim_id FROM ydoc_docs").all() })).toBe(2);
      }
      finally { parked.close(); }
    } finally { await lease.close({ settle: false }); }
    const moments = (await peer.capture.listMoments({ limit: 100 })).moments.filter(moment => moment.path === path);
    const projected = moments.find(moment => moment.id.startsWith("moment-ydoc-apply-"));
    expect(projected?.authors).toContainEqual({ kind: "unattributed" });
    expect(projected?.authors).toContainEqual({ kind: "human", humanId: "recipient", humanName: "Recipient" });
    // The direct-write ledger's recipient identity is independent of native History.
    // The desktop creation e2e covers that ledger; here its seed anchors real peer moments.
    const created: VersionedTextMoment = { id: "direct-recipient-create", workspaceId, versionId: "main", objectId: binding.objectId,
      path, operation: "write", recordedAtMs: 99, metadata: { origin: "sync" },
      authors: [{ kind: "named", userId: "recipient", grantId: "edit-grant", grantGeneration: 1 }],
      payload: { before: null, after: { path, text: baseline } } };
    const restore = vi.fn(async () => { throw new Error("Mixed text must not be restored"); });
    const result = await restoreDirectWrites({ assertCurrent() {},
      moment: async momentId => {
        if (momentId === created.id) return created;
        const detail = await peer!.capture.readMoment(momentId);
        return detail === null ? null : detail.protected ? "protected" : detail.moment;
      },
      momentsAfter: async () => moments.map(moment => moment.id), restore,
      folderEntries: async () => ["one.md"], removeEmptyFolder: async () => undefined,
      undoRuns: async () => ({ undone: 0, left: 0, missing: 0, keptFields: [], otherKept: 0, errorMessage: null }),
    }, [{ path, objectId: binding.objectId, momentId: created.id, created: true }]);
    expect(result).toMatchObject({ restored: [], review: [{ path, reason: "changed-since", changedBy: "An unrecorded author" }] });
    expect(restore).not.toHaveBeenCalled();
    expect(await readFile(join(rootB, path), "utf8")).toContain("OwnerNote: Owner text");
    expect(await readFile(join(rootB, path), "utf8")).toContain("Name: Recipient text");
    await hosted.close({ settle: false });
  } finally {
    doc.destroy();
    await peer?.close();
    try { await capture?.stop().catch(() => undefined); } finally { await owner?.close(); await relayServer.stop(); }
  }
}, 120_000);
