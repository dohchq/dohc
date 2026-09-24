import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { AutomationEvaluator } from "@dohc/app-backend-runtime/automation";
import type { CollectionQueryFilter, CollectionRecord } from "@dohc/workspace-contracts/collection";
import type { AutomationClaim, ChangeAttributionWire } from "@dohc/workspace-engine-client";
import type { CollectionRecordEditContext } from "../workspaces/collectionRecordEdits";
import type { WorkspaceEngineYDocProviderSession } from "../workspaces/workspaceEngineCapture";
import { createTestScratch } from "../workspaces/testTemp";
import { createAutomationFormulaEvaluator, type AutomationFormulaEvaluator } from "./automationEvaluatorHost";
import { localIsoTime } from "./automationPlan";
import type { ReachRoster, RosterGrant } from "./automationReach";
import { createAutomationRunStore, type AutomationRunStore } from "./automationRunStore";
import { CollectionAutomations, TIMEOUTS_BEFORE_SWITCH_OFF, type CollectionAutomationEngine } from "./collectionAutomations";
import { DEADLINE_ERROR, DEFINITION_CHANGED_ERROR } from "./collectionAutomationRun";

// The executor against an in-memory engine and record store: claims, record
// documents with the engine's idempotency rule, and files adopted as records.
// Formulas run in the real evaluator.

const evaluator = createAutomationFormulaEvaluator();
afterAll(() => evaluator.close());

const OWNER: ReachRoster = { kind: "owner", ownerUserId: "user-owner", grants: [] };
const editor = (email: string, paths: string[]): RosterGrant => ({
  recipientUserId: `user-${email}`, recipientEmail: email,
  files: { paths, versionId: null, access: "edit" }, channel: null,
});

interface FakeRecord { id: string; path: string; collection: string; doc: Y.Doc }

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function world(options: {
  collections?: string[];
  automations: Record<string, string>;
  evaluator?: AutomationFormulaEvaluator;
  deadline?: (abort: () => void) => () => void;
  withRecordWrites?: (signal: AbortSignal, events: string[]) => Promise<void>;
}) {
  const root = await createTestScratch("dohc-collection-automations-");
  const collections = options.collections ?? ["Tasks"];
  for (const collection of collections) {
    await mkdir(join(root, collection), { recursive: true });
    await writeFile(join(root, collection, "collection.yaml"), "fields: []\n");
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
  const failures = { authoredWrite: 0 };
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
      const claim = claims.get(claimId)!;
      claim.state = state;
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
  };

  const capture: CollectionRecordEditContext["capture"] = {
    async openYDocSession({ path }) {
      const record = [...records.values()].find((candidate) => candidate.path === path);
      if (!record) throw new Error(`No record at ${path}.`);
      return {
        get initialUpdate() { return Y.encodeStateAsUpdate(record.doc); },
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
      } as unknown as WorkspaceEngineYDocProviderSession;
    },
    async writeAuthoredTextFile(absolutePath, text, author, writeOptions) {
      if (failures.authoredWrite > 0) {
        failures.authoredWrite -= 1;
        throw new Error("dohc could not write the record file.");
      }
      const path = relative(root, absolutePath).replaceAll("\\", "/");
      authored.push({ path, author });
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, text, { flag: writeOptions?.createOnly ? "wx" : "w" });
      // The engine adopts the file under the id its frontmatter names.
      const id = /id: (rec_[a-z2-7]+)/.exec(text)![1]!;
      records.set(id, { id, path, collection: dirname(path).replaceAll("\\", "/"), doc: new Y.Doc() });
      queueMicrotask(() => { for (const listener of settleListeners) listener([path]); });
      return { resolvedAbsolutePath: absolutePath };
    },
  };

  let roster: ReachRoster = OWNER;
  let beforeRoster: (() => Promise<void>) | null = null;
  const baseStore = createAutomationRunStore(root);
  let failSaveAt: number | null = null;
  let saves = 0;
  const store: AutomationRunStore = {
    ...baseStore,
    save: async (run) => {
      saves += 1;
      if (saves === failSaveAt) throw new Error("The disk is full.");
      await baseStore.save(run);
    },
  };
  const failuresChanged: string[] = [];
  const errors: Array<{ context: string; error: unknown }> = [];
  const executor = new CollectionAutomations({
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
    roster: async () => {
      const current = roster;
      const hook = beforeRoster;
      beforeRoster = null;
      await hook?.();
      return current;
    },
    evaluator: options.evaluator ?? evaluator,
    store,
    onFailuresChanged: () => { failuresChanged.push("changed"); wake(); },
    onError: (context, error) => { errors.push({ context, error }); },
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
  });

  let claimCount = 0;
  const claim = (automationId: string, record: FakeRecord, change: Partial<AutomationClaim["change"]> = {}) => {
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
    root, executor, engine, records, journaled, authored, subscriptions, events, failures, errors, failuresChanged,
    addRecord, claim, settledClaim, until, writeAutomations, baseStore,
    requeue: (claim: AutomationClaim) => { pending.push(claim); },
    fieldsOf,
    idleDrains: () => idleDrains,
    setRoster: (next: ReachRoster) => { roster = next; },
    beforeNextRoster: (hook: () => Promise<void>) => { beforeRoster = hook; },
    failSaveAt: (index: number) => { failSaveAt = saves + index; },
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
    // Each field is its own effect, keyed by the claim, the definition, the step, the record, and the field.
    expect(w.journaled.map((entry) => entry.idempotencyKey)).toEqual([
      `${claim.claimId}/${hash}/0/${task.id}/Finished on`,
      `${claim.claimId}/${hash}/0/${task.id}/Note`,
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
    // The plan saves first; the second save records step 1, after its write landed.
    w.failSaveAt(2);
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
      evaluator: createAutomationFormulaEvaluator(() => ({ evaluate: timedOut, runCode: async () => { throw new Error("unused"); }, close: async () => undefined })),
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
        close: async () => undefined,
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
});
