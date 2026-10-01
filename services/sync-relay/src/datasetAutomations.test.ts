import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { generateDatasetOperations } from "@dohc/security-contract/dataset-operations";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { CollectionAutomations, type CollectionAutomationEngine } from "@dohc/automation-executor/collection-automations";
import { createAutomationFormulaEvaluator } from "@dohc/automation-executor/automation-evaluator-host";
import { createAutomationRunStore } from "@dohc/automation-executor/automation-run-store";
import { fixture as baseFixture, limits } from "./datasetTestFixture";
import { createRelayDatasetHost } from "./datasetHost";
import type { AppBackendAuth } from "./appBackendAuthority";
import { createSyncRelayHandler } from "./server";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { definitionHash } from "@dohc/automation-executor/automation-plan";
import { AutomationRunWait, SHARED_BUTTON_DENIED, SHARED_BUTTON_UNCHECKED } from "@dohc/automation-executor/button-presser";
import type { AutomationClaim } from "@dohc/workspace-engine-client";

const owner = { kind: "named" as const, workspaceId: "w", userId: "owner" };
const id = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const DATASET = id(1), TABLE = id(2), ID = id(3), NAME = id(4), BUTTON = id(8), CREATE = id(5), READ = id(6), EDIT = id(7);
const automationId = `collection:${DATASET}#name`;
const definition: DatasetDefinition = {
  formatVersion: 1, datasetId: DATASET, name: "People", schemaPath: "People/schema.sql", operationsPath: "People/operations.js",
  tables: [{ tableId: TABLE, name: "People", sqlName: "people", primaryKey: "id", fields: [
    { fieldId: ID, name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: NAME, name: "Name", sqlColumn: "name", type: "text", required: true, unique: false },
    { fieldId: BUTTON, name: "Rename", type: "button" },
  ] }],
  operations: [
    { operationId: CREATE, name: "create", label: "Create", tableId: TABLE, kind: "create", access: "helper", readOnly: false, fieldIds: [ID, NAME] },
    { operationId: READ, name: "read", label: "Read", tableId: TABLE, kind: "read", access: "helper", readOnly: true, fieldIds: [ID, NAME] },
    { operationId: EDIT, name: "edit", label: "Edit", tableId: TABLE, kind: "edit", access: "helper", readOnly: false, fieldIds: [NAME], reversible: true },
  ],
};
const schemaSql = 'CREATE TABLE people(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,"_record_version" INTEGER NOT NULL DEFAULT 1) STRICT;';
const operationSource = generateDatasetOperations(definition);
const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
const scope = { workspaceId: "w", datasetId: DATASET };
const rules = { datasetId: DATASET, revision: 1, revisionSha256: revision.revisionSha256 };
const editor = { kind: "named" as const, workspaceId: "w", userId: "editor", grantId: "editor-grant" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const SEND = id(9);
async function fixture(actionAccess?: "helper" | "owner") {
  const base = baseFixture(), directory = await mkdtemp(join(tmpdir(), "relay-dataset-automations-"));
  const host = await createRelayDatasetHost({ storage: base.storage, directory, limits, onShutdownError: error => { throw error; } });
  const lifetime = new AbortController();
  cleanups.push(async () => { lifetime.abort(); await host.close(); await rm(directory, { recursive: true, force: true }); });
  const approvedDefinition: DatasetDefinition = actionAccess === undefined ? definition : { ...definition, operations: [...definition.operations,
    { operationId: SEND, name: "send", label: "Send", tableId: TABLE, kind: "action", access: actionAccess, readOnly: false, fieldIds: [NAME] }] };
  const source = actionAccess === undefined ? operationSource : `${operationSource}\nglobalThis.operations.send = (ctx, input) => {
    ctx.db.execute('UPDATE people SET name=?, "_record_version"="_record_version"+1 WHERE id=?', [input.name, input.id]);
    return {sent: true};
  };`;
  const approved = describeDatasetRevision({ definition: approvedDefinition, revision: 1, schemaSql, operationSource: source });
  const currentRules = { ...rules, revisionSha256: approved.revisionSha256 };
  await host.activate(owner, { ...scope, revision: approved, schemaSql, operationSource: source, capacityBytes: 1024 * 1024 });
  const ledger = host.automations.workspace("w", "owner", lifetime.signal);
  const create = (key = "record") => host.invoke(owner, { ...scope, ...currentRules, operationId: CREATE, input: { values: { [ID]: key, [NAME]: "Before" } }, idempotencyKey: key });
  const subscription = { automationId, definitionHash: "a".repeat(64), tableId: TABLE, kinds: ["added" as const], fieldIds: [NAME] };
  function addEditor(access: "view" | "edit" = "edit", paths = ["People"]) {
    base.storage.createShare({ share: { shareId: "people-share", workspaceId: "w", granterUserId: "owner", selectorJson: JSON.stringify({ paths, versionId: null }), createdAtMs: 1 },
      grant: { grantId: editor.grantId, shareId: "people-share", principalKind: "user", principalUserId: "editor", principalEmail: null,
        access, generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null } });
    host.setDataGrant(owner, { ...scope, grantId: editor.grantId, grant: { operationIds: actionAccess === "helper" ? [READ, EDIT, SEND] : [READ, EDIT], discover: true,
      revision: currentRules.revision, revisionSha256: currentRules.revisionSha256 } });
  }
  const press = { pressId: "press", request: "b".repeat(64), automationId, definitionHash: "a".repeat(64), tableId: TABLE, fieldId: BUTTON, recordId: "record", pressedBy: "owner", by: { kind: "human" as const } };
  return { ...base, host, ledger, lifetime, directory, create, subscription, addEditor, press, currentRules };
}

it("uses registered callers, scopes authority, and preserves chain depth and receipts", async () => {
  const f = await fixture();
  f.ledger.subscribe(DATASET, f.subscription);
  const wake = vi.fn(); const stop = f.host.observeAutomationClaims(wake);
  const context = f.ledger.context({ automationId: "collection:People#writer", claimId: "test", person: "editor", depth: 3 });
  const input = { ...rules, operationId: CREATE, input: { values: { [ID]: "record", [NAME]: "Before" } }, idempotencyKey: "automation" };
  await expect(Promise.resolve().then(() => f.ledger.invoke({ ...context }, input))).rejects.toThrow();
  await expect(f.host.invoke({ kind: "automation", ...context } as unknown as AppBackendAuth, { ...input, workspaceId: "w" })).rejects.toThrow();
  expect(await f.ledger.invoke(context, input)).toMatchObject({ replayed: false });
  expect(await f.ledger.invoke(context, input)).toMatchObject({ replayed: true });
  expect(f.ledger.next()).toMatchObject({ depth: 3, actor: { kind: "automation", automationId: "collection:People#writer", userId: "editor", depth: 3 } });
  expect(f.ledger.claims(automationId).claims).toHaveLength(1);
  expect(wake).toHaveBeenCalledWith("w", false); stop();
  f.storage.claimWorkspace({ workspaceId: "other", ownerUserId: "owner", createdAtMs: 1 });
  const other = f.host.automations.workspace("other", "owner", f.lifetime.signal);
  await expect(other.invoke(context, input)).rejects.toThrow();
  expect(() => f.host.automations.workspace("w", "stranger", f.lifetime.signal)).toThrow();
  const running = f.ledger.claims(automationId).claims[0]!;
  f.lifetime.abort();
  f.ledger.release(running);
  expect(f.ledger.claim(automationId, running.claimId)?.state).toBe("pending");
  await expect(Promise.resolve().then(() => f.ledger.invoke(context, input))).rejects.toThrow();
});

it("admits owner and named editor presses only inside a checked request and rejects revoked grants", async () => {
  const f = await fixture(); f.addEditor(); await f.create();
  expect(() => f.ledger.press(DATASET, f.press)).toThrow();
  expect(await f.host.automations.press(owner, DATASET, f.lifetime.signal, async () => f.ledger.press(DATASET, f.press)))
    .toMatchObject({ kind: "claimed", claim: { actor: { kind: "owner", userId: "owner" } } });
  const started = f.ledger.next()!; f.ledger.settle(started, { state: "done" });
  const named = { ...f.press, pressId: "editor-press", pressedBy: "editor" };
  expect(await f.host.automations.press(editor, DATASET, f.lifetime.signal, async () => f.ledger.press(DATASET, named)))
    .toMatchObject({ kind: "claimed", claim: { actor: { kind: "named", userId: "editor" } } });
  await expect(f.host.automations.press(editor, DATASET, f.lifetime.signal, async () => {
    f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=2 WHERE grant_id=?").run(editor.grantId));
    return f.ledger.press(DATASET, { ...named, pressId: "revoked" });
  })).rejects.toThrow();
  expect(f.ledger.pressed("revoked")).toBeNull();
});

it.each(["view", "wrong-folder", "derived", "no-data"])("refuses a %s presser", async kind => {
  const f = await fixture(); f.addEditor(kind === "view" ? "view" : "edit", kind === "wrong-folder" ? ["Elsewhere"] : ["People"]);
  if (kind === "derived") f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_share_grants SET parent_grant_id='g' WHERE grant_id=?").run(editor.grantId));
  if (kind === "no-data") f.host.setDataGrant(owner, { ...scope, grantId: editor.grantId, grant: null });
  await expect(f.host.automations.press(editor, DATASET, f.lifetime.signal, async () => f.ledger.press(DATASET, { ...f.press, pressedBy: "editor" }))).rejects.toThrow();
  expect(f.ledger.claims(automationId).claims).toEqual([]);
});

it("rechecks dataset rules at the claim transaction after a press waited", async () => {
  const f = await fixture(); f.addEditor();
  await expect(f.host.automations.press(editor, DATASET, f.lifetime.signal, async () => {
    f.host.setDataGrant(owner, { ...scope, grantId: editor.grantId, grant: { revision: rules.revision, revisionSha256: rules.revisionSha256, discover: true, operationIds: [READ] } });
    return f.ledger.press(DATASET, { ...f.press, pressedBy: "editor" });
  })).rejects.toThrow();
  expect(f.ledger.claims(automationId).claims).toEqual([]);
});

async function executorFor(f: Awaited<ReturnType<typeof fixture>>, button = false, serverCopy?: string, sharedSteps?: string, extraFiles: Record<string, string> = {}) {
  const evaluator = createAutomationFormulaEvaluator();
  const metadata = join(f.directory, serverCopy ?? "metadata"); await mkdir(metadata, { recursive: true });
  const trigger = button ? "button: Rename" : "record-added";
  const texts = new Map([
    ["People/dataset.json", JSON.stringify(definition)],
    ["People/automations.yaml", "version: 1\nautomations:\n  - id: name\n    name: Rename\n    when: " + (button ? "{button: Rename, table: People}" : trigger) + "\n    do:\n      - set: {Name: After}\n        operation: edit\n"],
  ]);
  const claims: AutomationClaim[] = [];
  for (const [path, text] of Object.entries(extraFiles)) texts.set(path, text);
  if (sharedSteps) {
    texts.delete("People/automations.yaml");
    texts.set("Log/collection.yaml", "fields: {Send: {type: button}, Status: {type: text}}");
    texts.set("Log/automations.yaml", `version: 1\nautomations:\n  - id: send\n    name: Send\n    when: {button: Send}\n    do:\n${sharedSteps}\n`);
  }
  const engine = { listCollections: async () => ({ collections: sharedSteps ? [{ path: "Log", objectId: "Log", status: "valid", reasons: [] }] : [] }),
    getCollectionRecord: async () => ({ collection: { path: "Log", status: "valid", reasons: [] }, record: { id: "source", path: "Log/source.md", conflicted: false, values: [] }, history: [], nextBeforeHistoryId: null }),
    pressAutomation: async ({ pressId, automationId, recordId, pressedBy }: { pressId: string; automationId: string; recordId: string; pressedBy: string }) => {
      let claim = claims.find(value => "key" in value.trigger && value.trigger.key === `press:${pressId}`);
      if (!claim) {
        claim = { claimId: "claim-" + claims.length, automationId, recordId, collectionPath: null, depth: 0, trigger: { key: `press:${pressId}` },
          change: { kind: "button", authorOriginId: null, actorKind: "human", onBehalfOf: pressedBy, sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 },
          state: "pending", attempts: 0, run: 1, createdAtMs: Date.now(), updatedAtMs: 0 };
        claims.push(claim);
      }
      return { busy: false, claim };
    },
    claimNextAutomation: async () => { const claim = claims.find(value => value.state === "pending"); if (!claim) return null; claim.state = "running"; claim.attempts++; return structuredClone(claim); },
    settleAutomationClaim: async ({ claimId, state, error }: { claimId: string; state: "done" | "failed"; error?: string }) => { Object.assign(claims.find(value => value.claimId === claimId)!, { state, error }); },
    releaseAutomationClaim: async ({ claimId }: { claimId: string }) => { claims.find(value => value.claimId === claimId)!.state = "pending"; },
    subscribeAutomation: async () => undefined, releaseAutomationGroups: async () => ({ watchedGeneration: 0, handover: { floorMs: 0, automations: [] } }),
    watchAutomationGroups: async () => ({ needsHandover: false }), listAutomationFailures: async () => ({ failures: [] }),
    getActiveVersion: async () => ({ id: "main" }),
    pruneAutomationHistory: async () => ({ pruned: 0, more: false }),
    getAutomationClaim: async (input: { claimId: string } | { automationId: string; key: string }) => ({ claim: claims.find(value => "claimId" in input ? value.claimId === input.claimId : value.automationId === input.automationId && "key" in value.trigger && value.trigger.key === input.key) ?? null }),
    listAutomationClaims: async () => ({ claims, next: null }), readAutomationGroupSkips: async () => ({ aheadAtMs: null, lateAtMs: null }),
  } as unknown as CollectionAutomationEngine;
  const errors: unknown[] = [];
  const waiting: string[] = [];
  const roster = () => ({ kind: "owner" as const, ownerUserId: "owner", grants: f.storage.getShareGrant(editor.grantId)?.status === "active" ? [{
    grantId: editor.grantId, recipientUserId: editor.userId, recipientEmail: null,
    files: { paths: ["People"], versionId: null, access: "edit" as const }, channel: null,
  }] : [] });
  const store = createAutomationRunStore(f.directory, async () => metadata);
  let executor!: CollectionAutomations;
  const makeExecutor = () => executor = new CollectionAutomations({
    resolveRelayedPress: async hostPressId => {
      const current = () => f.storage.resolveAutomationPress({ workspaceId: "w", ownerUserId: "owner", installId: "host", generation: 1, hostPressId, nowMs: 10 });
      return { ...current(), current };
    },
    resolveButtonInspection: async inspectionId => f.storage.resolveButtonInspection({ workspaceId: "w", ownerUserId: "owner", installId: "host", generation: 1, inspectionId }),
    withEngine: async work => work(engine), withRecordWrites: async () => { throw Error("Unexpected document write"); },
    withUndoWrites: async () => { throw Error("Unexpected document Undo"); },
    readText: async path => texts.has(path) ? { text: texts.get(path)!, truncated: false, contentHash: createHash("sha256").update(texts.get(path)!).digest("hex") } : null,
    writeText: async () => ({ status: "conflict" }), pathExists: async path => texts.has(path),
    roster: async () => roster(), cachedRoster: async () => roster(), personName: userId => userId,
    evaluator: evaluator.forWorkspace("w"), store,
    withDatasetHost: async work => work(f.ledger), groupHost: async () => null,
    holdUnprovenWithoutHistory: async () => serverCopy !== undefined && f.storage.automationWorkspaceInfo("w")!.everShared,
    groupRelayRecord: async () => ({ generation: 0, handover: null }), reachRelayRecord: async () => ({ generation: 0, reach: null, everShared: false }),
    groupMessagesSkipped: async () => undefined, requestHost: async () => undefined, readMessageBody: async () => "",
    chat: { directory: async () => null, write: async () => { throw Error("Unexpected chat"); } }, postNotice: async () => undefined,
    mayRetryPress: async () => false, onPressSettled: () => undefined, onPressWaiting: event => { waiting.push(event.reason); },
    onRunsChanged: () => undefined, reportFailure: async () => undefined, withdrawFailure: async () => undefined, onSwitchedOff: () => undefined, onHoldsChanged: () => undefined, onAutomationsChanged: () => undefined,
    onError: (_context, error) => errors.push(error),
  });
  makeExecutor();
  const stop = f.host.observeAutomationClaims(() => executor.notifyClaimed());
  cleanups.push(async () => { stop(); await executor.dispose(); await evaluator.close(); });
  await executor.open();
  return { executor, makeExecutor, errors, store, claims, texts, waiting };
}

async function acceptedShared(f: Awaited<ReturnType<typeof fixture>>, steps: string, confirmed: string[] = [], extraFiles: Record<string, string> = {}) {
  f.addEditor("edit", ["Log"]);
  const run = await executorFor(f, false, undefined, steps, extraFiles);
  const parsed = parseAutomationsFile(run.texts.get("Log/automations.yaml")!);
  const entry = parsed.status === "read" ? parsed.entries[0] : null;
  if (entry?.status !== "valid") throw Error("Invalid fixture");
  f.storage.checkInAutomationComputer({ workspaceId: "w", ownerUserId: "owner", installId: "host", label: "Host", claim: true, server: null, nowMs: 10 });
  const press = { automationId: "collection:Log#send", collectionPath: "Log", definitionHash: definitionHash(entry.automation), recordId: "source", pressId: "relay-shared", pressedBy: "editor", confirmed };
  const register = (confirmed: string[] = []) => {
    f.storage.recordAutomationPress({ shareId: "people-share", grantId: editor.grantId, grantGeneration: 1, userId: "editor", pressId: "client-shared",
      automationId: press.automationId, collectionPath: press.collectionPath, definitionHash: press.definitionHash, recordId: "source", confirmed, nowMs: 10, newId: () => press.pressId });
    f.storage.acceptAutomationPresses({ workspaceId: "w", ownerUserId: "owner", installId: "host", generation: 1, hostPressIds: [press.pressId], nowMs: 10 });
  };
  register(confirmed);
  const inspect = async () => {
    const release = f.storage.parkButtonInspectionHost({ workspaceId: "w", ownerUserId: "owner", installId: "host" });
    const answer = f.storage.inspectAutomationButton({ target: { automationId: press.automationId, collectionPath: "Log", definitionHash: press.definitionHash },
      source: { workspaceId: "w", shareId: "people-share", grantId: editor.grantId, grantGeneration: 1, userId: "editor" }, id: "query", signal: f.lifetime.signal, wake: () => {} });
    release();
    const result = await run.executor.inspectRelayed("query");
    f.storage.answerButtonInspection({ workspaceId: "w", ownerUserId: "owner", installId: "host", generation: 1, inspectionId: "query" }, result);
    return answer;
  };
  return { ...run, press, inspect };
}

it.each([
  ["Find", "      - find: 'true'\n        collection: People\n        operation: read\n        as: matches"],
  ["nested Find and edit", "      - if: 'true'\n        do:\n          - find: 'true'\n            collection: People\n            operation: read\n            as: matches\n          - set: {Name: Shared}\n            records: matches\n            operation: edit"],
])("runs an allowed shared %s on the server as the stored presser", async (_name, steps) => {
  const f = await fixture(); await f.create();
  const run = await acceptedShared(f, steps);
  expect((await run.inspect()).kind).toBe("ready");
  await expect(run.executor.pressRelayed({ ...run.press, pressedBy: "owner" }, () => {})).rejects.toThrow(SHARED_BUTTON_DENIED);
  const result = await run.executor.pressRelayed(run.press, () => {});
  if (result.pressed.busy) throw Error("Expected a claim");
  await vi.waitFor(() => { expect({ errors: run.errors, waiting: run.waiting, claim: run.claims[0], holds: run.executor.holds() }).toMatchObject({ errors: [], waiting: [], claim: { state: "done" } }); }, { timeout: 5000 });
  expect(run.claims[0]?.change.onBehalfOf).toBe("editor");
});

it.each([false, true])("checks live grants for a computed code destination on the server, create allowed: %s", async allowed => {
  const f = await fixture();
  const run = await acceptedShared(f, "      - run: \"return { records: [{ action: 'add', collection: ['Peo', 'ple'].join(''), fields: { ID: 'by-code', Name: 'By code' } }] };\"");
  f.host.setDataGrant(owner, { ...scope, grantId: editor.grantId, grant: { operationIds: allowed ? [READ, CREATE, EDIT] : [READ, EDIT],
    discover: true, revision: 1, revisionSha256: revision.revisionSha256 } });
  expect((await run.inspect()).kind).toBe("ready");
  await run.executor.pressRelayed(run.press, () => {});
  await vi.waitFor(() => expect(["done", "failed"]).toContain(run.claims[0]?.state), { timeout: 30_000 });
  expect(run.claims[0]?.state).toBe(allowed ? "done" : "failed");
  const result = await f.host.invoke(owner, { ...scope, ...rules, operationId: READ, input: {}, idempotencyKey: "code-result" });
  expect(result.result).toMatchObject({ rows: allowed ? [{ id: "by-code", values: { [NAME]: "By code" } }] : [] });
});

it("denies a missing implicit read and revoked data or source grants between inspection and execution", async () => {
  const f = await fixture();
  const run = await acceptedShared(f, "      - add-record: {ID: added, Name: Before}\n        collection: People\n        operation: create\n        as: added\n      - set: {Name: After}\n        records: added\n        operation: edit");
  const grant = (ids: string[]) => f.host.setDataGrant(owner, { ...scope, grantId: editor.grantId,
    grant: { operationIds: ids, discover: true, revision: 1, revisionSha256: revision.revisionSha256 } });
  grant([CREATE, EDIT]);
  expect(await run.inspect()).toEqual({ kind: "denied", reason: SHARED_BUTTON_DENIED });
  grant([CREATE, EDIT, READ]);
  expect((await run.inspect()).kind).toBe("ready");
  grant([CREATE]);
  await expect(run.executor.pressRelayed(run.press, () => {})).rejects.toThrow(SHARED_BUTTON_DENIED);
  grant([CREATE, EDIT, READ]);
  f.storage.revokeShare("people-share", 11);
  await expect(run.executor.pressRelayed(run.press, () => {})).rejects.toThrow();
  expect(run.claims).toHaveLength(0);
});

it("does not borrow the same named operation grant from another dataset on the server", async () => {
  const f = await fixture();
  const other = { ...definition, datasetId: id(90), name: "Other", schemaPath: "Other/schema.sql", operationsPath: "Other/operations.js" };
  const source = generateDatasetOperations(other);
  const approved = describeDatasetRevision({ definition: other, revision: 1, schemaSql, operationSource: source });
  await f.host.activate(owner, { workspaceId: "w", revision: approved, schemaSql, operationSource: source, capacityBytes: 1024 * 1024 });
  const run = await acceptedShared(f, "      - find: 'true'\n        collection: Other\n        operation: read\n        as: matches", [], { "Other/dataset.json": JSON.stringify(other) });
  expect(await run.inspect()).toEqual({ kind: "denied", reason: SHARED_BUTTON_DENIED });
  await expect(run.executor.pressRelayed(run.press, () => {})).rejects.toThrow(SHARED_BUTTON_DENIED);
  f.host.setDataGrant(owner, { workspaceId: "w", datasetId: other.datasetId, grantId: editor.grantId,
    grant: { operationIds: [READ], discover: true, revision: 1, revisionSha256: approved.revisionSha256 } });
  expect((await run.inspect()).kind).toBe("ready");
  await run.executor.pressRelayed(run.press, () => {});
  await vi.waitFor(() => expect(run.claims[0]?.state).toBe("done"), { timeout: 30_000 });
});

it("runs an approved shared invoke only with its stored, destination-qualified confirmation", async () => {
  const f = await fixture("helper"); await f.create();
  const run = await acceptedShared(f, "      - invoke: send\n        collection: People\n        input: {id: record, name: Sent}", [`${DATASET}/send`]);
  expect(await run.inspect()).toMatchObject({ kind: "ready", irreversible: [{ name: `${DATASET}/send`, label: "People: Send" }] });
  await expect(run.executor.pressRelayed({ ...run.press, confirmed: [] }, () => {})).rejects.toThrow(SHARED_BUTTON_DENIED);
  await expect(run.executor.pressRelayed({ ...run.press, confirmed: ["send"] }, () => {})).rejects.toThrow(SHARED_BUTTON_DENIED);
  await run.executor.pressRelayed(run.press, () => {});
  await vi.waitFor(() => { expect(run.errors).toEqual([]); expect(run.claims[0]?.state).toBe("done"); }, { timeout: 30_000 });
  expect((await f.host.invoke(owner, { ...scope, ...f.currentRules, operationId: READ, input: {}, idempotencyKey: "inspect-sent" })).result)
    .toMatchObject({ rows: [{ values: { [NAME]: "Sent" } }] });
});

it("denies owner-only and missing actions with the same inspection", async () => {
  const hidden = await fixture("owner");
  const hiddenRun = await acceptedShared(hidden, "      - invoke: send\n        collection: People\n        input: {id: record}");
  const missing = await fixture();
  const missingRun = await acceptedShared(missing, "      - invoke: send\n        collection: Missing\n        input: {id: record}");
  expect(await hiddenRun.inspect()).toEqual({ kind: "denied", reason: SHARED_BUTTON_DENIED });
  expect(await missingRun.inspect()).toEqual(await hiddenRun.inspect());
});

it("keeps an unavailable dataset authority unchecked and refuses changed definitions", async () => {
  const f = await fixture();
  const run = await acceptedShared(f, "      - find: 'true'\n        collection: People\n        operation: read\n        as: matches");
  const unavailable = vi.spyOn(f.ledger, "dataGrants").mockImplementation(() => { throw new AutomationRunWait(SHARED_BUTTON_UNCHECKED); });
  expect(await run.inspect()).toEqual({ kind: "unchecked", reason: SHARED_BUTTON_UNCHECKED });
  await expect(run.executor.pressRelayed(run.press, () => {})).rejects.toBeInstanceOf(AutomationRunWait);
  expect(run.claims).toHaveLength(0);
  unavailable.mockRestore();
  run.texts.set("Log/automations.yaml", run.texts.get("Log/automations.yaml")!.replace("find: 'true'", "find: 'false'"));
  run.executor.handleWatcherEvents([{ operation: "update", path: "Log/automations.yaml" }]);
  await vi.waitFor(async () => expect((await run.inspect()).kind).toBe("denied"));
  await expect(run.executor.pressRelayed(run.press, () => {})).rejects.toThrow("changed after it was pressed");
});

it("stops later server steps after revocation and preserves the committed step", async () => {
  const f = await fixture();
  const run = await acceptedShared(f, "      - add-record: {ID: first, Name: First}\n        collection: People\n        operation: create\n      - add-record: {ID: second, Name: Second}\n        collection: People\n        operation: create");
  f.host.setDataGrant(owner, { ...scope, grantId: editor.grantId, grant: { operationIds: [CREATE], discover: true, revision: 1, revisionSha256: revision.revisionSha256 } });
  const invoke = f.ledger.invoke.bind(f.ledger);
  vi.spyOn(f.ledger, "invoke").mockImplementation(async (context, invocation) => {
    const result = await invoke(context, invocation);
    f.storage.revokeShare("people-share", 11);
    return result;
  });
  await run.executor.pressRelayed(run.press, () => {});
  await vi.waitFor(() => { expect(run.errors).toEqual([]); expect(run.claims[0]?.state).toBe("failed"); }, { timeout: 30_000 });
  expect((await f.host.invoke(owner, { ...scope, ...rules, operationId: READ, input: {}, idempotencyKey: "committed" })).result)
    .toMatchObject({ rows: [{ id: "first", values: { [NAME]: "First" } }] });
});

it("resumes an accepted server press after restart with live authority and no repeated committed step", async () => {
  const f = await fixture();
  const run = await acceptedShared(f, "      - add-record: {ID: first, Name: First}\n        collection: People\n        operation: create\n      - add-record: {ID: second, Name: Second}\n        collection: People\n        operation: create");
  f.host.setDataGrant(owner, { ...scope, grantId: editor.grantId, grant: { operationIds: [CREATE], discover: true, revision: 1, revisionSha256: revision.revisionSha256 } });
  const resolve = f.storage.resolveAutomationPress.bind(f.storage);
  let available = true;
  vi.spyOn(f.storage, "resolveAutomationPress").mockImplementation(input => {
    if (!available) throw new AutomationRunWait(SHARED_BUTTON_UNCHECKED, "roster");
    return resolve(input);
  });
  const invoke = f.ledger.invoke.bind(f.ledger);
  const loseAuthority = vi.spyOn(f.ledger, "invoke").mockImplementation(async (context, invocation) => {
    const result = await invoke(context, invocation);
    available = false;
    return result;
  });
  await run.executor.pressRelayed(run.press, () => {});
  await vi.waitFor(() => expect(run.waiting).toContain("roster"), { timeout: 30_000 });
  await run.executor.dispose();
  loseAuthority.mockRestore(); available = true;
  const resumed = run.makeExecutor(); await resumed.open();
  await vi.waitFor(() => { expect(run.errors).toEqual([]); expect(run.claims[0]?.state).toBe("done"); }, { timeout: 30_000 });
  expect((await f.host.invoke(owner, { ...scope, ...rules, operationId: READ, input: {}, idempotencyKey: "resumed" })).result)
    .toMatchObject({ rows: [{ id: "first" }, { id: "second" }] });
});

it("the real executor reconciles subscriptions, drains a server commit, and invokes approved operations", async () => {
  const f = await fixture(), { errors } = await executorFor(f);
  expect(f.ledger.subscriptions()).toHaveLength(1);
  await f.create();
  await vi.waitFor(() => expect(f.ledger.claims(automationId).claims).toMatchObject([{ state: "done" }]), { timeout: 30_000 });
  expect((await f.host.invoke(owner, { ...scope, ...rules, operationId: READ, input: {}, idempotencyKey: "read" })).result)
    .toMatchObject({ rows: [{ values: { [NAME]: "After" } }] });
  expect(errors).toEqual([]);
});

it("accepts HTTP presses as the verified owner or editor and never accepts caller identity in the body", async () => {
  const f = await fixture(); f.addEditor(); await f.create();
  const { executor, errors } = await executorFor(f, true);
  const handler = createSyncRelayHandler({
    storage: f.storage, datasetHost: f.host, nowMs: () => 10,
    resolveActor(request, workspaceId) {
      const match = /^Bearer (owner|editor|stranger)$/.exec(request.headers.get("authorization") ?? "");
      if (!match) throw new UnauthorizedError();
      return { workspaceId, userId: match[1]! };
    },
    pressDataset: (auth, input, signal) => f.host.automations.press(auth, input.datasetId, signal, describe =>
      executor.pressDataset({ ...input, pressedBy: auth.userId }, describe, () => undefined)),
  });
  const body = { table: "People", field: "Rename", recordId: JSON.stringify("record"), pressId: "http-owner", confirmed: [] };
  const request = (user: string, path: string, input: object, headers: Record<string, string> = {}) => handler(new Request("https://relay/sync/" + path, {
    method: "POST", headers: { authorization: "Bearer " + user, "content-type": "application/json", ...headers }, body: JSON.stringify(input),
  }));
  const ownerPath = "w/datasets/" + DATASET + "/press", sharedPath = "shares/people-share/datasets/" + DATASET + "/press";
  expect((await request("owner", ownerPath, { ...body, pressedBy: "editor" })).status).toBe(400);
  expect((await request("owner", ownerPath, { ...body, by: { kind: "agent", depth: 0 } })).status).toBe(400);
  expect((await request("owner", ownerPath, { ...body, confirmed: "all" })).status).toBe(400);
  expect((await request("stranger", ownerPath, body)).status).toBe(404);
  expect((await request("owner", ownerPath, body, { cookie: "session=owner" })).status).toBe(404);
  const first = await request("owner", ownerPath, body);
  expect(await first.clone().text()).not.toContain("message");
  expect(first.status).toBe(200);
  const answer = await first.json() as { claimId: string };
  await vi.waitFor(() => expect(f.ledger.claim(automationId, answer.claimId)?.state).toBe("done"), { timeout: 30_000 });
  expect((await (await request("owner", ownerPath, body)).json()) as unknown).toMatchObject({ claimId: answer.claimId });
  const second = await request("editor", sharedPath, { ...body, pressId: "http-editor" });
  expect(await second.clone().text()).not.toContain("message");
  expect(second.status).toBe(200);
  const named = await second.json() as { claimId: string };
  expect(f.ledger.claim(automationId, named.claimId)?.actor).toEqual({ kind: "named", userId: "editor" });
  await vi.waitFor(() => expect(f.ledger.claim(automationId, named.claimId)?.state).toBe("done"), { timeout: 30_000 });
  expect(errors).toEqual([]);
});

it("keeps dataset-only workspaces wanted while their automation file is present", async () => {
  const f = await fixture();
  expect(f.host.automations.wantedWorkspaces()).toEqual([]);
  f.storage.tx(() => f.storage.db.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES('w','test',1,'test','{}',1,1)").run());
  f.storage.tx(() => f.storage.db.prepare("INSERT INTO sync_relay_current_files(workspace_id,version_id,path,blob_sha256,content_kind,state_relay_seq) VALUES('w','main','People/automations.yaml',?,'text',1)").run("a".repeat(64)));
  expect(f.host.automations.wantedWorkspaces()).toEqual(["w"]);
  f.storage.tx(() => f.storage.db.prepare("DELETE FROM sync_relay_current_files WHERE workspace_id='w'").run());
  expect(f.host.automations.wantedWorkspaces()).toEqual([]);
});

it("checks current ownership again when an automation invokes an operation", async () => {
  const f = await fixture();
  const context = f.ledger.context({ automationId, claimId: "owner-change", person: null, depth: 1 });
  f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_workspaces SET owner_user_id='replacement' WHERE workspace_id='w'").run());
  await expect(Promise.resolve().then(() => f.ledger.invoke(context, {
    ...rules, operationId: CREATE, input: { values: { [NAME]: "No" } }, idempotencyKey: "refused",
  }))).rejects.toThrow();
});

it("leaves claims pending without an executor and forgets their private press records with the workspace", async () => {
  const f = await fixture();
  f.ledger.subscribe(DATASET, f.subscription);
  await f.create();
  expect(f.ledger.claims(automationId).claims).toMatchObject([{ state: "pending" }]);
  await f.host.automations.press(owner, DATASET, f.lifetime.signal, async () => f.ledger.press(DATASET, f.press));
  expect(f.ledger.pressed(f.press.pressId)).not.toBeNull();
  await f.host.close();
  f.storage.tx(() => f.storage.db.prepare("DELETE FROM sync_relay_workspaces WHERE workspace_id='w'").run());
  for (const table of ["dohc_dataset_automation_presses", "dohc_dataset_automation_claims", "dohc_dataset_automation_failure_generations"]) {
    expect(f.storage.db.prepare("SELECT COUNT(*) AS n FROM " + table).get()!.n).toBe(0);
  }
});


it.each(["fresh", "rebuilt", "removed-while-off"])("holds a removed editor's dataset step on a %s server copy", async copy => {
  const f = await fixture();
  f.addEditor();
  // This step can run only after the editor is removed: they cannot use its operation.
  f.host.setDataGrant(owner, { ...scope, grantId: editor.grantId, grant: null });
  const old = await executorFor(f);
  await vi.waitFor(async () => expect((await old.store.readReachVerdicts()).verdicts).toEqual(expect.arrayContaining([expect.objectContaining({ verdict: "stopped" })])), { timeout: 30_000 });
  await old.executor.dispose();
  f.storage.tx(() => f.storage.db.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=2 WHERE grant_id=?").run(editor.grantId));
  if (copy === "removed-while-off") await rm(join(f.directory, "metadata"), { recursive: true });
  const next = await executorFor(f, false, copy);
  await vi.waitFor(async () => expect((await next.store.readReachVerdicts()).verdicts.length).toBeGreaterThan(0), { timeout: 30_000 });
  expect(next.executor.holds()).toEqual(expect.arrayContaining([expect.objectContaining({ step: JSON.stringify(["operation", DATASET, EDIT]) })]));
  const released = vi.spyOn(f.ledger, "release");
  await f.create();
  await vi.waitFor(() => expect(released).toHaveBeenCalled(), { timeout: 30_000 });
  expect(f.ledger.claims(automationId).claims).toMatchObject([{ state: "pending", attempts: 0 }]);
  expect((await f.host.invoke(owner, { ...scope, ...rules, operationId: READ, input: {}, idempotencyKey: "held-read" })).result)
    .toMatchObject({ rows: [{ values: { [NAME]: "Before" } }] });
  await next.executor.dispose();
  const restarted = await executorFor(f, false, copy);
  await vi.waitFor(() => expect(restarted.executor.holds()).toEqual(expect.arrayContaining([expect.objectContaining({ step: JSON.stringify(["operation", DATASET, EDIT]) })])), { timeout: 30_000 });
  expect(next.errors).toEqual([]);
  expect(restarted.errors).toEqual([]);
}, 90_000);

it("selects wanted workspaces with one indexed query regardless of dataset count", async () => {
  const f = await fixture();
  f.storage.tx(() => {
    f.storage.db.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES('w','test',1,'test','{}',1,1)").run();
    const insert = f.storage.db.prepare("INSERT INTO sync_relay_current_files(workspace_id,version_id,path,blob_sha256,content_kind,state_relay_seq) VALUES('w',?,?,?,'text',1)");
    insert.run("main", "People/automations.yaml", "a".repeat(64));
    insert.run("other", "People/automations.yaml", "a".repeat(64));
    for (let n = 10; n < 110; n++) {
      f.storage.db.prepare("INSERT INTO dohc_dataset_catalog SELECT workspace_id,?,revision_json,artifacts_json FROM dohc_dataset_catalog WHERE dataset_id=?").run(id(n), DATASET);
    }
  });
  const prepare = vi.spyOn(f.storage.db, "prepare");
  expect(f.host.automations.wantedWorkspaces()).toEqual(["w"]);
  expect(prepare).toHaveBeenCalledOnce();
  const query = prepare.mock.calls[0]![0]; prepare.mockRestore();
  const plan = f.storage.db.prepare("EXPLAIN QUERY PLAN " + query).all();
  expect(plan.some(row => String(row.detail).includes("sync_relay_automation_files"))).toBe(true);
  expect(plan.filter(row => String(row.detail).startsWith("SCAN c"))).toEqual([]);
});

it("flags commit wakes only when they recorded failed claims", async () => {
  const f = await fixture();
  f.ledger.subscribe(DATASET, f.subscription);
  const wake = vi.fn(); f.host.observeAutomationClaims(wake);
  await f.create("ordinary");
  expect(wake).toHaveBeenLastCalledWith("w", false);
  const context = f.ledger.context({ automationId: "collection:People#writer", claimId: "chain", person: null, depth: 4 });
  await f.ledger.invoke(context, { ...rules, operationId: CREATE, input: { values: { [ID]: "chain", [NAME]: "Before" } }, idempotencyKey: "chain" });
  expect(wake).toHaveBeenLastCalledWith("w", true);
  expect(f.ledger.failures()).toHaveLength(1);
});

it.each([false, true])("checks destination grants again before recording a press (revoked: %s)", async (revoked) => {
  const f = await fixture(); f.addEditor("edit", ["People", "Other"]); await f.create();
  const otherId = id(20);
  const otherDefinition = { ...definition, datasetId: otherId, name: "Other", schemaPath: "Other/schema.sql", operationsPath: "Other/operations.js" };
  const otherSource = generateDatasetOperations(otherDefinition);
  const otherRevision = describeDatasetRevision({ definition: otherDefinition, revision: 1, schemaSql, operationSource: otherSource });
  const otherScope = { workspaceId: "w", datasetId: otherId };
  await f.host.activate(owner, { ...otherScope, revision: otherRevision, schemaSql, operationSource: otherSource, capacityBytes: 1024 * 1024 });
  f.host.setDataGrant(owner, { ...otherScope, grantId: editor.grantId,
    grant: { operationIds: [READ, EDIT], discover: true, revision: 1, revisionSha256: otherRevision.revisionSha256 } });
  const pressId = "cross-dataset";
  const press = f.host.automations.press(editor, DATASET, f.lifetime.signal, async describe => {
    const destination = await describe(otherId);
    expect(destination.datasetId).toBe(otherId);
    expect(destination.operations.some(operation => operation.operationId === EDIT)).toBe(true);
    if (revoked) f.host.setDataGrant(owner, { ...otherScope, grantId: editor.grantId, grant: null });
    return f.ledger.press(DATASET, { ...f.press, pressId, pressedBy: "editor" });
  });
  if (revoked) {
    await expect(press).rejects.toThrow();
    expect(f.ledger.pressed(pressId)).toBeNull();
  } else {
    await expect(press).resolves.toMatchObject({ kind: "claimed" });
    expect(f.ledger.pressed(pressId)).not.toBeNull();
  }
});
