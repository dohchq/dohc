import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import type { ChangeAttributionWire } from "@dohc/workspace-engine-client";
import { VersionedTextStoreError } from "@dohc/workspace-contracts/engine";
import {
  AutomationCreationCommitted,
  AutomationCreationSkipped,
  actorOriginIdFor,
  attributionFor,
  createCollectionRecord,
  runCollectionRecordCreation,
  collectionRecordWrites,
  setCollectionRecordFields,
  type CollectionRecordEditContext,
  type RecordEditSession,
} from "./collectionRecordEdits";
import { DaemonRefusalError, YdocOwnerDraftPendingError } from "@dohc/workspace-engine-client";
import { derivedRecordId } from "./recordIds";
import { createTestScratch } from "./testScratch";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { newRun } from "./collectionAutomationRun";
import { undoCollectionAutomationRuns, type CollectionAutomationUndoDependencies } from "./collectionAutomationUndo";

const AGENT = {
  kind: "agent",
  agentId: "notes-agent",
  onBehalfOf: "local",
  depth: 0,
} as const;

const AUTOMATION = {
  kind: "automation",
  automationId: "collection:tasks#finished-date",
  onBehalfOf: "local",
  depth: 1,
  run: { claimId: "claim-7", automationName: "Stamp the finish date" },
} as const;

it("uses the engine journal to skip an Undo field after a crash and another Undo", async () => {
  const root = await createTestScratch("dohc-undo-journal-");
  const {session, log} = fakeSession();
  const context = contextFor(root, session);
  const key = "automation-undo/test-run";
  log.doc.getMap("frontmatter").set("status", "done");
  const input = {recordPath: "tasks/one.md", fields: {status: "todo"}, expectedBefore: {status: "done"},
    author: {kind: "user", userId: "owner"} as const, idempotencyKeyPrefix: key, preserveCompletedFields: true};
  const fail = vi.spyOn(session, "settleNow").mockRejectedValueOnce(new Error("Interrupted after journal"));
  await expect(setCollectionRecordFields(context, input)).rejects.toThrow("Interrupted after journal");
  expect(log.doc.getMap("frontmatter").get("status")).toBe("todo");
  log.doc.getMap("frontmatter").set("status", "done");
  await expect(setCollectionRecordFields(context, input)).resolves.toMatchObject({replaced: {}, kept: {}});
  expect(log.doc.getMap("frontmatter").get("status")).toBe("done");
  expect(log.journaled).toHaveLength(1);
  fail.mockRestore();
});

it("recovers Undo receipts through production record writes after receipt persistence fails", async () => {
  const root = await createTestScratch("dohc-undo-production-receipt-");
  const draft = {outboxId: "outbox", nativeHeadSequence: 3, relayDatabaseNamespace: "relay", revision: 1,
    acceptedCursor: 2, nativeUnsettled: false, pendingBytes: 10, state: "active" as const,
    binding: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
      currentPath: "tasks/one.md", selectorPaths: ["tasks"], restoreFenceGeneration: 4}};
  const {session, log} = fakeSession({settleError: new YdocOwnerDraftPendingError(draft)});
  log.doc.getMap("frontmatter").set("status", "done");
  const writes = collectionRecordWrites(contextFor(root, session, {withAdapter: async work => work({
    getCollectionRecord: async () => {throw Error("Not used");}, sharedFileUpdateStates: async candidates => candidates.map(() => "pending"),
  })}));
  const parsed = parseAutomationsFile("version: 1\nautomations:\n  - id: finish\n    name: Finish\n    when: record-added\n    do: [{set: {status: done}}]");
  if(parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw Error("No definition");
  const run = {...newRun({automationId: "collection:tasks#finish", claimId: "claim"}, parsed.entries[0].automation, "hash-1", 1),
    undo: "started" as const, undoScope: "production-receipt", applied: [{ordinal: 0, writes: [{kind: "field" as const,
      recordId: "record", path: "tasks/one.md", field: "status", before: "todo", after: "done"}]}]};
  let failed = false;
  const dependencies: CollectionAutomationUndoDependencies = {
    withRecordWrites: async (_signal, work) => work(writes), collectionPathOf: () => "tasks", trash: async () => {},
    withReads: async work => work({getCollectionRecord: async () => ({collection: {path: "tasks", objectId: "tasks", status: "valid", reasons: []},
      record: {id: "record", path: "tasks/one.md", conflicted: false, values: []}, history: [], nextBeforeHistoryId: null}),
      queryCollectionRecords: async () => {throw Error("Not used");}}),
    recordReversal: async () => {if(!failed) {failed = true; throw Error("Receipt save failed");}},
  };
  await expect(undoCollectionAutomationRuns(dependencies, [run], new AbortController().signal)).rejects.toThrow("Receipt save failed");
  const retry = await undoCollectionAutomationRuns(dependencies, [run], new AbortController().signal);
  expect(retry.undoWrites).toMatchObject([{field: "status", draft: {appendKey: expect.stringMatching(/^automation-undo\//)}}]);
  expect(retry.undoWrites[0]!.draft.appendKey).toBe(log.journaled[0]!.idempotencyKey);
  expect(log.journaled).toHaveLength(1);
});

it("keeps Undo unfinished until an unchanged shared receipt can be checked", async () => {
  const root = await createTestScratch("dohc-undo-receipt-status-");
  const draft = {outboxId: "outbox", nativeHeadSequence: 3, relayDatabaseNamespace: "relay", revision: 1,
    acceptedCursor: 2, nativeUnsettled: false, pendingBytes: 10, state: "active" as const,
    binding: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
      currentPath: "tasks/one.md", selectorPaths: ["tasks"], restoreFenceGeneration: 4}};
  const {session, log} = fakeSession({settleError: new YdocOwnerDraftPendingError(draft)});
  log.doc.getMap("frontmatter").set("status", "done");
  let unavailable = false;
  const context = contextFor(root, session, {withAdapter: async work => work({
    getCollectionRecord: async () => {throw Error("Not used");}, sharedFileUpdateStates: async writes => {
      if(unavailable) throw Error("Status lookup overloaded");
      return writes.map(() => "pending");
    },
  })});
  const input = {recordPath: "tasks/one.md", fields: {status: "todo"}, expectedBefore: {status: "done"},
    author: {kind: "user", userId: "owner"} as const, idempotencyKeyPrefix: "automation-undo/status",
    preserveCompletedFields: true};
  const writes = collectionRecordWrites(context);
  const written = await writes.setFields(input);
  unavailable = true;
  await expect(writes.setFields(input)).rejects.toThrow("dohc could not check this run's shared reversals.");
  unavailable = false;
  expect((await writes.setFields(input)).sharedFileUpdates).toEqual(written.sharedFileUpdates);
  expect(log.journaled).toHaveLength(1);
});

it.each(["write-refused", "conflict-stale-target", "Saved locally. The shared file update is pending."])("does not accept other settlement errors as a completed automation effect (%s)", async message => {
  const root = await createTestScratch("dohc-automation-settle-refusal-");
  const error = new Error(message);
  error.name = "YdocOwnerDraftPendingError";
  const {session} = fakeSession({settleError: error});
  await expect(collectionRecordWrites(contextFor(root, session)).setFields({recordPath: "tasks/one.md", fields: {status: "done"}, author: AUTOMATION})).rejects.toBe(error);
});

it("records each field's append key when automation settlement is pending, including a resumed write", async () => {
  const root = await createTestScratch("dohc-automation-draft-identity-");
  const draft = {outboxId: "outbox", nativeHeadSequence: 3, relayDatabaseNamespace: "relay", revision: 1,
    acceptedCursor: 2, nativeUnsettled: false, pendingBytes: 10, state: "active" as const,
    binding: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
      currentPath: "tasks/one.md", selectorPaths: ["tasks"], restoreFenceGeneration: 4}};
  const {session, log} = fakeSession({settleError: new YdocOwnerDraftPendingError(draft)});
  const context = contextFor(root, session, {withAdapter: async work => work({
    getCollectionRecord: async () => {throw new Error("Not used");},
    sharedFileUpdateStates: async writes => writes.map(write => log.journaled.some(entry => entry.idempotencyKey === write.appendKey) ? "pending" : "absent"),
  })});
  const result = await collectionRecordWrites(context).setFields({
    recordPath: "tasks/one.md", fields: {status: "done", note: "saved"}, author: AUTOMATION, idempotencyKeyPrefix: "write",
  });
  const update = {outboxId: "outbox", binding: draft.binding, nativeHeadSequence: 3};
  expect(result.sharedFileUpdates).toEqual({status: {...update, appendKey: "write/status"}, note: {...update, appendKey: "write/note"}});
  expect(log.journaled.map(write => write.idempotencyKey)).toEqual(["write/status", "write/note"]);
  const resumed = await collectionRecordWrites(context).setFields({
    recordPath: "tasks/one.md", fields: {status: "done", note: "saved"}, author: AUTOMATION, idempotencyKeyPrefix: "write",
  });
  expect(resumed.sharedFileUpdates).toEqual(result.sharedFileUpdates);
  expect(log.journaled).toHaveLength(2);
  log.doc.getMap("frontmatter").set("status", "todo");
  const handReverted = await collectionRecordWrites(context).setFields({
    recordPath: "tasks/one.md", fields: {status: "todo", note: null}, expectedBefore: {status: "done", note: "saved"},
    author: AUTOMATION, idempotencyKeyPrefix: "undo",
  });
  expect(handReverted.sharedFileUpdates).toEqual({note: {...update, appendKey: "undo/note"}});
  expect(log.journaled.map(entry => entry.idempotencyKey)).not.toContain("undo/status");
  const neverLanded = await collectionRecordWrites(context).setFields({
    recordPath: "tasks/one.md", fields: {status: "todo"}, author: AUTOMATION, idempotencyKeyPrefix: "never-landed",
  });
  expect(neverLanded.sharedFileUpdates).toEqual({});
});

it.each(["write", "undo"])("keeps a journaled %s when an unchanged field's status read is overloaded", async prefix => {
  const root = await createTestScratch("dohc-automation-status-overloaded-");
  const draft = {outboxId: "outbox", nativeHeadSequence: 3, relayDatabaseNamespace: "relay", revision: 1,
    acceptedCursor: 2, nativeUnsettled: false, pendingBytes: 10, state: "active" as const,
    binding: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
      currentPath: "tasks/one.md", selectorPaths: ["tasks"], restoreFenceGeneration: 4}};
  const {session, log} = fakeSession({settleError: new YdocOwnerDraftPendingError(draft)});
  log.doc.getMap("frontmatter").set("status", "done");
  const read = vi.fn(async () => {
    throw new DaemonRefusalError({code: "OVERLOADED", message: "Overloaded", retry: "afterBackoff"}, undefined);
  });
  const context = contextFor(root, session, {withAdapter: async work => work({
    getCollectionRecord: async () => {throw new Error("Not used");}, sharedFileUpdateStates: read,
  })});
  const result = await collectionRecordWrites(context).setFields({
    recordPath: "tasks/one.md", fields: {status: "done", note: "saved"}, author: AUTOMATION,
    idempotencyKeyPrefix: prefix,
    ...(prefix === "undo" ? {expectedBefore: {status: "done", note: null}} : {}),
  });
  expect(result.sharedFileUpdates).toEqual({note: {
    outboxId: draft.outboxId, binding: draft.binding, nativeHeadSequence: draft.nativeHeadSequence, appendKey: `${prefix}/note`,
  }});
  expect(read).toHaveBeenCalledOnce();
  expect(log.journaled.map(write => write.idempotencyKey)).toEqual([`${prefix}/note`]);
  expect(log.doc.getMap("frontmatter").get("note")).toBe("saved");
  expect(log.order.at(-1)).toBe("close");
});

interface FakeSessionLog {
  doc: Y.Doc;
  order: string[];
  journaled: Array<{
    actorOriginId?: string;
    attribution?: ChangeAttributionWire;
    idempotencyKey?: string;
  }>;
  updates: Uint8Array[];
}

function fakeSession(options: {
  journaledKeys?: Map<string, string>;
  settleError?: Error;
  onSettle?: () => Promise<void>;
  /** Runs just before each update's turn on the session chain, as a remote update would land. */
  beforeTurn?: (doc: Y.Doc) => void;
} = {}): {
  session: RecordEditSession;
  log: FakeSessionLog;
} {
  const doc = new Y.Doc();
  const log: FakeSessionLog = { doc, order: [], journaled: [], updates: [] };
  // The engine's rule (durable.rs): a key already journaled with other
  // update bytes refuses, so a re-run that reuses a key with a new update fails.
  const journaledKeys = options.journaledKeys ?? new Map<string, string>();
  // Local updates take turns on one chain, as the real session's do.
  let chain: Promise<unknown> = Promise.resolve();
  const session = {
    doc,
    get initialUpdate() {
      return Y.encodeStateAsUpdate(doc);
    },
    applyDecidedLocalUpdate(
      decide: (current: Y.Doc) => Uint8Array | null,
      onArmed?: () => void,
      applyOptions?: { actorOriginId?: string; attribution?: ChangeAttributionWire; idempotencyKey?: string },
    ): Promise<boolean> {
      const turn = chain.then(() => {
        options.beforeTurn?.(doc);
        const update = decide(doc);
        if (update === null) return false;
        session.applyLocalUpdate(update, onArmed, applyOptions);
        return true;
      });
      chain = turn.catch(() => undefined);
      return turn;
    },
    applyLocalUpdate(
      update: Uint8Array,
      onArmed?: () => void,
      applyOptions?: {
        actorOriginId?: string;
        attribution?: ChangeAttributionWire;
        idempotencyKey?: string;
      },
    ) {
      const key = applyOptions?.idempotencyKey;
      const bytes = Buffer.from(update).toString("base64");
      if (key !== undefined && journaledKeys.has(key)) {
        if (journaledKeys.get(key) !== bytes) {
          onArmed?.();
          throw new DaemonRefusalError({ code: "INVALID_PARAMS", message: "idempotency-key-reuse-mismatch", retry: "no" }, undefined);
        }
        return;
      }
      if (key !== undefined) journaledKeys.set(key, bytes);
      // The real session journals the update and applies it to its doc.
      Y.applyUpdate(doc, update);
      log.order.push("apply");
      log.journaled.push({ ...applyOptions });
      log.updates.push(update);
      onArmed?.();
    },
    async settleNow() {
      await chain;
      log.order.push("settle");
      if (options.settleError) throw options.settleError;
      await options.onSettle?.();
      return { materialized: true };
    },
    async close() {
      log.order.push("close");
    },
  };
  return { session, log };
}

/** A host over files in `root`: it records each session opened and each file created, with its author. */
function contextFor(
  root: string,
  session: RecordEditSession,
  overrides: Partial<CollectionRecordEditContext> = {},
): CollectionRecordEditContext & { openedPaths: string[]; createdFiles: Array<{ path: string; author: unknown }> } {
  const openedPaths: string[] = [];
  const createdFiles: Array<{ path: string; author: unknown }> = [];
  return {
    openedPaths,
    createdFiles,
    async openRecord(path) {
      openedPaths.push(path);
      return session;
    },
    async createFile(path, text, author) {
      createdFiles.push({ path, author });
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), text, { flag: "wx" });
      return path;
    },
    async readText(path) {
      return { text: await readFile(join(root, path), "utf8"), truncated: false };
    },
    withAdapter: async () => null,
    onRecordsChanged: () => () => undefined,
    signal: new AbortController().signal,
    ...overrides,
  };
}

