import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  actorOriginIdFor,
  createCollectionRecord,
  setCollectionRecordFields,
  type CollectionRecordEditContext,
} from "./collectionRecordEdits";
import type { WorkspaceEngineYDocProviderSession } from "./workspaceEngineCapture";
import { createTestScratch } from "./testTemp";

const AGENT = {
  kind: "agent",
  agentId: "plugin:notes",
  onBehalfOf: "local",
} as const;

interface FakeSessionLog {
  doc: Y.Doc;
  order: string[];
  journaled: Array<{ actorOriginId?: string }>;
}

function fakeSession(options: { settleError?: Error } = {}): {
  session: WorkspaceEngineYDocProviderSession;
  log: FakeSessionLog;
} {
  const doc = new Y.Doc();
  const log: FakeSessionLog = { doc, order: [], journaled: [] };
  const session = {
    doc,
    get initialUpdate() {
      return Y.encodeStateAsUpdate(doc);
    },
    applyLocalUpdate(
      update: Uint8Array,
      onArmed?: () => void,
      applyOptions?: { actorOriginId?: string },
    ) {
      // The real session journals the update and applies it to its doc.
      Y.applyUpdate(doc, update);
      log.order.push("apply");
      log.journaled.push({ ...applyOptions });
      onArmed?.();
    },
    async settleNow() {
      log.order.push("settle");
      if (options.settleError) throw options.settleError;
      return { materialized: true };
    },
    async close() {
      log.order.push("close");
    },
  } as unknown as WorkspaceEngineYDocProviderSession;
  return { session, log };
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function workspaceRoot(): Promise<string> {
  const root = await createTestScratch("dohc-collection-edits-");
  roots.push(root);
  return root;
}

function contextFor(
  root: string,
  session: WorkspaceEngineYDocProviderSession,
  overrides: Partial<CollectionRecordEditContext> = {},
): CollectionRecordEditContext & { openedPaths: string[] } {
  const openedPaths: string[] = [];
  return {
    openedPaths,
    capture: {
      async openYDocSession(input) {
        openedPaths.push(input.path);
        return session;
      },
    },
    workspaceRoot: root,
    withAdapter: async () => null,
    ...overrides,
  };
}

describe("setCollectionRecordFields", () => {
  it("sets every field in one transaction with the agent's actor origin, settles, then releases", async () => {
    const root = await workspaceRoot();
    const { session, log } = fakeSession();
    const context = contextFor(root, session);

    await expect(
      setCollectionRecordFields(context, {
        recordPath: "tasks/one.md",
        fields: { status: "done", estimate: 3 },
        author: AGENT,
      }),
    ).resolves.toEqual({ path: "tasks/one.md" });

    expect(context.openedPaths).toEqual(["tasks/one.md"]);
    // ONE journaled update carrying the agent's origin, settled before release.
    expect(log.order).toEqual(["apply", "settle", "close"]);
    expect(log.journaled).toEqual([{ actorOriginId: "plugin:notes" }]);
    const frontmatter = log.doc.getMap("frontmatter");
    expect(frontmatter.get("status")).toBe("done");
    expect(frontmatter.get("estimate")).toBe(3);
  });

  it("keeps a non-agent author device-attributed, like a human edit", async () => {
    const root = await workspaceRoot();
    const { session, log } = fakeSession();

    await setCollectionRecordFields(contextFor(root, session), {
      recordPath: "tasks/one.md",
      fields: { status: "done" },
      author: { kind: "user", userId: "local" },
    });

    expect(log.journaled).toEqual([{}]);
    expect(actorOriginIdFor(AGENT)).toBe("plugin:notes");
    expect(actorOriginIdFor({ kind: "user", userId: "local" })).toBeUndefined();
  });

  it("refuses the engine-owned id field, empty fields, and non-record paths without opening a session", async () => {
    const root = await workspaceRoot();
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
    const root = await workspaceRoot();
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
  it("creates the md file, waits for the minted id, and seeds fields through the same seam", async () => {
    const root = await workspaceRoot();
    const { session, log } = fakeSession();
    const context = contextFor(root, session, {
      withAdapter: async (work) =>
        await work({
          queryCollectionRecords: async ({ collectionPath }) => ({
            collection: { path: collectionPath, status: "valid", reasons: [] },
            records: [
              { id: "rec_9", path: "tasks/two.md", conflicted: false, values: [] },
            ],
            groups: null,
            nextCursor: null,
          }),
        }),
    });

    await expect(
      createCollectionRecord(context, {
        collectionPath: "tasks",
        name: "two",
        fields: { status: "open" },
        author: AGENT,
      }),
    ).resolves.toEqual({ path: "tasks/two.md", recordId: "rec_9" });

    // The record file exists on disk through the desktop's create path.
    await expect(readFile(join(root, "tasks", "two.md"), "utf8")).resolves.toBe("");
    // Fields were seeded through the one write seam, attributed to the agent.
    expect(log.journaled).toEqual([{ actorOriginId: "plugin:notes" }]);
    expect(log.doc.getMap("frontmatter").get("status")).toBe("open");
  });

  it("names the created record when seeding its fields fails", async () => {
    const root = await workspaceRoot();
    const { session } = fakeSession({ settleError: new Error("settle refused") });
    const context = contextFor(root, session, {
      withAdapter: async (work) =>
        await work({
          queryCollectionRecords: async ({ collectionPath }) => ({
            collection: { path: collectionPath, status: "valid", reasons: [] },
            records: [
              { id: "rec_p", path: "tasks/partial.md", conflicted: false, values: [] },
            ],
            groups: null,
            nextCursor: null,
          }),
        }),
    });

    // The file and its id exist by the time the seed fails: the error says
    // so, so a caller reconciles instead of creating a second record.
    await expect(
      createCollectionRecord(context, {
        collectionPath: "tasks",
        name: "partial",
        fields: { status: "open" },
        author: AGENT,
      }),
    ).rejects.toThrow(/created at tasks\/partial\.md \(id rec_p\).*settle refused/);
  });

  it("returns without a session when fields are absent or empty", async () => {
    const root = await workspaceRoot();
    const { session, log } = fakeSession();
    const context = contextFor(root, session, {
      withAdapter: async (work) =>
        await work({
          queryCollectionRecords: async () => ({
            collection: { path: "tasks", status: "valid", reasons: [] },
            records: [
              { id: "rec_1", path: "tasks/solo.md", conflicted: false, values: [] },
            ],
            groups: null,
            nextCursor: null,
          }),
        }),
    });

    await expect(
      createCollectionRecord(context, {
        collectionPath: "tasks",
        name: "solo",
        author: AGENT,
      }),
    ).resolves.toEqual({ path: "tasks/solo.md", recordId: "rec_1" });
    // The CLI and MCP always send a fields object; an empty one is the same
    // request as none, not a refusal.
    await expect(
      createCollectionRecord(context, {
        collectionPath: "tasks",
        name: "solo",
        fields: {},
        author: AGENT,
      }),
    ).resolves.toEqual({ path: "tasks/solo.md", recordId: "rec_1" });
    expect(log.order).toEqual([]);
  });

  it("refuses a record name with separators and an aborted surface before writing", async () => {
    const root = await workspaceRoot();
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
      createCollectionRecord(
        contextFor(root, session, { signal: aborted.signal }),
        { collectionPath: "tasks", name: "two", author: AGENT },
      ),
    ).rejects.toThrow(/no longer active/i);
  });
});
