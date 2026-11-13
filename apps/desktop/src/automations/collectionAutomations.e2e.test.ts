import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import {
  createRealDaemonLifecycle,
  createRealDaemonWorkspaceSessions,
} from "../testing/realDaemonWorkspaceSessions";
import { bridgeAutomationClaimsToExecutors } from "../workspaces/automationClaimsBridge";
import { onWorkspaceCaptureSettled } from "../workspaces/captureActivityBridge";
import {
  collectionRecordWrites,
  setCollectionRecordFields,
  type CollectionRecordEditContext,
} from "@dohc/automation-executor/collection-record-edits";
import { desktopRecordEditContext, type LocalPersonAuthor } from "../workspaces/desktopRecordEdits";
import { createTestScratch } from "../workspaces/testTemp";
import { waitForPathMoments } from "../workspaces/waitForPathMoments";
import { createWorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import { createAutomationFormulaEvaluator } from "@dohc/automation-executor/automation-evaluator-host";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import {
  applyDocumentEffect,
  newRun,
  type CollectionAutomationRunDependencies,
} from "@dohc/automation-executor/collection-automation-run";
import { derivedRecordId } from "@dohc/automation-executor/record-ids";
import { createAutomationRunStore } from "@dohc/automation-executor/automation-run-store";
import { preparedAutomationStoreFolder } from "../testing/preparedLocalState";
import { readLocalStateFrom } from "../workspaces/workspaceLocalState";
import {
  CollectionAutomations,
  type CollectionAutomationEngine,
} from "@dohc/automation-executor/collection-automations";

// A person's change claims an automation in the real engine, and the
// executor runs it: the claim, its field facts, the drain, the formula, and
// the automation's own attributed writes.

const engine = requireEngineBinaryOrSkip();
const sharedEvaluator = createAutomationFormulaEvaluator();
afterAll(() => sharedEvaluator.close());
const evaluator = sharedEvaluator.forWorkspace("collection-automation-e2e");

async function harness(
  automations: string,
  run: (context: {
    root: string;
    settled: () => Promise<{ claimId: string; state: string; error?: string }>;
    withEngine: <T>(
      work: (adapter: CollectionAutomationEngine & VersionedLiveAdapter) => Promise<T>,
    ) => Promise<T>;
    personSets: (fields: Record<string, unknown>) => Promise<unknown>;
    /** This signed-out computer's person, as main reads it. */
    person: LocalPersonAuthor;
    /** The desktop's record edit context for a person. */
    recordContext: (person: LocalPersonAuthor, signal: AbortSignal) => CollectionRecordEditContext;
    capture: ReturnType<typeof createWorkspaceEngineCapture>;
    workspace: { workspaceId: string; rootPath: string; attachmentId: symbol };
  }) => Promise<void>,
) {
  const root = await createTestScratch("dohc-collection-automation-e2e-");
  await mkdir(join(root, "Tasks"), { recursive: true });
  await writeFile(
    join(root, "Tasks", "collection.yaml"),
    "name: Tasks\nfields:\n  Status:\n    type: text\n  Finished on:\n    type: text\n",
    "utf8",
  );
  await writeFile(
    join(root, "Tasks", "one.md"),
    "---\nStatus: Doing\n---\n\nPack the car.\n",
    "utf8",
  );
  await writeFile(
    join(root, "Tasks", "automations.yaml"),
    `version: 1\nautomations:\n${automations}`,
    "utf8",
  );

  const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
  await lifecycle.start();
  const sessions = createRealDaemonWorkspaceSessions(lifecycle);
  // Writers of `.dohc/local` ask the engine's open, as the desktop's do.
  readLocalStateFrom(sessions);
  const workspace = {
    workspaceId: "collection-automation-e2e",
    rootPath: root,
    attachmentId: Symbol("collection-automation-e2e"),
  };
  const capture = createWorkspaceEngineCapture({ ...workspace, rustEngineSessions: sessions });
  const settles: Array<{ claimId: string; state: string; error?: string }> = [];
  const waiting: Array<() => void> = [];
  const withEngine = <T>(
    work: (adapter: CollectionAutomationEngine & VersionedLiveAdapter) => Promise<T>,
  ) =>
    sessions.run(workspace, async ({ client, workspace: handle }) => {
      const adapter = new VersionedLiveAdapter(client, handle, {
        workspaceId: workspace.workspaceId,
      });
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
  const recordContext = (by: LocalPersonAuthor, signal: AbortSignal): CollectionRecordEditContext =>
    desktopRecordEditContext({
      person: by,
      capture,
      workspaceRoot: root,
      signal,
      withAdapter: withEngine,
      onCaptureSettled: (listener) =>
        onWorkspaceCaptureSettled(lifecycle, workspace.workspaceId, listener),
    });
  const editContext = (signal: AbortSignal) => recordContext(person, signal);
  const errors: string[] = [];
  const executor = new CollectionAutomations({
    withEngine,
    // These automations never post.
    chat: {
      hasMessage: async () => false,
      directory: async () => null,
      write: async () => {
        throw new Error("No chat in this test.");
      },
    },
    groupHost: async () => null,
    groupRelayRecord: async () => ({ generation: 0, handover: null }),
    reachRelayRecord: async () => ({ generation: 0, reach: null, everShared: false }),
    groupMessagesSkipped: async () => undefined,
    requestHost: async () => undefined,
    readMessageBody: async () => null,
    postNotice: async () => {
      throw new Error("No notices in this test.");
    },
    withRecordWrites: async (signal, work) =>
      await work(collectionRecordWrites(editContext(signal))),
    withUndoWrites: async (signal, work) => await work(collectionRecordWrites(editContext(signal))),
    readText: async (path) => {
      try {
        const text = await readFile(join(root, path), "utf8");
        return {
          text,
          truncated: false,
          contentHash: createHash("sha256").update(text).digest("hex"),
        };
      } catch {
        return null;
      }
    },
    writeText: async () => ({ status: "conflict" }),
    pathExists: (path) =>
      stat(join(root, path)).then(
        () => true,
        () => false,
      ),
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
    onError: (context, error) => {
      errors.push(`${context}: ${String(error)}`);
    },
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
      personSets: (fields) =>
        setCollectionRecordFields(editContext(new AbortController().signal), {
          recordPath: "Tasks/one.md",
          fields,
          author: { kind: "user", userId: "owner" },
        }),
      person,
      recordContext,
      capture,
      workspace,
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
  "gives each step what the steps before it wrote through the real engine: a Find sees a field just set and a record just added",
  async () => {
    await harness(
      [
        "  - id: chain",
        "    name: Chain",
        "    when: {field-changed: Status, to: Done}",
        "    do:",
        "      - set: {Finished on: flagged}",
        '      - find: record["Finished on"] == "flagged"',
        "        as: flagged",
        "      - add-record: {Status: '=\"Found \" + flagged.length'}",
        "        as: note",
        "      - find: record.Status == note.Status",
        "        as: notes",
        "      - set: {Finished on: '=\"notes \" + notes.length'}",
        "",
      ].join("\n"),
      async ({ settled, withEngine, personSets }) => {
        await personSets({ Status: "Done" });
        expect(await settled()).toEqual({ claimId: expect.any(String), state: "done" });
        const { records } = await withEngine((adapter) =>
          adapter.queryCollectionRecords({ collectionPath: "Tasks" }),
        );
        const fields = records.map((record) =>
          Object.fromEntries(record.values.map(({ field, value }) => [field, value])),
        );
        expect(fields).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ Status: "Done", "Finished on": "notes 1" }),
            expect.objectContaining({ Status: "Found 1" }),
          ]),
        );
        expect(records).toHaveLength(2);
      },
    );
  },
  120_000,
);

