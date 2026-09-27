import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { AutomationEvaluator } from "@dohc/app-backend-runtime/automation";
import { AUTOMATION_NEVER_STARTED_REFUSAL } from "@dohc/app-backend-runtime/dataset-automation-claims";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import type { CollectionQueryFilter, CollectionRecord } from "@dohc/workspace-contracts/collection";
import type { AutomationClaim, AutomationClaimMessage, AutomationGroupHandover, AutomationGroupRelayRecord, ChangeAttributionWire } from "@dohc/workspace-engine-client";
import type { RelayAutomationHost } from "@dohc/workspace-contracts/relay";
import { derivedRecordId } from "@dohc/automation-executor/record-ids";
import { collectionRecordWrites, type CollectionRecordEditContext } from "../workspaces/collectionRecordEdits";
import type { WorkspaceEngineYDocProviderSession } from "../workspaces/workspaceEngineCapture";
import { createTestScratch } from "../workspaces/testTemp";
import { resolveWorkspaceMetadataDir } from "../workspaces/workspaceMetadata";
import { generateDatasetSources } from "../workspaces/datasetGenerator";
import { createLocalDatasetHost } from "../workspaces/localDatasetHost";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { createAutomationFormulaEvaluator, type AutomationFormulaEvaluator } from "@dohc/automation-executor/automation-evaluator-host";
import { definitionHash, localIsoTime, stepKey } from "@dohc/automation-executor/automation-plan";
import { PERSONAL_NEEDS_ACCOUNT, type ReachRoster, type RosterGrant } from "@dohc/automation-executor/automation-reach";
import { createAutomationRunStore, type AutomationRunStore, type ReportedFailure, type StoredRun, type StoredSubscription } from "@dohc/automation-executor/automation-run-store";
import { automationHostGeneration, createAutomationHosts, HANDOVER_READ_FIRST_MS, HOST_FRESH_MS, type AutomationHosts } from "./automationHost";
import { recordNeverSynced, recordSynced } from "../workspaces/syncHistory";
import {
  CollectionAutomations,
  TIMEOUTS_BEFORE_SWITCH_OFF,
  UNREADABLE_REACH,
  type AutomationFailureReport,
  type AutomationSwitchedOff,
  type CollectionAutomationEngine,
  type CollectionAutomationsOptions,
} from "@dohc/automation-executor/collection-automations";
import { DEADLINE_ERROR, DEFINITION_CHANGED_ERROR, GROUP_CHANGED_ERROR, LOST_COLLECTION_ERROR, UNDONE_RUN_ERROR, UNREADABLE_RUN_ERROR } from "@dohc/automation-executor/collection-automation-run";
import {
  AutomationChatSessionWait,
  automationMessageId,
  automationNoticeId,
  automationWakeThreadId,
  chatDirectoryOf,
  NoticeNotSentError,
  type AutomationChatMessage,
  type AutomationNotice,
  type ChatDirectoryChannel,
  type ChatNeeds,
} from "@dohc/automation-executor/automation-chat";

type RecordChange = Exclude<AutomationClaim["change"], { kind: "message" }>;

// The executor against an in-memory engine and record store: claims, record
// documents with the engine's idempotency rule, and files adopted as records.
// Formulas run in the real evaluator.

const sharedEvaluator = createAutomationFormulaEvaluator();
afterAll(() => sharedEvaluator.close());
const evaluator = sharedEvaluator.forWorkspace("workspace");

const OWNER: ReachRoster = { kind: "owner", ownerUserId: "user-owner", grants: [] };
const editor = (email: string, paths: string[]): RosterGrant => ({
  grantId: `grant-${email}`, recipientUserId: `user-${email}`, recipientEmail: email,
  files: { paths, versionId: null, access: "edit" }, channel: null,
});

interface FakeRecord { id: string; path: string; collection: string; doc: Y.Doc }

