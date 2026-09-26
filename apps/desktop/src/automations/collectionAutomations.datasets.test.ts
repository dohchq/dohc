import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { JsonValue } from "@dohc/app-backend-runtime";
import { DATASET_AUTOMATION_HISTORY } from "@dohc/app-backend-runtime/dataset-automation-claims";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { generateDatasetSources } from "../workspaces/datasetGenerator";
import { createLocalDatasetHost, type LocalDatasetHost } from "../workspaces/localDatasetHost";
import { createTestScratch } from "../workspaces/testTemp";
import { createAutomationFormulaEvaluator, type AutomationFormulaEvaluator } from "./automationEvaluatorHost";
import type { ReachRoster } from "./automationReach";
import { createAutomationRunStore } from "./automationRunStore";
import { CollectionAutomations, type CollectionAutomationEngine } from "./collectionAutomations";

// Automations on a dataset Collection, end to end: a real dataset host runs
// dohc's generated operations in its worker, its commits claim through its
// ledger, and each step of a run goes through an approved operation.

const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const OWNER: ReachRoster = { kind: "owner", ownerUserId: "user-owner", grants: [] };
const UNKNOWN: ReachRoster = { kind: "unknown", problem: { kind: "unchecked", next: "dohc checks again when the server answers." } };
const AUTOMATION = "collection:Budget#close-paid";
const TABLE = id(2), PAID = id(4), STATUS = id(5), NOTES = id(6), FINISHED = id(7);
const LIST = id(10), CREATE = id(11), EDIT = id(12), STATUS_ONLY = id(13);
const { definition, files } = generateDatasetSources({
  formatVersion: 1, datasetId: id(1), name: "Budget", schemaPath: "Budget/schema.sql", operationsPath: "Budget/operations.js",
  tables: [{ tableId: TABLE, name: "Invoices", sqlName: "invoices", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: PAID, name: "Paid", sqlColumn: "paid", type: "checkbox", required: true, unique: false, default: false },
    { fieldId: STATUS, name: "Status", sqlColumn: "status", type: "text", required: true, unique: false, default: "Open" },
    { fieldId: NOTES, name: "Notes", sqlColumn: "notes", type: "text", required: false, unique: false },
    { fieldId: FINISHED, name: "Finished on", sqlColumn: "finished", type: "date", required: false, unique: false },
  ] }],
  operations: [
    { operationId: LIST, name: "invoices.list", label: "View", tableId: TABLE, kind: "read", access: "helper", readOnly: true, fieldIds: [PAID, STATUS, NOTES, FINISHED] },
    { operationId: CREATE, name: "invoices.create", label: "Create", tableId: TABLE, kind: "create", access: "link", readOnly: false, fieldIds: [id(3), PAID, STATUS, NOTES] },
    { operationId: EDIT, name: "invoices.edit", label: "Edit", tableId: TABLE, kind: "edit", access: "helper", readOnly: false, fieldIds: [PAID, STATUS, NOTES] },
    { operationId: STATUS_ONLY, name: "invoices.status", label: "Set status", tableId: TABLE, kind: "edit", access: "helper", readOnly: false, fieldIds: [STATUS] },
  ],
} satisfies DatasetDefinition);

const closePaid = (step = "      - set:\n          Status: Closed\n        operation: invoices.status\n", enabled = true) => `  - id: close-paid
    name: Close paid invoices
    enabled: ${enabled}
    when:
      field-changed: Paid
    do:
${step}`;

const sharedEvaluator = createAutomationFormulaEvaluator();
afterAll(() => sharedEvaluator.close());
const hosts: LocalDatasetHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); });

