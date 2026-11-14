import { createHash } from "node:crypto";
import { privateFolder } from "./private-folder.test-helper";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { createDatasetJournal, type DatasetScope } from "./journal.ts";
import { decodeChangeset } from "./dataset-change-facts.ts";
import { createDatasetSupervisor } from "./supervisor.ts";
import { createDatasetHost, type DatasetAuthority } from "./dataset-host.ts";
import type { JsonValue } from "./protocol.ts";
import {
  createDatasetAutomationClaims,
  DATASET_AUTOMATION_CHAIN_STOPPED,
  DATASET_AUTOMATION_CLAIMS_PER_COMMIT,
  DATASET_AUTOMATION_HISTORY_RETENTION_MS,
  DATASET_AUTOMATION_PRESS_RETENTION_MS,
  DATASET_AUTOMATION_RECLAIM_EXHAUSTED,
  type DatasetActor,
  type DatasetAutomationClaim,
  type DatasetAutomationClaims,
  type DatasetChangeClaimFact,
  type DatasetChangeKind,
  type DatasetPressInput,
} from "./dataset-automation-claims.ts";

vi.setConfig({ testTimeout: 30_000 });
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const scope = { workspaceId: "workspace", datasetId: id(1) };
const TASKS = id(2),
  STATUS = id(4),
  NOTES = id(5),
  TAGS = id(6),
  BUTTON = id(10);
const ANA = { kind: "owner", userId: "user-ana" } as const,
  BEN = { kind: "named", userId: "user-ben" } as const;
// The executor's hash of the automation a press was checked against.
const CHECKED = digest("collection:tasks#paid as checked");
const authorize = () => {};

function changeOf(claim: DatasetAutomationClaim): DatasetChangeClaimFact {
  if (claim.fact === null || claim.fact.kind === "button")
    throw new Error("This claim holds no change.");
  return claim.fact;
}
function drain(claims: Pick<DatasetAutomationClaims, "next">): DatasetAutomationClaim[] {
  const started: DatasetAutomationClaim[] = [];
  for (let claim = claims.next(scope.workspaceId); claim; claim = claims.next(scope.workspaceId))
    started.push(claim);
  return started;
}
function subscription(
  automationId: string,
  kinds: DatasetChangeKind[],
  fieldIds: string[] | null = null,
  tableId = TASKS,
) {
  return { automationId, tableId, kinds, fieldIds, definitionHash: digest(automationId) };
}
function transactions(db: DatabaseSync) {
  return <T>(run: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
}
const tasks = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => `('${String(index).padStart(3, "0")}','Open','')`,
  ).join(",");
// Everything the ledger retains for the dataset, as it charged it.
function retained(db: DatabaseSync): number {
  return ["claims", "revisions", "failure_generations", "presses"].reduce(
    (sum, table) =>
      sum +
      Number(
        db
          .prepare(
            `SELECT coalesce(sum(storage_bytes),0) AS bytes FROM dohc_dataset_automation_${table}`,
          )
          .get()!.bytes,
      ),
    0,
  );
}

// The journal and ledger alone. A commit's changeset comes from a session
// over a copy of the dataset, the way the worker prepares one.
const ledgerSchema =
  "CREATE TABLE tasks(id TEXT PRIMARY KEY NOT NULL,status TEXT NOT NULL,notes TEXT NOT NULL); CREATE TABLE tags(id INTEGER PRIMARY KEY,name TEXT NOT NULL);";
