import { describe, expect, it } from "vitest";
import type { JsonValue } from "@dohc/app-backend-runtime";
import type { DatasetAutomationClaim, DatasetChangeClaimFact } from "@dohc/app-backend-runtime/dataset-automation-claims";
import type { DatasetInvocationResult } from "@dohc/app-backend-runtime/supervisor";
import type { DatasetDefinition, DatasetRevision } from "@dohc/security-contract/dataset";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import type { LocalDatasetAutomationContext, LocalDatasetInvocation } from "../workspaces/localDatasetHost";
import { createTestScratch } from "../workspaces/testTemp";
import { datasetPrincipalKey } from "@dohc/security-contract/dataset-artifacts";
import { definitionHash } from "./automationPlan";
import { createAutomationRunStore } from "./automationRunStore";
import { datasetEffectKey } from "./datasetAutomationPlan";
import { ACCESS_NARROWED_ERROR, RULES_CHANGED_ERROR, runDatasetAutomation, type DatasetRunHost } from "./datasetAutomationRun";

// A dataset run against a scripted host: what it sends, under which key,
// and what it does when the approved rules change under a saved plan.

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const TABLE = id(2), STATUS = id(4), LIST = id(10), EDIT = id(11);
const definition: DatasetDefinition = {
  formatVersion: 1, datasetId: id(1), name: "Budget", schemaPath: "Budget/schema.sql", operationsPath: "Budget/operations.js",
  tables: [{ tableId: TABLE, name: "Invoices", sqlName: "invoices", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: STATUS, name: "Status", sqlColumn: "status", type: "text", required: true, unique: false },
  ] }],
  operations: [
    { operationId: LIST, name: "invoices.list", label: "View", tableId: TABLE, kind: "read", access: "owner", readOnly: true, fieldIds: [STATUS] },
    { operationId: EDIT, name: "invoices.edit", label: "Edit", tableId: TABLE, kind: "edit", access: "owner", readOnly: false, fieldIds: [STATUS], reversible: true },
  ],
};
const revision = { datasetId: definition.datasetId, revision: 3, revisionSha256: "r".repeat(64), definitionSha256: "", schemaSha256: "", operationsSha256: "", definition } satisfies DatasetRevision;
const parsed = parseAutomationsFile(`version: 1
automations:
  - id: close
    name: Close
    when: record-added
    do:
      - set:
          Status: Closed
        operation: invoices.edit
`);
if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw new Error("fixture");
const automation = parsed.entries[0].automation;
const added: DatasetChangeClaimFact = { kind: "added", datasetId: definition.datasetId, tableId: TABLE, recordId: "a", version: 1, fields: [{ fieldId: STATUS, previous: null, next: "Open" }] };
const claim: DatasetAutomationClaim = {
  claimId: "claim-1", workspaceId: "workspace", datasetId: definition.datasetId, automationId: "collection:Budget#close", hostEpoch: "epoch", revision: 7,
  fact: added,
  actor: { kind: "owner" }, depth: 0, state: "running", attempts: 1, run: 1, error: null, createdAtMs: 1_000, updatedAtMs: 1_000,
};

function host(script: { resolves: () => boolean; edit: (input: LocalDatasetInvocation) => Promise<JsonValue> }) {
  const sent: LocalDatasetInvocation[] = [];
  const surface: DatasetRunHost = {
    context: (input) => Object.freeze({ ...input }) satisfies LocalDatasetAutomationContext,
    revision: () => revision,
    generated: () => true,
    dataGrants: () => ({ workspaceId: "workspace", grants: [] }),
    resolves: script.resolves,
    invoke: async (_context, input) => {
      sent.push(input);
      if (input.operationId === LIST) return { result: { rows: [{ id: "a", version: 1, values: { [STATUS]: "Open" } }], nextCursor: null }, revision: 7, replayed: false };
      return { result: await script.edit(input), revision: 8, replayed: false };
    },
  };
  return { surface, sent };
}