async function world(options: { roster?: ReachRoster; hostOpen?: boolean; evaluator?: AutomationFormulaEvaluator } = {}) {
  const root = await createTestScratch("dohc-dataset-automations-");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const writeAutomations = (body: string) => writeFile(join(root, "Budget", "automations.yaml"), `version: 1\nautomations:\n${body}`);
  await writeAutomations(closePaid());

  let executor: CollectionAutomations | undefined;
  const waiters = new Set<() => void>();
  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  const until = (condition: () => boolean | Promise<boolean>) => new Promise<void>((resolve) => {
    const check = async () => { if (waiters.has(check) && await condition()) { waiters.delete(check); resolve(); } };
    waiters.add(check);
    void check();
  });
  const host = await createLocalDatasetHost({ workspaceId: "workspace", workspaceRoot: root, capacityBytes: 4 * 1024 * 1024,
    onAutomationClaims: () => { executor?.notifyClaimed(); wake(); },
    onDatasetsChanged: () => executor?.datasetsChanged() });
  hosts.push(host);
  const blobs = new Map<string, Uint8Array>();
  const adapter = new VersionedLiveAdapter({ close() {}, async sendRequest(request) {
    const params = request.params as Record<string, unknown>;
    if (request.method === "versionedText.captureSources") {
      const selected = await Promise.all([...params.paths as string[]].sort().map(async (path) => {
        const bytes = await readFile(join(root, path)), digest = sha256(bytes); blobs.set(digest, bytes);
        return { path, objectId: path, contentKind: "text", sha256: digest, byteLength: bytes.byteLength, latestMomentId: "m" };
      }));
      return { id: request.id, result: { workspaceId: "workspace", versionId: "main", files: selected, totalBytes: selected.reduce((sum, file) => sum + file.byteLength, 0),
        sourceDigest: sha256(JSON.stringify(["dohc-source-capture-v1", "workspace", "main", selected])) } };
    }
    const bytes = blobs.get(String(params.sha256))!;
    return { id: request.id, result: { bytesBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength } };
  } }, "owner", { workspaceId: "workspace" });
  const prepared = await host.prepare({ descriptorPath: "Budget/dataset.json", adapter });
  const approved = await host.approve({ preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256 });
  const rules = { datasetId: definition.datasetId, revision: approved.revision, revisionSha256: approved.revisionSha256 };
  let keys = 0;
  // The owner's own edits, as the Collection page makes them.
  const create = async (values: Record<string, JsonValue>) => {
    const result = await host.action({ ...rules, operationId: CREATE, input: { values }, idempotencyKey: `owner-${keys++}` });
    return result.result as { id: string; version: number };
  };
  const edit = async (recordId: string, values: Record<string, JsonValue>) => {
    const current = await record(recordId);
    await host.action({ ...rules, operationId: EDIT, input: { id: recordId, expectedVersion: current!.version, values }, idempotencyKey: `owner-${keys++}` });
  };
  const record = async (recordId: string) => {
    for (let after: JsonValue = null; ;) {
      const page = (await host.query({ ...rules, operationId: LIST, input: after === null ? { limit: 100 } : { limit: 100, after }, idempotencyKey: "read" })).result as
        { rows: Array<{ id: string; version: number; values: Record<string, JsonValue> }>; nextCursor: JsonValue };
      const found = page.rows.find((row) => row.id === recordId);
      if (found) return found;
      if (page.nextCursor === null) return null;
      after = page.nextCursor;
    }
  };
  const records = async () => ((await host.query({ ...rules, operationId: LIST, input: { limit: 100 }, idempotencyKey: "read" })).result as
    { rows: Array<{ id: string; version: number; values: Record<string, JsonValue> }> }).rows;

  const engine = {
    listCollections: async () => ({ collections: [] }),
    claimNextAutomation: async () => null,
    listAutomationClaims: async () => ({ claims: [] }),
    listAutomationFailures: async () => ({ failures: [] }),
  } as unknown as CollectionAutomationEngine;
  let roster = options.roster ?? OWNER;
  let hostOpen = options.hostOpen ?? true;
  const opened: boolean[] = [];
  const errors: Array<{ context: string; error: unknown }> = [];
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
    evaluator: options.evaluator ?? sharedEvaluator.forWorkspace("workspace"),
    store: createAutomationRunStore(root),
    onFailuresChanged: wake,
    onHoldsChanged: () => undefined,
    onAutomationsChanged: () => undefined,
    onError: (context, error) => { errors.push({ context, error }); wake(); },
    withDatasetHost: async (work, open) => {
      opened.push(open);
      if (!hostOpen && !open) return null;
      const result = await work(host.automations);
      wake();
      return result;
    },
  });
  makeExecutor();
  return {
    host, root, rules, create, edit, record, records, until, errors, opened, writeAutomations, makeExecutor,
    get executor() { return executor!; },
    claims: () => host.automations.claims(AUTOMATION),
    setRoster: (next: ReachRoster) => { roster = next; },
    openHost: () => { hostOpen = true; executor!.datasetsChanged(); },
  };
}

