
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import * as Y from "yjs";
import type { AutomationEvaluator } from "@dohc/app-backend-runtime/automation";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import type { CollectionQueryFilter, CollectionRecord } from "@dohc/workspace-contracts/collection";
import type { AutomationClaim, AutomationClaimMessage, AutomationGroupHandover, AutomationGroupRelayRecord, ChangeAttributionWire } from "@dohc/workspace-engine-client";
import type { RelayAutomationHost, RelayButtonAuthority } from "@dohc/workspace-contracts/relay";
import { DaemonRefusalError } from "@dohc/workspace-engine-client";
import { parseReachHandover } from "@dohc/automation-executor/reach-verdicts";
import { collectionRecordWrites } from "@dohc/automation-executor/collection-record-edits";
import { desktopRecordEditContext, type DesktopRecordEditHost } from "../workspaces/desktopRecordEdits";
import { createTestScratch } from "../workspaces/testTemp";

import { createAutomationFormulaEvaluator, type AutomationFormulaEvaluator } from "@dohc/automation-executor/automation-evaluator-host";
import { definitionHash, localIsoTime } from "@dohc/automation-executor/automation-plan";
import { type ReachRoster, type RosterGrant } from "@dohc/automation-executor/automation-reach";
import { createAutomationRunStore, type AutomationRunStore, type ReportedFailure, type StoredRun, type StoredSubscription } from "@dohc/automation-executor/automation-run-store";
import { fakeLocalStateOpens, preparedAutomationStoreFolder } from "../testing/preparedLocalState";
import { localAutomationStoreFolder } from "./localAutomationStore";
import { automationHostGeneration, createAutomationHosts, HANDOVER_READ_FIRST_MS, HOST_FRESH_MS, type AutomationHosts } from "./automationHost";

import { CollectionAutomations, UNREADABLE_REACH, type AutomationFailureReport, type AutomationSwitchedOff, type CollectionAutomationEngine, type CollectionAutomationsOptions } from "@dohc/automation-executor/collection-automations";
import { newRun, GROUP_CHANGED_ERROR, UNFINISHED_UNDO_ERROR, UNREADABLE_RUN_ERROR } from "@dohc/automation-executor/collection-automation-run";
import { AutomationChatSessionWait, AutomationWakeSent, chatDirectoryOf, NoticeNotSentError, type AutomationChatMessage, type AutomationNotice, type ChatDirectoryChannel, type ChatNeeds } from "@dohc/automation-executor/automation-chat";

import { createUsageStore } from "../usage/usageStore";
import { DESKTOP_USAGE_COVERAGE } from "../usage/cliUsage";

type RecordChange = Exclude<AutomationClaim["change"], { kind: "message" }>;

// The executor against an in-memory engine and record store: claims, record
// documents with the engine's idempotency rule, and files adopted as records.
// Formulas run in the real evaluator.

// Each world's engine open, which prepares its .dohc/local.
const localState = fakeLocalStateOpens();
const sharedEvaluator = createAutomationFormulaEvaluator();
afterAll(() => sharedEvaluator.close());
const evaluator = sharedEvaluator.forWorkspace("workspace");

const OWNER: ReachRoster = { kind: "owner", ownerUserId: "user-owner", grants: [] };
const editor = (email: string, paths: string[]): RosterGrant => ({
  grantId: `grant-${email}`, recipientUserId: `user-${email}`, recipientEmail: email,
  files: { paths, versionId: null, access: "edit" }, channel: null,
});