describe("a dataset automation run", () => {
  it("resends a stopped effect under the same key with the same content, and fails once the saved rules no longer resolve", async () => {
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-run-"));
    const input = (stopped: AbortSignal) => ({
      claim, automation, collection: { path: "Budget", name: "Budget" }, roster: { kind: "owner" as const, ownerUserId: null, grants: [] },
      signal: new AbortController().signal, stopped,
    });
    const dependencies = (surface: DatasetRunHost) => ({
      withHost: async <T>(work: (value: DatasetRunHost) => T | Promise<T>) => await work(surface),
      evaluator: { evaluate: async () => "busy" as const }, store, nowMs: () => 2_000, personName: (userId: string) => userId,
    });

    // The first attempt stops while its edit is in flight: the plan is saved, the effect is not.
    const stop = new AbortController();
    const first = host({ resolves: () => true, edit: async () => { stop.abort(); throw new Error("The host closed."); } });
    expect(await runDatasetAutomation(dependencies(first.surface), input(stop.signal))).toEqual({ kind: "wait", reason: "stopped" });
    const edit = first.sent.find((sent) => sent.operationId === EDIT)!;
    expect(edit).toMatchObject({
      datasetId: definition.datasetId, revision: 3, revisionSha256: revision.revisionSha256,
      input: { id: "a", expectedVersion: 1, values: { [STATUS]: "Closed" } },
      idempotencyKey: datasetEffectKey("claim-1", `${definitionHash(automation)}-1`, 0, "a", 0),
    });

    // A resume sends that key again with the same content, without reading again.
    const second = host({ resolves: () => true, edit: async () => ({ id: "a", version: 2, priorValues: { [STATUS]: "Open" } }) });
    const resumed = new AbortController();
    const resumedRun = runDatasetAutomation(dependencies(second.surface), input(resumed.signal));
    expect(await resumedRun).toEqual({ kind: "done" });
    expect(second.sent).toEqual([{ ...edit, signal: expect.any(AbortSignal) }]);

    // A new claim run under the same plan finds rules that no longer resolve.
    const third = host({ resolves: () => false, edit: async () => { throw new Error("unreachable"); } });
    const later = { ...claim, claimId: "claim-2" };
    const stopAgain = new AbortController();
    const again = host({ resolves: () => true, edit: async () => { stopAgain.abort(); throw new Error("The host closed."); } });
    expect(await runDatasetAutomation(dependencies(again.surface), { ...input(stopAgain.signal), claim: later })).toEqual({ kind: "wait", reason: "stopped" });
    expect(await runDatasetAutomation(dependencies(third.surface), { ...input(new AbortController().signal), claim: later }))
      .toEqual({ kind: "failed", error: RULES_CHANGED_ERROR, timedOut: false });
    expect(third.sent).toEqual([]);
  });
});

describe("the rules a dataset run uses", () => {
  it("plans under the rules reach checked, not a newer approval that lands between them", async () => {
    // The newer rules add a read that shows the record's id, which the plan would prefer for the trigger record.
    const WIDE = id(12);
    const newer = { ...revision, revision: 4, revisionSha256: "s".repeat(64), definition: { ...definition, operations: [...definition.operations,
      { operationId: WIDE, name: "invoices.byId", label: "By id", tableId: TABLE, kind: "read" as const, access: "owner" as const, readOnly: true, fieldIds: [id(3), STATUS] }] } };
    const script = host({ resolves: () => true, edit: async () => ({ id: "a", version: 2, priorValues: { [STATUS]: "Open" } }) });
    let reads = 0;
    const surface: DatasetRunHost = { ...script.surface, revision: () => (reads++ === 0 ? revision : newer) };
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-run-"));
    expect(await runDatasetAutomation({ withHost: async (work) => await work(surface), evaluator: { evaluate: async () => "busy" }, store, nowMs: () => 1, personName: (userId: string) => userId }, {
      claim, automation, collection: { path: "Budget", name: "Budget" }, roster: { kind: "owner", ownerUserId: null, grants: [] },
      signal: new AbortController().signal, stopped: new AbortController().signal,
    })).toEqual({ kind: "done" });
    expect(script.sent.map((sent) => [sent.operationId, sent.revision])).toEqual([[LIST, 3], [EDIT, 3]]);
  });
});

