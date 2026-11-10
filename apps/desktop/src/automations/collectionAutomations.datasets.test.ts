import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished } from "vitest";
import { datasetPrincipalKey } from "@dohc/security-contract/dataset-artifacts";
import { AUTOMATION_NEVER_STARTED_REFUSAL } from "@dohc/app-backend-runtime/dataset-automation-claims";
import { type Automation } from "@dohc/workspace-contracts/automations";
import { retryAutomationRun } from "./automationNotices";
import { type AutomationFormulaEvaluator } from "@dohc/automation-executor/automation-evaluator-host";
import { type ReachRoster } from "@dohc/automation-executor/automation-reach";
import { createAutomationRunStore } from "@dohc/automation-executor/automation-run-store";
import { preparedAutomationStoreFolder } from "../testing/preparedLocalState";
import { UNDONE_RUN_ERROR } from "@dohc/automation-executor/collection-automation-run";
import { definitionHash } from "@dohc/automation-executor/automation-plan";
import { DATASET_UNDO_RULES_CHANGED } from "@dohc/automation-executor/dataset-automation-undo";
import { datasetAutomationFixture } from "./collectionAutomationDatasetTestSupport";

const { id, OWNER, UNKNOWN, BUDGET, AUTOMATION, TABLE, PAID, STATUS, NOTES, LIST, EDIT, STATUS_ONLY, REMOVE, definition, files, closePaid, sharedEvaluator, AUTHORED_OPERATIONS, world } = datasetAutomationFixture();

