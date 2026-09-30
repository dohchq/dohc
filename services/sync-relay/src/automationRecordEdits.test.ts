import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { VersionedTextStoreError, type VersionRecord } from "@dohc/workspace-contracts/engine";
import { DaemonRefusalError, type EngineYdocProviderSession } from "@dohc/workspace-engine-client";
import { createCollectionRecord, setCollectionRecordFields } from "@dohc/automation-executor/collection-record-edits";
import { derivedRecordId } from "@dohc/automation-executor/record-ids";
import { replicaRecordEditContext, type ReplicaRecordEngine } from "./automationRecordEdits";

const AUTOMATION = { kind: "automation", automationId: "collection:Tasks#stamp", onBehalfOf: "owner", depth: 1,
  run: { claimId: "claim-1", automationName: "Stamp the finish date" } } as const;
const ONLY = "This server writes records only for automations, and for the owner's Undo of their runs.";
const RECORD = derivedRecordId("claim-1/0");
const MAIN: VersionRecord = { id: "main", workspaceId: "workspace-trip", kind: "main", name: "Main", createdAtMs: 1 };

/**
 * A replica's engine over a map of files: a create adopts its record at once,
 * as the engine does for a workspace without capture, and each session
 * records what it journaled and how it ended.
 */
function replicaEngine(options: {
  refuseKeys?: Set<string>; failJournal?: boolean; unsettled?: boolean; beforeJournal?: () => void; beforeVersion?: () => void;
  /** Paths someone deleted: the file is gone, and its document's history stays. */
  deleted?: readonly string[];
} = {}) {
  const files = new Map<string, string>();
  const events: string[] = [];
  const journaled: unknown[] = [];
  const opened: Array<{versionId: string; path: string; expectedObjectId?: string}> = [];
  const writes: unknown[] = [];
  const records = new Map<string, string>();
  const engine: ReplicaRecordEngine = {
    adapter: {
      getActiveVersion: async () => {
        options.beforeVersion?.();
        return MAIN;
      },
      readTextFile: async ({ path }) => {
        const text = files.get(path);
        return text === undefined ? null : { text } as Awaited<ReturnType<ReplicaRecordEngine["adapter"]["readTextFile"]>>;
      },
      writeTextFile: async (input) => {
        writes.push(input);
        if (input.createOnly && files.has(input.path)) throw new VersionedTextStoreError("target-path-exists", `File already exists: ${input.path}`);
        files.set(input.path, input.text);
        const id = /^---\nid: (rec_[a-z2-7]{26})\n/.exec(input.text)?.[1];
        if (id) records.set(id, input.path);
        return {} as Awaited<ReturnType<ReplicaRecordEngine["adapter"]["writeTextFile"]>>;
      },
      getCollectionRecord: async ({ collectionPath, recordId }) => {
        const path = records.get(recordId);
        if (path === undefined) throw new Error("collection-record-not-found");
        return {
          collection: { path: collectionPath, objectId: "collection-tasks", status: "valid", reasons: [] },
          record: { id: recordId, path, conflicted: false, values: [] },
          history: [],
          nextBeforeHistoryId: null,
        };
      },
    },
    async openSession({ path, versionId, expectedObjectId }) {
      opened.push({path, versionId, ...(expectedObjectId === undefined ? {} : {expectedObjectId})});
      expect(versionId).toBe("main");
      if (expectedObjectId !== undefined) expect(expectedObjectId).toBe(`object:${path}`);
      const text = files.get(path);
      const doc = markdownToYDoc(text ?? "");
      events.push(`open ${path}`);
      const session = {
        doc,
        objectId: `object:${path}`,
        head: text === undefined ? "absent" : "present",
        lineage: text === undefined && !options.deleted?.includes(path) ? "absent" : "existing",
        unsettled: options.unsettled ?? false,
        async applyLocalUpdate(update: Uint8Array, applyOptions: unknown) {
          options.beforeJournal?.();
          if (options.failJournal) {
            events.push("journal failed");
            throw new Error("The engine did not answer.");
          }
          Y.applyUpdate(doc, update);
          const key = (applyOptions as { idempotencyKey?: string }).idempotencyKey;
          if (key && options.refuseKeys?.has(key)) {
            events.push("key refused");
            throw new DaemonRefusalError({code: "INVALID_PARAMS", message: "idempotency-key-reuse-mismatch", retry: "no"}, undefined);
          }
          journaled.push(applyOptions);
          events.push("journal");
        },
        async settleNow() {
          files.set(path, yDocToMarkdown(doc));
          events.push("settle");
          return { materialized: true };
        },
        async close() { events.push("close"); },
        async evict() { events.push("evict"); },
      };
      return session as unknown as EngineYdocProviderSession;
    },
  };
  return { engine, files, events, journaled, writes, opened };
}

const replica = (signal = new AbortController().signal) => ({ workspaceId: "workspace-trip", signal });