it("rejects an unkeyed field write when the session declines the decided update", async () => {
  const root = await createTestScratch("dohc-record-declined-");
  const { session, log } = fakeSession();
  vi.spyOn(session, "applyDecidedLocalUpdate").mockImplementationOnce(async decide => {
    decide(log.doc);
    return false;
  });
  await expect(setCollectionRecordFields(contextFor(root, session), {
    recordPath: "tasks/a.md", fields: { status: "done" }, author: AGENT,
  })).rejects.toThrow("did not accept the field change");
  expect(log.order).toEqual(["close"]);
  expect(log.doc.getMap("frontmatter").get("status")).toBeUndefined();
});

it("refuses to set fields on a lossy note before any session opens", async () => {
  const root = await createTestScratch("dohc-record-lossy-");
  const text = "---\nstatus: open\n---\n\n<details>\n<summary>Notes</summary>\n\nHidden.\n</details>\n";
  await mkdir(join(root, "tasks"));
  await writeFile(join(root, "tasks", "a.md"), text);
  const { session, log } = fakeSession();
  const context = contextFor(root, session);
  await expect(setCollectionRecordFields(context, {
    recordPath: "tasks/a.md", fields: { status: "done" }, author: AUTOMATION,
  })).rejects.toThrow(
    "dohc can't change tasks/a.md without also changing parts it can't show, such as raw HTML or reference links. Edit the file directly instead.",
  );
  expect(context.openedPaths).toEqual([]);
  expect(log.order).toEqual([]);
  expect(await readFile(join(root, "tasks", "a.md"), "utf8")).toBe(text);
});

it("refuses a field write when its safety read fails, though a session could open", async () => {
  const { session, log } = fakeSession();
  const context = contextFor(await createTestScratch("dohc-record-unread-"), session, {
    readText: async () => { throw new Error("read refused"); },
  });
  await expect(setCollectionRecordFields(context, {
    recordPath: "tasks/a.md", fields: { status: "done" }, author: AUTOMATION,
  })).rejects.toThrow("dohc couldn't read tasks/a.md to check it, so nothing changed. Try again.");
  expect(context.openedPaths).toEqual([]);
  expect(log.order).toEqual([]);
  expect(log.doc.getMap("frontmatter").get("status")).toBeUndefined();
});

it("refuses a field write when the session holds a lossy note the read did not see", async () => {
  const root = await createTestScratch("dohc-record-replaced-");
  await mkdir(join(root, "tasks"));
  await writeFile(join(root, "tasks", "a.md"), "---\nstatus: open\n---\n\nPlain.\n");
  // The file was replaced after the read: the session's document carries the
  // replacement and its witness, as a seed of that file does.
  const replacement = "---\nstatus: open\n---\n\n<details>\n<summary>Notes</summary>\n\nHidden.\n</details>\n";
  const lossy = markdownToYDoc(replacement);
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  lossy.getMap("meta").set("dohcMarkdownSource", replacement);
  lossy.getMap("meta").set("dohcMarkdownSourceSha256", sha(replacement));
  lossy.getMap("meta").set("dohcMarkdownSourceProjectionSha256", sha(yDocToMarkdown(lossy)));
  const { session, log } = fakeSession({ beforeTurn: (doc) => Y.applyUpdate(doc, Y.encodeStateAsUpdate(lossy)) });
  const context = contextFor(root, session);
  await expect(setCollectionRecordFields(context, {
    recordPath: "tasks/a.md", fields: { status: "done" }, author: AUTOMATION,
  })).rejects.toThrow(
    "dohc can't change tasks/a.md without also changing parts it can't show, such as raw HTML or reference links. Edit the file directly instead.",
  );
  expect(context.openedPaths).toEqual(["tasks/a.md"]);
  expect(log.journaled).toEqual([]);
  expect(log.order).not.toContain("settle");
  expect(log.doc.getMap("frontmatter").get("status")).toBe("open");
  lossy.destroy();
});

