import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import type { EngineRelayWorkspaceClient } from "./engineRelayClient";
import type { DesktopLinkedChatStore } from "./liveLinkedChatStore";
import { probeRelayWorkspace } from "./relayWorkspaceProbe";
import {
  createWorkspaceEngineCapture,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import { waitForPathMoments } from "./waitForPathMoments";
import { createTestScratch } from "./testTemp";
import {
  installWorkspaceDataKey,
  loadSecretDataKey,
  SECRET_FILE_STORE_RELATIVE_PATH,
} from "./workspaceDataKey";
import { enrollWorkspaceKeyEnvelope } from "./workspaceKeyEnvelopeEnrollment";
import { bootstrapJoinedWorkspace } from "./workspaceJoinEnrollment";
import { createRelaySyncEngine, type CloudSyncEngine } from "./relaySyncEngine";

const engine = requireEngineBinaryOrSkip();

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
    ...workspace.workspace,
    rustEngineSessions: workspace.sessions,
  });
  const relay = workspace.relay.bind({
    ...workspace.workspace,
    relay: input.relay,
  });
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

async function openJoinedDaemonCapture(input: {
  workspaceId: string;
  rootPath: string;
  relay: { baseUrl: string; token: string };
  passphrase?: string;
}): Promise<LiveDaemonCapture> {
  const workspace = await openLiveDaemonWorkspace(input, { maxRestarts: 0 });
  const relay = workspace.relay.bind({
    ...workspace.workspace,
    relay: input.relay,
  });
  const probe = await probeRelayWorkspace({
    workspaceId: input.workspaceId,
    relay: input.relay,
  });
  try {
    await bootstrapJoinedWorkspace({
      workspaceId: input.workspaceId,
      identity: probe.identity,
      ...(input.passphrase === undefined
        ? {}
        : { passphrase: input.passphrase }),
      transport: relay,
      installDataKey: async (key) =>
        await installWorkspaceDataKey(input.rootPath, key),
    });
  } catch (error) {
    await workspace.close().catch(() => undefined);
    throw error;
  }
  const capture = createWorkspaceEngineCapture({
    ...workspace.workspace,
    rustEngineSessions: workspace.sessions,
  });
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

async function writeAndCapture(
  daemon: LiveDaemonCapture,
  rootPath: string,
  path: string,
  contents: string | Buffer,
): Promise<void> {
  const before = (await daemon.capture.listMoments({ limit: 1_000 })).moments.filter(
    (moment) => moment.path === path,
  ).length;
  const absolute = join(rootPath, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
  daemon.capture.captureBatch([{ path, operation: "update" }]);
  await waitForPathMoments(daemon.capture, path, before + 1);
}

async function openIndependentPlaintextLineage(
  daemon: LiveDaemonCapture,
  rootPath: string,
  path: string,
  text: string,
) {
  const absolute = join(rootPath, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, "");
  const session = await daemon.capture.openYDocSession({
    path,
    contentKind: "plaintext",
    onRemoteUpdate: () => undefined,
  });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, session.initialUpdate);
  const before = Y.encodeStateVector(doc);
  doc.getText("plainText").insert(0, text);
  session.applyLocalUpdate(Y.encodeStateAsUpdate(doc, before));
  await session.settleNow();
  return session;
}

async function pullAndExpect(
  daemon: LiveDaemonCapture,
  rootPath: string,
  path: string,
  contents: string | Buffer,
  contentKind?: "text" | "binary",
): Promise<void> {
  const pull = await daemon.capture.runRelaySync((materializePage) =>
    daemon.relay.pull(materializePage),
  );
  expect(pull.applied).toBeGreaterThan(0);
  if (contentKind !== undefined) {
    expect(pull.fastForwardedPaths).toContainEqual({
      versionId: "main",
      path,
      operation: "write",
      contentKind,
    });
  }
  expect(await readFile(join(rootPath, path))).toEqual(Buffer.from(contents));
}

async function expectTwoDaemonFileSync(input: {
  workspaceId: string;
  path: string;
  contents: string | Buffer;
  contentKind?: "text" | "binary";
  bootstrapRelayBeforeCapture?: boolean;
  passphrase?: string;
  reverse?: { path: string; contents: string | Buffer };
  restart?: { contents: string | Buffer };
  rejoin?: boolean;
}): Promise<void> {
  const token = `test:${input.workspaceId}`;
  // Both roots are opened through EngineWorkspaceSessions (via
  // openLiveDaemonWorkspace/openLiveDaemonCapture); the daemon binds each
  // root to its database on first open.
  const rootA = await createTestScratch("dohc-two-daemon-a-");
  const rootB = await createTestScratch("dohc-two-daemon-b-");
  const rootC = await createTestScratch("dohc-two-daemon-c-");
  const relayRoot = await createTestScratch("dohc-two-daemon-relay-");
  const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite") });
  let daemonA: LiveDaemonCapture | null = null;
  let daemonB: LiveDaemonCapture | null = null;
  let daemonC: LiveDaemonCapture | null = null;
  try {
    daemonA = await openLiveDaemonCapture({
      workspaceId: input.workspaceId,
      rootPath: rootA,
      relay: { baseUrl: relay.baseUrl, token },
    });
    await daemonA.relay.claim();
    if (input.passphrase !== undefined) {
      const key = await loadSecretDataKey(rootA, { createIfMissing: true });
      await enrollWorkspaceKeyEnvelope({
        workspaceId: input.workspaceId,
        dataKey: key,
        passphrase: input.passphrase,
        transport: daemonA.relay,
        installDataKey: async () => {
          throw new Error("The source workspace must not reinstall its key.");
        },
      });
    }

    if (input.bootstrapRelayBeforeCapture !== false) {
      // A successful relay position makes later file moments relay-visible.
      // Chat creation always journals, so it can establish that position before
      // the first file initializes the versioned workspace.
      await daemonA.chats.ensureGeneralChannel({ workspaceId: input.workspaceId });
      const bootstrapPush = await daemonA.relay.push();
      expect(bootstrapPush.pushed).toBeGreaterThan(0);
    }

    await writeAndCapture(daemonA, rootA, input.path, input.contents);

    const push = await daemonA.relay.push();
    expect(push.pushed).toBeGreaterThan(0);

    daemonB = await openJoinedDaemonCapture({
      workspaceId: input.workspaceId,
      rootPath: rootB,
      relay: { baseUrl: relay.baseUrl, token },
      ...(input.passphrase === undefined
        ? {}
        : { passphrase: input.passphrase }),
    });
    await pullAndExpect(
      daemonB,
      rootB,
      input.path,
      input.contents,
      input.contentKind,
    );

    const moments = await daemonB.capture.listMoments({ limit: 100 });
    expect(moments.moments.some((moment) => moment.path === input.path)).toBe(true);

    if (input.reverse) {
      await writeAndCapture(
        daemonB,
        rootB,
        input.reverse.path,
        input.reverse.contents,
      );
      expect((await daemonB.relay.push()).pushed).toBeGreaterThan(0);
      await pullAndExpect(
        daemonA,
        rootA,
        input.reverse.path,
        input.reverse.contents,
      );
    }

    if (input.restart) {
      await daemonB.close();
      daemonB = null;
      await writeAndCapture(daemonA, rootA, input.path, input.restart.contents);
      expect((await daemonA.relay.push()).pushed).toBeGreaterThan(0);
      daemonB = await openLiveDaemonCapture({
        workspaceId: input.workspaceId,
        rootPath: rootB,
        relay: { baseUrl: relay.baseUrl, token },
      });
      await pullAndExpect(
        daemonB,
        rootB,
        input.path,
        input.restart.contents,
        input.contentKind,
      );
    }

    if (input.rejoin) {
      daemonC = await openJoinedDaemonCapture({
        workspaceId: input.workspaceId,
        rootPath: rootC,
        relay: { baseUrl: relay.baseUrl, token },
        ...(input.passphrase === undefined
          ? {}
          : { passphrase: input.passphrase }),
      });
      await pullAndExpect(
        daemonC,
        rootC,
        input.path,
        input.restart?.contents ?? input.contents,
        input.contentKind,
      );
    }
  } finally {
    await daemonC?.close().catch(() => undefined);
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
      contents: "hello from daemon A\n",
      contentKind: "text",
      reverse: {
        path: "notes/reply.md",
        contents: "hello from daemon B\n",
      },
      restart: { contents: "hello after daemon B restarted\n" },
      rejoin: true,
    }),
  60_000,
);

