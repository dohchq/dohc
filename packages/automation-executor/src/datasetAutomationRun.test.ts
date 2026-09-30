import { afterAll, describe, expect, it } from "vitest";
import { AppBackendRuntimeError, type JsonValue } from "@dohc/app-backend-runtime";
import type { DatasetAutomationClaim, DatasetChangeClaimFact } from "@dohc/app-backend-runtime/dataset-automation-claims";
import type { DatasetInvocationResult } from "@dohc/app-backend-runtime/supervisor";
import type { DatasetDefinition, DatasetRevision } from "@dohc/security-contract/dataset";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import type { AutomationScope } from "@dohc/app-backend-runtime/automation";
import type { AutomationClaim } from "@dohc/workspace-engine-client";
import { createTestScratch, testMetadataDir } from "./testScratch";
import { datasetPrincipalKey } from "@dohc/security-contract/dataset-artifacts";
import {
  AutomationChatSessionWait,
  automationMessageId,
  automationNoticeId,
  automationThreadId,
  automationWakeThreadId,
  chatDirectoryOf,
  NoticeNotSentError,
  type AutomationChatMessage,
  type AutomationNotice,
  type ChatDirectoryChannel,
} from "./automationChat";
import { definitionDigest, definitionHash, stepKey } from "./automationPlan";
import { datasetFieldKey, type ReachRoster, type RosterGrant } from "./automationReach";
import { datasetRunClaim } from "./datasetAutomationPlan";
import { createAutomationFormulaEvaluator } from "./automationEvaluatorHost";
import { createAutomationRunStore } from "./automationRunStore";
import { DEADLINE_ERROR, GROUP_CHANGED_ERROR, RULES_CHANGED_ERROR } from "./collectionAutomationRun";
import { datasetEffectKey } from "./datasetAutomationPlan";
import {
  ACCESS_NARROWED_ERROR,
  type DatasetAutomationRunDependencies,
  type DatasetAutomationRunInput,
  runDatasetAutomation,
  type DatasetAutomationContext,
  type DatasetInvocation,
  type DatasetRunClaim,
  type DatasetRunHost,
} from "./datasetAutomationRun";

// A run checks reach again before each record effect, against the roster
// last read. Unless a test changes it, that is the roster the run began with.
function runWithRoster(
  dependencies: Omit<DatasetAutomationRunDependencies, "cachedRoster" | "targets"> & Partial<Pick<DatasetAutomationRunDependencies, "cachedRoster" | "targets">>,
  input: DatasetAutomationRunInput,
) {
  return runDatasetAutomation({
    cachedRoster: async () => input.roster,
    collectionPathOf: () => input.collection.path,
    targets: { validate: async (target) => target, resolve: async () => (await dependencies.withHost((host) => ({ kind: "dataset" as const,
      collection: input.collection, approved: host.revision(definition.datasetId), generated: host.generated(definition.datasetId),
      grants: host.dataGrants(definition.datasetId) }))) ?? { kind: "problem", code: "host-unavailable", problem: "Unavailable" } },
    ...dependencies,
  }, input);
}

// A dataset run against a scripted host: what it sends, under which key,
// and what it does when the approved rules change under a saved plan.

// These automations have no code steps.
const noCode = async (): Promise<never> => { throw new Error("This automation has no code step."); };

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
  claimId: "claim-1", workspaceId: "workspace", datasetId: definition.datasetId, automationId: `collection:${definition.datasetId}#close`, hostEpoch: "epoch", revision: 7,
  fact: added,
  actor: { kind: "owner" }, depth: 0, state: "running", attempts: 1, run: 1, error: null, createdAtMs: 1_000, updatedAtMs: 1_000,
};
const fromLedger = (claimed: DatasetAutomationClaim): DatasetRunClaim => ({ source: "dataset", claim: claimed });
// A run with no chat step reads no chat and sends nothing.
const sendsNothing = {
  chat: {
    directory: async () => { throw new Error("This automation sends no messages."); },
    write: async () => { throw new Error("This automation sends no messages."); },
  },
  postNotice: async () => { throw new Error("This automation notifies nobody."); },
  recipientVerdicts: async () => { throw new Error("This automation names nobody by formula."); },
  readMessageBody: async () => { throw new Error("No Group message starts this automation."); },
  readCode: async () => { throw new Error("This automation runs no code file."); },
};

function host(script: { resolves: () => boolean; edit: (input: DatasetInvocation) => Promise<JsonValue> }) {
  const sent: DatasetInvocation[] = [];
  const surface: DatasetRunHost = {
    context: (input) => Object.freeze({ ...input }) satisfies DatasetAutomationContext,
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
    readMessageBody: async () => { throw new Error("No Group message starts this automation."); },
    readCode: async () => { throw new Error("This automation runs no code file."); },
  };
  return { messages, notices, dependencies };
}

