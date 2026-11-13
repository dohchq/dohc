import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { type AutomationClaim } from "@dohc/workspace-engine-client";
import { definitionHash } from "@dohc/automation-executor/automation-plan";
import { SHARED_BUTTON_DENIED } from "@dohc/automation-executor/button-presser";
import { datasetAutomationFixture } from "./collectionAutomationDatasetTestSupport";

const { id, OWNER, BUDGET, AUTOMATION, PAID, STATUS, LIST, CREATE, STATUS_ONLY, definition, closePaid, ACTION_DESCRIPTOR, ACTION_OPERATIONS, world, engineClaim, authoredDestination } = datasetAutomationFixture();

it("retries a mixed run's document fields while keeping its dataset Undo counts", async () => {
  const f = await world({ documents: true });
  const invoice = await f.create({ [STATUS]: "Open" });
  await mkdir(join(f.root, "Log"), { recursive: true });
  await writeFile(join(f.root, "Log/collection.yaml"), "fields:\n  Status:\n    type: text\n");
  await writeFile(join(f.root, "Log/automations.yaml"), `version: 1
automations:
  - id: mixed
    name: Mixed
    when: record-added
    do:
      - set: {Status: Closed}
      - find: record.Status == "Open"
        collection: Budget
        operation: invoices.list
        as: invoices
      - set: {Status: Closed}
        records: invoices
        operation: invoices.status
`);
  const document = { id: "document", path: "Log/document.md", status: "Original" };
  f.documents.set(document.id, document);
  await f.executor.open();
  const automationId = "collection:Log#mixed";
  const claim: AutomationClaim = { ...engineClaim("mixed-undo", "pending", Date.now(), automationId),
    collectionPath: "Log", recordId: document.id, trigger: { historyId: 1 },
    change: { kind: "added", authorOriginId: null, actorKind: "human", onBehalfOf: null,
      sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 } };
  f.engineClaims.push(claim);
  f.executor.notifyClaimed();
  await f.until(() => claim.state === "done" || claim.state === "failed");
  expect(claim.state).toBe("done");
  expect(document.status).toBe("Closed");
  expect((await f.record(invoice.id))?.values[STATUS]).toBe("Closed");
  document.status = "Someone else's edit";
  await f.edit(invoice.id, { [STATUS]: "Someone else's edit" });
  const undo = () => f.executor.undo({ automationId, claimId: claim.claimId, deletes: null }, async () => { throw new Error("No record should be removed."); });
  expect(await undo()).toMatchObject({ status: "undone", reverted: 0, changedSince: 2 });
  const before = f.host.history({ datasetId: definition.datasetId }).entries;
  document.status = "Closed";
  expect(await undo()).toMatchObject({ status: "undone", reverted: 1, changedSince: 1 });
  expect(document.status).toBe("Original");
  expect((await f.record(invoice.id))?.values[STATUS]).toBe("Someone else's edit");
  expect(f.host.history({ datasetId: definition.datasetId }).entries).toEqual(before);
  expect(await undo()).toMatchObject({ status: "refused", reason: expect.stringContaining("History") });
  await f.executor.dispose();
});

it.each([true])("invokes and reverses another authored dataset through the real host from authored source %s", async (authoredSource) => {
  const f = await world(authoredSource ? { descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS } : {});
  const other = await authoredDestination(f);
  await f.writeAutomations(closePaid(`      - invoke: invoices.hold
        collection: Other
        input: {id: '${other.record.id}'}
`));
  await f.executor.open();
  const source = await f.create({});
  await f.edit(source.id, { [PAID]: true });
  await f.until(() => f.claims()[0]?.state === "done" || f.claims()[0]?.state === "failed");
  expect(f.claims()[0]).toMatchObject({ state: "done" });
  expect((await other.rows()).result).toMatchObject({ rows: [{ values: { [STATUS]: "On hold" } }] });
  expect((await f.record(source.id))?.values[STATUS]).toBe("Open");
  f.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [{ grantId: "source-editor", recipientUserId: "editor", recipientEmail: "editor@example.com", files: { paths: ["Budget"], access: "edit", versionId: null }, channel: null }] });
  expect(await f.executor.undo({ deletes: null, automationId: AUTOMATION, claimId: f.claims()[0]!.claimId }, async () => undefined))
    .toMatchObject({ status: "refused", reason: expect.stringContaining("Release in Other") });
  expect((await other.rows()).result).toMatchObject({ rows: [{ values: { [STATUS]: "On hold" } }] });
  f.setRoster(OWNER);
  expect(await f.executor.undo({ deletes: null, automationId: AUTOMATION, claimId: f.claims()[0]!.claimId }, async () => undefined))
    .toMatchObject({ status: "undone", actionsReversed: 1 });
  expect((await other.rows()).result).toMatchObject({ rows: [{ values: { [STATUS]: "Original" } }] });
  await f.executor.dispose();
});