describe("a dataset Find over its limit", () => {
  it("refuses the run before any write, as a Collection Find does", async () => {
    const read = parseAutomationsFile(`version: 1
automations:
  - id: close-all
    name: Close all
    when: record-added
    do:
      - find: "true"
        as: open
        operation: invoices.list
      - set:
          Status: Closed
        records: open
        operation: invoices.edit
`);
    if (read.status !== "read" || read.entries[0]?.status !== "valid") throw new Error(JSON.stringify(read));
    const sent: LocalDatasetInvocation[] = [];
    const surface: DatasetRunHost = {
      ...host({ resolves: () => true, edit: async () => { throw new Error("A refused run writes nothing."); } }).surface,
      invoke: async (_context, input): Promise<DatasetInvocationResult> => {
        sent.push(input);
        const { limit } = input.input as { limit: number };
        // The trigger read asks for one record; the Find asks for a page and there is more.
        if (limit === 1) return { result: { rows: [{ id: "a", version: 1, values: { [STATUS]: "Open" } }], nextCursor: null }, revision: 7, replayed: false };
        const rows = Array.from({ length: limit }, (_, index) => ({ id: `r${index}`, version: 1, values: { [STATUS]: "Open" } }));
        return { result: { rows, nextCursor: { id: "r49", value: "r49" } }, revision: 7, replayed: false };
      },
    };
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-run-"));
    expect(await runDatasetAutomation({
      withHost: async (work) => await work(surface),
      evaluator: { evaluate: async (_automationId, _scope, formulas) => formulas.map(() => ({ ok: true as const, value: true })) },
      store, nowMs: () => 1, personName: (userId: string) => userId,
    }, {
      claim, automation: read.entries[0].automation, collection: { path: "Budget", name: "Budget" },
      roster: { kind: "owner", ownerUserId: null, grants: [] }, signal: new AbortController().signal, stopped: new AbortController().signal,
    })).toEqual({ kind: "failed", error: "A Find matched more than 50 records. Narrow its condition, then try again.", timedOut: false });
    expect(sent.map((input) => input.operationId)).toEqual([LIST, LIST]);
    expect((await store.runsOf(claim.automationId, claim.claimId)).runs).toEqual([]);
  });
});