describe("Collection automations on a dataset", () => {
  it.each(["waits", "fails"] as const)("stops claiming a Collection here once it is fenced to move to a server, while its import %s", async (end) => {
    const f = await world();
    await f.writeAutomations(closePaid() + `  - id: nightly
    name: Nightly
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
    await f.executor.open();
    onTestFinished(() => f.executor.dispose());
    expect(f.host.automations.subscriptions()).toHaveLength(1);
    expect(f.executor.schedules()).toHaveLength(1);
    const reached = Promise.withResolvers<void>(), answer = Promise.withResolvers<void>();
    const transfer = f.host.transferToShared({ datasetId: BUDGET, targetOrigin: "https://relay.example", target: { async importRecovery() {
      reached.resolve();
      await answer.promise;
      throw new Error("The server stopped answering.");
    } } });
    await reached.promise;
    // The fence is durable and the server has not answered: nothing here claims the Collection's changes or due times.
    await f.until(() => f.host.automations.subscriptions().length === 0 && f.executor.schedules()?.length === 0);
    if (end === "fails") {
      answer.resolve();
      await expect(transfer).rejects.toThrow("stopped answering");
      // The failed end reconciles again, and the Collection stays fenced and unclaimed here.
      await f.executor.idle();
      await f.executor.automationsIn("Budget");
      expect(f.host.transferStatus(BUDGET)?.state).toBe("ready");
      expect(f.host.automations.subscriptions()).toEqual([]);
      expect(f.executor.schedules()).toEqual([]);
    } else {
      expect(f.host.transferStatus(BUDGET)?.state).toBe("ready");
      answer.resolve();
      await transfer.catch(() => undefined);
    }
    expect(f.errors).toEqual([]);
  });

  it.each(["failed reload", "dataset move"] as const)("retries a dataset press after a %s index read", async change => {
    const f = await world();
    await f.writeAutomations(closePaid().replace("field-changed: Paid", "button: Mark paid"));
    const reached = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
    const indexReached = Promise.withResolvers<void>(), indexResume = Promise.withResolvers<void>();
    let paused = false, indexing = false, releases = 0;
    const auxiliary = { ...definition, datasetId: id(300), schemaPath: "Aux/schema.sql", operationsPath: "Aux/operations.js" };
    const relocated = { ...definition, schemaPath: "Shared/Budget/schema.sql", operationsPath: "Shared/Budget/operations.js" };
    let definitions = [definition];
    await mkdir(join(f.root, "Aux"));
    await writeFile(join(f.root, "Aux/dataset.json"), JSON.stringify({ datasetId: auxiliary.datasetId }));
    const base = createAutomationRunStore(preparedAutomationStoreFolder(f.root));
    const executor = f.makeExecutor({
      store: { ...base, runsOf: async (...args) => {
        if (!paused && f.claims().some(c => c.state === "running")) { paused = true; reached.resolve(); await resume.promise; }
        return base.runsOf(...args);
      } },
      withDatasetHost: async work => work({ ...f.host.automations,
        release: claim => { f.host.automations.release(claim); releases += 1; },
        datasets: () => ({ definitions, failures: [] }),
        revision: datasetId => ({ ...f.approved, definition: definitions.find(d => d.datasetId === datasetId)! }),
        generated: () => true,
        dataGrants: datasetId => datasetId === auxiliary.datasetId ? { workspaceId: "workspace", grants: [] } : f.host.automations.dataGrants(datasetId),
      }),
      readText: async path => {
        if (indexing && path === "Aux/automations.yaml") { indexReached.resolve(); await indexResume.promise; }
        if (indexing && change === "failed reload" && path === "Budget/collection.yaml") {
          indexing = false;
          throw new Error("Schema read failed.");
        }
        return f.readText(path);
      },
    });
    onTestFinished(async () => { resume.resolve(); indexResume.resolve(); await executor.dispose(); });
    await executor.open();
    await executor.idle();
    const { id: invoice } = await f.create({ [PAID]: false, [STATUS]: "Open" });
    const pressed = await executor.pressDataset({ datasetId: BUDGET, table: "Invoices", field: "Mark paid", recordId: JSON.stringify(invoice),
      pressId: id(301), pressedBy: "user-owner", by: { kind: "human" }, confirmed: [] }, async datasetId => f.host.describe(datasetId), () => undefined);
    expect(pressed.busy).toBe(false);
    await reached.promise;
    if (change === "dataset move") {
      await mkdir(join(f.root, "Shared"));
      await rename(join(f.root, "Budget"), join(f.root, "Shared/Budget"));
    }
    definitions = [auxiliary, change === "dataset move" ? relocated : definition];
    indexing = true;
    const reload = change === "failed reload"
      ? executor.resyncFileObservation().then(() => null, error => error)
      : (executor.datasetsChanged(), executor.automationsIn("Shared/Budget"));
    await indexReached.promise;
    expect(executor.locate(AUTOMATION)).toBeNull();
    resume.resolve();
    await expect.poll(() => f.claims()[0]?.state).toBe("pending");
    // Another claim notification must not settle the temporarily missing source.
    executor.notifyClaimed();
    await expect.poll(() => releases).toBeGreaterThanOrEqual(2);
    expect(f.claims()[0]?.state).toBe("pending");
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    indexResume.resolve();
    await reload;
    if (change === "failed reload") expect(f.errors).toContainEqual({ context: "reload Collection automations", error: new Error("Schema read failed.") });
    await expect.poll(() => f.claims()[0]?.state).toBe("done");
    expect((await f.record(invoice))?.values[STATUS]).toBe("Closed");
  });

  it("reports a missing trigger field instead of showing an automation that cannot subscribe as runnable", async () => {
    const f = await world();
    await f.writeAutomations(closePaid().replace("field-changed: Paid", "field-changed: Missing"));
    await f.executor.open();
    expect(await f.executor.automationsIn("Budget")).toMatchObject({ automations: [{ cannotRun: "Invoices has no field named Missing." }] });
    await f.executor.dispose();
  });

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

  it("sends a chain stop's notice as its commit makes it, with nothing else to wake it, and offers no Try again", async () => {
    const f = await world();
    await f.writeAutomations(closePaid());
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    // An agent woken three automations deep writes at depth 4 through the dataset.
    const current = await f.record(invoice);
    await f.host.action({ ...f.rules, operationId: EDIT, input: { id: invoice, expectedVersion: current!.version, values: { [PAID]: true } },
      idempotencyKey: "agent-deep", agent: { depth: 4 } });
    await f.until(() => f.failureReports.length === 1);
    expect(f.failureReports).toEqual([{
      failure: expect.objectContaining({ automationId: AUTOMATION, neverStarted: true, chainStopped: true, error: "chain-stopped", generation: 1 }),
      name: "Close paid invoices",
      collectionPath: "Budget",
      // An agent's change does not select a recipient for the failure notice.
      startedBy: null,
      replaces: null,
      ownerSwitchesOnly: false,
    }]);
    expect(f.claims()).toEqual([expect.objectContaining({ state: "failed", attempts: 0, depth: 4 })]);
    const [run] = (await f.executor.runs(AUTOMATION)).runs;
    expect(run).toMatchObject({ state: "failed", neverStarted: true, chainStopped: true });
    await expect(f.executor.run(AUTOMATION, run!.claimId)).resolves.toMatchObject({ failedStep: null, startsOver: false });
    const refused = { status: "refused", reason: AUTOMATION_NEVER_STARTED_REFUSAL };
    await expect(f.executor.retry({ automationId: AUTOMATION, claimId: run!.claimId, startOver: true })).resolves.toEqual(refused);
    // The CLI and MCP ask as main wires them: this computer holds the run, so its executor answers.
    await expect(retryAutomationRun({
      notices: { sentFailure: async () => null },
      installId: "install-a",
      holds: async (held) => (await f.executor.run(held.automationId, held.claimId)) !== null,
      recovery: (automationId) => f.executor.switchedOffTarget(automationId),
      retry: (held) => f.executor.retry(held),
    }, { workspaceId: "workspace", automationId: AUTOMATION, claimId: run!.claimId, startOver: false })).resolves.toEqual(refused);
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    await f.executor.dispose();
  });

  it("sends a chain stop's notice at the next open when its commit's wake was lost, and once across a restart", async () => {
    const f = await world();
    await f.writeAutomations(closePaid());
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    await f.executor.dispose();
    // No executor hears this commit.
    const deep = async (paid: boolean, key: string) => {
      const current = await f.record(invoice);
      await f.host.action({ ...f.rules, operationId: EDIT, input: { id: invoice, expectedVersion: current!.version, values: { [PAID]: paid } },
        idempotencyKey: key, agent: { depth: 4 } });
    };
    await deep(true, "agent-deep");
    expect(f.failureReports).toEqual([]);
    f.makeExecutor();
    await f.executor.open();
    await f.until(() => f.failureReports.length === 1);
    expect(f.failureReports[0]?.failure).toMatchObject({ chainStopped: true, generation: 1 });
    const store = createAutomationRunStore(preparedAutomationStoreFolder(f.root));
    await f.until(async () => (await store.readReportedFailures()).some((entry) => entry.generation === 1 && entry.open));
    // After a restart, only the next stop sends a notice.
    await f.executor.dispose();
    f.makeExecutor();
    await f.executor.open();
    await deep(false, "agent-deeper");
    await f.until(() => f.failureReports.length === 2);
    expect(f.failureReports[1]?.failure).toMatchObject({ chainStopped: true, generation: 2 });
    await f.executor.dispose();
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
    expect(f.claims()[0]?.error).toMatch(/The formula can read only this record's id, not Status\./);
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
    const [run] = (await createAutomationRunStore(preparedAutomationStoreFolder(f.root)).runsOf(AUTOMATION, f.claims()[0]!.claimId)).runs;
    expect(run!.applied).toEqual([expect.objectContaining({ ordinal: 0, writes: [expect.objectContaining({
      kind: "dataset-edit", operationId: STATUS_ONLY, recordId: invoice, fields: [{ fieldId: STATUS, field: "Status", before: "Open", after: "Closed" }],
    })] })]);
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

  it("gives a change's run the person who made it, never the dataset's owner key, and carries them on", async () => {
    const f = await world();
    // Paid starts a run that names its person in Notes; that write starts a run that names its person in Status.
    await f.writeAutomations(`${closePaid("      - set:\n          Notes: '=person.name'\n        operation: invoices.edit\n")}  - id: status-by
    name: Status by
    when:
      field-changed: Notes
    do:
      - set:
          Status: '=person == null ? "nobody" : person.name'
        operation: invoices.status
`);
    await f.executor.open();
    const { id: invoice } = await f.create({ [PAID]: false, [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done" || f.claims()[0]?.state === "failed");
    await f.until(async () => (await f.record(invoice))?.values[STATUS] === "Person person-local");
    expect((await f.record(invoice))?.values[NOTES]).toBe("Person person-local");
    expect(f.claims()[0]?.actor).toEqual({ kind: "owner", userId: "person-local" });
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

  it("gives each step what the steps before it wrote: a Find sees a status just set, and an added record reads with its values", async () => {
    const f = await world();
    await f.writeAutomations(closePaid(`      - set:
          Status: Closed
        operation: invoices.status
      - find: record.Status == "Closed"
        as: closed
        operation: invoices.list
      - add-record:
          Notes: '="Closed " + closed.length'
          Status: Logged
        as: log
        operation: invoices.create
      - find: record.Notes == log.Notes
        as: logs
        operation: invoices.list
      - set:
          Notes: '=log.Notes + " / " + logs.length + " / " + log.Paid'
        operation: invoices.edit
`));
    await f.executor.open();
    const invoice = await f.create({ [NOTES]: "first" });
    await f.create({ [NOTES]: "other" });
    await f.edit(invoice.id, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    const rows = await f.records();
    // The added record reads with the default its Collection gave Paid.
    expect(rows.find((row) => row.id === invoice.id)?.values).toMatchObject({ [STATUS]: "Closed", [NOTES]: "Closed 1 / 1 / false" });
    expect(rows.filter((row) => row.values[STATUS] === "Logged").map((row) => row.values[NOTES])).toEqual(["Closed 1"]);
    await f.executor.dispose();
  });

  it("sends a stale edit again at the record's new version, and keeps a field someone else changed", async () => {
    let interfere: (() => Promise<void>) | null = null;
    const base = sharedEvaluator.forWorkspace("workspace");
    // Someone edits the record after the run read it and before it writes.
    const evaluator: AutomationFormulaEvaluator = {
      runCode: base.runCode,
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
    const [run] = (await createAutomationRunStore(preparedAutomationStoreFolder(f.root)).runsOf(AUTOMATION, f.claims()[0]!.claimId)).runs;
    expect(run!.replans).toEqual([expect.objectContaining({ effect: 0, replan: 1, fields: [expect.objectContaining({ fieldId: STATUS })] })]);
    expect(run!.applied[0]!.writes).toEqual([
      { kind: "dataset-kept", datasetId: definition.datasetId, tableId: TABLE, recordId: invoice, fieldId: NOTES, field: "Notes", planned: "Closed by automation", current: "someone else" },
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
      collectionPath: "Budget",
      startedBy: "person-local",
      replaces: null,
      ownerSwitchesOnly: false,
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
    await expect(f.executor.runs(AUTOMATION)).resolves.toEqual({ runs: [], next: null });
    expect(f.opened).toContain(true);
    expect(f.host.automations.subscriptions()).toHaveLength(1);
    // Try again finds the automation in the dataset's ledger, not "no longer in automations.yaml".
    await expect(f.executor.retry({ automationId: AUTOMATION, claimId: "dac_unknown", startOver: false }))
      .resolves.toEqual({ status: "refused", reason: "Run history no longer shows this run, so dohc will not run it again." });
    await f.executor.dispose();
  });

  it("names the dataset a Collection folder holds, opening a closed host, and none for a document folder", async () => {
    const f = await world({ hostOpen: false });
    await f.executor.open();
    await expect(f.executor.datasetIn("Budget")).resolves.toBe(definition.datasetId);
    expect(f.opened).toContain(true);
    await expect(f.executor.datasetIn("Notes")).resolves.toBeNull();
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

  it.each(["unavailable", "generated", "grants"] as const)("keeps dataset identity and releases a pending claim when index metadata fails: %s", async (failure) => {
    const f = await world();
    await f.executor.open();
    await f.executor.dispose();
    const { id: invoice } = await f.create({});
    await f.edit(invoice, { [PAID]: true });
    expect(f.claims()).toMatchObject([{ state: "pending" }]);
    f.failNextMetadata(failure);
    f.makeExecutor();
    await f.executor.open();
    await f.until(() => f.claims()[0]?.state === "pending" && f.errors.length > 0);
    expect(f.failureReports).toEqual([]);
    expect(f.errors).toContainEqual({ context: `read dataset ${definition.datasetId}'s operations`, error: expect.any(Error) });
    expect(f.claims()).toMatchObject([{ state: "pending" }]);
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    await expect(f.executor.datasetIn("Budget")).resolves.toBe(definition.datasetId);
    f.executor.datasetsChanged();
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
      runCode: base.runCode,
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
      runCode: base.runCode,
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
    // The newest page of run history holds 20.
    for (let index = 0; index <= 20; index += 1) await setPaid(index % 2 === 1);
    await f.until(() => f.claims().filter((claim) => claim.state === "done").length >= 20);
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
    const [run] = (await f.executor.runs(AUTOMATION)).runs;
    expect(run!.writes).toEqual([expect.objectContaining({ kind: "dataset-edit" }), { kind: "message", messageId: f.messages[0]!.messageId, name: "Team" }]);
    await f.executor.dispose();
  });

  it("stops a post an editor could not make, before it changes anything, and the ⚡ panel says why", async () => {
    const ana = { grantId: "g-ana", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", files: { paths: ["Budget"], versionId: null, access: "edit" as const }, channel: null };
    const f = await world({ roster: { kind: "owner", ownerUserId: "user-owner", grants: [ana] } });
    // Ana may use every operation the run calls, and cannot post in Team.
    const store = new DatabaseSync(join(f.root, ".dohc", "local", "datasets", "state.sqlite"));
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

  it.each([undefined, AUTHORED_OPERATIONS])("wakes the sole editor's agent from a field change on generated or authored operations", async (operations) => {
    const f = await world({ operations });
    await f.writeAutomations(closePaid("      - wake-agent: Look at this invoice\n        person: user-owner\n"));
    await f.executor.open();
    expect(await f.executor.automationsIn("Budget")).toMatchObject({ automations: [{ cannotRun: null }] });
    const { id: invoice } = await f.create({});
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    expect(f.messages).toEqual([expect.objectContaining({ target: { kind: "agent" }, automation: { automationId: AUTOMATION, name: "Close paid invoices", depth: 1 } })]);
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

  it("names held dataset operations by their label", async () => {
    const ana = { grantId: "g-ana", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", files: { paths: ["Budget"], versionId: null, access: "edit" as const }, channel: null };
    const f = await world({ roster: { kind: "owner", ownerUserId: "user-owner", grants: [ana] } });
    await f.executor.open();
    await f.executor.automationsIn("Budget");
    f.setRoster(OWNER);
    f.executor.rosterChanged();
    await f.until(() => f.executor.holds().some((hold) => hold.step === JSON.stringify(["operation", definition.datasetId, STATUS_ONLY])));
    expect(f.executor.holds()).toEqual(expect.arrayContaining([expect.objectContaining({
      step: JSON.stringify(["operation", definition.datasetId, STATUS_ONLY]), operationName: "Set status",
    })]));
    await f.executor.dispose();
  });

  it("holds a run when a field becomes readable only because an editor left, until a current editor allows it", async () => {
    const ana = { grantId: "g-ana", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", files: { paths: ["Budget"], versionId: null, access: "edit" as const }, channel: null };
    const withAna: ReachRoster = { kind: "owner", ownerUserId: "user-owner", grants: [ana] };
    const f = await world({ roster: withAna });
    // Ana may use the list and the status edit, which show every field but ID.
    const store = new DatabaseSync(join(f.root, ".dohc", "local", "datasets", "state.sqlite"));
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
    await f.until(() => f.claims()[0]?.state === "pending" && f.host.automations.claims(AUTOMATION).claims[0]?.attempts === 0);
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    expect(await f.executor.confirmReach(hold!)).toBe("confirmed");
    await f.until(async () => (await f.record(invoice))?.values[STATUS] === "Closed");
    await f.executor.dispose();
  });

  it("keeps a held field held when a schema change removes a field before it", async () => {
    const ana = { grantId: "g-ana", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", files: { paths: ["Budget"], versionId: null, access: "edit" as const }, channel: null };
    const f = await world({ roster: { kind: "owner", ownerUserId: "user-owner", grants: [ana] } });
    const store = new DatabaseSync(join(f.root, ".dohc", "local", "datasets", "state.sqlite"));
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
    const fieldStep = (fieldId: string) => JSON.stringify(["field", definition.datasetId, TABLE, fieldId]);
    const heldFields = () => f.executor.holds().map((hold) => hold.step).filter((step) => step.startsWith('["field",')).sort();
    await f.until(() => heldFields().length === 2);
    expect(heldFields()).toEqual([fieldStep(id(3)), fieldStep(SECRET)]);
    // An approved schema change removes Spare. Secret stays held.
    const withoutSpare = structuredClone(withSpare);
    withoutSpare.tables[0]!.fields = withoutSpare.tables[0]!.fields.filter((field) => field.fieldId !== SPARE);
    withoutSpare.operations = withoutSpare.operations.map((operation) => ({ ...operation, fieldIds: operation.fieldIds.filter((fieldId) => fieldId !== SPARE) }));
    const steps = async () => ((await f.executor.automationsIn("Budget")) as { automations: Array<{ reach: { steps?: unknown[] } }> }).automations[0]!.reach.steps?.length;
    expect(await steps()).toBe(9);
    f.changeRules(withoutSpare);
    // Two operations and six fields, once the change is indexed.
    await f.until(async () => await steps() === 8);
    expect(heldFields()).toEqual([fieldStep(id(3)), fieldStep(SECRET)]);
    await f.executor.dispose();
  });

  it("undoes a run's edits as the person, keeping fields someone changed since, and deletes the record it added once the person confirms", async () => {
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
    expect(await f.executor.automationsIn("Budget")).toMatchObject({ addsStay: [] });
    const { id: invoice } = await f.create({ [STATUS]: "Open", [NOTES]: "draft" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    const claimId = f.claims()[0]!.claimId;
    // The run recorded the delete an Undo may use on the record it added.
    const [listed] = (await f.executor.runs(AUTOMATION)).runs;
    expect(listed!.writes).toEqual([
      expect.objectContaining({ kind: "dataset-edit", recordId: invoice, expectedVersion: 2, version: 3 }),
      expect.objectContaining({ kind: "dataset-created", deletes: [REMOVE] }),
    ]);
    // Someone changes Notes after the run: Undo keeps it, and puts Status back.
    await f.edit(invoice, { [NOTES]: "mine" });
    const trash = async () => { throw new Error("A dataset keeps no trash."); };
    // First, what Undo will do. Nothing is saved or sent yet.
    const asked = await f.executor.undo({ automationId: AUTOMATION, claimId, deletes: null }, trash);
    expect(asked).toEqual({
      status: "confirm", preview: { deletes: 1, unchecked: 0, kept: 0, keptChanged: 0, gone: 0, reverts: 2, irreversible: 0, reverses: 0, actions: 0, choices: [], token: expect.any(String) },
    });
    if (asked.status !== "confirm") throw new Error("Undo should ask first.");
    const store = createAutomationRunStore(preparedAutomationStoreFolder(f.root));
    expect((await store.runsOf(AUTOMATION, claimId)).runs.map((run) => [run.undo, run.undoCalls])).toEqual([[null, []]]);
    expect((await f.records()).some((row) => row.values[NOTES] === "Log")).toBe(true);
    expect(await f.executor.undo({ automationId: AUTOMATION, claimId, deletes: { token: asked.preview.token, chosen: [] } }, trash)).toEqual({
      status: "undone", reverted: 1, removed: 0, deleted: 1, kept: 0, keptChanged: 0, gone: 0, changedSince: 1, missing: 0, irreversible: 0, actions: 0, actionsReversed: 0,
    });
    expect((await f.record(invoice))?.values).toMatchObject({ [STATUS]: "Open", [NOTES]: "mine", [PAID]: true });
    expect((await f.records()).some((row) => row.values[NOTES] === "Log")).toBe(false);
    // The owner undid it, not the automation.
    expect(f.host.history({ datasetId: definition.datasetId }).entries[0]).not.toHaveProperty("automation");
    // Run history does not show it fully undone, since Notes kept a later
    // value; Undo points to History, and Try again does not run it again.
    expect((await f.executor.runs(AUTOMATION)).runs).toEqual([expect.objectContaining({ claimId, undone: false })]);
    expect(await f.executor.undo({ automationId: AUTOMATION, claimId, deletes: null }, trash)).toEqual({
      status: "refused", reason: "dohc kept the fields someone changed after this run. Restore them from each record's History.",
    });
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
    await expect(f.executor.undoRunsOf([{ collectionPath: "Budget", id: "close-paid", definitionHash: hash }], trash)).resolves.toMatchObject({ undone: 1, left: 0, keptFields: [], errorMessage: null });
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    expect((await f.executor.runs(AUTOMATION)).runs).toEqual([expect.objectContaining({ undone: true })]);
    await f.executor.dispose();
  });

  it("counts one dataset field changed since the run once when stopping and restoring", async () => {
    const f = await world();
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    await f.edit(invoice, { [STATUS]: "Changed later" });
    const summary = await f.executor.automationsIn("Budget");
    if (summary.status !== "read" || !summary.automations[0]?.valid) throw new Error("The automation should read.");
    const result = await f.executor.undoRunsOf([
      { collectionPath: "Budget", id: "close-paid", definitionHash: definitionHash(summary.automations[0].automation) },
    ], async () => { throw new Error("Nothing moves to the trash."); });
    expect(result).toMatchObject({ undone: 1, left: 0, reverted: 0, missing: 0, otherKept: 0, errorMessage: null });
    expect(result.keptFields).toEqual([{ id: expect.stringMatching(/^[a-f0-9]{32}$/), path: "Budget", recordId: invoice, field: "Status" }]);
    expect(result.keptFields.length + result.missing + result.otherKept).toBe(1);
    expect((await f.record(invoice))?.values[STATUS]).toBe("Changed later");
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
    expect(await f.executor.undo({ automationId: AUTOMATION, claimId, deletes: null }, async () => undefined))
      .toEqual({ status: "refused", reason: DATASET_UNDO_RULES_CHANGED });
    expect((await f.record(invoice))?.values[STATUS]).toBe("Closed");
    // Nothing marks the run undone, so it still reads as a run that can be undone later.
    const { runs } = await createAutomationRunStore(preparedAutomationStoreFolder(f.root)).runsOf(AUTOMATION, claimId);
    expect(runs.map((run) => run.undo)).toEqual([null]);
    await f.executor.dispose();
  });
});
