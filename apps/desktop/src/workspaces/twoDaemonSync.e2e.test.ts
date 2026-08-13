import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
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
  bootstrapRelayBeforeCapture?: boolean;
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

    if (input.bootstrapRelayBeforeCapture !== false) {
      // A successful relay position makes later file moments relay-visible.
      // Chat creation always journals, so it can establish that position before
      // the first file initializes the versioned workspace.
      await daemonA.chats.ensureGeneralChannel({ workspaceId: input.workspaceId });
      const bootstrapPush = await daemonA.relay.push();
      expect(bootstrapPush.pushed).toBeGreaterThan(0);
    }

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
  "backfills a captured file when the first relay position follows capture",
  async () =>
    await expectTwoDaemonFileSync({
      workspaceId: "two-daemon-enrolment-window",
      path: "notes/before-first-push.md",
      text: "captured before the first relay position\n",
      contentKind: "text",
      bootstrapRelayBeforeCapture: false,
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