describe("a dataset run over two tables", () => {
  it("keeps each record's version and values apart when two tables share an id", async () => {
    const A = id(20), B = id(21), A_STATUS = id(22), B_STATUS = id(23);
    const table = (tableId: string, name: string, status: string) => ({ tableId, name, sqlName: name.toLowerCase(), primaryKey: "id", fields: [
      { fieldId: `${tableId.slice(0, -2)}99`, name: "ID", sqlColumn: "id", type: "text" as const, required: true, unique: true },
      { fieldId: status, name: "Status", sqlColumn: "status", type: "text" as const, required: true, unique: false },
    ] });
    const operation = (number: number, name: string, tableId: string, kind: "read" | "edit", fieldId: string) =>
      ({ operationId: id(number), name, label: name, tableId, kind, access: "owner" as const, readOnly: kind === "read", fieldIds: [fieldId] });
    const two: DatasetDefinition = { ...definition, tables: [table(A, "Orders", A_STATUS), table(B, "Items", B_STATUS)], operations: [
      operation(30, "orders.list", A, "read", A_STATUS), operation(31, "orders.edit", A, "edit", A_STATUS),
      operation(32, "items.list", B, "read", B_STATUS), operation(33, "items.edit", B, "edit", B_STATUS),
    ] };
    const read = parseAutomationsFile(`version: 1
automations:
  - id: ship
    name: Ship
    when:
      record-added: null
      table: Orders
    do:
      - find: "true"
        as: items
        operation: items.list
      - set:
          Status: Shipped
        operation: orders.edit
      - set:
          Status: Packed
        records: items
        operation: items.edit
`);
    if (read.status !== "read" || read.entries[0]?.status !== "valid") throw new Error(JSON.stringify(read));
    const sent: LocalDatasetInvocation[] = [];
    const surface: DatasetRunHost = {
      context: (input) => Object.freeze({ ...input }),
      revision: () => ({ ...revision, definition: two }),
      generated: () => true,
      dataGrants: () => ({ workspaceId: "workspace", grants: [] }),
      resolves: () => true,
      invoke: async (_context, input): Promise<DatasetInvocationResult> => {
        sent.push(input);
        const body = input.input as { expectedVersion: number; id: string };
        if (input.operationId === id(30)) return { result: { rows: [{ id: "1", version: 5, values: { [A_STATUS]: "New" } }], nextCursor: null }, revision: 7, replayed: false };
        if (input.operationId === id(32)) return { result: { rows: [{ id: "1", version: 9, values: { [B_STATUS]: "Waiting" } }], nextCursor: null }, revision: 7, replayed: false };
        const prior = input.operationId === id(31) ? { [A_STATUS]: "New" } : { [B_STATUS]: "Waiting" };
        return { result: { id: body.id, version: body.expectedVersion + 1, priorValues: prior }, revision: 8, replayed: false };
      },
    };
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-run-"));
    const added: DatasetAutomationClaim = { ...claim, automationId: "collection:Budget#ship",
      fact: { kind: "added", datasetId: definition.datasetId, tableId: A, recordId: "1", version: 5, fields: [{ fieldId: A_STATUS, previous: null, next: "New" }] } };
    expect(await runDatasetAutomation({ withHost: async (work) => await work(surface), evaluator: { evaluate: async () => "busy" }, store, nowMs: () => 1, personName: (userId: string) => userId }, {
      claim: added, automation: read.entries[0].automation, collection: { path: "Budget", name: "Budget" },
      roster: { kind: "owner", ownerUserId: null, grants: [] }, signal: new AbortController().signal, stopped: new AbortController().signal,
    })).toEqual({ kind: "done" });
    expect(sent.filter((input) => input.operationId === id(31) || input.operationId === id(33)).map((input) => [input.operationId, input.input])).toEqual([
      [id(31), { id: "1", expectedVersion: 5, values: { [A_STATUS]: "Shipped" } }],
      [id(33), { id: "1", expectedVersion: 9, values: { [B_STATUS]: "Packed" } }],
    ]);
    const [run] = (await store.runsOf("collection:Budget#ship", claim.claimId)).runs;
    expect(run!.applied.map(({ writes }) => writes[0])).toEqual([
      expect.objectContaining({ tableId: A, recordId: "1", version: 6, fields: [expect.objectContaining({ before: "New", after: "Shipped" })] }),
      expect.objectContaining({ tableId: B, recordId: "1", version: 10, fields: [expect.objectContaining({ before: "Waiting", after: "Packed" })] }),
    ]);
  });
});

