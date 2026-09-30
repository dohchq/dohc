import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serveFetchHandler, TokenBucketLimiter } from "@dohc/service-http";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";
import { MAX_COLLECTION_WRITE_BODY_BYTES, MAX_LINK_COLLECTION_WRITE_BODY_BYTES } from "./collectionWriteRoutes";
import { hashLinkBearer } from "./linkSecurity";
import { normalizeLinkRefusal } from "./linkRefusal";
import { guardRelayResponses } from "./relayResponseStanding";
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
  LINK_KEY,
  linkRequest,
  putBlob,
  reopenTestStorage,
  request,
  seedDependentGrant,
  seedLinkGrant,
  seedLinkSession,
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
  options: {
    overrides?: HandlerOverrides;
    paths?: string[];
    access?: "view" | "comment" | "edit";
    storage?: Parameters<typeof testStorage>[0];
  } = {},
): Promise<Relay> {
  const storage = await testStorage(options.storage);
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
      writer: { kind: "named", userId: RECIPIENT },
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

// The owner's reach check keeps a revoked recipient who wrote automations as
// a former editor, so the owner's share listing says who did, and under
// which generation, after the grant ends too.
describe("a grant's automations writes in the owner's share listing", () => {
  async function grantedRow(r: Relay): Promise<Record<string, unknown>> {
    const response = await r.h(request(OWNER, "/sync/shares"));
    expect(response.status).toBe(200);
    const granted = (await json(response)).granted as Array<Record<string, unknown>>;
    return granted.find((row) => row.grantId === r.grantId)!;
  }

  it("names the generation a recipient last wrote automations under, before and after the owner revokes them", async () => {
    const r = await relay();
    expect(await grantedRow(r)).toMatchObject({ automationsGeneration: null });
    await upload(r, SCHEMA_TWO);
    expect((await write(r, [edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA_TWO)], { submitId: "schema" })).status).toBe(200);
    expect(await grantedRow(r), "a schema is not an automations file").toMatchObject({ automationsGeneration: null });

    const one = automations(STAMP);
    await upload(r, one);
    expect((await write(r, [create(`${PACKING}/automations.yaml`, one)], { submitId: "automations" })).status).toBe(200);
    expect(await grantedRow(r)).toMatchObject({ revokedAtMs: null, automationsGeneration: 1 });

    // The owner revokes them from another computer.
    expect(r.storage.revokeShareGrant({ shareId: r.shareId, grantId: r.grantId, revokedAtMs: CLOCK }).ok).toBe(true);
    expect(await grantedRow(r)).toMatchObject({ revokedAtMs: CLOCK, automationsGeneration: 1 });
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

  it("keeps an earlier build's ledger rows as named writes, with their quota", async () => {
    const r = await relay();
    await upload(r, SCHEMA_TWO);
    expect((await write(r, [edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA_TWO)], { submitId: "edit" })).status).toBe(200);
    const before = await json(await ownerRead(r, r.grantId));
    const path = storagePath(r.storage);
    closeTestStorage(r.storage);
    // Put the ledger back the way the earlier build made it: a user id on
    // every row, an index since replaced, and no migration mark.
    const db = inspectDatabase(path);
    const usage = () => db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id = ?").get(WORKSPACE);
    const quota = usage();
    db.exec(`
      DELETE FROM sync_relay_migrations WHERE migration_id = 'collection-write-authors-v1';
      ALTER TABLE sync_relay_collection_writes RENAME TO current_ledger;
      CREATE TABLE sync_relay_collection_writes (
        grant_id TEXT NOT NULL,
        submit_id TEXT NOT NULL CHECK (length(submit_id) BETWEEN 1 AND 128),
        workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
        share_id TEXT NOT NULL,
        grant_generation INTEGER NOT NULL CHECK (grant_generation BETWEEN 1 AND 9007199254740991),
        user_id TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
        origin_id TEXT NOT NULL,
        first_origin_seq INTEGER NOT NULL CHECK (first_origin_seq >= 0),
        last_origin_seq INTEGER NOT NULL CHECK (last_origin_seq >= first_origin_seq),
        paths_json TEXT NOT NULL CHECK (json_valid(paths_json)),
        receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
        storage_bytes INTEGER NOT NULL CHECK (storage_bytes > 0),
        PRIMARY KEY (grant_id, submit_id)
      ) STRICT;
      INSERT INTO sync_relay_collection_writes
        SELECT grant_id, submit_id, workspace_id, share_id, grant_generation, user_id, payload_sha256, origin_id,
          first_origin_seq, last_origin_seq, paths_json, receipt_json, created_at_ms, storage_bytes
        FROM current_ledger;
      DROP TABLE current_ledger;
      CREATE INDEX idx_sync_relay_collection_writes_grant
        ON sync_relay_collection_writes(workspace_id, grant_id, created_at_ms);
      CREATE TRIGGER sync_relay_collection_writes_usage_insert
        AFTER INSERT ON sync_relay_collection_writes BEGIN
        UPDATE sync_relay_workspace_usage SET usage_bytes = usage_bytes + NEW.storage_bytes
        WHERE workspace_id = NEW.workspace_id; END;
      CREATE TRIGGER sync_relay_collection_writes_usage_delete
        AFTER DELETE ON sync_relay_collection_writes BEGIN
        UPDATE sync_relay_workspace_usage SET usage_bytes = usage_bytes - OLD.storage_bytes
        WHERE workspace_id = OLD.workspace_id; END;
    `);
    expect(usage()).toEqual(quota);
    db.close();

    const reopened = reopenTestStorage(path);
    const again: Relay = { ...r, h: testHandler(reopened, { nowMs: () => CLOCK }), storage: reopened };
    const migrated = inspectDatabase(path);
    expect(migrated.prepare(
      "SELECT author_kind, user_id, principal_id FROM sync_relay_collection_writes",
    ).all()).toEqual([{ author_kind: "named", user_id: RECIPIENT, principal_id: null }]);
    expect(migrated.prepare(
      "SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id = ?",
    ).get(WORKSPACE)).toEqual(quota);
    expect(migrated.prepare(
      "SELECT name FROM sqlite_master WHERE name LIKE '%collection_writes%' ORDER BY name",
    ).all().map((row) => row.name)).toEqual([
      "idx_sync_relay_collection_writes_grant_seq",
      "sqlite_autoindex_sync_relay_collection_writes_1",
      "sync_relay_collection_writes",
      "sync_relay_collection_writes_usage_delete",
      "sync_relay_collection_writes_usage_insert",
    ]);
    migrated.close();
    expect(await json(await ownerRead(again, r.grantId))).toEqual(before);
    // The same submit answers from its row, and another write still lands.
    const retried = await write(again, [edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA_TWO)], { submitId: "edit" });
    expect(retried.status, await retried.clone().text()).toBe(200);
    await upload(again, SCHEMA);
    const next = await write(again, [edit(`${PACKING}/collection.yaml`, SCHEMA_TWO, SCHEMA)], { submitId: "next" });
    expect(next.status, await next.clone().text()).toBe(200);
    expect((await new Owner(again.h).directMoments()).length).toBe(2);
  });

  it("stores each write's author as a named user or a link principal, never both", async () => {
    const r = await relay();
    const path = storagePath(r.storage);
    closeTestStorage(r.storage);
    const db = inspectDatabase(path);
    const insert = (submitId: string, authorKind: string, userId: string | null, principalId: string | null) =>
      db.prepare(`INSERT INTO sync_relay_collection_writes (
          grant_id, submit_id, workspace_id, share_id, grant_generation, author_kind, user_id, principal_id,
          payload_sha256, origin_id, first_origin_seq, last_origin_seq, paths_json, receipt_json, created_at_ms,
          storage_bytes
        ) VALUES ('grant', ?, ?, 'share', 1, ?, ?, ?, ?, 'relay:collection-file:grant', 0, 0, '[]', '{}', 0, 1)`)
        .run(submitId, WORKSPACE, authorKind, userId, principalId, "a".repeat(64));
    expect(() => insert("named", "named", "user", null)).not.toThrow();
    expect(() => insert("link", "link", null, "principal")).not.toThrow();
    for (const [kind, userId, principalId] of [
      ["named", null, null],
      ["named", "user", "principal"],
      ["named", null, "principal"],
      ["link", null, null],
      ["link", "user", "principal"],
      ["link", "user", null],
      ["link", null, ""],
      ["named", "", null],
      ["public", null, "principal"],
    ] as const) {
      expect(() => insert(`${kind}-${userId}-${principalId}`, kind, userId, principalId), `${kind} ${userId} ${principalId}`)
        .toThrow(/CHECK constraint/);
    }
    db.close();
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

// An Edit share link writes the same files through its own route (ADR 0013),
// with its content in the request and its authority from the capability.
describe("direct writes through an Edit share link", () => {
  async function expectOpaque(response: Response) {
    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ ok: false, error: "not found" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  }

  const LINK_GRANT = "grant-link";
  const TOKEN = "a".repeat(43);
  const OTHER_TOKEN = "b".repeat(43);
  const PROFILE = "c".repeat(43);
  const OTHER_PROFILE = "d".repeat(43);
  const release: HandlerOverrides = {
    publicEditRelease: { version: 1 },
    relayExchangeKey: "link-direct-write-relay-key-at-least-32",
    namedBrowserSessionLimits: { maxSessions: 8, retentionMs: 60_000, maxPendingRequests: 4, maxRequestBytes: 8192, maxResponseBytes: 16384, timeoutMs: 1000 },
  };

  async function linkRelay(
    options: { access?: "view" | "comment" | "edit"; overrides?: HandlerOverrides; storage?: Parameters<typeof testStorage>[0] } = {},
  ): Promise<Relay> {
    const r = await relay({ overrides: { ...release, ...options.overrides }, storage: options.storage });
    seedLinkGrant(r.storage, { grantId: LINK_GRANT, shareId: r.shareId, secretHash: "link-secret-hash", access: options.access ?? "edit" });
    seedLinkSession(r.storage, { grantId: LINK_GRANT, capabilityHash: hashLinkBearer(TOKEN, LINK_KEY) });
    seedLinkSession(r.storage, { grantId: LINK_GRANT, sessionId: "other-session", capabilityHash: hashLinkBearer(OTHER_TOKEN, LINK_KEY) });
    return r;
  }

  const encoded = (text: string) => Buffer.from(text).toString("base64");
  function linkEdit(path: string, before: string, after: string): Record<string, unknown> {
    return {
      basedOnPath: path, basedOnBlobSha256: sha256(before), operation: "write",
      afterPath: path, afterContentKind: "text", afterContentBase64: encoded(after), recordedAtMs: 1,
    };
  }
  function linkCreate(path: string, text: string): Record<string, unknown> {
    return { ...linkEdit(path, "", text), basedOnPath: null, basedOnBlobSha256: null };
  }

  async function linkWrite(
    r: Relay,
    changes: unknown,
    options: { submitId?: string; token?: string; profile?: string; headers?: Record<string, string>; body?: BodyInit } = {},
  ): Promise<Response> {
    return await r.h(linkRequest(options.token ?? TOKEN, "/sync/link/collection-writes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dohc-link-profile-secret": options.profile ?? PROFILE, ...options.headers },
      body: options.body ?? JSON.stringify({ submitId: options.submitId ?? "submit-1", changes }),
      ...(options.body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit));
  }

  function ledger(r: Relay): Array<Record<string, unknown>> {
    const db = inspectDatabase(storagePath(r.storage));
    try {
      return db.prepare("SELECT grant_id, author_kind, user_id, principal_id, grant_generation FROM sync_relay_collection_writes").all();
    } finally {
      db.close();
    }
  }
  function principals(r: Relay): number {
    const db = inspectDatabase(storagePath(r.storage));
    try {
      return Number(db.prepare("SELECT COUNT(*) AS n FROM sync_relay_link_principals").get()?.n);
    } finally {
      db.close();
    }
  }
  function sql(r: Relay, statement: string): void {
    const db = inspectDatabase(storagePath(r.storage));
    try {
      db.exec(statement);
    } finally {
      db.close();
    }
  }

  it("writes an automations file under the link, never a person, with content the relay hashed", async () => {
    const r = await linkRelay();
    const one = automations(STAMP);
    const response = await linkWrite(r, [linkCreate(`${PACKING}/automations.yaml`, one)]);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await json(response)).toMatchObject({ ok: true, submitId: "submit-1", paths: [`${PACKING}/automations.yaml`], created: true });

    const [moment, ...rest] = await r.owner.directMoments();
    expect(rest).toEqual([]);
    expect(moment!.originId).toBe(`relay:collection-file:${LINK_GRANT}`);
    const author = moment!.payload.author as Record<string, unknown>;
    expect(author).toEqual({ kind: "link", grantId: LINK_GRANT, grantGeneration: 1, principalId: expect.any(String) });
    expect(moment!.payload).toMatchObject({ payloadAfterBlobSha256: sha256(one), payloadAfterByteLength: bytes(one) });
    expect(Buffer.from(r.storage.getBlob(WORKSPACE, sha256(one))!).toString()).toBe(one);
    expect(ledger(r)).toEqual([{
      grant_id: LINK_GRANT, author_kind: "link", user_id: null, principal_id: author.principalId, grant_generation: 1,
    }]);
    // Nothing about the capability or the profile reaches the owner's log.
    expect(JSON.stringify(moment)).not.toContain(PROFILE);
    expect(JSON.stringify(moment)).not.toContain(hashLinkBearer(TOKEN, LINK_KEY));

    // The owner reads the link's writes, for stop and restore.
    const owned = await r.h(request(OWNER, `/sync/${WORKSPACE}/collection-writes/${LINK_GRANT}`));
    expect(await json(owned)).toMatchObject({ writes: [{ submitId: "submit-1", files: [{ path: `${PACKING}/automations.yaml`, created: true }] }] });
  });

  it("answers a retry from its receipt, and a submit id another browser or payload reuses with a conflict", async () => {
    const r = await linkRelay();
    const one = automations(STAMP);
    const changes = [linkCreate(`${PACKING}/automations.yaml`, one)];
    const first = await json(await linkWrite(r, changes));
    // The same browser in another session is the same principal.
    const retried = await linkWrite(r, changes, { token: OTHER_TOKEN });
    expect(await json(retried)).toEqual({ ...first, created: false });
    expect((await r.owner.directMoments()).length).toBe(1);
    // Another browser, with a session of its own, reusing the submit id.
    await expectCode(await linkWrite(r, changes, { token: OTHER_TOKEN, profile: OTHER_PROFILE }), 409, "conflict");
    // A session already bound to one browser answers for no other.
    await expectOpaque(await linkWrite(r, changes, { profile: OTHER_PROFILE }));
    await expectCode(await linkWrite(r, [linkCreate(`${PACKING}/automations.yaml`, automations(STAMP, STAMP.replace("stamp", "other")))]), 409, "conflict");
    expect((await r.owner.directMoments()).length).toBe(1);
  });

  it.each(["view", "comment"] as const)("refuses a %s link as a missing share, enrolling nobody", async (access) => {
    const r = await linkRelay({ access });
    await expectOpaque(await linkWrite(r, [linkCreate(`${PACKING}/automations.yaml`, automations(STAMP))]));
    expect(await r.owner.directMoments()).toEqual([]);
    expect(principals(r)).toBe(0);
  });

  it("keeps missing or bad credentials opaque even for a malformed write", async () => {
    const r = await linkRelay();
    for (const authorization of ["", "LinkCapability short", `LinkCapability ${"z".repeat(43)}`]) {
      await expectOpaque(await r.h(request(null, "/sync/link/collection-writes", {
        method: "POST", headers: { authorization, "content-type": "application/json", "x-dohc-link-profile-secret": PROFILE }, body: "{",
      })));
    }
    await expectOpaque(await linkWrite(r, null, { headers: { "x-dohc-link-profile-secret": "" }, body: "{" }));
  });

  it("keeps a mismatched profile opaque before body validation or rate admission", async () => {
    const r = await linkRelay({ overrides: { collectionWriteRateLimiter: new TokenBucketLimiter(1, 0.001, 10) } });
    expect((await linkWrite(r, [linkCreate(`${PACKING}/automations.yaml`, automations(STAMP))])).status).toBe(200);
    await expectOpaque(await linkWrite(r, null, { profile: OTHER_PROFILE, body: "{" }));
    await expectOpaque(await linkWrite(r, null, { profile: OTHER_PROFILE, headers: { "content-type": "text/plain" } }));
  });

  it("keeps paths outside the share opaque before rejecting content", async () => {
    const r = await linkRelay();
    for (const change of [
      linkCreate("private/automations.yaml", "invalid content"),
      { ...linkCreate(`${PACKING}/automations.yaml`, "invalid content"), basedOnPath: "private/automations.yaml" },
    ]) {
      await expectOpaque(await linkWrite(r, [change]));
    }
    expect(principals(r)).toBe(0);
  });

  it("preserves verified reasons through both relay normalizers and the response guard", async () => {
    const r = await linkRelay();
    const guarded = guardRelayResponses(r.storage, r.h);
    // main.ts normalizes again after the guard wraps the application's response.
    r.h = Object.assign(async (request: Request) => normalizeLinkRefusal(
      await guarded(request), new URL(request.url).pathname,
    ), r.h);
    const malformed = await linkWrite(r, null, { body: "{" });
    expect(await expectCode(malformed, 400, "bad_request")).toMatchObject({ error: "request body must be valid JSON" });
    const changes = [
      { ...linkCreate(`${PACKING}/automations.yaml`, automations(STAMP)), author: { kind: "named", userId: OWNER } },
    ];
    const response = await linkWrite(r, changes);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await expectCode(response, 403, "share_op_rejected")).toEqual({ ok: false, code: "share_op_rejected", error: "an op is outside this share" });
    await expectOpaque(await linkWrite(r, changes, { token: "z".repeat(43) }));
    await expectOpaque(await linkWrite(r, changes, { profile: "short" }));
    await expectOpaque(await linkWrite(r, [linkCreate("private/automations.yaml", "invalid content")]));
  });

  it("rejects too many changes before walking their scope", async () => {
    const r = await linkRelay();
    const changes = Array.from({ length: MAX_NEW_COLLECTION_RECORDS + 3 }, () =>
      linkCreate("private/automations.yaml", "invalid content"));
    expect(await expectCode(await linkWrite(r, changes), 403, "share_op_rejected"))
      .toEqual({ ok: false, code: "share_op_rejected", error: "an op is outside this share" });
    expect(principals(r)).toBe(0);
    expect(await r.owner.directMoments()).toEqual([]);
  });

  it("refuses without the Edit release, with an account cookie, with a bad profile, or with authority in the query", async () => {
    const closed = await linkRelay({ overrides: { publicEditRelease: undefined } });
    const changes = [linkCreate(`${PACKING}/automations.yaml`, automations(STAMP))];
    await expectOpaque(await linkWrite(closed, changes));
    const r = await linkRelay();
    await expectOpaque(await linkWrite(r, changes, { headers: { cookie: "session=ana" } }));
    await expectOpaque(await linkWrite(r, changes, { profile: "short" }));
    const query = await r.h(linkRequest(TOKEN, `/sync/link/collection-writes?shareId=${r.shareId}`, {
      method: "POST", headers: { "content-type": "application/json", "x-dohc-link-profile-secret": PROFILE },
      body: JSON.stringify({ submitId: "submit-1", changes }),
    }));
    await expectOpaque(query);
    expect(await r.owner.directMoments()).toEqual([]);
  });

  it.each([
    ["the link is revoked", (r: Relay) => { expect(r.storage.revokeShareGrant({ shareId: r.shareId, grantId: LINK_GRANT, revokedAtMs: CLOCK }).ok).toBe(true); }],
    ["the link was rotated", (r: Relay) => sql(r, `UPDATE sync_relay_share_grants SET generation = 2 WHERE grant_id = '${LINK_GRANT}'`)],
    ["the session expired", (r: Relay) => sql(r, `UPDATE sync_relay_link_sessions SET expires_at_ms = ${CLOCK}`)],
    ["the link was narrowed to View", (r: Relay) => sql(r, `UPDATE sync_relay_share_grants SET access = 'view' WHERE grant_id = '${LINK_GRANT}'`)],
    ["the owner paused link writes", (r: Relay) => sql(r, `UPDATE sync_relay_shares SET link_writes_paused_at_ms = 1 WHERE share_id = '${r.shareId}'`)],
    ["the owner blocked this browser", (r: Relay) => sql(r, "UPDATE sync_relay_link_principals SET blocked_at_ms = 1")],
  ] as const)("refuses a write and its retry once %s", async (_case, change) => {
    const r = await linkRelay();
    const one = automations(STAMP);
    expect((await linkWrite(r, [linkCreate(`${PACKING}/automations.yaml`, one)])).status).toBe(200);
    change(r);
    const two = automations(STAMP.replace("Packed", "Ready"));
    const next = [linkEdit(`${PACKING}/automations.yaml`, one, two)];
    await expectOpaque(await linkWrite(r, next, { submitId: "submit-2" }));
    await expectOpaque(await linkWrite(r, null, { body: "{" }));
    // A retry of the write that landed learns nothing either.
    await expectOpaque(await linkWrite(r, [linkCreate(`${PACKING}/automations.yaml`, one)]));
    expect((await r.owner.directMoments()).length).toBe(1);
  });

  it("refuses a write whose link is revoked inside the write, after the route read its capability", async () => {
    const r = await linkRelay();
    const one = automations(STAMP);
    const decision = filterCollectionWriteForShare(
      { versionId: null, paths: ["trip"], access: "edit" },
      [{ ...linkCreate(`${PACKING}/automations.yaml`, one), afterContentBase64: undefined, afterBlobSha256: sha256(one), afterByteLength: bytes(one) }],
    );
    if (!decision.allowed) throw new Error("expected the write to be allowed");
    expect(r.storage.revokeShareGrant({ shareId: r.shareId, grantId: LINK_GRANT, revokedAtMs: CLOCK }).ok).toBe(true);
    expect(() => r.storage.commitCollectionWrite({
      shareId: r.shareId, grantId: LINK_GRANT, grantGeneration: 1,
      writer: {
        kind: "link", capabilityHash: hashLinkBearer(TOKEN, LINK_KEY), profileTokenHash: "profile-hash",
        content: new Map([[sha256(one), Buffer.from(one)]]), now: () => CLOCK,
      },
      submitId: "submit-1", rawChanges: decision.write.kind === "automations" ? [decision.write.change] : [], write: decision.write,
      nowMs: CLOCK, newId: () => "id",
    })).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(await r.owner.directMoments()).toEqual([]);
    expect(principals(r)).toBe(0);
    expect(r.storage.getBlob(WORKSPACE, sha256(one))).toBeNull();
  });

  it("refuses a write whose link is revoked while its body streams in, storing nothing", async () => {
    const r = await linkRelay();
    const one = automations(STAMP);
    const body = new TextEncoder().encode(JSON.stringify({ submitId: "submit-1", changes: [linkCreate(`${PACKING}/automations.yaml`, one)] }));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        expect(r.storage.revokeShareGrant({ shareId: r.shareId, grantId: LINK_GRANT, revokedAtMs: CLOCK }).ok).toBe(true);
        controller.enqueue(body);
        controller.close();
      },
    });
    await expectOpaque(await linkWrite(r, null, { body: stream }));
    expect(await r.owner.directMoments()).toEqual([]);
    expect(r.storage.getBlob(WORKSPACE, sha256(one))).toBeNull();
  });

  it("keeps a body error opaque when the link is revoked while streaming", async () => {
    const r = await linkRelay();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        expect(r.storage.revokeShareGrant({ shareId: r.shareId, grantId: LINK_GRANT, revokedAtMs: CLOCK }).ok).toBe(true);
        controller.enqueue(new TextEncoder().encode("{"));
        controller.close();
      },
    });
    await expectOpaque(await linkWrite(r, null, { body: stream }));
  });

  it.each([
    ["names a hash of its own", { afterBlobSha256: sha256("x") }],
    ["names a size of its own", { afterByteLength: 3 }],
    ["sends base64 that is not canonical", { afterContentBase64: "YQ=" }],
    ["sends base64 with a character outside it", { afterContentBase64: "YW*j" }],
    ["sends no content", { afterContentBase64: undefined }],
    ["names an author", { author: { kind: "named", userId: "ana" } }],
  ])("refuses a change that %s", async (_case, patch) => {
    const r = await linkRelay();
    const change = { ...linkCreate(`${PACKING}/automations.yaml`, automations(STAMP)), ...patch };
    await expectCode(await linkWrite(r, [JSON.parse(JSON.stringify(change))]), 403, "share_op_rejected");
    expect(await r.owner.directMoments()).toEqual([]);
  });

  it("refuses content the shared parsers refuse, and text that is not UTF-8", async () => {
    const r = await linkRelay();
    expect(await expectCode(await linkWrite(r, [linkCreate(`${PACKING}/automations.yaml`, "version: 1\nautomations: nope\n")]), 403, "share_op_rejected"))
      .toMatchObject({ error: `${PACKING}/automations.yaml has an automation that is not valid` });
    await expectCode(await linkWrite(r, [linkEdit(`${PACKING}/collection.yaml`, SCHEMA, "fields: [\n")]), 403, "share_op_rejected");
    const notText = { ...linkCreate(`${PACKING}/automations.yaml`, ""), afterContentBase64: Buffer.from([0xff, 0xfe, 0x00]).toString("base64") };
    await expectCode(await linkWrite(r, [notText]), 403, "share_op_rejected");
    // A personal step stays on the named lane's rule too.
    await expectCode(await linkWrite(r, [linkCreate(`${PACKING}/automations.yaml`, automations(NUDGE))]), 403, "share_op_rejected");
    expect(await r.owner.directMoments()).toEqual([]);
  });

  it("refuses authority fields beside the write, storing and enrolling nothing", async () => {
    const r = await linkRelay();
    const one = automations(STAMP);
    for (const [key, value] of [
      ["workspaceId", "workspace-b"], ["grantId", "grant-other"], ["userId", RECIPIENT],
      ["principalId", "someone"], ["author", { kind: "named", userId: RECIPIENT }],
    ] as const) {
      const response = await linkWrite(r, null, {
        body: JSON.stringify({ submitId: "submit-1", changes: [linkCreate(`${PACKING}/automations.yaml`, one)], [key]: value }),
      });
      await expectCode(response, 403, "share_op_rejected");
    }
    expect(await r.owner.directMoments()).toEqual([]);
    expect(principals(r)).toBe(0);
    expect(r.storage.getBlob(WORKSPACE, sha256(one))).toBeNull();
  });

  it("refuses a session that expires while the write waits, reading the clock inside the write", async () => {
    let now = CLOCK;
    const r = await linkRelay({ overrides: { nowMs: () => now } });
    sql(r, `UPDATE sync_relay_link_sessions SET expires_at_ms = ${CLOCK + 1}`);
    const one = automations(STAMP);
    const decision = filterCollectionWriteForShare(
      { versionId: null, paths: ["trip"], access: "edit" },
      [{ ...linkCreate(`${PACKING}/automations.yaml`, one), afterContentBase64: undefined, afterBlobSha256: sha256(one), afterByteLength: bytes(one) }],
    );
    if (!decision.allowed) throw new Error("expected the write to be allowed");
    now = CLOCK + 1;
    expect(() => r.storage.commitCollectionWrite({
      shareId: r.shareId, grantId: LINK_GRANT, grantGeneration: 1,
      writer: {
        kind: "link", capabilityHash: hashLinkBearer(TOKEN, LINK_KEY), profileTokenHash: "profile-hash",
        content: new Map([[sha256(one), Buffer.from(one)]]), now: () => now,
      },
      submitId: "submit-1", rawChanges: decision.write.kind === "automations" ? [decision.write.change] : [], write: decision.write,
      // Sampled before the write waited.
      nowMs: CLOCK, newId: () => "id",
    })).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(await r.owner.directMoments()).toEqual([]);
  });

  it("tells a guessed base apart from no other: any base that is not the current file is stale", async () => {
    const r = await linkRelay();
    const one = automations(STAMP);
    await r.owner.write("object-automations", `${PACKING}/automations.yaml`, one);
    // Private content the link cannot read, stored in the same workspace.
    const hidden = automations(STAMP.replace("stamp", "hidden"));
    await r.owner.write("object-hidden", "budget/automations.yaml", hidden);
    const after = automations(STAMP.replace("Packed", "Ready"));
    const answers = [];
    for (const guess of [hidden, "never stored"]) {
      const response = await linkWrite(r, [linkEdit(`${PACKING}/automations.yaml`, guess, after)], { submitId: `guess-${answers.length}` });
      answers.push({ status: response.status, body: await json(response) });
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toMatchObject({ status: 409, body: { code: "stale", currentBlobSha256: sha256(one) } });
    expect(await r.owner.directMoments()).toEqual([]);
  });

  it("answers a retried automations edit from its receipt, for a link and for a named recipient", async () => {
    const r = await linkRelay();
    const one = automations(STAMP);
    const two = automations(STAMP.replace("Packed", "Ready"));
    await r.owner.write("object-automations", `${PACKING}/automations.yaml`, one);
    const changes = [linkEdit(`${PACKING}/automations.yaml`, one, two)];
    const first = await json(await linkWrite(r, changes));
    expect(first).toMatchObject({ ok: true, created: true });
    expect(await json(await linkWrite(r, changes))).toEqual({ ...first, created: false });

    const named = await relay();
    await named.owner.write("object-automations", `${PACKING}/automations.yaml`, one);
    await upload(named, two);
    const edits = [edit(`${PACKING}/automations.yaml`, one, two)];
    const landed = await json(await write(named, edits));
    expect(landed).toMatchObject({ ok: true, created: true });
    expect(await json(await write(named, edits))).toEqual({ ...landed, created: false });
  });

  it("says nothing about the current automations to a link revoked while its body streams", async () => {
    const r = await linkRelay();
    const one = automations(STAMP);
    await r.owner.write("object-automations", `${PACKING}/automations.yaml`, one);
    const body = new TextEncoder().encode(JSON.stringify({
      submitId: "submit-1", changes: [linkEdit(`${PACKING}/automations.yaml`, "a guess", automations(STAMP.replace("Packed", "Ready")))],
    }));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        expect(r.storage.revokeShareGrant({ shareId: r.shareId, grantId: LINK_GRANT, revokedAtMs: CLOCK }).ok).toBe(true);
        controller.enqueue(body);
        controller.close();
      },
    });
    const response = await linkWrite(r, null, { body: stream });
    await expectOpaque(response);

    // Nor whether a guessed base is current, through a content refusal.
    const current = await linkRelay();
    await current.owner.write("object-automations", `${PACKING}/automations.yaml`, one);
    for (const base of [one, "a guess"]) {
      const personal = new TextEncoder().encode(JSON.stringify({
        submitId: `personal-${base.length}`, changes: [linkEdit(`${PACKING}/automations.yaml`, base, automations(STAMP, NUDGE))],
      }));
      let revoked = false;
      const streamed = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!revoked) {
            expect(current.storage.revokeShareGrant({ shareId: current.shareId, grantId: LINK_GRANT, revokedAtMs: CLOCK }).ok).toBe(true);
            revoked = true;
          }
          controller.enqueue(personal);
          controller.close();
        },
      });
      await expectOpaque(await linkWrite(current, null, { body: streamed }));
      // Seed the link again for the next guess.
      sql(current, `UPDATE sync_relay_share_grants SET status = 'active', revoked_at_ms = NULL, generation = 1 WHERE grant_id = '${LINK_GRANT}'`);
    }
  });

  it("answers a stale base with the current file, writing nothing", async () => {
    const r = await linkRelay();
    const stale = await linkWrite(r, [linkEdit(`${PACKING}/collection.yaml`, SCHEMA_TWO, SCHEMA)]);
    expect(await expectCode(stale, 409, "stale")).toMatchObject({ path: `${PACKING}/collection.yaml`, currentBlobSha256: sha256(SCHEMA) });
    expect(await r.owner.directMoments()).toEqual([]);
  });

  it("refuses an envelope past its bound before reading it", async () => {
    const r = await linkRelay();
    const response = await linkWrite(r, [], { headers: { "content-length": String(MAX_LINK_COLLECTION_WRITE_BODY_BYTES + 1) } });
    await expectCode(response, 413, "payload_too_large");
  });

  it("spends one bucket for every browser of a link, before reading the body", async () => {
    const r = await linkRelay({ overrides: { collectionWriteRateLimiter: new TokenBucketLimiter(1, 0.001, 10) } });
    expect((await linkWrite(r, [linkCreate(`${PACKING}/automations.yaml`, automations(STAMP))])).status).toBe(200);
    await expectCode(await linkWrite(r, "not even changes", { token: OTHER_TOKEN, profile: OTHER_PROFILE, submitId: "submit-2" }), 429, "collection_write_rate_limited");
  });

  it("holds one body per link in memory at a time", async () => {
    const r = await linkRelay();
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const body = new TextEncoder().encode(JSON.stringify({ submitId: "submit-1", changes: [linkCreate(`${PACKING}/automations.yaml`, automations(STAMP))] }));
    const slow = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await held;
        controller.enqueue(body);
        controller.close();
      },
    });
    const first = linkWrite(r, null, { body: slow });
    await expectCode(await linkWrite(r, [], { token: OTHER_TOKEN, submitId: "submit-2" }), 429, "collection_write_rate_limited");
    finish();
    expect((await first).status).toBe(200);
  });

  it("counts a link's content and new browser against the workspace quota, and stores nothing past it", async () => {
    const r = await linkRelay({ storage: { workspaceQuotaBytes: 4096 } });
    const big = automations(STAMP) + "# " + "x".repeat(8192) + "\n";
    const response = await linkWrite(r, [linkCreate(`${PACKING}/automations.yaml`, big)]);
    expect(response.status).toBe(413);
    expect(principals(r)).toBe(0);
    expect(r.storage.getBlob(WORKSPACE, sha256(big))).toBeNull();
    expect(await r.owner.directMoments()).toEqual([]);
  });

  it("streams its body instead of the adapter buffering it", () => {
    expect(streamsRequestBody(new URL("http://relay.test/sync/link/collection-writes"), "POST")).toBe(true);
  });
});
