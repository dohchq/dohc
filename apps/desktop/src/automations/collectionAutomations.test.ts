import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { AutomationEvaluator } from "@dohc/app-backend-runtime/automation";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import type { CollectionQueryFilter, CollectionRecord } from "@dohc/workspace-contracts/collection";
import type { AutomationClaim, ChangeAttributionWire } from "@dohc/workspace-engine-client";
import { derivedRecordId, type CollectionRecordEditContext } from "../workspaces/collectionRecordEdits";
import type { WorkspaceEngineYDocProviderSession } from "../workspaces/workspaceEngineCapture";
import { createTestScratch } from "../workspaces/testTemp";
import { createAutomationFormulaEvaluator, type AutomationFormulaEvaluator } from "./automationEvaluatorHost";
import { definitionHash, localIsoTime, stepKey } from "./automationPlan";
import type { ReachRoster, RosterGrant } from "./automationReach";
import { createAutomationRunStore, type AutomationRunStore } from "./automationRunStore";
import { CollectionAutomations, TIMEOUTS_BEFORE_SWITCH_OFF, UNREADABLE_REACH, type CollectionAutomationEngine } from "./collectionAutomations";
import { DEADLINE_ERROR, DEFINITION_CHANGED_ERROR, UNDONE_RUN_ERROR, UNREADABLE_RUN_ERROR } from "./collectionAutomationRun";

type RecordChange = Exclude<AutomationClaim["change"], { kind: "message" }>;

// The executor against an in-memory engine and record store: claims, record
// documents with the engine's idempotency rule, and files adopted as records.
// Formulas run in the real evaluator.

const sharedEvaluator = createAutomationFormulaEvaluator();
afterAll(() => sharedEvaluator.close());
const evaluator = sharedEvaluator.forWorkspace("workspace");

const OWNER: ReachRoster = { kind: "owner", ownerUserId: "user-owner", grants: [] };
const editor = (email: string, paths: string[]): RosterGrant => ({
  recipientUserId: `user-${email}`, recipientEmail: email,
  files: { paths, versionId: null, access: "edit" }, channel: null,
});

interface FakeRecord { id: string; path: string; collection: string; doc: Y.Doc }

// Every field these tests name. A field a Collection lacks keeps its
// automation off, so each test Collection defines them all.
const FIELDS = [
  "Status", "Count", "Note", "Title", "Mark", "X", "Seen", "Amount", "Points", "Swept", "Checked",
  "Project", "Finished on", "A", "B", "C", "D", "E", "Details",
];
const SCHEMA = `fields:\n${FIELDS.map((field) => `  ${field}:\n    type: text\n`).join("")}`;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function world(options: {
  collections?: string[];
  automations: Record<string, string>;
  evaluator?: AutomationFormulaEvaluator;
  deadline?: (abort: () => void) => () => void;
  withRecordWrites?: (signal: AbortSignal, events: string[]) => Promise<void>;
  /** The engine gives no answer to settles until this is set false. */
  unanswered?: { settle: boolean };
  /** The engine refuses the next settle this many times: its recovery took the claim back. */
  refused?: { settle: number; stillRunning?: boolean };
}) {
  const root = await createTestScratch("dohc-collection-automations-");
  const collections = options.collections ?? ["Tasks"];
  for (const collection of collections) {
    await mkdir(join(root, collection), { recursive: true });
    await writeFile(join(root, collection, "collection.yaml"), SCHEMA);
  }
  const writeAutomations = async (collection: string, body: string) =>
    await writeFile(join(root, collection, "automations.yaml"), `version: 1\nautomations:\n${body}`);
  for (const [collection, body] of Object.entries(options.automations)) await writeAutomations(collection, body);

  const records = new Map<string, FakeRecord>();
  const journal = new Map<string, string>();
  const journaled: Array<{ path: string; field?: string; idempotencyKey?: string; actorOriginId?: string; attribution?: ChangeAttributionWire }> = [];
  const authored: Array<{ path: string; author: unknown }> = [];
  const claims = new Map<string, AutomationClaim>();
  const pending: AutomationClaim[] = [];
  const subscriptions = new Map<string, unknown>();
  const settleListeners = new Set<(paths: readonly string[] | null) => void>();
  const waiters = new Set<() => void>();
  const events: string[] = [];
  let idleDrains = 0;
  // Each count fails that many of the next calls.
  const failures = { authoredWrite: 0, openSession: 0 };
  // Fails the one record session opened this many calls from now.
  let opens = 0;
  let failOpenAt: number | null = null;
  let holdsChanged = 0;
  let automationsChanged = 0;
  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  const until = (condition: () => boolean) => new Promise<void>((resolve) => {
    const check = () => { if (condition()) { waiters.delete(check); resolve(); } };
    waiters.add(check);
    check();
  });

  const fieldsOf = (record: FakeRecord) => record.doc.getMap("frontmatter").toJSON() as Record<string, unknown>;
  const collectionRecord = (record: FakeRecord): CollectionRecord => ({
    id: record.id, path: record.path, conflicted: false,
    values: Object.entries(fieldsOf(record)).map(([field, value]) => ({
      field, value: value as CollectionRecord["values"][number]["value"], validation: { status: "valid" }, resolvedRelations: [],
    })),
  });
  const matches = (record: FakeRecord, filter: CollectionQueryFilter | undefined) => {
    if (!filter) return true;
    const value = fieldsOf(record)[filter.field];
    return filter.operator === "equals"
      ? JSON.stringify(value) === JSON.stringify(filter.value)
      : Array.isArray(value) ? value.includes(filter.value) : String(value ?? "").includes(String(filter.value));
  };
  const addRecord = (collection: string, name: string, fields: Record<string, unknown>) => {
    const id = `rec_${createHash("sha256").update(`${collection}/${name}`).digest("hex").slice(0, 26).replace(/[01890]/g, "a")}`;
    const doc = new Y.Doc();
    for (const [field, value] of Object.entries(fields)) doc.getMap("frontmatter").set(field, value);
    const record = { id, path: `${collection}/${name}.md`, collection, doc };
    records.set(id, record);
    return record;
  };

  const engine: CollectionAutomationEngine = {
    listCollections: async () => ({ collections: collections.map((path) => ({ path, status: "valid", reasons: [] })) }),
    getCollectionRecord: async ({ collectionPath, recordId }) => {
      const record = records.get(recordId);
      if (!record || record.collection !== collectionPath) throw new Error("collection-record-not-found");
      return { collection: { path: collectionPath, status: "valid", reasons: [] }, record: collectionRecord(record), history: [], nextBeforeHistoryId: null };
    },
    queryCollectionRecords: async ({ collectionPath, filter, limit }) => ({
      collection: { path: collectionPath, status: "valid", reasons: [] },
      records: [...records.values()].filter((record) => record.collection === collectionPath && matches(record, filter))
        .slice(0, limit).map(collectionRecord),
      groups: null, nextCursor: null,
    }),
    subscribeAutomation: async (input) => { subscriptions.set(input.automationId, input); return { subscribed: true }; },
    unsubscribeAutomation: async ({ automationId }) => { subscriptions.delete(automationId); return { unsubscribed: true }; },
    claimNextAutomation: async () => {
      const claim = pending.shift() ?? null;
      if (claim) { claim.state = "running"; claim.attempts += 1; } else { idleDrains += 1; wake(); }
      return claim ? structuredClone(claim) : null;
    },
    settleAutomationClaim: async ({ claimId, state, error }) => {
      // The desktop's own words when the engine is down, which read like a refusal and are not one.
      if (options.unanswered?.settle) throw new Error("The workspace engine is not running.");
      if (options.refused && options.refused.settle > 0) {
        options.refused.settle -= 1;
        const claim = claims.get(claimId)!;
        if (!options.refused.stillRunning) {
          claim.state = "pending";
          pending.push(claim);
        }
        throw Object.assign(new Error("invalid-input"), { wireError: { code: "INVALID_PARAMS", message: "invalid-input" } });
      }
      const claim = claims.get(claimId)!;
      claim.state = state;
      claim.updatedAtMs = ++updates;
      if (error === undefined) delete claim.error; else claim.error = error;
      events.push(`settled ${state}`);
      wake();
      return claim;
    },
    retryAutomationClaim: async ({ claimId }) => {
      const claim = claims.get(claimId)!;
      if (claim.state !== "failed") throw new Error("automation-claim-not-failed");
      claim.state = "pending"; claim.run += 1; delete claim.error;
      pending.push(claim);
      return claim;
    },
    listAutomationClaims: async ({ automationId }) => ({ claims: [...claims.values()].filter((claim) => claim.automationId === automationId).reverse() }),
    // Each automation's failure most recently settled, as the failure notice shows it.
    listAutomationFailures: async () => {
      const newest = new Map<string, AutomationClaim>();
      for (const claim of claims.values()) {
        const known = newest.get(claim.automationId);
        if (claim.state === "failed" && (!known || claim.updatedAtMs > known.updatedAtMs)) newest.set(claim.automationId, claim);
      }
      return { failures: [...newest.values()].map(({ automationId, claimId }) => ({ automationId, claimId })) };
    },
    releaseAutomationClaim: async ({ claimId }) => {
      const claim = claims.get(claimId)!;
      if (claim.state !== "running") throw new Error("Automation claim is not running.");
      claim.state = "pending"; claim.attempts -= 1;
      pending.push(claim);
      events.push(`released ${claimId}`);
      wake();
      return claim;
    },
  };

  const capture: CollectionRecordEditContext["capture"] = {
    async openYDocSession({ path }) {
      opens += 1;
      if (failures.openSession > 0 || opens === failOpenAt) {
        failures.openSession = Math.max(0, failures.openSession - 1);
        throw new Error("The record is open in a live session elsewhere.");
      }
      const record = [...records.values()].find((candidate) => candidate.path === path);
      if (!record) throw new Error(`No record at ${path}.`);
      const session = {
        get initialUpdate() { return Y.encodeStateAsUpdate(record.doc); },
        async applyDecidedLocalUpdate(decide: (doc: Y.Doc) => Uint8Array | null, armed?: () => void, applyOptions?: { idempotencyKey?: string; actorOriginId?: string; attribution?: ChangeAttributionWire }) {
          const update = decide(record.doc);
          if (update === null) return false;
          session.applyLocalUpdate(update, armed, applyOptions);
          return true;
        },
        applyLocalUpdate(update: Uint8Array, armed?: () => void, applyOptions?: { idempotencyKey?: string; actorOriginId?: string; attribution?: ChangeAttributionWire }) {
          const key = applyOptions?.idempotencyKey;
          const bytes = Buffer.from(update).toString("base64");
          if (key !== undefined && journal.has(key)) {
            // The engine's rule: the same key with other bytes is refused.
            if (journal.get(key) !== bytes) throw new Error("idempotency key reused with different content");
            armed?.();
            return;
          }
          if (key !== undefined) journal.set(key, bytes);
          Y.applyUpdate(record.doc, update);
          journaled.push({ path, ...applyOptions });
          armed?.();
        },
        async settleNow() { return { materialized: true }; },
        async close() {},
      };
      return session as unknown as WorkspaceEngineYDocProviderSession;
    },
    async writeAuthoredTextFile(absolutePath, text, author, writeOptions) {
      if (failures.authoredWrite > 0) {
        failures.authoredWrite -= 1;
        throw new Error("dohc could not write the record file.");
      }
      const path = relative(root, absolutePath).replaceAll("\\", "/");
      authored.push({ path, author });
      await mkdir(dirname(absolutePath), { recursive: true });
      const requested = /id: (rec_[a-z2-7]+)/.exec(text)![1]!;
      // The engine adopts the file under the id its frontmatter names, or a
      // new one it writes into the file when that id is taken.
      const id = occupied.has(requested) ? `rec_${"reminted".padEnd(26, "a")}` : requested;
      await writeFile(absolutePath, text.replace(requested, id), { flag: writeOptions?.createOnly ? "wx" : "w" });
      records.set(id, { id, path, collection: dirname(path).replaceAll("\\", "/"), doc: new Y.Doc() });
      queueMicrotask(() => { for (const listener of settleListeners) listener([path]); });
      return { resolvedAbsolutePath: absolutePath };
    },
  };

  let roster: ReachRoster = OWNER;
  let beforeRoster: (() => Promise<void>) | null = null;
  let rosterCalls = 0;
  let beforeRead: (() => void) | null = null;
  let prunes = 0;
  let updates = 0;
  const resumable: Array<ReadonlySet<string> | null> = [];
  const baseStore = createAutomationRunStore(root);
  let failRecordAt: number | null = null;
  let beforeRecord: (() => void) | null = null;
  // Ids the engine treats as taken, so it adopts a file carrying one under a new id.
  const occupied = new Set<string>();
  let saves = 0;
  let records_ = 0;
  const store: AutomationRunStore = {
    ...baseStore,
    prune: async (automationId, resumableClaims) => {
      resumable.push(await resumableClaims());
      prunes += 1;
      wake();
      await baseStore.prune(automationId, resumableClaims);
    },
    save: async (run) => {
      saves += 1;
      await baseStore.save(run);
    },
    appendEffect: async (run, applied) => {
      records_ += 1;
      if (records_ === failRecordAt) throw new Error("The disk is full.");
      const hook = beforeRecord;
      beforeRecord = null;
      hook?.();
      await baseStore.appendEffect(run, applied);
    },
  };
  const failuresChanged: string[] = [];
  const errors: Array<{ context: string; error: unknown }> = [];
  // A new executor over the same engine, files, and saved runs, as after a restart.
  const makeExecutor = () => new CollectionAutomations({
    withEngine: async (work) => await work(engine),
    withRecordWrites: async (signal, work) => {
      await options.withRecordWrites?.(signal, events);
      return await work({
        capture, workspaceRoot: root, signal,
        withAdapter: async (read) => await read(engine),
        onCaptureSettled: (listener) => { settleListeners.add(listener); return () => settleListeners.delete(listener); },
      });
    },
    readText: async (path) => {
      const hook = beforeRead;
      beforeRead = null;
      hook?.();
      try {
        const text = await readFile(join(root, path), "utf8");
        return { text, truncated: false, contentHash: sha256(text) };
      } catch {
        return null;
      }
    },
    writeText: async (path, text, expectedContentHash) => {
      if (sha256(await readFile(join(root, path), "utf8")) !== expectedContentHash) return { status: "conflict" };
      await writeFile(join(root, path), text);
      return { status: "written" };
    },
    pathExists: (path) => stat(join(root, path)).then(() => true, () => false),
    cachedRoster: async () => roster,
    roster: async () => {
      rosterCalls += 1;
      const current = roster;
      const hook = beforeRoster;
      beforeRoster = null;
      await hook?.();
      return current;
    },
    evaluator: options.evaluator ?? evaluator,
    store,
    onFailuresChanged: () => { failuresChanged.push("changed"); wake(); },
    onHoldsChanged: () => { holdsChanged += 1; wake(); },
    onAutomationsChanged: () => { automationsChanged += 1; wake(); },
    onError: (context, error) => { errors.push({ context, error }); },
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
  });
  const executor = makeExecutor();

  let claimCount = 0;
  const claim = (automationId: string, record: FakeRecord, change: Partial<RecordChange> = {}) => {
    claimCount += 1;
    const created: AutomationClaim = {
      claimId: `atc_claim${claimCount}`, automationId, trigger: { historyId: claimCount },
      recordId: record.id, collectionPath: record.collection, depth: 0,
      change: {
        kind: "changed", authorOriginId: null, actorKind: "human", onBehalfOf: null,
        fields: [{ field: "Status", historyId: claimCount, previous: { value: "Doing" }, next: { value: "Done" } }],
        fieldsOmitted: 0, ...change,
      },
      state: "pending", attempts: 0, run: 1, createdAtMs: Date.UTC(2026, 8, 25, 1, 30), updatedAtMs: 0,
    };
    claims.set(created.claimId, created);
    pending.push(created);
    return created;
  };
  const settledClaim = async (created: AutomationClaim) => {
    await until(() => created.state === "done" || created.state === "failed");
    return created;
  };

  return {
    root, executor, makeExecutor, engine, records, claims, journaled, authored, subscriptions, events, failures, errors, failuresChanged,
    holdsChanged: () => holdsChanged,
    automationsChanged: () => automationsChanged,
    rosterCalls: () => rosterCalls,
    prunes: () => prunes,
    resumable,
    beforeNextRead: (hook: () => void) => { beforeRead = hook; },
    moveRecord: (record: FakeRecord, name: string) => { record.path = `${record.collection}/${name}.md`; },
    addRecord, claim, settledClaim, until, writeAutomations, baseStore,
    requeue: (claim: AutomationClaim) => { pending.push(claim); },
    fieldsOf,
    idleDrains: () => idleDrains,
    setRoster: (next: ReachRoster) => { roster = next; },
    beforeNextRoster: (hook: () => Promise<void>) => { beforeRoster = hook; },
    failRecordAt: (index: number) => { failRecordAt = records_ + index; },
    beforeNextRecord: (hook: () => void) => { beforeRecord = hook; },
    saves: () => saves,
    effectRecords: () => records_,
    occupy: (id: string) => { occupied.add(id); },
    failOpenAt: (index: number) => { failOpenAt = opens + index; },
  };
}

