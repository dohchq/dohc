import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serveFetchHandler, TokenBucketLimiter } from "@dohc/service-http";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";
import { MAX_COLLECTION_WRITE_BODY_BYTES } from "./collectionWriteRoutes";
import { pathCollisionKey } from "./pathCollisionKey";
import { streamsRequestBody, type SyncRelayHandler } from "./server";
import {
  filterCollectionWriteForShare,
  MAX_COLLECTION_WRITE_BYTES,
  MAX_NEW_COLLECTION_RECORDS,
  type ProposedChange,
  type ShareSelector,
} from "./shareFilter";
import type { SyncRelayStorage } from "./storage";
import {
  claimWorkspace,
  closeTestStorage,
  closeTestStorages,
  createShare,
  inspectDatabase,
  json,
  jsonBody,
  putBlob,
  reopenTestStorage,
  request,
  seedDependentGrant,
  seedLinkGrant,
  sha256,
  storagePath,
  testHandler,
  testStorage,
  type HandlerOverrides,
} from "./testing";

// The direct lane, driven through the real route: the owner writes real
// files to its log, the recipient uploads content through its share and
// writes directly, and the assertions read the owner's own log.

afterEach(closeTestStorages);

const OWNER = "owner";
const RECIPIENT = "recipient";
const WORKSPACE = "workspace-a";
const CLOCK = 7_000;
const PACKING = "trip/packing";

const SCHEMA = "name: Packing\nfields:\n  Title:\n    type: text\n";
const SCHEMA_TWO = "name: Packing\nfields:\n  Title:\n    type: text\n  Count:\n    type: number\n";
const STAMP = "  - id: stamp\n    name: Stamp\n    when: record-added\n    do:\n      - set:\n          Title: Packed\n";
const NUDGE = "  - id: nudge\n    name: Nudge\n    when: record-added\n    do:\n      - wake-agent: Look\n        person: user_ana\n";
const automations = (...items: string[]) => `version: 1\nautomations:\n${items.join("")}`;

interface Relay {
  h: SyncRelayHandler;
  storage: SyncRelayStorage;
  shareId: string;
  grantId: string;
  owner: Owner;
}

async function relay(
  options: { overrides?: HandlerOverrides; paths?: string[]; access?: "view" | "comment" | "edit" } = {},
): Promise<Relay> {
  const storage = await testStorage();
  const h = testHandler(storage, { nowMs: () => CLOCK, ...options.overrides });
  await claimWorkspace(h, OWNER, WORKSPACE);
  const owner = new Owner(h);
  await owner.write("object-schema", `${PACKING}/collection.yaml`, SCHEMA);
  const shareId = await createShare(h, OWNER, WORKSPACE, {
    recipientUserId: RECIPIENT,
    paths: options.paths ?? ["trip"],
    access: options.access ?? "edit",
  });
  const grantId = storage.listActiveShareGrantsForRecipient(shareId, RECIPIENT)[0]!.grantId;
  return { h, storage, shareId, grantId, owner };
}

// The owner's own log and blobs. A write to a path the owner already has
// states the content it replaces, as the owner's engine does.
class Owner {
  private seq = 0;
  readonly moments = new Map<string, string>();
  private readonly contents = new Map<string, { text: string; contentKind: "text" | "binary" }>();

  constructor(private readonly h: SyncRelayHandler) {}

  async write(objectId: string, path: string, text: string, contentKind: "text" | "binary" = "text"): Promise<string> {
    const blobSha256 = await putBlob(this.h, OWNER, WORKSPACE, text);
    const originSeq = this.seq++;
    const momentId = `owner-moment-${originSeq}`;
    const previous = this.contents.get(path);
    const before = previous === undefined
      ? { payloadBeforeBlobSha256: null, payloadBeforePath: null, beforePresent: "null" }
      : {
          payloadBeforeBlobSha256: sha256(previous.text),
          payloadBeforePath: path,
          payloadBeforeContentKind: previous.contentKind,
          beforePresent: "present",
          beforeObjectId: objectId,
          beforePath: path,
          beforeBlobSha256: sha256(previous.text),
          beforeLatestMomentId: this.moments.get(path),
        };
    const response = await this.h(request(OWNER, `/sync/${WORKSPACE}/log`, jsonBody({
      originId: "origin-owner",
      ops: [{
        originSeq,
        opKind: "moment.append",
        recordedAtMs: 1_000 + originSeq,
        payload: {
          momentId,
          versionId: "main",
          objectId,
          path,
          recordedAtMs: 1_000 + originSeq,
          operation: "write",
          payloadAfterBlobSha256: blobSha256,
          payloadAfterPath: path,
          payloadAfterContentKind: contentKind,
          payloadAfterByteLength: new TextEncoder().encode(text).byteLength,
          metadata: { origin: "user" },
          ...before,
        },
      }],
    })));
    expect(response.status, await response.clone().text()).toBe(200);
    this.moments.set(path, momentId);
    this.contents.set(path, { text, contentKind });
    return momentId;
  }