it.skipIf(engine.missing)(
  "backfills a captured file when the first relay position follows capture",
  async () =>
    await expectTwoDaemonFileSync({
      workspaceId: "two-daemon-enrolment-window",
      path: "notes/before-first-push.md",
      contents: "captured before the first relay position\n",
      contentKind: "text",
      bootstrapRelayBeforeCapture: false,
    }),
  60_000,
);

it.skipIf(engine.missing)(
  "arbitrates independent Y.Doc bases without overwriting either document",
  async () => {
    const workspaceId = "two-daemon-independent-bases";
    const token = `test:${workspaceId}`;
    const path = "notes/shared.txt";
    const rootA = await createTestScratch("dohc-independent-base-a-");
    const rootB = await createTestScratch("dohc-independent-base-b-");
    const rootC = await createTestScratch("dohc-independent-base-c-");
    const relayRoot = await createTestScratch("dohc-independent-base-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite") });
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    let daemonC: LiveDaemonCapture | null = null;
    try {
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: { baseUrl: relay.baseUrl, token },
      });
      await daemonA.relay.claim();
      daemonB = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: { baseUrl: relay.baseUrl, token },
      });

      const sessionA = await openIndependentPlaintextLineage(
        daemonA,
        rootA,
        path,
        "winner from A\n",
      );
      const sessionB = await openIndependentPlaintextLineage(
        daemonB,
        rootB,
        path,
        "recovered from B\n",
      );
      expect((await daemonA.relay.push()).pushed).toBeGreaterThan(0);
      expect((await daemonB.relay.push()).pushed).toBeGreaterThan(0);

      // Both editors remain live. Each pull may persist the foreign base, but
      // it must not arbitrate behind the editor or change either projection.
      await daemonA.capture.runRelaySync((materializePage) =>
        daemonA!.relay.pull(materializePage),
      );
      await daemonB.capture.runRelaySync((materializePage) =>
        daemonB!.relay.pull(materializePage),
      );
      expect(await readFile(join(rootA, path), "utf8")).toBe("winner from A\n");
      expect(await readFile(join(rootB, path), "utf8")).toBe("recovered from B\n");

      // Close is the serialized replacement boundary. A was pushed first, so
      // its lower relay position owns the original path. B's full projection
      // becomes one ordinary recovered file before its lineage is purged.
      await sessionB.close({ settle: false });
      await sessionA.close({ settle: false });
      expect(await readFile(join(rootB, path), "utf8")).toBe("winner from A\n");
      const recoveredNames = (await readdir(join(rootB, "notes"))).filter(
        (name) => name.startsWith("shared (recovered ") && name.endsWith(".txt"),
      );
      expect(recoveredNames).toHaveLength(1);
      const recoveredPath = `notes/${recoveredNames[0]}`;
      expect(await readFile(join(rootB, recoveredPath), "utf8")).toBe(
        "recovered from B\n",
      );

      expect((await daemonB.relay.push()).pushed).toBeGreaterThan(0);
      await pullAndExpect(
        daemonA,
        rootA,
        recoveredPath,
        "recovered from B\n",
        "text",
      );
      expect(await readFile(join(rootA, path), "utf8")).toBe("winner from A\n");

      daemonC = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootC,
        relay: { baseUrl: relay.baseUrl, token },
      });
      await daemonC.capture.runRelaySync((materializePage) =>
        daemonC!.relay.pull(materializePage),
      );
      expect(await readFile(join(rootC, path), "utf8")).toBe("winner from A\n");
      expect(await readFile(join(rootC, recoveredPath), "utf8")).toBe(
        "recovered from B\n",
      );
    } finally {
      await daemonC?.close().catch(() => undefined);
      await daemonB?.close().catch(() => undefined);
      await daemonA?.close().catch(() => undefined);
      await relay.stop();
    }
  },
  90_000,
);

