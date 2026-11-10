import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { generateDatasetOperations } from "@dohc/security-contract/dataset-operations";
import { describeApprovedDataset } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { generateDatasetSources } from "../workspaces/datasetGenerator";
import { createPressWindows, registerAutomationButtonsIpc } from "../ipc/automationButtonsIpc";
import { createAutomationRunStore } from "@dohc/automation-executor/automation-run-store";
import { preparedAutomationStoreFolder } from "../testing/preparedLocalState";
import { SERVER_TRIGGERS_ELSEWHERE, type ServerDataset } from "@dohc/automation-executor/collection-automations";
import { AUTOMATION_SERVER_OFF } from "@dohc/workspace-contracts/relay";
import { CollectionMoveUnfinishedError } from "../ipc/errorWords";
import { definitionHash } from "@dohc/automation-executor/automation-plan";
import { AutomationRunWait, SHARED_BUTTON_DENIED, SHARED_BUTTON_UNCHECKED } from "@dohc/automation-executor/button-presser";
import { datasetAutomationFixture } from "./collectionAutomationDatasetTestSupport";

const { id, OWNER, UNKNOWN, BUDGET, AUTOMATION, TABLE, PAID, STATUS, MARK_PAID, LIST, CREATE, EDIT, STATUS_ONLY, definition, files, closePaid, AUTHORED_OPERATIONS, SETTLE, HOLD, RELEASE, ACTION_DESCRIPTOR, ACTION_OPERATIONS, HELPER_ACTION_DESCRIPTOR, sharedButtonWorld, world } = datasetAutomationFixture();

