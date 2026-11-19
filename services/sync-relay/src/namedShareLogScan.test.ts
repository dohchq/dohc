import { afterEach, expect, it } from "vitest";
import {
  appendLog,
  chatChannelCreate,
  chatThreadCreate,
  claimWorkspace,
  closeTestStorages,
  createShare,
  json,
  putBlob,
  request,
  testHandler,
  testStorage,
} from "./testing";

afterEach(closeTestStorages);

const OTHER_WIRE = "channel_wire_other";

function noteOp(sha: string) {
  return {
    originSeq: 0,
    opKind: "moment.append",
    payload: {
      momentId: "m1",
      versionId: "main",
      objectId: "o1",
      path: "docs/shared.md",
      recordedAtMs: 3000,
      operation: "write",
      payloadBeforeBlobSha256: null,
      payloadBeforePath: null,
      payloadAfterBlobSha256: sha,
      payloadAfterPath: "docs/shared.md",
      metadata: { origin: "user" },
      beforePresent: "null",
    },
    recordedAtMs: 3000,
  };
}

async function unrelatedRows(
  h: ReturnType<typeof testHandler>,
  batches: number,
  perBatch: number,
): Promise<void> {
  for (let batch = 0; batch < batches; batch += 1) {
    await appendLog(
      h,
      "owner",
      "w",
      Array.from({ length: perBatch }, (_, index) => ({
        originSeq: index,
        ...chatThreadCreate(`thread-${batch}-${index}`, OTHER_WIRE),
        recordedAtMs: 1000 + index,
      })),
      { originId: `origin-unrelated-${batch}` },
    );
  }
}

async function shareOfOneNoteBehind(batches: number, perBatch: number) {
  const storage = await testStorage();
  const h = testHandler(storage, { nowMs: () => 4242 });
  await claimWorkspace(h, "owner", "w");
  const sha = await putBlob(h, "owner", "w", "shared note");
  await appendLog(
    h,
    "owner",
    "w",
    [{ originSeq: 0, ...chatChannelCreate(OTHER_WIRE, { kind: "channel" }), recordedAtMs: 1000 }],
    { originId: "origin-channel" },
  );
  await unrelatedRows(h, batches, perBatch);
  await appendLog(h, "owner", "w", [noteOp(sha)], { originId: "origin-note" });
  const shareId = await createShare(h, "owner", "w", {
    recipientUserId: "member",
    paths: ["docs/shared.md"],
  });
  const page = async (since: number) =>
    (await json(await h(request("member", `/sync/shares/${shareId}/log?since=${since}`)))) as {
      ops: { opKind: string }[];
      hasMore: boolean;
      nextCursor: number;
    };
  return { page };
}

it("serves a one-note share from a long workspace history in one page", async () => {
  const { page } = await shareOfOneNoteBehind(6, 200);

  const first = await page(0);

  expect(first.ops.map((op) => op.opKind)).toEqual(["moment.append"]);
  expect(first.hasMore).toBe(false);
});

it("stops a page at 10,000 rows, and the next page goes on from its cursor", async () => {
  const { page } = await shareOfOneNoteBehind(50, 200);

  const first = await page(0);

  expect(first).toMatchObject({ ops: [], hasMore: true, nextCursor: 10_000 });
  const second = await page(first.nextCursor);
  expect(second.ops.map((op) => op.opKind)).toEqual(["moment.append"]);
  expect(second.hasMore).toBe(false);
}, 60_000);
