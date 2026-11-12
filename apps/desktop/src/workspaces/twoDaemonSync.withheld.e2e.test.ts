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

import { openEngineYdocProviderSession, VersionedLiveAdapter, WorkspaceDaemonRequester } from "@dohc/workspace-engine-client";

import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";

import { REAL_DAEMON_DEADLINE_MS } from "../testing/realDaemonWorkspaceSessions";

import { createWorkspaceEngineCapture, type WorkspaceEngineCapture } from "./workspaceEngineCapture";

import { createTestScratch } from "./testTemp";
import { deferred } from "../testing/deferred";
import { SECRET_FILE_STORE_RELATIVE_PATH } from "./workspaceDataKey";

import { createRelaySyncEngine, type CloudSyncEngine } from "./relaySyncEngine";
import { createRelayLogWait } from "./relayLogWait";
import { selfHostLiveProfile } from "../../../../services/sync-relay/src/selfHostLiveProfile";

import { engine, compiledRelayMain, LiveDaemonCapture, pullCaptured, pushUntilDrained, openLiveDaemonCapture, openJoinedDaemonCapture, writeAndCapture, openIndependentPlaintextLineage, pullAndExpect, OpenEditor, openEditor, typeAtEnd, shown } from "./twoDaemonSync.fixture";

it.skipIf(engine.missing)("keeps a journaled sharing-declined lineage private and wakes again for a shareable edit", async () => {
  const workspaceId = "watched-withheld", token = `test:${workspaceId}`;
  const root = await createTestScratch("dohc-watched-withheld-");
  const relayRoot = await createTestScratch("dohc-watched-withheld-relay-");
  const dbPath = join(relayRoot, "relay", "relay.sqlite"), path = "withheld.txt";
  const relay = await spawnSyncRelay({dbPath, compiledMain: compiledRelayMain});
  const connection = {baseUrl: relay.baseUrl, token};
  const source = await openLiveDaemonWorkspace({workspaceId, rootPath: root}, {maxRestarts: 0});
  const capture = createWorkspaceEngineCapture({...source.workspace, rustEngineSessions: source.sessions});
  const operations = source.relay.bind({...source.workspace, relay: connection});
  let withheld: Awaited<ReturnType<typeof openEngineYdocProviderSession>> | undefined;
  let editor: OpenEditor | undefined, sync: CloudSyncEngine | undefined;
  const doc = new Y.Doc();
  try {
    // Configure the relay binding before opening document sessions.
    await operations.probe().catch(error => {
      // The test relay has no workspace until claim. The request still pins
      // the transport, avoiding a workspace rebind under the provider lease.
      expect(error).toMatchObject({wireCode: "RELAY_INVALID_RESPONSE"});
    });
    await writeFile(join(root, "public.txt"), "shared base\n");
    capture.observeFileEvents([{path: "public.txt", operation: "update"}]); await capture.flush();
    const versionId = (await capture.listVersions()).versions.find(version => version.kind === "main")!.id;
    withheld = await source.sessions.run(source.workspace, ({workspace}) => openEngineYdocProviderSession({
      transport: source.nativeClient(), workspace, versionId, path, contentKind: "plaintext", seedAbsentLineage: true,
      onRemoteUpdate: () => {}, scheduleSettle: () => () => {},
    }));
    Y.applyUpdate(doc, withheld.initialUpdate);
    let appendIndex = 0, claim = withheld.lineageClaimId ?? null;
    const append = async (text: string) => {
      const vector = Y.encodeStateVector(doc), body = doc.getText("plainText");
      body.insert(body.length, text);
      // The large-base fixture bypasses the client's size-sensitive base64
      // validator, while retaining the real daemon journal and push policy.
      const result = await source.sessions.run(source.workspace, ({workspace}) =>
        new WorkspaceDaemonRequester(source.nativeClient()).request("ydoc.recordUpdate", {
          sessionId: withheld!.nativeOwner!.sessionId,
          updateBase64: Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString("base64"),
          expectedLineageClaimId: claim,
        }, {workspace, idempotencyKey: `withheld-${appendIndex++}`})) as {seq: number; lineageClaimId: string | null};
      expect(result).toHaveProperty("seq");
      claim = result.lineageClaimId;
    };
    // Three legal deltas make a base larger than MAX_YDOC_UPDATE_BYTES (20 MiB).
    // They are durable in the local Y.Doc journal before this workspace enrolls.
    for (let index = 0; index < 3; index++) await append(`WITHHELD-PRIVATE-${index}` + "x".repeat(7 * 1024 * 1024));
    // Enrollment defers live leases. Release this one without projecting its
    // oversized body so the real sync policy evaluates and declines the base.
    await withheld.evict();
    const local = new DatabaseSync(join(root, SECRET_FILE_STORE_RELATIVE_PATH), {readOnly: true});
    const privateDigests = () => local.prepare("SELECT update_blob_sha256 AS sha FROM ydoc_updates WHERE workspace_id=? AND object_id=? AND is_seed=0").all(workspaceId, withheld!.objectId!) as Array<{sha: string}>;
    try {
      expect(privateDigests().length).toBeGreaterThanOrEqual(3);
      let report!: (value: {hasMore: boolean; watched: boolean}) => void;
      const pushes: Array<{pushed: number}> = [];
      const subscribe = vi.spyOn(capture, "onDurableLocalChange");
      sync = createRelaySyncEngine({rootDir: root, relay: connection, capture, onChange: () => {},
        operations: {...operations, push: async () => {const result = await operations.push(); pushes.push(result); return result;}},
        waitForChange: (_since, signal) => new Promise((resolve, reject) => {
          report = resolve; signal.addEventListener("abort", () => reject(signal.reason), {once: true});
        })});
      await sync.start();
      expect(sync.snapshot().syncFailure).toBeNull();
      const marker = local.prepare("SELECT file_export_lane,sharing_declined_json FROM ydoc_docs WHERE workspace_id=? AND object_id=?").get(workspaceId, withheld.objectId!) as {file_export_lane: number; sharing_declined_json: string};
      expect(marker.file_export_lane).toBe(1);
      expect(JSON.parse(marker.sharing_declined_json)).toMatchObject({constraint: "MAX_YDOC_UPDATE_BYTES"});
      await vi.waitFor(() => expect(report).toBeTypeOf("function")); report({hasMore: false, watched: true});
      await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
      const before = pushes.length;
      sync.queueWatchedUpload();
      await vi.waitFor(() => expect(pushes.length).toBeGreaterThan(before));
      expect(pushes.at(-1)!.pushed).toBe(0);
      const afterEmpty = pushes.length;
      // Use the real workspace durable hook for the next, shareable lineage.
      editor = await openEditor({capture}, "public.txt");
      const vector = Y.encodeStateVector(editor.doc); editor.doc.getText("plainText").insert(0, "public edit ");
      await editor.session.applyDecidedLocalUpdate(() => Y.encodeStateAsUpdate(editor!.doc, vector));
      await vi.waitFor(() => expect(pushes.slice(afterEmpty).some(result => result.pushed > 0)).toBe(true));
      const remote = new DatabaseSync(dbPath, {readOnly: true});
      try {
        const rows = remote.prepare("SELECT payload_json FROM sync_relay_log WHERE workspace_id=?").all(workspaceId);
        expect(JSON.stringify(rows)).not.toContain(path);
        expect(JSON.stringify(rows)).not.toContain("WITHHELD-PRIVATE");
      } finally {remote.close();}
      for (const {sha} of privateDigests()) {
        const response = await fetch(`${relay.baseUrl}/blobs/${sha}`, {headers: {Authorization: `Bearer ${token}`}});
        expect(response.status).toBe(404);
        await response.body?.cancel();
      }
    } finally {local.close();}
  } finally {
    try {
      await sync?.stop();
      await Promise.allSettled([withheld?.evict(), editor?.session.close({settle: false})]);
      editor?.doc.destroy(); doc.destroy();
      await capture.stop();
    } finally {await source.close(); await relay.stop();}
  }
}, 120_000);
