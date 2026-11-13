import { afterAll, describe, expect, it, vi } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { AppBackendRuntimeError } from "@dohc/app-backend-runtime";
import type { JsonValue } from "@dohc/app-backend-runtime/automation";
import type { DatasetInvocationResult } from "@dohc/app-backend-runtime/supervisor";
import type { DatasetDefinition, DatasetRevision } from "@dohc/security-contract/dataset";
import { parseAutomationsFile, type Automation } from "@dohc/workspace-contracts/automations";
import type { CollectionRecord } from "@dohc/workspace-contracts/collection";
import { createAutomationFormulaEvaluator } from "./automationEvaluatorHost";
import { createAutomationRunStore } from "./automationRunStore";
import {
  type CollectionAutomationReads,
  type CollectionRecordWrites,
  RECORD_NOT_FOUND,
} from "./collectionAutomationRun";
import { type DatasetInvocation, type DatasetRunHost } from "./datasetAutomationRun";
import {
  runCollectionAutomation,
  type CollectionAutomationRunDependencies,
} from "./collectionAutomationRun";
import {
  runDatasetAutomation,
  type DatasetRunClaim,
  type DatasetAutomationRunDependencies,
} from "./datasetAutomationRun";
import type { AutomationClaim } from "@dohc/workspace-engine-client";
import { undoAutomationRuns, automationUndoReach } from "./automationUndo";
import { planDatasetUndo, type DatasetUndoHost } from "./datasetAutomationUndo";
import { createTestScratch, testStoreFolder } from "./testScratch";
import { datasetPrincipalKey } from "@dohc/security-contract/dataset-artifacts";
import type { ReachRoster } from "./automationReach";
import type { AutomationTarget } from "./automationTargets";
import {
  automationInventory,
  canPressInventory,
  irreversibleActionsOf,
} from "./automationInventory";
import { checkAutomationReach } from "./automationReach";

const evaluator = createAutomationFormulaEvaluator();
afterAll(async () => {
  await evaluator.close();
});
const roster = { kind: "owner" as const, ownerUserId: null, grants: [] };
const signal = new AbortController().signal;
type Row = { id: string | number; version: number; values: Record<string, JsonValue> };
function definition(path: string): DatasetRevision {
  const datasetId = path + "-dataset";
  const definition: DatasetDefinition = {
    formatVersion: 1,
    datasetId,
    name: path,
    schemaPath: path + "/schema.sql",
    operationsPath: path + "/operations.js",
    tables: [
      {
        tableId: "table",
        name: "Rows",
        sqlName: "rows",
        primaryKey: "id",
        fields: [
          {
            fieldId: "id",
            name: "ID",
            sqlColumn: "id",
            type: "text",
            required: true,
            unique: true,
          },
          {
            fieldId: "status",
            name: "Status",
            sqlColumn: "status",
            type: "text",
            required: false,
            unique: false,
          },
        ],
      },
    ],
    operations: [
      {
        operationId: "read",
        name: "rows.read",
        label: "Read",
        tableId: "table",
        kind: "read",
        access: "owner",
        readOnly: true,
        fieldIds: ["id", "status"],
      },
      {
        operationId: "create",
        name: "rows.create",
        label: "Create",
        tableId: "table",
        kind: "create",
        access: "owner",
        readOnly: false,
        fieldIds: ["status"],
      },
      {
        operationId: "edit",
        name: "rows.edit",
        label: "Edit",
        tableId: "table",
        kind: "edit",
        access: "owner",
        readOnly: false,
        fieldIds: ["status"],
        reversible: true,
      },
      {
        operationId: "delete",
        name: "rows.delete",
        label: "Delete",
        tableId: "table",
        kind: "delete",
        access: "owner",
        readOnly: false,
        fieldIds: [],
      },
    ],
  };
  return {
    datasetId,
    revision: 1,
    revisionSha256: "a".repeat(64),
    definitionSha256: "",
    schemaSha256: "",
    operationsSha256: "",
    definition,
  };
}
function automation(source: string): Automation {
  const parsed = parseAutomationsFile(
    "version: 1\nautomations:\n  - id: test\n    name: Test\n    when: record-added\n    do:\n" +
      source,
  );
  if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid")
    throw new Error(JSON.stringify(parsed));
  return parsed.entries[0].automation;
}
const find = (path: string, dataset: boolean, as = "found") =>
  '      - find: record.Status == "Open"\n        collection: ' +
  path +
  "\n        as: " +
  as +
  "\n" +
  (dataset ? "        operation: rows.read\n" : "");
const add = (path: string, dataset: boolean, as = "added") =>
  "      - add-record:\n          Status: Open\n        collection: " +
  path +
  "\n        as: " +
  as +
  "\n" +
  (dataset ? "        operation: rows.create\n" : "");
const set = (dataset: boolean, records: string, value = "Closed") =>
  "      - set:\n          Status: " +
  value +
  "\n        records: " +
  records +
  "\n" +
  (dataset ? "        operation: rows.edit\n" : "");

