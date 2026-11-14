import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished } from "vitest";
import { datasetPrincipalKey } from "@dohc/security-contract/dataset-artifacts";

import { type AutomationFormulaEvaluator } from "@dohc/automation-executor/automation-evaluator-host";
import { type ReachRoster } from "@dohc/automation-executor/automation-reach";
import { createAutomationRunStore } from "@dohc/automation-executor/automation-run-store";
import { preparedAutomationStoreFolder } from "../testing/preparedLocalState";
import { UNDONE_RUN_ERROR } from "@dohc/automation-executor/collection-automation-run";

import { datasetAutomationFixture } from "./collectionAutomationDatasetTestSupport";

const {
  id,
  OWNER,
  BUDGET,
  AUTOMATION,
  TABLE,
  PAID,
  STATUS,
  NOTES,
  LIST,
  EDIT,
  STATUS_ONLY,
  REMOVE,
  definition,
  closePaid,
  sharedEvaluator,
  AUTHORED_OPERATIONS,
  world,
} = datasetAutomationFixture();

describe("Collection automations on a dataset", () => {
  it("stops claiming a Collection fenced for a server move, including after its import fails", async () => {
    const f = await world();
    await f.writeAutomations(
      closePaid() +
        `  - id: nightly
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
`,
    );
    await f.executor.open();
    onTestFinished(() => f.executor.dispose());
    expect(f.host.automations.subscriptions()).toHaveLength(1);
    expect(f.executor.schedules()).toHaveLength(1);
    const reached = Promise.withResolvers<void>(),
      answer = Promise.withResolvers<void>();
    const transfer = f.host.transferToShared({
      datasetId: BUDGET,
      targetOrigin: "https://relay.example",
      target: {
        async importRecovery() {
          reached.resolve();
          await answer.promise;
          throw new Error("The server stopped answering.");
        },
      },
    });
    await reached.promise;
    // The fence is durable and the server has not answered: nothing here claims the Collection's changes or due times.
    await f.until(
      () => f.host.automations.subscriptions().length === 0 && f.executor.schedules()?.length === 0,
    );
    answer.resolve();
    await expect(transfer).rejects.toThrow("stopped answering");
    // The failed import leaves the durable fence in place.
    await f.executor.idle();
    await f.executor.automationsIn("Budget");
    expect(f.host.transferStatus(BUDGET)?.state).toBe("ready");
    expect(f.host.automations.subscriptions()).toEqual([]);
    expect(f.executor.schedules()).toEqual([]);
    expect(f.errors).toEqual([]);
  });

  it.each(["failed reload", "dataset move"] as const)(
    "retries a dataset press after a %s index read",
    async (change) => {
      const f = await world();
      await f.writeAutomations(closePaid().replace("field-changed: Paid", "button: Mark paid"));
      const reached = Promise.withResolvers<void>(),
        resume = Promise.withResolvers<void>();
      const indexReached = Promise.withResolvers<void>(),
        indexResume = Promise.withResolvers<void>();
      let paused = false,
        indexing = false,
        releases = 0;
      const auxiliary = {
        ...definition,
        datasetId: id(300),
        schemaPath: "Aux/schema.sql",
        operationsPath: "Aux/operations.js",
      };
      const relocated = {
        ...definition,
        schemaPath: "Shared/Budget/schema.sql",
        operationsPath: "Shared/Budget/operations.js",
      };
      let definitions = [definition];
      await mkdir(join(f.root, "Aux"));
      await writeFile(
        join(f.root, "Aux/dataset.json"),
        JSON.stringify({ datasetId: auxiliary.datasetId }),
      );
      const base = createAutomationRunStore(preparedAutomationStoreFolder(f.root));
      const executor = f.makeExecutor({
        store: {
          ...base,
          runsOf: async (...args) => {
            if (!paused && f.claims().some((c) => c.state === "running")) {
              paused = true;
              reached.resolve();
              await resume.promise;
            }
            return base.runsOf(...args);
          },
        },
        withDatasetHost: async (work) =>
          work({
            ...f.host.automations,
            release: (claim) => {
              f.host.automations.release(claim);
              releases += 1;
            },
            datasets: () => ({ definitions, failures: [] }),
            revision: (datasetId) => ({
              ...f.approved,
              definition: definitions.find((d) => d.datasetId === datasetId)!,
            }),
            generated: () => true,
            dataGrants: (datasetId) =>
              datasetId === auxiliary.datasetId
                ? { workspaceId: "workspace", grants: [] }
                : f.host.automations.dataGrants(datasetId),
          }),
        readText: async (path) => {
          if (indexing && path === "Aux/automations.yaml") {
            indexReached.resolve();
            await indexResume.promise;
          }
          if (indexing && change === "failed reload" && path === "Budget/collection.yaml") {
            indexing = false;
            throw new Error("Schema read failed.");
          }
          return f.readText(path);
        },
      });
      onTestFinished(async () => {
        resume.resolve();
        indexResume.resolve();
        await executor.dispose();
      });
      await executor.open();
      await executor.idle();
      const { id: invoice } = await f.create({ [PAID]: false, [STATUS]: "Open" });
      const pressed = await executor.pressDataset(
        {
          datasetId: BUDGET,
          table: "Invoices",
          field: "Mark paid",
          recordId: JSON.stringify(invoice),
          pressId: id(301),
          pressedBy: "user-owner",
          by: { kind: "human" },
          confirmed: [],
        },
        async (datasetId) => f.host.describe(datasetId),
        () => undefined,
      );
      expect(pressed.busy).toBe(false);
      await reached.promise;
      if (change === "dataset move") {
        await mkdir(join(f.root, "Shared"));
        await rename(join(f.root, "Budget"), join(f.root, "Shared/Budget"));
      }
      definitions = [auxiliary, change === "dataset move" ? relocated : definition];
      indexing = true;
      const reload =
        change === "failed reload"
          ? executor.resyncFileObservation().then(
              () => null,
              (error) => error,
            )
          : (executor.datasetsChanged(), executor.automationsIn("Shared/Budget"));
      await indexReached.promise;
      expect(executor.locate(AUTOMATION)).toBeNull();
      resume.resolve();
      await expect.poll(() => f.claims()[0]?.state).toBe("pending");
      executor.notifyClaimed();
      await expect.poll(() => releases).toBeGreaterThanOrEqual(2);
      expect(f.claims()[0]?.state).toBe("pending");
      expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
      indexResume.resolve();
      await reload;
      if (change === "failed reload")
        expect(f.errors).toContainEqual({
          context: "reload Collection automations",
          error: new Error("Schema read failed."),
        });
      await expect.poll(() => f.claims()[0]?.state).toBe("done");
      expect((await f.record(invoice))?.values[STATUS]).toBe("Closed");
    },
  );

  it("sends a chain stop's notice at the next open when its commit's wake was lost, and once across a restart", async () => {
    const f = await world();
    await f.writeAutomations(closePaid());
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    await f.executor.dispose();
    const deep = async (paid: boolean, key: string) => {
      const current = await f.record(invoice);
      await f.host.action({
        ...f.rules,
        operationId: EDIT,
        input: { id: invoice, expectedVersion: current!.version, values: { [PAID]: paid } },
        idempotencyKey: key,
        agent: { depth: 4 },
      });
    };
    await deep(true, "agent-deep");
    expect(f.failureReports).toEqual([]);
    f.makeExecutor();
    await f.executor.open();
    await f.until(() => f.failureReports.length === 1);
    expect(f.failureReports[0]?.failure).toMatchObject({ chainStopped: true, generation: 1 });
    const store = createAutomationRunStore(preparedAutomationStoreFolder(f.root));
    await f.until(async () =>
      (await store.readReportedFailures()).some((entry) => entry.generation === 1 && entry.open),
    );
    await f.executor.dispose();
    f.makeExecutor();
    await f.executor.open();
    await deep(false, "agent-deeper");
    await f.until(() => f.failureReports.length === 2);
    expect(f.failureReports[1]?.failure).toMatchObject({ chainStopped: true, generation: 2 });
    await f.executor.dispose();
  });

  it("stops a run whose formula reads a field dohc did not read, instead of reading it as empty", async () => {
    const f = await world({ operations: AUTHORED_OPERATIONS });
    await f.writeAutomations(
      closePaid(
        '      - if: record.Status == "Open"\n        do:\n          - notify: Open\n            to: [user-owner]\n        otherwise:\n          - notify: Not open\n            to: [user-owner]\n',
      ),
    );
    await f.executor.open();
    const { id: invoice } = await f.create({ [PAID]: false, [STATUS]: "Open" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "failed");
    expect(f.claims()[0]?.error).toMatch(
      /The formula can read only this record's id, not Status\./,
    );
    expect(f.notices).toEqual([]);
  });

  it("sends a stale edit again at the record's new version, and keeps a field someone else changed", async () => {
    let interfere: (() => Promise<void>) | null = null;
    const base = sharedEvaluator.forWorkspace("workspace");
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
    await f.writeAutomations(
      closePaid(`      - set:
          Status: =record.Status + " and paid"
          Notes: Closed by automation
        operation: invoices.edit
`),
    );
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open", [NOTES]: "draft" });
    interfere = () => f.edit(invoice, { [NOTES]: "someone else" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    // Status was still as the run read it, so it was sent again; Notes keeps their change.
    expect((await f.record(invoice))?.values).toMatchObject({
      [STATUS]: "Open and paid",
      [NOTES]: "someone else",
    });
    const [run] = (
      await createAutomationRunStore(preparedAutomationStoreFolder(f.root)).runsOf(
        AUTOMATION,
        f.claims()[0]!.claimId,
      )
    ).runs;
    expect(run!.replans).toEqual([
      expect.objectContaining({
        effect: 0,
        replan: 1,
        fields: [expect.objectContaining({ fieldId: STATUS })],
      }),
    ]);
    expect(run!.applied[0]!.writes).toEqual([
      {
        kind: "dataset-kept",
        datasetId: definition.datasetId,
        tableId: TABLE,
        recordId: invoice,
        fieldId: NOTES,
        field: "Notes",
        planned: "Closed by automation",
        current: "someone else",
      },
      expect.objectContaining({
        kind: "dataset-edit",
        fields: [{ fieldId: STATUS, field: "Status", before: "Open", after: "Open and paid" }],
      }),
    ]);
    await f.executor.dispose();
  });

  it("holds a run when a field becomes readable only because an editor left, until a current editor allows it", async () => {
    const ana = {
      grantId: "g-ana",
      recipientUserId: "u-ana",
      recipientEmail: "ana@dohc.test",
      files: { paths: ["Budget"], versionId: null, access: "edit" as const },
      channel: null,
    };
    const withAna: ReachRoster = { kind: "owner", ownerUserId: "user-owner", grants: [ana] };
    const f = await world({ roster: withAna });
    // Ana may use the list and the status edit, which show every field but ID.
    const store = new DatabaseSync(join(f.root, ".dohc", "local", "datasets", "state.sqlite"));
    try {
      store.prepare("INSERT INTO dohc_dataset_data_grants VALUES(?,?,?,?,?)").run(
        "workspace",
        definition.datasetId,
        datasetPrincipalKey("workspace", "g-ana", "u-ana"),
        JSON.stringify({
          operationIds: [LIST, STATUS_ONLY],
          discover: true,
          revision: f.rules.revision,
          revisionSha256: f.rules.revisionSha256,
        }),
        "token",
      );
    } finally {
      store.close();
    }
    await f.executor.open();
    expect(await f.executor.automationsIn("Budget")).toMatchObject({
      automations: [{ cannotRun: null }],
    });
    // Ana stops editing: ID becomes readable under the same definition, so it waits.
    f.setRoster(OWNER);
    f.executor.rosterChanged();
    await f.until(() => f.executor.holds().length === 1);
    const [hold] = f.executor.holds();
    expect(hold).toMatchObject({ action: "find", stoppedFor: "ana@dohc.test" });
    const { id: invoice } = await f.create({});
    await f.edit(invoice, { [PAID]: true });
    await f.until(
      () =>
        f.claims()[0]?.state === "pending" &&
        f.host.automations.claims(AUTOMATION).claims[0]?.attempts === 0,
    );
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    expect(await f.executor.confirmReach(hold!)).toBe("confirmed");
    await f.until(async () => (await f.record(invoice))?.values[STATUS] === "Closed");
    await f.executor.dispose();
  });

  it("undoes a run's edits as the person, keeping fields someone changed since, and deletes the record it added once the person confirms", async () => {
    const f = await world();
    await f.writeAutomations(
      closePaid(`      - set:
          Status: Closed
          Notes: Closed by automation
        operation: invoices.edit
      - add-record:
          Notes: Log
        operation: invoices.create
`),
    );
    await f.executor.open();
    expect(await f.executor.automationsIn("Budget")).toMatchObject({ addsStay: [] });
    const { id: invoice } = await f.create({ [STATUS]: "Open", [NOTES]: "draft" });
    await f.edit(invoice, { [PAID]: true });
    await f.until(() => f.claims()[0]?.state === "done");
    const claimId = f.claims()[0]!.claimId;
    const [listed] = (await f.executor.runs(AUTOMATION)).runs;
    expect(listed!.writes).toEqual([
      expect.objectContaining({
        kind: "dataset-edit",
        recordId: invoice,
        expectedVersion: 2,
        version: 3,
      }),
      expect.objectContaining({ kind: "dataset-created", deletes: [REMOVE] }),
    ]);
    await f.edit(invoice, { [NOTES]: "mine" });
    const trash = async () => {
      throw new Error("A dataset keeps no trash.");
    };
    // First, what Undo will do. Nothing is saved or sent yet.
    const asked = await f.executor.undo(
      { automationId: AUTOMATION, claimId, deletes: null },
      trash,
    );
    expect(asked).toEqual({
      status: "confirm",
      preview: {
        deletes: 1,
        unchecked: 0,
        kept: 0,
        keptChanged: 0,
        gone: 0,
        reverts: 2,
        irreversible: 0,
        reverses: 0,
        actions: 0,
        choices: [],
        token: expect.any(String),
      },
    });
    if (asked.status !== "confirm") throw new Error("Undo should ask first.");
    const store = createAutomationRunStore(preparedAutomationStoreFolder(f.root));
    expect(
      (await store.runsOf(AUTOMATION, claimId)).runs.map((run) => [run.undo, run.undoCalls]),
    ).toEqual([[null, []]]);
    expect((await f.records()).some((row) => row.values[NOTES] === "Log")).toBe(true);
    expect(
      await f.executor.undo(
        { automationId: AUTOMATION, claimId, deletes: { token: asked.preview.token, chosen: [] } },
        trash,
      ),
    ).toEqual({
      status: "undone",
      reverted: 1,
      removed: 0,
      deleted: 1,
      kept: 0,
      keptChanged: 0,
      gone: 0,
      changedSince: 1,
      missing: 0,
      irreversible: 0,
      actions: 0,
      actionsReversed: 0,
    });
    expect((await f.record(invoice))?.values).toMatchObject({
      [STATUS]: "Open",
      [NOTES]: "mine",
      [PAID]: true,
    });
    expect((await f.records()).some((row) => row.values[NOTES] === "Log")).toBe(false);
    expect(f.host.history({ datasetId: definition.datasetId }).entries[0]).not.toHaveProperty(
      "automation",
    );
    // Run history does not show it fully undone, since Notes kept a later
    // value; Undo points to History, and Try again does not run it again.
    expect((await f.executor.runs(AUTOMATION)).runs).toEqual([
      expect.objectContaining({ claimId, undone: false }),
    ]);
    expect(
      await f.executor.undo({ automationId: AUTOMATION, claimId, deletes: null }, trash),
    ).toEqual({
      status: "refused",
      reason:
        "dohc kept the fields someone changed after this run. Restore them from each record's History.",
    });
    expect(await f.executor.retry({ automationId: AUTOMATION, claimId, startOver: false })).toEqual(
      { status: "refused", reason: UNDONE_RUN_ERROR },
    );
    expect((await f.record(invoice))?.values).toMatchObject({ [STATUS]: "Open", [NOTES]: "mine" });
    await f.executor.dispose();
  });
});
