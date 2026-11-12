import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { expect, it } from "vitest";
import { EngineWorkspaceShuttingDownError } from "@dohc/workspace-engine-client/daemon";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { createTestScratch } from "./testTemp";
import { engine, compiledRelayMain, type LiveDaemonCapture, pushUntilDrained, openLiveDaemonCapture, openJoinedDaemonCapture, writeAndCapture, pullAndExpect } from "./twoDaemonSync.fixture";

// Quit stops waiting for a relay push the server has not answered. The
// engine has not acknowledged the edit, so the next launch sends it.
it.skipIf(engine.missing)(
  "sends an edit whose push was unanswered at quit on the next launch",
  async () => {
    const workspaceId = "two-daemon-quit-push";
    const token = `test:${workspaceId}`;
    const rootA = await createTestScratch("dohc-quit-push-a-");
    const rootB = await createTestScratch("dohc-quit-push-b-");
    const relayRoot = await createTestScratch("dohc-quit-push-relay-");
    const dbPath = join(relayRoot, "relay", "relay.sqlite");
    let relay = await spawnSyncRelay({ dbPath, compiledMain: compiledRelayMain });
    const port = Number(new URL(relay.baseUrl).port);
    const connection = { baseUrl: relay.baseUrl, token };
    // A server that takes each connection and never answers. The engine resets
    // the connection when it stops.
    const held = new Set<Socket>();
    const silent = createServer((socket) => {
      held.add(socket);
      socket.on("error", () => undefined);
    });
    let daemonA: LiveDaemonCapture | null = null;
    let daemonB: LiveDaemonCapture | null = null;
    try {
      daemonA = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: connection });
      await daemonA.relay.claim();
      await daemonA.chats.ensureGeneralChannel({ workspaceId });
      await pushUntilDrained(daemonA.relay);
      await writeAndCapture(daemonA, rootA, "notes.md", "body\n");

      await relay.stop();
      silent.listen(port, "127.0.0.1");
      await once(silent, "listening");
      const reached = once(silent, "connection") as Promise<[Socket]>;
      const push = daemonA.relay.push();
      const [socket] = await reached;
      await once(socket, "data");
      daemonA.beginShutdown();
      await expect(push).rejects.toBeInstanceOf(EngineWorkspaceShuttingDownError);
      await daemonA.close();
      daemonA = null;
      for (const socket of held) socket.destroy();
      silent.close();
      await once(silent, "close");

      relay = await spawnSyncRelay({ dbPath, compiledMain: compiledRelayMain, port });
      daemonA = await openLiveDaemonCapture({ workspaceId, rootPath: rootA, relay: connection });
      expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
      daemonB = await openJoinedDaemonCapture({ workspaceId, rootPath: rootB, relay: connection });
      await pullAndExpect(daemonB, rootB, "notes.md", "body\n");
    } finally {
      for (const socket of held) socket.destroy();
      if (silent.listening) silent.close();
      await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
      await relay.stop();
    }
  },
  120_000,
);

