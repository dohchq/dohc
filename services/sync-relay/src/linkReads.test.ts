import { createReceivedIdentity } from "./receivedIdentity";
import { TokenBucketLimiter } from "@dohc/service-http";

import {
  filesFromAccumulator,
  foldLogOps,
  type FileAccumulator,
  type RelayOp } from "../../share-web/viewer/src/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscussionActivityHub } from "./discussionActivity";
import {
  LinkEgressRateLimiter,
  LINK_SESSION_TTL_MS } from "./linkSecurity";
import {
  filterOpForShare } from "./shareFilter";
import {
  type SyncRelayHandler } from "./server";
import {
  currentFileBlobByteLengthQuery,
  currentFileStateQuery,
  type SyncRelayStorage } from "./storage";

import {
  appendLog,
  closeTestStorages,
  denialBytes,
  inspectDatabase,
  interceptStorage,
  json,
  jsonBody,
  LINK_KEY,
  linkRequest,
  linkSecret,
  moment as buildMoment,
  putBlob as upload,
  request,
  sha256,
  storagePath,
  testHandler,
  testStorage as newStorage,
  type HandlerOverrides } from "./testing";

const OWNER = "owner";
const RECIPIENT = "recipient";
const WORKSPACE = "workspace-link-reads";
const receivedIdentity = createReceivedIdentity(LINK_KEY);
function withoutReceivedIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutReceivedIdentity);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "objectId" && key !== "receivedSource").map(([key, item]) => [key, withoutReceivedIdentity(item)]));
}
const UNKNOWN_CAPABILITY = "z".repeat(43);

