import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTOMATION_NEVER_STARTED_REFUSAL } from "@dohc/app-backend-runtime/dataset-automation-claims";
import { type AutomationClaim } from "@dohc/workspace-engine-client";
import { generateDatasetSources } from "../workspaces/datasetGenerator";
import { type ReachRoster } from "@dohc/automation-executor/automation-reach";
import { createAutomationRunStore, type StoredRun } from "@dohc/automation-executor/automation-run-store";
import { preparedAutomationStoreFolder } from "../testing/preparedLocalState";
import { definitionHash } from "@dohc/automation-executor/automation-plan";
import { DATASET_UNDO_RULES_CHANGED } from "@dohc/automation-executor/dataset-automation-undo";
import { datasetAutomationFixture } from "./collectionAutomationDatasetTestSupport";

const { id, BUDGET, AUTOMATION, PAID, STATUS, NOTES, LIST, CREATE, EDIT, REMOVE, definition, files, closePaid, HOLD, RELEASE, ACTION_DESCRIPTOR, ACTION_OPERATIONS, world, engineClaim } = datasetAutomationFixture();

describe("undoing the records a dataset automation added", () => {
  const addLog = closePaid(`      - add-record:
          Notes: Log
        operation: invoices.create
`);
  const ana = { grantId: "g-ana", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", files: { paths: ["Budget"], versionId: null, access: "edit" as const }, channel: null };
  const withAna: ReachRoster = { kind: "owner", ownerUserId: "user-owner", grants: [ana] };
  const trash = async () => { throw new Error("A dataset keeps no trash."); };
  const counts = { reverted: 0, removed: 0, deleted: 0, kept: 0, keptChanged: 0, gone: 0, changedSince: 0, missing: 0, irreversible: 0, actions: 0, actionsReversed: 0 };
  const logs = async (f: Awaited<ReturnType<typeof world>>) => (await f.records()).filter((row) => row.values[NOTES] === "Log");
  // What the person sees when they click Undo, then the Undo they confirm from it.
  const ask = (f: Awaited<ReturnType<typeof world>>, claimId: string) => f.executor.undo({ automationId: AUTOMATION, claimId, deletes: null }, trash);
  const confirmed = async (f: Awaited<ReturnType<typeof world>>, claimId: string) => {
    const asked = await ask(f, claimId);
    return asked.status === "confirm" ? await f.executor.undo({ automationId: AUTOMATION, claimId, deletes: { token: asked.preview.token, chosen: [] } }, trash) : asked;
  };
  const shown = { deletes: 0, unchecked: 0, kept: 0, keptChanged: 0, gone: 0, reverts: 0, irreversible: 0, reverses: 0, actions: 0, choices: [], token: expect.any(String) };

  async function ranOnce(f: Awaited<ReturnType<typeof world>>) {
    await f.writeAutomations(addLog);
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    return f.claims()[0]!.claimId;
  }

  it("keeps a record it added when an editor cannot delete, says so in the builder, and never widens to a delete granted later", async () => {
    const f = await world({ roster: withAna });
    f.grant("g-ana", "u-ana", [LIST, CREATE, EDIT]);
    const claimId = await ranOnce(f);
    expect(await f.executor.automationsIn("Budget")).toMatchObject({ addsStay: ["Invoices"] });
    expect((await f.executor.runs(AUTOMATION)).runs[0]!.writes).toEqual([expect.objectContaining({ kind: "dataset-created", deletes: [] })]);
    expect(await ask(f, claimId)).toEqual({ status: "confirm", preview: { ...shown, kept: 1 } });
    // Ana may delete now. The run recorded no delete, so the record still stays.
    f.grant("g-ana", "u-ana", [LIST, CREATE, EDIT, REMOVE]);
    expect(await ask(f, claimId)).toMatchObject({ status: "confirm", preview: { deletes: 0, kept: 1 } });
    expect(await confirmed(f, claimId)).toEqual({ status: "undone", ...counts, kept: 1 });
    expect(await logs(f)).toHaveLength(1);
    await f.executor.dispose();
  });

  it("keeps a record it added when an editor lost the delete before Undo, and refuses while it cannot check who can edit", async () => {
    const f = await world({ roster: withAna });
    f.grant("g-ana", "u-ana", [LIST, CREATE, EDIT, REMOVE]);
    const claimId = await ranOnce(f);
    expect((await f.executor.runs(AUTOMATION)).runs[0]!.writes).toEqual([expect.objectContaining({ kind: "dataset-created", deletes: [REMOVE] })]);
    f.setRoster({ kind: "unknown", problem: { kind: "unchecked", next: "dohc checks again when the server answers." } });
    expect(await ask(f, claimId)).toEqual({ status: "refused", reason: "dohc could not check who can edit Budget. dohc checks again when the server answers." });
    f.setRoster(withAna);
    f.grant("g-ana", "u-ana", [LIST, CREATE, EDIT]);
    expect(await confirmed(f, claimId)).toEqual({ status: "undone", ...counts, kept: 1 });
    expect(await logs(f)).toHaveLength(1);
    await f.executor.dispose();
  });

  it("asks again, deleting nothing, when a confirmation answers a preview that no longer holds", async () => {
    const f = await world({ roster: withAna });
    f.grant("g-ana", "u-ana", [LIST, CREATE, EDIT, REMOVE]);
    const claimId = await ranOnce(f);
    // Ana loses the delete, so the preview says the record stays. She gets it back before the person confirms.
    f.grant("g-ana", "u-ana", [LIST, CREATE, EDIT]);
    const asked = await ask(f, claimId);
    expect(asked).toEqual({ status: "confirm", preview: { ...shown, kept: 1 } });
    if (asked.status !== "confirm") throw new Error("Undo should ask first.");
    f.grant("g-ana", "u-ana", [LIST, CREATE, EDIT, REMOVE]);
    expect(await f.executor.undo({ automationId: AUTOMATION, claimId, deletes: { token: asked.preview.token, chosen: [] } }, trash))
      .toEqual({ status: "confirm", preview: { ...shown, deletes: 1 } });
    expect(await logs(f)).toHaveLength(1);
    const { runs } = await createAutomationRunStore(preparedAutomationStoreFolder(f.root)).runsOf(AUTOMATION, claimId);
    expect(runs.map((run) => [run.undo, run.undoCalls])).toEqual([[null, []]]);
    await f.executor.dispose();
  });

  it("keeps a record it added that someone changed since, saying so first, rather than deleting it at its new version", async () => {
    const f = await world();
    const claimId = await ranOnce(f);
    const [log] = await logs(f);
    await f.edit(log!.id, { [STATUS]: "Kept by hand" });
    expect(await ask(f, claimId)).toEqual({ status: "confirm", preview: { ...shown, keptChanged: 1 } });
    expect(await confirmed(f, claimId)).toEqual({ status: "undone", ...counts, keptChanged: 1 });
    expect((await f.record(log!.id))?.values[STATUS]).toBe("Kept by hand");
    await f.executor.dispose();
  });

  it("sends the saved delete again after dohc stops once it committed, and counts one already gone apart", async () => {
    const f = await world();
    const claimId = await ranOnce(f);
    const asked = await ask(f, claimId);
    if (asked.status !== "confirm") throw new Error("Undo should ask first.");
    f.crashAfterOwnerInvoke(REMOVE);
    await expect(f.executor.undo({ automationId: AUTOMATION, claimId, deletes: { token: asked.preview.token, chosen: [] } }, trash)).rejects.toThrow("dohc stopped.");
    expect(await logs(f)).toEqual([]);
    const store = createAutomationRunStore(preparedAutomationStoreFolder(f.root));
    const [saved] = (await store.runsOf(AUTOMATION, claimId)).runs;
    expect(saved).toMatchObject({ undo: "started", undoCalls: [expect.objectContaining({ kind: "delete", operationId: REMOVE, expectedVersion: 1 })] });
    // The retry chooses nothing again: it sends the saved request, whose receipt replays.
    expect(await f.executor.undo({ automationId: AUTOMATION, claimId, deletes: null }, trash)).toEqual({ status: "undone", ...counts, deleted: 1 });
    await f.executor.dispose();

    const g = await world();
    const other = await ranOnce(g);
    const [log] = await logs(g);
    await g.host.action({ ...g.rules, operationId: REMOVE, input: { id: log!.id, expectedVersion: 1 }, idempotencyKey: "owner-delete" });
    expect(await ask(g, other)).toEqual({ status: "confirm", preview: { ...shown, gone: 1 } });
    expect(await confirmed(g, other)).toEqual({ status: "undone", ...counts, gone: 1 });
    await g.executor.dispose();
  });

  it("leaves a run that would try to delete a record it could not check when the owner stops and restores its automation's author", async () => {
    // A Logs table with a create and a delete, and no read.
    const LOGS = id(20), LOG_ID = id(21), LOG_NOTE = id(22), LOG_CREATE = id(23), LOG_DELETE = id(24);
    const withLogs = generateDatasetSources({ ...definition, tables: [...definition.tables, { tableId: LOGS, name: "Logs", sqlName: "logs", primaryKey: "id", fields: [
      { fieldId: LOG_ID, name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
      { fieldId: LOG_NOTE, name: "Note", sqlColumn: "note", type: "text", required: false, unique: false },
    ] }], operations: [...definition.operations,
      { operationId: LOG_CREATE, name: "logs.create", label: "Log", tableId: LOGS, kind: "create", access: "helper", readOnly: false, fieldIds: [LOG_NOTE] },
      { operationId: LOG_DELETE, name: "logs.delete", label: "Delete log", tableId: LOGS, kind: "delete", access: "helper", readOnly: false, fieldIds: [] }] });
    const f = await world({ sources: withLogs.files });
    // With two tables, the trigger names the one it watches.
    await f.writeAutomations(closePaid("      - add-record:\n          Note: Log\n        operation: logs.create\n").replace("field-changed: Paid", "field-changed: Paid\n      table: Invoices"));
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    const claimId = f.claims()[0]!.claimId;
    expect(await ask(f, claimId)).toEqual({ status: "confirm", preview: { ...shown, unchecked: 1 } });
    const summary = await f.executor.automationsIn("Budget");
    if (summary.status !== "read" || !summary.automations[0]?.valid) throw new Error("The automation should read.");
    const hash = definitionHash(summary.automations[0].automation);
    await expect(f.executor.undoRunsOf([{ collectionPath: "Budget", id: "close-paid", definitionHash: hash }], trash)).resolves.toMatchObject({ undone: 0, left: 1 });
    // Deletes are sent only once saved, so none was sent.
    const { runs } = await createAutomationRunStore(preparedAutomationStoreFolder(f.root)).runsOf(AUTOMATION, claimId);
    expect(runs.map((run) => [run.undo, run.undoCalls])).toEqual([[null, []]]);
    await f.executor.dispose();
  });

  it("leaves a run that would delete a record when the owner stops and restores its automation's author", async () => {
    const f = await world();
    await ranOnce(f);
    const summary = await f.executor.automationsIn("Budget");
    if (summary.status !== "read" || !summary.automations[0]?.valid) throw new Error("The automation should read.");
    const hash = definitionHash(summary.automations[0].automation);
    await expect(f.executor.undoRunsOf([{ collectionPath: "Budget", id: "close-paid", definitionHash: hash }], trash)).resolves.toMatchObject({ undone: 0, left: 1 });
    expect(await logs(f)).toHaveLength(1);
    expect((await f.executor.runs(AUTOMATION)).runs).toEqual([expect.objectContaining({ undone: false })]);
    await f.executor.dispose();
  });
});

describe("dataset automation claims in both ledgers", () => {

  it("lists both ledgers' runs as one history after a trigger edit, and reaches an engine claim for Undo and Try again", async () => {
    const f = await world();
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    const ledgerClaim = f.claims()[0]!;
    // The automation then ran on a schedule, and its run changed the same record.
    const store = createAutomationRunStore(preparedAutomationStoreFolder(f.root));
    const [ledgerRun] = (await store.runsOf(AUTOMATION, ledgerClaim.claimId)).runs;
    await store.save({ ...ledgerRun!, claimId: "atc_schedule" });
    f.engineClaims.push(engineClaim("atc_schedule", "done", ledgerClaim.createdAtMs + 1), engineClaim("atc_failed", "failed", ledgerClaim.createdAtMs - 1));
    expect(((await f.executor.runs(AUTOMATION)).runs).map((run) => run.claimId)).toEqual(["atc_schedule", ledgerClaim.claimId, "atc_failed"]);
    const trash = async () => { throw new Error("A dataset's added records stay."); };
    expect(await f.executor.undo({ automationId: AUTOMATION, claimId: "atc_schedule", deletes: null }, trash)).toMatchObject({ status: "undone", reverted: 1 });
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    expect(await f.executor.retry({ automationId: AUTOMATION, claimId: "atc_failed", startOver: false })).toEqual({ status: "queued", press: false });
    expect(f.engineRetries).toEqual(["atc_failed"]);
    await f.executor.dispose();
  });

  it("tells a Group message's author when the engine stops its dataset run's chain, and refuses to run it again", async () => {
    const f = await world();
    await f.executor.open();
    // The engine inserts a Group message's claim at the chain cap failed, and never serves it.
    const stopped: AutomationClaim = {
      ...engineClaim("atc_message", "failed", Date.now()), depth: 4, attempts: 0, error: "chain-stopped",
      change: {
        kind: "message", authorOriginId: null, actorKind: "human", onBehalfOf: "user-ana", sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0,
        message: { id: "m-1", threadId: "t", groupId: "team", lane: "posts", authorKind: "human", authorDisplayName: "Ana", createdAtMs: 1, body: "Pay it", authorUserId: "user-ana" },
      },
    };
    f.engineClaims.push(stopped);
    f.engineFailures.push({ automationId: AUTOMATION, claimId: "atc_message", chainStopped: true, error: "chain-stopped", updatedAtMs: stopped.updatedAtMs, generation: 1 });
    f.executor.failuresChanged();
    await f.until(() => f.failureReports.length === 1);
    expect(f.failureReports[0]).toMatchObject({
      failure: { claimId: "atc_message", neverStarted: true, chainStopped: true, datasetInstance: null }, startedBy: "user-ana",
    });
    expect((await f.executor.runs(AUTOMATION)).runs[0]).toMatchObject({ claimId: "atc_message", neverStarted: true, chainStopped: true });
    expect(await f.executor.retry({ automationId: AUTOMATION, claimId: "atc_message", startOver: true }))
      .toEqual({ status: "refused", reason: AUTOMATION_NEVER_STARTED_REFUSAL });
    expect(f.engineRetries).toEqual([]);
    await f.executor.dispose();
  });

  it("refuses to undo a run made before the Collection kept its records in a dataset, and marks nothing undone", async () => {
    const f = await world();
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    const store = createAutomationRunStore(preparedAutomationStoreFolder(f.root));
    const [ledgerRun] = (await store.runsOf(AUTOMATION, f.claims()[0]!.claimId)).runs;
    // An engine run from when Budget kept its records in documents.
    await store.save({ ...ledgerRun!, claimId: "atc_document", rules: null, steps: [{ ordinal: 0, effects: [{
      kind: "set", target: { recordId: "rec_one", path: "Budget/one.md", collectionPath: "Budget" },
      fields: [{ field: "Status", before: "Open", after: "Closed" }],
    }] }], applied: [{ ordinal: 0, writes: [
      { kind: "field", recordId: "rec_one", path: "Budget/one.md", field: "Status", before: "Open", after: "Closed" },
    ] }] });
    f.engineClaims.push(engineClaim("atc_document", "done", 1));
    const trash = async () => { throw new Error("Nothing moves to the trash."); };
    expect(await f.executor.undo({ automationId: AUTOMATION, claimId: "atc_document", deletes: null }, trash)).toEqual({
      status: "refused", reason: DATASET_UNDO_RULES_CHANGED,
    });
    expect((await store.runsOf(AUTOMATION, "atc_document")).runs.map((run) => run.undo)).toEqual([null]);
    await f.executor.dispose();
  });

  it("pages the runs of both ledgers together, newest first, and reads and undoes a run on any page", async () => {
    const f = await world();
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    const ledgerClaim = f.claims()[0]!;
    // The automation then ran 100 times on a schedule, after its record change.
    for (let index = 0; index < 100; index += 1) f.engineClaims.push(engineClaim(`atc_later_${index}`, "done", ledgerClaim.createdAtMs + 1 + index));
    const first = await f.executor.runs(AUTOMATION);
    expect(first.runs).toHaveLength(20);
    const listed = [...first.runs];
    for (let before = first.next; before !== null;) {
      const page = await f.executor.runs(AUTOMATION, before);
      listed.push(...page.runs);
      before = page.next;
    }
    expect(listed.map((run) => run.claimId)).toEqual([...Array.from({ length: 100 }, (_, index) => `atc_later_${99 - index}`), ledgerClaim.claimId]);
    expect(await f.executor.listedRun(AUTOMATION, ledgerClaim.claimId)).toMatchObject({ claimId: ledgerClaim.claimId, state: "done" });
    expect(await f.executor.run(AUTOMATION, ledgerClaim.claimId)).toMatchObject({ claimId: ledgerClaim.claimId, state: "done" });
    const summary = await f.executor.automationsIn("Budget");
    if (summary.status !== "read" || !summary.automations[0]?.valid) throw new Error("The automation should read.");
    const trash = async () => { throw new Error("A dataset's added records stay."); };
    await expect(f.executor.undoRunsOf([{ collectionPath: "Budget", id: "close-paid", definitionHash: definitionHash(summary.automations[0].automation) }], trash))
      .resolves.toEqual({ undone: 1, left: 0, reverted: 1, missing: 0, keptFields: [], otherKept: 0, errorMessage: null });
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    await f.executor.dispose();
  });

  it("expires saved runs 30 days after they ended, and keeps a failure a ledger may still try again or cannot answer for", async () => {
    // The dataset host stays closed: another process holds its store.
    const f = await world({ hostOpen: false, storeFails: true });
    const store = createAutomationRunStore(preparedAutomationStoreFolder(f.root));
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const saved = (claimId: string, outcome: StoredRun["outcome"], rest: Partial<StoredRun> = {}): StoredRun => ({
      durableEffects: 0, version: 13, claimId, automationId: AUTOMATION, definitionHash: "h", keySeed: "h-1", startedAtMs: old, finishedAtMs: old, steps: [],
      applied: [], created: [], replans: [], undoRequests: [], undoCalls: [], undoCovers: [], readableFields: null, collections: [], rules: null,
      superseded: false, undo: null, undoKept: [], settled: outcome?.state === "done", outcome, ...rest,
    });
    const failed = { state: "failed" as const, error: "Not yet.", run: 1, step: 0 };
    await store.save(saved("atc_done", { state: "done" }));
    // Undone since, which does not keep it longer.
    await store.save(saved("atc_undone", { state: "done" }, { undo: "done" }));
    await store.save(saved("atc_recent", { state: "done" }, { finishedAtMs: Date.now() }));
    // The engine still offers its Try again.
    await store.save(saved("atc_offered", failed));
    f.engineClaims.push(engineClaim("atc_offered", "failed", old));
    // No ledger holds it any more.
    await store.save(saved("atc_gone", failed));
    // Its dataset's ledger may hold it, and cannot say while its host is closed.
    await store.save(saved("atc_dataset", failed, { rules: { datasetId: "budget", revision: 1, revisionSha256: "r" } }));
    await f.executor.open();
    await f.until(() => f.expiries() > 0);
    const left: string[] = [];
    for (const claimId of ["atc_done", "atc_undone", "atc_recent", "atc_offered", "atc_gone", "atc_dataset"]) {
      if ((await store.runsOf(AUTOMATION, claimId)).runs.length > 0) left.push(claimId);
    }
    expect(left).toEqual(["atc_recent", "atc_offered", "atc_dataset"]);
    await f.executor.dispose();
  });
});

describe("schedules on a dataset Collection", () => {
  const SWEEP = `collection:${BUDGET}#sweep`;
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
    await f.until(() => f.host.automations.claims(`collection:${BUDGET}#note-closed`).claims[0]?.state === "done");
    expect(f.host.automations.claims(`collection:${BUDGET}#note-closed`).claims).toMatchObject([{ depth: 1 }]);
    expect((await f.record(paid))?.values[NOTES]).toBe("closed");
    await f.executor.dispose();
  });

  it("previews and deletes the record a scheduled run added, whose claim the engine holds", async () => {
    const f = await world();
    await f.writeAutomations(sweep(`      - add-record:
          Notes: Swept
          Status: Logged
        operation: invoices.create
`));
    await f.executor.open();
    expect(await runDue(f)).toMatchObject({ state: "done" });
    const logged = () => f.records().then((rows) => rows.filter((row) => row.values[STATUS] === "Logged"));
    expect(await logged()).toHaveLength(1);
    const trash = async () => { throw new Error("A dataset keeps no trash."); };
    const asked = await f.executor.undo({ automationId: SWEEP, claimId: "atc_due", deletes: null }, trash);
    expect(asked).toMatchObject({ status: "confirm", preview: { deletes: 1 } });
    if (asked.status !== "confirm") throw new Error("Undo should ask first.");
    expect(await f.executor.undo({ automationId: SWEEP, claimId: "atc_due", deletes: { token: asked.preview.token, chosen: [] } }, trash))
      .toMatchObject({ status: "undone", deleted: 1 });
    expect(await logged()).toEqual([]);
    await f.executor.dispose();
  });

  it("undoes a scheduled action through its reverse, saving the reverse before it sends it", async () => {
    const f = await world({ descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS });
    await f.writeAutomations(sweep("      - invoke: invoices.hold\n        input:\n          id: inv-1\n"));
    await f.executor.open();
    await f.create({ [id(3)]: "inv-1", [STATUS]: "Open" });
    expect(await runDue(f)).toMatchObject({ state: "done" });
    expect((await f.record("inv-1"))?.values[STATUS]).toBe("On hold");
    expect(await f.executor.undo({ automationId: SWEEP, claimId: "atc_due", deletes: null }, async () => undefined))
      .toMatchObject({ status: "undone", actionsReversed: 1, actions: 0 });
    expect((await f.record("inv-1"))?.values[STATUS]).toBe("Open");
    const { runs } = await createAutomationRunStore(preparedAutomationStoreFolder(f.root)).runsOf(SWEEP, "atc_due");
    expect(runs.flatMap((run) => run.undoCalls)).toEqual([expect.objectContaining({ kind: "reverse", operationId: RELEASE, action: HOLD })]);
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
    expect(await f.executor.undo({ automationId: SWEEP, claimId: "atc_due", deletes: null }, trash)).toMatchObject({ status: "undone", reverted: 1 });
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

  it("keeps a due time waiting, without draining again, while its approved dataset's folder does not name it", async () => {
    const f = await world();
    await f.writeAutomations(sweep(closeFound));
    const descriptor = join(f.root, "Budget", "dataset.json");
    await writeFile(descriptor, JSON.stringify({ ...JSON.parse(await readFile(descriptor, "utf8")), datasetId: id(98) }));
    await f.executor.open();
    f.engineClaims.push(engineClaim("atc_budget", "pending", due, SWEEP));
    f.executor.notifyClaimed();
    await f.until(() => f.engineClaims[0]!.attempts === 0 && f.served() >= 1);
    // Wait for the requested index read without inspecting the missing folder, which starts another read.
    const settle = async () => {
      await f.executor.idle();
      await (f.executor as unknown as { chain: Promise<void> }).chain;
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

  it("runs a waiting due time once its folder's descriptor is fixed, and settles one whose dataset this store does not hold", async () => {
    const f = await world();
    await f.writeAutomations(sweep(closeFound));
    const descriptor = join(f.root, "Budget", "dataset.json");
    const fixed = await readFile(descriptor, "utf8");
    await writeFile(descriptor, JSON.stringify({ ...JSON.parse(fixed), datasetId: id(98) }));
    await f.executor.open();
    const { id: paid } = await f.create({ [PAID]: true });
    // A due time of a dataset the store never approved names no Collection
    // here, so it settles; the approved one waits for its descriptor.
    f.engineClaims.push(engineClaim("atc_budget", "pending", due, SWEEP), engineClaim("atc_elsewhere", "pending", due + 1, `collection:${id(97)}#sweep`));
    f.executor.notifyClaimed();
    await f.until(() => f.engineClaims[0]!.state === "pending" && f.engineClaims[0]!.attempts === 0 && f.engineClaims[1]!.state === "done");
    await f.executor.idle();
    await writeFile(descriptor, fixed);
    f.executor.handleWatcherEvents([{ operation: "update", path: "Budget/dataset.json" }]);
    await f.until(() => f.engineClaims.every((claim) => claim.state === "done"));
    expect((await f.record(paid))?.values[STATUS]).toBe("Closed");
    await f.executor.dispose();
  });

  it("says a schedule runs on another computer when this one keeps the records, and runs it here once this one is the host", async () => {
    const elsewhere = await world();
    await elsewhere.writeAutomations(sweep(closeFound));
    await elsewhere.executor.open();
    expect(await elsewhere.executor.automationsIn("Budget")).toMatchObject({ automations: [{ cannotRun: expect.stringMatching(/^Schedules and Group messages run on another computer/) }] });
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
    const elsewhere = "This computer does not keep this automation's Collection. Run it from the computer that keeps it.";
    expect(await f.executor.runNowRefusal(`collection:${id(98)}#sweep`)).toBe(elsewhere);
    expect(await f.executor.runNowRefusal(SWEEP)).toBeNull();
    expect(await f.executor.runNowRefusal("collection:Tasks#stamp"), "nor a document Collection it does not have").toBe(elsewhere);
    await f.executor.dispose();
  });
});