describe("named shared document Buttons on the desktop host", () => {
  it("reads a Collection schema once per inspection batch and reports a changed Button field", async () => {
    const f = await sharedButtonWorld("      - find: 'true'\n        collection: Budget\n        operation: invoices.list\n        as: matches");
    f.grant("g-recipient", "user-recipient", [LIST]);
    await f.executor.idle();
    f.readText.mockClear();
    expect((await f.executor.inspectRelayedBatch([f.input.pressId, f.input.pressId])).map(answer => answer.kind)).toEqual(["ready", "ready"]);
    expect(f.readText.mock.calls.filter(([path]) => path === "Log/collection.yaml")).toHaveLength(1);
    await writeFile(join(f.root, "Log/collection.yaml"), "fields: {Send: {type: text}, Status: {type: text}}");
    expect(await f.executor.inspectRelayed(f.input.pressId)).toEqual({ kind: "denied", reason: "This field is no longer a Button. The Collection's files will update here soon." });
    await f.executor.dispose();
  });

  it("reports a moved Collection when the recipient's path is no longer indexed", async () => {
    const f = await sharedButtonWorld("      - find: 'true'\n        collection: Budget\n        operation: invoices.list\n        as: matches");
    f.grant("g-recipient", "user-recipient", [LIST]);
    await f.moveDocuments("Moved");
    f.executor.handleWatcherEvents([{ operation: "delete", path: "Log/collection.yaml" }, { operation: "update", path: "Moved/collection.yaml" }]);
    await f.executor.idle();
    await vi.waitFor(async () => expect(await f.executor.inspectRelayed(f.input.pressId)).toEqual({ kind: "denied", reason: "This Collection moved. Its files will update here soon." }));
    await f.executor.dispose();
  });
  it.each([true, false])("keeps a failure to open the dataset store unchecked, initially closed=%s", async initiallyClosed => {
    const f = await sharedButtonWorld("      - find: 'true'\n        collection: Budget\n        operation: invoices.list\n        as: matches", { hostOpen: !initiallyClosed, storeFails: initiallyClosed });
    f.grant("g-recipient", "user-recipient", [LIST]);
    if (!initiallyClosed) f.failStore();
    expect(await f.executor.inspectRelayed(f.input.pressId)).toEqual({ kind: "unchecked", reason: SHARED_BUTTON_UNCHECKED });
    await expect(f.executor.pressRelayed(f.input, () => undefined)).rejects.toBeInstanceOf(AutomationRunWait);
    expect(f.engineClaims).toEqual([]);
    await f.executor.dispose();
  });
  it.each([false, true])("checks the presser ceiling for a computed code destination, create allowed: %s", async allowed => {
    const f = await sharedButtonWorld("      - run: \"return { records: [{ action: 'add', collection: ['Bud', 'get'].join(''), fields: { Status: 'By code' } }] };\"");
    f.grant("g-recipient", "user-recipient", allowed ? [LIST, CREATE, EDIT, STATUS_ONLY] : [LIST, EDIT, STATUS_ONLY]);
    expect((await f.executor.inspectRelayed(f.input.pressId)).kind).toBe("ready");
    await f.executor.pressRelayed(f.input, () => undefined);
    await f.until(() => f.engineClaims[0]?.state === "done" || f.engineClaims[0]?.state === "failed");
    expect(f.engineClaims[0], JSON.stringify(f.engineClaims)).toMatchObject({ state: allowed ? "done" : "failed" });
    expect((await f.records()).map(row => row.values[STATUS])).toEqual(allowed ? ["By code"] : []);
    await f.executor.dispose();
  });
  it("does not borrow the same named operation grant from another dataset on the desktop", async () => {
    const f = await sharedButtonWorld("      - find: 'true'\n        collection: Other\n        operation: invoices.list\n        as: matches");
    const other = { ...definition, datasetId: id(90), name: "Other", schemaPath: "Other/schema.sql", operationsPath: "Other/operations.js" };
    await mkdir(join(f.root, "Other"), { recursive: true });
    await writeFile(join(f.root, "Other/dataset.json"), JSON.stringify(other));
    await writeFile(join(f.root, other.schemaPath), files[definition.schemaPath]!);
    await writeFile(join(f.root, other.operationsPath), generateDatasetOperations(other));
    const prepared = await f.host.prepare({ descriptorPath: "Other/dataset.json", adapter: f.adapter });
    const approved = await f.host.approve({ preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256 });
    f.grant("g-recipient", "user-recipient", [LIST]);
    expect(await f.executor.inspectRelayed(f.input.pressId)).toEqual({ kind: "denied", reason: SHARED_BUTTON_DENIED });
    await expect(f.executor.pressRelayed(f.input, () => undefined)).rejects.toThrow(SHARED_BUTTON_DENIED);
    f.grant("g-recipient", "user-recipient", [LIST], { datasetId: other.datasetId, revision: approved.revision, revisionSha256: approved.revisionSha256 });
    await vi.waitFor(async () => expect((await f.executor.inspectRelayed(f.input.pressId)).kind).toBe("ready"));
    await f.executor.pressRelayed(f.input, () => undefined);
    await f.until(() => f.engineClaims[0]?.state === "done");
    await f.executor.dispose();
  });
  it("requires the implicit read and refuses a forged identity", async () => {
    const f = await sharedButtonWorld("      - add-record: {Status: Open}\n        collection: Budget\n        operation: invoices.create\n        as: added\n      - set: {Status: Done}\n        records: added\n        operation: invoices.status");
    f.grant("g-recipient", "user-recipient", [CREATE, STATUS_ONLY]);
    expect(await f.executor.inspectRelayed(f.input.pressId)).toEqual({ kind: "denied", reason: SHARED_BUTTON_DENIED });
    f.grant("g-recipient", "user-recipient", [CREATE, STATUS_ONLY, LIST]);
    expect((await f.executor.inspectRelayed(f.input.pressId)).kind).toBe("ready");
    await expect(f.executor.pressRelayed({ ...f.input, pressedBy: "user-owner" }, () => undefined)).rejects.toThrow(SHARED_BUTTON_DENIED);
    const result = await f.executor.pressRelayed(f.input, () => undefined);
    if (result.pressed.busy) throw Error("Expected a claim");
    await f.until(() => f.engineClaims[0]?.state === "done");
    expect((await f.records()).map(row => row.values[STATUS])).toEqual(["Done"]);
    await f.executor.dispose();
  });

  it("inspects an authorized invoke, requires its qualified confirmation, and rechecks grants after listing", async () => {
    const f = await sharedButtonWorld("      - invoke: invoices.settle\n        collection: Budget\n        input: {id: destination, note: Sent}", { descriptor: HELPER_ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS });
    f.grant("g-recipient", "user-recipient", [SETTLE]);
    const listed = await f.executor.inspectRelayed(f.input.pressId);
    expect(listed).toMatchObject({ kind: "ready", irreversible: [{ name: `${BUDGET}/invoices.settle`, label: "Budget: Settle" }] });
    await expect(f.executor.pressRelayed(f.input, () => undefined)).rejects.toThrow("changed after it was pressed");
    await expect(f.executor.pressRelayed({ ...f.input, confirmed: ["invoices.settle"] }, () => undefined)).rejects.toThrow(SHARED_BUTTON_DENIED);
    const confirmed = { ...f.input, confirmed: [`${BUDGET}/invoices.settle`] };
    f.registerPress(confirmed);
    f.grant("g-recipient", "user-recipient", []);
    await expect(f.executor.pressRelayed(confirmed, () => undefined)).rejects.toThrow(SHARED_BUTTON_DENIED);
    f.grant("g-recipient", "user-recipient", [SETTLE]);
    const destination = await f.create({ [STATUS]: "Original" });
    // The generated id is read from the record, so the fixture's authored action names it directly.
    const held = f.authorities.get(f.input.pressId)!;
    const text = (await readFile(join(f.root, "Log/automations.yaml"), "utf8")).replace("id: destination", `id: '${destination.id}'`);
    await writeFile(join(f.root, "Log/automations.yaml"), text);
    f.executor.handleWatcherEvents([{ operation: "update", path: "Log/automations.yaml" }]);
    await vi.waitFor(async () => expect((await f.executor.inspectRelayed(f.input.pressId)).kind).toBe("denied"));
    await expect(f.executor.pressRelayed(confirmed, () => undefined)).rejects.toThrow("changed after it was pressed");
    const parsed = parseAutomationsFile(text); const entry = parsed.status === "read" ? parsed.entries[0] : null;
    if (entry?.status !== "valid") throw Error("Invalid fixture");
    held.definitionHash = definitionHash(entry.automation);
    const result = await f.executor.pressRelayed({ ...confirmed, definitionHash: held.definitionHash }, () => undefined);
    if (result.pressed.busy) throw Error("Expected a claim");
    await f.until(() => f.engineClaims[0]?.state === "done");
    expect((await f.record(destination.id))?.values[STATUS]).toContain("Sent");
    await f.executor.dispose();
  });

  it("waits for unknown authority and keeps committed work across restart, then stops after revocation", async () => {
    let revoke = () => {};
    const f = await sharedButtonWorld("      - add-record: {Status: First}\n        collection: Budget\n        operation: invoices.create\n      - add-record: {Status: Second}\n        collection: Budget\n        operation: invoices.create", { afterInvoke: async () => revoke() });
    f.grant("g-recipient", "user-recipient", [CREATE]);
    f.setAuthorityAvailable(false);
    expect(await f.executor.inspectRelayed(f.input.pressId)).toEqual({ kind: "unchecked", reason: SHARED_BUTTON_UNCHECKED });
    await expect(f.executor.pressRelayed(f.input, () => undefined)).rejects.toBeInstanceOf(AutomationRunWait);
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
    f.makeExecutor(); await f.executor.open();
    await f.until(() => f.engineClaims[0]?.state === "failed");
    expect(await f.records()).toHaveLength(1);
    await expect(f.executor.retry({ automationId: f.input.automationId, claimId: f.engineClaims[0]!.claimId, startOver: false })).resolves.toMatchObject({ status: "refused" });
    await f.executor.dispose();
  });

  it("resumes an accepted press after restart with its presser ceiling and no repeated committed step", async () => {
    let loseAuthority = () => {};
    const f = await sharedButtonWorld("      - add-record: {Status: First}\n        collection: Budget\n        operation: invoices.create\n      - add-record: {Status: Second}\n        collection: Budget\n        operation: invoices.create", { afterInvoke: async () => loseAuthority() });
    f.grant("g-recipient", "user-recipient", [CREATE]);
    loseAuthority = () => f.setAuthorityAvailable(false);
    await f.executor.pressRelayed(f.input, () => undefined);
    await f.until(() => f.waiting.length > 0);
    expect(await f.records()).toHaveLength(1);
    await f.executor.dispose();
    loseAuthority = () => {};
    f.setAuthorityAvailable(true);
    f.makeExecutor(); await f.executor.open();
    await f.until(() => f.engineClaims[0]?.state === "done");
    expect((await f.records()).map(row => row.values[STATUS]).sort()).toEqual(["First", "Second"]);
    await f.executor.dispose();
  });

  it("refuses owner-only actions and gives hidden and missing targets the same refusal", async () => {
    const hidden = await sharedButtonWorld("      - invoke: invoices.settle\n        collection: Budget\n        input: {id: private}", { descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS });
    hidden.grant("g-recipient", "user-recipient", [SETTLE]);
    const denied = await hidden.executor.inspectRelayed(hidden.input.pressId);
    const missing = await sharedButtonWorld("      - invoke: invoices.settle\n        collection: Missing\n        input: {id: private}");
    expect(await missing.executor.inspectRelayed(missing.input.pressId)).toEqual(denied);
    expect(denied).toEqual({ kind: "denied", reason: SHARED_BUTTON_DENIED });
    await hidden.executor.dispose(); await missing.executor.dispose();
  });
});

