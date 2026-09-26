import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDatasetJournal, type DatasetCursor } from "@dohc/app-backend-runtime/journal";
import { createDatasetAutomationClaims, DATASET_AUTOMATION_HISTORY, type DatasetAutomationClaim } from "@dohc/app-backend-runtime/dataset-automation-claims";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { createTestScratch } from "../workspaces/testTemp";
import type { AutomationFormulaEvaluator } from "./automationEvaluatorHost";
import type { ReachRoster } from "./automationReach";
import { createAutomationRunStore } from "./automationRunStore";
import {
  CollectionAutomations,
  DATASET_AUTOMATIONS_UNSUPPORTED,
  type CollectionAutomationEngine,
  type DatasetAutomationLedger,
  type DatasetClaimRunner,
} from "./collectionAutomations";
import type { CollectionAutomationRunOutcome } from "./collectionAutomationRun";

// The executor's second claim source: a dataset host's ledger, real here, fed
// by real journal commits. dohc cannot run dataset steps yet, so these tests
// pass the runner that makes dataset automations supported.

const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const OWNER: ReachRoster = { kind: "owner", ownerUserId: "user-owner", grants: [] };
const UNKNOWN: ReachRoster = { kind: "unknown", problem: { kind: "unchecked", next: "dohc checks again when the server answers." } };
const PAID = "collection:Budget#close-paid";
const TABLE = id(2), PAID_FIELD = id(4);
const schemaSql = "CREATE TABLE invoices(id TEXT PRIMARY KEY NOT NULL,status TEXT NOT NULL,paid INTEGER NOT NULL);";
const definition: DatasetDefinition = {
  formatVersion: 1, datasetId: id(1), name: "Budget", schemaPath: "Budget/schema.sql", operationsPath: "Budget/operations.js",
  tables: [{ tableId: TABLE, name: "Invoices", sqlName: "invoices", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: PAID_FIELD, name: "Paid", sqlColumn: "paid", type: "checkbox", required: true, unique: false },
    { fieldId: id(5), name: "Status", sqlColumn: "status", type: "text", required: true, unique: false },
  ] }],
  operations: [{ operationId: id(9), name: "invoices.edit", label: "Edit", tableId: TABLE, kind: "edit", access: "owner", readOnly: false, fieldIds: [id(5)] }],
};
const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource: "globalThis.operations={};" });
const automation = (options: { enabled?: boolean; table?: string } = {}) => `  - id: close-paid
    name: Close paid invoices
    enabled: ${options.enabled ?? true}
    when:
      field-changed: Paid${options.table ? `\n      table: ${options.table}` : ""}
    do:
      - set:
          Status: Closed
        operation: invoices.edit
`;

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const stub: AutomationFormulaEvaluator = { evaluate: async () => "busy" };