  async directMoments(): Promise<Array<{ originId: string; originSeq: number; payload: Record<string, unknown> }>> {
    const response = await this.h(request(OWNER, `/sync/${WORKSPACE}/log?since=0&limit=1000`));
    expect(response.status).toBe(200);
    const ops = (await json(response)).ops as Array<{
      originId: string;
      originSeq: number;
      opKind: string;
      payload: Record<string, unknown>;
    }>;
    return ops.filter((op) => op.originId.startsWith("relay:collection-file:"));
  }
}

function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// An in-place edit of `path` from `before` to `after`.
function edit(path: string, before: string, after: string): ProposedChange {
  return {
    basedOnPath: path,
    basedOnBlobSha256: sha256(before),
    operation: "write",
    afterPath: path,
    afterBlobSha256: sha256(after),
    afterContentKind: "text",
    afterByteLength: bytes(after),
    recordedAtMs: 1,
  };
}

function create(path: string, text: string): ProposedChange {
  return { ...edit(path, "", text), basedOnPath: null, basedOnBlobSha256: null };
}

async function upload(r: Relay, ...texts: string[]): Promise<void> {
  for (const text of texts) {
    const response = await r.h(request(RECIPIENT, `/sync/shares/${r.shareId}/blobs/${sha256(text)}`, {
      method: "PUT",
      body: new TextEncoder().encode(text),
    }));
    expect(response.status, await response.clone().text()).toBe(200);
  }
}

async function write(
  r: Relay,
  changes: unknown,
  options: { submitId?: string; as?: string } = {},
): Promise<Response> {
  return await r.h(request(
    options.as ?? RECIPIENT,
    `/sync/shares/${r.shareId}/collection-writes`,
    jsonBody({ submitId: options.submitId ?? "submit-1", changes }),
  ));
}

async function expectCode(response: Response, status: number, code: string): Promise<Record<string, unknown>> {
  const body = await json(response);
  expect({ status: response.status, code: body.code }).toEqual({ status, code });
  return body;
}

describe("the fixtures", () => {
  it("are what the shared parsers read", () => {
    expect(parseCollectionSchema(SCHEMA).status).toBe("valid");
    expect(parseCollectionSchema(SCHEMA_TWO).status).toBe("valid");
    const parsed = parseAutomationsFile(automations(STAMP, NUDGE));
    expect(parsed.status === "read" && parsed.entries.map((entry) => entry.status)).toEqual(["valid", "valid"]);
  });
});

