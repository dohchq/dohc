import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { datasetPrincipalKey } from "@dohc/security-contract/dataset-artifacts";
import type { JsonValue } from "@dohc/app-backend-runtime";
import { DATASET_AUTOMATION_HISTORY } from "@dohc/app-backend-runtime/dataset-automation-claims";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { generateDatasetSources } from "../workspaces/datasetGenerator";
import { createLocalDatasetHost, type LocalDatasetHost } from "../workspaces/localDatasetHost";
import { createTestScratch } from "../workspaces/testTemp";
import { chatDirectoryOf, type AutomationChatMessage, type AutomationNotice, type ChatDirectoryChannel } from "./automationChat";
import { createAutomationFormulaEvaluator, type AutomationFormulaEvaluator } from "./automationEvaluatorHost";
import type { ReachRoster } from "./automationReach";
import { createAutomationRunStore } from "./automationRunStore";
import { CollectionAutomations, type CollectionAutomationEngine, type PressSettled, type PressWaitReason } from "./collectionAutomations";
import { UNDONE_RUN_ERROR } from "./collectionAutomationRun";
import { DATASET_WAKE_NEEDS_BUTTON } from "./datasetAutomationPlan";
import { DATASET_UNDO_RULES_CHANGED } from "./datasetAutomationUndo";

// Automations on a dataset Collection, end to end: a real dataset host runs
// dohc's generated operations in its worker, its commits claim through its
// ledger, and each step of a run goes through an approved operation.