const ledgerDefinition: DatasetDefinition = {
  formatVersion: 1,
  datasetId: scope.datasetId,
  name: "Tasks",
  schemaPath: "tasks/schema.sql",
  operationsPath: "tasks/operations.js",
  tables: [
    {
      tableId: TASKS,
      name: "Tasks",
      sqlName: "tasks",
      primaryKey: "id",
      fields: [
        { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
        {
          fieldId: STATUS,
          name: "Status",
          sqlColumn: "status",
          type: "text",
          required: true,
          unique: false,
        },
        {
          fieldId: NOTES,
          name: "Notes",
          sqlColumn: "notes",
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
          fieldId: id(7),
          name: "ID",
          sqlColumn: "id",
          type: "number",
          required: true,
          unique: true,
        },
        {
          fieldId: id(8),
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
      operationId: id(9),
      name: "read",
      label: "Read",
      tableId: TASKS,
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [STATUS],
    },
  ],
};
const ledgerRevision = describeDatasetRevision({
  definition: ledgerDefinition,
  revision: 1,
  schemaSql: ledgerSchema,
  operationSource: "globalThis.operations={};",
});

function ledger() {
  const directory = mkdtempSync(join(tmpdir(), "dohc-automation-claims-"));
  const seed = new DatabaseSync(join(directory, "seed.sqlite"));
  seed.exec(ledgerSchema);
  seed.close();
  const data = new DatabaseSync(":memory:");
  data.exec(ledgerSchema);
  const columns = Object.fromEntries(
    ["tasks", "tags"].map((table) => [
      table,
      data
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((column) => String(column.name)),
    ]),
  );
  const db = new DatabaseSync(join(directory, "host.sqlite"));
  db.exec("PRAGMA journal_mode=WAL;");
  cleanups.push(() => {
    data.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const transaction = transactions(db);
  const wakes: Array<{ scope: DatasetScope; failed: boolean; inTransaction: boolean }> = [];
  let clock = 1_000,
    charged = 0;
  const open = () =>
    createDatasetAutomationClaims({
      db,
      transaction,
      nowMs: () => clock,
      account(key, bytes) {
        expect(key).toEqual(scope);
        expect(db.isTransaction).toBe(true);
        charged += bytes;
      },
      wake: (woken, failed) =>
        wakes.push({ scope: woken, failed, inTransaction: db.isTransaction }),
    });
  let claims = open();
  const journal = createDatasetJournal({ db, transaction });
  let cursor = journal.initialize({
    scope,
    hostEpoch: "host-1",
    approvedRevisionHash: ledgerRevision.revisionSha256,
    source: "globalThis.operations={};",
    schemaSql: ledgerSchema,
    definitionJson: JSON.stringify(ledgerRevision),
    checkpoint: readFileSync(join(directory, "seed.sqlite")),
    authorize,
  });
  const recorded: number[] = [];
  function commit(
    sql: string,
    actor: DatasetActor = { kind: "owner" },
    key = `change-${cursor.revision + 1}`,
  ) {
    const session = data.createSession();
    data.exec(sql);
    const changeset = session.changeset();
    session.close();
    const result = journal.commitOperation({
      expected: cursor,
      proposalId: `proposal-${key}`,
      operation: "change",
      callerKey: "caller",
      idempotencyKey: key,
      payloadSha256: digest(key),
      resultJson: "{}",
      changeset,
      changesetSha256: digest(changeset),
      attachedFileIds: [],
      authorize,
      recordCommit: (committed) => {
        recorded.push(committed.cursor.revision);
        return claims.recordCommit({ ...committed, columns, approved: ledgerRevision, actor });
      },
    });
    if (result.kind === "committed") cursor = result.event.cursor;
    return { ...result, changeset };
  }
  return {
    db,
    wakes,
    recorded,
    commit,
    get claims() {
      return claims;
    },
    get charged() {
      return charged;
    },
    get cursor() {
      return cursor;
    },
    reopen() {
      claims = open();
    },
    tick(ms: number) {
      clock += ms;
    },
  };
}

it("claims each changed record once per subscribed automation, by table, change kind, and watched field", async () => {
  const f = ledger();
  f.claims.subscribe(scope, subscription("collection:tasks#status", ["changed"], [STATUS]));
  f.claims.subscribe(scope, subscription("collection:tasks#arrivals", ["added", "removed"]));
  f.claims.subscribe(scope, subscription("collection:tags#new", ["added"], null, TAGS));
  f.commit("INSERT INTO tasks VALUES('a','Open','first'),('b','Open','second')");
  f.commit("UPDATE tasks SET status='Done',notes='seen' WHERE id='a'");
  f.commit("UPDATE tasks SET notes='edited' WHERE id='a'");
  f.commit("DELETE FROM tasks WHERE id='b'");
  expect(f.recorded).toEqual([1, 2, 3, 4]);
  // Claims start in commit order; within a commit, in the changeset's order.
  const started = drain(f.claims);
  expect(started.map((claim) => claim.revision)).toEqual([1, 1, 2, 4]);
  expect(
    started
      .map(
        (claim) =>
          `${claim.revision} ${claim.fact!.kind} ${claim.fact!.recordId} ${claim.automationId}`,
      )
      .sort(),
  ).toEqual([
    "1 added a collection:tasks#arrivals",
    "1 added b collection:tasks#arrivals",
    "2 changed a collection:tasks#status",
    "4 removed b collection:tasks#arrivals",
  ]);
  // A claim carries only the fields its automation watches.
  expect(started[2]).toMatchObject({
    state: "running",
    attempts: 1,
    run: 1,
    depth: 0,
    actor: { kind: "owner" },
    hostEpoch: "host-1",
    fact: { tableId: TASKS, fields: [{ fieldId: STATUS, previous: "Open", next: "Done" }] },
  });
  expect(changeOf(started[0]!).fields.map((field) => field.fieldId)).toEqual([
    id(3),
    STATUS,
    NOTES,
  ]);
  expect(new Set(started.map((claim) => claim.claimId)).size).toBe(started.length);
  expect(f.claims.next(scope.workspaceId)).toBeNull();
  await Promise.resolve();
  expect(f.wakes).toEqual([1, 2, 4].map(() => ({ scope, failed: false, inTransaction: false })));
});

it("commits a change it cannot read, failing only the automations that watch what it holds, wherever the refusal falls", () => {
  const f = ledger();
  f.claims.subscribe(scope, subscription("collection:tasks#a", ["added"]));
  f.claims.subscribe(scope, subscription("collection:tasks#b", ["added"]));
  f.claims.subscribe(scope, subscription("collection:tags#new", ["added"], null, TAGS));
  f.claims.subscribe(scope, subscription("collection:tasks#done", ["changed"]));
  f.claims.subscribe(scope, subscription("collection:tags#gone", ["removed"], null, TAGS));
  // More matching records than the limit come before a value no field type holds.
  const committed = f.commit(
    `INSERT INTO tasks VALUES${tasks(101)}; INSERT INTO tags VALUES(1,randomblob(4));`,
  );
  expect(committed.kind).toBe("committed");
  const decoded = [...decodeChangeset(committed.changeset)];
  expect(decoded.findIndex((row) => row.table === "tags")).toBeGreaterThan(
    DATASET_AUTOMATION_CLAIMS_PER_COMMIT / 2,
  );
  expect(f.claims.next(scope.workspaceId)).toBeNull();
  const failed = f.db
    .prepare(
      "SELECT claim_id,automation_id,state,attempts,fact,error FROM dohc_dataset_automation_claims ORDER BY automation_id",
    )
    .all();
  expect(
    failed.map((row) => [row.automation_id, row.state, row.attempts, row.fact, row.error]),
  ).toEqual(
    ["collection:tags#new", "collection:tasks#a", "collection:tasks#b"].map((automationId) => [
      automationId,
      "failed",
      0,
      null,
      "Name holds bytes, which no field type can hold.",
    ]),
  );
  expect(() =>
    f.claims.retry({ workspaceId: scope.workspaceId, claimId: String(failed[0]!.claim_id) }),
  ).toThrow("cannot run again");
  // When even the change's tables cannot be read, every automation hears of it.
  const revision = f.cursor.revision + 1;
  f.db.exec("BEGIN IMMEDIATE");
  f.claims.recordCommit({
    cursor: { ...f.cursor, revision },
    changeset: Uint8Array.of(0x54),
    columns: {},
    approved: ledgerRevision,
    actor: { kind: "owner" },
  });
  f.db.exec("COMMIT");
  expect(
    f.db
      .prepare(
        "SELECT count(*) AS count FROM dohc_dataset_automation_claims WHERE revision=? AND state='failed' AND fact IS NULL",
      )
      .get(revision),
  ).toEqual({ count: 5 });
  expect(f.charged).toBe(retained(f.db));
});

it("reads which tables a refused change holds without reading its values", () => {
  const f = ledger();
  f.claims.subscribe(scope, subscription("collection:tasks#a", ["added"]));
  f.claims.subscribe(scope, subscription("collection:tags#gone", ["removed"], null, TAGS));
  expect(f.commit("INSERT INTO tasks VALUES('a',CAST(x'80' AS TEXT),'')").kind).toBe("committed");
  expect(
    f.db.prepare("SELECT automation_id,state,attempts FROM dohc_dataset_automation_claims").all(),
  ).toEqual([{ automation_id: "collection:tasks#a", state: "failed", attempts: 0 }]);
});

it("never claims an automation's own commit, records it for History, and stops the chain at depth 4", async () => {
  const f = ledger();
  f.claims.subscribe(scope, subscription("collection:tasks#a", ["added"]));
  f.claims.subscribe(scope, subscription("collection:tasks#b", ["added"]));
  f.commit("INSERT INTO tasks VALUES('a','Open','')", {
    kind: "automation",
    automationId: "collection:tasks#a",
    depth: 1,
  });
  const [claim, ...rest] = drain(f.claims);
  expect(rest).toEqual([]);
  expect(claim).toMatchObject({
    automationId: "collection:tasks#b",
    depth: 1,
    actor: { kind: "automation", automationId: "collection:tasks#a", depth: 1 },
  });
  f.commit("INSERT INTO tasks VALUES('b','Open','')", {
    kind: "automation",
    automationId: "collection:tasks#b",
    depth: 4,
  });
  expect(f.claims.next(scope.workspaceId)).toBeNull();
  const stopped = f.db
    .prepare(
      "SELECT claim_id,automation_id,state,attempts,error FROM dohc_dataset_automation_claims WHERE revision=2",
    )
    .get()!;
  expect(stopped).toMatchObject({
    automation_id: "collection:tasks#a",
    state: "failed",
    attempts: 0,
    error: DATASET_AUTOMATION_CHAIN_STOPPED,
  });
  expect(() =>
    f.claims.retry({ workspaceId: scope.workspaceId, claimId: String(stopped.claim_id) }),
  ).toThrow("cannot run again");
  expect(
    f.db
      .prepare(
        "SELECT revision,automation_id,depth FROM dohc_dataset_automation_revisions ORDER BY revision",
      )
      .all(),
  ).toEqual([
    { revision: 1, automation_id: "collection:tasks#a", depth: 1 },
    { revision: 2, automation_id: "collection:tasks#b", depth: 4 },
  ]);
  // The stop's wake says it made a failure, so its notice goes out without waiting for another change.
  await Promise.resolve();
  expect(f.wakes.map((wake) => wake.failed)).toEqual([false, true]);
  expect(f.claims.failures(scope.workspaceId)).toMatchObject([
    {
      automationId: "collection:tasks#a",
      neverStarted: true,
      chainStopped: true,
      error: DATASET_AUTOMATION_CHAIN_STOPPED,
    },
  ]);
});

it("charges what it keeps, and keeps claims 30 days, and the newest failure longer", () => {
  const f = ledger();
  f.claims.subscribe(scope, subscription("collection:tasks#a", ["added"]));
  f.commit("INSERT INTO tasks VALUES('first','Open','')", {
    kind: "automation",
    automationId: "collection:tasks#x",
    depth: 4,
  });
  const count = 5;
  f.commit(
    `INSERT INTO tasks VALUES${Array.from({ length: count }, (_, index) => `('${String(index).padStart(3, "0")}','Open','')`).join(",")}`,
  );
  expect(f.charged).toBe(retained(f.db));
  const started = drain(f.claims);
  expect(started).toHaveLength(count);
  f.claims.settle(started[0]!, { state: "failed", error: `The step failed. ${"é".repeat(2000)}` });
  for (const claim of started.slice(1)) f.claims.settle(claim, { state: "done" });
  const rows = () =>
    f.db
      .prepare("SELECT claim_id,state,error FROM dohc_dataset_automation_claims ORDER BY rowid")
      .all();
  // Within 30 days every claim stays.
  f.tick(DATASET_AUTOMATION_HISTORY_RETENTION_MS);
  expect(f.claims.pruneHistory(scope.workspaceId, [])).toEqual({ pruned: 0, more: false });
  expect(rows()).toHaveLength(count + 1);
  // Past them, a claim goes unless the prune keeps it or it is the newest
  // failure, which the notice offers. The chain stop's failure stays counted.
  f.tick(1);
  const keep = started[4]!.claimId;
  expect(f.claims.pruneHistory(scope.workspaceId, [keep])).toEqual({
    pruned: count - 1,
    more: false,
  });
  const kept = rows();
  expect(kept.map((row) => row.claim_id)).toEqual([started[0]!.claimId, keep]);
  expect(Buffer.byteLength(String(kept[0]!.error))).toBeLessThanOrEqual(1024);
  expect(String(kept[0]!.error)).toMatch(/^The step failed\. é+$/);
  expect(f.claims.failures(scope.workspaceId)).toMatchObject([
    { claimId: started[0]!.claimId, generation: 2 },
  ]);
  expect(f.charged).toBe(retained(f.db));
});

it("requeues a claim a dead process left running, and fails it once it died at the attempt cap", () => {
  const f = ledger();
  f.claims.subscribe(scope, subscription("collection:tasks#a", ["added"]));
  f.commit("INSERT INTO tasks VALUES('a','Open','')");
  const first = f.claims.next(scope.workspaceId)!;
  f.reopen();
  expect(() => f.claims.settle(first, { state: "done" })).toThrow("no longer current");
  const second = f.claims.next(scope.workspaceId)!;
  expect(second).toMatchObject({ claimId: first.claimId, attempts: 2, run: 1 });
  f.reopen();
  expect(f.claims.next(scope.workspaceId)).toBeNull();
  expect(f.db.prepare("SELECT state,error FROM dohc_dataset_automation_claims").get()).toEqual({
    state: "failed",
    error: DATASET_AUTOMATION_RECLAIM_EXHAUSTED,
  });
  expect(f.claims.retry(second)).toMatchObject({ state: "pending", run: 2, error: null });
  expect(f.charged).toBe(retained(f.db));
});

it("keeps subscriptions current, and forgets a deleted dataset", () => {
  const f = ledger();
  f.claims.subscribe(scope, subscription("collection:tasks#a", ["added"]));
  f.claims.subscribe(scope, subscription("collection:tasks#a", ["changed", "added"], [STATUS]));
  f.claims.subscribe(
    { ...scope, datasetId: id(99) },
    subscription("collection:other#b", ["removed"]),
  );
  expect(f.claims.subscriptions(scope.workspaceId)).toEqual([
    {
      datasetId: scope.datasetId,
      ...subscription("collection:tasks#a", ["added", "changed"], [STATUS]),
    },
    { datasetId: id(99), ...subscription("collection:other#b", ["removed"]) },
  ]);
  expect(f.claims.subscriptions("elsewhere")).toEqual([]);
  expect(() => f.claims.subscribe(scope, subscription("collection:tasks#b", []))).toThrow(
    "change kinds",
  );
  expect(() =>
    f.claims.subscribe(scope, {
      ...subscription("collection:tasks#b", ["added"]),
      definitionHash: "edited",
    }),
  ).toThrow("definition hash");
  f.commit("INSERT INTO tasks VALUES('a','Open','')", {
    kind: "automation",
    automationId: "collection:tasks#b",
    depth: 1,
  });
  f.claims.press({
    cursor: f.cursor,
    pressId: "press-1",
    automationId: "collection:tasks#paid",
    definitionHash: CHECKED,
    tableId: TASKS,
    fieldId: BUTTON,
    recordId: "a",
    presser: ANA,
    request: request("a", ANA),
  });
  f.db.exec("BEGIN IMMEDIATE");
  f.claims.forget(scope);
  f.db.exec("COMMIT");
  for (const table of ["subscriptions", "claims", "revisions", "presses"]) {
    expect(
      f.db
        .prepare(
          `SELECT count(*) AS count FROM dohc_dataset_automation_${table} WHERE dataset_id=?`,
        )
        .get(scope.datasetId),
    ).toEqual({ count: 0 });
  }
  expect(f.claims.subscriptions(scope.workspaceId)).toEqual([
    { datasetId: id(99), ...subscription("collection:other#b", ["removed"]) },
  ]);
});

// The press as its window asked for it, as main hashes it.
const request = (...asked: unknown[]) => digest(JSON.stringify(asked));
function presses(f: ReturnType<typeof ledger>) {
  return (
    pressId: string,
    recordId: string | number = "a",
    presser: DatasetPressInput["presser"] = ANA,
    automationId = "collection:tasks#paid",
  ) =>
    f.claims.press({
      cursor: f.cursor,
      pressId,
      automationId,
      definitionHash: CHECKED,
      tableId: TASKS,
      fieldId: BUTTON,
      recordId,
      presser,
      request: request(recordId, presser, automationId),
    });
}

it("claims a press for the person who pressed, answers the same press sent again, and runs a button once per record", () => {
  const f = ledger();
  const press = presses(f);
  f.commit("INSERT INTO tasks VALUES('a','Open','')");
  const first = press("press-1");
  expect(first).toMatchObject({
    kind: "claimed",
    claim: {
      automationId: "collection:tasks#paid",
      state: "pending",
      depth: 0,
      attempts: 0,
      run: 1,
      hostEpoch: "host-1",
      revision: 1,
      fact: {
        kind: "button",
        datasetId: scope.datasetId,
        tableId: TASKS,
        recordId: "a",
        fieldId: BUTTON,
        definitionHash: CHECKED,
      },
      actor: ANA,
    },
  });
  if (first.kind === "busy") throw new Error("The first press ran.");
  // The press sent again, and a double click, answer the one claim.
  expect(press("press-1")).toEqual({ kind: "joined", claim: first.claim });
  expect(press("press-2")).toEqual({ kind: "joined", claim: first.claim });
  // Someone else's press gets no claim while it runs for Ana, and neither does a press of another automation the button now runs.
  expect(press("press-3", "a", BEN)).toEqual({ kind: "busy" });
  expect(press("press-9", "a", ANA, "collection:tasks#settle")).toEqual({ kind: "busy" });
  expect(f.claims.pressed(scope.workspaceId, "press-3")).toBeNull();
  // Another button on the record runs on its own.
  expect(
    f.claims.press({
      cursor: f.cursor,
      pressId: "press-8",
      automationId: "collection:tasks#paid",
      definitionHash: CHECKED,
      tableId: TASKS,
      fieldId: id(11),
      recordId: "a",
      presser: BEN,
      request: request("refund", BEN),
    }),
  ).toMatchObject({ kind: "claimed" });
  // Another record runs on its own, and a number is not its text.
  const numbered = press("press-4", 1),
    text = press("press-5", "1");
  expect([numbered.kind, text.kind]).toEqual(["claimed", "claimed"]);
  // A press id names one press.
  expect(() => press("press-1", "b")).toThrow("already names another press");
  expect(() => press("press-2", "a", BEN)).toThrow("already names another press");
  expect(() => press("press-6", { id: 1 } as unknown as string)).toThrow(
    "Invalid automation record",
  );
  expect(() =>
    f.claims.press({
      cursor: f.cursor,
      pressId: "press-10",
      automationId: "collection:tasks#paid",
      definitionHash: "edited",
      tableId: TASKS,
      fieldId: BUTTON,
      recordId: "c",
      presser: ANA,
      request: request("c", ANA),
    }),
  ).toThrow("definition hash");
  // The same request sent again answers its press, whatever its button or automation resolves to now.
  expect(
    f.claims.press({
      cursor: f.cursor,
      pressId: "press-1",
      automationId: "collection:tasks#renamed",
      definitionHash: CHECKED,
      tableId: TAGS,
      fieldId: id(11),
      recordId: "z",
      presser: ANA,
      request: request("a", ANA, "collection:tasks#paid"),
    }),
  ).toEqual({ kind: "joined", claim: first.claim });
  // Once the run settles, a new press runs again, and the settled press still answers its claim.
  for (const started of drain(f.claims)) f.claims.settle(started, { state: "done" });
  expect(f.claims.pressed(scope.workspaceId, "press-2")).toMatchObject({
    claim: { claimId: first.claim.claimId, state: "done" },
    request: request("a", ANA, "collection:tasks#paid"),
  });
  expect(press("press-1")).toMatchObject({
    kind: "joined",
    claim: { claimId: first.claim.claimId, state: "done" },
  });
  const again = press("press-7", "a", BEN);
  expect(again).toMatchObject({ kind: "claimed", claim: { actor: BEN, state: "pending" } });
  expect(again.kind !== "busy" && again.claim.claimId).not.toBe(first.claim.claimId);
  expect(f.charged).toBe(retained(f.db));
});

it("keeps a pressed claim while its press is remembered, and expires both after 30 days", () => {
  const f = ledger();
  const press = presses(f);
  const first = press("press-first");
  if (first.kind === "busy") throw new Error("The first press ran.");
  for (const started of drain(f.claims)) f.claims.settle(started, { state: "done" });
  f.tick(DATASET_AUTOMATION_HISTORY_RETENTION_MS);
  expect(f.claims.pruneHistory(scope.workspaceId, [])).toEqual({ pruned: 0, more: false });
  expect(f.claims.pressed(scope.workspaceId, "press-first")?.claim.claimId).toBe(
    first.claim.claimId,
  );
  f.tick(DATASET_AUTOMATION_PRESS_RETENTION_MS + 1);
  expect(f.claims.pressed(scope.workspaceId, "press-first")).toBeNull();
  // The next press forgets the old ones.
  press("press-late", "late");
  // The press sent again once the ledger forgot it still finds its claim, when nothing committed since.
  expect(press("press-first")).toMatchObject({
    kind: "joined",
    claim: { claimId: first.claim.claimId, state: "done" },
  });
  expect(() => press("press-first", "a", BEN)).toThrow("already names another press");
  // Expiring run history deletes the claims no press names.
  for (const started of drain(f.claims)) f.claims.settle(started, { state: "done" });
  f.tick(DATASET_AUTOMATION_HISTORY_RETENTION_MS + 1);
  f.claims.pruneHistory(scope.workspaceId, []);
  const count = (table: string) =>
    f.db.prepare(`SELECT count(*) AS count FROM dohc_dataset_automation_${table}`).get();
  expect([count("presses"), count("claims")]).toEqual([{ count: 0 }, { count: 0 }]);
  expect(f.charged).toBe(retained(f.db));
});

it("tries a failed press again only while its button does not run on the record, for any automation", () => {
  const f = ledger();
  const press = presses(f);
  const ana = press("press-ana");
  if (ana.kind === "busy") throw new Error("Ana's press ran.");
  const [started] = drain(f.claims);
  f.claims.settle(started!, { state: "failed", error: "Status is not a field." });
  // The button now runs another automation, which Ben presses.
  const ben = press("press-ben", "a", BEN, "collection:tasks#settle");
  expect(ben).toMatchObject({ kind: "claimed" });
  expect(() => f.claims.retry(ana.claim)).toThrow(
    "This button is already running for this record.",
  );
  expect(
    f.claims.claims(scope.workspaceId, "collection:tasks#paid").claims.map((claim) => claim.state),
  ).toEqual(["failed"]);
  for (const claim of drain(f.claims)) f.claims.settle(claim, { state: "done" });
  expect(f.claims.retry(ana.claim)).toMatchObject({
    claimId: ana.claim.claimId,
    state: "pending",
    run: 2,
  });
});

// The whole host, with a real worker: the actor comes from the context, and
// only a new commit claims.
const hostSource = `globalThis.operations={
  create(ctx,input){ctx.db.execute('INSERT INTO items VALUES(?,?)',[ctx.requestId,input.value]);return {id:ctx.requestId};},
  read(ctx){return ctx.db.query('SELECT id,value FROM items ORDER BY id');}
};`;
const ITEMS = id(12),
  CREATE = id(15),
  READ = id(16),
  WELCOME = id(17);
const hostDefinition: DatasetDefinition = {
  formatVersion: 1,
  datasetId: scope.datasetId,
  name: "Sign-ups",
  schemaPath: "signups/schema.sql",
  operationsPath: "signups/operations.js",
  tables: [
    {
      tableId: ITEMS,
      name: "Items",
      sqlName: "items",
      primaryKey: "id",
      fields: [
        {
          fieldId: id(13),
          name: "ID",
          sqlColumn: "id",
          type: "text",
          required: true,
          unique: true,
        },
        {
          fieldId: id(14),
          name: "Value",
          sqlColumn: "value",
          type: "text",
          required: true,
          unique: false,
        },
        { fieldId: WELCOME, name: "Welcome", type: "button" },
      ],
    },
  ],
  operations: [
    {
      operationId: CREATE,
      name: "create",
      label: "Sign up",
      tableId: ITEMS,
      kind: "create",
      access: "link",
      readOnly: false,
      fieldIds: [id(14)],
    },
    {
      operationId: READ,
      name: "read",
      label: "Read",
      tableId: ITEMS,
      kind: "read",
      access: "owner",
      readOnly: true,
      fieldIds: [id(13), id(14)],
    },
  ],
};
// A context names the authority resolveAuthority returns: the owner, a link
// visitor, an automation at a depth, or an exact authority to probe the host with.
type Context =
  | "owner"
  | "visitor"
  | { automationId: string; depth: number; visitor?: true }
  | { authority: DatasetAuthority };

const hostSchema = "CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);";
async function host(operationSource = hostSource, definition = hostDefinition) {
  const revision = describeDatasetRevision({
    definition,
    revision: 1,
    schemaSql: hostSchema,
    operationSource,
  });
  const directory = mkdtempSync(join(tmpdir(), "dohc-automation-host-"));
  const db = new DatabaseSync(join(directory, "host.sqlite"));
  db.exec("PRAGMA journal_mode=WAL;");
  const transaction = transactions(db);
  const journal = createDatasetJournal({ db, transaction });
  let supervisor = await createDatasetSupervisor({
    journal,
    directory: privateFolder(join(directory, "workers")),
  });
  const wakes: DatasetScope[] = [],
    storage = { bytes: 0, limit: Number.POSITIVE_INFINITY };
  cleanups.push(async () => {
    await supervisor.close();
    db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  });
  const visitor = { kind: "link" as const, principalId: "visitor", grantId: "public-link" };
  const create = () =>
    createDatasetHost<Context>({
      db,
      transaction,
      journal,
      supervisor,
      wakeAutomations: (woken) => wakes.push(woken),
      accountAutomations(allocation) {
        if (storage.bytes + allocation.bytes > storage.limit)
          throw new Error("Collection storage is full.");
        storage.bytes += allocation.bytes;
      },
      resolveAuthority(context, request) {
        if (context === "owner")
          return { caller: { kind: "owner", userId: "owner" }, principalKey: "owner" };
        if (context === "visitor")
          return {
            caller: visitor,
            principalKey: "visitor",
            ...(request.access.kind === "app" ? { appId: request.access.appId } : {}),
          };
        if ("authority" in context) return context.authority;
        return {
          caller: context.visitor
            ? visitor
            : { kind: "automation", automationId: context.automationId },
          principalKey: `automation:${context.automationId}`,
          chainDepth: context.depth,
          ...(request.access.kind === "app" ? { appId: request.access.appId } : {}),
        };
      },
    });
  let current = create();
  await current.activate("owner", {
    workspaceId: scope.workspaceId,
    revision,
    schemaSql: hostSchema,
    operationSource,
  });
  const invoke = (context: Context, operationId: string, idempotencyKey: string, appId?: string) =>
    current.invoke(context, {
      ...scope,
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationId,
      input: operationId === CREATE ? { value: idempotencyKey } : {},
      idempotencyKey,
      ...(appId ? { access: { kind: "app" as const, appId } } : {}),
    });
  return {
    db,
    journal,
    wakes,
    storage,
    invoke,
    revision,
    get host() {
      return current;
    },
    get claims() {
      return current.automationClaims;
    },
    async restart() {
      await supervisor.close();
      supervisor = await createDatasetSupervisor({
        journal,
        directory: privateFolder(join(directory, "workers")),
      });
      current = create();
    },
  };
}

it("claims a host commit once, as the actor its context names, and never on a replay or recovery", async () => {
  const f = await host();
  f.claims.subscribe(scope, subscription("collection:signups#welcome", ["added"], null, ITEMS));
  f.host.setBinding("owner", {
    ...scope,
    appId: "form",
    binding: {
      kind: "dataset",
      datasetId: scope.datasetId,
      revision: 1,
      revisionSha256: f.revision.revisionSha256,
      operationIds: [CREATE],
    },
  });
  expect(await f.invoke("visitor", CREATE, "signup-1", "form")).toMatchObject({ replayed: false });
  expect(await f.invoke("visitor", CREATE, "signup-1", "form")).toMatchObject({ replayed: true });
  // A new worker replays the journal to recover; that claims nothing.
  await f.restart();
  expect(await f.invoke("owner", READ, "read-1")).toMatchObject({
    result: [{ value: "signup-1" }],
  });
  await f.invoke("owner", CREATE, "owner-1");
  expect(drain(f.claims).map((claim) => [claim.revision, claim.actor])).toEqual([
    [1, { kind: "link", appId: "form" }],
    [2, { kind: "owner" }],
  ]);
  expect(f.wakes).toEqual([scope, scope]);
  expect(f.storage.bytes).toBe(retained(f.db));
});

it("rolls a commit back when its claims cannot be kept, and the next write still lands", async () => {
  const f = await host();
  f.claims.subscribe(scope, subscription("collection:signups#welcome", ["added"], null, ITEMS));
  f.storage.limit = 0;
  await expect(f.invoke("owner", CREATE, "refused")).rejects.toThrow("Collection storage is full.");
  expect(f.db.prepare("SELECT count(*) AS count FROM dohc_dataset_events").get()).toEqual({
    count: 0,
  });
  f.storage.limit = Number.POSITIVE_INFINITY;
  await f.invoke("owner", CREATE, "kept");
  expect(await f.invoke("owner", READ, "read-1")).toMatchObject({ result: [{ value: "kept" }] });
  expect(drain(f.claims).map((claim) => [claim.revision, changeOf(claim).fields[1]!.next])).toEqual(
    [[1, "kept"]],
  );
});

it("takes an automation's identity from its context, and grants it no owner administration", async () => {
  const f = await host();
  f.claims.subscribe(scope, subscription("collection:signups#a", ["added"], null, ITEMS));
  f.claims.subscribe(scope, subscription("collection:signups#b", ["added"], null, ITEMS));
  await f.invoke({ automationId: "collection:signups#a", depth: 2 }, CREATE, "step-1");
  expect(drain(f.claims).map((claim) => [claim.automationId, claim.depth, claim.actor])).toEqual([
    [
      "collection:signups#b",
      2,
      { kind: "automation", automationId: "collection:signups#a", depth: 2 },
    ],
  ]);
  // History names the automation behind its change, and only that change.
  await f.invoke("owner", CREATE, "by-hand");
  expect(f.host.history("owner", scope).entries.map((entry) => entry.automation ?? null)).toEqual([
    null,
    { automationId: "collection:signups#a", depth: 2 },
  ]);
  await expect(
    f.invoke({ automationId: "collection:signups#a", depth: 1, visitor: true }, CREATE, "step-2"),
  ).rejects.toThrow("You do not have access to this Collection.");
  await expect(
    f.invoke({ automationId: "collection:signups#a", depth: 5 }, CREATE, "step-3"),
  ).rejects.toThrow("You do not have access to this Collection.");
  expect(() => f.host.lifecycle({ automationId: "collection:signups#a", depth: 1 }, scope)).toThrow(
    "You do not have access to this Collection.",
  );
  expect(f.storage.bytes).toBe(retained(f.db));
});

it("refuses an automation through an app, and a chain depth that is missing, out of range, or on another caller", async () => {
  const f = await host();
  f.host.setBinding("owner", {
    ...scope,
    appId: "form",
    binding: {
      kind: "dataset",
      datasetId: scope.datasetId,
      revision: 1,
      revisionSha256: f.revision.revisionSha256,
      operationIds: [CREATE],
    },
  });
  // The binding admits a link visitor, so only the automation guard refuses the automation.
  expect(await f.invoke("visitor", CREATE, "visitor", "form")).toMatchObject({ replayed: false });
  await expect(
    f.invoke({ automationId: "collection:signups#a", depth: 1 }, CREATE, "as-app", "form"),
  ).rejects.toThrow("You do not have access to this Collection.");
  const automation = { kind: "automation" as const, automationId: "collection:signups#a" };
  const refused: DatasetAuthority[] = [
    { caller: automation, principalKey: "automation" },
    { caller: automation, principalKey: "automation", chainDepth: 0 },
    { caller: automation, principalKey: "automation", chainDepth: 1.5 },
    { caller: { kind: "owner", userId: "owner" }, principalKey: "owner", chainDepth: 1 },
    {
      caller: { kind: "named", userId: "ana", grantId: "grant", access: "edit", helper: true },
      principalKey: "ana",
      chainDepth: 1,
    },
  ];
  for (const [index, authority] of refused.entries()) {
    await expect(f.invoke({ authority }, CREATE, `depth-${index}`)).rejects.toThrow(
      "You do not have access to this Collection.",
    );
  }
  // Owner administration refuses it at every depth it may write at.
  const context = { automationId: "collection:signups#a", depth: 1 };
  expect(() => f.host.permissions(context, scope)).toThrow(
    "You do not have access to this Collection.",
  );
  expect(() => f.host.approvedArtifacts(context, scope)).toThrow(
    "You do not have access to this Collection.",
  );
  expect(() => f.host.setBinding(context, { ...scope, appId: "other", binding: null })).toThrow(
    "You do not have access to this Collection.",
  );
});

it("commits a reversible action only when it returns a bounded undo, and keeps no receipt for one it refuses", async () => {
  const SETTLE = id(20);
  const settle = {
    operationId: SETTLE,
    name: "settle",
    label: "Settle",
    tableId: ITEMS,
    kind: "action" as const,
    access: "owner" as const,
    readOnly: false,
    fieldIds: [id(14)],
    reversedBy: "settle",
  };
  const f = await host(
    `globalThis.operations={
    create(ctx,input){ctx.db.execute('INSERT INTO items VALUES(?,?)',[ctx.requestId,input.value]);return {id:ctx.requestId};},
    read(ctx){return ctx.db.query('SELECT id,value FROM items ORDER BY id');},
    settle(ctx,input){
      ctx.db.execute('INSERT INTO items VALUES(?,?)',[ctx.requestId,'settled']);
      if(input.shape==='none')return {id:ctx.requestId};
      if(input.shape==='large')return {undo:'x'.repeat(20000)};
      return {undo:{id:ctx.requestId}};
    }
  };`,
    { ...hostDefinition, operations: [...hostDefinition.operations, settle] },
  );
  const call = (input: JsonValue, idempotencyKey: string) =>
    f.host.invoke("owner", {
      ...scope,
      revision: 1,
      revisionSha256: f.revision.revisionSha256,
      operationId: SETTLE,
      input,
      idempotencyKey,
    });
  const events = () => f.db.prepare("SELECT count(*) AS count FROM dohc_dataset_events").get();
  for (const [shape, key] of [
    ["none", "k-none"],
    ["large", "k-large"],
  ] as const) {
    await expect(call({ shape }, key)).rejects.toMatchObject({
      refusal: {
        code: "undo_missing",
        message:
          "Settle is reversed by settle, so it must return undo: the input settle takes to reverse it, at most 16 KB.",
      },
    });
  }
  expect(events()).toEqual({ count: 0 });
  expect(await f.invoke("owner", READ, "read-1")).toMatchObject({ result: [] });
  // The same key runs again once the action returns what it must: nothing was kept for it.
  expect(await call({ shape: "ok" }, "k-none")).toMatchObject({
    replayed: false,
    result: { undo: { id: expect.any(String) } },
  });
  expect(events()).toEqual({ count: 1 });
});