it.each(["view"] as const)(
  "current-only %s links and their agents refuse History before and after a wake",
  async (access) => {
    const storage = await newStorage(),
      activity = new DiscussionActivityHub();
    const h = handler(storage, { discussionActivity: activity });
    const link = await seed(h, access);
    const agent = await json(
      await h(
        request(null, "/sync/link-exchange", jsonBody({ secret: link.secret })),
      ),
    );
    const latest = "current body",
      latestSha = await putBlob(h, latest);
    await appendMoments(h, [
      moment(3, "docs/shared.md", latest, 2000, {
        objectId: "object-shared",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
    ]);
    for (const capability of [link.capability, String(agent.capabilityToken)]) {
      expect(
        (await h(linkRequest(capability, `/sync/link/blobs/${link.sharedSha}`)))
          .status,
      ).toBe(404);
      expect(
        (await h(linkRequest(capability, "/sync/link/log?since=0"))).status,
      ).toBe(404);
      const current = await json(
        await h(linkRequest(capability, "/sync/link/current")),
      );
      expect(current.files).toEqual([
        expect.objectContaining({ blobSha256: latestSha }),
      ]);
      expect(
        await (
          await h(linkRequest(capability, `/sync/link/blobs/${latestSha}`))
        ).text(),
      ).toBe(latest);
      const changes = await json(
        await h(linkRequest(capability, "/sync/link/log?current=true&since=0")),
      );
      expect(JSON.stringify(changes)).not.toMatch(
        /payloadBefore|forkSnapshots|recordedAtMs/,
      );
      expect(JSON.stringify(changes)).not.toContain(link.sharedSha);
      expect(changes.ops).toContainEqual(
        expect.objectContaining({
          opKind: "file.current",
          payload: expect.objectContaining({
            file: expect.objectContaining({ blobSha256: latestSha }),
          }),
        }),
      );
      const pending = h(
        linkRequest(
          capability,
          `/sync/link/log?current=true&since=${current.nextCursor}&hold=30000`,
        ),
      );
      expect(activity.stats().waiters).toBe(1);
      const next = `wake-${capability}`,
        nextSha = await putBlob(h, next);
      const seq = capability === link.capability ? 4 : 5;
      await appendMoments(h, [
        moment(seq, "docs/shared.md", next, 8000 + seq * 1000, {
          objectId: "object-shared",
          beforePath: "docs/shared.md",
          beforeContent: latest,
        }),
      ]);
      const woke = await json(await pending);
      expect(JSON.stringify(woke)).not.toMatch(
        /payloadBefore|forkSnapshots|recordedAtMs/,
      );
      expect(JSON.stringify(woke)).not.toContain(latestSha);
      expect(woke.ops).toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            file: expect.objectContaining({ blobSha256: nextSha }),
          }),
        }),
      );
      expect(
        (await h(linkRequest(capability, `/sync/link/blobs/${latestSha}`)))
          .status,
      ).toBe(404);
      // Restore the current body before the next independent holder follows it.
      if (capability === link.capability)
        await appendMoments(
          h,
          [
            moment(0, "docs/shared.md", latest, 12500, {
              objectId: "object-shared",
              beforePath: "docs/shared.md",
              beforeContent: next,
            }),
          ],
          { originId: "restore" },
        );
    }
  },
);
it("serves one link-grant identity to browser and agent holders, separated from other grants and named users", async () => {
  const storage = await newStorage(), h = handler(storage);
  const first = await seed(h);
  const second = await createLink(h, { paths: ["docs"], access: "view" });
  const exchange = await json(await h(request(null, "/sync/link-exchange", jsonBody({ secret: first.secret }))));
  const read = async (capability: string) => {
    const meta = await json(await h(linkRequest(capability, "/sync/link/share")));
    const current = await json(await h(linkRequest(capability, "/sync/link/current")));
    const log = await json(await h(linkRequest(capability, "/sync/link/log?current=true&since=0&limit=100")));
    const files = new Map(); foldLogOps(files, log.ops as RelayOp[]);
    expect(filesFromAccumulator(files)).toEqual(current.files);
    return { receivedSource: meta.receivedSource, files: current.files };
  };
  const browser = await read(first.capability), agent = await read(String(exchange.capabilityToken));
  expect(agent).toEqual(browser);
  expect(browser).toEqual({ receivedSource: receivedIdentity.source(["link", first.grantId], WORKSPACE), files: [{ path: "docs/shared.md", blobSha256: first.sharedSha, contentKind: "text", objectId: receivedIdentity.object(["link", first.grantId], WORKSPACE, "object-shared") }] });
  const other = await read(second.capability);
  expect(other.receivedSource).not.toBe(browser.receivedSource);
  expect(other.files).not.toEqual(browser.files);
  const named = await json(await h(request(RECIPIENT, "/sync/shares/" + second.shareId)));
  expect(named.receivedSource).not.toBe(browser.receivedSource);
  for (const body of [browser, agent, other]) expect(JSON.stringify(body)).not.toContain(WORKSPACE);
});
const LINK_REFUSAL_BODY = '{"ok":false,"error":"not found"}';
const EPOCH_1 = "epoch-1";
const STREAM_1 = "stream-1";
const EPOCH_2 = "epoch-2";
const STREAM_2 = "stream-2";

type TestWorkspaceIdentity = {
  replicationEpoch: string;
  streamIdentity: string;
};

afterEach(closeTestStorages);

function handler(storage: SyncRelayStorage, options: HandlerOverrides = {}): SyncRelayHandler {
  return testHandler(storage, { resolveUserIdByEmail: undefined, lookupUserEmail: undefined, lookupVerifiedUserEmail: undefined, ...options });
}

function editHandler(storage: SyncRelayStorage, options: HandlerOverrides = {}): SyncRelayHandler {
  return handler(storage,{publicEditRelease:{version:1},relayExchangeKey:"link-read-preflight-relay-key-at-least-32",
    namedBrowserSessionLimits:{maxSessions:8,retentionMs:60_000,maxPendingRequests:4,maxRequestBytes:8192,maxResponseBytes:16384,timeoutMs:1000},...options});
}

class KeyIgnoringLinkReadRateLimiter extends TokenBucketLimiter {
  override allow(_key: string, nowMs: number): boolean {
    return super.allow("shared-test-bucket", nowMs);
  }
}

async function putBlob(h: SyncRelayHandler, content: string): Promise<string> {
  return upload(h, OWNER, WORKSPACE, content);
}