describe("a dataset automation run", () => {
  it("resends a stopped effect under the same key with the same content, and fails once the saved rules no longer resolve", async () => {
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-run-"), testMetadataDir);
    const input = (stopped: AbortSignal) => ({
      held: fromLedger(claim), automation, collection: { path: "Budget", name: "Budget" }, roster: { kind: "owner" as const, ownerUserId: null, grants: [] },
      signal: new AbortController().signal, stopped,
    });
    const dependencies = (surface: DatasetRunHost) => ({
      withHost: async <T>(work: (value: DatasetRunHost) => T | Promise<T>) => await work(surface),
      evaluator: { runCode: noCode, evaluate: async () => "busy" as const }, store, nowMs: () => 2_000, personName: (userId: string) => userId, ...sendsNothing,
    });

    // The first attempt stops while its edit is in flight: the plan is saved, the effect is not.
    const stop = new AbortController();
    const first = host({ resolves: () => true, edit: async () => { stop.abort(); throw new Error("The host closed."); } });
    expect(await runWithRoster(dependencies(first.surface), input(stop.signal))).toEqual({ kind: "wait", reason: "stopped" });
    const edit = first.sent.find((sent) => sent.operationId === EDIT)!;
    expect(edit).toMatchObject({
      datasetId: definition.datasetId, revision: 3, revisionSha256: revision.revisionSha256,
      input: { id: "a", expectedVersion: 1, values: { [STATUS]: "Closed" } },
      idempotencyKey: datasetEffectKey("claim-1", `${definitionHash(automation)}-1`, 0, 0, "a", 0),
    });

    // A resume sends that key again with the same content, without reading again.
    const second = host({ resolves: () => true, edit: async () => ({ id: "a", version: 2, priorValues: { [STATUS]: "Open" } }) });
    const resumed = new AbortController();
    const resumedRun = runWithRoster(dependencies(second.surface), input(resumed.signal));
    expect(await resumedRun).toEqual({ kind: "done" });
    expect(second.sent).toEqual([{ ...edit, signal: expect.any(AbortSignal) }]);

    // A new claim run under the same plan finds rules that no longer resolve.
    const third = host({ resolves: () => false, edit: async () => { throw new Error("unreachable"); } });
    const later = { ...claim, claimId: "claim-2" };
    const stopAgain = new AbortController();
    const again = host({ resolves: () => true, edit: async () => { stopAgain.abort(); throw new Error("The host closed."); } });
    expect(await runWithRoster(dependencies(again.surface), { ...input(stopAgain.signal), held: fromLedger(later) })).toEqual({ kind: "wait", reason: "stopped" });
    expect(await runWithRoster(dependencies(third.surface), { ...input(new AbortController().signal), held: fromLedger(later) }))
      .toEqual({ kind: "failed", error: RULES_CHANGED_ERROR, timedOut: false });
    expect(third.sent).toEqual([]);
  });

  it("stops a resumed run once the rules its landed steps used no longer resolve, before the next step reads", async () => {
    const twoSteps = automationFrom(`  - id: close
    name: Close
    when: record-added
    do:
      - set:
          Status: Closed
        operation: invoices.edit
      - set:
          Status: '=record.Status + "!"'
        operation: invoices.edit
`);
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-run-"), testMetadataDir);
    const run = (surface: DatasetRunHost) => runWithRoster({
      withHost: async (work) => await work(surface),
      // The second step's formula meets a busy evaluator, so the run waits once the first step landed.
      evaluator: { runCode: noCode, evaluate: async () => "busy" as const },
      store, nowMs: () => 2_000, personName: (userId: string) => userId, ...sendsNothing,
    }, {
      held: fromLedger(claim), automation: twoSteps, collection: { path: "Budget", name: "Budget" },
      roster: { kind: "owner", ownerUserId: null, grants: [] }, signal: new AbortController().signal, stopped: new AbortController().signal,
    });
    const first = host({ resolves: () => true, edit: async () => ({ id: "a", version: 2, priorValues: { [STATUS]: "Open" } }) });
    expect(await run(first.surface)).toEqual({ kind: "wait", reason: "busy" });
    expect(first.sent.filter((sent) => sent.operationId === EDIT)).toHaveLength(1);
    const later = host({ resolves: () => false, edit: async () => { throw new Error("unreachable"); } });
    expect(await run(later.surface)).toEqual({ kind: "failed", error: RULES_CHANGED_ERROR, timedOut: false });
    expect(later.sent).toEqual([]);
  });
});

describe("a due time on a dataset", () => {
  const scheduled = automationFrom(`  - id: close
    name: Close
    when: {schedule: day, timezone: UTC}
    do:
      - find: record.Status == "Open"
        as: open
        operation: invoices.list
      - set:
          Status: Closed
        records: open
        operation: invoices.edit
`);
  const due = Date.UTC(2026, 8, 27);
  const dueTime: AutomationClaim = {
    claimId: "atc_due", automationId: `collection:${definition.datasetId}#close`, trigger: { key: `schedule:${due}` }, recordId: null, collectionPath: "Budget",
    depth: 0, state: "running", attempts: 1, run: 1, createdAtMs: due + 5, updatedAtMs: due + 5,
    change: { kind: "schedule", authorOriginId: null, actorKind: null, onBehalfOf: null, sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 },
  };

  it("resumes its saved edit under the same key, and stops before any write once its Collection keeps another dataset", async () => {
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-run-"), testMetadataDir);
    const dependencies = (surface: DatasetRunHost) => ({
      withHost: async <T>(work: (value: DatasetRunHost) => T | Promise<T>) => await work(surface),
      evaluator: { runCode: noCode, evaluate: async () => "busy" as const }, store, nowMs: () => 2_000, personName: (userId: string) => userId, ...sendsNothing,
    });
    const input = (datasetId: string, stopped: AbortSignal) => ({
      held: { source: "engine" as const, claim: dueTime, datasetId }, automation: scheduled, collection: { path: "Budget", name: "Budget" },
      roster: { kind: "owner" as const, ownerUserId: null, grants: [] }, signal: new AbortController().signal, stopped,
    });
    const stop = new AbortController();
    const first = host({ resolves: () => true, edit: async () => { stop.abort(); throw new Error("The host closed."); } });
    expect(await runWithRoster(dependencies(first.surface), input(definition.datasetId, stop.signal))).toEqual({ kind: "wait", reason: "stopped" });
    const edit = first.sent.find((sent) => sent.operationId === EDIT)!;
    expect(edit.idempotencyKey).toBe(datasetEffectKey("atc_due", `${definitionHash(scheduled)}-1`, 1, 0, "a", 0));

    // The folder now holds another dataset: nothing is read or sent.
    const other = host({ resolves: () => true, edit: async () => { throw new Error("unreachable"); } });
    expect(await runWithRoster(dependencies(other.surface), input(id(99), new AbortController().signal)))
      .toEqual({ kind: "failed", error: RULES_CHANGED_ERROR, timedOut: false });
    expect(other.sent).toEqual([]);

    const resumed = host({ resolves: () => true, edit: async () => ({ id: "a", version: 2, priorValues: { [STATUS]: "Open" } }) });
    expect(await runWithRoster(dependencies(resumed.surface), input(definition.datasetId, new AbortController().signal))).toEqual({ kind: "done" });
    expect(resumed.sent).toEqual([{ ...edit, signal: expect.any(AbortSignal) }]);
  });

  it("revalidates a saved code change by table identity after another table is approved", async () => {
    const coded = automationFrom(`  - id: close
    name: Close
    when: {schedule: day, timezone: UTC}
    do:
      - run: return 1
`);
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-run-"), testMetadataDir);
    // The code closes record a in the dataset's only table.
    const dependencies = (surface: DatasetRunHost) => ({
      withHost: async <T>(work: (value: DatasetRunHost) => T | Promise<T>) => await work(surface),
      evaluator: {
        evaluate: async () => "busy" as const,
        runCode: async () => ({ ok: true as const, value: { records: [{ action: "change" as const, collection: "Budget", id: "a", fields: { Status: "Closed" } }] } }),
      },
      store, nowMs: () => 2_000, personName: (userId: string) => userId, ...sendsNothing, recipientVerdicts: async () => [],
    });
    const input = (stopped: AbortSignal) => ({
      held: { source: "engine" as const, claim: dueTime, datasetId: definition.datasetId }, automation: coded, collection: { path: "Budget", name: "Budget" },
      roster: { kind: "owner" as const, ownerUserId: null, grants: [] }, signal: new AbortController().signal, stopped,
    });
    const stop = new AbortController();
    const first = host({ resolves: () => true, edit: async () => { stop.abort(); throw new Error("The host closed."); } });
    expect(await runWithRoster(dependencies(first.surface), input(stop.signal))).toEqual({ kind: "wait", reason: "stopped" });
    expect(first.sent.some((sent) => sent.operationId === EDIT)).toBe(true);

    // The saved table remains explicit, so a new table cannot redirect the edit.
    const notes = { ...definition.tables[0]!, tableId: id(40), name: "Notes", sqlName: "notes" };
    const twoTables = host({ resolves: () => true, edit: async () => ({ id: "a", version: 2, priorValues: { [STATUS]: "Open" } }) });
    const surface: DatasetRunHost = { ...twoTables.surface, revision: () => ({ ...revision, definition: { ...definition, tables: [...definition.tables, notes] } }) };
    expect(await runWithRoster(dependencies(surface), input(new AbortController().signal)))
      .toEqual({ kind: "done" });
    expect(twoTables.sent).toMatchObject([{ operationId: EDIT, input: { id: "a" } }]);
  });

  it("stops a resumed plan that sends what it read once its Collection keeps another dataset", async () => {
    const telling = automationFrom(`  - id: close
    name: Close
    when: {schedule: day, timezone: UTC}
    do:
      - find: record.Status == "Open"
        as: open
        operation: invoices.list
      - notify: '{open.length} open'
        to: [user-owner]
`);
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-run-"), testMetadataDir);
    const stop = new AbortController();
    const spy = chatSpy({ notice: () => { stop.abort(); throw new Error("The workspace closed."); } });
    const attempt = async (datasetId: string, stopped: AbortSignal) => await runWithRoster(
      { withHost: async (work) => await work(host({ resolves: () => true, edit: async () => { throw new Error("unreachable"); } }).surface),
        evaluator: { runCode: noCode, evaluate: async () => [{ ok: true as const, value: "1 open" }] }, store, nowMs: () => 1, personName: (userId) => userId, ...spy.dependencies },
      { held: { source: "engine", claim: dueTime, datasetId }, automation: telling, collection: { path: "Budget", name: "Budget" },
        roster: { kind: "owner", ownerUserId: "user-owner", grants: [] }, signal: new AbortController().signal, stopped });
    expect(await attempt(definition.datasetId, stop.signal)).toEqual({ kind: "wait", reason: "stopped" });
    expect(spy.notices).toHaveLength(1);
    expect(await attempt(id(99), new AbortController().signal)).toEqual({ kind: "failed", error: RULES_CHANGED_ERROR, timedOut: false });
    expect(spy.notices).toHaveLength(1);
  });

  it("skips a due time once its automation starts from a record change instead", async () => {
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-run-"), testMetadataDir);
    const script = host({ resolves: () => true, edit: async () => { throw new Error("unreachable"); } });
    expect(await runWithRoster({ withHost: async (work) => await work(script.surface), evaluator: { runCode: noCode, evaluate: async () => "busy" }, store, nowMs: () => 1, personName: (userId: string) => userId, ...sendsNothing }, {
      held: { source: "engine", claim: dueTime, datasetId: definition.datasetId }, automation, collection: { path: "Budget", name: "Budget" },
      roster: { kind: "owner", ownerUserId: null, grants: [] }, signal: new AbortController().signal, stopped: new AbortController().signal,
    })).toEqual({ kind: "skipped" });
    expect(script.sent).toEqual([]);
  });
});