async function fixture(sourceDataset = false, targetDataset = true) {
  const scratch = await createTestScratch("static-automation-");
  const store = createAutomationRunStore(testStoreFolder(scratch));
  let currentRoster: Exclude<ReachRoster, { kind: "unknown" }> = roster;
  const targets = new Map<string, AutomationTarget>();
  const rows = new Map<string, Map<string | number, Row>>();
  const docs = new Map<
    string,
    { path: string; id: string; collection: string; status: JsonValue }
  >();
  const collectionIds = new Map<string, string>();
  const receipts = new Map<string, { payload: string; result: DatasetInvocationResult }>();
  const calls: DatasetInvocation[] = [];
  const keys = new Set<string>();
  const hooks: {
    hideDatasetLocations?: boolean;
    beforeRead?: () => void;
    afterEffect?: () => void;
    beforeEffect?: () => void;
    hostDown: boolean;
    crashAppend: boolean;
  } = { hostDown: false, crashAppend: false };
  for (const [path, dataset] of [
    ["Source", sourceDataset],
    ["Target", targetDataset],
    ["Other", true],
  ] as const) {
    collectionIds.set(path, dataset ? path + "-dataset" : path);
    if (dataset) {
      const approved = definition(path);
      targets.set(path, {
        kind: "dataset",
        collection: { path, name: path },
        approved,
        generated: true,
        grants: { workspaceId: "workspace", grants: [] },
      });
      rows.set(
        approved.datasetId,
        new Map([["same", { id: "same", version: 1, values: { id: "same", status: "Open" } }]]),
      );
    } else {
      targets.set(path, {
        kind: "document",
        collection: { path, name: path },
        fields: new Set(["Status"]),
      });
      docs.set(path + "/same", {
        path: path + "/same.md",
        id: path + "-same",
        collection: path,
        status: "Open",
      });
    }
  }
  const record = (doc: { path: string; id: string; status: JsonValue }): CollectionRecord => ({
    id: doc.id,
    path: doc.path,
    conflicted: false,
    values: [
      {
        field: "Status",
        value: doc.status as string,
        validation: { status: "untyped" },
        resolvedRelations: [],
      },
    ],
  });
  const reads: CollectionAutomationReads = {
    async getCollectionRecord({ collectionPath, recordId }) {
      const doc = [...docs.values()].find(
        (doc) => doc.collection === collectionPath && doc.id === recordId,
      );
      if (!doc) throw new Error(RECORD_NOT_FOUND);
      return {
        collection: {
          objectId: collectionPath,
          path: collectionPath,
          status: "valid",
          reasons: [],
        },
        record: record(doc),
        history: [],
        nextBeforeHistoryId: null,
      };
    },
    async queryCollectionRecords({ collectionPath, filter }) {
      const found = [...docs.values()].filter(
        (doc) =>
          doc.collection === collectionPath &&
          (!filter || isDeepStrictEqual(filter.value, doc.status)),
      );
      return {
        collection: {
          objectId: collectionPath,
          path: collectionPath,
          status: "valid",
          reasons: [],
        },
        records: found.map(record),
        groups: null,
        nextCursor: null,
      };
    },
  };
  const writes: CollectionRecordWrites = {
    async create({ collectionPath, recordId, name }) {
      const key = collectionPath + "/" + recordId;
      if (!docs.has(key))
        docs.set(key, {
          id: recordId,
          path: collectionPath + "/" + name + ".md",
          collection: collectionPath,
          status: null,
        });
      return { recordId, path: docs.get(key)!.path };
    },
    async setFields({ recordPath, fields, expectedBefore, idempotencyKeyPrefix }) {
      hooks.beforeEffect?.();
      const doc = [...docs.values()].find((doc) => doc.path === recordPath)!;
      const key = idempotencyKeyPrefix + "/Status";
      if (idempotencyKeyPrefix && keys.has(key)) return { replaced: {}, kept: {} };
      if (expectedBefore && !isDeepStrictEqual(doc.status, expectedBefore.Status))
        return { replaced: {}, kept: { Status: doc.status } };
      if (idempotencyKeyPrefix) keys.add(key);
      const before = doc.status;
      doc.status = fields.Status as JsonValue;
      hooks.afterEffect?.();
      return {
        replaced: isDeepStrictEqual(before, doc.status) ? {} : { Status: before },
        kept: {},
      };
    },
  };
  const invoke = async (
    request: DatasetInvocation,
    caller: unknown = { kind: "owner" },
  ): Promise<DatasetInvocationResult> => {
    calls.push(structuredClone({ ...request, signal: undefined }));
    const key = JSON.stringify([request.datasetId, caller, request.idempotencyKey]);
    const payload = JSON.stringify([
      request.revision,
      request.revisionSha256,
      request.operationId,
      request.input,
    ]);
    const saved = receipts.get(key);
    if (saved !== undefined) {
      if (saved.payload !== payload)
        throw new Error("A receipt key was reused with another payload.");
      return { ...saved.result, replayed: true };
    }
    const input = request.input;
    if (input === null || typeof input !== "object" || Array.isArray(input))
      throw new Error("input");
    const destination = [...targets.values()].find(
      (target) => target.kind === "dataset" && target.approved.datasetId === request.datasetId,
    );
    const operation =
      destination?.kind === "dataset"
        ? destination.approved.definition.operations.find(
            (operation) => operation.operationId === request.operationId,
          )
        : undefined;
    const own =
      rows.get(`${request.datasetId}/${operation?.tableId}`) ?? rows.get(request.datasetId)!;
    if (operation?.kind === "read") {
      hooks.beforeRead?.();
      const filters = Array.isArray(input.filters) ? input.filters : [];
      const found = [...own.values()].filter((row) =>
        filters.every(
          (filter) =>
            filter !== null &&
            typeof filter === "object" &&
            !Array.isArray(filter) &&
            isDeepStrictEqual(row.values[String(filter.fieldId)], filter.value),
        ),
      );
      return {
        result: { rows: structuredClone(found), nextCursor: null },
        revision: 1,
        replayed: false,
      };
    }
    hooks.beforeEffect?.();
    let result: JsonValue;
    if (operation?.kind === "create") {
      const id = "new-" + own.size;
      const values = input.values as Record<string, JsonValue>;
      own.set(id, { id, version: 1, values: { id, ...values } });
      result = { id, version: 1 };
    } else if (request.operationId === "action" || request.operationId === "reverse") {
      const row = own.get(input.id as string | number)!;
      const before = row.values.status;
      row.values.status = input.status ?? "Acted";
      row.version += 1;
      result = { undo: { id: row.id, status: before ?? null } };
    } else {
      const row = own.get(input.id as string | number);
      if (!row) throw new AppBackendRuntimeError({ code: "not_found", message: "Gone" });
      if (row.version !== input.expectedVersion)
        throw new AppBackendRuntimeError({ code: "stale_record", message: "Changed" });
      if (operation?.kind === "delete") {
        own.delete(row.id);
        result = { id: row.id };
      } else {
        const priorValues = structuredClone(row.values);
        Object.assign(row.values, input.values);
        row.version += 1;
        result = { id: row.id, version: row.version, priorValues };
      }
    }
    const receipt = { result, revision: 2, replayed: false };
    receipts.set(key, { payload, result: receipt });
    hooks.afterEffect?.();
    return receipt;
  };
  const host: DatasetRunHost & DatasetUndoHost = {
    context: (input) => input,
    invoke: async (context, input) => invoke(input, context),
    invokeAsOwner: invoke,
    revision: (id) => {
      const target = [...targets.values()].find(
        (target) => target.kind === "dataset" && target.approved.datasetId === id,
      );
      if (target?.kind !== "dataset") throw new Error("missing");
      return target.approved;
    },
    generated: () => true,
    resolves: (rules) =>
      [...targets.values()].some(
        (target) =>
          target.kind === "dataset" &&
          target.approved.datasetId === rules.datasetId &&
          target.approved.revisionSha256 === rules.revisionSha256,
      ),
    dataGrants: (id) => {
      const target = [...targets.values()].find(
        (target) => target.kind === "dataset" && target.approved.datasetId === id,
      );
      if (target?.kind !== "dataset") throw new Error("missing");
      return target.grants;
    },
  };
  const dependencies: CollectionAutomationRunDependencies & DatasetAutomationRunDependencies = {
    makeDurable: async () => {},
    isButtonField: async () => true,
    collectionIdOf: (path) => collectionIds.get(path) ?? null,
    collectionPathOf: (id) =>
      hooks.hideDatasetLocations && id.endsWith("-dataset")
        ? null
        : ([...collectionIds].find(([, known]) => known === id)?.[0] ?? null),
    targets: {
      resolve: async (path) =>
        hooks.hostDown && targets.get(path)?.kind === "dataset"
          ? { kind: "problem", code: "host-unavailable", problem: "Unavailable" }
          : (targets.get(path) ?? { kind: "problem", code: "missing", problem: "Missing" }),
    },
    withReads: async (work) => work(reads),
    withRecordWrites: async (_signal, work) => work(writes),
    withHost: async (work) => (hooks.hostDown ? null : work(host)),
    cachedRoster: async () => currentRoster,
    checkReach: async () => false,
    evaluator: evaluator.forWorkspace("workspace"),
    store: {
      ...store,
      appendEffect: async (run, applied) => {
        if (hooks.crashAppend) {
          hooks.crashAppend = false;
          throw new Error("crash before journal append");
        }
        await store.appendEffect(run, applied);
      },
    },
    nowMs: () => 1000,
    personName: (id) => id,
    readCode: async () => null,
    readMessageBody: async () => null,
    chat: { hasMessage: async () => false, directory: async () => null, write: async () => {} },
    postNotice: async () => {},
    recipientVerdicts: async () => [],
  };
  const claim = {
    automationId: sourceDataset ? "collection:Source-dataset#test" : "collection:Source#test",
    claimId: "claim",
    createdAtMs: 1000,
    run: 1,
    depth: 0,
  };
  const held: DatasetRunClaim | { source: "document"; claim: AutomationClaim } = sourceDataset
    ? {
        source: "dataset",
        claim: {
          ...claim,
          workspaceId: "workspace",
          datasetId: "Source-dataset",
          hostEpoch: "epoch",
          revision: 1,
          fact: {
            kind: "added",
            datasetId: "Source-dataset",
            tableId: "table",
            recordId: "same",
            version: 1,
            fields: [],
          },
          actor: { kind: "owner" },
          state: "running",
          attempts: 1,
          error: null,
          updatedAtMs: 1000,
        },
      }
    : {
        source: "document",
        claim: {
          ...claim,
          collectionPath: "Source",
          recordId: "Source-same",
          state: "running",
          attempts: 1,
          updatedAtMs: 1000,
          trigger: { historyId: 1 },
          change: {
            kind: "added",
            authorOriginId: null,
            actorKind: "human",
            onBehalfOf: null,
            sharedAuthor: null,
            liveCursor: null,
            fields: [],
            fieldsOmitted: 0,
          },
        },
      };
  const run = (automation: Automation) => {
    const input = {
      automation,
      collection: { path: "Source", name: "Source" },
      roster: currentRoster,
      signal,
      stopped: signal,
    };
    return held.source === "document"
      ? runCollectionAutomation(dependencies, { ...input, claim: held.claim })
      : runDatasetAutomation(dependencies, { ...input, held });
  };
  const runs = async () => (await store.runsOf(claim.automationId, claim.claimId)).runs;
  const undo = async () => {
    const restored = await runs();
    const planned = await planDatasetUndo(
      host,
      { roster: currentRoster, collection: { path: "Source", name: "Source" } },
      claim.claimId,
      restored,
      restored,
      signal,
    );
    const holder = restored.at(-1)!;
    holder.undoCalls.push(...planned.send([])!);
    return undoAutomationRuns(
      {
        collectionPathOf: dependencies.collectionPathOf,
        withReads: dependencies.withReads,
        withRecordWrites: dependencies.withRecordWrites,
        trash: async (path) => {
          for (const [key, doc] of docs) if (doc.path === path) docs.delete(key);
        },
      },
      host,
      { path: "Source", name: "Source" },
      async () => currentRoster,
      claim.claimId,
      restored,
      async (request) => {
        const run = restored.at(-1)!;
        await store.recordUndoRequest(run, request);
        run.undoRequests.push(request);
      },
      signal,
    );
  };
  const move = (from: string, to: string) => {
    const target = targets.get(from)!;
    targets.delete(from);
    targets.set(to, { ...target, collection: { path: to, name: to } });
    collectionIds.set(to, collectionIds.get(from)!);
    collectionIds.delete(from);
    if (target.kind === "dataset") {
      target.approved.definition.schemaPath = to + "/schema.sql";
      target.approved.definition.operationsPath = to + "/operations.js";
    }
    for (const doc of docs.values())
      if (doc.collection === from) {
        doc.collection = to;
        doc.path = to + doc.path.slice(from.length);
      }
  };
  return {
    run,
    runs,
    undo,
    move,
    targets,
    rows,
    docs,
    hooks,
    host,
    calls,
    dependencies,
    held,
    setRoster: (roster: Exclude<ReachRoster, { kind: "unknown" }>) => {
      currentRoster = roster;
    },
  };
}