interface FakeRecord { id: string; path: string; collection: string; doc: Y.Doc; conflicted?: boolean }

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
  /** A controlled wake when testing a released claim. The engine RPC itself emits none. */
  onClaimReleased?: (claim: AutomationClaim) => void;
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
    const file = parseAutomationsFile(`version: 1\nautomations:\n${options.automations[collection] ?? ""}`);
    const buttonFields = file.status === "read" ? new Set(file.entries.flatMap(entry =>
      entry.status === "valid" && entry.automation.when.kind === "button" ? [entry.automation.when.field] : [])) : new Set<string>();
    const schema = `fields:\n${[...new Set([...FIELDS, ...buttonFields])].map(field => `  ${field}:\n    type: ${buttonFields.has(field) ? "button" : "text"}\n`).join("")}`;
    await writeFile(join(root, collection, "collection.yaml"), schema);
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
  const failures = { authoredWrite: 0, openSession: 0, capture: 0 };
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
    id: record.id, path: record.path, conflicted: record.conflicted ?? false,
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
    const record: FakeRecord = { id, path: `${collection}/${name}.md`, collection, doc };
    records.set(id, record);
    return record;
  };

  const engine: CollectionAutomationEngine = {
    makeAutomationWritesDurable: async () => {},
    sharedFileUpdateStates: async writes => writes.map(() => "settled"),
    workspaceId: "ws",
    listVersions: async () => [{ id: "main" }],
    // A path the version does not hold reads as null, as the engine answers.
    readTextFile: async ({ path }) => {
      try {
        return { text: await readFile(join(root, path), "utf8"), contentKind: "text", objectId: collections.get(dirname(path).replaceAll("\\", "/")) ?? path };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    // Every file under the workspace folder, as the engine lists text files.
    listTextFileMetadata: async () => (await readdir(root, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => ({ path: relative(root, join(entry.parentPath, entry.name)).split("\\").join("/"), objectId: collections.get(relative(root, entry.parentPath).split("\\").join("/")) ?? entry.name })),
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
      if (rosterAfterPress !== null) { roster = rosterAfterPress; rosterAfterPress = null; }
      return { busy: false, claim: summary(claim) };
    },
    releaseAutomationClaim: async ({ claimId }) => {
      const claim = claims.get(claimId)!;
      if (claim.state !== "running") throw new Error("Automation claim is not running.");
      claim.state = "pending"; claim.attempts -= 1;
      pending.push(claim);
      events.push(`released ${claimId}`);
      wake();
      options.onClaimReleased?.(claim);
      return claim;
    },
  };

  const capture: DesktopRecordEditHost["capture"] = {
    async openRecordSession(path) {
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
            if (journal.get(key) !== bytes) throw new DaemonRefusalError({code: "INVALID_PARAMS", message: "idempotency-key-reuse-mismatch", retry: "no"}, undefined);
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
      return session;
    },
    async writeAuthoredFile(absolutePath, content, author, writeOptions) {
      const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
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
      return { resolvedAbsolutePath: absolutePath, materializeOutcome: "applied", objectId: "object", momentId: "moment", deduped: false };
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
  // The store main makes, which writes only while the engine's open stands.
  const opened = { workspaceId: "workspace", rootPath: root };
  await localState.open(opened);
  const baseStore = createAutomationRunStore(localAutomationStoreFolder(opened));
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
  const recordWrites: CollectionAutomationsOptions["withRecordWrites"] = async (signal, work) => {
    await options.withRecordWrites?.(signal, events);
    return await work(collectionRecordWrites(desktopRecordEditContext({
      person: { kind: "human", humanId: "local:test" },
      capture, workspaceRoot: root, signal,
      withAdapter: async (read) => await read(engine),
      onCaptureSettled: (listener) => { if (failures.capture > 0) { failures.capture--; throw Error("capture offline"); } settleListeners.add(listener); return () => settleListeners.delete(listener); },
    })));
  };
  // A new executor over the same engine, files, and saved runs, as after a restart.
  const relayAuthorities = new Map<string, RelayButtonAuthority>();
  let rosterAfterPress: ReachRoster | null = null;
  const makeExecutor = (extra: Partial<CollectionAutomationsOptions> = {}) => new CollectionAutomations({
    resolveRelayedPress: async id => {
      const authority = relayAuthorities.get(id);
      if (!authority) throw Error("No accepted relay press.");
      return authority;
    },
    withEngine: async (work) => await work(engine),
    withRecordWrites: recordWrites,
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
    groupList: async () => (options.channels ?? []).flatMap((channel) =>
      (channel.kind === "channel" ? [{ name: channel.name, slug: channel.slug }] : [])),
    chat: { hasMessage: async () => false,
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
    reachRelayRecord: async () => ({ generation: 0, reach: null, everShared: false }),
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
    // Undo writes through the same seam as the runs, as it does on a desktop.
    withUndoWrites: extra.withUndoWrites ?? extra.withRecordWrites ?? recordWrites,
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
    relayPress: async (host: CollectionAutomations, input: Parameters<CollectionAutomations["pressRelayed"]>[0], watch: Parameters<CollectionAutomations["pressRelayed"]>[1]) => {
      relayAuthorities.set(input.pressId, { workspaceId: "workspace", userId: input.pressedBy, grantId: "g-ana", grantGeneration: 1, hostGeneration: 1,
        principals: [], confirmed: [], automationId: input.automationId, collectionPath: input.collectionPath, definitionHash: input.definitionHash, recordId: input.recordId });
      // These old host-hold tests lose the roster after admission, before the claim drains.
      if (roster.kind === "unknown") {
        rosterAfterPress = roster; roster = OWNER;
      }
      return host.pressRelayed(input, watch);
    },
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
    renameCollection: async (from: string, to: string, deliverWatcherEvents = true) => {
      await mkdir(dirname(join(root, to)), { recursive: true });
      await rename(join(root, from), join(root, to));
      const objectId = collections.get(from)!;
      collections.delete(from);
      collections.set(to, objectId);
      for (const record of records.values()) {
        if (record.collection !== from) continue;
        record.collection = to;
        record.path = `${to}/${record.path.slice(from.length + 1)}`;
      }
      if (deliverWatcherEvents) executor.handleWatcherEvents(["collection.yaml", "automations.yaml"].flatMap((name) => [
        { operation: "delete" as const, path: `${from}/${name}` },
        { operation: "update" as const, path: `${to}/${name}` },
      ]));
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
    /** Ends the engine's open of the workspace, or opens it again. */
    localState: { close: () => localState.close(opened), open: () => localState.open(opened) },
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

  it("lists locally completed writes with current shared settlement state", async () => {
    const w = await world({automations: {Tasks: "  - id: finish\n    name: Finish\n    when: {field-changed: Status, to: Done}\n    do: [{set: {Note: saved}}]\n"}});
    const record = w.addRecord("Tasks", "pending", {Status: "Done"});
    const claim = w.claim("collection:Tasks#finish", record);
    const executor = w.makeExecutor({withRecordWrites: async (_signal, work) => work({
      setFields: async () => ({replaced: {Note: null}, kept: {}, sharedFileUpdates: {Note: {
        outboxId: "outbox-one", appendKey: "write/Note", nativeHeadSequence: 2,
        binding: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
          currentPath: "Tasks/pending.md", selectorPaths: ["Tasks"], restoreFenceGeneration: 0},
      }}}),
      create: async () => { throw new Error("No added record"); },
    })});
    onTestFinished(() => executor.dispose());
    let pending = true;
    const read = vi.fn(async (writes: readonly unknown[]) => writes.map(() => pending ? "pending" as const : "settled" as const));
    w.engine.sharedFileUpdateStates = read;
    await executor.open();
    expect((await w.settledClaim(claim)).state).toBe("done");
    expect((await executor.runs(claim.automationId)).runs[0]).toMatchObject({state: "done", error: null, sharedSettlementPending: true,
      writes: [{kind: "field", field: "Note", after: "saved"}]});
    expect(await executor.listedRun(claim.automationId, claim.claimId)).toMatchObject({sharedSettlementPending: true});
    expect(await executor.run(claim.automationId, claim.claimId)).toMatchObject({sharedSettlementPending: true});
    pending = false;
    expect((await executor.runs(claim.automationId)).runs[0]?.sharedSettlementPending).toBeUndefined();
    expect((await executor.run(claim.automationId, claim.claimId))?.sharedSettlementPending).toBeUndefined();
    const reads = read.mock.calls.length;
    pending = true;
    expect((await executor.runs(claim.automationId)).runs[0]?.sharedSettlementPending).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(reads);
  });

  it("counts pending reversals once and keeps refused reversals retryable", async () => {
    const definition = "  - id: finish\n    name: Finish\n    when: {field-changed: Status, to: Done}\n    do: [{set: {Note: saved}}]\n";
    const w = await world({automations: {Tasks: definition}});
    const record = w.addRecord("Tasks", "one", {Status: "Done"});
    const claim = w.claim("collection:Tasks#finish", record);
    const draft = {outboxId: "reverse-outbox", appendKey: "reverse/Note", nativeHeadSequence: 2,
      binding: {workspaceId: "workspace", mainVersionId: "main", objectId: record.id, lineageClaimId: "a".repeat(64),
        currentPath: record.path, selectorPaths: ["Tasks"], restoreFenceGeneration: 0}};
    const reverse = vi.fn(async (input: Parameters<ReturnType<typeof collectionRecordWrites>["setFields"]>[0]) => {
      draft.appendKey = `${input.idempotencyKeyPrefix}/Note`;
      return {replaced: {Note: "saved"}, kept: {}, sharedFileUpdates: {Note: {...draft}}};
    });
    const executor = w.makeExecutor({withUndoWrites: async (_signal, work) => work({
      setFields: reverse, create: async () => {throw new Error("No added record");},
    })});
    onTestFinished(() => executor.dispose());
    let state: "pending" | "not-accepted" | "settled" | "absent" = "pending";
    w.engine.sharedFileUpdateStates = async writes => writes.map(() => state);
    await executor.open();
    await w.settledClaim(claim);
    const input = {automationId: claim.automationId, claimId: claim.claimId, deletes: null};
    expect(await executor.undo(input, async () => undefined)).toMatchObject({status: "undone", reverted: 0, sharedReversals: [{draft, state: "pending"}]});
    expect(await executor.listedRun(claim.automationId, claim.claimId)).toMatchObject({undone: true, undoSettlementPending: true});
    expect(await executor.undo(input, async () => undefined)).toEqual({status: "refused", reason: "You already undid this run."});
    expect(reverse).toHaveBeenCalledOnce();
    state = "not-accepted";
    expect(await executor.run(claim.automationId, claim.claimId)).toMatchObject({undone: false, undoSettlementNotAccepted: true});
    const hash = await hashOf(executor, "Tasks", "finish");
    expect(await executor.undoRunsOf([{collectionPath: "Tasks", id: "finish", definitionHash: hash}], async () => undefined))
      .toMatchObject({undone: 1, left: 0, reverted: 0, sharedReversals: [{state: "pending"}]});
    expect(reverse).toHaveBeenCalledTimes(2);
    expect(reverse.mock.calls[1]?.[0].idempotencyKeyPrefix).not.toBe(reverse.mock.calls[0]?.[0].idempotencyKeyPrefix);
    state = "pending";
    expect(await executor.undoRunsOf([{collectionPath: "Tasks", id: "finish", definitionHash: hash}], async () => undefined))
      .toMatchObject({undone: 0, left: 0, sharedReversals: [{state: "pending"}]});
    expect(await executor.undoRunsOf([{collectionPath: "Tasks", id: "finish", definitionHash: hash}], async () => undefined, true))
      .toMatchObject({sharedReversals: [{state: "pending"}]});
    state = "settled";
    expect(await executor.listedRun(claim.automationId, claim.claimId)).toMatchObject({undone: true});
    expect(await executor.undoRunsOf([{collectionPath: "Tasks", id: "finish", definitionHash: hash}], async () => undefined, true))
      .not.toHaveProperty("sharedReversals");
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
    // The builder's check of the same automation, unchanged, says the same.
    const saved = syncedList.status === "read" && syncedList.automations[0]?.valid ? syncedList.automations[0].automation : null;
    await expect(synced.draftCannotRun("Tasks", saved!)).resolves.toBe("Turn on sync to run this workspace's schedules.");
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
    const pressed = await w.executor.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-1", pressedBy: "user-ice", confirmed: [], by: { kind: "human" } }, (claimId) => watched.push(claimId));
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
      { collectionPath: "Tasks", field: "Mark paid", recordId: other.id, pressId: "press-agent", pressedBy: "user-ice", confirmed: [], by: { kind: "agent", originId: "dohc-mcp", depth: 2 } },
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
    const again = await w.executor.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-1", pressedBy: "user-ice", confirmed: [], by: { kind: "human" } }, (claimId) => watched.push(claimId));
    expect(again).toEqual({ busy: false, claimId: claim.claimId, settled: { outcome: "done", error: null } });
    // A run that already ended has no settle left to hear.
    expect(watched).toEqual([claim.claimId]);
    // The id names this press, so another person, field, or record is refused.
    await expect(w.executor.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-1", pressedBy: "user-ana", confirmed: [], by: { kind: "human" } }, () => undefined))
      .rejects.toThrow("This press id already names another press.");
    // After a restart the engine still has the press, so the switched-off
    // button answers it, and still refuses it to anyone else.
    const restarted = w.makeExecutor();
    await restarted.open();
    await expect(restarted.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-1", pressedBy: "user-ice", confirmed: [], by: { kind: "human" } }, () => undefined))
      .resolves.toEqual({ busy: false, claimId: claim.claimId, settled: { outcome: "done", error: null } });
    await expect(restarted.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-1", pressedBy: "user-ana", confirmed: [], by: { kind: "human" } }, () => undefined))
      .rejects.toThrow("This press id already names another press.");
    // A new press on the switched-off button is still refused.
    await expect(restarted.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-2", pressedBy: "user-ice", confirmed: [], by: { kind: "human" } }, () => undefined))
      .rejects.toThrow("Mark paid is off. Turn it on in Automations.");
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
    const relayed = await w.relayPress(executor, { automationId: "collection:Tasks#paid", collectionPath: "Tasks", definitionHash: paid, recordId: invoice.id, pressId: "relay-1", pressedBy: "user-ana", confirmed: [] }, () => undefined);
    if (relayed.pressed.busy) throw new Error("Expected a claim");
    await aborted;
    await new Promise((resolve) => setImmediate(resolve));
    expect(hold.held()).toBe(1);
    finishWrite();
    await w.settledClaim(w.claims.get(relayed.pressed.claimId)!);
    expect(hold.held()).toBe(0);
  });

  it("runs a failed press again only for the person who pressed it or the owner", async () => {
    const w = await world({
      automations: { Tasks: "  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do: [{set: {Total: '=record.Missing.length'}}]\n" },
      mayRetryPress: async (pressedBy) => pressedBy === "user-ice",
    });
    const invoice = w.addRecord("Tasks", "invoice", {});
    await w.executor.open();
    const pressed = await w.executor.press({ collectionPath: "Tasks", field: "Mark paid", recordId: invoice.id, pressId: "press-1", pressedBy: "user-ana", confirmed: [], by: { kind: "human" } }, () => undefined);
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

  it("fails a run whose progress dohc may not save, keeps what it saved, and tries it again without repeating what landed", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: BUMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    const claim = w.claim(TASKS, task);
    // The engine's open ends after step 1's write landed, before it is recorded.
    w.beforeNextRecord(() => w.localState.close());
    await w.executor.open();
    await w.settledClaim(claim);
    const refused = "dohc did not save automation progress because the workspace has not finished opening. Try again when it opens.";
    expect(claim).toMatchObject({ state: "failed", error: refused });
    expect(w.fieldsOf(task).Count).toBe(3);
    // The person hears why, with Try again.
    await w.until(() => w.failureReports.length === 1);
    expect(w.failureReports[0]!.failure).toMatchObject({ claimId: claim.claimId, error: refused });

    await w.localState.open();
    // The step saved before the refusal is still there. On Windows dohc reads
    // it only while an open holds `.dohc/local`.
    const [saved] = (await w.baseStore.runsOf(TASKS, claim.claimId)).runs;
    expect(saved!.steps).toHaveLength(1);
    expect(saved!.applied).toEqual([]);
    await w.executor.retry({ automationId: TASKS, claimId: claim.claimId, startOver: false });
    await w.until(() => claim.state === "done");
    expect(w.fieldsOf(task).Count).toBe(3);
    expect([...w.records.values()].filter((record) => record.collection === "Log")).toHaveLength(1);
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

  // A Find may match 500 records, but a run may change only 200 fields, so the
  // full Find only counts.

  it("fails closed when a run's saved progress cannot be read, instead of starting over", async () => {
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: BUMP } });
    const task = w.addRecord("Tasks", "one", { Status: "Done", Count: 2 });
    w.failures.authoredWrite = 1;
    const claim = w.claim(TASKS, task);
    await w.executor.open();
    await w.settledClaim(claim);
    const folder = join(w.root, ".dohc", "local", "automations", "runs");
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
    w.setRoster({ kind: "unknown", problem: { kind: "unchecked", next: "Try again later." } });
    await w.executor.idle();
    const pokes = w.runsChanged.length;
    await expect(w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, deletes: null }, trash))
      .resolves.toEqual({ status: "undone", reverted: 1, removed: 1, changedSince: 1, missing: 0, kept: 0, irreversible: 0, actions: 0, deleted: 0, keptChanged: 0, gone: 0, actionsReversed: 0 });
    // Every window reads again, not only the pane that asked for the Undo.
    expect(w.runsChanged).toHaveLength(pokes + 1);
    expect(w.fieldsOf(task)).toMatchObject({ Count: 2, Note: "theirs" });
    expect(trashed).toEqual([added!.path]);
    expect(w.journaled.at(-1)).toMatchObject({ path: task.path, actorOriginId: "local:test",
      attribution: { actorKind: "human", onBehalfOf: "local:test", depth: 0 } });

    // Note kept a later value, so Undo can try it again, and keeps it again.
    const [run] = (await w.executor.runs("collection:Tasks#stamp")).runs;
    expect(run).toMatchObject({ state: "done", undone: false, chainStopped: false });
    await expect(w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, deletes: null }, trash))
      .resolves.toEqual({ status: "undone", reverted: 0, removed: 0, deleted: 0, keptChanged: 0, gone: 0, changedSince: 1, missing: 0, kept: 0, irreversible: 0, actions: 0, actionsReversed: 0 });
    expect(trashed).toEqual([added!.path]);
    task.doc.getMap("frontmatter").set("Note", "done");
    await expect(w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, deletes: null }, trash))
      .resolves.toMatchObject({ status: "undone", reverted: 1, changedSince: 0 });
    expect(w.fieldsOf(task).Note).toBe("old");
    expect(((await w.executor.runs("collection:Tasks#stamp")).runs)[0]).toMatchObject({ undone: true });
    await expect(w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, deletes: null }, trash))
      .resolves.toEqual({ status: "refused", reason: "You already undid this run." });
  });

  it.each(["stop-and-restore"] as const)("keeps %s unfinished when its WAL barrier fails and preserves completed reversal keys", async (mode: "undo" | "kept" | "stop-and-restore") => {
    const w = await world({collections: ["Tasks", "Log"], automations: {Tasks: STAMP}});
    const task = w.addRecord("Tasks", "one", {Status: "Done", Count: 2, Note: "old"});
    const claim = w.claim("collection:Tasks#stamp", task);
    await w.executor.open(); await w.settledClaim(claim);
    const input = {automationId: claim.automationId, claimId: claim.claimId, deletes: null};
    if (mode === "kept") {
      task.doc.getMap("frontmatter").set("Count", 99);
      await w.executor.undo(input, async () => {});
      task.doc.getMap("frontmatter").set("Count", 3);
    }
    const hash = await hashOf(w.executor, "Tasks", "stamp");
    const log: string[] = [];
    let fail = true;
    w.engine.makeAutomationWritesDurable = async () => {log.push("barrier"); if (fail) throw Error("WAL sync failed");};
    await w.executor.dispose();
    const executor = w.makeExecutor({store: {...w.baseStore, updateState: async (run, state) => {
      if (state.undo === "done") log.push("done");
      await w.baseStore.updateState(run, state);
    }}});
    onTestFinished(() => executor.dispose()); await executor.open();
    const attempt = () => mode === "stop-and-restore"
      ? executor.undoRunsOf([{collectionPath: "Tasks", id: "stamp", definitionHash: hash}], async () => {})
      : executor.undo(input, async () => {});
    if (mode === "stop-and-restore") expect(await attempt()).toMatchObject({errorMessage: "WAL sync failed"});
    else await expect(attempt()).rejects.toThrow("WAL sync failed");
    expect(log).toEqual(["barrier"]);
    expect((await w.baseStore.runsOf(claim.automationId, claim.claimId)).runs[0]?.undo).toBe("started");
    expect(w.fieldsOf(task).Count).toBe(2);
    // The reversal committed before the crash. Someone edits it again;
    // retry honors the same engine key rather than reversing their edit.
    task.doc.getMap("frontmatter").set("Count", 3);
    fail = false;
    expect(await attempt()).toMatchObject(mode === "stop-and-restore" ? {errorMessage: null} : {status: "undone"});
    expect(log).toEqual(["barrier", "barrier", "done"]);
    expect(w.fieldsOf(task).Count).toBe(3);
  });

  it.each([
    ["older Undo intervenes before expiry and restart", true, true],
  ] as const)("undoes runs of two automations newest first across both when %s", async (_case, conflict, intervenes) => {
    const later = STAMP.replace("id: stamp", "id: later").replace("name: Stamp", "name: Later");
    const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: `${STAMP}\n${later}\n` } });
    let now = Date.UTC(2026, 8, 1);
    let executor = w.makeExecutor({ nowMs: () => now });
    const shared = w.addRecord("Tasks", "shared", { Status: "Done", Count: 2, Note: "two" });
    const other = w.addRecord("Tasks", "other", { Status: "Done", Count: 2, Note: "y" });
    const older = w.claim("collection:Tasks#stamp", shared);
    await executor.open();
    await w.settledClaim(older);
    now += 1_000;
    const newer = w.claim("collection:Tasks#later", shared);
    executor.notifyClaimed();
    await w.settledClaim(newer);
    // Stamp's older run wrote Note "two" to "one"; Later's newer run wrote it
    // back to "two", and wrote the other record too.
    const rewrite = async (automationId: string, claimId: string, writes: Array<{ record: typeof shared; before: string; after: string }>) => {
      const [run] = (await w.baseStore.runsOf(automationId, claimId)).runs;
      await w.baseStore.save({
        ...run!, created: [],
        applied: run!.applied.map((entry, index) => ({
          ...entry,
          writes: index > 0 ? [] : writes.map(({ record, before, after }) => ({ kind: "field" as const, recordId: record.id, path: record.path, field: "Note", before, after })),
        })),
      });
    };
    await rewrite("collection:Tasks#stamp", older.claimId, [{ record: shared, before: "two", after: "one" }]);
    await rewrite("collection:Tasks#later", newer.claimId, [{ record: other, before: "x", after: "y" }, { record: shared, before: "one", after: "two" }]);
    shared.doc.getMap("frontmatter").set("Note", "two");
    other.doc.getMap("frontmatter").set("Note", "y");
    const file = await executor.automationsIn("Tasks");
    if (file.status !== "read") throw new Error("expected the automations to read");
    const hashOf = (id: string) => {
      const found = file.automations.find((automation) => automation.valid && automation.automation.id === id);
      if (!found?.valid) throw new Error(`expected ${id} to read`);
      return found.definitionHash;
    };
    // The older automation's definition first: the order of the pass must not follow it.
    const definitions = [
      { collectionPath: "Tasks", id: "stamp", definitionHash: hashOf("stamp") },
      { collectionPath: "Tasks", id: "later", definitionHash: hashOf("later") },
    ];

    if (conflict) {
      other.conflicted = true;
      // The pass stops at the newer run, after it put the shared record back, and leaves the older run as it is.
      await expect(executor.undoRunsOf(definitions, async () => undefined, false, "retained-restore")).resolves.toMatchObject({
        undone: 0, errorMessage: "Tasks/other.md has a sync conflict. Resolve the conflict, then try again.",
      });
      expect(w.fieldsOf(shared).Note).toBe("one");
      expect(w.fieldsOf(other).Note).toBe("y");
      expect((await w.baseStore.runsOf("collection:Tasks#stamp", older.claimId)).runs.map((run) => run.undo)).toEqual([null]);
      if (intervenes) {
        now += 31 * 24 * 60 * 60 * 1000;
        await w.baseStore.expire(now, async () => "gone", null);
        expect((await w.baseStore.runsOf("collection:Tasks#stamp", older.claimId)).runs).toHaveLength(1);
        expect((await executor.listedRun("collection:Tasks#later", newer.claimId))?.undoUnfinished).toBe(true);
        expect(await executor.retry({automationId: "collection:Tasks#later", claimId: newer.claimId, startOver: false})).toMatchObject({
          status: "refused", reason: "dohc has not finished undoing this run.",
        });
        await executor.undo({automationId: "collection:Tasks#stamp", claimId: older.claimId, deletes: null}, async () => undefined);
        expect(w.fieldsOf(shared).Note).toBe("two");
        await executor.dispose();
        executor = w.makeExecutor({nowMs: () => now});
        await executor.open();
      }
      other.conflicted = false;
    }
    await expect(executor.undoRunsOf(definitions, async () => undefined, false, "retained-restore")).resolves.toMatchObject({ undone: intervenes ? 1 : 2, errorMessage: null });
    expect(w.fieldsOf(other).Note).toBe("x");
    expect(w.fieldsOf(shared).Note).toBe("two");
    await executor.dispose();
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
      .resolves.toEqual({ status: "refused", reason: UNFINISHED_UNDO_ERROR });
    // Even once the automation changes, reading the run does not offer to start over: Try again refuses.
    await w.writeAutomations("Tasks", STAMP.replace("Title: Stamped", "Title: Stamped again"));
    // The executor reads the file again before it answers.
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    expect(await w.executor.run("collection:Tasks#stamp", claim.claimId)).toMatchObject({ definitionChanged: true, startsOver: false });
    await expect(w.executor.retry({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, startOver: true }))
      .resolves.toEqual({ status: "refused", reason: UNFINISHED_UNDO_ERROR });
    await w.writeAutomations("Tasks", STAMP);
    w.executor.handleWatcherEvents([{ operation: "update", path: "Tasks/automations.yaml" }]);
    expect(await w.executor.run("collection:Tasks#stamp", claim.claimId)).toMatchObject({ definitionChanged: false });
    // A requeue from the engine's recovery does not resume the plan either.
    claim.state = "pending";
    w.requeue(claim);
    w.executor.notifyClaimed();
    await w.until(() => claim.state === "failed" && claim.error === UNFINISHED_UNDO_ERROR);
    expect([...w.records.values()].filter((record) => record.collection === "Log")).toEqual([]);

    await expect(w.executor.undo({ automationId: "collection:Tasks#stamp", claimId: claim.claimId, deletes: null }, async () => undefined))
      .resolves.toEqual({ status: "undone", reverted: 2, removed: 0, changedSince: 0, missing: 0, kept: 0, irreversible: 0, actions: 0, deleted: 0, keptChanged: 0, gone: 0, actionsReversed: 0 });
    expect(w.fieldsOf(task)).toMatchObject({ Count: 2, Note: "old" });
    const [finished] = (await w.executor.runs("collection:Tasks#stamp")).runs;
    expect(finished).toMatchObject({ undone: true });
  });

  it("reports a saved breaker after restart when delivery failed, once", async () => {
    const timedOut: AutomationEvaluator["evaluate"] = async (_scope, formulas) =>
      formulas.map(() => ({ ok: false, error: { code: "timeout", message: "private-step-token".repeat(2_000) } }));
    const w = await world({ automations: { Tasks: "  - id: slow\n    name: Slow\n    when: {field-changed: Status}\n    do: [{set: {X: '=spin()'}}]\n" },
      evaluator: createAutomationFormulaEvaluator(() => ({ evaluate: timedOut, runCode: async () => { throw new Error("unused"); }, close: async () => undefined })).forWorkspace("workspace") });
    await w.executor.dispose();
    const offline = w.makeExecutor({ reportFailure: async () => { throw new Error("offline"); } });
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const claims = [
      w.claim("collection:Tasks#slow", task, { actorKind: "human", onBehalfOf: "human" }),
      w.claim("collection:Tasks#slow", task, { actorKind: "human", onBehalfOf: "creator" }),
      w.claim("collection:Tasks#slow", task, { actorKind: "human", onBehalfOf: "remover" }),
    ];
    await offline.open();
    for (const claim of claims) await w.settledClaim(claim);
    await offline.dispose();
    const restarted = w.makeExecutor();
    await restarted.open();
    await w.until(() => w.reportedFailures().some((entry) => entry.claimId === claims[2]!.claimId));
    expect(w.failureReports).toHaveLength(1);
    expect(w.failureReports[0]).toMatchObject({ startedBy: "remover", failure: { claimId: claims[2]!.claimId,
      switchedOff: { reason: "consecutive-timeouts", collectionPath: "Tasks" } } });
    restarted.failuresChanged();
    await restarted.dispose();
    expect(w.failureReports).toHaveLength(1);
    expect(w.writtenAs).toHaveLength(1);
  });

  // Node reports no mode on Windows.

  it("keeps every automation waiting when the saved verdicts cannot be read, until the holds are reset and allowed", async () => {
    const w = await world({ automations: { Tasks: "  - id: seen\n    name: Seen\n    when: {field-changed: Status}\n    do: [{set: {Seen: true}}]\n" } });
    await mkdir(join(w.root, ".dohc", "local", "automations"), { recursive: true });
    await writeFile(join(w.root, ".dohc", "local", "automations", "reach.json"), "{ torn");
    const task = w.addRecord("Tasks", "one", { Status: "Done" });
    const claim = w.claim("collection:Tasks#seen", task);
    await w.executor.open();
    await w.until(() => w.events.includes(`released ${claim.claimId}`));
    expect(w.executor.holdState()).toEqual({ holds: [], stops: [], unreadable: true, unprovenPaths: [] });
    expect(await w.executor.automationsIn("Tasks")).toMatchObject({ automations: [{ reach: { kind: "waiting", reason: UNREADABLE_REACH } }] });
    // Nothing overwrote the file dohc could not read.
    expect(await readFile(join(w.root, ".dohc", "local", "automations", "reach.json"), "utf8")).toBe("{ torn");

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

  // A broken entry keeps a name of any length. History shows it up to its
  // bound, and the automation's id past that, alone or beside another author.

});

