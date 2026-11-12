import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { datasetBaseFolder } from "@dohc/security-contract/dataset";
import { parseAutomationsFile, type Automation } from "@dohc/workspace-contracts/automations";
import { type AutomationClaim } from "@dohc/workspace-engine-client";
import { generateDatasetSchemaChange } from "../workspaces/datasetSchemaChanges";
import { generateDatasetSources } from "../workspaces/datasetGenerator";
import { definitionHash } from "@dohc/automation-executor/automation-plan";
import { SHARED_BUTTON_DENIED } from "@dohc/automation-executor/button-presser";
import { datasetAutomationFixture } from "./collectionAutomationDatasetTestSupport";

const { id, OWNER, BUDGET, AUTOMATION, TABLE, PAID, STATUS, NOTES, FINISHED, LIST, CREATE, STATUS_ONLY, definition, files, closePaid, ACTION_DESCRIPTOR, ACTION_OPERATIONS, world, engineClaim, authoredDestination } = datasetAutomationFixture();

it("adds, finds and sets another approved dataset without automations, through the real host", async () => {
  const f = await world();
  const other = generateDatasetSources({ ...definition, datasetId: id(200), name: "Other", schemaPath: "Other/schema.sql", operationsPath: "Other/operations.js" });
  for (const [path, text] of Object.entries(other.files)) { await mkdir(dirname(join(f.root, path)), { recursive: true }); await writeFile(join(f.root, path), text); }
  const prepared = await f.host.prepare({ descriptorPath: "Other/dataset.json", adapter: f.adapter });
  const approved = await f.host.approve({ preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256 });
  const rules = { datasetId: other.definition.datasetId, revision: approved.revision, revisionSha256: approved.revisionSha256 };
  await f.writeAutomations(closePaid(`      - add-record: {Status: Open}
        collection: Other
        operation: invoices.create
        as: added
      - set: {Status: Closed}
        records: added
        operation: invoices.status
      - find: record.Status == "Closed"
        collection: Other
        operation: invoices.list
        as: found
      - set: {Status: Found}
        records: found
        operation: invoices.status
`));
  await f.executor.open();
  const { id: invoice } = await f.create({});
  await f.edit(invoice, { [PAID]: true });
  await f.until(() => f.claims()[0]?.state === "done" || f.claims()[0]?.state === "failed");
  expect(f.claims()[0]?.state).toBe("done");
  const result = await f.host.query({ ...rules, operationId: LIST, input: { limit: 50 }, idempotencyKey: "verify" });
  expect(result.result).toMatchObject({ rows: [{ values: { [STATUS]: "Found", [PAID]: false } }] });
  expect((await f.record(invoice))?.values[STATUS]).toBe("Open");
  await f.executor.dispose();
});

it("routes Undo to document writes when the source is a dataset, even after its definition is deleted", async () => {
  const f = await world({ documents: true });
  await f.writeAutomations(closePaid('      - add-record: {Status: Added}\n        collection: Log\n'));
  await f.executor.open();
  const { id: invoice } = await f.create({});
  await f.edit(invoice, { [PAID]: true });
  await f.until(() => f.claims()[0]?.state === "done" || f.claims()[0]?.state === "failed");
  expect(f.claims()[0]?.state).toBe("done");
  expect(f.documents.size).toBe(1);
  await f.writeAutomations("");
  const undone = await f.executor.undo({ deletes: null, automationId: AUTOMATION, claimId: f.claims()[0]!.claimId }, async (path) => {
    for (const [id, record] of f.documents) if (record.path === path) f.documents.delete(id);
  });
  expect(undone).toMatchObject({ status: "undone", removed: 1 });
  expect(f.documents.size).toBe(0);
  await f.executor.dispose();
});

