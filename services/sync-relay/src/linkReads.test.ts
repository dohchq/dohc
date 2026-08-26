import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LinkReadRateLimiter,
  LINK_SESSION_TTL_MS,
} from "./linkSecurity";
import { filterOpForShare, type ShareSelector } from "./shareFilter";
import {
  createSyncRelayHandler,
  LINK_CAPABILITY_READ_FALLBACK_PAGE_BUDGET,
  type SyncRelayHandler,
} from "./server";
import {
  openSyncRelayStorage,
  SHARED_BLOB_CANDIDATE_LIMIT,
  type SyncRelayStorage,
} from "./storage";

const OWNER = "owner";
const RECIPIENT = "recipient";
const WORKSPACE = "workspace-link-reads";
const LINK_KEY = "test-link-key-with-at-least-thirty-two-bytes";
const UNKNOWN_CAPABILITY = "z".repeat(43);
const LINK_REFUSAL_BODY = '{"ok":false,"error":"not found","code":"not_found"}';
const EPOCH_1 = "epoch-1";
const STREAM_1 = "stream-1";
const EPOCH_2 = "epoch-2";
const STREAM_2 = "stream-2";

type TestWorkspaceIdentity = {
  replicationEpoch: string;
  streamIdentity: string;
};

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

function forceBlobFallback(storage: SyncRelayStorage): SyncRelayStorage {
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property === "latestLogRowForObjectInVersion") return () => null;
      if (property === "objectIdAtPathInVersion") return () => undefined;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function handler(
  storage: SyncRelayStorage,
  options: {
    nowMs?: () => number;
    linkReadRateLimiter?: LinkReadRateLimiter;
    linkLogReadRateLimiter?: LinkReadRateLimiter;
    linkCapabilityReadFallbackPageSize?: number;
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
    newShareId: () => `share-${id++}`,
    newGrantId: () => `grant-${id++}`,
    newId: () => `id-${id++}`,
    linkKey: LINK_KEY,
    linkReadRateLimiter: options.linkReadRateLimiter,
    linkLogReadRateLimiter: options.linkLogReadRateLimiter,
    linkCapabilityReadFallbackPageSize:
      options.linkCapabilityReadFallbackPageSize,
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

type MomentOptions = {
  versionId?: string;
  objectId?: string | null;
  operation?: "write" | "rename" | "delete";
  beforePath?: string | null;
  beforeContent?: string | null;
  afterPath?: string | null;
  afterContent?: string | null;
};

function moment(
  originSeq: number,
  path: string,
  content: string,
  recordedAtMs: number,
  options: MomentOptions = {},
) {
  const beforeContent = options.beforeContent ?? null;
  const afterContent =
    options.afterContent === undefined ? content : options.afterContent;
  const beforePath = options.beforePath ?? null;
  const afterPath = options.afterPath === undefined ? path : options.afterPath;
  return {
    originSeq,
    opKind: "moment.append",
    payload: {
      momentId: `moment-${originSeq}`,
      versionId: options.versionId ?? "main",
      objectId:
        options.objectId === undefined ? `object-${originSeq}` : options.objectId,
      path,
      recordedAtMs,
      operation: options.operation ?? "write",
      payloadBeforeBlobSha256:
        beforeContent === null ? null : sha256(beforeContent),
      payloadBeforePath: beforePath,
      payloadAfterBlobSha256:
        afterContent === null ? null : sha256(afterContent),
      payloadAfterPath: afterPath,
      metadata: { origin: "user" },
      beforePresent: beforeContent === null ? "null" : "present",
    },
    recordedAtMs,
  };
}

async function appendMoments(
  h: SyncRelayHandler,
  ops: ReturnType<typeof moment>[],
  options: {
    originId?: string;
    identity?: TestWorkspaceIdentity;
  } = {},
): Promise<void> {
  expect(
    (
      await h(
        request(
          OWNER,
          `/sync/${WORKSPACE}/log`,
          jsonBody({
            originId: options.originId ?? "origin-a",
            ops,
            ...(options.identity ?? {}),
          }),
        ),
      )
    ).status,
  ).toBe(200);
}

async function createLink(
  h: SyncRelayHandler,
  input: {
    paths: string[];
    versionId?: string;
    access: "view" | "comment" | "edit";
  },
): Promise<{ capability: string; grantId: string }> {
  const share = await json(
    await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares`,
        jsonBody({
          recipientUserId: RECIPIENT,
          paths: input.paths,
          access: input.access,
          ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
        }),
      ),
    ),
  );
  const link = await json(
    await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/${String(share.shareId)}/links`,
        jsonBody({ access: input.access }),
      ),
    ),
  );
  const exchange = await json(
    await h(request(null, "/sync/link-exchange", jsonBody({ secret: link.secret }))),
  );
  return {
    capability: String(exchange.capabilityToken),
    grantId: String(link.grantId),
  };
}