describe("Collection automations that post", () => {
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

  it.each(["automation-wake:later"])("records a server hand-off after reach, including supersession (%s)", async (supersededBy) => {
    const w = await world({ automations: { Tasks: ask } });
    const writes: AutomationChatMessage[] = [];
    const executor = w.makeExecutor({
      chat: { hasMessage: async () => false,
        directory: async (roster) => chatDirectoryOf([], roster),
        write: async (_signal, message) => {
          writes.push(message);
          return new AutomationWakeSent("automation-wake:receipt", "Ice", supersededBy);
        },
      },
    });
    const claim = w.claim("collection:Tasks#ask", w.addRecord("Tasks", "one", { Status: "Done" }));
    await executor.open();
    await w.settledClaim(claim);
    expect(claim.state).toBe("done");
    expect(writes).toHaveLength(1);
    const [run] = (await executor.runs("collection:Tasks#ask")).runs;
    expect(run!.writes).toEqual([{ kind: "notice", noticeId: "automation-wake:receipt", name: "Ice", ...(supersededBy ? { supersededBy } : {}) }]);
    w.setRoster({ kind: "owner", ownerUserId: "user-owner", grants: [editor("bob@dohc.test", ["Tasks"])] });
    const stopped = w.claim("collection:Tasks#ask", w.addRecord("Tasks", "two", { Status: "Done" }));
    executor.notifyClaimed();
    await w.settledClaim(stopped);
    expect(stopped.state).toBe("failed");
    expect(writes).toHaveLength(1);
  });

  describe("signed out, in a workspace proved never shared", () => {
    const local = [
      "  - id: local",
      "    name: Ask and tell me",
      "    when: {field-changed: Status}",
      "    do: [{wake-agent: Plan, person: install-here}, {notify: Done, to: [install-here]}]",
    ].join("\n");
    const provedLocal: ReachRoster = { kind: "owner", ownerUserId: null, localPersonId: "install-here", grants: [] };

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

  type World = Awaited<ReturnType<typeof world>>;
  type Workspace = { rootPath: string; remote?: unknown };
  type FakeTimer = { wake: () => void; delayMs: number; done: boolean };
  // The relay's record of the host, as the routes keep it, for all the owner's computers.
  type Relay = {
    row: RelayAutomationHost | null;
    onRelease?: () => void;
    down?: boolean;
    checkIns?: number;
    // The last release's Group handover and reach verdicts, for the computer it named.
    kept: { generation: number; forInstall: string; groups: AutomationGroupHandover; reach: unknown } | null;
    everShared?: boolean;
    // Only the reach verdicts read fails, or answers what this returns.
    reachDown?: boolean;
    onReachRead?: () => Promise<never>;
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
            reach: request.body.reach,
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
        if (released === null) return null;
        return { throughMs: 5_000, groups: released.handover, groupsWatched: released.watchedGeneration, reach: await executor.reachHandover() };
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
      groupHost: () => automationHostGeneration(workspace, { installId, label: installId }, () => hosts.runsAt("ws")),
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
      reachRelayRecord: async (generation) => {
        if (relay.down) throw new TypeError("fetch failed");
        if (relay.row?.generation !== generation) throw new Error("The relay answered the Group handover read with 409.");
        const everShared = relay.everShared ?? false;
        if (relay.reachDown) throw new TypeError("fetch failed");
        if (relay.onReachRead) return relay.onReachRead();
        if (relay.kept === null) return { generation: 0, reach: null, everShared };
        return {
          generation: relay.kept.generation,
          reach: relay.kept.forInstall === relay.row.installId ? parseReachHandover(relay.kept.reach) : null,
          everShared,
        };
      },
      requestHost: (signal) => hosts.admit("ws", signal),
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

  describe("reach verdicts across the owner's computers", () => {

    const spend = [
      "  - id: spend",
      "    name: Spend",
      "    when: {field-changed: Status}",
      "    do: [{add-record: {Amount: 5}, collection: Budget}]",
    ].join("\n");
    // Bob can edit Tasks but not Budget, so the step he wrote stops.
    const withBob: ReachRoster = { kind: "owner", ownerUserId: "user-owner", grants: [editor("bob@dohc.test", ["Tasks"])] };
    type Step = { verdict: string; stoppedFor: string | null; seq: number };
    const stepOf = async (executor: CollectionAutomations, id: string) => {
      const { automations } = await executor.automationsIn("Tasks") as {
        automations: Array<{ automationId: string; definitionHash: string; reach: { steps: Step[] } }>;
      };
      const summary = automations.find((automation) => automation.automationId === `collection:Tasks#${id}`)!;
      return { ...summary.reach.steps[0]!, definitionHash: summary.definitionHash };
    };
    const spendStep = (executor: CollectionAutomations) => stepOf(executor, "spend");

    // The laptop hosts and saw Bob's share; the desk opened after it ended.
    async function laptopAndDesk(everShared: boolean) {
      const workspace = { rootPath: "", remote: {} };
      const relay: Relay = { row: null, kept: null, everShared };
      const options = { collections: ["Tasks", "Budget"], channels: [TRIP], automations: { Tasks: `${task}\n${spend}` } };
      const laptop = await world(options);
      const desk = await world(options);
      laptop.setRoster(withBob);
      desk.setRoster(OWNER);
      const onLaptop = ownersComputer("laptop", laptop, relay, workspace);
      await onLaptop.executor.open();
      await laptop.until(() => subscribed(laptop));
      const onDesk = ownersComputer("desk", desk, relay, workspace);
      await onDesk.executor.open();
      expect(await spendStep(onLaptop.executor)).toMatchObject({ verdict: "stopped", reason: "bob@dohc.test cannot edit Budget." });
      expect(await spendStep(onDesk.executor)).toMatchObject({ verdict: "allowed" });
      return { relay, desk, onLaptop, onDesk };
    }

    const late = ["  - id: late", "    name: Late", "    when: {field-changed: Status}", "    do: [{add-record: {Amount: 1}, collection: Budget}]"].join("\n");
    it.each([
      ["a file that did not parse", `${late}\n  - id: [unclosed`],
    ])("holds a definition that comes back when someone fixes %s at the listing, until Allow", async (_case, broken) => {
      const { relay, desk, onDesk } = await laptopAndDesk(true);
      const { definitionHash } = await spendStep(onDesk.executor);
      relay.row = { installId: "desk", generation: 2, handoverFrom: null, releasedThroughMs: null };
      relay.kept = { generation: 2, forInstall: "none", groups: { floorMs: 1, automations: [] }, reach: null };
      onDesk.hosts.learned("ws", relay.row);
      await desk.until(() => subscribed(desk));
      // Written before the take over by someone who may have left since, and
      // broken in every version when the listing runs.
      await desk.writeAutomations("Tasks", `${task}\n${spend}\n${broken}`);
      onDesk.executor.handlePulledPaths(["Tasks/automations.yaml"]);
      onDesk.executor.relayAnswered();
      await onDesk.executor.automationsIn("Tasks");
      const listed = await desk.baseStore.readReachVerdicts();
      expect(listed).toMatchObject({ unprovenAll: false, unprovenPaths: [], unprovenFolders: ["Tasks"] });
      expect(listed.unproven, "a definition the broken file may still name stays").toContain(JSON.stringify(["collection:Tasks#spend", definitionHash]));

      // A current editor fixes only the syntax: the definition comes back as it was.
      await desk.writeAutomations("Tasks", `${task}\n${spend}\n${late}`);
      onDesk.executor.handlePulledPaths(["Tasks/automations.yaml"]);
      const held = await stepOf(onDesk.executor, "late");
      // The file reads in every version now, so the take over's hold is the reason.
      expect(held).toMatchObject({ verdict: "held", stoppedFor: null, fileUnread: false });
      expect((await desk.baseStore.readReachVerdicts()).unprovenFolders, "the file reads in every version now").toEqual([]);
      await onDesk.executor.confirmReach({ automationId: "collection:Tasks#late", definitionHash: held.definitionHash, step: "0", seq: held.seq });
      expect(await stepOf(onDesk.executor, "late")).toMatchObject({ verdict: "allowed" });

      // One written after that runs as usual.
      const fresh = ["  - id: fresh", "    name: Fresh", "    when: {field-changed: Status}", "    do: [{add-record: {Amount: 2}, collection: Budget}]"];
      await desk.writeAutomations("Tasks", `${task}\n${spend}\n${late}\n${fresh.join("\n")}`);
      onDesk.executor.handlePulledPaths(["Tasks/automations.yaml"]);
      expect(await stepOf(onDesk.executor, "fresh")).toMatchObject({ verdict: "allowed" });
    });

    it("watches no Groups and releases no verdicts until it took the last host's", async () => {
      const { relay, desk, onLaptop, onDesk } = await laptopAndDesk(true);
      let released: () => void = () => undefined;
      const release = new Promise<void>((resolve) => { released = resolve; });
      relay.onRelease = () => released();
      relay.row = { installId: "desk", generation: 2, handoverFrom: "laptop", releasedThroughMs: null };
      onLaptop.hosts.learned("ws", relay.row);
      await release;

      relay.reachDown = true;
      onDesk.hosts.learned("ws", relay.row);
      // The reconcile the host change queued has finished once this answers.
      await onDesk.executor.automationsIn("Tasks");
      expect(desk.errors.map(({ context }) => context)).toContain("read the last automation host's reach verdicts");
      expect(subscribed(desk)).toBe(false);
      await expect(onDesk.executor.reachHandover()).resolves.toBeNull();
      // A claim waits meanwhile.
      const claim = messageClaim(desk);
      const drained = desk.idleDrains();
      onDesk.executor.notifyClaimed();
      await desk.until(() => desk.idleDrains() > drained);
      expect(added(desk)).toEqual([]);

      relay.reachDown = false;
      onDesk.executor.relayAnswered();
      await desk.until(() => subscribed(desk));
      expect(await spendStep(onDesk.executor)).toMatchObject({ verdict: "held", stoppedFor: "bob@dohc.test" });
      await expect(onDesk.executor.reachHandover()).resolves.not.toBeNull();
      // Taking the verdicts ends that wait. Bob could not read the Group, so
      // the laptop had stopped this automation too: it runs once allowed.
      const task = await stepOf(onDesk.executor, "task");
      expect(task).toMatchObject({ verdict: "held", stoppedFor: "bob@dohc.test" });
      await onDesk.executor.confirmReach({ automationId: "collection:Tasks#task", definitionHash: task.definitionHash, step: "0", seq: task.seq });
      await desk.settledClaim(claim);
      expect(claim.state).toBe("done");
    });

    it("remembers across a restart that it never took the last host's verdicts", async () => {
      const { relay, desk, onLaptop, onDesk } = await laptopAndDesk(true);
      let released: () => void = () => undefined;
      const release = new Promise<void>((resolve) => { released = resolve; });
      relay.onRelease = () => released();
      relay.row = { installId: "desk", generation: 2, handoverFrom: "laptop", releasedThroughMs: null };
      onLaptop.hosts.learned("ws", relay.row);
      await release;
      // dohc closes while the relay has not answered the read.
      let reading: () => void = () => undefined;
      const read = new Promise<void>((resolve) => { reading = resolve; });
      relay.onReachRead = () => new Promise<never>(() => reading());
      onDesk.hosts.learned("ws", relay.row);
      await read;
      expect((await desk.baseStore.readReachVerdicts()).pending).toBe(3);

      // The process ends there, so nothing settles. The owner takes the
      // automations back on the laptop.
      relay.onReachRead = undefined;
      relay.row = { installId: "laptop", generation: 4, handoverFrom: null, releasedThroughMs: null };
      const reopened = ownersComputer("desk", desk, relay, { rootPath: "", remote: {} });
      await reopened.executor.open();
      expect(await spendStep(reopened.executor)).toMatchObject({ verdict: "held", stoppedFor: null });
      expect((await desk.baseStore.readReachVerdicts()).pending).toBeNull();
    });
  });

  describe("when the workspace stays open without a relay answer", () => {
    const untilAborted = (signal: AbortSignal) =>
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    // This bound fails a blocked job; the relay's own limit is 15 s.
    const promptly = async (work: Promise<unknown>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([work, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("The job waited for the relay.")), 10_000);
        })]);
      } finally {
        clearTimeout(timer);
      }
    };
    const kinds = ["reach verdicts", "Group handover"] as const;
    type ReadKind = typeof kinds[number];
    const relayFor = (kind: ReadKind, read: (generation: number, signal: AbortSignal) => Promise<void>): Partial<CollectionAutomationsOptions> =>
      kind === "reach verdicts" ? {
        reachRelayRecord: async (generation, signal) => {
          await read(generation, signal);
          return { generation, reach: null, everShared: false };
        },
      } : {
        groupRelayRecord: async (generation, signal) => {
          await read(generation, signal);
          return { generation, handover: null };
        },
      };
    const unanswered = (failFirst = true) => {
      const asked: number[] = [];
      const signals: AbortSignal[] = [];
      const reading = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<void>();
      const read = async (generation: number, signal: AbortSignal) => {
        asked.push(generation);
        signals.push(signal);
        if (failFirst && asked.length === 1) throw new TypeError("fetch failed");
        reading.resolve();
        await Promise.race([answer.promise, untilAborted(signal)]);
        if (signal.aborted) throw signal.reason;
      };
      return { asked, signals, reading: reading.promise, answer: () => answer.resolve(), read };
    };
    const rosterProblem = { kind: "unchecked", next: "Try again later." } as const;
    async function openingAt3(relay: Partial<CollectionAutomationsOptions>, beforeSave?: (reach: Parameters<AutomationRunStore["saveReachVerdicts"]>[0]) => void) {
      const bump = [
        "  - id: bump",
        "    name: Bump",
        "    when: {field-changed: Status}",
        "    do: [{set: {Count: '=record.Count + 1'}}]",
      ].join("\n");
      const w = await world({ channels: [TRIP], automations: { Tasks: `${task}\n${bump}` } });
      const changes: string[] = [];
      const { subscribeAutomation, unsubscribeAutomation, watchAutomationGroups, releaseAutomationGroups } = w.engine;
      w.engine.subscribeAutomation = async (input) => { changes.push("subscribe"); return await subscribeAutomation(input); };
      w.engine.unsubscribeAutomation = async (input) => { changes.push("unsubscribe"); return await unsubscribeAutomation(input); };
      w.engine.watchAutomationGroups = async (input) => { changes.push("watch Groups"); return await watchAutomationGroups(input); };
      w.engine.releaseAutomationGroups = async () => { changes.push("release Groups"); return await releaseAutomationGroups(); };
      const executor = w.makeExecutor({
        groupHost: async () => 3,
        cachedRoster: async () => ({ kind: "unknown", problem: rosterProblem }),
        reachRelayRecord: async (generation) => ({ generation, reach: null, everShared: false }),
        ...relay,
        store: {
          ...w.baseStore,
          saveSubscriptions: async (saved) => { changes.push("save subscriptions"); await w.baseStore.saveSubscriptions(saved); },
          saveReachVerdicts: async (reach) => { changes.push("save verdicts"); beforeSave?.(reach); await w.baseStore.saveReachVerdicts(reach); },
        },
      });
      onTestFinished(() => executor.dispose());
      const opening = executor.open();
      return { w, executor, changes, opening };
    }

    it.each(kinds)("waits once for %s until the next sync answer", async (kind) => {
      const relay = unanswered();
      const { w, executor, changes, opening } = await openingAt3(relayFor(kind, relay.read));
      await opening;
      const before = changes.length;
      const saved = await w.baseStore.readReachVerdicts();
      executor.hostChanged();
      await promptly(Promise.all([executor.resyncFileObservation(), executor.resyncFileObservation(), executor.open()]));
      expect(relay.asked).toEqual([3]);
      expect(w.errors.map(({ context }) => context)).toEqual([
        kind === "reach verdicts" ? "read the last automation host's reach verdicts" : "read the Group handover",
      ]);
      expect(await w.baseStore.readReachVerdicts()).toEqual(saved);
      expect(changes.slice(before)).toEqual([]);

      const beforeAnswer = changes.length;
      executor.relayAnswered();
      await promptly(relay.reading);
      expect(relay.asked).toEqual([3, 3]);
      expect(changes.slice(beforeAnswer).filter((change) => change !== "watch Groups")).toEqual([]);
      await executor.dispose();
      expect(w.errors).toHaveLength(1);
    });

  });

  describe("when the workspace closes during a relay read", () => {
    const watched = { automationId: "collection:Tasks#task", groupId: "trip", startsWith: "/task" };
    // A relay that took the request and never answers: only the close ends it.
    // Without a signal, as on main, it never ends.
    const untilAborted = (signal: AbortSignal | undefined) =>
      new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    // Fails unless the close ends within 10 s. The relay requests' own limit is 15 s.
    const promptly = async (closing: Promise<void>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([closing, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("The close waited for the relay.")), 10_000);
        })]);
      } finally {
        clearTimeout(timer);
      }
    };
    // The engine watches Trip from the last session. This computer opens as
    // the host at generation 3, and `relay` answers its reads.
    async function hostAt3(relay: Partial<CollectionAutomationsOptions>) {
      const w = await world({ channels: [TRIP], automations: { Tasks: task } });
      w.subscriptions.set(watched.automationId, watched);
      await w.baseStore.saveSubscriptions([watched]);
      // Every change to the engine's subscriptions or the saved state.
      const changes: string[] = [];
      const { subscribeAutomation, unsubscribeAutomation, watchAutomationGroups, releaseAutomationGroups } = w.engine;
      w.engine.subscribeAutomation = async (input) => { changes.push("subscribe"); return await subscribeAutomation(input); };
      w.engine.unsubscribeAutomation = async (input) => { changes.push("unsubscribe"); return await unsubscribeAutomation(input); };
      w.engine.watchAutomationGroups = async (input) => { changes.push("watch Groups"); return await watchAutomationGroups(input); };
      w.engine.releaseAutomationGroups = async () => { changes.push("release Groups"); return await releaseAutomationGroups(); };
      const executor = w.makeExecutor({
        groupHost: async () => 3,
        reachRelayRecord: async () => ({ generation: 3, reach: null, everShared: false }),
        ...relay,
        store: {
          ...w.baseStore,
          saveSubscriptions: async (saved) => { changes.push("save subscriptions"); await w.baseStore.saveSubscriptions(saved); },
          saveReachVerdicts: async (reach) => { changes.push("save verdicts"); await w.baseStore.saveReachVerdicts(reach); },
        },
      });
      const opening = executor.open();
      return { w, executor, changes, opening };
    }

    // The close aborts the read, ends at once, and leaves the subscriptions
    // and verdicts as the read found them, with nothing reported. `answer`
    // lets the read answer just as the close starts.
    async function closeDuringRead(opened: Awaited<ReturnType<typeof hostAt3>>, reading: Promise<void>, answer?: () => void) {
      const { w, executor, changes } = opened;
      await reading;
      const before = changes.length;
      const saved = await w.baseStore.readReachVerdicts();
      answer?.();
      await promptly(executor.dispose());
      expect(changes.slice(before)).toEqual([]);
      expect(subscribed(w), "the engine still watches Trip").toBe(true);
      expect(await w.baseStore.readSubscriptions()).toEqual([watched]);
      expect(await w.baseStore.readReachVerdicts()).toEqual(saved);
      expect(w.errors).toEqual([]);
      return saved;
    }

    it("stops the reach verdicts read, then reads again at the next open", async () => {
      const reading = Promise.withResolvers<void>();
      const first = await hostAt3({
        reachRelayRecord: async (_generation, signal) => {
          reading.resolve();
          await untilAborted(signal);
          throw signal.reason;
        },
      });
      const saved = await closeDuringRead(first, reading.promise);
      expect(saved, "the claims mark from before the read").toMatchObject({ pending: 3, taken: null, hostRecord: 0 });

      // The next start holds its claims until the read answers.
      const { w } = first;
      const asked: number[] = [];
      const answer = Promise.withResolvers<void>();
      const asking = Promise.withResolvers<void>();
      const claim = messageClaim(w);
      const again = w.makeExecutor({
        groupHost: async () => 3,
        reachRelayRecord: async (generation) => {
          asked.push(generation);
          asking.resolve();
          await answer.promise;
          return { generation: 3, reach: null, everShared: false };
        },
      });
      void again.open();
      await asking.promise;
      expect(asked).toEqual([3]);
      expect(claim.state).toBe("pending");
      answer.resolve();
      await w.settledClaim(claim);
      expect(claim.state).toBe("done");
      expect(await w.baseStore.readReachVerdicts()).toMatchObject({ pending: null, taken: 3, hostRecord: 3 });
      await again.dispose();
    });

    // A relay that answers just as the workspace closes, too late to take.

  });

  describe("when a Collection moves", () => {
    // Waits until the index reads the Collection at its new path.
    const movedTo = async (w: Awaited<ReturnType<typeof world>>, automationId: string, path: string) =>
      await w.until(() => (w.subscriptions.get(automationId) as { path?: string } | undefined)?.path === path);

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
        ["collection.yaml", "automations.yaml"].map((name) => ({ operation: "update" as const, path: `${folder}/${name}` }))));
      await w.until(() => w.subscriptions.has("collection:object-new-tasks#bump") && w.subscriptions.has("collection:object-copy#bump"));
      expect(await w.executor.automationsIn("Tasks")).toMatchObject({ automations: [{ automationId: "collection:object-new-tasks#bump" }] });
      expect((await w.executor.runs("collection:object-new-tasks#bump")).runs).toEqual([]);
      expect((await w.executor.runs("collection:object-copy#bump")).runs).toEqual([]);
      expect(((await w.executor.runs(TASKS)).runs).map((run) => run.claimId)).toEqual([claim.claimId]);
    });

    it.each(["write", "admission"] as const)("reports a moved Collection at the %s boundary", async boundary => {
      const reached = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let armed = false, paused = false;
      const pause = async () => {
        if (!armed || paused) return;
        paused = true; reached.resolve(); await resume.promise;
      };
      const w = await world({ automations: { Tasks: "  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do: [{set: {Paid by: '=person.id'}}]\n" },
        withRecordWrites: boundary === "write" ? pause : undefined });
      const invoice = w.addRecord("Tasks", "invoice", {});
      let hash = "";
      const authority = () => ({ workspaceId: "workspace", userId: "user-ana", grantId: "g-ana", grantGeneration: 1, hostGeneration: 1,
        principals: [], confirmed: [], automationId: "collection:Tasks#paid", collectionPath: "Tasks", definitionHash: hash, recordId: invoice.id });
      const executor = w.makeExecutor({
        resolveRelayedPress: async () => authority(),
        roster: async () => OWNER,
        groupHost: async () => { if (boundary === "admission") await pause(); return 0; },
      });
      onTestFinished(async () => { resume.resolve(); await executor.dispose(); });
      await executor.open();
      hash = await hashOf(executor, "Tasks", "paid");
      armed = true;
      const pressing = executor.pressRelayed({ automationId: "collection:Tasks#paid", collectionPath: "Tasks", definitionHash: hash,
        recordId: invoice.id, pressId: "boundary", pressedBy: "user-ana", confirmed: [] }, () => undefined);
      // Admission failures are observed immediately, including before the barrier resumes.
      const answered = pressing.then(value => ({ value }), error => ({ error }));
      await reached.promise;
      await w.renameCollection("Tasks", "Shared/Tasks", false);
      executor.handleWatcherEvents(["collection.yaml", "automations.yaml"].flatMap(name => [
        { operation: "delete" as const, path: `Tasks/${name}` },
        { operation: "update" as const, path: `Shared/Tasks/${name}` },
      ]));
      await executor.automationsIn("Shared/Tasks");
      resume.resolve();
      const answer = await answered;
      const moved = "This Collection moved after the button was pressed. Press it again.";
      if (boundary === "admission") {
        expect(answer).toEqual({ error: new Error(moved) });
      } else {
        if ("error" in answer) throw answer.error;
        if (answer.value.pressed.busy) throw new Error("Expected a claim");
        const claim = await w.settledClaim(w.claims.get(answer.value.pressed.claimId)!);
        expect(claim).toMatchObject({ state: "failed", error: moved });
      }
      expect(w.fieldsOf(invoice)).toEqual({});
      expect(w.journaled).toEqual([]);
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
    expect(claim).toMatchObject({ state: "failed", error: "The code in step 1 changes records. This automation cannot use the requested Collection or fields." });
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

it.each(["before receipts"])("replays shared Undo batches after a crash %s", async boundary => {
  const w = await world({collections: ["Tasks", "Log"], automations: {Tasks: BUMP}});
  const records = Array.from({length: 101}, (_, i) => w.addRecord("Tasks", `shared-${i}`, {Count: 2}));
  const claim = w.claim(TASKS, records[0]!); claim.state = "done";
  let fail = true, applied = 0;
  const completed = new Map<string, {replaced: Record<string, never>; kept: Record<string, never>; sharedFileUpdates: Record<string, {
    outboxId: string; appendKey: string; nativeHeadSequence: number; binding: {workspaceId: string; mainVersionId: string; objectId: string; lineageClaimId: string; currentPath: string; selectorPaths: string[]; restoreFenceGeneration: number};
  }>} >();
  const batches: number[] = [], events: string[] = [];
  w.engine.makeAutomationWritesDurable = async () => {events.push("barrier"); if (fail && boundary === "before barrier") throw Error("crash");};
  w.engine.sharedFileUpdateStates = async writes => writes.map(() => "pending");
  const executor = w.makeExecutor({store: {...w.baseStore, recordUndoWrites: async (run, writes) => {
    if (fail) throw Error("crash");
    events.push("receipts"); batches.push(writes.length); await w.baseStore.recordUndoWrites(run, writes);
  }}, withUndoWrites: async (_signal, work) => work({create: async () => {throw Error("unused");}, setFields: async input => {
    const key = input.idempotencyKeyPrefix!;
    const prior = completed.get(key); if (prior) return prior;
    const record = records.find(r => r.path === input.recordPath)!;
    const result = {replaced: {}, kept: {}, sharedFileUpdates: {Count: {outboxId: record.id, appendKey: key, nativeHeadSequence: 2,
      binding: {workspaceId: "workspace", mainVersionId: "main", objectId: record.id, lineageClaimId: "a".repeat(64), currentPath: record.path, selectorPaths: ["Tasks"], restoreFenceGeneration: 0}}}};
    completed.set(key, result); applied++; return result;
  }})});
  onTestFinished(() => executor.dispose()); await executor.open(); await executor.idle();
  const listed = await executor.automationsIn("Tasks");
  if (listed.status !== "read" || !listed.automations[0]?.valid) throw Error("No definition");
  const run = newRun(claim, listed.automations[0].automation, "shared-batch-crash", Date.now());
  run.outcome = {state: "done"}; run.settled = true;
  run.applied = records.map(r => ({ordinal: 0, writes: [{kind: "field", recordId: r.id, path: r.path, field: "Count", before: 1, after: 2}]}));
  run.steps = [{ordinal: 0, effects: records.map(r => ({kind: "set", target: {recordId: r.id, path: r.path, collectionPath: "Tasks"}, fields: [{field: "Count", before: 1, after: 2}]}))}];
  run.durableEffects = run.applied.length; await w.baseStore.save(run);
  const input = {automationId: TASKS, claimId: claim.claimId, deletes: null};
  await expect(executor.undo(input, async () => {})).rejects.toThrow("crash");
  expect(applied).toBe(100); expect(batches).toEqual([]);
  expect((await w.baseStore.runsOf(TASKS, claim.claimId)).runs[0]?.undoWrites ?? []).toEqual([]);
  fail = false; events.length = 0;
  expect(await executor.undo(input, async () => {})).toMatchObject({status: "undone"});
  expect(applied).toBe(101); expect(batches).toEqual([100, 1]);
  expect(events).toEqual(["barrier", "receipts", "barrier", "receipts"]);
  expect((await w.baseStore.runsOf(TASKS, claim.claimId)).runs[0]?.undoWrites).toHaveLength(101);
});

it.skipIf(!process.env.DOHC_UNDO_BENCHMARK)("measures production Undo of 2000 records", async () => {
  const w = await world({collections: ["Tasks", "Log"], automations: {Tasks: BUMP}});
  await w.executor.open();
  await w.executor.idle();
  const listed = await w.executor.automationsIn("Tasks");
  if (listed.status !== "read") throw new Error("No definitions");
  const entry = listed.automations.find(item => item.valid);
  if (!entry?.valid) throw new Error("No definition");
  const records = Array.from({length: 2000}, (_, index) => w.addRecord("Tasks", `bench-${index}`, {Count: 2}));
  const claim = w.claim(TASKS, records[0]!);
  claim.state = "done";
  const run = newRun(claim, entry.automation, "benchmark-1", Date.now());
  run.outcome = {state: "done"}; run.finishedAtMs = Date.now(); run.settled = true;
  run.steps = [{ordinal: 0, effects: records.map(record => ({kind: "set", target: {recordId: record.id,
    path: record.path, collectionPath: "Tasks"}, fields: [{field: "Count", before: 1, after: 2}]}))}];
  run.applied = [{ordinal: 0, writes: records.map(record => ({kind: "field", recordId: record.id,
    path: record.path, field: "Count", before: 1, after: 2}))}];
  const store = createAutomationRunStore(preparedAutomationStoreFolder(w.root));
  await store.save(run);
  const start = performance.now();
  const result = await w.executor.undo({automationId: TASKS, claimId: claim.claimId, deletes: null}, async () => {});
  const milliseconds = performance.now() - start;
  await writeFile(process.env.DOHC_UNDO_BENCHMARK!, JSON.stringify({benchmark: "production-undo-2000", milliseconds, journaled: w.journaled.length, result}));
  console.log(JSON.stringify({benchmark: "production-undo-2000", milliseconds, result}));
  expect(result).toMatchObject({status: "undone", reverted: 2000});
  expect(records.every(record => w.fieldsOf(record).Count === 1)).toBe(true);
  console.log(JSON.stringify({benchmark: "production-undo-2000", milliseconds, journaled: w.journaled.length}));
  await w.executor.close();
}, 180_000);

it("automation usage follows the local record off switch without stopping the run", async () => {
  const w = await world({ collections: ["Tasks", "Log"], automations: { Tasks: BUMP } });
  const store = createUsageStore({ stateDir: () => join(w.root, "local-state"), appVersion: "0.1.0", coverage: DESKTOP_USAGE_COVERAGE });
  await store.load();
  const observed: Array<{ capabilityId: string; door: string }> = [];
  const executor = w.makeExecutor({ onUsageSuccess: pair => { observed.push(pair); store.recordSuccess(pair); } });
  try {
    await store.setEnabled(false);
    await executor.open();
    const first = w.claim(TASKS, w.addRecord("Tasks", "Off", { Count: 0 }));
    executor.notifyClaimed();
    await w.settledClaim(first);
    expect(first.state).toBe("done");
    expect(observed).toEqual([
      { capabilityId: "collection.record.edit", door: "automation" },
      { capabilityId: "collection.record.create", door: "automation" },
    ]);
    expect((await store.read()).counts).toEqual([]);
    await store.setEnabled(true);
    const next = w.claim(TASKS, w.addRecord("Tasks", "On", { Count: 0 }));
    executor.notifyClaimed();
    await w.settledClaim(next);
    expect(next.state).toBe("done");
    expect((await store.read()).counts.map(({ capabilityId, door, count }) => ({ capabilityId, door, count })))
      .toEqual(expect.arrayContaining([
        { capabilityId: "collection.record.edit", door: "automation", count: 1 },
        { capabilityId: "collection.record.create", door: "automation", count: 1 },
      ]));
  } finally { await executor.dispose(); await store.close(); }
});
