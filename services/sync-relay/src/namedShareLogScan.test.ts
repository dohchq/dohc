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

it("serves a one-note share from a long workspace history in one page", async () => {
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
  for (let batch = 0; batch < 6; batch += 1) {
    await appendLog(
      h,
      "owner",
      "w",
      Array.from({ length: 200 }, (_, index) => ({
        originSeq: index,
        ...chatThreadCreate(`thread-${batch}-${index}`, OTHER_WIRE),
        recordedAtMs: 1000 + index,
      })),
      { originId: `origin-unrelated-${batch}` },
    );
  }
  await appendLog(
    h,
    "owner",
    "w",
    [
      {
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
      },
    ],
    { originId: "origin-note" },
  );
  const shareId = await createShare(h, "owner", "w", {
    recipientUserId: "member",
    paths: ["docs/shared.md"],
  });

  const response = await h(request("member", `/sync/shares/${shareId}/log?since=0`));

  expect(response.status).toBe(200);
  const page = (await json(response)) as { ops: { opKind: string }[]; hasMore: boolean };
  expect(page.ops.map((op) => op.opKind)).toContain("moment.append");
  expect(page.hasMore).toBe(false);
});