describe("pressing a button on a dataset record", () => {
  const PRESSER = "user-ana";
  const BUTTON_AUTOMATION = `collection:${BUDGET}#mark-paid`;
  const markPaid = (step = "      - set:\n          Status: '=\"Paid by \" + person.name + \" with \" + trigger.field'\n        operation: invoices.status\n", button = "Mark paid") => `  - id: mark-paid
    name: Mark paid
    when:
      button: ${button}
    do:
${step}`;
  const pressId = (number: number) => `4f2d3c1a-9b8e-4c7d-a6f5-${String(number).padStart(12, "0")}`;
  const owner = (f: Awaited<ReturnType<typeof world>>) => f.host.describe(definition.datasetId);
  const press = (f: Awaited<ReturnType<typeof world>>, input: { recordId: string; pressId: string; pressedBy?: string; field?: string; confirmed?: string[] }, description = owner(f)) =>
    f.executor.pressDataset({ datasetId: definition.datasetId, table: "Invoices", field: "Mark paid", pressedBy: PRESSER, by: { kind: "human" }, confirmed: [], ...input, recordId: JSON.stringify(input.recordId) },
      async () => description, () => undefined);

  it("runs a press on a dataset whose operations someone wrote, calling none of them for its own checks", async () => {
    const f = await world({ operations: AUTHORED_OPERATIONS });
    await f.writeAutomations(markPaid("      - notify: 'Invoice {record.id} was pressed'\n        to: [user-owner]\n"));
    await f.executor.open();
    expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], async () => (owner(f))))
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
    expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], async () => (owner(f))))
      .toEqual([{ kind: "ready", automationId: BUTTON_AUTOMATION, irreversible: [{ name: "invoices.settle", label: "Settle" }] }]);
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    // A press that did not agree to Settle is refused: the button would run what nobody was told of.
    await expect(press(f, { recordId: invoice, pressId: pressId(25) })).rejects.toThrow("changed");
    const pressed = await press(f, { recordId: invoice, pressId: pressId(20), confirmed: ["invoices.settle"] });
    if (pressed.busy) throw new Error("The press ran.");
    await f.until(() => f.settled.length === 1 && f.host.automations.claims(`collection:${BUDGET}#watch`).claims[0]?.state === "done");
    expect(f.settled).toEqual([{ claimId: pressed.claimId, outcome: "done", error: null }]);
    expect((await f.record(invoice))?.values[STATUS]).toBe(`Settled by ${BUTTON_AUTOMATION}: pressed`);
    // History names the automation behind the action's commit.
    expect(f.host.history({ datasetId: definition.datasetId }).entries[0]).toMatchObject({ operation: "invoices.settle", automation: { automationId: BUTTON_AUTOMATION, depth: 1 } });
    expect(f.host.automations.claims(`collection:${BUDGET}#watch`).claims).toEqual([expect.objectContaining({ state: "done", depth: 1 })]);
    expect(f.notices).toEqual([expect.objectContaining({ body: "Status changed" })]);
    expect(f.host.automations.claims(BUTTON_AUTOMATION).claims).toEqual([expect.objectContaining({ claimId: pressed.claimId })]);
    await f.executor.dispose();
  });

  it("undoes a reversible action through its reverse, once, and says an action it cannot reverse stays", async () => {
    const hold = "      - invoke: invoices.hold\n        input:\n          id: '=record.id'\n";
    const f = await world({ descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS });
    await f.writeAutomations(markPaid(hold + settle));
    await f.executor.open();
    // Only Settle has no reverse, so only Settle is named before a press.
    expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], async () => (owner(f))))
      .toEqual([{ kind: "ready", automationId: BUTTON_AUTOMATION, irreversible: [{ name: "invoices.settle", label: "Settle" }] }]);
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    const pressed = await press(f, { recordId: invoice, pressId: pressId(23), confirmed: ["invoices.settle"] });
    if (pressed.busy) throw new Error("The press ran.");
    await f.until(() => f.settled.length === 1);
    expect((await f.record(invoice))?.values[STATUS]).toBe(`Settled by ${BUTTON_AUTOMATION}: pressed`);
    // Settle ran last and cannot go back, so Hold's reverse finds the invoice not on hold and refuses.
    await expect(f.executor.undo({ automationId: BUTTON_AUTOMATION, claimId: pressed.claimId, deletes: null }, async () => undefined))
      .rejects.toThrow("Hold was not undone. Release refused: This invoice is no longer on hold.");
    await f.executor.dispose();
  });

  it("presses by folder as the CLI does: a reversible action runs unasked, and one dohc cannot undo runs once confirmed by name", async () => {
    const hold = "      - invoke: invoices.hold\n        input:\n          id: '=record.id'\n";
    const f = await world({ descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS });
    await f.writeAutomations(markPaid(hold + settle));
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    // The window's press path, as main hands it to the CLI, over this computer's executor.
    type Operation = { workspace: { workspaceId: string; rootPath: string }; state: { collectionAutomations: typeof f.executor } };
    const { pressNamed } = registerAutomationButtonsIpc<{ isDestroyed(): boolean; send(): void }, { sender: { isDestroyed(): boolean; send(): void } }, Operation>({
      registerHandler: () => undefined,
      assertTrustedSender: () => undefined,
      withRendererWorkspaceOperation: async () => { throw new Error("No window presses here."); },
      readText: async () => null,
      buttonFields: async () => [],
      recordAt: async () => null,
      describeDataset: async () => { throw new Error("The CLI describes the dataset itself."); },
      pressedBy: async () => PRESSER,
      relayPress: async () => { throw new Error("Nothing relays here."); },
      relayInspect: async () => { throw new Error("Nothing relays here."); },
      serverCollection: async () => null,
      inspectionAccount: async () => null,
      inspectionChanged: () => undefined,
      pressWindows: createPressWindows(() => null),
    });
    const operation: Operation = { workspace: { workspaceId: "workspace", rootPath: f.root }, state: { collectionAutomations: f.executor } };
    const caller = { by: { kind: "human" as const }, withOperation: async <Result>(work: (op: Operation) => Promise<Result>) => await work(operation),
      describeDataset: async () => owner(f), watch: () => undefined };
    const input = { workspaceId: "workspace", collectionPath: "Budget", field: "Mark paid", recordId: JSON.stringify(invoice), confirm: [] as string[], pressKey: "cli-1" };
    // Hold names its reverse, so only Settle is asked about.
    await expect(pressNamed(input, caller)).resolves.toEqual({ confirm: [{ name: "invoices.settle", label: "Settle" }] });
    expect(f.host.automations.claims(BUTTON_AUTOMATION).claims).toEqual([]);
    const pressed = await pressNamed({ ...input, confirm: ["invoices.settle"] }, caller);
    if ("confirm" in pressed || pressed.busy || "relayed" in pressed) throw new Error("The press ran.");
    await f.until(() => f.settled.length === 1);
    expect((await f.record(invoice))?.values[STATUS]).toBe(`Settled by ${BUTTON_AUTOMATION}: pressed`);
    // The same key sent again answers the first run, and asks nothing.
    await expect(pressNamed(input, caller)).resolves.toEqual({ busy: false, claimId: pressed.claimId, settled: { outcome: "done", error: null } });
    expect(f.host.automations.claims(BUTTON_AUTOMATION).claims).toHaveLength(1);
    // A button that runs only a reversible action presses with nothing to confirm.
    await f.writeAutomations(markPaid(hold));
    f.executor.handleWatcherEvents([{ operation: "update", path: "Budget/automations.yaml" }]);
    const { id: other } = await f.create({ [STATUS]: "Open" });
    const held = await pressNamed({ ...input, recordId: JSON.stringify(other), pressKey: "cli-2" }, caller);
    if ("confirm" in held || held.busy || "relayed" in held) throw new Error("The press ran.");
    await f.until(() => f.settled.length === 2);
    expect((await f.record(other))?.values[STATUS]).toBe("On hold");
    await f.executor.dispose();
  });

  it("plans the runs a Stop and restore of one definition left out when a full Undo resumes after it stopped", async () => {
    const f = await world({ descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS });
    await f.writeAutomations(markPaid("      - invoke: invoices.hold\n        input:\n          id: '=record.id'\n"));
    await f.executor.open();
    const { id: first } = await f.create({ [STATUS]: "Open" });
    const pressed = await press(f, { recordId: first, pressId: pressId(25) });
    if (pressed.busy) throw new Error("The press ran.");
    await f.until(() => f.settled.length === 1);
    // A second run of the same claim under another definition held another invoice, as a start-over would.
    const { id: second } = await f.create({ [STATUS]: "Open" });
    const held = await f.host.action({ ...f.rules, operationId: HOLD, input: { id: second }, idempotencyKey: "owner-hold" });
    const store = createAutomationRunStore(preparedAutomationStoreFolder(f.root));
    const [run] = (await store.runsOf(BUTTON_AUTOMATION, pressed.claimId)).runs;
    await store.save({ ...run!, definitionHash: "0123456789abcdef", keySeed: "0123456789abcdef-2", startedAtMs: run!.startedAtMs + 1, applied: [{ ordinal: 0, writes: [
      { kind: "dataset-action", rules: f.rules, operationId: HOLD, tableId: TABLE, name: "Hold", revision: held.revision, undo: { id: second, status: "Open" }, reverseOperationId: RELEASE },
    ] }] });
    // Stop and restore undoes the second definition's run alone, and dohc stops once its reverse committed.
    f.crashAfterOwnerInvoke(RELEASE);
    await expect(f.executor.undoRunsOf([{ collectionPath: "Budget", id: "mark-paid", definitionHash: "0123456789abcdef" }], async () => undefined))
      .resolves.toMatchObject({ undone: 0, errorMessage: expect.stringContaining("dohc stopped.") });
    expect((await f.record(second))?.values[STATUS]).toBe("Open");
    // The full Undo sends the saved reverse again, which replays, and plans the first run's own.
    expect(await f.executor.undo({ automationId: BUTTON_AUTOMATION, claimId: pressed.claimId, deletes: null }, async () => undefined))
      .toEqual({ status: "undone", reverted: 0, removed: 0, deleted: 0, kept: 0, keptChanged: 0, gone: 0, changedSince: 0, missing: 0, irreversible: 0, actions: 0, actionsReversed: 2 });
    expect((await f.record(first))?.values[STATUS]).toBe("Open");
    expect((await store.runsOf(BUTTON_AUTOMATION, pressed.claimId)).runs.map((stored) => stored.undo)).toEqual(["done", "done"]);
    await f.executor.dispose();
  });

  it("leaves another definition's saved reverse when Stop and restore finishes an Undo that stopped, for a full Undo to send", async () => {
    const f = await world({ descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS });
    await f.writeAutomations(markPaid("      - invoke: invoices.hold\n        input:\n          id: '=record.id'\n"));
    await f.executor.open();
    const { id: first } = await f.create({ [STATUS]: "Open" });
    const pressed = await press(f, { recordId: first, pressId: pressId(26) });
    if (pressed.busy) throw new Error("The press ran.");
    await f.until(() => f.settled.length === 1);
    // A second run of the same claim under another definition held another invoice, as a start-over would.
    const { id: second } = await f.create({ [STATUS]: "Open" });
    const held = await f.host.action({ ...f.rules, operationId: HOLD, input: { id: second }, idempotencyKey: "owner-hold" });
    const store = createAutomationRunStore(preparedAutomationStoreFolder(f.root));
    const [run] = (await store.runsOf(BUTTON_AUTOMATION, pressed.claimId)).runs;
    await store.save({ ...run!, definitionHash: "0123456789abcdef", keySeed: "0123456789abcdef-2", startedAtMs: run!.startedAtMs + 1, applied: [{ ordinal: 0, writes: [
      { kind: "dataset-action", rules: f.rules, operationId: HOLD, tableId: TABLE, name: "Hold", revision: held.revision, undo: { id: second, status: "Open" }, reverseOperationId: RELEASE },
    ] }] });
    const undo = () => f.executor.undo({ automationId: BUTTON_AUTOMATION, claimId: pressed.claimId, deletes: null }, async () => undefined);
    // A full Undo saves both reverses with the second run, and dohc stops once the first reverse committed.
    f.crashAfterOwnerInvoke(RELEASE);
    await expect(undo()).rejects.toThrow("dohc stopped.");
    expect((await f.record(second))?.values[STATUS]).toBe("Open");
    // Stop and restore of the second definition finishes its run, and leaves the first run's reverse unsent.
    await expect(f.executor.undoRunsOf([{ collectionPath: "Budget", id: "mark-paid", definitionHash: "0123456789abcdef" }], async () => undefined)).resolves.toMatchObject({ undone: 1, left: 0 });
    expect((await f.record(first))?.values[STATUS]).toBe("On hold");
    // A full Undo sends it.
    expect(await undo()).toMatchObject({ status: "undone", actionsReversed: 2 });
    expect((await f.record(first))?.values[STATUS]).toBe("Open");
    await f.executor.dispose();
  });

  it("refuses, saying which action it cannot put back, when run history dropped the run a saved reverse undoes", async () => {
    const f = await world({ descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS });
    await f.writeAutomations(markPaid("      - invoke: invoices.hold\n        input:\n          id: '=record.id'\n"));
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    const pressed = await press(f, { recordId: invoice, pressId: pressId(27) });
    if (pressed.busy) throw new Error("The press ran.");
    await f.until(() => f.settled.length === 1);
    // A saved list holds the reverse of a Hold whose run is no longer saved.
    const store = createAutomationRunStore(preparedAutomationStoreFolder(f.root));
    const [run] = (await store.runsOf(BUTTON_AUTOMATION, pressed.claimId)).runs;
    await store.recordUndoCalls(run!, ["gone"], [
      { kind: "reverse", rules: f.rules, operationId: RELEASE, action: HOLD, revision: 999, input: { id: "gone", status: "Open" }, idempotencyKey: "u.gone" },
    ]);
    expect(await f.executor.undo({ automationId: BUTTON_AUTOMATION, claimId: pressed.claimId, deletes: null }, async () => undefined)).toEqual({
      status: "refused", reason: "dohc no longer has the run that ran Hold, so it cannot finish this Undo. Undo what Hold changed by hand.",
    });
    expect((await f.record(invoice))?.values[STATUS]).toBe("On hold");
    expect((await store.runsOf(BUTTON_AUTOMATION, pressed.claimId)).runs.map((stored) => stored.undo)).toEqual([null]);
    await f.executor.dispose();
  });

  it("puts a held invoice back through Release, and a second Undo sends nothing", async () => {
    const f = await world({ descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS });
    await f.writeAutomations(markPaid("      - invoke: invoices.hold\n        input:\n          id: '=record.id'\n"));
    await f.executor.open();
    expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], async () => (owner(f))))
      .toEqual([{ kind: "ready", automationId: BUTTON_AUTOMATION }]);
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    const pressed = await press(f, { recordId: invoice, pressId: pressId(24) });
    if (pressed.busy) throw new Error("The press ran.");
    await f.until(() => f.settled.length === 1);
    expect((await f.record(invoice))?.values[STATUS]).toBe("On hold");
    expect(await f.executor.undo({ automationId: BUTTON_AUTOMATION, claimId: pressed.claimId, deletes: null }, async () => undefined))
      .toEqual({ status: "undone", reverted: 0, removed: 0, deleted: 0, kept: 0, keptChanged: 0, gone: 0, changedSince: 0, missing: 0, irreversible: 0, actions: 0, actionsReversed: 1 });
    expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
    // The reverse was saved with the run before it was sent, as a delete is.
    const { runs } = await createAutomationRunStore(preparedAutomationStoreFolder(f.root)).runsOf(BUTTON_AUTOMATION, pressed.claimId);
    expect(runs.flatMap((run) => run.undoCalls)).toEqual([expect.objectContaining({ kind: "reverse", operationId: RELEASE, action: HOLD })]);
    const releases = () => f.host.history({ datasetId: definition.datasetId }).entries.filter((entry) => entry.operation === "invoices.release").length;
    expect(releases()).toBe(1);
    expect(await f.executor.undo({ automationId: BUTTON_AUTOMATION, claimId: pressed.claimId, deletes: null }, async () => undefined))
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
    expect(f.host.automations.claims(BUTTON_AUTOMATION).claims).toMatchObject([{ state: "pending" }]);
    // The next executor sends the saved request under the same key: the host answers from its receipt.
    f.makeExecutor();
    await f.executor.open();
    await f.until(() => f.host.automations.claims(BUTTON_AUTOMATION).claims[0]?.state === "done");
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
    const reason = "Only you can use Settle in Budget, and ana@dohc.test can also edit these automations.";
    expect(await f.executor.automationsIn("Budget")).toMatchObject({ automations: [{ reach: { kind: "checked", steps: expect.arrayContaining([{ verdict: "stopped", reason }]) } }] });
    const { id: invoice } = await f.create({});
    const described = owner(f);
    const withoutAction = { ...described, operations: described.operations.filter((operation) => operation.operationId !== SETTLE) };
    await expect(press(f, { recordId: invoice, pressId: pressId(21) }, withoutAction)).rejects.toThrow("Only people who can edit Invoices can use this button.");
    expect(f.host.automations.claims(BUTTON_AUTOMATION).claims).toEqual([]);
    await f.executor.dispose();
  });

  it("runs a press on the record as it is now, for the person who pressed, once, and tells the window how it settled", async () => {
    const f = await world();
    await f.writeAutomations(markPaid());
    await f.executor.open();
    expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], async () => (owner(f))))
      .toEqual([{ kind: "ready", automationId: BUTTON_AUTOMATION }]);
    // A button watches nothing; its presses claim.
    expect(f.host.automations.subscriptions()).toEqual([]);
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    const watched: string[] = [];
    const pressed = await f.executor.pressDataset({ datasetId: definition.datasetId, table: "Invoices", field: "Mark paid", recordId: JSON.stringify(invoice), pressId: pressId(1), pressedBy: PRESSER, by: { kind: "human" }, confirmed: [] },
      async () => owner(f), (claimId) => watched.push(claimId));
    if (pressed.busy) throw new Error("The press ran.");
    expect(pressed.settled).toBeNull();
    expect(watched).toEqual([pressed.claimId]);
    // The ledger remembers the press by its id, so the CLI answers a resend with this run.
    await expect(f.executor.datasetPressed(pressId(1))).resolves.toBe(true);
    await expect(f.executor.datasetPressed(pressId(2))).resolves.toBe(false);
    await f.until(() => f.settled.length === 1);
    expect(f.settled).toEqual([{ claimId: pressed.claimId, outcome: "done", error: null }]);
    expect((await f.record(invoice))?.values[STATUS]).toBe(`Paid by Person ${PRESSER} with Mark paid`);
    expect(f.host.automations.claims(BUTTON_AUTOMATION).claims).toEqual([expect.objectContaining({ claimId: pressed.claimId, state: "done", depth: 0,
      fact: { kind: "button", datasetId: definition.datasetId, tableId: TABLE, recordId: invoice, fieldId: MARK_PAID, definitionHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      actor: { kind: "owner", userId: PRESSER } })]);
    // The press sent again after a lost reply answers how its run ended, and runs nothing more.
    expect(await press(f, { recordId: invoice, pressId: pressId(1) })).toEqual({ busy: false, claimId: pressed.claimId, settled: { outcome: "done", error: null } });
    await expect(press(f, { recordId: "another", pressId: pressId(1) })).rejects.toThrow("already names another press");
    expect(f.host.automations.claims(BUTTON_AUTOMATION).claims).toHaveLength(1);
    // History names the automation, which wrote as the owner.
    expect(f.host.history({ datasetId: definition.datasetId }).entries[0]).toMatchObject({ automation: { automationId: BUTTON_AUTOMATION, depth: 1 } });
    await f.executor.dispose();
  });

  it("runs an agent's press for its person one step deeper, reads it as the agent's, and stops one at the cap in words", async () => {
    const f = await world();
    await f.writeAutomations(markPaid());
    await f.executor.open();
    const { id: invoice } = await f.create({ [STATUS]: "Open" });
    const { id: other } = await f.create({ [STATUS]: "Open" });
    const agent = (depth: number) => ({ kind: "agent" as const, originId: "dohc-mcp", depth });
    const input = { datasetId: definition.datasetId, table: "Invoices", field: "Mark paid", pressedBy: PRESSER, confirmed: [] };
    const pressed = await f.executor.pressDataset({ ...input, recordId: JSON.stringify(invoice), pressId: pressId(1), by: agent(2) }, async () => owner(f), () => undefined);
    if (pressed.busy) throw new Error("The press ran.");
    await f.until(() => f.settled.length === 1);
    expect(f.host.automations.claims(BUTTON_AUTOMATION).claims).toEqual([expect.objectContaining({ depth: 2, actor: { kind: "owner", userId: PRESSER, agent: { depth: 2 } } })]);
    // The run writes one step deeper than the press, and run history names the agent.
    expect(f.host.history({ datasetId: definition.datasetId }).entries[0]).toMatchObject({ automation: { automationId: BUTTON_AUTOMATION, depth: 3 } });
    expect(await f.executor.run(BUTTON_AUTOMATION, pressed.claimId)).toMatchObject({ trigger: { kind: "button", by: "agent", depth: 2 } });
    const reports = f.failureReports.length;
    const stopped = await f.executor.pressDataset({ ...input, recordId: JSON.stringify(other), pressId: pressId(2), by: agent(4) }, async () => owner(f), () => undefined);
    expect(stopped).toMatchObject({ busy: false, settled: { outcome: "failed", error: "This press did not run. dohc stops a chain after automations and agents start each other 4 times in a row. Check which automations start each other." } });
    // The stop is a failure the owner hears about, without waiting for another change.
    await f.until(() => f.failureReports.length > reports);
    expect(f.failureReports.at(-1)).toMatchObject({ failure: { automationId: BUTTON_AUTOMATION, chainStopped: true } });
    expect((await f.record(other))?.values[STATUS]).toBe("Open");
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
      expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], async () => (description))).toEqual([{ kind: "disabled", reason: refusal }]);
    }
    await expect(f.executor.pressDataset({ datasetId: definition.datasetId, table: "Invoices", field: "Mark paid", recordId: "not json", pressId: pressId(3), pressedBy: PRESSER, by: { kind: "human" }, confirmed: [] },
      async () => described, () => undefined)).rejects.toThrow("This record is not in Invoices.");
    // A record the table does not hold gets no claim.
    await expect(press(f, { recordId: "missing", pressId: pressId(3) })).rejects.toThrow("This record is no longer in Invoices.");
    expect(f.host.automations.claims(BUTTON_AUTOMATION).claims).toEqual([]);
    await f.executor.dispose();
  });

  it("refuses a press of a button whose code step can use an operation the presser cannot, however little the code changes", async () => {
    const f = await world();
    // The code only sets Status, and Bob may use only what a Set Status step would need.
    await f.writeAutomations(markPaid("      - run: \"return { set: { Status: 'Approved' } };\"\n"));
    await f.executor.open();
    const { id: invoice } = await f.create({});
    const described = owner(f);
    const only = (...operationIds: string[]) => ({ ...described, operations: described.operations.filter((operation) => operationIds.includes(operation.operationId)) });
    const refusal = "Only people who can edit Invoices can use this button.";
    for (const description of [only(LIST, STATUS_ONLY), only(LIST, STATUS_ONLY, EDIT)]) {
      expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], async () => (description))).toEqual([{ kind: "disabled", reason: refusal }]);
      await expect(press(f, { recordId: invoice, pressId: pressId(2) }, description)).rejects.toThrow(refusal);
    }
    expect(f.host.automations.claims(BUTTON_AUTOMATION).claims).toEqual([]);
    // Someone who may use every edit, create, and read on the table can press it.
    const pressed = await press(f, { recordId: invoice, pressId: pressId(3) }, only(LIST, STATUS_ONLY, EDIT, CREATE));
    expect(pressed).toMatchObject({ busy: false });
    await f.until(async () => (await f.record(invoice))?.values[STATUS] === "Approved");
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
    expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], async () => (owner(f)))).toEqual([{ kind: "disabled", reason }]);
    await expect(press(f, { recordId: invoice, pressId: pressId(11) })).rejects.toThrow(reason);
    // Someone who cannot edit the table still learns only that.
    const reader = { ...owner(f), operations: owner(f).operations.filter((operation) => operation.operationId === LIST) };
    expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], async () => (reader)))
      .toEqual([{ kind: "disabled", reason: "Only people who can edit Invoices can use this button." }]);
    expect(f.host.automations.claims(BUTTON_AUTOMATION).claims).toEqual([]);
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
    // Its notice goes to the person who pressed too.
    await f.until(() => f.failureReports.length === 1);
    expect(f.failureReports[0]).toMatchObject({ failure: { claimId: pressed.claimId, neverStarted: false, chainStopped: false }, startedBy: PRESSER });
    await f.executor.dispose();
  });

  it("lists a dataset that moved to a server with its buttons off, saying why, and refuses a press the same way", async () => {
    const f = await world();
    await f.writeAutomations(markPaid());
    await f.executor.open();
    const { id: invoice } = await f.create({});
    f.moveToServer();
    const moved = "This Collection moved to a server, so its buttons can't run here.";
    expect(await f.executor.datasetButtons(definition.datasetId, [{ field: "Mark paid", table: "Invoices" }], async () => (owner(f))))
      .toEqual([{ kind: "disabled", reason: moved }]);
    await expect(press(f, { recordId: invoice, pressId: pressId(10) })).rejects.toThrow(moved);
    expect(f.host.automations.claims(BUTTON_AUTOMATION).claims).toEqual([]);
    await f.executor.dispose();
  });

  it("shows a Collection moved to the server as the server's, and never subscribes, schedules or presses it here", async () => {
    const f = await world({ descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS });
    // Each would run here if this computer still kept the Collection.
    await f.writeAutomations(markPaid(settle) + closePaid("      - invoke: invoices.hold\n        input:\n          id: '=record.id'\n") + `  - id: nightly
    name: Nightly
    when: {schedule: day, timezone: UTC}
    do:
      - notify: Invoices to close
        to: [user-owner]
`);
    // What the server answers: its approved rules and grants, and what it runs.
    const server = { approved: f.host.automations.revision(BUDGET), generated: f.host.automations.generated(BUDGET), grants: f.host.automations.dataGrants(BUDGET) };
    let runs: ServerDataset["runs"] = "all";
    const asked: string[] = [];
    // The Collection moved, so this computer's store keeps its transfer record.
    const store = new DatabaseSync(join(f.root, ".dohc", "local", "datasets", "state.sqlite"));
    try {
      store.prepare("INSERT INTO local_dataset_transfers VALUES(?,?,?,?,?,'imported',NULL,NULL,'{}')").run("workspace", BUDGET, id(400), "https://relay.example", "{}");
    } finally { store.close(); }
    // This computer runs the workspace's schedules, as the one that keeps the other Collections may.
    const executor = f.makeExecutor({ groupHost: async () => 0,
      serverDataset: async (datasetId) => { asked.push(datasetId); return datasetId === BUDGET ? { ...server, runs } : null; } });
    onTestFinished(() => executor.dispose());
    await executor.open();
    await executor.idle();
    // Nothing here claims its record changes or its schedule, and a person asked nothing yet.
    expect(f.host.automations.subscriptions()).toEqual([]);
    expect(executor.schedules()).toEqual([]);
    expect(executor.hasHostTriggers()).toBe(false);
    expect(asked).toEqual([]);
    const { id: invoice } = await f.create({ [PAID]: false });
    await f.edit(invoice, { [PAID]: true });
    await executor.idle();
    expect(f.claims()).toEqual([]);

    const listed = await executor.automationsIn("Budget");
    expect(listed).toMatchObject({ status: "read", onServer: { runs: true }, automations: [
      { valid: true, automationId: BUTTON_AUTOMATION, cannotRun: null, lastRun: null, reach: { kind: "checked" } },
      { valid: true, automationId: AUTOMATION, cannotRun: null, lastRun: null },
      { valid: true, automationId: `collection:${BUDGET}#nightly`, cannotRun: null },
    ] });
    expect(await executor.datasetCollection(BUDGET)).toEqual({ status: "found", collectionPath: "Budget" });
    const button = () => executor.datasetButtons(BUDGET, [{ field: "Mark paid", table: "Invoices" }], async () => owner(f));
    // The button runs on the server, which takes the press after the person confirms what can't be undone.
    expect(await button()).toEqual([{ kind: "ready", automationId: BUTTON_AUTOMATION, irreversible: [{ name: "invoices.settle", label: "Settle" }] }]);
    await expect(press(f, { recordId: invoice, pressId: pressId(40), confirmed: ["invoices.settle"] })).rejects.toThrow("not approved");
    expect(f.host.automations.claims(BUTTON_AUTOMATION).claims).toEqual([]);

    // The server runs schedules only when Schedules run on names it.
    runs = "no-schedules";
    expect(await executor.automationsIn("Budget")).toMatchObject({ onServer: { runs: true }, automations: [
      { cannotRun: null }, { cannotRun: null }, { cannotRun: SERVER_TRIGGERS_ELSEWHERE },
    ] });
    // A server that runs no automations runs none of them.
    runs = "off";
    expect(await executor.automationsIn("Budget")).toMatchObject({ onServer: { runs: false }, automations: [
      { cannotRun: AUTOMATION_SERVER_OFF }, { cannotRun: AUTOMATION_SERVER_OFF }, { cannotRun: AUTOMATION_SERVER_OFF },
    ] });
    expect(await button()).toEqual([{ kind: "disabled", reason: AUTOMATION_SERVER_OFF }]);
    expect(f.errors).toEqual([]);
  });

  it("says a Collection's move didn't finish in its panel note, its buttons and its presses, never that its rules aren't approved", async () => {
    const f = await world();
    await f.writeAutomations(markPaid());
    // The move stopped after this computer stopped changing the Collection, so its store keeps the transfer record.
    const store = new DatabaseSync(join(f.root, ".dohc", "local", "datasets", "state.sqlite"));
    try {
      store.prepare("INSERT INTO local_dataset_transfers VALUES(?,?,?,?,?,'ready',NULL,NULL,NULL)").run("workspace", BUDGET, id(402), "https://relay.example", "{}");
    } finally { store.close(); }
    // What main answers for it: the words of the move's own error, read without trying the move again.
    const unfinished = new CollectionMoveUnfinishedError("relay.example", { cause: null }).message;
    expect(unfinished).toBe("This Collection didn't finish moving to relay.example. Its records are kept on this computer.");
    const executor = f.makeExecutor({ serverDataset: async (datasetId) => datasetId === BUDGET ? { unfinished } : null });
    onTestFinished(() => executor.dispose());
    await executor.open();
    const { id: invoice } = await f.create({});

    // The ⚡ panel's note, the automations it lists, and the button.
    expect(await executor.datasetCollection(BUDGET)).toEqual({ status: "cannot-run", reason: unfinished });
    expect(await executor.automationsIn("Budget")).toMatchObject({ status: "read", automations: [{ automationId: BUTTON_AUTOMATION, cannotRun: unfinished }] });
    expect(await executor.datasetButtons(BUDGET, [{ field: "Mark paid", table: "Invoices" }], async () => owner(f))).toEqual([{ kind: "disabled", reason: unfinished }]);
    // A window's press, and a press by folder as the CLI and agents send it, refuse with the button's words.
    await expect(press(f, { recordId: invoice, pressId: pressId(41) })).rejects.toThrow(unfinished);
    type Operation = { workspace: { workspaceId: string; rootPath: string }; state: { collectionAutomations: typeof executor } };
    const { pressNamed } = registerAutomationButtonsIpc<{ isDestroyed(): boolean; send(): void }, { sender: { isDestroyed(): boolean; send(): void } }, Operation>({
      registerHandler: () => undefined,
      assertTrustedSender: () => undefined,
      withRendererWorkspaceOperation: async () => { throw new Error("No window presses here."); },
      readText: async () => null,
      buttonFields: async () => { throw new Error("A dataset's buttons aren't a document Collection's."); },
      recordAt: async () => null,
      describeDataset: async () => { throw new Error("The CLI describes the dataset itself."); },
      pressedBy: async () => PRESSER,
      relayPress: async () => { throw new Error("Nothing relays here."); },
      relayInspect: async () => { throw new Error("Nothing relays here."); },
      serverCollection: async () => null,
      inspectionAccount: async () => null,
      inspectionChanged: () => undefined,
      pressWindows: createPressWindows(() => null),
    });
    const operation: Operation = { workspace: { workspaceId: "workspace", rootPath: f.root }, state: { collectionAutomations: executor } };
    const caller = { by: { kind: "agent" as const, originId: "agent-run-1", depth: 1 }, withOperation: async <Result>(work: (op: Operation) => Promise<Result>) => await work(operation),
      describeDataset: async () => owner(f), watch: () => undefined };
    await expect(pressNamed({ workspaceId: "workspace", collectionPath: "Budget", field: "Mark paid", recordId: JSON.stringify(invoice), confirm: [], pressKey: "cli-1" }, caller))
      .rejects.toThrow(unfinished);
    expect(f.host.automations.claims(BUTTON_AUTOMATION).claims).toEqual([]);
    expect(f.errors).toEqual([]);
  });

  it("checks a button on the server whose step adds a record to another Collection on the server", async () => {
    const f = await world();
    const ledger = generateDatasetSources({ formatVersion: 1, datasetId: id(500), name: "Ledger", schemaPath: "Ledger/schema.sql", operationsPath: "Ledger/operations.js",
      tables: [{ tableId: id(501), name: "Entries", sqlName: "entries", primaryKey: "id", fields: [
        { fieldId: id(502), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
        { fieldId: id(503), name: "Note", sqlColumn: "note", type: "text", required: false, unique: false },
      ] }],
      operations: [{ operationId: id(504), name: "entries.create", label: "Create", tableId: id(501), kind: "create", access: "owner", readOnly: false, fieldIds: [id(502), id(503)] }],
    });
    for (const [path, text] of Object.entries(ledger.files)) {
      await mkdir(join(f.root, dirname(path)), { recursive: true });
      await writeFile(join(f.root, path), text);
    }
    const ledgerRules = describeDatasetRevision({ definition: ledger.definition, revision: 1,
      schemaSql: ledger.files["Ledger/schema.sql"]!, operationSource: ledger.files["Ledger/operations.js"]! });
    await f.writeAutomations(markPaid("      - add-record:\n          ID: '=record.id'\n          Note: Paid\n        collection: Ledger\n        operation: entries.create\n"));
    const store = new DatabaseSync(join(f.root, ".dohc", "local", "datasets", "state.sqlite"));
    try {
      store.prepare("INSERT INTO local_dataset_transfers VALUES(?,?,?,?,?,'imported',NULL,NULL,'{}')").run("workspace", BUDGET, id(401), "https://relay.example", "{}");
    } finally { store.close(); }
    const budget = { approved: f.host.automations.revision(BUDGET), generated: true, grants: f.host.automations.dataGrants(BUDGET), runs: "all" as const };
    const executor = f.makeExecutor({ serverDataset: async (datasetId) => datasetId === BUDGET ? budget
      : datasetId === id(500) ? { approved: ledgerRules, generated: true, grants: { workspaceId: "workspace", grants: [] }, runs: "all" } : null });
    onTestFinished(() => executor.dispose());
    await executor.open();
    // Neither Collection is kept here, so the step's destination comes from the server too.
    const describe = async (datasetId: string) => datasetId === BUDGET ? await owner(f) : describeApprovedDataset(ledgerRules, ledgerRules.definition.operations);
    expect(await executor.datasetButtons(BUDGET, [{ field: "Mark paid", table: "Invoices" }], describe)).toEqual([{ kind: "ready", automationId: BUTTON_AUTOMATION }]);
    expect(await executor.automationsIn("Budget")).toMatchObject({ status: "read", automations: [{ automationId: BUTTON_AUTOMATION, cannotRun: null }] });
    // Nothing here runs either of them.
    expect(f.host.automations.subscriptions()).toEqual([]);
    expect(executor.locate(BUTTON_AUTOMATION)).toBeNull();
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
