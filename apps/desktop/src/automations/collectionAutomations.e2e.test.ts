import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions } from "../testing/realDaemonWorkspaceSessions";
import { bridgeAutomationClaimsToExecutors } from "../workspaces/automationClaimsBridge";
import { onWorkspaceCaptureSettled } from "../workspaces/captureActivityBridge";
import { collectionRecordWrites, setCollectionRecordFields, type CollectionRecordEditContext } from "../workspaces/collectionRecordEdits";
import { createTestScratch } from "../workspaces/testTemp";
import { resolveWorkspaceMetadataDir } from "../workspaces/workspaceMetadata";
import { waitForPathMoments } from "../workspaces/waitForPathMoments";
import { createWorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import { createAutomationFormulaEvaluator } from "@dohc/automation-executor/automation-evaluator-host";
import { localIsoTime } from "@dohc/automation-executor/automation-plan";
import { createAutomationRunStore } from "@dohc/automation-executor/automation-run-store";
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
  const editContext = (signal: AbortSignal): CollectionRecordEditContext => ({
    capture, workspaceRoot: root, signal,
    withAdapter: withEngine,
    onCaptureSettled: (listener) => onWorkspaceCaptureSettled(lifecycle, workspace.workspaceId, listener),
  });
  const errors: string[] = [];
  const executor = new CollectionAutomations({
    withEngine,
    // These automations never post.
    chat: { directory: async () => null, write: async () => { throw new Error("No chat in this test."); } },
    groupHost: async () => null,
    groupRelayRecord: async () => ({ generation: 0, handover: null }),
    groupMessagesSkipped: async () => undefined,
    requestHost: async () => undefined,
    readMessageBody: async () => null,
    postNotice: async () => { throw new Error("No notices in this test."); },
    withRecordWrites: async (signal, work) => await work(collectionRecordWrites(editContext(signal))),
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
    store: createAutomationRunStore(root, resolveWorkspaceMetadataDir),
    onFailuresChanged: () => undefined,
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
    ].join("\n"), async ({ settled, withEngine, personSets }) => {
      await personSets({ Status: "Done" });
      await expect(settled()).resolves.toMatchObject({ state: "done" });

      const record = await withEngine(async (adapter) => {
        const { records } = await adapter.queryCollectionRecords({ collectionPath: "Tasks" });
        return await adapter.getCollectionRecord({ collectionPath: "Tasks", recordId: records[0]!.id, historyLimit: 10 });
      });
      const { claims } = await withEngine((adapter) => adapter.listAutomationClaims({ automationId: "collection:Tasks#stamp" }));
      expect(record.record.values.find((value) => value.field === "Finished on")?.value)
        .toBe(localIsoTime(claims[0]!.createdAtMs).slice(0, 10));
      // The automation's write is its own, one step down the chain, so its
      // own subscription does not claim it again.
      expect(record.history.find((entry) => entry.field === "Finished on")).toMatchObject({
        actorKind: "automation", authorOriginId: "collection:Tasks#stamp", depth: 1,
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
    ].join("\n"), async ({ settled, withEngine, personSets }) => {
      await personSets({ Status: "Done" });
      // Log adds a record, and Follow up runs for it. Follow up's own record
      // is adopted before its claim settles, so any claim it made on itself
      // exists by then.
      const followUpClaims = () => withEngine((adapter) => adapter.listAutomationClaims({ automationId: "collection:Tasks#follow-up" }));
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