describe("a Group message on a dataset", () => {
  it("stops a planned run before it sends more once the Group it watches is another one", async () => {
    const heard = automationFrom(`  - id: heard
    name: Heard
    when: {group-message: Team}
    do:
      - notify: Heard
        to: [user-owner]
      - notify: Heard again
        to: [user-owner]
`);
    const claim: AutomationClaim = {
      claimId: "atc_message", automationId: "collection:Budget#heard", trigger: { key: "message:m1" }, recordId: null, collectionPath: "Budget",
      depth: 0, state: "running", attempts: 1, run: 1, createdAtMs: 5, updatedAtMs: 5,
      change: {
        kind: "message", authorOriginId: null, actorKind: "human", onBehalfOf: null, sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0,
        message: { id: "m1", threadId: "t1", groupId: TEAM.id, lane: "posts", authorKind: "human", authorDisplayName: "Ana", createdAtMs: 5, body: "Hi", authorUserId: "user-ana" },
      },
    };
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-run-"), testMetadataDir);
    const stop = new AbortController();
    const spy = chatSpy({ notice: () => { stop.abort(); throw new Error("The workspace closed."); } });
    const attempt = async (channels: ChatDirectoryChannel[], stopped: AbortSignal) => await runWithRoster(
      { withHost: async (work) => await work(host({ resolves: () => true, edit: async () => { throw new Error("unreachable"); } }).surface),
        evaluator: { runCode: noCode, evaluate: async () => [{ ok: true as const, value: "Heard" }, { ok: true as const, value: "Heard again" }] }, store, nowMs: () => 1,
        personName: (userId) => userId, ...spy.dependencies, chat: { ...spy.dependencies.chat, directory: async (roster) => chatDirectoryOf(channels, roster) } },
      { held: { source: "engine", claim, datasetId: definition.datasetId }, automation: heard, collection: { path: "Budget", name: "Budget" },
        roster: { kind: "owner", ownerUserId: "user-owner", grants: [] }, signal: new AbortController().signal, stopped });
    expect(await attempt([TEAM], stop.signal)).toEqual({ kind: "wait", reason: "stopped" });
    expect(spy.notices).toHaveLength(1);
    // Team is now another Group with the same name.
    expect(await attempt([{ ...TEAM, id: "team-2", wireId: "team-2-wire" }], new AbortController().signal))
      .toEqual({ kind: "failed", error: GROUP_CHANGED_ERROR, timedOut: false });
    expect(spy.notices).toHaveLength(1);
  });
});

describe("a Find's formulas", () => {
  it("reads nothing for a value the field would refuse, and names the mismatch", async () => {
    const COUNT = id(20);
    const table = definition.tables[0]!;
    const counted: DatasetDefinition = {
      ...definition,
      tables: [{ ...table, fields: [...table.fields, { fieldId: COUNT, name: "Count", sqlColumn: "count", type: "number", required: false, unique: false }] }],
      operations: definition.operations.map((operation) => operation.operationId === LIST ? { ...operation, fieldIds: [STATUS, COUNT] } : operation),
    };
    const named = automationFrom(`  - id: named
    name: Named
    when: {group-message: Team}
    do:
      - find: record.Count == message.body.slice(6)
        as: found
        operation: invoices.list
      - set:
          Status: Closed
        records: found
        operation: invoices.edit
`);
    const claim: AutomationClaim = {
      claimId: "atc_named", automationId: "collection:Budget#named", trigger: { key: "message:m1" }, recordId: null, collectionPath: "Budget",
      depth: 0, state: "running", attempts: 1, run: 1, createdAtMs: 5, updatedAtMs: 5,
      change: {
        kind: "message", authorOriginId: null, actorKind: "human", onBehalfOf: null, sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0,
        message: { id: "m1", threadId: "t1", groupId: TEAM.id, lane: "posts", authorKind: "human", authorDisplayName: "Ana", createdAtMs: 5, body: "/done 12", authorUserId: "user-ana" },
      },
    };
    const script = host({ resolves: () => true, edit: async () => { throw new Error("unreachable"); } });
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-run-"), testMetadataDir);
    // The Find's formula gives "12", and the Find's guard is true.
    const evaluate = async (_id: string, _scope: AutomationScope, formulas: readonly { kind: string; source?: string }[]) =>
      formulas.map((formula) => ({ ok: true as const, value: formula.source === "true" ? true : "12" }));
    expect(await runWithRoster({
      withHost: async (work) => await work({ ...script.surface, revision: () => ({ ...revision, definition: counted }) }),
      evaluator: { runCode: noCode, evaluate }, store, nowMs: () => 1, personName: (userId) => userId, ...chatSpy().dependencies,
    }, {
      held: { source: "engine", claim, datasetId: definition.datasetId }, automation: named, collection: { path: "Budget", name: "Budget" },
      roster: { kind: "owner", ownerUserId: "user-owner", grants: [] }, signal: new AbortController().signal, stopped: new AbortController().signal,
    })).toEqual({ kind: "failed", error: "The Find in step 1 compares Count, a number, with text. Wrap the value in Number().", timedOut: false });
    expect(script.sent).toEqual([]);
  });
});

