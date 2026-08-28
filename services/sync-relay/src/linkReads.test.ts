import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filesFromAccumulator,
  foldLogOps,
  type FileAccumulator,
  type RelayOp,
} from "../../share-web/viewer/src/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hashLinkBearer,
  LinkEgressRateLimiter,
  LinkExchangeRateLimiter,
  LinkReadRateLimiter,
  LINK_GRANT_EGRESS_BUCKET_CAPACITY_BYTES,
  LINK_GRANT_EGRESS_REFILL_BYTES_PER_SECOND,
  LINK_GRANT_LOG_READ_BUCKET_CAPACITY,
  LINK_GRANT_READ_BUCKET_CAPACITY,
  LINK_LOG_READ_BUCKET_CAPACITY,
  LINK_READ_BUCKET_CAPACITY,
  LINK_SESSION_TTL_MS,
} from "./linkSecurity";
import { linkSecret } from "./linkTestHelpers";
import { filterOpForShare, type ShareSelector } from "./shareFilter";
import {
  createSyncRelayHandler,
  LINK_CAPABILITY_READ_FALLBACK_PAGE_BUDGET,
  MAX_BLOB_BYTES,
  MAX_RAW_ROWS_PER_LINK_PAGE,
  type SyncRelayHandler,
} from "./server";
import {
  currentFileStateQuery,
  openSyncRelayStorage,
  SHARED_BLOB_CANDIDATE_LIMIT,
  type SyncRelayStorage,
} from "./storage";

interface InspectionDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): Array<Record<string, unknown>>;
    iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
    run(...params: unknown[]): unknown;
  };
}

const { DatabaseSync: InspectionDatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => InspectionDatabase;
};

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
const storagePaths = new WeakMap<SyncRelayStorage, string>();