const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const OWNER: ReachRoster = { kind: "owner", ownerUserId: "user-owner", grants: [] };
const UNKNOWN: ReachRoster = { kind: "unknown", problem: { kind: "unchecked", next: "dohc checks again when the server answers." } };
const AUTOMATION = "collection:Budget#close-paid";
const TABLE = id(2), PAID = id(4), STATUS = id(5), NOTES = id(6), FINISHED = id(7), MARK_PAID = id(8), REFUND = id(9);
const LIST = id(10), CREATE = id(11), EDIT = id(12), STATUS_ONLY = id(13);
const { definition, files } = generateDatasetSources({
  formatVersion: 1, datasetId: id(1), name: "Budget", schemaPath: "Budget/schema.sql", operationsPath: "Budget/operations.js",
  tables: [{ tableId: TABLE, name: "Invoices", sqlName: "invoices", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: PAID, name: "Paid", sqlColumn: "paid", type: "checkbox", required: true, unique: false, default: false },
    { fieldId: STATUS, name: "Status", sqlColumn: "status", type: "text", required: true, unique: false, default: "Open" },
    { fieldId: NOTES, name: "Notes", sqlColumn: "notes", type: "text", required: false, unique: false },
    { fieldId: FINISHED, name: "Finished on", sqlColumn: "finished", type: "date", required: false, unique: false },
    { fieldId: MARK_PAID, name: "Mark paid", type: "button" },
    { fieldId: REFUND, name: "Refund", type: "button" },
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

const TEAM: ChatDirectoryChannel = { id: "team", name: "Team", slug: "team", kind: "channel", type: "posts", wireId: "team", runningThreadId: null };

async function world(options: { roster?: ReachRoster; hostOpen?: boolean; evaluator?: AutomationFormulaEvaluator; groups?: boolean; mayRetryPress?: boolean } = {}) {
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

  // Group subscriptions the executor asks the engine for.
  const subscribed: unknown[] = [];
  const engine = {
    listCollections: async () => ({ collections: [] }),
    subscribeAutomation: async (input: unknown) => { subscribed.push(input); },
    releaseAutomationGroups: async () => ({ watchedGeneration: 0, handover: { floorMs: 0, automations: [] } }),
    watchAutomationGroups: async () => ({ needsHandover: false }),
    claimNextAutomation: async () => null,
    listAutomationClaims: async () => ({ claims: [] }),
    listAutomationFailures: async () => ({ failures: [] }),
  } as unknown as CollectionAutomationEngine;
  let roster = options.roster ?? OWNER;
  let hostOpen = options.hostOpen ?? true;
  // Rules the executor sees in place of the approved ones, as after a schema change it indexes.
  let indexed: DatasetDefinition | null = null;
  // Whether saved rules still resolve, as before an approved change that drops them.
  let rulesResolve = true;
  // Why the host takes no press, as after the dataset moved to a server; the runtime tests fence a real journal.
  let unpressable: string | null = null;
  const opened: boolean[] = [];
  const errors: Array<{ context: string; error: unknown }> = [];
  // What the pressing window hears.
  const settled: PressSettled[] = [];
  const waiting: Array<{ claimId: string; reason: PressWaitReason }> = [];
  // What automations post and notify.
  const messages: AutomationChatMessage[] = [];
  const notices: AutomationNotice[] = [];
  const makeExecutor = () => executor = new CollectionAutomations({
    personName: (userId) => `Person ${userId}`,
    mayRetryPress: async () => options.mayRetryPress ?? false,
    onPressSettled: (event) => { settled.push(event); wake(); },
    onPressWaiting: (event) => { waiting.push(event); wake(); },
    groupHost: async () => (options.groups ? 0 : null),
    groupRelayRecord: async () => ({ generation: 0, handover: null }),
    requestHost: async () => undefined,
    readMessageBody: async () => { throw new Error("Dataset automations cannot use Group messages."); },
    postNotice: async (notice) => { notices.push(notice); wake(); },
    chat: {
      directory: async (current) => chatDirectoryOf([TEAM], current),
      write: async (_signal, message) => { messages.push(message); wake(); },
    },
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
      const override = indexed;
      const current = override === null ? host.automations : { ...host.automations,
        datasets: () => ({ definitions: [override], failures: [] as Array<{ datasetId: string; error: unknown }> }),
        revision: (datasetId: string) => ({ ...host.automations.revision(datasetId), definition: override }) };
      const resolving = rulesResolve ? current : { ...current, resolves: () => false };
      const moved = unpressable;
      const automations = moved === null ? resolving : { ...resolving, assertPressable: () => { throw new Error(moved); } };
      const result = await work(automations);
      wake();
      return result;
    },
  });
  makeExecutor();
  return {
    host, root, rules, create, edit, record, records, until, errors, opened, subscribed, writeAutomations, makeExecutor, settled, waiting, messages, notices,
    get executor() { return executor!; },
    claims: () => host.automations.claims(AUTOMATION),
    setRoster: (next: ReachRoster) => { roster = next; },
    openHost: () => { hostOpen = true; executor!.datasetsChanged(); },
    changeRules: (next: DatasetDefinition) => { indexed = next; executor!.datasetsChanged(); },
    dropRules: () => { rulesResolve = false; },
    moveToServer: () => { unpressable = "This Collection moved to a server, so its buttons can't run here."; },
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
    expect(await f.executor.retry({ automationId: AUTOMATION, claimId: failed, startOver: false })).toEqual({ status: "queued", press: false });
    await f.until(() => f.host.automations.failures().length === 0);
    await f.executor.dispose();
  }, 60_000);

  it("posts in a Group after its edit, as the automation, with the record's fields in its text", async () => {
    const f = await world();
    await f.writeAutomations(closePaid("      - set:\n          Status: Closed\n        operation: invoices.status\n      - post: 'Closed {record.Notes}'\n        group: Team\n"));
    await f.executor.open();
    expect(await f.executor.automationsIn("Budget")).toMatchObject({ automations: [{ cannotRun: null, reach: { kind: "checked" } }] });
    const { id: invoice } = await f.create({ [NOTES]: "rent" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    expect((await f.record(invoice))?.values[STATUS]).toBe("Closed");
    expect(f.messages).toEqual([expect.objectContaining({
      target: { kind: "group", channelId: "team", lane: "posts" }, body: "Closed rent",
      automation: { automationId: AUTOMATION, name: "Close paid invoices", depth: 1 },
    })]);
    const [run] = await f.executor.runs(AUTOMATION);
    expect(run!.writes).toEqual([expect.objectContaining({ kind: "dataset-edit" }), { kind: "message", messageId: f.messages[0]!.messageId, name: "Team" }]);
    await f.executor.dispose();
  });

  it("stops a post an editor could not make, before it changes anything, and the ⚡ panel says why", async () => {
    const ana = { grantId: "g-ana", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", files: { paths: ["Budget"], versionId: null, access: "edit" as const }, channel: null };
    const f = await world({ roster: { kind: "owner", ownerUserId: "user-owner", grants: [ana] } });
    // Ana may use every operation the run calls, and cannot post in Team.
    const store = new DatabaseSync(join(f.root, ".dohc", "datasets", "state.sqlite"));
    try {
      store.prepare("INSERT INTO dohc_dataset_data_grants VALUES(?,?,?,?,?)").run("workspace", definition.datasetId, datasetPrincipalKey("workspace", "g-ana", "u-ana"),
        JSON.stringify({ operationIds: [LIST, STATUS_ONLY], discover: true, revision: f.rules.revision, revisionSha256: f.rules.revisionSha256 }), "token");
    } finally {
      store.close();
    }
    await f.writeAutomations(closePaid("      - set:\n          Status: Closed\n        operation: invoices.status\n      - post: Closed\n        group: Team\n"));
    await f.executor.open();
    const reason = "ana@dohc.test cannot post in Team.";
    expect(await f.executor.automationsIn("Budget")).toMatchObject({ automations: [{ cannotRun: null, reach: { kind: "checked", steps: expect.arrayContaining([{ verdict: "stopped", reason }]) } }] });
    const { id: invoice } = await f.create({});
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "failed");
    expect(f.claims()[0]).toMatchObject({ error: reason });
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    expect(f.messages).toEqual([]);
    await f.executor.dispose();
  });

  it("says in the ⚡ panel that only a button can wake your agent", async () => {
    const f = await world();
    await f.writeAutomations(closePaid("      - wake-agent: Look at this invoice\n        person: user-owner\n"));
    await f.executor.open();
    expect(await f.executor.automationsIn("Budget")).toMatchObject({ automations: [{ cannotRun: DATASET_WAKE_NEEDS_BUTTON }] });
    expect(f.host.automations.subscriptions()).toEqual([]);
    await f.executor.dispose();
  });

  it("gives a dataset automation that a Group message starts no subscription", async () => {
    const f = await world({ groups: true });
    await f.writeAutomations("  - id: from-team\n    name: From Team\n    when:\n      group-message: Team\n    do:\n" +
      "      - add-record:\n          Status: New\n        operation: invoices.create\n");
    await f.executor.open();
    expect(await f.executor.automationsIn("Budget")).toMatchObject({ status: "read", automations: [
      expect.objectContaining({ cannotRun: "This Collection's automations cannot start from Group messages. Choose a record change as the trigger." }),
    ] });
    expect(f.subscribed).toEqual([]);
    expect(f.host.automations.subscriptions()).toEqual([]);
    expect(f.errors).toEqual([]);
    await f.executor.dispose();
  });

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

  it("holds a run when a field becomes readable only because an editor left, until a current editor allows it", async () => {
    const ana = { grantId: "g-ana", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", files: { paths: ["Budget"], versionId: null, access: "edit" as const }, channel: null };
    const withAna: ReachRoster = { kind: "owner", ownerUserId: "user-owner", grants: [ana] };
    const f = await world({ roster: withAna });
    // Ana may use the list and the status edit, which show every field but ID.
    const store = new DatabaseSync(join(f.root, ".dohc", "datasets", "state.sqlite"));
    try {
      store.prepare("INSERT INTO dohc_dataset_data_grants VALUES(?,?,?,?,?)").run("workspace", definition.datasetId, datasetPrincipalKey("workspace", "g-ana", "u-ana"),
        JSON.stringify({ operationIds: [LIST, STATUS_ONLY], discover: true, revision: f.rules.revision, revisionSha256: f.rules.revisionSha256 }), "token");
    } finally {
      store.close();
    }
    await f.executor.open();
    expect(await f.executor.automationsIn("Budget")).toMatchObject({ automations: [{ cannotRun: null }] });
    // Ana stops editing: ID becomes readable under the same definition, so it waits.
    f.setRoster(OWNER);
    f.executor.rosterChanged();
    await f.until(() => f.executor.holds().length === 1);
    const [hold] = f.executor.holds();
    expect(hold).toMatchObject({ action: "find", stoppedFor: "ana@dohc.test" });
    const { id: invoice } = await f.create({});
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "pending" && f.host.automations.claims(AUTOMATION)[0]?.attempts === 0);
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    expect(await f.executor.confirmReach(hold!)).toBe("confirmed");
    await f.until(async () => (await f.record(invoice))?.values[STATUS] === "Closed");
    await f.executor.dispose();
  });

  it("keeps a held field held when a schema change removes a field before it", async () => {
    const ana = { grantId: "g-ana", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", files: { paths: ["Budget"], versionId: null, access: "edit" as const }, channel: null };
    const f = await world({ roster: { kind: "owner", ownerUserId: "user-owner", grants: [ana] } });
    const store = new DatabaseSync(join(f.root, ".dohc", "datasets", "state.sqlite"));
    try {
      store.prepare("INSERT INTO dohc_dataset_data_grants VALUES(?,?,?,?,?)").run("workspace", definition.datasetId, datasetPrincipalKey("workspace", "g-ana", "u-ana"),
        JSON.stringify({ operationIds: [LIST, STATUS_ONLY], discover: true, revision: f.rules.revision, revisionSha256: f.rules.revisionSha256 }), "token");
    } finally {
      store.close();
    }
    // Secret, last, is in no read Ana holds. Spare, before it, is.
    const SPARE = id(8), SECRET = id(9);
    const table = definition.tables[0]!;
    const withSpare = structuredClone(definition);
    withSpare.tables[0]!.fields = [...table.fields,
      { fieldId: SPARE, name: "Spare", sqlColumn: "spare", type: "text", required: false, unique: false },
      { fieldId: SECRET, name: "Secret", sqlColumn: "secret", type: "text", required: false, unique: false }];
    withSpare.operations = withSpare.operations.map((operation) => operation.operationId === LIST ? { ...operation, fieldIds: [...operation.fieldIds, SPARE] } : operation);
    f.changeRules(withSpare);
    await f.executor.open();
    await f.until(async () => (await f.executor.automationsIn("Budget")).status === "read");
    // Ana stops editing: Secret, and ID, become readable only because she left.
    f.setRoster(OWNER);
    f.executor.rosterChanged();
    const heldFields = () => f.executor.holds().map((hold) => hold.step).filter((step) => step.startsWith("field:")).sort();
    await f.until(() => heldFields().length === 2);
    expect(heldFields()).toEqual([`field:${id(3)}`, `field:${SECRET}`]);
    // An approved schema change removes Spare. Secret stays held.
    const withoutSpare = structuredClone(withSpare);
    withoutSpare.tables[0]!.fields = withoutSpare.tables[0]!.fields.filter((field) => field.fieldId !== SPARE);
    withoutSpare.operations = withoutSpare.operations.map((operation) => ({ ...operation, fieldIds: operation.fieldIds.filter((fieldId) => fieldId !== SPARE) }));
    const steps = async () => ((await f.executor.automationsIn("Budget")) as { automations: Array<{ reach: { steps?: unknown[] } }> }).automations[0]!.reach.steps?.length;
    expect(await steps()).toBe(9);
    f.changeRules(withoutSpare);
    // Two operations and six fields, once the change is indexed.
    await f.until(async () => await steps() === 8);
    expect(heldFields()).toEqual([`field:${id(3)}`, `field:${SECRET}`]);
    await f.executor.dispose();
  });

  it("undoes a run's edits as the person, keeping fields someone changed since and the records it added", async () => {
    const f = await world();
    await f.writeAutomations(closePaid(`      - set:
          Status: Closed
          Notes: Closed by automation
        operation: invoices.edit
      - add-record:
          Notes: Log
        operation: invoices.create
`));
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open", [NOTES]: "draft" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    // Someone changes Notes after the run: Undo keeps it, and puts Status back.
    await f.edit(invoice, { [NOTES]: "mine" });
    const claimId = f.claims()[0]!.claimId;
    const trash = async () => { throw new Error("A dataset's added records stay."); };
    expect(await f.executor.undo({ automationId: AUTOMATION, claimId }, trash)).toEqual({
      status: "undone", reverted: 1, removed: 0, kept: 1, changedSince: 1, missing: 0, irreversible: 0,
    });
    expect((await f.record(invoice))?.values).toMatchObject({ [STATUS]: "Open", [NOTES]: "mine", [PAID]: true });
    expect((await f.records()).some((row) => row.values[NOTES] === "Log")).toBe(true);
    // The owner undid it, not the automation.
    expect(f.host.history({ datasetId: definition.datasetId }).entries[0]).not.toHaveProperty("automation");
    // Run history shows it undone, and neither Undo nor Try again runs it again.
    expect(await f.executor.runs(AUTOMATION)).toEqual([expect.objectContaining({ claimId, undone: true })]);
    expect(await f.executor.undo({ automationId: AUTOMATION, claimId }, trash)).toEqual({ status: "refused", reason: "You already undid this run." });
    expect(await f.executor.retry({ automationId: AUTOMATION, claimId, startOver: false })).toEqual({ status: "refused", reason: UNDONE_RUN_ERROR });
    expect((await f.record(invoice))?.values).toMatchObject({ [STATUS]: "Open", [NOTES]: "mine" });
    await f.executor.dispose();
  });

  it("refuses to undo a run whose rules no longer resolve, before it saves or sends anything", async () => {
    const f = await world();
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    const claimId = f.claims()[0]!.claimId;
    f.dropRules();
    expect(await f.executor.undo({ automationId: AUTOMATION, claimId }, async () => undefined))
      .toEqual({ status: "refused", reason: DATASET_UNDO_RULES_CHANGED });
    expect((await f.record(invoice))?.values[STATUS]).toBe("Closed");
    // Nothing marks the run undone, so it still reads as a run that can be undone later.
    const { runs } = await createAutomationRunStore(f.root).runsOf(AUTOMATION, claimId);
    expect(runs.map((run) => run.undo)).toEqual([null]);
    await f.executor.dispose();
  });
});

describe("pressing a button on a dataset record", () => {
  const PRESSER = "user-ana";
  const BUTTON_AUTOMATION = "collection:Budget#mark-paid";
  const markPaid = (step = "      - set:\n          Status: '=\"Paid by \" + person.name + \" with \" + trigger.field'\n        operation: invoices.status\n", button = "Mark paid") => `  - id: mark-paid
    name: Mark paid
    when:
      button: ${button}
    do:
${step}`;
  const pressId = (number: number) => `4f2d3c1a-9b8e-4c7d-a6f5-${String(number).padStart(12, "0")}`;
  const owner = (f: Awaited<ReturnType<typeof world>>) => f.host.describe(definition.datasetId);
  const press = (f: Awaited<ReturnType<typeof world>>, input: { recordId: string; pressId: string; pressedBy?: string; field?: string }, description = owner(f)) =>
    f.executor.pressDataset({ datasetId: definition.datasetId, table: "Invoices", field: "Mark paid", pressedBy: PRESSER, ...input, recordId: JSON.stringify(input.recordId) },
      description, () => undefined);

  it("runs a press on the record as it is now, for the person who pressed, once, and tells the window how it settled", async () => {
    const f = await world();
    await f.writeAutomations(markPaid());
    await f.executor.open();
    expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], owner(f)))
      .toEqual([{ kind: "ready", automationId: BUTTON_AUTOMATION }]);
    // A button watches nothing; its presses claim.
    expect(f.host.automations.subscriptions()).toEqual([]);
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    const watched: string[] = [];
    const pressed = await f.executor.pressDataset({ datasetId: definition.datasetId, table: "Invoices", field: "Mark paid", recordId: JSON.stringify(invoice), pressId: pressId(1), pressedBy: PRESSER },
      owner(f), (claimId) => watched.push(claimId));
    if (pressed.busy) throw new Error("The press ran.");
    expect(pressed.settled).toBeNull();
    expect(watched).toEqual([pressed.claimId]);
    await f.until(() => f.settled.length === 1);
    expect(f.settled).toEqual([{ claimId: pressed.claimId, outcome: "done", error: null }]);
    expect((await f.record(invoice))?.values[STATUS]).toBe(`Paid by Person ${PRESSER} with Mark paid`);
    expect(f.host.automations.claims(BUTTON_AUTOMATION)).toEqual([expect.objectContaining({ claimId: pressed.claimId, state: "done", depth: 0,
      fact: { kind: "button", datasetId: definition.datasetId, tableId: TABLE, recordId: invoice, fieldId: MARK_PAID, definitionHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      actor: { kind: "owner", userId: PRESSER } })]);
    // The press sent again after a lost reply answers how its run ended, and runs nothing more.
    expect(await press(f, { recordId: invoice, pressId: pressId(1) })).toEqual({ busy: false, claimId: pressed.claimId, settled: { outcome: "done", error: null } });
    await expect(press(f, { recordId: "another", pressId: pressId(1) })).rejects.toThrow("already names another press");
    expect(f.host.automations.claims(BUTTON_AUTOMATION)).toHaveLength(1);
    // History names the automation, which wrote as the owner.
    expect(f.host.history({ datasetId: definition.datasetId }).entries[0]).toMatchObject({ automation: { automationId: BUTTON_AUTOMATION, depth: 1 } });
    await f.executor.dispose();
  });

  it("refuses someone the host lets read the table, or not use every operation the button invokes, before claiming anything", async () => {
    const f = await world();
    await f.writeAutomations(markPaid());
    await f.executor.open();
    const { id: invoice } = await f.create({});
    const described = owner(f);
    const only = (...operationIds: string[]) => ({ ...described, operations: described.operations.filter((operation) => operationIds.includes(operation.operationId)) });
    const refusal = "Only people who can edit Invoices can use this button.";
    // The run also reads the record through invoices.list as the owner, so the presser must be able to.
    // A description of another dataset grants nothing here.
    for (const description of [only(LIST), only(LIST, EDIT), only(STATUS_ONLY), { ...described, datasetId: id(99) }]) {
      await expect(press(f, { recordId: invoice, pressId: pressId(2) }, description)).rejects.toThrow(refusal);
      expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], description)).toEqual([{ kind: "disabled", reason: refusal }]);
    }
    await expect(f.executor.pressDataset({ datasetId: definition.datasetId, table: "Invoices", field: "Mark paid", recordId: "not json", pressId: pressId(3), pressedBy: PRESSER },
      described, () => undefined)).rejects.toThrow("This record is not in Invoices.");
    // A record the table does not hold gets no claim.
    await expect(press(f, { recordId: "missing", pressId: pressId(3) })).rejects.toThrow("This record is no longer in Invoices.");
    expect(f.host.automations.claims(BUTTON_AUTOMATION)).toEqual([]);
    await f.executor.dispose();
  });

  it("says why a button whose automation names an operation the rules lack cannot run, as the panel does, not that the owner cannot edit", async () => {
    const f = await world();
    await f.writeAutomations(markPaid("      - set:\n          Status: Refunded\n        operation: invoices.refund\n"));
    await f.executor.open();
    const { id: invoice } = await f.create({});
    const reason = "Budget has no approved operation named invoices.refund.";
    const summary = await f.executor.automationsIn("Budget");
    expect(summary.status === "read" && summary.automations[0]?.valid && summary.automations[0].cannotRun).toBe(reason);
    expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], owner(f))).toEqual([{ kind: "disabled", reason }]);
    await expect(press(f, { recordId: invoice, pressId: pressId(11) })).rejects.toThrow(reason);
    // Someone who cannot edit the table still learns only that.
    const reader = { ...owner(f), operations: owner(f).operations.filter((operation) => operation.operationId === LIST) };
    expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], reader))
      .toEqual([{ kind: "disabled", reason: "Only people who can edit Invoices can use this button." }]);
    expect(f.host.automations.claims(BUTTON_AUTOMATION)).toEqual([]);
    await f.executor.dispose();
  });

  it("tells the window why a press waits, runs the same person's second press with it, and is busy for anyone else", async () => {
    const f = await world({ roster: UNKNOWN });
    await f.writeAutomations(markPaid());
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    const first = await press(f, { recordId: invoice, pressId: pressId(4) });
    if (first.busy) throw new Error("The press ran.");
    await f.until(() => f.waiting.length > 0);
    expect(f.waiting[0]).toEqual({ claimId: first.claimId, reason: "roster" });
    expect(await press(f, { recordId: invoice, pressId: pressId(5) })).toEqual({ busy: false, claimId: first.claimId, settled: null });
    expect(await press(f, { recordId: invoice, pressId: pressId(6), pressedBy: "user-ben" })).toEqual({ busy: true });
    f.setRoster(OWNER);
    f.executor.rosterChanged();
    await f.until(() => f.settled.length === 1);
    expect(f.settled).toEqual([{ claimId: first.claimId, outcome: "done", error: null }]);
    await f.executor.dispose();
  });

  it("answers a press sent again after its button was renamed, and only as it was first asked", async () => {
    const f = await world();
    await f.writeAutomations(markPaid());
    await f.executor.open();
    const { id: invoice } = await f.create({});
    const first = await press(f, { recordId: invoice, pressId: pressId(8) });
    if (first.busy) throw new Error("The press ran.");
    await f.until(() => f.settled.length === 1);
    const renamed = structuredClone(definition);
    renamed.tables[0]!.fields.find((field) => field.fieldId === MARK_PAID)!.name = "Settle";
    await f.writeAutomations(markPaid(undefined, "Settle"));
    f.executor.handleWatcherEvents([{ operation: "update", path: "Budget/automations.yaml" }]);
    f.changeRules(renamed);
    // A wait that asks the host would wake itself, so it watches the index.
    await f.until(async () => JSON.stringify(await f.executor.automationsIn("Budget")).includes("Settle"));
    expect(await press(f, { recordId: invoice, pressId: pressId(8) })).toEqual({ busy: false, claimId: first.claimId, settled: { outcome: "done", error: null } });
    await expect(press(f, { recordId: invoice, pressId: pressId(8), field: "Settle" })).rejects.toThrow("already names another press");
    await f.executor.dispose();
  });

  it.each([
    ["runs from another button", "Refund", markPaid(undefined, "Refund")],
    ["does something else", "Settled", markPaid("      - set:\n          Status: Settled\n        operation: invoices.status\n")],
  ])("refuses a waiting press once its automation %s, without touching the record", async (_name, marker, edited) => {
    const f = await world({ roster: UNKNOWN });
    await f.writeAutomations(markPaid());
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    const pressed = await press(f, { recordId: invoice, pressId: pressId(9) });
    if (pressed.busy) throw new Error("The press ran.");
    await f.until(() => f.waiting.length > 0);
    await f.writeAutomations(edited);
    f.executor.handleWatcherEvents([{ operation: "update", path: "Budget/automations.yaml" }]);
    await f.until(async () => JSON.stringify(await f.executor.automationsIn("Budget")).includes(marker));
    f.setRoster(OWNER);
    f.executor.rosterChanged();
    await f.until(() => f.settled.length === 1);
    expect(f.settled).toEqual([{ claimId: pressed.claimId, outcome: "failed", error: "Mark paid changed after it was pressed. Press it again." }]);
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    await f.executor.dispose();
  });

  it("lists a dataset that moved to a server with its buttons off, saying why, and refuses a press the same way", async () => {
    const f = await world();
    await f.writeAutomations(markPaid());
    await f.executor.open();
    const { id: invoice } = await f.create({});
    f.moveToServer();
    const moved = "This Collection moved to a server, so its buttons can't run here.";
    expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], owner(f)))
      .toEqual([{ kind: "disabled", reason: moved }]);
    await expect(press(f, { recordId: invoice, pressId: pressId(10) })).rejects.toThrow(moved);
    expect(f.host.automations.claims(BUTTON_AUTOMATION)).toEqual([]);
    await f.executor.dispose();
  });

  it("runs a failed press again only for the person who pressed it or the owner", async () => {
    for (const mayRetryPress of [false, true]) {
      const f = await world({ mayRetryPress });
      await f.writeAutomations(markPaid("      - set:\n          Status: '=missing.value'\n        operation: invoices.status\n"));
      await f.executor.open();
      const { id: invoice } = await f.create({});
      const pressed = await press(f, { recordId: invoice, pressId: pressId(7) });
      if (pressed.busy) throw new Error("The press ran.");
      await f.until(() => f.settled.length === 1);
      expect(f.settled[0]).toMatchObject({ claimId: pressed.claimId, outcome: "failed" });
      expect(await f.executor.retry({ automationId: BUTTON_AUTOMATION, claimId: pressed.claimId, startOver: false })).toEqual(mayRetryPress
        ? { status: "queued", press: true }
        : { status: "refused", reason: "Only the person who pressed this button, or the workspace's owner, can run it again." });
      await f.executor.dispose();
    }
  });
});