describe("the rules a dataset run uses", () => {
  it("exposes trigger facts only through their dataset and table field keys", () => {
    const table = definition.tables[0]!;
    const fields = (datasetId: string, tableId: string) => datasetRunClaim(claim, "Budget", table, new Set([datasetFieldKey(datasetId, tableId, STATUS)])).change.fields;
    expect(fields(definition.datasetId, TABLE)).toEqual([{ field: "Status", previous: null, next: { value: "Open" } }]);
    expect(fields("other-dataset", TABLE)).toEqual([]);
    expect(fields(definition.datasetId, "other-table")).toEqual([]);
  });

  it.each([false, true])("stops a replaced destination before reads or effects, afterRead=%s", async (afterRead) => {
    const script = host({ resolves: () => true, edit: async () => { throw new Error("Must not write"); } });
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-destination-"), testMetadataDir);
    let resolutions = 0;
    const outcome = await runWithRoster({
      withHost: async (work) => await work(script.surface), evaluator: { runCode: noCode, evaluate: async () => "busy" }, store,
      nowMs: () => 1, personName: (id) => id, ...sendsNothing,
      targets: { resolve: async () => ({ kind: "dataset", collection: { path: "Budget", name: "Budget" },
        approved: !afterRead || resolutions++ > 1 ? { ...revision, datasetId: "replacement" } : revision,
        generated: true, grants: { workspaceId: "workspace", grants: [] } }) },
    }, {
      held: fromLedger(claim), automation, collection: { path: "Budget", name: "Budget" }, roster: { kind: "owner", ownerUserId: null, grants: [] },
      signal: new AbortController().signal, stopped: new AbortController().signal,
    });
    expect(outcome).toEqual({ kind: "failed", error: RULES_CHANGED_ERROR, timedOut: false });
    expect(script.sent.every((sent) => sent.operationId === LIST)).toBe(true);
    if (!afterRead) expect(script.sent).toEqual([]);
  });

  it("plans under the rules reach checked, not a newer approval that lands between them", async () => {
    // The newer rules add a read that shows the record's id, which the plan would prefer for the trigger record.
    const WIDE = id(12);
    const newer = { ...revision, revision: 4, revisionSha256: "s".repeat(64), definition: { ...definition, operations: [...definition.operations,
      { operationId: WIDE, name: "invoices.byId", label: "By id", tableId: TABLE, kind: "read" as const, access: "owner" as const, readOnly: true, fieldIds: [id(3), STATUS] }] } };
    const script = host({ resolves: () => true, edit: async () => ({ id: "a", version: 2, priorValues: { [STATUS]: "Open" } }) });
    let reads = 0;
    const surface: DatasetRunHost = { ...script.surface, revision: () => (reads++ === 0 ? revision : newer) };
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-run-"), testMetadataDir);
    expect(await runWithRoster({ withHost: async (work) => await work(surface), evaluator: { runCode: noCode, evaluate: async () => "busy" }, store, nowMs: () => 1, personName: (userId: string) => userId, ...sendsNothing }, {
      held: fromLedger(claim), automation, collection: { path: "Budget", name: "Budget" }, roster: { kind: "owner", ownerUserId: null, grants: [] },
      signal: new AbortController().signal, stopped: new AbortController().signal,
    })).toEqual({ kind: "done" });
    // The trigger record is read for the run's conditions, then again when its step starts.
    expect(script.sent.map((sent) => [sent.operationId, sent.revision])).toEqual([[LIST, 3], [LIST, 3], [EDIT, 3]]);
  });

  it("skips a record change once its automation starts on a schedule instead, before it reads anything", async () => {
    const scheduled = automationFrom(`  - id: close
    name: Close
    when: {schedule: day, timezone: UTC}
    do:
      - find: 'true'
        as: all
        operation: invoices.list
      - set:
          Status: Closed
        records: all
        operation: invoices.edit
`);
    const script = host({ resolves: () => true, edit: async () => { throw new Error("unreachable"); } });
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-run-"), testMetadataDir);
    expect(await runWithRoster({ withHost: async (work) => await work(script.surface), evaluator: { runCode: noCode, evaluate: async () => "busy" }, store, nowMs: () => 1, personName: (userId: string) => userId, ...sendsNothing }, {
      held: fromLedger(claim), automation: scheduled, collection: { path: "Budget", name: "Budget" }, roster: { kind: "owner", ownerUserId: null, grants: [] },
      signal: new AbortController().signal, stopped: new AbortController().signal,
    })).toEqual({ kind: "skipped" });
    expect(script.sent).toEqual([]);
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
    const sent: DatasetInvocation[] = [];
    const surface: DatasetRunHost = {
      ...host({ resolves: () => true, edit: async () => { throw new Error("A refused run writes nothing."); } }).surface,
      invoke: async (_context, input): Promise<DatasetInvocationResult> => {
        sent.push(input);
        const { limit, after } = input.input as { limit: number; after?: { id: string } };
        // The trigger read asks for one record; the Find asks for a page and there is more.
        if (limit === 1) return { result: { rows: [{ id: "a", version: 1, values: { [STATUS]: "Open" } }], nextCursor: null }, revision: 7, replayed: false };
        const start = after === undefined ? 0 : Number(after.id.slice(1)) + 1;
        const rows = Array.from({ length: limit }, (_, index) => ({ id: `r${start + index}`, version: 1, values: { [STATUS]: "Open" } }));
        return { result: { rows, nextCursor: { id: `r${start + limit - 1}`, value: `r${start + limit - 1}` } }, revision: 7, replayed: false };
      },
    };
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-run-"), testMetadataDir);
    expect(await runWithRoster({
      withHost: async (work) => await work(surface),
      evaluator: { runCode: noCode, evaluate: async (_automationId, _scope, formulas) => formulas.map(() => ({ ok: true as const, value: true })) },
      store, nowMs: () => 1, personName: (userId: string) => userId, ...sendsNothing,
    }, {
      held: fromLedger(claim), automation: read.entries[0].automation, collection: { path: "Budget", name: "Budget" },
      roster: { kind: "owner", ownerUserId: null, grants: [] }, signal: new AbortController().signal, stopped: new AbortController().signal,
    })).toEqual({ kind: "failed", error: "The Find in step 1 matched more than 500 records. Narrow its condition, then try again.", timedOut: false });
    expect(sent.map((input) => input.operationId)).toEqual(Array(7).fill(LIST));
    expect((await store.runsOf(claim.automationId, claim.claimId)).runs).toEqual([]);
  });
});

