import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { generateDatasetOperations } from "@dohc/security-contract/dataset-operations";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { UnauthorizedError, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import { createAccountFeedWaits } from "./accountFeed";
import { createAccountOperationRoute } from "./accountOperationRoutes";
import { createChatWakeWaits } from "./chatWakeRoutes";
import { createRelayDatasetHost, type RelayDatasetHost } from "./datasetHost";
import { fixture as baseFixture, limits, owner, pushFile } from "./datasetTestFixture";
import { DiscussionActivityHub } from "./discussionActivity";
import { errorResponse } from "./errors";
import { createPhoneCollections, PHONE_COLLECTION_PAGE } from "./phoneCollections";
import type { SyncRelayStorage } from "./storage";
import { fenceAccount, initializeAccountDeletion } from "./storage/accountDeletion";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DATASET = id(1),
  PEOPLE = id(2),
  KEY = id(3),
  NAME = id(4),
  PAID = id(5),
  BUTTON = id(6),
  CREATE = id(7),
  READ = id(8),
  NOTES = id(9),
  TEXT = id(10),
  NOTE_KEY = id(11),
  ADD_NOTE = id(12),
  EMAIL = id(13),
  RECEIPT = id(14),
  OTHER = id(15);
const definition: DatasetDefinition = {
  formatVersion: 1,
  datasetId: DATASET,
  name: "Registrations",
  schemaPath: "registrations/schema.sql",
  operationsPath: "registrations/operations.js",
  tables: [
    {
      tableId: PEOPLE,
      name: "People",
      sqlName: "people",
      primaryKey: "id",
      fields: [
        { fieldId: KEY, name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
        {
          fieldId: NAME,
          name: "Name",
          sqlColumn: "name",
          type: "text",
          required: true,
          unique: false,
        },
        {
          fieldId: PAID,
          name: "Paid",
          sqlColumn: "paid",
          type: "checkbox",
          required: false,
          unique: false,
        },
        // The read leaves it out.
        {
          fieldId: EMAIL,
          name: "Email",
          sqlColumn: "email",
          type: "text",
          required: false,
          unique: false,
        },
        {
          fieldId: RECEIPT,
          name: "Receipt",
          sqlColumn: "receipt",
          type: "attachment",
          required: false,
          unique: false,
        },
        { fieldId: BUTTON, name: "Remind", type: "button" },
      ],
    },
    {
      tableId: NOTES,
      name: "Notes",
      sqlName: "notes",
      primaryKey: "id",
      fields: [
        {
          fieldId: NOTE_KEY,
          name: "ID",
          sqlColumn: "id",
          type: "text",
          required: true,
          unique: true,
        },
        {
          fieldId: TEXT,
          name: "Text",
          sqlColumn: "text",
          type: "text",
          required: true,
          unique: false,
        },
      ],
    },
  ],
  operations: [
    {
      operationId: CREATE,
      name: "create",
      label: "Create",
      tableId: PEOPLE,
      kind: "create",
      access: "owner",
      readOnly: false,
      fieldIds: [KEY, NAME, PAID, EMAIL, RECEIPT],
    },
    {
      operationId: READ,
      name: "read",
      label: "Read",
      tableId: PEOPLE,
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [KEY, NAME, PAID, RECEIPT],
    },
    // Notes take records but have no read.
    {
      operationId: ADD_NOTE,
      name: "addNote",
      label: "Add note",
      tableId: NOTES,
      kind: "create",
      access: "owner",
      readOnly: false,
      fieldIds: [NOTE_KEY, TEXT],
    },
  ],
};
const schemaSql = `CREATE TABLE people(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,paid INTEGER,email TEXT,receipt TEXT,"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;
CREATE TABLE notes(id TEXT PRIMARY KEY NOT NULL,text TEXT NOT NULL,"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;`;
const operationSource = generateDatasetOperations(definition);
const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
const scope = { workspaceId: "w", datasetId: DATASET };
const collectionFile = {
  path: "registrations/dataset.json",
  text: JSON.stringify({ datasetId: DATASET }),
};
/** `r00` to `r50`: one more than a page. */
const KEYS = Array.from(
  { length: PHONE_COLLECTION_PAGE + 1 },
  (_, n) => `r${String(n).padStart(2, "0")}`,
);

// `Bearer session:<user>:<session>:<kind>`, refused once the session is revoked.
const revoked = new Set<string>();
const resolveAccountSession: ResolveAccountSession = async (request) => {
  const match = /^Bearer session:([\w-]+):([\w-]+):(phone|desktop)$/u.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match || revoked.has(match[2]!)) throw new UnauthorizedError();
  return {
    userId: match[1]!,
    sessionId: match[2]!,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    clientKind: match[3] as "phone" | "desktop",
  };
};

/** The owner's workspace `w` with Registrations and its records, behind the account route on a server with no copies. */
async function phone() {
  revoked.clear();
  const base = baseFixture(),
    directory = await mkdtemp(join(tmpdir(), "phone-collections-"));
  const host = await createRelayDatasetHost({
    publicEditRelease: undefined,
    storage: base.storage,
    directory,
    limits,
    onShutdownError: (error) => {
      throw error;
    },
  });
  cleanups.push(async () => {
    await host.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  });
  await host.activate(owner, {
    ...scope,
    revision,
    schemaSql,
    operationSource,
    capacityBytes: 1024 * 1024,
  });
  pushFile(base.storage, "dataset", null, collectionFile);
  for (const key of KEYS)
    await host.invoke(owner, {
      ...scope,
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationId: CREATE,
      input: {
        values: {
          [KEY]: key,
          [NAME]: `Person ${key}`,
          [PAID]: key === "r00",
          [EMAIL]: `${key}@example.com`,
        },
      },
      idempotencyKey: key,
    });
  const storage = base.storage as SyncRelayStorage;
  // What the host does when it reads, which a test can add to.
  let during: () => void = () => undefined;
  const reading: Pick<RelayDatasetHost, "list" | "describe" | "invoke"> = {
    list: host.list,
    describe: host.describe,
    invoke: async (auth, input) => {
      during();
      const answer = await host.invoke(auth, input);
      during();
      return answer;
    },
  };
  const hub = new DiscussionActivityHub();
  const route = createAccountOperationRoute({
    storage,
    resolveAccountSession,
    copies: () => undefined,
    nowMs: () => 2_000,
    limiter: new TokenBucketLimiter(1_000, 1_000, 4_096),
    feedWaits: createAccountFeedWaits(storage, hub),
    wakeWaits: createChatWakeWaits(storage, hub),
    phoneCollections: createPhoneCollections({ storage, host: reading }),
  });
  /** One Collection operation as `user:session:kind`, answered with its status and body. */
  async function op(operation: string, args: unknown, as = "owner:phone-1:phone") {
    const response = await route(
      new Request(`http://relay.test/sync/w/ops/${operation}`, {
        method: "POST",
        headers: { authorization: `Bearer session:${as}`, "content-type": "application/json" },
        body: JSON.stringify(args),
      }),
      { route: "account-operation", workspaceId: "w", operation },
    ).catch((error: unknown) => errorResponse(error));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  return {
    storage: base.storage,
    showOnPhone: (showOnPhone: boolean) =>
      storage.setShowOnPhone({ ownerUserId: "owner", workspaceId: "w", showOnPhone }),
    host,
    op,
    records: (after?: unknown, as?: string) =>
      op(
        "collectionRecords",
        { datasetId: DATASET, tableId: PEOPLE, ...(after ? { after } : {}) },
        as,
      ),
    during: (run: () => void) => {
      during = run;
    },
  };
}

const ok = (result: unknown) => ({ status: 200, body: { ok: true, result } });
const notFound = { status: 404, body: expect.objectContaining({ ok: false, code: "not_found" }) };
const rowKeys = (answer: { body: Record<string, unknown> }) =>
  ((answer.body.result as { rows: { id: string }[] }).rows ?? []).map((row) => row.id);

it("lists, describes, and reads a Collection's records a page at a time", async () => {
  const f = await phone();
  expect(await f.op("collections", {})).toEqual(
    ok({ collections: [{ datasetId: DATASET, name: "Registrations" }], nextCursor: null }),
  );
  // Names, IDs, types and the primary field of what each table's read gives; never a button, a column, or an operation.
  expect(await f.op("collection", { datasetId: DATASET })).toEqual(
    ok({
      datasetId: DATASET,
      name: "Registrations",
      tables: [
        {
          tableId: PEOPLE,
          name: "People",
          primaryFieldId: KEY,
          fields: [
            { fieldId: KEY, name: "ID", type: "text" },
            { fieldId: NAME, name: "Name", type: "text" },
            { fieldId: PAID, name: "Paid", type: "checkbox" },
            { fieldId: RECEIPT, name: "Receipt", type: "attachment" },
          ],
        },
        { tableId: NOTES, name: "Notes", primaryFieldId: null, fields: [] },
      ],
    }),
  );
  const first = await f.records();
  expect(first.status).toBe(200);
  expect(first.body.result).toMatchObject({
    status: "ready",
    nextCursor: { id: "r49", value: "r49" },
    files: {},
  });
  expect(rowKeys(first)).toEqual(KEYS.slice(0, PHONE_COLLECTION_PAGE));
  expect((first.body.result as { rows: unknown[] }).rows[0]).toEqual({
    id: "r00",
    version: 1,
    values: { [KEY]: "r00", [NAME]: "Person r00", [PAID]: true, [RECEIPT]: null },
  });
  const next = await f.records({ id: "r49", value: "r49" });
  expect(rowKeys(next)).toEqual(["r50"]);
  expect(next.body.result).toMatchObject({ status: "ready", nextCursor: null });
});

it("names a page's attached files, but not one still waiting to attach or another Collection's", async () => {
  const f = await phone();
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  const files = ["kept.png", "pending.png", "moved.png"].map(
    (name, n) =>
      f.host.ownerUpload(owner, {
        ...scope,
        revision: 1,
        revisionSha256: revision.revisionSha256,
        idempotencyKey: `upload-${name}`,
        name,
        contentType: "image/png",
        bytesBase64: Buffer.from([...png, n]).toString("base64"),
      }).file.fileId,
  );
  for (const [n, fileId] of files.entries())
    await f.host.invoke(owner, {
      ...scope,
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationId: CREATE,
      input: { values: { [KEY]: `f${n}`, [NAME]: `File ${n}`, [RECEIPT]: fileId } },
      idempotencyKey: `f${n}`,
    });
  const [kept, pending, moved] = files as [string, string, string];
  // As if `pending` hadn't attached yet, and `moved` were another Collection's.
  const db = f.storage.db;
  db.prepare("UPDATE sync_relay_dataset_files SET attached_revision=NULL WHERE file_id=?").run(
    pending,
  );
  db.prepare("INSERT INTO sync_relay_dataset_usage VALUES ('w',?,0)").run(OTHER);
  db.prepare("UPDATE sync_relay_dataset_files SET dataset_id=? WHERE file_id=?").run(OTHER, moved);
  const answer = await f.records();
  expect(rowKeys(answer).slice(0, 3)).toEqual(["f0", "f1", "f2"]);
  expect((answer.body.result as { files: unknown }).files).toEqual({ [kept]: "kept.png" });
});

it("answers a table with no read with a refusal the phone can show", async () => {
  const f = await phone();
  expect(await f.op("collectionRecords", { datasetId: DATASET, tableId: NOTES })).toEqual(
    ok({ status: "refused", reason: "no-read" }),
  );
});

it("leaves out an archived Collection, and one whose dataset.json is hidden or gone, and answers each as not found", async () => {
  const absent = async (f: Awaited<ReturnType<typeof phone>>) => {
    expect(await f.op("collections", {})).toEqual(ok({ collections: [], nextCursor: null }));
    expect(await f.op("collection", { datasetId: DATASET })).toEqual(notFound);
    expect(await f.records()).toEqual(notFound);
  };
  const archived = await phone();
  archived.host.archiveDataset(owner, scope);
  await absent(archived);

  // Its folder moved under a hidden path, as a reader on this platform classifies it.
  const hidden = await phone();
  const db = hidden.storage.db;
  const sha = createHash("sha256").update(collectionFile.text).digest("hex");
  const seq = Number(db.prepare("SELECT MAX(relay_seq) AS seq FROM sync_relay_log").get()!.seq) + 1;
  db.prepare(
    "INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES ('w','test',1,'ydoc.update','{}',2,?)",
  ).run(seq);
  db.prepare("DELETE FROM sync_relay_current_files WHERE workspace_id='w' AND path=?").run(
    collectionFile.path,
  );
  db.prepare(
    "INSERT INTO sync_relay_current_files VALUES ('w','main','a/.env/dataset.json',?,'text',?)",
  ).run(sha, seq);
  db.prepare(
    `INSERT INTO sync_relay_object_moments(workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
     VALUES ('w','dataset',?,'moment-hidden','main','a/.env/dataset.json',?,'text',?,1)`,
  ).run(seq, sha, Buffer.byteLength(collectionFile.text));
  await absent(hidden);
  // A file naming no Collection, left where the moved one was, doesn't stand in for it.
  pushFile(hidden.storage, "stub", null, { path: collectionFile.path, text: "{}" });
  await absent(hidden);

  const gone = await phone();
  pushFile(gone.storage, "dataset", collectionFile, null);
  await absent(gone);
});

it("refuses another account, Show on phone off, a revoked sign-in and a fenced account", async () => {
  const f = await phone();
  for (const operation of ["collections", "collection", "collectionRecords"]) {
    const args = { datasetId: DATASET, tableId: PEOPLE };
    const only =
      operation === "collections" ? {} : operation === "collection" ? { datasetId: DATASET } : args;
    expect(await f.op(operation, only, "intruder:phone-2:phone")).toEqual(notFound);
  }
  f.showOnPhone(false);
  expect(await f.records()).toEqual(notFound);
  f.showOnPhone(true);
  revoked.add("phone-1");
  expect((await f.records()).status).toBe(401);
  revoked.clear();
  initializeAccountDeletion(f.storage, "k".repeat(32));
  fenceAccount(f.storage, "k".repeat(32), "owner", "owner@dohc.test");
  expect(await f.records()).toEqual(notFound);
});

it("refuses the answer when Show on phone turns off, the sign-in is revoked, the account is fenced, or the Collection is archived during a read", async () => {
  for (const change of ["hidden", "revoked", "fenced", "archived"] as const) {
    const f = await phone();
    let reads = 0;
    // After the host has read the records, before the relay answers.
    f.during(() => {
      if (++reads !== 2) return;
      if (change === "hidden") f.showOnPhone(false);
      else if (change === "revoked") revoked.add("phone-1");
      else if (change === "archived") f.host.archiveDataset(owner, scope);
      else {
        initializeAccountDeletion(f.storage, "k".repeat(32));
        fenceAccount(f.storage, "k".repeat(32), "owner", "owner@dohc.test");
      }
    });
    const answer = await f.records();
    expect(answer.status).toBe(change === "revoked" ? 401 : 404);
    expect(JSON.stringify(answer.body)).not.toContain("Person");
  }
  // Show on phone off as the read starts: the host's own check refuses it.
  const f = await phone();
  f.during(() => f.showOnPhone(false));
  expect(await f.records()).toEqual(notFound);
});

// As the phone's app reads (phoneApps.ts), any sign-in of the owner's reads them: a computer's too. An agent has no
// account sign-in to send, so the account route turns it away before any operation.
it("gives a computer's sign-in of the owner what it gives the phone", async () => {
  const f = await phone();
  expect(await f.op("collections", {}, "owner:desktop-1:desktop")).toEqual(
    await f.op("collections", {}),
  );
  expect(rowKeys(await f.records(undefined, "owner:desktop-1:desktop"))).toEqual(
    KEYS.slice(0, PHONE_COLLECTION_PAGE),
  );
});