describe("direct writes to a Collection's own files", () => {
  it("mints the owner's moment for a schema edit, naming the recipient", async () => {
    const r = await relay();
    await upload(r, SCHEMA_TWO);
    const response = await write(r, [edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA_TWO)]);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await json(response)).toEqual({
      ok: true,
      submitId: "submit-1",
      paths: [`${PACKING}/collection.yaml`],
      committedAtMs: CLOCK,
      created: true,
    });

    const [moment, ...rest] = await r.owner.directMoments();
    expect(rest).toEqual([]);
    expect(moment!.originId).toBe(`relay:collection-file:${r.grantId}`);
    expect(moment!.payload).toMatchObject({
      versionId: "main",
      objectId: "object-schema",
      path: `${PACKING}/collection.yaml`,
      operation: "write",
      recordedAtMs: CLOCK,
      payloadBeforePath: `${PACKING}/collection.yaml`,
      payloadBeforeBlobSha256: sha256(SCHEMA),
      payloadAfterPath: `${PACKING}/collection.yaml`,
      payloadAfterBlobSha256: sha256(SCHEMA_TWO),
      payloadAfterContentKind: "text",
      beforePresent: "present",
      beforeLatestMomentId: r.owner.moments.get(`${PACKING}/collection.yaml`),
      authors: [{ kind: "named", userId: RECIPIENT, grantId: r.grantId, grantGeneration: 1 }],
    });
    expect(JSON.stringify(moment!.payload)).not.toContain("@");
  });

  it("answers a retried submit with its receipt, and refuses the id for another write", async () => {
    const r = await relay();
    const third = `${SCHEMA_TWO}  Notes:\n    type: text\n`;
    await upload(r, SCHEMA_TWO, third);
    const changes = [edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA_TWO)];
    const first = await json(await write(r, changes));
    const again = await write(r, changes);
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual({ ...first, created: false });
    expect(await r.owner.directMoments()).toHaveLength(1);

    await expectCode(await write(r, [edit(`${PACKING}/collection.yaml`, SCHEMA_TWO, third)]), 409, "conflict");
  });

  it("answers stale with the current hash when the file changed since the recipient read it", async () => {
    const r = await relay();
    await r.owner.write("object-schema", `${PACKING}/collection.yaml`, SCHEMA_TWO);
    const mine = `${SCHEMA}  Notes:\n    type: text\n`;
    await upload(r, mine);
    const body = await expectCode(await write(r, [edit(`${PACKING}/collection.yaml`, SCHEMA, mine)]), 409, "stale");
    expect(body).toMatchObject({ path: `${PACKING}/collection.yaml`, currentBlobSha256: sha256(SCHEMA_TWO) });
    expect(await r.owner.directMoments()).toEqual([]);
  });

  it("takes an edit of automations the owner stored as binary, and the file becomes text", async () => {
    const r = await relay();
    const one = automations(STAMP);
    const two = automations(STAMP.replace("Packed", "Ready"));
    await r.owner.write("object-automations", `${PACKING}/automations.yaml`, one, "binary");
    await upload(r, two);
    const response = await write(r, [edit(`${PACKING}/automations.yaml`, one, two)]);
    expect(response.status, await response.clone().text()).toBe(200);

    const [moment, ...rest] = await r.owner.directMoments();
    expect(rest).toEqual([]);
    expect(moment!.payload).toMatchObject({
      objectId: "object-automations",
      operation: "write",
      payloadBeforeBlobSha256: sha256(one),
      payloadBeforeContentKind: "binary",
      payloadAfterBlobSha256: sha256(two),
      payloadAfterContentKind: "text",
      beforeLatestMomentId: r.owner.moments.get(`${PACKING}/automations.yaml`),
    });
  });

  it("takes edits beside and to a schema the owner stored as binary", async () => {
    const r = await relay();
    await r.owner.write("object-schema", `${PACKING}/collection.yaml`, SCHEMA_TWO, "binary");
    const one = automations(STAMP);
    const third = `${SCHEMA_TWO}  Notes:\n    type: text\n`;
    await upload(r, one, third);
    const created = await write(r, [create(`${PACKING}/automations.yaml`, one)]);
    expect(created.status, await created.clone().text()).toBe(200);
    const edited = await write(r, [edit(`${PACKING}/collection.yaml`, SCHEMA_TWO, third)], { submitId: "submit-2" });
    expect(edited.status, await edited.clone().text()).toBe(200);

    const moments = await r.owner.directMoments();
    expect(moments.map((op) => op.payload.path)).toEqual([
      `${PACKING}/automations.yaml`,
      `${PACKING}/collection.yaml`,
    ]);
    expect(moments[1]!.payload).toMatchObject({
      payloadBeforeContentKind: "binary",
      payloadAfterContentKind: "text",
    });
  });

  it("creates automations.yaml beside a Collection and edits it", async () => {
    const r = await relay();
    const one = automations(STAMP);
    const two = automations(STAMP.replace("Packed", "Ready"));
    await upload(r, one, two);
    expect((await write(r, [create(`${PACKING}/automations.yaml`, one)])).status).toBe(200);
    expect((await write(r, [edit(`${PACKING}/automations.yaml`, one, two)], { submitId: "submit-2" })).status).toBe(200);
    expect((await r.owner.directMoments()).map((op) => op.payload.path)).toEqual([
      `${PACKING}/automations.yaml`,
      `${PACKING}/automations.yaml`,
    ]);
  });

  it("refuses any change to an automation with a personal step", async () => {
    const r = await relay();
    const withNudge = automations(STAMP, NUDGE);
    await upload(r, withNudge);
    // Adding one.
    await expectCode(await write(r, [create(`${PACKING}/automations.yaml`, withNudge)]), 403, "share_op_rejected");

    await r.owner.write("object-automations", `${PACKING}/automations.yaml`, withNudge);
    const stampChanged = automations(STAMP.replace("Packed", "Ready"), NUDGE);
    const nudgeChanged = automations(STAMP, NUDGE.replace("Look", "Look again"));
    const nudgeRemoved = automations(STAMP);
    await upload(r, stampChanged, nudgeChanged, nudgeRemoved);
    // Changing one, or removing one.
    for (const [index, after] of [nudgeChanged, nudgeRemoved].entries()) {
      await expectCode(
        await write(r, [edit(`${PACKING}/automations.yaml`, withNudge, after)], { submitId: `refused-${index}` }),
        403,
        "share_op_rejected",
      );
    }
    // Another automation beside it, with the personal one unchanged.
    expect((await write(r, [edit(`${PACKING}/automations.yaml`, withNudge, stampChanged)])).status).toBe(200);
  });

  it("refuses content the shared parsers do not accept", async () => {
    const r = await relay();
    const badSchema = "fields:\n  Title:\n    type: sparkles\n";
    const badAutomation = automations("  - id: stamp\n    name: Stamp\n    when: whenever\n    do: []\n");
    const badRecord = "---\ntitle: [unclosed\n---\nBody\n";
    expect(parseCollectionSchema(badSchema).status).not.toBe("valid");
    await upload(r, badSchema, badAutomation, badRecord);
    await expectCode(await write(r, [edit(`${PACKING}/collection.yaml`, SCHEMA, badSchema)]), 403, "share_op_rejected");
    await expectCode(await write(r, [create(`${PACKING}/automations.yaml`, badAutomation)]), 403, "share_op_rejected");
    await expectCode(
      await write(r, [create("trip/ideas/collection.yaml", SCHEMA), create("trip/ideas/a.md", badRecord)]),
      403,
      "share_op_rejected",
    );
    expect(await r.owner.directMoments()).toEqual([]);
  });

  it("creates a new Collection with its schema first", async () => {
    const r = await relay();
    const auto = automations(STAMP);
    const recordA = "---\nTitle: Tent\n---\n";
    const recordB = "No fields yet.\n";
    await upload(r, SCHEMA, auto, recordA, recordB);
    const response = await write(r, [
      create("trip/ideas/b.md", recordB),
      create("trip/ideas/a.md", recordA),
      create("trip/ideas/automations.yaml", auto),
      create("trip/ideas/collection.yaml", SCHEMA),
    ]);
    expect(response.status, await response.clone().text()).toBe(200);
    const moments = await r.owner.directMoments();
    expect(moments.map((op) => [op.originSeq, op.payload.path])).toEqual([
      [0, "trip/ideas/collection.yaml"],
      [1, "trip/ideas/automations.yaml"],
      [2, "trip/ideas/b.md"],
      [3, "trip/ideas/a.md"],
    ]);
    expect(moments.every((op) => op.payload.beforePresent === "null" && op.payload.operation === "write")).toBe(true);
    expect(new Set(moments.map((op) => op.payload.objectId)).size).toBe(4);
  });

  it("answers stale when a new Collection's folder is taken under another spelling", async () => {
    const r = await relay();
    await r.owner.write("object-taken", "trip/Ideas/old.md", "old\n");
    await upload(r, SCHEMA);
    const body = await expectCode(await write(r, [create("trip/ideas/collection.yaml", SCHEMA)]), 409, "stale");
    expect(body).toMatchObject({ path: "trip/ideas", currentBlobSha256: null });
  });

  it("refuses more than 500 records in one new Collection", async () => {
    const r = await relay();
    const records = Array.from({ length: MAX_NEW_COLLECTION_RECORDS + 1 }, (_, index) =>
      create(`trip/ideas/${index}.md`, `${index}\n`));
    await expectCode(
      await write(r, [create("trip/ideas/collection.yaml", SCHEMA), ...records]),
      403,
      "share_op_rejected",
    );
  });

  it("leaves deletes, renames, other files, and a folder the share does not cover on proposals", async () => {
    const r = await relay();
    await upload(r, SCHEMA_TWO, "note\n");
    const moved = { ...edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA_TWO), afterPath: "trip/other/collection.yaml" };
    const deleted = {
      ...edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA),
      operation: "delete",
      afterPath: null,
      afterBlobSha256: null,
      afterContentKind: null,
      afterByteLength: null,
    };
    for (const changes of [[moved], [deleted], [create(`${PACKING}/notes.md`, "note\n")]]) {
      await expectCode(await write(r, changes), 403, "share_op_rejected");
    }

    const narrow = await relay({ paths: [`${PACKING}/collection.yaml`] });
    await upload(narrow, SCHEMA_TWO);
    await expectCode(
      await write(narrow, [edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA_TWO)]),
      403,
      "share_op_rejected",
    );
  });

  it("refuses view, comment, a link-opened grant, and anyone the share does not name", async () => {
    for (const access of ["view", "comment"] as const) {
      const r = await relay({ access });
      await expectCode(await write(r, [edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA_TWO)]), 403, "share_read_only");
    }

    const r = await relay();
    await expectCode(
      await write(r, [edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA_TWO)], { as: "stranger" }),
      404,
      "not_found",
    );

    seedLinkGrant(r.storage, { grantId: "link-1", shareId: r.shareId, secretHash: sha256("secret"), access: "edit" });
    seedDependentGrant(r.storage, {
      shareId: r.shareId, parentGrantId: "link-1", grantId: "from-link", principalUserId: "linked", createdAtMs: CLOCK,
    });
    await expectCode(
      await write(r, [edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA_TWO)], { as: "linked" }),
      403,
      "share_read_only",
    );
  });

  it("refuses a write whose grant changed after the route found it", async () => {
    const r = await relay();
    await upload(r, SCHEMA_TWO);
    const changes = [edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA_TWO)];
    const selector: ShareSelector = { versionId: null, paths: ["trip"], access: "edit" };
    const decision = filterCollectionWriteForShare(selector, changes);
    if (!decision.allowed) throw new Error("expected the write to be allowed");
    expect(r.storage.revokeShareGrant({ shareId: r.shareId, grantId: r.grantId, revokedAtMs: CLOCK }).ok).toBe(true);
    expect(() => r.storage.commitCollectionWrite({
      shareId: r.shareId,
      grantId: r.grantId,
      grantGeneration: 1,
      userId: RECIPIENT,
      submitId: "submit-1",
      rawChanges: changes,
      write: decision.write,
      nowMs: CLOCK,
      newId: () => "id",
    })).toThrow(expect.objectContaining({ code: "not_found" }));
    await expectCode(await write(r, changes), 404, "not_found");
    expect(await r.owner.directMoments()).toEqual([]);
  });

  it("limits each grant's rate of direct writes", async () => {
    const r = await relay({ overrides: { collectionWriteRateLimiter: new TokenBucketLimiter(1, 0.001, 10) } });
    const third = `${SCHEMA_TWO}  Notes:\n    type: text\n`;
    await upload(r, SCHEMA_TWO, third);
    expect((await write(r, [edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA_TWO)])).status).toBe(200);
    await expectCode(
      await write(r, [edit(`${PACKING}/collection.yaml`, SCHEMA_TWO, third)], { submitId: "submit-2" }),
      429,
      "collection_write_rate_limited",
    );
  });

  it("asks for a blob the relay does not hold", async () => {
    const r = await relay();
    await expectCode(await write(r, [edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA_TWO)]), 422, "blob_missing");
  });
});

