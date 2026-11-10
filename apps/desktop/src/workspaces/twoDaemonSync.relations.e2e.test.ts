import { createHash } from "node:crypto";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { DatabaseSync } from "node:sqlite";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseFrontmatter } from "@dohc/ydoc-projection/frontmatter";
import { VersionedLiveAdapter, YdocLiveAdapter } from "@dohc/workspace-engine-client";
import { mintLocalhostCa } from "../../../../services/share-web/src/testing/localhostCa";
import { selfHostLiveProfile } from "../../../../services/sync-relay/src/selfHostLiveProfile";
import { startServerProxy } from "../../e2e/helpers/selfHostOnboarding";
import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";
import { createWorkspaceEngineCapture, type WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { createTestScratch } from "./testTemp";
import { SECRET_FILE_STORE_RELATIVE_PATH } from "./workspaceDataKey";
import { readyOwnerDeliveryDocuments } from "./serverOwnerDelivery";
import { engine, compiledRelayMain, type LiveDaemonCapture, pullCaptured, openLiveDaemonCapture, openJoinedDaemonCapture, pullAndExpect } from "./twoDaemonSync.fixture";

it.skipIf(engine.missing)(
  "delivers never-opened relation cleanup to a recipient and preserves it after restart",
  async () => {
    const workspaceId = "never-opened-relation-delivery";
    const rootA = await createTestScratch("dohc-relation-owner-");
    const rootB = await createTestScratch("dohc-relation-recipient-");
    const relayRoot = await createTestScratch("dohc-relation-relay-");
    const ca = await mintLocalhostCa(relayRoot);
    const previousRoots = getCACertificates("default");
    setDefaultCACertificates([...previousRoots, ca.ca]);
    const trustEnv = {
      NODE_EXTRA_CA_CERTS: ca.caPath,
      DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
      DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath,
      DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0",
    };
    for (const [name, value] of Object.entries(trustEnv)) vi.stubEnv(name, value);
    const proxy = await startServerProxy(ca);
    let relayServer: Awaited<ReturnType<typeof spawnSyncRelay>> | undefined;
    let owner: Awaited<ReturnType<typeof openLiveDaemonWorkspace>> | undefined;
    let capture: WorkspaceEngineCapture | undefined;
    let recipient: LiveDaemonCapture | undefined;
    const path = "tasks/source.md";
    const sourceId = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const targetId = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    const original = `---\nid: ${sourceId}\nrelated: ${targetId}\ntitle: Keep\n---\n\n# Body stays intact`;
    const cleared = original.replace(`related: ${targetId}\n`, "");
    try {
      relayServer = await spawnSyncRelay({
        dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain,
        editLinks: { engineExecutable: engine.require(), publicOrigin: proxy.origin, trustEnv },
        linkBoundary: { linkKey: "relation-link-key-".repeat(3), relayExchangeKey: "relation-exchange-key-".repeat(3),
          publicViewerOrigin: proxy.origin },
      });
      proxy.routeRelayTo(relayServer.baseUrl);
      const connection = { baseUrl: proxy.origin, token: `test:${workspaceId}` };
      const profile = selfHostLiveProfile();
      const nativeConfigPath = join(rootA, "owner-ingress.json");
      await writeFile(nativeConfigPath, JSON.stringify(profile.nativeIngress));
      const openOwner = () => openLiveDaemonWorkspace({ workspaceId, rootPath: rootA }, {
        maxRestarts: 0, allowInsecureLoopbackForTests: false,
        privateOwnerHost: { configPath: nativeConfigPath, client: profile.nativeClient },
      });
      owner = await openOwner();
      await owner.chats.ensureGeneralChannel({ workspaceId });
      const adapterOf = (source: NonNullable<typeof owner>) => source.sessions.run(source.workspace,
        async ({ client, workspace }) => new VersionedLiveAdapter(client, workspace, { workspaceId }));
      let adapter = await adapterOf(owner);
      await adapter.ensureMainVersion({ workspaceId });
      for (const [filePath, text] of [
        ["tasks/collection.yaml", "fields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n  title:\n    type: text\n"],
        ["tasks/target.md", `---\nid: ${targetId}\n---\n\nTarget`],
        [path, original],
      ]) {
        await adapter.writeTextFile({ workspaceId, versionId: "main", path: filePath!, text: text!,
          publish: true, metadata: { origin: "api" } });
      }
      await expect.poll(async () => (await adapter.listPendingCollectionAdoptions()).adoptions.length,
        { timeout: REAL_DAEMON_DEADLINE_MS }).toBe(2);
      capture = createWorkspaceEngineCapture({ ...owner.workspace, rustEngineSessions: owner.sessions });
      await expect.poll(async () => {
        await capture!.flush();
        return (await adapter.listPendingCollectionAdoptions()).adoptions;
      }, { timeout: REAL_DAEMON_DEADLINE_MS }).toEqual([]);
      // Background adoption establishes the bindings without an editor open.
      // Close the covered local-only lineages through the engine's prune path.
      await owner.sessions.run(owner.workspace, async ({ workspace }) => {
        const ydocs = new YdocLiveAdapter(owner!.nativeClient());
        try {
          for (const filePath of [path, "tasks/target.md"]) {
            const session = await ydocs.openSession({ workspace, versionId: "main", path: filePath,
              contentKind: "richdoc", seedAbsentLineage: false });
            try { expect(session.lineage).toBe("existing"); } finally { await session.close(); }
          }
        } finally { ydocs.dispose(); }
      });
      await capture.stop();
      capture = undefined;
      await owner.close();
      owner = undefined;
      const db = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), { readOnly: true });
      try {
        expect(db.prepare("SELECT record_id,file_path,adoption_state FROM collection_records WHERE workspace_id=? ORDER BY file_path")
          .all(workspaceId)).toEqual([
            { record_id: sourceId, file_path: path, adoption_state: "adopted" },
            { record_id: targetId, file_path: "tasks/target.md", adoption_state: "adopted" },
          ]);
        expect(db.prepare("SELECT COUNT(*) AS count FROM ydoc_updates").get()).toEqual({ count: 0 });
        expect(db.prepare("SELECT path,regime,head_update_seq,head_snapshot_seq FROM ydoc_docs WHERE workspace_id=? AND path IN (?,?) ORDER BY path")
          .all(workspaceId, path, "tasks/target.md")).toEqual([
            { path, regime: "local-only", head_update_seq: 0, head_snapshot_seq: 0 },
            { path: "tasks/target.md", regime: "local-only", head_update_seq: 0, head_snapshot_seq: 0 },
          ]);
      } finally { db.close(); }
      owner = await openOwner();
      const relay = owner.relay.bind({ ...owner.workspace, relay: connection });
      await relay.claim();
      await relay.push();
      adapter = await adapterOf(owner);
      await expect.poll(async () => {
        await adapter.reconcileCapture();
        const indexed = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), { readOnly: true });
        try {
          return indexed.prepare("SELECT COUNT(*) AS count FROM collection_relation_edges WHERE source_record_id=? AND target_record_id=?")
            .get(sourceId, targetId);
        } finally { indexed.close(); }
      }, { timeout: REAL_DAEMON_DEADLINE_MS }).toEqual({ count: 1 });
      const share = await fetch(`${proxy.origin}/sync/${workspaceId}/shares`, {
        method: "POST", headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
        body: JSON.stringify({ recipientEmail: "relation-recipient@dohc.test", paths: [path], access: "edit" }),
      });
      expect(share.status).toBe(200);
      const { shareId } = await share.json() as { shareId: string };
      const neverOpened = new DatabaseSync(join(rootA, SECRET_FILE_STORE_RELATIVE_PATH), { readOnly: true });
      try {
        expect(neverOpened.prepare("SELECT COUNT(*) AS count FROM ydoc_updates").get()).toEqual({ count: 0 });
      } finally { neverOpened.close(); }
      recipient = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: connection });
      await pullAndExpect(recipient, rootB, path, original);

      const { holdId } = await adapter.holdCapture();
      try {
        await rm(join(rootA, "tasks/target.md"));
        await adapter.deleteTextFile({ workspaceId, versionId: "main", path: "tasks/target.md",
          metadata: { origin: "api" }, captureHoldId: holdId, onlyIfAbsentOnDisk: true });
      } finally { await adapter.releaseCapture(holdId); }
      await expect.poll(async () => {
        await adapter.reconcileCapture();
        return readFile(join(rootA, path), "utf8");
      }, { timeout: REAL_DAEMON_DEADLINE_MS }).toBe(cleared);
      expect((await relay.push()).sharingDeclined).toEqual([]);
      const enrollment = await fetch(`${proxy.origin}/sync/${workspaceId}/live-host`, {
        method: "POST", headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
        body: JSON.stringify({ shareId }),
      });
      expect([200, 202]).toContain(enrollment.status);
      let discoveryPayload: unknown;
      await expect.poll(async () => {
        const response = await fetch(`${proxy.origin}/sync/${workspaceId}/live-host`, {
          headers: { authorization: `Bearer ${connection.token}` },
        });
        expect(response.status).toBe(200);
        discoveryPayload = await response.json();
        return readyOwnerDeliveryDocuments(discoveryPayload, workspaceId).map(document => document.binding.currentPath);
      }, { timeout: 120_000 }).toEqual([path]).catch(error => {
        throw new Error(JSON.stringify({ discoveryPayload, diagnostics: relayServer!.diagnostics() }), { cause: error });
      });
      expect(JSON.stringify(relayServer.diagnostics())).not.toContain("invalid-schema");
      capture = createWorkspaceEngineCapture({ ...owner.workspace, rustEngineSessions: owner.sessions });
      await pullCaptured(relay, capture);
      await relay.push();
      const assertRecipientState = async () => {
        const markdown = await readFile(join(rootB, path), "utf8");
        expect(markdown).toBe(cleared);
        expect(parseFrontmatter(markdown, false).meta).toEqual({ id: sourceId, title: "Keep" });
        await expect.poll(async () => {
          const query = await recipient!.queryCollectionRecords({ collectionPath: "tasks", resolveRelations: true });
          const record = query.records.find(record => record.id === sourceId);
          return record && {
            id: record.id, path: record.path, conflicted: record.conflicted,
            related: record.values.find(value => value.field === "related"),
            title: record.values.find(value => value.field === "title"),
          };
        }, { timeout: REAL_DAEMON_DEADLINE_MS }).toMatchObject({
          id: sourceId, path, conflicted: false, related: undefined, title: { value: "Keep" },
        });
        expect(await recipient!.refusalNotices()).toEqual({ notices: [] });
        expect(await recipient!.capture.countOpenConflicts()).toBe(0);
      };
      const assertRecipient = async () => {
        const headers = { authorization: "Bearer test:relation-recipient" };
        const digest = createHash("sha256").update(cleared).digest("hex");
        await expect.poll(async () => {
          await relay.pull(apply => capture!.runRelaySync(apply));
          await relay.push();
          const log = await fetch(`${proxy.origin}/sync/shares/${shareId}/log?since=0&limit=500`, { headers });
          expect(log.status).toBe(200);
          return log.json();
        }, { timeout: 120_000 }).toMatchObject({ ops: expect.arrayContaining([
          expect.objectContaining({ opKind: "moment.append", payload: expect.objectContaining({ payloadAfterBlobSha256: digest }) }),
        ]) });
        const blob = await fetch(`${proxy.origin}/sync/shares/${shareId}/blobs/${digest}`, { headers });
        expect(blob.status).toBe(200);
        expect(await blob.text()).toBe(cleared);
        await expect.poll(async () => {
          await recipient!.relay.pull(apply => recipient!.capture.runRelaySync(apply));
          const markdown = await readFile(join(rootB, path), "utf8");
          const query = await recipient!.queryCollectionRecords({ collectionPath: "tasks", resolveRelations: true });
          const record = query.records.find(record => record.id === sourceId);
          return { markdown, recordId: record?.id, related: record?.values.find(value => value.field === "related") };
        }, { timeout: 120_000 }).toEqual({ markdown: cleared, recordId: sourceId, related: undefined });
        await assertRecipientState();
      };
      await assertRecipient();
      await recipient.close();
      recipient = await openLiveDaemonCapture({ workspaceId, rootPath: rootB, relay: connection });
      await assertRecipientState();
      await assertRecipient();
    } finally {
      await recipient?.close();
      try { await capture?.stop(); } finally {
        await owner?.close();
        await relayServer?.stop();
        await proxy.close();
        setDefaultCACertificates(previousRoots);
        vi.unstubAllEnvs();
      }
    }
  },
  240_000,
);