function authored(f: Awaited<ReturnType<typeof fixture>>, path: string, reversible = true) {
  const target = f.targets.get(path);
  if (target?.kind !== "dataset") throw new Error("Expected a dataset");
  target.generated = false;
  target.approved.definition.operations.push(
    {
      operationId: "action",
      name: "rows.act",
      label: "Act",
      kind: "action",
      tableId: "table",
      access: "owner",
      readOnly: false,
      fieldIds: ["status"],
      ...(reversible ? { reversedBy: "rows.reverse" } : {}),
    },
    {
      operationId: "reverse",
      name: "rows.reverse",
      label: "Reverse",
      kind: "action",
      tableId: "table",
      access: "owner",
      readOnly: false,
      fieldIds: ["status"],
    },
  );
  return target;
}
const actionStep = (path: string) =>
  `      - invoke: rows.act\n        collection: ${path}\n        input: {id: same}\n`;

const codeStep = (source: string) => automation(`      - run: ${JSON.stringify(source)}\n`);
const changes = (
  ...records: Array<{
    action: "add" | "change";
    collection: string;
    table?: string;
    id?: string;
    fields: Record<string, JsonValue>;
  }>
) => codeStep(`return ${JSON.stringify({ records })};`);

describe("cross-Collection code changes", () => {
  it.each([true])(
    "denies a dynamic destination generically between steps, grant revoked=%s",
    async (grantRevoked) => {
      const f = await fixture();
      f.move("Target", "HR");
      const target = f.targets.get("HR");
      if (target?.kind !== "dataset") throw new Error("target");
      target.approved.definition.operations.forEach((operation) => {
        operation.access = "helper";
      });
      target.approved.definition.operations.find(
        (operation) => operation.operationId === "edit",
      )!.name = "Update Status";
      const editor: Exclude<ReachRoster, { kind: "unknown" }> = {
        kind: "owner",
        ownerUserId: "owner",
        grants: [
          {
            grantId: "editor",
            recipientUserId: "editor",
            recipientEmail: "E",
            files: { paths: ["Source"], versionId: null, access: "edit" },
            channel: null,
          },
        ],
      };
      if (grantRevoked) {
        f.setRoster(editor);
        target.grants.grants = [
          {
            principalKey: datasetPrincipalKey("workspace", "editor", "editor"),
            operationIds: ["read", "edit"],
          },
        ];
      }
      f.hooks.afterEffect = () => {
        f.hooks.afterEffect = undefined;
        f.setRoster(editor);
        target.grants.grants = [];
      };
      const a = automation(
        '      - run: \'return { records: [{ action: "change", collection: "HR", id: "same", fields: { Status: "First" } }] };\'\n' +
          '      - run: \'return { records: [{ action: "change", collection: "HR", id: "same", fields: { Status: "Second" } }] };\'\n',
      );
      expect(await f.run(a)).toMatchObject({
        kind: "failed",
        error: "This automation cannot use the requested Collection or fields.",
      });
      expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("First");
      expect(f.calls.filter((call) => call.operationId === "edit")).toHaveLength(1);
      expect((await f.runs())[0]!.steps).toHaveLength(1);
    },
  );

  it.each(["document", "dataset"])(
    "does not disclose HR's Salary field with a %s destination",
    async (kind) => {
      const answers: unknown[] = [];
      for (const salary of [false, true]) {
        const f = await fixture(false, kind !== "document");
        f.move("Target", "HR");
        const target = f.targets.get("HR")!;
        if (kind === "missing") f.targets.delete("HR");
        if (target.kind === "document" && salary) target.fields = new Set(["Status", "Salary"]);
        if (target.kind === "dataset") {
          if (salary) {
            target.approved.definition.tables[0]!.fields[1]!.name = "Salary";
          }
          if (kind === "authored") target.generated = false;
          if (kind === "ambiguous")
            target.approved.definition.tables.push({
              ...target.approved.definition.tables[0]!,
              tableId: "other",
              name: "Other",
            });
        }
        f.setRoster({
          kind: "owner",
          ownerUserId: "owner",
          grants: [
            {
              grantId: "editor",
              recipientUserId: "editor",
              recipientEmail: "editor@example.com",
              files: { paths: ["Source"], versionId: null, access: "edit" },
              channel: null,
            },
          ],
        });
        answers.push(
          await f.run(
            changes({
              action: "add",
              collection: "HR",
              ...(kind === "missing-table" ? { table: "Missing" } : {}),
              fields: { Salary: "secret" },
            }),
          ),
        );
        expect(f.calls).toEqual([]);
      }
      expect(answers[0]).toEqual(answers[1]);
      expect(answers[0]).toMatchObject({
        kind: "failed",
        error:
          "The code in step 1 changes records. This automation cannot use the requested Collection or fields.",
      });
    },
  );

  it("keeps a document hold ahead of schema validation", async () => {
    const f = await fixture(false, false);
    f.dependencies.recipientVerdicts = async () => ["held"];
    expect(
      await f.run(changes({ action: "add", collection: "Target", fields: { Missing: "x" } })),
    ).toEqual({ kind: "wait", reason: "held" });
    expect(f.docs.size).toBe(2);
  });

  it.each([null, "local-fallback"])(
    "checks button caller %s independently of the owner account",
    async (person) => {
      const f = await fixture();
      if (f.held.source !== "document") throw new Error("claim");
      f.held.claim.change.kind = "button";
      f.held.claim.change.onBehalfOf = person;
      f.dependencies.localPersonId = () => "local-fallback";
      f.setRoster({ kind: "owner", ownerUserId: person === null ? null : "owner", grants: [] });
      const a = changes({
        action: "change",
        collection: "Target",
        id: "same",
        fields: { Status: "Closed" },
      });
      a.when = { kind: "button", field: "Run", table: null };
      expect(await f.run(a)).toMatchObject({ kind: person === null ? "failed" : "done" });
      expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe(
        person === null ? "Open" : "Closed",
      );
    },
  );

  it.each([
    [false, true],
    [true, false],
  ])(
    "routes from dataset %s to dataset %s and uses the shared Undo",
    async (sourceDataset, targetDataset) => {
      const f = await fixture(sourceDataset, targetDataset);
      const definition = changes({
        action: "change",
        collection: "Target",
        id: targetDataset ? "same" : "Target-same",
        fields: { Status: "Closed" },
      });
      expect(await f.run(definition)).toMatchObject({ kind: "done" });
      const status = () =>
        targetDataset
          ? f.rows.get("Target-dataset")!.get("same")!.values.status
          : f.docs.get("Target/same")!.status;
      expect(status()).toBe("Closed");
      expect((await f.runs())[0]!.steps[0]!.destinations).toMatchObject([{ path: "Target" }]);
      await f.undo();
      expect(status()).toBe("Open");
    },
  );

  it("keeps equal record ids in two explicitly selected tables separate", async () => {
    const f = await fixture();
    const target = f.targets.get("Target");
    if (target?.kind !== "dataset") throw new Error("target");
    target.approved.definition.tables.push({
      ...structuredClone(target.approved.definition.tables[0]!),
      tableId: "second",
      name: "Second",
      sqlName: "second",
    });
    target.approved.definition.operations.push(
      ...target.approved.definition.operations.map((operation) => ({
        ...operation,
        tableId: "second",
        operationId: "second-" + operation.operationId,
        name: "second." + operation.kind,
      })),
    );
    f.rows.set(
      "Target-dataset/second",
      new Map([["same", { id: "same", version: 1, values: { id: "same", status: "Open" } }]]),
    );
    expect(
      await f.run(
        changes(
          {
            action: "change",
            collection: "Target",
            table: "Rows",
            id: "same",
            fields: { Status: "First" },
          },
          {
            action: "change",
            collection: "Target",
            table: "Second",
            id: "same",
            fields: { Status: "Second" },
          },
        ),
      ),
    ).toMatchObject({ kind: "done" });
    expect((await f.runs())[0]!.steps[0]!.effects).toMatchObject([
      { tableId: "table", operationId: "edit" },
      { tableId: "second", operationId: "second-edit" },
    ]);
    expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("First");
    expect(f.rows.get("Target-dataset/second")!.get("same")!.values.status).toBe("Second");
    await f.undo();
    expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("Open");
    expect(f.rows.get("Target-dataset/second")!.get("same")!.values.status).toBe("Open");
  });

  it("replays a mixed saved code step after a lost receipt append without evaluating its file again", async () => {
    const f = await fixture();
    const readCode = vi.fn(async () => ({
      text: "return { records: [{ action: 'add', collection: 'Target', fields: { Status: 'Added' } }, { action: 'change', collection: 'Source', id: 'Source-same', fields: { Status: 'Closed' } }] };",
      truncated: false,
    }));
    f.dependencies.readCode = readCode;
    const definition = automation("      - run-file: run.js\n");
    f.hooks.crashAppend = true;
    await expect(f.run(definition)).rejects.toThrow("crash before journal append");
    f.dependencies.readCode = async () => {
      throw new Error("code was read again");
    };
    f.dependencies.evaluator = {
      evaluate: async () => {
        throw new Error("evaluated again");
      },
      runCode: async () => {
        throw new Error("evaluated again");
      },
    };
    expect(await f.run(definition)).toMatchObject({ kind: "done" });
    expect(readCode).toHaveBeenCalledTimes(1);
    expect(f.rows.get("Target-dataset")!.size).toBe(2);
    expect(f.docs.get("Source/same")!.status).toBe("Closed");
    const calls = f.calls.filter((call) => call.operationId === "create");
    expect(calls[1]!.idempotencyKey).toBe(calls[0]!.idempotencyKey);
  });

  it("rejects a replaced saved target without replaying code or redirecting the effect", async () => {
    const f = await fixture();
    const definition = changes({
      action: "add",
      collection: "Target",
      fields: { Status: "Added" },
    });
    f.hooks.crashAppend = true;
    await expect(f.run(definition)).rejects.toThrow("crash before journal append");
    const target = f.targets.get("Target");
    if (target?.kind !== "dataset") throw new Error("target");
    target.approved.datasetId = "replacement";
    const before = f.calls.length;
    expect(await f.run(definition)).toMatchObject({ kind: "failed" });
    expect(f.calls).toHaveLength(before);
  });

  it("requires the button caller's destination grants even when the caller is not an editor", async () => {
    const f = await fixture();
    if (f.held.source !== "document") throw new Error("claim");
    f.held.claim.change.kind = "button";
    f.held.claim.change.onBehalfOf = "visitor";
    f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [] });
    const definition = changes({
      action: "change",
      collection: "Target",
      id: "same",
      fields: { Status: "Closed" },
    });
    definition.when = { kind: "button", field: "Run", table: null };
    expect(await f.run(definition)).toMatchObject({
      kind: "failed",
      error: expect.stringContaining("person who pressed"),
    });
    expect(f.calls).toEqual([]);
  });

  it("rechecks grants before each effect and retains earlier writes", async () => {
    const f = await fixture();
    f.hooks.afterEffect = () =>
      f.setRoster({
        kind: "owner",
        ownerUserId: "owner",
        grants: [
          {
            grantId: "editor",
            recipientUserId: "editor",
            recipientEmail: "editor@example.com",
            files: { paths: ["Source"], versionId: null, access: "edit" },
            channel: null,
          },
        ],
      });
    expect(
      await f.run(
        changes(
          { action: "add", collection: "Target", fields: { Status: "First" } },
          { action: "add", collection: "Other", fields: { Status: "Denied" } },
        ),
      ),
    ).toMatchObject({ kind: "failed" });
    expect(f.rows.get("Target-dataset")!.size).toBe(2);
    expect(f.rows.get("Other-dataset")!.size).toBe(1);
    expect((await f.runs())[0]!.applied).toHaveLength(1);
  });

  it("replays and undoes under saved compatible rules after re-approval", async () => {
    const f = await fixture();
    const definition = changes({
      action: "add",
      collection: "Target",
      fields: { Status: "Added" },
    });
    f.hooks.crashAppend = true;
    await expect(f.run(definition)).rejects.toThrow("crash before journal append");
    const target = f.targets.get("Target");
    if (target?.kind !== "dataset") throw new Error("target");
    target.approved.revision += 1;
    target.approved.revisionSha256 = "b".repeat(64);
    f.host.resolves = () => true;
    expect(await f.run(definition)).toMatchObject({ kind: "done" });
    const calls = f.calls.filter((call) => call.operationId === "create");
    expect(calls.map((call) => [call.revision, call.revisionSha256])).toEqual([
      [1, "a".repeat(64)],
      [1, "a".repeat(64)],
    ]);
    await f.undo();
    expect(f.rows.get("Target-dataset")!.size).toBe(1);
  });

  it("rejects a path outside the workspace before resolving it", async () => {
    const f = await fixture();
    const resolve = vi.spyOn(f.dependencies.targets, "resolve");
    expect(
      await f.run(
        changes({ action: "add", collection: "../Private", fields: { Status: "Denied" } }),
      ),
    ).toMatchObject({ kind: "failed" });
    expect(resolve.mock.calls.every(([path]) => path === "Source")).toBe(true);
    expect(f.calls).toEqual([]);
  });
});