it.skipIf(engine.missing)(
  "reviews and settles concurrent offline edits between two real daemons",
  async () => {
    const workspaceId = "two-daemon-offline-conflict";
    const token = `test:${workspaceId}`;
    const path = "notes/offline.md";
    const rootA = await createTestScratch("dohc-offline-conflict-a-");
    const rootB = await createTestScratch("dohc-offline-conflict-b-");
    const relayRoot = await createTestScratch("dohc-offline-conflict-relay-");
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
      await daemonA.chats.ensureGeneralChannel({ workspaceId });
      expect((await daemonA.relay.push()).pushed).toBeGreaterThan(0);
      await writeAndCapture(daemonA, rootA, path, "shared base\n");
      expect((await daemonA.relay.push()).pushed).toBeGreaterThan(0);

      daemonB = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: { baseUrl: relay.baseUrl, token },
      });
      await pullAndExpect(daemonB, rootB, path, "shared base\n", "text");

      await writeAndCapture(daemonA, rootA, path, "edit from A\n");
      await writeAndCapture(daemonB, rootB, path, "edit from B\n");
      expect((await daemonA.relay.push()).pushed).toBeGreaterThan(0);
      expect((await daemonB.relay.push()).pushed).toBeGreaterThan(0);

      await daemonA.capture.runRelaySync((materializePage) =>
        daemonA!.relay.pull(materializePage),
      );
      const conflictPage = await daemonA.capture.listOpenConflictsPage();
      const conflict = conflictPage.conflicts.find((entry) => entry.path === path);
      expect(conflict).toBeDefined();
      expect(conflict?.current.text).toBe("edit from A\n");
      expect(conflict?.incoming.text).toBe("edit from B\n");
      expect(await readFile(join(rootA, path), "utf8")).toBe("edit from A\n");

      await daemonA.capture.resolveConflict(conflict!.id, {
        kind: "apply-incoming",
      });
      expect(await readFile(join(rootA, path), "utf8")).toBe("edit from B\n");
      expect(await daemonA.capture.countOpenConflicts()).toBe(0);
      expect((await daemonA.relay.push()).pushed).toBeGreaterThan(0);

      await daemonB.capture.runRelaySync((materializePage) =>
        daemonB!.relay.pull(materializePage),
      );
      expect(await readFile(join(rootB, path), "utf8")).toBe("edit from B\n");
      expect(await daemonB.capture.countOpenConflicts()).toBe(0);

      await daemonB.close();
      daemonB = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: { baseUrl: relay.baseUrl, token },
      });
      expect(await readFile(join(rootB, path), "utf8")).toBe("edit from B\n");
      expect(await daemonB.capture.countOpenConflicts()).toBe(0);
    } finally {
      await daemonB?.close().catch(() => undefined);
      await daemonA?.close().catch(() => undefined);
      await relay.stop();
    }
  },
  90_000,
);

