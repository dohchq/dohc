import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import {
  EngineDaemonLifecycle,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import { relayAdoptedIdentity, spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import {
  EngineRelayClient,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
} from "./engineRelayClient";
import {
  createLiveLinkedChatStore,
  type DesktopLinkedChatStore,
} from "./liveLinkedChatStore";
import {
  createWorkspaceEngineCapture,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import { createTestScratch } from "./testTemp";

const engine = requireEngineBinaryOrSkip();

interface LiveDaemonCapture {
  capture: WorkspaceEngineCapture;
  chats: DesktopLinkedChatStore;
  relay: EngineRelayClient;
  close(): Promise<void>;
}

async function waitForPathMoment(
  capture: WorkspaceEngineCapture,
  path: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await capture.flush();
    const moments = await capture.listMoments({ limit: 100 });
    if (moments.moments.some((moment) => moment.path === path)) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for a captured moment for ${path}.`);
}

async function openLiveDaemonCapture(input: {
  workspaceId: string;
  rootPath: string;
}): Promise<LiveDaemonCapture> {
  const lifecycle = new EngineDaemonLifecycle({
    command: engine.require(),
    maxRestarts: 0,
  });
  await lifecycle.start();
  const routes = new RelayTransportRouteGuard();
  const source = new RelayConfiguredDaemonClientSource(lifecycle, routes);
  const sessions = new EngineWorkspaceSessions(source);
  const relay = new EngineRelayClient({
    sessions,
    routes,
    allowInsecureLoopbackForTests: true,
  });
  const capture = createWorkspaceEngineCapture({
    ...input,
    rustEngineSessions: sessions,
    daemonOwnsCapture: true,
  });
  let closed = false;
  return {
    capture,
    chats: createLiveLinkedChatStore(input, sessions),
    relay,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await capture.stop();
        await relay.closeAll();
        await sessions.closeAll();
      } finally {
        await lifecycle.stop();
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
    });
    const relayA = daemonA.relay.bind({
      workspaceId: input.workspaceId,
      rootPath: rootA,
      relay: { baseUrl: relay.baseUrl, token },
    });
    await relayA.claim();
    const identity = relayAdoptedIdentity(relay.dbPath, input.workspaceId);
    expect(identity).not.toBeNull();
    if (identity === null) {
      throw new Error("The relay did not adopt daemon A's replication identity.");
    }

    // A successful relay position makes later file moments relay-visible.
    // Chat creation always journals, so it can establish that position before
    // the first file initializes the versioned workspace.
    await daemonA.chats.ensureGeneralChannel({ workspaceId: input.workspaceId });
    const bootstrapPush = await relayA.push();
    expect(bootstrapPush.pushed).toBeGreaterThan(0);

    const absoluteA = join(rootA, input.path);
    await mkdir(dirname(absoluteA), { recursive: true });
    await writeFile(absoluteA, input.text, "utf8");
    daemonA.capture.captureBatch([{ path: input.path, operation: "update" }]);
    await waitForPathMoment(daemonA.capture, input.path);

    const push = await relayA.push();
    expect(push.pushed).toBeGreaterThan(0);

    daemonB = await openLiveDaemonCapture({
      workspaceId: input.workspaceId,
      rootPath: rootB,
    });
    const relayB = daemonB.relay.bind({
      workspaceId: input.workspaceId,
      rootPath: rootB,
      relay: { baseUrl: relay.baseUrl, token },
    });
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