describe("cross-Collection authored actions", () => {
  it("keeps authored source fields unreadable while allowing a document add and a destination action", async () => {
    const f = await fixture(true, false);
    authored(f, "Source");
    authored(f, "Other");
    expect(await f.run(automation(add("Target", false) + actionStep("Other")))).toMatchObject({
      kind: "done",
    });
    expect(f.calls.every((call) => call.datasetId !== "Source-dataset")).toBe(true);
    const blocked = await fixture(true);
    authored(blocked, "Source");
    authored(blocked, "Target");
    expect(
      await blocked.run(
        automation(actionStep("Target").replace("{id: same}", "{id: '=record.Status'}")),
      ),
    ).toMatchObject({ kind: "failed" });
    expect(blocked.calls).toEqual([]);
  });

  it("replays a committed action after a journal failure and retains the destination after it moves", async () => {
    const f = await fixture();
    authored(f, "Target");
    const definition = automation(actionStep("Target"));
    f.hooks.crashAppend = true;
    await expect(f.run(definition)).rejects.toThrow("crash before journal append");
    f.move("Target", "Moved");
    expect(await f.run(definition)).toMatchObject({ kind: "done" });
    expect(f.rows.get("Target-dataset")!.get("same")!.version).toBe(2);
    expect((await f.runs())[0]!.steps[0]!.effects[0]).toMatchObject({ collectionPath: "Moved" });
    expect(await f.undo()).toMatchObject({ undone: { actionsReversed: 1 } });
  });

  it("does not invent a reverse action", async () => {
    const f = await fixture();
    authored(f, "Target", false);
    expect(await f.run(automation(actionStep("Target")))).toMatchObject({ kind: "done" });
    expect(await f.undo()).toMatchObject({ undone: { actions: 1, actionsReversed: 0 } });
    expect(f.calls.some((call) => call.operationId === "reverse")).toBe(false);
  });

  it("rechecks action grants immediately before invocation", async () => {
    const f = await fixture();
    authored(f, "Target");
    const save = f.dependencies.store.save;
    f.dependencies.store.save = async (run) => {
      await save(run);
      f.setRoster({
        kind: "owner",
        ownerUserId: "owner",
        grants: [
          {
            grantId: "editor",
            recipientUserId: "person",
            recipientEmail: "person@example.com",
            files: { paths: ["Source"], access: "edit", versionId: null },
            channel: null,
          },
        ],
      });
    };
    expect(await f.run(automation(actionStep("Target")))).toMatchObject({ kind: "failed" });
    expect(f.calls).toEqual([]);
  });

  it("requires destination grants for the declared reverse as well as the forward action", async () => {
    const f = await fixture();
    const target = authored(f, "Target");
    target.approved.definition.operations = target.approved.definition.operations.map(
      (operation) => ({ ...operation, access: "helper" }),
    );
    const editor = {
      grantId: "editor",
      recipientUserId: "person",
      recipientEmail: "person@example.com",
      files: { paths: ["Source"], versionId: null, access: "edit" as const },
      channel: null,
    };
    const roster: ReachRoster = { kind: "owner", ownerUserId: "owner", grants: [editor] };
    f.setRoster(roster);
    target.grants = {
      workspaceId: "workspace",
      grants: [
        {
          principalKey: datasetPrincipalKey("workspace", "editor", "person"),
          operationIds: ["action"],
        },
      ],
    };
    expect(await f.run(automation(actionStep("Target")))).toMatchObject({ kind: "done" });
    const reach = await automationUndoReach(
      await f.runs(),
      f.dependencies.targets,
      () => "Target",
      null,
      f.host,
    );
    expect(reach).toMatchObject([
      {
        kind: "dataset-operation",
        datasetId: "Target-dataset",
        operation: { operationId: "reverse" },
      },
    ]);
    expect(
      checkAutomationReach(roster, {
        id: "test",
        collection: { path: "Source", name: "Source" },
        codeFiles: [],
        steps: reach,
      }),
    ).toMatchObject([{ allowed: false }]);
    expect(f.calls.some((call) => call.operationId === "reverse")).toBe(false);
    target.grants = {
      ...target.grants,
      grants: target.grants.grants.map((grant) => ({
        ...grant,
        operationIds: [...grant.operationIds, "reverse"],
      })),
    };
    const allowed = await automationUndoReach(
      await f.runs(),
      f.dependencies.targets,
      () => "Target",
      null,
      f.host,
    );
    expect(
      checkAutomationReach(roster, {
        id: "test",
        collection: { path: "Source", name: "Source" },
        codeFiles: [],
        steps: allowed,
      }),
    ).toMatchObject([{ allowed: true }]);
    expect(await f.undo()).toMatchObject({ undone: { actionsReversed: 1 } });
  });

  it("requires the presser's destination operation and distinguishes confirmations across datasets", async () => {
    const f = await fixture();
    const target = authored(f, "Target", false);
    const other = authored(f, "Other", false);
    const definition = automation(actionStep("Target") + actionStep("Other"));
    const inventory = automationInventory(
      definition,
      "Source",
      (path) => f.targets.get(path)!,
      null,
    );
    const describe = async (id: string) => {
      const own = id === target.approved.datasetId ? target : other;
      return {
        ...own.approved,
        name: own.collection.name,
        tables: own.approved.definition.tables,
        operations: own.approved.definition.operations,
      };
    };
    expect(await canPressInventory(inventory)).toBe(false);
    expect(await canPressInventory(inventory, describe)).toBe(true);
    expect(
      await canPressInventory(inventory, async (id) => ({
        ...(await describe(id)),
        operations: id === other.approved.datasetId ? [] : (await describe(id)).operations,
      })),
    ).toBe(false);
    expect(
      await canPressInventory(inventory, async () => describe(target.approved.datasetId)),
    ).toBe(false);
    expect(irreversibleActionsOf(definition, "Source", inventory)).toEqual([
      { name: "Target-dataset/rows.act", label: "Target: Act" },
      { name: "Other-dataset/rows.act", label: "Other: Act" },
    ]);
  });
});

