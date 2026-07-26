import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceDaemonRequester } from "@dohc/workspace-engine-client";
import { afterEach, describe, expect, it } from "vitest";
import { EngineDaemonLifecycle } from "./engineDaemonLifecycle";
import {
  EngineRelayClient,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
} from "./engineRelayClient";
import { EngineWorkspaceSessions } from "./engineWorkspaceSessions";

const configuredBinary = process.env.DOHC_TEST_RUST_ENGINE_BIN?.trim();
const defaultBinary = resolve(
  "C:/w/_targets/rpcs8/debug",
  process.platform === "win32"
    ? "dohc-workspace-engine.exe"
    : "dohc-workspace-engine",
);
const engineBinary = configuredBinary || defaultBinary;
const scratchRoots: string[] = [];
const lifecycles: EngineDaemonLifecycle[] = [];

afterEach(async () => {
  await Promise.all(
    lifecycles.splice(0).map(async (lifecycle) => {
      await lifecycle.stop().catch(() => undefined);
    }),
  );
  await Promise.all(
    scratchRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

async function bodyJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function json(response: ServerResponse, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": bytes.length,
    connection: "close",
  });
  response.end(bytes);
}

async function startRelay(workspaceId: string): Promise<{
  baseUrl: string;
  pushed: Array<Record<string, unknown>>;
  close(): Promise<void>;
}> {
  const pushed: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://relay.test");
      if (
        request.method === "POST" &&
        url.pathname === `/sync/${workspaceId}/log`
      ) {
        const body = await bodyJson(request);
        const originId = String(body.originId);
        const ops = Array.isArray(body.ops)
          ? (body.ops as Array<Record<string, unknown>>)
          : [];
        for (const op of ops) {
          pushed.push({
            relaySeq: pushed.length + 1,
            workspaceId,
            originId,
            ...op,
          });
        }
        const last = ops.at(-1);
        json(response, {
          accepted: ops.length,
          inserted: ops.length,
          skipped: 0,
          currentMaxOriginSeq:
            typeof last?.originSeq === "number" ? last.originSeq : -1,
        });
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === `/sync/${workspaceId}/log`
      ) {
        const since = Number(url.searchParams.get("since") ?? 0);
        const ops = pushed.filter(
          (row) => Number(row.relaySeq ?? 0) > since,
        );
        json(response, {
          ops,
          nextCursor:
            ops.length > 0 ? Number(ops.at(-1)?.relaySeq ?? since) : since,
          hasMore: false,
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === `/sync/${workspaceId}/blobs/have`
      ) {
        json(response, { missing: [] });
        return;
      }
      response.writeHead(500);
      response.end(`unexpected ${request.method} ${url.pathname}`);
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake relay did not bind a TCP address.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    pushed,
    close: async () =>
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}

describe("EngineRelayClient real daemon", () => {
  it.runIf(existsSync(engineBinary))(
    "completes one push and pull round trip through the built sidecar",
    async () => {
      const workspaceId = `relay-e2e-${process.pid}-${Date.now()}`;
      const rootPath = await mkdtemp(join(tmpdir(), "dohc-relay-e2e-"));
      scratchRoots.push(rootPath);
      const markerDirectory = join(rootPath, ".dohc", "engine");
      await mkdir(markerDirectory, { recursive: true });
      await writeFile(
        join(markerDirectory, "SHADOW_CLONE"),
        randomBytes(32).toString("hex"),
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      const relay = await startRelay(workspaceId);
      try {
        const lifecycle = new EngineDaemonLifecycle({
          command: engineBinary,
          requestTimeoutMs: 10_000,
        });
        lifecycles.push(lifecycle);
        await lifecycle.start();

        const routes = new RelayTransportRouteGuard();
        const source = new RelayConfiguredDaemonClientSource(
          lifecycle,
          routes,
        );
        const sessions = new EngineWorkspaceSessions(source);
        const live = new EngineRelayClient({
          sessions,
          routes,
          allowInsecureLoopbackForTests: true,
          requestDeadlineMs: 10_000,
        });
        const client = live.bind({
          workspaceId,
          rootPath,
          relay: { baseUrl: relay.baseUrl, token: "relay-test-token" },
        });

        // Seed one local replication op through the same live daemon handle.
        await sessions.run(
          { workspaceId, rootPath },
          async ({ client: daemon, workspace }) => {
            const requester = new WorkspaceDaemonRequester(daemon);
            await requester.request(
              "chats.channels.create",
              {
                channelId: "relay-e2e-channel",
                name: "Relay E2E",
                kind: "channel",
                nowMs: Date.now(),
              },
              { workspace },
            );
          },
        );

        const pushed = await client.push();
        expect(pushed.pushed).toBeGreaterThan(0);
        expect(relay.pushed.length).toBeGreaterThan(0);
        const pulled = await client.pull();
        expect(pulled.fetched).toBeGreaterThan(0);
        await pulled.commitFetchCursor();
        await sessions.closeAll();
      } finally {
        await relay.close();
      }
    },
    30_000,
  );
});
