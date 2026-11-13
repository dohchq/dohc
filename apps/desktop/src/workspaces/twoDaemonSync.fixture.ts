import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect } from "vitest";
import { buildRelay } from "../../../../services/sync-relay/scripts/build.mjs";

import * as Y from "yjs";

import { VersionedLiveAdapter, WorkspaceDaemonRequester } from "@dohc/workspace-engine-client";

import { openLiveDaemonWorkspace, type CloseStep } from "../../e2e/helpers/daemonSeed";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";

import type { EngineRelayWorkspaceClient } from "./engineRelayClient";
import type { DesktopLinkedChatStore } from "./liveLinkedChatStore";
import { probeRelayWorkspace } from "./relayWorkspaceProbe";
import { createWorkspaceEngineCapture, type WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { waitForCapturedContents, waitForPathMoments } from "./waitForPathMoments";

import { createTestScratch } from "./testTemp";

import { installWorkspaceDataKey, loadSecretDataKey } from "./workspaceDataKey";
import { enrollWorkspaceKeyEnvelope } from "./workspaceKeyEnvelopeEnrollment";
import { bootstrapJoinedWorkspace } from "./workspaceJoinEnrollment";

import { selfHostLiveProfile } from "../../../../services/sync-relay/src/selfHostLiveProfile";

export const engine = requireEngineBinaryOrSkip();

let relayBuildDirectory: string;
export let compiledRelayMain: string;

beforeAll(async () => {
  if (engine.missing) return;
  if (process.env.DOHC_TEST_RELAY_MAIN) {
    compiledRelayMain = process.env.DOHC_TEST_RELAY_MAIN;
    return;
  }
  const output = fileURLToPath(new URL("../../../../services/sync-relay/.output/", import.meta.url));
  await mkdir(output, { recursive: true });
  relayBuildDirectory = await mkdtemp(join(output, "two-daemon-sync-"));
  await buildRelay(relayBuildDirectory);
  compiledRelayMain = join(relayBuildDirectory, "main.js");
}, 30_000);

afterAll(async () => {
  if (relayBuildDirectory) {
    await rm(relayBuildDirectory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
}, 30_000);

export interface LiveDaemonCapture {
  capture: WorkspaceEngineCapture;
  chats: DesktopLinkedChatStore;
  relay: EngineRelayWorkspaceClient;
  refusalNotices(): Promise<unknown>;
  queryCollectionRecords: VersionedLiveAdapter["queryCollectionRecords"];
  // What the desktop does first at quit.
  beginShutdown(): void;
  close(step?: CloseStep): Promise<void>;
}

export function pullCaptured(relay: EngineRelayWorkspaceClient, capture: WorkspaceEngineCapture) {
  return relay.pull(apply => capture.runRelaySync(apply));
}

export async function pushUntilDrained(relay: EngineRelayWorkspaceClient) {
  let result = await relay.push();
  let pushed = result.pushed;
  while (result.hasMore) {
    result = await relay.push();
    pushed += result.pushed;
  }
  return { ...result, pushed };
}

export async function openLiveDaemonCapture(input: {
  workspaceId: string;
  rootPath: string;
  relay: { baseUrl: string; token: string };
  settleDebounceMs?: number;
}): Promise<LiveDaemonCapture> {
  const workspace = await openLiveDaemonWorkspace(input, { maxRestarts: 0,
    allowInsecureLoopbackForTests: new URL(input.relay.baseUrl).protocol === "http:" });
  const capture = createWorkspaceEngineCapture({
    ...workspace.workspace,
    rustEngineSessions: workspace.sessions,
    ...(input.settleDebounceMs === undefined
      ? {}
      : { settleDebounceMs: input.settleDebounceMs }),
  });
  const relay = workspace.relay.bind({
    ...workspace.workspace,
    relay: input.relay,
  });
  return {
    capture,
    chats: workspace.chats,
    relay,
    queryCollectionRecords: query => workspace.sessions.run(workspace.workspace, async ({ client, workspace: handle }) =>
      new VersionedLiveAdapter(client, handle, { workspaceId: input.workspaceId }).queryCollectionRecords(query)),
    refusalNotices: () => workspace.sessions.run(workspace.workspace, async ({ client, workspace: handle }) =>
      new WorkspaceDaemonRequester(client).request("sync.refusalNotices", {
        workspaceId: input.workspaceId,
      }, { workspace: handle }),
    ),
    beginShutdown: () => {
      capture.beginShutdown();
      workspace.sessions.beginShutdown();
    },
    close: async (step: CloseStep = (_name, work) => work) => {
      try {
        await step("capture.stop", capture.stop());
      } finally {
        await workspace.close(step);
      }
    },
  };
}

export async function openJoinedDaemonCapture(input: {
  workspaceId: string;
  rootPath: string;
  relay: { baseUrl: string; token: string };
  passphrase?: string;
  holdEditorResync?: boolean;
}): Promise<LiveDaemonCapture> {
  const workspace = await openLiveDaemonWorkspace(input, { maxRestarts: 0,
    allowInsecureLoopbackForTests: new URL(input.relay.baseUrl).protocol === "http:" });
  if (input.holdEditorResync) {
    const client = workspace.nativeClient();
    const onEvent = client.onEvent.bind(client);
    // Hold the advisory resync so all updates drain together at lease close.
    client.onEvent = handler => onEvent(event => {
      if (event.name !== "ydoc.remoteUpdate") handler(event);
    });
  }
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
    queryCollectionRecords: query => workspace.sessions.run(workspace.workspace, async ({ client, workspace: handle }) =>
      new VersionedLiveAdapter(client, handle, { workspaceId: input.workspaceId }).queryCollectionRecords(query)),
    refusalNotices: () => workspace.sessions.run(workspace.workspace, async ({ client, workspace: handle }) =>
      new WorkspaceDaemonRequester(client).request("sync.refusalNotices", {
        workspaceId: input.workspaceId,
      }, { workspace: handle }),
    ),
    beginShutdown: () => {
      capture.beginShutdown();
      workspace.sessions.beginShutdown();
    },
    close: async (step: CloseStep = (_name, work) => work) => {
      try {
        await step("capture.stop", capture.stop());
      } finally {
        await workspace.close(step);
      }
    },
  };
}

export async function writeAndCapture(
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
  daemon.capture.observeFileEvents([{ path, operation: "update" }]);
  await waitForCapturedContents(daemon.capture, path, contents, before + 1);
}

export async function openIndependentPlaintextLineage(
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

export async function pullAndExpect(
  daemon: LiveDaemonCapture,
  rootPath: string,
  path: string,
  contents: string | Buffer,
  contentKind?: "text" | "binary",
): Promise<void> {
  const pull = await daemon.relay.pull(apply => daemon.capture.runRelaySync(apply));
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

export async function expectTwoDaemonFileSync(input: {
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
  const relayRoot = await createTestScratch("dohc-two-daemon-relay-");
  const relay = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: compiledRelayMain });
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
      const bootstrapPush = await pushUntilDrained(daemonA.relay);
      expect(bootstrapPush.pushed).toBeGreaterThan(0);
    }

    await writeAndCapture(daemonA, rootA, input.path, input.contents);

    const push = await pushUntilDrained(daemonA.relay);
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
      expect((await pushUntilDrained(daemonB.relay)).pushed).toBeGreaterThan(0);
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
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
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
      const rootC = await createTestScratch("dohc-two-daemon-c-");
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
    await Promise.allSettled([daemonC?.close(), daemonB?.close(), daemonA?.close()]);
    await relay.stop();
  }
}

export interface OpenEditor {
  session: Awaited<ReturnType<WorkspaceEngineCapture["openYDocSession"]>>;
  // What the renderer holds: the opening state plus every remote update.
  doc: Y.Doc;
}

export async function openEditor(daemon: Pick<LiveDaemonCapture, "capture">, path: string): Promise<OpenEditor> {
  const doc = new Y.Doc();
  const session = await daemon.capture.openYDocSession({
    path,
    contentKind: "plaintext",
    onRemoteUpdate: (update) => Y.applyUpdate(doc, update),
  });
  Y.applyUpdate(doc, session.initialUpdate);
  return { session, doc };
}

export async function typeAtEnd(editor: OpenEditor, text: string): Promise<void> {
  const typed = editor.doc.getText("plainText");
  const before = Y.encodeStateVector(editor.doc);
  typed.insert(typed.length, text);
  void editor.session.applyLocalUpdate(Y.encodeStateAsUpdate(editor.doc, before));
  await editor.session.settleNow();
}

export function shown(editor: OpenEditor): string {
  return editor.doc.getText("plainText").toString();
}
