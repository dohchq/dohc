import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { createPressWindows, registerAutomationButtonsIpc } from "../ipc/automationButtonsIpc";
import { createAutomationRunStore } from "@dohc/automation-executor/automation-run-store";
import { preparedAutomationStoreFolder } from "../testing/preparedLocalState";

import { definitionHash } from "@dohc/automation-executor/automation-plan";
import {
  AutomationRunWait,
  SHARED_BUTTON_DENIED,
  SHARED_BUTTON_UNCHECKED,
} from "@dohc/automation-executor/button-presser";
import { datasetAutomationFixture } from "./collectionAutomationDatasetTestSupport";

const {
  BUDGET,
  TABLE,
  STATUS,
  LIST,
  CREATE,
  EDIT,
  STATUS_ONLY,
  definition,
  SETTLE,
  HOLD,
  RELEASE,
  ACTION_DESCRIPTOR,
  ACTION_OPERATIONS,
  HELPER_ACTION_DESCRIPTOR,
  sharedButtonWorld,
  world,
} = datasetAutomationFixture();

describe("named shared document Buttons on the desktop host", () => {
  it.each([false, true])(
    "checks the presser ceiling for a computed code destination, create allowed: %s",
    async (allowed) => {
      const f = await sharedButtonWorld(
        "      - run: \"return { records: [{ action: 'add', collection: ['Bud', 'get'].join(''), fields: { Status: 'By code' } }] };\"",
      );
      f.grant(
        "g-recipient",
        "user-recipient",
        allowed ? [LIST, CREATE, EDIT, STATUS_ONLY] : [LIST, EDIT, STATUS_ONLY],
      );
      expect((await f.executor.inspectRelayed(f.input.pressId)).kind).toBe("ready");
      await f.executor.pressRelayed(f.input, () => undefined);
      await f.until(
        () => f.engineClaims[0]?.state === "done" || f.engineClaims[0]?.state === "failed",
      );
      expect(f.engineClaims[0], JSON.stringify(f.engineClaims)).toMatchObject({
        state: allowed ? "done" : "failed",
      });
      expect((await f.records()).map((row) => row.values[STATUS])).toEqual(
        allowed ? ["By code"] : [],
      );
      await f.executor.dispose();
    },
  );
  it("requires the implicit read and refuses a forged identity", async () => {
    const f = await sharedButtonWorld(
      "      - add-record: {Status: Open}\n        collection: Budget\n        operation: invoices.create\n        as: added\n      - set: {Status: Done}\n        records: added\n        operation: invoices.status",
    );
    f.grant("g-recipient", "user-recipient", [CREATE, STATUS_ONLY]);
    expect(await f.executor.inspectRelayed(f.input.pressId)).toEqual({
      kind: "denied",
      reason: SHARED_BUTTON_DENIED,
    });
    f.grant("g-recipient", "user-recipient", [CREATE, STATUS_ONLY, LIST]);
    expect((await f.executor.inspectRelayed(f.input.pressId)).kind).toBe("ready");
    await expect(
      f.executor.pressRelayed({ ...f.input, pressedBy: "user-owner" }, () => undefined),
    ).rejects.toThrow(SHARED_BUTTON_DENIED);
    const result = await f.executor.pressRelayed(f.input, () => undefined);
    if (result.pressed.busy) throw Error("Expected a claim");
    await f.until(() => f.engineClaims[0]?.state === "done");
    expect((await f.records()).map((row) => row.values[STATUS])).toEqual(["Done"]);
    await f.executor.dispose();
  });

  it("inspects an authorized invoke, requires its qualified confirmation, and rechecks grants after listing", async () => {
    const f = await sharedButtonWorld(
      "      - invoke: invoices.settle\n        collection: Budget\n        input: {id: destination, note: Sent}",
      { descriptor: HELPER_ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS },
    );
    f.grant("g-recipient", "user-recipient", [SETTLE]);
    const listed = await f.executor.inspectRelayed(f.input.pressId);
    expect(listed).toMatchObject({
      kind: "ready",
      irreversible: [{ name: `${BUDGET}/invoices.settle`, label: "Budget: Settle" }],
    });
    await expect(f.executor.pressRelayed(f.input, () => undefined)).rejects.toThrow(
      "changed after it was pressed",
    );
    await expect(
      f.executor.pressRelayed({ ...f.input, confirmed: ["invoices.settle"] }, () => undefined),
    ).rejects.toThrow(SHARED_BUTTON_DENIED);
    const confirmed = { ...f.input, confirmed: [`${BUDGET}/invoices.settle`] };
    f.registerPress(confirmed);
    f.grant("g-recipient", "user-recipient", []);
    await expect(f.executor.pressRelayed(confirmed, () => undefined)).rejects.toThrow(
      SHARED_BUTTON_DENIED,
    );
    f.grant("g-recipient", "user-recipient", [SETTLE]);
    const destination = await f.create({ [STATUS]: "Original" });
    // The generated id is read from the record, so the fixture's authored action names it directly.
    const held = f.authorities.get(f.input.pressId)!;
    const text = (await readFile(join(f.root, "Log/automations.yaml"), "utf8")).replace(
      "id: destination",
      `id: '${destination.id}'`,
    );
    await writeFile(join(f.root, "Log/automations.yaml"), text);
    f.executor.handleWatcherEvents([{ operation: "update", path: "Log/automations.yaml" }]);
    await vi.waitFor(async () =>
      expect((await f.executor.inspectRelayed(f.input.pressId)).kind).toBe("denied"),
    );
    await expect(f.executor.pressRelayed(confirmed, () => undefined)).rejects.toThrow(
      "changed after it was pressed",
    );
    const parsed = parseAutomationsFile(text);
    const entry = parsed.status === "read" ? parsed.entries[0] : null;
    if (entry?.status !== "valid") throw Error("Invalid fixture");
    held.definitionHash = definitionHash(entry.automation);
    const result = await f.executor.pressRelayed(
      { ...confirmed, definitionHash: held.definitionHash },
      () => undefined,
    );
    if (result.pressed.busy) throw Error("Expected a claim");
    await f.until(() => f.engineClaims[0]?.state === "done");
    expect((await f.record(destination.id))?.values[STATUS]).toContain("Sent");
    await f.executor.dispose();
  });

  it("waits for unknown authority and keeps committed work across restart, then stops after revocation", async () => {
    let revoke = () => {};
    const f = await sharedButtonWorld(
      "      - add-record: {Status: First}\n        collection: Budget\n        operation: invoices.create\n      - add-record: {Status: Second}\n        collection: Budget\n        operation: invoices.create",
      { afterInvoke: async () => revoke() },
    );
    f.grant("g-recipient", "user-recipient", [CREATE]);
    f.setAuthorityAvailable(false);
    expect(await f.executor.inspectRelayed(f.input.pressId)).toEqual({
      kind: "unchecked",
      reason: SHARED_BUTTON_UNCHECKED,
    });
    await expect(f.executor.pressRelayed(f.input, () => undefined)).rejects.toBeInstanceOf(
      AutomationRunWait,
    );
    expect(await f.records()).toHaveLength(0);
    f.setAuthorityAvailable(true);
    revoke = () => f.setAuthorityAvailable(false);
    const pressed = await f.executor.pressRelayed(f.input, () => undefined);
    if (pressed.pressed.busy) throw Error("Expected a claim");
    await f.until(() => f.waiting.length > 0);
    expect(await f.records()).toHaveLength(1);
    await f.executor.dispose();
    f.setAuthorityAvailable(true);
    f.authorities.delete(f.input.pressId);
    f.makeExecutor();
    await f.executor.open();
    await f.until(() => f.engineClaims[0]?.state === "failed");
    expect(await f.records()).toHaveLength(1);
    await expect(
      f.executor.retry({
        automationId: f.input.automationId,
        claimId: f.engineClaims[0]!.claimId,
        startOver: false,
      }),
    ).resolves.toMatchObject({ status: "refused" });
    await f.executor.dispose();
  });

  it("refuses owner-only actions and gives hidden and missing targets the same refusal", async () => {
    const hidden = await sharedButtonWorld(
      "      - invoke: invoices.settle\n        collection: Budget\n        input: {id: private}",
      { descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS },
    );
    hidden.grant("g-recipient", "user-recipient", [SETTLE]);
    const denied = await hidden.executor.inspectRelayed(hidden.input.pressId);
    const missing = await sharedButtonWorld(
      "      - invoke: invoices.settle\n        collection: Missing\n        input: {id: private}",
    );
    expect(await missing.executor.inspectRelayed(missing.input.pressId)).toEqual(denied);
    expect(denied).toEqual({ kind: "denied", reason: SHARED_BUTTON_DENIED });
    await hidden.executor.dispose();
    await missing.executor.dispose();
  });
});