// A run store of its own, in a folder no engine opens.
async function scratchRunStore(prefix: string) {
  const folder = await createTestScratch(prefix);
  return createAutomationRunStore({ forWrite: async () => folder, read: (work) => work(folder) });
}

it.skipIf(engine.missing)(
  "finishes a written but unadopted creation on native desktop replay",
  async () => {
    await harness(
      "  - id: idle\n    name: Idle\n    when: {field-changed: Status, to: Never}\n    do: [{set: {Finished on: never}}]\n",
      async (ctx) => {
        const parsed = parseAutomationsFile(
          "version: 1\nautomations:\n  - id: replay\n    name: Replay\n    when: record-added\n    do: [{add-record: {Status: New}}]\n",
        );
        if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid")
          throw Error("invalid automation");
        const automation = parsed.entries[0].automation,
          signal = new AbortController().signal;
        const run = newRun(
          { claimId: "unadopted", automationId: "collection:Tasks#replay" },
          automation,
          "key",
          1,
        );
        const author = {
          kind: "automation" as const,
          automationId: run.automationId,
          depth: 1,
          run: { claimId: run.claimId, automationName: automation.name },
        };
        const recordId = derivedRecordId(run.claimId),
          path = "Tasks/made.md";
        const db = new DatabaseSync(join(ctx.root, ".dohc/engine/engine.db"));
        db.exec("PRAGMA busy_timeout=10000");
        db.exec(
          "CREATE TRIGGER block_adoption BEFORE INSERT ON collection_records WHEN NEW.file_path = 'Tasks/made.md' BEGIN SELECT RAISE(FAIL, 'test adoption failure'); END",
        );
        const recordContext = ctx.recordContext(ctx.person, signal);
        let adopting: Promise<void> | undefined;
        try {
          await recordContext.createFile(path, `---\nid: ${recordId}\n---\n`, author);
          expect(await readFile(join(ctx.root, path), "utf8")).toContain(recordId);
          expect(
            (
              await ctx.withEngine((adapter) =>
                adapter.queryCollectionRecords({ collectionPath: "Tasks" }),
              )
            ).records.some((record) => record.id === recordId),
          ).toBe(false);
          const subscribe = recordContext.onRecordsChanged;
          recordContext.onRecordsChanged = (listener) => {
            const unsubscribe = subscribe(listener);
            db.exec("DROP TRIGGER block_adoption");
            adopting = ctx.capture.flush();
            return unsubscribe;
          };
          const store = await scratchRunStore("dohc-unadopted-replay-runs-");
          const effect = {
            kind: "add" as const,
            collectionPath: "Tasks",
            name: "made",
            recordId,
            fields: [{ field: "Status", value: "New" }],
          };
          run.steps = [{ ordinal: 0, effects: [effect] }];
          await store.save(run);
          const dependencies = {
            store,
            withRecordWrites: async (
              _signal: AbortSignal,
              work: Parameters<CollectionAutomationRunDependencies["withRecordWrites"]>[1],
            ) => work(collectionRecordWrites(recordContext)),
          } as CollectionAutomationRunDependencies;
          const result = await applyDocumentEffect(
            dependencies,
            {
              run,
              author,
              signal,
              ordinal: 0,
              automationName: automation.name,
              depth: 1,
              chat: null,
            },
            effect,
            "may-have-landed",
          );
          expect(adopting).toBeDefined();
          await adopting;
          expect(result).toMatchObject([
            { kind: "created", recordId, path },
            { kind: "field", field: "Status", after: "New" },
          ]);
          expect(run.created).toMatchObject([{ recordId, path }]);
          expect(
            (
              await ctx.withEngine((adapter) =>
                adapter.getCollectionRecord({ collectionPath: "Tasks", recordId, historyLimit: 1 }),
              )
            ).record.values,
          ).toContainEqual(expect.objectContaining({ field: "Status", value: "New" }));
        } finally {
          db.exec("DROP TRIGGER IF EXISTS block_adoption");
          db.close();
        }
      },
    );
  },
  120_000,
);