describe("static steps across storage kinds", () => {
  it.each([true])("keeps a stale edit on dataset=%s", async (target) => {
    const f = await fixture(!target, target);
    f.hooks.beforeEffect = () => {
      f.hooks.beforeEffect = undefined;
      if (target) {
        const row = f.rows.get("Target-dataset")!.get("same")!;
        row.values.status = "Person";
        row.version += 1;
      } else f.docs.get("Target/same")!.status = "Person";
    };
    expect(await f.run(automation(find("Target", target) + set(target, "found")))).toEqual({
      kind: "done",
    });
    expect((await f.undo()).undone.reverted).toBe(0);
    expect(
      target
        ? f.rows.get("Target-dataset")!.get("same")!.values.status
        : f.docs.get("Target/same")!.status,
    ).toBe("Person");
  });
  it("recovers a mixed run after commit before journal append, then undoes both kinds", async () => {
    const f = await fixture();
    const a = automation(
      add("Target", true) + set(true, "added") + add("Source", false, "doc") + set(false, "doc"),
    );
    f.hooks.crashAppend = true;
    await expect(f.run(a)).rejects.toThrow("crash before journal append");
    expect(await f.run(a)).toEqual({ kind: "done" });
    expect(f.rows.get("Target-dataset")!.size).toBe(2);
    expect((await f.undo()).undone).toMatchObject({ removed: 1, deleted: 1 });
    expect(f.rows.get("Target-dataset")!.size).toBe(1);
  });
});