/**
 * The engine side of a create: records it has adopted, keyed by id, and its
 * news of adopted records. A lookup of an id it has not adopted answers the
 * way collections.getRecord does.
 */
function fakeEngine() {
  const records = new Map<string, string>();
  const listeners = new Set<(paths: readonly string[] | null) => void>();
  const waitingForListener: Array<() => void> = [];
  const lookups: string[] = [];
  const waitingForLookups: Array<{ count: number; resolve: () => void }> = [];
  let refusal: Error | null = null;
  const overrides: Partial<CollectionRecordEditContext> = {
    withAdapter: async (work) =>
      await work({
        sharedFileUpdateStates: async writes => writes.map(() => "absent"),
        async getCollectionRecord({ collectionPath, recordId }) {
          lookups.push(recordId);
          for (const waiter of [...waitingForLookups]) {
            if (lookups.length < waiter.count) continue;
            waitingForLookups.splice(waitingForLookups.indexOf(waiter), 1);
            waiter.resolve();
          }
          if (refusal) throw refusal;
          const path = records.get(recordId);
          if (path === undefined) throw new Error("collection-record-not-found");
          return {
            collection: { path: collectionPath, objectId: "object-test", status: "valid", reasons: [] },
            record: { id: recordId, path, conflicted: false, values: [] },
            history: [],
            nextBeforeHistoryId: null,
          };
        },
      }),
    onRecordsChanged: (listener) => {
      listeners.add(listener);
      for (const resolve of waitingForListener.splice(0)) resolve();
      return () => listeners.delete(listener);
    },
  };
  return {
    overrides,
    records,
    lookups,
    listeners,
    /** Resolves once the seam is waiting for an announcement. */
    listening(): Promise<void> {
      if (listeners.size > 0) return Promise.resolve();
      return new Promise((resolve) => waitingForListener.push(resolve));
    },
    /** Resolves once the seam has asked for `count` records. */
    lookupsReached(count: number): Promise<void> {
      if (lookups.length >= count) return Promise.resolve();
      return new Promise((resolve) => waitingForLookups.push({ count, resolve }));
    },
    refuseLookups(error: Error | null) {
      refusal = error;
    },
    announce(paths: readonly string[] | null) {
      for (const listener of [...listeners]) listener(paths);
    },
    /** Adopts the file the seam wrote at `path` under the id in its frontmatter. */
    async adopt(root: string, path: string): Promise<string> {
      const text = await readFile(join(root, path), "utf8");
      const recordId = /^---\nid: (rec_[a-z2-7]{26})\n---\n$/.exec(text)?.[1];
      if (!recordId) throw new Error(`Not a new record file: ${text}`);
      records.set(recordId, path);
      return recordId;
    },
    /**
     * Adopts the file at `path` under a new id, as the engine does when the
     * file's own id belongs to another record now or in history, and writes
     * that id back into the file.
     */
    async adoptUnderNewId(root: string, path: string, recordId: string) {
      await writeFile(join(root, path), `---\nid: ${recordId}\n---\n`);
      records.set(recordId, path);
    },
  };
}

const ADOPTION_TIMEOUT_MESSAGE =
  "The record file was created at tasks/two.md, but the engine did not adopt it as a collection record in time. Look for it in the Collection before you create it again.";

afterEach(() => {
  vi.useRealTimers();
});

