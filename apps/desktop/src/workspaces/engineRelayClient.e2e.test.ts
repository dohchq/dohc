import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceDaemonRequester } from "@dohc/workspace-engine-client";
import {
  EngineDaemonLifecycle,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import { afterEach, describe, expect, it } from "vitest";
import {
  EngineRelayClient,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
} from "./engineRelayClient";

const configuredBinary = process.env.DOHC_TEST_RUST_ENGINE_BIN?.trim() || null;
const engineBinary =
  configuredBinary === null ? null : resolve(configuredBinary);
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

function requiredEngineBinary(): string {
  if (engineBinary === null) {
    throw new Error("DOHC_TEST_RUST_ENGINE_BIN is required for this E2E.");
  }
  if (!existsSync(engineBinary)) {
    throw new Error(
      `DOHC_TEST_RUST_ENGINE_BIN does not exist: ${engineBinary}`,
    );
  }
  return engineBinary;
}

async function startRelay(workspaceId: string): Promise<{
  baseUrl: string;
  pushed: Array<Record<string, unknown>>;
  close(): Promise<void>;
}> {
  const pushed: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== "Bearer relay-test-token") {
        response.writeHead(401, {
          "content-type": "application/json",
          connection: "close",
        });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
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
  it.runIf(configuredBinary !== null)(
    "pushes from one replica and durably applies the pull to another",
    async () => {
      const binary = requiredEngineBinary();
      const workspaceId = `relay-e2e-${process.pid}-${Date.now()}`;
      const senderRoot = await createShadowRoot("dohc-relay-e2e-sender-");
      const receiverRoot = await createShadowRoot(
        "dohc-relay-e2e-receiver-",
      );
      const relay = await startRelay(workspaceId);
      try {
        const senderLifecycle = new EngineDaemonLifecycle({
          command: binary,
          requestTimeoutMs: 10_000,
        });
        const receiverLifecycle = new EngineDaemonLifecycle({
          command: binary,
          requestTimeoutMs: 10_000,
        });
        lifecycles.push(senderLifecycle, receiverLifecycle);
        await Promise.all([
          senderLifecycle.start(),
          receiverLifecycle.start(),
        ]);

        const sender = relayHarness(
          senderLifecycle,
          workspaceId,
          senderRoot,
          relay.baseUrl,
        );
        const receiver = relayHarness(
          receiverLifecycle,
          workspaceId,
          receiverRoot,
          relay.baseUrl,
        );

        // Each replica owns a local identity. The receiver's seed is never
        // pushed; it only prepares an independent durable store for the pull.
        await createChannel(
          receiver.sessions,
          workspaceId,
          receiverRoot,
          "receiver-seed",
          "Receiver seed",
        );
        await createChannel(
          sender.sessions,
          workspaceId,
          senderRoot,
          "relay-e2e-channel",
          "Relay E2E",
        );

        const pushed = await sender.client.push();
        expect(pushed.pushed).toBeGreaterThan(0);
        expect(relay.pushed.length).toBeGreaterThan(0);
        const pulled = await receiver.client.pull();
        expect(pulled.fetched).toBeGreaterThan(0);
        expect(
          await channelIds(receiver.sessions, workspaceId, receiverRoot),
          "MUTATION: fetched counts are insufficient unless the second replica materializes the channel",
        ).toContain("relay-e2e-channel");
        await pulled.commitFetchCursor();

        // `closeAll()` is a ONE-WAY door: it clears `acceptingRuns`, which
        // nothing ever restores, so every later `acquire()` throws
        // "Rust engine workspace sessions are closed." (asserted as a contract
        // in engineWorkspaceSessions.test.ts). This test called it and then
        // kept using the same object, so it could never have passed — and the
        // `DOHC_TEST_RUST_ENGINE_BIN` gate meant nobody found out. Production
        // is unaffected: closeAllRelayTransportWorkspaces fans out over the
        // non-terminal closeWorkspace().
        //
        // Scope, stated honestly: this re-opens the workspace against the
        // SAME running daemon, so it proves the pull survives a session
        // close/re-open, not that it survives a process restart. Restarting
        // the daemon would prove more, but EngineDaemonLifecycle.stop() is
        // itself terminal ("already stopping"), so that needs a second
        // lifecycle rather than a contortion of this one.
        await receiver.sessions.closeWorkspace(workspaceId);
        expect(
          await channelIds(receiver.sessions, workspaceId, receiverRoot),
        ).toContain("relay-e2e-channel");
        await Promise.all([
          sender.sessions.closeAll(),
          receiver.sessions.closeAll(),
        ]);
      } finally {
        await relay.close();
      }
    },
    30_000,
  );
});

async function createShadowRoot(prefix: string): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), prefix));
  scratchRoots.push(rootPath);
  const markerDirectory = join(rootPath, ".dohc", "engine");
  await mkdir(markerDirectory, { recursive: true });
  await writeFile(
    join(markerDirectory, "SHADOW_CLONE"),
    randomBytes(32).toString("hex"),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return rootPath;
}

function relayHarness(
  lifecycle: EngineDaemonLifecycle,
  workspaceId: string,
  rootPath: string,
  baseUrl: string,
): {
  sessions: EngineWorkspaceSessions;
  client: ReturnType<EngineRelayClient["bind"]>;
} {
  const routes = new RelayTransportRouteGuard();
  const source = new RelayConfiguredDaemonClientSource(lifecycle, routes);
  const sessions = new EngineWorkspaceSessions(source);
  const live = new EngineRelayClient({
    sessions,
    routes,
    allowInsecureLoopbackForTests: true,
    requestDeadlineMs: 10_000,
  });
  return {
    sessions,
    client: live.bind({
      workspaceId,
      rootPath,
      relay: { baseUrl, token: "relay-test-token" },
    }),
  };
}

async function createChannel(
  sessions: EngineWorkspaceSessions,
  workspaceId: string,
  rootPath: string,
  channelId: string,
  name: string,
): Promise<void> {
  await sessions.run(
    { workspaceId, rootPath },
    async ({ client: daemon, workspace }) => {
      const requester = new WorkspaceDaemonRequester(daemon);
      await requester.request(
        "chats.channels.create",
        {
          channelId,
          name,
          kind: "channel",
          nowMs: Date.now(),
        },
        { workspace },
      );
    },
  );
}

async function channelIds(
  sessions: EngineWorkspaceSessions,
  workspaceId: string,
  rootPath: string,
): Promise<string[]> {
  return await sessions.run(
    { workspaceId, rootPath },
    async ({ client: daemon, workspace }) => {
      const requester = new WorkspaceDaemonRequester(daemon);
      const result = await requester.request(
        "chats.channels.list",
        {},
        { workspace },
      );
      if (
        result === null ||
        Array.isArray(result) ||
        typeof result !== "object" ||
        !Array.isArray(result.channels)
      ) {
        throw new Error("Daemon returned an invalid channel list.");
      }
      return result.channels.map((channel) => {
        if (
          channel === null ||
          Array.isArray(channel) ||
          typeof channel !== "object" ||
          typeof channel.channelId !== "string"
        ) {
          throw new Error("Daemon returned an invalid channel.");
        }
        return channel.channelId;
      });
    },
  );
}
