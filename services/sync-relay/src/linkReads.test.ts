import { TokenBucketLimiter } from "@dohc/service-http";
import {linkRefusalBody} from "@dohc/security-contract/link-refusal";
import {
  accumulatorFromCurrentFiles,
  filesFromAccumulator,
  foldLogOps,
  type FileAccumulator,
  type RelayOp,
} from "../../share-web/viewer/src/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscussionActivityHub } from "./discussionActivity";
import {
  hashLinkBearer,
  LinkEgressRateLimiter,
  LINK_GRANT_EGRESS_BUCKET_CAPACITY_BYTES,
  LINK_SESSION_TTL_MS,
} from "./linkSecurity";
import {
  filterOpForShare,
  hasValidShareMomentShape,
  type ShareSelector,
} from "./shareFilter";
import {
  LINK_FRESHNESS_PAGE_BUDGET,
  MAX_BLOB_BYTES,
  MAX_RAW_ROWS_PER_LINK_PAGE,
  type SyncRelayHandler,
} from "./server";
import {
  currentFileBlobByteLengthQuery,
  currentFileStateQuery,
  SHARED_BLOB_CANDIDATE_LIMIT,
  type SyncRelayStorage,
} from "./storage";
import { LINK_REVISION_SCAN_LIMIT } from "./storage/limits";
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
  type HandlerOverrides,
} from "./testing";