describe("setCollectionRecordFields", () => {
  it.each([
    '{status: draft, score: .nan}',
    '&root {status: draft, score: .nan}',
    '!custom &root {status: draft, score: .nan}',
    ': note\nstatus: draft\nscore: .nan',
    'status: &v .nan\nscore: *v',
    'status: &v .nan\nscore: {nested: [*v]}',
  ])("refuses unsafe property candidates before writing the file: %s", async yaml => {
    const root = await createTestScratch("dohc-collection-edits-");
    const file = join(root, "one.md");
    const markdown = `---\n${yaml}\n---\n\nBody`;
    const original = Buffer.from(markdown);
    await writeFile(file, original);
    const { session, log } = fakeSession({
      onSettle: async () => { await writeFile(file, yDocToMarkdown(log.doc)); },
    });
    const imported = markdownToYDoc(markdown);
    try {
      Y.applyUpdate(log.doc, Y.encodeStateAsUpdate(imported));
      const before = Y.encodeStateAsUpdate(log.doc);
      await expect(setCollectionRecordFields(contextFor(root, session), {
        recordPath: "one.md", fields: { status: "done" }, author: AGENT,
      })).rejects.toThrow("without rewriting the others");
      expect(log.order).toEqual(["close"]);
      expect(log.journaled).toEqual([]);
      expect(Y.encodeStateAsUpdate(log.doc)).toEqual(before);
      expect(await readFile(file)).toEqual(original);
    } finally { imported.destroy(); log.doc.destroy(); }
  });

  it("journals each field as its own update with the agent's actor origin, settles once, then releases", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session, log } = fakeSession();
    const context = contextFor(root, session);

    await expect(
      setCollectionRecordFields(context, {
        recordPath: "tasks/one.md",
        fields: { status: "done", estimate: 3 },
        author: AGENT,
      }),
    ).resolves.toEqual({
      path: "tasks/one.md",
      replaced: { status: null, estimate: null },
      kept: {},
    });

    expect(context.openedPaths).toEqual(["tasks/one.md"]);
    // One journaled update per field carrying the agent's origin, then one
    // settle before release.
    expect(log.order).toEqual(["apply", "apply", "settle", "close"]);
    const journaled = {
      actorOriginId: "notes-agent",
      attribution: { actorKind: "agent", onBehalfOf: "local", depth: 0 },
    };
    expect(log.journaled).toEqual([journaled, journaled]);
    const frontmatter = log.doc.getMap("frontmatter");
    expect(frontmatter.get("status")).toBe("done");
    expect(frontmatter.get("estimate")).toBe(3);
  });

  it("records an automation author under its subscription id with its depth, run, and claim key", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session, log } = fakeSession();

    await setCollectionRecordFields(contextFor(root, session), {
      recordPath: "tasks/one.md",
      fields: { status: "done" },
      author: AUTOMATION,
      idempotencyKeyPrefix: "claim-7/1/0",
    });

    // The actor origin IS the engine subscription id, so the engine's
    // self-skip guard binds (lane 2), and the wire key is the claim's.
    expect(log.journaled).toEqual([
      {
        actorOriginId: AUTOMATION.automationId,
        attribution: { actorKind: "automation", onBehalfOf: "local", depth: 1, run: { claimId: "claim-7", automationName: "Stamp the finish date" } },
        idempotencyKey: "claim-7/1/0/status",
      },
    ]);
    expect(actorOriginIdFor(AUTOMATION)).toBe(AUTOMATION.automationId);
  });

  it("writes only the fields that change and returns the values they replaced", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session, log } = fakeSession();
    const frontmatter = log.doc.getMap("frontmatter");
    frontmatter.set("status", "open");
    frontmatter.set("tags", ["a", "b"]);
    frontmatter.set("estimate", 2);
    const before = Y.encodeStateAsUpdate(log.doc);

    await expect(
      setCollectionRecordFields(contextFor(root, session), {
        recordPath: "tasks/one.md",
        fields: { status: "done", tags: ["a", "b"], estimate: 2, owner: "ana" },
        author: AGENT,
      }),
    ).resolves.toEqual({
      path: "tasks/one.md",
      // A field the record did not have reads as null, as record history shows it.
      replaced: { status: "open", owner: null },
      kept: {},
    });

    // The journaled updates touch only the changed fields, one each.
    expect(log.updates).toHaveLength(2);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, before);
    const touched: string[] = [];
    replica.getMap("frontmatter").observe((event) => {
      touched.push(...event.keysChanged);
    });
    for (const update of log.updates) Y.applyUpdate(replica, update);
    expect(touched.sort()).toEqual(["owner", "status"]);
    expect(frontmatter.toJSON()).toEqual({
      status: "done",
      tags: ["a", "b"],
      estimate: 2,
      owner: "ana",
    });
  });

  it("journals and settles nothing when every field already holds its value", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session, log } = fakeSession();
    const frontmatter = log.doc.getMap("frontmatter");
    frontmatter.set("status", "done");
    frontmatter.set("meta", { due: "2026-09-24", points: [1, 2] });

    await expect(
      setCollectionRecordFields(contextFor(root, session), {
        recordPath: "tasks/one.md",
        fields: { meta: { points: [1, 2], due: "2026-09-24" }, status: "done" },
        author: AGENT,
        idempotencyKeyPrefix: "claim-7/1/0",
      }),
    ).resolves.toEqual({ path: "tasks/one.md", replaced: {}, kept: {} });
    expect(log.order).toEqual(["close"]);
  });

  it("compares a nested shared value by its JSON and returns that JSON as the replaced value", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session, log } = fakeSession();
    const frontmatter = log.doc.getMap("frontmatter");
    const tags = new Y.Array<string>();
    tags.push(["a", "b"]);
    frontmatter.set("tags", tags);
    const owner = new Y.Map<string>();
    owner.set("name", "Ana");
    frontmatter.set("owner", owner);
    const context = contextFor(root, session);

    await expect(
      setCollectionRecordFields(context, {
        recordPath: "tasks/one.md",
        fields: { tags: ["a", "b"], owner: { name: "Ana" } },
        author: AGENT,
      }),
    ).resolves.toEqual({ path: "tasks/one.md", replaced: {}, kept: {} });
    await expect(
      setCollectionRecordFields(context, {
        recordPath: "tasks/one.md",
        fields: { tags: ["a"], owner: { name: "Ana" } },
        author: AGENT,
      }),
    ).resolves.toEqual({ path: "tasks/one.md", replaced: { tags: ["a", "b"] }, kept: {} });
    expect(log.order).toEqual(["close", "apply", "settle", "close"]);
  });

  it("treats a requested null on a field the record lacks as no change", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session, log } = fakeSession();
    log.doc.getMap("frontmatter").set("status", "open");

    await expect(
      setCollectionRecordFields(contextFor(root, session), {
        recordPath: "tasks/one.md",
        fields: { due: null, status: null },
        author: AGENT,
      }),
    ).resolves.toEqual({ path: "tasks/one.md", replaced: { status: "open" }, kept: {} });
    expect(log.doc.getMap("frontmatter").toJSON()).toEqual({ status: null });
  });

  it("keeps a field named __proto__ in the replaced values", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session, log } = fakeSession();
    log.doc.getMap("frontmatter").set("__proto__", "old");
    const fields = JSON.parse('{"__proto__": "new"}') as Record<string, unknown>;

    const result = await setCollectionRecordFields(contextFor(root, session), {
      recordPath: "tasks/one.md",
      fields,
      author: AGENT,
    });

    expect(Object.keys(result.replaced)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(result.replaced, "__proto__")?.value).toBe("old");
    expect(log.doc.getMap("frontmatter").get("__proto__")).toBe("new");
  });

  it("writes nothing when its caller ends while the session opens", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session, log } = fakeSession();
    const controller = new AbortController();
    const context = contextFor(root, session, {
      signal: controller.signal,
      async openRecord() {
        // An automation run's deadline passes while the engine opens it.
        controller.abort();
        return session;
      },
    });

    await expect(
      setCollectionRecordFields(context, {
        recordPath: "tasks/one.md",
        fields: { status: "done" },
        author: AUTOMATION,
      }),
    ).rejects.toThrow(/no longer active/);
    expect(log.order).toEqual(["close"]);
  });

  it("re-runs one logical write under a new attempt's key until the record converges", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session, log } = fakeSession();
    const context = contextFor(root, session);
    const attempt = (number: number) =>
      setCollectionRecordFields(context, {
        recordPath: "tasks/one.md",
        fields: { status: "done", finishedOn: "2026-09-24" },
        author: AUTOMATION,
        idempotencyKeyPrefix: `claim-7/${number}/0`,
      });

    await expect(attempt(1)).resolves.toEqual({
      path: "tasks/one.md",
      replaced: { status: null, finishedOn: null },
      kept: {},
    });
    // The run stops before it settles its claim, and someone reopens the
    // task before the engine hands the claim out again.
    log.doc.getMap("frontmatter").set("status", "open");
    await expect(attempt(2)).resolves.toEqual({
      path: "tasks/one.md",
      replaced: { status: "open" },
      kept: {},
    });
    await expect(attempt(3)).resolves.toEqual({
      path: "tasks/one.md",
      replaced: {},
      kept: {},
    });

    expect(log.journaled.map((entry) => entry.idempotencyKey)).toEqual([
      "claim-7/1/0/status",
      "claim-7/1/0/finishedOn",
      "claim-7/2/0/status",
    ]);
    expect(log.doc.getMap("frontmatter").toJSON()).toEqual({
      status: "done",
      finishedOn: "2026-09-24",
    });
  });

  it("writes a field still at its expected value, and keeps one someone changed since", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session, log } = fakeSession();
    const frontmatter = log.doc.getMap("frontmatter");
    // An earlier attempt landed Count; someone then changed Owner by hand.
    frontmatter.set("Count", 3);
    frontmatter.set("Owner", "ana");

    await expect(
      setCollectionRecordFields(contextFor(root, session), {
        recordPath: "tasks/one.md",
        fields: { Count: 3, Owner: "bob", Due: "2026-09-30" },
        author: AUTOMATION,
        idempotencyKeyPrefix: "claim-7/hash/0/rec_one",
        expectedBefore: { Count: 2, Owner: null, Due: null },
      }),
    ).resolves.toEqual({
      path: "tasks/one.md",
      replaced: { Due: null },
      kept: { Owner: "ana" },
    });
    expect(log.journaled.map((entry) => entry.idempotencyKey)).toEqual(["claim-7/hash/0/rec_one/Due"]);
    expect(frontmatter.toJSON()).toEqual({ Count: 3, Owner: "ana", Due: "2026-09-30" });
  });

  it("still rejects reused keys for ordinary field edits", async () => {
    const root = await createTestScratch("dohc-record-key-reuse-");
    const { session, log } = fakeSession();
    const context = contextFor(root, session);
    const input = { recordPath: "tasks/one.md", fields: { status: "open" }, author: AGENT, idempotencyKeyPrefix: "edit" };
    await setCollectionRecordFields(context, input);
    log.doc.getMap("frontmatter").delete("status");
    await expect(setCollectionRecordFields(context, input)).rejects.toThrow("idempotency-key-reuse-mismatch");
    expect(log.doc.getMap("frontmatter").has("status")).toBe(false);
    expect(log.journaled).toHaveLength(1);
  });

  it("compares each field when it is written, so a change that lands after the session opens is kept", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    // Undo's case: put Note back to "old" only while it still holds the run's "new".
    const { session, log } = fakeSession({
      // A remote edit lands after the open and before the field's turn.
      beforeTurn: (doc) => doc.getMap("frontmatter").set("Note", "theirs"),
    });
    log.doc.getMap("frontmatter").set("Note", "new");

    await expect(
      setCollectionRecordFields(contextFor(root, session), {
        recordPath: "tasks/one.md",
        fields: { Note: "old" },
        author: { kind: "user", userId: "local" },
        expectedBefore: { Note: "new" },
      }),
    ).resolves.toEqual({ path: "tasks/one.md", replaced: {}, kept: { Note: "theirs" } });
    expect(log.doc.getMap("frontmatter").get("Note")).toBe("theirs");
    expect(log.order).toEqual(["close"]);
  });

  it("keeps a non-agent author device-attributed, like a human edit", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session, log } = fakeSession();

    await setCollectionRecordFields(contextFor(root, session), {
      recordPath: "tasks/one.md",
      fields: { status: "done" },
      author: { kind: "user", userId: "local" },
    });

    expect(log.journaled).toEqual([
      { attribution: { actorKind: "human" } },
    ]);
    expect(actorOriginIdFor(AGENT)).toBe("notes-agent");
    expect(actorOriginIdFor({ kind: "user", userId: "local" })).toBeUndefined();
    expect(attributionFor(AGENT)).toEqual({
      actorKind: "agent",
      onBehalfOf: "local",
      depth: 0,
    });
    expect(attributionFor({ kind: "user", userId: "local" })).toEqual({
      actorKind: "human",
    });
  });

  it("refuses the engine-owned id field, empty fields, and non-record paths without opening a session", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session } = fakeSession();
    const context = contextFor(root, session);

    await expect(
      setCollectionRecordFields(context, {
        recordPath: "tasks/one.md",
        fields: { id: "forged" },
        author: AGENT,
      }),
    ).rejects.toThrow(/"id" field is engine-owned/);
    await expect(
      setCollectionRecordFields(context, {
        recordPath: "tasks/one.md",
        fields: {},
        author: AGENT,
      }),
    ).rejects.toThrow(/at least one field/i);
    await expect(
      setCollectionRecordFields(context, {
        recordPath: "tasks/data.bin",
        fields: { status: "done" },
        author: AGENT,
      }),
    ).rejects.toThrow(/not a collection record path/i);
    await expect(
      setCollectionRecordFields(context, {
        recordPath: "tasks/one.md",
        fields: { status: () => "done" },
        author: AGENT,
      }),
    ).rejects.toThrow(/must be a JSON value/i);
    expect(context.openedPaths).toEqual([]);
  });

  it("propagates a settle failure and still releases the session", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session, log } = fakeSession({
      settleError: new Error("settle refused"),
    });

    await expect(
      setCollectionRecordFields(contextFor(root, session), {
        recordPath: "tasks/one.md",
        fields: { status: "done" },
        author: AGENT,
      }),
    ).rejects.toThrow("settle refused");
    expect(log.order).toEqual(["apply", "settle", "close"]);
  });
});

