import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions } from "../testing/realDaemonWorkspaceSessions";
import { bridgeAutomationClaimsToExecutors } from "../workspaces/automationClaimsBridge";
import { onWorkspaceCaptureSettled } from "../workspaces/captureActivityBridge";
import { collectionRecordWrites, setCollectionRecordFields, type CollectionRecordEditContext } from "@dohc/automation-executor/collection-record-edits";
import { createRecordByHand, desktopRecordEditContext, type LocalPersonAuthor } from "../workspaces/desktopRecordEdits";
import { deleteWorkspacePathByHand } from "../workspaces/workspaceFileMoves";
import { createLocalChangeAuthor } from "@dohc/workspace-core";
import { createTestScratch } from "../workspaces/testTemp";
import { waitForPathMoments } from "../workspaces/waitForPathMoments";
import { createWorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import { createAutomationFormulaEvaluator } from "@dohc/automation-executor/automation-evaluator-host";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import { applyDocumentEffect, newRun, type CollectionAutomationRunDependencies } from "@dohc/automation-executor/collection-automation-run";
import { derivedRecordId } from "@dohc/automation-executor/record-ids";
import { collectionAutomationId, localIsoTime } from "@dohc/automation-executor/automation-plan";
import { createAutomationRunStore } from "@dohc/automation-executor/automation-run-store";
import { preparedAutomationStoreFolder } from "../testing/preparedLocalState";
import { readLocalStateFrom } from "../workspaces/workspaceLocalState";
import { CollectionAutomations, type CollectionAutomationEngine } from "@dohc/automation-executor/collection-automations";

// A person's change claims an automation in the real engine, and the
// executor runs it: the claim, its field facts, the drain, the formula, and
// the automation's own attributed writes.

const engine = requireEngineBinaryOrSkip();
const sharedEvaluator = createAutomationFormulaEvaluator();
afterAll(() => sharedEvaluator.close());
const evaluator = sharedEvaluator.forWorkspace("collection-automation-e2e");

async function harness(automations: string, run: (context: {
  root: string;
  settled: () => Promise<{ claimId: string; state: string; error?: string }>;
  withEngine: <T>(work: (adapter: CollectionAutomationEngine & VersionedLiveAdapter) => Promise<T>) => Promise<T>;
  personSets: (fields: Record<string, unknown>) => Promise<unknown>;
  /** The engine id of an automation in Tasks, by its id in the file. */
  automationId: (id: string) => Promise<string>;
  /** This signed-out computer's person, as main reads it. */
  person: LocalPersonAuthor;
  /** The desktop's record edit context for a person. */
  recordContext: (person: LocalPersonAuthor, signal: AbortSignal) => CollectionRecordEditContext;
  capture: ReturnType<typeof createWorkspaceEngineCapture>;
  workspace: { workspaceId: string; rootPath: string; attachmentId: symbol };
}) => Promise<void>) {
  const root = await createTestScratch("dohc-collection-automation-e2e-");
  await mkdir(join(root, "Tasks"), { recursive: true });
  await writeFile(join(root, "Tasks", "collection.yaml"),
    "name: Tasks\nfields:\n  Status:\n    type: text\n  Finished on:\n    type: text\n", "utf8");
  await writeFile(join(root, "Tasks", "one.md"), "---\nStatus: Doing\n---\n\nPack the car.\n", "utf8");
  await writeFile(join(root, "Tasks", "automations.yaml"), `version: 1\nautomations:\n${automations}`, "utf8");

  const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
  await lifecycle.start();
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  // Writers of `.dohc/local` ask the engine's open, as the desktop's do.
  readLocalStateFrom(sessions);
  const workspace = { workspaceId: "collection-automation-e2e", rootPath: root, attachmentId: Symbol("collection-automation-e2e") };
  const capture = createWorkspaceEngineCapture({ ...workspace, rustEngineSessions: sessions });
  const settles: Array<{ claimId: string; state: string; error?: string }> = [];
  const waiting: Array<() => void> = [];
  const withEngine = <T>(work: (adapter: CollectionAutomationEngine & VersionedLiveAdapter) => Promise<T>) =>
    sessions.run(workspace, async ({ client, workspace: handle }) => {
      const adapter = new VersionedLiveAdapter(client, handle, { workspaceId: workspace.workspaceId });
      const settle = adapter.settleAutomationClaim.bind(adapter);
      adapter.settleAutomationClaim = async (input) => {
        const result = await settle(input);
        settles.push(input);
        for (const wake of waiting.splice(0)) wake();
        return result;
      };
      return await work(adapter);
    });
  const person: LocalPersonAuthor = { kind: "human", humanId: "local:test" };
  const recordContext = (by: LocalPersonAuthor, signal: AbortSignal): CollectionRecordEditContext => desktopRecordEditContext({
    person: by,
    capture, workspaceRoot: root, signal,
    withAdapter: withEngine,
    onCaptureSettled: (listener) => onWorkspaceCaptureSettled(lifecycle, workspace.workspaceId, listener),
  });
  const editContext = (signal: AbortSignal) => recordContext(person, signal);
  const errors: string[] = [];
  const executor = new CollectionAutomations({
    withEngine,
    // These automations never post.
    chat: { hasMessage: async () => false, directory: async () => null, write: async () => { throw new Error("No chat in this test."); } },
    groupHost: async () => null,
    groupRelayRecord: async () => ({ generation: 0, handover: null }),
    reachRelayRecord: async () => ({ generation: 0, reach: null, everShared: false }),
    groupMessagesSkipped: async () => undefined,
    requestHost: async () => undefined,
    readMessageBody: async () => null,
    postNotice: async () => { throw new Error("No notices in this test."); },
    withRecordWrites: async (signal, work) => await work(collectionRecordWrites(editContext(signal))),
    withUndoWrites: async (signal, work) => await work(collectionRecordWrites(editContext(signal))),
    readText: async (path) => {
      try {
        const text = await readFile(join(root, path), "utf8");
        return { text, truncated: false, contentHash: createHash("sha256").update(text).digest("hex") };
      } catch {
        return null;
      }
    },
    writeText: async () => ({ status: "conflict" }),
    pathExists: (path) => stat(join(root, path)).then(() => true, () => false),
    roster: async () => ({ kind: "owner", ownerUserId: null, grants: [] }),
    cachedRoster: async () => ({ kind: "owner", ownerUserId: null, grants: [] }),
    evaluator,
    store: createAutomationRunStore(preparedAutomationStoreFolder(root)),
    onRunsChanged: () => undefined,
    reportFailure: async () => undefined,
    withdrawFailure: async () => undefined,
    onSwitchedOff: () => undefined,
    onHoldsChanged: () => undefined,
    onAutomationsChanged: () => undefined,
    personName: (userId) => userId,
    mayRetryPress: async () => true,
    onPressSettled: () => undefined,
    onPressWaiting: () => undefined,
    onError: (context, error) => { errors.push(`${context}: ${String(error)}`); },
    withDatasetHost: async () => null,
  });
  const stopBridge = bridgeAutomationClaimsToExecutors(lifecycle, () => executor);
  try {
    for (const path of ["Tasks/collection.yaml", "Tasks/one.md", "Tasks/automations.yaml"]) {
      await waitForPathMoments(capture, path, 1);
    }
    await capture.flush();
    await executor.open();
    let seen = 0;
    await run({
      root,
      withEngine,
      // The next settle this test has not looked at yet.
      settled: async () => {
        while (settles.length <= seen) await new Promise<void>((resolve) => waiting.push(resolve));
        return settles[seen++]!;
      },
      // The person changes the record, as the record view does.
      personSets: (fields) => setCollectionRecordFields(editContext(new AbortController().signal), {
        recordPath: "Tasks/one.md", fields, author: { kind: "user", userId: "owner" },
      }),
      automationId: async (id) => {
        const { collections } = await withEngine((adapter) => adapter.listCollections());
        return collectionAutomationId(collections.find((collection) => collection.path === "Tasks")!.objectId, id);
      },
      person, recordContext, capture, workspace,
    });
    expect(errors).toEqual([]);
  } finally {
    stopBridge();
    await executor.dispose();
    await capture.stop().catch(() => undefined);
    await sessions.closeAll().catch(() => undefined);
    await lifecycle.stop().catch(() => undefined);
  }
}

it.skipIf(engine.missing)(
  "runs a Collection automation for a person's change through the real engine",
  async () => {
    await harness([
      "  - id: stamp",
      "    name: Stamp the finish date",
      "    when: {field-changed: Status, to: Done}",
      "    do: [{set: {Finished on: '=today()'}}]",
      "",
    ].join("\n"), async ({ settled, withEngine, personSets, automationId }) => {
      await personSets({ Status: "Done" });
      await expect(settled()).resolves.toMatchObject({ state: "done" });
      const stamp = await automationId("stamp");

      const record = await withEngine(async (adapter) => {
        const { records } = await adapter.queryCollectionRecords({ collectionPath: "Tasks" });
        return await adapter.getCollectionRecord({ collectionPath: "Tasks", recordId: records[0]!.id, historyLimit: 10 });
      });
      const { claims } = await withEngine((adapter) => adapter.listAutomationClaims({ automationId: stamp }));
      expect(record.record.values.find((value) => value.field === "Finished on")?.value)
        .toBe(localIsoTime(claims[0]!.createdAtMs).slice(0, 10));
      // The automation's write is its own, one step down the chain, so its
      // own subscription does not claim it again.
      expect(record.history.find((entry) => entry.field === "Finished on")).toMatchObject({
        actorKind: "automation", authorOriginId: stamp, depth: 1,
      });
      expect(claims).toHaveLength(1);
    });
  },
  120_000,
);

it.skipIf(engine.missing)(
  "adds a record to its own Collection without triggering itself",
  async () => {
    await harness([
      "  - id: follow-up",
      "    name: Follow up",
      "    when: record-added",
      "    do: [{add-record: {Status: Follow up}}]",
      "  - id: log",
      "    name: Log",
      "    when: {field-changed: Status, to: Done}",
      "    do: [{add-record: {Status: Logged}}]",
      "",
    ].join("\n"), async ({ settled, withEngine, personSets, automationId }) => {
      await personSets({ Status: "Done" });
      const followUp = await automationId("follow-up");
      // Log adds a record, and Follow up runs for it. Follow up's own record
      // is adopted before its claim settles, so any claim it made on itself
      // exists by then.
      const followUpClaims = () => withEngine((adapter) => adapter.listAutomationClaims({ automationId: followUp }));
      for (;;) {
        await expect(settled()).resolves.toMatchObject({ state: "done" });
        if ((await followUpClaims()).claims.some((claim) => claim.state === "done")) break;
      }
      const { records } = await withEngine((adapter) => adapter.queryCollectionRecords({ collectionPath: "Tasks" }));
      expect(records.map((record) => record.values.find((value) => value.field === "Status")?.value).sort())
        .toEqual(["Done", "Follow up", "Logged"]);
      expect((await followUpClaims()).claims).toHaveLength(1);
    });
  },
  120_000,
);

it.skipIf(engine.missing)(
  "gives each step what the steps before it wrote through the real engine: a Find sees a field just set and a record just added",
  async () => {
    await harness([
      "  - id: chain",
      "    name: Chain",
      "    when: {field-changed: Status, to: Done}",
      "    do:",
      "      - set: {Finished on: flagged}",
      "      - find: record[\"Finished on\"] == \"flagged\"",
      "        as: flagged",
      "      - add-record: {Status: '=\"Found \" + flagged.length'}",
      "        as: note",
      "      - find: record.Status == note.Status",
      "        as: notes",
      "      - set: {Finished on: '=\"notes \" + notes.length'}",
      "",
    ].join("\n"), async ({ settled, withEngine, personSets }) => {
      await personSets({ Status: "Done" });
      await expect(settled()).resolves.toMatchObject({ state: "done" });
      const { records } = await withEngine((adapter) => adapter.queryCollectionRecords({ collectionPath: "Tasks" }));
      const fields = records.map((record) => Object.fromEntries(record.values.map(({ field, value }) => [field, value])));
      expect(fields).toEqual(expect.arrayContaining([
        expect.objectContaining({ Status: "Done", "Finished on": "notes 1" }),
        expect.objectContaining({ Status: "Found 1" }),
      ]));
      expect(records).toHaveLength(2);
    });
  },
  120_000,
);

// A person creates a record by hand and deletes it, signed out. Main names the
// installation on both History moments; the renderer's author is a display
// label and names no one.
it.skipIf(engine.missing)(
  "credits a record created and deleted by hand to the signed-out installation in History",
  async () => {
    await harness([
      // Nothing a hand create or delete does matches this, so nothing runs.
      "  - id: idle",
      "    name: Idle",
      "    when: {field-changed: Status, to: Never}",
      "    do: [{set: {Finished on: never}}]",
      "",
    ].join("\n"), async ({ root, withEngine, person, recordContext, capture, workspace }) => {
      const signal = new AbortController().signal;
      const created = await createRecordByHand({ collectionPath: "Tasks", name: "hand" }, {
        author: createLocalChangeAuthor("Someone else"),
        localPerson: async () => person,
        withWorkspaceOperation: async (work) => await work(workspace),
        editContext: async (_operation, by) => recordContext(by, signal),
      });
      if ("kind" in created) throw new Error(`The record was only partly created: ${created.reason}`);
      expect(created).toMatchObject({ path: "Tasks/hand.md", recordId: expect.stringMatching(/^rec_/u) });
      const { records } = await withEngine((adapter) => adapter.queryCollectionRecords({ collectionPath: "Tasks" }));
      expect(records.map((record) => record.path).sort()).toEqual(["Tasks/hand.md", "Tasks/one.md"]);

      const systemTrash = await createTestScratch("dohc-collection-hand-trash-");
      await expect(deleteWorkspacePathByHand({ workspace, assertCurrent: () => undefined }, "Tasks/hand.md", person, {
        capture, requestId: "hand-delete", markDeleted: () => undefined,
        trashItem: async (target) => { await rename(target, join(systemTrash, basename(target))); },
      })).resolves.toMatchObject({ trashed: true, operationId: expect.stringMatching(/^dohc-operation:/), undo: { available: true } });
      expect(await readFile(join(systemTrash, "hand.md"), "utf8")).toContain(created.recordId);
      await expect(stat(join(root, "Tasks", "hand.md"))).rejects.toThrow();

      const installation = [{ kind: "human", humanId: "local:test" }];
      const moments = (await capture.listMoments({ limit: 100 })).moments.filter((moment) => moment.path === "Tasks/hand.md");
      // Newest first: the delete, then whatever adoption recorded, then the
      // creation, each a local file edit by the person.
      expect(moments[0]).toMatchObject({ operation: "delete", metadata: { origin: "local-file" }, authors: installation });
      expect(moments.at(-1)).toMatchObject({ metadata: { origin: "local-file" }, authors: installation });
      expect(moments.at(-1)?.operation).not.toBe("delete");
      // No moment for the record names anyone else.
      for (const moment of moments) {
        expect(moment.authors === undefined || JSON.stringify(moment.authors) === JSON.stringify(installation)).toBe(true);
      }
    });
  },
  120_000,
);

// A run store of its own, in a folder no engine opens.
async function scratchRunStore(prefix: string) {
  const folder = await createTestScratch(prefix);
  return createAutomationRunStore({ forWrite: async () => folder, read: (work) => work(folder) });
}

it.skipIf(engine.missing).each(["deleted", "moved"] as const)(
  "skips replay of a %s creation through the native engine and desktop facade",
  async change => {
    await harness("  - id: idle\n    name: Idle\n    when: {field-changed: Status, to: Never}\n    do: [{set: {Finished on: never}}]\n", async ctx => {
      const parsed = parseAutomationsFile("version: 1\nautomations:\n  - id: replay\n    name: Replay\n    when: record-added\n    do: [{add-record: {Status: New}}]\n");
      if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw Error("invalid automation");
      const automation = parsed.entries[0].automation;
      const signal = new AbortController().signal;
      const run = newRun({ claimId: "creation-replay", automationId: "collection:Tasks#replay" }, automation, "key", 1);
      const author = { kind: "automation" as const, automationId: run.automationId, depth: 1, run: { claimId: run.claimId, automationName: automation.name } };
      const store = await scratchRunStore("dohc-creation-replay-runs-");
      const dependencies = { store, withRecordWrites: async (_signal: AbortSignal, work: Parameters<CollectionAutomationRunDependencies["withRecordWrites"]>[1]) =>
        work(collectionRecordWrites(ctx.recordContext(ctx.person, signal))) } as CollectionAutomationRunDependencies;
      const effect = { kind: "add" as const, collectionPath: "Tasks", name: "made", recordId: derivedRecordId(run.claimId), fields: [] };
      run.steps = [{ ordinal: 0, effects: [effect] }];
      await store.save(run);
      const context = { run, author, signal, ordinal: 0, automationName: automation.name, depth: 1, chat: null };
      expect(await applyDocumentEffect(dependencies, context, effect, "fresh")).toMatchObject([{ kind: "created", path: "Tasks/made.md" }]);
      if (change === "deleted") {
        const trash = await createTestScratch("dohc-replay-trash-");
        await deleteWorkspacePathByHand({ workspace: ctx.workspace, assertCurrent: () => undefined }, "Tasks/made.md", ctx.person, {
          capture: ctx.capture, requestId: "replay-delete", markDeleted: () => undefined,
          trashItem: target => rename(target, join(trash, "made.md")),
        });
      } else {
        await ctx.withEngine(adapter => adapter.renameTextFile({ workspaceId: ctx.workspace.workspaceId, versionId: "main", fromPath: "Tasks/made.md", toPath: "moved.md", metadata: { origin: "api" } }));
        await rename(join(ctx.root, "Tasks/made.md"), join(ctx.root, "moved.md"));
        // A rebased plan can present the same key under a different target path.
        effect.name = "rebased";
      }
      await ctx.capture.flush();
      // Flush covers noticed changes; wait for this path change's projection.
      await expect.poll(async () => {
        const records = (await ctx.withEngine(adapter => adapter.queryCollectionRecords({ collectionPath: "Tasks" }))).records;
        return records.map(record => record.id);
      }, { timeout: 60_000 }).not.toContain(effect.recordId);
      const result = await applyDocumentEffect(dependencies, context, effect, "may-have-landed");
      expect(result).toMatchObject([{ kind: "skipped", reason: "The record was already created, then moved or deleted." }]);
      expect((await ctx.withEngine(adapter => adapter.queryCollectionRecords({ collectionPath: "Tasks" }))).records.map(record => record.path)).toEqual(["Tasks/one.md"]);
      await expect(stat(join(ctx.root, "Tasks", `${effect.name}.md`))).rejects.toThrow();
    });
  }, 120_000,
);

it.skipIf(engine.missing)("finishes a written but unadopted creation on native desktop replay", async () => {
  await harness("  - id: idle\n    name: Idle\n    when: {field-changed: Status, to: Never}\n    do: [{set: {Finished on: never}}]\n", async ctx => {
    const parsed = parseAutomationsFile("version: 1\nautomations:\n  - id: replay\n    name: Replay\n    when: record-added\n    do: [{add-record: {Status: New}}]\n");
    if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw Error("invalid automation");
    const automation = parsed.entries[0].automation, signal = new AbortController().signal;
    const run = newRun({ claimId: "unadopted", automationId: "collection:Tasks#replay" }, automation, "key", 1);
    const author = { kind: "automation" as const, automationId: run.automationId, depth: 1, run: { claimId: run.claimId, automationName: automation.name } };
    const recordId = derivedRecordId(run.claimId), path = "Tasks/made.md";
    const db = new DatabaseSync(join(ctx.root, ".dohc/engine/engine.db"));
    db.exec("PRAGMA busy_timeout=10000");
    db.exec("CREATE TRIGGER block_adoption BEFORE INSERT ON collection_records WHEN NEW.file_path = 'Tasks/made.md' BEGIN SELECT RAISE(FAIL, 'test adoption failure'); END");
    const recordContext = ctx.recordContext(ctx.person, signal);
    let adopting: Promise<void> | undefined;
    try {
      await recordContext.createFile(path, `---\nid: ${recordId}\n---\n`, author);
      expect(await readFile(join(ctx.root, path), "utf8")).toContain(recordId);
      expect((await ctx.withEngine(adapter => adapter.queryCollectionRecords({ collectionPath: "Tasks" }))).records.some(record => record.id === recordId)).toBe(false);
      const subscribe = recordContext.onRecordsChanged;
      recordContext.onRecordsChanged = listener => {
        const unsubscribe = subscribe(listener);
        db.exec("DROP TRIGGER block_adoption");
        adopting = ctx.capture.flush();
        return unsubscribe;
      };
      const store = await scratchRunStore("dohc-unadopted-replay-runs-");
      const effect = { kind: "add" as const, collectionPath: "Tasks", name: "made", recordId, fields: [{ field: "Status", value: "New" }] };
      run.steps = [{ ordinal: 0, effects: [effect] }]; await store.save(run);
      const dependencies = { store, withRecordWrites: async (_signal: AbortSignal, work: Parameters<CollectionAutomationRunDependencies["withRecordWrites"]>[1]) =>
        work(collectionRecordWrites(recordContext)) } as CollectionAutomationRunDependencies;
      const result = await applyDocumentEffect(dependencies, { run, author, signal, ordinal: 0, automationName: automation.name, depth: 1, chat: null }, effect, "may-have-landed");
      expect(adopting).toBeDefined(); await adopting;
      expect(result).toMatchObject([{ kind: "created", recordId, path }, { kind: "field", field: "Status", after: "New" }]);
      expect(run.created).toMatchObject([{ recordId, path }]);
      expect((await ctx.withEngine(adapter => adapter.getCollectionRecord({ collectionPath: "Tasks", recordId, historyLimit: 1 }))).record.values).toContainEqual(expect.objectContaining({ field: "Status", value: "New" }));
    } finally { db.exec("DROP TRIGGER IF EXISTS block_adoption"); db.close(); }
  });
}, 120_000);
