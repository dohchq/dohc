import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { relayAdoptedIdentity, spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import type { EngineRelayWorkspaceClient } from "./engineRelayClient";
import type { DesktopLinkedChatStore } from "./liveLinkedChatStore";
import {
  createWorkspaceEngineCapture,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import { waitForPathMoments } from "./waitForPathMoments";
import { createTestScratch } from "./testTemp";

const engine = requireEngineBinaryOrSkip();
const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): {
      all(...params: unknown[]): Array<Record<string, unknown>>;
    };
    close(): void;
  };
};

function relayYDocBases(dbPath: string, workspaceId: string): Array<{
  relaySeq: number;
  originId: string;
  updateBlobSha256: string;
}> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT relay_seq AS relaySeq, origin_id AS originId, payload_json AS payloadJson
         FROM sync_relay_log
         WHERE workspace_id = ? AND op_kind = 'ydoc.update'
         ORDER BY relay_seq`,
      )
      .all(workspaceId)
      .flatMap((row) => {
        if (
          typeof row.relaySeq !== "number" ||
          typeof row.originId !== "string" ||
          typeof row.payloadJson !== "string"
        ) {
          throw new Error("The relay returned a malformed Y.Doc log row.");
        }
        const payload: unknown = JSON.parse(row.payloadJson);
        if (
          typeof payload !== "object" ||
          payload === null ||
          !("isBaseState" in payload) ||
          payload.isBaseState !== true
        ) {
          return [];
        }
        if (
          !("updateBlobSha256" in payload) ||
          typeof payload.updateBlobSha256 !== "string"
        ) {
          throw new Error("The relay returned a malformed Y.Doc base payload.");
        }
        return [
          {
            relaySeq: row.relaySeq,
            originId: row.originId,
            updateBlobSha256: payload.updateBlobSha256,
          },
        ];
      });
  } finally {
    db.close();
  }
}

function localConflictOrigin(rootPath: string, workspaceId: string): string | null {
  const db = new DatabaseSync(join(rootPath, ".dohc", "engine", "engine.db"), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare(
        `SELECT metadata_origin AS metadataOrigin
         FROM conflicts
         WHERE workspace_id = ? AND status = 'open'
         ORDER BY conflict_id
         LIMIT 1`,
      )
      .all(workspaceId)[0];
    if (row === undefined) return null;
    if (typeof row.metadataOrigin !== "string") {
      throw new Error("The engine returned malformed conflict provenance.");
    }
    return row.metadataOrigin;
  } finally {
    db.close();
  }
}

interface LiveDaemonCapture {
  capture: WorkspaceEngineCapture;
  chats: DesktopLinkedChatStore;
  relay: EngineRelayWorkspaceClient;
  close(): Promise<void>;
}

async function openLiveDaemonCapture(input: {
  workspaceId: string;
  rootPath: string;
  relay: { baseUrl: string; token: string };
}): Promise<LiveDaemonCapture> {
  const workspace = await openLiveDaemonWorkspace(input, { maxRestarts: 0 });
  const capture = createWorkspaceEngineCapture({
    workspaceId: input.workspaceId,
    rootPath: input.rootPath,
    rustEngineSessions: workspace.sessions,
    daemonOwnsCapture: true,
  });
  const relay = workspace.relay.bind(input);
  return {
    capture,
    chats: workspace.chats,
    relay,
    close: async () => {
      try {
        await capture.stop();
      } finally {
        await workspace.close();
      }
    },
  };
}

async function expectTwoDaemonFileSync(input: {
  workspaceId: string;
  path: string;
  text: string;
  contentKind?: "text" | "binary";
}): Promise<void> {
  const token = `test:${input.workspaceId}`;
  // Both roots are opened exclusively through EngineWorkspaceSessions (via
  // openLiveDaemonWorkspace/openLiveDaemonCapture), which writes each root's
  // `.dohc/engine/SHADOW_CLONE` marker itself before the first RPC touches it
  // (engineWorkspaceSessions.ts's `prepareWorkspace`). Unlike suites that talk
  // to the engine outside that path, this harness never needs to seed the
  // marker by hand.
  const rootA = await createTestScratch("dohc-two-daemon-a-");
  const rootB = await createTestScratch("dohc-two-daemon-b-");
  const relayRoot = await createTestScratch("dohc-two-daemon-relay-");
  const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite") });
  let daemonA: LiveDaemonCapture | null = null;
  let daemonB: LiveDaemonCapture | null = null;
  try {
    daemonA = await openLiveDaemonCapture({
      workspaceId: input.workspaceId,
      rootPath: rootA,
      relay: { baseUrl: relay.baseUrl, token },
    });
    await daemonA.relay.claim();
    const identity = relayAdoptedIdentity(relay.dbPath, input.workspaceId);
    if (identity === null) {
      throw new Error("The relay did not adopt daemon A's replication identity.");
    }

    // A successful relay position makes later file moments relay-visible.
    // Chat creation always journals, so it can establish that position before
    // the first file initializes the versioned workspace.
    await daemonA.chats.ensureGeneralChannel({ workspaceId: input.workspaceId });
    const bootstrapPush = await daemonA.relay.push();
    expect(bootstrapPush.pushed).toBeGreaterThan(0);

    const absoluteA = join(rootA, input.path);
    await mkdir(dirname(absoluteA), { recursive: true });
    await writeFile(absoluteA, input.text, "utf8");
    // Registry maintenance, not the moment's source: under daemonOwnsCapture
    // the real capture write comes from the daemon's own filesystem watcher,
    // proven by removing this call and watching the moment still arrive.
    daemonA.capture.captureBatch([{ path: input.path, operation: "update" }]);
    await waitForPathMoments(daemonA.capture, input.path, 1);

    const push = await daemonA.relay.push();
    expect(push.pushed).toBeGreaterThan(0);

    daemonB = await openLiveDaemonCapture({
      workspaceId: input.workspaceId,
      rootPath: rootB,
      relay: { baseUrl: relay.baseUrl, token },
    });
    const relayB = daemonB.relay;
    // A join normally creates its empty main version before the first pull.
    await daemonB.capture.listVersions();
    await relayB.bootstrapJoinIdentity(identity);

    const pull = await daemonB.capture.runRelaySync(() => relayB.pull());
    expect(pull.applied).toBeGreaterThan(0);
    if (input.contentKind !== undefined) {
      expect(pull.fastForwardedPaths).toContainEqual({
        path: input.path,
        operation: "write",
        contentKind: input.contentKind,
      });
    }
    expect(await readFile(join(rootB, input.path), "utf8")).toBe(input.text);

    const moments = await daemonB.capture.listMoments({ limit: 100 });
    expect(moments.moments.some((moment) => moment.path === input.path)).toBe(true);
  } finally {
    await daemonB?.close().catch(() => undefined);
    await daemonA?.close().catch(() => undefined);
    await relay.stop();
  }
}

it.skipIf(engine.missing)(
  "syncs a captured file between two real daemons through one real relay",
  async () =>
    await expectTwoDaemonFileSync({
      workspaceId: "two-daemon-sync",
      path: "notes/hello.md",
      text: "hello from daemon A\n",
      contentKind: "text",
    }),
  60_000,
);

it.skipIf(engine.missing)(
  "arbitrates independent bases by relay order and preserves the loser as a conflict",
  async () => {
    const workspaceId = "two-daemon-base-arbitration";
    const token = `test:${workspaceId}`;
    const path = "notes/shared.md";
    const winnerText = "created first on daemon A\n";
    const loserText = "created independently on daemon B\n";
    const rootA = await createTestScratch("dohc-base-arbitration-a-");
    const rootB = await createTestScratch("dohc-base-arbitration-b-");
    const relayRoot = await createTestScratch("dohc-base-arbitration-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite") });
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    try {
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: { baseUrl: relay.baseUrl, token },
      });
      await daemonA.relay.claim();
      const identity = relayAdoptedIdentity(relay.dbPath, workspaceId);
      if (identity === null) {
        throw new Error("The relay did not adopt daemon A's replication identity.");
      }
      await daemonA.chats.ensureGeneralChannel({ workspaceId });
      expect((await daemonA.relay.push()).pushed).toBeGreaterThan(0);

      daemonB = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: { baseUrl: relay.baseUrl, token },
      });
      await daemonB.capture.listVersions();
      await daemonB.relay.bootstrapJoinIdentity(identity);
      await daemonB.capture.runRelaySync(() => daemonB!.relay.pull());

      const absoluteA = join(rootA, path);
      const absoluteB = join(rootB, path);
      await Promise.all([
        mkdir(dirname(absoluteA), { recursive: true }),
        mkdir(dirname(absoluteB), { recursive: true }),
      ]);
      await writeFile(absoluteA, "", "utf8");
      daemonA.capture.captureBatch([{ path, operation: "update" }]);
      await waitForPathMoments(daemonA.capture, path, 1);
      await writeFile(absoluteB, "", "utf8");
      daemonB.capture.captureBatch([{ path, operation: "update" }]);
      await waitForPathMoments(daemonB.capture, path, 1);

      const createIndependentBase = async (
        daemon: LiveDaemonCapture,
        text: string,
      ): Promise<void> => {
        const session = await daemon.capture.openYDocSession({
          path,
          onRemoteUpdate: () => undefined,
        });
        const editor = new Y.Doc();
        Y.applyUpdate(editor, session.initialUpdate);
        const before = Y.encodeStateVector(editor);
        editor.getText("plainText").insert(0, text);
        await session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
        await session.settleNow();
        await session.close();
      };
      await createIndependentBase(daemonA, winnerText);
      await createIndependentBase(daemonB, loserText);

      // A's base commits first, so its lineage owns this path coordinate.
      expect((await daemonA.relay.push()).pushed).toBeGreaterThan(0);
      expect((await daemonB.relay.push()).pushed).toBeGreaterThan(0);
      const bases = relayYDocBases(relay.dbPath, workspaceId);
      expect(bases).toHaveLength(2);
      expect(bases[0]?.originId).not.toBe(bases[1]?.originId);
      expect(bases[0]?.updateBlobSha256).not.toBe(bases[1]?.updateBlobSha256);

      await daemonA.capture.runRelaySync(() => daemonA!.relay.pull());
      await daemonB.capture.runRelaySync(() => daemonB!.relay.pull());

      expect(await readFile(absoluteA, "utf8")).toBe(winnerText);
      expect(await readFile(absoluteB, "utf8")).toBe(winnerText);

      const conflicts = await daemonB.capture.listOpenConflictsPage();
      const conflict = conflicts.conflicts.find((candidate) => candidate.path === path);
      expect(conflict).toBeDefined();
      expect(localConflictOrigin(rootB, workspaceId)).toBe("sync-independent-origin");
      expect(conflict?.metadata.origin).toBe("sync-independent-origin");
      expect(conflict?.base.exists).toBe(false);
      expect(conflict?.current.text).toBe(loserText);
      expect(conflict?.incoming.text).toBe(winnerText);
    } finally {
      await daemonB?.close().catch(() => undefined);
      await daemonA?.close().catch(() => undefined);
      await relay.stop();
    }
  },
  90_000,
);

// KNOWN GAP (#356): the secret applier reports no materialization change, and
// a fresh daemon B has no root-local secret key to decrypt A's replicated
// ciphertext. The key-envelope join flow must install that key before this
// materializing path can become an active acceptance case.
it.skip(
  "syncs a captured secret file between two real daemons through one real relay",
  async () =>
    await expectTwoDaemonFileSync({
      workspaceId: "two-daemon-secret-sync",
      path: ".env",
      text: "TOKEN=two-daemon-secret\n",
    }),
  60_000,
);
