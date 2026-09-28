import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { derivedRecordId } from "@dohc/automation-executor/record-ids";

import {
  actorOriginIdFor,
  attributionFor,
  createCollectionRecord,
  setCollectionRecordFields,
  type CollectionRecordEditContext,
} from "./collectionRecordEdits";
import type { ChangeAttributionWire } from "@dohc/workspace-engine-client";

import type { WorkspaceEngineYDocProviderSession } from "./workspaceEngineCapture";

import { createTestScratch } from "./testTemp";
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
} as const;

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
  settleError?: Error;
  onSettle?: () => Promise<void>;
  /** Runs just before each update's turn on the session chain, as a remote update would land. */
  beforeTurn?: (doc: Y.Doc) => void;
} = {}): {
  session: WorkspaceEngineYDocProviderSession;
  log: FakeSessionLog;
} {
  const doc = new Y.Doc();
  const log: FakeSessionLog = { doc, order: [], journaled: [], updates: [] };
  // The engine's rule (durable.rs): a key already journaled with other
  // update bytes refuses, so a re-run that reuses a key with a new update fails.
  const journaledKeys = new Map<string, string>();
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
          throw new Error("idempotency-key-reuse-mismatch");
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
  return { session: session as unknown as WorkspaceEngineYDocProviderSession, log };
}

function contextFor(
  root: string,
  session: WorkspaceEngineYDocProviderSession,
  overrides: Partial<CollectionRecordEditContext> = {},
): CollectionRecordEditContext & { openedPaths: string[]; authoredWrites: Array<{ path: string; author: unknown }> } {
  const openedPaths: string[] = [];
  const authoredWrites: Array<{ path: string; author: unknown }> = [];
  return {
    openedPaths,
    authoredWrites,
    capture: {
      async openYDocSession(input) {
        openedPaths.push(input.path);
        return session;
      },
      // The engine writes the file with its author on the moment.
      async writeAuthoredFile(absolutePath, text, author, options) {
        authoredWrites.push({ path: absolutePath, author });
        await mkdir(join(absolutePath, ".."), { recursive: true });
        await writeFile(absolutePath, text, { flag: options?.createOnly ? "wx" : "w" });
        return { resolvedAbsolutePath: absolutePath, materializeOutcome: "applied" };
      },
    },
    workspaceRoot: root,
    withAdapter: async () => null,
    onCaptureSettled: () => () => undefined,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/**
 * The engine side of a create: records it has adopted, keyed by id, and its
 * capture announcements. A lookup of an id it has not adopted answers the
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
            collection: { path: collectionPath, status: "valid", reasons: [] },
            record: { id: recordId, path, conflicted: false, values: [] },
            history: [],
            nextBeforeHistoryId: null,
          };
        },
      }),
    onCaptureSettled: (listener) => {
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

  it("records an automation author under its subscription id with its depth and claim key", async () => {
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
        attribution: { actorKind: "automation", onBehalfOf: "local", depth: 1 },
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
      capture: {
        async openYDocSession() {
          // An automation run's deadline passes while the engine opens it.
          controller.abort();
          return session;
        },
        writeAuthoredFile: vi.fn(),
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
  it("does not accept matching disk bytes after an authored engine failure", async () => {
    const root = await createTestScratch("dohc-collection-edits-");
    const { session } = fakeSession();
    const engine = fakeEngine();
    const context = contextFor(root, session, engine.overrides);
    const recordId = derivedRecordId("failed-create");
    const failure = new Error("engine write failed");
    context.capture.writeAuthoredFile = async (path, text) => {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, text);
      throw failure;
    };
    await expect(createCollectionRecord(context, {
      collectionPath: "tasks", name: "failed", recordId, author: AUTOMATION,
    })).rejects.toBe(failure);
    expect(engine.listeners.size).toBe(0);
  });

  it("writes the file with a new record id, finishes on the engine's announcement without polling, and seeds fields", async () => {
    vi.useFakeTimers();
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
    expect(context.authoredWrites).toEqual([{ path: join(root, "tasks", "two.md"), author: AUTOMATION }]);
    await expect(readFile(join(root, "tasks", "two.md"), "utf8")).resolves.toBe(
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
      () => null,
      (reason: unknown) => reason,
    );

    // The engine adopts the file only after the run's deadline.
    engine.refuseLookups(null);
    await engine.adopt(root, "tasks/two.md");
    engine.announce(["tasks/two.md"]);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(ADOPTION_TIMEOUT_MESSAGE);
    expect(((error as Error).cause as Error).message).toBe("collection reloading");
    expect(engine.listeners.size).toBe(0);
    expect(engine.lookups).toHaveLength(2);
    expect(context.openedPaths).toEqual([]);
  });

  it("stops waiting at the adoption ceiling when the caller's signal allows longer", async () => {
    vi.useFakeTimers();
    const root = await createTestScratch("dohc-collection-edits-");
    const { session } = fakeSession();
    const engine = fakeEngine();

    const created = createCollectionRecord(
      contextFor(root, session, engine.overrides),
      { collectionPath: "tasks", name: "two", author: AGENT },
    );
    const outcome = created.then(
      () => null,
      (reason: unknown) => reason,
    );
    await engine.lookupsReached(1);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(((await outcome) as Error).message).toBe(ADOPTION_TIMEOUT_MESSAGE);
    expect(engine.listeners.size).toBe(0);
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
    await expect(created).rejects.toThrow(
      `The record was created at tasks/partial.md (id ${recordId}), but its fields could not be set: settle refused`,
    );
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
