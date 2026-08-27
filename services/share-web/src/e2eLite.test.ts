import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSyncRelayHandler } from "@dohc/sync-relay";
import {
  openSyncRelayStorage,
  type SyncRelayStorage,
} from "@dohc/sync-relay/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShareWebHandler } from "./server";

const RELAY_EXCHANGE_KEY = "e2e-share-web-relay-exchange-key";
const servers: Server[] = [];
const roots: string[] = [];
const storages: SyncRelayStorage[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => {
        server.closeIdleConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      },
    ),
  );
  for (const storage of storages.splice(0)) storage.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function listen(handler: (request: Request) => Promise<Response>): Promise<string> {
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    incoming.on("end", () => {
      const url = new URL(incoming.url ?? "/", `http://${incoming.headers.host ?? "localhost"}`);
      void handler(
        new Request(url, {
          method: incoming.method,
          headers: incoming.headers as Record<string, string>,
          body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
        }),
      ).then(
        async (webResponse) => {
          outgoing.statusCode = webResponse.status;
          for (const [key, value] of webResponse.headers) outgoing.setHeader(key, value);
          outgoing.end(Buffer.from(await webResponse.arrayBuffer()));
        },
        (error: unknown) => {
          outgoing.statusCode = 500;
          outgoing.end(error instanceof Error ? error.message : String(error));
        },
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("share-web e2e-lite", () => {
  it("exchanges a real link and reads a real relay Markdown blob", async () => {
    vi.stubEnv("DOHC_RELAY_EXCHANGE_KEY", RELAY_EXCHANGE_KEY);
    const root = await mkdtemp(join(tmpdir(), "dohc-share-web-e2e-"));
    roots.push(root);
    const storage = openSyncRelayStorage(join(root, "relay.sqlite"));
    storages.push(storage);
    let id = 0;
    const relayHandler = createSyncRelayHandler({
      storage,
      resolveActor(request, workspaceId) {
        const match = /^Bearer user:([^ ]+)$/u.exec(request.headers.get("authorization") ?? "");
        if (!match) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
        return { userId: match[1]!, workspaceId };
      },
      lookupUserEmail: (userId) => `${userId}@example.test`,
      newShareId: () => "share-e2e",
      newGrantId: () => `grant-${id++}`,
      newId: () => `id-${id++}`,
      linkKey: "e2e-link-key-with-at-least-thirty-two-bytes",
      relayExchangeKey: process.env.DOHC_RELAY_EXCHANGE_KEY,
    });
    const relayUrl = await listen(relayHandler);

    const ownerHeaders = {
      authorization: "Bearer user:owner",
      "content-type": "application/json",
    };
    expect(
      (
        await fetch(`${relayUrl}/sync/workspaces`, {
          method: "POST",
          headers: ownerHeaders,
          body: JSON.stringify({ workspaceId: "workspace-e2e" }),
        })
      ).status,
    ).toBe(200);
    const markdown = "# Accountless view\n\nRead through share-web.\n";
    const blobSha = sha256(markdown);
    expect(
      (
        await fetch(`${relayUrl}/sync/workspace-e2e/blobs/${blobSha}`, {
          method: "PUT",
          headers: { authorization: "Bearer user:owner" },
          body: markdown,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${relayUrl}/sync/workspace-e2e/log`, {
          method: "POST",
          headers: ownerHeaders,
          body: JSON.stringify({
            originId: "origin-e2e",
            ops: [
              {
                originSeq: 0,
                opKind: "moment.append",
                recordedAtMs: 10_000,
                payload: {
                  momentId: "moment-e2e",
                  versionId: "main",
                  objectId: "object-e2e",
                  path: "docs/readme.md",
                  recordedAtMs: 10_000,
                  operation: "write",
                  payloadBeforeBlobSha256: null,
                  payloadBeforePath: null,
                  payloadAfterBlobSha256: blobSha,
                  payloadAfterPath: "docs/readme.md",
                  metadata: { origin: "user" },
                  beforePresent: "null",
                },
              },
            ],
          }),
        })
      ).status,
    ).toBe(200);
    const share = await body(
      await fetch(`${relayUrl}/sync/workspace-e2e/shares`, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({
          recipientUserId: "recipient",
          paths: ["docs"],
          access: "view",
        }),
      }),
    );
    const link = await body(
      await fetch(`${relayUrl}/sync/workspace-e2e/shares/${String(share.shareId)}/links`, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ access: "view" }),
      }),
    );

    const publicHosts = new Set<string>();
    const shareWebHandler = createShareWebHandler({
      relayUrl,
      relayExchangeKey: RELAY_EXCHANGE_KEY,
      publicHosts,
    });
    const shareWebUrl = await listen(shareWebHandler);
    publicHosts.add(new URL(shareWebUrl).host);

    const exchanged = await fetch(`${shareWebUrl}/api/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: link.secret }),
    });
    expect(exchanged.status).toBe(200);
    const session = (await body(exchanged)).session;
    const cookie = exchanged.headers.get("set-cookie")!.split(";", 1)[0]!;
    const sessionHeaders = {
      cookie,
      "x-dohc-link-session": String(session),
    };

    const log = await body(
      await fetch(`${shareWebUrl}/api/view/log?since=0&limit=100`, {
        headers: sessionHeaders,
      }),
    );
    expect(log.ops).toEqual([
      expect.objectContaining({
        opKind: "moment.append",
        payload: expect.objectContaining({ path: "docs/readme.md", payloadAfterBlobSha256: blobSha }),
      }),
    ]);
    const file = await fetch(`${shareWebUrl}/api/view/blob/${blobSha}`, {
      headers: sessionHeaders,
    });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toBe("attachment");
    expect(await file.text()).toBe(markdown);
  });
});
