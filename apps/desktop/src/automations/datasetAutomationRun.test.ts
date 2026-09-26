import { describe, expect, it } from "vitest";
import type { JsonValue } from "@dohc/app-backend-runtime";
import type { DatasetAutomationClaim, DatasetChangeClaimFact } from "@dohc/app-backend-runtime/dataset-automation-claims";
import type { DatasetInvocationResult } from "@dohc/app-backend-runtime/supervisor";
import type { DatasetDefinition, DatasetRevision } from "@dohc/security-contract/dataset";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import type { AutomationScope } from "@dohc/app-backend-runtime/automation";
import { NoticeNotSentError } from "../notices/noticeStore";
import type { LocalDatasetAutomationContext, LocalDatasetInvocation } from "../workspaces/localDatasetHost";
import { createTestScratch } from "../workspaces/testTemp";
import { datasetPrincipalKey } from "@dohc/security-contract/dataset-artifacts";
import {
  AutomationChatSessionWait,
  automationMessageId,
  automationNoticeId,
  automationThreadId,
  automationWakeThreadId,
  chatDirectoryOf,
  type AutomationChatMessage,
  type AutomationNotice,
  type ChatDirectoryChannel,
} from "./automationChat";
import { definitionDigest, definitionHash, stepKey } from "./automationPlan";
import type { ReachRoster, RosterGrant } from "./automationReach";
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
// A run with no chat step reads no chat and sends nothing.
const sendsNothing = {
  chat: {
    directory: async () => { throw new Error("This automation sends no messages."); },
    write: async () => { throw new Error("This automation sends no messages."); },
  },
  postNotice: async () => { throw new Error("This automation notifies nobody."); },
  recipientVerdicts: async () => { throw new Error("This automation names nobody by formula."); },
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

function automationFrom(text: string) {
  const read = parseAutomationsFile(`version: 1\nautomations:\n${text}`);
  if (read.status !== "read" || read.entries[0]?.status !== "valid") throw new Error(JSON.stringify(read));
  return read.entries[0].automation;
}

const TEAM: ChatDirectoryChannel = { id: "team", name: "Team", slug: "team", kind: "channel", type: "posts", wireId: "team-wire", runningThreadId: null };
const DM_ANA: ChatDirectoryChannel = { id: "dm-ana", name: "ana@dohc.test", slug: "dm-ana", kind: "dm", type: "chat", wireId: "dm-ana", runningThreadId: "thread-dm-ana" };

/** Chat and notices as the executor gives them to a run, recording what the run sends. */
function chatSpy(script: { write?: (message: AutomationChatMessage) => void; notice?: (notice: AutomationNotice) => void } = {}) {
  const messages: AutomationChatMessage[] = [];
  const notices: AutomationNotice[] = [];
  const dependencies = {
    chat: {
      directory: async (roster: Exclude<ReachRoster, { kind: "unknown" }>) => chatDirectoryOf([TEAM, DM_ANA], roster),
      write: async (_signal: AbortSignal, message: AutomationChatMessage) => { messages.push(message); script.write?.(message); },
    },
    postNotice: async (notice: AutomationNotice) => { notices.push(notice); script.notice?.(notice); },
    recipientVerdicts: async (input: { recipients: readonly unknown[] }) => input.recipients.map(() => "allowed" as const),
  };
  return { messages, notices, dependencies };
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
      evaluator: { evaluate: async () => "busy" as const }, store, nowMs: () => 2_000, personName: (userId: string) => userId, ...sendsNothing,
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
    expect(await runDatasetAutomation({ withHost: async (work) => await work(surface), evaluator: { evaluate: async () => "busy" }, store, nowMs: () => 1, personName: (userId: string) => userId, ...sendsNothing }, {
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
      store, nowMs: () => 1, personName: (userId: string) => userId, ...sendsNothing,
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
    expect(await runDatasetAutomation({ withHost: async (work) => await work(surface), evaluator: { evaluate: async () => "busy" }, store, nowMs: () => 1, personName: (userId: string) => userId, ...sendsNothing }, {
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
      store: createAutomationRunStore(await createTestScratch("dohc-dataset-reach-")), nowMs: () => 1, personName: (userId: string) => userId, ...sendsNothing,
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
      evaluator: { evaluate: async () => [{ ok: true as const, value: "x" }] }, store, nowMs: () => 1, personName: (userId: string) => userId, ...sendsNothing });
    // Planned while only the owner edits: every field was readable. It stops mid-edit.
    const first = host(async () => { stop.abort(); throw new Error("The host closed."); });
    expect(await runDatasetAutomation(dependencies(first), input([], stop.signal))).toEqual({ kind: "wait", reason: "stopped" });
    // Ana now edits the automation and cannot read Secret: the rest stops.
    const second = host(async () => { throw new Error("unreachable"); });
    expect(await runDatasetAutomation(dependencies(second), input([ana], new AbortController().signal)))
      .toEqual({ kind: "failed", error: ACCESS_NARROWED_ERROR, timedOut: false });
  });

  it("shows a message's formulas only the fields every other editor can read", async () => {
    const post = automationFrom(`  - id: tell
    name: Tell
    when: record-added
    do:
      - post: 'Added {trigger.fields}'
        group: Team
`);
    const scopes: AutomationScope[] = [];
    const spy = chatSpy();
    const surface: DatasetRunHost = {
      context: (input) => Object.freeze({ ...input }),
      revision: () => ({ ...revision, definition: wide }),
      generated: () => true,
      dataGrants: () => ({ workspaceId: "workspace", grants: [{ principalKey: anaKey, operationIds: [LIST] }] }),
      resolves: () => true,
      invoke: async (): Promise<DatasetInvocationResult> =>
        ({ result: { rows: [{ id: "a", version: 1, values: { [STATUS]: "Open" } }], nextCursor: null }, revision: 7, replayed: false }),
    };
    // Ana edits the automation, may use the list, and can post in Team.
    const inTeam = { grantId: "g-team", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", files: null, channel: { wireId: "team-wire", canPost: true } };
    expect(await runDatasetAutomation({
      withHost: async (work) => await work(surface),
      evaluator: { evaluate: async (_id, scope) => { scopes.push(scope); return [{ ok: true, value: "Added" }]; } },
      store: createAutomationRunStore(await createTestScratch("dohc-dataset-reach-")), nowMs: () => 1, personName: (userId: string) => userId, ...spy.dependencies,
    }, {
      claim: { ...claim, automationId: "collection:Budget#tell", fact: { ...added, fields: [{ fieldId: STATUS, previous: null, next: "Open" }, { fieldId: SECRET, previous: null, next: "s3cret" }] } },
      automation: post, collection: { path: "Budget", name: "Budget" },
      roster: { kind: "owner", ownerUserId: "u-owner", grants: [ana, inTeam] }, signal: new AbortController().signal, stopped: new AbortController().signal,
    })).toEqual({ kind: "done" });
    expect(scopes).toEqual([expect.objectContaining({
      record: { Status: "Open", id: "a" },
      trigger: expect.objectContaining({ fields: ["Status"], record: { Status: "Open", id: "a" } }),
    })]);
    expect(JSON.stringify(scopes)).not.toContain("s3cret");
    expect(spy.messages.map((message) => message.body)).toEqual(["Added"]);
  });
});

describe("chat steps in a dataset run", () => {
  const BUDGET = { path: "Budget", name: "Budget" };
  // Ana is in the direct message and can view Budget, so she can get notices and is no editor.
  const ANA: RosterGrant[] = [
    { grantId: "g-dm", recipientUserId: "user-ana", recipientEmail: "ana@dohc.test", files: null, channel: { wireId: "dm-ana", canPost: true } },
    { grantId: "g-view", recipientUserId: "user-ana", recipientEmail: "ana@dohc.test", files: { paths: ["Budget"], versionId: null, access: "view" }, channel: null },
  ];
  const BOB: RosterGrant = { grantId: "g-bob", recipientUserId: "user-bob", recipientEmail: "bob@dohc.test", files: { paths: ["Budget"], versionId: null, access: "edit" }, channel: null };
  const owner = (grants: RosterGrant[]) => ({ kind: "owner" as const, ownerUserId: "user-owner", grants });
  const tell = automationFrom(`  - id: tell
    name: Tell the team
    when: record-added
    do:
      - set:
          Status: Closed
        operation: invoices.edit
      - post: 'Closed {record.Status}'
        group: Team
      - if: record.Status == "Open"
        do:
          - direct-message: Yours is closed
            to: [user-ana]
          - notify: 'Invoice {record.id} is closed'
            to: [user-ana]
`);
  const told = { ...claim, automationId: "collection:Budget#tell" };
  // Every text reads "Closed", and every condition holds.
  const evaluator = {
    evaluate: async (_id: string, _scope: AutomationScope, formulas: readonly { kind: string }[]) =>
      formulas.map((formula) => ({ ok: true as const, value: formula.kind === "text" ? "Closed" : true })),
  };
  const key = (automation: typeof tell, ordinal: number) => stepKey("claim-1", `${definitionHash(automation)}-1`, ordinal);
  const edits = () => host({ resolves: () => true, edit: async () => ({ id: "a", version: 2, priorValues: { [STATUS]: "Open" } }) });

  it("posts, sends a direct message, and notifies as the automation, one chain step deeper, each keyed by its claim, definition, and step", async () => {
    const script = edits();
    const spy = chatSpy();
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-chat-"));
    expect(await runDatasetAutomation({ withHost: async (work) => await work(script.surface), evaluator, store, nowMs: () => 1, personName: (userId) => userId, ...spy.dependencies }, {
      claim: { ...told, depth: 2 }, automation: tell, collection: BUDGET, roster: owner(ANA), signal: new AbortController().signal, stopped: new AbortController().signal,
    })).toEqual({ kind: "done" });

    const sender = { automationId: "collection:Budget#tell", name: "Tell the team", depth: 3 };
    const post = `${key(tell, 1)}/post`, direct = `${key(tell, 3)}/dm/user-ana`;
    expect(spy.messages).toEqual([
      { target: { kind: "group", channelId: "team", lane: "posts" }, effectId: post, messageId: automationMessageId(post), threadId: automationThreadId(post), automation: sender, body: "Closed" },
      { target: { kind: "direct-message", threadId: "thread-dm-ana" }, effectId: direct, messageId: automationMessageId(direct), threadId: "thread-dm-ana", automation: sender, body: "Closed" },
    ]);
    // A dataset record has no file: the notice names its Collection, and the record by its id.
    expect(spy.notices).toEqual([{
      noticeId: automationNoticeId(key(tell, 4), "user-ana"), kind: "automation-notify", title: "Tell the team", body: "Closed", recipientUserId: "user-ana",
      target: { path: "Budget", record: "a", automation: "collection:Budget#tell", run: "claim-1" },
    }]);
    const [run] = (await store.runsOf("collection:Budget#tell", "claim-1")).runs;
    expect(run!.applied.map(({ ordinal, writes }) => [ordinal, writes.map((write) => write.kind)])).toEqual([
      [0, ["dataset-edit"]], [1, ["message"]], [3, ["message"]], [4, ["notice"]],
    ]);
  });

  it("sends a message that may have landed again under the same ids, and Try again sends only what did not go", async () => {
    const script = edits();
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-chat-"));
    const attempt = async (spy: ReturnType<typeof chatSpy>, run: number, stopped: AbortSignal) => await runDatasetAutomation(
      { withHost: async (work) => await work(script.surface), evaluator, store, nowMs: () => 1, personName: (userId) => userId, ...spy.dependencies },
      { claim: { ...told, run }, automation: tell, collection: BUDGET, roster: owner(ANA), signal: new AbortController().signal, stopped });

    // The post lands, and the run stops before it records it.
    const stop = new AbortController();
    const first = chatSpy({ write: () => { stop.abort(); throw new Error("The engine closed."); } });
    expect(await attempt(first, 1, stop.signal)).toEqual({ kind: "wait", reason: "stopped" });
    // The run resumes: the post goes again under its ids, so the engine replays it. The notice does not reach Ana.
    const second = chatSpy({ notice: () => { throw new NoticeNotSentError("Ana has not accepted your share yet."); } });
    expect(await attempt(second, 1, new AbortController().signal))
      .toEqual({ kind: "failed", error: "dohc could not notify ana@dohc.test. Ana has not accepted your share yet.", timedOut: false });
    expect(second.messages.map((message) => [message.effectId, message.messageId])).toEqual([
      [first.messages[0]!.effectId, first.messages[0]!.messageId],
      [`${key(tell, 3)}/dm/user-ana`, automationMessageId(`${key(tell, 3)}/dm/user-ana`)],
    ]);
    // Try again sends only the notice, under the id it had. The record was edited once.
    const third = chatSpy();
    expect(await attempt(third, 2, new AbortController().signal)).toEqual({ kind: "done" });
    expect(third.messages).toEqual([]);
    expect(third.notices.map((notice) => notice.noticeId)).toEqual(second.notices.map((notice) => notice.noticeId));
    expect(script.sent.filter((sent) => sent.operationId === EDIT)).toHaveLength(1);
  });

  it("waits for a session to post in a synced workspace, then posts under the same id", async () => {
    const script = edits();
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-chat-"));
    const attempt = async (spy: ReturnType<typeof chatSpy>) => await runDatasetAutomation(
      { withHost: async (work) => await work(script.surface), evaluator, store, nowMs: () => 1, personName: (userId) => userId, ...spy.dependencies },
      { claim: told, automation: tell, collection: BUDGET, roster: owner(ANA), signal: new AbortController().signal, stopped: new AbortController().signal });
    const signedOut = chatSpy({ write: () => { throw new AutomationChatSessionWait(); } });
    expect(await attempt(signedOut)).toEqual({ kind: "wait", reason: "session" });
    const signedIn = chatSpy();
    expect(await attempt(signedIn)).toEqual({ kind: "done" });
    expect(signedIn.messages[0]!.effectId).toBe(signedOut.messages[0]!.effectId);
    expect(script.sent.filter((sent) => sent.operationId === EDIT)).toHaveLength(1);
  });

  it("names a record in a notice only by an id a notice can carry", async () => {
    const notify = automationFrom(`  - id: notify
    name: Notify
    when: record-added
    do:
      - notify: Added
        to: [user-ana]
`);
    const surface: DatasetRunHost = { ...edits().surface, invoke: async (): Promise<DatasetInvocationResult> =>
      ({ result: { rows: [{ id: "a ", version: 1, values: { [STATUS]: "Open" } }], nextCursor: null }, revision: 7, replayed: false }) };
    const spy = chatSpy();
    expect(await runDatasetAutomation({
      withHost: async (work) => await work(surface), evaluator, store: createAutomationRunStore(await createTestScratch("dohc-dataset-chat-")),
      nowMs: () => 1, personName: (userId) => userId, ...spy.dependencies,
    }, {
      claim: { ...claim, automationId: "collection:Budget#notify", fact: { ...added, recordId: "a " } }, automation: notify, collection: BUDGET,
      roster: owner(ANA), signal: new AbortController().signal, stopped: new AbortController().signal,
    })).toEqual({ kind: "done" });
    expect(spy.notices.map((notice) => notice.target)).toEqual([{ path: "Budget", automation: "collection:Budget#notify", run: "claim-1" }]);
  });

  it("stops before it reads anything when an editor cannot post in the Group", async () => {
    const script = host({ resolves: () => true, edit: async () => { throw new Error("A stopped run writes nothing."); } });
    const spy = chatSpy();
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-chat-"));
    expect(await runDatasetAutomation({ withHost: async (work) => await work(script.surface), evaluator, store, nowMs: () => 1, personName: (userId) => userId, ...spy.dependencies }, {
      claim: told, automation: tell, collection: BUDGET, roster: owner([...ANA, BOB]), signal: new AbortController().signal, stopped: new AbortController().signal,
    })).toEqual({ kind: "failed", error: "bob@dohc.test cannot post in Team.", timedOut: false });
    expect(script.sent).toEqual([]);
    expect(spy.messages).toEqual([]);
    expect(spy.notices).toEqual([]);
  });

  const ASK = id(50);
  const withButton: DatasetDefinition = { ...definition, tables: [{ ...definition.tables[0]!, fields: [...definition.tables[0]!.fields, { fieldId: ASK, name: "Ask", type: "button" }] }] };
  const ask = automationFrom(`  - id: ask
    name: Ask my agent
    when:
      button: Ask
    do:
      - wake-agent: 'Look at invoice {record.id}'
        person: user-owner
`);
  const pressed: DatasetAutomationClaim = { ...claim, automationId: "collection:Budget#ask", actor: { kind: "owner", userId: "user-owner" },
    fact: { kind: "button", datasetId: definition.datasetId, tableId: TABLE, recordId: "a", fieldId: ASK, definitionHash: definitionDigest(ask) } };

  it("wakes your agent from a press in a Collection only you edit", async () => {
    const script = host({ resolves: () => true, edit: async () => { throw new Error("This automation edits nothing."); } });
    const surface: DatasetRunHost = { ...script.surface, revision: () => ({ ...revision, definition: withButton }) };
    const run = async (grants: RosterGrant[]) => {
      const spy = chatSpy();
      const outcome = await runDatasetAutomation({
        withHost: async (work) => await work(surface), evaluator, store: createAutomationRunStore(await createTestScratch("dohc-dataset-wake-")),
        nowMs: () => 1, personName: (userId) => userId, ...spy.dependencies,
      }, { claim: pressed, automation: ask, collection: BUDGET, roster: owner(grants), signal: new AbortController().signal, stopped: new AbortController().signal });
      return { outcome, messages: spy.messages };
    };

    const wake = `${key(ask, 0)}/wake`;
    expect(await run([])).toEqual({ outcome: { kind: "done" }, messages: [{
      target: { kind: "agent" }, effectId: wake, messageId: automationMessageId(wake), threadId: automationWakeThreadId("collection:Budget#ask"),
      automation: { automationId: "collection:Budget#ask", name: "Ask my agent", depth: 1 }, body: "Closed",
    }] });
    // Once someone else can edit Budget, the step acts as nobody.
    expect(await run([BOB])).toEqual({ outcome: { kind: "failed", error: "This step acts as you, and bob@dohc.test can also edit Budget.", timedOut: false }, messages: [] });
  });

  it("does not resume a saved wake once the automation no longer resolves under the rules", async () => {
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-wake-"));
    let rules = withButton;
    const surface: DatasetRunHost = { ...host({ resolves: () => true, edit: async () => { throw new Error("This automation edits nothing."); } }).surface,
      revision: () => ({ ...revision, definition: rules }) };
    const attempt = async (spy: ReturnType<typeof chatSpy>, grants: RosterGrant[], stopped: AbortSignal) => await runDatasetAutomation(
      { withHost: async (work) => await work(surface), evaluator, store, nowMs: () => 1, personName: (userId) => userId, ...spy.dependencies },
      { claim: pressed, automation: ask, collection: BUDGET, roster: owner(grants), signal: new AbortController().signal, stopped });
    // The plan is saved, and the run stops before the wake is recorded.
    const stop = new AbortController();
    expect(await attempt(chatSpy({ write: () => { stop.abort(); throw new Error("The engine closed."); } }), [], stop.signal))
      .toEqual({ kind: "wait", reason: "stopped" });
    // The approved read goes, so the automation no longer resolves, and Bob can now edit Budget.
    rules = { ...withButton, operations: withButton.operations.filter((operation) => operation.kind !== "read") };
    const resumed = chatSpy();
    expect(await attempt(resumed, [BOB], new AbortController().signal)).toEqual({ kind: "failed", error: RULES_CHANGED_ERROR, timedOut: false });
    expect(resumed.messages).toEqual([]);
  });
});