// Every field these tests name. A field a Collection lacks keeps its
// automation off, so each test Collection defines them all.
const FIELDS = [
  "Status", "Count", "Note", "Title", "Mark", "X", "Seen", "Amount", "Points", "Swept", "Checked",
  "Project", "Finished on", "Archived on", "Paid", "Paid by", "Pressed", "Button", "Total", "A", "B", "C", "D", "E", "Details", "Stamped", "Asked by",
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
  /** The workspace's chats, for automations that post. */
  channels?: ChatDirectoryChannel[];
  /** Whether this computer is the automation host; true unless a test says otherwise. */
  runsGroupTriggers?: boolean;
  /** Whole message bodies by id, for claims that carried them truncated. */
  messageBodies?: Record<string, string>;
  /** Who may run a failed press again. Everyone, unless a test says otherwise. */
  mayRetryPress?: (pressedBy: string | null) => Promise<boolean>;
}) {
  const root = await createTestScratch("dohc-collection-automations-");
  // Each Collection's path, with the object id of its collection.yaml, which
  // a move keeps. A test Collection's id is its first path's name, so the
  // automation ids the tests name read as "collection:Tasks#bump".
  const collections = new Map((options.collections ?? ["Tasks"]).map((path) => [path, path.replaceAll("/", "-")]));
  for (const collection of collections.keys()) {
    await mkdir(join(root, collection), { recursive: true });
    await writeFile(join(root, collection, "collection.yaml"), SCHEMA);
  }
  const summaryOf = (path: string) => ({ path, objectId: collections.get(path) ?? "object-gone", status: "valid" as const, reasons: [] });
  const writeAutomations = async (collection: string, body: string) =>
    await writeFile(join(root, collection, "automations.yaml"), `version: 1\nautomations:\n${body}`);
  for (const [collection, body] of Object.entries(options.automations)) await writeAutomations(collection, body);

  const records = new Map<string, FakeRecord>();
  let claimCount = 0;
  const journal = new Map<string, string>();
  const journaled: Array<{ path: string; field?: string; idempotencyKey?: string; actorOriginId?: string; attribution?: ChangeAttributionWire }> = [];
  const authored: Array<{ path: string; author: unknown }> = [];
  const claims = new Map<string, AutomationClaim>();
  const pending: AutomationClaim[] = [];
  const presses = new Map<string, string>();
  const pressEvents: unknown[] = [];
  const subscriptions = new Map<string, StoredSubscription>();
  // The host generation the engine last watched Group subscriptions at, and
  // the relay record each new generation read.
  let groupGeneration = 0;
  const relayRecords: AutomationGroupRelayRecord[] = [];
  const groupSkips: { aheadAtMs: number | null; lateAtMs: number | null } = { aheadAtMs: null, lateAtMs: null };
  // Each Group message skip the owner was told about.
  const skipNotices: Array<{ reason: string; atMs: number }> = [];
  const frozenGroups = new Map<string, StoredSubscription>();
  const marks = new Map<string, Awaited<ReturnType<CollectionAutomationEngine["listAutomationScheduleMarks"]>>["marks"][number]>();
  const settleListeners = new Set<(paths: readonly string[] | null) => void>();
  const waiters = new Set<() => void>();
  const events: string[] = [];
  // Messages the automations wrote, once per effect as the engine keeps them.
  const messages: AutomationChatMessage[] = [];
  let chatWrites = 0;
  let beforeChatWrite: ((message: AutomationChatMessage) => Promise<void>) | null = null;
  // What each directory read was asked for.
  const directoryNeeds: ChatNeeds[] = [];
  // The run signal each notice was sent under.
  const noticeSignals: AbortSignal[] = [];
  // Notices the automations sent, once per id as the outbox keeps them.
  const notices: AutomationNotice[] = [];
  let beforeNotice: ((notice: AutomationNotice) => Promise<void>) | null = null;
  let idleDrains = 0;
  // Each count fails that many of the next calls.
  const failures = { authoredWrite: 0, openSession: 0 };
  // Fails the one record session opened this many calls from now.
  let opens = 0;
  let failOpenAt: number | null = null;
  let holdsChanged = 0;
  let automationsChanged = 0;
  let hostRequests = 0;
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
    listCollections: async () => ({ collections: [...collections.keys()].map(summaryOf) }),
    getCollectionRecord: async ({ collectionPath, recordId }) => {
      const record = records.get(recordId);
      if (!record || record.collection !== collectionPath) throw new Error("collection-record-not-found");
      return { collection: summaryOf(collectionPath), record: collectionRecord(record), history: [], nextBeforeHistoryId: null };
    },
    queryCollectionRecords: async ({ collectionPath, filter, limit }) => {
      const matching = [...records.values()].filter((record) => record.collection === collectionPath && matches(record, filter));
      const page = matching.slice(0, limit);
      const last = page.at(-1);
      return {
        collection: summaryOf(collectionPath),
        records: page.map(collectionRecord),
        groups: null,
        nextCursor: matching.length > page.length && last
          ? { sortValues: [], recordPath: last.path, recordId: last.id }
          : null,
      };
    },
    subscribeAutomation: async (input) => { subscriptions.set(input.automationId, input); wake(); return { subscribed: true }; },
    unsubscribeAutomation: async ({ automationId }) => { subscriptions.delete(automationId); wake(); return { unsubscribed: true }; },
    // The engine's Group rules: a release freezes them all and answers the
    // handover, the same when repeated; a watch at a host generation it has
    // not watched at asks for the relay's record first, then sets the whole
    // set.
    releaseAutomationGroups: async () => {
      for (const subscription of [...subscriptions.values()]) {
        if (!("groupId" in subscription)) continue;
        subscriptions.delete(subscription.automationId);
        frozenGroups.set(subscription.automationId, subscription);
      }
      wake();
      return {
        watchedGeneration: groupGeneration,
        handover: {
          floorMs: 0,
          automations: [...frozenGroups.keys()].map((automationId) => ({
            automationId, sinceMs: 0, decided: [{ messageId: "m-decided", createdAtMs: 1 }],
          })),
        },
      };
    },
    watchAutomationGroups: async ({ generation, subscriptions: watching, relay }) => {
      if (generation !== groupGeneration && relay === undefined) return { needsHandover: true };
      if (generation !== groupGeneration) {
        groupGeneration = generation;
        if (relay !== undefined) relayRecords.push(relay);
      }
      for (const [automationId, subscription] of [...subscriptions]) {
        if ("groupId" in subscription) subscriptions.delete(automationId);
      }
      frozenGroups.clear();
      for (const { automationId, groupId, startsWith } of watching) {
        subscriptions.set(automationId, startsWith === undefined ? { automationId, groupId } : { automationId, groupId, startsWith });
      }
      wake();
      return { needsHandover: false };
    },
    claimNextAutomation: async () => {
      // As the engine does, it serves only a claim still pending, never one inserted failed.
      while (pending[0] !== undefined && pending[0].state !== "pending") pending.shift();
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
    // Pages as the engine does: newest first by when each claim was made, then by id.
    listAutomationClaims: async ({ automationId, before, limit = 20 }) => {
      const [atMs, id] = before === undefined ? [Infinity, ""] : [Number(before.slice(0, before.indexOf(":"))), before.slice(before.indexOf(":") + 1)];
      const listed = [...claims.values()]
        .filter((claim) => claim.automationId === automationId && (claim.createdAtMs < atMs || (claim.createdAtMs === atMs && claim.claimId < id)))
        .sort((left, right) => right.createdAtMs - left.createdAtMs || (left.claimId < right.claimId ? 1 : -1));
      const last = listed[limit - 1];
      return { claims: listed.slice(0, limit), next: listed.length > limit && last ? `${last.createdAtMs}:${last.claimId}` : null };
    },
    getAutomationClaim: async (input: { claimId: string } | { automationId: string; key: string }) => {
      const claim = [...claims.values()].find((candidate) => "claimId" in input
        ? candidate.claimId === input.claimId
        : candidate.automationId === input.automationId && "key" in candidate.trigger && candidate.trigger.key === input.key);
      return { claim: claim ?? null };
    },
    pruneAutomationHistory: async ({ keep }) => {
      historyPrunes.push(keep);
      wake();
      return { pruned: 0, more: false };
    },
    // When Group messages last started nothing here, as the engine records it.
    readAutomationGroupSkips: async () => ({ ...groupSkips }),
    // Each automation's failure most recently settled, as the failure notice shows it.
    listAutomationFailures: async () => {
      const newest = new Map<string, AutomationClaim>();
      for (const claim of claims.values()) {
        const known = newest.get(claim.automationId);
        if (claim.state === "failed" && (!known || claim.updatedAtMs > known.updatedAtMs)) newest.set(claim.automationId, claim);
      }
      // The engine's count: every failed claim, and every retry of one.
      const generation = (automationId: string) => [...claims.values()]
        .filter((claim) => claim.automationId === automationId)
        .reduce((sum, claim) => sum + claim.run - 1 + (claim.state === "failed" ? 1 : 0), 0);
      return {
        failures: [...newest.values()].map(({ automationId, claimId, attempts, error, updatedAtMs }) => ({
          automationId, claimId, chainStopped: attempts === 0, error: error ?? "", updatedAtMs, generation: generation(automationId),
        })),
      };
    },
    // The engine's rules: a new or changed schedule only sets its mark, and
    // each due time claims once.
    claimAutomationSchedule: async ({ automationId, scheduleHash, run, throughMs }) => {
      const mark = marks.get(automationId);
      const inserted: AutomationClaim[] = [];
      if (mark?.scheduleHash === scheduleHash) {
        for (const due of run) {
          if ([...claims.values()].some((known) => known.automationId === automationId && "key" in known.trigger && known.trigger.key === `schedule:${due}`)) continue;
          claimCount += 1;
          const created: AutomationClaim = {
            claimId: `atc_claim${claimCount}`, automationId, trigger: { key: `schedule:${due}` },
            recordId: null, collectionPath: null, depth: 0,
            change: { kind: "schedule", authorOriginId: null, actorKind: null, onBehalfOf: null, sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 },
            state: "pending", attempts: 0, run: 1, createdAtMs: due + 1_000, updatedAtMs: 0,
          };
          claims.set(created.claimId, created);
          pending.push(created);
          inserted.push(created);
        }
      }
      const next = { automationId, scheduleHash, throughMs };
      marks.set(automationId, next);
      return { claims: inserted, mark: next };
    },
    listAutomationScheduleMarks: async () => ({ marks: [...marks.values()] }),
    runAutomationNow: async ({ automationId, noticeId }) => {
      const key = `run-now:${noticeId}`;
      const known = [...claims.values()].find((claim) => claim.automationId === automationId && "key" in claim.trigger && claim.trigger.key === key);
      if (known) return { claim: known };
      claimCount += 1;
      const created: AutomationClaim = {
        claimId: `atc_claim${claimCount}`, automationId, trigger: { key },
        recordId: null, collectionPath: null, depth: 0,
        change: { kind: "schedule", authorOriginId: null, actorKind: null, onBehalfOf: null, sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 },
        state: "pending", attempts: 0, run: 1, createdAtMs: Date.UTC(2026, 8, 25, 12), updatedAtMs: 0,
      };
      claims.set(created.claimId, created);
      pending.push(created);
      return { claim: created };
    },
    // The engine's press rules: a remembered press id answers its claim; the
    // same person's press joins a pending or running claim; anyone else's is busy.
    pressAutomation: async ({ pressId, automationId, recordId, pressedBy, by }) => {
      const summary = (claim: AutomationClaim) => {
        const { fields: _fields, fieldsOmitted: _omitted, ...change } = claim.change;
        return { ...claim, change };
      };
      const remembered = presses.get(pressId);
      if (remembered) return { busy: false, claim: summary(claims.get(remembered)!) };
      const active = [...claims.values()].find((claim) => claim.automationId === automationId && claim.recordId === recordId &&
        claim.change.kind === "button" && (claim.state === "pending" || claim.state === "running"));
      if (active && active.change.onBehalfOf !== pressedBy) return { busy: true, claim: null };
      const claim = active ?? (() => {
        claimCount += 1;
        const record = records.get(recordId)!;
        const created: AutomationClaim = {
          claimId: `atc_claim${claimCount}`, automationId, trigger: { key: `press:${pressId}` },
          recordId, collectionPath: null, depth: by.kind === "agent" ? by.depth : 0,
          change: {
            kind: "button", authorOriginId: by.kind === "agent" ? by.originId : null, actorKind: by.kind, onBehalfOf: pressedBy, sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0,
          },
          state: "pending", attempts: 0, run: 1, createdAtMs: Date.UTC(2026, 8, 25, 2, 0), updatedAtMs: 0,
        };
        claims.set(created.claimId, created);
        pending.push(created);
        return created;
      })();
      presses.set(pressId, claim.claimId);
      return { busy: false, claim: summary(claim) };
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
            if (journal.get(key) !== bytes) throw new Error("idempotency-key-reuse-mismatch");
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
  // Each pass over the saved runs that reached their end.
  let expiries = 0;
  // Each claim's run as the executor last saved it.
  const lastSaved = new Map<string, StoredRun>();
  // The claims each run history prune kept.
  const historyPrunes: string[][] = [];
  let updates = 0;
  const baseStore = createAutomationRunStore(root, resolveWorkspaceMetadataDir);
  let failRecordAt: number | null = null;
  let beforeRecord: (() => void) | null = null;
  // Ids the engine treats as taken, so it adopts a file carrying one under a new id.
  const occupied = new Set<string>();
  let saves = 0;
  let records_ = 0;
  // The failures this computer last saved as sent.
  let reportedFailures: ReportedFailure[] = [];
  // Each file the executor wrote, and the automation it wrote as.
  const writtenAs: Array<{ path: string; automationId: string }> = [];
  // How many times the executor has read each file.
  const fileReads = new Map<string, number>();
  // The switched-on automations this computer last saved, per Collection.
  let enabledSaved: ReadonlyMap<string, readonly string[]> = new Map();
  const store: AutomationRunStore = {
    ...baseStore,
    saveEnabledAutomations: async (enabled) => {
      await baseStore.saveEnabledAutomations(enabled);
      enabledSaved = new Map(enabled);
      wake();
    },
    saveReportedFailures: async (failures) => {
      await baseStore.saveReportedFailures(failures);
      reportedFailures = [...failures];
      wake();
    },
    expire: async (before, keeps, from) => {
      const next = await baseStore.expire(before, keeps, from);
      if (next === null) {
        expiries += 1;
        wake();
      }
      return next;
    },
    save: async (run) => {
      saves += 1;
      await baseStore.save(run);
      lastSaved.set(run.claimId, run);
      wake();
    },
    updateState: async (run, state) => {
      await baseStore.updateState(run, state);
      lastSaved.set(run.claimId, { ...run, ...state });
      wake();
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
  const runsChanged: string[] = [];
  const failureReports: AutomationFailureReport[] = [];
  const withdrawnFailures: Array<{ claimId: string; generation: number }> = [];
  const switchedOff: AutomationSwitchedOff[] = [];
  const errors: Array<{ context: string; error: unknown }> = [];
  // A new executor over the same engine, files, and saved runs, as after a restart.
  const makeExecutor = (extra: Partial<CollectionAutomationsOptions> = {}) => new CollectionAutomations({
    withEngine: async (work) => await work(engine),
    withRecordWrites: async (signal, work) => {
      await options.withRecordWrites?.(signal, events);
      return await work(collectionRecordWrites({
        capture, workspaceRoot: root, signal,
        withAdapter: async (read) => await read(engine),
        onCaptureSettled: (listener) => { settleListeners.add(listener); return () => settleListeners.delete(listener); },
      }));
    },
    readText: async (path) => {
      const hook = beforeRead;
      beforeRead = null;
      hook?.();
      try {
        const text = await readFile(join(root, path), "utf8");
        fileReads.set(path, (fileReads.get(path) ?? 0) + 1);
        wake();
        return { text, truncated: false, contentHash: sha256(text) };
      } catch {
        return null;
      }
    },
    writeText: async (path, text, expectedContentHash, automationId) => {
      writtenAs.push({ path, automationId });
      if (sha256(await readFile(join(root, path), "utf8")) !== expectedContentHash) return { status: "conflict" };
      await writeFile(join(root, path), text);
      return { status: "written" };
    },
    pathExists: (path) => stat(join(root, path)).then(() => true, () => false),
    roster: async () => {
      rosterCalls += 1;
      const current = roster;
      const hook = beforeRoster;
      beforeRoster = null;
      await hook?.();
      return current;
    },
    cachedRoster: async () => roster,
    evaluator: options.evaluator ?? evaluator,
    store,
    onRunsChanged: () => { runsChanged.push("changed"); wake(); },
    reportFailure: async (report) => { failureReports.push(report); wake(); },
    withdrawFailure: async ({ claimId, generation }) => { withdrawnFailures.push({ claimId, generation }); wake(); },
    onSwitchedOff: (switched) => { switchedOff.push(switched); wake(); },
    onHoldsChanged: () => { holdsChanged += 1; wake(); },
    onAutomationsChanged: () => { automationsChanged += 1; wake(); },
    chat: {
      directory: async (current, needs) => {
        directoryNeeds.push(needs);
        return chatDirectoryOf(options.channels ?? [], current);
      },
      write: async (_signal, message) => {
        chatWrites += 1;
        await beforeChatWrite?.(message);
        if (!messages.some((written) => written.effectId === message.effectId)) messages.push(message);
      },
    },
    groupHost: async () => (options.runsGroupTriggers ?? true ? 0 : null),
    groupRelayRecord: async () => ({ generation: 0, handover: null }),
    requestHost: async () => { hostRequests += 1; },
    groupMessagesSkipped: async (reason, atMs) => { skipNotices.push({ reason, atMs }); },
    readMessageBody: async (messageId) => options.messageBodies?.[messageId] ?? null,
    postNotice: async (notice, signal) => {
      noticeSignals.push(signal);
      await beforeNotice?.(notice);
      if (!notices.some((sent) => sent.noticeId === notice.noticeId)) notices.push(notice);
    },
    personName: (userId) => (userId === "user-ice" ? "Ice" : userId),
    mayRetryPress: options.mayRetryPress ?? (async () => true),
    onPressSettled: (event) => { pressEvents.push({ settled: event }); wake(); },
    onPressWaiting: (event) => { pressEvents.push({ waiting: event }); wake(); },
    onError: (context, error) => { errors.push({ context, error }); },
    withDatasetHost: async () => null,
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    ...extra,
  });
  const executor = makeExecutor();

  const claim = (automationId: string, record: FakeRecord, change: Partial<RecordChange> = {}) => {
    claimCount += 1;
    const created: AutomationClaim = {
      claimId: `atc_claim${claimCount}`, automationId, trigger: { historyId: claimCount },
      recordId: record.id, collectionPath: record.collection, depth: 0,
      change: {
        kind: "changed", authorOriginId: null, actorKind: "human", onBehalfOf: null, sharedAuthor: null, liveCursor: null,
        fields: [{ field: "Status", historyId: claimCount, previous: { value: "Doing" }, next: { value: "Done" } }],
        fieldsOmitted: 0, ...change,
      },
      state: "pending", attempts: 0, run: 1, createdAtMs: Date.UTC(2026, 8, 25, 1, 30) + claimCount, updatedAtMs: 0,
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
    root, executor, makeExecutor, engine, records, claims, journaled, authored, subscriptions, events, failures, errors, runsChanged, failureReports, withdrawnFailures, switchedOff, pressEvents,
    reportedFailures: () => reportedFailures,
    enabledSaved: (collection: string) => enabledSaved.get(collection) ?? [],
    fileReads: (path: string) => fileReads.get(path) ?? 0,
    writtenAs,
    holdsChanged: () => holdsChanged,
    automationsChanged: () => automationsChanged,
    hostRequests: () => hostRequests,
    relayRecords,
    groupSkips,
    skipNotices,
    rosterCalls: () => rosterCalls,
    expiries: () => expiries,
    lastSaved: (claimId: string) => lastSaved.get(claimId),
    historyPrunes,
    beforeNextRead: (hook: () => void) => { beforeRead = hook; },
    moveRecord: (record: FakeRecord, name: string) => { record.path = `${record.collection}/${name}.md`; },
    /**
     * Moves a Collection's folder, as a person's rename does: the engine
     * keeps its collection.yaml's object id, and the watcher reports each
     * file it moved.
     */
    renameCollection: async (from: string, to: string) => {
      await mkdir(dirname(join(root, to)), { recursive: true });
      await rename(join(root, from), join(root, to));
      const objectId = collections.get(from)!;
      collections.delete(from);
      collections.set(to, objectId);
      const moved = [];
      for (const record of records.values()) {
        if (record.collection !== from) continue;
        record.collection = to;
        record.path = `${to}/${record.path.slice(from.length + 1)}`;
        moved.push(record.path);
      }
      executor.handleWatcherEvents(["collection.yaml", "automations.yaml"].map((name) => ({
        operation: "rename" as const, path: `${to}/${name}`, fromPath: `${from}/${name}`,
      })));
    },
    /** Puts a new Collection with its own object id at a path. */
    addCollection: async (path: string, objectId: string) => {
      await mkdir(join(root, path), { recursive: true });
      await writeFile(join(root, path, "collection.yaml"), SCHEMA);
      collections.set(path, objectId);
    },
    removeCollection: async (path: string) => {
      await rm(join(root, path), { recursive: true });
      collections.delete(path);
      executor.handleWatcherEvents(["collection.yaml", "automations.yaml"].map((name) => ({
        operation: "delete" as const, path: `${path}/${name}`,
      })));
    },
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
    messages,
    directoryNeeds,
    chatWrites: () => chatWrites,
    beforeChatWrite: (hook: ((message: AutomationChatMessage) => Promise<void>) | null) => { beforeChatWrite = hook; },
    notices,
    noticeSignals,
    beforeNotice: (hook: ((notice: AutomationNotice) => Promise<void>) | null) => { beforeNotice = hook; },
  };
}

const TASKS = "collection:Tasks#bump";

// The definition hash the executor lists for one automation, as a presser's window sees it.
// The host module's holds as the executor sees them: a handover waits on each.
function fakeHostHold() {
  let admits = true;
  let holds = 0;
  return {
    held: () => holds,
    refuse: () => { admits = false; },
    take: (): (() => void) | null => {
      if (!admits) return null;
      holds += 1;
      let released = false;
      return () => { if (!released) { released = true; holds -= 1; } };
    },
  };
}

async function hashOf(executor: CollectionAutomations, collection: string, id: string): Promise<string> {
  const listed = await executor.automationsIn(collection);
  const found = listed.status === "read"
    ? listed.automations.find((entry) => entry.valid && entry.automation.id === id)
    : undefined;
  if (!found?.valid) throw new Error(`No automation ${id} in ${collection}.`);
  return found.definitionHash;
}
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

  it("fails a step's formula once the steps before it landed, and keeps what they wrote", async () => {
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
    expect(w.fieldsOf(task)).toEqual({ Status: "Done", Details: null, Seen: true });
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
    // A schedule claims when it is due, so only the record trigger subscribes.
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
    // Nobody is known to have made the change, so the run's writes name nobody.
    expect(w.journaled[0]).toMatchObject({ actorOriginId: "collection:Tasks#stamp" });
    expect(w.journaled[0]?.attribution).toEqual({ actorKind: "automation", depth: 1 });
  });

  it("gives a record change's person to formulas and to the run's own writes", async () => {
    const note = "  - id: note\n    name: Note\n    when: {field-changed: Status}\n    do: [{set: {Note: '=person == null ? \"nobody\" : person.name'}}]\n";
    const w = await world({ automations: { Tasks: note } });
    const typed = w.addRecord("Tasks", "typed", { Status: "Done" });
    const byAgent = w.addRecord("Tasks", "agent", { Status: "Done" });
    const byFile = w.addRecord("Tasks", "file", { Status: "Done" });
    const named = { kind: "named" as const, userId: "user-ana", grantId: "grant-ana", grantGeneration: 1 };
    const claims = [
      w.claim("collection:Tasks#note", typed, { actorKind: "human", onBehalfOf: "user-ice" }),
      // An agent's change names the person it works for; the agent stays the actor.
      w.claim("collection:Tasks#note", byAgent, { authorOriginId: "dohc-mcp", actorKind: "agent", onBehalfOf: "user-ice" }),
      // A file another program wrote names nobody.
      w.claim("collection:Tasks#note", byFile, { actorKind: null, onBehalfOf: null }),
      // The engine names a collaborator whose live edit the relay accepted.
      w.claim("collection:Tasks#note", w.addRecord("Tasks", "shared", { Status: "Done" }), { actorKind: null, onBehalfOf: "user-ana", sharedAuthor: named }),
    ];
    await w.executor.open();
    for (const claim of claims) await w.settledClaim(claim);
    expect(claims.map((claim) => claim.state)).toEqual(["done", "done", "done", "done"]);
    expect([typed, byAgent, byFile].map((record) => w.fieldsOf(record).Note)).toEqual(["Ice", "Ice", "nobody"]);
    expect(w.journaled.map((entry) => entry.attribution)).toEqual([
      { actorKind: "automation", onBehalfOf: "user-ice", depth: 1 },
      { actorKind: "automation", onBehalfOf: "user-ice", depth: 1 },
      { actorKind: "automation", depth: 1 },
      { actorKind: "automation", onBehalfOf: "user-ana", depth: 1 },
    ]);
  });

  it("reads a Collection's automations again when a relay pull writes them, with no watcher batch", async () => {
    const w = await world({ automations: { Tasks: BUMP } });
    await w.executor.open();
    await w.until(() => w.subscriptions.has(TASKS));

    // A collaborator's direct write removes the automation (ADR 0013).
    await w.writeAutomations("Tasks", "version: 1\nautomations: []\n");
    w.executor.handlePulledPaths(["Tasks/notes.md"]);
    // A read queued after the pull sees the index the pull left.
    const unchanged = await w.executor.automationsIn("Tasks");
    expect(unchanged.status === "read" && unchanged.automations.length, "a pull that names no definition file reads nothing").toBe(1);
    expect(w.subscriptions.has(TASKS)).toBe(true);

    w.executor.handlePulledPaths(["Tasks/notes.md", "Tasks/automations.yaml"]);
    await w.until(() => !w.subscriptions.has(TASKS));
  });

  it("runs Run now from a skipped-run notice once, with when the skipped runs began", async () => {
    const w = await world({ automations: { Tasks: [
      "  - id: sweep",
      "    name: Sweep",
      "    when: {schedule: day, at: '09:00', timezone: UTC}",
      "    do: [{add-record: {Title: '=trigger.skipped'}}]",
    ].join("\n") } });
    await w.executor.open();
    const notice = `schedule-skipped:ws:collection:Tasks#sweep:${Date.UTC(2026, 8, 22, 9)}`;
    expect(await w.executor.runNow("collection:Tasks#sweep", notice)).toBe(true);
    const claim = [...w.claims.values()].find((candidate) => "key" in candidate.trigger && candidate.trigger.key === `run-now:${notice}`)!;
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(await w.executor.runNow("collection:Tasks#sweep", notice), "a repeat answers the same claim").toBe(true);
    expect([...w.claims.values()].filter((candidate) => "key" in candidate.trigger && candidate.trigger.key.startsWith("run-now:")))
      .toHaveLength(1);
  });

  it("closes after a background run and opens again", async () => {
    const w = await world({ automations: { Tasks: [
      "  - id: sweep",
      "    name: Sweep",
      "    when: {schedule: hour, timezone: UTC}",
      "    do: [{add-record: {Title: Swept}}]",
    ].join("\n") } });
    await w.executor.open();
    await w.executor.idle();
    expect(w.executor.schedules()).toHaveLength(1);
    await w.executor.close();
    expect(w.executor.schedules(), "unknown while closed").toBeNull();
    await w.executor.open();
    expect(w.executor.schedules()).toHaveLength(1);
  });

  it("times a schedule's switch-on at the index read that sees it", async () => {
    const sweep = (enabled: boolean, title = "Swept") => [
      "  - id: sweep",
      "    name: Sweep",
      `    enabled: ${enabled}`,
      "    when: {schedule: hour, timezone: UTC}",
      `    do: [{add-record: {Title: ${title}}}]`,
    ].join("\n");
    const w = await world({ automations: { Tasks: sweep(true) } });
    let now = 1_000;
    let read: () => void = () => undefined;
    const executor = w.makeExecutor({ nowMs: () => now, onSchedulesChanged: () => read() });
    const reread = async (body: string) => {
      await w.writeAutomations("Tasks", body);
      const done = new Promise<void>((resolve) => { read = resolve; });
      executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
      await done;
    };
    await executor.open();
    expect(executor.schedules()?.map((entry) => entry.enabledSince), "on as the executor opened").toEqual([null]);

    // Switched off and on again before any scheduler step looks.
    await reread(sweep(false));
    expect(executor.schedules()).toEqual([]);
    now = 2_000;
    await reread(sweep(true));
    now = 3_000;
    await reread(sweep(true, "Swept again"));
    expect(executor.schedules()?.map((entry) => entry.enabledSince), "an edit that keeps it on keeps the time").toEqual([2_000]);
    await executor.dispose();
  });

  it("runs a schedule's due time on the records a Find returns, with the due time as now", async () => {
    const w = await world({ automations: { Tasks: [
      "  - id: sweep",
      "    name: Sweep",
      "    when: {schedule: day, at: '09:00', timezone: UTC}",
      "    do:",
      "      - find: record.Status == \"Done\"",
      "        as: done",
      "      - set: {Archived on: '=today()'}",
      "        records: done",
      "  - id: off",
      "    name: Off",
      "    enabled: false",
      "    when: {schedule: hour, timezone: UTC}",
      "    do: [{add-record: {Title: Never}}]",
      "  - id: nowhere",
      "    name: Nowhere",
      "    when: {schedule: hour, timezone: Mars/Olympus}",
      "    do: [{add-record: {Title: Never}}]",
    ].join("\n") } });
    const done = w.addRecord("Tasks", "done", { Status: "Done" });
    const open = w.addRecord("Tasks", "open", { Status: "Doing" });
    expect(w.executor.schedules(), "unknown until the executor opens").toBeNull();
    await w.executor.open();
    expect(w.executor.schedules()?.map((entry) => entry.automationId)).toEqual(["collection:Tasks#sweep"]);
    const [sweep] = w.executor.schedules() ?? [];
    const due = Date.UTC(2026, 8, 25, 9);
    expect(await w.executor.claimSchedule({ automationId: sweep!.automationId, scheduleHash: sweep!.scheduleHash, run: [], throughMs: due - 1 }))
      .toEqual({ automationId: sweep!.automationId, scheduleHash: sweep!.scheduleHash, throughMs: due - 1 });
    await w.executor.claimSchedule({ automationId: sweep!.automationId, scheduleHash: sweep!.scheduleHash, run: [due], throughMs: due });
    const claim = [...w.claims.values()].find((candidate) => candidate.change.kind === "schedule")!;
    await w.settledClaim(claim);

    expect(claim.state).toBe("done");
    expect(w.fieldsOf(done)).toEqual({ Status: "Done", "Archived on": "2026-09-25" });
    expect(w.fieldsOf(open)).toEqual({ Status: "Doing" });
    expect(await w.executor.scheduleMarks()).toEqual([
      { automationId: sweep!.automationId, scheduleHash: sweep!.scheduleHash, throughMs: due },
    ]);
    // A workspace that must sync before its schedules run says so.
    const synced = w.makeExecutor({ hostCanRun: async () => false });
    await synced.open();
    const syncedList = await synced.automationsIn("Tasks");
    expect(syncedList.status === "read" && syncedList.automations[0]?.valid ? syncedList.automations[0].cannotRun : null)
      .toBe("Turn on sync to run this workspace's schedules.");
    await synced.dispose();
    // This computer's parser refuses a zone it does not know, so that
    // schedule is off here with its diagnostic.
    const listed = await w.executor.automationsIn("Tasks");
    const nowhere = listed.status === "read" ? listed.automations[2] : null;
    expect(nowhere).toMatchObject({ valid: false, id: "nowhere", diagnostics: [{ code: "invalid-timezone" }] });
  });

  it("runs a button's automation on the record for the person who pressed it, with no subscription", async () => {
    const w = await world({ automations: { Tasks: [
      "  - id: mark-paid",
      "    name: Mark paid",
      "    when: {button: Mark paid}",
      "    do: [{set: {Paid: true, Paid by: '=person.name', Pressed: '=trigger.pressedAt', Button: '=trigger.field'}}]",
    ].join("\n") } });
    const invoice = w.addRecord("Tasks", "invoice", { Status: "Sent" });
    await w.executor.open();
    expect([...w.subscriptions.keys()]).toEqual([]);
    await expect(w.executor.buttons("Tasks", ["Mark paid", "Archive"])).resolves.toEqual([
      { field: "Mark paid", state: { kind: "ready", automationId: "collection:Tasks#mark-paid" } },
      { field: "Archive", state: { kind: "no-automation", reason: "No automation uses this button." } },
    ]);
    const watched: string[] = [];
    const pressed = await w.executor.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-1", pressedBy: "user-ice", by: { kind: "human" } }, (claimId) => watched.push(claimId));
    if (pressed.busy) throw new Error("Expected a claim");
    expect(pressed.settled).toBeNull();
    const claim = w.claims.get(pressed.claimId)!;
    expect(watched).toEqual([claim.claimId]);
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(w.fieldsOf(invoice)).toEqual({
      Status: "Sent", Paid: true, "Paid by": "Ice", Pressed: localIsoTime(claim.createdAtMs), Button: "Mark paid",
    });
    await w.until(() => w.pressEvents.length > 0);
    expect(w.pressEvents).toEqual([{ settled: { claimId: claim.claimId, outcome: "done", error: null } }]);
    // An agent's press for Ice reaches the engine as the agent's, at its run's depth, and its run writes one step deeper.
    const other = w.addRecord("Tasks", "other", { Status: "Sent" });
    const byAgent = await w.executor.press(
      { collectionPath: "Tasks", field: "Mark paid", recordId: other.id, pressId: "press-agent", pressedBy: "user-ice", by: { kind: "agent", originId: "dohc-mcp", depth: 2 } },
      () => undefined);
    if (byAgent.busy) throw new Error("Expected a claim");
    const agentClaim = w.claims.get(byAgent.claimId)!;
    expect(agentClaim).toMatchObject({ depth: 2, change: { actorKind: "agent", authorOriginId: "dohc-mcp", onBehalfOf: "user-ice" } });
    await w.settledClaim(agentClaim);
    const agentRunWrites = w.journaled.filter((write) => write.path === other.path);
    expect(agentRunWrites.length).toBeGreaterThan(0);
    expect(agentRunWrites.every((write) => write.attribution?.depth === 3)).toBe(true);
    // The same press sent again after a lost reply answers the same claim
    // and how it ended, even after the automation is switched off.
    await w.writeAutomations("Tasks", [
      "  - id: mark-paid", "    name: Mark paid", "    enabled: false", "    when: {button: Mark paid}", "    do: [{set: {Paid: true}}]",
    ].join("\n"));
    const idle = w.idleDrains();
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    await w.until(() => w.idleDrains() > idle);
    await expect(w.executor.buttons("Tasks", ["Mark paid"])).resolves.toMatchObject([{ state: { kind: "disabled" } }]);
    const again = await w.executor.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-1", pressedBy: "user-ice", by: { kind: "human" } }, (claimId) => watched.push(claimId));
    expect(again).toEqual({ busy: false, claimId: claim.claimId, settled: { outcome: "done", error: null } });
    // A run that already ended has no settle left to hear.
    expect(watched).toEqual([claim.claimId]);
    // The id names this press, so another person, field, or record is refused.
    await expect(w.executor.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-1", pressedBy: "user-ana", by: { kind: "human" } }, () => undefined))
      .rejects.toThrow("This press id already names another press.");
    // After a restart the engine still has the press, so the switched-off
    // button answers it, and still refuses it to anyone else.
    const restarted = w.makeExecutor();
    await restarted.open();
    await expect(restarted.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-1", pressedBy: "user-ice", by: { kind: "human" } }, () => undefined))
      .resolves.toEqual({ busy: false, claimId: claim.claimId, settled: { outcome: "done", error: null } });
    await expect(restarted.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-1", pressedBy: "user-ana", by: { kind: "human" } }, () => undefined))
      .rejects.toThrow("This press id already names another press.");
    // A new press on the switched-off button is still refused.
    await expect(restarted.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-2", pressedBy: "user-ice", by: { kind: "human" } }, () => undefined))
      .rejects.toThrow("Mark paid is off. Turn it on in Automations.");
    await restarted.dispose();
  });

  it("tells the window a skipped run changed nothing, and answers a resend of it only as ended", async () => {
    const w = await world({ automations: { Tasks: "  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do: [{set: {Paid: true}}]\n" } });
    const invoice = w.addRecord("Tasks", "invoice", {});
    await w.executor.open();
    const input = { collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-1", pressedBy: "user-ice", by: { kind: "human" as const } };
    // The record leaves before the run reads it, so the run changes nothing.
    w.records.delete(invoice.id);
    await expect(w.executor.press(input, () => undefined)).rejects.toThrow("This record is no longer in Tasks.");
    w.records.set(invoice.id, invoice);
    const pressed = await w.executor.press(input, () => undefined);
    if (pressed.busy) throw new Error("Expected a claim");
    w.records.delete(invoice.id);
    await w.settledClaim(w.claims.get(pressed.claimId)!);
    await w.until(() => w.pressEvents.length > 0);
    expect(w.pressEvents).toEqual([{ settled: { claimId: pressed.claimId, outcome: "skipped", error: null } }]);
    // A run that saved nothing looks the same as one whose record was
    // trimmed, so the resend says only that the run ended.
    await expect(w.executor.press(input, () => undefined))
      .resolves.toEqual({ busy: false, claimId: pressed.claimId, settled: { outcome: "ended", error: null } });
  });

  it("answers busy while the button runs on the record for someone else, and joins the same person's run", async () => {
    const w = await world({ automations: { Tasks: "  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do: [{set: {Paid: true}}]\n" } });
    const invoice = w.addRecord("Tasks", "invoice", {});
    w.setRoster({ kind: "unknown", problem: { kind: "unchecked", next: "Try again later." } });
    await w.executor.open();
    const first = await w.executor.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-1", pressedBy: "user-ice", by: { kind: "human" } }, () => undefined);
    if (first.busy) throw new Error("Expected a claim");
    // Who can edit is unknown, so the run waits and its window hears why.
    await w.until(() => w.pressEvents.length > 0);
    expect(w.pressEvents).toEqual([{ waiting: { claimId: first.claimId, reason: "roster" } }]);
    await expect(w.executor.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-2", pressedBy: "user-ana", by: { kind: "human" } }, () => undefined))
      .resolves.toEqual({ busy: true });
    // A second window of the same person joins the run and learns why it waits.
    const joined: Array<[string, string | null]> = [];
    await expect(w.executor.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-3", pressedBy: "user-ice", by: { kind: "human" } },
      (claimId, waiting) => joined.push([claimId, waiting])))
      .resolves.toEqual({ busy: false, claimId: first.claimId, settled: null });
    expect(joined).toEqual([[first.claimId, "roster"]]);
    w.setRoster(OWNER);
    w.executor.rosterChanged();
    await w.settledClaim(w.claims.get(first.claimId)!);
    expect(w.fieldsOf(invoice)).toEqual({ Paid: true });
  });

  it("runs a relayed press as the verified user's, and refuses one whose automation left or no longer runs the button", async () => {
    const w = await world({ automations: { Tasks: "  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do: [{set: {Paid by: '=person.id'}}]\n" } });
    const invoice = w.addRecord("Tasks", "invoice", {});
    await w.executor.open();
    const paid = await hashOf(w.executor, "Tasks", "paid");
    await expect(w.executor.pressRelayed(
      { automationId: "collection:Tasks#paid", collectionPath: "Tasks", definitionHash: "0000000000000000", recordId: invoice.id, pressId: "relay-0", pressedBy: "user-ana" }, () => undefined))
      .rejects.toThrow("Mark paid changed after it was pressed. Press it again.");
    // The relay checked the presser's grant for the path they saw, so the
    // press runs only while the Collection is still there.
    await expect(w.executor.pressRelayed(
      { automationId: "collection:Tasks#paid", collectionPath: "Old/Tasks", definitionHash: paid, recordId: invoice.id, pressId: "relay-moved", pressedBy: "user-ana" }, () => undefined))
      .rejects.toThrow("This Collection moved after the button was pressed. Press it again.");
    const relayed = await w.executor.pressRelayed(
      { automationId: "collection:Tasks#paid", collectionPath: "Tasks", definitionHash: paid, recordId: invoice.id, pressId: "relay-1", pressedBy: "user-ana" }, () => undefined);
    expect(relayed.field).toBe("Mark paid");
    if (relayed.pressed.busy) throw new Error("Expected a claim");
    await w.settledClaim(w.claims.get(relayed.pressed.claimId)!);
    expect(w.fieldsOf(invoice)).toEqual({ "Paid by": "user-ana" });

    // The relay cannot tell which Collection a record is in, so the host checks.
    const elsewhere = w.addRecord("Log", "entry", {});
    await expect(w.executor.pressRelayed(
      { automationId: "collection:Tasks#paid", collectionPath: "Tasks", definitionHash: paid, recordId: elsewhere.id, pressId: "relay-outside", pressedBy: "user-ana" }, () => undefined))
      .rejects.toThrow("This record is no longer in Tasks.");
    expect([...w.claims.values()].filter((claim) => claim.recordId === elsewhere.id)).toEqual([]);

    await w.writeAutomations("Tasks", "  - id: other\n    name: Other\n    when: {button: Mark paid}\n    do: [{set: {X: 1}}]\n");
    const idle = w.idleDrains();
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    await w.until(() => w.idleDrains() > idle);
    await expect(w.executor.pressRelayed(
      { automationId: "collection:Tasks#paid", collectionPath: "Tasks", definitionHash: paid, recordId: invoice.id, pressId: "relay-2", pressedBy: "user-ana" }, () => undefined))
      .rejects.toThrow("This button no longer runs an automation in its Collection.");

    // The pressed automation is off, and another now runs the button.
    await w.writeAutomations("Tasks", "  - id: paid\n    name: Paid\n    enabled: false\n    when: {button: Mark paid}\n    do: [{set: {X: 1}}]\n  - id: other\n    name: Other\n    when: {button: Mark paid}\n    do: [{set: {X: 1}}]\n");
    const again = w.idleDrains();
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    await w.until(() => w.idleDrains() > again);
    await expect(w.executor.pressRelayed(
      { automationId: "collection:Tasks#paid", collectionPath: "Tasks", definitionHash: await hashOf(w.executor, "Tasks", "paid"), recordId: invoice.id, pressId: "relay-3", pressedBy: "user-ana" }, () => undefined))
      .rejects.toThrow("Mark paid now runs another automation. Press it again.");
  });

  it("refuses to run a relayed press after its automation changed, even once claimed, and finds its claim again", async () => {
    const w = await world({ automations: { Tasks: "  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do: [{set: {Paid: true}}]\n" } });
    const invoice = w.addRecord("Tasks", "invoice", {});
    // Who can edit is unknown, so the claim waits before it runs.
    w.setRoster({ kind: "unknown", problem: { kind: "unchecked", next: "Try again later." } });
    await w.executor.open();
    const paid = await hashOf(w.executor, "Tasks", "paid");
    const input = { automationId: "collection:Tasks#paid", collectionPath: "Tasks", definitionHash: paid, pressId: "relay-1" };
    expect(await w.executor.relayedClaim(input)).toBeNull();
    const relayed = await w.executor.pressRelayed({ ...input, collectionPath: "Tasks", recordId: invoice.id, pressedBy: "user-ana" }, () => undefined);
    if (relayed.pressed.busy) throw new Error("Expected a claim");
    expect(await w.executor.relayedClaim(input)).toEqual({ claimId: relayed.pressed.claimId, settled: null });
    // The steps change under the same id before the claim runs.
    await w.writeAutomations("Tasks", "  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do: [{set: {Refunded: true}}]\n");
    const idle = w.idleDrains();
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    await w.until(() => w.idleDrains() > idle);
    w.setRoster(OWNER);
    w.executor.rosterChanged();
    const claim = await w.settledClaim(w.claims.get(relayed.pressed.claimId)!);
    expect(claim).toMatchObject({ state: "failed", error: "Mark paid changed after it was pressed. Press it again." });
    expect(w.fieldsOf(invoice)).toEqual({});
    expect(await w.executor.relayedClaim(input)).toMatchObject({ settled: { outcome: "failed" } });
    // Its notice reaches the person who pressed.
    await w.until(() => w.failureReports.length === 1);
    expect(w.failureReports[0]).toMatchObject({ failure: { claimId: claim.claimId }, startedBy: "user-ana" });
  });

  it("holds the host while a relayed press's run writes, and runs nothing the host no longer admits", async () => {
    const hold = fakeHostHold();
    const writes: number[] = [];
    const w = await world({
      automations: { Tasks: "  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do: [{set: {Paid: true}}]\n" },
      withRecordWrites: async () => { writes.push(hold.held()); },
    });
    const executor = w.makeExecutor({ holdForHost: hold.take });
    await executor.open();
    const paid = await hashOf(executor, "Tasks", "paid");
    // The owner's own press holds nothing.
    const own = w.addRecord("Tasks", "own", {});
    const pressed = await executor.press({ collectionPath: "Tasks", field: "Mark paid", recordId: own.id, pressId: "press-1", pressedBy: "user-ice", by: { kind: "human" } }, () => undefined);
    if (pressed.busy) throw new Error("Expected a claim");
    await w.settledClaim(w.claims.get(pressed.claimId)!);
    const invoice = w.addRecord("Tasks", "invoice", {});
    const relayed = await executor.pressRelayed({ automationId: "collection:Tasks#paid", collectionPath: "Tasks", definitionHash: paid, recordId: invoice.id, pressId: "relay-1", pressedBy: "user-ana" }, () => undefined);
    if (relayed.pressed.busy) throw new Error("Expected a claim");
    await w.settledClaim(w.claims.get(relayed.pressed.claimId)!);
    expect(writes).toEqual([0, 1]);
    expect(hold.held()).toBe(0);
    // A handover began: the press settles failed and writes nothing.
    hold.refuse();
    const late = w.addRecord("Tasks", "late", {});
    const refused = await executor.pressRelayed({ automationId: "collection:Tasks#paid", collectionPath: "Tasks", definitionHash: paid, recordId: late.id, pressId: "relay-2", pressedBy: "user-ana" }, () => undefined);
    if (refused.pressed.busy) throw new Error("Expected a claim");
    expect(await w.settledClaim(w.claims.get(refused.pressed.claimId)!))
      .toMatchObject({ state: "failed", error: "This workspace's automations moved to another computer before this press ran." });
    expect(w.fieldsOf(late)).toEqual({});
    expect(writes).toEqual([0, 1]);
    await executor.dispose();
  });

  it("holds nothing while a relayed press's claim waits, and a restarted executor holds the host for it", async () => {
    const hold = fakeHostHold();
    const writes: number[] = [];
    const w = await world({
      automations: { Tasks: "  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do: [{set: {Paid: true}}]\n" },
      withRecordWrites: async () => { writes.push(hold.held()); },
    });
    const invoice = w.addRecord("Tasks", "invoice", {});
    // Who can edit is unknown, so the claim waits before it runs.
    w.setRoster({ kind: "unknown", problem: { kind: "unchecked", next: "Try again later." } });
    const first = w.makeExecutor({ holdForHost: hold.take });
    await first.open();
    const paid = await hashOf(first, "Tasks", "paid");
    const relayed = await first.pressRelayed({ automationId: "collection:Tasks#paid", collectionPath: "Tasks", definitionHash: paid, recordId: invoice.id, pressId: "relay-1", pressedBy: "user-ana" }, () => undefined);
    if (relayed.pressed.busy) throw new Error("Expected a claim");
    await w.until(() => w.pressEvents.length > 0);
    expect(w.pressEvents).toMatchObject([{ waiting: { claimId: relayed.pressed.claimId } }]);
    expect(hold.held()).toBe(0);
    await first.dispose();
    // After a restart the claim runs before the relayed press loop looks it
    // up, so the executor holds the host for it by itself.
    w.setRoster(OWNER);
    const restarted = w.makeExecutor({ holdForHost: hold.take });
    await restarted.open();
    await w.settledClaim(w.claims.get(relayed.pressed.claimId)!);
    expect(w.fieldsOf(invoice)).toEqual({ Paid: true });
    expect(writes).toEqual([1]);
    expect(hold.held()).toBe(0);
    await restarted.dispose();
  });

  it("keeps a relayed press's hold after its deadline until its write really stops", async () => {
    const hold = fakeHostHold();
    let passDeadline = () => {};
    let finishWrite = () => {};
    let markAborted = () => {};
    const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
    const w = await world({
      automations: { Tasks: "  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do: [{set: {Paid: true}}]\n" },
      deadline: (abort) => { passDeadline = abort; return () => {}; },
      // The write outlives the abort, as one still in flight when the workspace closes does.
      withRecordWrites: (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          finishWrite = () => reject(new Error("The write stopped."));
          markAborted();
        }, { once: true });
        passDeadline();
      }),
    });
    const invoice = w.addRecord("Tasks", "invoice", {});
    const executor = w.makeExecutor({ holdForHost: hold.take });
    await executor.open();
    const paid = await hashOf(executor, "Tasks", "paid");
    const relayed = await executor.pressRelayed({ automationId: "collection:Tasks#paid", collectionPath: "Tasks", definitionHash: paid, recordId: invoice.id, pressId: "relay-1", pressedBy: "user-ana" }, () => undefined);
    if (relayed.pressed.busy) throw new Error("Expected a claim");
    await aborted;
    await new Promise((resolve) => setImmediate(resolve));
    expect(hold.held()).toBe(1);
    finishWrite();
    await w.settledClaim(w.claims.get(relayed.pressed.claimId)!);
    expect(hold.held()).toBe(0);
  });

  it("names why a button cannot run, and refuses a press on it", async () => {
    const w = await world({ collections: ["Tasks", "Other"], automations: { Tasks: [
      "  - id: one", "    name: One", "    when: {button: Twice}", "    do: [{set: {A: 1}}]",
      "  - id: two", "    name: Two", "    when: {button: Twice}", "    do: [{set: {B: 1}}]",
      "  - id: off", "    name: Resend", "    enabled: false", "    when: {button: Resend}", "    do: [{set: {C: 1}}]",
      "  - id: msg", "    name: Notify", "    when: {button: Notify}", "    do: [{post: hello, group: Team}]",
      "  - id: far", "    name: Reach", "    when: {button: Reach}", "    do: [{add-record: {Title: x}, collection: Other}]",
      "  - id: broken", "    name: Broken", "    when: {button: Broken}", "    do: [{nonsense: true}]",
    ].join("\n") } });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("ana@example.com", ["Tasks"])] });
    const task = w.addRecord("Tasks", "one", {});
    await w.executor.open();
    const states = await w.executor.buttons("Tasks", ["Twice", "Resend", "Notify", "Reach", "Broken"]);
    expect(states.map(({ state }) => state)).toEqual([
      { kind: "disabled", reason: "Two automations use Twice. Keep one." },
      { kind: "disabled", reason: "Resend is off. Turn it on in Automations." },
      { kind: "disabled", reason: "ana@example.com cannot post in Team." },
      { kind: "disabled", reason: "ana@example.com cannot edit Other." },
      { kind: "disabled", reason: "The automation for Broken has a problem. Fix it in Automations." },
    ]);
    await expect(w.executor.press({ collectionPath: "Tasks", field: "Resend", recordId: task.id, pressId: "press-1", pressedBy: "user-owner", by: { kind: "human" } }, () => undefined))
      .rejects.toThrow("Resend is off. Turn it on in Automations.");
    await expect(w.executor.press({ collectionPath: "Other", field: "Twice", recordId: task.id, pressId: "press-2", pressedBy: "user-owner", by: { kind: "human" } }, () => undefined))
      .rejects.toThrow("No automation uses this button.");
    expect(w.claims.size).toBe(0);
  });

  it("disables a button whose automation names a missing field, without claiming a run", async () => {
    const w = await world({ automations: { Tasks: "  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do: [{set: {Absent: true}}]\n" } });
    const invoice = w.addRecord("Tasks", "invoice", {});
    await w.executor.open();
    await expect(w.executor.buttons("Tasks", ["Mark paid"])).resolves.toEqual([
      { field: "Mark paid", state: { kind: "disabled", reason: "Absent is not a field in Tasks." } },
    ]);
    await expect(w.executor.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-1", pressedBy: "user-ice", by: { kind: "human" } }, () => undefined))
      .rejects.toThrow("Absent is not a field in Tasks.");
    expect(w.claims.size).toBe(0);
  });

  it("refuses a press on a record that left the Collection, and claims nothing", async () => {
    const w = await world({ automations: { Tasks: "  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do: [{set: {Paid: true}}]\n" } });
    await w.executor.open();
    await expect(w.executor.press({ collectionPath: "Tasks", field: "Mark paid", recordId: "rec_gone", pressId: "press-1", pressedBy: "user-ice", by: { kind: "human" } }, () => undefined))
      .rejects.toThrow("This record is no longer in Tasks.");
    expect(w.claims.size).toBe(0);
  });

  it("runs a failed press again only for the person who pressed it or the owner", async () => {
    const w = await world({
      automations: { Tasks: "  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do: [{set: {Total: '=record.Missing.length'}}]\n" },
      mayRetryPress: async (pressedBy) => pressedBy === "user-ice",
    });
    const invoice = w.addRecord("Tasks", "invoice", {});
    await w.executor.open();
    const pressed = await w.executor.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-1", pressedBy: "user-ana", by: { kind: "human" } }, () => undefined);
    if (pressed.busy) throw new Error("Expected a claim");
    const claim = await w.settledClaim(w.claims.get(pressed.claimId)!);
    expect(claim.state).toBe("failed");
    await w.until(() => w.pressEvents.length > 0);
    expect(w.pressEvents).toEqual([{ settled: { claimId: claim.claimId, outcome: "failed", error: claim.error } }]);
    await expect(w.executor.retry({ automationId: "collection:Tasks#paid", claimId: claim.claimId, startOver: false })).resolves.toEqual({
      status: "refused", reason: "Only the person who pressed this button, or the workspace's owner, can run it again.",
    });
    expect(claim.state).toBe("failed");
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
      kind: "automation", automationId: "collection:Tasks#sweep", depth: 1,
    } }]);
    const [run] = (await w.executor.runs("collection:Tasks#sweep")).runs;
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
    await w.until(() => w.runsChanged.length === 1);
  });

  it("sends one notice per failure, replacing the one before, and none again after a restart", async () => {
    const w = await world({ collections: ["Tasks", "Budget"], automations: { Tasks: [
      "  - id: spend",
      "    name: Spend",
      "    when: {field-changed: Status}",
      "    do: [{add-record: {Amount: 5}, collection: Budget}]",
    ].join("\n") } });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("ana@dohc.test", ["Tasks"])] });
    const claim = w.claim("collection:Tasks#spend", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.until(() => w.failureReports.length === 1);
    expect(w.failureReports[0]).toEqual({
      failure: {
        automationId: "collection:Tasks#spend", claimId: claim.claimId, neverStarted: false, chainStopped: false,
        error: "ana@dohc.test cannot edit Budget.", updatedAtMs: claim.updatedAtMs, generation: 1, datasetInstance: null,
      },
      name: "Spend",
      collectionPath: "Tasks",
      startedBy: null,
      replaces: null,
    });

    // Failing the same way sends a new notice. The old one goes once: Try
    // again took it back, or, when the run failed before that pass, the new
    // notice replaced it.
    await expect(w.executor.retry({ automationId: "collection:Tasks#spend", claimId: claim.claimId, startOver: false }))
      .resolves.toMatchObject({ status: "queued" });
    await w.until(() => w.failureReports.length === 2);
    expect(w.failureReports[1]).toMatchObject({ failure: { generation: 2 } });
    const first = { claimId: claim.claimId, generation: 1 };
    expect([...w.withdrawnFailures, w.failureReports[1]!.replaces]
      .filter((run) => run?.claimId === first.claimId && run.generation === 1)).toHaveLength(1);
    const withdrawn = w.withdrawnFailures.length;
    await w.until(() => w.reportedFailures().some((entry) => entry.generation === 2 && entry.open));

    // After a restart, only a new failure sends a notice.
    await w.executor.dispose();
    const next = w.claim("collection:Tasks#spend", w.addRecord("Tasks", "two", { Status: "Done" }));
    const restarted = w.makeExecutor();
    await restarted.open();
    await w.until(() => w.failureReports.length === 3);
    // The older failed run is still failed, so the newer notice takes its place.
    expect(w.failureReports[2]).toMatchObject({ failure: { claimId: next.claimId, generation: 3 }, replaces: { claimId: claim.claimId, generation: 2 } });
    expect(w.withdrawnFailures).toHaveLength(withdrawn);
    await restarted.dispose();
  });

  it("takes back a run's notice once Try again runs it, though an older run of the automation is still failed", async () => {
    const w = await world({ collections: ["Tasks", "Budget"], automations: { Tasks: [
      "  - id: spend",
      "    name: Spend",
      "    when: {field-changed: Status}",
      "    do: [{add-record: {Amount: 5}, collection: Budget}]",
    ].join("\n") } });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("ana@dohc.test", ["Tasks"])] });
    const older = w.claim("collection:Tasks#spend", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(older);
    const newer = w.claim("collection:Tasks#spend", w.addRecord("Tasks", "two", { Status: "Done" }));
    w.executor.notifyClaimed();
    await w.until(() => w.failureReports.at(-1)?.failure.claimId === newer.claimId);
    const shown = w.failureReports.at(-1)!.failure.generation;

    // Reach now allows the step, so the retried run waits instead of failing again.
    w.setRoster(OWNER);
    await expect(w.executor.retry({ automationId: "collection:Tasks#spend", claimId: newer.claimId, startOver: false }))
      .resolves.toMatchObject({ status: "queued" });
    // The older run is its automation's newest failure again, so its notice takes the newer one's place.
    await w.until(() => w.failureReports.at(-1)?.failure.claimId === older.claimId);
    expect(w.failureReports.at(-1)).toMatchObject({ replaces: { claimId: newer.claimId, generation: shown } });
    expect(older.state).toBe("failed");
  });

  it("says when a changed file switched an automation off, and not when dohc switched it off", async () => {
    const w = await world({ automations: { Tasks: "  - id: seen\n    name: Seen\n    when: {field-changed: Status}\n    do: [{set: {Seen: true}}]\n" } });
    await w.executor.open();
    const on = "  - id: seen\n    name: Seen\n    when: {field-changed: Status}\n    do: [{set: {Seen: true}}]\n";
    const off = "  - id: seen\n    name: Seen\n    enabled: false\n    when: {field-changed: Status}\n    do: [{set: {Seen: true}}]\n";
    // Each change waits until the executor has read it, so no read sees a later one.
    const read = async (text: string, pulled: boolean) => {
      const reads = w.fileReads("Tasks/automations.yaml");
      await w.writeAutomations("Tasks", text);
      if (pulled) w.executor.handlePulledPaths(["Tasks/automations.yaml"]);
      else w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
      await w.until(() => w.fileReads("Tasks/automations.yaml") > reads);
    };
    await read(off, false);
    await w.until(() => w.switchedOff.length === 1);
    expect(w.switchedOff).toEqual([{ collectionPath: "Tasks", id: "seen", automationId: "collection:Tasks#seen", name: "Seen" }]);

    // Off to off is no switch.
    await read(off, false);
    expect(w.switchedOff).toHaveLength(1);

    // On again, then off in a change a relay pull brought, as from someone the work was shared with.
    await read(on, false);
    await read(off, true);
    await w.until(() => w.switchedOff.length === 2);
    expect(w.switchedOff[1]).toMatchObject({ id: "seen" });
  });

  it("says when an automation was switched off while dohc was closed", async () => {
    const w = await world({ automations: { Tasks: "  - id: seen\n    name: Seen\n    when: {field-changed: Status}\n    do: [{set: {Seen: true}}]\n" } });
    await w.executor.open();
    await w.until(() => w.automationsChanged() > 0);
    await w.executor.dispose();
    await w.writeAutomations("Tasks", "  - id: seen\n    name: Seen\n    enabled: false\n    when: {field-changed: Status}\n    do: [{set: {Seen: true}}]\n");
    const reopened = w.makeExecutor();
    await reopened.open();
    await w.until(() => w.switchedOff.length === 1);
    expect(w.switchedOff).toEqual([expect.objectContaining({ id: "seen" })]);
    await reopened.dispose();
  });

  it.each([false, true])("refuses an approved dataset through the document write path (code: %s)", async (code) => {
    const w = await world({ automations: { Tasks: [
      "  - id: donate",
      "    name: Donate",
      "    when: {field-changed: Status}",
      code ? "    do: [{run: \"return { records: [{ action: 'add', collection: 'Donations', fields: { Amount: 5 } }] };\"}]"
        : "    do: [{add-record: {Amount: 5}, collection: Donations}]",
    ].join("\n") } });
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const { files } = generateDatasetSources({
      formatVersion: 1, datasetId: id(1), name: "Donations", schemaPath: "Donations/schema.sql", operationsPath: "Donations/operations.js",
      tables: [{ tableId: id(2), name: "Donations", sqlName: "donations", primaryKey: "id", fields: [
        { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
        { fieldId: id(4), name: "Amount", sqlColumn: "amount", type: "number", required: false, unique: false },
      ] }],
      operations: [{ operationId: id(5), name: "donations.create", label: "Create", tableId: id(2), kind: "create", access: "owner", readOnly: false, fieldIds: [id(4)] }],
    });
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(w.root, path)), { recursive: true });
      await writeFile(join(w.root, path), text);
    }
    const host = await createLocalDatasetHost({ localPersonId: () => "person-local", workspaceId: "workspace", workspaceRoot: w.root, capacityBytes: 1024 * 1024 });
    const executor = w.makeExecutor({ withDatasetHost: async (work) => await work(host.automations) });
    try {
      const prepared = await host.prepare({ descriptorPath: "Donations/dataset.json", adapter: sourceCaptureAdapter(new Map(Object.entries(files)), { workspaceId: "workspace" }) });
      await host.approve({ preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256 });
      const task = w.addRecord("Tasks", "one", { Status: "Done" });
      const claim = w.claim("collection:Tasks#donate", task);
      await executor.open();
      await w.settledClaim(claim);
      expect(claim).toMatchObject({
        state: "failed",
        error: `${code ? "The code in step 1 changes records in Donations. " : ""}Automations cannot use Donations yet, because its records change only through its Collection actions.`,
      });
      expect(w.authored).toEqual([]);
    } finally {
      await executor.dispose();
      await host.close();
    }
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

    await expect(w.executor.retry({ automationId: TASKS, claimId: claim.claimId, startOver: false })).resolves.toEqual({ status: "queued", press: false });
    await w.until(() => claim.state === "done");
    expect(w.fieldsOf(task).Count).toBe(3);
    expect([...w.records.values()].filter((record) => record.collection === "Log")).toHaveLength(1);
    // The retry named the claim to the failure notices, and took its notice back.
    expect(w.runsChanged.length).toBeGreaterThanOrEqual(2);
    await w.until(() => w.withdrawnFailures.length === 1);
    expect(w.withdrawnFailures).toEqual([{ claimId: claim.claimId, generation: 1 }]);
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
    const [run] = (await w.executor.runs(TASKS)).runs;
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
      .resolves.toEqual({ status: "definition-changed", repeatsMessages: false });
    expect(claim.state).toBe("failed");
    // Starting over makes new messages too, so the person hears that first.
    expect(DEFINITION_CHANGED_ERROR).toContain("It may repeat changes, posts, direct messages, and notices the earlier run already made.");
    expect(((await w.executor.runs(TASKS)).runs)[0]).toMatchObject({ definitionChanged: true });
    // Reading the run says Try again starts over, as the refusal above does.
    expect(await w.executor.run(TASKS, claim.claimId)).toMatchObject({ state: "failed", startsOver: true });

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
      automationId: "collection:Trip#spend", definitionHash: summary.definitionHash, step: "0", seq: summary.reach.steps[0]!.seq + 1,
    })).resolves.toBe("changed");
    await expect(w.executor.confirmReach({
      automationId: "collection:Trip#spend", definitionHash: summary.definitionHash, step: "0", seq: summary.reach.steps[0]!.seq,
    })).resolves.toBe("confirmed");
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect([...w.records.values()].filter((record) => record.collection === "Budget")).toHaveLength(1);
  });

  it("holds a step first seen after a link that could have written it was revoked, until a current editor confirms it", async () => {
    const w = await world({ collections: ["Trip", "Budget"], automations: { Trip: [
      "  - id: spend",
      "    name: Spend",
      "    when: {field-changed: Status}",
      "    do: [{add-record: {Amount: 5}, collection: Budget}]",
    ].join("\n") } });
    // An Edit link on Trip wrote automations directly, and was revoked before this
    // computer ever checked its automations: the roster has no editor now.
    w.setRoster({
      kind: "owner", ownerUserId: "user-owner", grants: [],
      formerEditors: [{ grantId: "g-link", generation: 1, holder: "link", recipientEmail: null, files: { paths: ["Trip"], versionId: null } }],
    });
    await w.executor.open();
    const listed = await w.executor.automationsIn("Trip");
    expect(listed).toMatchObject({
      automations: [{ reach: { kind: "checked", steps: [{ verdict: "held", stoppedFor: "Anyone who had your share link to Trip" }] } }],
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
      automationId: "collection:Trip#spend", definitionHash: summary.definitionHash, step: "0", seq: summary.reach.steps[0]!.seq,
    })).resolves.toBe("confirmed");
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect([...w.records.values()].filter((record) => record.collection === "Budget")).toHaveLength(1);
  });

  it("holds an allowed step once per ended editing period of a link that could have switched it on, and not again after Allow or a restart", async () => {
    const w = await world({ collections: ["Trip", "Budget"], automations: { Trip: [
      "  - id: spend",
      "    name: Spend",
      "    when: {field-changed: Status}",
      "    do: [{add-record: {Amount: 5}, collection: Budget}]",
    ].join("\n") } });
    await w.executor.open();
    const steps = async (executor = w.executor) => {
      const listed = await executor.automationsIn("Trip");
      return (listed as { automations: Array<{ definitionHash: string; reach: { steps: Array<{ verdict: string; seq: number }> } }> }).automations[0]!;
    };
    expect((await steps()).reach.steps).toMatchObject([{ verdict: "allowed" }]);

    // The next listing shows an Edit link on Trip that wrote automations directly and was
    // revoked before this computer listed it as an editor.
    w.setRoster({
      kind: "owner", ownerUserId: "user-owner", grants: [],
      formerEditors: [{ grantId: "g-link", generation: 1, holder: "link", recipientEmail: null, files: { paths: ["Trip"], versionId: null } }],
    });
    const before = w.holdsChanged();
    w.executor.rosterChanged();
    await w.until(() => w.holdsChanged() > before);
    const held = await steps();
    expect(held.reach.steps).toMatchObject([{ verdict: "held", stoppedFor: "Anyone who had your share link to Trip" }]);
    await expect(w.executor.confirmReach({
      automationId: "collection:Trip#spend", definitionHash: held.definitionHash, step: "0", seq: held.reach.steps[0]!.seq,
    })).resolves.toBe("confirmed");

    // Allow answered for that link: the next roster check and a restart keep it.
    const restarted = w.makeExecutor();
    await restarted.open();
    expect(restarted.holds()).toEqual([]);
    expect((await steps(restarted)).reach.steps).toMatchObject([{ verdict: "allowed" }]);
    await restarted.dispose();

    // The link had Edit again, wrote automations under a newer generation,
    // and ended before this computer listed it: that is new evidence.
    w.setRoster({
      kind: "owner", ownerUserId: "user-owner", grants: [],
      formerEditors: [{ grantId: "g-link", generation: 2, holder: "link", recipientEmail: null, files: { paths: ["Trip"], versionId: null } }],
    });
    const again = w.holdsChanged();
    w.executor.rosterChanged();
    await w.until(() => w.holdsChanged() > again);
    expect((await steps()).reach.steps).toMatchObject([{ verdict: "held", stoppedFor: "Anyone who had your share link to Trip" }]);
  });

  it("holds a step first seen after the owner revoked, from another computer, the recipient who wrote it", async () => {
    const w = await world({ collections: ["Trip", "Budget"], automations: { Trip: [
      "  - id: spend",
      "    name: Spend",
      "    when: {field-changed: Status}",
      "    do: [{add-record: {Amount: 5}, collection: Budget}]",
    ].join("\n") } });
    // Bob wrote Trip's automations directly. The owner revoked him on another
    // computer, and this computer lists the roster before it ever saw him.
    w.setRoster({
      kind: "owner", ownerUserId: "user-owner", grants: [],
      formerEditors: [{ grantId: "g-bob", generation: 1, holder: "person", recipientEmail: "bob@dohc.test", files: { paths: ["Trip"], versionId: null } }],
    });
    await w.executor.open();
    expect(await w.executor.automationsIn("Trip")).toMatchObject({
      automations: [{ reach: { kind: "checked", steps: [{ verdict: "held", stoppedFor: "bob@dohc.test" }] } }],
    });
    const trip = w.addRecord("Trip", "day-one", { Status: "Done" });
    const claim = w.claim("collection:Trip#spend", trip);
    const drained = w.idleDrains();
    w.executor.notifyClaimed();
    await w.until(() => w.idleDrains() > drained);
    expect(claim.state).toBe("running");
    expect([...w.records.values()].filter((record) => record.collection === "Budget")).toEqual([]);
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
    expect(w.writtenAs).toEqual([{ path: "Tasks/automations.yaml", automationId: "collection:Tasks#slow" }]);
    // Its own switch off is no person's, so nobody hears who did it.
    const reads = w.automationsChanged();
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    await w.until(() => w.automationsChanged() > reads);
    expect(w.switchedOff).toEqual([]);
  });

  it("leaves a claim for the next drain when the evaluator is busy", async () => {
    let calls = 0;
    const w = await world({
      automations: { Tasks: "  - id: calc\n    name: Calc\n    when: {field-changed: Status}\n    do: [{set: {X: '=1 + 1'}}]\n" },
      evaluator: {
        runCode: evaluator.runCode,
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
    const [run] = (await w.executor.runs("collection:Tasks#chain")).runs;
    expect(run!.writes.filter((write) => write.kind === "field").map((write) => write.kind === "field" && [write.before, write.after]))
      .toEqual([[0, 1], [1, 2]]);
  });

  it("reads one run with what started it and what each step changed", async () => {
    const two = "  - id: two\n    name: Two\n    when: {field-changed: Status}\n    do: [{set: {Count: 1}}, {set: {Note: a}}]\n";
    const w = await world({ automations: { Tasks: two } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 0 });
    // Step 1 lands; step 2 cannot open the record.
    w.failOpenAt(2);
    const claim = w.claim("collection:Tasks#two", task, { actorKind: "agent" });
    await w.executor.open();
    await w.settledClaim(claim);

    const read = await w.executor.run("collection:Tasks#two", claim.claimId);
    expect(read).toMatchObject({
      claimId: claim.claimId,
      state: "failed",
      error: "The record is open in a live session elsewhere.",
      trigger: { kind: "changed", recordId: task.id, by: "agent", sharedAuthor: null, depth: 0 },
      steps: [{ step: 1, writes: [{ kind: "field", recordId: task.id, path: task.path, field: "Count", before: 0, after: 1 }] }],
      failedStep: 2,
      startsOver: false,
    });
    expect(read).not.toHaveProperty("writes");
    const [listed] = (await w.executor.runs("collection:Tasks#two")).runs;
    expect(listed!.trigger).toEqual(read!.trigger);
    // Another computer's run, or one history no longer shows, is not here.
    await expect(w.executor.run("collection:Tasks#two", "atc_elsewhere")).resolves.toBeNull();

    await w.executor.retry({ automationId: "collection:Tasks#two", claimId: claim.claimId, startOver: false });
    await w.until(() => claim.state === "done");
    expect(await w.executor.run("collection:Tasks#two", claim.claimId)).toMatchObject({ failedStep: null, startsOver: false, steps: [{ step: 1 }, { step: 2 }] });
  });

  it("keeps the Edit link a live change came through in run history, and fills no person from it", async () => {
    const note = "  - id: note\n    name: Note\n    when: {field-changed: Status}\n    do: [{set: {Note: '=person == null ? trigger.author.kind : person.name'}}]\n";
    const w = await world({ automations: { Tasks: note } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 0 });
    const link = { kind: "link" as const, grantId: "grant-link", grantGeneration: 2, principalId: "holder-1" };
    const claim = w.claim("collection:Tasks#note", task, { actorKind: null, sharedAuthor: link });
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(w.fieldsOf(task).Note).toBe("link");
    const [listed] = (await w.executor.runs("collection:Tasks#note")).runs;
    expect(listed!.trigger).toEqual({ kind: "changed", recordId: task.id, by: null, sharedAuthor: link, depth: 0 });
  });

  const ITEMS = "  - id: tick\n    name: Tick\n    when: {field-changed: Status}\n    do:\n      - find: 'true'\n        collection: Items\n        as: items\n      - set: {Count: '=record.Count + 1'}\n        records: items\n";

  it.each([50, 51])("requires a complete Find before using its records with %i matches", async (count) => {
    let boundCount: number | undefined;
    const w = await world({
      collections: ["Tasks", "Items"], automations: { Tasks: ITEMS },
      evaluator: {
        runCode: evaluator.runCode,
        evaluate: async (...args) => {
          const items = args[1].bindings?.items;
          boundCount = Array.isArray(items) ? items.length : undefined;
          return evaluator.evaluate(...args);
        },
      },
    });
    const items = Array.from({ length: count }, (_, index) => w.addRecord("Items", `item-${index}`, { Count: 0 }));
    const claim = w.claim("collection:Tasks#tick", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);
    if (count === 50) {
      expect(claim.state).toBe("done");
      expect(boundCount).toBe(50);
      expect(items.map((item) => w.fieldsOf(item).Count)).toEqual(Array(50).fill(1));
    } else {
      expect(claim.state).toBe("failed");
      expect(claim.error).toBe("The Find in step 1 matched more than 50 records. Narrow its condition, then try again.");
      expect(boundCount).toBeUndefined();
      expect(w.saves()).toBe(0);
      expect(w.journaled).toEqual([]);
      expect(items.map((item) => w.fieldsOf(item).Count)).toEqual(Array(51).fill(0));
    }
  });

  it.each(["branch", "only-if", "count"])("handles a truncated Find in %s without partial writes", async (mode) => {
    const steps = mode === "branch" ? [
      "      - if: 'false'",
      "        do:",
      "          - find: 'true'",
      "            collection: Items",
      "            as: items",
      "          - set: {Count: '=record.Count + 1'}",
      "            records: items",
      "        otherwise: [{set: {Note: fallback}}]",
    ] : [
      "      - find: 'true'",
      "        collection: Items",
      "        as: items",
      "      - if: items.length > 50",
      "        do: [{set: {Note: many}}]",
      "        otherwise: [{set: {Note: few}}]",
    ];
    const body = [
      "  - id: overflow",
      "    name: Overflow",
      "    when: {field-changed: Status}",
      ...(mode === "only-if" ? ["    if: 'false'"] : []),
      "    do:",
      ...steps,
    ].join("\n");
    const w = await world({ collections: ["Tasks", "Items"], automations: { Tasks: body } });
    const items = Array.from({ length: 51 }, (_, index) => w.addRecord("Items", `item-${index}`, { Count: 0 }));
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const claim = w.claim("collection:Tasks#overflow", task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(items.map((item) => w.fieldsOf(item).Count)).toEqual(Array(51).fill(0));
    if (mode === "branch") {
      expect(claim.state).toBe("done");
      expect(w.fieldsOf(task).Note).toBe("fallback");
    } else {
      expect(w.journaled).toEqual([]);
      expect(w.saves()).toBe(0);
      if (mode === "only-if") {
        expect(claim.state).toBe("done");
        expect(claim.error).toBeUndefined();
      } else {
        expect(claim.state).toBe("failed");
        expect(claim.error).toBe("The Find in step 1 matched more than 50 records. Narrow its condition, then try again.");
        expect(w.fieldsOf(task).Note).toBeUndefined();
      }
    }
  });

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
      .resolves.toEqual({ status: "definition-changed", repeatsMessages: false });
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
    expect(claim.error).toBe("Step 2 would make this run change more than 200 fields. Narrow its Find steps, or split it into smaller automations.");
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
    const [run] = (await w.executor.runs("collection:Tasks#note")).runs;
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
    const [run] = (await w.executor.runs("collection:Tasks#two")).runs;
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
    await expect(w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, deletes: null }, trash))
      .resolves.toEqual({ status: "undone", reverted: 1, removed: 1, changedSince: 1, missing: 0, kept: 0, irreversible: 0, actions: 0, deleted: 0, keptChanged: 0, gone: 0, actionsReversed: 0 });
    expect(w.fieldsOf(task)).toMatchObject({ Count: 2, Note: "theirs" });
    expect(trashed).toEqual([added!.path]);
    expect(w.journaled.at(-1)).toMatchObject({ path: task.path, attribution: { actorKind: "human" } });
    expect(w.journaled.at(-1)!.actorOriginId).toBeUndefined();

    const [run] = (await w.executor.runs("collection:Tasks#stamp")).runs;
    expect(run).toMatchObject({ state: "done", undone: true, chainStopped: false });
    await expect(w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, deletes: null }, trash))
      .resolves.toEqual({ status: "refused", reason: "You already undid this run." });
  });

  it("undoes every finished run of the definitions a stopped person wrote, and no other", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: STAMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2, Note: "old" });
    const first = w.claim("collection:Tasks#stamp", task);
    await w.executor.open();
    await w.settledClaim(first);
    const second = w.claim("collection:Tasks#stamp", task);
    w.executor.notifyClaimed();
    await w.settledClaim(second);
    expect(w.fieldsOf(task).Count).toBe(4);
    const file = await w.executor.automationsIn("Tasks");
    if (file.status !== "read" || !file.automations[0]!.valid) throw new Error("expected Stamp to read");
    const hash = file.automations[0]!.definitionHash;

    await expect(w.executor.undoRunsOf([{ collectionPath: "Tasks", id: "stamp", definitionHash: "0000000000000000" }], async () => undefined))
      .resolves.toEqual({ undone: 0, left: 0, kept: 0, errorMessage: null });
    expect(w.fieldsOf(task).Count).toBe(4);
    await expect(w.executor.undoRunsOf([{ collectionPath: "Tasks", id: "stamp", definitionHash: hash }], async () => undefined))
      .resolves.toEqual({ undone: 2, left: 0, kept: 0, errorMessage: null });
    expect(w.fieldsOf(task)).toMatchObject({ Count: 2, Note: "old" });
    // Runs already undone are passed over.
    await expect(w.executor.undoRunsOf([{ collectionPath: "Tasks", id: "stamp", definitionHash: hash }], async () => undefined))
      .resolves.toEqual({ undone: 0, left: 0, kept: 0, errorMessage: null });
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

    await expect(w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, deletes: null }, async () => undefined))
      .resolves.toEqual({ status: "undone", reverted: 2, removed: 0, changedSince: 0, missing: 0, kept: 0, irreversible: 0, actions: 0, deleted: 0, keptChanged: 0, gone: 0, actionsReversed: 0 });
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
    await expect(w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, deletes: null }, async () => undefined))
      .rejects.toThrow("The record is open in a live session elsewhere.");
    expect(w.fieldsOf(task)).toMatchObject({ Count: 3, Note: "done" });
    const [stopped] = (await w.executor.runs("collection:Tasks#stamp")).runs;
    expect(stopped).toMatchObject({ undone: false });
    await expect(w.executor.retry({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, startOver: false }))
      .resolves.toEqual({ status: "refused", reason: UNDONE_RUN_ERROR });
    // Even once the automation changes, reading the run does not offer to start over: Try again refuses.
    await w.writeAutomations("Tasks", STAMP.replace("Title: Stamped", "Title: Stamped again"));
    // The executor reads the file again before it answers.
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    expect(await w.executor.run("collection:Tasks#stamp", claim.claimId)).toMatchObject({ definitionChanged: true, startsOver: false });
    await expect(w.executor.retry({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, startOver: true }))
      .resolves.toEqual({ status: "refused", reason: UNDONE_RUN_ERROR });
    await w.writeAutomations("Tasks", STAMP);
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    expect(await w.executor.run("collection:Tasks#stamp", claim.claimId)).toMatchObject({ definitionChanged: false });
    // A requeue from the engine's recovery does not resume the plan either.
    claim.state = "pending";
    w.requeue(claim);
    w.executor.notifyClaimed();
    await w.until(() => claim.state === "failed" && claim.error === UNDONE_RUN_ERROR);
    expect([...w.records.values()].filter((record) => record.collection === "Log")).toEqual([]);

    await expect(w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, deletes: null }, async () => undefined))
      .resolves.toEqual({ status: "undone", reverted: 2, removed: 0, changedSince: 0, missing: 0, kept: 0, irreversible: 0, actions: 0, deleted: 0, keptChanged: 0, gone: 0, actionsReversed: 0 });
    expect(w.fieldsOf(task)).toMatchObject({ Count: 2, Note: "old" });
    const [finished] = (await w.executor.runs("collection:Tasks#stamp")).runs;
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
    const [run] = (await w.executor.runs("collection:Tasks#log")).runs;
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
    await expect(w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, deletes: null }, async (path) => {
      trashed.push(path);
    })).resolves.toEqual({ status: "undone", reverted: 2, removed: 1, changedSince: 0, missing: 0, kept: 0, irreversible: 0, actions: 0, deleted: 0, keptChanged: 0, gone: 0, actionsReversed: 0 });
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
    const [run] = (await w.executor.runs("collection:Tasks#stamp")).runs;
    expect(run!.writes.filter((write) => write.kind === "field" && write.field === "Count")
      .map((write) => write.kind === "field" && [write.before, write.after])).toEqual([[2, 3], [3, 13]]);

    await w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, deletes: null }, async () => undefined);
    // Back to before the first version ran, not only before the second.
    expect(w.fieldsOf(task)).toMatchObject({ Count: 2, Note: "old" });
  });

  it("undoes only a stopped person's definition among a claim's runs", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: STAMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2, Note: "old" });
    w.failures.authoredWrite = 1;
    const claim = w.claim("collection:Tasks#stamp", task);
    await w.executor.open();
    await w.settledClaim(claim);
    const first = await w.executor.automationsIn("Tasks");
    if (first.status !== "read" || !first.automations[0]!.valid) throw new Error("expected Stamp to read");
    const firstHash = first.automations[0]!.definitionHash;

    await w.writeAutomations("Tasks", STAMP.replace("record.Count + 1", "record.Count + 10"));
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    await w.until(() => w.idleDrains() >= 2);
    await w.executor.retry({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, startOver: true });
    await w.until(() => claim.state === "done");
    const second = await w.executor.automationsIn("Tasks");
    if (second.status !== "read" || !second.automations[0]!.valid) throw new Error("expected Stamp to read");
    expect(w.fieldsOf(task).Count).toBe(13);

    // The person wrote only the second version: its run goes back, the first stays.
    await expect(w.executor.undoRunsOf(
      [{ collectionPath: "Tasks", id: "stamp", definitionHash: second.automations[0]!.definitionHash }],
      async () => undefined,
    )).resolves.toEqual({ undone: 1, left: 0, kept: 0, errorMessage: null });
    expect(w.fieldsOf(task).Count).toBe(3);
    expect(second.automations[0]!.definitionHash).not.toBe(firstHash);
  });

  it("lets only one of an Undo and a Try again started together change a run", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: STAMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    w.failures.authoredWrite = 1;
    const claim = w.claim("collection:Tasks#stamp", task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("failed");

    const undoing = w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, deletes: null }, async () => undefined);
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
    const [run] = (await w.executor.runs("collection:Tasks#stamp")).runs;
    expect(run).toMatchObject({ state: "failed", neverStarted: true, chainStopped: true, undone: false, writes: [] });
    // Try again by its id, as the CLI and MCP ask, is refused with a reason, not an error.
    await w.executor.open();
    await expect(w.executor.retry({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, startOver: true }))
      .resolves.toEqual({ status: "refused", reason: AUTOMATION_NEVER_STARTED_REFUSAL });
    expect(w.claims.get(claim.claimId)).toMatchObject({ state: "failed", attempts: 0 });
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

  it("keeps an automation off when its Collection uses a newer version", async () => {
    const w = await world({ automations: { Tasks: "  - id: done\n    name: Done\n    when: {field-changed: Status}\n    do: [{set: {Status: Done}}]\n" } });
    await writeFile(join(w.root, "Tasks", "collection.yaml"), `version: 2\n${SCHEMA}`);
    await w.executor.open();
    const listed = await w.executor.automationsIn("Tasks");
    expect(listed.status === "read" && listed.automations[0]).toMatchObject({
      cannotRun: "Tasks/collection.yaml uses a newer version. Update dohc to read this file.",
    });
    expect(w.subscriptions.has("collection:Tasks#done")).toBe(false);
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
  it("checks every field of the step a stop interrupted, so it keeps someone's change, and later steps start from it", async () => {
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
    // The third step had not started, so it sets Count as the automation says.
    expect(w.fieldsOf(task)).toMatchObject({ Count: 2, Note: "a" });
    const [run] = (await w.executor.runs("collection:Tasks#steps")).runs;
    expect(run!.writes.filter((write) => write.kind === "kept").map((write) => write.kind === "kept" && write.planned)).toEqual([1]);
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
    expect(claim.error).toBe("Step 2 would make this run change more data than dohc can save for it. Narrow its Find steps, or split it into smaller automations.");
    expect(w.journaled).toEqual([]);
  });

  it("records no reach for an automation dohc cannot run yet", async () => {
    const unsupported = [
      "  - id: code",
      "    name: Code",
      "    when: {field-changed: Status}",
      "    do: [{set: {X: 1}}, {invoke: tasks.archive}]",
    ].join("\n");
    const w = await world({ automations: { Tasks: unsupported } });
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

  it("expires run history at open, then at most hourly after a run settles, keeping each run an unfinished Undo names", async () => {
    const note = "  - id: note\n    name: Note\n    when: {field-changed: Status}\n    do: [{set: {Note: seen}}]\n";
    const w = await world({ automations: { Tasks: note } });
    let now = 1_000;
    const executor = w.makeExecutor({ nowMs: () => now });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const first = w.claim("collection:Tasks#note", task);
    await executor.open();
    await w.settledClaim(first);
    await w.until(() => w.expiries() === 1 && w.lastSaved(first.claimId)?.settled === true);
    expect(w.historyPrunes).toEqual([[]]);
    const [saved] = (await w.baseStore.runsOf("collection:Tasks#note", first.claimId)).runs;
    await w.baseStore.save({ ...saved!, undo: "started" });
    now += 60 * 60 * 1000 - 1;
    const second = w.claim("collection:Tasks#note", task);
    executor.notifyClaimed();
    await w.settledClaim(second);
    expect(w.historyPrunes).toHaveLength(1);
    now += 1;
    w.claim("collection:Tasks#note", task);
    executor.notifyClaimed();
    await w.until(() => w.historyPrunes.length === 2);
    expect(w.historyPrunes[1]).toEqual([first.claimId]);
    await executor.dispose();
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
    // Only the settle the engine took marks the run done.
    await w.until(() => w.lastSaved(claim.claimId)?.settled === true);
  });
  it("expires saved runs 30 days after they ended once the engine let their claim go, and keeps a failure it may still try again", async () => {
    const note = "  - id: note\n    name: Note\n    when: {field-changed: Status}\n    do: [{set: {Note: seen}}]\n";
    const w = await world({ automations: { Tasks: note } });
    let now = Date.UTC(2026, 8, 1);
    const executor = w.makeExecutor({ nowMs: () => now });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const saved = async (claim: AutomationClaim) => (await w.baseStore.runsOf("collection:Tasks#note", claim.claimId)).runs.length;
    const settle = async () => {
      const claim = w.claim("collection:Tasks#note", task);
      executor.notifyClaimed();
      return await w.settledClaim(claim);
    };
    await executor.open();
    const done = await settle();
    w.failures.openSession = 1;
    const failed = await settle();
    expect(failed.state).toBe("failed");
    await w.until(() => w.expiries() === 1);
    expect([await saved(done), await saved(failed)]).toEqual([1, 1]);
    // The first pass after 30 days removes the done run the engine let go. The engine still offers the failure's Try again.
    now += 30 * 24 * 60 * 60 * 1000 + 1;
    w.claims.delete(done.claimId);
    const later = await settle();
    await w.until(() => w.expiries() === 2);
    expect([await saved(done), await saved(failed), await saved(later)]).toEqual([0, 1, 1]);
    // Once the engine lets the failure go, its run goes too.
    w.claims.delete(failed.claimId);
    now += 60 * 60 * 1000;
    await settle();
    await w.until(() => w.expiries() === 3);
    expect(await saved(failed)).toBe(0);
    await executor.dispose();
  });

  it("refuses to run again a run that run history no longer shows", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: BUMP } });
    await w.executor.open();
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
    expect(holds).toMatchObject([{ automationId: "collection:Tasks#seen", step: "0", stoppedFor: null }]);
    await w.executor.confirmReach({ automationId: holds[0]!.automationId, definitionHash: holds[0]!.definitionHash, step: "0", seq: holds[0]!.seq });
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

  it("fails a document Collection's claim for an automation that runs a Collection action, with the reason the panel shows, before any write", async () => {
    const w = await world({ automations: { Tasks: "  - id: act\n    name: Act\n    when: record-added\n    do:\n      - set: {Seen: true}\n      - if: 'false'\n        do: [{set: {Seen: false}}]\n        otherwise: [{invoke: tasks.archive}]\n" } });
    const claim = w.claim("collection:Tasks#act", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim).toMatchObject({ state: "failed", error: expect.stringMatching(/cannot name a table or a Collection action/) });
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
    expect(w.runsChanged).toEqual([]);
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

describe("Collection automations that post", () => {
  const TRIP: ChatDirectoryChannel = {
    id: "trip", name: "Trip", slug: "trip", kind: "channel", type: "posts", wireId: "trip", runningThreadId: null,
  };
  const DM_ANA: ChatDirectoryChannel = {
    id: "dm-ana", name: "ana@dohc.test", slug: "dm-ana", kind: "dm", type: "chat", wireId: "dm-ana", runningThreadId: "thread-dm-ana",
  };
  // Ana holds the direct message's grant and nothing else, so she is not an editor.
  const ANA_IN_DM: RosterGrant = {
    grantId: "grant-dm-ana", recipientUserId: "user-ana", recipientEmail: "ana@dohc.test", files: null, channel: { wireId: "dm-ana", canPost: true },
  };
  const post = (...steps: string[]) => [
    "  - id: tell",
    "    name: Tell the trip",
    "    when: {field-changed: Status}",
    "    do:",
    ...steps,
  ].join("\n");


  it("includes chat steps in share warnings and held summaries", async () => {
    const w = await world({ channels: [TRIP], automations: { Tasks: post("      - post: Done", "        group: Trip") } });
    await w.executor.open();
    await w.executor.automationsIn("Tasks");
    await expect(w.executor.shareImpact({ paths: ["Tasks"], versionId: null, access: "edit", recipientEmail: "bob@dohc.test" })).resolves.toEqual([
      { automationId: "collection:Tasks#tell", automationName: "Tell the trip", collectionPath: "Tasks", target: "Trip", action: "post" },
    ]);
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("bob@dohc.test", ["Tasks"])] });
    await w.executor.automationsIn("Tasks");
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [] });
    const listed = await w.executor.automationsIn("Tasks");
    expect(listed).toMatchObject({ automations: [{ reach: { kind: "checked", steps: [{ verdict: "held", target: "Trip", action: "post" }] } }] });
  });

  it("posts in a Group and sends a direct message as the automation, keyed so a retry writes each once", async () => {
    const w = await world({
      channels: [TRIP, DM_ANA],
      automations: { Tasks: post(
        "      - post: 'Done: {record.Status}'",
        "        group: Trip",
        "      - direct-message: Your task is done",
        "        to: [user-ana]",
      ) },
    });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [ANA_IN_DM] });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const claim = w.claim("collection:Tasks#tell", task);
    await w.executor.open();
    await w.settledClaim(claim);

    expect(claim.state).toBe("done");
    const definition = parseAutomationsFile(await readFile(join(w.root, "Tasks", "automations.yaml"), "utf8"));
    if (definition.status !== "read" || definition.entries[0]?.status !== "valid") throw new Error("unreadable fixture");
    const seed = `${definitionHash(definition.entries[0].automation)}-1`;
    const postId = `${stepKey(claim.claimId, seed, 0)}/post`;
    const dmId = `${stepKey(claim.claimId, seed, 1)}/dm/user-ana`;
    const automation = { automationId: "collection:Tasks#tell", name: "Tell the trip", depth: 1 };
    expect(w.messages).toEqual([
      expect.objectContaining({
        target: { kind: "group", channelId: "trip", lane: "posts" },
        effectId: postId, messageId: automationMessageId(postId), automation, body: "Done: Done",
      }),
      expect.objectContaining({
        target: { kind: "direct-message", threadId: "thread-dm-ana" },
        effectId: dmId, messageId: automationMessageId(dmId), automation, body: "Your task is done",
      }),
    ]);
    const [run] = (await w.executor.runs("collection:Tasks#tell")).runs;
    expect(run!.writes).toEqual([
      { kind: "message", messageId: automationMessageId(postId), name: "Trip" },
      { kind: "message", messageId: automationMessageId(dmId), name: "your direct message with ana@dohc.test" },
    ]);
  });

  it("writes into a chat Group's running conversation", async () => {
    const w = await world({
      channels: [{ ...TRIP, type: "chat" }],
      automations: { Tasks: post("      - post: Done", "        group: Trip") },
    });
    const claim = w.claim("collection:Tasks#tell", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);

    expect(w.messages.map((message) => message.target)).toEqual([{ kind: "group", channelId: "trip", lane: "chat" }]);
  });

  it("fails without writing when the Group or the direct message does not exist", async () => {
    const w = await world({
      channels: [TRIP],
      automations: { Tasks: [
        post("      - post: Done", "        group: Nowhere"),
        "  - id: dm",
        "    name: Tell Bob",
        "    when: {field-changed: Status}",
        "    do: [{direct-message: Done, to: [user-bob]}]",
      ].join("\n") },
    });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const group = w.claim("collection:Tasks#tell", task);
    const direct = w.claim("collection:Tasks#dm", task);
    await w.executor.open();
    await w.settledClaim(group);
    await w.settledClaim(direct);

    expect(group).toMatchObject({ state: "failed", error: "dohc cannot find the Group Nowhere." });
    expect(direct).toMatchObject({
      state: "failed",
      error: "There is no direct message with that person yet. Start one first: automations never start one.",
    });
    expect(w.chatWrites()).toBe(0);
  });

  it("stops a post that an editor could not make, including to a person a formula names", async () => {
    const w = await world({
      channels: [TRIP, DM_ANA],
      automations: { Tasks: [
        post("      - post: Done", "        group: Trip"),
        "  - id: dm",
        "    name: Tell Ana",
        "    when: {field-changed: Status}",
        "    do: [{direct-message: Done, to: ['=\"user-ana\"']}]",
      ].join("\n") },
    });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("bob@dohc.test", ["Tasks"]), ANA_IN_DM] });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const group = w.claim("collection:Tasks#tell", task);
    const direct = w.claim("collection:Tasks#dm", task);
    await w.executor.open();
    await w.settledClaim(group);
    await w.settledClaim(direct);

    expect(group).toMatchObject({ state: "failed", error: "bob@dohc.test cannot post in Trip." });
    expect(direct).toMatchObject({
      state: "failed", error: "bob@dohc.test cannot post in your direct message with ana@dohc.test.",
    });
    expect(w.chatWrites()).toBe(0);
  });

  it("holds a direct message to a person a formula named once an editor's leaving allows it, until Allow", async () => {
    const tellAna = post("      - direct-message: Done", "        to: ['=\"user-ana\"']");
    const w = await world({ channels: [DM_ANA], automations: { Tasks: tellAna } });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("bob@dohc.test", ["Tasks"]), ANA_IN_DM] });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const first = w.claim("collection:Tasks#tell", task);
    await w.executor.open();
    await w.settledClaim(first);
    expect(first).toMatchObject({ state: "failed", error: "bob@dohc.test cannot post in your direct message with ana@dohc.test." });

    // Bob leaves. What his reach stopped now waits for a current editor.
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [ANA_IN_DM] });
    const second = w.claim("collection:Tasks#tell", task);
    w.executor.notifyClaimed();
    await w.until(() => w.events.includes(`released ${second.claimId}`));
    expect(w.messages).toEqual([]);
    const [hold] = w.executor.holds();
    expect(hold).toMatchObject({
      action: "post", target: "your direct message with ana@dohc.test", recipient: "user-ana", stoppedFor: "bob@dohc.test",
    });

    await expect(w.executor.confirmReach({ ...hold!, recipient: hold!.recipient! })).resolves.toBe("confirmed");
    await w.settledClaim(second);
    expect(second.state).toBe("done");
    expect(w.messages).toHaveLength(1);
  });

  it("does not send a saved direct message after its people changed", async () => {
    const w = await world({
      channels: [DM_ANA],
      automations: { Tasks: post("      - direct-message: Done", "        to: [user-ana]") },
    });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [ANA_IN_DM] });
    let signedIn = false;
    w.beforeChatWrite(async () => {
      if (!signedIn) throw new AutomationChatSessionWait();
    });
    const claim = w.claim("collection:Tasks#tell", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.until(() => w.events.includes(`released ${claim.claimId}`));

    // While the run waited, someone else was invited to the conversation.
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [
      ANA_IN_DM, { grantId: "grant-dm-eve", recipientUserId: null, recipientEmail: "eve@dohc.test", files: null, channel: { wireId: "dm-ana", canPost: true } },
    ] });
    signedIn = true;
    w.executor.sessionChanged();
    await w.settledClaim(claim);
    expect(claim).toMatchObject({
      state: "failed",
      error: "The people in your direct message with ana@dohc.test changed since this run began, so dohc did not send its message.",
    });
    expect(w.messages).toEqual([]);
  });

  it("keeps each formula-named person's hold apart through a restart, until Allow", async () => {
    const DM_CARA: ChatDirectoryChannel = { ...DM_ANA, id: "dm-cara", name: "cara@dohc.test", slug: "dm-cara", wireId: "dm-cara", runningThreadId: "thread-dm-cara" };
    const CARA_IN_DM: RosterGrant = {
      grantId: "grant-dm-cara", recipientUserId: "user-cara", recipientEmail: "cara@dohc.test", files: null, channel: { wireId: "dm-cara", canPost: true },
    };
    const tellBoth = post("      - direct-message: Done", "        to: ['=[\"user-ana\", \"user-cara\"]']");
    const w = await world({ channels: [DM_ANA, DM_CARA], automations: { Tasks: tellBoth } });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("bob@dohc.test", ["Tasks"]), ANA_IN_DM, CARA_IN_DM] });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const first = w.claim("collection:Tasks#tell", task);
    await w.executor.open();
    await w.settledClaim(first);
    expect(first.state).toBe("failed");

    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [ANA_IN_DM, CARA_IN_DM] });
    const second = w.claim("collection:Tasks#tell", task);
    w.executor.notifyClaimed();
    await w.until(() => w.events.includes(`released ${second.claimId}`));
    expect(w.executor.holds().map((hold) => hold.recipient)).toEqual(["user-ana", "user-cara"]);

    // A restart reads the holds back, one per person, and still sends nothing.
    await w.executor.dispose();
    const reopened = w.makeExecutor();
    await reopened.open();
    await w.until(() => w.events.filter((event) => event === `released ${second.claimId}`).length >= 2);
    expect(w.messages).toEqual([]);
    const holds = reopened.holds();
    expect(holds.map((hold) => hold.recipient)).toEqual(["user-ana", "user-cara"]);
    await reopened.confirmReach({ ...holds[0]!, recipient: holds[0]!.recipient! });
    expect(reopened.holds().map((hold) => hold.recipient)).toEqual(["user-cara"]);
    await reopened.confirmReach({ ...holds[1]!, recipient: holds[1]!.recipient! });
    await w.settledClaim(second);
    expect(w.messages.map((message) => message.target)).toEqual([
      { kind: "direct-message", threadId: "thread-dm-ana" },
      { kind: "direct-message", threadId: "thread-dm-cara" },
    ]);
  });

  it("reads only the conversations of the people a formula named", async () => {
    const w = await world({
      channels: [DM_ANA],
      automations: { Tasks: post("      - direct-message: Done", "        to: ['=\"user-ana\"']") },
    });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [ANA_IN_DM] });
    const claim = w.claim("collection:Tasks#tell", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);

    expect(claim.state).toBe("done");
    const people = w.directoryNeeds.map((needs) => [...needs.people]);
    // Before the formula runs no conversation is read; after, only Ana's.
    expect(people).toContainEqual([]);
    expect(people).toContainEqual(["user-ana"]);
    expect(people.flat().every((userId) => userId === "user-ana")).toBe(true);
  });

  it("asks before a start-over that could send an automation's messages again", async () => {
    const w = await world({ channels: [TRIP], automations: { Tasks: post("      - post: Done", "        group: Trip") } });
    w.beforeChatWrite(async () => { throw new Error("The server did not answer."); });
    const claim = w.claim("collection:Tasks#tell", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("failed");

    await w.writeAutomations("Tasks", post("      - post: Done again", "        group: Trip"));
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    await w.until(() => w.idleDrains() >= 2);
    await expect(w.executor.retry({ automationId: "collection:Tasks#tell", claimId: claim.claimId, startOver: false }))
      .resolves.toEqual({ status: "definition-changed", repeatsMessages: true });
  });

  it("checks a run again where its Collection is now when it moves while the run writes", async () => {
    const w = await world({ channels: [TRIP], automations: { Tasks: post("      - post: Done", "        group: Trip", "      - set: {Count: 1}") } });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    w.beforeChatWrite(async () => {
      w.beforeChatWrite(null);
      await w.renameCollection("Tasks", "Voyage");
      await w.until(() => (w.subscriptions.get("collection:Tasks#tell") as { path?: string } | undefined)?.path === "Voyage");
    });
    const claim = w.claim("collection:Tasks#tell", task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    // The run stopped after its post and resumed in the moved Collection.
    expect(w.events).toContain(`released ${claim.claimId}`);
    expect(w.messages).toHaveLength(1);
    expect(w.fieldsOf(task)).toEqual({ Status: "Done", Count: 1 });
  });

  it("fails when its own Collection is deleted while the run writes", async () => {
    const w = await world({ channels: [TRIP], automations: { Tasks: post(
      "      - post: First", "        group: Trip", "      - post: Second", "        group: Trip",
    ) } });
    w.beforeChatWrite(async () => {
      w.beforeChatWrite(null);
      await w.removeCollection("Tasks");
      await w.until(() => !w.subscriptions.has("collection:Tasks#tell"));
    });
    const claim = w.claim("collection:Tasks#tell", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim).toMatchObject({ state: "failed", error: "This automation's Collection is gone." });
    expect(w.messages).toHaveLength(1);
    expect(w.events).not.toContain(`released ${claim.claimId}`);
    expect((await w.executor.runs("collection:Tasks#tell")).runs).toMatchObject([
      { state: "failed", error: "This automation's Collection is gone." },
    ]);
  });

  it("waits for a session in a synced workspace, then posts once one arrives", async () => {
    const w = await world({ channels: [TRIP], automations: { Tasks: post("      - post: Done", "        group: Trip") } });
    let signedIn = false;
    w.beforeChatWrite(async () => {
      if (!signedIn) throw new AutomationChatSessionWait();
    });
    const claim = w.claim("collection:Tasks#tell", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.until(() => w.events.includes(`released ${claim.claimId}`));
    expect(claim.state).toBe("pending");
    expect(w.messages).toEqual([]);

    signedIn = true;
    w.executor.sessionChanged();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(w.messages).toHaveLength(1);
  });
});

describe("Collection automations that notify", () => {
  const viewer = (email: string, paths: string[]): RosterGrant => ({
    grantId: `grant-${email}`, recipientUserId: `user-${email}`, recipientEmail: email,
    files: { paths, versionId: null, access: "view" }, channel: null,
  });
  const notify = (to: string, text = "Done: {record.Status}") => [
    "  - id: tell",
    "    name: Tell people",
    "    when: {field-changed: Status}",
    `    do: [{notify: '${text}', to: ${to}}]`,
  ].join("\n");

  it("reports a newly allowed named notice recipient as held", async () => {
    const w = await world({ automations: { Tasks: notify("[user-ana@dohc.test]") } });
    await w.executor.open();
    await w.executor.automationsIn("Tasks");
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [viewer("ana@dohc.test", ["Tasks"])] });
    expect(await w.executor.automationsIn("Tasks")).toMatchObject({ automations: [{ reach: { steps: [{ verdict: "held", action: "notify" }] } }] });
  });

  it("sends each person one notice with the automation's name, the text, and where it points", async () => {
    const long = "x".repeat(600);
    const w = await world({ automations: { Tasks: notify("[user-owner, user-ana@dohc.test]", long) } });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [viewer("ana@dohc.test", ["Tasks"])] });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const claim = w.claim("collection:Tasks#tell", task);
    await w.executor.open();
    await w.settledClaim(claim);

    expect(claim.state).toBe("done");
    const definition = parseAutomationsFile(await readFile(join(w.root, "Tasks", "automations.yaml"), "utf8"));
    if (definition.status !== "read" || definition.entries[0]?.status !== "valid") throw new Error("unreadable fixture");
    const key = stepKey(claim.claimId, `${definitionHash(definition.entries[0].automation)}-1`, 0);
    const notice = (recipientUserId: string) => ({
      noticeId: automationNoticeId(key, recipientUserId),
      kind: "automation-notify",
      title: "Tell people",
      body: `${"x".repeat(499)}…`,
      target: { path: task.path, record: task.id, automation: "collection:Tasks#tell", run: claim.claimId },
      recipientUserId,
    });
    expect(w.notices).toEqual([notice("user-owner"), notice("user-ana@dohc.test")]);
    // Each notice goes out under the run's signal, so a stop ends it before it sends.
    expect(w.noticeSignals).toHaveLength(2);
    expect(w.noticeSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    const [run] = (await w.executor.runs("collection:Tasks#tell")).runs;
    expect(run!.writes).toEqual([
      { kind: "notice", noticeId: automationNoticeId(key, "user-owner"), name: "you" },
      { kind: "notice", noticeId: automationNoticeId(key, "user-ana@dohc.test"), name: "ana@dohc.test" },
    ]);
  });

  it("notifies nobody when a person is not among the workspace's people or cannot view the Collection", async () => {
    const w = await world({
      collections: ["Tasks", "Budget"],
      automations: { Tasks: [
        notify("[user-zed]"),
        "  - id: far",
        "    name: Tell Bob",
        "    when: {field-changed: Status}",
        "    do: [{notify: Done, to: ['=\"user-bob@dohc.test\"']}]",
      ].join("\n") },
    });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [viewer("bob@dohc.test", ["Budget"])] });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const unknown = w.claim("collection:Tasks#tell", task);
    const far = w.claim("collection:Tasks#far", task);
    await w.executor.open();
    await w.settledClaim(unknown);
    await w.settledClaim(far);

    expect(unknown).toMatchObject({ state: "failed", error: "that person cannot view Tasks." });
    expect(far).toMatchObject({ state: "failed", error: "bob@dohc.test cannot view Tasks." });
    expect(w.notices).toEqual([]);
  });

  it("holds a notice to a person a formula named once they can newly view the Collection, until Allow", async () => {
    const w = await world({ collections: ["Tasks", "Budget"], automations: { Tasks: notify("['=\"user-ana@dohc.test\"']") } });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [viewer("ana@dohc.test", ["Budget"])] });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const first = w.claim("collection:Tasks#tell", task);
    await w.executor.open();
    await w.settledClaim(first);
    expect(first).toMatchObject({ state: "failed", error: "ana@dohc.test cannot view Tasks." });

    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [viewer("ana@dohc.test", ["Tasks"])] });
    const second = w.claim("collection:Tasks#tell", task);
    w.executor.notifyClaimed();
    await w.until(() => w.events.includes(`released ${second.claimId}`));
    const [hold] = w.executor.holds();
    expect(hold).toMatchObject({ action: "notify", target: "ana@dohc.test", recipient: "user-ana@dohc.test" });
    await w.executor.confirmReach({ ...hold!, recipient: hold!.recipient! });
    await w.settledClaim(second);
    expect(w.notices.map((notice) => notice.recipientUserId)).toEqual(["user-ana@dohc.test"]);
  });

  it("fails on a notice that did not reach its person, and Try again notifies only the people left", async () => {
    const w = await world({ automations: { Tasks: notify("[user-owner, user-ana@dohc.test]") } });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [viewer("ana@dohc.test", ["Tasks"])] });
    const posted: string[] = [];
    let full = true;
    w.beforeNotice(async (notice) => {
      posted.push(notice.recipientUserId);
      if (full && notice.recipientUserId === "user-ana@dohc.test") {
        throw new NoticeNotSentError("This person has too many unread notices to get this one.");
      }
    });
    const claim = w.claim("collection:Tasks#tell", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim).toMatchObject({
      state: "failed",
      error: "dohc could not notify ana@dohc.test. This person has too many unread notices to get this one.",
    });

    full = false;
    await w.executor.retry({ automationId: "collection:Tasks#tell", claimId: claim.claimId, startOver: false });
    await w.until(() => claim.state === "done");
    expect(posted).toEqual(["user-owner", "user-ana@dohc.test", "user-ana@dohc.test"]);
    expect(w.notices.map((notice) => notice.recipientUserId)).toEqual(["user-owner", "user-ana@dohc.test"]);
  });
});