describe("a record the run reads twice", () => {
  // The record: Find sees a newer version than the trigger read until the
  // edits stop, after `settlesAfter` plans.
  const conflicting = (settlesAfter: number) => {
    const read = parseAutomationsFile(`version: 1
automations:
  - id: close-all
    name: Close all
    when: record-added
    do:
      - find: record.Status == String("Open")
        as: open
        operation: invoices.list
      - set:
          Status: '="Closed"'
        operation: invoices.edit
`);
    if (read.status !== "read" || read.entries[0]?.status !== "valid") throw new Error(JSON.stringify(read));
    const sent: DatasetInvocation[] = [];
    let plans = 0;
    const surface: DatasetRunHost = {
      ...host({ resolves: () => true, edit: async () => ({ id: "a", version: 2, priorValues: { [STATUS]: "Open" } }) }).surface,
      invoke: async (_context, input): Promise<DatasetInvocationResult> => {
        sent.push(input);
        if (input.operationId !== LIST) return { result: { id: "a", version: 9, priorValues: { [STATUS]: "Open" } }, revision: 7, replayed: false };
        const trigger = (input.input as { limit: number }).limit === 1;
        if (trigger) plans += 1;
        // Someone edits the record between the trigger read and the Find.
        const version = trigger || plans > settlesAfter ? plans : plans + 1;
        return { result: { rows: [{ id: "a", version, values: { [STATUS]: "Open" } }], nextCursor: null }, revision: 7, replayed: false };
      },
    };
    return { automation: read.entries[0].automation, sent, surface, plans: () => plans };
  };
  // Each evaluator request's record of the run's time, once each.
  const budgets = new Set<unknown>();
  let requests = 0;
  const runConflicting = async (script: ReturnType<typeof conflicting>, signal = new AbortController().signal) => runWithRoster({
    withHost: async (work) => await work(script.surface),
    evaluator: { runCode: noCode, evaluate: async (_automationId, _scope, formulas, spent) => { budgets.add(spent); requests += 1; return formulas.map(() => ({ ok: true as const, value: "Closed" })); } },
    store: createAutomationRunStore(await createTestScratch("dohc-dataset-run-"), testMetadataDir), nowMs: () => 1, personName: (userId: string) => userId, ...sendsNothing,
  }, {
    held: fromLedger(claim), automation: script.automation, collection: { path: "Budget", name: "Budget" },
    roster: { kind: "owner", ownerUserId: null, grants: [] }, signal, stopped: new AbortController().signal,
  });

  it("reads a step again when the record changed between its reads, so no write uses one read's values at the other's version", async () => {
    const script = conflicting(2);
    budgets.clear();
    requests = 0;
    expect(await runConflicting(script)).toEqual({ kind: "done" });
    // The run's start reads the trigger record, the Find's step reads twice, and the Set's step once.
    expect(script.plans()).toBe(4);
    // Each read of the Find's step evaluated its value before the Find read, all against one budget for the run.
    expect(requests).toBeGreaterThanOrEqual(3);
    expect(budgets.size).toBe(1);
    // One edit, sent at the version the Set's step read.
    expect(script.sent.filter((input) => input.operationId === EDIT).map((input) => (input.input as { expectedVersion: number }).expectedVersion)).toEqual([4]);
  });

  it("fails with Try again, before any write, when the record keeps changing between the reads", async () => {
    const script = conflicting(Infinity);
    expect(await runConflicting(script)).toEqual({ kind: "failed", error: "The record kept changing while this automation ran. Try again.", timedOut: false });
    // The run's start, then six reads of the Find's step.
    expect(script.plans()).toBe(7);
    expect(script.sent.some((input) => input.operationId === EDIT)).toBe(false);
  });

  it("counts a deadline that passes while the run plans again as a timeout", async () => {
    const script = conflicting(Infinity);
    const deadline = new AbortController();
    const invoke = script.surface.invoke;
    script.surface.invoke = async (context, input) => {
      // The deadline passes during the second plan's reads.
      if (script.plans() === 2) deadline.abort();
      return await invoke(context, input);
    };
    expect(await runConflicting(script, deadline.signal)).toEqual({ kind: "failed", error: DEADLINE_ERROR, timedOut: true });
    expect(script.sent.some((input) => input.operationId === EDIT)).toBe(false);
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
    const sent: DatasetInvocation[] = [];
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
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-run-"), testMetadataDir);
    const added: DatasetAutomationClaim = { ...claim, automationId: "collection:Budget#ship",
      fact: { kind: "added", datasetId: definition.datasetId, tableId: A, recordId: "1", version: 5, fields: [{ fieldId: A_STATUS, previous: null, next: "New" }] } };
    expect(await runWithRoster({ withHost: async (work) => await work(surface), evaluator: { runCode: noCode, evaluate: async () => "busy" }, store, nowMs: () => 1, personName: (userId: string) => userId, ...sendsNothing }, {
      held: fromLedger(added), automation: read.entries[0].automation, collection: { path: "Budget", name: "Budget" },
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
    const outcome = await runWithRoster({
      withHost: async (work) => await work(surface),
      evaluator: { runCode: noCode, evaluate: async (_id, scope) => { scopes.push(scope); return [{ ok: true, value: "x" }]; } },
      store: createAutomationRunStore(await createTestScratch("dohc-dataset-reach-"), testMetadataDir), nowMs: () => 1, personName: (userId: string) => userId, ...sendsNothing,
    }, {
      held: fromLedger({ ...claim, fact: { ...added, fields: [{ fieldId: STATUS, previous: null, next: "Open" }, { fieldId: SECRET, previous: null, next: "s3cret" }] } }),
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
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-narrowed-"), testMetadataDir);
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
      held: fromLedger({ ...claim, fact: { ...added, fields: [{ fieldId: STATUS, previous: null, next: "Open" }, { fieldId: SECRET, previous: null, next: "s3cret" }] } }),
      automation: stamp, collection: { path: "Budget", name: "Budget" },
      roster: { kind: "owner" as const, ownerUserId: "u-owner", grants: editors }, signal: new AbortController().signal, stopped,
    });
    const dependencies = (surface: DatasetRunHost) => ({ withHost: async <T>(work: (value: DatasetRunHost) => T | Promise<T>) => await work(surface),
      evaluator: { runCode: noCode, evaluate: async () => [{ ok: true as const, value: "x" }] }, store, nowMs: () => 1, personName: (userId: string) => userId, ...sendsNothing });
    // Planned while only the owner edits: every field was readable. It stops mid-edit.
    const first = host(async () => { stop.abort(); throw new Error("The host closed."); });
    expect(await runWithRoster(dependencies(first), input([], stop.signal))).toEqual({ kind: "wait", reason: "stopped" });
    // Ana now edits the automation and cannot read Secret: the rest stops.
    const second = host(async () => { throw new Error("unreachable"); });
    expect(await runWithRoster(dependencies(second), input([ana], new AbortController().signal)))
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
    expect(await runWithRoster({
      withHost: async (work) => await work(surface),
      evaluator: { runCode: noCode, evaluate: async (_id, scope) => { scopes.push(scope); return [{ ok: true, value: "Added" }]; } },
      store: createAutomationRunStore(await createTestScratch("dohc-dataset-reach-"), testMetadataDir), nowMs: () => 1, personName: (userId: string) => userId, ...spy.dependencies,
    }, {
      held: fromLedger({ ...claim, automationId: "collection:Budget#tell", fact: { ...added, fields: [{ fieldId: STATUS, previous: null, next: "Open" }, { fieldId: SECRET, previous: null, next: "s3cret" }] } }),
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
    runCode: noCode,
    evaluate: async (_id: string, _scope: AutomationScope, formulas: readonly { kind: string }[]) =>
      formulas.map((formula) => ({ ok: true as const, value: formula.kind === "text" ? "Closed" : true })),
  };
  const key = (automation: typeof tell, ordinal: number) => stepKey("claim-1", `${definitionHash(automation)}-1`, ordinal);
  const edits = () => host({ resolves: () => true, edit: async () => ({ id: "a", version: 2, priorValues: { [STATUS]: "Open" } }) });

  it("posts, sends a direct message, and notifies as the automation, one chain step deeper, each keyed by its claim, definition, and step", async () => {
    const script = edits();
    const spy = chatSpy();
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-chat-"), testMetadataDir);
    expect(await runWithRoster({ withHost: async (work) => await work(script.surface), evaluator, store, nowMs: () => 1, personName: (userId) => userId, ...spy.dependencies }, {
      held: fromLedger({ ...told, depth: 2 }), automation: tell, collection: BUDGET, roster: owner(ANA), signal: new AbortController().signal, stopped: new AbortController().signal,
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
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-chat-"), testMetadataDir);
    const attempt = async (spy: ReturnType<typeof chatSpy>, run: number, stopped: AbortSignal) => await runWithRoster(
      { withHost: async (work) => await work(script.surface), evaluator, store, nowMs: () => 1, personName: (userId) => userId, ...spy.dependencies },
      { held: fromLedger({ ...told, run }), automation: tell, collection: BUDGET, roster: owner(ANA), signal: new AbortController().signal, stopped });

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
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-chat-"), testMetadataDir);
    const attempt = async (spy: ReturnType<typeof chatSpy>) => await runWithRoster(
      { withHost: async (work) => await work(script.surface), evaluator, store, nowMs: () => 1, personName: (userId) => userId, ...spy.dependencies },
      { held: fromLedger(told), automation: tell, collection: BUDGET, roster: owner(ANA), signal: new AbortController().signal, stopped: new AbortController().signal });
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
    expect(await runWithRoster({
      withHost: async (work) => await work(surface), evaluator, store: createAutomationRunStore(await createTestScratch("dohc-dataset-chat-"), testMetadataDir),
      nowMs: () => 1, personName: (userId) => userId, ...spy.dependencies,
    }, {
      held: fromLedger({ ...claim, automationId: "collection:Budget#notify", fact: { ...added, recordId: "a " } }), automation: notify, collection: BUDGET,
      roster: owner(ANA), signal: new AbortController().signal, stopped: new AbortController().signal,
    })).toEqual({ kind: "done" });
    expect(spy.notices.map((notice) => notice.target)).toEqual([{ path: "Budget", automation: "collection:Budget#notify", run: "claim-1" }]);
  });

  it("stops before it reads anything when an editor cannot post in the Group", async () => {
    const script = host({ resolves: () => true, edit: async () => { throw new Error("A stopped run writes nothing."); } });
    const spy = chatSpy();
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-chat-"), testMetadataDir);
    expect(await runWithRoster({ withHost: async (work) => await work(script.surface), evaluator, store, nowMs: () => 1, personName: (userId) => userId, ...spy.dependencies }, {
      held: fromLedger(told), automation: tell, collection: BUDGET, roster: owner([...ANA, BOB]), signal: new AbortController().signal, stopped: new AbortController().signal,
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

  it("names the button when its automation changed after a press", async () => {
    const script = host({ resolves: () => true, edit: async () => { throw new Error("Must not write"); } });
    const surface = { ...script.surface, revision: () => ({ ...revision, definition: withButton }) };
    const stale = structuredClone(pressed);
    if (stale.fact?.kind !== "button") throw new Error("fixture");
    stale.fact.definitionHash = "old";
    const spy = chatSpy();
    expect(await runWithRoster({
      withHost: async (work) => work(surface), evaluator,
      store: createAutomationRunStore(await createTestScratch("dohc-dataset-button-"), testMetadataDir),
      nowMs: () => 1, personName: (id) => id, ...spy.dependencies,
    }, { held: fromLedger(stale), automation: ask, collection: BUDGET, roster: owner([]),
      signal: new AbortController().signal, stopped: new AbortController().signal }))
      .toEqual({ kind: "failed", error: "Ask changed after it was pressed. Press it again.", timedOut: false });
    expect(script.sent).toEqual([]);
    expect(spy.messages).toEqual([]);
  });

  it("wakes your agent from a press in a Collection only you edit", async () => {
    const script = host({ resolves: () => true, edit: async () => { throw new Error("This automation edits nothing."); } });
    const surface: DatasetRunHost = { ...script.surface, revision: () => ({ ...revision, definition: withButton }) };
    const run = async (grants: RosterGrant[]) => {
      const spy = chatSpy();
      const outcome = await runWithRoster({
        withHost: async (work) => await work(surface), evaluator, store: createAutomationRunStore(await createTestScratch("dohc-dataset-wake-"), testMetadataDir),
        nowMs: () => 1, personName: (userId) => userId, ...spy.dependencies,
      }, { held: fromLedger(pressed), automation: ask, collection: BUDGET, roster: owner(grants), signal: new AbortController().signal, stopped: new AbortController().signal });
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
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-wake-"), testMetadataDir);
    let rules = withButton;
    const surface: DatasetRunHost = { ...host({ resolves: () => true, edit: async () => { throw new Error("This automation edits nothing."); } }).surface,
      revision: () => ({ ...revision, definition: rules }) };
    const attempt = async (spy: ReturnType<typeof chatSpy>, grants: RosterGrant[], stopped: AbortSignal) => await runWithRoster(
      { withHost: async (work) => await work(surface), evaluator, store, nowMs: () => 1, personName: (userId) => userId, ...spy.dependencies },
      { held: fromLedger(pressed), automation: ask, collection: BUDGET, roster: owner(grants), signal: new AbortController().signal, stopped });
    // The plan is saved, and the run stops before the wake is recorded.
    const stop = new AbortController();
    expect(await attempt(chatSpy({ write: () => { stop.abort(); throw new Error("The engine closed."); } }), [], stop.signal))
      .toEqual({ kind: "wait", reason: "stopped" });
    // The approved read goes, so the automation no longer resolves, and Bob can now edit Budget.
    rules = { ...withButton, operations: withButton.operations.filter((operation) => operation.kind !== "read") };
    const resumed = chatSpy();
    expect(await attempt(resumed, [BOB], new AbortController().signal)).toEqual({ kind: "failed", error: "Budget has no approved read in Invoices.", timedOut: false });
    expect(resumed.messages).toEqual([]);
  });
});

describe("a dataset action a run invokes", () => {
  const MARK_PAID = id(12);
  const withAction: DatasetDefinition = {
    ...definition,
    tables: [{ ...definition.tables[0]!, primaryKey: "number", fields: [
      { fieldId: id(3), name: "Number", sqlColumn: "number", type: "number", required: true, unique: true },
      { fieldId: STATUS, name: "Status", sqlColumn: "status", type: "text", required: true, unique: false },
    ] }],
    operations: [...definition.operations, { operationId: MARK_PAID, name: "invoices.markPaid", label: "Mark paid", tableId: TABLE, kind: "action", access: "owner", readOnly: false, fieldIds: [STATUS] }],
  };
  const actionRevision = { ...revision, definition: withAction } satisfies DatasetRevision;
  const markPaid = automationFrom(`  - id: mark
    name: Mark
    when: record-added
    do:
      - invoke: invoices.markPaid
        input:
          id: '=record.id'
          note: Paid by an automation
`);
  const numbered: DatasetAutomationClaim = { ...claim, automationId: "collection:Budget#mark", fact: { ...added, recordId: 12 } };
  // Operations someone wrote: the run reads nothing, and formulas see the record's id alone.
  function actionHost(invoke: (input: DatasetInvocation) => Promise<DatasetInvocationResult>) {
    const sent: DatasetInvocation[] = [];
    const surface: DatasetRunHost = {
      context: (input) => Object.freeze({ ...input }) satisfies DatasetAutomationContext,
      revision: () => actionRevision,
      generated: () => false,
      dataGrants: () => ({ workspaceId: "workspace", grants: [] }),
      resolves: () => true,
      invoke: async (_context, input) => { sent.push(input); return await invoke(input); },
    };
    return { surface, sent };
  }
  const scopes: AutomationScope[] = [];
  const evaluator = {
    runCode: noCode,
    evaluate: async (_automationId: string, scope: AutomationScope, formulas: readonly unknown[]) => {
      scopes.push(scope);
      return formulas.map(() => ({ ok: true as const, value: (scope.record?.id ?? null) as JsonValue }));
    },
  };

  it("sends the action its input once per claim, with the record's id as its operations take it, and resumes under the same key", async () => {
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-action-"), testMetadataDir);
    const dependencies = (surface: DatasetRunHost) => ({
      withHost: async <T>(work: (value: DatasetRunHost) => T | Promise<T>) => await work(surface),
      evaluator, store, nowMs: () => 2_000, personName: (userId: string) => userId, ...sendsNothing,
    });
    const input = (stopped: AbortSignal) => ({
      held: fromLedger(numbered), automation: markPaid, collection: { path: "Budget", name: "Budget" }, roster: { kind: "owner" as const, ownerUserId: null, grants: [] },
      signal: new AbortController().signal, stopped,
    });
    const stop = new AbortController();
    const first = actionHost(async () => { stop.abort(); throw new Error("The host closed."); });
    expect(await runWithRoster(dependencies(first.surface), input(stop.signal))).toEqual({ kind: "wait", reason: "stopped" });
    // No read: the only call is the action, with a number for a number key.
    expect(first.sent).toEqual([expect.objectContaining({
      operationId: MARK_PAID, input: { id: 12, note: "Paid by an automation" },
      idempotencyKey: datasetEffectKey("claim-1", `${definitionHash(markPaid)}-1`, 0, 0, null, 0),
    })]);
    expect(scopes.at(-1)).toMatchObject({ record: { id: 12 }, recordKeys: ["id"] });
    const evaluated = scopes.length;
    // A resume sends the saved request again, without evaluating again; the host replays its receipt.
    const second = actionHost(async () => ({ result: { id: 12 }, revision: 8, replayed: true }));
    expect(await runWithRoster(dependencies(second.surface), input(new AbortController().signal))).toEqual({ kind: "done" });
    expect(second.sent).toEqual([{ ...first.sent[0]!, signal: expect.any(AbortSignal) }]);
    expect(scopes).toHaveLength(evaluated);
    const [run] = (await store.runsOf("collection:Budget#mark", "claim-1")).runs;
    expect(run?.applied.flatMap((effect) => effect.writes)).toEqual([
      { kind: "dataset-action", rules: { datasetId: definition.datasetId, revision: 3, revisionSha256: revision.revisionSha256 }, operationId: MARK_PAID, tableId: TABLE, name: "Mark paid", revision: 8 },
    ]);
  });

  it("stops a planned action only you can use once someone else can edit the automation, before it commits", async () => {
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-action-"), testMetadataDir);
    const alone = { kind: "owner" as const, ownerUserId: "u-owner", grants: [] };
    const ana = { grantId: "g-ana", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", files: { paths: ["Budget"], versionId: null, access: "edit" as const }, channel: null };
    let roster: ReachRoster = alone;
    // The owner shares Budget with Ana while the run evaluates its formulas, after reach passed for the plan.
    const sharing = { runCode: noCode, evaluate: async (automationId: string, scope: AutomationScope, formulas: readonly unknown[]) => {
      roster = { ...alone, grants: [ana] };
      return await evaluator.evaluate(automationId, scope, formulas);
    } };
    const host = actionHost(async () => { throw new Error("The action must not run."); });
    expect(await runWithRoster({
      withHost: async (work) => await work(host.surface), evaluator: sharing, store, nowMs: () => 2_000, personName: (userId: string) => userId, ...sendsNothing,
      cachedRoster: async () => roster,
    }, {
      held: fromLedger(numbered), automation: markPaid, collection: { path: "Budget", name: "Budget" }, roster: alone,
      signal: new AbortController().signal, stopped: new AbortController().signal,
    })).toEqual({ kind: "failed", error: "Only you can use invoices.markPaid in Budget, and ana@dohc.test can also edit these automations.", timedOut: false });
    expect(host.sent).toEqual([]);
  });

  it("runs an action on a schedule, and checks who can edit before the action as for a record change", async () => {
    const nightly = automationFrom(`  - id: mark
    name: Mark
    when: {schedule: day, timezone: UTC}
    do:
      - invoke: invoices.markPaid
        input:
          note: Nightly
`);
    const due = Date.UTC(2026, 8, 27);
    const dueTime: AutomationClaim = {
      claimId: "atc_due", automationId: "collection:Budget#mark", trigger: { key: `schedule:${due}` }, recordId: null, collectionPath: "Budget",
      depth: 0, state: "running", attempts: 1, run: 1, createdAtMs: due + 5, updatedAtMs: due + 5,
      change: { kind: "schedule", authorOriginId: null, actorKind: null, onBehalfOf: null, sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 },
    };
    const alone = { kind: "owner" as const, ownerUserId: "u-owner", grants: [] };
    const ana = { grantId: "g-ana", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", files: { paths: ["Budget"], versionId: null, access: "edit" as const }, channel: null };
    const attempt = async (roster: ReachRoster, host: ReturnType<typeof actionHost>) => await runWithRoster({
      withHost: async (work) => await work(host.surface), evaluator, store: createAutomationRunStore(await createTestScratch("dohc-dataset-action-"), testMetadataDir),
      nowMs: () => 2_000, personName: (userId: string) => userId, ...sendsNothing, cachedRoster: async () => roster,
    }, {
      held: { source: "engine", claim: dueTime, datasetId: definition.datasetId }, automation: nightly, collection: { path: "Budget", name: "Budget" },
      roster: alone, signal: new AbortController().signal, stopped: new AbortController().signal,
    });
    const ran = actionHost(async () => ({ result: null, revision: 9, replayed: false }));
    expect(await attempt(alone, ran)).toEqual({ kind: "done" });
    expect(ran.sent).toEqual([expect.objectContaining({ operationId: MARK_PAID, input: { note: "Nightly" } })]);
    // Ana gained Edit after the plan: the action does not run.
    const stopped = actionHost(async () => { throw new Error("The action must not run."); });
    expect(await attempt({ ...alone, grants: [ana] }, stopped)).toMatchObject({ kind: "failed", error: expect.stringContaining("ana@dohc.test") });
    expect(stopped.sent).toEqual([]);
  });

  it("waits to run a planned action when it cannot check who can edit the Collection", async () => {
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-action-"), testMetadataDir);
    const host = actionHost(async () => { throw new Error("The action must not run."); });
    expect(await runWithRoster({
      withHost: async (work) => await work(host.surface), evaluator, store, nowMs: () => 2_000, personName: (userId: string) => userId, ...sendsNothing,
      cachedRoster: async () => ({ kind: "unknown", problem: { kind: "unchecked", next: "dohc checks again when the server answers." } }),
    }, {
      held: fromLedger(numbered), automation: markPaid, collection: { path: "Budget", name: "Budget" }, roster: { kind: "owner", ownerUserId: null, grants: [] },
      signal: new AbortController().signal, stopped: new AbortController().signal,
    })).toEqual({ kind: "wait", reason: "roster" });
    expect(host.sent).toEqual([]);
  });

  it("fails a run the action refuses with the action's own words, and sends it again under the same key on Try again", async () => {
    const store = createAutomationRunStore(await createTestScratch("dohc-dataset-action-"), testMetadataDir);
    const dependencies = (surface: DatasetRunHost) => ({
      withHost: async <T>(work: (value: DatasetRunHost) => T | Promise<T>) => await work(surface),
      evaluator, store, nowMs: () => 2_000, personName: (userId: string) => userId, ...sendsNothing,
    });
    const input = (run: number) => ({
      held: fromLedger({ ...numbered, run }), automation: markPaid, collection: { path: "Budget", name: "Budget" }, roster: { kind: "owner" as const, ownerUserId: null, grants: [] },
      signal: new AbortController().signal, stopped: new AbortController().signal,
    });
    const refusing = actionHost(async () => { throw new AppBackendRuntimeError({ code: "already_paid", message: "This invoice is already paid." }); });
    expect(await runWithRoster(dependencies(refusing.surface), input(1)))
      .toEqual({ kind: "failed", error: "Mark paid refused this run: This invoice is already paid.", timedOut: false });
    // Try again: the refusal committed nothing, so the same request runs the action again.
    const accepting = actionHost(async () => ({ result: { id: 12 }, revision: 9, replayed: false }));
    expect(await runWithRoster(dependencies(accepting.surface), input(2))).toEqual({ kind: "done" });
    expect(accepting.sent).toEqual([{ ...refusing.sent[0]!, signal: expect.any(AbortSignal) }]);
  });

  describe("with a code step", () => {
    // Formulas and code run in the real evaluator.
    const shared = createAutomationFormulaEvaluator();
    afterAll(() => shared.close());
    const coded = (code: string) => automationFrom(`  - id: mark
    name: Mark
    when: record-added
    do:
      - run: "${code}"
        as: note
      - invoke: invoices.markPaid
        input:
          id: '=record.id'
          note: '=note'
`);
    const run = async (automation: ReturnType<typeof coded>, host: ReturnType<typeof actionHost>) => await runWithRoster({
      withHost: async (work) => await work(host.surface), evaluator: shared.forWorkspace("workspace"),
      store: createAutomationRunStore(await createTestScratch("dohc-dataset-action-"), testMetadataDir), nowMs: () => 2_000, personName: (userId: string) => userId, ...sendsNothing,
      recipientVerdicts: async () => [],
    }, {
      held: fromLedger(numbered), automation, collection: { path: "Budget", name: "Budget" }, roster: { kind: "owner", ownerUserId: null, grants: [] },
      signal: new AbortController().signal, stopped: new AbortController().signal,
    });

    it("gives an action the value its code returns, reading only the record's id", async () => {
      const host = actionHost(async () => ({ result: { id: 12 }, revision: 8, replayed: false }));
      expect(await run(coded("return { output: 'Paid ' + ctx.record.id };"), host)).toEqual({ kind: "done" });
      expect(host.sent).toEqual([expect.objectContaining({ operationId: MARK_PAID, input: { id: 12, note: "Paid 12" } })]);
    });

    it("stops code that reads a field the run could not read, before anything runs", async () => {
      const host = actionHost(async () => { throw new Error("The action must not run."); });
      expect(await run(coded("return { output: ctx.record.Status };"), host))
        .toMatchObject({ kind: "failed", error: expect.stringMatching(/^The code in step 1 failed\. .*The code can read only this record's id, not Status\./) });
      expect(host.sent).toEqual([]);
    });

    it("refuses code that changes records, before anything runs, since only an action can change them", async () => {
      const host = actionHost(async () => { throw new Error("The action must not run."); });
      expect(await run(coded("return { set: { Status: 'Paid' } };"), host)).toEqual({
        kind: "failed", timedOut: false,
        error: "The code in step 1 changes records in Budget. Its operations were written or changed outside dohc, so only an action can change its records. Run one with an invoke step.",
      });
      expect(host.sent).toEqual([]);
    });
  });
});