it("does not reuse another destination's grants for matching operation and field IDs", async () => {
  const f = await fixture();
  const grant = {
    grantId: "editor",
    recipientUserId: "person",
    recipientEmail: "person@example.com",
    files: { paths: ["Source", "Target", "Other"], versionId: null, access: "edit" as const },
    channel: null,
  };
  f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [grant] });
  const principalKey = datasetPrincipalKey("workspace", "editor", "person");
  for (const path of ["Target", "Other"]) {
    const target = f.targets.get(path)!;
    if (target.kind !== "dataset") throw new Error("fixture");
    target.approved.definition.operations = target.approved.definition.operations.map(
      (operation) => ({ ...operation, access: "helper" }),
    );
    target.grants = {
      workspaceId: "workspace",
      grants: path === "Target" ? [{ principalKey, operationIds: ["read", "edit", "create"] }] : [],
    };
  }
  expect(
    await f.run(
      automation(
        find("Target", true) +
          set(true, "found") +
          find("Other", true, "other") +
          set(true, "other"),
      ),
    ),
  ).toMatchObject({ kind: "failed" });
  expect(f.calls).toEqual([]);
});

it.each([true])(
  "mixed Undo restores an intervening edit when the final write lacks a journal entry on dataset=%s",
  async (target) => {
    const f = await fixture(!target, target);
    let effects = 0;
    f.hooks.afterEffect = () => {
      effects += 1;
      if (effects === 2) {
        if (target) {
          const row = f.rows.get("Target-dataset")!.get("same")!;
          row.values.status = "Person";
          row.version += 1;
        } else f.docs.get("Target/same")!.status = "Person";
      }
      if (effects === 3) f.hooks.crashAppend = true;
    };
    await expect(
      f.run(
        automation(
          add("Other", true, "other") +
            find("Target", target) +
            set(target, "found", "First") +
            set(target, "found", "Last"),
        ),
      ),
    ).rejects.toThrow("crash before journal append");
    f.hooks.afterEffect = undefined;
    expect((await f.undo()).undone).toMatchObject({ reverted: 1, deleted: 1 });
    expect(
      target
        ? f.rows.get("Target-dataset")!.get("same")!.values.status
        : f.docs.get("Target/same")!.status,
    ).toBe("Person");
  },
);