describe("createCollectionRecord", () => {
  it("reports durable bytes as partial after an authored engine failure", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);
    const recordId = derivedRecordId("failed-create");
    const failure = new Error("engine write failed");
    context.createFile = async (path, text) => {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), text);
      throw failure;
    };
    await expect(createCollectionRecord(context, {
      collectionPath: "tasks", name: "failed", recordId, author: AUTOMATION,
    })).resolves.toMatchObject({ kind: "partial", created: ["tasks/failed.md"], failedStage: "write", retry: { mode: "resume", recordId } });
    expect(engine.listeners.size).toBe(0);
  });

  it("writes the file with a new record id, finishes on the engine's announcement without polling, and seeds fields", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const root = await createTestScratch("dohc-collection-edits-");
    const { session, log } = fakeSession();
    const engine = fakeEngine();

    const created = createCollectionRecord(
      contextFor(root, session, engine.overrides),
      {
        collectionPath: "tasks",
        name: "two",
        fields: { status: "open" },
        author: AGENT,
      },
    );

    // One lookup when the wait starts. The only timer is the adoption
    // ceiling, and time short of it looks nothing up again.
    await engine.lookupsReached(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(14_999);
    engine.announce(["tasks/other.md"]);
    expect(engine.lookups).toHaveLength(1);

    const recordId = await engine.adopt(root, "tasks/two.md");
    engine.announce(["tasks/two.md"]);
    await expect(created).resolves.toEqual({ path: "tasks/two.md", recordId });
    expect(engine.lookups).toEqual([recordId, recordId]);
    expect(engine.listeners.size).toBe(0);

    // Fields were seeded through the one write seam, attributed to the agent.
    expect(log.journaled).toEqual([
      {
        actorOriginId: "notes-agent",
        attribution: { actorKind: "agent", onBehalfOf: "local", depth: 0 },
        idempotencyKey: `create-record/${recordId}/status`,
      },
    ]);
    expect(log.doc.getMap("frontmatter").get("status")).toBe("open");
  });

  it("checks again when an announcement does not list its paths", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session } = fakeSession();
    const engine = fakeEngine();

    const created = createCollectionRecord(
      contextFor(root, session, engine.overrides),
      { collectionPath: "tasks", name: "two", author: AGENT },
    );
    await engine.listening();
    const recordId = await engine.adopt(root, "tasks/two.md");
    engine.announce(null);

    await expect(created).resolves.toEqual({ path: "tasks/two.md", recordId });
  });

  it("returns the record a deterministic id already names instead of adding another", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session, log } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);
    const recordId = derivedRecordId("claim-7/0");
    const attempt = (number: number) =>
      createCollectionRecord(context, {
        collectionPath: "tasks",
        name: "two",
        fields: { status: "open" },
        author: AUTOMATION,
        idempotencyKeyPrefix: `claim-7/${number}/0`,
        recordId,
      });

    const first = attempt(1);
    await engine.listening();
    await expect(engine.adopt(root, "tasks/two.md")).resolves.toBe(recordId);
    engine.announce(["tasks/two.md"]);
    await expect(first).resolves.toEqual({ path: "tasks/two.md", recordId });

    // The run stops before it settles; the next attempt finds the record,
    // even after someone renamed it, and has nothing left to write.
    await rename(join(root, "tasks", "two.md"), join(root, "tasks", "renamed.md"));
    engine.records.set(recordId, "tasks/renamed.md");
    await expect(attempt(2)).resolves.toEqual({
      path: "tasks/renamed.md",
      recordId,
    });
    expect(log.journaled.map((entry) => entry.idempotencyKey)).toEqual([
      "claim-7/1/0/status",
    ]);
    // The automation's file carries it as the moment's author, so the added
    // record's claim knows the automation and its depth.
    expect(context.createdFiles).toEqual([{ path: "tasks/two.md", author: AUTOMATION }]);
    await expect(readFile(join(root, "tasks", "renamed.md"), "utf8")).resolves.toBe(
      `---\nid: ${recordId}\n---\n`,
    );
  });

  it("returns the id the engine adopted the file under when it could not keep the requested one", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session, log } = fakeSession();
    const engine = fakeEngine();
    const requested = derivedRecordId("claim-7/0");

    const created = createCollectionRecord(
      contextFor(root, session, engine.overrides),
      {
        collectionPath: "tasks",
        name: "two",
        fields: { status: "open" },
        author: AUTOMATION,
        recordId: requested,
      },
    );
    await engine.listening();
    // The requested id belonged to a record someone deleted, so the engine
    // adopts the file under a new id and writes that id into it.
    const adopted = derivedRecordId("minted by the engine");
    await engine.adoptUnderNewId(root, "tasks/two.md", adopted);
    engine.announce(["tasks/two.md"]);

    await expect(created).resolves.toEqual({ path: "tasks/two.md", recordId: adopted });
    expect(log.doc.getMap("frontmatter").get("status")).toBe("open");
  });

  it("continues with an earlier attempt's file that the engine has not adopted yet", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session, log } = fakeSession();
    const engine = fakeEngine();
    const recordId = derivedRecordId("claim-7/0");
    // The earlier attempt wrote the file and stopped before adoption.
    await mkdir(join(root, "tasks"));
    await writeFile(join(root, "tasks", "two.md"), `---\nid: ${recordId}\n---\n`);

    const created = createCollectionRecord(
      contextFor(root, session, engine.overrides),
      {
        collectionPath: "tasks",
        name: "two",
        fields: { status: "open" },
        author: AUTOMATION,
        recordId,
      },
    );
    await engine.listening();
    await engine.adopt(root, "tasks/two.md");
    engine.announce(["tasks/two.md"]);

    await expect(created).resolves.toEqual({ path: "tasks/two.md", recordId });
    expect(log.doc.getMap("frontmatter").get("status")).toBe("open");
  });

  it("refuses a taken name and never writes into the other record", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);
    const other = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nstatus: done\n---\nNotes\n";
    await mkdir(join(root, "tasks"));
    await writeFile(join(root, "tasks", "two.md"), other);

    await expect(
      createCollectionRecord(context, {
        collectionPath: "tasks",
        name: "two",
        fields: { status: "open" },
        author: AGENT,
      }),
    ).rejects.toThrow("tasks/two.md already exists. Choose another record name.");
    await expect(
      createCollectionRecord(context, {
        collectionPath: "tasks",
        name: "two",
        fields: { status: "open" },
        author: AUTOMATION,
        recordId: derivedRecordId("claim-7/0"),
      }),
    ).rejects.toThrow("tasks/two.md already exists. Choose another record name.");

    await expect(readFile(join(root, "tasks", "two.md"), "utf8")).resolves.toBe(other);
    expect(context.openedPaths).toEqual([]);
    expect(engine.listeners.size).toBe(0);
  });

  it("stops waiting when the caller's signal aborts and never seeds a record adopted after that", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session } = fakeSession();
    const engine = fakeEngine();
    const controller = new AbortController();
    engine.refuseLookups(new Error("collection reloading"));
    const context = contextFor(root, session, {
      ...engine.overrides,
      signal: controller.signal,
    });

    const created = createCollectionRecord(context, {
      collectionPath: "tasks",
      name: "two",
      fields: { status: "open" },
      author: AUTOMATION,
    });
    // A second lookup starts only after the seam has taken the first refusal.
    await engine.listening();
    engine.announce(["tasks/two.md"]);
    await engine.lookupsReached(2);
    controller.abort();
    const error = await created.then(
      result => result,
      (reason: unknown) => reason,
    );

    // The engine adopts the file only after the run's deadline.
    engine.refuseLookups(null);
    await engine.adopt(root, "tasks/two.md");
    engine.announce(["tasks/two.md"]);

    expect(error).toMatchObject({ kind: "partial", created: ["tasks/two.md"], failedStage: "index", retry: { mode: "resume" } });
    expect(engine.listeners.size).toBe(0);
    expect(engine.lookups).toHaveLength(2);
    expect(context.openedPaths).toEqual([]);
  });

  it("stops waiting at the adoption ceiling when the caller's signal allows longer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const root = await createTestScratch("dohc-collection-edits-");
    const { session } = fakeSession();
    const engine = fakeEngine();

    const created = createCollectionRecord(
      contextFor(root, session, engine.overrides),
      { collectionPath: "tasks", name: "two", author: AGENT },
    );
    const outcome = created.then(
      result => result,
      (reason: unknown) => reason,
    );
    await engine.lookupsReached(1);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await outcome).toMatchObject({ kind: "partial", created: ["tasks/two.md"], failedStage: "index", retry: { mode: "resume" } });
    expect(engine.listeners.size).toBe(0);
  });

  it.each(["abort", "deadline"] as const)("stops a pending file read at %s without starting a late lookup", async end => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const root = await createTestScratch("dohc-record-read-wait-");
    const { session } = fakeSession();
    const engine = fakeEngine();
    const controller = new AbortController();
    const context = contextFor(root, session, { ...engine.overrides, signal: controller.signal });
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<{ text: string; truncated: boolean }>();
    vi.spyOn(context, "readText").mockImplementationOnce(() => {
      started.resolve();
      return held.promise;
    });
    const created = createCollectionRecord(context, {
      collectionPath: "tasks", name: "two", fields: { status: "open" }, author: AGENT,
    });
    await started.promise;
    engine.announce(null);
    if (end === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(15_000);
    expect(await created).toMatchObject({
      kind: "partial", failedStage: "index",
      reason: "dohc created tasks/two.md, but the engine did not add it to the Collection in time.",
    });
    expect(engine.listeners.size).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    await engine.adopt(root, "tasks/two.md");
    held.resolve(await context.readText("tasks/two.md"));
    await held.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(engine.lookups).toHaveLength(0);
    expect(context.openedPaths).toEqual([]);
  });

  it.each(["abort", "deadline"] as const)("stops a pending lookup at %s without seeding its late result", async end => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const root = await createTestScratch("dohc-record-lookup-wait-");
    const { session, log } = fakeSession();
    const engine = fakeEngine();
    const controller = new AbortController();
    const context = contextFor(root, session, { ...engine.overrides, signal: controller.signal });
    const createFile = context.createFile;
    vi.spyOn(context, "createFile").mockImplementationOnce(async (...args) => {
      const path = await createFile(...args);
      await engine.adopt(root, path);
      return path;
    });
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const withAdapter = context.withAdapter;
    vi.spyOn(context, "withAdapter").mockImplementationOnce(async work => {
      const result = await withAdapter(work);
      started.resolve();
      await held.promise;
      return result;
    });
    const created = createCollectionRecord(context, {
      collectionPath: "tasks", name: "two", fields: { status: "open" }, author: AGENT,
    });
    await started.promise;
    engine.announce(null);
    if (end === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(15_000);
    expect(await created).toMatchObject({ kind: "partial", failedStage: "index" });
    expect(engine.listeners.size).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    held.resolve();
    await held.promise;
    // Cross the real scheduler's event-loop boundary, without waiting for time.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(engine.lookups).toHaveLength(1);
    expect(context.openedPaths).toEqual([]);
    expect(log.updates).toEqual([]);
  });

  it("coalesces a burst during a lookup into one follow-up check", async () => {
    const root = await createTestScratch("dohc-record-burst-");
    const { session } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const withAdapter = context.withAdapter;
    vi.spyOn(context, "withAdapter").mockImplementationOnce(async work => {
      const result = await withAdapter(work);
      started.resolve();
      await held.promise;
      return result;
    });
    const created = createCollectionRecord(context, { collectionPath: "tasks", name: "two", author: AGENT });
    await started.promise;
    // Use resolved reads for the event-loop barrier below.
    const read = await context.readText("tasks/two.md");
    vi.spyOn(context, "readText").mockResolvedValue(read);
    for (let index = 0; index < 1_000; index++) engine.announce(["tasks/two.md"]);
    expect(engine.lookups).toHaveLength(1);
    held.resolve();
    await engine.lookupsReached(2);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(engine.lookups).toHaveLength(2);
    const recordId = await engine.adopt(root, "tasks/two.md");
    engine.announce(null);
    expect(await created).toEqual({ path: "tasks/two.md", recordId });
    expect(engine.lookups).toHaveLength(3);
    expect(engine.listeners.size).toBe(0);
  });

  it("recovers from an engine refusal on the next notification", async () => {
    const root = await createTestScratch("dohc-record-refusal-");
    const { session } = fakeSession();
    const engine = fakeEngine();
    engine.refuseLookups(Error("collection reloading"));
    const created = createCollectionRecord(contextFor(root, session, engine.overrides), {
      collectionPath: "tasks", name: "two", author: AGENT,
    });
    await engine.lookupsReached(1);
    engine.refuseLookups(null);
    const recordId = await engine.adopt(root, "tasks/two.md");
    engine.announce(null);
    expect(await created).toEqual({ path: "tasks/two.md", recordId });
    expect(engine.listeners.size).toBe(0);
  });

  it.each(["creation", "registration"] as const)("releases a subscription when the workspace ends during %s", async when => {
    const root = await createTestScratch("dohc-record-subscribe-abort-");
    const { session } = fakeSession();
    const engine = fakeEngine();
    const controller = new AbortController();
    const unsubscribe = vi.fn();
    const context = contextFor(root, session, {
      ...engine.overrides,
      signal: controller.signal,
      onRecordsChanged(listener) {
        const remove = engine.overrides.onRecordsChanged!(listener);
        if (when === "registration") controller.abort();
        return () => { remove(); unsubscribe(); };
      },
    });
    const createFile = context.createFile;
    if (when === "creation") vi.spyOn(context, "createFile").mockImplementationOnce(async (...args) => {
      const path = await createFile(...args);
      controller.abort();
      return path;
    });
    const read = vi.spyOn(context, "readText");
    expect(await createCollectionRecord(context, { collectionPath: "tasks", name: "two", author: AGENT }))
      .toMatchObject({ kind: "partial", failedStage: "index" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(engine.listeners.size).toBe(0);
    expect(context.openedPaths).toEqual([]);
    // Only the outer creation's diagnostic read runs after cancellation.
    expect(read).toHaveBeenCalledTimes(1);
    expect(engine.lookups).toEqual([]);
  });

  it("handles notifications during registration when the file is already indexed", async () => {
    const root = await createTestScratch("dohc-record-register-news-");
    const { session } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, {
      ...engine.overrides,
      onRecordsChanged(listener) {
        const remove = engine.overrides.onRecordsChanged!(listener);
        listener(null);
        listener(["tasks/two.md"]);
        return remove;
      },
    });
    const createFile = context.createFile;
    let recordId = "";
    vi.spyOn(context, "createFile").mockImplementationOnce(async (...args) => {
      const path = await createFile(...args);
      recordId = await engine.adopt(root, path);
      return path;
    });
    expect(await createCollectionRecord(context, { collectionPath: "tasks", name: "two", author: AGENT }))
      .toEqual({ path: "tasks/two.md", recordId });
    expect(engine.lookups).toEqual([recordId]);
    expect(engine.listeners.size).toBe(0);
  });

  it("keeps a late read from the old workspace out of the next workspace's creation", async () => {
    const oldRoot = await createTestScratch("dohc-record-old-workspace-");
    const { session: oldSession, log: oldLog } = fakeSession();
    const oldEngine = fakeEngine();
    const controller = new AbortController();
    const oldContext = contextFor(oldRoot, oldSession, { ...oldEngine.overrides, signal: controller.signal });
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<{ text: string; truncated: boolean }>();
    vi.spyOn(oldContext, "readText").mockImplementationOnce(() => {
      started.resolve();
      return held.promise;
    });
    const oldCreation = createCollectionRecord(oldContext, {
      collectionPath: "tasks", name: "two", fields: { status: "old" }, author: AGENT,
    });
    await started.promise;
    controller.abort();
    expect(await oldCreation).toMatchObject({ kind: "partial", failedStage: "index" });

    const nextRoot = await createTestScratch("dohc-record-next-workspace-");
    const { session: nextSession, log: nextLog } = fakeSession();
    const nextEngine = fakeEngine();
    const nextContext = contextFor(nextRoot, nextSession, nextEngine.overrides);
    const nextCreation = createCollectionRecord(nextContext, {
      collectionPath: "tasks", name: "two", fields: { status: "next" }, author: AGENT,
    });
    await nextEngine.listening();
    const oldId = await oldEngine.adopt(oldRoot, "tasks/two.md");
    held.resolve(await oldContext.readText("tasks/two.md"));
    oldEngine.announce(null);
    const nextId = await nextEngine.adopt(nextRoot, "tasks/two.md");
    nextEngine.announce(null);
    expect(await nextCreation).toEqual({ path: "tasks/two.md", recordId: nextId });
    expect(nextId).not.toBe(oldId);
    expect(oldContext.openedPaths).toEqual([]);
    expect(oldLog.updates).toEqual([]);
    expect(oldEngine.lookups).toEqual([]);
    expect(nextLog.doc.getMap("frontmatter").get("status")).toBe("next");
  });

  it("names the created record when seeding its fields fails", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session } = fakeSession({ settleError: new Error("settle refused") });
    const engine = fakeEngine();

    const created = createCollectionRecord(
      contextFor(root, session, engine.overrides),
      {
        collectionPath: "tasks",
        name: "partial",
        fields: { status: "open" },
        author: AGENT,
      },
    );
    await engine.listening();
    const recordId = await engine.adopt(root, "tasks/partial.md");
    engine.announce(["tasks/partial.md"]);

    // The file and its id exist by the time the seed fails: the error says
    // so, so a caller reconciles instead of creating a second record.
    await expect(created).resolves.toMatchObject({ kind: "partial", created: ["tasks/partial.md"], failedStage: "settle", retry: { mode: "resume", recordId } });
  });

  it("returns without a session when fields are absent or empty", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session, log } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);

    const solo = createCollectionRecord(context, {
      collectionPath: "tasks",
      name: "solo",
      author: AGENT,
    });
    await engine.listening();
    const soloId = await engine.adopt(root, "tasks/solo.md");
    engine.announce(["tasks/solo.md"]);
    await expect(solo).resolves.toEqual({ path: "tasks/solo.md", recordId: soloId });

    // The CLI and MCP always send a fields object; an empty one is the same
    // request as none, not a refusal.
    const empty = createCollectionRecord(context, {
      collectionPath: "tasks",
      name: "empty",
      fields: {},
      author: AGENT,
    });
    await engine.listening();
    const emptyId = await engine.adopt(root, "tasks/empty.md");
    engine.announce(["tasks/empty.md"]);
    await expect(empty).resolves.toEqual({ path: "tasks/empty.md", recordId: emptyId });
    expect(log.order).toEqual([]);
  });

  it("refuses a bad record name or id and an aborted surface before writing", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session } = fakeSession();
    const aborted = new AbortController();
    aborted.abort();

    await expect(
      createCollectionRecord(contextFor(root, session), {
        collectionPath: "tasks",
        name: "no/separators",
        author: AGENT,
      }),
    ).rejects.toThrow(/plain file name/i);
    await expect(
      createCollectionRecord(contextFor(root, session), {
        collectionPath: "tasks",
        name: "two",
        author: AGENT,
        recordId: "rec_TOO_SHORT",
      }),
    ).rejects.toThrow(/Record id must be "rec_"/);
    await expect(
      createCollectionRecord(
        contextFor(root, session, { signal: aborted.signal }),
        { collectionPath: "tasks", name: "two", author: AGENT },
      ),
    ).rejects.toThrow(/no longer active/i);
    await expect(readFile(join(root, "tasks", "two.md"), "utf8")).rejects.toThrow(
      /ENOENT/,
    );
  });
});