describe("Collection automations that wake your agent", () => {
  const ask = [
    "  - id: ask",
    "    name: Ask my agent",
    "    when: {field-changed: Status}",
    "    do: [{wake-agent: 'Plan {record.Status}', person: user-owner}]",
  ].join("\n");

  it("includes agent wakes in share warnings and held summaries", async () => {
    const w = await world({ automations: { Tasks: ask } });
    await w.executor.open();
    await w.executor.automationsIn("Tasks");
    expect(await w.executor.shareImpact({ paths: ["Tasks"], versionId: null, access: "edit", recipientEmail: "bob@dohc.test" })).toMatchObject([{ target: "your agent", action: "wake" }]);
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("bob@dohc.test", ["Tasks"])] });
    await w.executor.automationsIn("Tasks");
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [] });
    expect(await w.executor.automationsIn("Tasks")).toMatchObject({ automations: [{ reach: { steps: [{ verdict: "held", target: "your agent", action: "wake" }] } }] });
  });

  it("sends the automation's message to the person's agent when they alone edit the Collection", async () => {
    const w = await world({ automations: { Tasks: ask } });
    const claim = w.claim("collection:Tasks#ask", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);

    expect(claim.state).toBe("done");
    expect(w.messages).toEqual([expect.objectContaining({
      target: { kind: "agent" },
      threadId: automationWakeThreadId("collection:Tasks#ask"),
      automation: { automationId: "collection:Tasks#ask", name: "Ask my agent", depth: 1 },
      body: "Plan Done",
    })]);
    const [run] = (await w.executor.runs("collection:Tasks#ask")).runs;
    expect(run!.writes).toEqual([{ kind: "message", messageId: w.messages[0]!.messageId, name: "your agent" }]);
  });

  it("wakes the agent for a change an agent or another automation made, one level deeper", async () => {
    // The woken agent changes a task; Stamp stamps it; Ask, seeing Stamp's
    // change, wakes the agent again. Each hop carries the chain one deeper,
    // so the engine stops the loop at the cap.
    const w = await world({ automations: { Tasks: [
      "  - id: stamp",
      "    name: Stamp",
      "    when: {field-changed: Status}",
      "    do: [{set: {Stamped: true}}]",
      ask.replace("{field-changed: Status}", "{field-changed: Stamped}"),
    ].join("\n") } });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const fromAgent = w.claim("collection:Tasks#stamp", task, { actorKind: "agent", authorOriginId: "dohc-chat-runner" });
    fromAgent.depth = 1;
    await w.executor.open();
    await w.settledClaim(fromAgent);
    expect(fromAgent.state).toBe("done");
    expect(w.fieldsOf(task).Stamped).toBe(true);
    expect(w.journaled.at(-1)?.attribution).toMatchObject({ actorKind: "automation", depth: 2 });

    const fromStamp = w.claim("collection:Tasks#ask", task, {
      actorKind: "automation", authorOriginId: "collection:Tasks#stamp",
      fields: [{ field: "Stamped", historyId: 99, previous: null, next: { value: true } }],
    });
    fromStamp.depth = 2;
    w.executor.notifyClaimed();
    await w.settledClaim(fromStamp);
    expect(fromStamp.state).toBe("done");
    expect(w.messages).toEqual([expect.objectContaining({
      target: { kind: "agent" },
      automation: { automationId: "collection:Tasks#ask", name: "Ask my agent", depth: 3 },
    })]);
  });

  it("fails a wake with the reason when dohc cannot check who can edit, instead of waiting for a sign-in", async () => {
    const w = await world({ automations: { Tasks: ask } });
    w.setRoster({ kind: "unknown", problem: { kind: "unchecked", next: "Sign in, then try again." } });
    const claim = w.claim("collection:Tasks#ask", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim).toMatchObject({ state: "failed", error: "dohc could not check who can edit Tasks. Sign in, then try again." });
    expect(w.messages).toEqual([]);
  });

  it("does not wake an agent when no account says who this computer's person is", async () => {
    const w = await world({ automations: { Tasks: ask } });
    w.setRoster({ kind: "owner", ownerUserId: null, grants: [] });
    const claim = w.claim("collection:Tasks#ask", w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim).toMatchObject({ state: "failed", error: PERSONAL_NEEDS_ACCOUNT });
  });

  describe("signed out, in a workspace proved never shared", () => {
    const local = [
      "  - id: local",
      "    name: Ask and tell me",
      "    when: {field-changed: Status}",
      "    do: [{wake-agent: Plan, person: install-here}, {notify: Done, to: [install-here]}]",
    ].join("\n");
    const provedLocal: ReachRoster = { kind: "owner", ownerUserId: null, localPersonId: "install-here", grants: [] };

    it("wakes this computer's agent and notifies its person by this computer's id for them", async () => {
      const w = await world({ automations: { Tasks: local } });
      w.setRoster(provedLocal);
      const claim = w.claim("collection:Tasks#local", w.addRecord("Tasks", "one", { Status: "Done" }));
      await w.executor.open();
      await w.settledClaim(claim);

      expect(claim.state).toBe("done");
      expect(w.messages).toEqual([expect.objectContaining({ target: { kind: "agent" }, body: "Plan" })]);
      expect(w.notices.map((notice) => notice.recipientUserId)).toEqual(["install-here"]);
      const [run] = await w.executor.runs("collection:Tasks#local");
      expect(run!.writes).toEqual([
        { kind: "message", messageId: w.messages[0]!.messageId, name: "your agent" },
        expect.objectContaining({ kind: "notice", name: "you" }),
      ]);
    });

    it("refuses a step for another computer's id or an account, and starts no direct message", async () => {
      const step = (id: string, action: string) => [
        `  - id: ${id}`,
        `    name: ${id}`,
        "    when: {field-changed: Status}",
        `    do: [${action}]`,
      ].join("\n");
      const w = await world({ automations: { Tasks: [
        step("copied", "{wake-agent: Plan, person: install-elsewhere}"),
        step("account", "{wake-agent: Plan, person: user-owner}"),
        step("tell", "{notify: Done, to: [user-ana@dohc.test]}"),
        step("dm", "{direct-message: Done, to: [install-here]}"),
      ].join("\n") } });
      w.setRoster(provedLocal);
      const task = w.addRecord("Tasks", "one", { Status: "Done" });
      const claims = ["copied", "account", "tell", "dm"].map((id) => w.claim(`collection:Tasks#${id}`, task));
      await w.executor.open();
      for (const claim of claims) await w.settledClaim(claim);

      expect(claims.map((claim) => [claim.state, claim.error])).toEqual([
        ["failed", PERSONAL_NEEDS_ACCOUNT],
        ["failed", PERSONAL_NEEDS_ACCOUNT],
        ["failed", "that person cannot view Tasks."],
        ["failed", "There is no direct message with you yet. Start one first: automations never start one."],
      ]);
      expect(w.messages).toEqual([]);
      expect(w.notices).toEqual([]);
    });

    it("keeps the same person after a sign-in, and stops once the workspace is no longer proved never shared", async () => {
      const w = await world({ automations: { Tasks: local } });
      w.setRoster({ ...provedLocal, ownerUserId: "user-owner" });
      const task = w.addRecord("Tasks", "one", { Status: "Done" });
      const signedIn = w.claim("collection:Tasks#local", task);
      await w.executor.open();
      await w.settledClaim(signedIn);
      expect(signedIn.state).toBe("done");
      expect(w.notices.map((notice) => notice.recipientUserId)).toEqual(["install-here"]);

      w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [] });
      const synced = w.claim("collection:Tasks#local", task);
      w.executor.notifyClaimed();
      await w.settledClaim(synced);
      expect(synced).toMatchObject({ state: "failed", error: "This step acts as that person, and you can also edit Tasks." });
      expect(w.messages).toHaveLength(1);
      expect(w.notices).toHaveLength(1);
    });
  });

  it("stops when someone else can also edit the Collection, or the step names another person", async () => {
    const w = await world({ automations: { Tasks: [
      ask,
      "  - id: other",
      "    name: Ask Ana's agent",
      "    when: {field-changed: Status}",
      "    do: [{wake-agent: Plan, person: user-ana@dohc.test}]",
    ].join("\n") } });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("bob@dohc.test", ["Tasks"])] });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const mine = w.claim("collection:Tasks#ask", task);
    const others = w.claim("collection:Tasks#other", task);
    await w.executor.open();
    await w.settledClaim(mine);
    await w.settledClaim(others);

    expect(mine).toMatchObject({ state: "failed", error: "This step acts as you, and bob@dohc.test can also edit Tasks." });
    expect(others).toMatchObject({ state: "failed", error: "This step acts as that person, and you can also edit Tasks." });
    expect(w.messages).toEqual([]);
  });
});