it("retries a mixed Undo after one destination was reversed and the next failed", async () => {
  const f = await fixture();
  const a = automation(
    find("Source", false, "docs") + set(false, "docs") + find("Target", true) + set(true, "found"),
  );
  expect(await f.run(a)).toEqual({ kind: "done" });
  const writes = f.dependencies.withRecordWrites;
  f.dependencies.withRecordWrites = async () => {
    throw new Error("document engine unavailable");
  };
  await expect(f.undo()).rejects.toThrow("document engine unavailable");
  expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("Open");
  expect(f.docs.get("Source/same")!.status).toBe("Closed");
  f.dependencies.withRecordWrites = writes;
  await f.undo();
  expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("Open");
  expect(f.docs.get("Source/same")!.status).toBe("Open");
});

it("replays a replan after commit-before-append with the same caller and payload", async () => {
  const f = await fixture();
  const a = automation(find("Target", true) + set(true, "found"));
  f.hooks.beforeEffect = () => {
    f.hooks.beforeEffect = undefined;
    // A different field changed: the planned field still qualifies for the replan.
    f.rows.get("Target-dataset")!.get("same")!.version += 1;
  };
  f.hooks.crashAppend = true;
  await expect(f.run(a)).rejects.toThrow("crash before journal append");
  const [saved] = await f.runs();
  expect(saved!.replans).toMatchObject([{ replan: 1, version: 2 }]);
  expect(await f.run(a)).toEqual({ kind: "done" });
  const edits = f.calls.filter((call) => call.operationId === "edit");
  expect(edits).toHaveLength(3);
  expect(edits[2]).toEqual(edits[1]);
  expect(f.rows.get("Target-dataset")!.get("same")!.version).toBe(3);
});

it.each(["revision"])("Undo refuses changed destination %s before any reversal", async (change) => {
  const f = await fixture();
  expect(await f.run(automation(find("Target", true) + set(true, "found")))).toEqual({
    kind: "done",
  });
  const target = f.targets.get("Target")!;
  if (target.kind !== "dataset") throw new Error("fixture");
  if (change === "descriptor") target.approved = { ...target.approved, datasetId: "replacement" };
  if (change === "revision")
    target.approved = { ...target.approved, revision: 2, revisionSha256: "b".repeat(64) };
  await expect(
    automationUndoReach(
      await f.runs(),
      f.dependencies.targets,
      f.dependencies.collectionPathOf,
      { roster, collection: { path: "Source", name: "Source" } },
      f.host,
    ),
  ).rejects.toThrow();
  expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("Closed");
});

it.each([[true, true]])(
  "keeps compatible approvals during a run and Undo, dataset=%s, resume=%s",
  async (sourceDataset, resume) => {
    const f = await fixture(sourceDataset);
    const resolve = f.dependencies.targets.resolve;
    f.dependencies.targets.resolve = async (path) => structuredClone(await resolve(path));
    const accepted = new Set<string>();
    for (const target of f.targets.values())
      if (target.kind === "dataset")
        accepted.add(
          JSON.stringify([
            target.approved.datasetId,
            target.approved.revision,
            target.approved.revisionSha256,
          ]),
        );
    f.host.resolves = (rules) =>
      accepted.has(JSON.stringify([rules.datasetId, rules.revision, rules.revisionSha256]));
    const approve = () => {
      for (const target of f.targets.values()) {
        if (target.kind !== "dataset") continue;
        const approved = structuredClone(target.approved);
        approved.revision += 1;
        approved.revisionSha256 = String(approved.revision).repeat(64);
        approved.definition.tables[0]!.fields.push({
          fieldId: "button-" + approved.revision,
          name: "Button " + approved.revision,
          type: "button",
        });
        target.approved = approved;
        accepted.add(
          JSON.stringify([approved.datasetId, approved.revision, approved.revisionSha256]),
        );
      }
    };
    f.hooks.beforeRead = () => {
      f.hooks.beforeRead = undefined;
      approve();
    };
    f.hooks.afterEffect = () => {
      f.hooks.afterEffect = undefined;
      approve();
    };
    f.hooks.crashAppend = resume;
    const a = automation(
      find("Target", true) + set(true, "found", "First") + set(true, "found", "Last"),
    );
    if (resume) await expect(f.run(a)).rejects.toThrow("crash before journal append");
    expect(await f.run(a)).toEqual({ kind: "done" });
    expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("Last");
    approve();
    await expect(
      automationUndoReach(
        await f.runs(),
        f.dependencies.targets,
        f.dependencies.collectionPathOf,
        { roster, collection: { path: "Source", name: "Source" } },
        f.host,
      ),
    ).resolves.toEqual([]);
    expect((await f.undo()).undone).toMatchObject({ reverted: 1 });
    expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("Open");
  },
);