describe("partial record retry", () => {
  it("does not treat an untyped key error as a completed seed", async () => {
    const root = await createTestScratch("dohc-record-untyped-refusal-");
    const { session } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);
    vi.spyOn(session, "applyDecidedLocalUpdate").mockRejectedValueOnce(new Error("idempotency-key-reuse-mismatch"));
    const first = createCollectionRecord(context, {
      collectionPath: "tasks", name: "retry", fields: { status: "open" }, author: AGENT,
    });
    await engine.listening();
    await engine.adopt(root, "tasks/retry.md");
    engine.announce(["tasks/retry.md"]);
    expect(await first).toMatchObject({ kind: "partial", failedStage: "fields" });
  });

  it.each(["delete", "null"])("preserves a cleared seed after settlement fails (%s)", async clear => {
    const root = await createTestScratch("dohc-record-cleared-seed-");
    const journaledKeys = new Map<string, string>();
    const { session, log } = fakeSession({ journaledKeys });
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);
    const input = { collectionPath: "tasks", name: "retry", fields: { status: "open" }, author: AGENT };
    vi.spyOn(session, "settleNow").mockRejectedValueOnce(new Error("settle refused"));
    const first = createCollectionRecord(context, input);
    await engine.listening();
    const recordId = await engine.adopt(root, "tasks/retry.md");
    engine.announce(["tasks/retry.md"]);
    expect(await first).toMatchObject({ kind: "partial", failedStage: "settle" });
    expect(log.doc.getMap("frontmatter").get("status")).toBe("open");

    const resumed = fakeSession({ journaledKeys });
    Y.applyUpdate(resumed.log.doc, Y.encodeStateAsUpdate(log.doc));
    const fields = resumed.log.doc.getMap("frontmatter");
    if (clear === "delete") fields.delete("status");
    else fields.set("status", null);
    await expect(createCollectionRecord(contextFor(root, resumed.session, engine.overrides), {
      ...input, recordId,
    })).resolves.toEqual({ path: "tasks/retry.md", recordId, kept: { status: null } });
    expect(fields.get("status")).toBe(clear === "delete" ? undefined : null);
    expect(resumed.log.journaled).toEqual([]);
    expect(resumed.log.order).toEqual(["settle", "close"]);
    expect(journaledKeys.size).toBe(1);
    expect(await readdir(join(root, "tasks"))).toEqual(["retry.md"]);
  });

  it("preserves a person's later edit after seeding lands but settlement fails", async () => {
    const root = await createTestScratch("dohc-record-later-edit-");
    const { session, log } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);
    const input = { collectionPath: "tasks", name: "retry", fields: { status: "open" }, author: AGENT };
    vi.spyOn(session, "settleNow").mockRejectedValueOnce(new Error("settle refused"));
    const first = createCollectionRecord(context, input);
    await engine.listening();
    const recordId = await engine.adopt(root, "tasks/retry.md");
    engine.announce(["tasks/retry.md"]);
    const partial = await first;
    expect(partial).toMatchObject({ kind: "partial", failedStage: "settle", retry: { recordId } });
    if (!("kind" in partial)) throw Error("expected partial");
    expect(log.doc.getMap("frontmatter").get("status")).toBe("open");

    // A fresh session models a retry after the original caller has gone away.
    const resumed = fakeSession();
    Y.applyUpdate(resumed.log.doc, Y.encodeStateAsUpdate(log.doc));
    resumed.log.doc.getMap("frontmatter").set("status", "done");
    await expect(createCollectionRecord(contextFor(root, resumed.session, engine.overrides), {
      ...input, recordId: partial.retry.recordId,
    })).resolves.toEqual({ path: "tasks/retry.md", recordId, kept: { status: "done" } });
    expect(resumed.log.doc.getMap("frontmatter").get("status")).toBe("done");
    expect(resumed.log.journaled).toEqual([]);
    expect(log.journaled[0]?.idempotencyKey).toBe(`create-record/${recordId}/status`);
    expect(await readdir(join(root, "tasks"))).toEqual(["retry.md"]);
  });

  it("seeds only fields still absent when retrying after binding fails", async () => {
    const root = await createTestScratch("dohc-record-missing-fields-");
    const { session, log } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);
    const input = { collectionPath: "tasks", name: "retry", fields: { status: "open", priority: "high" }, author: AGENT };
    vi.spyOn(context, "openRecord").mockRejectedValueOnce(new Error("bind refused"));
    const first = createCollectionRecord(context, input);
    await engine.listening();
    const recordId = await engine.adopt(root, "tasks/retry.md");
    engine.announce(["tasks/retry.md"]);
    expect(await first).toMatchObject({ kind: "partial", failedStage: "bind" });
    log.doc.getMap("frontmatter").set("status", "done");
    await expect(createCollectionRecord(context, { ...input, recordId })).resolves.toEqual({ path: "tasks/retry.md", recordId, kept: { status: "done" } });
    expect(log.doc.getMap("frontmatter").toJSON()).toEqual({ status: "done", priority: "high" });
    expect(log.journaled.map(entry => entry.idempotencyKey)).toEqual([`create-record/${recordId}/priority`]);
  });

  it("keeps a reassigned automation identity when capture cannot finish", async () => {
    const root = await createTestScratch("dohc-record-automation-retry-");
    const { session } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);
    const adopted = derivedRecordId("reassigned");
    const originalWrite = context.createFile;
    vi.spyOn(context, "createFile").mockImplementationOnce(async (...args) => {
      const written = await originalWrite(...args);
      await engine.adoptUnderNewId(root, "tasks/retry.md", adopted);
      return written;
    });
    vi.spyOn(context, "onRecordsChanged").mockImplementationOnce(() => { throw Error("capture offline"); });
    // The engine reassigned the identity before capture could be confirmed.
    const remember = vi.fn(async () => {});
    await expect(collectionRecordWrites(context).create({
      collectionPath: "tasks", name: "retry", recordId: derivedRecordId("planned"), author: AUTOMATION, onPartial: remember,
    })).rejects.toThrow();
    expect(remember).toHaveBeenCalledWith({ path: "tasks/retry.md", recordId: adopted });
    await expect(collectionRecordWrites(context).create({
      collectionPath: "tasks", name: "retry", recordId: adopted, author: AUTOMATION,
    })).resolves.toEqual({ path: "tasks/retry.md", recordId: adopted });
    expect(await readdir(join(root, "tasks"))).toEqual(["retry.md"]);
  });

  it("refuses a retry ID belonging to a different path for humans and agents", async () => {
    const root = await createTestScratch("dohc-record-path-");
    const { session, log } = fakeSession();
    const engine = fakeEngine();
    const recordId = derivedRecordId("other");
    engine.records.set(recordId, "tasks/other.md");
    await expect(createCollectionRecord(contextFor(root, session, engine.overrides), {
      collectionPath: "tasks", name: "new", fields: { status: "open" }, recordId, author: AGENT,
    })).rejects.toThrow("belongs to another path");
    expect(log.updates).toEqual([]);
  });


  it("keeps partial record facts when the workspace lease rejects completion", async () => {
    const root = await createTestScratch("dohc-record-lease-");
    const { session } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);
    vi.spyOn(context, "onRecordsChanged").mockImplementationOnce(() => { throw Error("capture offline"); });
    const partial = await runCollectionRecordCreation(async work => {
      await work(context);
      throw Error("stale workspace");
    }, { collectionPath: "tasks", name: "retry", author: AGENT });
    expect(partial).toMatchObject({ kind: "partial", created: ["tasks/retry.md"], failedStage: "capture" });
  });

  it("reports a saved record when only the final workspace lease check fails", async () => {
    const root = await createTestScratch("dohc-record-lease-");
    const { session } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);
    const first = runCollectionRecordCreation(async work => {
      await work(context);
      throw Error("stale workspace");
    }, { collectionPath: "tasks", name: "retry", author: AGENT });
    await engine.listening();
    const recordId = await engine.adopt(root, "tasks/retry.md");
    engine.announce(null);
    expect(await first).toMatchObject({ kind: "partial", failedStage: "scope", retry: { recordId } });
    await expect(runCollectionRecordCreation(work => work(context), {
      collectionPath: "tasks", name: "retry", recordId, author: AGENT,
    })).resolves.toEqual({ path: "tasks/retry.md", recordId });
    expect(await readdir(join(root, "tasks"))).toEqual(["retry.md"]);
  });


  it("retries an authored write that landed before the transport failed", async () => {
    const root = await createTestScratch("dohc-record-write-retry-");
    const { session } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);
    const write = context.createFile;
    vi.spyOn(context, "createFile").mockImplementationOnce(async (...args) => {
      await write(...args);
      throw Error("response lost");
    });
    const input = { collectionPath: "tasks", name: "retry", author: AUTOMATION };
    const partial = await createCollectionRecord(context, input);
    expect(partial).toMatchObject({ kind: "partial", failedStage: "write", created: ["tasks/retry.md"] });
    if (!("kind" in partial)) throw Error("expected partial");
    const retry = createCollectionRecord(context, { ...input, recordId: partial.retry.recordId });
    await engine.listening();
    await engine.adopt(root, "tasks/retry.md");
    engine.announce(null);
    await expect(retry).resolves.toEqual({ path: "tasks/retry.md", recordId: partial.retry.recordId });
    expect(await readdir(join(root, "tasks"))).toEqual(["retry.md"]);
  });

  it("retries capture subscription failure without leaving a deadline behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const root = await createTestScratch("dohc-record-capture-retry-");
    const { session } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);
    vi.spyOn(context, "onRecordsChanged").mockImplementationOnce(() => { throw Error("capture offline"); });
    const input = { collectionPath: "tasks", name: "retry", author: AGENT };
    const partial = await createCollectionRecord(context, input);
    expect(partial).toMatchObject({ kind: "partial", failedStage: "capture" });
    expect(vi.getTimerCount()).toBe(0);
    if (!("kind" in partial)) throw Error("expected partial");
    const retry = createCollectionRecord(context, { ...input, recordId: partial.retry.recordId });
    await engine.listening();
    await engine.adopt(root, "tasks/retry.md");
    engine.announce(null);
    await expect(retry).resolves.toEqual({ path: "tasks/retry.md", recordId: partial.retry.recordId });
    expect(await readdir(join(root, "tasks"))).toEqual(["retry.md"]);
  });

  it("keeps an adopted record ID while preserving a busy creation refusal", async () => {
    const root = await createTestScratch("dohc-record-busy-retry-");
    const { session } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);
    const busy = new DaemonRefusalError({code: "OVERLOADED", message: "engine-store-busy", retry: "afterBackoff"}, undefined);
    vi.spyOn(context, "onRecordsChanged").mockImplementationOnce(() => { throw busy; });
    const onPartial = vi.fn(async () => undefined);
    const input = { collectionPath: "tasks", name: "retry", author: AGENT, recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa", onPartial };
    const first = collectionRecordWrites(context).create(input);
    await expect(first).rejects.toBe(busy);
    const id = await engine.adopt(root, "tasks/retry.md");
    expect(onPartial).toHaveBeenCalledWith({path: "tasks/retry.md", recordId: id});
    await expect(collectionRecordWrites(context).create({...input, recordId: id})).resolves.toEqual({path: "tasks/retry.md", recordId: id});
    expect(await readdir(join(root, "tasks"))).toEqual(["retry.md"]);
  });

  it.each(["bind", "fields", "settle", "close"] as const)("resumes after %s without another file or field update", async stage => {
    const root = await createTestScratch("dohc-record-retry-");
    const { session, log } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);
    const input = { collectionPath: "tasks", name: "retry", fields: { status: "open" }, author: AGENT };
    const fail = () => { throw new Error("injected " + stage); };
    if (stage === "bind") vi.spyOn(context, "openRecord").mockImplementationOnce(fail);
    if (stage === "fields") vi.spyOn(session, "applyDecidedLocalUpdate").mockImplementationOnce(fail);
    if (stage === "settle") vi.spyOn(session, "settleNow").mockImplementationOnce(fail);
    if (stage === "close") vi.spyOn(session, "close").mockImplementationOnce(fail);
    const first = createCollectionRecord(context, input);
    await engine.listening();
    const id = await engine.adopt(root, "tasks/retry.md");
    engine.announce(["tasks/retry.md"]);
    const partial = await first;
    expect(partial).toMatchObject({ kind: "partial", created: ["tasks/retry.md"], failedStage: stage, retry: { mode: "resume", recordId: id } });
    if (!("kind" in partial)) throw Error("expected partial");
    await expect(createCollectionRecord(context, { ...input, recordId: partial.retry.recordId })).resolves.toEqual({ path: "tasks/retry.md", recordId: id });
    expect(await readdir(join(root, "tasks"))).toEqual(["retry.md"]);
    expect(log.updates).toHaveLength(1);
    expect(log.order).toContain("settle");
  });

  it("resumes an adoption timeout with the returned identity", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const root = await createTestScratch("dohc-record-retry-");
    const { session } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);
    const input = { collectionPath: "tasks", name: "retry", author: AGENT };
    const first = createCollectionRecord(context, input);
    await engine.lookupsReached(1);
    await vi.advanceTimersByTimeAsync(15_000);
    const partial = await first;
    expect(partial).toMatchObject({ kind: "partial", failedStage: "index" });
    if (!("kind" in partial)) throw Error("expected partial");
    const retry = createCollectionRecord(context, { ...input, recordId: partial.retry.recordId });
    await engine.listening();
    await engine.adopt(root, "tasks/retry.md");
    engine.announce(null);
    await expect(retry).resolves.toEqual({ path: "tasks/retry.md", recordId: partial.retry.recordId });
    expect(await readdir(join(root, "tasks"))).toEqual(["retry.md"]);
  });
});