describe("Collection automations that a Group message starts", () => {
  const TRIP: ChatDirectoryChannel = {
    id: "trip", name: "Trip", slug: "trip", kind: "channel", type: "posts", wireId: "trip", runningThreadId: null,
  };
  const task = [
    "  - id: task",
    "    name: Add a task",
    "    when: {group-message: Trip, starts-with: /task}",
    "    do: [{add-record: {Title: '=message.body.slice(6)', Asked by: '=person.name'}}]",
  ].join("\n");
  const messageClaim = (
    w: Awaited<ReturnType<typeof world>>,
    message: Partial<AutomationClaimMessage> = {},
  ) => {
    const claim = w.claim("collection:Tasks#task", w.addRecord("Tasks", "unused", {}), { fields: [] });
    claim.recordId = null;
    claim.trigger = { key: "message:m1" };
    claim.change = { ...claim.change, kind: "message", message: {
      id: "m1", threadId: "t1", groupId: "trip", lane: "posts", authorKind: "human",
      authorDisplayName: "Ana", authorUserId: "user-ana", createdAtMs: 1, body: "/task Buy tickets", ...message,
    } };
    return claim;
  };
  const added = (w: Awaited<ReturnType<typeof world>>) =>
    [...w.records.values()].filter((record) => record.path.startsWith("Tasks/task-")).map((record) => w.fieldsOf(record));

  it("names the person whose message started a failed run in its notice", async () => {
    const w = await world({ channels: [TRIP], collections: ["Tasks", "Budget"], automations: { Tasks: [
      "  - id: task",
      "    name: Add a task",
      "    when: {group-message: Trip, starts-with: /task}",
      "    do: [{add-record: {Amount: 5}, collection: Budget}]",
    ].join("\n") } });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("ana@dohc.test", ["Tasks"])] });
    const claim = messageClaim(w);
    claim.change = { ...claim.change, onBehalfOf: "user-ana" };
    await w.executor.open();
    await w.until(() => w.failureReports.length === 1);
    expect(claim.state).toBe("failed");
    expect(w.failureReports[0]).toMatchObject({ failure: { claimId: claim.claimId }, name: "Add a task", startedBy: "user-ana" });
  });

  it("includes Group reads in share warnings and held summaries", async () => {
    const w = await world({ channels: [TRIP], automations: { Tasks: task } });
    await w.executor.open();
    await w.executor.automationsIn("Tasks");
    expect(await w.executor.shareImpact({ paths: ["Tasks"], versionId: null, access: "edit", recipientEmail: "bob@dohc.test" })).toMatchObject([{ target: "Trip", action: "read" }]);
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("bob@dohc.test", ["Tasks"])] });
    await w.executor.automationsIn("Tasks");
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [] });
    expect(await w.executor.automationsIn("Tasks")).toMatchObject({ automations: [{ reach: { steps: [{ verdict: "held", target: "Trip", action: "read" }, { verdict: "allowed" }] } }] });
  });

  const cannotRunOf = async (executor: CollectionAutomations) => {
    const file = await executor.automationsIn("Tasks");
    if (file.status !== "read" || !file.automations[0]?.valid) throw new Error("unreadable fixture");
    return file.automations[0].cannotRun;
  };

  it("subscribes to its Group's messages on the automation host, and only there", async () => {
    const here = await world({ channels: [TRIP], automations: { Tasks: task } });
    await here.executor.open();
    await here.until(() => here.subscriptions.has("collection:Tasks#task"));
    expect(here.subscriptions.get("collection:Tasks#task")).toEqual({
      automationId: "collection:Tasks#task", groupId: "trip", startsWith: "/task",
    });
    expect(here.hostRequests(), "it asks to be the host, as a schedule does").toBeGreaterThan(0);

    const elsewhere = await world({ channels: [TRIP], automations: { Tasks: task }, runsGroupTriggers: false });
    // A crash after the engine subscribed, before this computer recorded it.
    elsewhere.subscriptions.set("collection:Tasks#task", { automationId: "collection:Tasks#task", groupId: "trip" });
    await elsewhere.executor.open();
    expect(await cannotRunOf(elsewhere.executor), "it runs, on the host").toBeNull();
    expect(elsewhere.subscriptions.has("collection:Tasks#task"), "the engine keeps none off the host").toBe(false);
    expect(elsewhere.hostRequests()).toBeGreaterThan(0);

    const off = await world({ channels: [TRIP], automations: { Tasks: task.replace("    when:", "    enabled: false\n    when:") } });
    await off.executor.open();
    await off.executor.automationsIn("Tasks");
    expect(off.hostRequests(), "switched off, it does not ask").toBe(0);
  });

  it("subscribes in a workspace that never synced, whose only computer this is, and not in one that synced before", async () => {
    const w = await world({ channels: [TRIP], automations: { Tasks: task } });
    await mkdir(join(w.root, ".dohc"), { recursive: true });
    await recordNeverSynced(w.root);
    // No remote: the workspace does not sync now.
    const host = () => automationHostGeneration({ rootPath: w.root }, () => null);
    const neverSynced = w.makeExecutor({ groupHost: host });
    await neverSynced.open();
    await w.until(() => w.subscriptions.has("collection:Tasks#task"));
    expect(await cannotRunOf(neverSynced)).toBeNull();
    await neverSynced.dispose();

    // Sync was on once and is off now: another computer may be the host.
    recordSynced(w.root);
    const syncedBefore = w.makeExecutor({ groupHost: host, hostCanRun: async () => false });
    await syncedBefore.open();
    await w.until(() => !w.subscriptions.has("collection:Tasks#task"));
    expect(await cannotRunOf(syncedBefore)).toBe("Turn on sync so Group messages start this automation.");
  });

  it("runs for a Group message with the message and its author in its formulas", async () => {
    const w = await world({ channels: [TRIP], automations: { Tasks: task } });
    const claim = messageClaim(w);
    claim.change = { ...claim.change, onBehalfOf: "user-ana" };
    await w.executor.open();
    await w.settledClaim(claim);

    expect(claim.state).toBe("done");
    expect(added(w)).toEqual([{ Title: "Buy tickets", "Asked by": "Ana" }]);
    // The record it adds is made for the message's author, so its claims name them.
    expect(w.authored.map((entry) => entry.author)).toEqual([
      { kind: "automation", automationId: "collection:Tasks#task", onBehalfOf: "user-ana", depth: 1 },
    ]);
  });

  it("finds the record a message names with a formula, and changes it", async () => {
    const done = [
      "  - id: task",
      "    name: Finish a task",
      "    when: {group-message: Trip, starts-with: /done}",
      "    do:",
      "      - find: record.Title == message.body.slice(6)",
      "        as: named",
      "      - set: {Status: Done}",
      "        records: named",
    ].join("\n");
    const w = await world({ channels: [TRIP], automations: { Tasks: done } });
    const tickets = w.addRecord("Tasks", "tickets", { Title: "Buy tickets", Status: "Open" });
    const bags = w.addRecord("Tasks", "bags", { Title: "Pack the bags", Status: "Open" });
    const claim = messageClaim(w, { body: "/done Buy tickets" });
    await w.executor.open();
    await w.settledClaim(claim);

    expect(claim.state).toBe("done");
    expect(w.fieldsOf(tickets)).toMatchObject({ Status: "Done" });
    expect(w.fieldsOf(bags)).toMatchObject({ Status: "Open" });
  });

  it("fails on a Find's formula only when the Find's branch runs", async () => {
    const parsed = [
      "  - id: task",
      "    name: Finish a task",
      "    when: {group-message: Trip}",
      "    do:",
      "      - if: 'message.body.startsWith(\"/done \")'",
      "        do:",
      "          - find: record.Title == JSON.parse(message.body.slice(6)).title",
      "            as: named",
      "          - set: {Status: Done}",
      "            records: named",
      "        otherwise:",
      "          - add-record: {Title: '=message.body'}",
    ].join("\n");
    const w = await world({ channels: [TRIP], automations: { Tasks: parsed } });
    const hello = messageClaim(w, { body: "/hello" });
    await w.executor.open();
    await w.settledClaim(hello);
    expect(hello.state).toBe("done");
    expect(added(w)).toEqual([{ Title: "/hello" }]);
    const broken = messageClaim(w, { id: "m2", body: "/done not json" });
    broken.trigger = { key: "message:m2" };
    await w.settledClaim(broken);
    expect(broken).toMatchObject({ state: "failed", error: expect.stringMatching(/^The Find in step 2 failed\./) });
  });

  it("reads a body its claim carried truncated", async () => {
    const w = await world({ channels: [TRIP], automations: { Tasks: task }, messageBodies: { m1: "/task Pack the bags" } });
    const claim = messageClaim(w, { body: { truncated: true, bytes: 70_000 } });
    await w.executor.open();
    await w.settledClaim(claim);

    expect(added(w)).toEqual([{ Title: "Pack the bags", "Asked by": "Ana" }]);
  });

  it("skips a message from another Group or without the starting text, as the automation reads now", async () => {
    const w = await world({ channels: [TRIP], automations: { Tasks: task } });
    const otherGroup = messageClaim(w, { groupId: "family" });
    const noCommand = messageClaim(w, { body: "hello" });
    await w.executor.open();
    await w.settledClaim(otherGroup);
    await w.settledClaim(noCommand);

    expect([otherGroup.state, noCommand.state]).toEqual(["done", "done"]);
    expect(added(w)).toEqual([]);
  });

  it("stops a resumed run whose Group is no longer the one its message came from", async () => {
    const LOG: ChatDirectoryChannel = { ...TRIP, id: "log", name: "Log", slug: "log", wireId: "log" };
    const channels = [TRIP, LOG];
    const relay = [
      "  - id: task",
      "    name: Relay",
      "    when: {group-message: Trip, starts-with: /task}",
      "    do: [{post: 'Asked: {message.body}', group: Log}]",
    ].join("\n");
    const w = await world({ channels, automations: { Tasks: relay } });
    let signedIn = false;
    w.beforeChatWrite(async () => { if (!signedIn) throw new AutomationChatSessionWait(); });
    const claim = messageClaim(w);
    await w.executor.open();
    await w.until(() => w.events.includes(`released ${claim.claimId}`));

    // While the run waited, "Trip" came to name another Group.
    channels[0] = { ...TRIP, id: "trip-2", wireId: "trip-2" };
    signedIn = true;
    w.executor.sessionChanged();
    await w.settledClaim(claim);
    expect(claim).toMatchObject({ state: "failed", error: GROUP_CHANGED_ERROR });
    expect(w.messages).toEqual([]);
  });

  it("drops its subscription once this computer is no longer the host, and still runs a message it claimed as host", async () => {
    const options: Parameters<typeof world>[0] = { channels: [TRIP], automations: { Tasks: task } };
    const w = await world(options);
    await w.executor.open();
    await w.until(() => w.subscriptions.has("collection:Tasks#task"));

    // The engine claimed a message, then the owner chose another computer.
    const claim = messageClaim(w);
    options.runsGroupTriggers = false;
    w.executor.hostChanged();
    await w.until(() => !w.subscriptions.has("collection:Tasks#task"));
    w.executor.notifyClaimed();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(added(w)).toEqual([{ Title: "Buy tickets", "Asked by": "Ana" }]);
  });

  it("tells the owner once when Group messages started nothing here, and again only after a newer skip", async () => {
    const w = await world({ channels: [TRIP], automations: { Tasks: task } });
    w.groupSkips.aheadAtMs = 1_000;
    await w.executor.groupMessagesArrived();
    expect(w.skipNotices, "it watches no Group yet").toEqual([]);

    // Its first watch tells, since a replay can skip a message too.
    await w.executor.open();
    await w.until(() => w.subscriptions.has("collection:Tasks#task"));
    await w.until(() => w.skipNotices.length > 0);
    await w.executor.groupMessagesArrived();
    expect(w.skipNotices).toEqual([{ reason: "ahead", atMs: 1_000 }]);

    w.groupSkips.aheadAtMs = 2_000;
    w.groupSkips.lateAtMs = 1_500;
    await w.executor.groupMessagesArrived();
    expect(w.skipNotices).toEqual([
      { reason: "ahead", atMs: 1_000 },
      { reason: "ahead", atMs: 2_000 },
      { reason: "late", atMs: 1_500 },
    ]);
  });

  it("before a handover, has the engine stop every Group subscription, tracked or not, and answers its handover once it did", async () => {
    const options: Parameters<typeof world>[0] = { channels: [TRIP], automations: { Tasks: task } };
    const w = await world(options);
    expect(await w.executor.releaseGroupSubscriptions(() => true), "not open, so it cannot tell").toBeNull();
    await w.executor.open();
    await w.until(() => w.subscriptions.has("collection:Tasks#task"));
    expect(await w.executor.releaseGroupSubscriptions(() => false), "called off, so it keeps them").toBeNull();
    expect(w.subscriptions.has("collection:Tasks#task")).toBe(true);
    // A crash after the engine subscribed, before this computer recorded it.
    w.subscriptions.set("collection:Tasks#lost", { automationId: "collection:Tasks#lost", groupId: "trip" });

    options.runsGroupTriggers = false;
    const release = w.engine.releaseAutomationGroups;
    w.engine.releaseAutomationGroups = async () => { throw new Error("The workspace engine is not running."); };
    expect(await w.executor.releaseGroupSubscriptions(() => true)).toBeNull();
    expect(w.subscriptions.has("collection:Tasks#task")).toBe(true);

    w.engine.releaseAutomationGroups = release;
    const released = await w.executor.releaseGroupSubscriptions(() => true);
    expect(released?.handover.automations.map((automation) => automation.automationId)).toEqual(["collection:Tasks#task", "collection:Tasks#lost"]);
    expect(released?.watchedGeneration, "a workspace that never synced watches at generation 0").toBe(0);
    expect([...w.subscriptions.keys()]).toEqual([]);
  });

  it("watches again when the owner calls a handover off after a release whose answer was lost", async () => {
    const options: Parameters<typeof world>[0] = { channels: [TRIP], automations: { Tasks: task } };
    const w = await world(options);
    await w.executor.open();
    await w.until(() => w.subscriptions.has("collection:Tasks#task"));

    // The engine stops them, and the answer never arrives.
    options.runsGroupTriggers = false;
    const release = w.engine.releaseAutomationGroups;
    w.engine.releaseAutomationGroups = async () => {
      await release();
      throw new Error("The workspace engine stopped answering.");
    };
    expect(await w.executor.releaseGroupSubscriptions(() => true)).toBeNull();
    expect(w.subscriptions.has("collection:Tasks#task")).toBe(false);

    // The owner calls the handover off, so this computer hosts again.
    w.engine.releaseAutomationGroups = release;
    options.runsGroupTriggers = true;
    w.executor.hostChanged();
    await w.executor.automationsIn("Tasks");
    expect(w.subscriptions.has("collection:Tasks#task")).toBe(true);
  });

  it("watches again after a watch whose answer was lost, though the Groups it wants did not change", async () => {
    const w = await world({ channels: [TRIP], automations: { Tasks: task } });
    await w.executor.open();
    await w.until(() => w.subscriptions.has("collection:Tasks#task"));
    const reread = async () => {
      w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
      await w.executor.automationsIn("Tasks");
    };

    // Switched off: the engine drops it, and the answer never arrives.
    const watch = w.engine.watchAutomationGroups;
    w.engine.watchAutomationGroups = async (input) => {
      await watch(input);
      throw new Error("The workspace engine stopped answering.");
    };
    await w.writeAutomations("Tasks", task.replace("    when:", "    enabled: false\n    when:"));
    await reread();
    expect(w.subscriptions.has("collection:Tasks#task")).toBe(false);

    // Switched on again: what this computer last recorded matches, but the engine holds nothing.
    w.engine.watchAutomationGroups = watch;
    await w.writeAutomations("Tasks", task);
    await reread();
    expect(w.subscriptions.has("collection:Tasks#task")).toBe(true);
  });

  it("stops nothing when the owner calls a handover off while the release waits in line", async () => {
    const w = await world({ channels: [TRIP], automations: { Tasks: task } });
    // While a handover winds down this computer admits no new host work,
    // even once the relay names it again.
    let stillRuns = true;
    let gate: Promise<void> = Promise.resolve();
    const executor = w.makeExecutor({ groupHost: async () => { await gate; return stillRuns ? 0 : null; } });
    await executor.open();
    await w.until(() => w.subscriptions.has("collection:Tasks#task"));
    let releases = 0;
    const release = w.engine.releaseAutomationGroups;
    w.engine.releaseAutomationGroups = async () => { releases += 1; return await release(); };

    // The handover begins: a reconcile waits in line, and the release behind it.
    stillRuns = false;
    let letThrough: () => void = () => undefined;
    gate = new Promise((resolve) => { letThrough = resolve; });
    executor.hostChanged();
    let handingOver = true;
    const releasing = executor.releaseGroupSubscriptions(() => handingOver);
    // The owner calls it off before the release's turn.
    handingOver = false;
    letThrough();
    expect(await releasing, "nothing to release").toBeNull();
    expect(releases, "only the reconcile's, while this computer admitted no host work").toBe(1);

    // The handover ends, and this computer hosts again.
    stillRuns = true;
    executor.hostChanged();
    await executor.automationsIn("Tasks");
    expect(w.subscriptions.has("collection:Tasks#task")).toBe(true);
  });

  type World = Awaited<ReturnType<typeof world>>;
  type Workspace = { rootPath: string; remote?: unknown };
  type FakeTimer = { wake: () => void; delayMs: number; done: boolean };
  // The relay's record of the host, as the routes keep it, for all the owner's computers.
  type Relay = {
    row: RelayAutomationHost | null;
    onRelease?: () => void;
    down?: boolean;
    checkIns?: number;
    // The last release's Group handover, for the computer it named.
    kept: { generation: number; forInstall: string; groups: AutomationGroupHandover } | null;
  };
  // One of the owner's computers: its host module and executor, wired as main.ts wires them.
  const ownersComputer = (installId: string, w: World, relay: Relay, workspace: Workspace) => {
    const clock = { ms: 0 };
    const timers: FakeTimer[] = [];
    const hostErrors: unknown[] = [];
    const hosts: AutomationHosts = createAutomationHosts({
      installId: () => installId,
      label: () => installId,
      synced: () => workspace.remote !== undefined,
      send: async (_workspaceId, request) => {
        // A workspace that does not sync has no relay to ask.
        if (workspace.remote === undefined) return null;
        if (request.action === "check-in") relay.checkIns = (relay.checkIns ?? 0) + 1;
        if (relay.down) throw new TypeError("fetch failed");
        if (request.action === "check-in" && request.body.claim && relay.row === null) {
          relay.row = { installId, generation: 1, handoverFrom: null, releasedThroughMs: null };
        }
        if (request.action === "release" && relay.row !== null) {
          relay.onRelease?.();
          relay.row = { ...relay.row, generation: relay.row.generation + 1, handoverFrom: null, releasedThroughMs: request.body.releasedThroughMs };
          relay.kept = {
            generation: relay.row.generation,
            forInstall: relay.row.installId,
            groups: request.body.groups as AutomationGroupHandover,
          };
        }
        return { status: 200, body: { ok: true, host: relay.row } };
      },
      stored: () => undefined,
      store: () => undefined,
      startedHere: () => undefined,
      hostChanged: () => executor.hostChanged(),
      finishHere: async (_workspaceId, stillHandingOver) => {
        const released = await executor.releaseGroupSubscriptions(stillHandingOver);
        return released === null ? null : { throughMs: 5_000, groups: released.handover, groupsWatched: released.watchedGeneration };
      },
      logError: (_workspaceId, error) => { hostErrors.push(error); },
      monotonicMs: () => clock.ms,
      setTimer: (wake, delayMs) => {
        const timer = { wake, delayMs, done: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (cleared) => { for (const timer of timers) if (timer === cleared) timer.done = true; },
    });
    const executor = w.makeExecutor({
      groupHost: () => automationHostGeneration(workspace, () => hosts.runsAt("ws")),
      // The relay answers only for the current generation, as main.ts reads it.
      groupRelayRecord: async (generation) => {
        if (relay.down) throw new TypeError("fetch failed");
        if (relay.row?.generation !== generation) throw new Error("The relay answered the Group handover read with 409.");
        if (relay.kept === null) return { generation: 0, handover: null };
        return {
          generation: relay.kept.generation,
          handover: relay.kept.forInstall === relay.row.installId ? relay.kept.groups : null,
        };
      },
      requestHost: () => hosts.admit("ws"),
    });
    hosts.open("ws");
    const armed = () => timers.filter((timer) => !timer.done);
    return { hosts, executor, clock, hostErrors, armed };
  };
  const subscribed = (w: World) => w.subscriptions.has("collection:Tasks#task");

  // The laptop opens first and its Group trigger records it as the host; the desk opens after.
  async function laptopAndDesk() {
    const workspace = { rootPath: "", remote: {} };
    const relay: Relay = { row: null, kept: null };
    const laptop = await world({ channels: [TRIP], automations: { Tasks: task } });
    const desk = await world({ channels: [TRIP], automations: { Tasks: task } });
    const onLaptop = ownersComputer("laptop", laptop, relay, workspace);
    await onLaptop.executor.open();
    await laptop.until(() => subscribed(laptop));
    expect(relay.row).toMatchObject({ installId: "laptop", handoverFrom: null });
    const onDesk = ownersComputer("desk", desk, relay, workspace);
    await onDesk.executor.open();
    expect(subscribed(desk)).toBe(false);
    expect(onDesk.armed(), "no handover, so no timer").toEqual([]);
    // Neither computer holds a subscription when the laptop releases.
    const atRelease: Array<{ laptop: boolean; desk: boolean }> = [];
    let released: () => void = () => undefined;
    const release = new Promise<void>((resolve) => { released = resolve; });
    relay.onRelease = () => {
      atRelease.push({ laptop: subscribed(laptop), desk: subscribed(desk) });
      released();
    };
    return { relay, laptop, desk, onLaptop, onDesk, atRelease, release };
  }

  it("hands over from the desk's settings: the laptop drops its subscription before it releases, and the desk's timer finds the release", async () => {
    const { relay, laptop, desk, onLaptop, onDesk, atRelease, release } = await laptopAndDesk();
    relay.row = { installId: "desk", generation: 2, handoverFrom: "laptop", releasedThroughMs: null };
    onDesk.hosts.learned("ws", relay.row);
    expect(onDesk.armed().map((timer) => timer.delayMs)).toEqual([HANDOVER_READ_FIRST_MS]);
    // The laptop reads the host again before its next step, and hands over.
    onLaptop.clock.ms += HOST_FRESH_MS + 1;
    expect(await onLaptop.hosts.runsHere("ws")).toBe(false);
    await release;
    expect(atRelease).toEqual([{ laptop: false, desk: false }]);

    // The desk's timer reads the release, and the desk takes the laptop's
    // Group handover and subscribes at once: no schedule, no reopen.
    const [next] = onDesk.armed();
    next!.done = true;
    next!.wake();
    await desk.until(() => subscribed(desk));
    expect(desk.relayRecords).toEqual([{ generation: 3, handover: relay.kept!.groups }]);
    expect(relay.kept?.groups).toMatchObject({ automations: [{ automationId: "collection:Tasks#task" }] });
    expect(subscribed(laptop)).toBe(false);
    expect(onDesk.armed(), "the handover ended").toEqual([]);
    expect(onLaptop.armed()).toEqual([]);
    expect([...onLaptop.hostErrors, ...onDesk.hostErrors]).toEqual([]);
  });

  it("hands over from the laptop's settings: the desk learns through its own read after a sync pull", async () => {
    const { relay, laptop, desk, onLaptop, onDesk, atRelease, release } = await laptopAndDesk();
    // The owner chooses the desk on the laptop, which hands over at once.
    relay.row = { installId: "desk", generation: 2, handoverFrom: "laptop", releasedThroughMs: null };
    onLaptop.hosts.learned("ws", relay.row);
    await release;
    expect(atRelease).toEqual([{ laptop: false, desk: false }]);

    // The desk heard nothing. A sync pull with a fresh copy reads nothing;
    // once its copy is a minute old, the next pull reads the host.
    onDesk.hosts.relayAnswered("ws");
    await onDesk.executor.automationsIn("Tasks");
    expect(subscribed(desk)).toBe(false);
    onDesk.clock.ms += HOST_FRESH_MS + 1;
    onDesk.hosts.relayAnswered("ws");
    await desk.until(() => subscribed(desk));
    expect(desk.relayRecords).toEqual([{ generation: 3, handover: relay.kept!.groups }]);
    expect(subscribed(laptop)).toBe(false);
    expect([...onLaptop.hostErrors, ...onDesk.hostErrors]).toEqual([]);
  });

  it("keeps its subscriptions when a workspace that never synced turns sync on", async () => {
    const w = await world({ channels: [TRIP], automations: { Tasks: task } });
    await mkdir(join(w.root, ".dohc"), { recursive: true });
    await recordNeverSynced(w.root);
    const workspace: Workspace = { rootPath: w.root };
    const relay: Relay = { row: null, kept: null };
    const here = ownersComputer("laptop", w, relay, workspace);
    await here.executor.open();
    await w.until(() => subscribed(w));
    let removals = 0;
    const release = w.engine.releaseAutomationGroups;
    w.engine.releaseAutomationGroups = async () => { removals += 1; return await release(); };

    // Sync turns on, and the relay records no host yet.
    recordSynced(w.root);
    workspace.remote = {};
    here.executor.hostChanged();
    await here.executor.automationsIn("Tasks");
    expect(relay.row, "its Group trigger recorded it as the host").toMatchObject({ installId: "laptop" });
    expect(removals, "no gap in which a message claims nowhere").toBe(0);
    expect(subscribed(w)).toBe(true);
    expect(w.relayRecords, "the first host finds none").toEqual([{ generation: 0, handover: null }]);
    expect(here.hostErrors).toEqual([]);
  });

  it.each([
    ["another computer is already the host", { row: { installId: "desk", generation: 1, handoverFrom: null, releasedThroughMs: null } }],
    ["the relay does not answer", { row: null, down: true }],
  ] as const)("drops its subscriptions when a workspace that never synced turns sync on and %s", async (_case, start) => {
    const w = await world({ channels: [TRIP], automations: { Tasks: task } });
    await mkdir(join(w.root, ".dohc"), { recursive: true });
    await recordNeverSynced(w.root);
    const workspace: Workspace = { rootPath: w.root };
    const relay: Relay = { row: null, kept: null };
    const here = ownersComputer("laptop", w, relay, workspace);
    await here.executor.open();
    await w.until(() => subscribed(w));

    // Only a computer the relay names keeps them. The first sync pull reads
    // the host, and nothing else asks the executor.
    relay.row = start.row;
    relay.down = "down" in start;
    recordSynced(w.root);
    workspace.remote = {};
    here.hosts.relayAnswered("ws");
    await w.until(() => !subscribed(w));
    expect(relay.checkIns, "one read decides; the reconcile it starts reads nothing more").toBe(1);
    if (!("down" in start)) return;
    // The relay answers again: the next pull claims the host, and the subscriptions come back.
    relay.down = false;
    here.hosts.relayAnswered("ws");
    await w.until(() => subscribed(w));
    expect(relay.row).toMatchObject({ installId: "laptop" });
  });

  it("holds a Group trigger an editor's leaving newly allows, until Allow", async () => {
    const w = await world({ channels: [TRIP], automations: { Tasks: task } });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("bob@dohc.test", ["Tasks"])] });
    const first = messageClaim(w);
    await w.executor.open();
    await w.settledClaim(first);
    expect(first).toMatchObject({ state: "failed", error: "bob@dohc.test cannot read Trip." });

    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [] });
    const second = messageClaim(w);
    w.executor.notifyClaimed();
    await w.until(() => w.events.includes(`released ${second.claimId}`));
    const [hold] = w.executor.holds();
    expect(hold).toMatchObject({ action: "read", target: "Trip", stoppedFor: "bob@dohc.test" });
    await w.executor.confirmReach(hold!);
    await w.settledClaim(second);
    expect(second.state).toBe("done");
  });

  it("stops when an editor cannot read the Group", async () => {
    const w = await world({ channels: [TRIP], automations: { Tasks: task } });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("bob@dohc.test", ["Tasks"])] });
    const claim = messageClaim(w);
    await w.executor.open();
    await w.settledClaim(claim);

    expect(claim).toMatchObject({ state: "failed", error: "bob@dohc.test cannot read Trip." });
    expect(added(w)).toEqual([]);
  });


  describe("when a Collection moves", () => {
    // Waits until the index reads the Collection at its new path.
    const movedTo = async (w: Awaited<ReturnType<typeof world>>, automationId: string, path: string) =>
      await w.until(() => (w.subscriptions.get(automationId) as { path?: string } | undefined)?.path === path);

    it("keeps its automations' ids, subscriptions, and run history", async () => {
      const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: [
        "  - id: bump", "    name: Bump", "    when: {field-changed: Status}", "    do: [{set: {Count: '=record.Count + 1'}}]",
      ].join("\n") } });
      const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
      const claim = w.claim(TASKS, task);
      await w.executor.open();
      await w.settledClaim(claim);

      await w.renameCollection("Tasks", "Voyage");
      await movedTo(w, TASKS, "Voyage");
      expect(await w.executor.automationsIn("Voyage")).toMatchObject({ status: "read", automations: [{ automationId: TASKS }] });
      expect(((await w.executor.runs(TASKS)).runs).map((run) => run.claimId)).toEqual([claim.claimId]);
      expect(w.executor.locate(TASKS)).toEqual({ collectionPath: "Voyage", id: "bump" });

      // A change in the moved Collection runs there, and a restart finds its history too.
      const next = w.claim(TASKS, task);
      w.executor.notifyClaimed();
      await w.settledClaim(next);
      expect(w.fieldsOf(task).Count).toBe(4);
      await w.executor.dispose();
      const restarted = w.makeExecutor();
      await restarted.open();
      expect((await restarted.runs(TASKS)).runs.map((run) => run.claimId)).toEqual([next.claimId, claim.claimId]);
      await restarted.dispose();
    });

    it("runs a claim made before the move where the Collection is now", async () => {
      const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: BUMP } });
      const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
      await w.executor.open();
      await w.renameCollection("Tasks", "Voyage");
      await movedTo(w, TASKS, "Voyage");
      // The engine claimed the change while the Collection was still at Tasks.
      const claim = w.claim(TASKS, task);
      claim.collectionPath = "Tasks";
      w.executor.notifyClaimed();
      await w.settledClaim(claim);
      expect(claim.state).toBe("done");
      expect(w.fieldsOf(task).Count).toBe(3);
    });

    it("does not run a removal that the move itself made", async () => {
      const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: [
        "  - id: gone", "    name: Gone", "    when: record-removed", "    do: [{add-record: {Title: Removed}, collection: Log}]",
      ].join("\n") } });
      const task = w.addRecord("Tasks", "one", { Status: "Done" });
      await w.executor.open();
      await w.renameCollection("Tasks", "Voyage");
      await movedTo(w, "collection:Tasks#gone", "Voyage");
      const claim = w.claim("collection:Tasks#gone", task, { kind: "removed", fields: [] });
      claim.collectionPath = "Tasks";
      w.executor.notifyClaimed();
      await w.settledClaim(claim);
      expect(claim.state).toBe("done");
      expect(w.authored).toEqual([]);
      // A record removed from where the Collection is now still runs it.
      const removed = w.claim("collection:Tasks#gone", task, { kind: "removed", fields: [] });
      w.executor.notifyClaimed();
      await w.settledClaim(removed);
      expect(w.authored).toHaveLength(1);
    });

    it("tries a failed run again where its Collections are now, without repeating what landed, and undoes it there", async () => {
      const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: BUMP } });
      const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
      // Step 1's record fails after its write landed.
      w.failRecordAt(1);
      const claim = w.claim(TASKS, task);
      await w.executor.open();
      await w.settledClaim(claim);
      expect(claim).toMatchObject({ state: "failed", error: "The disk is full." });

      await w.renameCollection("Tasks", "Voyage");
      await movedTo(w, TASKS, "Voyage");
      await expect(w.executor.retry({ automationId: TASKS, claimId: claim.claimId, startOver: false }))
        .resolves.toEqual({ status: "queued", press: false });
      await w.until(() => claim.state === "done");
      expect(w.fieldsOf(task).Count).toBe(3);
      const [added] = w.authored.map((entry) => entry.path);
      expect(w.authored).toHaveLength(1);
      expect(added).toMatch(/^Log\//u);

      // Undo finds each record where its Collection is now, the one it added too.
      await w.renameCollection("Log", "Journal");
      await w.executor.automationsIn("Journal");

      const trashed: string[] = [];
      await expect(w.executor.undo({ automationId: TASKS, claimId: claim.claimId, deletes: null }, async (path) => { trashed.push(path); }))
        .resolves.toMatchObject({ status: "undone", reverted: 1, removed: 1, missing: 0 });
      expect(w.fieldsOf(task).Count).toBe(2);
      expect(trashed).toEqual([added!.replace(/^Log\//u, "Journal/")]);
    });

    it("gives a copy, or a new Collection at the old path, none of the original's history", async () => {
      const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: BUMP } });
      const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
      const claim = w.claim(TASKS, task);
      await w.executor.open();
      await w.settledClaim(claim);
      await w.renameCollection("Tasks", "Voyage");
      await movedTo(w, TASKS, "Voyage");

      // A new collection.yaml at the old path, or in a copied folder, is a new object.
      await w.addCollection("Tasks", "object-new-tasks");
      await w.writeAutomations("Tasks", BUMP);
      await w.addCollection("Copy", "object-copy");
      await w.writeAutomations("Copy", BUMP);
      w.executor.handleWatcherEvents(["Tasks", "Copy"].flatMap((folder) =>
        ["collection.yaml", "automations.yaml"].map((name) => ({ operation: "create" as const, path: `${folder}/${name}` }))));
      await w.until(() => w.subscriptions.has("collection:object-new-tasks#bump") && w.subscriptions.has("collection:object-copy#bump"));
      expect(await w.executor.automationsIn("Tasks")).toMatchObject({ automations: [{ automationId: "collection:object-new-tasks#bump" }] });
      expect((await w.executor.runs("collection:object-new-tasks#bump")).runs).toEqual([]);
      expect((await w.executor.runs("collection:object-copy#bump")).runs).toEqual([]);
      expect(((await w.executor.runs(TASKS)).runs).map((run) => run.claimId)).toEqual([claim.claimId]);
    });

    it("checks reach again where the Collection is now", async () => {
      const w = await world({ collections: ["Tasks", "Budget"], automations: { Tasks: [
        "  - id: spend", "    name: Spend", "    when: {field-changed: Status}", "    do: [{add-record: {Amount: 5}, collection: Budget}]",
      ].join("\n") } });
      // Ana edits the Shared folder, and not Budget.
      w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("ana@dohc.test", ["Shared"])] });
      const task = w.addRecord("Tasks", "one", { Status: "Done" });
      const first = w.claim("collection:Tasks#spend", task);
      await w.executor.open();
      await w.settledClaim(first);
      expect(first.state).toBe("done");

      await w.renameCollection("Tasks", "Shared/Tasks");
      await movedTo(w, "collection:Tasks#spend", "Shared/Tasks");
      const second = w.claim("collection:Tasks#spend", task);
      w.executor.notifyClaimed();
      await w.settledClaim(second);
      expect(second).toMatchObject({ state: "failed", error: "ana@dohc.test cannot edit Budget." });
    });

    it("runs a claim made before the move even when a new Collection took the old path", async () => {
      const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: [
        "  - id: bump", "    name: Bump", "    when: {field-changed: Status}", "    do: [{set: {Count: '=record.Count + 1'}}]",
      ].join("\n") } });
      const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
      await w.executor.open();
      await w.renameCollection("Tasks", "Voyage");
      await movedTo(w, TASKS, "Voyage");
      await w.addCollection("Tasks", "object-new-tasks");
      w.executor.handleWatcherEvents([{ operation: "create", path: "Tasks/collection.yaml" }]);
      await w.executor.automationsIn("Tasks");
      const claim = w.claim(TASKS, task);
      claim.collectionPath = "Tasks";
      w.executor.notifyClaimed();
      await w.settledClaim(claim);
      expect(claim.state).toBe("done");
      expect(w.fieldsOf(task).Count).toBe(3);
      // A record in the new Collection at the old path is not the moved one's.
      const stranger = w.addRecord("Tasks", "stranger", { Status: "Done", Count: 7 });
      const other = w.claim(TASKS, stranger);
      w.executor.notifyClaimed();
      await w.settledClaim(other);
      expect(other.state).toBe("done");
      expect(w.fieldsOf(stranger).Count).toBe(7);
    });

    it("follows a saved run's other Collections, checks reach there, and stops when one is gone", async () => {
      const failedRun = async () => {
        let writes = 0;
        const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: BUMP },
          withRecordWrites: async () => { if (++writes === 2) throw new Error("The disk is full."); } });
        const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
        // Step 2 is saved with Log's identity, but fails before it creates a record.
        const claim = w.claim(TASKS, task);
        await w.executor.open();
        await w.settledClaim(claim);
        expect(claim.state).toBe("failed");
        const [saved] = (await w.baseStore.runsOf(TASKS, claim.claimId)).runs;
        expect(saved!.steps.map((step) => step.ordinal)).toEqual([0, 1]);
        expect(saved!.collections).toContainEqual({ collectionId: "Log", path: "Log" });
        expect(w.authored).toEqual([]);
        return { w, claim };
      };
      const retried = async (w: Awaited<ReturnType<typeof world>>, claim: AutomationClaim) => {
        await w.executor.retry({ automationId: TASKS, claimId: claim.claimId, startOver: false });
        await w.settledClaim(claim);
        expect(claim).toMatchObject({ state: "failed", run: 2 });
        return claim.error;
      };

      // Log moved where Ana cannot edit it, and a new Log took its old path:
      // the saved plan writes the moved Log, so reach is checked there.
      const moved = await failedRun();
      moved.w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("ana@dohc.test", ["Tasks", "Log"])] });
      await moved.w.renameCollection("Log", "Private/Log");
      await moved.w.addCollection("Log", "object-new-log");
      moved.w.executor.handleWatcherEvents([{ operation: "create", path: "Log/collection.yaml" }]);
      await moved.w.executor.automationsIn("Private/Log");
      await moved.w.executor.automationsIn("Log");
      expect(await retried(moved.w, moved.claim)).toBe("ana@dohc.test cannot edit Log.");
      expect(moved.w.authored).toEqual([]);

      // Log was deleted and a new Log took its path: nothing is added there.
      const gone = await failedRun();
      await rm(join(gone.w.root, "Log"), { recursive: true });
      await gone.w.addCollection("Log", "object-new-log");
      gone.w.executor.handleWatcherEvents([{ operation: "update", path: "Log/collection.yaml" }]);
      await gone.w.executor.automationsIn("Log");
      expect(await retried(gone.w, gone.claim)).toBe(LOST_COLLECTION_ERROR);
      expect(gone.w.authored).toEqual([]);
    });

    it("runs a relayed press that waited only while its Collection is where the relay allowed it", async () => {
      const w = await world({ automations: { Tasks: "  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do: [{set: {Paid by: '=person.id'}}]\n" } });
      const invoice = w.addRecord("Tasks", "invoice", {});
      w.setRoster({ kind: "unknown", problem: { kind: "unchecked", next: "Try again later." } });
      await w.executor.open();
      const paid = await hashOf(w.executor, "Tasks", "paid");
      const relayed = await w.executor.pressRelayed(
        { automationId: "collection:Tasks#paid", collectionPath: "Tasks", definitionHash: paid, recordId: invoice.id, pressId: "relay-1", pressedBy: "user-ana" }, () => undefined);
      if (relayed.pressed.busy) throw new Error("Expected a claim");
      await w.renameCollection("Tasks", "Shared/Tasks");
      await w.executor.automationsIn("Shared/Tasks");
      w.setRoster(OWNER);
      w.executor.rosterChanged();
      const claim = await w.settledClaim(w.claims.get(relayed.pressed.claimId)!);
      expect(claim).toMatchObject({ state: "failed", error: "This Collection moved after the button was pressed. Press it again." });
      expect(w.fieldsOf(invoice)).toEqual({});
    });
  });
});

