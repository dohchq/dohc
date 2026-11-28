import { once } from "node:events";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RELAY_API_VERSION_HEADER } from "@dohc/workspace-contracts/relay-values";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import { createTestScratch } from "./testTemp";
import {
  compiledRelayMain,
  engine,
  type LiveDaemonCapture,
  openJoinedDaemonCapture,
  openLiveDaemonCapture,
  pullAndExpect,
  pushUntilDrained,
  writeAndCapture,
} from "./twoDaemonSync.fixture";

async function namingProxy(target: string) {
  const named: string[] = [];
  const server = createServer((incoming, outgoing) => {
    named.push(`${incoming.headers[RELAY_API_VERSION_HEADER]} ${incoming.method} ${incoming.url}`);
    const upstream = request(
      new URL(incoming.url!, target),
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        outgoing.writeHead(response.statusCode!, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", (error) => outgoing.destroy(error));
    incoming.pipe(upstream);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    named,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

for (const floor of ["1", "2"])
  it.skipIf(engine.missing)(
    `pushes and pulls between two engines through a relay at floor ${floor}, naming version 2`,
    async () => {
      const workspaceId = `relay-floor-${floor}`;
      const token = `test:${workspaceId}`;
      const rootA = await createTestScratch("dohc-relay-floor-a-");
      const rootB = await createTestScratch("dohc-relay-floor-b-");
      const relayRoot = await createTestScratch("dohc-relay-floor-relay-");
      const relay = await spawnSyncRelay({
        dbPath: join(relayRoot, "relay", "relay.sqlite"),
        compiledMain: compiledRelayMain,
        env: { DOHC_RELAY_ENGINE_API_MIN: floor },
      });
      const proxy = await namingProxy(relay.baseUrl);
      let daemonA: LiveDaemonCapture | null = null;
      let daemonB: LiveDaemonCapture | null = null;
      try {
        daemonA = await openLiveDaemonCapture({
          workspaceId,
          rootPath: rootA,
          relay: { baseUrl: proxy.baseUrl, token },
        });
        await daemonA.relay.claim();
        await daemonA.chats.ensureGeneralChannel({ workspaceId });
        expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
        await writeAndCapture(daemonA, rootA, "notes/plan.md", "# Plan\n");
        expect((await pushUntilDrained(daemonA.relay)).pushed).toBeGreaterThan(0);
        daemonB = await openJoinedDaemonCapture({
          workspaceId,
          rootPath: rootB,
          relay: { baseUrl: proxy.baseUrl, token },
        });
        await pullAndExpect(daemonB, rootB, "notes/plan.md", "# Plan\n");
        expect(proxy.named.length).toBeGreaterThan(0);
        expect(proxy.named.filter((line) => !line.startsWith("2 "))).toEqual([]);
      } finally {
        await Promise.allSettled([daemonB?.close(), daemonA?.close()]);
        await proxy.close();
        await relay.stop();
      }
    },
  );