it.each(["deleted", "renamed", "replaced"].flatMap(state => [
  { state, fields: undefined }, { state, fields: { status: "done" } },
]))("skips an automation replay with a stale binding after the file was $state ($fields)", async ({ state, fields }) => {
  const root = await createTestScratch("dohc-stale-record-");
  const { session, log } = fakeSession();
  const engine = fakeEngine();
  const context = contextFor(root, session, engine.overrides);
  const recordId = derivedRecordId("stale");
  await mkdir(join(root, "tasks"));
  await writeFile(join(root, "tasks", "two.md"), `---\nid: ${recordId}\n---\n`);
  await engine.adopt(root, "tasks/two.md");
  if (state === "renamed") await rename(join(root, "tasks", "two.md"), join(root, "tasks", "moved.md"));
  else await unlink(join(root, "tasks", "two.md"));
  const other = `---\nid: ${derivedRecordId("other")}\n---\n`;
  if (state === "replaced") await writeFile(join(root, "tasks", "two.md"), other);

  // No reconciliation: the engine still answers the old path for this id.
  await expect(createCollectionRecord(context, {
    collectionPath: "tasks", name: "two", recordId, author: AUTOMATION, fields,
  })).rejects.toBeInstanceOf(AutomationCreationSkipped);
  expect(context.openedPaths).toEqual([]);
  expect(context.createdFiles).toEqual([]);
  expect(log.updates).toEqual([]);
  if (state === "replaced") expect(await readFile(join(root, "tasks", "two.md"), "utf8")).toBe(other);
});