describe("an automation's record writes on this server's replica", () => {
  it("writes each field as the automation under its key, then settles and closes", async () => {
    const { engine, files, events, journaled } = replicaEngine();
    files.set("Tasks/one.md", `---\nid: ${RECORD}\nStatus: Doing\n---\n`);
    const context = replicaRecordEditContext(replica(), engine, new AbortController().signal);
    await expect(setCollectionRecordFields(context, {
      recordPath: "Tasks/one.md", fields: { Status: "Done" }, author: AUTOMATION, idempotencyKeyPrefix: "claim-1/1/0",
    })).resolves.toEqual({ path: "Tasks/one.md", replaced: { Status: "Doing" }, kept: {} });
    expect(journaled).toEqual([{
      actorOriginId: AUTOMATION.automationId,
      attribution: { actorKind: "automation", onBehalfOf: "owner", depth: 1, run: AUTOMATION.run },
      idempotencyKey: "claim-1/1/0/Status",
      armSettle: false,
    }]);
    expect(events).toEqual(["open Tasks/one.md", "journal", "settle", "close"]);
    expect(files.get("Tasks/one.md")).toContain("Status: Done");
  });

  it("leaves an update the engine did not answer unsettled, and writes nothing more in that session", async () => {
    const { engine, files, events } = replicaEngine({ failJournal: true });
    files.set("Tasks/one.md", `---\nid: ${RECORD}\nStatus: Doing\n---\n`);
    const context = replicaRecordEditContext(replica(), engine, new AbortController().signal);
    await expect(setCollectionRecordFields(context, {
      recordPath: "Tasks/one.md", fields: { Status: "Done", Owner: "Ana" }, author: AUTOMATION, idempotencyKeyPrefix: "claim-1/1/0",
    })).rejects.toThrow(/may have been recorded/);
    expect(events).toEqual(["open Tasks/one.md", "journal failed", "evict"]);
  });

  it("settles what an earlier write left before it writes", async () => {
    const { engine, files, events } = replicaEngine({ unsettled: true });
    files.set("Tasks/one.md", `---\nid: ${RECORD}\nStatus: Done\n---\n`);
    const context = replicaRecordEditContext(replica(), engine, new AbortController().signal);
    await setCollectionRecordFields(context, { recordPath: "Tasks/one.md", fields: { Status: "Done" }, author: AUTOMATION });
    expect(events).toEqual(["open Tasks/one.md", "settle", "close"]);
  });

  it.each([
    ["never existed", []],
    ["someone deleted", ["Tasks/gone.md"]],
  ] as const)("refuses a record that %s, and writes nothing there", async (_case, deleted) => {
    const { engine, events, files } = replicaEngine({ deleted });
    const context = replicaRecordEditContext(replica(), engine, new AbortController().signal);
    await expect(setCollectionRecordFields(context, { recordPath: "Tasks/gone.md", fields: { Status: "Done" }, author: AUTOMATION }))
      .rejects.toThrow("Tasks/gone.md is not a record in this server's copy of the workspace.");
    expect(events).toEqual(["open Tasks/gone.md", "evict"]);
    expect(files.has("Tasks/gone.md")).toBe(false);
  });

  it("creates a record as the automation, and asks again with the same request after a failure", async () => {
    const { engine, writes } = replicaEngine();
    const context = replicaRecordEditContext(replica(), engine, new AbortController().signal);
    const create = () => createCollectionRecord(context, { collectionPath: "Tasks", name: "two", author: AUTOMATION, recordId: RECORD });
    await expect(create()).resolves.toEqual({ path: "Tasks/two.md", recordId: RECORD });
    expect(writes).toEqual([expect.objectContaining({
      workspaceId: "workspace-trip", versionId: "main", path: "Tasks/two.md", text: `---\nid: ${RECORD}\n---\n`, publish: true, createOnly: true,
      author: { kind: AUTOMATION.kind, automationId: AUTOMATION.automationId, onBehalfOf: AUTOMATION.onBehalfOf, depth: AUTOMATION.depth },
      metadata: { origin: "api", summary: "Added two.md" },
    })]);
    // The record exists now, so the same create finds it and writes nothing.
    await expect(create()).resolves.toEqual({ path: "Tasks/two.md", recordId: RECORD });
    expect(writes).toHaveLength(1);
    // A file the engine refused names the same request as the first.
    await expect(context.createFile("Tasks/two.md", `---\nid: ${RECORD}\n---\n`, AUTOMATION)).rejects.toThrow("File already exists");
    expect((writes[1] as { requestId: string }).requestId).toBe((writes[0] as { requestId: string }).requestId);
  });

  it("keeps a cleared creation seed and finishes missing fields after a typed refusal", async () => {
    const refuseKeys = new Set<string>();
    const { engine, files, events, journaled, opened } = replicaEngine({ refuseKeys });
    const context = replicaRecordEditContext(replica(), engine, new AbortController().signal);
    const input = { collectionPath: "Tasks", name: "retry", author: AUTOMATION, recordId: RECORD,
      fields: { Status: "Open" } };
    await expect(createCollectionRecord(context, input)).resolves.toMatchObject({recordId: RECORD});
    // Someone cleared the completed seed; a retry must leave it cleared.
    files.set("Tasks/retry.md", `---\nid: ${RECORD}\n---\n`);
    refuseKeys.add(`create-record/${RECORD}/Status`);
    events.length = 0;
    await expect(createCollectionRecord(context, {...input, fields: {Status: "Open", Owner: "Ana"}}))
      .resolves.toMatchObject({recordId: RECORD, kept: {Status: null}});
    expect(files.get("Tasks/retry.md")).not.toContain("Status:");
    expect(files.get("Tasks/retry.md")).toContain("Owner: Ana");
    expect(journaled).toHaveLength(2);
    expect(opened.at(-1)).toEqual({versionId: "main", path: "Tasks/retry.md", expectedObjectId: "object:Tasks/retry.md"});
    expect(events).toEqual(["open Tasks/retry.md", "key refused", "evict", "open Tasks/retry.md", "journal", "settle", "close"]);
  });

  it("writes records and fields only for automations", async () => {
    const { engine, files, writes, journaled } = replicaEngine();
    files.set("Tasks/one.md", `---\nid: ${RECORD}\nStatus: Doing\n---\n`);
    const context = replicaRecordEditContext(replica(), engine, new AbortController().signal);
    const person = { kind: "user", userId: "owner" } as const;
    await expect(context.createFile("Tasks/two.md", "---\n---\n", person))
      .rejects.toThrow(ONLY);
    await expect(setCollectionRecordFields(context, { recordPath: "Tasks/one.md", fields: { Status: "Done" }, author: person }))
      .rejects.toThrow(ONLY);
    expect(writes).toEqual([]);
    expect(journaled).toEqual([]);
    expect(files.get("Tasks/one.md")).toContain("Status: Doing");
  });

  it("lets the owner's Undo write a record's fields as a person, and nothing else", async () => {
    const { engine, files, writes, journaled } = replicaEngine();
    files.set("Tasks/one.md", `---\nid: ${RECORD}\nStatus: Done\n---\n`);
    const context = replicaRecordEditContext(replica(), engine, new AbortController().signal, true);
    const person = { kind: "user", userId: "local" } as const;
    await expect(context.createFile("Tasks/two.md", "---\n---\n", person)).rejects.toThrow(ONLY);
    // Undo's session takes no automation's writes.
    await expect(context.createFile("Tasks/two.md", `---\nid: ${RECORD}\n---\n`, AUTOMATION)).rejects.toThrow(ONLY);
    await expect(setCollectionRecordFields(context, { recordPath: "Tasks/one.md", fields: { Status: "Doing" }, author: AUTOMATION }))
      .rejects.toThrow(ONLY);
    await setCollectionRecordFields(context, { recordPath: "Tasks/one.md", fields: { Status: "Doing" }, author: person });
    expect(writes).toEqual([]);
    expect(journaled).toHaveLength(1);
  });

  it("writes and settles nothing more once its run ends", async () => {
    const run = new AbortController();
    const { engine, files, events, journaled } = replicaEngine({ beforeJournal: () => run.abort() });
    files.set("Tasks/one.md", `---\nid: ${RECORD}\nStatus: Doing\n---\n`);
    const context = replicaRecordEditContext(replica(), engine, run.signal);
    await expect(setCollectionRecordFields(context, {
      recordPath: "Tasks/one.md", fields: { Status: "Done", Owner: "Ana" }, author: AUTOMATION, idempotencyKeyPrefix: "claim-1/1/0",
    })).rejects.toThrow();
    // The first field was on its way when the run ended; the second never goes.
    expect(journaled).toHaveLength(1);
    expect(events).toEqual(["open Tasks/one.md", "journal", "evict"]);
  });

  it("creates nothing when its run ends while it finds the version", async () => {
    const run = new AbortController();
    const { engine, writes } = replicaEngine({ beforeVersion: () => run.abort() });
    const context = replicaRecordEditContext(replica(), engine, run.signal);
    await expect(context.createFile("Tasks/two.md", `---\nid: ${RECORD}\n---\n`, AUTOMATION)).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it("writes nothing once the replica closes", async () => {
    const { engine, files, events } = replicaEngine();
    files.set("Tasks/one.md", `---\nid: ${RECORD}\nStatus: Doing\n---\n`);
    const closed = new AbortController();
    const context = replicaRecordEditContext(replica(closed.signal), engine, new AbortController().signal);
    closed.abort();
    await expect(setCollectionRecordFields(context, { recordPath: "Tasks/one.md", fields: { Status: "Done" }, author: AUTOMATION }))
      .rejects.toThrow(/no longer active/);
    await expect(context.withAdapter(async () => "read")).resolves.toBeNull();
    expect(events).toEqual([]);
  });
});
