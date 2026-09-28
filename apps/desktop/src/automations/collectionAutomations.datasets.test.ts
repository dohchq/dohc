import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { datasetPrincipalKey } from "@dohc/security-contract/dataset-artifacts";
import type { JsonValue } from "@dohc/app-backend-runtime";
import { DATASET_AUTOMATION_HISTORY } from "@dohc/app-backend-runtime/dataset-automation-claims";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import type { Automation } from "@dohc/workspace-contracts/automations";
import { VersionedLiveAdapter, type AutomationClaim } from "@dohc/workspace-engine-client";
import { generateDatasetSources } from "../workspaces/datasetGenerator";
import { createLocalDatasetHost, type LocalDatasetHost } from "../workspaces/localDatasetHost";
import { createTestScratch } from "../workspaces/testTemp";
import { resolveWorkspaceMetadataDir } from "../workspaces/workspaceMetadata";
import { chatDirectoryOf, type AutomationChatMessage, type AutomationNotice, type ChatDirectoryChannel } from "@dohc/automation-executor/automation-chat";
import { createAutomationFormulaEvaluator, type AutomationFormulaEvaluator } from "@dohc/automation-executor/automation-evaluator-host";
import type { ReachRoster } from "@dohc/automation-executor/automation-reach";
import type { AutomationFailure } from "@dohc/automation-executor/automation-failed-notice";
import { createAutomationRunStore } from "@dohc/automation-executor/automation-run-store";
import {
  CollectionAutomations,
  type AutomationFailureReport,
  type CollectionAutomationEngine,
  type PressSettled,
  type PressWaitReason,
} from "@dohc/automation-executor/collection-automations";
import { UNDONE_RUN_ERROR } from "@dohc/automation-executor/collection-automation-run";
import { DATASET_WAKE_NEEDS_BUTTON } from "@dohc/automation-executor/dataset-automation-plan";
import { definitionHash } from "@dohc/automation-executor/automation-plan";
import { DATASET_UNDO_RULES_CHANGED } from "@dohc/automation-executor/dataset-automation-undo";

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
const drains: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const drain of drains.splice(0)) await drain();
  for (const host of hosts.splice(0)) await host.close();
});

const TEAM: ChatDirectoryChannel = { id: "team", name: "Team", slug: "team", kind: "channel", type: "posts", wireId: "team", runningThreadId: null };

// Generated operations with more code after them, as someone who adds to
// them writes: dohc no longer knows the operations. This code refuses every
// call an automation makes, and every read of one record, as a trigger read
// or a press's record check would make, so a run that calls any fails.
const AUTHORED_OPERATIONS = `${files[definition.operationsPath]}
for (const [name, operation] of Object.entries(globalThis.operations)) {
  globalThis.operations[name] = (ctx, input) => {
    if (ctx.caller.kind === "automation") ctx.refuse("not_for_automations", "This operation does not run for automations.");
    if (input.limit === 1) ctx.refuse("one_record", "This read lists records; it does not find one.");
    return operation(ctx, input);
  };
}
`;

// The same rules with an action someone wrote: only an automation may settle
// an invoice, and the action says which automation did.
const SETTLE = id(14), HOLD = id(15), RELEASE = id(16);
const ACTION_DESCRIPTOR = JSON.stringify({ ...definition, operations: [...definition.operations,
  { operationId: SETTLE, name: "invoices.settle", label: "Settle", tableId: TABLE, kind: "action", access: "owner", readOnly: false, fieldIds: [STATUS] },
  // Hold puts an invoice on hold, and Release puts back the status it had.
  { operationId: HOLD, name: "invoices.hold", label: "Hold", tableId: TABLE, kind: "action", access: "owner", readOnly: false, fieldIds: [STATUS], reversedBy: "invoices.release" },
  { operationId: RELEASE, name: "invoices.release", label: "Release", tableId: TABLE, kind: "action", access: "owner", readOnly: false, fieldIds: [STATUS] },
] }, null, 2) + "\n";
const ACTION_OPERATIONS = `${files[definition.operationsPath]}
globalThis.operations["invoices.settle"] = (ctx, input) => {
  if (ctx.caller.kind !== "automation") ctx.refuse("automations_only", "Only an automation settles an invoice.");
  const changed = ctx.db.execute('UPDATE invoices SET status=?, "_record_version"="_record_version"+1 WHERE id=?', ["Settled by " + ctx.caller.automationId + ": " + input.note, input.id]);
  if (changed.changes !== 1) ctx.refuse("not_found", "This invoice is gone.");
  return { id: input.id };
};
globalThis.operations["invoices.hold"] = (ctx, input) => {
  const [row] = ctx.db.query("SELECT status FROM invoices WHERE id=?", [input.id]);
  if (!row) ctx.refuse("not_found", "This invoice is gone.");
  ctx.db.execute('UPDATE invoices SET status=?, "_record_version"="_record_version"+1 WHERE id=?', ["On hold", input.id]);
  return { undo: { id: input.id, status: row.status } };
};
globalThis.operations["invoices.release"] = (ctx, input) => {
  const [row] = ctx.db.query("SELECT status FROM invoices WHERE id=?", [input.id]);
  if (!row || row.status !== "On hold") ctx.refuse("changed", "This invoice is no longer on hold.");
  ctx.db.execute('UPDATE invoices SET status=?, "_record_version"="_record_version"+1 WHERE id=?', [input.status, input.id]);
  return { id: input.id };
};
`;