describe("reach in a dataset run", () => {
  const SECRET = id(40);
  // The read shows Status only; Secret is in no read, but an added record's claim carries it.
  const wide: DatasetDefinition = { ...definition,
    tables: [{ ...definition.tables[0]!, fields: [...definition.tables[0]!.fields, { fieldId: SECRET, name: "Secret", sqlColumn: "secret", type: "text", required: false, unique: false }] }],
    operations: [{ ...definition.operations[0]!, access: "helper" }, { ...definition.operations[1]!, access: "helper" }] };
  const parsedStamp = parseAutomationsFile(`version: 1
automations:
  - id: close
    name: Close
    when: record-added
    do:
      - set:
          Status: '=trigger.fields.join(",")'
        operation: invoices.edit
`);
  if (parsedStamp.status !== "read" || parsedStamp.entries[0]?.status !== "valid") throw new Error("fixture");
  const stamp = parsedStamp.entries[0].automation;
  const ana = { grantId: "g-ana", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", files: { paths: ["Budget"], versionId: null, access: "edit" as const }, channel: null };
  const anaKey = datasetPrincipalKey("workspace", "g-ana", "u-ana");

  async function run(editors: typeof ana[], operationIds: string[]) {
    const scopes: unknown[] = [];
    const surface: DatasetRunHost = {
      context: (input) => Object.freeze({ ...input }),
      revision: () => ({ ...revision, definition: wide }),
      generated: () => true,
      dataGrants: () => ({ workspaceId: "workspace", grants: [{ principalKey: anaKey, operationIds }] }),
      resolves: () => true,
      invoke: async (_context, input): Promise<DatasetInvocationResult> => {
        if (input.operationId === LIST) return { result: { rows: [{ id: "a", version: 1, values: { [STATUS]: "Open" } }], nextCursor: null }, revision: 7, replayed: false };
        return { result: { id: "a", version: 2, priorValues: { [STATUS]: "Open" } }, revision: 8, replayed: false };
      },
    };
    const outcome = await runDatasetAutomation({
      withHost: async (work) => await work(surface),
      evaluator: { evaluate: async (_id, scope) => { scopes.push(scope); return [{ ok: true, value: "x" }]; } },
      store: createAutomationRunStore(await createTestScratch("dohc-dataset-reach-")), nowMs: () => 1, personName: (userId: string) => userId,
    }, {
      claim: { ...claim, fact: { ...added, fields: [{ fieldId: STATUS, previous: null, next: "Open" }, { fieldId: SECRET, previous: null, next: "s3cret" }] } },
      automation: stamp, collection: { path: "Budget", name: "Budget" },
      roster: { kind: "owner", ownerUserId: "u-owner", grants: editors }, signal: new AbortController().signal, stopped: new AbortController().signal,
    });
    return { outcome, scopes };
  }

  it("stops a run that uses an operation another editor holds no grant for", async () => {
    expect((await run([ana], [LIST])).outcome).toEqual({ kind: "failed", error: "ana@dohc.test has no grant to use invoices.edit in Budget.", timedOut: false });
  });

  it("shows formulas only the fields every other editor can read through a granted read", async () => {
    const shared = await run([ana], [LIST, EDIT]);
    expect(shared.outcome).toEqual({ kind: "done" });
    expect(shared.scopes).toEqual([expect.objectContaining({ trigger: expect.objectContaining({ fields: ["Status"] }) })]);
    // Only the owner edits these automations: every field the claim carries.
    const own = await run([], []);
    expect(own.scopes).toEqual([expect.objectContaining({ trigger: expect.objectContaining({ fields: ["Status", "Secret"] }) })]);
  });

  it("stops a resumed plan once an editor can no longer read a field it was planned with, and keeps what landed", async () => {
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-narrowed-"));
    const stop = new AbortController();
    const host = (edit: () => Promise<JsonValue>): DatasetRunHost => ({
      context: (input) => Object.freeze({ ...input }),
      revision: () => ({ ...revision, definition: wide }),
      generated: () => true,
      dataGrants: () => ({ workspaceId: "workspace", grants: [{ principalKey: anaKey, operationIds: [LIST, EDIT] }] }),
      resolves: () => true,
      invoke: async (_context, input): Promise<DatasetInvocationResult> => input.operationId === LIST
        ? { result: { rows: [{ id: "a", version: 1, values: { [STATUS]: "Open" } }], nextCursor: null }, revision: 7, replayed: false }
        : { result: await edit(), revision: 8, replayed: false },
    });
    const input = (editors: typeof ana[], stopped: AbortSignal) => ({
      claim: { ...claim, fact: { ...added, fields: [{ fieldId: STATUS, previous: null, next: "Open" }, { fieldId: SECRET, previous: null, next: "s3cret" }] } },
      automation: stamp, collection: { path: "Budget", name: "Budget" },
      roster: { kind: "owner" as const, ownerUserId: "u-owner", grants: editors }, signal: new AbortController().signal, stopped,
    });
    const dependencies = (surface: DatasetRunHost) => ({ withHost: async <T>(work: (value: DatasetRunHost) => T | Promise<T>) => await work(surface),
      evaluator: { evaluate: async () => [{ ok: true as const, value: "x" }] }, store, nowMs: () => 1, personName: (userId: string) => userId });
    // Planned while only the owner edits: every field was readable. It stops mid-edit.
    const first = host(async () => { stop.abort(); throw new Error("The host closed."); });
    expect(await runDatasetAutomation(dependencies(first), input([], stop.signal))).toEqual({ kind: "wait", reason: "stopped" });
    // Ana now edits the automation and cannot read Secret: the rest stops.
    const second = host(async () => { throw new Error("unreachable"); });
    expect(await runDatasetAutomation(dependencies(second), input([ana], new AbortController().signal)))
      .toEqual({ kind: "failed", error: ACCESS_NARROWED_ERROR, timedOut: false });
  });
});