it.skipIf(engine.missing)(
  "syncs a captured secret file between two real daemons through one real relay",
  async () =>
    await expectTwoDaemonFileSync({
      workspaceId: "two-daemon-secret-sync",
      path: ".env",
      contents: "TOKEN=two-daemon-secret\n",
      passphrase: "two-daemon protected-files passphrase",
      restart: { contents: "TOKEN=after-restart\n" },
      rejoin: true,
    }),
  90_000,
);

it.skipIf(engine.missing)(
  "preserves binary bytes through a real product join",
  async () =>
    await expectTwoDaemonFileSync({
      workspaceId: "two-daemon-binary-sync",
      path: "assets/payload.bin",
      contents: Buffer.from([0x00, 0xff, 0x80, 0x0a, 0x7f, 0x42]),
      contentKind: "binary",
    }),
  60_000,
);

it.skipIf(engine.missing)(
  "recovers a restored origin through the real relay without losing its local suffix",
  async () => {
    const workspaceId = "two-daemon-origin-recovery";
    const token = `test:${workspaceId}`;
    const rootA = await createTestScratch("dohc-origin-recovery-a-");
    const rootB = await createTestScratch("dohc-origin-recovery-b-");
    const relayRoot = await createTestScratch("dohc-origin-recovery-relay-");
    const backupRoot = await createTestScratch("dohc-origin-recovery-backup-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite") });
    const relayConnection = { baseUrl: relay.baseUrl, token };
    const engineDb = join(rootA, SECRET_FILE_STORE_RELATIVE_PATH);
    const backupDb = join(backupRoot, "engine.db");
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    try {
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: relayConnection,
      });
      await daemonA.relay.claim();
      await daemonA.chats.ensureGeneralChannel({ workspaceId });
      expect((await daemonA.relay.push()).pushed).toBeGreaterThan(0);
      await writeAndCapture(daemonA, rootA, "notes/base.md", "base\n");
      expect((await daemonA.relay.push()).pushed).toBeGreaterThan(0);
      await daemonA.close();
      daemonA = null;
      await copyFile(engineDb, backupDb);

      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: relayConnection,
      });
      await writeAndCapture(
        daemonA,
        rootA,
        "notes/relay-ahead.md",
        "relay is ahead of the backup\n",
      );
      expect((await daemonA.relay.push()).pushed).toBeGreaterThan(0);
      await daemonA.close();
      daemonA = null;

      await copyFile(backupDb, engineDb);
      await rm(`${engineDb}-wal`, { force: true });
      await rm(`${engineDb}-shm`, { force: true });
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: relayConnection,
      });
      await writeAndCapture(
        daemonA,
        rootA,
        "notes/local-after-restore.md",
        "local work after restore\n",
      );

      const sync = createRelaySyncEngine({
        rootDir: rootA,
        relay: relayConnection,
        operations: daemonA.relay,
        capture: daemonA.capture,
        onChange: () => undefined,
        debounceMs: 0,
      });
      await sync.start();
      expect(sync.snapshot().lastSyncedAtMs).not.toBeNull();
      await sync.stop();

      daemonB = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: relayConnection,
      });
      await pullAndExpect(
        daemonB,
        rootB,
        "notes/local-after-restore.md",
        "local work after restore\n",
      );
      expect(await readFile(join(rootB, "notes/relay-ahead.md"), "utf8")).toBe(
        "relay is ahead of the backup\n",
      );
    } finally {
      await daemonB?.close().catch(() => undefined);
      await daemonA?.close().catch(() => undefined);
      await relay.stop();
    }
  },
  90_000,
);