async function world(options: { roster?: ReachRoster; hostOpen?: boolean; evaluator?: AutomationFormulaEvaluator; groups?: boolean; mayRetryPress?: boolean; storeFails?: boolean; operations?: string; descriptor?: string;
  /** Runs once, after the first automation invocation commits and before its run hears back, as a crash there would. */
  afterInvoke?: () => Promise<void> } = {}) {
  const root = await createTestScratch("dohc-dataset-automations-");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    const given = path === definition.operationsPath ? options.operations : path === "Budget/dataset.json" ? options.descriptor : undefined;
    await writeFile(join(root, path), given ?? text);
  }
  const writeAutomations = (body: string) => writeFile(join(root, "Budget", "automations.yaml"), `version: 1\nautomations:\n${body}`);
  await writeAutomations(closePaid());

  let executor: CollectionAutomations | undefined;
  const waiters = new Set<() => void>();
  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  // Checks run on every wake without waiting for the last one; the test waits for them all before its host closes.
  const checking = new Set<Promise<void>>();
  const until = (condition: () => boolean | Promise<boolean>) => new Promise<void>((resolve, reject) => {
    const check = () => {
      const run = (async () => {
        if (!waiters.has(check)) return;
        try {
          if (await condition()) { waiters.delete(check); resolve(); }
        } catch (error) {
          if (waiters.delete(check)) reject(error);
        }
      })();
      checking.add(run);
      void run.finally(() => checking.delete(run));
    };
    waiters.add(check);
    check();
  });
  const settledChecks = async () => { while (checking.size > 0) await Promise.all([...checking]); };
  const host = await createLocalDatasetHost({ workspaceId: "workspace", workspaceRoot: root, capacityBytes: 4 * 1024 * 1024,
    onAutomationClaims: () => { executor?.notifyClaimed(); wake(); },
    onDatasetsChanged: () => executor?.datasetsChanged() });
  hosts.push(host);
  drains.push(settledChecks);
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
  // Claims the engine holds for this Collection's automations, as a schedule or a Group message makes them.
  const engineClaims: AutomationClaim[] = [];
  const engineFailures: Array<Omit<AutomationFailure, "datasetInstance">> = [];
  const engineRetries: string[] = [];
  let engineReadable = true;
  // How many claims the engine has served.
  let served = 0;
  const engine = {
    listCollections: async () => ({ collections: [] }),
    subscribeAutomation: async (input: unknown) => { subscribed.push(input); },
    releaseAutomationGroups: async () => ({ watchedGeneration: 0, handover: { floorMs: 0, automations: [] } }),
    watchAutomationGroups: async () => ({ needsHandover: false }),
    // Serves the oldest pending claim, as the engine drains its queue.
    claimNextAutomation: async () => {
      const next = engineClaims.filter((claim) => claim.state === "pending").sort((left, right) => left.createdAtMs - right.createdAtMs)[0];
      if (next === undefined) return null;
      served += 1;
      Object.assign(next, { state: "running", attempts: next.attempts + 1 });
      return structuredClone(next);
    },
    settleAutomationClaim: async ({ claimId, state, error }: { claimId: string; state: "done" | "failed"; error?: string }) => {
      Object.assign(engineClaims.find((claim) => claim.claimId === claimId)!, { state, updatedAtMs: Date.now(), ...(error === undefined ? {} : { error }) });
      wake();
    },
    releaseAutomationClaim: async ({ claimId }: { claimId: string }) => {
      const claim = engineClaims.find((candidate) => candidate.claimId === claimId)!;
      Object.assign(claim, { state: "pending", attempts: claim.attempts - 1 });
      wake();
    },
    listAutomationClaims: async ({ automationId }: { automationId: string }) => {
      if (!engineReadable) throw new Error("The engine could not read its claims.");
      return { claims: engineClaims.filter((claim) => claim.automationId === automationId).sort((left, right) => right.createdAtMs - left.createdAtMs) };
    },
    listAutomationFailures: async () => ({ failures: engineFailures }),
    retryAutomationClaim: async ({ claimId }: { claimId: string }) => {
      engineRetries.push(claimId);
      const claim = engineClaims.find((candidate) => candidate.claimId === claimId)!;
      Object.assign(claim, { state: "pending", run: claim.run + 1 });
      return claim;
    },
    readAutomationGroupSkips: async () => ({ aheadAtMs: null, lateAtMs: null }),
  } as unknown as CollectionAutomationEngine;
  let roster = options.roster ?? OWNER;
  let afterInvoke = options.afterInvoke;
  let hostOpen = options.hostOpen ?? true;
  // Rules the executor sees in place of the approved ones, as after a schema change it indexes.
  let indexed: DatasetDefinition | null = null;
  // Whether saved rules still resolve, as before an approved change that drops them.
  let rulesResolve = true;
  // Whether opening the dataset store fails, as when another process holds it.
  let storeFails = options.storeFails ?? false;
  // Why the host takes no press, as after the dataset moved to a server; the runtime tests fence a real journal.
  let unpressable: string | null = null;
  const opened: boolean[] = [];
  const errors: Array<{ context: string; error: unknown }> = [];
  let automationsChanged = 0;
  // What the pressing window hears.
  const settled: PressSettled[] = [];
  const waiting: Array<{ claimId: string; reason: PressWaitReason }> = [];
  // What automations post and notify.
  const messages: AutomationChatMessage[] = [];
  const notices: AutomationNotice[] = [];
  const failureReports: AutomationFailureReport[] = [];
  const makeExecutor = () => executor = new CollectionAutomations({
    personName: (userId) => `Person ${userId}`,
    mayRetryPress: async () => options.mayRetryPress ?? false,
    onPressSettled: (event) => { settled.push(event); wake(); },
    onPressWaiting: (event) => { waiting.push(event); wake(); },
    groupHost: async () => (options.groups ? 0 : null),
    groupRelayRecord: async () => ({ generation: 0, handover: null }),
    groupMessagesSkipped: async () => undefined,
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
    store: createAutomationRunStore(root, resolveWorkspaceMetadataDir),
    onRunsChanged: wake,
    reportFailure: async (report) => { failureReports.push(report); wake(); },
    withdrawFailure: async () => undefined,
    onSwitchedOff: () => undefined,
    onHoldsChanged: () => undefined,
    onAutomationsChanged: () => { automationsChanged += 1; wake(); },
    onError: (context, error) => { errors.push({ context, error }); wake(); },
    withDatasetHost: async (work, open) => {
      opened.push(open);
      if (!hostOpen && !open) return null;
      if (!hostOpen && storeFails) throw new Error("The dataset store is in use by another process.");
      // As in main, an opened host serves the executor until it closes.
      hostOpen = true;
      const override = indexed;
      const current = override === null ? host.automations : { ...host.automations,
        datasets: () => ({ definitions: [override], failures: [] as Array<{ datasetId: string; error: unknown }> }),
        revision: (datasetId: string) => ({ ...host.automations.revision(datasetId), definition: override }) };
      const resolving = rulesResolve ? current : { ...current, resolves: () => false };
      const moved = unpressable;
      const pressable = moved === null ? resolving : { ...resolving, assertPressable: () => { throw new Error(moved); } };
      const after = afterInvoke;
      const automations = after === undefined ? pressable : { ...pressable, invoke: async (...args: Parameters<typeof pressable.invoke>) => {
        const result = await pressable.invoke(...args);
        afterInvoke = undefined;
        await after();
        return result;
      } };
      const result = await work(automations);
      wake();
      return result;
    },
  });
  makeExecutor();
  return {
    host, root, rules, create, edit, record, records, until, errors, opened, subscribed, writeAutomations, makeExecutor, settled, waiting, messages, notices, failureReports,
    engineClaims, engineFailures, engineRetries, setEngineReadable: (readable: boolean) => { engineReadable = readable; },
    served: () => served,
    get executor() { return executor!; },
    claims: () => host.automations.claims(AUTOMATION),
    automationsChanged: () => automationsChanged,
    setRoster: (next: ReachRoster) => { roster = next; },
    openHost: () => { hostOpen = true; executor!.datasetsChanged(); },
    changeRules: (next: DatasetDefinition) => { indexed = next; executor!.datasetsChanged(); },
    dropRules: () => { rulesResolve = false; },
    keepRules: () => { rulesResolve = true; },
    fixStore: () => { storeFails = false; },
    moveToServer: () => { unpressable = "This Collection moved to a server, so its buttons can't run here."; },
  };
}

