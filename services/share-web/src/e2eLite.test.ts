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
          for (const [key, value] of webResponse.headers) {
            if (key !== "set-cookie") outgoing.setHeader(key, value);
          }
          const setCookies = webResponse.headers.getSetCookie();
          if (setCookies.length > 0) outgoing.setHeader("set-cookie", setCookies);
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
  it("completes a real viewer-session handoff to a named relay recipient", async () => {
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
      shareWebOrigin: "https://share.example.test",
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
    const linkResponse = await fetch(`${relayUrl}/sync/workspace-e2e/shares/links`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ paths: ["docs"], access: "view" }),
    });
    expect(linkResponse.status).toBe(200);
    const link = await body(linkResponse);

    const publicHosts = new Set<string>();
    const shareWebHandler = createShareWebHandler({
      relayUrl,
      publicRelayUrl: relayUrl,
      relayExchangeKey: RELAY_EXCHANGE_KEY,
      publicHosts,
    });
    const shareWebUrl = await listen(shareWebHandler);
    publicHosts.add(new URL(shareWebUrl).host);

    const exchanged = await fetch(`${shareWebUrl}/api/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: new URL(String(link.url)).hash.slice(1) }),
    });
    expect(exchanged.status).toBe(200);
    const session = (await body(exchanged)).session;
    const cookie = exchanged.headers
      .getSetCookie()
      .map((setCookie) => setCookie.split(";", 1)[0]!)
      .find(
        (pair) =>
          pair.startsWith("dohc_share_") &&
          !pair.startsWith("dohc_share_profile_"),
      );
    expect(cookie).toBeDefined();
    const sessionHeaders = {
      cookie: cookie!,
      "x-dohc-link-session": String(session),
    };

    const inventoryBefore = await body(
      await fetch(`${relayUrl}/sync/workspace-e2e/shares/links`, {
        headers: { authorization: "Bearer user:owner" },
      }),
    );
    const linkBefore = (inventoryBefore.links as Array<Record<string, unknown>>).find(
      (candidate) => candidate.grantId === link.grantId,
    );
    expect(linkBefore?.dependents).toEqual([]);
    expect(JSON.stringify(inventoryBefore)).not.toContain("handoff-recipient");

    const handedOff = await fetch(`${shareWebUrl}/api/handoff`, {
      method: "POST",
      headers: sessionHeaders,
    });
    expect(handedOff.status).toBe(200);
    const handoff = await body(handedOff);
    expect(Object.keys(handoff).sort()).toEqual([
      "code",
      "expiresAtMs",
      "ok",
      "relayUrl",
    ]);
    expect(handoff.ok).toBe(true);
    expect(String(handoff.code)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(handoff.relayUrl).toBe(relayUrl.replace(/\/$/u, ""));
    expect(Number.isSafeInteger(handoff.expiresAtMs)).toBe(true);
    expect(Number(handoff.expiresAtMs)).toBeGreaterThan(Date.now());

    const redeemPayload = { code: handoff.code };
    expect(Object.keys(redeemPayload)).toEqual(["code"]);
    const redeemed = await fetch(`${relayUrl}/sync/link-redeem`, {
      method: "POST",
      headers: {
        authorization: "Bearer user:handoff-recipient",
        "content-type": "application/json",
      },
      body: JSON.stringify(redeemPayload),
    });
    expect(redeemed.status).toBe(200);
    const namedGrant = await body(redeemed);
    expect(namedGrant).toMatchObject({
      ok: true,
      shareId: link.shareId,
      access: "view",
    });

    const inventoryAfter = await body(
      await fetch(`${relayUrl}/sync/workspace-e2e/shares/links`, {
        headers: { authorization: "Bearer user:owner" },
      }),
    );
    const linkAfter = (inventoryAfter.links as Array<Record<string, unknown>>).find(
      (candidate) => candidate.grantId === link.grantId,
    );
    expect(linkAfter?.dependents).toEqual([
      expect.objectContaining({
        grantId: namedGrant.grantId,
        recipientUserId: "handoff-recipient",
        recipientEmail: "handoff-recipient@example.test",
        access: "view",
      }),
    ]);

    const namedLog = await body(
      await fetch(`${relayUrl}/sync/shares/${String(link.shareId)}/log?since=0&limit=100`, {
        headers: { authorization: "Bearer user:handoff-recipient" },
      }),
    );
    expect(namedLog.ops).toEqual([
      expect.objectContaining({
        opKind: "moment.append",
        payload: expect.objectContaining({ path: "docs/readme.md" }),
      }),
    ]);

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