it("lists and confirms a held cross-Collection step after its editor leaves", async () => {
  const ana = { grantId: "g-ana", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", files: { paths: ["Budget"], versionId: null, access: "edit" as const }, channel: null };
  const f = await world({ documents: true, roster: { kind: "owner", ownerUserId: "user-owner", grants: [ana] } });
  await f.writeAutomations(closePaid('      - add-record: {Status: Added}\n        collection: Log\n'));
  await f.executor.open();
  await f.executor.automationsIn("Budget");
  f.setRoster(OWNER);
  f.executor.rosterChanged();
  await f.until(() => f.executor.holds().some((hold) => hold.action === "change"));
  const { id: invoice } = await f.create({});
  await f.edit(invoice, { [PAID]: true });
  await f.until(() => f.claims()[0]?.state === "pending");
  for (const hold of f.executor.holds()) expect(await f.executor.confirmReach(hold)).toBe("confirmed");
  await f.until(() => f.claims()[0]?.state === "done" || f.claims()[0]?.state === "failed");
  expect(f.claims()[0]?.state).toBe("done");
  expect(f.documents.size).toBe(1);
  await f.executor.dispose();
});

it("runs a document source's cross-Collection code changes through the real host", async () => {
  const f = await world({ documents: true });
  await mkdir(join(f.root, "Log"), { recursive: true });
  await writeFile(join(f.root, "Log/collection.yaml"), "fields:\n  Status:\n    type: text\n");
  await writeFile(join(f.root, "Log/automations.yaml"), `version: 1
automations:
  - id: copy
    name: Copy
    when: record-added
    do:
      - run: "return { records: [{ action: 'add', collection: 'Budget', table: 'Invoices', fields: { Status: ctx.record.Status } }, { action: 'add', collection: 'Budget', fields: { Status: 'Second' } }] };"
      - find: record.Status == "Original"
        collection: Budget
        operation: invoices.list
        as: added
      - set: {Status: From document}
        records: added
        operation: invoices.status
`);
  f.documents.set("document", { id: "document", path: "Log/document.md", status: "Original" });
  await f.executor.open();
  const claim: AutomationClaim = { ...engineClaim("document-copy", "pending", Date.now(), "collection:Log#copy"),
    collectionPath: "Log", recordId: "document", trigger: { historyId: 1 },
    change: { kind: "added", authorOriginId: null, actorKind: "human", onBehalfOf: "document-author",
      sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 } };
  f.engineClaims.push(claim);
  f.executor.notifyClaimed();
  await f.until(() => claim.state === "done" || claim.state === "failed");
  expect(claim.state).toBe("done");
  expect((await f.records()).map((row) => row.values[STATUS]).sort()).toEqual(["From document", "Second"]);
  expect(f.host.history({ datasetId: definition.datasetId }).entries[0]).toMatchObject({
    automation: { automationId: "collection:Log#copy", depth: 1 },
  });
  await f.executor.dispose();
});

it("shows a computed dataset operation hold and resumes only after confirmation", async () => {
  const editor = { grantId: "editor", recipientUserId: "editor", recipientEmail: "editor@example.com",
    files: { paths: ["Log"], versionId: null, access: "edit" as const }, channel: null };
  const f = await world({ documents: true, roster: { kind: "owner", ownerUserId: "user-owner", grants: [editor] }, mayRetryPress: true });
  await mkdir(join(f.root, "Log"), { recursive: true });
  await writeFile(join(f.root, "Log/collection.yaml"), "fields:\n  Status:\n    type: text\n");
  await writeFile(join(f.root, "Log/automations.yaml"), `version: 1
automations:
  - id: copy
    name: Copy
    when: record-added
    do:
      - run: "return { records: [{ action: 'add', collection: ['Bud', 'get'].join(''), fields: { Status: 'Copied' } }] };"
`);
  f.documents.set("document", { id: "document", path: "Log/document.md", status: "Original" });
  await f.executor.open();
  const claim: AutomationClaim = { ...engineClaim("code-hold", "pending", Date.now(), "collection:Log#copy"),
    collectionPath: "Log", recordId: "document", trigger: { historyId: 1 },
    change: { kind: "added", authorOriginId: null, actorKind: "human", onBehalfOf: "user-owner", sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 } };
  f.engineClaims.push(claim);
  f.executor.notifyClaimed();
  await f.until(() => claim.state === "failed");
  expect(await f.records()).toEqual([]);
  f.setRoster(OWNER);
  f.executor.rosterChanged();
  expect(await f.executor.retry({ automationId: claim.automationId, claimId: claim.claimId, startOver: false })).toMatchObject({ status: "queued" });
  await f.until(() => f.executor.holds().some((hold) => hold.recipient === JSON.stringify(["operation", BUDGET, CREATE])));
  expect(await f.records()).toEqual([]);
  for (const hold of f.executor.holds()) expect(await f.executor.confirmReach(hold)).toBe("confirmed");
  await f.until(() => claim.state === "done" || claim.state === "failed");
  expect(claim.state).toBe("done");
  expect(await f.records()).toMatchObject([{ values: { [STATUS]: "Copied" } }]);
  await f.executor.dispose();
});

it("resumes a saved cross-Collection Add after its document destination moves", async () => {
  const f = await world({ documents: true });
  await mkdir(join(f.root, "Log"), { recursive: true });
  await writeFile(join(f.root, "Log/collection.yaml"), "fields:\n  Status:\n    type: text\n");
  await f.writeAutomations(closePaid(`      - add-record: {Status: Added}
        collection: Log
        as: added
      - set: {Status: Resumed}
        records: added
`));
  await f.executor.open();
  let closed: Promise<void> | undefined;
  f.afterNextSave(() => { closed = f.executor.close(); });
  const invoice = await f.create({});
  await f.edit(invoice.id, { [PAID]: true });
  await f.until(() => closed !== undefined);
  await closed;
  await f.moveDocuments("Moved");
  await f.executor.open();
  await f.until(() => f.claims()[0]?.state === "done" || f.claims()[0]?.state === "failed");
  expect(f.claims()[0]?.state).toBe("done");
  expect([...f.documents.values()]).toEqual([expect.objectContaining({ path: expect.stringMatching(/^Moved\//), status: "Resumed" })]);
  await f.executor.dispose();
});

it("refuses a viewer who can write only the source button table when its automation writes another dataset", async () => {
  const f = await world();
  const other = generateDatasetSources({ ...definition, datasetId: id(200), name: "Other",
    schemaPath: "Other/schema.sql", operationsPath: "Other/operations.js" });
  for (const [path, text] of Object.entries(other.files)) {
    await mkdir(dirname(join(f.root, path)), { recursive: true });
    await writeFile(join(f.root, path), text);
  }
  const prepared = await f.host.prepare({ descriptorPath: "Other/dataset.json", adapter: f.adapter });
  await f.host.approve({ preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256 });
  await f.writeAutomations(`  - id: cross-button
    name: Cross button
    when:
      button: Mark paid
    do:
      - add-record: {Status: Crossed}
        collection: Other
        operation: invoices.create
`);
  await f.executor.open();
  const record = await f.create({});
  const described: string[] = [];
  const viewer = async (datasetId: string) => {
    described.push(datasetId);
    const description = f.host.describe(datasetId);
    return { ...description, operations: description.operations.filter((operation) =>
      datasetId === definition.datasetId ? [LIST, STATUS_ONLY].includes(operation.operationId) : operation.readOnly) };
  };
  await expect(f.executor.pressDataset({ datasetId: definition.datasetId, table: "Invoices", field: "Mark paid",
    recordId: JSON.stringify(record.id), pressId: id(201), pressedBy: "viewer", by: { kind: "human" }, confirmed: [] },
    viewer, () => undefined)).rejects.toThrow("Only people who can edit Invoices can use this button.");
  expect(described.sort()).toEqual([definition.datasetId, other.definition.datasetId].sort());
  expect(f.host.automations.claims(`collection:${BUDGET}#cross-button`).claims).toEqual([]);
  await f.executor.dispose();
});

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

it("keeps source field marks when the automation also invokes another Collection", async () => {
  const f = await world();
  const other = await authoredDestination(f);
  await f.writeAutomations(closePaid(`      - set: {Status: Closed}
        operation: invoices.status
      - invoke: invoices.hold
        collection: Other
        input: {id: '${other.record.id}'}
`));
  await f.executor.open();
  expect(await f.executor.datasetFieldMarks(BUDGET, "Invoices")).toEqual([{ field: "Status", automations: ["Close paid invoices"] }]);
  expect(await f.executor.datasetFieldMarks(other.rules.datasetId, "Invoices")).toEqual([]);
  await f.executor.dispose();
});

it.each([false, true])("invokes and reverses another authored dataset through the real host from authored source %s", async (authoredSource) => {
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

it("checks source buttons against destination action grants and destination-qualified confirmations", async () => {
  const f = await world();
  const other = await authoredDestination(f);
  await f.writeAutomations(`  - id: cross-action
    name: Cross action
    when: {button: Mark paid}
    do:
      - invoke: invoices.settle
        collection: Other
        input: {id: '${other.record.id}', note: Button}
`);
  await f.executor.open();
  const source = await f.create({});
  const input = { datasetId: BUDGET, table: "Invoices", field: "Mark paid", recordId: JSON.stringify(source.id), pressId: id(205), pressedBy: "user-owner", by: { kind: "human" as const }, confirmed: ["invoices.settle"] };
  const denied = async (datasetId: string) => {
    const description = f.host.describe(datasetId);
    return datasetId === BUDGET ? description : { ...description, operations: [] };
  };
  await expect(f.executor.pressDataset(input, denied, () => undefined)).rejects.toThrow("Only people who can edit Invoices");
  const describe = async (datasetId: string) => f.host.describe(datasetId);
  await expect(f.executor.pressDataset(input, describe, () => undefined)).rejects.toThrow("changed after it was pressed");
  const name = `${other.rules.datasetId}/invoices.settle`;
  expect(await f.executor.datasetButtons(BUDGET, [{ field: input.field, table: input.table }], describe))
    .toMatchObject([{ kind: "ready", irreversible: [{ name, label: "Other: Settle" }] }]);
  const pressed = await f.executor.pressDataset({ ...input, confirmed: [name] }, describe, () => undefined);
  if (pressed.busy) throw new Error("Unexpected busy press");
  const automationId = `collection:${BUDGET}#cross-action`;
  await f.until(() => f.host.automations.claim(automationId, pressed.claimId)?.state === "done");
  expect((await other.rows()).result).toMatchObject({ rows: [{ values: { [STATUS]: `Settled by ${automationId}: Button` } }] });
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
  ["Find without a pinned operation", "      - find: 'true'\n        collection: Budget\n        as: matches"],
  ["nested Find", "      - if: 'false'\n        do: [{set: {Status: Done}}]\n        otherwise:\n          - find: 'true'\n            collection: Budget\n            operation: invoices.list\n            as: matches"],
  ["bound records and implicit reads", "      - add-record: {Status: Open}\n        collection: Budget\n        operation: invoices.create\n        as: added\n      - set: {Status: Done}\n        records: added\n        operation: invoices.status"],
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

it("invokes and reverses an authored action from a document claim through the real host", async () => {
  const f = await world({ documents: true, descriptor: ACTION_DESCRIPTOR, operations: ACTION_OPERATIONS });
  const destination = await f.create({ [STATUS]: "Original" });
  await mkdir(join(f.root, "Log"), { recursive: true });
  await writeFile(join(f.root, "Log/collection.yaml"), "fields:\n  Status:\n    type: text\n");
  await writeFile(join(f.root, "Log/automations.yaml"), `version: 1
automations:
  - id: hold
    name: Hold
    when: record-added
    do:
      - invoke: invoices.hold
        collection: Budget
        input: {id: '${destination.id}'}
`);
  f.documents.set("document", { id: "document", path: "Log/document.md", status: "Source" });
  await f.executor.open();
  const automationId = "collection:Log#hold";
  const claim: AutomationClaim = { ...engineClaim("document-action", "pending", Date.now(), automationId),
    collectionPath: "Log", recordId: "document", trigger: { historyId: 1 },
    change: { kind: "added", authorOriginId: null, actorKind: "human", onBehalfOf: "document-author",
      sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 } };
  f.engineClaims.push(claim);
  f.executor.notifyClaimed();
  await f.until(() => claim.state === "done" || claim.state === "failed");
  expect(claim.state).toBe("done");
  expect((await f.record(destination.id))?.values[STATUS]).toBe("On hold");
  expect(f.host.history({ datasetId: BUDGET }).entries[0]).toMatchObject({ automation: { automationId, depth: 1 } });
  expect(await f.executor.undo({ deletes: null, automationId, claimId: claim.claimId }, async () => undefined))
    .toMatchObject({ status: "undone", actionsReversed: 1 });
  expect((await f.record(destination.id))?.values[STATUS]).toBe("Original");
  expect(f.documents.get("document")!.status).toBe("Source");
  await f.executor.dispose();
});

it("lists every dataset for the builder with each operation's reach, and names one generic steps cannot use", async () => {
  const f = await world({ documents: true });
  await authoredDestination(f);
  await mkdir(join(f.root, "Log"), { recursive: true });
  await writeFile(join(f.root, "Log/collection.yaml"), "fields:\n  Status:\n    type: text\n");
  await f.executor.open();
  const targets = await f.executor.targetsFor("Log");
  expect(targets.map((target) => [target.path, target.kind])).toEqual([["Budget", "dataset"], ["Log", "document"], ["Other", "dataset"]]);
  const budget = targets.find((target) => target.path === "Budget");
  expect(budget).toMatchObject({ kind: "dataset", datasetId: BUDGET, stopped: null, findStopped: null, editStopped: null, actionsStopped: "Budget has no approved actions." });
  expect(budget?.kind === "dataset" ? budget.operations.map(({ name, kind, stopped }) => [name, kind, stopped]) : []).toEqual([
    ["invoices.list", "read", null], ["invoices.create", "create", null], ["invoices.edit", "edit", null],
    ["invoices.status", "edit", null], ["invoices.delete", "delete", null],
  ]);
  // Operations someone wrote run only as actions, so Add, Find, and Set name why, and actions stay.
  expect(targets.find((target) => target.path === "Other")).toMatchObject({
    kind: "dataset", stopped: "Other's operations were written or changed outside dohc, so Set fields, Add record, and Find steps cannot use them.", actionsStopped: null,
  });
  // An editor of Log without a data grant in Budget cannot use its operations, so Add and Find there say why.
  f.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [{ grantId: "log-editor", recipientUserId: "editor", recipientEmail: "editor@example.com", files: { paths: ["Log"], access: "edit", versionId: null }, channel: null }] });
  const narrowed = (await f.executor.targetsFor("Log")).find((target) => target.path === "Budget");
  expect(narrowed?.kind === "dataset" && narrowed.operations.every((operation) => typeof operation.stopped === "string")).toBe(true);
  expect(narrowed).toMatchObject({ stopped: expect.any(String), findStopped: expect.any(String), actionsStopped: "Budget has no approved actions." });
  await f.executor.dispose();
});

it("pins a document Collection's steps in a dataset when the builder saves, marks the fields they set there, and warns a share about them", async () => {
  const f = await world({ documents: true });
  await mkdir(join(f.root, "Log"), { recursive: true });
  await writeFile(join(f.root, "Log/collection.yaml"), "fields:\n  Status:\n    type: text\n");
  const add = { kind: "add-record" as const, values: [{ field: "Status", value: { kind: "literal" as const, value: "Logged" } }], collection: "Budget", as: "added", operation: null };
  const find = { kind: "find" as const, condition: "record.Paid == true", collection: "Budget", as: "paid", operation: null };
  const set = { kind: "set" as const, values: [{ field: "Notes", value: { kind: "literal" as const, value: "Seen" } }], records: "paid", operation: null };
  const draft: Automation = { id: "log", name: "Log it", enabled: true, when: { kind: "record-added", table: null }, if: null, do: [add, find, set] };
  await f.executor.open();
  const [pinned] = await f.executor.pinOperations("Log", [draft], []);
  expect(pinned!.do).toEqual([{ ...add, operation: "invoices.create" }, { ...find, operation: "invoices.list" }, { ...set, operation: "invoices.edit" }]);
  // The builder's check pins as a save does, so a new step there runs.
  await expect(f.executor.draftCannotRun("Log", draft)).resolves.toBeNull();
  // A step the file already holds keeps what it names.
  expect((await f.executor.pinOperations("Log", [draft], [draft]))[0]!.do).toEqual(draft.do);

  await writeFile(join(f.root, "Log/automations.yaml"), `version: 1
automations:
  - id: log
    name: Log it
    when: record-added
    do:
      - add-record: {Status: Logged}
        collection: Budget
        operation: invoices.create
      - find: record.Paid == true
        collection: Budget
        as: paid
        operation: invoices.list
      - set: {Notes: Seen}
        records: paid
        operation: invoices.edit
`);
  f.executor.handleWatcherEvents([{ operation: "update", path: "Log/automations.yaml" }]);
  await f.until(async () => (await f.executor.datasetFieldMarks(BUDGET, "Invoices")).length === 2);
  const marks = await f.executor.datasetFieldMarks(BUDGET, "Invoices");
  expect(marks.find((mark) => mark.field === "Notes")).toEqual({ field: "Notes", automations: ["Log it"] });
  expect(marks.find((mark) => mark.field === "Status")?.automations.sort()).toEqual(["Close paid invoices", "Log it"]);
  // Sharing Log to edit makes a new editor of the automation, who holds no grant in Budget: the warning names Budget.
  const stops = await f.executor.shareImpact({ paths: ["Log"], versionId: null, access: "edit", recipientEmail: "ana@dohc.test" });
  expect(stops.length).toBeGreaterThan(0);
  expect(stops.every((stop) => stop.automationId === "collection:Log#log" && stop.target === "Budget")).toBe(true);
  await f.executor.dispose();
});

it("lists a Collection a step names whose dataset.json is broken, with why, for the builder", async () => {
  const f = await world({ documents: true });
  await mkdir(join(f.root, "Log"), { recursive: true });
  await writeFile(join(f.root, "Log/collection.yaml"), "fields:\n  Status:\n    type: text\n");
  await writeFile(join(f.root, "Log/automations.yaml"), `version: 1
automations:
  - id: log
    name: Log it
    when: record-added
    do:
      - add-record: {Status: Logged}
        collection: Broken
`);
  await mkdir(join(f.root, "Broken"), { recursive: true });
  await writeFile(join(f.root, "Broken/dataset.json"), "{ not json");
  await f.executor.open();
  await f.executor.automationsIn("Log");
  expect((await f.executor.targetsFor("Log")).find((target) => target.path === "Broken")).toEqual({
    kind: "dataset", path: "Broken", name: "Broken", datasetId: null, operations: [],
    stopped: "dohc cannot read Broken/dataset.json. Fix that file, then try again.",
    findStopped: "dohc cannot read Broken/dataset.json. Fix that file, then try again.",
    editStopped: "dohc cannot read Broken/dataset.json. Fix that file, then try again.",
    actionsStopped: "dohc cannot read Broken/dataset.json. Fix that file, then try again.",
  });
  await f.executor.dispose();
});

it.each([1, 2])("keeps timed and message automations at the base after %s field changes", async changes => {
  const f = await world({ groups: true });
  try {
    for (let change = 1; change <= changes; change++) {
      const approved = f.host.approvedArtifacts(BUDGET);
      const next = generateDatasetSchemaChange({ ...approved, change: { kind: "renameField", tableId: TABLE, fieldId: FINISHED, name: `Finished ${change}` } });
      expect(next.descriptorPath).toMatch(/\/revisions\/\d+-[^/]+\/revision\.json$/);
      expect(datasetBaseFolder(JSON.parse(next.files[next.descriptorPath]!))).toBe("Budget");
      for (const [path, text] of Object.entries(next.files)) {
        await mkdir(join(f.root, dirname(path)), { recursive: true });
        await writeFile(join(f.root, path), text);
      }
      const prepared = await f.host.prepareMigration({ datasetId: BUDGET, descriptorPath: next.descriptorPath, migrationPath: next.migrationPath, adapter: f.adapter });
      const result = await f.host.approveMigration({ preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256, approvalDigest: prepared.approvalDigest });
      Object.assign(f.rules, { revision: result.revision.revision, revisionSha256: result.revision.revisionSha256 });
    }
    expect(JSON.parse(await readFile(join(f.root, "Budget/dataset.json"), "utf8")).schemaPath).toBe("Budget/schema.sql");
    await f.writeAutomations(`  - id: scheduled
    name: Scheduled
    when: {schedule: day, timezone: UTC}
    do:
      - add-record: {Status: Scheduled}
        collection: Budget
        operation: invoices.create
  - id: messaged
    name: Messaged
    when: {group-message: Team}
    do:
      - add-record: {Status: '=message.body'}
        collection: Budget
        operation: invoices.create
`);
    await f.executor.open();
    expect(await f.executor.automationsIn("Budget")).toMatchObject({ automations: [
      { valid: true, cannotRun: null }, { valid: true, cannotRun: null },
    ] });
    const scheduled = engineClaim("base-schedule", "pending", Date.UTC(2026, 8, 27), `collection:${BUDGET}#scheduled`);
    const messaged = engineClaim("base-message", "pending", Date.UTC(2026, 8, 28), `collection:${BUDGET}#messaged`);
    messaged.trigger = { key: "message:base-message" };
    messaged.change = { kind: "message", authorOriginId: null, actorKind: "human", onBehalfOf: null, sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0,
      message: { id: "base-message", threadId: "thread", groupId: "team", lane: "posts", authorKind: "human", authorDisplayName: "Bob", authorUserId: "u-bob", createdAtMs: Date.UTC(2026, 8, 28), body: "Messaged" } };
    f.engineClaims.push(scheduled, messaged);
    f.executor.notifyClaimed();
    await f.until(() => f.engineClaims.every(claim => claim.state === "done" || claim.state === "failed"));
    expect(f.engineClaims).toMatchObject([{ state: "done" }, { state: "done" }]);
    expect((await f.records()).map(row => row.values[STATUS]).sort()).toEqual(["Messaged", "Scheduled"]);
    expect(f.errors).toEqual([]);
  } finally { await f.executor.dispose(); }
});

it("reports dataset-only kept fields on every Stop and restore retry", async () => {
  const f = await world();
  await f.writeAutomations(closePaid(`      - set: {Status: Closed, Notes: Closed by automation}
        operation: invoices.edit
`));
  await f.executor.open();
  const invoice = await f.create({[STATUS]: "Open", [NOTES]: "draft"});
  await f.edit(invoice.id, {[PAID]: true});
  await f.until(() => f.claims()[0]?.state === "done");
  await f.edit(invoice.id, {[NOTES]: "mine"});
  const listed = await f.executor.automationsIn("Budget");
  if(listed.status !== "read" || !listed.automations[0]?.valid) throw Error("No definition");
  const definitions = [{collectionPath: "Budget", id: "close-paid", definitionHash: listed.automations[0].definitionHash}];
  definitions[0]!.id = listed.automations[0].automation.id;
  const first = await f.executor.undoRunsOf(definitions, async () => undefined);
  expect(first.keptFields).toHaveLength(1);
  const retry = await f.executor.undoRunsOf(definitions, async () => undefined, true);
  expect(retry.keptFields).toEqual(first.keptFields);
  await f.executor.dispose();
});
