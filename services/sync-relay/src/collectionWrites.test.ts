import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";
import { MAX_COLLECTION_WRITE_BODY_BYTES, readCollectionWritesConfig } from "./collectionWriteRoutes";
import { pathCollisionKey } from "./pathCollisionKey";
import type { SyncRelayHandler } from "./server";
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
  const h = testHandler(storage, { nowMs: () => CLOCK, collectionWritesEnabled: true, ...options.overrides });
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
  private readonly contents = new Map<string, string>();

  constructor(private readonly h: SyncRelayHandler) {}

  async write(objectId: string, path: string, text: string): Promise<string> {
    const blobSha256 = await putBlob(this.h, OWNER, WORKSPACE, text);
    const originSeq = this.seq++;
    const momentId = `owner-moment-${originSeq}`;
    const previous = this.contents.get(path);
    const before = previous === undefined
      ? { payloadBeforeBlobSha256: null, payloadBeforePath: null, beforePresent: "null" }
      : {
          payloadBeforeBlobSha256: sha256(previous),
          payloadBeforePath: path,
          payloadBeforeContentKind: "text",
          beforePresent: "present",
          beforeObjectId: objectId,
          beforePath: path,
          beforeBlobSha256: sha256(previous),
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
          payloadAfterContentKind: "text",
          payloadAfterByteLength: new TextEncoder().encode(text).byteLength,
          metadata: { origin: "user" },
          ...before,
        },
      }],
    })));
    expect(response.status, await response.clone().text()).toBe(200);
    this.moments.set(path, momentId);
    this.contents.set(path, text);
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
  it("are off unless the deployment opts in", async () => {
    const r = await relay({ overrides: { collectionWritesEnabled: undefined } });
    await upload(r, SCHEMA_TWO);
    await expectCode(await write(r, [edit(`${PACKING}/collection.yaml`, SCHEMA, SCHEMA_TWO)]), 404, "not_found");
    expect(await r.owner.directMoments()).toEqual([]);

    expect(readCollectionWritesConfig(undefined)).toBe(false);
    expect(readCollectionWritesConfig("0")).toBe(false);
    expect(readCollectionWritesConfig("1")).toBe(true);
    expect(() => readCollectionWritesConfig("yes")).toThrow("DOHC_RELAY_COLLECTION_WRITES must be 0 or 1.");
  });

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
      author: { kind: "named", userId: RECIPIENT, grantId: r.grantId, grantGeneration: 1 },
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
          metadata: { origin: "user" }, beforePresent: "null", ...(author ? { author } : {}),
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
    const h = testHandler(reopened, { nowMs: () => CLOCK, collectionWritesEnabled: true });
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