it("skips an automation replay when the bound file read reports file-not-found", async () => {
  const root = await createTestScratch("dohc-stale-record-read-");
  const { session } = fakeSession();
  const engine = fakeEngine();
  const recordId = derivedRecordId("stale");
  engine.records.set(recordId, "tasks/two.md");
  const context = contextFor(root, session, engine.overrides);
  const read = vi.spyOn(context, "readText").mockRejectedValueOnce(new VersionedTextStoreError("file-not-found", "missing"));
  await expect(createCollectionRecord(context, {
    collectionPath: "tasks", name: "two", recordId, author: AUTOMATION,
  })).rejects.toBeInstanceOf(AutomationCreationSkipped);
  expect(read).toHaveBeenCalledOnce();
  expect(context.openedPaths).toEqual([]);
});

it("propagates a transient bound-file read failure without treating the record as created", async () => {
  const root = await createTestScratch("dohc-stale-record-read-");
  const { session } = fakeSession();
  const engine = fakeEngine();
  const recordId = derivedRecordId("stale");
  await mkdir(join(root, "tasks"));
  await writeFile(join(root, "tasks", "two.md"), `---\nid: ${recordId}\n---\n`);
  await engine.adopt(root, "tasks/two.md");
  const context = contextFor(root, session, engine.overrides);
  const error = Object.assign(new Error("read refused"), { code: "EACCES" });
  const read = vi.spyOn(context, "readText").mockRejectedValueOnce(error);
  await expect(createCollectionRecord(context, {
    collectionPath: "tasks", name: "two", recordId, author: AUTOMATION,
  })).rejects.toBe(error);
  expect(read).toHaveBeenCalledOnce();
  expect(context.openedPaths).toEqual([]);
});

it.each([undefined, derivedRecordId("first-create")])("does not add a file read to a first automation creation (%s)", async recordId => {
  const root = await createTestScratch("dohc-first-record-read-");
  const { session } = fakeSession();
  const engine = fakeEngine();
  const context = contextFor(root, session, engine.overrides);
  const write = context.createFile;
  vi.spyOn(context, "createFile").mockImplementationOnce(async (...args) => {
    const path = await write(...args);
    await engine.adopt(root, path);
    return path;
  });
  const read = vi.spyOn(context, "readText");
  await expect(createCollectionRecord(context, {
    collectionPath: "tasks", name: "two", recordId, author: AUTOMATION,
  })).resolves.toMatchObject({ path: "tasks/two.md" });
  // Only waitForRecord reads the new file to confirm adoption.
  expect(read).toHaveBeenCalledExactlyOnceWith("tasks/two.md");
});

it("continues an automation replay when the bound file still has the requested id", async () => {
  const root = await createTestScratch("dohc-live-record-replay-");
  const { session, log } = fakeSession();
  const engine = fakeEngine();
  const recordId = derivedRecordId("live");
  await mkdir(join(root, "tasks"));
  await writeFile(join(root, "tasks", "two.md"), `---\nid: ${recordId}\n---\n`);
  await engine.adopt(root, "tasks/two.md");
  const context = contextFor(root, session, engine.overrides);
  const read = vi.spyOn(context, "readText");
  await expect(createCollectionRecord(context, {
    collectionPath: "tasks", name: "two", recordId, author: AUTOMATION, fields: { status: "done" },
  })).resolves.toEqual({ path: "tasks/two.md", recordId });
  // Once for its id, and once to check it is not a lossy note before its fields are set.
  expect(read.mock.calls).toEqual([["tasks/two.md"], ["tasks/two.md"]]);
  expect(context.createdFiles).toEqual([]);
  expect(context.openedPaths).toEqual(["tasks/two.md"]);
  expect(log.doc.getMap("frontmatter").get("status")).toBe("done");
});

it.each(["missing", "other", "unreadable"] as const)("checks a committed creation's %s file before skipping it", async state => {
  const root = await createTestScratch("dohc-committed-record-");
  const { session } = fakeSession();
  const context = contextFor(root, session, fakeEngine().overrides);
  const recordId = derivedRecordId("committed");
  if (state === "other") { await mkdir(join(root, "tasks")); await writeFile(join(root, "tasks", "two.md"), `---\nid: ${derivedRecordId("other")}\n---\n`); }
  context.createFile = async () => { throw new AutomationCreationCommitted(); };
  if (state === "unreadable") context.readText = async () => { throw Error("read refused"); };
  const result = createCollectionRecord(context, { collectionPath: "tasks", name: "two", recordId, author: AGENT });
  if (state === "unreadable") await expect(result).rejects.toThrow("read refused");
  else await expect(result).rejects.toBeInstanceOf(AutomationCreationSkipped);
  expect(context.openedPaths).toEqual([]);
});