describe("Collection automations on a dataset", () => {
  it("runs a change's automation on a dataset whose operations someone wrote, from the change's facts alone", async () => {
    const f = await world({ operations: AUTHORED_OPERATIONS });
    await f.writeAutomations(closePaid("      - notify: 'Invoice {record.id} paid, was {previous.Paid}'\n        to: [user-owner]\n"));
    await f.executor.open();
    const { id: invoice } = await f.create({ [PAID]: false, [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    expect(f.notices).toEqual([expect.objectContaining({ body: `Invoice ${invoice} paid, was false` })]);
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
  });

  it("stops a run that must compare a value too large for its claim, instead of comparing it as empty", async () => {
    const f = await world({ operations: AUTHORED_OPERATIONS });
    await f.writeAutomations("  - id: close-paid\n    name: Cleared notes\n    when:\n      field-changed: Notes\n      to: null\n    do:\n      - notify: Cleared\n        to: [user-owner]\n");
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open", [NOTES]: "short" });
    await f.edit(invoice, { [NOTES]: "n".repeat(9000) });
    await f.until(() => f.claims()[0]?.state === "failed");
    expect(f.claims()[0]?.error).toBe("The new value of Notes is too large for dohc to compare without reading the record.");
    expect(f.notices).toEqual([]);
  });

  it("stops a run whose formula reads a field dohc did not read, instead of reading it as empty", async () => {
    const f = await world({ operations: AUTHORED_OPERATIONS });
    await f.writeAutomations(closePaid("      - if: record.Status == \"Open\"\n        do:\n          - notify: Open\n            to: [user-owner]\n        otherwise:\n          - notify: Not open\n            to: [user-owner]\n"));
    await f.executor.open();
    const { id: invoice } = await f.create({ [PAID]: false, [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "failed");
    expect(f.claims()[0]?.error).toMatch(/Formulas can read only this record's id, not Status\./);
    expect(f.notices).toEqual([]);
  });

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
    const [run] = (await createAutomationRunStore(f.root, resolveWorkspaceMetadataDir).runsOf(AUTOMATION, f.claims()[0]!.claimId)).runs;
    expect(run!.applied).toEqual([{ ordinal: 0, writes: [expect.objectContaining({
      kind: "dataset-edit", operationId: STATUS_ONLY, recordId: invoice, fields: [{ fieldId: STATUS, field: "Status", before: "Open", after: "Closed" }],
    })] }]);
    // Reading the run, as the CLI does, names the change that started it and step 1's edit.
    expect(await f.executor.run(AUTOMATION, f.claims()[0]!.claimId)).toMatchObject({
      state: "done",
      // The owner's edit could be a person's or an agent's, so it names neither.
      trigger: { kind: "changed", recordId: String(invoice), by: null, depth: 0 },
      failedStep: null,
      startsOver: false,
      steps: [{ step: 1, writes: [expect.objectContaining({ kind: "dataset-edit", recordId: invoice })] }],
    });
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
    const [run] = (await createAutomationRunStore(f.root, resolveWorkspaceMetadataDir).runsOf(AUTOMATION, f.claims()[0]!.claimId)).runs;
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
    // Its notice counts the failure per instance of the dataset, and it ran.
    await f.until(() => f.failureReports.length === 1);
    expect(f.failureReports).toEqual([{
      failure: expect.objectContaining({ automationId: AUTOMATION, error: sentence, generation: 1, chainStopped: false, datasetInstance: expect.any(String) }),
      name: expect.any(String),
      startedBy: null,
      replaces: null,
    }]);
    await f.executor.dispose();
  });

  it("skips a record change claimed before its automation changed to start on a schedule, without a failure", async () => {
    const f = await world({ roster: UNKNOWN });
    await f.executor.open();
    const { id: invoice } = await f.create({});
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "pending");
    await f.writeAutomations(`  - id: close-paid
    name: Close paid invoices
    when: {schedule: day, timezone: UTC}
    do:
      - find: record.Paid == true
        as: paid
        operation: invoices.list
      - set:
          Status: Closed
        records: paid
        operation: invoices.status
`);
    f.executor.handleWatcherEvents([{ operation: "update", path: "Budget/automations.yaml" }]);
    await f.until(async () => JSON.stringify(await f.executor.automationsIn("Budget")).includes("schedule"));
    f.setRoster(OWNER);
    f.executor.rosterChanged();
    await f.until(() => f.claims()[0]?.state === "done");
    expect(f.host.automations.failures()).toEqual([]);
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    await f.executor.dispose();
  });

  it("pins each step to a reversible operation with the fewest extra fields when the panel saves", async () => {
    const f = await world();
    await f.executor.open();
    const built: Automation = {
      id: "close-paid", name: "Close", enabled: true, when: { kind: "field-changed", field: "Paid", to: null, table: null }, if: null,
      do: [
        { kind: "set", values: [{ field: "Status", value: { kind: "literal", value: "Closed" } }], records: null, operation: null },
        { kind: "set", values: [{ field: "Notes", value: { kind: "literal", value: "x" } }], records: null, operation: "invoices.status" },
        { kind: "set", values: [{ field: "Finished on", value: { kind: "literal", value: "2026-09-25" } }], records: null, operation: null },
      ],
    };
    const [pinned] = await f.executor.pinOperations("Budget", [built], []);
    expect(pinned!.do.map((step) => "operation" in step ? step.operation : null)).toEqual(["invoices.status", "invoices.edit", null]);
    // Switching off or renaming one the file already holds changes no step.
    const [switched] = await f.executor.pinOperations("Budget", [{ ...built, enabled: false, name: "Closer" }], [built]);
    expect(switched!.do).toEqual(built.do);
    // A copy of it keeps its steps too.
    const [, copy] = await f.executor.pinOperations("Budget", [built, { ...built, id: "close-paid-copy" }], [built]);
    expect(copy!.do).toEqual(built.do);
    // Editing its condition and adding a step pins only the new step.
    const added = { kind: "set" as const, values: [{ field: "Notes", value: { kind: "literal" as const, value: "y" } }], records: null, operation: null };
    const [edited] = await f.executor.pinOperations("Budget", [{ ...built, if: "record.Paid == true", do: [...built.do, added] }], [built]);
    expect(edited!.do.map((step) => "operation" in step ? step.operation : null)).toEqual([null, "invoices.status", null, "invoices.edit"]);
    await f.executor.dispose();
  });

  it("opens the dataset host when the workspace opens, since a due time opens nothing, then runs what it holds", async () => {
    const f = await world({ hostOpen: false });
    await f.executor.open();
    expect(f.opened[0]).toBe(true);
    expect(f.host.automations.subscriptions()).toHaveLength(1);
    const { id: invoice } = await f.create({});
    await f.edit(invoice, { [PAID]: true });
    await f.until(async () => (await f.record(invoice))?.values[STATUS] === "Closed");
    await f.executor.dispose();
  });

  it("opens a closed dataset host when someone asks for an automation's runs, as the panel does", async () => {
    const f = await world({ hostOpen: false });
    await f.executor.open();
    await expect(f.executor.runs(AUTOMATION)).resolves.toEqual([]);
    expect(f.opened).toContain(true);
    expect(f.host.automations.subscriptions()).toHaveLength(1);
    // Try again finds the automation in the dataset's ledger, not "no longer in automations.yaml".
    await expect(f.executor.retry({ automationId: AUTOMATION, claimId: "dac_unknown", startOver: false }))
      .resolves.toEqual({ status: "refused", reason: "Run history no longer shows this run, so dohc will not run it again." });
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

  it("says in the ⚡ panel that a record change cannot wake your agent", async () => {
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
      status: "undone", reverted: 1, removed: 0, kept: 1, changedSince: 1, missing: 0, irreversible: 0, actions: 0, actionsReversed: 0,
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

  it("says the automations changed when a dataset's approved rules change, so its panel finds the folder again", async () => {
    // With no roster to check, no reach verdict changes to say it instead.
    const f = await world({ roster: UNKNOWN });
    await f.executor.open();
    f.host.archive({ datasetId: definition.datasetId });
    await f.until(async () => (await f.executor.datasetCollection(definition.datasetId)).status === "cannot-run");
    const before = f.automationsChanged();
    f.host.restore({ datasetId: definition.datasetId });
    await f.until(() => f.automationsChanged() > before);
    expect(await f.executor.datasetCollection(definition.datasetId)).toEqual({ status: "found", collectionPath: "Budget" });
    await f.executor.dispose();
  });

  it("names its folder for the ⚡ panel, marks each field its switched-on automations set in a table, and shows its last run", async () => {
    const f = await world();
    await f.executor.open();
    expect(await f.executor.datasetCollection(definition.datasetId)).toEqual({ status: "found", collectionPath: "Budget" });
    expect(await f.executor.datasetCollection(id(99))).toEqual({ status: "cannot-run", reason: "This Collection's rules are not approved yet, so its automations cannot run." });
    expect(await f.executor.datasetFieldMarks(definition.datasetId, "Invoices")).toEqual([{ field: "Status", automations: ["Close paid invoices"] }]);
    expect(await f.executor.datasetFieldMarks(definition.datasetId, "Refunds")).toEqual([]);
    expect(await f.executor.datasetFieldMarks(id(99), "Invoices")).toEqual([]);
    // A document Collection's marks never come from a dataset's automations.
    expect(await f.executor.fieldMarks("Budget")).toEqual([]);

    expect(await f.executor.automationsIn("Budget")).toMatchObject({ automations: [{ lastRun: null }] });
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    expect(await f.executor.automationsIn("Budget")).toMatchObject({ automations: [{ lastRun: { state: "done" } }] });

    // A switched-off automation marks nothing.
    await f.writeAutomations(closePaid(undefined, false));
    f.executor.handleWatcherEvents([{ operation: "update", path: "Budget/automations.yaml" }]);
    await f.until(async () => (await f.executor.datasetFieldMarks(definition.datasetId, "Invoices")).length === 0);
    await f.executor.dispose();
  });

  it("undoes the runs of a person's automations on a dataset when the owner stops and restores them", async () => {
    const f = await world();
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    const summary = await f.executor.automationsIn("Budget");
    if (summary.status !== "read" || !summary.automations[0]?.valid) throw new Error("The automation should read.");
    const hash = definitionHash(summary.automations[0].automation);
    const trash = async () => { throw new Error("A dataset's added records stay."); };
    await expect(f.executor.undoRunsOf([{ automationId: AUTOMATION, definitionHash: hash }], trash)).resolves.toEqual({ undone: 1, left: 0 });
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    expect(await f.executor.runs(AUTOMATION)).toEqual([expect.objectContaining({ undone: true })]);
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
    const { runs } = await createAutomationRunStore(f.root, resolveWorkspaceMetadataDir).runsOf(AUTOMATION, claimId);
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
  const press = (f: Awaited<ReturnType<typeof world>>, input: { recordId: string; pressId: string; pressedBy?: string; field?: string; confirmed?: string[] }, description = owner(f)) =>
    f.executor.pressDataset({ datasetId: definition.datasetId, table: "Invoices", field: "Mark paid", pressedBy: PRESSER, confirmed: [], ...input, recordId: JSON.stringify(input.recordId) },
      description, () => undefined);

  it("runs a press on a dataset whose operations someone wrote, calling none of them for its own checks", async () => {
    const f = await world({ operations: AUTHORED_OPERATIONS });
    await f.writeAutomations(markPaid("      - notify: 'Invoice {record.id} was pressed'\n        to: [user-owner]\n"));
    await f.executor.open();
    expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], owner(f)))
      .toEqual([{ kind: "ready", automationId: BUTTON_AUTOMATION }]);
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    const pressed = await press(f, { recordId: invoice, pressId: pressId(12) });
    if (pressed.busy) throw new Error("The press ran.");
    await f.until(() => f.settled.length === 1);
    expect(f.settled).toEqual([{ claimId: pressed.claimId, outcome: "done", error: null }]);
    expect(f.notices).toEqual([expect.objectContaining({ body: `Invoice ${invoice} was pressed` })]);
    // A step that changes records still refuses these operations.
    await f.writeAutomations(markPaid());
    f.executor.handleWatcherEvents([{ operation: "update", path: "Budget/automations.yaml" }]);
    const refusal = "Budget's operations were written or changed outside dohc, so Set fields, Add record, and Find steps cannot use them.";
    await f.until(async () => JSON.stringify(await f.executor.automationsIn("Budget")).includes(refusal));
  });

  const settle = "      - invoke: invoices.settle\n        input:\n          id: '=record.id'\n          note: pressed\n";
  const watchStatus = `  - id: watch
    name: Watch status
    when:
      field-changed: Status
    do:
      - notify: Status changed
        to: [user-owner]
`;

  it("runs a button's action as the automation, and the action's change starts other automations one step deeper, never its own", async () => {
    const f = await world({ descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS });
    await f.writeAutomations(markPaid(settle) + watchStatus);
    await f.executor.open();
    // The button says which action it runs that dohc cannot undo, so it can ask first.
    expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], owner(f)))
      .toEqual([{ kind: "ready", automationId: BUTTON_AUTOMATION, irreversible: [{ name: "invoices.settle", label: "Settle" }] }]);
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    // A press that did not agree to Settle is refused: the button would run what nobody was told of.
    await expect(press(f, { recordId: invoice, pressId: pressId(25) })).rejects.toThrow("changed");
    const pressed = await press(f, { recordId: invoice, pressId: pressId(20), confirmed: ["invoices.settle"] });
    if (pressed.busy) throw new Error("The press ran.");
    await f.until(() => f.settled.length === 1 && f.host.automations.claims("collection:Budget#watch")[0]?.state === "done");
    expect(f.settled).toEqual([{ claimId: pressed.claimId, outcome: "done", error: null }]);
    expect((await f.record(invoice))?.values[STATUS]).toBe(`Settled by ${BUTTON_AUTOMATION}: pressed`);
    // History names the automation behind the action's commit.
    expect(f.host.history({ datasetId: definition.datasetId }).entries[0]).toMatchObject({ operation: "invoices.settle", automation: { automationId: BUTTON_AUTOMATION, depth: 1 } });
    expect(f.host.automations.claims("collection:Budget#watch")).toEqual([expect.objectContaining({ state: "done", depth: 1 })]);
    expect(f.notices).toEqual([expect.objectContaining({ body: "Status changed" })]);
    expect(f.host.automations.claims(BUTTON_AUTOMATION)).toEqual([expect.objectContaining({ claimId: pressed.claimId })]);
    await f.executor.dispose();
  });

  it("undoes a reversible action through its reverse, once, and says an action it cannot reverse stays", async () => {
    const hold = "      - invoke: invoices.hold\n        input:\n          id: '=record.id'\n";
    const f = await world({ descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS });
    await f.writeAutomations(markPaid(hold + settle));
    await f.executor.open();
    // Only Settle has no reverse, so only Settle is named before a press.
    expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], owner(f)))
      .toEqual([{ kind: "ready", automationId: BUTTON_AUTOMATION, irreversible: [{ name: "invoices.settle", label: "Settle" }] }]);
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    const pressed = await press(f, { recordId: invoice, pressId: pressId(23), confirmed: ["invoices.settle"] });
    if (pressed.busy) throw new Error("The press ran.");
    await f.until(() => f.settled.length === 1);
    expect((await f.record(invoice))?.values[STATUS]).toBe(`Settled by ${BUTTON_AUTOMATION}: pressed`);
    // Settle ran last and cannot go back, so Hold's reverse finds the invoice not on hold and refuses.
    await expect(f.executor.undo({ automationId: BUTTON_AUTOMATION, claimId: pressed.claimId }, async () => undefined))
      .rejects.toThrow("Hold was not undone. Release refused: This invoice is no longer on hold.");
    await f.executor.dispose();
  });

  it("puts a held invoice back through Release, and a second Undo sends nothing", async () => {
    const f = await world({ descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS });
    await f.writeAutomations(markPaid("      - invoke: invoices.hold\n        input:\n          id: '=record.id'\n"));
    await f.executor.open();
    expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], owner(f)))
      .toEqual([{ kind: "ready", automationId: BUTTON_AUTOMATION }]);
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    const pressed = await press(f, { recordId: invoice, pressId: pressId(24) });
    if (pressed.busy) throw new Error("The press ran.");
    await f.until(() => f.settled.length === 1);
    expect((await f.record(invoice))?.values[STATUS]).toBe("On hold");
    expect(await f.executor.undo({ automationId: BUTTON_AUTOMATION, claimId: pressed.claimId }, async () => undefined))
      .toEqual({ status: "undone", reverted: 0, removed: 0, kept: 0, changedSince: 0, missing: 0, irreversible: 0, actions: 0, actionsReversed: 1 });
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    const releases = () => f.host.history({ datasetId: definition.datasetId }).entries.filter((entry) => entry.operation === "invoices.release").length;
    expect(releases()).toBe(1);
    expect(await f.executor.undo({ automationId: BUTTON_AUTOMATION, claimId: pressed.claimId }, async () => undefined))
      .toEqual({ status: "refused", reason: "You already undid this run." });
    expect(releases()).toBe(1);
    await f.executor.dispose();
  });

  it("runs a button's action once when dohc stops after the action committed and before the run recorded it", async () => {
    let started: () => void = () => undefined, release: () => void = () => undefined;
    const committed = new Promise<void>((resolve) => { started = resolve; });
    const f = await world({ descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS, afterInvoke: async () => {
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      throw new Error("The workspace closed.");
    } });
    await f.writeAutomations(markPaid(settle));
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    const pressed = await press(f, { recordId: invoice, pressId: pressId(22), confirmed: ["invoices.settle"] });
    if (pressed.busy) throw new Error("The press ran.");
    await committed;
    const disposed = f.executor.dispose();
    release();
    await disposed;
    expect(f.host.automations.claims(BUTTON_AUTOMATION)).toMatchObject([{ state: "pending" }]);
    // The next executor sends the saved request under the same key: the host answers from its receipt.
    f.makeExecutor();
    await f.executor.open();
    await f.until(() => f.host.automations.claims(BUTTON_AUTOMATION)[0]?.state === "done");
    const settles = f.host.history({ datasetId: definition.datasetId }).entries.filter((entry) => entry.operation === "invoices.settle");
    expect(settles).toHaveLength(1);
    expect((await f.record(invoice))?.values[STATUS]).toBe(`Settled by ${BUTTON_AUTOMATION}: pressed`);
    await f.executor.dispose();
  });

  it("stops an action only you can use while someone else can edit the automation, and refuses a press by someone the action is not granted to", async () => {
    const ana = { grantId: "g-ana", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", files: { paths: ["Budget"], versionId: null, access: "edit" as const }, channel: null };
    const f = await world({ descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS, roster: { kind: "owner", ownerUserId: "user-owner", grants: [ana] } });
    await f.writeAutomations(markPaid(settle));
    await f.executor.open();
    const reason = "Only you can use invoices.settle in Budget, and ana@dohc.test can also edit these automations.";
    expect(await f.executor.automationsIn("Budget")).toMatchObject({ automations: [{ reach: { kind: "checked", steps: expect.arrayContaining([{ verdict: "stopped", reason }]) } }] });
    const { id: invoice } = await f.create({});
    const described = owner(f);
    const withoutAction = { ...described, operations: described.operations.filter((operation) => operation.operationId !== SETTLE) };
    await expect(press(f, { recordId: invoice, pressId: pressId(21) }, withoutAction)).rejects.toThrow("Only people who can edit Invoices can use this button.");
    expect(f.host.automations.claims(BUTTON_AUTOMATION)).toEqual([]);
    await f.executor.dispose();
  });

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
    const pressed = await f.executor.pressDataset({ datasetId: definition.datasetId, table: "Invoices", field: "Mark paid", recordId: JSON.stringify(invoice), pressId: pressId(1), pressedBy: PRESSER, confirmed: [] },
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
    await expect(f.executor.pressDataset({ datasetId: definition.datasetId, table: "Invoices", field: "Mark paid", recordId: "not json", pressId: pressId(3), pressedBy: PRESSER, confirmed: [] },
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

/** An engine claim of a dataset automation, as a schedule makes one for its due time. */
function engineClaim(claimId: string, state: AutomationClaim["state"], createdAtMs: number, automationId = AUTOMATION): AutomationClaim {
  return {
    claimId, automationId, trigger: { key: `schedule:${createdAtMs}` }, recordId: null,
    collectionPath: automationId.slice("collection:".length, automationId.lastIndexOf("#")), depth: 0,
    state, attempts: state === "pending" ? 0 : 1, run: 1, createdAtMs, updatedAtMs: createdAtMs, ...(state === "failed" ? { error: "Not yet." } : {}),
    change: { kind: "schedule", authorOriginId: null, actorKind: null, onBehalfOf: null, fields: [], fieldsOmitted: 0 },
  };
}

describe("dataset automation claims in both ledgers", () => {

  it("lists both ledgers' runs as one history after a trigger edit, and reaches an engine claim for Undo and Try again", async () => {
    const f = await world();
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    const ledgerClaim = f.claims()[0]!;
    // The automation then ran on a schedule, and its run changed the same record.
    const store = createAutomationRunStore(f.root, resolveWorkspaceMetadataDir);
    const [ledgerRun] = (await store.runsOf(AUTOMATION, ledgerClaim.claimId)).runs;
    await store.save({ ...ledgerRun!, claimId: "atc_schedule" });
    f.engineClaims.push(engineClaim("atc_schedule", "done", ledgerClaim.createdAtMs + 1), engineClaim("atc_failed", "failed", ledgerClaim.createdAtMs - 1));
    expect((await f.executor.runs(AUTOMATION)).map((run) => run.claimId)).toEqual(["atc_schedule", ledgerClaim.claimId, "atc_failed"]);
    const trash = async () => { throw new Error("A dataset's added records stay."); };
    expect(await f.executor.undo({ automationId: AUTOMATION, claimId: "atc_schedule" }, trash)).toMatchObject({ status: "undone", reverted: 1 });
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    expect(await f.executor.retry({ automationId: AUTOMATION, claimId: "atc_failed", startOver: false })).toEqual({ status: "queued", press: false });
    expect(f.engineRetries).toEqual(["atc_failed"]);
    await f.executor.dispose();
  });

  it("refuses to undo a run made before the Collection kept its records in a dataset, and marks nothing undone", async () => {
    const f = await world();
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    const store = createAutomationRunStore(f.root, resolveWorkspaceMetadataDir);
    const [ledgerRun] = (await store.runsOf(AUTOMATION, f.claims()[0]!.claimId)).runs;
    // An engine run from when Budget kept its records in documents.
    await store.save({ ...ledgerRun!, claimId: "atc_document", datasetId: null, applied: [{ ordinal: 0, writes: [
      { kind: "field", recordId: "rec_one", path: "Budget/one.md", field: "Status", before: "Open", after: "Closed" },
    ] }] });
    f.engineClaims.push(engineClaim("atc_document", "done", 1));
    const trash = async () => { throw new Error("Nothing moves to the trash."); };
    expect(await f.executor.undo({ automationId: AUTOMATION, claimId: "atc_document" }, trash)).toEqual({
      status: "refused", reason: "This run ran before this Collection changed how it keeps its records, so dohc cannot undo it.",
    });
    expect((await store.runsOf(AUTOMATION, "atc_document")).runs.map((run) => run.undo)).toEqual([null]);
    await f.executor.dispose();
  });

  it("lists the newest 100 runs of both ledgers, and still reads an older run and undoes it", async () => {
    const f = await world();
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    const ledgerClaim = f.claims()[0]!;
    // The automation then ran 100 times on a schedule, after its record change.
    for (let index = 0; index < 100; index += 1) f.engineClaims.push(engineClaim(`atc_later_${index}`, "done", ledgerClaim.createdAtMs + 1 + index));
    const listed = await f.executor.runs(AUTOMATION, 500);
    expect(listed).toHaveLength(100);
    expect(listed.some((run) => run.claimId === ledgerClaim.claimId)).toBe(false);
    expect(await f.executor.run(AUTOMATION, ledgerClaim.claimId)).toMatchObject({ claimId: ledgerClaim.claimId, state: "done" });
    const summary = await f.executor.automationsIn("Budget");
    if (summary.status !== "read" || !summary.automations[0]?.valid) throw new Error("The automation should read.");
    const trash = async () => { throw new Error("A dataset's added records stay."); };
    await expect(f.executor.undoRunsOf([{ automationId: AUTOMATION, definitionHash: definitionHash(summary.automations[0].automation) }], trash))
      .resolves.toEqual({ undone: 1, left: 0 });
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    await f.executor.dispose();
  });

  it("keeps each ledger's offered failure resumable when it prunes, and prunes nothing while a ledger cannot be read", async () => {
    let fail = false;
    const base = sharedEvaluator.forWorkspace("workspace");
    const evaluator: AutomationFormulaEvaluator = {
      evaluate: async (automationId, scope, formulas) => fail
        ? formulas.map(() => ({ ok: false as const, error: { code: "runtime" as const, message: "Not yet." } }))
        : await base.evaluate(automationId, scope, formulas),
    };
    const f = await world({ evaluator });
    await f.writeAutomations(`  - id: close-paid
    name: Close paid invoices
    when:
      field-changed: Paid
    if: record.Status != "Never"
    do:
      - set:
          Status: Closed
        operation: invoices.status
`);
    await f.executor.open();
    const paid = async () => {
      const { id: invoice } = await f.create({});
      const before = f.claims().length;
      await f.edit(invoice, { [PAID]: true });
      await f.until(() => f.claims().length > before && f.claims()[0]!.state !== "pending" && f.claims()[0]!.state !== "running");
      await f.executor.idle();
    };
    await paid();
    const store = createAutomationRunStore(f.root, resolveWorkspaceMetadataDir);
    const [template] = (await store.runsOf(AUTOMATION, f.claims()[0]!.claimId)).runs;
    fail = true;
    await paid();
    const ledgerFailure = f.claims()[0]!.claimId;
    const failed = { outcome: { state: "failed" as const, error: "Not yet.", run: 1 }, settled: false };
    // The ledger's failure, and two older engine failures, one its notice offers, behind 40 newer engine runs.
    await store.save({ ...template!, claimId: ledgerFailure, ...failed });
    for (const [claimId, at] of [["atc_offered", 2], ["atc_old", 1]] as const) {
      await store.save({ ...template!, claimId, ...failed });
      f.engineClaims.push(engineClaim(claimId, "failed", at));
    }
    f.engineFailures.push({ automationId: AUTOMATION, claimId: "atc_offered", chainStopped: false, error: "Not yet.", updatedAtMs: 2, generation: 1 });
    for (let index = 0; index < 40; index += 1) {
      await store.save({ ...template!, claimId: `atc_done_${index}`, settled: true });
      f.engineClaims.push(engineClaim(`atc_done_${index}`, "done", Date.now() + 1_000 + index));
    }
    const compacted = async (claimId: string) => (await store.runsOf(AUTOMATION, claimId)).runs[0]?.compacted ?? false;

    fail = false;
    f.setEngineReadable(false);
    await paid();
    expect(f.errors.map((error) => error.context)).toContain(`prune runs of "${AUTOMATION}"`);
    expect(await Promise.all([ledgerFailure, "atc_offered", "atc_old"].map(compacted))).toEqual([false, false, false]);
    expect((await store.runsOf(AUTOMATION, "atc_done_0")).runs).toHaveLength(1);

    f.setEngineReadable(true);
    await paid();
    expect(await Promise.all([ledgerFailure, "atc_offered", "atc_old"].map(compacted))).toEqual([false, false, true]);
    expect((await store.runsOf(AUTOMATION, "atc_done_0")).runs).toEqual([]);
    await f.executor.dispose();
  }, 60_000);
});

describe("schedules on a dataset Collection", () => {
  const SWEEP = "collection:Budget#sweep";
  const sweep = (steps: string) => `  - id: sweep
    name: Sweep paid invoices
    when: {schedule: day, timezone: UTC}
    do:
${steps}`;
  const closeFound = `      - find: record.Paid == true && record.Status == "Open"
        as: paid
        operation: invoices.list
      - set:
          Status: Closed
        records: paid
        operation: invoices.status
`;
  // A record change on the same dataset, which the schedule's write starts.
  const noteClosed = `  - id: note-closed
    name: Note closed invoices
    when:
      field-changed: Status
    if: record.Status == "Closed"
    do:
      - set:
          Notes: closed
        operation: invoices.edit
`;
  const due = Date.UTC(2026, 8, 27, 0, 0);
  const runDue = async (f: Awaited<ReturnType<typeof world>>, claimId = "atc_due") => {
    f.engineClaims.push(engineClaim(claimId, "pending", due, SWEEP));
    f.executor.notifyClaimed();
    await f.until(() => ["done", "failed"].includes(f.engineClaims.find((claim) => claim.claimId === claimId)!.state));
    await f.executor.idle();
    return f.engineClaims.find((claim) => claim.claimId === claimId)!;
  };

  it("runs a due time: finds, changes found records, adds one, and notifies, one step deeper in the chain", async () => {
    const f = await world();
    await f.writeAutomations(sweep(`${closeFound}      - add-record:
          Notes: '="Swept " + paid.length'
          Status: Logged
        operation: invoices.create
      - notify: '{paid.length} invoices closed'
        to: [user-owner]
`) + noteClosed);
    await f.executor.open();
    const { id: paid } = await f.create({ [PAID]: true });
    const { id: unpaid } = await f.create({});
    expect(await runDue(f)).toMatchObject({ state: "done" });
    expect((await f.record(paid))?.values).toMatchObject({ [STATUS]: "Closed" });
    expect((await f.record(unpaid))?.values[STATUS]).toBe("Open");
    expect((await f.records()).filter((row) => row.values[STATUS] === "Logged").map((row) => row.values[NOTES])).toEqual(["Swept 1"]);
    expect(f.notices).toEqual([expect.objectContaining({ recipientUserId: "user-owner", body: "1 invoices closed" })]);
    // The schedule's edit declares depth 1, so the record change it starts claims at depth 1 and runs.
    expect(f.host.history({ datasetId: definition.datasetId }).entries.find((entry) => entry.automation?.automationId === SWEEP))
      .toMatchObject({ automation: { depth: 1 } });
    await f.until(() => f.host.automations.claims("collection:Budget#note-closed")[0]?.state === "done");
    expect(f.host.automations.claims("collection:Budget#note-closed")).toMatchObject([{ depth: 1 }]);
    expect((await f.record(paid))?.values[NOTES]).toBe("closed");
    await f.executor.dispose();
  });

  it("runs a schedule that only notifies a person a formula names", async () => {
    const f = await world();
    await f.writeAutomations(sweep(`      - notify: Check the invoices
        to: ['="user-owner"']
`));
    await f.executor.open();
    expect(await runDue(f)).toMatchObject({ state: "done" });
    expect(f.notices).toEqual([expect.objectContaining({ recipientUserId: "user-owner", body: "Check the invoices" })]);
    await f.executor.dispose();
  });

  it("reports a failed run to the owner, tries it again from its saved plan, and undoes its reversible edit", async () => {
    const f = await world();
    await f.writeAutomations(sweep(closeFound.replace("invoices.status", "invoices.edit")));
    await f.executor.open();
    const { id: paid } = await f.create({ [PAID]: true });
    // The rules stop resolving after the plan is saved, so the edit fails.
    f.dropRules();
    const failed = await runDue(f);
    expect(failed).toMatchObject({ state: "failed" });
    expect((await f.record(paid))?.values[STATUS]).toBe("Open");
    // The engine lists the failure as any other, and its notice names the automation.
    f.engineFailures.push({ automationId: SWEEP, claimId: "atc_due", chainStopped: false, error: failed.error!, updatedAtMs: failed.updatedAtMs, generation: 1 });
    f.executor.failuresChanged();
    await f.until(() => f.failureReports.some((report) => report.failure.claimId === "atc_due"));
    expect(f.failureReports.find((report) => report.failure.claimId === "atc_due")).toMatchObject({
      name: "Sweep paid invoices", startedBy: null, failure: { automationId: SWEEP, datasetInstance: null },
    });
    f.engineFailures.length = 0;
    f.keepRules();
    expect(await f.executor.retry({ automationId: SWEEP, claimId: "atc_due", startOver: false })).toEqual({ status: "queued", press: false });
    await f.until(() => f.engineClaims[0]!.state === "done");
    expect((await f.record(paid))?.values[STATUS]).toBe("Closed");
    const trash = async () => { throw new Error("A dataset's added records stay."); };
    expect(await f.executor.undo({ automationId: SWEEP, claimId: "atc_due" }, trash)).toMatchObject({ status: "undone", reverted: 1 });
    expect((await f.record(paid))?.values[STATUS]).toBe("Open");
    await f.executor.dispose();
  });

  it("lists a schedule written while dohc was closed when the workspace opens, from its open", async () => {
    const f = await world({ hostOpen: false });
    await f.writeAutomations(sweep(closeFound));
    await f.executor.open();
    expect(f.executor.schedules()).toEqual([expect.objectContaining({ automationId: SWEEP, enabledSince: null })]);
    await f.executor.dispose();
  });

  it("keeps a due time waiting while the dataset store cannot open, and runs it once the store opens", async () => {
    const f = await world({ hostOpen: false, storeFails: true });
    await f.writeAutomations(sweep(closeFound));
    await f.executor.open();
    expect(f.executor.schedules()).toEqual([]);
    const { id: paid } = await f.create({ [PAID]: true });
    f.engineClaims.push(engineClaim("atc_due", "pending", due, SWEEP));
    f.executor.notifyClaimed();
    await f.until(() => f.errors.filter((error) => error.context === "open this workspace's dataset store").length >= 2);
    await f.executor.idle();
    expect(f.engineClaims[0]).toMatchObject({ state: "pending", attempts: 0 });
    f.fixStore();
    f.openHost();
    await f.until(() => f.engineClaims[0]!.state === "done");
    expect((await f.record(paid))?.values[STATUS]).toBe("Closed");
    await f.executor.dispose();
  });

  it("keeps a due time waiting, without draining again, while the store opens and still holds no such dataset", async () => {
    const f = await world();
    await mkdir(join(f.root, "Elsewhere"));
    await writeFile(join(f.root, "Elsewhere", "dataset.json"), JSON.stringify({ datasetId: id(98) }));
    await writeFile(join(f.root, "Elsewhere", "automations.yaml"), `version: 1\nautomations:\n${sweep(closeFound)}`);
    await f.executor.open();
    f.engineClaims.push(engineClaim("atc_elsewhere", "pending", due, "collection:Elsewhere#sweep"));
    f.executor.notifyClaimed();
    await f.until(() => f.engineClaims[0]!.attempts === 0 && f.opened.filter((open) => open).length >= 2);
    // The index it asked for has run, and nothing wakes the claim again.
    const settle = async () => {
      await f.executor.automationsIn("Budget");
      await f.executor.idle();
    };
    await settle();
    const served = f.served();
    await settle();
    await settle();
    expect(f.served()).toBe(served);
    expect(f.engineClaims[0]).toMatchObject({ state: "pending", attempts: 0 });
    await f.executor.dispose();
  });

  it("runs a waiting due time once its folder's descriptor is fixed, and settles one whose descriptor is removed", async () => {
    const f = await world();
    await f.writeAutomations(sweep(closeFound));
    const descriptor = join(f.root, "Budget", "dataset.json");
    const fixed = await readFile(descriptor, "utf8");
    await writeFile(descriptor, JSON.stringify({ ...JSON.parse(fixed), datasetId: id(98) }));
    await mkdir(join(f.root, "Elsewhere"));
    await writeFile(join(f.root, "Elsewhere", "dataset.json"), JSON.stringify({ datasetId: id(97) }));
    await writeFile(join(f.root, "Elsewhere", "automations.yaml"), `version: 1\nautomations:\n${sweep(closeFound)}`);
    await f.executor.open();
    const { id: paid } = await f.create({ [PAID]: true });
    f.engineClaims.push(engineClaim("atc_budget", "pending", due, SWEEP), engineClaim("atc_elsewhere", "pending", due + 1, "collection:Elsewhere#sweep"));
    f.executor.notifyClaimed();
    await f.until(() => f.engineClaims.every((claim) => claim.state === "pending" && claim.attempts === 0) && f.served() >= 2);
    await f.executor.idle();
    await writeFile(descriptor, fixed);
    await rm(join(f.root, "Elsewhere", "dataset.json"));
    f.executor.handleWatcherEvents([{ operation: "update", path: "Budget/dataset.json" }, { operation: "delete", path: "Elsewhere/dataset.json" }]);
    await f.until(() => f.engineClaims.every((claim) => claim.state === "done"));
    expect((await f.record(paid))?.values[STATUS]).toBe("Closed");
    await f.executor.dispose();
  });

  it("says a schedule runs on another computer when this one keeps the records, and runs it here once this one is the host", async () => {
    const elsewhere = await world();
    await elsewhere.writeAutomations(sweep(closeFound));
    await elsewhere.executor.open();
    expect(await elsewhere.executor.automationsIn("Budget")).toMatchObject({ automations: [{ cannotRun: expect.stringMatching(/^Schedules run on another computer/) }] });
    await elsewhere.executor.dispose();
    const here = await world({ groups: true });
    await here.writeAutomations(sweep(closeFound));
    await here.executor.open();
    expect(await here.executor.automationsIn("Budget")).toMatchObject({ automations: [{ cannotRun: null }] });
    await here.executor.dispose();
  });

  it("refuses Run now on a computer that does not keep the dataset's records", async () => {
    const f = await world();
    await mkdir(join(f.root, "Elsewhere"));
    await writeFile(join(f.root, "Elsewhere", "dataset.json"), JSON.stringify({ datasetId: id(98) }));
    await f.executor.open();
    expect(await f.executor.runNowRefusal("collection:Elsewhere#sweep"))
      .toBe("This computer does not keep Elsewhere's records. Run it from the computer that keeps them.");
    expect(await f.executor.runNowRefusal(SWEEP)).toBeNull();
    expect(await f.executor.runNowRefusal("collection:Tasks#stamp")).toBeNull();
    await f.executor.dispose();
  });
});