describe("pressing a button on a dataset record", () => {
  const PRESSER = "user-ana";
  const BUTTON_AUTOMATION = `collection:${BUDGET}#mark-paid`;
  const markPaid = (
    step = '      - set:\n          Status: \'="Paid by " + person.name + " with " + trigger.field\'\n        operation: invoices.status\n',
    button = "Mark paid",
  ) => `  - id: mark-paid
    name: Mark paid
    when:
      button: ${button}
    do:
${step}`;
  const pressId = (number: number) => `4f2d3c1a-9b8e-4c7d-a6f5-${String(number).padStart(12, "0")}`;
  const owner = (f: Awaited<ReturnType<typeof world>>) => f.host.describe(definition.datasetId);
  const press = (
    f: Awaited<ReturnType<typeof world>>,
    input: {
      recordId: string;
      pressId: string;
      pressedBy?: string;
      field?: string;
      confirmed?: string[];
    },
    description = owner(f),
  ) =>
    f.executor.pressDataset(
      {
        datasetId: definition.datasetId,
        table: "Invoices",
        field: "Mark paid",
        pressedBy: PRESSER,
        by: { kind: "human" },
        confirmed: [],
        ...input,
        recordId: JSON.stringify(input.recordId),
      },
      async () => description,
      () => undefined,
    );

  const settle =
    "      - invoke: invoices.settle\n        input:\n          id: '=record.id'\n          note: pressed\n";
  it("presses by folder as the CLI does: a reversible action runs unasked, and one dohc cannot undo runs once confirmed by name", async () => {
    const hold = "      - invoke: invoices.hold\n        input:\n          id: '=record.id'\n";
    const f = await world({ descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS });
    await f.writeAutomations(markPaid(hold + settle));
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    type Operation = {
      workspace: { workspaceId: string; rootPath: string };
      state: { collectionAutomations: typeof f.executor };
    };
    const { pressNamed } = registerAutomationButtonsIpc<
      { isDestroyed(): boolean; send(): void },
      { sender: { isDestroyed(): boolean; send(): void } },
      Operation
    >({
      registerHandler: () => undefined,
      assertTrustedSender: () => undefined,
      withRendererWorkspaceOperation: async () => {
        throw new Error("No window presses here.");
      },
      readText: async () => null,
      buttonFields: async () => [],
      recordAt: async () => null,
      describeDataset: async () => {
        throw new Error("The CLI describes the dataset itself.");
      },
      pressedBy: async () => PRESSER,
      relayPress: async () => {
        throw new Error("Nothing relays here.");
      },
      relayInspect: async () => {
        throw new Error("Nothing relays here.");
      },
      serverCollection: async () => null,
      inspectionAccount: async () => null,
      inspectionChanged: () => undefined,
      pressWindows: createPressWindows(() => null),
    });
    const operation: Operation = {
      workspace: { workspaceId: "workspace", rootPath: f.root },
      state: { collectionAutomations: f.executor },
    };
    const caller = {
      by: { kind: "human" as const },
      withOperation: async <Result>(work: (op: Operation) => Promise<Result>) =>
        await work(operation),
      describeDataset: async () => owner(f),
      watch: () => undefined,
    };
    const input = {
      workspaceId: "workspace",
      collectionPath: "Budget",
      field: "Mark paid",
      recordId: JSON.stringify(invoice),
      confirm: [] as string[],
      pressKey: "cli-1",
    };
    // Hold names its reverse, so only Settle is asked about.
    await expect(pressNamed(input, caller)).resolves.toEqual({
      confirm: [{ name: "invoices.settle", label: "Settle" }],
    });
    expect(f.host.automations.claims(BUTTON_AUTOMATION).claims).toEqual([]);
    const pressed = await pressNamed({ ...input, confirm: ["invoices.settle"] }, caller);
    if ("confirm" in pressed || pressed.busy || "relayed" in pressed)
      throw new Error("The press ran.");
    await f.until(() => f.settled.length === 1);
    expect((await f.record(invoice))?.values[STATUS]).toBe(
      `Settled by ${BUTTON_AUTOMATION}: pressed`,
    );
    await expect(pressNamed(input, caller)).resolves.toEqual({
      busy: false,
      claimId: pressed.claimId,
      settled: { outcome: "done", error: null },
    });
    expect(f.host.automations.claims(BUTTON_AUTOMATION).claims).toHaveLength(1);
    await f.writeAutomations(markPaid(hold));
    f.executor.handleWatcherEvents([{ operation: "update", path: "Budget/automations.yaml" }]);
    const { id: other } = await f.create({ [STATUS]: "Open" });
    const held = await pressNamed(
      { ...input, recordId: JSON.stringify(other), pressKey: "cli-2" },
      caller,
    );
    if ("confirm" in held || held.busy || "relayed" in held) throw new Error("The press ran.");
    await f.until(() => f.settled.length === 2);
    expect((await f.record(other))?.values[STATUS]).toBe("On hold");
    await f.executor.dispose();
  });

  it("leaves another definition's saved reverse when Stop and restore finishes an Undo that stopped, for a full Undo to send", async () => {
    const f = await world({ descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS });
    await f.writeAutomations(
      markPaid("      - invoke: invoices.hold\n        input:\n          id: '=record.id'\n"),
    );
    await f.executor.open();
    const { id: first } = await f.create({ [STATUS]: "Open" });
    const pressed = await press(f, { recordId: first, pressId: pressId(26) });
    if (pressed.busy) throw new Error("The press ran.");
    await f.until(() => f.settled.length === 1);
    // A second run of the same claim under another definition held another invoice, as a start-over would.
    const { id: second } = await f.create({ [STATUS]: "Open" });
    const held = await f.host.action({
      ...f.rules,
      operationId: HOLD,
      input: { id: second },
      idempotencyKey: "owner-hold",
    });
    const store = createAutomationRunStore(preparedAutomationStoreFolder(f.root));
    const [run] = (await store.runsOf(BUTTON_AUTOMATION, pressed.claimId)).runs;
    await store.save({
      ...run!,
      definitionHash: "0123456789abcdef",
      keySeed: "0123456789abcdef-2",
      startedAtMs: run!.startedAtMs + 1,
      applied: [
        {
          ordinal: 0,
          writes: [
            {
              kind: "dataset-action",
              rules: f.rules,
              operationId: HOLD,
              tableId: TABLE,
              name: "Hold",
              revision: held.revision,
              undo: { id: second, status: "Open" },
              reverseOperationId: RELEASE,
            },
          ],
        },
      ],
    });
    const undo = () =>
      f.executor.undo(
        { automationId: BUTTON_AUTOMATION, claimId: pressed.claimId, deletes: null },
        async () => undefined,
      );
    // A full Undo saves both reverses with the second run, and dohc stops once the first reverse committed.
    f.crashAfterOwnerInvoke(RELEASE);
    await expect(undo()).rejects.toThrow("dohc stopped.");
    expect((await f.record(second))?.values[STATUS]).toBe("Open");
    await expect(
      f.executor.undoRunsOf(
        [{ collectionPath: "Budget", id: "mark-paid", definitionHash: "0123456789abcdef" }],
        async () => undefined,
      ),
    ).resolves.toMatchObject({ undone: 1, left: 0 });
    expect((await f.record(first))?.values[STATUS]).toBe("On hold");
    expect(await undo()).toMatchObject({ status: "undone", actionsReversed: 2 });
    expect((await f.record(first))?.values[STATUS]).toBe("Open");
    await f.executor.dispose();
  });

  it("runs a button's action once when dohc stops after the action committed and before the run recorded it", async () => {
    let started: () => void = () => undefined,
      release: () => void = () => undefined;
    const committed = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = await world({
      descriptor: ACTION_DESCRIPTOR,
      operations: ACTION_OPERATIONS,
      afterInvoke: async () => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw new Error("The workspace closed.");
      },
    });
    await f.writeAutomations(markPaid(settle));
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    const pressed = await press(f, {
      recordId: invoice,
      pressId: pressId(22),
      confirmed: ["invoices.settle"],
    });
    if (pressed.busy) throw new Error("The press ran.");
    await committed;
    const disposed = f.executor.dispose();
    release();
    await disposed;
    expect(f.host.automations.claims(BUTTON_AUTOMATION).claims).toMatchObject([
      { state: "pending" },
    ]);
    // The next executor sends the saved request under the same key: the host answers from its receipt.
    f.makeExecutor();
    await f.executor.open();
    await f.until(() => f.host.automations.claims(BUTTON_AUTOMATION).claims[0]?.state === "done");
    const settles = f.host
      .history({ datasetId: definition.datasetId })
      .entries.filter((entry) => entry.operation === "invoices.settle");
    expect(settles).toHaveLength(1);
    expect((await f.record(invoice))?.values[STATUS]).toBe(
      `Settled by ${BUTTON_AUTOMATION}: pressed`,
    );
    await f.executor.dispose();
  });

  it("runs a failed press again only for the person who pressed it or the owner", async () => {
    for (const mayRetryPress of [false, true]) {
      const f = await world({ mayRetryPress });
      await f.writeAutomations(
        markPaid(
          "      - set:\n          Status: '=missing.value'\n        operation: invoices.status\n",
        ),
      );
      await f.executor.open();
      const { id: invoice } = await f.create({});
      const pressed = await press(f, { recordId: invoice, pressId: pressId(7) });
      if (pressed.busy) throw new Error("The press ran.");
      await f.until(() => f.settled.length === 1);
      expect(f.settled[0]).toMatchObject({ claimId: pressed.claimId, outcome: "failed" });
      expect(
        await f.executor.retry({
          automationId: BUTTON_AUTOMATION,
          claimId: pressed.claimId,
          startOver: false,
        }),
      ).toEqual(
        mayRetryPress
          ? { status: "queued", press: true }
          : {
              status: "refused",
              reason:
                "Only the person who pressed this button, or the workspace's owner, can run it again.",
            },
      );
      await f.executor.dispose();
    }
  });
});