it.each(["host"])("does not save a stale source refusal after the %s await", async (boundary) => {
  const f = await fixture(boundary === "host", false);
  const reached = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  let paused = false;
  const pause = async () => {
    if (!paused) {
      paused = true;
      reached.resolve();
      await resume.promise;
    }
  };
  if (boundary === "roster")
    f.dependencies.cachedRoster = async () => {
      if ((await f.runs()).length > 0) {
        await pause();
        return {
          kind: "owner",
          ownerUserId: "owner",
          grants: [
            {
              grantId: "editor",
              recipientUserId: "person",
              recipientEmail: "person@example.com",
              files: { paths: ["Source/automations.yaml"], access: "edit", versionId: null },
              channel: null,
            },
          ],
        };
      }
      return roster;
    };
  if (boundary === "host") {
    const withHost = f.dependencies.withHost!;
    let savedHostReads = 0;
    f.dependencies.withHost = async (work) => {
      // The first host read after planning refreshes step permissions.
      if ((await f.runs()).length > 0 && ++savedHostReads === 1) await pause();
      return withHost(work);
    };
  }
  if (boundary === "verdicts")
    f.dependencies.checkReach = async () => {
      if ((await f.runs()).length === 0) return false;
      await pause();
      return true;
    };
  const running = f.run(
    automation(
      (boundary === "verdicts" ? "      - set: {Status: First}\n" : "") +
        "      - set: {Status: Closed}\n" +
        (boundary === "host" ? "        operation: rows.edit\n" : ""),
    ),
  );
  try {
    await reached.promise;
    f.move("Source", "Shared/Source");
    if (boundary === "host") {
      const target = f.targets.get("Shared/Source")!;
      if (target.kind !== "dataset") throw new Error("Expected a dataset");
      f.targets.set("Shared/Source", {
        ...target,
        approved: { ...target.approved, revisionSha256: "b".repeat(64) },
      });
    }
    resume.resolve();
    await expect(running).resolves.toEqual({ kind: "wait", reason: "moved" });
    const runs = await f.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBeNull();
    expect(runs.flatMap((run) => run.applied)).toHaveLength(boundary === "verdicts" ? 1 : 0);
  } finally {
    resume.resolve();
    await running;
  }
});

it("does not save a stale destination refusal after the roster await", async () => {
  const f = await fixture(false, false);
  const reached = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  let paused = false;
  f.dependencies.cachedRoster = async () => {
    if (!paused && (await f.runs()).length > 0) {
      paused = true;
      reached.resolve();
      await resume.promise;
      return {
        kind: "owner",
        ownerUserId: "owner",
        grants: [
          {
            grantId: "editor",
            recipientUserId: "person",
            recipientEmail: "person@example.com",
            files: { paths: ["Source"], access: "edit", versionId: null },
            channel: null,
          },
        ],
      };
    }
    return roster;
  };
  const running = f.run(automation(find("Target", false) + set(false, "found")));
  try {
    await reached.promise;
    f.move("Target", "Shared/Target");
    resume.resolve();
    await expect(running).resolves.toEqual({ kind: "wait", reason: "moved" });
    const runs = await f.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBeNull();
    expect(runs[0]!.applied).toEqual([]);
    expect(f.docs.get("Target/same")!.status).toBe("Open");
  } finally {
    resume.resolve();
    await running;
  }
});

it.each(["held wait"])(
  "keeps a missing source retryable during an index read after %s",
  async (boundary) => {
    const f = await fixture(false, false);
    const reached = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    let missing = false,
      paused = false;
    const lookup = f.dependencies.collectionPathOf;
    f.dependencies.collectionPathOf = (id) => (missing && id === "Source" ? null : lookup(id));
    f.dependencies.isIndexReading = () => missing;
    const pause = async () => {
      if (!paused) {
        paused = true;
        reached.resolve();
        await resume.promise;
      }
    };
    if (boundary === "held wait")
      f.dependencies.checkReach = async () => {
        if ((await f.runs()).length === 0) return false;
        await pause();
        return true;
      };
    else
      f.dependencies.cachedRoster = async () => {
        if ((await f.runs()).length > 0) {
          await pause();
          if (boundary === "roster wait")
            return { kind: "unknown", problem: { kind: "unchecked", next: "Try again." } };
        }
        return roster;
      };
    const running = f.run(
      automation(
        (boundary === "held wait" ? "      - set: {Status: First}\n" : "") +
          "      - set: {Status: Closed}\n",
      ),
    );
    try {
      await reached.promise;
      missing = true;
      resume.resolve();
      await expect(running).resolves.toEqual({ kind: "wait", reason: "moved" });
      const runs = await f.runs();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.outcome).toBeNull();
      expect(runs[0]!.applied).toHaveLength(boundary === "held wait" ? 1 : 0);
    } finally {
      resume.resolve();
      await running;
    }
  },
);

it("still saves a gone source failure when no index read is active", async () => {
  const f = await fixture(false, false);
  const reached = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  let missing = false,
    paused = false;
  const lookup = f.dependencies.collectionPathOf;
  f.dependencies.collectionPathOf = (id) => (missing && id === "Source" ? null : lookup(id));
  f.dependencies.isIndexReading = () => false;
  f.dependencies.cachedRoster = async () => {
    if (!paused && (await f.runs()).length > 0) {
      paused = true;
      reached.resolve();
      await resume.promise;
    }
    return roster;
  };
  const running = f.run(automation("      - set: {Status: Closed}\n"));
  try {
    await reached.promise;
    missing = true;
    resume.resolve();
    await expect(running).resolves.toMatchObject({
      kind: "failed",
      error: "This automation's Collection is gone.",
    });
    const runs = await f.runs();
    expect(runs[0]!.outcome).toMatchObject({
      state: "failed",
      error: "This automation's Collection is gone.",
    });
    expect(runs[0]!.applied).toEqual([]);
  } finally {
    resume.resolve();
    await running;
  }
});