interface OpenEditor {
  session: Awaited<ReturnType<WorkspaceEngineCapture["openYDocSession"]>>;
  // What the renderer holds: the opening state plus every remote update.
  doc: Y.Doc;
}

async function openEditor(daemon: LiveDaemonCapture, path: string): Promise<OpenEditor> {
  const doc = new Y.Doc();
  const session = await daemon.capture.openYDocSession({
    path,
    contentKind: "plaintext",
    onRemoteUpdate: (update) => Y.applyUpdate(doc, update),
  });
  Y.applyUpdate(doc, session.initialUpdate);
  return { session, doc };
}

async function typeAtEnd(editor: OpenEditor, text: string): Promise<void> {
  const typed = editor.doc.getText("plainText");
  const before = Y.encodeStateVector(editor.doc);
  typed.insert(typed.length, text);
  void editor.session.applyLocalUpdate(Y.encodeStateAsUpdate(editor.doc, before));
  await editor.session.settleNow();
}

function shown(editor: OpenEditor): string {
  return editor.doc.getText("plainText").toString();
}

it.skipIf(engine.missing)(
  "shows each device's edit in the other device's idle open editor",
  async () => {
    const workspaceId = "two-daemon-idle-editors";
    const token = `test:${workspaceId}`;
    const path = "notes/shared.txt";
    const rootA = await createTestScratch("dohc-idle-editor-a-");
    const rootB = await createTestScratch("dohc-idle-editor-b-");
    const relayRoot = await createTestScratch("dohc-idle-editor-relay-");
    const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay.sqlite") });
    const relayConnection = { baseUrl: relay.baseUrl, token };
    // The product pulls every few seconds. Any cadence proves the same path,
    // and a short one keeps the waits short.
    const idlePullMs = 100;
    // Generous against that cadence plus one settle.
    const arrival = { timeout: 60_000, interval: 100 };
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    const engines: CloudSyncEngine[] = [];
    const editors: OpenEditor[] = [];
    try {
      daemonA = await openLiveDaemonCapture({
        workspaceId,
        rootPath: rootA,
        relay: relayConnection,
      });
      await daemonA.relay.claim();
      await daemonA.chats.ensureGeneralChannel({ workspaceId });
      expect((await daemonA.relay.push()).pushed).toBeGreaterThan(0);

      // A starts the document in an editor and shares it.
      await mkdir(join(rootA, "notes"), { recursive: true });
      await writeFile(join(rootA, path), "");
      const editorA = await openEditor(daemonA, path);
      editors.push(editorA);
      await typeAtEnd(editorA, "Starting together.\n");
      expect((await daemonA.relay.push()).pushed).toBeGreaterThan(0);

      // B joins, receives the document, and opens it too.
      daemonB = await openJoinedDaemonCapture({
        workspaceId,
        rootPath: rootB,
        relay: relayConnection,
      });
      await daemonB.capture.runRelaySync((materializePage) =>
        daemonB!.relay.pull(materializePage),
      );
      const editorB = await openEditor(daemonB, path);
      editors.push(editorB);
      expect(shown(editorB)).toBe("Starting together.\n");

      // From here nothing asks either device to sync. Each pulls on its own.
      for (const [daemon, rootPath] of [
        [daemonA, rootA],
        [daemonB, rootB],
      ] as const) {
        const sync = createRelaySyncEngine({
          rootDir: rootPath,
          relay: relayConnection,
          operations: daemon.relay,
          capture: daemon.capture,
          onChange: () => undefined,
          debounceMs: 0,
          idlePullMs,
        });
        engines.push(sync);
        await sync.start();
      }

      // Each device types while the other's editor sits idle, and the idle
      // editor shows the edit without being touched.
      await typeAtEnd(editorA, "Typed on A.\n");
      await vi.waitFor(() => expect(shown(editorB)).toContain("Typed on A."), arrival);
      await typeAtEnd(editorB, "Typed on B.\n");
      await vi.waitFor(() => expect(shown(editorA)).toContain("Typed on B."), arrival);

      // Both editors and both files hold every line exactly once.
      const merged = shown(editorA);
      for (const line of ["Starting together.", "Typed on A.", "Typed on B."]) {
        expect(merged.split(line).length - 1, line).toBe(1);
      }
      expect(shown(editorB)).toBe(merged);
      await vi.waitFor(async () => {
        expect(await readFile(join(rootA, path), "utf8")).toBe(merged);
        expect(await readFile(join(rootB, path), "utf8")).toBe(merged);
      }, arrival);
    } finally {
      for (const sync of engines) await sync.stop().catch(() => undefined);
      for (const editor of editors) await editor.session.close().catch(() => undefined);
      await daemonB?.close().catch(() => undefined);
      await daemonA?.close().catch(() => undefined);
      await relay.stop();
    }
  },
  180_000,
);