async function seed(
  h: SyncRelayHandler,
  access: "view" | "comment" | "edit" = "view",
  selector: {
    paths?: string[];
    versionId?: string;
    sharedVersionId?: string;
    sharedObjectId?: string | null;
  } = {},
  identity?: TestWorkspaceIdentity,
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
              moment(1, "docs/shared.md", "# shared\n", 1_100, {
                versionId: selector.sharedVersionId,
                objectId:
                  selector.sharedObjectId === undefined
                    ? "object-shared"
                    : selector.sharedObjectId,
              }),
              moment(2, "private/hidden.md", "hidden\n", 1_200),
            ],
            ...(identity ?? {}),
          }),
        ),
      )
    ).status,
  ).toBe(200);
  const link = await createLink(h, {
    paths: selector.paths ?? ["docs"],
    ...(selector.versionId === undefined ? {} : { versionId: selector.versionId }),
    access,
  });
  return {
    ...link,
    sharedSha,
    hiddenSha,
  };
}

async function seedThenRotate(h: SyncRelayHandler) {
  const seeded = await seed(h, "view", {}, {
    replicationEpoch: EPOCH_1,
    streamIdentity: STREAM_1,
  });
  expect(
    (
      await h(
        request(
          OWNER,
          `/sync/${WORKSPACE}/epoch`,
          jsonBody({ replicationEpoch: EPOCH_2, streamIdentity: STREAM_2 }),
        ),
      )
    ).status,
  ).toBe(200);
  return seeded;
}

async function appendAfterRotation(h: SyncRelayHandler): Promise<string> {
  const content = "# after rotation\n";
  const sha = await putBlob(h, content);
  await appendMoments(
    h,
    [
      moment(0, "docs/after-rotation.md", content, 1_300, {
        objectId: "object-after-rotation",
      }),
    ],
    {
      originId: "origin-b",
      identity: { replicationEpoch: EPOCH_2, streamIdentity: STREAM_2 },
    },
  );
  return sha;
}

async function denialBytes(response: Response): Promise<string> {
  expect(response.status).toBe(404);
  return `${response.status}:${await response.text()}`;
}

async function capabilityRefusalBody(response: Response): Promise<string> {
  expect(response.status).toBe(401);
  const body = await response.text();
  expect(body).toBe(LINK_REFUSAL_BODY);
  return body;
}

