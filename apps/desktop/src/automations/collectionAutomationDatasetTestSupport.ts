import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, vi } from "vitest";
import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";
import { datasetPrincipalKey } from "@dohc/security-contract/dataset-artifacts";
import { type JsonValue } from "@dohc/app-backend-runtime";
import { type DatasetDefinition } from "@dohc/security-contract/dataset";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { VersionedLiveAdapter, type AutomationClaim } from "@dohc/workspace-engine-client";
import { generateDatasetSources } from "../workspaces/datasetGenerator";
import { createLocalDatasetHost, type LocalDatasetAgent, type LocalDatasetHost } from "../workspaces/localDatasetHost";
import { createTestScratch } from "../workspaces/testTemp";
import { chatDirectoryOf, type AutomationChatMessage, type AutomationNotice, type ChatDirectoryChannel } from "@dohc/automation-executor/automation-chat";
import { createAutomationFormulaEvaluator, type AutomationFormulaEvaluator } from "@dohc/automation-executor/automation-evaluator-host";
import { type ReachRoster } from "@dohc/automation-executor/automation-reach";
import { type AutomationFailure } from "@dohc/automation-executor/automation-failed-notice";
import { createAutomationRunStore, type AutomationRunStore } from "@dohc/automation-executor/automation-run-store";
import { preparedAutomationStoreFolder, openedLocalState } from "../testing/preparedLocalState";
import { CollectionAutomations, type AutomationFailureReport, type CollectionAutomationEngine, type CollectionAutomationsOptions, type PressSettled, type PressWaitReason } from "@dohc/automation-executor/collection-automations";
import { definitionHash } from "@dohc/automation-executor/automation-plan";
import { AutomationRunWait, SHARED_BUTTON_DENIED, SHARED_BUTTON_UNCHECKED } from "@dohc/automation-executor/button-presser";
import { type RelayButtonAuthority } from "@dohc/workspace-contracts/relay";
import { unguardedCollections } from "../testing/collectionsHolder";