const TASKS = "collection:Tasks#bump";
const BUMP = [
  "  - id: bump",
  "    name: Bump",
  "    when: {field-changed: Status}",
  "    do:",
  "      - set: {Count: '=record.Count + 1'}",
  "      - add-record: {Title: Bumped}",
  "        collection: Log",
].join("\n");

describe("Collection automations", () => {
  it.each([false, true])("uses otherwise when a guarded formula has no Details (Only if: %s)", async (onlyIf) => {
    const w = await world({ automations: { Tasks: [
      "  - id: guarded", "    name: Guarded", "    when: {field-changed: Status}",
      ...(onlyIf ? ['    if: record.Status == "Waiting"'] : []),
      "    do:",
      "      - if: record.Details != null",
      "        do: [{set: {Note: '=record.Details.name'}}]",
      "        otherwise: [{set: {Note: fallback}}]",
    ].join("\n") } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Details: null });
    const claim = w.claim("collection:Tasks#guarded", task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(w.fieldsOf(task)).toEqual({ Status: "Done", Details: null, ...(onlyIf ? {} : { Note: "fallback" }) });
    expect(w.journaled).toHaveLength(onlyIf ? 0 : 1);
  });

  it("fails a selected formula before writing any earlier planned step", async () => {
    const w = await world({ automations: { Tasks: [
      "  - id: guarded", "    name: Guarded", "    when: {field-changed: Status}",
      "    do:", "      - set: {Seen: true}",
      "      - if: record.Details == null",
      "        do: [{set: {Note: '=record.Details.name'}}]",
      "        otherwise: [{set: {Note: fallback}}]",
    ].join("\n") } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Details: null });
    const claim = w.claim("collection:Tasks#guarded", task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("failed");
    expect(claim.error).toContain('The formula for "Note" in step 3 failed.');
    expect(w.fieldsOf(task)).toEqual({ Status: "Done", Details: null });
    expect(w.journaled).toEqual([]);
  });

  it("subscribes each automation it can run, then sets fields on the trigger record as the automation", async () => {
    const w = await world({ automations: { Tasks: [
      "  - id: stamp",
      "    name: Stamp",
      "    when: {field-changed: Status, to: Done}",
      "    do: [{set: {Finished on: '=today()', Note: done}}]",
      "  - id: later",
      "    name: Later",
      "    when: {schedule: day, timezone: UTC}",
      "    do: [{find: 'true', as: all}]",
    ].join("\n") } });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const claim = w.claim("collection:Tasks#stamp", task);
    await w.executor.open();
    await w.settledClaim(claim);

    expect(claim.state).toBe("done");
    // A schedule cannot run yet, so only the record trigger subscribes.
    expect([...w.subscriptions.keys()]).toEqual(["collection:Tasks#stamp"]);
    expect(w.subscriptions.get("collection:Tasks#stamp")).toEqual({
      automationId: "collection:Tasks#stamp", path: "Tasks", kinds: ["changed"], fields: ["Status"],
    });
    expect(w.fieldsOf(task)).toEqual({
      Status: "Done", "Finished on": localIsoTime(claim.createdAtMs).slice(0, 10), Note: "done",
    });
    const listed = await w.executor.automationsIn("Tasks");
    const hash = listed.status === "read" && listed.automations[0]?.valid ? listed.automations[0].definitionHash : "";
    // Each field is its own effect, keyed by the claim, the definition and the claim's run, the step, the record, and the field.
    expect(w.journaled.map((entry) => entry.idempotencyKey)).toEqual([
      `${claim.claimId}/${hash}-1/0/${task.id}/Finished on`,
      `${claim.claimId}/${hash}-1/0/${task.id}/Note`,
    ]);
    expect(w.journaled[0]).toMatchObject({
      actorOriginId: "collection:Tasks#stamp",
      attribution: { actorKind: "automation", onBehalfOf: "local", depth: 1 },
    });
  });

  it("finds records, changes each with its own values, branches, and adds records it then changes", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: [
      "  - id: sweep",
      "    name: Sweep",
      "    when: {field-changed: Status}",
      "    do:",
      "      - find: record.Project == trigger.record.Project",
      "        as: siblings",
      "      - set: {Points: '=record.Points * 2', Swept: true}",
      "        records: siblings",
      "      - if: siblings.length > 5",
      "        do: [{set: {Note: many}}]",
      "        otherwise:",
      "          - add-record: {Title: '=\"Swept \" + siblings.length'}",
      "            collection: Log",
      "            as: entry",
      "          - set: {Checked: true}",
      "            records: entry",
    ].join("\n") } });
    const trigger = w.addRecord("Tasks", "one", { Status: "Done", Project: "Trip", Points: 1 });
    const sibling = w.addRecord("Tasks", "two", { Project: "Trip", Points: 5 });
    const other = w.addRecord("Tasks", "three", { Project: "Budget", Points: 7 });
    const claim = w.claim("collection:Tasks#sweep", trigger);
    await w.executor.open();
    await w.settledClaim(claim);

    expect(claim.error).toBeUndefined();
    expect(w.fieldsOf(trigger)).toMatchObject({ Points: 2, Swept: true });
    expect(w.fieldsOf(sibling)).toMatchObject({ Points: 10, Swept: true });
    expect(w.fieldsOf(other)).toEqual({ Project: "Budget", Points: 7 });
    const added = [...w.records.values()].find((record) => record.collection === "Log")!;
    expect(w.fieldsOf(added)).toEqual({ Title: "Swept 2", Checked: true });
    expect(added.path).toMatch(/^Log\/sweep-[a-z2-7]{8}\.md$/);
    // The automation creates the file as the moment's author, so the added
    // record's claim carries the automation and never triggers itself.
    expect(w.authored).toEqual([{ path: added.path, author: {
      kind: "automation", automationId: "collection:Tasks#sweep", onBehalfOf: "local", depth: 1,
    } }]);
    const [run] = await w.executor.runs("collection:Tasks#sweep");
    expect(run!.writes).toContainEqual({ kind: "field", recordId: sibling.id, path: sibling.path, field: "Points", before: 5, after: 10 });
    expect(run!.writes).toContainEqual({ kind: "created", recordId: added.id, path: added.path });
  });

  it("lists every Collection a step can add records to, with why one is out of reach", async () => {
    const w = await world({ collections: ["Tasks", "Budget"], automations: {} });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("ana@dohc.test", ["Tasks"])] });
    await w.executor.open();
    await expect(w.executor.targetsFor("Tasks")).resolves.toEqual([
      { path: "Budget", name: "Budget", stopped: "ana@dohc.test cannot edit Budget." },
      { path: "Tasks", name: "Tasks", stopped: null },
    ]);
  });

  it("fails a run whose step reaches past what every editor can reach, before anything is written", async () => {
    const w = await world({ collections: ["Tasks", "Budget"], automations: { Tasks: [
      "  - id: spend",
      "    name: Spend",
      "    when: {field-changed: Status}",
      "    do: [{set: {Seen: true}}, {add-record: {Amount: 5}, collection: Budget}]",
    ].join("\n") } });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("ana@dohc.test", ["Tasks"])] });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const claim = w.claim("collection:Tasks#spend", task);
    await w.executor.open();
    await w.settledClaim(claim);

    expect(claim).toMatchObject({ state: "failed", error: "ana@dohc.test cannot edit Budget." });
    expect(w.fieldsOf(task)).toEqual({ Status: "Done" });
    expect(w.journaled).toEqual([]);
    // The failure notices re-read once the claim settles.
    await w.until(() => w.failuresChanged.length === 1);
  });

  it("refuses a step that would change a dataset's records through the document write path", async () => {
    const w = await world({ automations: { Tasks: [
      "  - id: donate",
      "    name: Donate",
      "    when: {field-changed: Status}",
      "    do: [{add-record: {Amount: 5}, collection: Donations}]",
    ].join("\n") } });
    await mkdir(join(w.root, "Donations"), { recursive: true });
    await writeFile(join(w.root, "Donations", "dataset.json"), "{}\n");
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const claim = w.claim("collection:Tasks#donate", task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim).toMatchObject({
      state: "failed",
      error: "Automations cannot use Donations yet, because it keeps its records in a dataset.",
    });
    expect(w.authored).toEqual([]);
  });

  it("leaves a claim waiting while the roster is unknown, and runs it after the next listing", async () => {
    const w = await world({ automations: { Tasks: "  - id: seen\n    name: Seen\n    when: {field-changed: Status}\n    do: [{set: {Seen: true}}]\n" } });
    w.setRoster({ kind: "unknown", problem: { kind: "unchecked", next: "Try again later." } });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const claim = w.claim("collection:Tasks#seen", task);
    await w.executor.open();
    await w.until(() => w.idleDrains() >= 1);
    expect(claim.state).toBe("running");
    expect(await w.executor.automationsIn("Tasks")).toMatchObject({
      automations: [{ reach: { kind: "waiting", reason: "dohc could not check who can edit Tasks. Try again later." } }],
    });

    w.setRoster(OWNER);
    w.executor.rosterChanged();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(w.fieldsOf(task)).toEqual({ Status: "Done", Seen: true });
  });

  it("finishes a run that failed part way on Try again without repeating the step that landed", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: BUMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    w.failures.authoredWrite = 1;
    const claim = w.claim(TASKS, task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim).toMatchObject({ state: "failed", error: "dohc could not write the record file." });
    expect(w.fieldsOf(task).Count).toBe(3);

    await expect(w.executor.retry({ automationId: TASKS, claimId: claim.claimId, startOver: false })).resolves.toEqual({ status: "queued" });
    await w.until(() => claim.state === "done");
    expect(w.fieldsOf(task).Count).toBe(3);
    expect([...w.records.values()].filter((record) => record.collection === "Log")).toHaveLength(1);
    // The retry named the claim to the failure notices.
    expect(w.failuresChanged.length).toBeGreaterThanOrEqual(2);
  });

  it("resumes a run that stopped after a write landed but before it was recorded, without a second increment", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: BUMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    // Step 1's record fails after its write landed.
    w.failRecordAt(1);
    const claim = w.claim(TASKS, task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim).toMatchObject({ state: "failed", error: "The disk is full." });
    expect(w.fieldsOf(task).Count).toBe(3);

    await w.executor.retry({ automationId: TASKS, claimId: claim.claimId, startOver: false });
    await w.until(() => claim.state === "done");
    expect(w.fieldsOf(task).Count).toBe(3);
    const [run] = await w.executor.runs(TASKS);
    // The step that landed before the stop is recorded with what it changed.
    expect(run!.writes).toContainEqual({ kind: "field", recordId: task.id, path: task.path, field: "Count", before: 2, after: 3 });
  });

  it("asks before running a changed automation from the start, and repeats its steps only when confirmed", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: BUMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    w.failures.authoredWrite = 1;
    const claim = w.claim(TASKS, task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(w.fieldsOf(task).Count).toBe(3);

    await w.writeAutomations("Tasks", BUMP.replace("Title: Bumped", "Title: Bumped again"));
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    await w.until(() => w.idleDrains() >= 2);
    await expect(w.executor.retry({ automationId: TASKS, claimId: claim.claimId, startOver: false }))
      .resolves.toEqual({ status: "definition-changed" });
    expect(claim.state).toBe("failed");
    expect((await w.executor.runs(TASKS))[0]).toMatchObject({ definitionChanged: true });

    await w.executor.retry({ automationId: TASKS, claimId: claim.claimId, startOver: true });
    await w.until(() => claim.state === "done");
    expect(w.fieldsOf(task).Count).toBe(4);
    const titles = [...w.records.values()].filter((record) => record.collection === "Log").map((record) => w.fieldsOf(record).Title);
    expect(titles).toEqual(["Bumped again"]);
  });

  it("fails a changed automation's requeued run instead of repeating what the first definition did", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: BUMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    w.failures.authoredWrite = 1;
    const claim = w.claim(TASKS, task);
    await w.executor.open();
    await w.settledClaim(claim);
    await w.writeAutomations("Tasks", BUMP.replace("Title: Bumped", "Title: Other"));
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    await w.until(() => w.idleDrains() >= 2);
    // The engine hands the claim out again, as after a crash.
    claim.state = "pending";
    w.requeue(claim);
    w.executor.notifyClaimed();
    await w.until(() => claim.state === "failed" && claim.error === DEFINITION_CHANGED_ERROR);
    expect(w.fieldsOf(task).Count).toBe(3);
  });

  it("holds a step that reach allows only because its writer stopped editing, until a current editor confirms it", async () => {
    const w = await world({ collections: ["Trip", "Budget"], automations: { Trip: [
      "  - id: spend",
      "    name: Spend",
      "    when: {field-changed: Status}",
      "    do: [{add-record: {Amount: 5}, collection: Budget}]",
    ].join("\n") } });
    // Bob can edit Trip but not Budget, so the step he wrote is stopped.
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("bob@dohc.test", ["Trip"])] });
    await w.executor.open();
    expect(await w.executor.automationsIn("Trip")).toMatchObject({
      automations: [{ reach: { kind: "checked", steps: [{ verdict: "stopped", reason: "bob@dohc.test cannot edit Budget." }] } }],
    });

    // Bob's share ends. His step is not switched on by his leaving.
    w.setRoster(OWNER);
    const listed = await w.executor.automationsIn("Trip");
    expect(listed).toMatchObject({
      automations: [{ reach: { kind: "checked", steps: [{ verdict: "held", stoppedFor: "bob@dohc.test" }] } }],
    });
    // One notice asks a current editor, however often the verdict is read.
    await w.executor.automationsIn("Trip");
    expect(w.holdsChanged()).toBe(1);
    expect(w.executor.holds()).toMatchObject([{ automationName: "Spend", collection: "Trip", target: "Budget", action: "change", stoppedFor: "bob@dohc.test" }]);
    const trip = w.addRecord("Trip", "day-one", { Status: "Done" });
    const claim = w.claim("collection:Trip#spend", trip);
    const drained = w.idleDrains();
    w.executor.notifyClaimed();
    await w.until(() => w.idleDrains() > drained);
    expect(claim.state).toBe("running");
    expect([...w.records.values()].filter((record) => record.collection === "Budget")).toEqual([]);

    const summary = (listed as { automations: Array<{ definitionHash: string; reach: { steps: Array<{ seq: number }> } }> }).automations[0]!;
    await expect(w.executor.confirmReach({
      automationId: "collection:Trip#spend", definitionHash: summary.definitionHash, step: 0, seq: summary.reach.steps[0]!.seq + 1,
    })).resolves.toBe("changed");
    await expect(w.executor.confirmReach({
      automationId: "collection:Trip#spend", definitionHash: summary.definitionHash, step: 0, seq: summary.reach.steps[0]!.seq,
    })).resolves.toBe("confirmed");
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect([...w.records.values()].filter((record) => record.collection === "Budget")).toHaveLength(1);
  });

  it("clears the Allow notice when a held step stops again", async () => {
    const spend = "  - id: spend\n    name: Spend\n    when: {field-changed: Status}\n    do: [{add-record: {Amount: 5}, collection: Budget}]\n";
    const w = await world({ collections: ["Trip", "Budget"], automations: { Trip: spend } });
    const bob = { kind: "owner" as const, ownerUserId: "user-owner", grants: [editor("bob@dohc.test", ["Trip"])] };
    w.setRoster(bob);
    await w.executor.open();
    await w.executor.automationsIn("Trip");
    w.setRoster(OWNER);
    await w.executor.automationsIn("Trip");
    expect(w.executor.holds()).toHaveLength(1);
    const raised = w.holdsChanged();
    // Bob gets Edit on Trip again, so the step stops, and its notice goes.
    w.setRoster(bob);
    await w.executor.automationsIn("Trip");
    expect(w.executor.holds()).toEqual([]);
    expect(w.holdsChanged()).toBe(raised + 1);
  });

  it("runs the definition it read before checking who can edit, not one that arrived during the check", async () => {
    const w = await world({ automations: { Tasks: "  - id: mark\n    name: Mark\n    when: {field-changed: Status}\n    do: [{set: {Mark: first}}]\n" } });
    await w.executor.open();
    await w.until(() => w.idleDrains() >= 1);
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    // A pull lands a new definition while the roster is being listed.
    w.beforeNextRoster(async () => {
      await w.writeAutomations("Tasks", "  - id: mark\n    name: Mark\n    when: {field-changed: Status}\n    do: [{set: {Mark: second}}]\n");
      w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    });
    const claim = w.claim("collection:Tasks#mark", task);
    w.executor.notifyClaimed();
    await w.settledClaim(claim);
    expect(w.fieldsOf(task).Mark).toBe("first");
  });

  it("switches off an automation after three runs in a row time out, and says so in the failure", async () => {
    const timedOut: AutomationEvaluator["evaluate"] = async (_scope, formulas) =>
      formulas.map(() => ({ ok: false, error: { code: "timeout", message: "The formula ran longer than 100 ms." } }));
    const w = await world({
      automations: { Tasks: "  - id: slow\n    name: Slow\n    when: {field-changed: Status}\n    do: [{set: {X: '=spin()'}}]\n" },
      evaluator: createAutomationFormulaEvaluator(() => ({ evaluate: timedOut, runCode: async () => { throw new Error("unused"); }, close: async () => undefined })).forWorkspace("workspace"),
    });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const claims = Array.from({ length: TIMEOUTS_BEFORE_SWITCH_OFF }, () => w.claim("collection:Tasks#slow", task));
    await w.executor.open();
    for (const claim of claims) await w.settledClaim(claim);

    expect(claims.map((claim) => claim.state)).toEqual(["failed", "failed", "failed"]);
    expect(claims[1]!.error).not.toContain("switched off");
    expect(claims[2]!.error).toContain('dohc switched off "Slow" after 3 runs in a row took too long.');
    expect(await readFile(join(w.root, "Tasks", "automations.yaml"), "utf8")).toContain("enabled: false");
  });

  it("leaves a claim for the next drain when the evaluator is busy", async () => {
    let calls = 0;
    const w = await world({
      automations: { Tasks: "  - id: calc\n    name: Calc\n    when: {field-changed: Status}\n    do: [{set: {X: '=1 + 1'}}]\n" },
      evaluator: {
        evaluate: async (id, scope, formulas) => (calls += 1) === 1 ? "busy" : await evaluator.evaluate(id, scope, formulas),
      },
    });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const claim = w.claim("collection:Tasks#calc", task);
    await w.executor.open();
    await w.until(() => calls === 1 && w.idleDrains() >= 1);
    expect(claim.state).toBe("running");

    w.executor.notifyClaimed();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(w.fieldsOf(task).X).toBe(2);
  });

  it("aborts every write at the deadline and settles only after the write in flight has stopped", async () => {
    let passDeadline = () => {};
    const w = await world({
      automations: { Tasks: "  - id: stuck\n    name: Stuck\n    when: {field-changed: Status}\n    do: [{set: {X: 1}}]\n" },
      deadline: (abort) => { passDeadline = abort; return () => {}; },
      // The write waits on the engine, and the run's deadline passes while it does.
      withRecordWrites: (signal, events) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          events.push("write stopped");
          reject(new Error("The write stopped."));
        }, { once: true });
        passDeadline();
      }),
    });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const claim = w.claim("collection:Tasks#stuck", task);
    await w.executor.open();
    await w.settledClaim(claim);

    expect(claim).toMatchObject({ state: "failed", error: DEADLINE_ERROR });
    expect(w.events).toEqual(["write stopped", "settled failed"]);
    expect(w.fieldsOf(task)).toEqual({ Status: "Done" });
  });

  it("resumes a chain of writes to one field from the step that did not land", async () => {
    const w = await world({ automations: { Tasks: "  - id: chain\n    name: Chain\n    when: {field-changed: Status}\n    do: [{set: {Count: 1}}, {set: {Count: 2}}]\n" } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 0 });
    // The first write lands; the second cannot open the record.
    w.failOpenAt(2);
    const claim = w.claim("collection:Tasks#chain", task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("failed");
    expect(w.fieldsOf(task).Count).toBe(1);

    await w.executor.retry({ automationId: "collection:Tasks#chain", claimId: claim.claimId, startOver: false });
    await w.until(() => claim.state === "done");
    expect(w.fieldsOf(task).Count).toBe(2);
    const [run] = await w.executor.runs("collection:Tasks#chain");
    expect(run!.writes.filter((write) => write.kind === "field").map((write) => write.kind === "field" && [write.before, write.after]))
      .toEqual([[0, 1], [1, 2]]);
  });

  const ITEMS = "  - id: tick\n    name: Tick\n    when: {field-changed: Status}\n    do:\n      - find: 'true'\n        collection: Items\n        as: items\n      - set: {Count: '=record.Count + 1'}\n        records: items\n";

  it("resumes a step over 50 records at the record where it stopped, so each record changes once", async () => {
    const w = await world({ collections: ["Tasks", "Items"], automations: { Tasks: ITEMS } });
    const items = Array.from({ length: 50 }, (_, index) => w.addRecord("Items", `item-${index}`, { Count: index }));
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    w.failOpenAt(26);
    const claim = w.claim("collection:Tasks#tick", task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("failed");
    expect(items.filter((item, index) => w.fieldsOf(item).Count === index + 1)).toHaveLength(25);

    await w.executor.retry({ automationId: "collection:Tasks#tick", claimId: claim.claimId, startOver: false });
    await w.until(() => claim.state === "done");
    expect(items.map((item) => w.fieldsOf(item).Count)).toEqual(items.map((_, index) => index + 1));
  });

  it("asks before running an edited automation over a step that stopped part way through 50 records", async () => {
    const w = await world({ collections: ["Tasks", "Items"], automations: { Tasks: ITEMS } });
    const items = Array.from({ length: 50 }, (_, index) => w.addRecord("Items", `item-${index}`, { Count: 0 }));
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    w.failOpenAt(26);
    const claim = w.claim("collection:Tasks#tick", task);
    await w.executor.open();
    await w.settledClaim(claim);
    await w.writeAutomations("Tasks", ITEMS.replace("record.Count + 1", "record.Count + 10"));
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    await w.until(() => w.idleDrains() >= 2);

    await expect(w.executor.retry({ automationId: "collection:Tasks#tick", claimId: claim.claimId, startOver: false }))
      .resolves.toEqual({ status: "definition-changed" });
    expect(claim.state).toBe("failed");
    await w.executor.retry({ automationId: "collection:Tasks#tick", claimId: claim.claimId, startOver: true });
    await w.until(() => claim.state === "done");
    // The person chose to run the new version from the start.
    expect(items.map((item) => w.fieldsOf(item).Count)).toEqual(items.map((_, index) => index < 25 ? 11 : 10));
  });

  it("refuses a run that would change more fields than it can save, before writing anything", async () => {
    const wide = "  - id: wide\n    name: Wide\n    when: {field-changed: Status}\n    do:\n      - find: 'true'\n        collection: Items\n        as: items\n      - set: {A: 1, B: 1, C: 1, D: 1, E: 1}\n        records: items\n";
    const w = await world({ collections: ["Tasks", "Items"], automations: { Tasks: wide } });
    Array.from({ length: 50 }, (_, index) => w.addRecord("Items", `item-${index}`, {}));
    const claim = w.claim("collection:Tasks#wide", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.error).toBe("This run would change more than 200 fields. Narrow its Find steps, or split it into smaller automations.");
    expect(w.journaled).toEqual([]);
  });

  it("finds a record by its id again before writing, and records a record that left as skipped", async () => {
    const w = await world({ automations: { Tasks: "  - id: note\n    name: Note\n    when: {field-changed: Status}\n    do: [{set: {Note: seen}}]\n" } });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    w.failures.openSession = 1;
    const claim = w.claim("collection:Tasks#note", task);
    await w.executor.open();
    await w.settledClaim(claim);
    // Someone renames the record before Try again.
    w.moveRecord(task, "renamed");
    await w.executor.retry({ automationId: "collection:Tasks#note", claimId: claim.claimId, startOver: false });
    await w.until(() => claim.state === "done");
    expect(w.fieldsOf(task).Note).toBe("seen");
    expect(w.journaled.at(-1)!.path).toBe("Tasks/renamed.md");

    const gone = w.addRecord("Tasks", "two", { Status: "Done" });
    w.failures.openSession = 1;
    const second = w.claim("collection:Tasks#note", gone);
    w.executor.notifyClaimed();
    await w.settledClaim(second);
    w.records.delete(gone.id);
    await w.executor.retry({ automationId: "collection:Tasks#note", claimId: second.claimId, startOver: false });
    await w.until(() => second.state === "done");
    const [run] = await w.executor.runs("collection:Tasks#note");
    expect(run!.writes).toEqual([{ kind: "skipped", recordId: gone.id, path: gone.path, reason: "The record is no longer in the Collection." }]);
  });

  it("keeps a field someone changed while the run waited, and does not count it as the automation's write", async () => {
    const w = await world({ automations: { Tasks: "  - id: two\n    name: Two\n    when: {field-changed: Status}\n    do: [{set: {Count: 1}}, {set: {Note: done}}]\n" } });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    w.failOpenAt(2);
    const claim = w.claim("collection:Tasks#two", task);
    await w.executor.open();
    await w.settledClaim(claim);
    task.doc.getMap("frontmatter").set("Note", "theirs");
    await w.executor.retry({ automationId: "collection:Tasks#two", claimId: claim.claimId, startOver: false });
    await w.until(() => claim.state === "done");
    expect(w.fieldsOf(task)).toMatchObject({ Count: 1, Note: "theirs" });
    const [run] = await w.executor.runs("collection:Tasks#two");
    expect(run!.writes).toContainEqual({ kind: "kept", recordId: task.id, path: task.path, field: "Note", planned: "done", current: "theirs" });
    expect(run!.writes.some((write) => write.kind === "field" && write.field === "Note")).toBe(false);
  });

  it("hands a waiting claim back to the engine at the end of the drain, and holds nothing at close", async () => {
    const w = await world({ automations: { Tasks: "  - id: seen\n    name: Seen\n    when: {field-changed: Status}\n    do: [{set: {Seen: true}}]\n" } });
    w.setRoster({ kind: "unknown", problem: { kind: "unchecked", next: "Try again later." } });
    const claim = w.claim("collection:Tasks#seen", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.until(() => w.events.includes(`released ${claim.claimId}`));
    expect(claim).toMatchObject({ state: "pending", attempts: 0 });
    await w.executor.dispose();
    expect(claim.state).toBe("pending");
  });

  it("refuses Try again for an automation that is switched off", async () => {
    const off = "  - id: off\n    name: Off\n    enabled: false\n    when: {field-changed: Status}\n    do: [{set: {X: 1}}]\n";
    const w = await world({ automations: { Tasks: off } });
    await w.executor.open();
    await expect(w.executor.retry({ automationId: "collection:Tasks#off", claimId: "atc_any", startOver: false }))
      .resolves.toEqual({ status: "refused", reason: '"Off" is switched off. Switch it on, then try again.' });
  });

  it("fails closed when a run's saved progress cannot be read, instead of starting over", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: BUMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    w.failures.authoredWrite = 1;
    const claim = w.claim(TASKS, task);
    await w.executor.open();
    await w.settledClaim(claim);
    const folder = join(w.root, ".dohc", "automations", "runs");
    for (const automation of await readdir(folder)) {
      for (const file of await readdir(join(folder, automation))) await writeFile(join(folder, automation, file), "{ torn");
    }
    await expect(w.executor.retry({ automationId: TASKS, claimId: claim.claimId, startOver: false }))
      .resolves.toEqual({ status: "refused", reason: UNREADABLE_RUN_ERROR });
    // A crash requeue does not start it over either.
    claim.state = "pending";
    w.requeue(claim);
    w.executor.notifyClaimed();
    await w.until(() => claim.state === "failed" && claim.error === UNREADABLE_RUN_ERROR);
    expect(w.fieldsOf(task).Count).toBe(3);
  });

  const STAMP = [
    "  - id: stamp",
    "    name: Stamp",
    "    when: {field-changed: Status}",
    "    do:",
    "      - set: {Count: '=record.Count + 1', Note: done}",
    "      - add-record: {Title: Stamped}",
    "        collection: Log",
  ].join("\n");

  it("undoes a run as the person, keeps what someone changed since, and moves the records it added to the trash", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: STAMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2, Note: "old" });
    const claim = w.claim("collection:Tasks#stamp", task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(w.fieldsOf(task)).toMatchObject({ Count: 3, Note: "done" });
    const [added] = [...w.records.values()].filter((record) => record.collection === "Log");
    task.doc.getMap("frontmatter").set("Note", "theirs");

    const trashed: string[] = [];
    const trash = async (path: string) => {
      trashed.push(path);
      for (const [id, record] of w.records) if (record.path === path) w.records.delete(id);
    };
    await expect(w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId }, trash))
      .resolves.toEqual({ status: "undone", reverted: 1, removed: 1, changedSince: 1, missing: 0 });
    expect(w.fieldsOf(task)).toMatchObject({ Count: 2, Note: "theirs" });
    expect(trashed).toEqual([added!.path]);
    expect(w.journaled.at(-1)).toMatchObject({ path: task.path, attribution: { actorKind: "human" } });
    expect(w.journaled.at(-1)!.actorOriginId).toBeUndefined();

    const [run] = await w.executor.runs("collection:Tasks#stamp");
    expect(run).toMatchObject({ state: "done", undone: true, chainStopped: false });
    await expect(w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId }, trash))
      .resolves.toEqual({ status: "refused", reason: "You already undid this run." });
  });

  it("will not run a failed run again after someone undid what it changed", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: STAMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    w.failures.authoredWrite = 1;
    const claim = w.claim("collection:Tasks#stamp", task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("failed");
    expect(w.fieldsOf(task).Count).toBe(3);

    await expect(w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId }, async () => undefined))
      .resolves.toEqual({ status: "undone", reverted: 2, removed: 0, changedSince: 0, missing: 0 });
    expect(w.fieldsOf(task).Count).toBe(2);
    await expect(w.executor.retry({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, startOver: false }))
      .resolves.toEqual({ status: "refused", reason: UNDONE_RUN_ERROR });
    expect(claim.state).toBe("failed");
    // A retry that reaches the engine another way does not run it either.
    claim.state = "pending";
    w.requeue(claim);
    w.executor.notifyClaimed();
    await w.until(() => claim.state === "failed" && claim.error === UNDONE_RUN_ERROR);
    expect(w.fieldsOf(task).Count).toBe(2);
  });

  it("marks an Undo started before it reverses anything, so nothing resumes over it, and resumes it next time", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: STAMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2, Note: "old" });
    // The run sets its fields, then cannot add its record, so its plan could resume.
    w.failures.authoredWrite = 1;
    const claim = w.claim("collection:Tasks#stamp", task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("failed");

    // Undo stops before it puts anything back: the record cannot be opened.
    w.failures.openSession = 1;
    await expect(w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId }, async () => undefined))
      .rejects.toThrow("The record is open in a live session elsewhere.");
    expect(w.fieldsOf(task)).toMatchObject({ Count: 3, Note: "done" });
    const [stopped] = await w.executor.runs("collection:Tasks#stamp");
    expect(stopped).toMatchObject({ undone: false });
    await expect(w.executor.retry({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, startOver: false }))
      .resolves.toEqual({ status: "refused", reason: UNDONE_RUN_ERROR });
    // A requeue from the engine's recovery does not resume the plan either.
    claim.state = "pending";
    w.requeue(claim);
    w.executor.notifyClaimed();
    await w.until(() => claim.state === "failed" && claim.error === UNDONE_RUN_ERROR);
    expect([...w.records.values()].filter((record) => record.collection === "Log")).toEqual([]);

    await expect(w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId }, async () => undefined))
      .resolves.toEqual({ status: "undone", reverted: 2, removed: 0, changedSince: 0, missing: 0 });
    expect(w.fieldsOf(task)).toMatchObject({ Count: 2, Note: "old" });
    const [finished] = await w.executor.runs("collection:Tasks#stamp");
    expect(finished).toMatchObject({ undone: true });
  });

  it("lists a record a run created before it stopped, once, so its Undo shows", async () => {
    const addOnly = [
      "  - id: log",
      "    name: Log",
      "    when: {field-changed: Status}",
      "    do:",
      "      - add-record: {Title: Logged}",
      "        collection: Log",
    ].join("\n");
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: addOnly } });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    // The record is created, then its fields cannot be set.
    w.failOpenAt(1);
    const claim = w.claim("collection:Tasks#log", task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("failed");
    const added = [...w.records.values()].find((record) => record.collection === "Log")!;
    const [run] = await w.executor.runs("collection:Tasks#log");
    expect(run!.writes).toEqual([{ kind: "created", recordId: added.id, path: added.path }]);
  });

  it("moves a record to the trash that a run created before it stopped setting its fields", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: STAMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2, Note: "old" });
    // The task's fields land, the record is created, then its fields cannot be set.
    w.failOpenAt(2);
    const claim = w.claim("collection:Tasks#stamp", task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("failed");
    const added = [...w.records.values()].find((record) => record.collection === "Log")!;

    const trashed: string[] = [];
    await expect(w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId }, async (path) => {
      trashed.push(path);
    })).resolves.toEqual({ status: "undone", reverted: 2, removed: 1, changedSince: 0, missing: 0 });
    expect(trashed).toEqual([added.path]);
  });

  it("undoes what a run did under the definition a person started it over from", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: STAMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2, Note: "old" });
    // The first version sets its fields, then cannot add its record.
    w.failures.authoredWrite = 1;
    const claim = w.claim("collection:Tasks#stamp", task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(w.fieldsOf(task)).toMatchObject({ Count: 3, Note: "done" });

    await w.writeAutomations("Tasks", STAMP.replace("record.Count + 1", "record.Count + 10"));
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    await w.until(() => w.idleDrains() >= 2);
    await w.executor.retry({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, startOver: true });
    await w.until(() => claim.state === "done");
    expect(w.fieldsOf(task).Count).toBe(13);
    const [run] = await w.executor.runs("collection:Tasks#stamp");
    expect(run!.writes.filter((write) => write.kind === "field" && write.field === "Count")
      .map((write) => write.kind === "field" && [write.before, write.after])).toEqual([[2, 3], [3, 13]]);

    await w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId }, async () => undefined);
    // Back to before the first version ran, not only before the second.
    expect(w.fieldsOf(task)).toMatchObject({ Count: 2, Note: "old" });
  });

  it("lets only one of an Undo and a Try again started together change a run", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: STAMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    w.failures.authoredWrite = 1;
    const claim = w.claim("collection:Tasks#stamp", task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("failed");

    const undoing = w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId }, async () => undefined);
    const retrying = w.executor.retry({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, startOver: false });
    await expect(retrying).resolves.toEqual({ status: "refused", reason: "dohc is already changing this run. Try again in a moment." });
    await expect(undoing).resolves.toMatchObject({ status: "undone", reverted: 2 });
    expect(claim.state).toBe("failed");
    expect(w.fieldsOf(task).Count).toBe(2);
  });

  it("marks a run the chain depth cap stopped, so the panel offers no Try again", async () => {
    const w = await world({ automations: { Tasks: STAMP.replace("        collection: Log", "") } });
    const claim = w.claim("collection:Tasks#stamp", w.addRecord("Tasks", "one", { Status: "Done" }));
    // The engine inserts a chain stop failed, and never serves it.
    w.claims.get(claim.claimId)!.state = "failed";
    w.claims.get(claim.claimId)!.error = "chain-stopped";
    const [run] = await w.executor.runs("collection:Tasks#stamp");
    expect(run).toMatchObject({ state: "failed", chainStopped: true, undone: false, writes: [] });
  });

  it("keeps an automation that names a field its Collection lacks off, says why, and runs it once the field exists", async () => {
    const w = await world({ automations: { Tasks: "  - id: done\n    name: Done\n    when: {field-changed: Status}\n    do: [{set: {Done on: '=today()'}}]\n" } });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    await w.executor.open();
    const listed = await w.executor.automationsIn("Tasks");
    expect(listed.status === "read" && listed.automations[0]).toMatchObject({ cannotRun: "Done on is not a field in Tasks." });
    expect(w.subscriptions.has("collection:Tasks#done")).toBe(false);
    // A claim made before the field went away fails with the reason, without writing.
    const early = w.claim("collection:Tasks#done", task);
    w.executor.notifyClaimed();
    await w.settledClaim(early);
    expect(early).toMatchObject({ state: "failed", error: "Done on is not a field in Tasks." });
    expect(w.fieldsOf(task)).toEqual({ Status: "Done" });

    await writeFile(join(w.root, "Tasks", "collection.yaml"), `${SCHEMA}  Done on:\n    type: text\n`);
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/collection.yaml" }]);
    await w.until(() => w.subscriptions.has("collection:Tasks#done"));
    const claim = w.claim("collection:Tasks#done", task);
    w.executor.notifyClaimed();
    await w.settledClaim(claim);
    expect(w.fieldsOf(task)["Done on"]).toBe(localIsoTime(claim.createdAtMs).slice(0, 10));
  });

  it("checks fields against a schema with one bad key, and keeps an automation off while its schema is not YAML", async () => {
    const w = await world({ automations: { Tasks: "  - id: done\n    name: Done\n    when: {field-changed: Status}\n    do: [{set: {Done on: '=today()'}}]\n" } });
    // One key dohc does not know degrades the schema; its fields still count.
    await writeFile(join(w.root, "Tasks", "collection.yaml"), `${SCHEMA}colour: blue\n`);
    await w.executor.open();
    const degraded = await w.executor.automationsIn("Tasks");
    expect(degraded.status === "read" && degraded.automations[0]).toMatchObject({ cannotRun: "Done on is not a field in Tasks." });

    await writeFile(join(w.root, "Tasks", "collection.yaml"), "fields: [unclosed\n");
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/collection.yaml" }]);
    const broken = await w.executor.automationsIn("Tasks");
    expect(broken.status === "read" && broken.automations[0]).toMatchObject({
      cannotRun: "dohc cannot read the fields of Tasks. Fix Tasks/collection.yaml to run this automation.",
    });
    expect(w.subscriptions.has("collection:Tasks#done")).toBe(false);
  });

  it("keeps counting timeouts across a restart", async () => {
    const timedOut: AutomationEvaluator["evaluate"] = async (_scope, formulas) =>
      formulas.map(() => ({ ok: false, error: { code: "timeout", message: "The formula ran longer than 100 ms." } }));
    const w = await world({
      automations: { Tasks: "  - id: slow\n    name: Slow\n    when: {field-changed: Status}\n    do: [{set: {X: '=spin()'}}]\n" },
      evaluator: createAutomationFormulaEvaluator(() => ({ evaluate: timedOut, runCode: async () => { throw new Error("unused"); }, close: async () => undefined })).forWorkspace("workspace"),
    });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const first = w.claim("collection:Tasks#slow", task);
    await w.executor.open();
    await w.settledClaim(first);
    await w.executor.dispose();

    const restarted = w.makeExecutor();
    const later = [w.claim("collection:Tasks#slow", task), w.claim("collection:Tasks#slow", task)];
    await restarted.open();
    for (const claim of later) await w.settledClaim(claim);
    expect(later[0]!.error).not.toContain("switched off");
    expect(later[1]!.error).toContain('dohc switched off "Slow" after 3 runs in a row took too long.');
  });
  it("checks every field after a stop, so a later write does not replace someone's change", async () => {
    const steps = "  - id: steps\n    name: Steps\n    when: {field-changed: Status}\n    do: [{set: {Count: 1}}, {set: {Note: a}}, {set: {Count: 2}}]\n";
    const w = await world({ automations: { Tasks: steps } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 0 });
    w.failOpenAt(1);
    const claim = w.claim("collection:Tasks#steps", task);
    await w.executor.open();
    await w.settledClaim(claim);
    // Someone sets Count while the run waits for Try again.
    task.doc.getMap("frontmatter").set("Count", 99);
    await w.executor.retry({ automationId: "collection:Tasks#steps", claimId: claim.claimId, startOver: false });
    await w.until(() => claim.state === "done");
    expect(w.fieldsOf(task)).toMatchObject({ Count: 99, Note: "a" });
    const [run] = await w.executor.runs("collection:Tasks#steps");
    expect(run!.writes.filter((write) => write.kind === "kept").map((write) => write.kind === "kept" && write.planned)).toEqual([1, 2]);
  });

  it("keeps a claim whose settle the engine did not take, and settles it later without running it again", async () => {
    const unanswered = { settle: true };
    const w = await world({ unanswered, automations: { Tasks: "  - id: bump\n    name: Bump\n    when: {field-changed: Status}\n    do: [{set: {Count: '=record.Count + 1'}}]\n" } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 1 });
    const claim = w.claim("collection:Tasks#bump", task);
    await w.executor.open();
    await w.until(() => w.errors.some((entry) => entry.context === `settle automation claim "${claim.claimId}"`));
    expect(claim.state).toBe("running");

    unanswered.settle = false;
    w.executor.notifyClaimed();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(w.fieldsOf(task).Count).toBe(2);
    expect(w.journaled).toHaveLength(1);
  });

  it("does not run a failed claim again when the engine hands it out without a Try again", async () => {
    const unanswered = { settle: true };
    const w = await world({ unanswered, automations: { Tasks: "  - id: two\n    name: Two\n    when: {field-changed: Status}\n    do: [{set: {Count: 1}}, {set: {Note: a}}]\n" } });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    w.failOpenAt(2);
    const claim = w.claim("collection:Tasks#two", task);
    await w.executor.open();
    await w.until(() => w.errors.some((entry) => entry.context === `settle automation claim "${claim.claimId}"`));
    await w.executor.dispose();
    // dohc stopped before the engine took the failure; its recovery hands the claim out again.
    unanswered.settle = false;
    claim.state = "pending";
    w.requeue(claim);
    await w.makeExecutor().open();
    await w.until(() => claim.state === "failed");
    expect(claim.error).toBe("The record is open in a live session elsewhere.");
    expect(w.fieldsOf(task)).toEqual({ Status: "Done", Count: 1 });
  });

  it("settles a finished run as done after the automation changed, instead of offering to start it over", async () => {
    const unanswered = { settle: true };
    const w = await world({ collections: ["Tasks", "Log"], unanswered, automations: { Tasks: BUMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    const claim = w.claim(TASKS, task);
    await w.executor.open();
    await w.until(() => w.errors.some((entry) => entry.context === `settle automation claim "${claim.claimId}"`));
    await w.executor.dispose();
    await w.writeAutomations("Tasks", BUMP.replace("Title: Bumped", "Title: Changed"));
    unanswered.settle = false;
    claim.state = "pending";
    w.requeue(claim);
    await w.makeExecutor().open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(w.fieldsOf(task).Count).toBe(3);
  });

  it("writes nothing after a pause that lands while the run checks who can edit, and runs once the engine is back", async () => {
    const w = await world({ automations: { Tasks: "  - id: seen\n    name: Seen\n    when: {field-changed: Status}\n    do: [{set: {Seen: true}}]\n" } });
    await w.executor.open();
    await w.until(() => w.idleDrains() >= 1);
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const paused = Promise.withResolvers<void>();
    w.beforeNextRoster(async () => {
      w.executor.pauseForEngineRestart();
      paused.resolve();
    });
    const claim = w.claim("collection:Tasks#seen", task);
    w.executor.notifyClaimed();
    await paused.promise;
    expect(claim.state).toBe("running");
    expect(w.journaled).toEqual([]);
    // The claim is still the executor's to hand back when the engine answers.
    w.executor.resumeAfterEngineRestart();
    await w.settledClaim(claim);
    expect(w.events).toContain(`released ${claim.claimId}`);
    expect(w.fieldsOf(task)).toEqual({ Status: "Done", Seen: true });
    expect(w.journaled).toHaveLength(1);
  });

  it("hands back a claim when the workspace closes while its run checks who can edit", async () => {
    const w = await world({ automations: { Tasks: "  - id: seen\n    name: Seen\n    when: {field-changed: Status}\n    do: [{set: {Seen: true}}]\n" } });
    await w.executor.open();
    await w.until(() => w.idleDrains() >= 1);
    let closing: Promise<void> | undefined;
    w.beforeNextRoster(async () => { closing = w.executor.dispose(); });
    const claim = w.claim("collection:Tasks#seen", w.addRecord("Tasks", "one", { Status: "Done" }));
    w.executor.notifyClaimed();
    await w.until(() => closing !== undefined);
    await closing;
    expect(claim.state).toBe("pending");
    expect(w.journaled).toEqual([]);
  });

  it("refuses a run whose saved progress would outgrow what dohc reads back, before writing", async () => {
    const big = "x".repeat(12_500);
    const clear = "  - id: clear\n    name: Clear\n    when: {field-changed: Status}\n    do:\n      - find: 'true'\n        collection: Items\n        as: items\n      - set: {A: 1, B: 1, C: 1, D: 1}\n        records: items\n";
    const w = await world({ collections: ["Tasks", "Items"], automations: { Tasks: clear } });
    Array.from({ length: 50 }, (_, index) => w.addRecord("Items", `item-${index}`, { A: big, B: big, C: big, D: big }));
    const claim = w.claim("collection:Tasks#clear", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.error).toBe("This run would change more data than dohc can save for it. Narrow its Find steps, or split it into smaller automations.");
    expect(w.journaled).toEqual([]);
  });

  it("records no reach for an automation dohc cannot run yet", async () => {
    const notify = "  - id: tell\n    name: Tell\n    when: {field-changed: Status}\n    do: [{set: {X: 1}, records: null}, {notify: Hi, to: [user-1]}]\n".replace(", records: null", "");
    const w = await world({ automations: { Tasks: notify } });
    await w.executor.open();
    await w.executor.automationsIn("Tasks");
    await expect(w.baseStore.readReachVerdicts()).resolves.toEqual({ verdicts: [], unreadable: false });
  });
  it("passes a waiting claim by in later drains until what it waits for clears", async () => {
    const w = await world({ automations: {
      Tasks: "  - id: seen\n    name: Seen\n    when: {field-changed: Status}\n    do: [{set: {Seen: true}}]\n",
    } });
    w.setRoster({ kind: "unknown", problem: { kind: "unchecked", next: "Try again later." } });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const claim = w.claim("collection:Tasks#seen", task);
    await w.executor.open();
    await w.until(() => w.events.includes(`released ${claim.claimId}`));
    const checked = w.rosterCalls();
    // Another drain takes the claim again and hands it straight back.
    w.executor.notifyClaimed();
    await w.until(() => w.events.filter((event) => event === `released ${claim.claimId}`).length === 2);
    expect(w.rosterCalls()).toBe(checked);
    expect(claim).toMatchObject({ state: "pending", attempts: 0 });

    w.setRoster(OWNER);
    w.executor.rosterChanged();
    await w.settledClaim(claim);
    expect(w.fieldsOf(task).Seen).toBe(true);
  });

  it("does not switch an automation off when a pause lands while it reads the file", async () => {
    const timedOut: AutomationEvaluator["evaluate"] = async (_scope, formulas) =>
      formulas.map(() => ({ ok: false, error: { code: "timeout", message: "The formula ran longer than 100 ms." } }));
    const w = await world({
      automations: { Tasks: "  - id: slow\n    name: Slow\n    when: {field-changed: Status}\n    do: [{set: {X: '=spin()'}}]\n" },
      evaluator: createAutomationFormulaEvaluator(() => ({ evaluate: timedOut, runCode: async () => { throw new Error("unused"); }, close: async () => undefined })).forWorkspace("workspace"),
    });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const first = [w.claim("collection:Tasks#slow", task), w.claim("collection:Tasks#slow", task)];
    await w.executor.open();
    for (const claim of first) await w.settledClaim(claim);
    const paused = Promise.withResolvers<void>();
    w.beforeNextRead(() => {
      w.executor.pauseForEngineRestart();
      paused.resolve();
    });
    const third = w.claim("collection:Tasks#slow", task);
    w.executor.notifyClaimed();
    await paused.promise;
    // Closing waits for the stopped drain, then hands the claim back.
    await w.executor.dispose();
    expect(await readFile(join(w.root, "Tasks", "automations.yaml"), "utf8")).not.toContain("enabled: false");
    expect(third.state).toBe("pending");
  });

  it("takes an edited or deleted automation's held step out of the notices", async () => {
    const spend = "  - id: spend\n    name: Spend\n    when: {field-changed: Status}\n    do: [{add-record: {Amount: 5}, collection: Budget}]\n";
    const w = await world({ collections: ["Trip", "Budget"], automations: { Trip: spend } });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("bob@dohc.test", ["Trip"])] });
    await w.executor.open();
    await w.executor.automationsIn("Trip");
    w.setRoster(OWNER);
    await w.executor.automationsIn("Trip");
    expect(w.executor.holds()).toHaveLength(1);
    const raised = w.holdsChanged();
    await w.writeAutomations("Trip", "");
    w.executor.handleWatcherEvents([{ operation: "update", path: "Trip/automations.yaml" }]);
    await w.until(() => w.holdsChanged() > raised);
    expect(w.executor.holds()).toEqual([]);
  });

  it("trims saved runs after a failure the engine took, as after a done run", async () => {
    const w = await world({ automations: { Tasks: "  - id: note\n    name: Note\n    when: {field-changed: Status}\n    do: [{set: {Note: seen}}]\n" } });
    w.failures.openSession = 1;
    const claim = w.claim("collection:Tasks#note", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);
    await w.until(() => w.prunes() === 1);
    expect(claim.state).toBe("failed");
  });

  it("drops a settle the engine refused because its recovery took the claim, and leaves the run unsettled", async () => {
    const refused = { settle: 1 };
    const w = await world({ refused, automations: { Tasks: "  - id: note\n    name: Note\n    when: {field-changed: Status}\n    do: [{set: {Note: seen}}]\n" } });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const claim = w.claim("collection:Tasks#note", task);
    await w.executor.open();
    // The recovery handed the claim out again; it finishes as done without writing twice.
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(w.journaled).toHaveLength(1);
    expect(w.errors.filter((entry) => entry.context.startsWith("settle"))).toEqual([]);
    // Only the settle the engine took marks the run done and trims.
    await w.until(() => w.prunes() === 1);
  });
  it("keeps the plan of the failure its notice offers, even behind 20 newer runs", async () => {
    const note = "  - id: note\n    name: Note\n    when: {field-changed: Status}\n    do: [{set: {Note: seen}}]\n";
    const w = await world({ automations: { Tasks: note } });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    w.failures.openSession = 1;
    const old = w.claim("collection:Tasks#note", task);
    await w.executor.open();
    await w.settledClaim(old);
    w.failures.openSession = 1;
    const newer = w.claim("collection:Tasks#note", task);
    w.executor.notifyClaimed();
    await w.settledClaim(newer);
    // The older claim is tried again and fails last, so its notice is the current one.
    w.failures.openSession = 1;
    await w.executor.retry({ automationId: "collection:Tasks#note", claimId: old.claimId, startOver: false });
    await w.until(() => old.state === "failed");
    for (let index = 0; index < 20; index += 1) {
      const claim = w.claim("collection:Tasks#note", w.addRecord("Tasks", `more-${index}`, { Status: "Done" }));
      w.executor.notifyClaimed();
      await w.settledClaim(claim);
    }
    await w.until(() => w.resumable.length >= 23);
    const kept = w.resumable.at(-1)!;
    expect(kept.has(old.claimId)).toBe(true);
    expect(kept.has(newer.claimId)).toBe(false);
  });

  it("asks before starting over a failure whose progress dohc dropped, and refuses one run history no longer shows", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: BUMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    w.failures.authoredWrite = 1;
    const claim = w.claim(TASKS, task);
    await w.executor.open();
    await w.settledClaim(claim);
    const [saved] = (await w.baseStore.runsOf(TASKS, claim.claimId)).runs;
    await w.baseStore.save({ ...saved!, plan: null, applied: [], compacted: true });

    await expect(w.executor.retry({ automationId: TASKS, claimId: claim.claimId, startOver: false }))
      .resolves.toEqual({ status: "progress-gone" });
    expect(claim.state).toBe("failed");
    await expect(w.executor.retry({ automationId: TASKS, claimId: claim.claimId, startOver: true }))
      .resolves.toEqual({ status: "queued" });
    await w.until(() => claim.state === "done");
    // The person chose to run it from the start, so its first step ran again.
    expect(w.fieldsOf(task).Count).toBe(4);

    await expect(w.executor.retry({ automationId: TASKS, claimId: "atc_forgotten", startOver: true }))
      .resolves.toEqual({ status: "refused", reason: "Run history no longer shows this run, so dohc will not run it again." });
  });

  it("keeps a settle the engine refused while it still holds the claim as running, and says so", async () => {
    const refused = { settle: 1, stillRunning: true };
    const w = await world({ refused, automations: { Tasks: "  - id: note\n    name: Note\n    when: {field-changed: Status}\n    do: [{set: {Note: seen}}]\n" } });
    const claim = w.claim("collection:Tasks#note", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.until(() => w.errors.some((entry) => entry.context === `settle automation claim "${claim.claimId}"`));
    expect(claim.state).toBe("running");
    w.executor.notifyClaimed();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(w.journaled).toHaveLength(1);
  });

  it("gives a restart its own keys and records even after history dropped the run it replaces", async () => {
    const stepsOf = (title: string) =>
      `  - id: log\n    name: Log\n    when: {field-changed: Status}\n    do:\n      - set: {Count: '=record.Count + 1'}\n      - add-record: {Title: ${title}}\n        collection: Log\n      - set: {Note: done}\n`;
    const A = stepsOf("A");
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: A } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    // A applies its first two steps, and its third cannot open the record.
    w.failOpenAt(3);
    const claim = w.claim("collection:Tasks#log", task);
    await w.executor.open();
    await w.settledClaim(claim);
    const hashA = (await w.baseStore.runsOf("collection:Tasks#log", claim.claimId)).runs[0]!.definitionHash;
    const reload = async (text: string) => {
      await w.writeAutomations("Tasks", text);
      const drained = w.idleDrains();
      w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
      await w.until(() => w.idleDrains() > drained);
    };
    // A confirmed restart under B fails at its first write.
    await reload(stepsOf("B"));
    w.failures.openSession = 1;
    await w.executor.retry({ automationId: "collection:Tasks#log", claimId: claim.claimId, startOver: true });
    await w.until(() => claim.state === "failed" && claim.run === 2);
    // Pruning drops A's superseded run while B's failure stays.
    const folder = join(w.root, ".dohc", "automations", "runs");
    for (const automation of await readdir(folder)) {
      for (const file of await readdir(join(folder, automation))) {
        if (!file.endsWith(".json")) continue;
        const saved = JSON.parse(await readFile(join(folder, automation, file), "utf8")) as { definitionHash: string };
        if (saved.definitionHash !== hashA) continue;
        await rm(join(folder, automation, file));
        await rm(join(folder, automation, file.replace(/\.json$/, ".progress.jsonl")), { force: true });
      }
    }
    // A comes back, and a restart under it is confirmed.
    await reload(A);
    await w.executor.retry({ automationId: "collection:Tasks#log", claimId: claim.claimId, startOver: true });
    await w.until(() => claim.state === "done" || (claim.state === "failed" && claim.run === 3));
    expect(claim.error).toBeUndefined();
    expect(claim.state).toBe("done");
    // The restart added its own record instead of taking the first run's.
    expect([...w.records.values()].filter((record) => record.collection === "Log")).toHaveLength(2);
    expect(w.fieldsOf(task)).toMatchObject({ Count: 4, Note: "done" });
  });
  it("waits instead of failing when the engine restarts in the middle of a write, and resumes after", async () => {
    let pauseNext = true;
    const paused = Promise.withResolvers<void>();
    const w = await world({
      automations: { Tasks: "  - id: seen\n    name: Seen\n    when: {field-changed: Status}\n    do: [{set: {Seen: true}}]\n" },
      withRecordWrites: (signal) => {
        if (!pauseNext) return Promise.resolve();
        pauseNext = false;
        // The engine restarts while this write waits on it.
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("The write stopped.")), { once: true });
          w_.executor.pauseForEngineRestart();
          paused.resolve();
        });
      },
    });
    const w_ = w;
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const claim = w.claim("collection:Tasks#seen", task);
    await w.executor.open();
    await paused.promise;
    expect(claim.state).toBe("running");
    w.executor.resumeAfterEngineRestart();
    await w.settledClaim(claim);
    expect(claim).toMatchObject({ state: "done" });
    expect(claim.error).toBeUndefined();
    expect(w.fieldsOf(task).Seen).toBe(true);
    const [run] = (await w.baseStore.runsOf("collection:Tasks#seen", claim.claimId)).runs;
    expect(run!.outcome).toEqual({ state: "done" });
  });

  it("keeps every automation waiting when the saved verdicts cannot be read, until the holds are reset and allowed", async () => {
    const w = await world({ automations: { Tasks: "  - id: seen\n    name: Seen\n    when: {field-changed: Status}\n    do: [{set: {Seen: true}}]\n" } });
    await mkdir(join(w.root, ".dohc", "automations"), { recursive: true });
    await writeFile(join(w.root, ".dohc", "automations", "reach.json"), "{ torn");
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const claim = w.claim("collection:Tasks#seen", task);
    await w.executor.open();
    await w.until(() => w.events.includes(`released ${claim.claimId}`));
    expect(w.executor.holdState()).toEqual({ holds: [], stops: [], unreadable: true });
    expect(await w.executor.automationsIn("Tasks")).toMatchObject({ automations: [{ reach: { kind: "waiting", reason: UNREADABLE_REACH } }] });
    // Nothing overwrote the file dohc could not read.
    expect(await readFile(join(w.root, ".dohc", "automations", "reach.json"), "utf8")).toBe("{ torn");

    // Every run waits, so no field is marked.
    await expect(w.executor.fieldMarks("Tasks")).resolves.toEqual([]);

    await expect(w.executor.resetHolds()).resolves.toBe("reset");
    const { holds, unreadable } = w.executor.holdState();
    expect(unreadable).toBe(false);
    expect(holds).toMatchObject([{ automationId: "collection:Tasks#seen", step: 0, stoppedFor: null }]);
    await w.executor.confirmReach({ automationId: holds[0]!.automationId, definitionHash: holds[0]!.definitionHash, step: 0, seq: holds[0]!.seq });
    await w.settledClaim(claim);
    expect(w.fieldsOf(task).Seen).toBe(true);
  });

  it("resumes an added record under the id the engine gave it when its fields failed to save", async () => {
    const log = "  - id: log\n    name: Log\n    when: {field-changed: Status}\n    do: [{add-record: {Title: Logged}, collection: Log}]\n";
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: log } });
    const parsed = parseAutomationsFile(`version: 1\nautomations:\n${log}`);
    if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw new Error("Not a valid automation.");
    const claim = w.claim("collection:Tasks#log", w.addRecord("Tasks", "one", { Status: "Done" }));
    // The derived id is taken, so the engine adopts the new file under another.
    w.occupy(derivedRecordId(stepKey(claim.claimId, `${definitionHash(parsed.entries[0].automation)}-1`, 0)));
    w.failures.openSession = 1;
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("failed");
    await w.executor.retry({ automationId: "collection:Tasks#log", claimId: claim.claimId, startOver: false });
    await w.until(() => claim.state !== "pending" && claim.state !== "running");
    expect(claim.error).toBeUndefined();
    const added = [...w.records.values()].filter((record) => record.collection === "Log");
    expect(added.map((record) => record.id)).toEqual([`rec_${"reminted".padEnd(26, "a")}`]);
    expect(w.fieldsOf(added[0]!)).toEqual({ Title: "Logged" });
  });

  it("writes the plan once and records each effect after it", async () => {
    const w = await world({ automations: { Tasks: "  - id: three\n    name: Three\n    when: {field-changed: Status}\n    do: [{set: {A: 1}}, {set: {B: 2}}, {set: {C: 3}}]\n" } });
    const claim = w.claim("collection:Tasks#three", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);
    // The plan before the first write, and the outcome after the last.
    expect(w.saves()).toBe(2);
    expect(w.effectRecords()).toBe(3);
  });

  it("shows reach from the roster it has, without listing again", async () => {
    const w = await world({ automations: { Tasks: "  - id: seen\n    name: Seen\n    when: {field-changed: Status}\n    do: [{set: {Seen: true}}]\n" } });
    await w.executor.open();
    await w.until(() => w.idleDrains() >= 1);
    const listings = w.rosterCalls();
    await w.executor.automationsIn("Tasks");
    expect(w.rosterCalls()).toBe(listings);
  });

  it("fails a claim for an automation this version cannot run, with the reason the panel shows", async () => {
    const w = await world({ automations: { Tasks: "  - id: later\n    name: Later\n    when: {schedule: day, timezone: UTC}\n    do: [{find: 'true', as: all}]\n" } });
    const claim = w.claim("collection:Tasks#later", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim).toMatchObject({
      state: "failed",
      error: "dohc can run automations that start from a record change. Other triggers come later.",
    });
    expect(w.journaled).toEqual([]);
  });

  it("leaves a run to the next drain when a pause lands as its last effect is recorded", async () => {
    const w = await world({ automations: { Tasks: "  - id: seen\n    name: Seen\n    when: {field-changed: Status}\n    do: [{set: {Seen: true}}]\n" } });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const paused = Promise.withResolvers<void>();
    w.beforeNextRecord(() => {
      w.executor.pauseForEngineRestart();
      paused.resolve();
    });
    const claim = w.claim("collection:Tasks#seen", task);
    await w.executor.open();
    await paused.promise;
    // Closing waits for the stopped run and hands its claim back.
    await w.executor.dispose();
    const [waiting] = (await w.baseStore.runsOf("collection:Tasks#seen", claim.claimId)).runs;
    expect(waiting).toMatchObject({ outcome: null, applied: [{ ordinal: 0 }] });
    await w.makeExecutor().open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(w.journaled).toHaveLength(1);
  });

  it("settles a claim for a switched-off automation as done, even one this version cannot run", async () => {
    const w = await world({ automations: { Tasks: "  - id: later\n    name: Later\n    enabled: false\n    when: {schedule: day, timezone: UTC}\n    do: [{find: 'true', as: all}]\n" } });
    const claim = w.claim("collection:Tasks#later", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(w.failuresChanged).toEqual([]);
  });

  it("marks each field switched-on automations set, in the Collection they set it, and names them", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: [
      BUMP,
      "  - id: stamp",
      "    name: Stamp",
      "    when: {field-changed: Status, to: Done}",
      "    do: [{set: {Count: 0, Finished on: '=today()'}}]",
      "  - id: idle",
      "    name: Idle",
      "    enabled: false",
      "    when: record-added",
      "    do: [{set: {Idle: true}}]",
    ].join("\n") } });
    await expect(w.executor.fieldMarks("Tasks")).resolves.toEqual([]);
    await w.executor.open();
    expect(w.automationsChanged()).toBe(1);
    await expect(w.executor.fieldMarks("Tasks")).resolves.toEqual([
      { field: "Count", automations: ["Bump", "Stamp"] },
      { field: "Finished on", automations: ["Stamp"] },
    ]);
    await expect(w.executor.fieldMarks("Log")).resolves.toEqual([{ field: "Title", automations: ["Bump"] }]);
    expect(w.executor.automationName(TASKS)).toBe("Bump");

    // A reload says so once it has read the file again. A broken entry keeps its name.
    await w.writeAutomations("Tasks", BUMP.replace("name: Bump", "name: Bump the count").replace("{field-changed: Status}", "whenever"));
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    await w.until(() => w.executor.automationName(TASKS) === "Bump the count");
    await expect(w.executor.fieldMarks("Tasks")).resolves.toEqual([]);
    expect(w.executor.automationName(TASKS)).toBe("Bump the count");
    expect(w.executor.automationName("collection:Tasks#stamp")).toBeNull();
  });

  it("marks only what a run would write: no dataset, no missing Collection, no stopped step", async () => {
    const w = await world({ collections: ["Tasks", "Log", "Ledger"], automations: { Tasks: [
      BUMP,
      "  - id: stamp",
      "    name: Stamp",
      "    when: {field-changed: Status, to: Done}",
      "    do: [{set: {Count: 0}}]",
      "  - id: post",
      "    name: Post",
      "    when: {field-changed: Status}",
      "    do: [{set: {Posted: true}}, {add-record: {Amount: 1}, collection: Ledger}]",
      "  - id: lost",
      "    name: Lost",
      "    when: {field-changed: Status}",
      "    do: [{set: {Lost: true}}, {add-record: {Amount: 1}, collection: Nowhere}]",
    ].join("\n") } });
    await writeFile(join(w.root, "Ledger", "dataset.json"), "{}\n");
    // Ana edits Tasks but not Log, so Bump's step into Log is stopped.
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("ana@dohc.test", ["Tasks"])] });
    await w.executor.open();
    await w.executor.automationsIn("Tasks");
    await expect(w.executor.fieldMarks("Tasks")).resolves.toEqual([{ field: "Count", automations: ["Stamp"] }]);
    await expect(w.executor.fieldMarks("Ledger")).resolves.toEqual([]);
    await expect(w.executor.fieldMarks("Nowhere")).resolves.toEqual([]);

    // Ana's share ends. Bump's step now waits for a current editor, so it
    // still writes nothing, and the marks hear that the verdict changed.
    const changes = w.automationsChanged();
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [] });
    w.executor.rosterChanged();
    const bumpHold = () => w.executor.holds().find((hold) => hold.automationName === "Bump");
    await w.until(() => bumpHold() !== undefined && w.automationsChanged() > changes);
    await expect(w.executor.fieldMarks("Tasks")).resolves.toEqual([{ field: "Count", automations: ["Stamp"] }]);
    await w.executor.confirmReach(bumpHold()!);
    await expect(w.executor.fieldMarks("Tasks")).resolves.toEqual([{ field: "Count", automations: ["Bump", "Stamp"] }]);
    await expect(w.executor.fieldMarks("Log")).resolves.toEqual([{ field: "Title", automations: ["Bump"] }]);
  });

  it("says before a share which steps it would stop, and after it, names the steps it stopped until dismissed", async () => {
    const w = await world({ collections: ["Trip", "Budget"], automations: { Trip: [
      "  - id: spend",
      "    name: Spend",
      "    when: {field-changed: Status}",
      "    do: [{add-record: {Amount: 5}, collection: Budget}]",
      "  - id: idle",
      "    name: Idle",
      "    enabled: false",
      "    when: {field-changed: Status}",
      "    do: [{add-record: {Amount: 1}, collection: Budget}]",
    ].join("\n") } });
    await w.executor.open();
    await w.executor.automationsIn("Trip");
    const share = { paths: ["Trip"], versionId: null, access: "edit" as const, recipientEmail: "ana@dohc.test" };
    // A switched-off automation stops nothing it was doing.
    await expect(w.executor.shareImpact(share)).resolves.toEqual([
      { automationId: "collection:Trip#spend", automationName: "Spend", collectionPath: "Trip", target: "Budget", action: "change" },
    ]);
    await expect(w.executor.shareImpact({ ...share, recipientEmail: null })).resolves.toHaveLength(1);
    await expect(w.executor.shareImpact({ ...share, access: "view" })).resolves.toEqual([]);

    // Ana gets Edit on Trip. Her reach stops the step, and one notice says so.
    const before = w.holdsChanged();
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("ana@dohc.test", ["Trip"])] });
    w.executor.rosterChanged();
    await w.until(() => w.holdsChanged() > before);
    const [stop, ...rest] = w.executor.stops();
    expect(rest).toEqual([]);
    expect(stop).toMatchObject({
      automationName: "Spend", collection: "Trip", target: "Budget", action: "change", stoppedFor: "ana@dohc.test",
    });

    // Reading the verdicts again keeps the notice; dismissing the verdict it showed ends it.
    await w.executor.automationsIn("Trip");
    expect(w.executor.stops()).toHaveLength(1);
    await w.executor.dismissStops([{ ...stop!, seq: stop!.seq + 1 }]);
    expect(w.executor.stops()).toHaveLength(1);
    await w.executor.dismissStops([stop!]);
    expect(w.executor.stops()).toEqual([]);
    await w.executor.automationsIn("Trip");
    expect(w.executor.stops()).toEqual([]);
    // After a restart the dismissal holds, because the verdicts are saved.
    await w.executor.dispose();
    const restarted = w.makeExecutor();
    await restarted.open();
    await restarted.automationsIn("Trip");
    expect(restarted.stops()).toEqual([]);
  });

  it("ends the notice for a stopped step when its automation is switched off, and does not raise it again", async () => {
    const spend = [
      "  - id: spend",
      "    name: Spend",
      "    when: {field-changed: Status}",
      "    do: [{add-record: {Amount: 5}, collection: Budget}]",
    ].join("\n");
    const w = await world({ collections: ["Trip", "Budget"], automations: { Trip: spend } });
    await w.executor.open();
    await w.executor.automationsIn("Trip");
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("ana@dohc.test", ["Trip"])] });
    w.executor.rosterChanged();
    await w.until(() => w.executor.stops().length === 1);

    await w.writeAutomations("Trip", spend.replace("    name: Spend", "    name: Spend\n    enabled: false"));
    w.executor.handleWatcherEvents([{ operation: "update", path: "Trip/automations.yaml" }]);
    await w.until(() => !w.subscriptions.has("collection:Trip#spend"));
    expect(w.executor.stops()).toEqual([]);
    // Reading the verdicts records them under the switched-off definition.
    await w.executor.automationsIn("Trip");
    // Switched on again, it is still stopped, and the ⚡ panel says so; the notice is not raised again.
    await w.writeAutomations("Trip", spend);
    w.executor.handleWatcherEvents([{ operation: "update", path: "Trip/automations.yaml" }]);
    await w.until(() => w.subscriptions.has("collection:Trip#spend"));
    await w.executor.automationsIn("Trip");
    expect(w.executor.stops()).toEqual([]);
  });
});