describe("relay capability reads", () => {
  it.each([
    ["metadata", "/sync/link/share"],
    ["log", "/sync/link/log"],
    ["blob", `/sync/link/blobs/${sha256("missing")}`],
  ])("answers an invalid capability on the %s route with the generic 401 refusal", async (_name, path) => {
    const storage = await newStorage();
    const response = await handler(storage)(linkRequest(UNKNOWN_CAPABILITY, path));

    expect({ status: response.status, body: await response.text() }).toEqual({
      status: 401,
      body: LINK_REFUSAL_BODY,
    });
  });

  it("keeps an unknown blob behind a valid capability at the generic 404", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const response = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${sha256("missing")}`),
    );

    expect({ status: response.status, body: await response.text() }).toEqual({
      status: 404,
      body: LINK_REFUSAL_BODY,
    });
  });

  it("matches the view recipient file and blob boundary without its identity metadata", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const { capability, sharedSha, hiddenSha } = await seed(h, "view");

    const recipientMeta = await json(await h(request(RECIPIENT, "/sync/shares/share-0")));
    const linkMetaResponse = await h(linkRequest(capability, "/sync/link/share"));
    expect(linkMetaResponse.status).toBe(200);
    const linkMeta = await json(linkMetaResponse);
    expect(linkMeta).toEqual({
      ok: true,
      effectiveSelector: {
        ...(recipientMeta.selector as Record<string, unknown>),
        access: "view",
      },
      access: "view",
      lastSettledAtMs: 1_100,
      lastSettledKnown: true,
    });
    expect(linkMeta).not.toHaveProperty("granterEmail");
    expect(linkMeta).not.toHaveProperty("workspaceId");
    expect(linkMeta).not.toHaveProperty("grantId");
    expect(linkMeta).not.toHaveProperty("participants");

    const recipientLog = await json(
      await h(request(RECIPIENT, "/sync/shares/share-0/log?since=0&limit=100")),
    );
    const linkLog = await json(
      await h(linkRequest(capability, "/sync/link/log?since=0&limit=100")),
    );
    const linkOps = (recipientLog.ops as Array<Record<string, unknown>>).map(
      ({ originId: _originId, ...op }) => op,
    );
    expect(linkLog).toEqual({ ...recipientLog, ops: linkOps });
    expect(linkOps.every((op) => !Object.hasOwn(op, "originId"))).toBe(true);
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
  });

  it("keeps accountless log pages to viewer artifact rows without changing authenticated logs", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h, "view");
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/${WORKSPACE}/log`,
            jsonBody({
              originId: "origin-a",
              ops: [
                {
                  originSeq: 3,
                  opKind: "chat.thread.create",
                  payload: {
                    threadId: "thread-shared",
                    title: "About the shared file",
                    createdAtMs: 1_300,
                    linkedAtMs: 1_300,
                    linkedObjectId: "object-shared",
                    linkedPathHint: "docs/shared.md",
                  },
                  recordedAtMs: 1_300,
                },
                {
                  originSeq: 4,
                  opKind: "chat.message.append",
                  payload: {
                    messageId: "message-shared",
                    threadId: "thread-shared",
                    authorKind: "human",
                    authorDisplayName: "Owner",
                    authorUserId: OWNER,
                    body: "The file looks ready.",
                    createdAtMs: 1_400,
                  },
                  recordedAtMs: 1_400,
                },
              ],
            }),
          ),
        )
      ).status,
    ).toBe(200);

    const authenticatedLog = await json(
      await h(request(RECIPIENT, "/sync/shares/share-0/log?since=0&limit=100")),
    );
    const authenticatedOps = authenticatedLog.ops as Array<{
      relaySeq: number;
      originId: string;
      originSeq: number;
      opKind: string;
      payload: Record<string, unknown>;
      recordedAtMs: number;
    }>;
    expect(authenticatedOps.find((op) => op.opKind === "chat.message.append")).toEqual({
      relaySeq: 5,
      originId: "origin-a",
      originSeq: 4,
      opKind: "chat.message.append",
      payload: {
        messageId: "message-shared",
        threadId: "thread-shared",
        authorKind: "human",
        authorDisplayName: "Owner",
        authorUserId: OWNER,
        body: "The file looks ready.",
        createdAtMs: 1_400,
      },
      recordedAtMs: 1_400,
    });

    const linkLog = await json(
      await h(linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100")),
    );
    const expectedLinkOps = authenticatedOps
      .filter((op) =>
        ["workspace.init", "moment.append", "version.create"].includes(op.opKind),
      )
      .map(({ originId: _originId, ...op }) => op);
    expect(linkLog).toEqual({
      ok: true,
      ops: expectedLinkOps,
      nextCursor: authenticatedLog.nextCursor,
      hasMore: authenticatedLog.hasMore,
    });
    expect(
      (linkLog.ops as Array<Record<string, unknown>>).every(
        (op) => !Object.hasOwn(op, "originId"),
      ),
    ).toBe(true);
    // The excluded kinds by name: a widened accountless boundary must fail
    // here even if the expected-list above is ever derived from the server.
    const chatKinds = [
      "chat.thread.create",
      "chat.message.append",
      "chat.reaction.set",
      "chat.decision.set",
      "chat.attachment.add",
    ];
    expect(
      (linkLog.ops as Array<{ opKind: string }>).some((op) =>
        chatKinds.includes(op.opKind),
      ),
    ).toBe(false);

    const skippedThreadPage = await json(
      await h(linkRequest(seeded.capability, "/sync/link/log?since=3&limit=1")),
    );
    expect(skippedThreadPage).toEqual({ ok: true, ops: [], nextCursor: 4, hasMore: true });
    const skippedMessagePage = await json(
      await h(linkRequest(seeded.capability, "/sync/link/log?since=4&limit=1")),
    );
    expect(skippedMessagePage).toEqual({ ok: true, ops: [], nextCursor: 5, hasMore: false });
  });

  it("keeps link log pages and freshness above the workspace epoch floor", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seedThenRotate(h);

    const rotatedLog = await json(
      await h(linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100")),
    );
    expect(rotatedLog).toMatchObject({ ok: true, ops: [], hasMore: false });

    const rotatedShare = await json(
      await h(linkRequest(seeded.capability, "/sync/link/share")),
    );
    expect(rotatedShare.lastSettledAtMs).toBeNull();
    expect(rotatedShare.lastSettledKnown).toBe(true);

    await appendAfterRotation(h);
    const currentLog = await json(
      await h(linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100")),
    );
    expect(
      (currentLog.ops as Array<{ payload: { payloadAfterPath?: string } }>).map(
        (op) => op.payload.payloadAfterPath,
      ),
    ).toEqual(["docs/after-rotation.md"]);
    const currentShare = await json(
      await h(linkRequest(seeded.capability, "/sync/link/share")),
    );
    expect(currentShare.lastSettledAtMs).toBe(1_300);
    expect(currentShare.lastSettledKnown).toBe(true);
  });

  it("serves only blobs established above the workspace epoch floor", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seedThenRotate(h);

    expect(
      await denialBytes(
        await h(
          linkRequest(
            seeded.capability,
            `/sync/link/blobs/${seeded.sharedSha}`,
          ),
        ),
      ),
    ).toBe(`404:${LINK_REFUSAL_BODY}`);

    const currentSha = await appendAfterRotation(h);
    const currentBlob = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${currentSha}`),
    );
    expect(currentBlob.status).toBe(200);
    expect(await currentBlob.text()).toBe("# after rotation\n");
  });

  it("refuses a path-shared blob after a later delete supersedes its file", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);

    const beforeDelete = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`),
    );
    expect(beforeDelete.status).toBe(200);
    expect(await beforeDelete.text()).toBe("# shared\n");

    await appendMoments(h, [
      moment(3, "docs/shared.md", "# shared\n", 1_300, {
        objectId: "object-shared",
        operation: "delete",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
    ]);

    const missing = await denialBytes(
      await h(
        linkRequest(
          seeded.capability,
          `/sync/link/blobs/${sha256("missing")}`,
        ),
      ),
    );
    expect(
      await denialBytes(
        await h(
          linkRequest(
            seeded.capability,
            `/sync/link/blobs/${seeded.sharedSha}`,
          ),
        ),
      ),
    ).toBe(missing);
  });

  it("serves only the replacement blob and keeps untouched files servable", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const replacement = "# replacement\n";
    const untouched = "# untouched\n";
    const replacementSha = await putBlob(h, replacement);
    const untouchedSha = await putBlob(h, untouched);
    await appendMoments(h, [
      moment(3, "docs/untouched.md", untouched, 1_300, {
        objectId: "object-untouched",
      }),
      moment(4, "docs/shared.md", replacement, 1_400, {
        objectId: "object-shared",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
    ]);

    const missing = await denialBytes(
      await h(
        linkRequest(
          seeded.capability,
          `/sync/link/blobs/${sha256("missing")}`,
        ),
      ),
    );
    expect(
      await denialBytes(
        await h(
          linkRequest(
            seeded.capability,
            `/sync/link/blobs/${seeded.sharedSha}`,
          ),
        ),
      ),
    ).toBe(missing);

    const current = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${replacementSha}`),
    );
    expect(current.status).toBe(200);
    expect(await current.text()).toBe(replacement);

    const untouchedResponse = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${untouchedSha}`),
    );
    expect(untouchedResponse.status).toBe(200);
    expect(await untouchedResponse.text()).toBe(untouched);
  });

  it("refuses a blob after its file moves outside a path selector", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    await appendMoments(h, [
      moment(3, "private/moved.md", "# shared\n", 1_300, {
        objectId: "object-shared",
        operation: "rename",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
    ]);

    expect(
      await denialBytes(
        await h(
          linkRequest(
            seeded.capability,
            `/sync/link/blobs/${seeded.sharedSha}`,
          ),
        ),
      ),
    ).toContain("404:");
  });

  it("keeps a live main-version blob servable after the shared object is edited on a fork", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const forkContent = "# fork edit\n";
    const forkSha = await putBlob(h, forkContent);

    await appendMoments(h, [
      moment(3, "docs/shared.md", forkContent, 1_300, {
        versionId: "fork-1",
        objectId: "object-shared",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
    ]);

    expect(
      await denialBytes(
        await h(linkRequest(seeded.capability, `/sync/link/blobs/${forkSha}`)),
      ),
    ).toBe(`404:${LINK_REFUSAL_BODY}`);

    const mainBlob = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`),
    );
    expect(mainBlob.status).toBe(200);
    expect(await mainBlob.text()).toBe("# shared\n");
  });

  it("keeps a version share's pinned blob servable after the live file moves on", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h, "view", {
      paths: [],
      versionId: "snapshot-1",
      sharedVersionId: "snapshot-1",
    });
    await appendMoments(h, [
      moment(3, "private/moved.md", "# shared\n", 1_300, {
        versionId: "main",
        objectId: "object-shared",
        operation: "rename",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
    ]);

    const pinned = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`),
    );
    expect(pinned.status).toBe(200);
    expect(await pinned.text()).toBe("# shared\n");
  });

  it("serves a version.create-only snapshot blob only through a selector that covers it", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h, "view", {
      paths: ["docs"],
      versionId: "snapshot-1",
    });
    const snapshotContent = "# snapshot only\n";
    const snapshotSha = await putBlob(h, snapshotContent);
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/${WORKSPACE}/log`,
            jsonBody({
              originId: "origin-a",
              ops: [
                {
                  originSeq: 3,
                  opKind: "version.create",
                  payload: {
                    versionId: "snapshot-1",
                    forkSnapshots: [
                      {
                        objectId: "object-snapshot-only",
                        path: "docs/snapshot-only.md",
                        blobSha256: snapshotSha,
                      },
                    ],
                  },
                  recordedAtMs: 1_300,
                },
              ],
            }),
          ),
        )
      ).status,
    ).toBe(200);

    const excluded = await createLink(h, {
      paths: ["private"],
      versionId: "snapshot-1",
      access: "view",
    });

    const covered = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${snapshotSha}`),
    );
    expect(covered.status).toBe(200);
    expect(await covered.text()).toBe(snapshotContent);
    expect(
      await denialBytes(
        await h(
          linkRequest(
            excluded.capability,
            `/sync/link/blobs/${snapshotSha}`,
          ),
        ),
      ),
    ).toBe(`404:${LINK_REFUSAL_BODY}`);
  });

  it("scopes path-share blob candidates before the cap without admitting prefix neighbors", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const docs2OnlyContent = "# docs2 only\n";
    const docs2OnlySha = await putBlob(h, docs2OnlyContent);
    const privateCopies = Array.from(
      { length: SHARED_BLOB_CANDIDATE_LIMIT + 1 },
      (_, index) =>
        moment(
          index + 3,
          `docs2/private-copy-${index}.md`,
          "# shared\n",
          1_300 + index,
          { objectId: `object-private-copy-${index}` },
        ),
    );
    privateCopies.push(
      moment(
        SHARED_BLOB_CANDIDATE_LIMIT + 4,
        "docs2/private-only.md",
        docs2OnlyContent,
        1_400 + SHARED_BLOB_CANDIDATE_LIMIT,
        { objectId: "object-docs2-only" },
      ),
    );
    await appendMoments(h, privateCopies);

    const sharedBlob = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`),
    );
    expect(sharedBlob.status).toBe(200);
    expect(await sharedBlob.text()).toBe("# shared\n");

    expect(
      await denialBytes(
        await h(
          linkRequest(
            seeded.capability,
            `/sync/link/blobs/${docs2OnlySha}`,
          ),
        ),
      ),
    ).toBe(`404:${LINK_REFUSAL_BODY}`);
    const sharedLog = await json(
      await h(linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100")),
    );
    expect(JSON.stringify(sharedLog)).not.toContain("docs2/");
  });

  it("deduplicates and caps blob candidates when one file returns to earlier content", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const alternateContent = "# alternate\n";
    await putBlob(h, alternateContent);
    const ops: ReturnType<typeof moment>[] = [];
    for (let index = 0; index < SHARED_BLOB_CANDIDATE_LIMIT; index += 1) {
      ops.push(
        moment(3 + index, `private/candidate-${index}.md`, "# shared\n", 1_300 + index, {
          objectId: `object-candidate-${index}`,
        }),
      );
    }
    const firstOscillationOriginSeq = 3 + SHARED_BLOB_CANDIDATE_LIMIT;
    for (let index = 0; index <= SHARED_BLOB_CANDIDATE_LIMIT; index += 1) {
      const alternateOriginSeq = firstOscillationOriginSeq + index * 2;
      ops.push(
        moment(alternateOriginSeq, "docs/shared.md", alternateContent, 2_000 + index * 2, {
          objectId: "object-shared",
          beforePath: "docs/shared.md",
          beforeContent: "# shared\n",
        }),
      );
      ops.push(
        moment(alternateOriginSeq + 1, "docs/shared.md", "# shared\n", 2_001 + index * 2, {
          objectId: "object-shared",
          beforePath: "docs/shared.md",
          beforeContent: alternateContent,
        }),
      );
    }
    await appendMoments(h, ops);

    const blob = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`),
    );
    expect(blob.status).toBe(200);
    expect(await blob.text()).toBe("# shared\n");

    const candidates = storage.listObjectMomentLogRowsByBlob({
      workspaceId: WORKSPACE,
      versionId: "main",
      sha256: seeded.sharedSha,
    });
    expect(candidates.length).toBeLessThanOrEqual(SHARED_BLOB_CANDIDATE_LIMIT);
    const candidateObjectIds = candidates.map((row) => {
      const payload: unknown = JSON.parse(row.payloadJson);
      if (payload === null || typeof payload !== "object") return null;
      const objectId: unknown = Reflect.get(payload, "objectId");
      return typeof objectId === "string" ? objectId : null;
    });
    expect(new Set(candidateObjectIds).size).toBe(candidateObjectIds.length);
    expect(candidateObjectIds[0]).toBe("object-shared");
    expect(candidates.map((row) => row.relaySeq)).toEqual(
      [...candidates.map((row) => row.relaySeq)].sort((left, right) => right - left),
    );
  });

  it("makes revoked, rotated, expired, and unknown capability refusals byte-identical", async () => {
    let now = 2_000;
    const storage = await newStorage();
    const h = handler(storage, { nowMs: () => now });
    const first = await seed(h);
    const unknown = await capabilityRefusalBody(
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
      await capabilityRefusalBody(await h(linkRequest(first.capability, "/sync/link/share"))),
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
      await capabilityRefusalBody(
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
      await capabilityRefusalBody(
        await h(
          linkRequest(String(thirdExchange.capabilityToken), `/sync/link/blobs/${first.sharedSha}`),
        ),
      ),
    ).toBe(unknown);
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
      expect((await h(linkRequest(seeded.capability, path))).status).toBe(401);
    }
  });

  it("reports unknown freshness when the first shared row is beyond the fallback page budget", async () => {
    const pageSize = 2;
    const storage = await newStorage();
    const h = handler(storage, {
      linkCapabilityReadFallbackPageSize: pageSize,
    });
    const seeded = await seed(h);
    const rowsPerBudget =
      LINK_CAPABILITY_READ_FALLBACK_PAGE_BUDGET * pageSize;
    await appendMoments(
      h,
      Array.from({ length: rowsPerBudget - 1 }, (_, index) =>
        moment(
          index + 3,
          `private/freshness-noise-${index}.md`,
          "hidden\n",
          1_300 + index,
        ),
      ),
    );

    const metadata = await json(
      await h(linkRequest(seeded.capability, "/sync/link/share")),
    );

    expect(metadata.lastSettledAtMs).toBeNull();
    expect(metadata.lastSettledKnown).toBe(false);
  });

  it("refuses a fallback blob when the forward walk exceeds the page budget", async () => {
    const pageSize = 2;
    const storage = await newStorage();
    const h = handler(forceBlobFallback(storage), {
      linkCapabilityReadFallbackPageSize: pageSize,
    });
    const seeded = await seed(h);
    const rowsPerBudget =
      LINK_CAPABILITY_READ_FALLBACK_PAGE_BUDGET * pageSize;
    await appendMoments(
      h,
      Array.from({ length: rowsPerBudget }, (_, index) =>
        moment(
          index + 3,
          `private/blob-noise-${index}.md`,
          "hidden\n",
          1_300 + index,
        ),
      ),
    );

    expect(
      await denialBytes(
        await h(
          linkRequest(
            seeded.capability,
            `/sync/link/blobs/${seeded.sharedSha}`,
          ),
        ),
      ),
    ).toBe(`404:${LINK_REFUSAL_BODY}`);
  });

  it("keeps freshness and fallback blobs unchanged when the log fits the page budget", async () => {
    const storage = await newStorage();
    const h = handler(forceBlobFallback(storage), {
      linkCapabilityReadFallbackPageSize: 2,
    });
    const seeded = await seed(h);

    const metadata = await json(
      await h(linkRequest(seeded.capability, "/sync/link/share")),
    );
    expect(metadata.lastSettledAtMs).toBe(1_100);
    expect(metadata.lastSettledKnown).toBe(true);

    const blob = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`),
    );
    expect(blob.status).toBe(200);
    expect(await blob.text()).toBe("# shared\n");
  });

  it("keeps file-link freshness on the latest artifact operation when chat is newer", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h, "view");
    await appendMoments(h, [
      moment(3, "docs/shared.md", "# shared\n", 1_300, {
        objectId: "object-shared",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
    ]);
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/${WORKSPACE}/log`,
            jsonBody({
              originId: "origin-a",
              ops: [
                {
                  originSeq: 4,
                  opKind: "chat.thread.create",
                  payload: {
                    threadId: "thread-shared",
                    title: "About the shared file",
                    createdAtMs: 1_400,
                    linkedAtMs: 1_400,
                    linkedObjectId: "object-shared",
                    linkedPathHint: "docs/shared.md",
                  },
                  recordedAtMs: 1_400,
                },
                {
                  originSeq: 5,
                  opKind: "chat.message.append",
                  payload: {
                    messageId: "message-shared",
                    threadId: "thread-shared",
                    authorKind: "human",
                    authorDisplayName: "Owner",
                    authorUserId: OWNER,
                    body: "The file looks ready.",
                    createdAtMs: 1_500,
                  },
                  recordedAtMs: 1_500,
                },
              ],
            }),
          ),
        )
      ).status,
    ).toBe(200);

    const metadata = await json(
      await h(linkRequest(seeded.capability, "/sync/link/share")),
    );
    expect(metadata.lastSettledAtMs).toBe(1_300);
  });

  it("moves file-link freshness when a file write follows chat", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h, "view");
    await putBlob(h, "# updated\n");
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/${WORKSPACE}/log`,
            jsonBody({
              originId: "origin-a",
              ops: [
                {
                  originSeq: 3,
                  opKind: "chat.thread.create",
                  payload: {
                    threadId: "thread-shared",
                    title: "About the shared file",
                    createdAtMs: 1_300,
                    linkedAtMs: 1_300,
                    linkedObjectId: "object-shared",
                    linkedPathHint: "docs/shared.md",
                  },
                  recordedAtMs: 1_300,
                },
                {
                  originSeq: 4,
                  opKind: "chat.message.append",
                  payload: {
                    messageId: "message-shared",
                    threadId: "thread-shared",
                    authorKind: "human",
                    authorDisplayName: "Owner",
                    authorUserId: OWNER,
                    body: "Please update the file.",
                    createdAtMs: 1_400,
                  },
                  recordedAtMs: 1_400,
                },
                moment(5, "docs/shared.md", "# updated\n", 1_500, {
                  objectId: "object-shared",
                  beforePath: "docs/shared.md",
                  beforeContent: "# shared\n",
                }),
              ],
            }),
          ),
        )
      ).status,
    ).toBe(200);

    const metadata = await json(
      await h(linkRequest(seeded.capability, "/sync/link/share")),
    );
    expect(metadata.lastSettledAtMs).toBe(1_500);
  });

  it("matches the former full-scan freshness result on interleaved rows", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/${WORKSPACE}/log`,
            jsonBody({
              originId: "origin-a",
              ops: [
                moment(3, "docs/newer.md", "# shared\n", 1_300),
                moment(4, "private/newer.md", "hidden\n", 1_400),
              ],
            }),
          ),
        )
      ).status,
    ).toBe(200);

    const newestPage = storage.fetchLogPageDescending({
      workspaceId: WORKSPACE,
      beforeRelaySeq: null,
      limit: 2,
    });
    expect(newestPage.map((row) => row.recordedAtMs)).toEqual([1_400, 1_300]);
    const nextPage = storage.fetchLogPageDescending({
      workspaceId: WORKSPACE,
      beforeRelaySeq: newestPage.at(-1)!.relaySeq,
      limit: 2,
    });
    expect(nextPage.map((row) => row.recordedAtMs)).toEqual([1_200, 1_100]);

    const selector: ShareSelector = {
      paths: ["docs"],
      versionId: null,
      access: "view",
    };
    let cursor = 0;
    let formerFullScanAnswer: number | null = null;
    while (true) {
      const page = storage.fetchLogPage({
        workspaceId: WORKSPACE,
        sinceRelaySeq: cursor,
        limit: 2,
      });
      for (const row of page.rows) {
        if (!filterOpForShare(selector, row.opKind, row.payloadJson).allowed) continue;
        formerFullScanAnswer =
          formerFullScanAnswer === null
            ? row.recordedAtMs
            : Math.max(formerFullScanAnswer, row.recordedAtMs);
      }
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }

    const metadata = await json(
      await h(linkRequest(seeded.capability, "/sync/link/share")),
    );
    expect(formerFullScanAnswer).toBe(1_300);
    expect(metadata.lastSettledAtMs).toBe(formerFullScanAnswer);
  });

  it("rate-limits only after capability authentication", async () => {
    const storage = await newStorage();
    const limiter = new LinkReadRateLimiter(1, 0.000_001, 10);
    const h = handler(storage, { linkReadRateLimiter: limiter });
    const seeded = await seed(h);
    expect((await h(linkRequest(UNKNOWN_CAPABILITY, "/sync/link/share"))).status).toBe(401);
    expect((await h(linkRequest(seeded.capability, "/sync/link/share"))).status).toBe(200);
    const limited = await h(linkRequest(seeded.capability, "/sync/link/share"));
    expect(limited.status).toBe(429);
    expect(await json(limited)).toMatchObject({ code: "link_read_rate_limited" });
  });

  it("uses a separate read bucket for link log pages", async () => {
    const storage = await newStorage();
    const h = handler(storage, {
      linkReadRateLimiter: new LinkReadRateLimiter(1, 0.000_001, 10),
      linkLogReadRateLimiter: new LinkReadRateLimiter(1, 0.000_001, 10),
    });
    const seeded = await seed(h);

    expect((await h(linkRequest(seeded.capability, "/sync/link/share"))).status).toBe(200);
    const limitedBlob = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`),
    );
    expect(limitedBlob.status).toBe(429);
    expect(await json(limitedBlob)).toEqual({
      ok: false,
      error: "too many link reads",
      code: "link_read_rate_limited",
    });

    expect((await h(linkRequest(seeded.capability, "/sync/link/log"))).status).toBe(200);
    const limitedLog = await h(linkRequest(seeded.capability, "/sync/link/log"));
    expect(limitedLog.status).toBe(429);
    expect(await json(limitedLog)).toEqual({
      ok: false,
      error: "too many link reads",
      code: "link_read_rate_limited",
    });
  });
});