const OWNER = "owner";
const RECIPIENT = "recipient";
const WORKSPACE = "workspace-link-reads";
const UNKNOWN_CAPABILITY = "z".repeat(43);
it("bounds storage work with the same rate refusal for every target after authentication", async () => {
  const storage = await newStorage();
  const h = handler(storage, {linkReadRateLimiter: new TokenBucketLimiter(1, 0.000001, 10),
    appPublicationLimits: {maxFiles: 10, maxMetadataBytes: 16_384, maxBundleBytes: 4096}, appCollectionPolicy: {maxCreatesPerGrant: 10}});
  const seeded = await seed(h);
  expect((await h(linkRequest(seeded.capability, "/sync/link/share"))).status).toBe(200);
  const limited = await h(linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`));
  expect(limited.status).toBe(429);
  expect(await limited.json()).toEqual({ok: false, code: "link_read_rate_limited", error: "This link has reached its request limit. Try again later."});
  const lookup = vi.spyOn(storage, "readCurrentFileState");
  const publications = vi.spyOn(storage, "listLinkAppPublications");
  const collection = vi.spyOn(storage, "authorizeLinkAppCollection");
  for (const path of ["/sync/link/current", `/sync/link/blobs/${seeded.hiddenSha}`, `/sync/link/blobs/${sha256("missing")}`,
    "/sync/link/app-publications", `/sync/link/app-publications/${"a".repeat(64)}/collection?authorityRevision=1&limit=5`]) {
    const refused = await h(linkRequest(seeded.capability, path, {headers: {"x-dohc-link-profile-secret": "p".repeat(43)}}));
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({code: "link_read_rate_limited"});
  }
  expect(lookup).not.toHaveBeenCalled();
  expect(publications).not.toHaveBeenCalled();
  expect(collection).not.toHaveBeenCalled();
  const refused = await h(linkRequest(UNKNOWN_CAPABILITY, `/sync/link/blobs/${seeded.sharedSha}`));
  expect([refused.status, await refused.text()]).toEqual([404, '{"ok":false,"error":"not found"}']);
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
  it("parks a link log read until selected durable state advances", async () => {
    const storage = await newStorage();
    const activity = new DiscussionActivityHub();
    const h = handler(storage, { discussionActivity: activity });
    const seeded = await seed(h, "comment");
    const initial = await json(
      await h(
        linkRequest(
          seeded.capability,
          "/sync/link/log?since=0&limit=500",
        ),
      ),
    );
    const initialCursor = Number(initial.nextCursor);

    const held = h(
      linkRequest(
        seeded.capability,
        `/sync/link/log?since=${String(initialCursor)}&limit=500&hold=30000`,
      ),
    );
    expect(
      await Promise.race([
        held.then(() => "settled"),
        Promise.resolve("pending"),
      ]),
    ).toBe("pending");
    expect(activity.stats()).toEqual({ shares: 1, waiters: 1 });

    await appendMoments(h, [
      moment(2, "private/hidden.md", "hidden\n", 1_200),
    ]);
    expect(
      await Promise.race([
        held.then(() => "settled"),
        Promise.resolve("pending"),
      ]),
    ).toBe("pending");
    expect(activity.stats()).toEqual({ shares: 1, waiters: 1 });

    await putBlob(h, "private update\n");
    await appendMoments(h, [
      moment(3, "private/held-noise.md", "private update\n", 1_300),
    ]);
    expect(
      await Promise.race([
        held.then(() => "settled"),
        Promise.resolve("pending"),
      ]),
    ).toBe("pending");
    expect(activity.stats()).toEqual({ shares: 1, waiters: 1 });

    const selectedBody = "# selected settlement\n";
    await putBlob(h, selectedBody);
    await appendMoments(h, [
      moment(4, "docs/shared.md", selectedBody, 1_400, {
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
    ]);
    const selected = await json(await held);
    expect(selected).toMatchObject({
      ok: true,
      hasMore: false,
      ops: [
        {
          relaySeq: initialCursor + 2,
          originSeq: 4,
          opKind: "moment.append",
          payload: expect.objectContaining({
            path: "docs/shared.md",
            payloadAfterPath: "docs/shared.md",
            payloadAfterBlobSha256: sha256(selectedBody),
          }),
          recordedAtMs: 1_400,
        },
      ],
    });
    expect(selected.ops).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ originId: expect.anything() })]),
    );
    expect(activity.stats()).toEqual({ shares: 0, waiters: 0 });

    const raceBody = "# registered race\n";
    await putBlob(h, raceBody);
    const originalFetchLogPage = storage.fetchLogPage.bind(storage);
    let raceFetches = 0;
    let raceArmed = true;
    const fetchSpy = vi.spyOn(storage, "fetchLogPage").mockImplementation((input) => {
      raceFetches += 1;
      if (raceArmed && raceFetches === 2) {
        raceArmed = false;
        const racedMoment = moment(0, "docs/shared.md", raceBody, 1_500, {
          beforePath: "docs/shared.md",
          beforeContent: selectedBody,
        });
        storage.appendLogBatch({
          workspaceId: WORKSPACE,
          originId: "origin-race",
          ops: [{
            ...racedMoment,
            payloadJson: JSON.stringify(racedMoment.payload),
          }],
        });
      }
      return originalFetchLogPage(input);
    });
    const raced = await json(
      await h(
        linkRequest(
          seeded.capability,
          `/sync/link/log?since=${String(selected.nextCursor)}&limit=500&hold=30000`,
        ),
      ),
    );
    fetchSpy.mockRestore();
    expect(raceArmed).toBe(false);
    expect(raced).toMatchObject({
      ops: [
        expect.objectContaining({
          originSeq: 0,
          payload: expect.objectContaining({
            payloadAfterBlobSha256: sha256(raceBody),
          }),
        }),
      ],
    });

    const narrowedRead = h(
      linkRequest(
        seeded.capability,
        `/sync/link/log?since=${String(raced.nextCursor)}&limit=500&hold=30000`,
      ),
    );
    expect(
      await Promise.race([
        narrowedRead.then(() => "settled"),
        Promise.resolve("pending"),
      ]),
    ).toBe("pending");
    const shareId = storage.getShareGrant(seeded.grantId)!.shareId;
    const generationBeforeNarrowing = storage.getShareGrant(seeded.grantId)!.generation;
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/shares/${shareId}/links/${seeded.grantId}/retune`,
            jsonBody({
              workspaceId: WORKSPACE,
              access: "view",
              expectedDependentGrantIds: [],
            }),
          ),
        )
      ).status,
    ).toBe(200);
    expect(storage.getShareGrant(seeded.grantId)).toMatchObject({
      access: "view",
      generation: generationBeforeNarrowing,
    });
    expect(
      await Promise.race([
        narrowedRead.then(() => "settled"),
        Promise.resolve("pending"),
      ]),
    ).toBe("pending");
    expect(activity.stats()).toEqual({ shares: 1, waiters: 1 });

    const narrowedBody = "# selected after access narrowing\n";
    await putBlob(h, narrowedBody);
    await appendMoments(h, [
      moment(5, "docs/shared.md", narrowedBody, 1_550, {
        beforePath: "docs/shared.md",
        beforeContent: raceBody,
      }),
    ]);
    const narrowed = await json(await narrowedRead);
    expect(narrowed).toMatchObject({
      ops: [
        expect.objectContaining({
          originSeq: 5,
          payload: expect.objectContaining({
            payloadAfterBlobSha256: sha256(narrowedBody),
          }),
        }),
      ],
    });

    const revokedRead = h(
      linkRequest(
        seeded.capability,
        `/sync/link/log?since=${String(narrowed.nextCursor)}&limit=500&hold=30000`,
      ),
    );
    expect(
      await Promise.race([
        revokedRead.then(() => "settled"),
        Promise.resolve("pending"),
      ]),
    ).toBe("pending");
    const refusedBody = "# must not escape after revoke\n";
    await putBlob(h, refusedBody);
    const refusedMoment = moment(
      0,
      "docs/shared.md",
      refusedBody,
      1_600,
      { beforePath: "docs/shared.md", beforeContent: narrowedBody },
    );
    storage.appendLogBatch({
      workspaceId: WORKSPACE,
      originId: "origin-before-revoke",
      ops: [{
        ...refusedMoment,
        payloadJson: JSON.stringify({
          ...refusedMoment.payload,
          momentId: "moment-before-revoke",
        }),
      }],
    });
    expect(
      (
        await h(
          request(
            OWNER,
            `/sync/shares/${String(storage.getShareGrant(seeded.grantId)!.shareId)}/revoke`,
            jsonBody({
              grantId: seeded.grantId,
              workspaceId: WORKSPACE,
              expectedDependentGrantIds: [],
            }),
          ),
        )
      ).status,
    ).toBe(200);
    const revoked = await revokedRead;
    expect(`${String(revoked.status)}:${await revoked.text()}`).toBe(
      `404:${LINK_REFUSAL_BODY}`,
    );
    expect(activity.stats()).toEqual({ shares: 0, waiters: 0 });

    const serializationRace = await createLink(h, {
      paths: ["docs"],
      access: "view",
    });
    const beforeSerializationRace = await json(
      await h(
        linkRequest(
          serializationRace.capability,
          "/sync/link/log?since=0&limit=500",
        ),
      ),
    );
    const serializationRead = h(
      linkRequest(
        serializationRace.capability,
        `/sync/link/log?since=${String(beforeSerializationRace.nextCursor)}&limit=500&hold=30000`,
      ),
    );
    expect(
      await Promise.race([
        serializationRead.then(() => "settled"),
        Promise.resolve("pending"),
      ]),
    ).toBe("pending");
    const fetchBeforeSerialization = storage.fetchLogPage.bind(storage);
    let revokedDuringSerialization = false;
    const serializationFetchSpy = vi
      .spyOn(storage, "fetchLogPage")
      .mockImplementation((input) => {
        const rows = fetchBeforeSerialization(input);
        if (!revokedDuringSerialization) {
          const result = storage.revokeShareGrant({
            shareId: serializationRace.shareId,
            grantId: serializationRace.grantId,
            revokedAtMs: 1_650,
            expectedDependentGrantIds: [],
          });
          revokedDuringSerialization = result.ok;
        }
        return rows;
      });
    const serializationBody = "# authority changed before serialization\n";
    await putBlob(h, serializationBody);
    await appendMoments(h, [
      moment(6, "docs/shared.md", serializationBody, 1_650, {
        beforePath: "docs/shared.md",
        beforeContent: refusedBody,
      }),
    ]);
    const refusedSerialization = await serializationRead;
    serializationFetchSpy.mockRestore();
    expect(revokedDuringSerialization).toBe(true);
    expect(
      `${String(refusedSerialization.status)}:${await refusedSerialization.text()}`,
    ).toBe(`404:${LINK_REFUSAL_BODY}`);

    const fresh = await createLink(h, { paths: ["docs"], access: "view" });
    const current = await json(
      await h(linkRequest(fresh.capability, "/sync/link/log?since=0&limit=500")),
    );
    const abortController = new AbortController();
    const abortRequest = request(
      null,
      `/sync/link/log?since=${String(current.nextCursor)}&limit=500&hold=30000`,
      {
        headers: { authorization: `LinkCapability ${fresh.capability}` },
        signal: abortController.signal,
      },
    );
    const abortedRead = h(abortRequest);
    expect(
      await Promise.race([
        abortedRead.then(() => "settled"),
        Promise.resolve("pending"),
      ]),
    ).toBe("pending");
    abortController.abort();
    await abortedRead;
    expect(activity.stats()).toEqual({ shares: 0, waiters: 0 });

    const timedOut = await h(
      linkRequest(
        fresh.capability,
        `/sync/link/log?since=${String(current.nextCursor)}&limit=500&hold=1`,
      ),
    );
    expect(timedOut.status).toBe(200);
    expect(activity.stats()).toEqual({ shares: 0, waiters: 0 });

    const cappedActivity = new DiscussionActivityHub({ maxTotalWaiters: 1 });
    const cappedHandler = handler(storage, { discussionActivity: cappedActivity });
    const capAbort = new AbortController();
    const filled = cappedHandler(
      request(
        null,
        `/sync/link/log?since=${String(current.nextCursor)}&limit=500&hold=30000`,
        {
          headers: { authorization: `LinkCapability ${fresh.capability}` },
          signal: capAbort.signal,
        },
      ),
    );
    expect(
      await Promise.race([
        filled.then(() => "settled"),
        Promise.resolve("pending"),
      ]),
    ).toBe("pending");
    const limited = await cappedHandler(
      linkRequest(
        fresh.capability,
        `/sync/link/log?since=${String(current.nextCursor)}&limit=500&hold=30000`,
      ),
    );
    expect(limited.status).toBe(429);
    expect(await json(limited)).toEqual({
      ok: false,
      error: "This link has reached its request limit. Try again later.",
      code: "link_read_rate_limited",
    });
    expect(cappedActivity.stats()).toEqual({ shares: 1, waiters: 1 });
    capAbort.abort();
    await filled;
    expect(cappedActivity.stats()).toEqual({ shares: 0, waiters: 0 });

    for (const hold of [
      "",
      "-1",
      "+1",
      "1.5",
      "1e3",
      "0x10",
      "%201",
      "30001",
      "9007199254740992",
      "bad",
    ]) {
      const invalid = await h(
        linkRequest(
          fresh.capability,
          `/sync/link/log?since=${String(current.nextCursor)}&limit=500&hold=${hold}`,
        ),
      );
      expect(invalid.status, `hold=${hold}`).toBe(400);
    }
  });

  it("keeps simultaneous View and Comment grants bound to their own access", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const view = await seed(h, "view");
    const shareId = storage.getShareGrant(view.grantId)!.shareId;
    const commentResponse = await h(
      request(
        OWNER,
        `/sync/${WORKSPACE}/shares/${shareId}/links`,
        jsonBody({ access: "comment" }),
      ),
    );
    expect(commentResponse.status).toBe(200);
    const commentLink = await json(commentResponse);
    const commentExchangeResponse = await h(
      request(
        null,
        "/sync/link-exchange",
        jsonBody({ secret: linkSecret(commentLink.url) }),
      ),
    );
    expect(commentExchangeResponse.status).toBe(200);
    const commentExchange = await json(commentExchangeResponse);

    expect(commentExchange).toMatchObject({
      grantId: commentLink.grantId,
      access: "comment",
      generation: 1,
      effectiveSelector: { access: "comment" },
    });
    expect(commentExchange.grantId).not.toBe(view.grantId);

    for (const bound of [
      { access: "view", capability: view.capability, grantId: view.grantId },
      {
        access: "comment",
        capability: String(commentExchange.capabilityToken),
        grantId: String(commentLink.grantId),
      },
    ] as const) {
      const current = await h(linkRequest(bound.capability, "/sync/link/current"));
      expect(current.status).toBe(200);
      expect(await json(current)).toMatchObject({
        access: bound.access,
        effectiveSelector: { access: bound.access },
      });

      const refreshResponse = await h(
        request(null, "/sync/link-refresh", {
          method: "POST",
          headers: { authorization: `LinkCapability ${bound.capability}` },
        }),
      );
      expect(refreshResponse.status).toBe(200);
      expect(await json(refreshResponse)).toMatchObject({
        grantId: bound.grantId,
        access: bound.access,
        generation: 1,
        effectiveSelector: { access: bound.access },
      });
    }
  });

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
    expect(forward.files).toEqual([
      { path: "docs/first.md", blobSha256: firstSnapshotSha, contentKind: "text" },
      { path: "docs/pending.md", blobSha256: localWriteSha, contentKind: "text" },
    ]);
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

  });

  it.each(["path", "beforePath"] as const)(
    "refuses a contradictory visible %s alias from every accountless view",
    async (alias) => {
      const storage = await newStorage();
      const h = handler(storage);
      const seeded = await seed(h);
      const initialLog = await json(
        await h(linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100")),
      );
      const forwardFiles: FileAccumulator = new Map();
      foldLogOps(forwardFiles, initialLog.ops as RelayOp[]);

      const forgedContent = `forged ${alias}\n`;
      const forgedSha = await putBlob(h, forgedContent);
      const forgedMoment = alias === "path"
        ? moment(3, "docs/path-target.md", forgedContent, 1_300, {
            objectId: "object-forged-path",
          })
        : moment(3, "docs/renamed.md", forgedContent, 1_300, {
            objectId: "object-shared",
            operation: "rename",
            beforePath: "docs/shared.md",
            beforeContent: "# shared\n",
          });
      Object.assign(
        forgedMoment.payload,
        alias === "path"
          ? { path: "docs/path-alias.md" }
          : { beforePath: "docs/renamed.md" },
      );
      await appendMoments(h, [forgedMoment]);

      const delta = await json(
        await h(
          linkRequest(
            seeded.capability,
            `/sync/link/log?since=${String(initialLog.nextCursor)}&limit=100`,
          ),
        ),
      );
      foldLogOps(forwardFiles, delta.ops as RelayOp[]);
      const fullLog = await json(
        await h(linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100")),
      );
      const fullFiles: FileAccumulator = new Map();
      foldLogOps(fullFiles, fullLog.ops as RelayOp[]);
      const current = await json(
        await h(linkRequest(seeded.capability, "/sync/link/current")),
      );
      const forgedBlob = await denialBytes(
        await h(linkRequest(seeded.capability, `/sync/link/blobs/${forgedSha}`)),
      );
      const expectedFiles = [{
        path: "docs/shared.md",
        blobSha256: seeded.sharedSha,
        contentKind: "text",
      }];
      expect({
        current: current.files,
        fullReplay: filesFromAccumulator(fullFiles),
        forwardReplay: filesFromAccumulator(forwardFiles),
        deltaOps: delta.ops,
        forgedBlob,
      }).toEqual({
        current: expectedFiles,
        fullReplay: expectedFiles,
        forwardReplay: expectedFiles,
        deltaOps: [],
        forgedBlob: `404:${LINK_REFUSAL_BODY}`,
      });

      const sharedBlob = await h(
        linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`),
      );
      expect(sharedBlob.status).toBe(200);
      expect(await sharedBlob.text()).toBe("# shared\n");

    },
  );

  it("refuses an all-visible cross-path write from every accountless view", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const initialLog = await json(
      await h(linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100")),
    );
    const forwardFiles: FileAccumulator = new Map();
    foldLogOps(forwardFiles, initialLog.ops as RelayOp[]);

    const forgedContent = "forged cross-path write\n";
    const forgedSha = await putBlob(h, forgedContent);
    const forgedWrite = moment(3, "docs/moved.md", forgedContent, 1_300, {
      objectId: "object-shared",
      operation: "write",
      beforePath: "docs/shared.md",
      beforeContent: "# shared\n",
    });
    await appendMoments(h, [forgedWrite]);

    const expectedFiles = [{
      path: "docs/shared.md",
      blobSha256: seeded.sharedSha,
      contentKind: "text",
    }];
    const assertReadAgreement = async (
      readHandler: SyncRelayHandler,
      openedFiles?: FileAccumulator,
    ) => {
      const delta = await json(
        await readHandler(
          linkRequest(
            seeded.capability,
            `/sync/link/log?since=${String(initialLog.nextCursor)}&limit=100`,
          ),
        ),
      );
      if (openedFiles) foldLogOps(openedFiles, delta.ops as RelayOp[]);
      const fullLog = await json(
        await readHandler(
          linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100"),
        ),
      );
      const fullFiles: FileAccumulator = new Map();
      foldLogOps(fullFiles, fullLog.ops as RelayOp[]);
      const current = await json(
        await readHandler(linkRequest(seeded.capability, "/sync/link/current")),
      );
      expect({
        current: current.files,
        deltaOps: delta.ops,
        forward: openedFiles ? filesFromAccumulator(openedFiles) : expectedFiles,
        fullReplay: filesFromAccumulator(fullFiles),
      }).toEqual({
        current: expectedFiles,
        deltaOps: [],
        forward: expectedFiles,
        fullReplay: expectedFiles,
      });
      expect(
        await denialBytes(
          await readHandler(
            linkRequest(seeded.capability, `/sync/link/blobs/${forgedSha}`),
          ),
        ),
      ).toBe(`404:${LINK_REFUSAL_BODY}`);
      const sharedBlob = await readHandler(
        linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`),
      );
      expect(sharedBlob.status).toBe(200);
      expect(await sharedBlob.text()).toBe("# shared\n");
    };

    await assertReadAgreement(h, forwardFiles);

  });

  it.each([
    ["unsupported operation", "unsupported"],
    ["one-sided before path", "before-path-only"],
    ["one-sided before digest", "before-digest-only"],
    ["missing rename after path", "missing-after-path"],
  ] as const)(
    "does not expose a historical blob from a moment with %s",
    async (_case, shape) => {
      const storage = await newStorage();
      const h = handler(storage);
      const wholeVersion = shape === "missing-after-path";
      const versionId = wholeVersion ? "snapshot-malformed" : "main";
      const seeded = await seed(
        h,
        "view",
        wholeVersion
          ? { paths: [], versionId, sharedVersionId: versionId }
          : {},
      );
      const opened = await json(
        await h(linkRequest(seeded.capability, "/sync/link/log?since=0&limit=100")),
      );
      const forgedContent = `${shape}\n`;
      const forgedSha = await putBlob(h, forgedContent);
      const malformed = moment(3, "docs/shared.md", forgedContent, 1_300, {
        versionId,
        objectId: "object-shared",
        ...(shape === "missing-after-path"
          ? {
              operation: "rename" as const,
              beforePath: "docs/shared.md",
              beforeContent: "# shared\n",
            }
          : {}),
      });
      if (shape === "unsupported") {
        Object.assign(malformed.payload, { operation: "copy" });
      } else if (shape === "before-path-only") {
        Object.assign(malformed.payload, { payloadBeforePath: "docs/shared.md" });
      } else if (shape === "before-digest-only") {
        Object.assign(malformed.payload, {
          payloadBeforeBlobSha256: seeded.sharedSha,
        });
      } else {
        Object.assign(malformed.payload, { path: null, payloadAfterPath: null });
      }
      appendStoredMoments(storage, [malformed]);

      const since = String(opened.nextCursor);
      const [namedLog, viewLog] = await Promise.all([
        json(
          await h(
            request(
              RECIPIENT,
              `/sync/shares/share-0/log?since=${since}&limit=100`,
            ),
          ),
        ),
        json(
          await h(
            linkRequest(
              seeded.capability,
              `/sync/link/log?since=${since}&limit=100`,
            ),
          ),
        ),
      ]);
      const missingSha = sha256(`missing ${shape}`);
      const [missingNamed, missingView] = await Promise.all([
        denialBytes(
          await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${missingSha}`)),
        ),
        denialBytes(
          await h(linkRequest(seeded.capability, `/sync/link/blobs/${missingSha}`)),
        ),
      ]);
      await Promise.all([
        expect(
          denialBytes(
            await h(request(RECIPIENT, `/sync/shares/share-0/blobs/${forgedSha}`)),
          ),
        ).resolves.toBe(missingNamed),
        expect(
          denialBytes(
            await h(linkRequest(seeded.capability, `/sync/link/blobs/${forgedSha}`)),
          ),
        ).resolves.toBe(missingView),
      ]);
      expect(namedLog.ops).toEqual([]);
      expect(viewLog.ops).toEqual([]);
      expect(hasValidShareMomentShape(malformed.payload)).toBe(false);
    },
  );

  it.each([
    [
      "uppercase before digest",
      {
        operation: "write",
        path: "docs/shared.md",
        payloadBeforePath: "docs/shared.md",
        payloadBeforeBlobSha256: "A".repeat(64),
        payloadAfterPath: "docs/shared.md",
        payloadAfterBlobSha256: "b".repeat(64),
      },
    ],
    [
      "missing write after digest",
      {
        operation: "write",
        path: "docs/shared.md",
        payloadBeforePath: null,
        payloadBeforeBlobSha256: null,
        payloadAfterPath: "docs/shared.md",
        payloadAfterBlobSha256: null,
      },
    ],
    [
      "delete without a before pair",
      {
        operation: "delete",
        path: null,
        payloadBeforePath: null,
        payloadBeforeBlobSha256: null,
        payloadAfterPath: null,
        payloadAfterBlobSha256: "b".repeat(64),
      },
    ],
  ] as const)("refuses a share moment with %s", (_case, payload) => {
    expect(hasValidShareMomentShape(payload)).toBe(false);
  });

  it("ignores a delete after digest without granting blob authority", () => {
    const payload = {
      operation: "delete",
      versionId: "main",
      path: "docs/shared.md",
      payloadBeforePath: "docs/shared.md",
      payloadBeforeBlobSha256: "a".repeat(64),
      payloadAfterPath: null,
      payloadAfterBlobSha256: "not-a-digest",
    };
    expect(hasValidShareMomentShape(payload)).toBe(true);
    const decision = filterOpForShare(
      { paths: ["docs"], versionId: null, access: "view" },
      "moment.append",
      JSON.stringify(payload),
    );
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.blobSha256s).toEqual([]);
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

    },
  );

  it.each([
    ["folder moment", "moment", ["docs"], null],
    ["folder fork snapshot", "snapshot", ["docs"], "snapshot-folder"],
    ["whole-version fork snapshot", "snapshot", [], "snapshot-whole"],
    ["boundary rename", "boundary", ["docs"], null],
  ] as const)(
    "refuses noncanonical viewer paths in a %s",
    async (_case, shape, paths, versionId) => {
      const storage = await newStorage();
      const h = handler(storage);
      expect(
        (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
      ).toBe(200);

      const noncanonicalPath = shape === "boundary" ? "private//hidden.md" : "docs//x.md";
      const content = `${shape} with a noncanonical path\n`;
      const blobSha256 = await putBlob(h, content);
      if (shape === "boundary") await putBlob(h, "hidden\n");
      const link = await createLink(h, {
        paths: [...paths],
        ...(versionId === null ? {} : { versionId }),
        access: "view",
      });
      const openedCurrent = await json(
        await h(linkRequest(link.capability, "/sync/link/current")),
      );
      const liveFiles = accumulatorFromCurrentFiles(openedCurrent.files);
      if (!liveFiles) throw new Error("initial current state was malformed");
      expect(filesFromAccumulator(liveFiles)).toEqual([]);
      const openedLog = await json(
        await h(linkRequest(link.capability, "/sync/link/log?since=0&limit=100")),
      );

      const payload = shape === "moment"
        ? moment(0, noncanonicalPath, content, 1_100).payload
        : shape === "boundary"
          ? moment(0, "docs/arrived.md", content, 1_100, {
              operation: "rename",
              beforePath: noncanonicalPath,
              beforeContent: "hidden\n",
            }).payload
          : {
              versionId,
              forkSnapshots: [{ path: noncanonicalPath, blobSha256 }],
            };
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

      const assertReadAgreement = async (readHandler: SyncRelayHandler) => {
        const current = await json(
          await readHandler(linkRequest(link.capability, "/sync/link/current")),
        );
        const fullReplay = await json(
          await readHandler(
            linkRequest(link.capability, "/sync/link/log?since=0&limit=100"),
          ),
        );
        const replayed: FileAccumulator = new Map();
        foldLogOps(replayed, fullReplay.ops as RelayOp[]);
        expect(current.files).toEqual([]);
        expect(filesFromAccumulator(replayed)).toEqual(current.files);
        expect(JSON.stringify({ current, fullReplay })).not.toContain(noncanonicalPath);
        expect(
          await denialBytes(
            await readHandler(
              linkRequest(link.capability, `/sync/link/blobs/${blobSha256}`),
            ),
          ),
        ).toBe(`404:${LINK_REFUSAL_BODY}`);
      };

      const delta = await json(
        await h(
          linkRequest(
            link.capability,
            `/sync/link/log?since=${String(openedLog.nextCursor)}&limit=100`,
          ),
        ),
      );
      foldLogOps(liveFiles, delta.ops as RelayOp[]);
      expect(filesFromAccumulator(liveFiles)).toEqual([]);
      expect(JSON.stringify(delta)).not.toContain(noncanonicalPath);
      await assertReadAgreement(h);

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

  it.each([
    ["metadata", "/sync/link/share", "fetchLogPageDescending"],
    ["current state", "/sync/link/current", "readCurrentFileState"],
  ] as const)(
    "serializes the fresh access after a same-generation narrowing during the %s read",
    async (_description, path, pauseAt) => {
      const storage = await newStorage();
      let narrowOnRead = false;
      let shareId = "";
      let grantId = "";
      const narrow = (): void => {
        if (!narrowOnRead) return;
        narrowOnRead = false;
        expect(
          storage.retuneShareGrant({
            shareId,
            grantId,
            access: "view",
            changedAtMs: 2_001,
            expectedDependentGrantIds: [],
            guard: () => undefined,
          }),
        ).toMatchObject({
          ok: true,
          grant: { access: "view", generation: 1 },
        });
      };
      const storageWithRace = interceptStorage(storage, {
        fetchLogPageDescending: (target, input) => {
          const rows = target.fetchLogPageDescending(input);
          if (pauseAt === "fetchLogPageDescending") narrow();
          return rows;
        },
        readCurrentFileState: (target, input) => {
          const snapshot = target.readCurrentFileState(input);
          if (pauseAt === "readCurrentFileState") narrow();
          return snapshot;
        },
      });
      const h = handler(storageWithRace);
      const seeded = await seed(h, "comment");
      grantId = seeded.grantId;
      shareId = storage.getShareGrant(grantId)!.shareId;
      narrowOnRead = true;

      const response = await h(linkRequest(seeded.capability, path));

      expect(response.status).toBe(200);
      expect(await json(response)).toMatchObject({
        access: "view",
        effectiveSelector: {
          paths: ["docs"],
          versionId: null,
          access: "view",
        },
      });
      expect(narrowOnRead).toBe(false);
    },
  );

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
    const getBlob = vi.spyOn(storage, "getBlob");
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
      expect(getBlob).toHaveBeenCalledTimes(3);
      const small = await h(
        linkRequest(link.capability, `/sync/link/blobs/${smallSha}`),
      );
      opened.push(small);
      const current = await h(
        linkRequest(link.capability, "/sync/link/current"),
      );
      opened.push(current);
      expect(await current.text()).toContain("docs/large.bin");

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
        current: current.status,
        restored: restored.status,
      }).toEqual({
        held: [200, 200, 200],
        overBudget: 429,
        small: 200,
        current: 200,
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

  it("releases pre-stream blob admissions on every load failure", async () => {
    const cases = ["missing", "throwing", "length-mismatch", "rotation"] as const;
    for (const failure of cases) {
      const storage = await newStorage();
      const targetContent = "t".repeat(4 * 1024 * 1024);
      const targetSha = sha256(targetContent);
      const rotatedSecret = "r".repeat(43);
      let failTargetLoad = false;
      let grantId = "";
      const racedStorage = interceptStorage(storage, {
        getBlob: (target, workspaceId, blobSha256) => {
            if (!failTargetLoad || blobSha256 !== targetSha) {
              return target.getBlob(workspaceId, blobSha256);
            }
            failTargetLoad = false;
            if (failure === "missing") return null;
            if (failure === "throwing") throw new Error("injected blob load failure");
            if (failure === "length-mismatch") {
              return new Uint8Array(targetContent.length - 1);
            }
            const blob = target.getBlob(workspaceId, blobSha256);
            const rotation = target.rotateLinkGrant({
              shareId: "share-0",
              grantId,
              rotatedAtMs: 2_001,
              expectedDependentGrantIds: [],
              guard: () => undefined,
              mintCredential: () => ({
                credentialId: `raced-${failure}`,
                secretHash: hashLinkBearer(rotatedSecret, LINK_KEY),
              }),
            });
            expect(rotation.ok).toBe(true);
            return blob;
        },
      });
      const h = handler(racedStorage, {
        linkGrantEgressRateLimiter: new LinkEgressRateLimiter(
          3 * MAX_BLOB_BYTES + targetContent.length,
          0.000_001,
          10,
        ),
      });
      const seeded = await seed(h);
      grantId = seeded.grantId;
      const largeContent = "l".repeat(MAX_BLOB_BYTES);
      const largeSha = await putBlob(h, largeContent);
      await putBlob(h, targetContent);
      const probeContent = "p";
      const probeSha = await putBlob(h, probeContent);
      await appendMoments(h, [
        moment(3, "docs/held.bin", largeContent, 1_300),
        moment(4, "docs/failure.bin", targetContent, 1_400),
        moment(5, "docs/probe.bin", probeContent, 1_500),
      ]);
      const held = await Promise.all(
        Array.from({ length: 3 }, () =>
          h(linkRequest(seeded.capability, `/sync/link/blobs/${largeSha}`)),
        ),
      );
      expect(held.map((response) => response.status)).toEqual([200, 200, 200]);

      let consoleError: ReturnType<typeof vi.spyOn> | undefined;
      if (failure === "throwing") {
        consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      }
      failTargetLoad = true;
      const failed = await h(
        linkRequest(seeded.capability, `/sync/link/blobs/${targetSha}`),
      );
      consoleError?.mockRestore();

      let capability = seeded.capability;
      if (failure === "rotation") {
        expect(await capabilityRefusalBody(failed)).toBe(LINK_REFUSAL_BODY);
        const exchange = await json(
          await h(
            request(null, "/sync/link-exchange", jsonBody({ secret: rotatedSecret })),
          ),
        );
        expect(exchange.grantId).toBe(seeded.grantId);
        capability = String(exchange.capabilityToken);
      } else if (failure === "throwing") {
        expect(failed.status).toBe(503);
        expect(await json(failed)).toEqual(linkRefusalBody("link_unavailable"));
      } else {
        expect(failed.status).toBe(404);
        expect(await failed.text()).toBe(LINK_REFUSAL_BODY);
      }

      const probe = await h(
        linkRequest(capability, `/sync/link/blobs/${probeSha}`),
      );
      expect(probe.status, failure).toBe(200);
      expect(await probe.text()).toBe(probeContent);
      await Promise.all(held.map(async (response) => await response.body?.cancel()));
    }
  });

  it.each([-1, MAX_BLOB_BYTES + 1, Number.MAX_SAFE_INTEGER + 1])(
    "refuses corrupt current blob byte length %s without loading content",
    async (byteLength) => {
      const storage = await newStorage();
      const h = handler(storage);
      const seeded = await seed(h);
      const inspection = inspectDatabase(storagePath(storage));
      try {
        inspection.prepare(
          `UPDATE sync_relay_blobs SET byte_length = ?
           WHERE workspace_id = ? AND sha256 = ?`,
        ).run(byteLength, WORKSPACE, seeded.sharedSha);
      } finally {
        inspection.close();
      }
      const getBlob = vi.spyOn(storage, "getBlob");

      const response = await h(
        linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`),
      );

      expect(response.status).toBe(404);
      expect(await response.text()).toBe(LINK_REFUSAL_BODY);
      expect(getBlob).not.toHaveBeenCalled();
    },
  );

  it.each(["cancel", "rotate"] as const)(
    "charges only emitted blob bytes after stream %s",
    async (interruption) => {
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
      if (interruption === "cancel") {
        await reader.cancel();
        await reader.cancel();
      } else {
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
      }

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

  it.each(["cancel", "complete", "rotate"] as const)(
    "settles emitted UTF-8 link JSON bytes after stream %s",
    async (interruption) => {
      const chunkBytes = 64 * 1024;
      const storage = await newStorage();
      const setupHandler = handler(storage);
      const seeded = await seed(setupHandler);
      const content = "streamed JSON 界\n";
      await putBlob(setupHandler, content);
      await appendMoments(
        setupHandler,
        Array.from({ length: 450 }, (_, index) =>
          moment(
            index + 3,
            `docs/${String(index).padStart(3, "0")}-${"界".repeat(64)}.md`,
            content,
            1_300 + index,
            { objectId: `object-json-stream-${index}` },
          ),
        ),
      );
      const route = interruption === "complete"
        ? "/sync/link/log?since=0&limit=500"
        : "/sync/link/current";

      const measuringHandler = handler(storage, {
        linkGrantEgressRateLimiter: new LinkEgressRateLimiter(
          LINK_GRANT_EGRESS_BUCKET_CAPACITY_BYTES,
          0.000_001,
          10,
        ),
      });
      const measured = await measuringHandler(
        linkRequest(seeded.capability, route),
      );
      expect(measured.status).toBe(200);
      const expectedBody = await measured.text();
      const exactBodyBytes = Buffer.byteLength(expectedBody);
      expect(exactBodyBytes).toBeGreaterThan(2 * chunkBytes);
      expect(expectedBody).toContain("界");

      const egress = new LinkEgressRateLimiter(
        exactBodyBytes,
        0.000_001,
        10,
      );
      const originalReserve = egress.reserve.bind(egress);
      const settlements: Array<[number, number]> = [];
      const reserve = vi.spyOn(egress, "reserve").mockImplementation(
        (grantId, byteLength, reservedAtMs) => {
          const settle = originalReserve(grantId, byteLength, reservedAtMs);
          if (!settle) return null;
          return (emittedByteLength, settledAtMs) => {
            settlements.push([emittedByteLength, settledAtMs]);
            settle(emittedByteLength, settledAtMs);
          };
        },
      );
      const h = handler(storage, { linkGrantEgressRateLimiter: egress });
      const response = await h(linkRequest(seeded.capability, route));
      expect(response.status).toBe(200);
      expect(reserve).toHaveBeenNthCalledWith(
        1,
        seeded.grantId,
        exactBodyBytes,
        2_000,
      );
      expect(egress.reserve(seeded.grantId, 1, 2_000)).toBeNull();

      if (interruption === "complete") {
        expect(await response.text()).toBe(expectedBody);
        expect(settlements).toEqual([[exactBodyBytes, 2_000]]);
        expect(egress.reserve(seeded.grantId, 1, 2_000)).toBeNull();
        return;
      }

      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      if (first.done) return;
      expect(first.value.byteLength).toBe(chunkBytes);

      if (interruption === "cancel") {
        await reader.cancel();
        await reader.cancel();
      } else {
        const rotation = await h(
          request(
            OWNER,
            `/sync/shares/share-0/links/${seeded.grantId}/rotate`,
            jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
          ),
        );
        expect(rotation.status).toBe(200);
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
      }

      expect(settlements).toEqual([[chunkBytes, 2_000]]);
      const refunded = egress.reserve(
        seeded.grantId,
        exactBodyBytes - chunkBytes,
        2_000,
      );
      expect(refunded).not.toBeNull();
      refunded?.(exactBodyBytes - chunkBytes, 2_000);
      expect(egress.reserve(seeded.grantId, 1, 2_000)).toBeNull();
    },
  );

  it("terminates same-grant JSON and blob streams together", async () => {
    const chunkBytes = 64 * 1024;
    const storage = await newStorage();
    const setupHandler = handler(storage);
    const seeded = await seed(setupHandler);
    const jsonContent = "mixed stream 界\n";
    await putBlob(setupHandler, jsonContent);
    const largeContent = "m".repeat(MAX_BLOB_BYTES);
    const largeSha = await putBlob(setupHandler, largeContent);
    await appendMoments(setupHandler, [
      moment(3, "docs/mixed-large.bin", largeContent, 1_300),
      ...Array.from({ length: 450 }, (_, index) =>
        moment(
          index + 4,
          `docs/${String(index).padStart(3, "0")}-${"界".repeat(64)}.md`,
          jsonContent,
          1_400 + index,
          { objectId: `object-mixed-stream-${index}` },
        ),
      ),
    ]);

    const egress = new LinkEgressRateLimiter(
      LINK_GRANT_EGRESS_BUCKET_CAPACITY_BYTES,
      0.000_001,
      10,
    );
    const originalReserve = egress.reserve.bind(egress);
    const settlements: Array<{
      reservedByteLength: number;
      emittedByteLength: number;
    }> = [];
    const reserve = vi.spyOn(egress, "reserve").mockImplementation(
      (grantId, byteLength, reservedAtMs) => {
        const settle = originalReserve(grantId, byteLength, reservedAtMs);
        if (!settle) return null;
        return (emittedByteLength, settledAtMs) => {
          settlements.push({ reservedByteLength: byteLength, emittedByteLength });
          settle(emittedByteLength, settledAtMs);
        };
      },
    );
    const h = handler(storage, { linkGrantEgressRateLimiter: egress });
    const current = await h(
      linkRequest(seeded.capability, "/sync/link/current"),
    );
    const blob = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${largeSha}`),
    );
    expect([current.status, blob.status]).toEqual([200, 200]);
    expect(reserve.mock.calls).toHaveLength(2);
    const currentReservedByteLength = reserve.mock.calls[0]![1];
    expect(currentReservedByteLength).toBeGreaterThan(2 * chunkBytes);
    expect(reserve.mock.calls[1]![1]).toBe(MAX_BLOB_BYTES);
    const currentReader = current.body!.getReader();
    const blobReader = blob.body!.getReader();
    const [currentFirst, blobFirst] = await Promise.all([
      currentReader.read(),
      blobReader.read(),
    ]);
    expect(currentFirst.done).toBe(false);
    expect(blobFirst.done).toBe(false);
    if (currentFirst.done || blobFirst.done) return;
    expect(currentFirst.value.byteLength).toBe(chunkBytes);
    expect(blobFirst.value.byteLength).toBe(chunkBytes);

    const rotation = await json(
      await h(
        request(
          OWNER,
          `/sync/shares/share-0/links/${seeded.grantId}/rotate`,
          jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
        ),
      ),
    );
    const outcomes = await Promise.all(
      [currentReader, blobReader].map(async (reader) =>
        await reader.read().then(
          () => ({ kind: "delivered" as const }),
          (error: unknown) => ({
            kind: "terminated" as const,
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
      ),
    );
    expect(outcomes).toEqual([
      { kind: "terminated", message: "link grant changed during stream" },
      { kind: "terminated", message: "link grant changed during stream" },
    ]);
    expect(settlements).toEqual(expect.arrayContaining([
      {
        reservedByteLength: currentReservedByteLength,
        emittedByteLength: chunkBytes,
      },
      {
        reservedByteLength: MAX_BLOB_BYTES,
        emittedByteLength: chunkBytes,
      },
    ]));
    expect(settlements).toHaveLength(2);

    const unavailable = egress.reserve(
      seeded.grantId,
      LINK_GRANT_EGRESS_BUCKET_CAPACITY_BYTES - 2 * chunkBytes + 1,
      2_000,
    );
    expect(unavailable).toBeNull();
    const exactAvailable = egress.reserve(
      seeded.grantId,
      LINK_GRANT_EGRESS_BUCKET_CAPACITY_BYTES - 2 * chunkBytes,
      2_000,
    );
    expect(exactAvailable).not.toBeNull();
    exactAvailable?.(0, 2_000);

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
    const held = await Promise.all(
      Array.from({ length: 3 }, () =>
        h(linkRequest(rotatedCapability, `/sync/link/blobs/${largeSha}`)),
      ),
    );
    try {
      expect(held.map((response) => response.status)).toEqual([200, 200, 200]);
    } finally {
      await Promise.all(held.map(async (response) => await response.body?.cancel()));
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
      "widening",
      async (
        h: SyncRelayHandler,
        shareId: string,
        grantId: string,
        _storage: SyncRelayStorage,
      ) =>
        await h(
          request(
            OWNER,
            `/sync/shares/${shareId}/links/${grantId}/retune`,
            jsonBody({
              workspaceId: WORKSPACE,
              access: "comment",
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

  it("preserves an open Comment link blob stream through View narrowing", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const content = `${"a".repeat(64 * 1024)}${"b".repeat(64 * 1024)}${"c".repeat(64 * 1024)}`;
    expect(
      (await h(request(OWNER, "/sync/workspaces", jsonBody({ workspaceId: WORKSPACE })))).status,
    ).toBe(200);
    const blobSha = await putBlob(h, content);
    await appendMoments(h, [moment(0, "docs/large.bin", content, 1_100)]);
    const target = await createLink(h, { paths: ["docs"], access: "comment" });
    const untouched = await createLink(h, { paths: ["docs"], access: "view" });

    const targetResponse = await h(
      linkRequest(target.capability, `/sync/link/blobs/${blobSha}`),
    );
    const untouchedResponse = await h(
      linkRequest(untouched.capability, `/sync/link/blobs/${blobSha}`),
    );
    expect(targetResponse.status).toBe(200);
    expect(untouchedResponse.status).toBe(200);
    const targetReader = targetResponse.body!.getReader();
    const untouchedReader = untouchedResponse.body!.getReader();
    const targetFirst = await targetReader.read();
    const untouchedFirst = await untouchedReader.read();
    expect(targetFirst.done).toBe(false);
    expect(untouchedFirst.done).toBe(false);
    if (targetFirst.done || untouchedFirst.done) return;
    expect(targetFirst.value.byteLength).toBe(64 * 1024);
    expect(untouchedFirst.value.byteLength).toBe(64 * 1024);

    const capabilityHash = hashLinkBearer(target.capability, LINK_KEY);
    const grantBefore = storage.getShareGrant(target.grantId)!;
    const credentialBefore = storage.getCurrentLinkCredential(target.grantId);
    const sessionBefore = storage.findLinkSessionByCapabilityHash(capabilityHash);
    const narrowed = await h(
      request(
        OWNER,
        `/sync/shares/${target.shareId}/links/${target.grantId}/retune`,
        jsonBody({
          workspaceId: WORKSPACE,
          access: "view",
          expectedDependentGrantIds: [],
        }),
      ),
    );
    expect(narrowed.status).toBe(200);
    expect(storage.getShareGrant(target.grantId)).toMatchObject({
      access: "view",
      generation: grantBefore.generation,
    });
    expect(storage.getCurrentLinkCredential(target.grantId)).toEqual(credentialBefore);
    expect(storage.findLinkSessionByCapabilityHash(capabilityHash)).toEqual(sessionBefore);

    const targetOutcome = await readRemainingBytes(targetReader, targetFirst.value).then(
      (bytes) => ({
        kind: "delivered" as const,
        byteLength: bytes.byteLength,
        sha256: sha256(new TextDecoder().decode(bytes)),
      }),
      (error: unknown) => ({
        kind: "terminated" as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    const untouchedBytes = await readRemainingBytes(
      untouchedReader,
      untouchedFirst.value,
    );
    expect(new TextDecoder().decode(untouchedBytes)).toBe(content);
    expect(targetOutcome).toEqual({
      kind: "delivered",
      byteLength: Buffer.byteLength(content),
      sha256: sha256(content),
    });

    const freshRead = await h(
      linkRequest(target.capability, `/sync/link/blobs/${blobSha}`),
    );
    expect(freshRead.status).toBe(200);
    expect(new TextDecoder().decode(await freshRead.arrayBuffer())).toBe(content);
  });

  it.each(["rotate", "retune"] as const)(
    "refuses %s when owner standing changes before commit without writes or terminated reads",
    async (operation) => {
      const storage = await newStorage();
      let ownershipAnswers: boolean[] | null = null;
      const ownershipStorage = interceptStorage(storage, {
        workspaceIsOwnedBy: (target, workspaceId, ownerUserId) =>
          ownershipAnswers === null
            ? target.workspaceIsOwnedBy(workspaceId, ownerUserId)
            : (ownershipAnswers.shift() ?? false),
      });
      let bearerByte = 1;
      const newLinkBearer = vi.fn(() =>
        Buffer.alloc(32, bearerByte++).toString("base64url"),
      );
      let grantSeq = 0;
      let idSeq = 0;
      const h = handler(ownershipStorage, {
        newShareId: () => "share-owner-race",
        newGrantId: () => `grant-owner-race-${grantSeq++}`,
        newId: () => `id-owner-race-${idSeq++}`,
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
            : {
                workspaceId: WORKSPACE,
                access: "view",
                expectedDependentGrantIds: [],
              };
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
  ])("answers an invalid capability on the %s route with the generic 404 refusal", async (_name, path) => {
    const storage = await newStorage();
    const response = await handler(storage)(linkRequest(UNKNOWN_CAPABILITY, path));

    expect({ status: response.status, body: await response.text() }).toEqual({
      status: 404,
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
      await h(request(RECIPIENT, "/sync/shares/share-0/log?since=0&limit=100&originId=recipient-replica")),
    );
    const linkLog = await json(
      await h(linkRequest(capability, "/sync/link/log?since=0&limit=100")),
    );
    const linkOps = (recipientLog.ops as Array<Record<string, unknown>>).map(
      ({ originId: _originId, ...op }) => op,
    );
    const { ownOriginId, ...recipientPage } = recipientLog;
    expect(ownOriginId).toMatch(/^relay:share-member:[a-f0-9]{64}$/);
    expect(linkLog).toEqual({ ...recipientPage, ops: linkOps, epochLogFloor: 0 });
    expect(linkLog).not.toHaveProperty("ownOriginId");
    expect(linkOps.every((op) => !Object.hasOwn(op, "originId"))).toBe(true);
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
  });

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

  it("serves an earlier revision of a file still in the share", async () => {
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

    for (const [sha, content] of [
      [seeded.sharedSha, "# shared\n"],
      [replacementSha, replacement],
      [untouchedSha, untouched],
    ] as const) {
      const response = await h(linkRequest(seeded.capability, `/sync/link/blobs/${sha}`));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(content);
    }
    expect(
      await denialBytes(
        await h(linkRequest(seeded.capability, `/sync/link/blobs/${seeded.hiddenSha}`)),
      ),
    ).toBe(`404:${LINK_REFUSAL_BODY}`);
  });

  it("withdraws every revision of a file when it is deleted", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const replacement = "# replacement\n";
    const replacementSha = await putBlob(h, replacement);
    await appendMoments(h, [
      moment(3, "docs/shared.md", replacement, 1_300, {
        objectId: "object-shared",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
    ]);
    expect(
      (await h(linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`))).status,
    ).toBe(200);

    await appendMoments(h, [
      moment(4, "docs/shared.md", replacement, 1_400, {
        objectId: "object-shared",
        operation: "delete",
        beforePath: "docs/shared.md",
        beforeContent: replacement,
      }),
    ]);
    for (const sha of [seeded.sharedSha, replacementSha]) {
      expect(
        await denialBytes(await h(linkRequest(seeded.capability, `/sync/link/blobs/${sha}`))),
      ).toBe(`404:${LINK_REFUSAL_BODY}`);
    }
  });

  it("follows a rename inside the share and withdraws history on a move out", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const replacement = "# replacement\n";
    const replacementSha = await putBlob(h, replacement);
    await appendMoments(h, [
      moment(3, "docs/shared.md", replacement, 1_300, {
        objectId: "object-shared",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
      moment(4, "docs/renamed.md", replacement, 1_400, {
        objectId: "object-shared",
        operation: "rename",
        beforePath: "docs/shared.md",
        beforeContent: replacement,
      }),
    ]);
    const earlier = await h(linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`));
    expect(earlier.status).toBe(200);
    expect(await earlier.text()).toBe("# shared\n");

    await appendMoments(h, [
      moment(5, "private/renamed.md", replacement, 1_500, {
        objectId: "object-shared",
        operation: "rename",
        beforePath: "docs/renamed.md",
        beforeContent: replacement,
      }),
    ]);
    for (const sha of [seeded.sharedSha, replacementSha]) {
      expect(
        await denialBytes(await h(linkRequest(seeded.capability, `/sync/link/blobs/${sha}`))),
      ).toBe(`404:${LINK_REFUSAL_BODY}`);
    }
  });

  it("withdraws history when a file passes through a path the share never admits", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const replacement = "# replacement\n";
    const latest = "# latest\n";
    await putBlob(h, replacement);
    const latestSha = await putBlob(h, latest);
    await appendMoments(h, [
      moment(3, "docs/shared.md", replacement, 1_300, {
        objectId: "object-shared",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
      moment(4, "docs/.env", replacement, 1_400, {
        objectId: "object-shared",
        operation: "rename",
        beforePath: "docs/shared.md",
        beforeContent: replacement,
      }),
      moment(5, "docs/shared.md", replacement, 1_500, {
        objectId: "object-shared",
        operation: "rename",
        beforePath: "docs/.env",
        beforeContent: replacement,
      }),
      moment(6, "docs/shared.md", latest, 1_600, {
        objectId: "object-shared",
        beforePath: "docs/shared.md",
        beforeContent: replacement,
      }),
    ]);

    const current = await h(linkRequest(seeded.capability, `/sync/link/blobs/${latestSha}`));
    expect(current.status).toBe(200);
    expect(await current.text()).toBe(latest);
    expect(
      await denialBytes(
        await h(linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`)),
      ),
    ).toBe(`404:${LINK_REFUSAL_BODY}`);
  });

  it("withdraws history on a move out and does not restore it on a move back in", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
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

  it("finds a revision past more deleted copies than the candidate cap", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const replacement = "# replacement\n";
    await putBlob(h, replacement);
    const copies = Array.from({ length: SHARED_BLOB_CANDIDATE_LIMIT }, (_, index) => [
      moment(4 + index * 2, `docs/copy-${index}.md`, "# shared\n", 2_000 + index, {
        objectId: `object-copy-${index}`,
      }),
      moment(5 + index * 2, `docs/copy-${index}.md`, "# shared\n", 3_000 + index, {
        objectId: `object-copy-${index}`,
        operation: "delete",
        beforePath: `docs/copy-${index}.md`,
        beforeContent: "# shared\n",
      }),
    ]).flat();
    await appendMoments(h, [
      moment(3, "docs/shared.md", replacement, 1_300, {
        objectId: "object-shared",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
      ...copies,
    ]);

    const earlier = await h(linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`));
    expect(earlier.status).toBe(200);
    expect(await earlier.text()).toBe("# shared\n");
  });

  it("refuses a revision it would find only past the scan bound", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const replacement = "# replacement\n";
    await putBlob(h, replacement);
    // Deleted copies whose object ids sort before object-shared fill the
    // bounded index scan, so the read refuses instead of scanning further.
    appendStoredMoments(storage, [
      moment(3, "docs/shared.md", replacement, 1_300, {
        objectId: "object-shared",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
      ...Array.from({ length: LINK_REVISION_SCAN_LIMIT }, (_, index) => [
        moment(4 + index * 2, `docs/scan-${index}.md`, "# shared\n", 2_000 + index, {
          objectId: `object-a-${String(index).padStart(5, "0")}`,
        }),
        moment(5 + index * 2, `docs/scan-${index}.md`, "# shared\n", 2_000 + index, {
          objectId: `object-a-${String(index).padStart(5, "0")}`,
          operation: "delete",
          beforePath: `docs/scan-${index}.md`,
          beforeContent: "# shared\n",
        }),
      ]).flat(),
    ]);

    expect(
      await denialBytes(
        await h(linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`)),
      ),
    ).toBe(`404:${LINK_REFUSAL_BODY}`);
  });

  it("never serves content a file had before it moved into the share", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const outside = "# drafted outside\n";
    const inside = "# edited inside\n";
    const outsideSha = await putBlob(h, outside);
    const insideSha = await putBlob(h, inside);
    await appendMoments(h, [
      moment(3, "private/draft.md", outside, 1_300, { objectId: "object-draft" }),
      moment(4, "docs/draft.md", outside, 1_400, {
        objectId: "object-draft",
        operation: "rename",
        beforePath: "private/draft.md",
        beforeContent: outside,
      }),
      moment(5, "docs/draft.md", inside, 1_500, {
        objectId: "object-draft",
        beforePath: "docs/draft.md",
        beforeContent: outside,
      }),
    ]);
    expect(
      (await h(linkRequest(seeded.capability, `/sync/link/blobs/${insideSha}`))).status,
    ).toBe(200);
    expect(
      await denialBytes(await h(linkRequest(seeded.capability, `/sync/link/blobs/${outsideSha}`))),
    ).toBe(`404:${LINK_REFUSAL_BODY}`);
  });

  it("serves a pinned version's fork snapshot after the file is edited on that version", async () => {
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

    for (const [sha, content] of [[snapshotSha, snapshot], [editedSha, edited]] as const) {
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

  it("serves no revision recorded at or below the workspace epoch floor", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seedThenRotate(h);
    const content = "# after rotation\n";
    const sha = await putBlob(h, content);
    await appendMoments(
      h,
      [moment(0, "docs/shared.md", content, 1_300, { objectId: "object-shared" })],
      { originId: "origin-b", identity: { replicationEpoch: EPOCH_2, streamIdentity: STREAM_2 } },
    );
    expect((await h(linkRequest(seeded.capability, `/sync/link/blobs/${sha}`))).status).toBe(200);
    expect(
      await denialBytes(
        await h(linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`)),
      ),
    ).toBe(`404:${LINK_REFUSAL_BODY}`);
  });

  it("refuses an earlier revision once the link is revoked", async () => {
    const storage = await newStorage();
    const h = handler(storage);
    const seeded = await seed(h);
    const replacementSha = await putBlob(h, "# replacement\n");
    await appendMoments(h, [
      moment(3, "docs/shared.md", "# replacement\n", 1_300, {
        objectId: "object-shared",
        beforePath: "docs/shared.md",
        beforeContent: "# shared\n",
      }),
    ]);
    expect(
      (await h(linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`))).status,
    ).toBe(200);
    expect(
      (
        await h(
          request(
            OWNER,
            "/sync/shares/share-0/revoke",
            jsonBody({ grantId: seeded.grantId, workspaceId: WORKSPACE, expectedDependentGrantIds: [] }),
          ),
        )
      ).status,
    ).toBe(200);
    for (const sha of [seeded.sharedSha, replacementSha]) {
      await capabilityRefusalBody(
        await h(linkRequest(seeded.capability, `/sync/link/blobs/${sha}`)),
      );
    }
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

    // No current file holds it now, but it is an earlier revision of files
    // still in the share, so the link serves it as the named recipient does.
    const linkRevision = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`),
    );
    expect(linkRevision.status).toBe(200);
    expect(await linkRevision.text()).toBe("# shared\n");

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
      const revokeAfter =
        <M extends "fetchLogPage" | "getBlob">(method: M) =>
        (storage: SyncRelayStorage, ...args: Parameters<SyncRelayStorage[M]>) => {
          const real = storage[method] as (
            this: SyncRelayStorage,
            ...input: Parameters<SyncRelayStorage[M]>
          ) => ReturnType<SyncRelayStorage[M]>;
          const result = real.call(storage, ...args);
          if (armed) {
            armed = false;
            storage.revokeShareGrant({ shareId: "share-0", grantId, revokedAtMs: 2_001 });
          }
          return result;
        };
      const raced = interceptStorage(target, {
        fetchLogPage: racedMethod === "fetchLogPage" ? revokeAfter("fetchLogPage") : undefined,
        getBlob: racedMethod === "getBlob" ? revokeAfter("getBlob") : undefined,
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

  it("reports unknown freshness when the first shared row is beyond the freshness page budget", async () => {
    const pageSize = 2;
    const storage = await newStorage();
    const h = handler(storage, {
      linkFreshnessPageSize: pageSize,
    });
    const seeded = await seed(h);
    const rowsPerBudget =
      LINK_FRESHNESS_PAGE_BUDGET * pageSize;
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
      linkFreshnessPageSize: pageSize,
    });
    const seeded = await seed(h);
    const rowsPerBudget =
      LINK_FRESHNESS_PAGE_BUDGET * pageSize;
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
      linkFreshnessPageSize: 2,
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
    const limiter = new TokenBucketLimiter(1, 0.000_001, 10);
    const h = handler(storage, { linkReadRateLimiter: limiter });
    const seeded = await seed(h);
    expect((await h(linkRequest(UNKNOWN_CAPABILITY, "/sync/link/share"))).status).toBe(404);
    expect((await h(linkRequest(seeded.capability, "/sync/link/share"))).status).toBe(200);
    const limited = await h(linkRequest(seeded.capability, "/sync/link/share"));
    expect(limited.status).toBe(429);
    expect(await json(limited)).toMatchObject({ code: "link_read_rate_limited" });
  });

  it("shares a grant read budget across capabilities minted by re-exchange", async () => {
    const storage = await newStorage();
    const h = handler(storage, {
      linkReadRateLimiter: new TokenBucketLimiter(1, 0.000_001, 10),
      linkGrantReadRateLimiter: new TokenBucketLimiter(1, 0.000_001, 10),
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
      error: "This link has reached its request limit. Try again later.",
      code: "link_read_rate_limited",
    });
  });

  it("keeps grant read budgets independent for different grants", async () => {
    const storage = await newStorage();
    const h = handler(storage, {
      linkReadRateLimiter: new TokenBucketLimiter(1, 0.000_001, 10),
      linkGrantReadRateLimiter: new TokenBucketLimiter(1, 0.000_001, 10),
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
      linkReadRateLimiter: new TokenBucketLimiter(1, 0.000_001, 10),
      linkGrantReadRateLimiter: new TokenBucketLimiter(1, 0.000_001, 10),
      linkLogReadRateLimiter: new TokenBucketLimiter(1, 0.000_001, 10),
      linkGrantLogReadRateLimiter: new TokenBucketLimiter(1, 0.000_001, 10),
    });
    const seeded = await seed(h);

    expect((await h(linkRequest(seeded.capability, "/sync/link/share"))).status).toBe(200);
    const limitedBlob = await h(
      linkRequest(seeded.capability, `/sync/link/blobs/${seeded.sharedSha}`),
    );
    expect(limitedBlob.status).toBe(429);
    expect(await json(limitedBlob)).toEqual({
      ok: false,
      error: "This link has reached its request limit. Try again later.",
      code: "link_read_rate_limited",
    });

    expect((await h(linkRequest(seeded.capability, "/sync/link/log"))).status).toBe(200);
    const limitedLog = await h(linkRequest(seeded.capability, "/sync/link/log"));
    expect(limitedLog.status).toBe(429);
    expect(await json(limitedLog)).toEqual({
      ok: false,
      error: "This link has reached its request limit. Try again later.",
      code: "link_read_rate_limited",
    });
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

  it("reserves exact metadata and log response bytes on the same grant", async () => {
    const storage = await newStorage();
    const budget = new LinkEgressRateLimiter(10_000, 1, 10);
    const reserve = vi.spyOn(budget, "reserve");
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

    expect(reserve.mock.calls).toEqual([
      [seeded.grantId, Buffer.byteLength(metadataBody), 2_000],
      [seeded.grantId, Buffer.byteLength(currentBody), 2_000],
      [seeded.grantId, Buffer.byteLength(logBody), 2_000],
    ]);
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
    const h = handler(storage, {
      linkExchangeGlobalRateLimiter: exchangeLimiter,
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
