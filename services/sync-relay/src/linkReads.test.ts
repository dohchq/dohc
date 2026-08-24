import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LinkReadRateLimiter,
  LINK_SESSION_TTL_MS,
} from "./linkSecurity";
import { createSyncRelayHandler, type SyncRelayHandler } from "./server";
import { openSyncRelayStorage, type SyncRelayStorage } from "./storage";

const OWNER = "owner";
const RECIPIENT = "recipient";
const WORKSPACE = "workspace-link-reads";
const LINK_KEY = "test-link-key-with-at-least-thirty-two-bytes";
const UNKNOWN_CAPABILITY = "z".repeat(43);

const roots: string[] = [];
const storages: SyncRelayStorage[] = [];

afterEach(async () => {
  for (const storage of storages.splice(0)) storage.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newStorage(): Promise<SyncRelayStorage> {
  const root = await mkdtemp(join(tmpdir(), "dohc-link-reads-"));
  roots.push(root);
  const storage = openSyncRelayStorage(join(root, "relay.sqlite"));
  storages.push(storage);
  return storage;
}

function handler(
  storage: SyncRelayStorage,
  options: {
    nowMs?: () => number;
    lookupUserEmail?: (userId: string) => Promise<string | null> | string | null;
    linkReadRateLimiter?: LinkReadRateLimiter;
  } = {},
): SyncRelayHandler {
  let id = 0;
  return createSyncRelayHandler({
    storage,
    resolveActor(request, workspaceId) {
      const match = /^Bearer user:([^ ]+)$/u.exec(request.headers.get("authorization") ?? "");
      if (!match) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
      return { userId: match[1]!, workspaceId };
    },
    nowMs: options.nowMs ?? (() => 2_000),
    lookupUserEmail: options.lookupUserEmail ?? ((userId) => `${userId}@example.test`),
    newShareId: () => `share-${id++}`,
    newGrantId: () => `grant-${id++}`,
    newId: () => `id-${id++}`,
    linkKey: LINK_KEY,
    linkReadRateLimiter: options.linkReadRateLimiter,
  });
}

function request(userId: string | null, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (userId) headers.set("authorization", `Bearer user:${userId}`);
  headers.set("x-dohc-relay-client-ip", "192.0.2.20");
  return new Request(`http://relay.test${path}`, { ...init, headers });
}

function linkRequest(capability: string, path: string): Request {
  return request(null, path, {
    headers: { authorization: `LinkCapability ${capability}` },
  });
}

function jsonBody(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function putBlob(h: SyncRelayHandler, content: string): Promise<string> {
  const sha = sha256(content);
  expect(
    (
      await h(
        request(OWNER, `/sync/${WORKSPACE}/blobs/${sha}`, {
          method: "PUT",
          body: content,
        }),
      )
    ).status,
  ).toBe(200);
  return sha;
}

function moment(originSeq: number, path: string, content: string, recordedAtMs: number) {
  return {
    originSeq,
    opKind: "moment.append",
    payload: {
      momentId: `moment-${originSeq}`,
      versionId: "main",
      objectId: `object-${originSeq}`,
      path,
      recordedAtMs,
      operation: "write",
      payloadBeforeBlobSha256: null,
      payloadBeforePath: null,
      payloadAfterBlobSha256: sha256(content),
      payloadAfterPath: path,
      metadata: { origin: "user" },
      beforePresent: "null",
    },
    recordedAtMs,
  };
}

async function seed(
  h: SyncRelayHandler,
  access: "view" | "comment" | "edit" = "view",
): Promise<{ capability: string; grantId: string; sharedSha: string; hiddenSha: string }> {
  expect(
    (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
  ).toBe(200);
  const sharedSha = await putBlob(h, "# shared\n");
  const hiddenSha = await putBlob(h, "hidden\n");
  expect(
    (
      await h(
        request(
          OWNER,
          `/sync/${WORKSPACE}/log`,
          jsonBody({
            originId: "origin-a",
            ops: [
              { originSeq: 0, opKind: "workspace.init", payload: { private: true }, recordedAtMs: 900 },
              moment(1, "docs/shared.md", "# shared\n", 1_100),
              moment(2, "private/hidden.md", "hidden\n", 1_200),
            ],
          }),
        ),
      )
    ).status,
  ).toBe(200);
  const share = await json(
    await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({ recipientUserId: RECIPIENT, paths: ["docs"], access }),
      ),
    ),
  );
  const shareId = String(share.shareId);
  const link = await json(
    await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/${shareId}/links`,
        jsonBody({ access }),
      ),
    ),
  );
  const exchange = await json(
    await h(request(null, "/sync/link-exchange", jsonBody({ secret: link.secret }))),
  );
  return {
    capability: String(exchange.capabilityToken),
    grantId: String(link.grantId),
    sharedSha,
    hiddenSha,
  };
}

async function denialBytes(response: Response): Promise<string> {
  expect(response.status).toBe(404);
  return `${response.status}:${await response.text()}`;
}

describe("relay capability reads", () => {
  it("matches the same-access recipient log and blob boundary at every access", async () => {
    for (const access of ["view", "comment", "edit"] as const) {
      const storage = await newStorage();
      const h = handler(storage);
      const { capability, sharedSha, hiddenSha } = await seed(h, access);

      const recipientMeta = await json(await h(request(RECIPIENT, "/sync/shares/share-0")));
      const linkMetaResponse = await h(linkRequest(capability, "/sync/link/share"));
      expect(linkMetaResponse.status).toBe(200);
      const linkMeta = await json(linkMetaResponse);
      expect(linkMeta).toEqual({
        ok: true,
        effectiveSelector: {
          ...(recipientMeta.selector as Record<string, unknown>),
          access,
        },
        access,
        lastSettledAtMs: 1_100,
        granterEmail: `${OWNER}@example.test`,
      });
      expect(linkMeta).not.toHaveProperty("workspaceId");
      expect(linkMeta).not.toHaveProperty("grantId");
      expect(linkMeta).not.toHaveProperty("participants");

      const recipientLog = await json(
        await h(request(RECIPIENT, "/sync/shares/share-0/log?since=0&limit=100")),
      );
      const linkLog = await json(
        await h(linkRequest(capability, "/sync/link/log?since=0&limit=100")),
      );
      expect(linkLog).toEqual(recipientLog);
      expect(JSON.stringify(linkLog)).not.toContain("private/hidden.md");

      const recipientBlob = await h(
        request(RECIPIENT, `/sync/shares/share-0/blobs/${sharedSha}`),
      );
      const linkBlob = await h(linkRequest(capability, `/sync/link/blobs/${sharedSha}`));
      expect(linkBlob.status).toBe(recipientBlob.status);
      expect(await linkBlob.arrayBuffer()).toEqual(await recipientBlob.arrayBuffer());

      const missingSha = sha256("missing");
      const recipientMissing = await denialBytes(
        await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${missingSha}`)),
      );
      expect(
        await denialBytes(await h(linkRequest(capability, `/sync/link/blobs/${hiddenSha}`))),
      ).toBe(recipientMissing);
      expect(
        await denialBytes(await h(linkRequest(capability, `/sync/link/blobs/${missingSha}`))),
      ).toBe(recipientMissing);
    }
  });

  it("makes revoked, rotated, expired, and unknown capability refusals byte-identical", async () => {
    let now = 2_000;
    const storage = await newStorage();
    const h = handler(storage, { nowMs: () => now });
    const first = await seed(h);
    const unknown = await denialBytes(
      await h(linkRequest(UNKNOWN_CAPABILITY, "/sync/link/share")),
    );

    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/shares/share-0/links/${first.grantId}/rotate`,
            { method: "POST" },
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      await denialBytes(await h(linkRequest(first.capability, "/sync/link/share"))),
    ).toBe(unknown);

    const secondLink = await json(
      await h(
        request(
          OWNER,
          `/sync/${WORKSPACE}/shares/share-0/links`,
          jsonBody({ access: "view" }),
        ),
      ),
    );
    const secondExchange = await json(
      await h(request(null, "/sync/link-exchange", jsonBody({ secret: secondLink.secret }))),
    );
    expect(
      (
        await h(
          request(
            OWNER,
            "/sync/shares/share-0/revoke",
            jsonBody({ grantId: secondLink.grantId }),
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      await denialBytes(
        await h(linkRequest(String(secondExchange.capabilityToken), "/sync/link/log")),
      ),
    ).toBe(unknown);

    const thirdLink = await json(
      await h(
        request(
          OWNER,
          `/sync/${WORKSPACE}/shares/share-0/links`,
          jsonBody({ access: "view" }),
        ),
      ),
    );
    const thirdExchange = await json(
      await h(request(null, "/sync/link-exchange", jsonBody({ secret: thirdLink.secret }))),
    );
    now += LINK_SESSION_TTL_MS;
    expect(
      await denialBytes(
        await h(
          linkRequest(String(thirdExchange.capabilityToken), `/sync/link/blobs/${first.sharedSha}`),
        ),
      ),
    ).toBe(unknown);
  });

  it("rechecks metadata after its asynchronous display lookup", async () => {
    const storage = await newStorage();
    let resolveLookup!: (email: string) => void;
    const lookup = new Promise<string>((resolve) => {
      resolveLookup = resolve;
    });
    let holdLookup = false;
    const h = handler(storage, {
      lookupUserEmail: (userId) =>
        holdLookup ? lookup : `${userId}@example.test`,
    });
    const seeded = await seed(h);
    holdLookup = true;
    const pending = h(linkRequest(seeded.capability, "/sync/link/share"));
    await Promise.resolve();
    expect(
      storage.revokeShareGrant({
        shareId: "share-0",
        grantId: seeded.grantId,
        revokedAtMs: 2_001,
      }),
    ).toMatchObject({ ok: true });
    resolveLookup(`${OWNER}@example.test`);
    expect((await pending).status).toBe(404);
  });

  it("rechecks log and blob reads after storage work", async () => {
    for (const racedMethod of ["fetchLogPage", "getBlob"] as const) {
      const target = await newStorage();
      let grantId = "";
      let armed = false;
      const raced = new Proxy(target, {
        get(storage, property, receiver) {
          const value = Reflect.get(storage, property, receiver) as unknown;
          if (property !== racedMethod || typeof value !== "function") {
            return typeof value === "function" ? value.bind(storage) : value;
          }
          return (...args: unknown[]) => {
            const result = (value as (...callArgs: unknown[]) => unknown).apply(storage, args);
            if (armed) {
              armed = false;
              storage.revokeShareGrant({
                shareId: "share-0",
                grantId,
                revokedAtMs: 2_001,
              });
            }
            return result;
          };
        },
      });
      const h = handler(raced);
      const seeded = await seed(h);
      grantId = seeded.grantId;
      armed = true;
      const path =
        racedMethod === "fetchLogPage"
          ? "/sync/link/log"
          : `/sync/link/blobs/${seeded.sharedSha}`;
      expect((await h(linkRequest(seeded.capability, path))).status).toBe(404);
    }
  });

  it("rate-limits only after capability authentication", async () => {
    const storage = await newStorage();
    const limiter = new LinkReadRateLimiter(1, 0.000_001, 10);
    const h = handler(storage, { linkReadRateLimiter: limiter });
    const seeded = await seed(h);
    expect((await h(linkRequest(UNKNOWN_CAPABILITY, "/sync/link/share"))).status).toBe(404);
    expect((await h(linkRequest(seeded.capability, "/sync/link/share"))).status).toBe(200);
    const limited = await h(linkRequest(seeded.capability, "/sync/link/share"));
    expect(limited.status).toBe(429);
    expect(await json(limited)).toMatchObject({ code: "link_read_rate_limited" });
  });
});
