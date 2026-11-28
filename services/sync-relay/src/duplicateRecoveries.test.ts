import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimWorkspace,
  closeTestStorages,
  inspect,
  jsonBody,
  request,
  storagePath,
  testHandler,
  testStorage,
} from "./testing";

afterEach(closeTestStorages);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const FIRST = "# Late\n\nTyped before.\n";
const SECOND = "# Late\n\nTyped before.\n\nTyped after.\n";
const OBJECT = `ydoc-recovery-object-${"a".repeat(64)}`;
const RECOVERED = "Late (recovered).md";

type Moment = { momentId: string; path: string; text: string; before?: string; delete?: boolean };

function op(originSeq: number, moment: Moment) {
  const before = moment.before;
  return {
    originSeq,
    opKind: "moment.append",
    recordedAtMs: 10 + originSeq,
    payload: {
      momentId: moment.momentId,
      versionId: "main",
      objectId: OBJECT,
      objectCreatedAtMs: 10,
      path: moment.path,
      recordedAtMs: 10 + originSeq,
      operation: moment.delete ? "delete" : "write",
      payloadBeforeBlobSha256: before === undefined ? null : sha256(before),
      payloadBeforePath: before === undefined ? null : RECOVERED,
      payloadAfterBlobSha256: moment.delete ? null : sha256(moment.text),
      payloadAfterPath: moment.delete ? null : moment.path,
      payloadBeforeContentKind: before === undefined ? null : "text",
      payloadBeforeByteLength: before === undefined ? null : Buffer.byteLength(before),
      payloadAfterContentKind: moment.delete ? null : "text",
      payloadAfterByteLength: moment.delete ? null : Buffer.byteLength(moment.text),
      metadata: {
        origin: "sync",
        summary: "Recovered from Late.md after this file was created on two machines.",
        correlationId: `ydoc-inactive-recovery:${"b".repeat(64)}`,
      },
      authors: null,
      beforePresent: before === undefined ? "null" : "present",
      beforeBlobSha256: before === undefined ? null : sha256(before),
    },
  };
}

const creation: Moment = {
  momentId: `ydoc-recovery-moment-${"a".repeat(64)}`,
  path: RECOVERED,
  text: FIRST,
};
const continuation: Moment = {
  momentId: `ydoc-inactive-recovery-${"c".repeat(64)}`,
  path: RECOVERED,
  text: SECOND,
  before: FIRST,
};

async function relay() {
  const storage = await testStorage(),
    handler = testHandler(storage);
  await claimWorkspace(handler, "owner", "workspace");
  for (const text of [FIRST, SECOND]) {
    storage.putBlob({
      workspaceId: "workspace",
      sha256: sha256(text),
      content: Buffer.from(text),
      createdAtMs: 1,
    });
  }
  const push = async (originId: string, ops: ReturnType<typeof op>[]) => {
    const response = await handler(
      request("owner", "/sync/workspace/log", jsonBody({ originId, ops })),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  };
  const projected = () =>
    inspect(storagePath(storage), (db) => ({
      paths: db
        .prepare(
          "SELECT path FROM sync_relay_object_paths WHERE workspace_id='workspace' AND object_id=?",
        )
        .all(OBJECT),
      moments: db
        .prepare(
          "SELECT m.moment_id FROM sync_relay_object_moments m WHERE m.workspace_id='workspace' AND m.object_id=? ORDER BY m.relay_seq",
        )
        .all(OBJECT),
      origins: db
        .prepare(
          "SELECT origin_id FROM sync_relay_log WHERE workspace_id='workspace' ORDER BY relay_seq",
        )
        .all(),
    }));
  return { push, projected };
}

describe("a recovery that a second replica publishes late", () => {
  it("keeps the renamed path and logs the duplicate's coordinate", async () => {
    const f = await relay();
    await f.push("owner-device", [
      op(0, creation),
      op(1, continuation),
      op(2, { momentId: "rename", path: "Renamed.md", text: SECOND, before: SECOND }),
    ]);

    const late = await f.push("server-copy", [op(0, creation), op(1, continuation)]);
    expect(late).toMatchObject({ inserted: 2 });
    expect(late).not.toHaveProperty("refusals");
    expect(late).not.toHaveProperty("redundantRecoveries");

    const projected = f.projected();
    expect(projected.paths).toEqual([{ path: "Renamed.md" }]);
    expect(projected.moments).toEqual([
      { moment_id: creation.momentId },
      { moment_id: continuation.momentId },
      { moment_id: "rename" },
    ]);
    expect(projected.origins).toEqual([
      { origin_id: "owner-device" },
      { origin_id: "owner-device" },
      { origin_id: "owner-device" },
      { origin_id: "server-copy" },
      { origin_id: "server-copy" },
    ]);
  });

  it("never brings back a file the person deleted", async () => {
    const f = await relay();
    await f.push("owner-device", [
      op(0, creation),
      op(1, { momentId: "delete", path: RECOVERED, text: FIRST, before: FIRST, delete: true }),
    ]);
    await f.push("server-copy", [op(0, creation)]);
    expect(f.projected().paths).toEqual([{ path: null }]);
  });

  it("projects a recovery with other bytes under the same id", async () => {
    const f = await relay();
    await f.push("owner-device", [
      op(0, creation),
      op(1, { momentId: "rename", path: "Renamed.md", text: FIRST, before: FIRST }),
    ]);
    await f.push("server-copy", [op(0, { ...creation, text: SECOND })]);
    expect(f.projected().paths).toEqual([{ path: RECOVERED }]);
  });
});