describe("round 1 of review", () => {
  it("refuses a newer Collection version with the file and update instruction", async () => {
    const r = await relay();
    const newer = `version: 2\n${SCHEMA_TWO}`;
    await upload(r, newer);
    const body = await expectCode(await write(r, [edit(`${PACKING}/collection.yaml`, SCHEMA, newer)]), 403, "share_op_rejected");
    expect(body).toMatchObject({ error: "trip/packing/collection.yaml uses a newer version. Update the sync service to read this file." });
    expect(await r.owner.directMoments()).toEqual([]);
  });
  it("keeps the lane's origin and a named author out of the owner's own log", async () => {
    const r = await relay();
    const append = (originId: string, author: unknown) => r.h(request(OWNER, `/sync/${WORKSPACE}/log`, jsonBody({
      originId,
      ops: [{
        originSeq: 0, opKind: "moment.append", recordedAtMs: 1,
        payload: {
          momentId: "forged", versionId: "main", objectId: "object-forged", path: "trip/forged.md", recordedAtMs: 1,
          operation: "write", payloadBeforeBlobSha256: null, payloadBeforePath: null,
          payloadAfterBlobSha256: sha256("forged"), payloadAfterPath: "trip/forged.md", payloadAfterContentKind: "text",
          metadata: { origin: "user" }, beforePresent: "null", ...(author ? { authors: [author] } : {}),
        },
      }],
    })));
    await expectCode(await append(`relay:collection-file:${r.grantId}`, null), 400, "bad_request");
    await expectCode(
      await append("origin-owner", { kind: "named", userId: RECIPIENT, grantId: r.grantId, grantGeneration: 1 }),
      403,
      "authorship_mismatch",
    );
  });

  it("refuses a batch whose files sum past the byte bound, before reading anything", async () => {
    const r = await relay();
    const big = Math.floor(MAX_COLLECTION_WRITE_BYTES / 4);
    const records = Array.from({ length: 5 }, (_, index) =>
      ({ ...create(`trip/ideas/${index}.md`, `${index}`), afterByteLength: big }));
    const reads = vi.spyOn(r.storage, "getBlob");
    await expectCode(await write(r, [create("trip/ideas/collection.yaml", SCHEMA), ...records]), 403, "share_op_rejected");
    expect(reads).not.toHaveBeenCalled();
  });

  it("reads each blob once, however many files name it", async () => {
    const r = await relay();
    const record = "---\nTitle: Same\n---\n";
    await upload(r, SCHEMA, record);
    const reads = vi.spyOn(r.storage, "getBlob");
    const response = await write(r, [
      create("trip/ideas/collection.yaml", SCHEMA),
      ...Array.from({ length: 50 }, (_, index) => create(`trip/ideas/${index}.md`, record)),
    ]);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(reads.mock.calls.map(([, sha]) => sha).sort()).toEqual([sha256(SCHEMA), sha256(record)].sort());
  });

  it("refuses a body past the route's bound", async () => {
    const r = await relay();
    const response = await r.h(request(RECIPIENT, `/sync/shares/${r.shareId}/collection-writes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ submitId: "big", changes: [], pad: "x".repeat(MAX_COLLECTION_WRITE_BODY_BYTES) }),
    }));
    await expectCode(response, 413, "payload_too_large");
  });

  it("spends a token on a request it refuses", async () => {
    const r = await relay({ overrides: { collectionWriteRateLimiter: new TokenBucketLimiter(1, 0.001, 10) } });
    await upload(r, SCHEMA_TWO);
    await expectCode(await write(r, "not a list"), 403, "share_op_rejected");
    await expectCode(
      await write(r, [edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA_TWO)]),
      429,
      "collection_write_rate_limited",
    );
  });

  it("finds a new Collection's folder taken under another spelling of its parent", async () => {
    const r = await relay();
    await r.owner.write("object-taken", "trip/Ideas/packing/collection.yaml", SCHEMA);
    await upload(r, SCHEMA);
    const body = await expectCode(await write(r, [create("trip/ideas/packing/collection.yaml", SCHEMA)]), 409, "stale");
    expect(body).toMatchObject({ path: "trip/ideas/packing", currentBlobSha256: null });
  });

  it("finds a created file taken under another spelling", async () => {
    const r = await relay();
    const existing = automations(STAMP);
    await r.owner.write("object-automations", `${PACKING}/Automations.yaml`, existing);
    await upload(r, existing);
    const body = await expectCode(await write(r, [create(`${PACKING}/automations.yaml`, existing)]), 409, "stale");
    expect(body).toMatchObject({ path: `${PACKING}/automations.yaml`, currentBlobSha256: null });
  });

  it("finds a file where a new Collection needs a folder", async () => {
    const r = await relay();
    await r.owner.write("object-file", "trip/Ideas", "a file, not a folder\n");
    await upload(r, SCHEMA);
    const body = await expectCode(await write(r, [create("trip/ideas/new/collection.yaml", SCHEMA)]), 409, "stale");
    expect(body).toMatchObject({ path: "trip/ideas/new", currentBlobSha256: null });
  });

  it("reads an unchanged automations file once", async () => {
    const r = await relay();
    const same = automations(STAMP);
    await r.owner.write("object-automations", `${PACKING}/automations.yaml`, same);
    const reads = vi.spyOn(r.storage, "getBlob");
    const response = await write(r, [edit(`${PACKING}/automations.yaml`, same, same)]);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(reads.mock.calls.map(([, sha]) => sha)).toEqual([sha256(same)]);
  });

  it("keys current files that existed before the key table", async () => {
    const r = await relay();
    await r.owner.write("object-taken", "trip/Ideas/old.md", "old\n");
    const path = storagePath(r.storage);
    closeTestStorage(r.storage);
    const db = inspectDatabase(path);
    db.prepare("DELETE FROM sync_relay_current_file_keys").run();
    db.prepare("DELETE FROM sync_relay_migrations WHERE migration_id = 'current-file-collision-keys-v1'").run();
    db.close();
    const reopened = reopenTestStorage(path);
    const h = testHandler(reopened, { nowMs: () => CLOCK });
    const again: Relay = { ...r, h, storage: reopened };
    await upload(again, SCHEMA);
    await expectCode(await write(again, [create("trip/ideas/collection.yaml", SCHEMA)]), 409, "stale");
  });

  it("refuses a write to a file whose old version has an entry that is not valid", async () => {
    const r = await relay();
    const hidden = "  - id: hidden\n    name: Hidden\n    when: whenever\n    do:\n      - wake-agent: Look\n        person: user_ana\n";
    const withHidden = automations(STAMP, hidden);
    const parsed = parseAutomationsFile(withHidden);
    expect(parsed.status === "read" && parsed.entries.map((entry) => entry.status)).toEqual(["valid", "invalid"]);
    await r.owner.write("object-automations", `${PACKING}/automations.yaml`, withHidden);
    const removed = automations(STAMP);
    await upload(r, removed);
    await expectCode(await write(r, [edit(`${PACKING}/automations.yaml`, withHidden, removed)]), 403, "share_op_rejected");
    expect(await r.owner.directMoments()).toEqual([]);
  });
});

// The relay's own HTTP adapter, as main.ts configures it. The refused uploads
// below never end, so an answer shows the relay did not wait for the whole
// body. Each sends no more than the relay reads before it answers: the adapter
// closes the connection after a refusal, and unread bytes would reset it.
describe("over the HTTP adapter", () => {
  async function serve(r: Relay): Promise<{ port: number; close(): Promise<void> }> {
    const server = serveFetchHandler({
      handler: r.h,
      maxBodyBytes: () => 21 * 1024 * 1024,
      streamBody: streamsRequestBody,
      oversized: () => new Response(null, { status: 413 }),
      failure: () => new Response(null, { status: 500 }),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      port: (server.address() as AddressInfo).port,
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  function post(
    port: number,
    path: string,
    options: { as: string | null; body: Uint8Array; end: boolean; method?: string; length?: number },
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (options.as !== null) headers.authorization = `Bearer user:${options.as}`;
      if (options.length !== undefined) headers["content-length"] = String(options.length);
      const sent = httpRequest({ host: "127.0.0.1", port, path, method: options.method ?? "POST", headers });
      sent.on("response", (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { text += chunk; });
        response.on("end", () => {
          sent.destroy();
          resolve({ status: response.statusCode ?? 0, body: text });
        });
      });
      sent.on("error", reject);
      sent.write(options.body);
      if (options.end) sent.end();
    });
  }

  it("refuses a caller without credentials before reading the body, whatever the method", async () => {
    const r = await relay();
    const server = await serve(r);
    try {
      for (const method of ["POST", "PUT", "GET", "HEAD"]) {
        const answer = await post(server.port, `/sync/shares/${r.shareId}/collection-writes`, {
          as: null,
          body: new Uint8Array(1024),
          end: false,
          method,
          // Node sends a GET's body only under a stated length.
          length: 4096,
        });
        expect({ method, status: answer.status }).toEqual({ method, status: 401 });
      }
    } finally {
      await server.close();
    }
  });

  it("bounds the body at 1 MiB under every spelling of the path", async () => {
    const r = await relay();
    const server = await serve(r);
    try {
      for (const path of [
        `/sync/shares/${r.shareId}/collection-writes`,
        `/sync/shares/${r.shareId}/collection-writes/`,
        `/sync/shares/${r.shareId}/collection%2Dwrites`,
      ]) {
        const answer = await post(server.port, path, {
          as: RECIPIENT,
          body: new Uint8Array(MAX_COLLECTION_WRITE_BODY_BYTES + 1).fill(0x20),
          end: false,
        });
        expect({ path, status: answer.status, code: JSON.parse(answer.body).code })
          .toEqual({ path, status: 413, code: "payload_too_large" });
      }
    } finally {
      await server.close();
    }
  });

  it("writes a streamed body", async () => {
    const r = await relay();
    await upload(r, SCHEMA_TWO);
    const server = await serve(r);
    try {
      const answer = await post(server.port, `/sync/shares/${r.shareId}/collection-writes`, {
        as: RECIPIENT,
        body: new TextEncoder().encode(JSON.stringify({
          submitId: "streamed",
          changes: [edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA_TWO)],
        })),
        end: true,
      });
      expect(answer.status, answer.body).toBe(200);
      expect((await r.owner.directMoments()).length).toBe(1);
    } finally {
      await server.close();
    }
  });
});

describe("the owner's read of a grant's direct writes", () => {
  async function ownerRead(r: Relay, grantId: string, query = "", as = OWNER): Promise<Response> {
    return await r.h(request(as, `/sync/${WORKSPACE}/collection-writes/${grantId}${query}`));
  }

  it("lists each write's files from the moments it minted, oldest first, after the grant ends", async () => {
    const r = await relay();
    const record = "---\nTitle: Tent\n---\n";
    await upload(r, SCHEMA_TWO, SCHEMA, record);
    expect((await write(r, [edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA_TWO)], { submitId: "edit" })).status).toBe(200);
    expect((await write(r, [
      create("trip/ideas/a.md", record),
      create("trip/ideas/collection.yaml", SCHEMA),
    ], { submitId: "new" })).status).toBe(200);
    expect(r.storage.revokeShareGrant({ shareId: r.shareId, grantId: r.grantId, revokedAtMs: CLOCK }).ok).toBe(true);

    const moments = await r.owner.directMoments();
    const response = await ownerRead(r, r.grantId);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await json(response)).toEqual({
      writes: [
        {
          submitId: "edit",
          grantGeneration: 1,
          committedAtMs: CLOCK,
          firstOriginSeq: 0,
          files: [{
            path: `${PACKING}/collection.yaml`,
            objectId: "object-schema",
            momentId: moments[0]!.payload.momentId,
            created: false,
          }],
        },
        {
          submitId: "new",
          grantGeneration: 1,
          committedAtMs: CLOCK,
          firstOriginSeq: 1,
          files: [
            { path: "trip/ideas/collection.yaml", objectId: moments[1]!.payload.objectId, momentId: moments[1]!.payload.momentId, created: true },
            { path: "trip/ideas/a.md", objectId: moments[2]!.payload.objectId, momentId: moments[2]!.payload.momentId, created: true },
          ],
        },
      ],
      nextAfterOriginSeq: null,
    });

    const first = await json(await ownerRead(r, r.grantId, "?limit=1"));
    expect(first).toMatchObject({ writes: [{ submitId: "edit" }], nextAfterOriginSeq: 0 });
    const second = await json(await ownerRead(r, r.grantId, "?limit=1&afterOriginSeq=0"));
    expect(second).toMatchObject({ writes: [{ submitId: "new" }], nextAfterOriginSeq: null });
  });

  it("reads the ledger by grant and order, and drops the index an earlier build made", async () => {
    const r = await relay();
    const path = storagePath(r.storage);
    closeTestStorage(r.storage);
    const db = inspectDatabase(path);
    db.prepare(`CREATE INDEX idx_sync_relay_collection_writes_grant
      ON sync_relay_collection_writes(workspace_id, grant_id, created_at_ms)`).run();
    db.close();
    closeTestStorage(reopenTestStorage(path));
    const reopened = inspectDatabase(path);
    const indexes = reopened.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sync_relay_collection_writes' AND sql IS NOT NULL",
    ).all().map((row) => row.name);
    reopened.close();
    expect(indexes).toEqual(["idx_sync_relay_collection_writes_grant_seq"]);
  });

  it("answers only the workspace's owner, for a grant on one of its shares", async () => {
    const r = await relay();
    await expectCode(await ownerRead(r, r.grantId, "", RECIPIENT), 404, "not_found");
    await expectCode(await ownerRead(r, "grant-elsewhere"), 404, "not_found");
    await claimWorkspace(r.h, "stranger", "workspace-b");
    const theirs = await createShare(r.h, "stranger", "workspace-b", { recipientUserId: RECIPIENT, paths: ["x"], access: "edit" });
    const theirGrant = r.storage.listActiveShareGrantsForRecipient(theirs, RECIPIENT)[0]!.grantId;
    await expectCode(await ownerRead(r, theirGrant), 404, "not_found");
    await expectCode(await ownerRead(r, r.grantId, "?limit=0"), 400, "bad_request");
    await expectCode(await ownerRead(r, r.grantId, "?cursor=1"), 400, "bad_request");
    expect(await json(await ownerRead(r, r.grantId))).toEqual({ writes: [], nextAfterOriginSeq: null });
  });
});

describe("the direct-write decision", () => {
  it("counts two paths one disk would hold as one file as the same path", () => {
    const selector: ShareSelector = { versionId: null, paths: ["trip"], access: "edit" };
    for (const [first, second] of [["a.md", "A.md"], ["caf\u00e9.md", "cafe\u0301.md"], ["b.md", "b.md. "]]) {
      const decision = filterCollectionWriteForShare(selector, [
        create("trip/ideas/collection.yaml", SCHEMA),
        create(`trip/ideas/${first}`, "one"),
        create(`trip/ideas/${second}`, "two"),
      ]);
      expect(decision.allowed, `${first} beside ${second}`).toBe(false);
    }
    expect(pathCollisionKey("Trip/Ideas. /A.MD")).toBe(pathCollisionKey("trip/ideas/a.md"));
  });

  it("folds every spelling of a letter to one key", () => {
    // Each group lands on one key, and folding a key again changes nothing.
    const groups = [
      ["\u1e9e.md", "\u00df.md", "ss.md", "SS.md"], // capital and small sharp s
      ["\u0131.md", "i.md", "I.md"], // dotless i
      ["\u0130.md", "i\u0307.md"], // dotted capital I
      ["\u03c2.md", "\u03c3.md", "\u03a3.md"], // final, small, and capital sigma
      ["\u039f\u0394\u039f\u03a3", "\u03bf\u03b4\u03bf\u03c3", "\u03bf\u03b4\u03bf\u03c2"],
      ["\ufb01le.md", "file.md", "FILE.md. "], // a ligature and a trailing dot and space
    ];
    for (const group of groups) {
      const keys = group.map(pathCollisionKey);
      expect(new Set(keys).size, group.join(" ")).toBe(1);
      expect(pathCollisionKey(keys[0]!)).toBe(keys[0]);
    }
    expect(new Set(groups.map((group) => pathCollisionKey(group[0]!))).size).toBe(groups.length);
  });

  it("takes exactly 500 records in a new Collection", () => {
    const selector: ShareSelector = { versionId: null, paths: ["trip"], access: "edit" };
    const records = Array.from({ length: MAX_NEW_COLLECTION_RECORDS }, (_, index) =>
      create(`trip/ideas/${index}.md`, `${index}\n`));
    const decision = filterCollectionWriteForShare(selector, [...records, create("trip/ideas/collection.yaml", SCHEMA)]);
    expect(decision.allowed && decision.write.kind === "new-collection" && decision.write.changes.length).toBe(501);
    expect(decision.allowed && decision.write.kind === "new-collection" && decision.write.changes[0]!.afterPath)
      .toBe("trip/ideas/collection.yaml");
  });
});