type MomentOptions = Omit<NonNullable<Parameters<typeof buildMoment>[2]>, "originSeq" | "recordedAtMs">;

function moment(
  originSeq: number,
  path: string,
  content: string,
  recordedAtMs: number,
  options: MomentOptions = {},
) {
  return buildMoment(path, content, { ...options, originSeq, recordedAtMs });
}

async function appendMoments(
  h: SyncRelayHandler,
  ops: ReturnType<typeof moment>[],
  options: {
    originId?: string;
    identity?: TestWorkspaceIdentity;
  } = {},
): Promise<void> {
  await appendLog(h, OWNER, WORKSPACE, ops, {
    originId: options.originId ?? "origin-a",
    ...(options.identity ?? {}),
  });
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
    await h(request(null, "/sync/link-exchange", {...jsonBody({ secret }), headers: {"content-type":"application/json", "x-dohc-relay-exchange-key":"link-read-preflight-relay-key-at-least-32"}})),
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

async function seedThenRotate(h: SyncRelayHandler, access: "view" | "edit" = "view") {
  const seeded = await seed(h, access, {}, {
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

async function capabilityRefusalBody(response: Response): Promise<string> {
  expect(response.status).toBe(404);
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
  const emit = (
    limiter: LinkEgressRateLimiter,
    grantId: string,
    byteLength: number,
    nowMs: number,
  ): boolean => {
    const settle = limiter.reserve(grantId, byteLength, nowMs);
    if (!settle) return false;
    settle(byteLength, nowMs);
    return true;
  };

  it("evicts a fully refilled bucket without resetting active grant debt", () => {
    const limiter = new LinkEgressRateLimiter(10, 1, 2);

    expect(emit(limiter, "target", 10, 0)).toBe(true);
    expect(emit(limiter, "refilled", 1, 1_000)).toBe(true);
    expect(emit(limiter, "newcomer", 1, 2_000)).toBe(true);

    expect(emit(limiter, "target", 10, 2_000)).toBe(false);
    expect(emit(limiter, "target", 2, 2_000)).toBe(true);
  });

  it("refuses a new grant while every tracked bucket carries debt", () => {
    const limiter = new LinkEgressRateLimiter(10, 1, 2);

    expect(emit(limiter, "target", 10, 0)).toBe(true);
    expect(emit(limiter, "other", 10, 1_000)).toBe(true);

    expect(emit(limiter, "newcomer", 1, 2_000)).toBe(false);
    expect(emit(limiter, "target", 10, 2_000)).toBe(false);
    expect(emit(limiter, "target", 2, 2_000)).toBe(true);
    expect(emit(limiter, "other", 1, 2_000)).toBe(true);
  });
});

describe("relay capability reads", () => {

  it("keeps exact object results at the 32-moment boundary and above the epoch floor", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h, "view");
    const lookup = (epochLogFloor = 0) => storage.currentObjectFile({ workspaceId: WORKSPACE, versionId: "main", objectId: "object-shared", epochLogFloor });
    const current = await json(await h(linkRequest(seeded.capability, "/sync/link/current")));
    const floor = Number(current.nextCursor);
    await putBlob(h, "refused\n");
    await putBlob(h, "wrong before\n");
    const refused = (index: number) => moment(index + 3, "docs/shared.md", "refused\n", 1_300 + index, {
      objectId: "object-shared", beforePath: "docs/shared.md", beforeContent: "wrong before\n",
    });
    appendStoredMoments(storage, Array.from({ length: 31 }, (_, index) => refused(index)));
    expect(lookup()).toEqual({ path: "docs/shared.md", blobSha256: seeded.sharedSha, contentKind: "text" });
    expect(lookup(floor)).toBeNull();
    appendStoredMoments(storage, [refused(31)]);
    expect(lookup()).toBe("reset");
    expect(lookup(floor)).toBeNull();
  });

  it("materializes the viewer CAS fold per version and uses the selected path index", async () => {
    const storage = await newStorage();
    const h = editHandler(storage);
    const seeded = await seed(h, "edit");
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
    expect(current.files).toMatchObject([{
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

    const inspection = inspectDatabase(storagePath(storage), { readOnly: true });
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

      const blobQuery = currentFileBlobByteLengthQuery(["docs"]);
      const blobPlan = inspection.prepare(`EXPLAIN QUERY PLAN ${blobQuery.sql}`).all(
        WORKSPACE,
        "main",
        acceptedSha,
        0,
        ...blobQuery.selectorParams,
      );
      const blobDetails = blobPlan.map((row) => String(row.detail)).join("\n");
      expect(blobDetails).toMatch(
        /SEARCH sync_relay_current_files USING COVERING INDEX idx_sync_relay_current_files_blob/u,
      );
      expect(blobDetails).toMatch(
        /SEARCH blob USING INDEX sqlite_autoindex_sync_relay_blobs_1/u,
      );
    } finally {
      inspection.close();
    }
  });

  it("refuses contradictory path aliases from current state and startup replay", async () => {
    const storage = await newStorage();
    const h = editHandler(storage);
    const seeded = await seed(h, "edit");
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
          { paths: ["docs"], versionId: null, access: "edit" },
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
      expect(filesFromAccumulator(replayed)).toMatchObject(expectedFiles);

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

  });

  it("applies the current-file cap after selector filtering and refuses overflow generically", async () => {
    const storage = await newStorage();
    const h = handler(storage, { linkCurrentFileLimit: 1 });
    const seeded = await seed(h);

    const oneSelected = await h(linkRequest(seeded.capability, "/sync/link/current"));
    expect(oneSelected.status).toBe(200);
    expect((await json(oneSelected)).files).toMatchObject([{
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

  it("revalidates the capability generation after reading current state", async () => {
    const storage = await newStorage();
    let revokeOnRead = false;
    let grantId = "";
    const storageWithRace = interceptStorage(storage, {
      readCurrentFileState: (target, input) => {
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

  it.each(["rotate"] as const)(
    "charges only emitted blob bytes after stream %s",
    async () => {
      const chunkBytes = 64 * 1024;
      const largeContent = "l".repeat(3 * chunkBytes);
      const exactRefundContent = "r".repeat(2 * chunkBytes);
      const finalByteContent = "f";
      const storage = await newStorage();
      const egress = new LinkEgressRateLimiter(largeContent.length, 0.000_001, 10);
      const h = handler(storage, {
        nowMs: () => 2_000,
        linkGrantEgressRateLimiter: egress,
      });
      const seeded = await seed(h);
      const largeSha = await putBlob(h, largeContent);
      const exactRefundSha = await putBlob(h, exactRefundContent);
      const finalByteSha = await putBlob(h, finalByteContent);
      await appendMoments(h, [
        moment(3, "docs/large.bin", largeContent, 1_300),
        moment(4, "docs/refund.bin", exactRefundContent, 1_400),
        moment(5, "docs/final-byte.bin", finalByteContent, 1_500),
      ]);

      const largePath = `/sync/link/blobs/${largeSha}`;
      const partial = await h(linkRequest(seeded.capability, largePath));
      expect(partial.status).toBe(200);
      const reader = partial.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      if (first.done) return;
      expect(first.value.byteLength).toBe(chunkBytes);

      let capability = seeded.capability;

      const rotation = await json(
        await h(
          request(
            OWNER,
            `/sync/shares/share-0/links/${seeded.grantId}/rotate`,
            jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
          ),
        ),
      );
      const terminated = await reader.read().then(
        () => ({ kind: "delivered" as const }),
        (error: unknown) => ({
          kind: "terminated" as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      expect(terminated).toEqual({
        kind: "terminated",
        message: "link grant changed during stream",
      });
      await reader.cancel().catch(() => undefined);
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
      capability = String(exchange.capabilityToken);

      const overRefunded = await h(linkRequest(capability, largePath));
      expect(overRefunded.status).toBe(429);
      expect(await json(overRefunded)).toMatchObject({
        code: "link_read_rate_limited",
      });

      const exactRefund = await h(
        linkRequest(capability, `/sync/link/blobs/${exactRefundSha}`),
      );
      expect(exactRefund.status).toBe(200);
      expect(new Uint8Array(await exactRefund.arrayBuffer())).toHaveLength(
        exactRefundContent.length,
      );

      const completionRefunded = await h(
        linkRequest(capability, `/sync/link/blobs/${finalByteSha}`),
      );
      expect(completionRefunded.status).toBe(429);
      expect(await json(completionRefunded)).toMatchObject({
        code: "link_read_rate_limited",
      });
    },
  );

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
        message: "link grant changed during stream",
      });
      const untouchedBytes = await readRemainingBytes(
        untouchedReader,
        untouchedFirst.value,
      );
      expect(new TextDecoder().decode(untouchedBytes)).toBe(content);
    },
  );

  it("matches the view recipient file and blob boundary without its identity metadata", async () => {
    const storage = await newStorage();
    const h = editHandler(storage);
    const { capability, sharedSha, hiddenSha } = await seed(h, "edit");

    const recipientMeta = await json(await h(request(RECIPIENT, "/sync/shares/share-0")));
    const linkMetaResponse = await h(linkRequest(capability, "/sync/link/share"));
    expect(linkMetaResponse.status).toBe(200);
    const linkMeta = await json(linkMetaResponse);
    expect(linkMeta).toMatchObject({
      ok: true,
      subjectName: null,
      effectiveSelector: {
        ...(recipientMeta.selector as Record<string, unknown>),
        access: "edit",
      },
      access: "edit",
      lastSettledAtMs: 1_100,
      lastSettledKnown: true,
    });
    expect(linkMeta).not.toHaveProperty("granterEmail");
    expect(linkMeta).not.toHaveProperty("workspaceId");
    expect(linkMeta).not.toHaveProperty("grantId");
    expect(linkMeta).not.toHaveProperty("participants");

    const recipientLog = await json(
      await h(request(RECIPIENT, "/sync/shares/share-0/log?since=0&limit=100&originId=recipient-replica")),
    );
    const linkLog = await json(
      await h(linkRequest(capability, "/sync/link/log?since=0&limit=100")),
    );
    const recipientOps = recipientLog.ops as Array<Record<string, unknown>>;
    const stored = storage.fetchLogCoordinate({ workspaceId: WORKSPACE, originId: "origin-a", originSeq: 1 })!;
    expect(stored.admittedAuthorSnapshot).toBeUndefined();
    expect(JSON.parse(stored.payloadJson)).not.toHaveProperty("authors");
    expect(stored.settlementAdmission).toBeUndefined();
    expect(recipientOps.find(op => op.opKind === "moment.append")?.payload).toMatchObject({
      authors: [{ kind: "unattributed" }],
    });
    // This named-reader fallback is not a relay-journal snapshot; accountless replay omits authors.
    const linkOps = recipientOps.map(({ originId: _originId, payload, ...op }) => {
      const { authors: _authors, ...artifact } = payload as Record<string, unknown>;
      return { ...op, payload: artifact };
    });
    // Named sync carries reference mappings; link logs keep their file replay contract.
    const { ownOriginId, workReferences, nextReferenceAfter, referenceHasMore, ...recipientPage } = recipientLog;
    expect(ownOriginId).toMatch(/^relay:share-member:[a-f0-9]{64}$/);
    expect(workReferences).toEqual([]);
    expect(nextReferenceAfter).toBeTypeOf("string");
    expect(referenceHasMore).toBe(false);
    expect(linkLog).not.toHaveProperty("workReferences");
    expect(linkLog).not.toHaveProperty("nextReferenceAfter");
    expect(linkLog).not.toHaveProperty("referenceHasMore");
    expect(withoutReceivedIdentity(linkLog)).toEqual(withoutReceivedIdentity({ ...recipientPage, ops: linkOps, epochLogFloor: 0 }));
    expect(linkLog).not.toHaveProperty("ownOriginId");
    expect(linkOps.every((op) => !Object.hasOwn(op, "originId"))).toBe(true);
    expect(JSON.stringify(linkLog)).not.toContain('"authors"');
    expect(JSON.stringify(linkLog)).not.toContain("private/hidden.md");

    const recipientBlob = await h(
      request(RECIPIENT, `/sync/shares/share-0/blobs/${sharedSha}`),
    );
    const linkBlob = await h(linkRequest(capability, `/sync/link/blobs/${sharedSha}`));
    expect(linkBlob.status).toBe(recipientBlob.status);
    expect(await linkBlob.arrayBuffer()).toEqual(await recipientBlob.arrayBuffer());

    const missingSha = sha256("missing");
    await denialBytes(
      await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${missingSha}`)),
    );
    expect(
      await denialBytes(await h(linkRequest(capability, `/sync/link/blobs/${hiddenSha}`))),
    ).toBe('404:{"ok":false,"error":"not found"}');
    expect(
      await denialBytes(await h(linkRequest(capability, `/sync/link/blobs/${missingSha}`))),
    ).toBe('404:{"ok":false,"error":"not found"}');
  });

  it("projects an inward move as an accountless arrival so current and replay converge", async () => {
    const storage = await newStorage();
    const h = editHandler(storage);
    const seeded = await seed(h, "edit");
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
        { paths: ["docs"], versionId: null, access: "edit" },
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
    expect(accountlessOps).toMatchObject([
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
    expect(filesFromAccumulator(alreadyOpenFiles)).toMatchObject(expectedFiles);

    const fullReplay = await json(
      await h(linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100")),
    );
    const freshFiles: FileAccumulator = new Map();
    foldLogOps(freshFiles, fullReplay.ops as RelayOp[]);
    expect(filesFromAccumulator(freshFiles)).toMatchObject(expectedFiles);

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

  it("keeps accountless log pages to viewer artifact rows without changing authenticated logs", async () => {
    const storage = await newStorage();
    const h = editHandler(storage);
    const seeded = await seed(h, "edit");
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
      .map(({ originId: _originId, payload, ...op }) => {
        const { authors: _authors, ...artifact } = payload;
        return { ...op, payload: artifact };
      });
    expect(withoutReceivedIdentity(linkLog)).toEqual(withoutReceivedIdentity({
      ok: true,
      ops: expectedLinkOps,
      nextCursor: authenticatedLog.nextCursor,
      hasMore: authenticatedLog.hasMore,
      epochLogFloor: 0,
    }));
    expect(
      (linkLog.ops as Array<Record<string, unknown>>).every(
        (op) => !Object.hasOwn(op, "originId"),
      ),
    ).toBe(true);
    expect(JSON.stringify(linkLog)).not.toContain('"authors"');
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

  it("keeps link log pages and freshness above the workspace epoch floor", async () => {
    const storage = await newStorage();
    const h = editHandler(storage);
    const seeded = await seed(h, "edit", {}, {
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

  it("recreates a pre-reset path from empty current state after epoch rotation", async () => {
    const storage = await newStorage();
    const h = editHandler(storage);
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
    expect(current.files).toMatchObject([{
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

  it("propagates a retirement delete through the link log and withdraws its history", async () => {
    const storage = await newStorage();
    const h = editHandler(storage);
    const seeded = await seed(h, "edit");
    const replacement = "# replacement\n";
    const replacementSha = await putBlob(h, replacement);
    await appendMoments(h, [moment(3, "docs/shared.md", replacement, 1_300, {
      objectId: "object-shared", beforePath: "docs/shared.md", beforeContent: "# shared\n",
    })]);
    const initial = await json(await h(linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100")));
    const imported: FileAccumulator = new Map();
    foldLogOps(imported, initial.ops as RelayOp[]);
    expect(filesFromAccumulator(imported).map(file => file.path)).toEqual(["docs/shared.md"]);
    for (const sha of [seeded.sharedSha, replacementSha]) {
      expect((await h(linkRequest(seeded.capability, "/sync/link/blobs/" + sha))).status).toBe(200);
    }

    // CaptureDriver policy narrowing retires the old head with a delete moment.
    await appendMoments(h, [moment(4, "docs/shared.md", replacement, 1_400, {
      objectId: "object-shared", operation: "delete", beforePath: "docs/shared.md", beforeContent: replacement,
      payload: { metadata: { origin: "local-file", summary: "Stopped tracking by policy" } },
    })]);
    const delta = await json(await h(linkRequest(seeded.capability, "/sync/link/log?since=" + String(initial.nextCursor) + "&limit=100")));
    expect(delta.ops).toEqual([expect.objectContaining({ opKind: "moment.append", payload: expect.objectContaining({
      operation: "delete", path: "docs/shared.md", payloadBeforePath: "docs/shared.md",
    }) })]);
    foldLogOps(imported, delta.ops as RelayOp[]);
    expect(filesFromAccumulator(imported)).toEqual([]);
    const current = await json(await h(linkRequest(seeded.capability, "/sync/link/current")));
    expect(current.files).toMatchObject([]);
    for (const sha of [seeded.sharedSha, replacementSha]) {
      expect(await denialBytes(await h(linkRequest(seeded.capability, "/sync/link/blobs/" + sha))))
        .toBe("404:" + LINK_REFUSAL_BODY);
    }
  });

  it("withdraws history on a move out and does not restore it on a move back in", async () => {
    const storage = await newStorage();
    const h = editHandler(storage);
    const seeded = await seed(h, "edit");
    const replacement = "# replacement\n";
    const replacementSha = await putBlob(h, replacement);
    await appendMoments(h, [
      moment(3, "docs/shared.md", replacement, 1_300, {
        objectId: "object-shared",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
      moment(4, "private/shared.md", replacement, 1_400, {
        objectId: "object-shared",
        operation: "rename",
        beforePath: "docs/shared.md",
        beforeContent: replacement,
      }),
      moment(5, "docs/shared.md", replacement, 1_500, {
        objectId: "object-shared",
        operation: "rename",
        beforePath: "private/shared.md",
        beforeContent: replacement,
      }),
    ]);

    const current = await h(linkRequest(seeded.capability, `/sync/link/blobs/${replacementSha}`));
    expect(current.status).toBe(200);
    expect(await current.text()).toBe(replacement);
    expect(
      await denialBytes(
        await h(linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`)),
      ),
    ).toBe(`404:${LINK_REFUSAL_BODY}`);
  });

  it("serves only the current file on a pinned view link", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h, "view", { paths: ["docs"], versionId: "snapshot-1" });
    const snapshot = "# snapshot\n";
    const edited = "# edited on the version\n";
    const snapshotSha = await putBlob(h, snapshot);
    const editedSha = await putBlob(h, edited);
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/${WORKSPACE}/log`,
            jsonBody({
              originId: "origin-a",
              ops: [{
                originSeq: 3,
                opKind: "version.create",
                payload: {
                  versionId: "snapshot-1",
                  forkSnapshots: [
                    { objectId: "object-pinned", path: "docs/pinned.md", blobSha256: snapshotSha },
                    { objectId: "object-private", path: "private/hidden.md", blobSha256: seeded.hiddenSha },
                  ],
                },
                recordedAtMs: 1_300,
              }],
            }),
          ),
        )
      ).status,
    ).toBe(200);
    await appendMoments(h, [
      moment(4, "docs/pinned.md", edited, 1_400, {
        versionId: "snapshot-1",
        objectId: "object-pinned",
        beforePath: "docs/pinned.md",
        beforeContent: snapshot,
      }),
    ]);

    expect((await h(linkRequest(seeded.capability, `/sync/link/blobs/${snapshotSha}`))).status).toBe(404);
    for (const [sha, content] of [[editedSha, edited]] as const) {
      const response = await h(linkRequest(seeded.capability, `/sync/link/blobs/${sha}`));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(content);
    }
    expect(
      await denialBytes(
        await h(linkRequest(seeded.capability, `/sync/link/blobs/${seeded.hiddenSha}`)),
      ),
    ).toBe(`404:${LINK_REFUSAL_BODY}`);

    await appendMoments(h, [
      moment(5, "docs/pinned.md", edited, 1_500, {
        versionId: "snapshot-1",
        objectId: "object-pinned",
        operation: "delete",
        beforePath: "docs/pinned.md",
        beforeContent: edited,
      }),
    ]);
    expect(
      await denialBytes(await h(linkRequest(seeded.capability, `/sync/link/blobs/${snapshotSha}`))),
    ).toBe(`404:${LINK_REFUSAL_BODY}`);
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

  it("rate-limits only after capability authentication", async () => {
    const storage = await newStorage();
    const limiter = new TokenBucketLimiter(1, 0.000_001, 10);
    const h = handler(storage, { linkReadRateLimiter: limiter });
    const seeded = await seed(h);
    expect((await h(linkRequest(UNKNOWN_CAPABILITY, "/sync/link/share"))).status).toBe(404);
    expect((await h(linkRequest(seeded.capability, "/sync/link/share"))).status).toBe(200);
    const limited = await h(linkRequest(seeded.capability, "/sync/link/share"));
    expect(limited.status).toBe(429);
    expect(await json(limited)).toMatchObject({ code: "link_read_rate_limited" });
  });

  it("keeps total blob egress on the grant across rotation and refills it", async () => {
    let now = 2_000;
    const storage = await newStorage();
    const getBlob = vi.spyOn(storage, "getBlob");
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
    expect(getBlob).toHaveBeenCalledTimes(2);

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
    expect(getBlob).toHaveBeenCalledTimes(2);

    now += 1_000;
    const refilled = await h(linkRequest(rotatedCapability, blobPath));
    expect(refilled.status).toBe(200);
    expect(await refilled.text()).toBe("# shared\n");
    expect(getBlob).toHaveBeenCalledTimes(3);
  });

  it("keeps exhausted public link controls off the owner sync path", async () => {
    const exchangeLimiter = new TokenBucketLimiter(1, 0.000_001, 10);
    const readLimiter = new TokenBucketLimiter(1, 0.000_001, 10);
    const grantReadLimiter = new TokenBucketLimiter(1, 0.000_001, 10);
    const logLimiter = new KeyIgnoringLinkReadRateLimiter(1, 0.000_001, 10);
    const grantLogLimiter = new TokenBucketLimiter(1, 0.000_001, 10);
    const egressLimiter = new LinkEgressRateLimiter(9, 0.000_001, 10);
    const limiterCalls = [
      vi.spyOn(exchangeLimiter, "allow"),
      vi.spyOn(readLimiter, "allow"),
      vi.spyOn(grantReadLimiter, "allow"),
      vi.spyOn(logLimiter, "allow"),
      vi.spyOn(grantLogLimiter, "allow"),
      vi.spyOn(egressLimiter, "reserve"),
    ];
    const storage = await newStorage();
    const h = editHandler(storage, {
      linkExchangeGlobalRateLimiter: exchangeLimiter,
      linkReadRateLimiter: readLimiter,
      linkGrantReadRateLimiter: grantReadLimiter,
      linkLogReadRateLimiter: logLimiter,
      linkGrantLogReadRateLimiter: grantLogLimiter,
      linkGrantEgressRateLimiter: egressLimiter,
    });
    const seeded = await seed(h, "edit");
    const blobPath = `/sync/link/blobs/${seeded.sharedSha}`;

    const publicBlob = await h(linkRequest(seeded.capability, blobPath));
    expect(publicBlob.status).toBe(200);
    expect(await publicBlob.text()).toBe("# shared\n");
    expect((await h(linkRequest(seeded.capability, blobPath))).status).toBe(429);
    expect((await h(linkRequest(seeded.capability, "/sync/link/log"))).status).toBe(429);
    expect(
      (
        await h(
          request(null, "/sync/link-exchange", {...jsonBody({ secret: seeded.secret }),headers:{"content-type":"application/json","x-dohc-relay-exchange-key":"link-read-preflight-relay-key-at-least-32"}}),
        )
      ).status,
     ).toBe(429);
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

