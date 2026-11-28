import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { generateDatasetOperations } from "@dohc/security-contract/dataset-operations";
import type { DatasetDefinition, DatasetDescription } from "@dohc/security-contract/dataset";
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
  OTHER = id(15),
  EDIT = id(16),
  REMOVE = id(17),
  GUESTS = id(18),
  GUEST_KEY = id(19),
  GUEST_NAME = id(20),
  GUEST_PAID = id(21),
  GUEST_STATUS = id(22),
  GUEST_READ = id(23),
  GUEST_CREATE = id(24),
  GUEST_REMOVE = id(25);
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
    // As the desktop makes a table: the host gives each record its key, so a new record can start with defaults.
    {
      tableId: GUESTS,
      name: "Guests",
      sqlName: "guests",
      primaryKey: "id",
      fields: [
        {
          fieldId: GUEST_KEY,
          name: "Record ID",
          sqlColumn: "id",
          type: "text",
          required: true,
          unique: true,
          generated: "record-id",
        },
        {
          fieldId: GUEST_NAME,
          name: "Name",
          sqlColumn: "name",
          type: "text",
          required: false,
          unique: false,
        },
        {
          fieldId: GUEST_PAID,
          name: "Paid",
          sqlColumn: "paid",
          type: "checkbox",
          required: true,
          unique: false,
        },
        {
          fieldId: GUEST_STATUS,
          name: "Status",
          sqlColumn: "status",
          type: "select",
          required: true,
          unique: false,
          default: "Unpaid",
          options: ["Unpaid", "Paid"],
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
      access: "link",
      readOnly: true,
      fieldIds: [KEY, NAME, PAID, RECEIPT],
    },
    // It changes neither the ID nor the receipt.
    {
      operationId: EDIT,
      name: "edit",
      label: "Edit",
      tableId: PEOPLE,
      kind: "edit",
      access: "link",
      readOnly: false,
      fieldIds: [NAME, PAID],
      reversible: true,
    },
    {
      operationId: REMOVE,
      name: "remove",
      label: "Delete",
      tableId: PEOPLE,
      kind: "delete",
      access: "owner",
      readOnly: false,
      fieldIds: [],
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
    {
      operationId: GUEST_READ,
      name: "readGuests",
      label: "Read guests",
      tableId: GUESTS,
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [GUEST_KEY, GUEST_NAME, GUEST_PAID, GUEST_STATUS],
    },
    {
      operationId: GUEST_CREATE,
      name: "addGuest",
      label: "Add guest",
      tableId: GUESTS,
      kind: "create",
      access: "owner",
      readOnly: false,
      fieldIds: [GUEST_NAME, GUEST_PAID, GUEST_STATUS],
    },
    {
      operationId: GUEST_REMOVE,
      name: "removeGuest",
      label: "Delete guest",
      tableId: GUESTS,
      kind: "delete",
      access: "owner",
      readOnly: false,
      fieldIds: [],
    },
  ],
};
const schemaSql = `CREATE TABLE people(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,paid INTEGER,email TEXT,receipt TEXT,"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;
CREATE TABLE notes(id TEXT PRIMARY KEY NOT NULL,text TEXT NOT NULL,"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;
CREATE TABLE guests(id TEXT PRIMARY KEY NOT NULL,name TEXT,paid INTEGER NOT NULL,status TEXT NOT NULL,"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;`;
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
async function phone(keys = KEYS.slice(0, 2)) {
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
  for (const key of keys)
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
  // What the host does when it reads, which a test can add to, and how a test changes what it describes.
  let during: () => void = () => undefined;
  let describing = (description: DatasetDescription) => description;
  const reading: Pick<
    RelayDatasetHost,
    "list" | "describe" | "invoke" | "dataUpload" | "dataReadFile"
  > = {
    list: host.list,
    describe: (auth, input) => describing(host.describe(auth, input)),
    invoke: async (auth, input) => {
      during();
      const answer = await host.invoke(auth, input);
      during();
      return answer;
    },
    dataUpload: (auth, input, signal) => {
      during();
      return host.dataUpload(auth, input, signal);
    },
    dataReadFile: async (auth, input, signal) => {
      during();
      const answer = await host.dataReadFile(auth, input, signal);
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
  async function opRaw(operation: string, args: unknown, as = "owner:phone-1:phone") {
    return await route(
      new Request(`http://relay.test/sync/w/ops/${operation}`, {
        method: "POST",
        headers: { authorization: `Bearer session:${as}`, "content-type": "application/json" },
        body: JSON.stringify(args),
      }),
      { route: "account-operation", workspaceId: "w", operation },
    ).catch((error: unknown) => errorResponse(error));
  }
  /** One Collection operation as `user:session:kind`, answered with its status and body. */
  async function op(operation: string, args: unknown, as = "owner:phone-1:phone") {
    const response = await opRaw(operation, args, as);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  return {
    storage: base.storage,
    showOnPhone: (showOnPhone: boolean) =>
      storage.setShowOnPhone({ userId: "owner", workspaceId: "w", showOnPhone }),
    host,
    op,
    opRaw,
    records: (after?: unknown, as?: string) =>
      op(
        "collectionRecords",
        { datasetId: DATASET, tableId: PEOPLE, ...(after ? { after } : {}) },
        as,
      ),
    during: (run: () => void) => {
      during = run;
    },
    describing: (alter: typeof describing) => {
      describing = alter;
    },
  };
}

/** Moves the Collection's folder under a hidden path, as a reader on this platform classifies it. */
function hide(f: Awaited<ReturnType<typeof phone>>) {
  const db = f.storage.db;
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
}

const ok = (result: unknown) => ({ status: 200, body: { ok: true, result } });
const notFound = { status: 404, body: expect.objectContaining({ ok: false, code: "not_found" }) };
const rowKeys = (answer: { body: Record<string, unknown> }) =>
  ((answer.body.result as { rows: { id: string }[] }).rows ?? []).map((row) => row.id);

it("lists, describes, and reads a Collection's records a page at a time", async () => {
  const f = await phone(KEYS);
  expect(await f.op("collections", {})).toEqual(
    ok({ collections: [{ datasetId: DATASET, name: "Registrations" }], nextCursor: null }),
  );
  // Names, IDs, types and the primary field of what each table's read gives, and which an edit changes; never a
  // button, a column, or an operation.
  const field = (fieldId: string, name: string, type: string, edit = false) => ({
    fieldId,
    name,
    type,
    editable: edit,
    reversible: edit,
  });
  expect(await f.op("collection", { datasetId: DATASET })).toEqual(
    ok({
      datasetId: DATASET,
      name: "Registrations",
      revision: 1,
      revisionSha256: revision.revisionSha256,
      tables: [
        {
          tableId: PEOPLE,
          name: "People",
          primaryFieldId: KEY,
          fields: [
            field(KEY, "ID", "text"),
            field(NAME, "Name", "text", true),
            field(PAID, "Paid", "checkbox", true),
            field(RECEIPT, "Receipt", "attachment"),
          ],
          // Required and optional inputtable create fields (including write-only Email and attachment Receipt).
          createFields: [
            { fieldId: KEY, name: "ID", type: "text", required: true },
            { fieldId: NAME, name: "Name", type: "text", required: true },
            { fieldId: PAID, name: "Paid", type: "checkbox", required: false },
            { fieldId: EMAIL, name: "Email", type: "text", required: false },
            { fieldId: RECEIPT, name: "Receipt", type: "attachment", required: false },
          ],
          canCreate: true,
          canDelete: true,
        },
        {
          tableId: NOTES,
          name: "Notes",
          primaryFieldId: null,
          fields: [],
          createFields: [],
          canCreate: false,
          canDelete: false,
        },
        // The host's own record key isn't shown.
        {
          tableId: GUESTS,
          name: "Guests",
          primaryFieldId: null,
          fields: [
            field(GUEST_NAME, "Name", "text"),
            field(GUEST_PAID, "Paid", "checkbox"),
            { ...field(GUEST_STATUS, "Status", "select"), options: ["Unpaid", "Paid"] },
          ],
          createFields: [
            { fieldId: GUEST_NAME, name: "Name", type: "text", required: false },
            { fieldId: GUEST_PAID, name: "Paid", type: "checkbox", required: true },
            {
              fieldId: GUEST_STATUS,
              name: "Status",
              type: "select",
              required: true,
              default: "Unpaid",
              options: ["Unpaid", "Paid"],
            },
          ],
          canCreate: true,
          canDelete: true,
        },
      ],
    }),
  );
  const first = await f.records();
  expect(first.status).toBe(200);
  expect(first.body.result).toMatchObject({
    status: "ready",
    nextCursor: { id: "r49", value: "r49" },
    files: {},
    relations: {},
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

  const hidden = await phone();
  hide(hidden);
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
  const f = await phone(KEYS);
  expect(await f.op("collections", {}, "owner:desktop-1:desktop")).toEqual(
    await f.op("collections", {}),
  );
  expect(rowKeys(await f.records(undefined, "owner:desktop-1:desktop"))).toEqual(
    KEYS.slice(0, PHONE_COLLECTION_PAGE),
  );
});

/** One field's change to record `r01`, as the phone sends it. */
const edit = (
  f: Awaited<ReturnType<typeof phone>>,
  change: Record<string, unknown> = {},
  as?: string,
) =>
  f.op(
    "collectionEdit",
    {
      datasetId: DATASET,
      tableId: PEOPLE,
      recordId: "r01",
      fieldId: NAME,
      value: "Maya",
      expectedVersion: 1,
      revision: 1,
      revisionSha256: revision.revisionSha256,
      idempotencyKey: id(100),
      ...change,
    },
    as,
  );
/** Record `r01`, read again by its key. */
const r01 = async (f: Awaited<ReturnType<typeof phone>>) => {
  const answer = await f.op("collectionRecords", {
    datasetId: DATASET,
    tableId: PEOPLE,
    recordId: "r01",
  });
  expect(answer.status).toBe(200);
  const rows = (answer.body.result as { rows: { version: number; values: object }[] }).rows;
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

it("saves a field's change, replays its retry, and undoes it with the prior value", async () => {
  const f = await phone();
  expect(await edit(f)).toEqual(ok({ saved: { version: 2, priorValue: "Person r01" } }));
  expect(await r01(f)).toMatchObject({ version: 2, values: { [NAME]: "Maya" } });
  // The same key and stamp answer the same receipt, with no second version.
  expect(await edit(f)).toEqual(ok({ saved: { version: 2, priorValue: "Person r01" } }));
  expect((await r01(f)).version).toBe(2);
  // The same key with another payload: the phone never changes a change it resends, so the rules changed between tries.
  expect(await edit(f, { value: "Maya L." })).toEqual(ok({ rulesChanged: true }));
  expect(await r01(f)).toMatchObject({ version: 2, values: { [NAME]: "Maya" } });
  // Undo: the prior value at the saved version, with a new key.
  expect(
    await edit(f, { value: "Person r01", expectedVersion: 2, idempotencyKey: id(101) }),
  ).toEqual(ok({ saved: { version: 3, priorValue: "Maya" } }));
  expect(await r01(f)).toMatchObject({ version: 3, values: { [NAME]: "Person r01" } });
  // A checkbox takes a boolean, and an optional one null, which its Undo puts back.
  expect(
    await edit(f, { fieldId: PAID, value: null, expectedVersion: 3, idempotencyKey: id(102) }),
  ).toEqual(ok({ saved: { version: 4, priorValue: false } }));
  expect(
    await edit(f, { fieldId: PAID, value: true, expectedVersion: 4, idempotencyKey: id(103) }),
  ).toEqual(ok({ saved: { version: 5, priorValue: null } }));
  expect(
    await edit(f, { fieldId: PAID, value: null, expectedVersion: 5, idempotencyKey: id(104) }),
  ).toEqual(ok({ saved: { version: 6, priorValue: true } }));
});

it("answers a stale version with the record's refusal, and a field no edit changes before any invoke", async () => {
  const f = await phone();
  await edit(f);
  expect(await edit(f, { value: "Other", idempotencyKey: id(101) })).toEqual(
    ok({
      refused: {
        code: "stale_record",
        message: "This record changed. Refresh the table before editing it.",
      },
    }),
  );
  let invoked = 0;
  f.during(() => void invoked++);
  expect(await edit(f, { fieldId: KEY, value: "r99", idempotencyKey: id(102) })).toEqual(
    ok({
      refused: {
        code: "forbidden",
        message: "The Collection's rules no longer allow this change, so dohc did not save it.",
      },
    }),
  );
  // Nor does a key that isn't random.
  expect((await edit(f, { idempotencyKey: "r01-name" })).status).toBe(400);
  expect(invoked).toBe(0);
  // The operation refuses a value the field's type can't take.
  expect(
    await edit(f, { fieldId: PAID, value: "yes", expectedVersion: 2, idempotencyKey: id(103) }),
  ).toEqual(ok({ refused: { code: "invalid_input", message: "Check the fields and try again." } }));
  expect((await r01(f)).values).toMatchObject({ [NAME]: "Maya", [PAID]: false });
});

it("answers a change made under rules the Collection has replaced as rules changed", async () => {
  const f = await phone();
  const next = structuredClone(definition);
  next.operations.find((operation) => operation.operationId === EDIT)!.fieldIds.push(EMAIL);
  // Where the desktop puts a new revision, so the Collection's dataset.json stays in `registrations`.
  next.schemaPath = `registrations/revisions/2-${id(99)}/schema.sql`;
  next.operationsPath = `registrations/revisions/2-${id(99)}/operations.js`;
  const nextSource = generateDatasetOperations(next);
  const widened = describeDatasetRevision({
    definition: next,
    revision: 2,
    schemaSql,
    operationSource: nextSource,
  });
  const preview = await f.host.prepareMigration(owner, {
    workspaceId: "w",
    revision: widened,
    schemaSql,
    operationSource: nextSource,
    expected: f.host.approvedArtifacts(owner, scope).cursor,
    migrationSql: "SELECT 1;",
  });
  await f.host.approveMigration(owner, {
    ...scope,
    candidateId: preview.candidateId,
    checkpointSha256: preview.checkpointSha256,
  });
  expect(await edit(f)).toEqual(ok({ rulesChanged: true }));
  expect((await r01(f)).values).toMatchObject({ [NAME]: "Person r01" });
  // Under the new rules' stamp, the same change saves.
  const stamp = { revision: 2, revisionSha256: widened.revisionSha256 };
  expect(await edit(f, { ...stamp, idempotencyKey: id(101) })).toEqual(
    ok({ saved: { version: 2, priorValue: "Person r01" } }),
  );
  // The edit now changes Email too, but the read doesn't show it, so neither the description nor the edit offers it.
  let invoked = 0;
  f.during(() => void invoked++);
  expect(
    await edit(f, {
      ...stamp,
      fieldId: EMAIL,
      value: "maya@example.test",
      expectedVersion: 2,
      idempotencyKey: id(102),
    }),
  ).toEqual(
    ok({
      refused: {
        code: "forbidden",
        message: "The Collection's rules no longer allow this change, so dohc did not save it.",
      },
    }),
  );
  expect(invoked).toBe(0);
});

it("refuses a change from another account, with Show on phone off, a revoked sign-in, a fenced account, or an archived Collection", async () => {
  const f = await phone();
  expect(await edit(f, {}, "intruder:phone-2:phone")).toEqual(notFound);
  f.showOnPhone(false);
  expect(await edit(f)).toEqual(notFound);
  f.showOnPhone(true);
  revoked.add("phone-1");
  expect((await edit(f)).status).toBe(401);
  revoked.clear();
  expect((await r01(f)).version).toBe(1);
  initializeAccountDeletion(f.storage, "k".repeat(32));
  fenceAccount(f.storage, "k".repeat(32), "owner", "owner@dohc.test");
  expect(await edit(f)).toEqual(notFound);

  const archived = await phone();
  archived.host.archiveDataset(owner, scope);
  expect(await edit(archived)).toEqual(notFound);
});

it("refuses a change when Show on phone turns off or its dataset.json goes as it starts, and its answer when it turns off after it ran", async () => {
  const before = await phone();
  before.during(() => before.showOnPhone(false));
  expect(await edit(before)).toEqual(notFound);
  before.during(() => undefined);
  before.showOnPhone(true);
  expect((await r01(before)).version).toBe(1);

  // Its dataset.json gone as the edit starts: the edit's own guard refuses it, so nothing commits.
  const gone = await phone();
  gone.during(() => pushFile(gone.storage, "dataset", collectionFile, null));
  expect(await edit(gone)).toEqual(notFound);
  gone.during(() => undefined);
  pushFile(gone.storage, "dataset-again", null, collectionFile);
  expect((await r01(gone)).version).toBe(1);

  const after = await phone();
  let calls = 0;
  after.during(() => {
    if (++calls === 2) after.showOnPhone(false);
  });
  const answer = await edit(after);
  expect(answer).toEqual(notFound);
  expect(JSON.stringify(answer.body)).not.toContain("Person");
});

/** A new guest, as the phone asks for one. */
const create = (
  f: Awaited<ReturnType<typeof phone>>,
  change: Record<string, unknown> = {},
  as?: string,
) =>
  f.op(
    "collectionCreate",
    {
      datasetId: DATASET,
      tableId: GUESTS,
      revision: 1,
      revisionSha256: revision.revisionSha256,
      idempotencyKey: id(200),
      ...change,
    },
    as,
  );
/** Record `r01`'s deletion, as the phone asks for it. */
const remove = (
  f: Awaited<ReturnType<typeof phone>>,
  change: Record<string, unknown> = {},
  as?: string,
) =>
  f.op(
    "collectionDelete",
    {
      datasetId: DATASET,
      tableId: PEOPLE,
      recordId: "r01",
      expectedVersion: 1,
      revision: 1,
      revisionSha256: revision.revisionSha256,
      idempotencyKey: id(300),
      ...change,
    },
    as,
  );
const guests = async (f: Awaited<ReturnType<typeof phone>>) =>
  rowKeys(await f.op("collectionRecords", { datasetId: DATASET, tableId: GUESTS }));
const hasR01 = async (f: Awaited<ReturnType<typeof phone>>) =>
  rowKeys(await f.op("collectionRecords", { datasetId: DATASET, tableId: PEOPLE, recordId: "r01" }))
    .length === 1;

it("adds a record with the desktop's starting values, replays its retry, and answers a reused key as rules changed", async () => {
  const f = await phone();
  const first = await create(f);
  // Its key, which the phone reads it by, and never values the relay only sent.
  expect(first).toEqual(ok({ saved: { id: expect.any(String), version: 1 } }));
  const key = (first.body.result as { saved: { id: string } }).saved.id;
  expect(await guests(f)).toEqual([key]);
  // Each field's default, or its empty value.
  const read = await f.op("collectionRecords", {
    datasetId: DATASET,
    tableId: GUESTS,
    recordId: key,
  });
  expect((read.body.result as { rows: unknown[] }).rows).toEqual([
    expect.objectContaining({
      id: key,
      version: 1,
      values: expect.objectContaining({
        [GUEST_NAME]: null,
        [GUEST_PAID]: false,
        [GUEST_STATUS]: "Unpaid",
      }),
    }),
  ]);
  // The same key and stamp answer the same receipt, with no second record.
  expect(await create(f)).toEqual(first);
  expect(await guests(f)).toEqual([key]);
  // The key a deletion used before: the phone never changes what it resends, so the rules changed between tries.
  expect(await remove(f, { idempotencyKey: id(200) })).toEqual(ok({ rulesChanged: true }));
  expect(await hasR01(f)).toBe(true);
});

it("deletes a record, replays its retry, and refuses a stale version", async () => {
  const f = await phone();
  await edit(f);
  // r01 is at version 2 now.
  expect(await remove(f)).toEqual(
    ok({
      refused: {
        code: "stale_record",
        message: "This record changed. Refresh the table before editing it.",
      },
    }),
  );
  expect(await hasR01(f)).toBe(true);
  expect(await remove(f, { expectedVersion: 2, idempotencyKey: id(301) })).toEqual(
    ok({ saved: {} }),
  );
  expect(await hasR01(f)).toBe(false);
  expect(await remove(f, { expectedVersion: 2, idempotencyKey: id(301) })).toEqual(
    ok({ saved: {} }),
  );
  // A new guest, deleted.
  const added = await create(f);
  const key = (added.body.result as { saved: { id: string } }).saved.id;
  expect(await remove(f, { tableId: GUESTS, recordId: key, idempotencyKey: id(302) })).toEqual(
    ok({ saved: {} }),
  );
  expect(await guests(f)).toEqual([]);
});

it("refuses a new record or deletion that a table's operations don't allow, before any invoke", async () => {
  const f = await phone();
  let invoked = 0;
  f.during(() => void invoked++);
  const refused = ok({
    refused: {
      code: "forbidden",
      message: "The Collection's rules no longer allow this change, so dohc did not save it.",
    },
  });
  // Nothing reads Notes, so the phone can't show what it would add or delete there.
  expect(await create(f, { tableId: NOTES })).toEqual(refused);
  expect(await remove(f, { tableId: NOTES })).toEqual(refused);
  expect(await create(f, { tableId: OTHER })).toEqual(notFound);
  // Disallowed create fieldIds (generated key, another table's field, or button) are refused before invoke.
  expect(await create(f, { values: { [GUEST_KEY]: "forced" } })).toEqual(refused);
  expect(await create(f, { tableId: PEOPLE, values: { [TEXT]: "wrong-table" } })).toEqual(refused);
  expect(await create(f, { tableId: PEOPLE, values: { [BUTTON]: "nope" } })).toEqual(refused);
  // Nor does a key that isn't random, a version that isn't one, or malformed values.
  expect((await create(f, { idempotencyKey: "new-guest" })).status).toBe(400);
  expect((await create(f, { values: "bad" })).status).toBe(400);
  expect((await create(f, { values: { notAUuid: "x" } })).status).toBe(400);
  expect((await remove(f, { expectedVersion: 0 })).status).toBe(400);
  expect(invoked).toBe(0);
});

it("refuses a new record or deletion from another account, with Show on phone off, a revoked sign-in, a fenced account, an archived Collection, or a hidden dataset.json", async () => {
  for (const write of [create, remove]) {
    const f = await phone();
    expect(await write(f, {}, "intruder:phone-2:phone")).toEqual(notFound);
    f.showOnPhone(false);
    expect(await write(f)).toEqual(notFound);
    f.showOnPhone(true);
    revoked.add("phone-1");
    expect((await write(f)).status).toBe(401);
    revoked.clear();
    expect(await guests(f)).toEqual([]);
    expect(await hasR01(f)).toBe(true);
    initializeAccountDeletion(f.storage, "k".repeat(32));
    fenceAccount(f.storage, "k".repeat(32), "owner", "owner@dohc.test");
    expect(await write(f)).toEqual(notFound);

    const archived = await phone();
    archived.host.archiveDataset(owner, scope);
    expect(await write(archived)).toEqual(notFound);

    const hidden = await phone();
    hide(hidden);
    expect(await write(hidden)).toEqual(notFound);
  }
});

it("refuses a new record or deletion when Show on phone turns off or its dataset.json goes as it starts, and its answer when Show on phone turns off after it ran", async () => {
  for (const write of [create, remove]) {
    const before = await phone();
    before.during(() => before.showOnPhone(false));
    expect(await write(before)).toEqual(notFound);
    before.during(() => undefined);
    before.showOnPhone(true);
    expect(await guests(before)).toEqual([]);
    expect(await hasR01(before)).toBe(true);

    const gone = await phone();
    gone.during(() => pushFile(gone.storage, "dataset", collectionFile, null));
    expect(await write(gone)).toEqual(notFound);
    gone.during(() => undefined);
    pushFile(gone.storage, "dataset-again", null, collectionFile);
    expect(await guests(gone)).toEqual([]);
    expect(await hasR01(gone)).toBe(true);

    const after = await phone();
    let calls = 0;
    after.during(() => {
      if (++calls === 2) after.showOnPhone(false);
    });
    expect(await write(after)).toEqual(notFound);
  }
});

it("adds no record where the phone couldn't read it back by its key", async () => {
  const f = await phone();
  let invoked = 0;
  f.during(() => void invoked++);
  f.describing((description) => ({
    ...description,
    operations: description.operations.map((operation) =>
      operation.operationId === GUEST_READ
        ? { ...operation, fieldIds: operation.fieldIds.filter((field) => field !== GUEST_KEY) }
        : operation,
    ),
  }));
  const described = await f.op("collection", { datasetId: DATASET });
  expect(
    (described.body.result as { tables: { tableId: string; canCreate: boolean }[] }).tables.find(
      (table) => table.tableId === GUESTS,
    )?.canCreate,
  ).toBe(false);
  expect(await create(f)).toEqual(
    ok({
      refused: {
        code: "forbidden",
        message: "The Collection's rules no longer allow this change, so dohc did not save it.",
      },
    }),
  );
  expect(invoked).toBe(0);
});

it("reads a joined workspace's Collection through the Member's own grant, read-only below Edit", async () => {
  const f = await phone();
  expect(
    (f.storage as SyncRelayStorage).inviteWorkspaceMember({
      workspaceId: "w",
      actorUserId: "owner",
      workspaceName: "Fundraiser",
      email: "ana@example.test",
      recipientUserId: "ana",
      newMemberId: () => "member-ana",
      newGrantId: () => "grant-ana",
      newShareId: () => "share-w",
      nowMs: 1,
    }),
  ).toMatchObject({ ok: true });
  const ana = "ana:ana-phone:phone";
  expect(await f.op("collections", {}, ana)).toEqual(ok({ collections: [], nextCursor: null }));
  const offered = new Set(
    definition.operations
      .filter((operation) => operation.access !== "owner")
      .map((operation) => operation.operationId),
  );
  const reads = f.host
    .describe(owner, scope)
    .operations.filter((operation) => operation.readOnly && offered.has(operation.operationId))
    .map((operation) => operation.operationId);
  f.host.setWorkspaceDefaults(owner, {
    ...scope,
    defaults: {
      view: reads,
      comment: reads,
      edit: [...offered],
      revision: 1,
      revisionSha256: revision.revisionSha256,
    },
  });
  expect(await f.op("collections", {}, ana)).toEqual(
    ok({ collections: [{ datasetId: DATASET, name: "Registrations" }], nextCursor: null }),
  );
  const described = (await f.op("collection", { datasetId: DATASET }, ana)).body.result as {
    tables: Array<{ fields: Array<{ editable: boolean }>; canCreate: boolean; canDelete: boolean }>;
  };
  expect(described.tables.flatMap((table) => table.fields).some((field) => field.editable)).toBe(
    false,
  );
  expect(described.tables.some((table) => table.canCreate || table.canDelete)).toBe(false);
  expect(rowKeys(await f.records(undefined, ana))).toEqual(["r00", "r01"]);
  (f.storage as SyncRelayStorage).setShowOnPhone({
    userId: "ana",
    workspaceId: "w",
    showOnPhone: false,
  });
  expect(await f.op("collections", {}, ana)).toEqual(notFound);
  expect((await f.op("collections", {})).status, "the owner's phone still shows it").toBe(200);
});

it("commits no Member's change once their phone stops reaching the workspace as it starts", async () => {
  const f = await phone();
  const storage = f.storage as SyncRelayStorage;
  storage.inviteWorkspaceMember({
    workspaceId: "w",
    actorUserId: "owner",
    workspaceName: "Fundraiser",
    email: "ana@example.test",
    recipientUserId: "ana",
    newMemberId: () => "member-ana",
    newGrantId: () => "grant-ana",
    newShareId: () => "share-w",
    nowMs: 1,
  });
  storage.setWorkspaceMemberLevel({
    workspaceId: "w",
    actorUserId: "owner",
    level: "edit",
    workspaceName: undefined,
    newShareId: () => "share-w-edit",
    nowMs: 2,
  });
  const offered = definition.operations
    .filter((operation) => operation.access !== "owner")
    .map((operation) => operation.operationId);
  f.host.setWorkspaceDefaults(owner, {
    ...scope,
    defaults: {
      view: [READ],
      comment: [READ],
      edit: offered,
      revision: 1,
      revisionSha256: revision.revisionSha256,
    },
  });
  const ana = "ana:ana-phone:phone";
  f.during(() => storage.setShowOnPhone({ userId: "ana", workspaceId: "w", showOnPhone: false }));
  expect(await edit(f, {}, ana)).toEqual(notFound);
  f.during(() => undefined);
  expect((await r01(f)).version).toBe(1);
  storage.setShowOnPhone({ userId: "ana", workspaceId: "w", showOnPhone: true });
  expect(await edit(f, {}, ana)).toEqual(ok({ saved: { version: 2, priorValue: "Person r01" } }));
});

it("creates records with required and write-only fields via values, refuses disallowed fields, and disables create on required unreadable relations", async () => {
  const f = await phone([]);
  const added = await create(f, {
    tableId: PEOPLE,
    values: { [KEY]: "p-1", [NAME]: "Ada Lovelace", [PAID]: true, [EMAIL]: "ada@example.test" },
  });
  expect(added).toEqual(ok({ saved: { id: "p-1", version: 1 } }));
  const row = await f.op("collectionRecords", {
    datasetId: DATASET,
    tableId: PEOPLE,
    recordId: "p-1",
  });
  expect((row.body.result as { rows: unknown[] }).rows).toEqual([
    {
      id: "p-1",
      version: 1,
      values: { [KEY]: "p-1", [NAME]: "Ada Lovelace", [PAID]: true, [RECEIPT]: null },
    },
  ]);
  expect(
    await create(f, { tableId: PEOPLE, values: { [KEY]: "p-2" }, idempotencyKey: id(202) }),
  ).toEqual(ok({ refused: { code: "invalid_input", message: "Check the fields and try again." } }));
  let invoked = 0;
  f.during(() => void invoked++);
  expect(
    await create(f, {
      tableId: PEOPLE,
      values: { [KEY]: "p-3", [NAME]: "No Note", [TEXT]: "wrong-table" },
      idempotencyKey: id(203),
    }),
  ).toEqual(
    ok({
      refused: {
        code: "forbidden",
        message: "The Collection's rules no longer allow this change, so dohc did not save it.",
      },
    }),
  );
  expect(invoked).toBe(0);

  f.describing((desc) => ({
    ...desc,
    tables: desc.tables.map((t) =>
      t.tableId !== PEOPLE
        ? t
        : {
            ...t,
            fields: t.fields.map((field) =>
              field.fieldId !== EMAIL
                ? field
                : {
                    ...field,
                    type: "relation" as const,
                    required: true,
                    unique: false,
                    relation: {
                      datasetId: OTHER,
                      tableId: PEOPLE,
                      fieldId: KEY,
                      many: false,
                    },
                  },
            ),
          },
    ),
  }));
  const desc = (await f.op("collection", { datasetId: DATASET })).body.result as {
    tables: Array<{ tableId: string; canCreate: boolean; createFields: unknown[] }>;
  };
  expect(desc.tables.find((t) => t.tableId === PEOPLE)).toMatchObject({
    canCreate: false,
    createFields: [],
  });
  expect(
    await create(f, {
      tableId: PEOPLE,
      values: { [KEY]: "p-4", [NAME]: "Blocked" },
      idempotencyKey: id(204),
    }),
  ).toEqual(
    ok({
      refused: {
        code: "forbidden",
        message: "The Collection's rules no longer allow this change, so dohc did not save it.",
      },
    }),
  );
  expect(invoked).toBe(0);
});

it("resolves same-dataset relation labels, supports searchable RelationPicker and relation creates/edits, and isolates forbidden tables from Members", async () => {
  const REL_DS = id(400),
    CUSTOMERS = id(401),
    CUST_ID = id(402),
    CUST_NAME = id(403),
    TAGS = id(404),
    TAG_ID = id(405),
    TAG_LABEL = id(406),
    ORDERS = id(407),
    ORD_ID = id(408),
    ORD_TITLE = id(409),
    ORD_CUST = id(410),
    ORD_TAGS = id(411),
    ORD_SECRET = id(412),
    ORD_FILE = id(413),
    CUST_READ = id(420),
    CUST_CREATE = id(421),
    TAG_READ = id(422),
    TAG_CREATE = id(423),
    ORD_READ = id(424),
    ORD_CREATE = id(425),
    ORD_EDIT = id(426);
  const relDef: DatasetDefinition = {
    formatVersion: 1,
    datasetId: REL_DS,
    name: "Shop",
    schemaPath: "shop/schema.sql",
    operationsPath: "shop/operations.js",
    tables: [
      {
        tableId: CUSTOMERS,
        name: "Customers",
        sqlName: "customers",
        primaryKey: "id",
        fields: [
          {
            fieldId: CUST_ID,
            name: "ID",
            sqlColumn: "id",
            type: "text",
            required: true,
            unique: true,
          },
          {
            fieldId: CUST_NAME,
            name: "Name",
            sqlColumn: "name",
            type: "text",
            required: true,
            unique: false,
          },
        ],
      },
      {
        tableId: TAGS,
        name: "Tags",
        sqlName: "tags",
        primaryKey: "id",
        fields: [
          {
            fieldId: TAG_ID,
            name: "ID",
            sqlColumn: "id",
            type: "text",
            required: true,
            unique: true,
          },
          {
            fieldId: TAG_LABEL,
            name: "Label",
            sqlColumn: "label",
            type: "text",
            required: true,
            unique: false,
          },
        ],
      },
      {
        tableId: ORDERS,
        name: "Orders",
        sqlName: "orders",
        primaryKey: "id",
        fields: [
          {
            fieldId: ORD_ID,
            name: "ID",
            sqlColumn: "id",
            type: "text",
            required: true,
            unique: true,
            generated: "record-id",
          },
          {
            fieldId: ORD_TITLE,
            name: "Title",
            sqlColumn: "title",
            type: "text",
            required: true,
            unique: false,
          },
          {
            fieldId: ORD_CUST,
            name: "Customer",
            sqlColumn: "customer_id",
            type: "relation",
            required: true,
            unique: false,
            relation: { datasetId: REL_DS, tableId: CUSTOMERS, fieldId: CUST_ID, many: false },
          },
          {
            fieldId: ORD_TAGS,
            name: "Tags",
            sqlColumn: "tag_ids",
            type: "relation",
            required: false,
            unique: false,
            relation: { datasetId: REL_DS, tableId: TAGS, fieldId: TAG_ID, many: true },
          },
          {
            fieldId: ORD_SECRET,
            name: "Internal code",
            sqlColumn: "secret_code",
            type: "text",
            required: true,
            unique: false,
          },
          {
            fieldId: ORD_FILE,
            name: "Invoice",
            sqlColumn: "invoice",
            type: "attachment",
            required: false,
            unique: false,
          },
        ],
      },
    ],
    operations: [
      {
        operationId: CUST_READ,
        name: "readCustomers",
        label: "Read customers",
        tableId: CUSTOMERS,
        kind: "read",
        access: "link",
        readOnly: true,
        fieldIds: [CUST_ID, CUST_NAME],
      },
      {
        operationId: CUST_CREATE,
        name: "createCustomer",
        label: "Create customer",
        tableId: CUSTOMERS,
        kind: "create",
        access: "owner",
        readOnly: false,
        fieldIds: [CUST_ID, CUST_NAME],
      },
      {
        operationId: TAG_READ,
        name: "readTags",
        label: "Read tags",
        tableId: TAGS,
        kind: "read",
        access: "link",
        readOnly: true,
        fieldIds: [TAG_ID, TAG_LABEL],
      },
      {
        operationId: TAG_CREATE,
        name: "createTag",
        label: "Create tag",
        tableId: TAGS,
        kind: "create",
        access: "owner",
        readOnly: false,
        fieldIds: [TAG_ID, TAG_LABEL],
      },
      {
        operationId: ORD_READ,
        name: "readOrders",
        label: "Read orders",
        tableId: ORDERS,
        kind: "read",
        access: "link",
        readOnly: true,
        fieldIds: [ORD_ID, ORD_TITLE, ORD_CUST, ORD_TAGS],
      },
      {
        operationId: ORD_CREATE,
        name: "createOrder",
        label: "Create order",
        tableId: ORDERS,
        kind: "create",
        access: "link",
        readOnly: false,
        fieldIds: [ORD_TITLE, ORD_CUST, ORD_TAGS, ORD_SECRET, ORD_FILE],
      },
      {
        operationId: ORD_EDIT,
        name: "editOrder",
        label: "Edit order",
        tableId: ORDERS,
        kind: "edit",
        access: "link",
        readOnly: false,
        fieldIds: [ORD_TITLE, ORD_CUST, ORD_TAGS],
        reversible: true,
      },
    ],
  };
  const relSql = `CREATE TABLE customers(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;
CREATE TABLE tags(id TEXT PRIMARY KEY NOT NULL,label TEXT NOT NULL,"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;
CREATE TABLE orders(id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,customer_id TEXT NOT NULL REFERENCES customers(id),tag_ids TEXT,secret_code TEXT NOT NULL,invoice TEXT,"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;`;
  const relSource = generateDatasetOperations(relDef);
  const relRev = describeDatasetRevision({
    definition: relDef,
    revision: 1,
    schemaSql: relSql,
    operationSource: relSource,
  });
  const f = await phone([]);
  await f.host.activate(owner, {
    workspaceId: "w",
    revision: relRev,
    schemaSql: relSql,
    operationSource: relSource,
    capacityBytes: 1024 * 1024,
  });
  pushFile(f.storage, "shop-dataset", null, {
    path: "shop/dataset.json",
    text: JSON.stringify({ datasetId: REL_DS }),
  });
  for (const [cid, cname] of [
    ["c-1", "Acme Corp"],
    ["c-2", "Beacon Labs"],
    ["c-3", "Unused Secret"],
  ])
    await f.host.invoke(owner, {
      workspaceId: "w",
      datasetId: REL_DS,
      revision: 1,
      revisionSha256: relRev.revisionSha256,
      operationId: CUST_CREATE,
      input: { values: { [CUST_ID]: cid, [CUST_NAME]: cname } },
      idempotencyKey: `cust-${cid}`,
    });
  for (const [tid, tlabel] of [
    ["t-1", "VIP"],
    ["t-2", "Urgent"],
  ])
    await f.host.invoke(owner, {
      workspaceId: "w",
      datasetId: REL_DS,
      revision: 1,
      revisionSha256: relRev.revisionSha256,
      operationId: TAG_CREATE,
      input: { values: { [TAG_ID]: tid, [TAG_LABEL]: tlabel } },
      idempotencyKey: `tag-${tid}`,
    });

  // Omitting required write-only ORD_SECRET fails with invalid_input; providing it succeeds (proving values forwarded).
  expect(
    await f.op("collectionCreate", {
      datasetId: REL_DS,
      tableId: ORDERS,
      revision: 1,
      revisionSha256: relRev.revisionSha256,
      idempotencyKey: id(449),
      values: { [ORD_TITLE]: "Missing secret", [ORD_CUST]: "c-1" },
    }),
  ).toEqual(ok({ refused: { code: "invalid_input", message: "Check the fields and try again." } }));
  const created = await f.op("collectionCreate", {
    datasetId: REL_DS,
    tableId: ORDERS,
    revision: 1,
    revisionSha256: relRev.revisionSha256,
    idempotencyKey: id(450),
    values: {
      [ORD_TITLE]: "First order",
      [ORD_CUST]: "c-1",
      [ORD_TAGS]: ["t-1", "t-2"],
      [ORD_SECRET]: "S-99",
    },
  });
  expect(created).toEqual(ok({ saved: { id: expect.any(String), version: 1 } }));
  const orderId = (created.body.result as { saved: { id: string } }).saved.id;

  // Owner sees resolved relation labels (only for referenced keys, not Unused Secret) and searchable options.
  const ownerPage = await f.op("collectionRecords", { datasetId: REL_DS, tableId: ORDERS });
  expect(ownerPage.body.result).toMatchObject({
    status: "ready",
    relations: {
      [ORD_CUST]: { '"c-1"': "Acme Corp" },
      [ORD_TAGS]: { '"t-1"': "VIP", '"t-2"': "Urgent" },
    },
  });
  expect(JSON.stringify(ownerPage.body)).not.toContain("Unused Secret");
  expect(
    await f.op("collectionRelationOptions", {
      datasetId: REL_DS,
      tableId: ORDERS,
      fieldId: ORD_CUST,
      search: "Beac",
    }),
  ).toEqual(ok({ options: [{ value: "c-2", label: "Beacon Labs" }], nextCursor: null }));

  // Owner can edit relation field and undo it.
  expect(
    await f.op("collectionEdit", {
      datasetId: REL_DS,
      tableId: ORDERS,
      recordId: orderId,
      fieldId: ORD_CUST,
      value: "c-2",
      expectedVersion: 1,
      revision: 1,
      revisionSha256: relRev.revisionSha256,
      idempotencyKey: id(451),
    }),
  ).toEqual(ok({ saved: { version: 2, priorValue: "c-1" } }));

  // Member Ana has Edit access on Orders ONLY (no read on Customers or Tags).
  const storage = f.storage as SyncRelayStorage;
  storage.inviteWorkspaceMember({
    workspaceId: "w",
    actorUserId: "owner",
    workspaceName: "Shop",
    email: "ana@example.test",
    recipientUserId: "ana",
    newMemberId: () => "member-ana",
    newGrantId: () => "grant-ana",
    newShareId: () => "share-w",
    nowMs: 1,
  });
  storage.setWorkspaceMemberLevel({
    workspaceId: "w",
    actorUserId: "owner",
    level: "edit",
    workspaceName: undefined,
    newShareId: () => "share-w-edit",
    nowMs: 2,
  });
  f.host.setWorkspaceDefaults(owner, {
    workspaceId: "w",
    datasetId: REL_DS,
    defaults: {
      view: [ORD_READ],
      comment: [ORD_READ],
      edit: [ORD_READ, ORD_CREATE, ORD_EDIT],
      revision: 1,
      revisionSha256: relRev.revisionSha256,
    },
  });
  const ana = "ana:ana-phone:phone";
  const anaDesc = (await f.op("collection", { datasetId: REL_DS }, ana)).body.result as {
    tables: Array<{
      tableId: string;
      canCreate: boolean;
      createFields: unknown[];
      fields: Array<{ fieldId: string; editable: boolean; relation?: unknown }>;
    }>;
  };
  const anaOrders = anaDesc.tables.find((t) => t.tableId === ORDERS)!;
  expect(anaOrders.canCreate).toBe(false);
  expect(anaOrders.createFields).toEqual([]);
  expect(anaOrders.fields.find((item) => item.fieldId === ORD_CUST)).toMatchObject({
    editable: false,
  });
  expect(anaOrders.fields.find((item) => item.fieldId === ORD_CUST)?.relation).toBeUndefined();
  const anaRecords = await f.op("collectionRecords", { datasetId: REL_DS, tableId: ORDERS }, ana);
  expect(anaRecords.status).toBe(200);
  expect((anaRecords.body.result as { relations: unknown }).relations).toEqual({});
  expect(JSON.stringify(anaRecords.body)).not.toContain("Acme");
  expect(JSON.stringify(anaRecords.body)).not.toContain("Beacon");
  expect(JSON.stringify(anaRecords.body)).not.toContain("VIP");
  expect(
    await f.op(
      "collectionRelationOptions",
      { datasetId: REL_DS, tableId: ORDERS, fieldId: ORD_CUST },
      ana,
    ),
  ).toEqual(notFound);
  expect(
    await f.op(
      "collectionRelationOptions",
      { datasetId: REL_DS, tableId: ORDERS, fieldId: ORD_TAGS },
      ana,
    ),
  ).toEqual(notFound);
  // Attempting to write forbidden relation field is refused before invoke.
  let invoked = 0;
  f.during(() => void invoked++);
  expect(
    await f.op(
      "collectionEdit",
      {
        datasetId: REL_DS,
        tableId: ORDERS,
        recordId: orderId,
        fieldId: ORD_CUST,
        value: "c-1",
        expectedVersion: 2,
        revision: 1,
        revisionSha256: relRev.revisionSha256,
        idempotencyKey: id(452),
      },
      ana,
    ),
  ).toEqual(
    ok({
      refused: {
        code: "forbidden",
        message: "The Collection's rules no longer allow this change, so dohc did not save it.",
      },
    }),
  );
  expect(invoked).toBe(0);

  // Granting Ana read on Customers (still not Tags) unlocks Customers labels/options while keeping Tags isolated.
  f.host.setWorkspaceDefaults(owner, {
    workspaceId: "w",
    datasetId: REL_DS,
    defaults: {
      view: [ORD_READ, CUST_READ],
      comment: [ORD_READ, CUST_READ],
      edit: [ORD_READ, ORD_CREATE, ORD_EDIT, CUST_READ],
      revision: 1,
      revisionSha256: relRev.revisionSha256,
    },
  });
  const anaWithCust = await f.op("collectionRecords", { datasetId: REL_DS, tableId: ORDERS }, ana);
  expect((anaWithCust.body.result as { relations: unknown }).relations).toEqual({
    [ORD_CUST]: { '"c-2"': "Beacon Labs" },
  });
  expect(JSON.stringify(anaWithCust.body)).not.toContain("VIP");
  expect(
    await f.op(
      "collectionRelationOptions",
      { datasetId: REL_DS, tableId: ORDERS, fieldId: ORD_CUST },
      ana,
    ),
  ).toEqual(
    ok({
      options: [
        { value: "c-1", label: "Acme Corp" },
        { value: "c-2", label: "Beacon Labs" },
        { value: "c-3", label: "Unused Secret" },
      ],
      nextCursor: null,
    }),
  );
  expect(
    await f.op(
      "collectionRelationOptions",
      { datasetId: REL_DS, tableId: ORDERS, fieldId: ORD_TAGS },
      ana,
    ),
  ).toEqual(notFound);
  // With Edit access + Customers read, Ana can now create an Order (with write-only secret + required relation) via RelayDatasetHost.
  expect(
    await f.op(
      "collectionCreate",
      {
        datasetId: REL_DS,
        tableId: ORDERS,
        revision: 1,
        revisionSha256: relRev.revisionSha256,
        idempotencyKey: id(453),
        values: { [ORD_TITLE]: "Ana order", [ORD_CUST]: "c-1", [ORD_SECRET]: "ANA-1" },
      },
      ana,
    ),
  ).toEqual(ok({ saved: { id: expect.any(String), version: 1 } }));
});

it("resolves cross-dataset relation labels and enforces visibility and Member authorization on the target dataset", async () => {
  const TARGET_DS = id(500),
    ACCOUNTS = id(501),
    ACC_ID = id(502),
    ACC_NAME = id(503),
    ACC_READ = id(504),
    ACC_CREATE = id(505);
  const targetDef: DatasetDefinition = {
    formatVersion: 1,
    datasetId: TARGET_DS,
    name: "Accounts",
    schemaPath: "accounts/schema.sql",
    operationsPath: "accounts/operations.js",
    tables: [
      {
        tableId: ACCOUNTS,
        name: "Accounts",
        sqlName: "accounts",
        primaryKey: "id",
        fields: [
          {
            fieldId: ACC_ID,
            name: "ID",
            sqlColumn: "id",
            type: "text",
            required: true,
            unique: true,
          },
          {
            fieldId: ACC_NAME,
            name: "Name",
            sqlColumn: "name",
            type: "text",
            required: true,
            unique: false,
          },
        ],
      },
    ],
    operations: [
      {
        operationId: ACC_READ,
        name: "read",
        label: "Read",
        tableId: ACCOUNTS,
        kind: "read",
        access: "link",
        readOnly: true,
        fieldIds: [ACC_ID, ACC_NAME],
      },
      {
        operationId: ACC_CREATE,
        name: "create",
        label: "Create",
        tableId: ACCOUNTS,
        kind: "create",
        access: "owner",
        readOnly: false,
        fieldIds: [ACC_ID, ACC_NAME],
      },
    ],
  };
  const targetSql = `CREATE TABLE accounts(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;`;
  const targetSource = generateDatasetOperations(targetDef);
  const targetRev = describeDatasetRevision({
    definition: targetDef,
    revision: 1,
    schemaSql: targetSql,
    operationSource: targetSource,
  });
  const f = await phone(["r00"]);
  await f.host.activate(owner, {
    workspaceId: "w",
    revision: targetRev,
    schemaSql: targetSql,
    operationSource: targetSource,
    capacityBytes: 1024 * 1024,
  });
  const targetFile = {
    path: "accounts/dataset.json",
    text: JSON.stringify({ datasetId: TARGET_DS }),
  };
  pushFile(f.storage, "accounts-dataset", null, targetFile);
  await f.host.invoke(owner, {
    workspaceId: "w",
    datasetId: TARGET_DS,
    revision: 1,
    revisionSha256: targetRev.revisionSha256,
    operationId: ACC_CREATE,
    input: { values: { [ACC_ID]: "Person r00", [ACC_NAME]: "Globex Corp" } },
    idempotencyKey: id(510),
  });
  // Wire PEOPLE.NAME as a cross-dataset relation targeting TARGET_DS.ACCOUNTS.ACC_ID.
  f.describing((desc) =>
    desc.datasetId !== DATASET
      ? desc
      : {
          ...desc,
          tables: desc.tables.map((t) =>
            t.tableId !== PEOPLE
              ? t
              : {
                  ...t,
                  fields: t.fields.map((field) =>
                    field.fieldId !== NAME || field.type === "button"
                      ? field
                      : {
                          ...field,
                          type: "relation" as const,
                          relation: {
                            datasetId: TARGET_DS,
                            tableId: ACCOUNTS,
                            fieldId: ACC_ID,
                            many: false,
                          },
                        },
                  ),
                },
          ),
        },
  );
  // Owner sees cross-dataset label and picker option.
  const ownerPage = await f.records();
  expect((ownerPage.body.result as { relations: unknown }).relations).toEqual({
    [NAME]: { '"Person r00"': "Globex Corp" },
  });
  expect(
    await f.op("collectionRelationOptions", { datasetId: DATASET, tableId: PEOPLE, fieldId: NAME }),
  ).toEqual(ok({ options: [{ value: "Person r00", label: "Globex Corp" }], nextCursor: null }));

  // Member Ana can read DATASET (Registrations) ONLY, NOT TARGET_DS (Accounts): zero target labels leak.
  const storage = f.storage as SyncRelayStorage;
  storage.inviteWorkspaceMember({
    workspaceId: "w",
    actorUserId: "owner",
    workspaceName: "Fundraiser",
    email: "ana@example.test",
    recipientUserId: "ana",
    newMemberId: () => "member-ana",
    newGrantId: () => "grant-ana",
    newShareId: () => "share-w",
    nowMs: 1,
  });
  f.host.setWorkspaceDefaults(owner, {
    ...scope,
    defaults: {
      view: [READ],
      comment: [READ],
      edit: [READ],
      revision: 1,
      revisionSha256: revision.revisionSha256,
    },
  });
  const ana = "ana:ana-phone:phone";
  const anaPage = await f.records(undefined, ana);
  expect(anaPage.status).toBe(200);
  expect((anaPage.body.result as { relations: unknown }).relations).toEqual({});
  expect(JSON.stringify(anaPage.body)).not.toContain("Globex");
  expect(
    await f.op(
      "collectionRelationOptions",
      { datasetId: DATASET, tableId: PEOPLE, fieldId: NAME },
      ana,
    ),
  ).toEqual(notFound);

  // Once Ana is granted read access to TARGET_DS, she sees Globex Corp.
  f.host.setWorkspaceDefaults(owner, {
    workspaceId: "w",
    datasetId: TARGET_DS,
    defaults: {
      view: [ACC_READ],
      comment: [ACC_READ],
      edit: [ACC_READ],
      revision: 1,
      revisionSha256: targetRev.revisionSha256,
    },
  });
  expect((await f.records(undefined, ana)).body.result).toMatchObject({
    relations: { [NAME]: { '"Person r00"': "Globex Corp" } },
  });
  // If TARGET_DS becomes invisible mid-read (after invoke), zero labels leak and options return 404.
  let targetCalls = 0;
  f.during(() => {
    if (++targetCalls === 4) pushFile(f.storage, "accounts-dataset", targetFile, null);
  });
  const midRevoked = await f.records(undefined, ana);
  f.during(() => undefined);
  expect(midRevoked.status).toBe(200);
  expect((midRevoked.body.result as { relations: unknown }).relations).toEqual({});
  expect(JSON.stringify(midRevoked.body)).not.toContain("Globex");
  // While TARGET_DS's dataset.json is deleted (invisible), even the Owner gets zero target labels and 404 on options.
  const hiddenPage = await f.records();
  expect((hiddenPage.body.result as { relations: unknown }).relations).toEqual({});
  expect(JSON.stringify(hiddenPage.body)).not.toContain("Globex");
  expect(
    await f.op("collectionRelationOptions", { datasetId: DATASET, tableId: PEOPLE, fieldId: NAME }),
  ).toEqual(notFound);
});

it("forwards search and sort to generated reads and falls back cleanly on custom-op invalid_input", async () => {
  const f = await phone(["r00", "r01", "r02"]);
  const searched = await f.op("collectionRecords", {
    datasetId: DATASET,
    tableId: PEOPLE,
    search: "Person r01",
  });
  expect(rowKeys(searched)).toEqual(["r01"]);
  const sorted = await f.op("collectionRecords", {
    datasetId: DATASET,
    tableId: PEOPLE,
    sort: { fieldId: NAME, direction: "desc" },
  });
  expect(rowKeys(sorted)).toEqual(["r02", "r01", "r00"]);
  // Unsortable field (attachment), bad direction, or combining search with recordId returns 400.
  expect(
    (
      await f.op("collectionRecords", {
        datasetId: DATASET,
        tableId: PEOPLE,
        sort: { fieldId: RECEIPT, direction: "asc" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.op("collectionRecords", {
        datasetId: DATASET,
        tableId: PEOPLE,
        sort: { fieldId: NAME, direction: "up" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.op("collectionRecords", {
        datasetId: DATASET,
        tableId: PEOPLE,
        recordId: "r00",
        search: "x",
      })
    ).status,
  ).toBe(400);

  // Custom operations.js that rejects search and sort with invalid_input.
  const CUSTOM_DS = id(600),
    ITEMS = id(601),
    ITEM_ID = id(602),
    ITEM_NAME = id(603),
    ITEM_READ = id(604),
    ITEM_CREATE = id(605);
  const customDef: DatasetDefinition = {
    formatVersion: 1,
    datasetId: CUSTOM_DS,
    name: "Custom",
    schemaPath: "custom/schema.sql",
    operationsPath: "custom/operations.js",
    tables: [
      {
        tableId: ITEMS,
        name: "Items",
        sqlName: "items",
        primaryKey: "id",
        fields: [
          {
            fieldId: ITEM_ID,
            name: "ID",
            sqlColumn: "id",
            type: "text",
            required: true,
            unique: true,
          },
          {
            fieldId: ITEM_NAME,
            name: "Name",
            sqlColumn: "name",
            type: "text",
            required: true,
            unique: false,
          },
        ],
      },
    ],
    operations: [
      {
        operationId: ITEM_READ,
        name: "read",
        label: "Read",
        tableId: ITEMS,
        kind: "read",
        access: "owner",
        readOnly: true,
        fieldIds: [ITEM_ID, ITEM_NAME],
      },
      {
        operationId: ITEM_CREATE,
        name: "create",
        label: "Create",
        tableId: ITEMS,
        kind: "create",
        access: "owner",
        readOnly: false,
        fieldIds: [ITEM_ID, ITEM_NAME],
      },
    ],
  };
  const customSql = `CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;`;
  const customSource = `globalThis.operations = {
    read(ctx, input) {
      if (input.search !== undefined || input.sort !== undefined) ctx.refuse('invalid_input', 'No query here.');
      const rows = ctx.db.query('SELECT id, name, "_record_version" FROM items ORDER BY id LIMIT ?', [input.limit ?? 50]);
      return { rows: rows.map(r => ({ id: r.id, version: r._record_version, values: { ${JSON.stringify(ITEM_ID)}: r.id, ${JSON.stringify(ITEM_NAME)}: r.name } })), nextCursor: null };
    },
    create(ctx, input) {
      ctx.db.execute('INSERT INTO items(id, name) VALUES (?, ?)', [input.values[${JSON.stringify(ITEM_ID)}], input.values[${JSON.stringify(ITEM_NAME)}]]);
      return { id: input.values[${JSON.stringify(ITEM_ID)}], version: 1 };
    },
  };`;
  const customRev = describeDatasetRevision({
    definition: customDef,
    revision: 1,
    schemaSql: customSql,
    operationSource: customSource,
  });
  await f.host.activate(owner, {
    workspaceId: "w",
    revision: customRev,
    schemaSql: customSql,
    operationSource: customSource,
    capacityBytes: 1024 * 1024,
  });
  pushFile(f.storage, "custom-dataset", null, {
    path: "custom/dataset.json",
    text: JSON.stringify({ datasetId: CUSTOM_DS }),
  });
  await f.host.invoke(owner, {
    workspaceId: "w",
    datasetId: CUSTOM_DS,
    revision: 1,
    revisionSha256: customRev.revisionSha256,
    operationId: ITEM_CREATE,
    input: { values: { [ITEM_ID]: "i-1", [ITEM_NAME]: "Alpha" } },
    idempotencyKey: id(610),
  });
  expect(
    rowKeys(await f.op("collectionRecords", { datasetId: CUSTOM_DS, tableId: ITEMS })),
  ).toEqual(["i-1"]);
  expect(
    await f.op("collectionRecords", { datasetId: CUSTOM_DS, tableId: ITEMS, search: "Al" }),
  ).toEqual(ok({ status: "refused", reason: "unsupported-query" }));
  expect(
    await f.op("collectionRecords", {
      datasetId: CUSTOM_DS,
      tableId: ITEMS,
      sort: { fieldId: ITEM_NAME, direction: "desc" },
    }),
  ).toEqual(ok({ status: "refused", reason: "unsupported-query" }));
  // Relation picker targeting a custom-op table that refuses search returns searchUnsupported cleanly.
  f.describing((desc) =>
    desc.datasetId !== DATASET
      ? desc
      : {
          ...desc,
          tables: desc.tables.map((t) =>
            t.tableId !== PEOPLE
              ? t
              : {
                  ...t,
                  fields: t.fields.map((field) =>
                    field.fieldId !== NAME || field.type === "button"
                      ? field
                      : {
                          ...field,
                          type: "relation" as const,
                          relation: {
                            datasetId: CUSTOM_DS,
                            tableId: ITEMS,
                            fieldId: ITEM_ID,
                            many: false,
                          },
                        },
                  ),
                },
          ),
        },
  );
  expect(
    await f.op("collectionRelationOptions", {
      datasetId: DATASET,
      tableId: PEOPLE,
      fieldId: NAME,
      search: "Al",
    }),
  ).toEqual(ok({ options: [], nextCursor: null, searchUnsupported: true }));
});

it("handles decimal relation keys, truncates long target labels, and blocks mid-flight source/target read narrowing or write revocation", async () => {
  const DS = id(700),
    CATS = id(701),
    CAT_ID = id(702),
    CAT_CODE = id(703),
    CAT_NAME = id(704),
    ENTRIES = id(705),
    ENT_ID = id(706),
    ENT_CAT = id(707),
    CAT_READ = id(710),
    CAT_CREATE = id(711),
    ENT_READ = id(712),
    ENT_CREATE = id(713),
    ENT_EDIT = id(714);
  const def: DatasetDefinition = {
    formatVersion: 1,
    datasetId: DS,
    name: "Catalog",
    schemaPath: "cat/schema.sql",
    operationsPath: "cat/operations.js",
    tables: [
      {
        tableId: CATS,
        name: "Categories",
        sqlName: "categories",
        primaryKey: "id",
        fields: [
          {
            fieldId: CAT_ID,
            name: "ID",
            sqlColumn: "id",
            type: "text",
            required: true,
            unique: true,
          },
          {
            fieldId: CAT_CODE,
            name: "Code",
            sqlColumn: "code",
            type: "number",
            required: true,
            unique: true,
          },
          {
            fieldId: CAT_NAME,
            name: "Name",
            sqlColumn: "name",
            type: "text",
            required: true,
            unique: false,
          },
        ],
      },
      {
        tableId: ENTRIES,
        name: "Entries",
        sqlName: "entries",
        primaryKey: "id",
        fields: [
          {
            fieldId: ENT_ID,
            name: "ID",
            sqlColumn: "id",
            type: "text",
            required: true,
            unique: true,
          },
          {
            fieldId: ENT_CAT,
            name: "Category",
            sqlColumn: "cat_code",
            type: "relation",
            required: false,
            unique: false,
            relation: { datasetId: DS, tableId: CATS, fieldId: CAT_CODE, many: false },
          },
        ],
      },
    ],
    operations: [
      {
        operationId: CAT_READ,
        name: "readCats",
        label: "Read",
        tableId: CATS,
        kind: "read",
        access: "link",
        readOnly: true,
        fieldIds: [CAT_ID, CAT_CODE, CAT_NAME],
      },
      {
        operationId: CAT_CREATE,
        name: "createCat",
        label: "Create",
        tableId: CATS,
        kind: "create",
        access: "owner",
        readOnly: false,
        fieldIds: [CAT_ID, CAT_CODE, CAT_NAME],
      },
      {
        operationId: ENT_READ,
        name: "readEnts",
        label: "Read",
        tableId: ENTRIES,
        kind: "read",
        access: "link",
        readOnly: true,
        fieldIds: [ENT_ID, ENT_CAT],
      },
      {
        operationId: ENT_CREATE,
        name: "createEnt",
        label: "Create",
        tableId: ENTRIES,
        kind: "create",
        access: "link",
        readOnly: false,
        fieldIds: [ENT_ID, ENT_CAT],
      },
      {
        operationId: ENT_EDIT,
        name: "editEnt",
        label: "Edit",
        tableId: ENTRIES,
        kind: "edit",
        access: "link",
        readOnly: false,
        fieldIds: [ENT_CAT],
        reversible: true,
      },
    ],
  };
  const sql = `CREATE TABLE categories(id TEXT PRIMARY KEY NOT NULL,code REAL NOT NULL UNIQUE,name TEXT NOT NULL,"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;
CREATE TABLE entries(id TEXT PRIMARY KEY NOT NULL,cat_code REAL REFERENCES categories(code),"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;`;
  const src = generateDatasetOperations(def);
  const rev = describeDatasetRevision({
    definition: def,
    revision: 1,
    schemaSql: sql,
    operationSource: src,
  });
  const f = await phone([]);
  await f.host.activate(owner, {
    workspaceId: "w",
    revision: rev,
    schemaSql: sql,
    operationSource: src,
    capacityBytes: 1024 * 1024,
  });
  pushFile(f.storage, "cat-dataset", null, {
    path: "cat/dataset.json",
    text: JSON.stringify({ datasetId: DS }),
  });
  const huge = "L".repeat(2500);
  await f.host.invoke(owner, {
    workspaceId: "w",
    datasetId: DS,
    revision: 1,
    revisionSha256: rev.revisionSha256,
    operationId: CAT_CREATE,
    input: { values: { [CAT_ID]: "c1", [CAT_CODE]: 1.5, [CAT_NAME]: huge } },
    idempotencyKey: id(720),
  });
  await f.host.invoke(owner, {
    workspaceId: "w",
    datasetId: DS,
    revision: 1,
    revisionSha256: rev.revisionSha256,
    operationId: ENT_CREATE,
    input: { values: { [ENT_ID]: "e1", [ENT_CAT]: 1.5 } },
    idempotencyKey: id(721),
  });

  // Decimal relation key 1.5 resolves and long labels truncate to <= 500 chars.
  const page = await f.op("collectionRecords", { datasetId: DS, tableId: ENTRIES });
  expect(
    (page.body.result as { relations: Record<string, Record<string, string>> }).relations,
  ).toEqual({
    [ENT_CAT]: { "1.5": "L".repeat(500) },
  });
  expect(
    await f.op("collectionRelationOptions", { datasetId: DS, tableId: ENTRIES, fieldId: ENT_CAT }),
  ).toEqual(ok({ options: [{ value: 1.5, label: "L".repeat(500) }], nextCursor: null }));

  // Narrowing target read projection mid-read omits old label on collectionRecords and returns 404 on options.
  let narrowed = false;
  let calls = 0;
  f.describing((desc) =>
    desc.datasetId !== DS || !narrowed
      ? desc
      : {
          ...desc,
          operations: desc.operations.map((o) =>
            o.operationId === CAT_READ ? { ...o, fieldIds: [CAT_ID, CAT_CODE] } : o,
          ),
        },
  );
  f.during(() => {
    if (++calls === 4) narrowed = true;
  });
  const narrowedPage = await f.op("collectionRecords", { datasetId: DS, tableId: ENTRIES });
  f.during(() => undefined);
  expect((narrowedPage.body.result as { relations: unknown }).relations).toEqual({});
  narrowed = false;
  calls = 0;
  f.during(() => {
    if (++calls === 2) narrowed = true;
  });
  expect(
    await f.op("collectionRelationOptions", { datasetId: DS, tableId: ENTRIES, fieldId: ENT_CAT }),
  ).toEqual(notFound);
  f.during(() => undefined);
  narrowed = false;

  // Revoking source read mid-read returns no-read with zero rows.
  let noRead = false;
  calls = 0;
  f.describing((desc) =>
    desc.datasetId !== DS || !noRead
      ? desc
      : { ...desc, operations: desc.operations.filter((o) => o.operationId !== ENT_READ) },
  );
  f.during(() => {
    if (++calls === 2) noRead = true;
  });
  expect(await f.op("collectionRecords", { datasetId: DS, tableId: ENTRIES })).toEqual(
    ok({ status: "refused", reason: "no-read" }),
  );
  f.during(() => undefined);
  noRead = false;

  // Losing target read mid-commit aborts a relation edit without mutating the record.
  let noTarget = false;
  f.describing((desc) =>
    desc.datasetId !== DS || !noTarget
      ? desc
      : { ...desc, operations: desc.operations.filter((o) => o.operationId !== CAT_READ) },
  );
  f.during(() => {
    noTarget = true;
  });
  expect(
    await f.op("collectionEdit", {
      datasetId: DS,
      tableId: ENTRIES,
      recordId: "e1",
      fieldId: ENT_CAT,
      value: null,
      expectedVersion: 1,
      revision: 1,
      revisionSha256: rev.revisionSha256,
      idempotencyKey: id(722),
    }),
  ).toEqual(notFound);
  f.during(() => undefined);
  noTarget = false;
  const after = await f.op("collectionRecords", {
    datasetId: DS,
    tableId: ENTRIES,
    recordId: "e1",
  });
  expect(
    (after.body.result as { rows: Array<{ version: number; values: Record<string, unknown> }> })
      .rows[0],
  ).toMatchObject({
    version: 1,
    values: { [ENT_CAT]: 1.5 },
  });
});

it("resolves more than 25 relation links beyond row 100 and paginates cursors on long sorted text", async () => {
  const DS = id(800),
    TAGS = id(801),
    TAG_ID = id(802),
    TAG_LABEL = id(803),
    ITEMS = id(804),
    ITEM_ID = id(805),
    ITEM_TITLE = id(806),
    ITEM_TAGS = id(807),
    TAG_READ = id(810),
    TAG_CREATE = id(811),
    ITEM_READ = id(812),
    ITEM_CREATE = id(813);
  const def: DatasetDefinition = {
    formatVersion: 1,
    datasetId: DS,
    name: "Big",
    schemaPath: "big/schema.sql",
    operationsPath: "big/operations.js",
    tables: [
      {
        tableId: TAGS,
        name: "Tags",
        sqlName: "tags",
        primaryKey: "id",
        fields: [
          {
            fieldId: TAG_ID,
            name: "ID",
            sqlColumn: "id",
            type: "text",
            required: true,
            unique: true,
          },
          {
            fieldId: TAG_LABEL,
            name: "Label",
            sqlColumn: "label",
            type: "text",
            required: true,
            unique: false,
          },
        ],
      },
      {
        tableId: ITEMS,
        name: "Items",
        sqlName: "items",
        primaryKey: "id",
        fields: [
          {
            fieldId: ITEM_ID,
            name: "ID",
            sqlColumn: "id",
            type: "text",
            required: true,
            unique: true,
          },
          {
            fieldId: ITEM_TITLE,
            name: "Title",
            sqlColumn: "title",
            type: "text",
            required: true,
            unique: false,
          },
          {
            fieldId: ITEM_TAGS,
            name: "Tags",
            sqlColumn: "tag_ids",
            type: "relation",
            required: false,
            unique: false,
            relation: { datasetId: DS, tableId: TAGS, fieldId: TAG_ID, many: true },
          },
        ],
      },
    ],
    operations: [
      {
        operationId: TAG_READ,
        name: "readTags",
        label: "Read",
        tableId: TAGS,
        kind: "read",
        access: "link",
        readOnly: true,
        fieldIds: [TAG_ID, TAG_LABEL],
      },
      {
        operationId: TAG_CREATE,
        name: "createTag",
        label: "Create",
        tableId: TAGS,
        kind: "create",
        access: "owner",
        readOnly: false,
        fieldIds: [TAG_ID, TAG_LABEL],
      },
      {
        operationId: ITEM_READ,
        name: "readItems",
        label: "Read",
        tableId: ITEMS,
        kind: "read",
        access: "link",
        readOnly: true,
        fieldIds: [ITEM_ID, ITEM_TITLE, ITEM_TAGS],
      },
      {
        operationId: ITEM_CREATE,
        name: "createItem",
        label: "Create",
        tableId: ITEMS,
        kind: "create",
        access: "owner",
        readOnly: false,
        fieldIds: [ITEM_ID, ITEM_TITLE, ITEM_TAGS],
      },
    ],
  };
  const sql = `CREATE TABLE tags(id TEXT PRIMARY KEY NOT NULL,label TEXT NOT NULL,"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;
CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,tag_ids TEXT,"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;`;
  const src = generateDatasetOperations(def);
  const rev = describeDatasetRevision({
    definition: def,
    revision: 1,
    schemaSql: sql,
    operationSource: src,
  });
  const f = await phone([]);
  await f.host.activate(owner, {
    workspaceId: "w",
    revision: rev,
    schemaSql: sql,
    operationSource: src,
    capacityBytes: 4 * 1024 * 1024,
  });
  pushFile(f.storage, "big-dataset", null, {
    path: "big/dataset.json",
    text: JSON.stringify({ datasetId: DS }),
  });
  for (let i = 0; i < 126; i++) {
    const tid = `t-${String(i).padStart(3, "0")}`;
    await f.host.invoke(owner, {
      workspaceId: "w",
      datasetId: DS,
      revision: 1,
      revisionSha256: rev.revisionSha256,
      operationId: TAG_CREATE,
      input: { values: { [TAG_ID]: tid, [TAG_LABEL]: `Tag ${i}` } },
      idempotencyKey: `bt-${i}`,
    });
  }
  const lateTags = Array.from({ length: 26 }, (_, i) => `t-${String(100 + i).padStart(3, "0")}`);
  const longText = "A".repeat(4096);
  for (let i = 0; i < PHONE_COLLECTION_PAGE + 1; i++) {
    const iid = `i-${String(i).padStart(2, "0")}`;
    await f.host.invoke(owner, {
      workspaceId: "w",
      datasetId: DS,
      revision: 1,
      revisionSha256: rev.revisionSha256,
      operationId: ITEM_CREATE,
      input: {
        values: {
          [ITEM_ID]: iid,
          [ITEM_TITLE]: `${longText}-${String(i).padStart(2, "0")}`,
          [ITEM_TAGS]: i === 0 ? lateTags : [],
        },
      },
      idempotencyKey: `bi-${i}`,
    });
  }
  const page1 = await f.op("collectionRecords", {
    datasetId: DS,
    tableId: ITEMS,
    sort: { fieldId: ITEM_TITLE, direction: "asc" },
  });
  expect(page1.status).toBe(200);
  const res1 = page1.body.result as {
    nextCursor: unknown;
    relations: Record<string, Record<string, string>>;
  };
  expect(Object.keys(res1.relations[ITEM_TAGS] ?? {})).toHaveLength(26);
  expect(res1.relations[ITEM_TAGS]?.['"t-125"']).toBe("Tag 125");
  expect(res1.nextCursor).not.toBeNull();
  const page2 = await f.op("collectionRecords", {
    datasetId: DS,
    tableId: ITEMS,
    sort: { fieldId: ITEM_TITLE, direction: "asc" },
    after: res1.nextCursor,
  });
  expect(page2.status).toBe(200);
  expect((page2.body.result as { rows: Array<{ id: string }> }).rows.map((r) => r.id)).toEqual([
    `i-${PHONE_COLLECTION_PAGE}`,
  ]);
  // If a scan page hits resource_limit (e.g. bulky rows on page 2), per-key filter fallback still resolves labels.
  const bulk = "X".repeat(10_000);
  for (let i = 126; i < 156; i++) {
    const tid = `t-${String(i).padStart(3, "0")}`;
    await f.host.invoke(owner, {
      workspaceId: "w",
      datasetId: DS,
      revision: 1,
      revisionSha256: rev.revisionSha256,
      operationId: TAG_CREATE,
      input: { values: { [TAG_ID]: tid, [TAG_LABEL]: `${tid} ${bulk}` } },
      idempotencyKey: `bt-${i}`,
    });
  }
  await f.host.invoke(owner, {
    workspaceId: "w",
    datasetId: DS,
    revision: 1,
    revisionSha256: rev.revisionSha256,
    operationId: ITEM_CREATE,
    input: { values: { [ITEM_ID]: "i-bulk", [ITEM_TITLE]: "000-bulk", [ITEM_TAGS]: ["t-155"] } },
    idempotencyKey: "bi-bulk",
  });
  const bulkPage = await f.op("collectionRecords", {
    datasetId: DS,
    tableId: ITEMS,
    recordId: "i-bulk",
  });
  expect(bulkPage.status).toBe(200);
  expect(
    (bulkPage.body.result as { relations: Record<string, Record<string, string>> }).relations[
      ITEM_TAGS
    ]?.['"t-155"'],
  ).toBe(`t-155 ${bulk}`.slice(0, 500));
});

it("uploads, attaches, and downloads Collection attachments for Owner and Member, enforces 20 MiB cap, rejects forged operationId, and revokes on row/access change", async () => {
  const ATT_DS = id(90);
  const ATT_TBL = id(91);
  const ATT_ID = id(92);
  const ATT_TITLE = id(93);
  const ATT_FILE = id(94);
  const ATT_CREATE = id(95);
  const ATT_READ = id(96);
  const ATT_EDIT = id(97);
  const attDef: DatasetDefinition = {
    formatVersion: 1,
    datasetId: ATT_DS,
    name: "Expenses",
    schemaPath: "expenses/schema.sql",
    operationsPath: "expenses/operations.js",
    tables: [
      {
        tableId: ATT_TBL,
        name: "Items",
        sqlName: "items",
        primaryKey: "id",
        fields: [
          {
            fieldId: ATT_ID,
            name: "ID",
            sqlColumn: "id",
            type: "text",
            required: true,
            unique: true,
          },
          {
            fieldId: ATT_TITLE,
            name: "Title",
            sqlColumn: "title",
            type: "text",
            required: true,
            unique: false,
          },
          {
            fieldId: ATT_FILE,
            name: "Receipt",
            sqlColumn: "receipt",
            type: "attachment",
            required: false,
            unique: false,
          },
        ],
      },
    ],
    operations: [
      {
        operationId: ATT_CREATE,
        name: "createItem",
        label: "Create",
        tableId: ATT_TBL,
        kind: "create",
        access: "owner",
        readOnly: false,
        fieldIds: [ATT_ID, ATT_TITLE, ATT_FILE],
      },
      {
        operationId: ATT_READ,
        name: "readItems",
        label: "Read",
        tableId: ATT_TBL,
        kind: "read",
        access: "link",
        readOnly: true,
        fieldIds: [ATT_ID, ATT_TITLE, ATT_FILE],
      },
      {
        operationId: ATT_EDIT,
        name: "editItem",
        label: "Edit",
        tableId: ATT_TBL,
        kind: "edit",
        access: "link",
        readOnly: false,
        fieldIds: [ATT_TITLE, ATT_FILE],
        reversible: true,
      },
    ],
  };
  const attSql =
    'CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,receipt TEXT,"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;';
  const attSrc = generateDatasetOperations(attDef);
  const attRev = describeDatasetRevision({
    definition: attDef,
    revision: 1,
    schemaSql: attSql,
    operationSource: attSrc,
  });
  const f = await phone([]);
  await f.host.activate(owner, {
    workspaceId: "w",
    revision: attRev,
    schemaSql: attSql,
    operationSource: attSrc,
    capacityBytes: 32 * 1024 * 1024,
  });
  pushFile(f.storage, "att-dataset", null, {
    path: "expenses/dataset.json",
    text: JSON.stringify({ datasetId: ATT_DS }),
  });
  await f.host.invoke(owner, {
    workspaceId: "w",
    datasetId: ATT_DS,
    revision: 1,
    revisionSha256: attRev.revisionSha256,
    operationId: ATT_CREATE,
    input: { values: { [ATT_ID]: "exp-1", [ATT_TITLE]: "Flight", [ATT_FILE]: null } },
    idempotencyKey: "seed-exp-1",
  });

  const desc = await f.op("collection", { datasetId: ATT_DS });
  expect(desc.status).toBe(200);
  expect(
    (
      desc.body.result as {
        tables: Array<{ fields: Array<{ fieldId: string; editable: boolean }> }>;
      }
    ).tables[0]!.fields.find((item) => item.fieldId === ATT_FILE)?.editable,
  ).toBe(true);

  const pdfBytes = new TextEncoder().encode("%PDF-1.7\nreceipt\n");
  const uploadArgs = {
    datasetId: ATT_DS,
    tableId: ATT_TBL,
    fieldId: ATT_FILE,
    revision: 1,
    revisionSha256: attRev.revisionSha256,
    idempotencyKey: id(210),
    name: "flight.pdf",
    contentType: "application/pdf",
    bytesBase64: Buffer.from(pdfBytes).toString("base64"),
  };
  const up1 = await f.op("collectionAttachmentUpload", uploadArgs);
  expect(up1.status).toBe(200);
  const file1 = up1.body.result as { file: { fileId: string; name: string }; replayed: boolean };
  expect(file1.replayed).toBe(false);
  expect(file1.file.name).toBe("flight.pdf");

  const upReplay = await f.op("collectionAttachmentUpload", uploadArgs);
  expect(upReplay.status).toBe(200);
  expect(upReplay.body.result).toMatchObject({
    file: { fileId: file1.file.fileId, name: "flight.pdf" },
    replayed: true,
  });

  const upConflict = await f.op("collectionAttachmentUpload", {
    ...uploadArgs,
    bytesBase64: Buffer.from("%PDF-1.7\nother\n").toString("base64"),
  });
  expect(upConflict.status).toBe(409);

  const over20 = await f.op("collectionAttachmentUpload", {
    ...uploadArgs,
    idempotencyKey: id(211),
    contentType: "application/octet-stream",
    name: "huge.bin",
    bytesBase64: Buffer.alloc(20 * 1024 * 1024 + 1, 1).toString("base64"),
  });
  expect(over20.status).toBe(413);

  expect(
    await f.op("collectionEdit", {
      datasetId: ATT_DS,
      tableId: ATT_TBL,
      recordId: "exp-1",
      fieldId: ATT_FILE,
      value: file1.file.fileId,
      expectedVersion: 1,
      revision: 1,
      revisionSha256: attRev.revisionSha256,
      idempotencyKey: id(212),
    }),
  ).toEqual(ok({ saved: { version: 2, priorValue: null } }));

  const ownerRead = await f.opRaw("collectionAttachmentRead", {
    datasetId: ATT_DS,
    tableId: ATT_TBL,
    recordId: "exp-1",
    fieldId: ATT_FILE,
    fileId: file1.file.fileId,
  });
  expect(ownerRead.status).toBe(200);
  expect(ownerRead.headers.get("content-type")).toBe("application/octet-stream");
  expect(ownerRead.headers.get("x-content-type-options")).toBe("nosniff");
  expect(ownerRead.headers.get("cache-control")).toBe("private, no-store");
  expect(new Uint8Array(await ownerRead.arrayBuffer())).toEqual(pdfBytes);

  const forged = await f.op("collectionAttachmentRead", {
    datasetId: ATT_DS,
    tableId: ATT_TBL,
    recordId: "exp-1",
    fieldId: ATT_FILE,
    fileId: file1.file.fileId,
    operationId: ATT_EDIT,
  });
  expect(forged.status).toBe(400);

  const storage = f.storage as SyncRelayStorage;
  storage.inviteWorkspaceMember({
    workspaceId: "w",
    actorUserId: "owner",
    workspaceName: "Work",
    email: "ana@dohc.test",
    recipientUserId: "ana",
    newMemberId: () => "member-ana",
    newGrantId: () => "grant-ana",
    newShareId: () => "share-w",
    nowMs: 100,
  });
  storage.setWorkspaceMemberLevel({
    workspaceId: "w",
    actorUserId: "owner",
    level: "edit",
    workspaceName: undefined,
    newShareId: () => "share-w-edit",
    nowMs: 101,
  });
  storage.setShowOnPhone({ userId: "ana", workspaceId: "w", showOnPhone: true });
  f.host.setWorkspaceDefaults(owner, {
    workspaceId: "w",
    datasetId: ATT_DS,
    defaults: {
      view: [ATT_READ],
      comment: [ATT_READ],
      edit: [ATT_READ, ATT_EDIT],
      revision: 1,
      revisionSha256: attRev.revisionSha256,
    },
  });
  const ana = "ana:phone-ana:phone";
  const svgBytes = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
  );
  const memberUp = await f.op(
    "collectionAttachmentUpload",
    {
      datasetId: ATT_DS,
      tableId: ATT_TBL,
      fieldId: ATT_FILE,
      revision: 1,
      revisionSha256: attRev.revisionSha256,
      idempotencyKey: id(213),
      name: "diagram.svg",
      contentType: "image/svg+xml",
      bytesBase64: Buffer.from(svgBytes).toString("base64"),
    },
    ana,
  );
  expect(memberUp.status).toBe(200);
  const svgFileId = (memberUp.body.result as { file: { fileId: string } }).file.fileId;
  expect(
    await f.op(
      "collectionEdit",
      {
        datasetId: ATT_DS,
        tableId: ATT_TBL,
        recordId: "exp-1",
        fieldId: ATT_FILE,
        value: svgFileId,
        expectedVersion: 2,
        revision: 1,
        revisionSha256: attRev.revisionSha256,
        idempotencyKey: id(214),
      },
      ana,
    ),
  ).toEqual(ok({ saved: { version: 3, priorValue: file1.file.fileId } }));

  const memberRead = await f.opRaw(
    "collectionAttachmentRead",
    {
      datasetId: ATT_DS,
      tableId: ATT_TBL,
      recordId: "exp-1",
      fieldId: ATT_FILE,
      fileId: svgFileId,
    },
    ana,
  );
  expect(memberRead.status).toBe(200);
  expect(memberRead.headers.get("content-type")).toBe("application/octet-stream");
  expect(memberRead.headers.get("x-content-type-options")).toBe("nosniff");
  expect(memberRead.headers.get("cache-control")).toBe("private, no-store");
  expect(new Uint8Array(await memberRead.arrayBuffer())).toEqual(svgBytes);

  expect(
    (
      await f.opRaw(
        "collectionAttachmentRead",
        {
          datasetId: ATT_DS,
          tableId: ATT_TBL,
          recordId: "exp-1",
          fieldId: ATT_FILE,
          fileId: file1.file.fileId,
        },
        ana,
      )
    ).status,
  ).toBe(404);

  f.host.setWorkspaceDefaults(owner, {
    workspaceId: "w",
    datasetId: ATT_DS,
    defaults: {
      view: [],
      comment: [],
      edit: [],
      revision: 1,
      revisionSha256: attRev.revisionSha256,
    },
  });
  expect(
    (
      await f.opRaw(
        "collectionAttachmentRead",
        {
          datasetId: ATT_DS,
          tableId: ATT_TBL,
          recordId: "exp-1",
          fieldId: ATT_FILE,
          fileId: svgFileId,
        },
        ana,
      )
    ).status,
  ).toBe(404);
});