it("checks document buttons against the caller's destination grant and refuses an unconfirmed action before claiming", async () => {
  const f = await world({ documents: true, descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS });
  await mkdir(join(f.root, "Log"), { recursive: true });
  await writeFile(join(f.root, "Log/collection.yaml"), "fields:\n  Send:\n    type: button\n");
  await writeFile(join(f.root, "Log/automations.yaml"), `version: 1
automations:
  - id: send
    name: Send
    when: {button: Send}
    do:
      - invoke: invoices.settle
        collection: Budget
        input: {id: destination}
`);
  await f.executor.open();
  const input = { collectionPath: "Log", field: "Send", recordId: "source", confirmed: [], pressId: id(206), pressedBy: "user-owner", by: { kind: "human" as const } };
  const describe = async (datasetId: string) => f.host.describe(datasetId);
  expect(await f.executor.buttons("Log", ["Send"])).toMatchObject([{ state: { kind: "disabled" } }]);
  expect(await f.executor.buttons("Log", ["Send"], async (id) => ({ ...await describe(id), operations: [] }))).toMatchObject([{ state: { kind: "disabled" } }]);
  expect(await f.executor.buttons("Log", ["Send"], describe)).toMatchObject([{ state: { kind: "ready", irreversible: [{ name: `${BUDGET}/invoices.settle` }] } }]);
  await expect(f.executor.press(input, () => undefined, async () => undefined, describe)).rejects.toThrow("changed after it was pressed");
  const automationFile = parseAutomationsFile(await readFile(join(f.root, "Log/automations.yaml"), "utf8"));
  const automation = automationFile?.status === "read" ? automationFile.entries.find((entry) => entry.status === "valid") : undefined;
  if (automation?.status !== "valid") throw new Error("Expected the document button automation");
  const relayed = { automationId: "collection:Log#send", collectionPath: "Log", definitionHash: definitionHash(automation.automation), recordId: "source", confirmed: [], pressId: id(207), pressedBy: "user-recipient" };
  f.registerPress(relayed);
  await expect(f.executor.pressRelayed(relayed, () => undefined)).rejects.toThrow(SHARED_BUTTON_DENIED);
  expect(f.engineClaims).toEqual([]);
  await f.executor.dispose();
});

it.each([
  ["Find", "      - find: 'true'\n        collection: Budget\n        operation: invoices.list\n        as: matches"],
  ["unresolved destination", "      - find: 'true'\n        collection: Missing\n        as: matches"],
])("checks the named presser for %s before claiming", async (name, steps) => {
  const f = await world({ documents: true });
  await mkdir(join(f.root, "Log"), { recursive: true });
  await writeFile(join(f.root, "Log/collection.yaml"), "fields:\n  Send:\n    type: button\n  Status:\n    type: text\n");
  await writeFile(join(f.root, "Log/automations.yaml"), `version: 1\nautomations:\n  - id: send\n    name: Send\n    when: {button: Send}\n    do:\n${steps}\n`);
  await f.executor.open();
  const automationFile = parseAutomationsFile(await readFile(join(f.root, "Log/automations.yaml"), "utf8"));
  const automation = automationFile?.status === "read" ? automationFile.entries.find((entry) => entry.status === "valid") : undefined;
  if (automation?.status !== "valid") throw new Error("Expected the document button automation");
  const input = { automationId: "collection:Log#send", collectionPath: "Log", definitionHash: definitionHash(automation.automation), recordId: "source", confirmed: [], pressId: id(208), pressedBy: "user-recipient" };
  f.registerPress(input);
  f.documents.set("source", { id: "source", path: "Log/source.md", status: "Source" });
  f.grant("g-recipient", "user-recipient", [LIST, CREATE, STATUS_ONLY]);
  f.executor.datasetsChanged();
  await f.executor.idle();
  const inspection = await f.executor.inspectRelayed(input.pressId);
  const deniedBeforeClaim = name === "unresolved destination" || name === "Find without a pinned operation";
  if (deniedBeforeClaim) expect(inspection).toEqual({ kind: "denied", reason: SHARED_BUTTON_DENIED });
  else {
    expect(inspection.kind).toBe("ready");
    const result = await f.executor.pressRelayed(input, () => undefined);
    if (result.pressed.busy) throw Error("Expected a claim");
    const claimId = result.pressed.claimId;
    await f.until(() => f.engineClaims.find(claim => claim.claimId === claimId)?.state === "done");
  }
  f.grant("g-recipient", "user-recipient", []);
  f.executor.datasetsChanged();
  await f.executor.idle();
  await expect(f.executor.pressRelayed(input, () => undefined)).rejects.toThrow(SHARED_BUTTON_DENIED);
  expect(f.engineClaims).toHaveLength(deniedBeforeClaim ? 0 : 1);
  await f.executor.dispose();
});