export function datasetAutomationFixture() {
  const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

  const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

  const OWNER: ReachRoster = { kind: "owner", ownerUserId: "user-owner", grants: [] };

  const UNKNOWN: ReachRoster = { kind: "unknown", problem: { kind: "unchecked", next: "dohc checks again when the server answers." } };

  const BUDGET = id(1);

  const AUTOMATION = `collection:${BUDGET}#close-paid`;

  const TABLE = id(2), PAID = id(4), STATUS = id(5), NOTES = id(6), FINISHED = id(7), MARK_PAID = id(8), REFUND = id(9);

  const LIST = id(10), CREATE = id(11), EDIT = id(12), STATUS_ONLY = id(13), REMOVE = id(17);

  const { definition, files } = generateDatasetSources({
    formatVersion: 1, datasetId: id(1), name: "Budget", schemaPath: "Budget/schema.sql", operationsPath: "Budget/operations.js",
    tables: [{ tableId: TABLE, name: "Invoices", sqlName: "invoices", primaryKey: "id", fields: [
      { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
      { fieldId: PAID, name: "Paid", sqlColumn: "paid", type: "checkbox", required: true, unique: false, default: false },
      { fieldId: STATUS, name: "Status", sqlColumn: "status", type: "text", required: true, unique: false, default: "Open" },
      { fieldId: NOTES, name: "Notes", sqlColumn: "notes", type: "text", required: false, unique: false },
      { fieldId: FINISHED, name: "Finished on", sqlColumn: "finished", type: "date", required: false, unique: false },
      { fieldId: MARK_PAID, name: "Mark paid", type: "button" },
      { fieldId: REFUND, name: "Refund", type: "button" },
    ] }],
    operations: [
      { operationId: LIST, name: "invoices.list", label: "View", tableId: TABLE, kind: "read", access: "helper", readOnly: true, fieldIds: [PAID, STATUS, NOTES, FINISHED] },
      { operationId: CREATE, name: "invoices.create", label: "Create", tableId: TABLE, kind: "create", access: "link", readOnly: false, fieldIds: [id(3), PAID, STATUS, NOTES] },
      { operationId: EDIT, name: "invoices.edit", label: "Edit", tableId: TABLE, kind: "edit", access: "helper", readOnly: false, fieldIds: [PAID, STATUS, NOTES] },
      { operationId: STATUS_ONLY, name: "invoices.status", label: "Set status", tableId: TABLE, kind: "edit", access: "helper", readOnly: false, fieldIds: [STATUS] },
      { operationId: REMOVE, name: "invoices.delete", label: "Delete", tableId: TABLE, kind: "delete", access: "helper", readOnly: false, fieldIds: [] },
    ],
  } satisfies DatasetDefinition);

  const closePaid = (step = "      - set:\n          Status: Closed\n        operation: invoices.status\n", enabled = true) => `  - id: close-paid
    name: Close paid invoices
    enabled: ${enabled}
    when:
      field-changed: Paid
    do:
${step}`;

  const sharedEvaluator = createAutomationFormulaEvaluator();

  afterAll(() => sharedEvaluator.close());

  const compileFixture = createDatasetFixtureCompiler();

  const hosts: LocalDatasetHost[] = [];

  const drains: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const drain of drains.splice(0)) await drain();
    for (const host of hosts.splice(0)) await host.close();
  });

  const TEAM: ChatDirectoryChannel = { id: "team", name: "Team", slug: "team", kind: "channel", type: "posts", wireId: "team", runningThreadId: null };

  const AUTHORED_OPERATIONS = `${files[definition.operationsPath]}
for (const [name, operation] of Object.entries(globalThis.operations)) {
  globalThis.operations[name] = (ctx, input) => {
    if (ctx.caller.kind === "automation") ctx.refuse("not_for_automations", "This operation does not run for automations.");
    if (input.limit === 1) ctx.refuse("one_record", "This read lists records; it does not find one.");
    return operation(ctx, input);
  };
}
`;

  const SETTLE = id(14), HOLD = id(15), RELEASE = id(16);

  const ACTION_DESCRIPTOR = JSON.stringify({ ...definition, operations: [...definition.operations,
    { operationId: SETTLE, name: "invoices.settle", label: "Settle", tableId: TABLE, kind: "action", access: "owner", readOnly: false, fieldIds: [STATUS] },
    // Hold puts an invoice on hold, and Release puts back the status it had.
    { operationId: HOLD, name: "invoices.hold", label: "Hold", tableId: TABLE, kind: "action", access: "owner", readOnly: false, fieldIds: [STATUS], reversedBy: "invoices.release" },
    { operationId: RELEASE, name: "invoices.release", label: "Release", tableId: TABLE, kind: "action", access: "owner", readOnly: false, fieldIds: [STATUS] },
  ] }, null, 2) + "\n";

  const ACTION_OPERATIONS = `${files[definition.operationsPath]}
globalThis.operations["invoices.settle"] = (ctx, input) => {
  if (ctx.caller.kind !== "automation") ctx.refuse("automations_only", "Only an automation settles an invoice.");
  const changed = ctx.db.execute('UPDATE invoices SET status=?, "_record_version"="_record_version"+1 WHERE id=?', ["Settled by " + ctx.caller.automationId + ": " + input.note, input.id]);
  if (changed.changes !== 1) ctx.refuse("not_found", "This invoice is gone.");
  return { id: input.id };
};
globalThis.operations["invoices.hold"] = (ctx, input) => {
  const [row] = ctx.db.query("SELECT status FROM invoices WHERE id=?", [input.id]);
  if (!row) ctx.refuse("not_found", "This invoice is gone.");
  ctx.db.execute('UPDATE invoices SET status=?, "_record_version"="_record_version"+1 WHERE id=?', ["On hold", input.id]);
  return { undo: { id: input.id, status: row.status } };
};
globalThis.operations["invoices.release"] = (ctx, input) => {
  const [row] = ctx.db.query("SELECT status FROM invoices WHERE id=?", [input.id]);
  if (!row || row.status !== "On hold") ctx.refuse("changed", "This invoice is no longer on hold.");
  ctx.db.execute('UPDATE invoices SET status=?, "_record_version"="_record_version"+1 WHERE id=?', [input.status, input.id]);
  return { id: input.id };
};
`;

  const HELPER_ACTION_DESCRIPTOR = JSON.stringify({ ...JSON.parse(ACTION_DESCRIPTOR) as DatasetDefinition,
    operations: (JSON.parse(ACTION_DESCRIPTOR) as DatasetDefinition).operations.map(operation => operation.operationId === SETTLE ? { ...operation, access: "helper" } : operation) });

  async function sharedButtonWorld(steps: string, options: Parameters<typeof world>[0] = {}) {
    const f = await world({ documents: true, ...options });
    await mkdir(join(f.root, "Log"), { recursive: true });
    await writeFile(join(f.root, "Log/collection.yaml"), "fields:\n  Send:\n    type: button\n  Status:\n    type: text\n");
    const text = `version: 1\nautomations:\n  - id: send\n    name: Send\n    when: {button: Send}\n    do:\n${steps}\n`;
    await writeFile(join(f.root, "Log/automations.yaml"), text);
    f.documents.set("source", { id: "source", path: "Log/source.md", status: "Source" });
    await f.executor.open();
    const parsed = parseAutomationsFile(text);
    const entry = parsed.status === "read" ? parsed.entries[0] : null;
    if (entry?.status !== "valid") throw Error("Invalid fixture automation");
    const input = { automationId: "collection:Log#send", collectionPath: "Log", definitionHash: definitionHash(entry.automation),
      recordId: "source", confirmed: [], pressId: "relay-named", pressedBy: "user-recipient" };
    f.registerPress(input);
    return Object.assign(f, { input });
  }

  async function world(options: { documents?: boolean; roster?: ReachRoster; hostOpen?: boolean; evaluator?: AutomationFormulaEvaluator; groups?: boolean; mayRetryPress?: boolean; storeFails?: boolean; operations?: string; descriptor?: string;
    agentRun?: () => LocalDatasetAgent | null;
    onMessage?: (message: AutomationChatMessage) => Promise<void>;
    onFailure?: (report: AutomationFailureReport) => Promise<void>;
    documentCollection?: string;
    /** Every source file of the dataset, in place of the default ones. */
    sources?: Record<string, string>;
    /** Runs once, after the first automation invocation commits and before its run hears back, as a crash there would. */
    afterInvoke?: () => Promise<void> } = {}) {
    // Runs once, after the next invocation of an operation as the owner commits and before its caller hears back.
    let afterOwnerInvoke: { operationId: string; then: () => Promise<void> } | undefined;
    const root = await createTestScratch("dohc-dataset-automations-");
    for (const [path, text] of Object.entries(options.sources ?? files)) {
      await mkdir(join(root, dirname(path)), { recursive: true });
      const given = path === definition.operationsPath ? options.operations : path === "Budget/dataset.json" ? options.descriptor : undefined;
      await writeFile(join(root, path), given ?? text);
    }
    const writeAutomations = (body: string) => writeFile(join(root, "Budget", "automations.yaml"), `version: 1\nautomations:\n${body}`);
    await writeAutomations(closePaid());
  
    let executor: CollectionAutomations | undefined;
    const waiters = new Set<() => void>();
    const wake = () => { for (const waiter of [...waiters]) waiter(); };
    // Checks run on every wake without waiting for the last one; the test waits for them all before its host closes.
    const checking = new Set<Promise<void>>();
    const until = (condition: () => boolean | Promise<boolean>) => new Promise<void>((resolve, reject) => {
      const check = () => {
        const run = (async () => {
          if (!waiters.has(check)) return;
          try {
            if (await condition()) { waiters.delete(check); resolve(); }
          } catch (error) {
            if (waiters.delete(check)) reject(error);
          }
        })();
        checking.add(run);
        void run.finally(() => checking.delete(run));
      };
      waiters.add(check);
      check();
    });
    const settledChecks = async () => { while (checking.size > 0) await Promise.all([...checking]); };
    // Workers and exports live in .dohc/local, which an engine open prepares.
    await openedLocalState({ workspaceId: "workspace", rootPath: root });
    const host = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId: "workspace", workspaceRoot: root, capacityBytes: 4 * 1024 * 1024,
      compile: compileFixture,
      agentRun: options.agentRun,
      onAutomationClaims: (failed) => { executor?.notifyClaimed(); if (failed) executor?.failuresChanged(); wake(); },
      onDatasetsChanged: () => executor?.datasetsChanged() });
    hosts.push(host);
    drains.push(settledChecks);
    const blobs = new Map<string, Uint8Array>();
    const adapter = new VersionedLiveAdapter({ close() {}, async sendRequest(request) {
      const params = request.params as Record<string, unknown>;
      if (request.method === "versionedText.captureSources") {
        const selected = await Promise.all([...params.paths as string[]].sort().map(async (path) => {
          const bytes = await readFile(join(root, path)), digest = sha256(bytes); blobs.set(digest, bytes);
          return { path, objectId: path, contentKind: "text", sha256: digest, byteLength: bytes.byteLength, latestMomentId: "m" };
        }));
        return { id: request.id, result: { workspaceId: "workspace", versionId: "main", files: selected, totalBytes: selected.reduce((sum, file) => sum + file.byteLength, 0),
          sourceDigest: sha256(JSON.stringify(["dohc-source-capture-v1", "workspace", "main", selected])) } };
      }
      const bytes = blobs.get(String(params.sha256))!;
      return { id: request.id, result: { bytesBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength } };
    } }, "owner", { workspaceId: "workspace" });
    const prepared = await host.prepare({ descriptorPath: "Budget/dataset.json", adapter });
    const approved = await host.approve({ preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256 });
    const rules = { datasetId: definition.datasetId, revision: approved.revision, revisionSha256: approved.revisionSha256 };
    let keys = 0;
    // The owner's own edits, as the Collection page makes them.
    const create = async (values: Record<string, JsonValue>) => {
      const result = await host.action({ ...rules, operationId: CREATE, input: { values }, idempotencyKey: `owner-${keys++}` });
      return result.result as { id: string; version: number };
    };
    const edit = async (recordId: string, values: Record<string, JsonValue>) => {
      const current = await record(recordId);
      await host.action({ ...rules, operationId: EDIT, input: { id: recordId, expectedVersion: current!.version, values }, idempotencyKey: `owner-${keys++}` });
    };
    const record = async (recordId: string) => {
      for (let after: JsonValue = null; ;) {
        const page = (await host.query({ ...rules, operationId: LIST, input: after === null ? { limit: 100 } : { limit: 100, after }, idempotencyKey: "read" })).result as
          { rows: Array<{ id: string; version: number; values: Record<string, JsonValue> }>; nextCursor: JsonValue };
        const found = page.rows.find((row) => row.id === recordId);
        if (found) return found;
        if (page.nextCursor === null) return null;
        after = page.nextCursor;
      }
    };
    const records = async () => ((await host.query({ ...rules, operationId: LIST, input: { limit: 100 }, idempotencyKey: "read" })).result as
      { rows: Array<{ id: string; version: number; values: Record<string, JsonValue> }> }).rows;
  
    const documents = new Map<string, { id: string; path: string; status: string }>();
    const authorities = new Map<string, RelayButtonAuthority>();
    let authorityAvailable = true;
    const resolveAuthority = async (id: string) => {
      if (!authorityAvailable) throw new AutomationRunWait(SHARED_BUTTON_UNCHECKED, "roster");
      const held = authorities.get(id);
      if (!held) throw new Error(SHARED_BUTTON_DENIED);
      return held;
    };
    let documentPath = "Log";
    // Group subscriptions the executor asks the engine for.
    const subscribed: unknown[] = [];
    // The Group subscriptions the executor last asked the engine to watch.
    const watched: unknown[] = [];
    // Claims the engine holds for this Collection's automations, as a schedule or a Group message makes them.
    const engineClaims: AutomationClaim[] = [];
    const engineFailures: Array<Omit<AutomationFailure, "datasetInstance" | "neverStarted">> = [];
    const engineRetries: string[] = [];
    let engineReadable = true;
    // How many claims the engine has served.
    let served = 0;
    const engine = {
      pressAutomation: async ({ pressId, automationId, recordId, pressedBy }: { pressId: string; automationId: string; recordId: string; pressedBy: string }) => {
        const previous = engineClaims.find(claim => "key" in claim.trigger && claim.trigger.key === `press:${pressId}`);
        if (previous) return { busy: false, claim: previous };
        const claim: AutomationClaim = { claimId: `claim-${engineClaims.length}`, automationId, recordId, collectionPath: null,
          trigger: { key: `press:${pressId}` }, depth: 0, state: "pending", attempts: 0, run: 1, createdAtMs: Date.now(), updatedAtMs: 0,
          change: { kind: "button", authorOriginId: null, actorKind: "human", onBehalfOf: pressedBy, sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 } };
        engineClaims.push(claim);
        return { busy: false, claim };
      },
      listCollections: async () => ({ collections: [
        ...(options.documents ? [{ objectId: "Log", path: documentPath, status: "valid", reasons: [] }] : []),
        ...(options.documentCollection ? [{ path: options.documentCollection, objectId: options.documentCollection, status: "valid", reasons: [] }] : []),
      ] }),
      getCollectionRecord: async ({ collectionPath, recordId }: { collectionPath: string; recordId: string }) => {
        const record = documents.get(recordId);
        if (collectionPath !== documentPath || record === undefined) throw new Error("collection-record-not-found");
        return { collection: { path: documentPath, status: "valid", reasons: [] }, record: { id: record.id, path: record.path, conflicted: false, values: [{ field: "Status", value: record.status, validation: { status: "untyped" }, resolvedRelations: [] }] }, history: [], nextBeforeHistoryId: null };
      },
      subscribeAutomation: async (input: unknown) => { subscribed.push(input); },
      releaseAutomationGroups: async () => ({ watchedGeneration: 0, handover: { floorMs: 0, automations: [] } }),
      watchAutomationGroups: async (input: { subscriptions: unknown[] }) => { watched.splice(0, watched.length, ...input.subscriptions); return { needsHandover: false }; },
      // Serves the oldest pending claim, as the engine drains its queue.
      makeAutomationWritesDurable: async () => {},
      claimNextAutomation: async () => {
        const next = engineClaims.filter((claim) => claim.state === "pending").sort((left, right) => left.createdAtMs - right.createdAtMs)[0];
        if (next === undefined) return null;
        served += 1;
        Object.assign(next, { state: "running", attempts: next.attempts + 1 });
        return structuredClone(next);
      },
      settleAutomationClaim: async ({ claimId, state, error }: { claimId: string; state: "done" | "failed"; error?: string }) => {
        Object.assign(engineClaims.find((claim) => claim.claimId === claimId)!, { state, updatedAtMs: Date.now(), ...(error === undefined ? {} : { error }) });
        wake();
      },
      releaseAutomationClaim: async ({ claimId }: { claimId: string }) => {
        const claim = engineClaims.find((candidate) => candidate.claimId === claimId)!;
        Object.assign(claim, { state: "pending", attempts: claim.attempts - 1 });
        wake();
      },
      // Pages as the engine does: newest first by when each claim was made, then by id.
      listAutomationClaims: async ({ automationId, before, limit = 20 }: { automationId: string; before?: string; limit?: number }) => {
        if (!engineReadable) throw new Error("The engine could not read its claims.");
        const [atMs, id] = before === undefined ? [Infinity, ""] : [Number(before.slice(0, before.indexOf(":"))), before.slice(before.indexOf(":") + 1)];
        const listed = engineClaims
          .filter((claim) => claim.automationId === automationId && (claim.createdAtMs < atMs || (claim.createdAtMs === atMs && claim.claimId < id)))
          .sort((left, right) => right.createdAtMs - left.createdAtMs || (left.claimId < right.claimId ? 1 : -1));
        const last = listed[limit - 1];
        return { claims: listed.slice(0, limit), next: listed.length > limit && last ? `${last.createdAtMs}:${last.claimId}` : null };
      },
      getAutomationClaim: async (input: { claimId: string } | { automationId: string; key: string }) => {
        const claim = [...engineClaims].find((candidate) => "claimId" in input
          ? candidate.claimId === input.claimId
          : candidate.automationId === input.automationId && "key" in candidate.trigger && candidate.trigger.key === input.key);
        return { claim: claim ?? null };
      },
      pruneAutomationHistory: async () => ({ pruned: 0, more: false }),
      listAutomationFailures: async () => ({ failures: engineFailures }),
      retryAutomationClaim: async ({ claimId }: { claimId: string }) => {
        engineRetries.push(claimId);
        const claim = engineClaims.find((candidate) => candidate.claimId === claimId)!;
        Object.assign(claim, { state: "pending", run: claim.run + 1 });
        return claim;
      },
      readAutomationGroupSkips: async () => ({ aheadAtMs: null, lateAtMs: null }),
    } as unknown as CollectionAutomationEngine;
    let roster = options.roster ?? OWNER;
    let afterInvoke = options.afterInvoke;
    let hostOpen = options.hostOpen ?? true;
    let metadataFailure: "unavailable" | "generated" | "grants" | null = null;
    let listedForFailure = false;
    // Rules the executor sees in place of the approved ones, as after a schema change it indexes.
    let indexed: DatasetDefinition | null = null;
    // Whether saved rules still resolve, as before an approved change that drops them.
    let rulesResolve = true;
    // Whether opening the dataset store fails, as when another process holds it.
    let storeFails = options.storeFails ?? false;
    // Each pass over the saved runs that reached their end.
    let expiries = 0;
    // Why the host takes no press, as after the dataset moved to a server; the runtime tests fence a real journal.
    let unpressable: string | null = null;
    const opened: boolean[] = [];
    const errors: Array<{ context: string; error: unknown }> = [];
    let automationsChanged = 0;
    // What the pressing window hears.
    const settled: PressSettled[] = [];
    const waiting: Array<{ claimId: string; reason: PressWaitReason }> = [];
    // What automations post and notify.
    const messages: AutomationChatMessage[] = [];
    const notices: AutomationNotice[] = [];
    const failureReports: AutomationFailureReport[] = [];
    // Runs once after the next run is saved, as when its plan is on disk.
    let afterSave: (() => void) | null = null;
    const store = ((): AutomationRunStore => {
      const base = createAutomationRunStore(preparedAutomationStoreFolder(root));
      return {
        ...base,
        save: async (run) => {
          await base.save(run);
          const hook = afterSave;
          afterSave = null;
          hook?.();
        },
        expire: async (now, standing, from) => {
          const next = await base.expire(now, standing, from);
          if (next === null) {
            expiries += 1;
            wake();
          }
          return next;
        },
      };
    })();
    const withRecordWrites: ConstructorParameters<typeof CollectionAutomations>[0]["withRecordWrites"] = async (_signal, work) => {
        if (!options.documents) throw new Error("Dataset runs write through their own operations.");
        return work({
          create: async ({ recordId, collectionPath, name }) => {
            if (collectionPath !== documentPath) throw new Error("Wrong Collection.");
            documents.set(recordId, { id: recordId, path: documentPath + "/" + name + ".md", status: "" });
            return { recordId, path: documents.get(recordId)!.path };
          },
          setFields: async ({ recordPath, fields, expectedBefore }) => {
            const record = [...documents.values()].find((record) => record.path === recordPath)!;
            const before = record.status;
            if (expectedBefore !== undefined && expectedBefore.Status !== (before || null)) {
              return { replaced: {}, kept: { Status: before || null } };
            }
            record.status = String(fields.Status);
            return { replaced: { Status: before || null }, kept: {} };
          },
        });
      };
    const readText = vi.fn(async (path: string) => {
      try {
        const text = await readFile(join(root, path), "utf8");
        return { text, truncated: false as const, contentHash: sha256(text) };
      } catch { return null; }
    });
    const makeExecutor = (extra: Partial<CollectionAutomationsOptions> = {}) => executor = new CollectionAutomations({
      resolveRelayedPress: resolveAuthority,
      resolveButtonInspection: async (id) => {
        const authority = await resolveAuthority(id);
        // Inspection resolves the authored id; the stored press keeps its Collection-bound id.
        return { ...authority, automationId: authority.automationId.slice(authority.automationId.indexOf("#") + 1) };
      },
      personName: (userId) => `Person ${userId}`,
      localPersonId: () => "user-ana",
      mayRetryPress: async () => options.mayRetryPress ?? false,
      onPressSettled: (event) => { settled.push(event); wake(); },
      onPressWaiting: (event) => { waiting.push(event); wake(); },
      groupHost: async () => (options.groups ? 0 : null),
      groupRelayRecord: async () => ({ generation: 0, handover: null }),
      reachRelayRecord: async () => ({ generation: 0, reach: null, everShared: false }),
      groupMessagesSkipped: async () => undefined,
      requestHost: async () => undefined,
      readMessageBody: async () => { throw new Error("These test messages carry their whole body."); },
      postNotice: async (notice) => { notices.push(notice); wake(); },
      chat: { hasMessage: async () => false,
        directory: async (current) => chatDirectoryOf([TEAM], current),
        write: async (_signal, message) => { await options.onMessage?.(message); messages.push(message); wake(); },
      },
      withEngine: async (work) => await work(engine),
      withRecordWrites,
      withUndoWrites: withRecordWrites,
      readText,
      writeText: async () => ({ status: "conflict" }),
      pathExists: (path) => stat(join(root, path)).then(() => true, () => false),
      roster: async () => roster,
      cachedRoster: async () => roster,
      evaluator: options.evaluator ?? sharedEvaluator.forWorkspace("workspace"),
      // A saved record of which failures have notices wakes the test, which can wait for it.
      store: { ...store, saveReportedFailures: async (reported) => { await store.saveReportedFailures(reported); wake(); } },
      onRunsChanged: wake,
      reportFailure: async (report) => { await options.onFailure?.(report); failureReports.push(report); wake(); },
      withdrawFailure: async () => undefined,
      onSwitchedOff: () => undefined,
      onHoldsChanged: () => undefined,
      onAutomationsChanged: () => { automationsChanged += 1; wake(); },
      onError: (context, error) => { errors.push({ context, error }); wake(); },
      withDatasetHost: async (work, open) => {
        opened.push(open);
        if (!hostOpen && !open) return null;
        if (!hostOpen && storeFails) throw new Error("The dataset store is in use by another process.");
        // As in main, an opened host serves the executor until it closes.
        hostOpen = true;
        const override = indexed;
        const current = override === null ? host.automations : { ...host.automations,
          datasets: () => ({ definitions: [override], failures: [] as Array<{ datasetId: string; error: unknown }> }),
          revision: (datasetId: string) => ({ ...host.automations.revision(datasetId), definition: override }) };
        if (metadataFailure !== null) {
          if (!listedForFailure) return await work({ ...current, datasets: () => {
            const listed = current.datasets();
            listedForFailure = true;
            return listed;
          } });
          const failure = metadataFailure;
          metadataFailure = null;
          listedForFailure = false;
          if (failure === "unavailable") return null;
          const fail = () => { throw new Error(`Cannot read ${failure}`); };
          return await work({ ...current, ...(failure === "generated" ? { generated: fail } : { dataGrants: fail }) });
        }
        const resolving = rulesResolve ? current : { ...current, resolves: () => false };
        const moved = unpressable;
        const pressable = moved === null ? resolving : { ...resolving, assertPressable: () => { throw new Error(moved); } };
        const after = afterInvoke;
        const invoking = after === undefined ? pressable : { ...pressable, invoke: async (...args: Parameters<typeof pressable.invoke>) => {
          const result = await pressable.invoke(...args);
          afterInvoke = undefined;
          await after();
          return result;
        } };
        const afterOwner = afterOwnerInvoke;
        const automations = afterOwner === undefined ? invoking : { ...invoking, invokeAsOwner: async (...args: Parameters<typeof invoking.invokeAsOwner>) => {
          const result = await invoking.invokeAsOwner(...args);
          if (args[0].operationId !== afterOwner.operationId) return result;
          afterOwnerInvoke = undefined;
          await afterOwner.then();
          return result;
        } };
        const result = await work(automations);
        wake();
        return result;
      },
      ...extra,
    });
    makeExecutor();
    return {
      authorities, readText,
      setAuthorityAvailable: (available: boolean) => { authorityAvailable = available; },
      registerPress: (input: Parameters<CollectionAutomations["pressRelayed"]>[0]) => {
        authorities.set(input.pressId, { workspaceId: "workspace", userId: input.pressedBy, grantId: "g-recipient", grantGeneration: 1, hostGeneration: 1,
          automationId: input.automationId, collectionPath: input.collectionPath, definitionHash: input.definitionHash, recordId: input.recordId,
          confirmed: [...(input.confirmed ?? [])].sort(), principals: [{ grantId: "g-recipient", userId: input.pressedBy, access: "edit" }] });
      },
      host, root, adapter, documents, rules, approved, create, edit, record, records, until, errors, opened, subscribed, watched, writeAutomations, makeExecutor, settled, waiting, messages, notices, failureReports,
      expiries: () => expiries,
      engineClaims, engineFailures, engineRetries, setEngineReadable: (readable: boolean) => { engineReadable = readable; },
      served: () => served,
      get executor() { return executor!; },
      claims: () => host.automations.claims(AUTOMATION).claims,
      automationsChanged: () => automationsChanged,
      setRoster: (next: ReachRoster) => { roster = next; },
      crashAfterOwnerInvoke: (operationId: string) => { afterOwnerInvoke = { operationId, then: async () => { throw new Error("dohc stopped."); } }; },
      /** Gives a person the data grant on these operations, as the share dialog would. */
      grant: (grantId: string, userId: string, operationIds: string[], reference = rules) => {
        const store = new DatabaseSync(join(root, ".dohc", "local", "datasets", "state.sqlite"));
        try {
          store.prepare("INSERT OR REPLACE INTO dohc_dataset_data_grants VALUES(?,?,?,?,?)").run("workspace", reference.datasetId, datasetPrincipalKey("workspace", grantId, userId),
            JSON.stringify({ operationIds, discover: true, revision: reference.revision, revisionSha256: reference.revisionSha256 }), "token");
        } finally {
          store.close();
        }
      },
      openHost: () => { hostOpen = true; executor!.datasetsChanged(); },
      changeRules: (next: DatasetDefinition) => { indexed = next; executor!.datasetsChanged(); },
      dropRules: () => { rulesResolve = false; },
      keepRules: () => { rulesResolve = true; },
      fixStore: () => { storeFails = false; },
      failStore: () => { hostOpen = false; storeFails = true; },
      failNextMetadata: (failure: NonNullable<typeof metadataFailure>) => { metadataFailure = failure; },
      afterNextSave: (hook: () => void) => { afterSave = hook; },
      moveDocuments: async (path: string) => {
        await rename(join(root, documentPath), join(root, path));
        for (const record of documents.values()) record.path = path + record.path.slice(documentPath.length);
        documentPath = path;
      },
      moveToServer: () => { unpressable = "This Collection moved to a server, so its buttons can't run here."; },
    };
  }

  function engineClaim(claimId: string, state: AutomationClaim["state"], createdAtMs: number, automationId = AUTOMATION): AutomationClaim {
    return {
      claimId, automationId, trigger: { key: `schedule:${createdAtMs}` }, recordId: null,
      collectionPath: null, depth: 0,
      state, attempts: state === "pending" ? 0 : 1, run: 1, createdAtMs, updatedAtMs: createdAtMs, ...(state === "failed" ? { error: "Not yet." } : {}),
      change: { kind: "schedule", authorOriginId: null, actorKind: null, onBehalfOf: null, sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 },
    };
  }

  async function authoredDestination(f: Awaited<ReturnType<typeof world>>) {
    const destination: DatasetDefinition = { ...JSON.parse(ACTION_DESCRIPTOR) as DatasetDefinition, datasetId: id(200), name: "Other",
      schemaPath: "Other/schema.sql", operationsPath: "Other/operations.js" };
    const sources = { "Other/dataset.json": JSON.stringify(destination), "Other/schema.sql": files[definition.schemaPath]!, "Other/operations.js": ACTION_OPERATIONS };
    for (const [path, text] of Object.entries(sources)) {
      await mkdir(dirname(join(f.root, path)), { recursive: true });
      await writeFile(join(f.root, path), text);
    }
    const prepared = await f.host.prepare({ descriptorPath: "Other/dataset.json", adapter: f.adapter });
    const approved = await f.host.approve({ preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256 });
    const rules = { datasetId: destination.datasetId, revision: approved.revision, revisionSha256: approved.revisionSha256 };
    const created = await f.host.action({ ...rules, operationId: CREATE, input: { values: { [STATUS]: "Original" } }, idempotencyKey: "seed-other" });
    const record = created.result as { id: string };
    return { rules, record, rows: () => f.host.query({ ...rules, operationId: LIST, input: { limit: 50 }, idempotencyKey: "check-other" }) };
  }

  return { id, OWNER, UNKNOWN, BUDGET, AUTOMATION, TABLE, PAID, STATUS, NOTES, FINISHED, MARK_PAID, LIST, CREATE, EDIT, STATUS_ONLY, REMOVE, definition, files, closePaid, sharedEvaluator, AUTHORED_OPERATIONS, SETTLE, HOLD, RELEASE, ACTION_DESCRIPTOR, ACTION_OPERATIONS, HELPER_ACTION_DESCRIPTOR, sharedButtonWorld, world, engineClaim, authoredDestination };
}