afterEach(async () => {
  for (const storage of storages.splice(0)) storage.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newStorage(): Promise<SyncRelayStorage> {
  const root = await mkdtemp(join(tmpdir(), "dohc-link-reads-"));
  roots.push(root);
  const dbPath = join(root, "relay.sqlite");
  const storage = openSyncRelayStorage(dbPath);
  storagePaths.set(storage, dbPath);
  storages.push(storage);
  return storage;
}

function handler(
  storage: SyncRelayStorage,
  options: {
    nowMs?: () => number;
    linkExchangeRateLimiter?: LinkExchangeRateLimiter;
    linkReadRateLimiter?: LinkReadRateLimiter;
    linkGrantReadRateLimiter?: LinkReadRateLimiter;
    linkLogReadRateLimiter?: LinkReadRateLimiter;
    linkGrantLogReadRateLimiter?: LinkReadRateLimiter;
    linkGrantEgressRateLimiter?: LinkEgressRateLimiter;
    linkCapabilityReadFallbackPageSize?: number;
    linkCurrentFileLimit?: number;
    newLinkBearer?: () => string;
  } = {},
): SyncRelayHandler {
  let id = 0;
  const handlerOptions = {
    storage,
    resolveActor(request: Request, workspaceId: string) {
      const match = /^Bearer user:([^ ]+)$/u.exec(request.headers.get("authorization") ?? "");
      if (!match) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
      return { userId: match[1]!, workspaceId };
    },
    nowMs: options.nowMs ?? (() => 2_000),
    newShareId: () => `share-${id++}`,
    newGrantId: () => `grant-${id++}`,
    newId: () => `id-${id++}`,
    linkKey: LINK_KEY,
    shareWebOrigin: "https://share.example.test",
    linkExchangeRateLimiter: options.linkExchangeRateLimiter,
    linkReadRateLimiter: options.linkReadRateLimiter,
    linkGrantReadRateLimiter: options.linkGrantReadRateLimiter,
    linkLogReadRateLimiter: options.linkLogReadRateLimiter,
    linkGrantLogReadRateLimiter: options.linkGrantLogReadRateLimiter,
    linkGrantEgressRateLimiter: options.linkGrantEgressRateLimiter,
    linkCapabilityReadFallbackPageSize:
      options.linkCapabilityReadFallbackPageSize,
    linkCurrentFileLimit: options.linkCurrentFileLimit,
    newLinkBearer: options.newLinkBearer,
  };
  return createSyncRelayHandler(handlerOptions);
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

class KeyIgnoringLinkReadRateLimiter extends LinkReadRateLimiter {
  override allow(_key: string, nowMs: number): boolean {
    return super.allow("shared-test-bucket", nowMs);
  }
}

describe("linkSecret", () => {
  const secret = "a".repeat(43);

  it("returns the fragment from a canonical minted URL", () => {
    expect(linkSecret(`https://share.example.test/s/#${secret}`)).toBe(secret);
  });

  it.each([
    ["a non-string", null],
    ["a path without the trailing slash", `https://share.example.test/s#${secret}`],
    ["a nested path", `https://share.example.test/s/more/#${secret}`],
    ["an empty query marker", `https://share.example.test/s/?#${secret}`],
    ["a query value", `https://share.example.test/s/?source=test#${secret}`],
    ["a missing fragment", "https://share.example.test/s/"],
    ["a short fragment", `https://share.example.test/s/#${"a".repeat(42)}`],
    ["a long fragment", `https://share.example.test/s/#${"a".repeat(44)}`],
    ["a non-base64url fragment", `https://share.example.test/s/#${"a".repeat(42)}+`],
  ])("rejects %s", (_shape, value) => {
    expect(() => linkSecret(value)).toThrow();
  });
});

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

function appendStoredMoments(
  storage: SyncRelayStorage,
  ops: ReturnType<typeof moment>[],
): void {
  storage.appendLogBatch({
    workspaceId: WORKSPACE,
    originId: "origin-a",
    ops: ops.map(({ payload, ...op }) => ({
      ...op,
      payloadJson: JSON.stringify(payload),
    })),
  });
}

async function createLink(
  h: SyncRelayHandler,
  input: {
    paths: string[];
    versionId?: string;
    access: "view" | "comment" | "edit";
  },
): Promise<{
  capability: string;
  exchange: Record<string, unknown>;
  grantId: string;
  secret: string;
  shareId: string;
}> {
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
  const secret = linkSecret(link.url);
  const exchange = await json(
    await h(request(null, "/sync/link-exchange", jsonBody({ secret }))),
  );
  return {
    capability: String(exchange.capabilityToken),
    exchange,
    grantId: String(link.grantId),
    secret,
    shareId: String(share.shareId),
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
): Promise<{
  capability: string;
  grantId: string;
  hiddenSha: string;
  secret: string;
  sharedSha: string;
}> {
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
  await rotateWorkspaceIdentity(h);
  return seeded;
}

async function rotateWorkspaceIdentity(h: SyncRelayHandler): Promise<void> {
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

async function ownerLinkUsage(
  h: SyncRelayHandler,
  grantId: string,
): Promise<{ lastUsedAtMs: unknown; urlIssuedAtMs: unknown }> {
  const response = await h(request(OWNER, `/sync/${WORKSPACE}/shares/links`));
  expect(response.status).toBe(200);
  const links = (await json(response)).links as Array<Record<string, unknown>>;
  const row = links.find((candidate) => candidate.grantId === grantId);
  expect(row).toBeDefined();
  return {
    lastUsedAtMs: row!.lastUsedAtMs,
    urlIssuedAtMs: row!.urlIssuedAtMs,
  };
}

async function capabilityRefusalBody(response: Response): Promise<string> {
  expect(response.status).toBe(401);
  const body = await response.text();
  expect(body).toBe(LINK_REFUSAL_BODY);
  return body;
}

async function readRemainingBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  firstChunk: Uint8Array,
): Promise<Uint8Array> {
  const chunks = [firstChunk];
  let byteLength = firstChunk.byteLength;
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    chunks.push(read.value);
    byteLength += read.value.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

describe("LinkEgressRateLimiter", () => {
  it("evicts a fully refilled bucket without resetting active grant debt", () => {
    const limiter = new LinkEgressRateLimiter(10, 1, 2);

    expect(limiter.charge("target", 10, 0)).toBe(true);
    expect(limiter.charge("refilled", 1, 1_000)).toBe(true);
    expect(limiter.charge("newcomer", 1, 2_000)).toBe(true);

    expect(limiter.charge("target", 10, 2_000)).toBe(false);
    expect(limiter.charge("target", 2, 2_000)).toBe(true);
  });

  it("refuses a new grant while every tracked bucket carries debt", () => {
    const limiter = new LinkEgressRateLimiter(10, 1, 2);

    expect(limiter.charge("target", 10, 0)).toBe(true);
    expect(limiter.charge("other", 10, 1_000)).toBe(true);

    expect(limiter.charge("newcomer", 1, 2_000)).toBe(false);
    expect(limiter.charge("target", 10, 2_000)).toBe(false);
    expect(limiter.charge("target", 2, 2_000)).toBe(true);
    expect(limiter.charge("other", 1, 2_000)).toBe(true);
  });
});

describe("relay capability reads", () => {
  it("projects only the selected current files from a fresh view capability", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);

    const response = await h(
      linkRequest(seeded.capability, "/sync/link/current"),
    );

    expect(response.status).toBe(200);
    const projection = await json(response);
    expect(projection).toMatchObject({
      ok: true,
      access: "view",
      effectiveSelector: {
        paths: ["docs"],
        versionId: null,
        access: "view",
      },
      files: [{
        path: "docs/shared.md",
        blobSha256: seeded.sharedSha,
        contentKind: "text",
      }],
      nextCursor: 3,
      epochLogFloor: 0,
      lastSettledAtMs: 1_100,
      lastSettledKnown: true,
    });
    expect(Object.keys(projection).sort()).toEqual([
      "access",
      "effectiveSelector",
      "epochLogFloor",
      "files",
      "lastSettledAtMs",
      "lastSettledKnown",
      "nextCursor",
      "ok",
    ]);
    expect(Object.keys((projection.files as Array<Record<string, unknown>>)[0]!).sort())
      .toEqual(["blobSha256", "contentKind", "path"]);
    const serialized = JSON.stringify(projection);
    for (const privateValue of [
      "private/hidden.md",
      seeded.hiddenSha,
      "object-shared",
      "moment-1",
      "owner",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("materializes the viewer CAS fold per version and uses the selected path index", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const acceptedContent = "accepted\n";
    const staleContent = "stale\n";
    const neighborContent = "neighbor\n";
    const sideContent = "side version\n";
    const acceptedSha = await putBlob(h, acceptedContent);
    const staleSha = await putBlob(h, staleContent);
    const neighborSha = await putBlob(h, neighborContent);
    const sideSha = await putBlob(h, sideContent);
    await appendMoments(h, [
      moment(3, "docs/shared.md", acceptedContent, 1_300, {
        objectId: "object-shared",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
      moment(4, "docs/shared.md", staleContent, 1_400, {
        objectId: "object-shared",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
      moment(5, "docs/😀.md", acceptedContent, 1_500, {
        objectId: "object-shared",
        operation: "rename",
        beforePath: "docs/shared.md",
        beforeContent: acceptedContent,
      }),
      moment(6, "docs-private/neighbor.md", neighborContent, 1_600, {
        objectId: "object-neighbor",
      }),
      moment(7, "docs/😀.md", sideContent, 1_700, {
        versionId: "side-version",
        objectId: "object-side",
      }),
    ]);

    const response = await h(linkRequest(seeded.capability, "/sync/link/current"));
    expect(response.status).toBe(200);
    const current = await json(response);
    expect(current.files).toEqual([{
      path: "docs/😀.md",
      blobSha256: acceptedSha,
      contentKind: "text",
    }]);
    expect(JSON.stringify(current)).not.toContain(staleSha);
    expect(JSON.stringify(current)).not.toContain(neighborSha);
    expect(JSON.stringify(current)).not.toContain(sideSha);

    const historical = await json(
      await h(linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100")),
    );
    const replayed: FileAccumulator = new Map();
    foldLogOps(replayed, historical.ops as RelayOp[]);
    expect(filesFromAccumulator(replayed)).toEqual(current.files);

    const dbPath = storagePaths.get(storage);
    if (!dbPath) throw new Error("missing inspection path");
    const inspection = new InspectionDatabaseSync(dbPath, { readOnly: true });
    try {
      const query = currentFileStateQuery(["docs"]);
      const plan = inspection.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(
        WORKSPACE,
        "main",
        0,
        Number.MAX_SAFE_INTEGER,
        ...query.selectorParams,
        5_001,
      );
      const details = plan.map((row) => String(row.detail)).join("\n");
      expect(details).toMatch(
        /SEARCH sync_relay_current_files USING INDEX idx_sync_relay_current_files_path/u,
      );
      expect(details).not.toContain("sync_relay_log");
      expect(details).not.toContain("sync_relay_object_moments");
    } finally {
      inspection.close();
    }
  });

  it("preserves a write that reaches a path before a later fork snapshot chunk", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    expect(
      (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
    ).toBe(200);
    const firstSnapshotSha = await putBlob(h, "first snapshot\n");
    const pendingSnapshotSha = await putBlob(h, "pending snapshot\n");
    const localWriteSha = await putBlob(h, "local write\n");
    const versionCreate = (
      originSeq: number,
      path: string,
      blobSha256: string,
    ) => ({
      originSeq,
      opKind: "version.create",
      payload: {
        versionId: "chunked-version",
        forkSnapshots: [{ path, blobSha256 }],
      },
      recordedAtMs: 1_100 + originSeq,
    });

    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/${WORKSPACE}/log`,
            jsonBody({
              originId: "fork-origin",
              ops: [versionCreate(0, "docs/first.md", firstSnapshotSha)],
            }),
          ),
        )
      ).status,
    ).toBe(200);
    await appendMoments(
      h,
      [
        moment(0, "docs/pending.md", "local write\n", 1_200, {
          versionId: "chunked-version",
          objectId: "local-pending-object",
        }),
      ],
      { originId: "local-origin" },
    );
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/${WORKSPACE}/log`,
            jsonBody({
              originId: "fork-origin",
              ops: [versionCreate(1, "docs/pending.md", pendingSnapshotSha)],
            }),
          ),
        )
      ).status,
    ).toBe(200);
    const link = await createLink(h, {
      paths: ["docs"],
      versionId: "chunked-version",
      access: "view",
    });

    const forward = await json(
      await h(linkRequest(link.capability, "/sync/link/current")),
    );
    const dbPath = storagePaths.get(storage);
    if (!dbPath) throw new Error("missing inspection path");
    storage.close();
    storages.splice(storages.indexOf(storage), 1);
    const legacy = new InspectionDatabaseSync(dbPath);
    legacy.exec("DROP TABLE sync_relay_current_files");
    legacy.prepare(
      "DELETE FROM sync_relay_migrations WHERE migration_id = ?",
    ).run("current-files-seed-v1");
    legacy.close();
    const reopened = openSyncRelayStorage(dbPath);
    storages.push(reopened);
    storagePaths.set(reopened, dbPath);
    const replayed = await json(
      await handler(reopened)(linkRequest(link.capability, "/sync/link/current")),
    );
    const expectedFiles = [
      {
        path: "docs/first.md",
        blobSha256: firstSnapshotSha,
        contentKind: "text",
      },
      {
        path: "docs/pending.md",
        blobSha256: localWriteSha,
        contentKind: "text",
      },
    ];

    expect({ forward: forward.files, replayed: replayed.files }).toEqual({
      forward: expectedFiles,
      replayed: expectedFiles,
    });
  });

  it("refuses contradictory path aliases from current state and startup replay", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const initialLog = await json(
      await h(linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100")),
    );
    const forgedContent = "forged\n";
    const forgedSha = await putBlob(h, forgedContent);
    const mismatchedWrite = moment(3, "docs/forged.md", forgedContent, 1_300, {
      objectId: "object-forged",
    });
    mismatchedWrite.payload.path = "private/forged.md";
    const mismatchedDelete = moment(4, "docs/shared.md", "# shared\n", 1_400, {
      objectId: "object-shared",
      operation: "delete",
      beforePath: "docs/shared.md",
      beforeContent: "# shared\n",
      afterPath: null,
      afterContent: null,
    });
    Object.assign(mismatchedDelete.payload, { beforePath: "private/shared.md" });

    for (const malformed of [mismatchedWrite, mismatchedDelete]) {
      expect(
        filterOpForShare(
          { paths: ["docs"], versionId: null, access: "view" },
          malformed.opKind,
          JSON.stringify(malformed.payload),
        ).allowed,
      ).toBe(false);
    }
    await appendMoments(h, [mismatchedWrite, mismatchedDelete]);

    const expectConsistentDenial = async (currentHandler: SyncRelayHandler) => {
      const delta = await json(
        await currentHandler(
          linkRequest(
            seeded.capability,
            `/sync/link/log?since=${String(initialLog.nextCursor)}&limit=100`,
          ),
        ),
      );
      expect(delta).toMatchObject({ ops: [], nextCursor: 5, hasMore: false });

      const current = await json(
        await currentHandler(linkRequest(seeded.capability, "/sync/link/current")),
      );
      const expectedFiles = [{
        path: "docs/shared.md",
        blobSha256: seeded.sharedSha,
        contentKind: "text",
      }];
      expect(current).toMatchObject({ files: expectedFiles, nextCursor: 5 });

      const fullReplay = await json(
        await currentHandler(
          linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100"),
        ),
      );
      const replayed: FileAccumulator = new Map();
      foldLogOps(replayed, fullReplay.ops as RelayOp[]);
      expect(filesFromAccumulator(replayed)).toEqual(expectedFiles);

      const missingSha = sha256("missing");
      const missing = await denialBytes(
        await currentHandler(
          linkRequest(seeded.capability, `/sync/link/blobs/${missingSha}`),
        ),
      );
      expect(
        await denialBytes(
          await currentHandler(
            linkRequest(seeded.capability, `/sync/link/blobs/${forgedSha}`),
          ),
        ),
      ).toBe(missing);
      const sharedBlob = await currentHandler(
        linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`),
      );
      expect(sharedBlob.status).toBe(200);
      expect(await sharedBlob.text()).toBe("# shared\n");
    };

    await expectConsistentDenial(h);

    const dbPath = storagePaths.get(storage);
    if (!dbPath) throw new Error("missing inspection path");
    storage.close();
    storages.splice(storages.indexOf(storage), 1);
    const legacy = new InspectionDatabaseSync(dbPath);
    legacy.exec("DROP TABLE sync_relay_current_files");
    legacy.prepare(
      "DELETE FROM sync_relay_migrations WHERE migration_id = ?",
    ).run("current-files-seed-v1");
    legacy.close();

    const reopened = openSyncRelayStorage(dbPath);
    storages.push(reopened);
    storagePaths.set(reopened, dbPath);
    await expectConsistentDenial(handler(reopened));
  });

  it.each([
    ["moment payloadAfterPath", "after"],
    ["moment payloadBeforePath", "before"],
    ["version.create snapshot path", "snapshot"],
  ] as const)(
    "does not materialize a canonical current file from a noncanonical %s",
    async (_field, shape) => {
      const storage = await newStorage();
      const h = handler(storage);
      expect(
        (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
      ).toBe(200);

      const canonicalPath = `docs/noncanonical-${shape}.md`;
      const noncanonicalPath = `docs//noncanonical-${shape}.md`;
      const content = `noncanonical ${shape}\n`;
      const blobSha256 = await putBlob(h, content);
      const versionId = shape === "snapshot" ? "snapshot-noncanonical" : "main";
      const payload = shape === "snapshot"
        ? {
            versionId,
            forkSnapshots: [{ path: noncanonicalPath, blobSha256 }],
          }
        : shape === "after"
          ? moment(0, noncanonicalPath, content, 1_100).payload
          : moment(0, canonicalPath, content, 1_100, {
              operation: "rename",
              beforePath: noncanonicalPath,
              beforeContent: content,
            }).payload;
      expect(
        (
          await h(
            request(
              OWNER,
              `/sync/${WORKSPACE}/log`,
              jsonBody({
                originId: "origin-a",
                ops: [{
                  originSeq: 0,
                  opKind: shape === "snapshot" ? "version.create" : "moment.append",
                  payload,
                  recordedAtMs: 1_100,
                }],
              }),
            ),
          )
        ).status,
      ).toBe(200);
      const link = await createLink(h, {
        paths: [canonicalPath],
        ...(shape === "snapshot" ? { versionId } : {}),
        access: "view",
      });

      const assertNoInventedFile = async (readHandler: SyncRelayHandler) => {
        const fullReplay = await json(
          await readHandler(
            linkRequest(link.capability, "/sync/link/log?since=0&limit=100"),
          ),
        );
        const replayed: FileAccumulator = new Map();
        foldLogOps(replayed, fullReplay.ops as RelayOp[]);
        const replayedFiles = filesFromAccumulator(replayed);
        expect(replayedFiles).toEqual([]);

        const current = await json(
          await readHandler(linkRequest(link.capability, "/sync/link/current")),
        );
        expect(current.files).toEqual(replayedFiles);
        expect(
          await denialBytes(
            await readHandler(
              linkRequest(link.capability, `/sync/link/blobs/${blobSha256}`),
            ),
          ),
        ).toBe(`404:${LINK_REFUSAL_BODY}`);
      };

      await assertNoInventedFile(h);

      const dbPath = storagePaths.get(storage);
      if (!dbPath) throw new Error("missing inspection path");
      storage.close();
      storages.splice(storages.indexOf(storage), 1);
      const legacy = new InspectionDatabaseSync(dbPath);
      legacy.exec("DROP TABLE sync_relay_current_files");
      legacy.prepare(
        "DELETE FROM sync_relay_migrations WHERE migration_id = ?",
      ).run("current-files-seed-v1");
      legacy.close();

      const reopened = openSyncRelayStorage(dbPath);
      storages.push(reopened);
      storagePaths.set(reopened, dbPath);
      await assertNoInventedFile(handler(reopened));
    },
  );

  it("applies the current-file cap after selector filtering and refuses overflow generically", async () => {
    const storage = await newStorage();
    const h = handler(storage, { linkCurrentFileLimit: 1 });
    const seeded = await seed(h);

    const oneSelected = await h(linkRequest(seeded.capability, "/sync/link/current"));
    expect(oneSelected.status).toBe(200);
    expect((await json(oneSelected)).files).toEqual([{
      path: "docs/shared.md",
      blobSha256: seeded.sharedSha,
      contentKind: "text",
    }]);

    const secondContent = "second selected\n";
    await putBlob(h, secondContent);
    await appendMoments(h, [
      moment(3, "docs/second.md", secondContent, 1_300, {
        objectId: "object-second",
      }),
    ]);
    const overflow = await denialBytes(
      await h(linkRequest(seeded.capability, "/sync/link/current")),
    );
    const missing = await denialBytes(
      await h(
        linkRequest(seeded.capability, `/sync/link/blobs/${"f".repeat(64)}`),
      ),
    );
    expect(overflow).toBe(missing);
  });

  it("keeps current-state freshness equal to metadata after a selected delete", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    await appendMoments(h, [
      moment(3, "docs/shared.md", "# shared\n", 1_300, {
        objectId: "object-shared",
        operation: "delete",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
        afterContent: null,
        afterPath: null,
      }),
    ]);

    const metadata = await json(
      await h(linkRequest(seeded.capability, "/sync/link/share")),
    );
    const current = await json(
      await h(linkRequest(seeded.capability, "/sync/link/current")),
    );
    expect(current.files).toEqual([]);
    expect({
      lastSettledAtMs: current.lastSettledAtMs,
      lastSettledKnown: current.lastSettledKnown,
    }).toEqual({
      lastSettledAtMs: metadata.lastSettledAtMs,
      lastSettledKnown: metadata.lastSettledKnown,
    });
    expect(current.lastSettledAtMs).toBe(1_300);
  });

  it("revalidates the capability generation after reading current state", async () => {
    const storage = await newStorage();
    let revokeOnRead = false;
    let grantId = "";
    const storageWithRace = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === "readCurrentFileState") {
          return (input: Parameters<SyncRelayStorage["readCurrentFileState"]>[0]) => {
            const snapshot = target.readCurrentFileState(input);
            if (revokeOnRead) {
              target.revokeShareGrant({
                shareId: "share-0",
                grantId,
                revokedAtMs: 2_000,
                expectedDependentGrantIds: [],
              });
            }
            return snapshot;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const h = handler(storageWithRace);
    const seeded = await seed(h);
    grantId = seeded.grantId;
    revokeOnRead = true;

    const response = await h(
      linkRequest(seeded.capability, "/sync/link/current"),
    );
    expect(await capabilityRefusalBody(response)).toBe(
      await capabilityRefusalBody(
        await h(linkRequest(UNKNOWN_CAPABILITY, "/sync/link/current")),
      ),
    );
  });

  it("streams the accepted current fold once when reopening a pre-table database", async () => {
    const originalStorage = await newStorage();
    const originalHandler = handler(originalStorage);
    const seeded = await seed(originalHandler);
    const acceptedContent = "accepted before migration\n";
    const staleContent = "stale before migration\n";
    const acceptedSha = await putBlob(originalHandler, acceptedContent);
    await putBlob(originalHandler, staleContent);
    await appendMoments(originalHandler, [
      moment(3, "docs/shared.md", acceptedContent, 1_300, {
        objectId: "object-shared",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
      moment(4, "docs/shared.md", staleContent, 1_400, {
        objectId: "object-shared",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
    ]);
    const dbPath = storagePaths.get(originalStorage);
    if (!dbPath) throw new Error("missing inspection path");
    originalStorage.close();
    storages.splice(storages.indexOf(originalStorage), 1);

    const legacy = new InspectionDatabaseSync(dbPath);
    legacy.exec("DROP TABLE sync_relay_current_files");
    legacy.prepare(
      "DELETE FROM sync_relay_migrations WHERE migration_id = ?",
    ).run("current-files-seed-v1");
    legacy.close();

    const databasePrototype = InspectionDatabaseSync.prototype as InspectionDatabase;
    const nativePrepare = databasePrototype.prepare;
    const migrationAll = vi.fn(() => {
      throw new Error("current-files migration materialized its full result set");
    });
    let migrationStatement: ReturnType<InspectionDatabase["prepare"]> | undefined;
    const migrationIterate = vi.fn((...params: unknown[]) => {
      if (!migrationStatement) throw new Error("migration iterator has no statement");
      return migrationStatement.iterate(...params);
    });
    const prepareSpy = vi
      .spyOn(databasePrototype, "prepare")
      .mockImplementation(function (this: InspectionDatabase, sql: string) {
        const statement = nativePrepare.call(this, sql);
        if (
          !sql.includes("FROM sync_relay_log log") ||
          !sql.includes("ORDER BY log.relay_seq")
        ) {
          return statement;
        }
        migrationStatement = statement;
        return new Proxy(statement, {
          get(target, property) {
            if (property === "all") return migrationAll;
            if (property === "iterate") return migrationIterate;
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
    let reopened: SyncRelayStorage;
    try {
      reopened = openSyncRelayStorage(dbPath);
    } finally {
      prepareSpy.mockRestore();
    }
    expect(migrationAll).not.toHaveBeenCalled();
    expect(migrationIterate).toHaveBeenCalledOnce();
    storages.push(reopened);
    storagePaths.set(reopened, dbPath);
    const reopenedHandler = handler(reopened);
    const firstProjection = await json(
      await reopenedHandler(
        linkRequest(seeded.capability, "/sync/link/current"),
      ),
    );
    expect(firstProjection.files).toEqual([{
      path: "docs/shared.md",
      blobSha256: acceptedSha,
      contentKind: "text",
    }]);
    reopened.close();
    storages.splice(storages.indexOf(reopened), 1);

    const openedAgain = openSyncRelayStorage(dbPath);
    storages.push(openedAgain);
    storagePaths.set(openedAgain, dbPath);
    const secondProjection = await json(
      await handler(openedAgain)(
        linkRequest(seeded.capability, "/sync/link/current"),
      ),
    );
    expect(secondProjection.files).toEqual(firstProjection.files);
    const inspection = new InspectionDatabaseSync(dbPath, { readOnly: true });
    try {
      expect(inspection.prepare(
        `SELECT migration_id FROM sync_relay_migrations
         WHERE migration_id = 'current-files-seed-v1'`,
      ).all()).toHaveLength(1);
    } finally {
      inspection.close();
    }
  });

  it("backfills only rows above a preexisting epoch floor", async () => {
    const originalStorage = await newStorage();
    const originalHandler = handler(originalStorage);
    const seeded = await seedThenRotate(originalHandler);
    const recreatedContent = "recreated before migration\n";
    const recreatedSha = await putBlob(originalHandler, recreatedContent);
    await appendMoments(
      originalHandler,
      [
        moment(0, "docs/shared.md", recreatedContent, 1_300, {
          objectId: "object-recreated-before-migration",
        }),
      ],
      {
        originId: "origin-b",
        identity: { replicationEpoch: EPOCH_2, streamIdentity: STREAM_2 },
      },
    );
    const dbPath = storagePaths.get(originalStorage);
    if (!dbPath) throw new Error("missing inspection path");
    originalStorage.close();
    storages.splice(storages.indexOf(originalStorage), 1);

    const legacy = new InspectionDatabaseSync(dbPath);
    legacy.exec("DROP TABLE sync_relay_current_files");
    legacy.prepare(
      "DELETE FROM sync_relay_migrations WHERE migration_id = ?",
    ).run("current-files-seed-v1");
    legacy.close();

    const reopened = openSyncRelayStorage(dbPath);
    storages.push(reopened);
    storagePaths.set(reopened, dbPath);
    const projection = await json(
      await handler(reopened)(
        linkRequest(seeded.capability, "/sync/link/current"),
      ),
    );
    expect(projection.files).toEqual([{
      path: "docs/shared.md",
      blobSha256: recreatedSha,
      contentKind: "text",
    }]);
    expect(JSON.stringify(projection)).not.toContain(seeded.sharedSha);
  });

  it("gives each grant four capability buckets of read capacity", () => {
    expect(LINK_GRANT_READ_BUCKET_CAPACITY).toBe(LINK_READ_BUCKET_CAPACITY * 4);
    expect(LINK_GRANT_LOG_READ_BUCKET_CAPACITY).toBe(
      LINK_LOG_READ_BUCKET_CAPACITY * 4,
    );
  });

  it("does not update durable link usage on metadata, log, or blob reads", async () => {
    const storage = await newStorage();
    let now = 2_000;
    const h = handler(storage, { nowMs: () => now });
    const seeded = await seed(h);
    expect(await ownerLinkUsage(h, seeded.grantId)).toEqual({
      lastUsedAtMs: 2_000,
      urlIssuedAtMs: 2_000,
    });

    now = 5_000;
    const metadata = await h(linkRequest(seeded.capability, "/sync/link/share"));
    expect(metadata.status).toBe(200);
    await metadata.text();
    const log = await h(linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100"));
    expect(log.status).toBe(200);
    await log.text();
    const blob = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`),
    );
    expect(blob.status).toBe(200);
    await blob.text();

    expect(await ownerLinkUsage(h, seeded.grantId)).toEqual({
      lastUsedAtMs: 2_000,
      urlIssuedAtMs: 2_000,
    });
  });

  it("bounds retained link blob bytes per grant and releases every stream charge", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const largeContent = "l".repeat(MAX_BLOB_BYTES);
    const smallContent = "s".repeat(4 * 1024 * 1024);
    expect(
      (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
    ).toBe(200);
    const largeSha = await putBlob(h, largeContent);
    const smallSha = await putBlob(h, smallContent);
    await appendMoments(h, [
      moment(0, "docs/large.bin", largeContent, 1_100),
      moment(1, "docs/small.bin", smallContent, 1_200),
    ]);
    const link = await createLink(h, { paths: ["docs"], access: "view" });
    const opened: Response[] = [];

    try {
      const held = await Promise.all(
        Array.from({ length: 3 }, () =>
          h(linkRequest(link.capability, `/sync/link/blobs/${largeSha}`)),
        ),
      );
      opened.push(...held);
      const overBudget = await h(
        linkRequest(link.capability, `/sync/link/blobs/${largeSha}`),
      );
      opened.push(overBudget);
      const small = await h(
        linkRequest(link.capability, `/sync/link/blobs/${smallSha}`),
      );
      opened.push(small);

      await overBudget.body?.cancel();
      await small.body?.cancel();
      await held[0]!.body?.cancel();
      const restored = await h(
        linkRequest(link.capability, `/sync/link/blobs/${largeSha}`),
      );
      opened.push(restored);

      expect({
        held: held.map((response) => response.status),
        overBudget: overBudget.status,
        small: small.status,
        restored: restored.status,
      }).toEqual({
        held: [200, 200, 200],
        overBudget: 429,
        small: 200,
        restored: 200,
      });
    } finally {
      await Promise.all(
        opened.map(async (response) => {
          try {
            await response.body?.cancel();
          } catch {
            // A terminated or already-consumed response has released its charge.
          }
        }),
      );
    }
  });

  it.each([
    [
      "keyed revocation",
      async (
        h: SyncRelayHandler,
        shareId: string,
        grantId: string,
        _storage: SyncRelayStorage,
      ) =>
        await h(
          request(
            OWNER,
            `/sync/shares/${shareId}/revoke`,
            jsonBody({
              grantId,
              workspaceId: WORKSPACE,
              expectedDependentGrantIds: [],
            }),
          ),
        ),
    ],
    [
      "whole-share revocation",
      async (
        h: SyncRelayHandler,
        shareId: string,
        _grantId: string,
        _storage: SyncRelayStorage,
      ) =>
        await h(request(OWNER, `/sync/shares/${shareId}/revoke`, { method: "POST" })),
    ],
    [
      "rotation",
      async (
        h: SyncRelayHandler,
        shareId: string,
        grantId: string,
        _storage: SyncRelayStorage,
      ) =>
        await h(
          request(
            OWNER,
            `/sync/shares/${shareId}/links/${grantId}/rotate`,
            jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
          ),
        ),
    ],
    [
      "retuning",
      async (
        h: SyncRelayHandler,
        shareId: string,
        grantId: string,
        storage: SyncRelayStorage,
      ) => {
        expect(
          storage.retuneShareGrant({
            shareId,
            grantId,
            access: "comment",
            changedAtMs: 2_001,
            expectedDependentGrantIds: [],
            guard: () => undefined,
            mintCredential: () => ({
              credentialId: "storage-seeded-comment-stream-credential",
              secretHash: "storage-seeded-comment-stream-hash",
            }),
          }),
        ).toMatchObject({ ok: true, grant: { access: "comment" } });
        return await h(
          request(
            OWNER,
            `/sync/shares/${shareId}/links/${grantId}/retune`,
            jsonBody({ access: "view", expectedDependentGrantIds: [] }),
          ),
        );
      },
    ],
  ] as const)(
    "terminates an open link blob stream after %s without affecting another grant",
    async (_transitionName, transition) => {
      const storage = await newStorage();
      const h = handler(storage);
      const content = `${"a".repeat(64 * 1024)}${"b".repeat(64 * 1024)}${"c".repeat(64 * 1024)}`;
      expect(
        (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
      ).toBe(200);
      const blobSha = await putBlob(h, content);
      await appendMoments(h, [moment(0, "docs/large.bin", content, 1_100)]);
      const target = await createLink(h, { paths: ["docs"], access: "view" });
      const untouched = await createLink(h, { paths: ["docs"], access: "view" });

      const targetResponse = await h(
        linkRequest(target.capability, `/sync/link/blobs/${blobSha}`),
      );
      const untouchedResponse = await h(
        linkRequest(untouched.capability, `/sync/link/blobs/${blobSha}`),
      );
      expect(targetResponse.status).toBe(200);
      expect(untouchedResponse.status).toBe(200);
      expect(targetResponse.headers.get("content-length")).toBe(
        String(Buffer.byteLength(content)),
      );
      expect(untouchedResponse.headers.get("content-length")).toBe(
        String(Buffer.byteLength(content)),
      );
      const targetReader = targetResponse.body!.getReader();
      const untouchedReader = untouchedResponse.body!.getReader();
      const targetFirst = await targetReader.read();
      const untouchedFirst = await untouchedReader.read();
      expect(targetFirst.done).toBe(false);
      expect(untouchedFirst.done).toBe(false);
      if (targetFirst.done || untouchedFirst.done) return;
      expect(targetFirst.value.byteLength).toBe(64 * 1024);
      expect(untouchedFirst.value.byteLength).toBe(64 * 1024);

      const changed = await transition(h, target.shareId, target.grantId, storage);
      expect(changed.status).toBe(200);

      const targetOutcome = await targetReader.read().then(
        () => ({ kind: "delivered" as const }),
        (error: unknown) => ({
          kind: "terminated" as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      expect(targetOutcome).toEqual({
        kind: "terminated",
        message: "link grant changed during blob stream",
      });
      const untouchedBytes = await readRemainingBytes(
        untouchedReader,
        untouchedFirst.value,
      );
      expect(new TextDecoder().decode(untouchedBytes)).toBe(content);
    },
  );

  it.each(["rotate", "retune"] as const)(
    "refuses %s when owner standing changes before commit without writes or terminated reads",
    async (operation) => {
      const storage = await newStorage();
      let ownershipAnswers: boolean[] | null = null;
      const ownershipStorage = new Proxy(storage, {
        get(target, property, receiver) {
          if (property === "workspaceIsOwnedBy") {
            return (workspaceId: string, ownerUserId: string) =>
              ownershipAnswers === null
                ? target.workspaceIsOwnedBy(workspaceId, ownerUserId)
                : (ownershipAnswers.shift() ?? false);
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      let bearerByte = 1;
      const newLinkBearer = vi.fn(() =>
        Buffer.alloc(32, bearerByte++).toString("base64url"),
      );
      const h = createSyncRelayHandler({
        storage: ownershipStorage,
        resolveActor(request: Request, workspaceId: string) {
          const match = /^Bearer user:([^ ]+)$/u.exec(
            request.headers.get("authorization") ?? "",
          );
          if (!match) {
            throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
          }
          return { userId: match[1]!, workspaceId };
        },
        nowMs: () => 2_000,
        newShareId: () => "share-owner-race",
        newGrantId: (() => {
          let id = 0;
          return () => `grant-owner-race-${id++}`;
        })(),
        newId: (() => {
          let id = 0;
          return () => `id-owner-race-${id++}`;
        })(),
        linkKey: LINK_KEY,
        shareWebOrigin: "https://share.example.test",
        newLinkBearer,
      });
      const content = `${"a".repeat(64 * 1024)}${"b".repeat(64 * 1024)}${"c".repeat(64 * 1024)}`;
      expect(
        (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
      ).toBe(200);
      const blobSha = await putBlob(h, content);
      await appendMoments(h, [moment(0, "docs/large.bin", content, 1_100)]);
      const target = await createLink(h, { paths: ["docs"], access: "view" });
      let capability = target.capability;

      if (operation === "retune") {
        expect(
          storage.retuneShareGrant({
            shareId: target.shareId,
            grantId: target.grantId,
            access: "comment",
            changedAtMs: 1_900,
            expectedDependentGrantIds: [],
            guard: () => undefined,
            mintCredential: () => ({
              credentialId: "credential-owner-race-comment",
              secretHash: hashLinkBearer("comment-owner-race-secret", LINK_KEY),
            }),
          }),
        ).toMatchObject({ ok: true, grant: { access: "comment", generation: 2 } });
        capability = Buffer.alloc(32, 200).toString("base64url");
        expect(
          storage.mintLinkSession({
            session: {
              sessionId: "session-owner-race-comment",
              capabilityHash: hashLinkBearer(capability, LINK_KEY),
              grantId: target.grantId,
              generation: 2,
              mintedAtMs: 1_901,
              expiresAtMs: 2_000 + LINK_SESSION_TTL_MS,
            },
          }),
        ).toBe(true);
      }

      const blobResponse = await h(
        linkRequest(capability, `/sync/link/blobs/${blobSha}`),
      );
      expect(blobResponse.status).toBe(200);
      const reader = blobResponse.body!.getReader();
      try {
        const first = await reader.read();
        expect(first.done).toBe(false);
        if (first.done) return;
        expect(first.value.byteLength).toBe(64 * 1024);

        const beforeGrant = storage.getShareGrant(target.grantId);
        const beforeCredential = storage.getCurrentLinkCredential(target.grantId);
        const capabilityHash = hashLinkBearer(capability, LINK_KEY);
        const beforeSession = storage.findLinkSessionByCapabilityHash(capabilityHash);
        const bearerCalls = newLinkBearer.mock.calls.length;
        const route = `/sync/shares/${target.shareId}/links/${target.grantId}/${operation}`;
        const missingRoute = `/sync/shares/share-missing/links/grant-missing/${operation}`;
        const body =
          operation === "rotate"
            ? { workspaceId: WORKSPACE, expectedDependentGrantIds: [] }
            : { access: "view", expectedDependentGrantIds: [] };
        const missing = await denialBytes(
          await h(request(OWNER, missingRoute, jsonBody(body))),
        );

        ownershipAnswers = [true, false];
        const refused = await h(request(OWNER, route, jsonBody(body)));
        expect(await denialBytes(refused)).toBe(missing);
        expect(ownershipAnswers).toEqual([]);
        ownershipAnswers = null;

        expect(storage.getShareGrant(target.grantId)).toEqual(beforeGrant);
        expect(storage.getCurrentLinkCredential(target.grantId)).toEqual(
          beforeCredential,
        );
        expect(storage.findLinkSessionByCapabilityHash(capabilityHash)).toEqual(
          beforeSession,
        );
        expect(newLinkBearer).toHaveBeenCalledTimes(bearerCalls);
        expect((await h(linkRequest(capability, "/sync/link/share"))).status).toBe(200);
        expect(new TextDecoder().decode(await readRemainingBytes(reader, first.value))).toBe(
          content,
        );

        ownershipAnswers = [true, true];
        expect((await h(request(OWNER, route, jsonBody(body)))).status).toBe(200);
        expect(ownershipAnswers).toEqual([]);
        ownershipAnswers = null;
      } finally {
        try {
          await reader.cancel();
        } catch {
          // A successful transition can terminate an already-consumed stream.
        }
      }
    },
  );

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
    expect(linkLog).toEqual({ ...recipientLog, ops: linkOps, epochLogFloor: 0 });
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

  it("applies an accountless overwrite through the viewer fold", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const realPath = "docs/readme.md";
    const projectedPath = "readme.md";
    const firstContent = "# First\n";
    const secondContent = "# Second\n";

    expect(
      (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
    ).toBe(200);
    await putBlob(h, firstContent);
    const secondSha = await putBlob(h, secondContent);
    await appendMoments(h, [
      moment(0, realPath, firstContent, 1_000),
      moment(1, realPath, secondContent, 1_100, {
        objectId: "object-0",
        beforePath: realPath,
        beforeContent: firstContent,
      }),
    ]);
    const link = await createLink(h, { paths: [realPath], access: "view" });

    const linkLog = await json(
      await h(linkRequest(link.capability, "/sync/link/log?since=0&limit=100")),
    );
    const ops = linkLog.ops;
    expect(Array.isArray(ops)).toBe(true);
    if (!Array.isArray(ops)) throw new Error("link log did not return ops");
    expect(ops).toHaveLength(2);

    const files: FileAccumulator = new Map();
    foldLogOps(files, ops as RelayOp[]);
    expect(filesFromAccumulator(files)).toEqual([
      {
        path: projectedPath,
        blobSha256: secondSha,
        contentKind: "text",
      },
    ]);
    expect(ops[1]).toMatchObject({
      payload: {
        payloadBeforeBlobSha256: sha256(firstContent),
        payloadAfterBlobSha256: secondSha,
      },
    });

    const selected = files.get(projectedPath);
    expect(selected).toBeDefined();
    if (!selected) throw new Error("viewer fold did not select the shared file");
    const blob = await h(
      linkRequest(link.capability, `/sync/link/blobs/${selected.blobSha256}`),
    );
    expect(blob.status).toBe(200);
    expect(await blob.text()).toBe(secondContent);
  });

  it("projects a nested file into the accountless namespace without changing authenticated paths", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const realPath = "clients/acme/private/report.md";
    const projectedPath = "report.md";
    const before = "# Before\n";
    const after = "# After\n";

    expect(
      (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
    ).toBe(200);
    await putBlob(h, before);
    await putBlob(h, after);
    const storedMoment = moment(0, realPath, after, 1_100, {
      objectId: "object-report",
      beforePath: realPath,
      beforeContent: before,
    });
    await appendMoments(h, [storedMoment]);
    const link = await createLink(h, { paths: [realPath], access: "view" });

    const linkMeta = await json(
      await h(linkRequest(link.capability, "/sync/link/share")),
    );
    expect(linkMeta.effectiveSelector).toEqual({
      paths: [projectedPath],
      versionId: null,
      access: "view",
    });
    expect(link.exchange.effectiveSelector).toEqual({
      paths: [projectedPath],
      versionId: null,
      access: "view",
    });
    const linkLog = await json(
      await h(linkRequest(link.capability, "/sync/link/log?since=0&limit=100")),
    );
    const linkPayload = (
      linkLog.ops as Array<{ payload: Record<string, unknown> }>
    )[0]!.payload;
    expect(linkPayload).toMatchObject({
      path: projectedPath,
      payloadBeforePath: projectedPath,
      payloadAfterPath: projectedPath,
    });
    expect(linkPayload).not.toHaveProperty("beforePath");
    expect(JSON.stringify({ exchange: link.exchange, meta: linkMeta, log: linkLog }))
      .not.toContain(realPath);

    const authenticatedMeta = await json(
      await h(request(RECIPIENT, `/sync/shares/${link.shareId}`)),
    );
    expect(authenticatedMeta.selector).toMatchObject({ paths: [realPath] });
    const authenticatedLog = await json(
      await h(request(RECIPIENT, `/sync/shares/${link.shareId}/log?since=0&limit=100`)),
    );
    const authenticatedPayload = (
      authenticatedLog.ops as Array<{ payload: Record<string, unknown> }>
    )[0]!.payload;
    expect(authenticatedPayload).toMatchObject({
      path: realPath,
      payloadBeforePath: realPath,
      payloadAfterPath: realPath,
    });

    const refreshed = await json(
      await h(request(null, "/sync/link-refresh", {
        method: "POST",
        headers: { authorization: `LinkCapability ${link.capability}` },
      })),
    );
    expect(refreshed.effectiveSelector).toEqual({
      paths: [projectedPath],
      versionId: null,
      access: "view",
    });
  });

  it("projects a refused outward move as an accountless deletion", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const initialLog = await json(
      await h(
        linkRequest(
          seeded.capability,
          "/sync/link/log?since=0&limit=100",
        ),
      ),
    );
    const initialOps = initialLog.ops as RelayOp[];
    const initialFiles: FileAccumulator = new Map();
    foldLogOps(initialFiles, initialOps);
    expect(filesFromAccumulator(initialFiles).map(({ path }) => path)).toEqual([
      "docs/shared.md",
    ]);

    const outwardMove = moment(3, "private/moved.md", "# shared\n", 1_300, {
      objectId: "object-shared",
      operation: "rename",
      beforePath: "docs/shared.md",
      beforeContent: "# shared\n",
    });
    await appendMoments(h, [outwardMove]);

    const accountlessDelta = await json(
      await h(
        linkRequest(
          seeded.capability,
          `/sync/link/log?since=${String(initialLog.nextCursor)}&limit=100`,
        ),
      ),
    );
    const accountlessOps = accountlessDelta.ops as RelayOp[];
    const authenticatedDelta = await json(
      await h(
        request(
          RECIPIENT,
          `/sync/shares/share-0/log?since=${String(initialLog.nextCursor)}&limit=100`,
        ),
      ),
    );
    const authenticatedOps = authenticatedDelta.ops as RelayOp[];
    const accountlessFiles = new Map(initialFiles);
    foldLogOps(accountlessFiles, accountlessOps);
    const authenticatedFiles = new Map(initialFiles);
    foldLogOps(authenticatedFiles, authenticatedOps);

    expect({
      rawFilterAllowed: filterOpForShare(
        { paths: ["docs"], versionId: null, access: "view" },
        outwardMove.opKind,
        JSON.stringify(outwardMove.payload),
      ).allowed,
      accountlessOps,
      accountlessFoldedPaths: filesFromAccumulator(accountlessFiles).map(
        ({ path }) => path,
      ),
      authenticatedOps,
      authenticatedFoldedPaths: filesFromAccumulator(authenticatedFiles).map(
        ({ path }) => path,
      ),
    }).toEqual({
      rawFilterAllowed: false,
      accountlessOps: [
        {
          relaySeq: 4,
          originSeq: 3,
          opKind: "moment.append",
          payload: {
            operation: "delete",
            versionId: "main",
            metadata: { origin: "sync" },
            path: "docs/shared.md",
            payloadBeforeBlobSha256: seeded.sharedSha,
            payloadBeforePath: "docs/shared.md",
          },
          recordedAtMs: 1_300,
        },
      ],
      accountlessFoldedPaths: [],
      authenticatedOps: [],
      authenticatedFoldedPaths: ["docs/shared.md"],
    });
    const projectedPayload = accountlessOps[0]?.payload as
      | Record<string, unknown>
      | undefined;
    expect(projectedPayload).not.toHaveProperty("payloadAfterPath");
    expect(projectedPayload).not.toHaveProperty("payloadAfterBlobSha256");
    expect(projectedPayload).not.toHaveProperty("payloadAfterContentKind");
  });

  it("uses an outward move as accountless freshness", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const updated = "# updated\n";
    await putBlob(h, updated);
    await appendMoments(h, [
      moment(3, "docs/shared.md", updated, 1_300, {
        objectId: "object-shared",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
      moment(4, "private/moved.md", updated, 1_400, {
        objectId: "object-shared",
        operation: "rename",
        beforePath: "docs/shared.md",
        beforeContent: updated,
      }),
    ]);

    const metadata = await json(
      await h(linkRequest(seeded.capability, "/sync/link/share")),
    );

    expect(metadata.lastSettledAtMs).toBe(1_400);
    expect(metadata.lastSettledKnown).toBe(true);
  });

  it("reports known-empty freshness for a never-written path share", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    expect(
      (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
    ).toBe(200);
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
                  originSeq: 0,
                  opKind: "workspace.init",
                  payload: {},
                  recordedAtMs: 2_000,
                },
              ],
            }),
          ),
        )
      ).status,
    ).toBe(200);
    const link = await createLink(h, { paths: ["docs"], access: "view" });

    const metadata = await json(
      await h(linkRequest(link.capability, "/sync/link/share")),
    );

    expect(metadata.lastSettledAtMs).toBeNull();
    expect(metadata.lastSettledKnown).toBe(true);
  });

  it("projects an inward move as an accountless arrival so current and replay converge", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const initialLog = await json(
      await h(
        linkRequest(
          seeded.capability,
          "/sync/link/log?since=0&limit=100",
        ),
      ),
    );
    const initialOps = initialLog.ops as RelayOp[];
    const initialFiles: FileAccumulator = new Map();
    foldLogOps(initialFiles, initialOps);
    const arrived = "arrived\n";
    const arrivedSha = await putBlob(h, arrived);
    const inwardMove = moment(3, "docs/arrived.md", "hidden\n", 1_300, {
      objectId: "object-2",
      operation: "rename",
      beforePath: "private/hidden.md",
      beforeContent: "hidden\n",
      afterContent: arrived,
    });
    await appendMoments(h, [inwardMove]);

    expect(
      filterOpForShare(
        { paths: ["docs"], versionId: null, access: "view" },
        inwardMove.opKind,
        JSON.stringify(inwardMove.payload),
      ).allowed,
    ).toBe(false);
    const accountlessDelta = await json(
      await h(
        linkRequest(
          seeded.capability,
          `/sync/link/log?since=${String(initialLog.nextCursor)}&limit=1`,
        ),
      ),
    );
    const accountlessOps = accountlessDelta.ops as RelayOp[];
    expect(accountlessDelta).toMatchObject({ nextCursor: 4, hasMore: false });
    expect(accountlessOps).toEqual([
      {
        relaySeq: 4,
        originSeq: 3,
        opKind: "moment.append",
        payload: {
          operation: "write",
          versionId: "main",
          metadata: { origin: "sync" },
          path: "docs/arrived.md",
          payloadBeforeBlobSha256: null,
          payloadAfterBlobSha256: arrivedSha,
          payloadAfterPath: "docs/arrived.md",
        },
        recordedAtMs: 1_300,
      },
    ]);

    const current = await json(
      await h(linkRequest(seeded.capability, "/sync/link/current")),
    );
    const expectedFiles = [
      {
        path: "docs/arrived.md",
        blobSha256: arrivedSha,
        contentKind: "text",
      },
      {
        path: "docs/shared.md",
        blobSha256: seeded.sharedSha,
        contentKind: "text",
      },
    ];
    expect(current).toMatchObject({ files: expectedFiles, nextCursor: 4 });

    const alreadyOpenFiles = new Map(initialFiles);
    foldLogOps(alreadyOpenFiles, accountlessOps);
    expect(filesFromAccumulator(alreadyOpenFiles)).toEqual(expectedFiles);

    const fullReplay = await json(
      await h(linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100")),
    );
    const freshFiles: FileAccumulator = new Map();
    foldLogOps(freshFiles, fullReplay.ops as RelayOp[]);
    expect(filesFromAccumulator(freshFiles)).toEqual(expectedFiles);

    const serializedAccountless = JSON.stringify({
      current,
      delta: accountlessDelta,
      fullReplay,
    });
    for (const privateValue of [
      "private/hidden.md",
      seeded.hiddenSha,
      "object-2",
      "moment-3",
      "origin-a",
    ]) {
      expect(serializedAccountless).not.toContain(privateValue);
    }

    const authenticatedInward = await json(
      await h(
        request(
          RECIPIENT,
          `/sync/shares/share-0/log?since=${String(initialLog.nextCursor)}&limit=1`,
        ),
      ),
    );
    expect(authenticatedInward.ops).toEqual([]);
  });

  it("keeps a nested folder's visible name as its accountless root", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const realRoot = "clients/acme/private/docs";
    const realPath = `${realRoot}/guides/start.md`;

    expect(
      (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
    ).toBe(200);
    await putBlob(h, "# Start\n");
    await appendMoments(h, [
      moment(0, realPath, "# Start\n", 1_100, { objectId: "object-start" }),
    ]);
    const link = await createLink(h, { paths: [realRoot], access: "view" });

    const linkMeta = await json(
      await h(linkRequest(link.capability, "/sync/link/share")),
    );
    expect(linkMeta.effectiveSelector).toMatchObject({ paths: ["docs"] });
    const linkLog = await json(
      await h(linkRequest(link.capability, "/sync/link/log?since=0&limit=100")),
    );
    expect(
      (linkLog.ops as Array<{ payload: Record<string, unknown> }>)[0]!.payload,
    ).toMatchObject({
      path: "docs/guides/start.md",
      payloadAfterPath: "docs/guides/start.md",
    });
    expect(JSON.stringify({ meta: linkMeta, log: linkLog })).not.toContain("clients/acme/private");
  });

  it("disambiguates accountless roots with the same visible name", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const firstRoot = "clients/acme/private/docs";
    const secondRoot = "teams/blue/private/docs";
    const firstPath = `${firstRoot}/first.md`;
    const secondPath = `${secondRoot}/second.md`;

    expect(
      (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
    ).toBe(200);
    await putBlob(h, "first\n");
    await putBlob(h, "second\n");
    await appendMoments(h, [
      moment(0, firstPath, "first\n", 1_100, { objectId: "object-first" }),
      moment(1, secondPath, "second\n", 1_200, { objectId: "object-second" }),
    ]);
    const link = await createLink(h, {
      paths: [firstRoot, secondRoot],
      access: "view",
    });

    const linkMeta = await json(
      await h(linkRequest(link.capability, "/sync/link/share")),
    );
    expect(linkMeta.effectiveSelector).toMatchObject({
      paths: ["docs", "2~docs"],
    });
    const linkLog = await json(
      await h(linkRequest(link.capability, "/sync/link/log?since=0&limit=100")),
    );
    const projectedPaths = (
      linkLog.ops as Array<{ payload: { payloadAfterPath?: string } }>
    ).map((op) => op.payload.payloadAfterPath);
    expect(projectedPaths).toEqual(["docs/first.md", "2~docs/second.md"]);
    const serialized = JSON.stringify({ meta: linkMeta, log: linkLog });
    expect(serialized).not.toContain("clients/acme/private");
    expect(serialized).not.toContain("teams/blue/private");
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
      epochLogFloor: 0,
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

    const skippedChatRows = await json(
      await h(linkRequest(seeded.capability, "/sync/link/log?since=3&limit=1")),
    );
    expect(skippedChatRows).toEqual({
      ok: true,
      ops: [],
      nextCursor: 5,
      hasMore: false,
      epochLogFloor: 0,
    });
  });

  it("fills one accountless page across unrelated raw pages", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const unrelatedRows = Array.from({ length: 1_500 }, (_, index) =>
      moment(
        index + 3,
        `private/page-noise-${index}.md`,
        "hidden\n",
        1_300 + index,
      ),
    );
    appendStoredMoments(storage, [
      ...unrelatedRows,
      moment(1_503, "docs/behind-pages.md", "# shared\n", 2_800),
    ]);

    const pages: Array<Record<string, unknown>> = [];
    let since = 3;
    let hasMore = true;
    while (hasMore && pages.length < 5) {
      const page = await json(
        await h(
          linkRequest(
            seeded.capability,
            `/sync/link/log?since=${String(since)}&limit=500`,
          ),
        ),
      );
      pages.push(page);
      since = Number(page.nextCursor);
      hasMore = page.hasMore === true;
    }

    expect(pages).toEqual([
      {
        ok: true,
        ops: [
          expect.objectContaining({
            relaySeq: 1_504,
            originSeq: 1_503,
            opKind: "moment.append",
            payload: expect.objectContaining({
              path: "docs/behind-pages.md",
              payloadAfterPath: "docs/behind-pages.md",
            }),
            recordedAtMs: 2_800,
          }),
        ],
        nextCursor: 1_504,
        hasMore: false,
        epochLogFloor: 0,
      },
    ]);
  });

  it("continues an accountless page after the raw-row work bound", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const firstAdmitted = moment(3, "docs/before-bound.md", "# shared\n", 1_300);
    const unrelatedRows = Array.from(
      { length: MAX_RAW_ROWS_PER_LINK_PAGE - 1 },
      (_, index) =>
        moment(
          index + 4,
          `private/bound-noise-${index}.md`,
          "hidden\n",
          1_301 + index,
        ),
    );
    const secondAdmitted = moment(
      MAX_RAW_ROWS_PER_LINK_PAGE + 3,
      "docs/after-bound.md",
      "# shared\n",
      1_300 + MAX_RAW_ROWS_PER_LINK_PAGE,
    );
    appendStoredMoments(storage, [firstAdmitted, ...unrelatedRows, secondAdmitted]);

    const first = await json(
      await h(linkRequest(seeded.capability, "/sync/link/log?since=3&limit=2")),
    );
    expect(first).toEqual({
      ok: true,
      ops: [
        expect.objectContaining({
          relaySeq: 4,
          originSeq: 3,
          payload: expect.objectContaining({ path: "docs/before-bound.md" }),
        }),
      ],
      nextCursor: MAX_RAW_ROWS_PER_LINK_PAGE + 3,
      hasMore: true,
      epochLogFloor: 0,
    });

    const second = await json(
      await h(
        linkRequest(
          seeded.capability,
          `/sync/link/log?since=${String(first.nextCursor)}&limit=2`,
        ),
      ),
    );
    expect(second).toEqual({
      ok: true,
      ops: [
        expect.objectContaining({
          relaySeq: MAX_RAW_ROWS_PER_LINK_PAGE + 4,
          originSeq: MAX_RAW_ROWS_PER_LINK_PAGE + 3,
          payload: expect.objectContaining({ path: "docs/after-bound.md" }),
        }),
      ],
      nextCursor: MAX_RAW_ROWS_PER_LINK_PAGE + 4,
      hasMore: false,
      epochLogFloor: 0,
    });
  }, 20_000);

  it("keeps link log pages and freshness above the workspace epoch floor", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h, "view", {}, {
      replicationEpoch: EPOCH_1,
      streamIdentity: STREAM_1,
    });

    const originalLog = await json(
      await h(linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100")),
    );
    expect(originalLog.epochLogFloor).toBe(0);

    await rotateWorkspaceIdentity(h);

    const rotatedLog = await json(
      await h(linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100")),
    );
    expect(rotatedLog).toMatchObject({
      ok: true,
      epochLogFloor: 3,
      ops: [],
      hasMore: false,
    });

    const rotatedShare = await json(
      await h(linkRequest(seeded.capability, "/sync/link/share")),
    );
    expect(rotatedShare.lastSettledAtMs).toBeNull();
    expect(rotatedShare.lastSettledKnown).toBe(true);

    await appendAfterRotation(h);
    const currentLog = await json(
      await h(linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100")),
    );
    expect(currentLog.epochLogFloor).toBe(3);
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

  it("recreates a pre-reset path from empty current state after epoch rotation", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seedThenRotate(h);
    const recreatedContent = "# recreated after reset\n";
    const recreatedSha = await putBlob(h, recreatedContent);
    await appendMoments(
      h,
      [
        moment(0, "docs/shared.md", recreatedContent, 1_300, {
          objectId: "object-recreated",
        }),
      ],
      {
        originId: "origin-b",
        identity: { replicationEpoch: EPOCH_2, streamIdentity: STREAM_2 },
      },
    );

    const current = await json(
      await h(linkRequest(seeded.capability, "/sync/link/current")),
    );
    expect(current.files).toEqual([{
      path: "docs/shared.md",
      blobSha256: recreatedSha,
      contentKind: "text",
    }]);
    const recreatedBlob = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${recreatedSha}`),
    );
    expect(recreatedBlob.status).toBe(200);
    expect(await recreatedBlob.text()).toBe(recreatedContent);
    expect(
      await denialBytes(
        await h(
          linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`),
        ),
      ),
    ).toBe(`404:${LINK_REFUSAL_BODY}`);
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

  it("serves only the different object recreated at a selected path", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const replacement = "# recreated object\n";
    const replacementSha = await putBlob(h, replacement);
    await appendMoments(h, [
      moment(3, "docs/shared.md", "# shared\n", 1_300, {
        objectId: "object-shared",
        operation: "delete",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
      moment(4, "docs/shared.md", replacement, 1_400, {
        objectId: "object-recreated",
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
    ).toBe(`404:${LINK_REFUSAL_BODY}`);
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

  it.each(["accountless", "authenticated"] as const)(
    "serves a selected pinned-version path blob after newer out-of-selector candidates on the %s route",
    async (route) => {
      const storage = await newStorage();
      const h = handler(storage);
      const seeded = await seed(h, "view", {
        paths: ["docs"],
        versionId: "snapshot-1",
        sharedVersionId: "snapshot-1",
      });
      await appendMoments(
        h,
        Array.from(
          { length: SHARED_BLOB_CANDIDATE_LIMIT + 1 },
          (_, index) =>
            moment(
              index + 3,
              `private/copy-${index}.md`,
              "# shared\n",
              1_300 + index,
              {
                versionId: "snapshot-1",
                objectId: `object-private-copy-${index}`,
              },
            ),
        ),
      );

      const blob = await h(
        route === "accountless"
          ? linkRequest(
              seeded.capability,
              `/sync/link/blobs/${seeded.sharedSha}`,
            )
          : request(
              RECIPIENT,
              `/sync/shares/share-0/blobs/${seeded.sharedSha}`,
            ),
      );

      expect(blob.status).toBe(200);
      expect(await blob.text()).toBe("# shared\n");
    },
  );

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
    const current = await json(
      await h(linkRequest(seeded.capability, "/sync/link/current")),
    );
    expect(current.files).toEqual([{
      path: "docs/snapshot-only.md",
      blobSha256: snapshotSha,
      contentKind: "text",
    }]);
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

  it("caps current-state blob candidates after stale objects are removed", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const editedContent = "# edited\n";
    await putBlob(h, editedContent);

    const matchingCopies = Array.from(
      { length: SHARED_BLOB_CANDIDATE_LIMIT },
      (_, index) =>
        moment(index + 3, `docs/candidate-${index}.md`, "# shared\n", 1_300 + index, {
          objectId: `object-candidate-${index}`,
        }),
    );
    const editedCopies = Array.from(
      { length: SHARED_BLOB_CANDIDATE_LIMIT },
      (_, index) =>
        moment(
          SHARED_BLOB_CANDIDATE_LIMIT + index + 3,
          `docs/candidate-${index}.md`,
          editedContent,
          2_000 + index,
          {
            objectId: `object-candidate-${index}`,
            beforePath: `docs/candidate-${index}.md`,
            beforeContent: "# shared\n",
          },
        ),
    );
    await appendMoments(h, [...matchingCopies, ...editedCopies]);

    const survivingCurrentBlob = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`),
    );
    expect(survivingCurrentBlob.status).toBe(200);
    expect(await survivingCurrentBlob.text()).toBe("# shared\n");

    await appendMoments(h, [
      moment(
        SHARED_BLOB_CANDIDATE_LIMIT * 2 + 3,
        "docs/shared.md",
        editedContent,
        3_000,
        {
          objectId: "object-shared",
          beforePath: "docs/shared.md",
          beforeContent: "# shared\n",
        },
      ),
    ]);

    expect(
      await denialBytes(
        await h(linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`)),
      ),
    ).toBe(`404:${LINK_REFUSAL_BODY}`);

    const historicalBlob = await h(
      request(RECIPIENT, `/sync/shares/share-0/blobs/${seeded.sharedSha}`),
    );
    expect(historicalBlob.status).toBe(200);
    expect(await historicalBlob.text()).toBe("# shared\n");
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
      semantics: "current-state",
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
            jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      await capabilityRefusalBody(await h(linkRequest(first.capability, "/sync/link/current"))),
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
      await h(
        request(null, "/sync/link-exchange", {
          ...jsonBody({ secret: linkSecret(secondLink.url) }),
        }),
      ),
    );
    expect(
      (
        await h(
          request(
            OWNER,
            "/sync/shares/share-0/revoke",
            jsonBody({
              grantId: secondLink.grantId,
              workspaceId: WORKSPACE,
              expectedDependentGrantIds: [],
            }),
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      await capabilityRefusalBody(
        await h(linkRequest(String(secondExchange.capabilityToken), "/sync/link/current")),
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
      await h(
        request(null, "/sync/link-exchange", {
          ...jsonBody({ secret: linkSecret(thirdLink.url) }),
        }),
      ),
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

  it("serves a current blob without walking forward history", async () => {
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
      Array.from({ length: rowsPerBudget }, (_, index) =>
        moment(
          index + 3,
          `private/blob-noise-${index}.md`,
          "hidden\n",
          1_300 + index,
        ),
      ),
    );

    const response = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("# shared\n");
  });

  it("keeps freshness and materialized blobs unchanged when the log fits the page budget", async () => {
    const storage = await newStorage();
    const h = handler(storage, {
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

  it("shares a grant read budget across capabilities minted by re-exchange", async () => {
    const storage = await newStorage();
    const h = handler(storage, {
      linkReadRateLimiter: new LinkReadRateLimiter(1, 0.000_001, 10),
      linkGrantReadRateLimiter: new LinkReadRateLimiter(1, 0.000_001, 10),
    });
    const seeded = await seed(h);
    expect((await h(linkRequest(seeded.capability, "/sync/link/share"))).status).toBe(200);

    const secondExchange = await json(
      await h(request(null, "/sync/link-exchange", jsonBody({ secret: seeded.secret }))),
    );
    expect(secondExchange.grantId).toBe(seeded.grantId);
    const pastCapabilityBound = await h(
      linkRequest(String(secondExchange.capabilityToken), "/sync/link/share"),
    );

    expect(pastCapabilityBound.status).toBe(429);
    expect(await json(pastCapabilityBound)).toEqual({
      ok: false,
      error: "too many link reads",
      code: "link_read_rate_limited",
    });
  });

  it("keeps grant read budgets independent for different grants", async () => {
    const storage = await newStorage();
    const h = handler(storage, {
      linkReadRateLimiter: new LinkReadRateLimiter(1, 0.000_001, 10),
      linkGrantReadRateLimiter: new LinkReadRateLimiter(1, 0.000_001, 10),
    });
    const first = await seed(h);
    const second = await createLink(h, { paths: ["docs"], access: "view" });
    expect(second.grantId).not.toBe(first.grantId);

    expect((await h(linkRequest(first.capability, "/sync/link/share"))).status).toBe(200);
    expect((await h(linkRequest(second.capability, "/sync/link/share"))).status).toBe(200);
  });

  it("uses a separate read bucket for link log pages", async () => {
    const storage = await newStorage();
    const h = handler(storage, {
      linkReadRateLimiter: new LinkReadRateLimiter(1, 0.000_001, 10),
      linkGrantReadRateLimiter: new LinkReadRateLimiter(1, 0.000_001, 10),
      linkLogReadRateLimiter: new LinkReadRateLimiter(1, 0.000_001, 10),
      linkGrantLogReadRateLimiter: new LinkReadRateLimiter(1, 0.000_001, 10),
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

  it("keeps total blob egress on the grant across rotation and refills it", async () => {
    expect(LINK_GRANT_EGRESS_BUCKET_CAPACITY_BYTES).toBe(5 * MAX_BLOB_BYTES);
    expect(LINK_GRANT_EGRESS_REFILL_BYTES_PER_SECOND).toBe(
      LINK_GRANT_EGRESS_BUCKET_CAPACITY_BYTES / (24 * 60 * 60),
    );
    let now = 2_000;
    const storage = await newStorage();
    const h = handler(storage, {
      nowMs: () => now,
      linkGrantEgressRateLimiter: new LinkEgressRateLimiter(18, 9, 10),
    });
    const seeded = await seed(h);
    const blobPath = `/sync/link/blobs/${seeded.sharedSha}`;

    for (let reads = 0; reads < 2; reads += 1) {
      const response = await h(linkRequest(seeded.capability, blobPath));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("# shared\n");
    }
    const exhausted = await h(linkRequest(seeded.capability, blobPath));
    expect(exhausted.status).toBe(429);
    expect(await json(exhausted)).toMatchObject({ code: "link_read_rate_limited" });

    const rotation = await json(
      await h(
        request(
          OWNER,
          `/sync/shares/share-0/links/${seeded.grantId}/rotate`,
          jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
        ),
      ),
    );
    const exchange = await json(
      await h(
        request(
          null,
          "/sync/link-exchange",
          jsonBody({ secret: linkSecret(rotation.url) }),
        ),
      ),
    );
    expect(exchange.grantId).toBe(seeded.grantId);
    const rotatedCapability = String(exchange.capabilityToken);
    const stillExhausted = await h(linkRequest(rotatedCapability, blobPath));
    expect(stillExhausted.status).toBe(429);
    expect(await json(stillExhausted)).toMatchObject({
      code: "link_read_rate_limited",
    });

    now += 1_000;
    const refilled = await h(linkRequest(rotatedCapability, blobPath));
    expect(refilled.status).toBe(200);
    expect(await refilled.text()).toBe("# shared\n");
  });

  it("charges exact metadata and log response bytes to the same grant", async () => {
    const storage = await newStorage();
    const budget = new LinkEgressRateLimiter(10_000, 1, 10);
    const charge = vi.spyOn(budget, "charge");
    const h = handler(storage, { linkGrantEgressRateLimiter: budget });
    const seeded = await seed(h);

    const metadata = await h(linkRequest(seeded.capability, "/sync/link/share"));
    expect(metadata.status).toBe(200);
    const metadataBody = await metadata.text();
    const current = await h(linkRequest(seeded.capability, "/sync/link/current"));
    expect(current.status).toBe(200);
    const currentBody = await current.text();
    const log = await h(linkRequest(seeded.capability, "/sync/link/log"));
    expect(log.status).toBe(200);
    const logBody = await log.text();

    expect(charge.mock.calls).toEqual([
      [seeded.grantId, Buffer.byteLength(metadataBody), 2_000],
      [seeded.grantId, Buffer.byteLength(currentBody), 2_000],
      [seeded.grantId, Buffer.byteLength(logBody), 2_000],
    ]);
  });

  it("keeps exhausted public link controls off the owner sync path", async () => {
    const exchangeLimiter = new LinkExchangeRateLimiter(1, 0.000_001, 10);
    const readLimiter = new LinkReadRateLimiter(1, 0.000_001, 10);
    const grantReadLimiter = new LinkReadRateLimiter(1, 0.000_001, 10);
    const logLimiter = new KeyIgnoringLinkReadRateLimiter(1, 0.000_001, 10);
    const grantLogLimiter = new LinkReadRateLimiter(1, 0.000_001, 10);
    const egressLimiter = new LinkEgressRateLimiter(9, 0.000_001, 10);
    const limiterCalls = [
      vi.spyOn(exchangeLimiter, "allow"),
      vi.spyOn(readLimiter, "allow"),
      vi.spyOn(grantReadLimiter, "allow"),
      vi.spyOn(logLimiter, "allow"),
      vi.spyOn(grantLogLimiter, "allow"),
      vi.spyOn(egressLimiter, "charge"),
    ];
    const storage = await newStorage();
    const h = handler(storage, {
      linkExchangeRateLimiter: exchangeLimiter,
      linkReadRateLimiter: readLimiter,
      linkGrantReadRateLimiter: grantReadLimiter,
      linkLogReadRateLimiter: logLimiter,
      linkGrantLogReadRateLimiter: grantLogLimiter,
      linkGrantEgressRateLimiter: egressLimiter,
    });
    const seeded = await seed(h);
    const blobPath = `/sync/link/blobs/${seeded.sharedSha}`;

    const publicBlob = await h(linkRequest(seeded.capability, blobPath));
    expect(publicBlob.status).toBe(200);
    expect(await publicBlob.text()).toBe("# shared\n");
    expect((await h(linkRequest(seeded.capability, blobPath))).status).toBe(429);
    expect((await h(linkRequest(seeded.capability, "/sync/link/log"))).status).toBe(429);
    expect(
      (
        await h(
          request(null, "/sync/link-exchange", jsonBody({ secret: seeded.secret })),
        )
      ).status,
    ).toBe(404);
    const callsAfterPublicExhaustion = limiterCalls.map(
      (spy) => spy.mock.calls.length,
    );

    const ownerContent = "# owner still syncing\n";
    const ownerSha = await putBlob(h, ownerContent);
    await appendMoments(h, [
      moment(3, "docs/owner.md", ownerContent, 2_100, {
        objectId: "object-owner",
      }),
    ]);
    const ownerBlob = await h(
      request(OWNER, `/sync/${WORKSPACE}/blobs/${ownerSha}`),
    );
    expect(ownerBlob.status).toBe(200);
    expect(await ownerBlob.text()).toBe(ownerContent);
    const ownerLog = await h(
      request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=100`),
    );
    expect(ownerLog.status).toBe(200);
    expect(((await json(ownerLog)).ops as unknown[]).length).toBeGreaterThan(0);

    expect(limiterCalls.map((spy) => spy.mock.calls.length)).toEqual(
      callsAfterPublicExhaustion,
    );
  });
});