async function world(options: { runner?: boolean; roster?: ReachRoster } = {}) {
  const root = await createTestScratch("dohc-dataset-automations-");
  await mkdir(join(root, "Budget"), { recursive: true });
  await writeFile(join(root, "Budget", "dataset.json"), JSON.stringify(definition));
  const writeAutomations = (body: string) => writeFile(join(root, "Budget", "automations.yaml"), `version: 1\nautomations:\n${body}`);
  await writeAutomations(automation());

  // The dataset host's database: its journal, and the ledger its commits claim through.
  const seed = new DatabaseSync(join(root, "seed.sqlite")); seed.exec(schemaSql); seed.close();
  const data = new DatabaseSync(":memory:"); data.exec(schemaSql);
  const columns = { invoices: data.prepare("PRAGMA table_info(invoices)").all().map((column) => String(column.name)) };
  const db = new DatabaseSync(join(root, "host.sqlite"));
  cleanups.push(() => { data.close(); db.close(); });
  const transaction = <T>(run: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = run(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const journal = createDatasetJournal({ db, transaction });
  let executor: CollectionAutomations | undefined;
  const ledger = createDatasetAutomationClaims({ db, transaction, account: () => undefined, wake: () => executor?.notifyClaimed() });
  const scope = { workspaceId: "workspace", datasetId: definition.datasetId };
  const checkpoint = readFileSync(join(root, "seed.sqlite"));
  let cursor: DatasetCursor = journal.initialize({ scope, hostEpoch: "host-1", approvedRevisionHash: revision.revisionSha256, source: "globalThis.operations={};",
    schemaSql, definitionJson: JSON.stringify(revision), checkpoint, authorize: () => undefined });
  const commit = (sql: string) => {
    const session = data.createSession(); data.exec(sql);
    const changeset = session.changeset(); session.close();
    const key = `change-${cursor.revision + 1}`;
    const result = journal.commitOperation({ expected: cursor, proposalId: key, operation: "edit", callerKey: "owner", idempotencyKey: key,
      payloadSha256: sha256(key), resultJson: "{}", changeset, changesetSha256: sha256(changeset), attachedFileIds: [], authorize: () => undefined,
      recordCommit: (committed) => ledger.recordCommit({ ...committed, columns, approved: revision, actor: { kind: "owner" } }) });
    if (result.kind === "committed") cursor = result.event.cursor;
  };

  let ledgerOpens = 0, releases = 0, approved = revision.definition;
  let storeFails = false;
  const workspaceLedger: DatasetAutomationLedger = {
    datasets: () => ({ definitions: [approved], failures: [] }),
    subscribe: (datasetId, subscription) => ledger.subscribe({ workspaceId: "workspace", datasetId }, subscription),
    unsubscribe: (datasetId, automationId) => ledger.unsubscribe({ workspaceId: "workspace", datasetId }, automationId),
    subscriptions: () => ledger.subscriptions("workspace"),
    next: () => ledger.next("workspace"),
    settle: (started, outcome) => ledger.settle(started, outcome),
    release: (started) => { ledger.release(started); releases += 1; },
    retry: (claimId) => ledger.retry({ workspaceId: "workspace", claimId }),
    claims: (automationId) => ledger.claims("workspace", automationId),
    claim: (automationId, claimId) => ledger.claim("workspace", automationId, claimId),
    failures: () => ledger.failures("workspace"),
  };
  const engine = {
    listCollections: async () => ({ collections: [] }),
    claimNextAutomation: async () => null,
    listAutomationClaims: async () => ({ claims: [] }),
    listAutomationFailures: async () => ({ failures: [] }),
  } as unknown as CollectionAutomationEngine;

  const runs: DatasetAutomationClaim[] = [];
  const outcomes: CollectionAutomationRunOutcome[] = [];
  const waiters = new Set<() => void>();
  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  const until = (condition: () => boolean) => new Promise<void>((resolve) => {
    const check = () => { if (condition()) { waiters.delete(check); resolve(); } };
    waiters.add(check);
    check();
  });
  let holdRuns = false;
  const runner: DatasetClaimRunner = async ({ claim, signal }) => {
    runs.push(claim);
    wake();
    // A held run lasts until the executor stops it.
    if (holdRuns) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return outcomes.shift() ?? { kind: "done" };
  };
  let roster = options.roster ?? OWNER;
  const errors: unknown[] = [];
  // A new executor over the same files and dataset host, as after the workspace reopens.
  const makeExecutor = () => executor = new CollectionAutomations({
    withEngine: async (work) => await work(engine),
    withRecordWrites: async () => { throw new Error("Dataset runs write through their own operations."); },
    readText: async (path) => {
      try {
        const text = await readFile(join(root, path), "utf8");
        return { text, truncated: false, contentHash: sha256(text) };
      } catch {
        return null;
      }
    },
    writeText: async () => ({ status: "conflict" }),
    pathExists: (path) => stat(join(root, path)).then(() => true, () => false),
    roster: async () => roster,
    cachedRoster: async () => roster,
    evaluator: stub,
    store: createAutomationRunStore(root),
    onFailuresChanged: wake,
    onHoldsChanged: () => undefined,
    onAutomationsChanged: () => undefined,
    onError: (_context, error) => { errors.push(error); wake(); },
    withDatasetLedger: async (work) => {
      ledgerOpens += 1;
      if (storeFails) throw new Error("The dataset store cannot open.");
      const result = await work(workspaceLedger);
      wake();
      return result;
    },
    ...(options.runner === false ? {} : { runDatasetClaim: runner }),
  });
  makeExecutor();
  const claimsOf = () => db.prepare("SELECT claim_id,state,attempts,run,error FROM dohc_dataset_automation_claims ORDER BY rowid").all();
  return {
    get executor() { return executor!; }, makeExecutor, ledger, commit, runs, outcomes, until, errors, writeAutomations, claimsOf,
    ledgerOpens: () => ledgerOpens,
    releases: () => releases,
    setRoster: (next: ReachRoster) => { roster = next; },
    holdRuns: () => { holdRuns = true; },
    approve: (next: DatasetDefinition) => { approved = next; },
    failStore: () => { storeFails = true; },
  };
}

describe("Collection automations on a dataset", () => {
  it("says dataset automations are not supported yet, and never opens the dataset host for them", async () => {
    const f = await world({ runner: false });
    await f.executor.open();
    const file = await f.executor.automationsIn("Budget");
    expect(file).toMatchObject({ status: "read", automations: [{ valid: true, cannotRun: DATASET_AUTOMATIONS_UNSUPPORTED }] });
    expect(f.ledgerOpens()).toBe(0);
    expect(f.ledger.subscriptions("workspace")).toEqual([]);
    await f.executor.dispose();
  });

  it("subscribes in the host's ledger, runs each claim once when the host wakes it, and settles it there", async () => {
    const f = await world();
    await f.executor.open();
    expect(f.ledger.subscriptions("workspace")).toEqual([expect.objectContaining({
      datasetId: definition.datasetId, automationId: PAID, tableId: TABLE, kinds: ["changed"], fieldIds: [PAID_FIELD],
    })]);
    expect(await f.executor.automationsIn("Budget")).toMatchObject({ automations: [{ cannotRun: null }] });
    f.commit("INSERT INTO invoices VALUES('a','Open',0)");
    f.commit("UPDATE invoices SET paid=1 WHERE id='a'");
    // Only the watched field's change claims.
    f.commit("UPDATE invoices SET status='Sent' WHERE id='a'");
    await f.until(() => f.claimsOf().every((claim) => claim.state === "done") && f.runs.length === 1);
    expect(f.runs[0]).toMatchObject({ automationId: PAID, revision: 2, depth: 0, fact: { kind: "changed", recordId: "a", fields: [{ fieldId: PAID_FIELD, previous: false, next: true }] } });
    expect(f.claimsOf()).toEqual([{ claim_id: f.runs[0]!.claimId, state: "done", attempts: 1, run: 1, error: null }]);
    await f.executor.dispose();
  });

  it("runs a claim made while the workspace was closed when it opens", async () => {
    const f = await world();
    await f.executor.open();
    await f.executor.dispose();
    f.commit("INSERT INTO invoices VALUES('a','Open',0)");
    f.commit("UPDATE invoices SET paid=1 WHERE id='a'");
    expect(f.claimsOf()).toMatchObject([{ state: "pending" }]);
    f.makeExecutor();
    await f.executor.open();
    await f.until(() => f.runs.length === 1 && f.claimsOf()[0]?.state === "done");
    await f.executor.dispose();
  });

  it("hands a claim back without counting its attempt while it waits to check who can edit, then runs it", async () => {
    const f = await world({ roster: UNKNOWN });
    await f.executor.open();
    f.commit("INSERT INTO invoices VALUES('a','Open',0)");
    f.commit("UPDATE invoices SET paid=1 WHERE id='a'");
    await f.until(() => f.releases() === 1);
    expect(f.claimsOf()[0]).toMatchObject({ attempts: 0 });
    expect(f.runs).toEqual([]);
    f.setRoster(OWNER);
    f.executor.rosterChanged();
    await f.until(() => f.claimsOf()[0]?.state === "done");
    expect(f.runs).toHaveLength(1);
    await f.executor.dispose();
  });

  it("records a failure in the ledger, and Try again runs the claim again as its next run", async () => {
    const f = await world();
    await f.executor.open();
    f.outcomes.push({ kind: "failed", error: "Budget has no approved edit that changes Status.", timedOut: false });
    f.commit("INSERT INTO invoices VALUES('a','Open',0)");
    f.commit("UPDATE invoices SET paid=1 WHERE id='a'");
    await f.until(() => f.claimsOf()[0]?.state === "failed");
    const [failed] = f.claimsOf();
    expect(failed).toMatchObject({ error: "Budget has no approved edit that changes Status.", run: 1 });
    expect(await f.executor.runs(PAID)).toMatchObject([{ claimId: failed!.claim_id, state: "failed" }]);
    expect(await f.executor.retry({ automationId: PAID, claimId: String(failed!.claim_id), startOver: false })).toEqual({ status: "queued" });
    await f.until(() => f.claimsOf()[0]?.state === "done");
    expect(f.runs.map((claim) => claim.run)).toEqual([1, 2]);
    await f.executor.dispose();
  });

  it("unsubscribes an automation that is switched off, and settles its waiting claim without running it", async () => {
    const f = await world({ roster: UNKNOWN });
    await f.executor.open();
    f.commit("INSERT INTO invoices VALUES('a','Open',0)");
    f.commit("UPDATE invoices SET paid=1 WHERE id='a'");
    await f.until(() => f.releases() === 1);
    await f.writeAutomations(automation({ enabled: false }));
    f.executor.handleWatcherEvents([{ operation: "update", path: "Budget/automations.yaml" }]);
    await f.until(() => f.ledger.subscriptions("workspace").length === 0);
    f.setRoster(OWNER);
    f.executor.rosterChanged();
    await f.until(() => f.claimsOf()[0]?.state === "done");
    expect(f.runs).toEqual([]);
    await f.executor.dispose();
  });

  it("names why an automation cannot watch the dataset", async () => {
    const f = await world();
    await f.writeAutomations(automation({ table: "Receipts" }));
    await f.executor.open();
    expect(await f.executor.automationsIn("Budget")).toMatchObject({ automations: [{ cannotRun: "Budget has no table named Receipts." }] });
    expect(f.ledger.subscriptions("workspace")).toEqual([]);
    await f.executor.dispose();
  });

  it("hands a claim it holds back to the host when the workspace closes, without counting an attempt", async () => {
    const f = await world();
    await f.executor.open();
    f.holdRuns();
    f.commit("INSERT INTO invoices VALUES('a','Open',0)");
    f.commit("UPDATE invoices SET paid=1 WHERE id='a'");
    await f.until(() => f.runs.length === 1);
    await f.executor.dispose();
    expect(f.claimsOf()).toMatchObject([{ state: "pending", attempts: 0 }]);
  });

  it("re-indexes and resubscribes when a dataset's approved rules change", async () => {
    const f = await world();
    await f.executor.open();
    expect(f.ledger.subscriptions("workspace")).toHaveLength(1);
    const renamed = structuredClone(definition);
    renamed.tables[0]!.fields[1]!.name = "Settled";
    f.approve(renamed);
    f.executor.datasetsChanged();
    await f.until(() => f.ledger.subscriptions("workspace").length === 0);
    expect(await f.executor.automationsIn("Budget")).toMatchObject({ automations: [{ cannotRun: "Invoices has no field named Paid." }] });
    await f.executor.dispose();
  });

  it("tries a failed claim again after newer claims push it out of run history", async () => {
    const f = await world();
    await f.executor.open();
    f.outcomes.push({ kind: "failed", error: "Budget has no approved edit that changes Status.", timedOut: false });
    f.commit("INSERT INTO invoices VALUES('a','Open',0)");
    f.commit("UPDATE invoices SET paid=1 WHERE id='a'");
    await f.until(() => f.claimsOf()[0]?.state === "failed");
    const failed = String(f.claimsOf()[0]!.claim_id);
    for (let index = 0; index <= DATASET_AUTOMATION_HISTORY; index += 1) f.commit(`UPDATE invoices SET paid=${index % 2} WHERE id='a'`);
    await f.until(() => f.claimsOf().filter((claim) => claim.state === "done").length === DATASET_AUTOMATION_HISTORY);
    expect(f.ledger.claims("workspace", PAID).some((claim) => claim.claimId === failed)).toBe(false);
    expect(await f.executor.retry({ automationId: PAID, claimId: failed, startOver: false })).toEqual({ status: "queued" });
    // It runs as its second run and settles done, and history trims it as the oldest.
    await f.until(() => f.runs.some((claim) => claim.claimId === failed && claim.run === 2) && f.ledger.failures("workspace").length === 0);
    await f.executor.dispose();
  });

  it("reports a dataset store that cannot open, and still opens the workspace's other automations", async () => {
    const f = await world();
    f.failStore();
    await f.executor.open();
    await f.until(() => f.errors.length > 0);
    expect(String(f.errors[0])).toContain("The dataset store cannot open.");
    await expect(f.executor.automationsIn("Budget")).resolves.toMatchObject({ status: "read" });
    await f.executor.dispose();
  });
});