describe("Collection automations on a dataset", () => {
  it("sets a field through the pinned edit when a watched field changes, once, and History names the automation", async () => {
    const f = await world();
    await f.executor.open();
    expect(f.host.automations.subscriptions()).toEqual([expect.objectContaining({ automationId: AUTOMATION, tableId: TABLE, kinds: ["changed"], fieldIds: [PAID] })]);
    const { id: invoice } = await f.create({ [PAID]: false, [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(async () => (await f.record(invoice))?.values[STATUS] === "Closed");
    await f.until(() => f.claims()[0]?.state === "done");
    expect(f.claims()).toHaveLength(1);
    // The automation's own write claims nothing more for it.
    expect(f.host.history({ datasetId: definition.datasetId }).entries[0]).toMatchObject({ automation: { automationId: AUTOMATION, depth: 1 } });
    const [run] = (await createAutomationRunStore(f.root).runsOf(AUTOMATION, f.claims()[0]!.claimId)).runs;
    expect(run!.applied).toEqual([{ ordinal: 0, writes: [expect.objectContaining({
      kind: "dataset-edit", operationId: STATUS_ONLY, recordId: invoice, fields: [{ fieldId: STATUS, field: "Status", before: "Open", after: "Closed" }],
    })] }]);
    await f.executor.dispose();
  });

  it("reads a trigger record by any id the table accepts, the smallest included", async () => {
    const f = await world();
    await f.executor.open();
    for (const recordId of ["\u0000", "\u0000a", "b"]) {
      await f.create({ [id(3)]: recordId });
      await f.edit(recordId, { [PAID]: true });
      await f.until(async () => (await f.record(recordId))?.values[STATUS] === "Closed");
    }
    await f.executor.dispose();
  });

  it("finds records with equality filters, changes each found record, and adds a record with a formula", async () => {
    const f = await world();
    await f.writeAutomations(closePaid(`      - find: record.Status == "Open" && record.Paid == false
        as: open
        operation: invoices.list
      - set:
          Notes: =record.Notes + " (reminded)"
        records: open
        operation: invoices.edit
      - add-record:
          Notes: '="Paid " + trigger.record.id'
          Status: Logged
        operation: invoices.create
`));
    await f.executor.open();
    const first = await f.create({ [NOTES]: "first" });
    const second = await f.create({ [NOTES]: "second" });
    await f.create({ [NOTES]: "done", [STATUS]: "Closed" });
    await f.edit(first.id, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    const rows = await f.records();
    expect(rows.find((row) => row.id === second.id)?.values[NOTES]).toBe("second (reminded)");
    // The paid invoice no longer matches the Find.
    expect(rows.find((row) => row.id === first.id)?.values[NOTES]).toBe("first");
    expect(rows.filter((row) => row.values[STATUS] === "Logged").map((row) => row.values[NOTES])).toEqual([`Paid ${first.id}`]);
    await f.executor.dispose();
  });

  it("sends a stale edit again at the record's new version, and keeps a field someone else changed", async () => {
    let interfere: (() => Promise<void>) | null = null;
    const base = sharedEvaluator.forWorkspace("workspace");
    // Someone edits the record after the run read it and before it writes.
    const evaluator: AutomationFormulaEvaluator = {
      evaluate: async (automationId, scope, formulas) => {
        const change = interfere;
        interfere = null;
        await change?.();
        return await base.evaluate(automationId, scope, formulas);
      },
    };
    const f = await world({ evaluator });
    await f.writeAutomations(closePaid(`      - set:
          Status: =record.Status + " and paid"
          Notes: Closed by automation
        operation: invoices.edit
`));
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open", [NOTES]: "draft" });
    interfere = () => f.edit(invoice, { [NOTES]: "someone else" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    // Status was still as the run read it, so it was sent again; Notes keeps their change.
    expect((await f.record(invoice))?.values).toMatchObject({ [STATUS]: "Open and paid", [NOTES]: "someone else" });
    const [run] = (await createAutomationRunStore(f.root).runsOf(AUTOMATION, f.claims()[0]!.claimId)).runs;
    expect(run!.replans).toEqual([expect.objectContaining({ effect: 0, replan: 1, fields: [expect.objectContaining({ fieldId: STATUS })] })]);
    expect(run!.applied[0]!.writes).toEqual([
      { kind: "dataset-kept", recordId: invoice, fieldId: NOTES, field: "Notes", planned: "Closed by automation", current: "someone else" },
      expect.objectContaining({ kind: "dataset-edit", fields: [{ fieldId: STATUS, field: "Status", before: "Open", after: "Open and paid" }] }),
    ]);
    await f.executor.dispose();
  });

  it("names the operation no approved edit fits, and refuses a claimed run with that sentence", async () => {
    const f = await world({ roster: UNKNOWN });
    await f.executor.open();
    const { id: invoice } = await f.create({});
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "pending");
    await f.writeAutomations(closePaid("      - set:\n          Finished on: '=today()'\n        operation: invoices.edit\n"));
    f.executor.handleWatcherEvents([{ operation: "update", path: "Budget/automations.yaml" }]);
    const sentence = "Budget has no approved edit that changes Finished on.";
    await f.until(async () => (await f.executor.automationsIn("Budget")).status === "read" &&
      JSON.stringify(await f.executor.automationsIn("Budget")).includes(sentence));
    f.setRoster(OWNER);
    f.executor.rosterChanged();
    await f.until(() => f.claims()[0]?.state === "failed");
    expect(f.claims()[0]).toMatchObject({ error: sentence });
    expect(await f.executor.datasetFailures()).toEqual([expect.objectContaining({ automationId: AUTOMATION, error: sentence, generation: 1, neverStarted: false })]);
    await f.executor.dispose();
  });

  it("pins each step to a reversible operation with the fewest extra fields when the panel saves", async () => {
    const f = await world();
    await f.executor.open();
    const [pinned] = await f.executor.pinOperations("Budget", [{
      id: "close-paid", name: "Close", enabled: true, when: { kind: "field-changed", field: "Paid", to: null, table: null }, if: null,
      do: [
        { kind: "set", values: [{ field: "Status", value: { kind: "literal", value: "Closed" } }], records: null, operation: null },
        { kind: "set", values: [{ field: "Notes", value: { kind: "literal", value: "x" } }], records: null, operation: "invoices.status" },
        { kind: "set", values: [{ field: "Finished on", value: { kind: "literal", value: "2026-09-25" } }], records: null, operation: null },
      ],
    }]);
    expect(pinned!.do.map((step) => "operation" in step ? step.operation : null)).toEqual(["invoices.status", "invoices.edit", null]);
    await f.executor.dispose();
  });

  it("leaves the dataset host closed until something opens it, then runs what it holds", async () => {
    const f = await world({ hostOpen: false });
    await f.executor.open();
    expect(f.opened.every((open) => !open)).toBe(true);
    expect(f.host.automations.subscriptions()).toEqual([]);
    f.openHost();
    await f.until(() => f.host.automations.subscriptions().length === 1);
    const { id: invoice } = await f.create({});
    await f.edit(invoice, { [PAID]: true });
    await f.until(async () => (await f.record(invoice))?.values[STATUS] === "Closed");
    expect(f.opened.every((open) => !open)).toBe(true);
    await f.executor.dispose();
  });

  it("runs a claim made while the workspace was closed when it opens", async () => {
    const f = await world();
    await f.executor.open();
    await f.executor.dispose();
    const { id: invoice } = await f.create({});
    await f.edit(invoice, { [PAID]: true });
    expect(f.claims()).toMatchObject([{ state: "pending" }]);
    f.makeExecutor();
    await f.executor.open();
    await f.until(() => f.claims()[0]?.state === "done");
    await f.executor.dispose();
  });

  it("hands a claim back without counting its attempt while it waits to check who can edit, then runs it", async () => {
    const f = await world({ roster: UNKNOWN });
    await f.executor.open();
    const { id: invoice } = await f.create({});
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "pending" && f.errors.length === 0);
    expect(f.claims()[0]).toMatchObject({ attempts: 0 });
    f.setRoster(OWNER);
    f.executor.rosterChanged();
    await f.until(() => f.claims()[0]?.state === "done");
    await f.executor.dispose();
  });

  it("hands a claim it holds back to the host when the workspace closes, without counting an attempt", async () => {
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const base = sharedEvaluator.forWorkspace("workspace");
    const evaluator: AutomationFormulaEvaluator = {
      evaluate: async (automationId, scope, formulas) => {
        started();
        await new Promise<void>((resolve) => { release = resolve; });
        return await base.evaluate(automationId, scope, formulas);
      },
    };
    const f = await world({ evaluator });
    await f.writeAutomations(closePaid("      - set:\n          Status: '=\"Closed\"'\n        operation: invoices.status\n"));
    await f.executor.open();
    const { id: invoice } = await f.create({});
    await f.edit(invoice, { [PAID]: true });
    await running;
    const disposed = f.executor.dispose();
    release();
    await disposed;
    expect(f.claims()).toMatchObject([{ state: "pending", attempts: 0 }]);
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
  });

  it("tries a failed claim again after newer claims push it out of run history", async () => {
    let fail = true;
    const base = sharedEvaluator.forWorkspace("workspace");
    const evaluator: AutomationFormulaEvaluator = {
      evaluate: async (automationId, scope, formulas) => fail
        ? formulas.map(() => ({ ok: false as const, error: { code: "runtime" as const, message: "Not yet." } }))
        : await base.evaluate(automationId, scope, formulas),
    };
    const f = await world({ evaluator });
    // Its runs read the record and write nothing, so the owner's versions stay known.
    await f.writeAutomations(`  - id: close-paid
    name: Close paid invoices
    when:
      field-changed: Paid
    if: record.Status == "Never"
    do:
      - set:
          Status: Closed
        operation: invoices.status
`);
    await f.executor.open();
    const { id: invoice } = await f.create({});
    let version = 1;
    const setPaid = async (paid: boolean) => {
      await f.host.action({ ...f.rules, operationId: EDIT, input: { id: invoice, expectedVersion: version++, values: { [PAID]: paid } }, idempotencyKey: `paid-${version}` });
    };
    await setPaid(true);
    await f.until(() => f.claims()[0]?.state === "failed");
    const failed = f.claims()[0]!.claimId;
    fail = false;
    for (let index = 0; index <= DATASET_AUTOMATION_HISTORY; index += 1) await setPaid(index % 2 === 1);
    await f.until(() => f.claims().filter((claim) => claim.state === "done").length >= DATASET_AUTOMATION_HISTORY);
    expect(f.claims().some((claim) => claim.claimId === failed)).toBe(false);
    expect(await f.executor.retry({ automationId: AUTOMATION, claimId: failed, startOver: false })).toEqual({ status: "queued" });
    await f.until(() => f.host.automations.failures().length === 0);
    await f.executor.dispose();
  }, 60_000);

  it("unsubscribes an automation that is switched off, and settles its waiting claim without running it", async () => {
    const f = await world({ roster: UNKNOWN });
    await f.executor.open();
    const { id: invoice } = await f.create({});
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "pending");
    await f.writeAutomations(closePaid(undefined, false));
    f.executor.handleWatcherEvents([{ operation: "update", path: "Budget/automations.yaml" }]);
    await f.until(() => f.host.automations.subscriptions().length === 0);
    f.setRoster(OWNER);
    f.executor.rosterChanged();
    await f.until(() => f.claims()[0]?.state === "done");
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    await f.executor.dispose();
  });

  it("re-indexes and resubscribes when a dataset's approved rules change", async () => {
    const f = await world();
    await f.executor.open();
    expect(f.host.automations.subscriptions()).toHaveLength(1);
    f.host.archive({ datasetId: definition.datasetId });
    await f.until(() => f.host.automations.subscriptions().length === 0);
    f.host.restore({ datasetId: definition.datasetId });
    await f.until(() => f.host.automations.subscriptions().length === 1);
    await f.executor.dispose();
  });
});