describe("code steps", () => {
  // One automation whose only step runs `code`, then the steps after it.
  const coded = (code: string, ...after: string[]) => [
    "  - id: code",
    "    name: Code",
    "    when: {field-changed: Status}",
    "    do:",
    "      - run: |",
    ...code.split("\n").map((line) => `          ${line}`),
    ...after,
  ].join("\n");
  const CODE = "collection:Tasks#code";

  it("sets fields on the trigger record the way a Set fields step does, and Undo reverts them", async () => {
    const w = await world({ automations: { Tasks: coded("return { set: { Count: ctx.record.Count + 1, Note: ctx.trigger.fields.join(', ') } };") } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    const claim = w.claim(CODE, task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(w.fieldsOf(task)).toEqual({ Status: "Done", Count: 3, Note: "Status" });
    const seed = stepKey(claim.claimId, `${await hashOf(w.executor, "Tasks", "code")}-1`, 0);
    expect(w.journaled.map((entry) => entry.idempotencyKey?.startsWith(`${seed}/${task.id}`))).not.toContain(false);
    expect(w.journaled[0]).toMatchObject({ attribution: { actorKind: "automation" } });

    await expect(w.executor.undo({ automationId: CODE, claimId: claim.claimId, deletes: null }, async () => undefined))
      .resolves.toMatchObject({ status: "undone", reverted: 2 });
    expect(w.fieldsOf(task)).toEqual({ Status: "Done", Count: 2, Note: null });
  });

  it("adds records to a Collection the code names, each once", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: coded([
      "return { records: [",
      "  { action: 'add', collection: 'Log', fields: { Title: 'Logged ' + ctx.record.Status } },",
      "  { action: 'add', collection: 'Log', fields: { Title: 'Second' } },",
      "] };",
    ].join("\n")) } });
    const claim = w.claim(CODE, w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    const added = [...w.records.values()].filter((record) => record.collection === "Log");
    expect(added.map((record) => w.fieldsOf(record).Title).sort()).toEqual(["Logged Done", "Second"]);
    expect(new Set(added.map((record) => record.id)).size).toBe(2);
  });

  it("gives the value it returns to the steps after it", async () => {
    const w = await world({ automations: { Tasks: coded("return { output: ctx.record.Count * 2 };", "        as: doubled", "      - set: {Total: '=doubled + 1'}") } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    const claim = w.claim(CODE, task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(w.fieldsOf(task).Total).toBe(5);
  });

  it("runs a code file in the Collection's folder, and fails a run whose file is missing", async () => {
    const file = (name: string) => [
      "  - id: code", "    name: Code", "    when: {field-changed: Status}", "    do:", `      - run-file: scripts/${name}`,
    ].join("\n");
    const w = await world({ automations: { Tasks: file("count.js") } });
    await mkdir(join(w.root, "Tasks", "scripts"), { recursive: true });
    await writeFile(join(w.root, "Tasks", "scripts", "count.js"), "return { set: { Count: ctx.record.Count + 10 } };\n");
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    const claim = w.claim(CODE, task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(w.fieldsOf(task).Count).toBe(12);

    await w.writeAutomations("Tasks", file("missing.js"));
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    await w.until(() => w.idleDrains() >= 2);
    const missing = w.claim(CODE, task);
    w.executor.notifyClaimed();
    await w.settledClaim(missing);
    expect(missing).toMatchObject({ state: "failed", error: "Step 1 runs Tasks/scripts/missing.js, and dohc cannot find that file." });
    expect(w.fieldsOf(task).Count).toBe(12);
  });

  it.each([
    ["time", "while (true) {}", "The code in step 1 failed. The code ran longer than 1000 ms, so it stopped. Check it for a loop that never ends."],
    ["memory", "const rows = []; for (;;) rows.push({ rows });", "The code in step 1 failed. The code used more memory than it is allowed, so it stopped."],
  ])("fails a run whose code runs past its %s limit, before anything is written", async (_limit, code, error) => {
    const w = await world({ automations: { Tasks: coded(code, "      - set: {Seen: true}") } });
    const claim = w.claim(CODE, w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim).toMatchObject({ state: "failed", error });
    expect(w.journaled).toEqual([]);
  });

  it.each([
    ["a shape the contract does not allow", "return { set: 'Done' };", /^The code in step 1 failed\. The code returned something the automation cannot use\. set: /],
    ["a field the Collection lacks", "return { set: { Nope: 1 } };", /^The code in step 1 sets Nope, which is not a field in Tasks\.$/],
    ["a Collection that does not exist", "return { records: [{ action: 'add', collection: 'Nowhere', fields: {} }] };", /^The code in step 1 changes records in Nowhere\. dohc cannot find the Collection Nowhere\.$/],
    ["a record that is not in its Collection", "return { records: [{ action: 'change', collection: 'Tasks', id: 'rec_gone', fields: { Seen: true } }] };",
      /^The code in step 1 changes record rec_gone, which is not in Tasks\.$/],
  ])("fails a run whose code returns %s, before anything is written", async (_problem, code, error) => {
    const w = await world({ automations: { Tasks: coded(code, "      - set: {Seen: true}") } });
    const claim = w.claim(CODE, w.addRecord("Tasks", "one", { Status: "Done" }));
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim).toMatchObject({ state: "failed", error: expect.stringMatching(error) });
    expect(w.journaled).toEqual([]);
  });

  it("counts a Find's values, the formulas, and the code against one evaluator budget for the run", async () => {
    const budgets = new Set<unknown>();
    const counting: AutomationFormulaEvaluator = {
      evaluate: async (id, scope, formulas, spent) => { budgets.add(spent); return await evaluator.evaluate(id, scope, formulas, spent); },
      runCode: async (id, scope, source, spent) => { budgets.add(spent); return await evaluator.runCode(id, scope, source, spent); },
    };
    const w = await world({ evaluator: counting, automations: { Tasks: [
      "  - id: code", "    name: Code", "    when: {field-changed: Status}", "    do:",
      "      - find: 'record.Note == String(trigger.record.Count + 1)'", "        as: next",
      "      - run: 'return { output: ctx.next.length };'", "        as: found",
      "      - set: {Total: '=found'}",
    ].join("\n") } });
    w.addRecord("Tasks", "three", { Status: "Doing", Note: "3" });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    const claim = w.claim(CODE, task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(w.fieldsOf(task).Total).toBe(1);
    expect(budgets.size).toBe(1);
  });

  it("refuses a schedule's code that sets fields, since a schedule has no record", async () => {
    const w = await world({ automations: { Tasks: [
      "  - id: code", "    name: Code", "    when: {schedule: day, timezone: UTC}", "    do:",
      "      - run: \"return { set: { Seen: true } };\"",
    ].join("\n") } });
    await w.executor.open();
    const [scheduled] = w.executor.schedules() ?? [];
    const due = Date.UTC(2026, 8, 25, 9);
    await w.executor.claimSchedule({ automationId: CODE, scheduleHash: scheduled!.scheduleHash, run: [], throughMs: due - 1 });
    await w.executor.claimSchedule({ automationId: CODE, scheduleHash: scheduled!.scheduleHash, run: [due], throughMs: due });
    const claim = [...w.claims.values()].find((candidate) => candidate.change.kind === "schedule")!;
    await w.settledClaim(claim);
    expect(claim).toMatchObject({ state: "failed",
      error: 'The code in step 1 returned "set", but a schedule starts this automation, so it has no record to set fields on. Change records by id in "records" instead.' });
    expect(w.journaled).toEqual([]);
  });

  it("resumes after a crash with the changes its code returned, without running the code again", async () => {
    let runs = 0;
    const counting: AutomationFormulaEvaluator = {
      evaluate: evaluator.evaluate,
      runCode: async (...args) => {
        runs += 1;
        return await evaluator.runCode(...args);
      },
    };
    const w = await world({ collections: ["Tasks", "Log"], evaluator: counting, automations: { Tasks: coded(
      "return { set: { Count: ctx.record.Count + 1 }, records: [{ action: 'add', collection: 'Log', fields: { Title: 'Bumped' } }] };",
    ) } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    const paused = Promise.withResolvers<void>();
    // The engine restarts once the first change lands.
    w.beforeNextRecord(() => {
      w.executor.pauseForEngineRestart();
      paused.resolve();
    });
    const claim = w.claim(CODE, task);
    await w.executor.open();
    await paused.promise;
    await w.executor.dispose();
    expect(w.fieldsOf(task).Count).toBe(3);
    expect([...w.records.values()].filter((record) => record.collection === "Log")).toEqual([]);

    await w.makeExecutor().open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(runs).toBe(1);
    expect(w.fieldsOf(task).Count).toBe(3);
    expect([...w.records.values()].filter((record) => record.collection === "Log").map((record) => w.fieldsOf(record).Title)).toEqual(["Bumped"]);
  });

  it("checks what a saved plan's code changes again when it resumes, as the file's steps are", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: coded(
      "return { set: { Count: ctx.record.Count + 1 }, records: [{ action: 'add', collection: 'Log', fields: { Title: 'Bumped' } }] };",
    ) } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    const paused = Promise.withResolvers<void>();
    w.beforeNextRecord(() => {
      w.executor.pauseForEngineRestart();
      paused.resolve();
    });
    const claim = w.claim(CODE, task);
    await w.executor.open();
    await paused.promise;
    await w.executor.dispose();

    // While the run waited, Ana got Edit on Tasks, and she cannot edit Log.
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("ana@dohc.test", ["Tasks"])] });
    await w.makeExecutor().open();
    await w.settledClaim(claim);
    expect(claim).toMatchObject({ state: "failed", error: "ana@dohc.test cannot edit Log." });
    expect([...w.records.values()].filter((record) => record.collection === "Log")).toEqual([]);
  });

  it("does not run code that someone who cannot view its Collection can change", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: [
      "  - id: code", "    name: Code", "    when: {field-changed: Status}", "    do:", "      - run-file: scripts/copy.js",
    ].join("\n") } });
    await mkdir(join(w.root, "Tasks", "scripts"), { recursive: true });
    await writeFile(join(w.root, "Tasks", "scripts", "copy.js"), "return { records: [{ action: 'add', collection: 'Log', fields: { Note: ctx.record.Note } }] };\n");
    // Ana can change the code and Log, but she cannot view Tasks.
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("ana@dohc.test", ["Tasks/scripts/copy.js", "Log"])] });
    const claim = w.claim(CODE, w.addRecord("Tasks", "one", { Status: "Done", Note: "private" }));
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim).toMatchObject({ state: "failed", error: "ana@dohc.test cannot view Tasks." });
    expect([...w.records.values()].filter((record) => record.collection === "Log")).toEqual([]);
  });

  it("refuses a change the code names outside what every editor can reach, before anything is written", async () => {
    const w = await world({ collections: ["Tasks", "Budget"], automations: { Tasks: coded(
      "return { set: { Seen: true }, records: [{ action: 'add', collection: 'Budget', fields: { Amount: 5 } }] };",
    ) } });
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("ana@dohc.test", ["Tasks"])] });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const claim = w.claim(CODE, task);
    await w.executor.open();
    await w.settledClaim(claim);
    expect(claim).toMatchObject({ state: "failed", error: "The code in step 1 changes records in Budget. ana@dohc.test cannot edit Budget." });
    expect(w.fieldsOf(task)).toEqual({ Status: "Done" });
    expect(w.journaled).toEqual([]);

    // Ana leaves. The change her reach stopped now waits for a current editor.
    w.setRoster(OWNER);
    const second = w.claim(CODE, task);
    w.executor.notifyClaimed();
    await w.until(() => w.events.includes(`released ${second.claimId}`));
    expect(w.journaled).toEqual([]);
    const [hold] = w.executor.holds();
    expect(hold).toMatchObject({ step: "0", action: "change", target: "Budget", recipient: "Budget", stoppedFor: "ana@dohc.test" });

    await expect(w.executor.confirmReach({ ...hold!, recipient: hold!.recipient! })).resolves.toBe("confirmed");
    await w.settledClaim(second);
    expect(second.state).toBe("done");
    expect([...w.records.values()].filter((record) => record.collection === "Budget").map((record) => w.fieldsOf(record))).toEqual([{ Amount: 5 }]);
  });
});
