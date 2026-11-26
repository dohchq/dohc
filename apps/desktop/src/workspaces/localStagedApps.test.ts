import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JournalError } from "@dohc/app-backend-runtime/journal";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { compileClosedApp } from "./closedAppCompiler";
import { createLocalDatasetHost, type LocalDatasetHost } from "./localDatasetHost";
import { createLocalStagedApps } from "./localStagedApps";
import { createDatasetAuthorityRouter, createRemoteDatasetData } from "./remoteDataset";
import { createLocalOwnerAppPublicationHandler } from "../ipc/localOwnerAppPublication";
import { openedLocalState } from "../testing/preparedLocalState";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";
import { unguardedCollections } from "../testing/collectionsHolder";

const EXAMPLE_ROOT = resolve(import.meta.dirname, "../../../../examples/personal-control-tower");
const compileFixture = createDatasetFixtureCompiler();

const roots: string[] = [];
const hosts: LocalDatasetHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function loadControlTowerFiles(): Promise<Map<string, string>> {
  const relPaths = [
    "app.publish.json",
    "index.tsx",
    "expenses/dataset.json",
    "expenses/schema.sql",
    "expenses/operations.js",
    "workouts/dataset.json",
    "workouts/schema.sql",
    "workouts/operations.js",
  ];
  const entries = await Promise.all(
    relPaths.map(
      async (rel) =>
        [`personal-control-tower/${rel}`, await readFile(join(EXAMPLE_ROOT, rel), "utf8")] as const,
    ),
  );
  return new Map(entries);
}

async function openFixture(overrides?: {
  workspaceRoot?: string;
  onBeforeApproveCreate?: (revisionSha256: string) => void | Promise<void>;
  onBeforePrepareMigration?: (datasetId: string) => void | Promise<void>;
  onBeforeApproveMigration?: (datasetId: string) => void | Promise<void>;
  onAfterApproveMigration?: (datasetId: string) => void | Promise<void>;
  onEnterExclusiveDatasets?: () => void;
  onTryApprovedArtifacts?: (datasetId: string) => void;
}) {
  const workspaceRoot =
    overrides?.workspaceRoot ?? (await mkdtemp(join(tmpdir(), "dohc-staged-apps-")));
  if (!overrides?.workspaceRoot) {
    roots.push(workspaceRoot);
    await openedLocalState({ workspaceId: "w", rootPath: workspaceRoot });
  }
  const host = await createLocalDatasetHost({
    localPersonId: () => "person-local",
    workspaceId: "w",
    workspaceRoot,
    capacityBytes: 4 * 1024 * 1024,
    compile: compileFixture,
    holder: unguardedCollections,
  });
  hosts.push(host);
  const staged = createLocalStagedApps({
    workspaceId: "w",
    workspaceRoot,
    assertCurrent() {},
    compile: compileClosedApp,
    preflightCreate: (input) => host.preflightCreate(input),
    tryApprovedArtifacts: async (datasetId) => {
      overrides?.onTryApprovedArtifacts?.(datasetId);
      try {
        return host.approvedArtifacts(datasetId);
      } catch (error) {
        if (
          error instanceof JournalError &&
          error.code === "conflict" &&
          error.message === "This Collection is not set up yet."
        )
          return null;
        throw error;
      }
    },
    prepareCreate: (input) => host.prepare(input),
    approveCreate: async (input) => {
      await overrides?.onBeforeApproveCreate?.(input.revisionSha256);
      return host.approve(input);
    },
    discardCreate: (id) => host.discard(id),
    prepareMigrationCandidate: async (input) => {
      await overrides?.onBeforePrepareMigration?.(input.revision.datasetId);
      return host.prepareMigrationCandidate(input);
    },
    approveMigrationCandidate: async (input) => {
      await overrides?.onBeforeApproveMigration?.(input.datasetId);
      const migrated = await host.approveMigrationCandidate(input);
      await overrides?.onAfterApproveMigration?.(input.datasetId);
      return migrated;
    },
    discardMigrationCandidate: (input) => host.discardMigrationCandidate(input),
    activateApp: (prepared, signal, agent) => host.apps.activate(prepared, signal, agent),
    withExclusiveDatasets: (datasetIds, signal, work) => {
      overrides?.onEnterExclusiveDatasets?.();
      return host.withExclusiveDatasets(datasetIds, signal, (exclusive) =>
        work({
          approveCreate: async (input) => {
            await overrides?.onBeforeApproveCreate?.(input.revisionSha256);
            return exclusive.approve(input);
          },
          approveMigrationCandidate: async (input) => {
            await overrides?.onBeforeApproveMigration?.(input.datasetId);
            const migrated = await exclusive.approveMigrationCandidate(input);
            await overrides?.onAfterApproveMigration?.(input.datasetId);
            return migrated;
          },
        }),
      );
    },
  });
  return { workspaceRoot, host, staged };
}

describe("localStagedApps", () => {
  it("stages the two-Collection Personal Control Tower under .dohc/local/, approves in one action, and executes live reads and writes", async () => {
    const { workspaceRoot, host, staged } = await openFixture();
    const files = await loadControlTowerFiles();
    const signal = new AbortController().signal;

    const summary = await staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
    });

    expect(await readdir(workspaceRoot)).toEqual([".dohc"]);
    const stageDirs = await readdir(join(workspaceRoot, ".dohc", "local", "staged-apps"));
    expect(stageDirs).toEqual([summary.stageId]);

    expect(summary.appRoot).toBe("personal-control-tower");
    expect(summary.collections).toHaveLength(2);
    expect(summary.collections.map((c) => c.name).sort()).toEqual(["Expenses", "Workouts"]);
    expect(summary.collections.every((c) => c.action === "create" && !c.applied)).toBe(true);
    expect(summary.capabilities).toHaveLength(2);
    expect(host.list().datasets).toHaveLength(0);

    files.set(
      "personal-control-tower/expenses/operations.js",
      "globalThis.operations = { listExpenses() { return ['TAMPERED']; } };",
    );

    await expect(
      staged.approve({ stageId: summary.stageId, reviewDigest: "0".repeat(64), signal }),
    ).rejects.toThrow(/changed or expired/i);
    expect(host.list().datasets).toHaveLength(0);

    const approved = await staged.approve({
      stageId: summary.stageId,
      reviewDigest: summary.reviewDigest,
      signal,
    });
    expect(approved.collectionsApplied).toHaveLength(2);
    expect(host.list().datasets).toHaveLength(2);
    expect(await staged.list()).toEqual([]);

    await host.apps.request(approved.publicationId, "invoke", {
      authorityRevision: approved.authorityRevision,
      dataset: "expenses",
      operation: "addExpense",
      idempotencyKey: "exp-1",
      input: {
        date: "2026-11-23",
        merchant: "Blue Bottle",
        category: "Food",
        amount: 6.5,
        note: "Cortado",
      },
    });
    await host.apps.request(approved.publicationId, "invoke", {
      authorityRevision: approved.authorityRevision,
      dataset: "workouts",
      operation: "logWorkout",
      idempotencyKey: "wrk-1",
      input: {
        date: "2026-11-23",
        activity: "Morning 5K",
        minutes: 28,
        effort: "Moderate",
        notes: "Tempo run",
      },
    });

    const expList = (await host.apps.request(approved.publicationId, "invoke", {
      authorityRevision: approved.authorityRevision,
      dataset: "expenses",
      operation: "listExpenses",
      idempotencyKey: "exp-list",
      input: {},
    })) as { result: Array<{ merchant: string; amount: number }> };
    const wrkList = (await host.apps.request(approved.publicationId, "invoke", {
      authorityRevision: approved.authorityRevision,
      dataset: "workouts",
      operation: "listWorkouts",
      idempotencyKey: "wrk-list",
      input: {},
    })) as { result: Array<{ activity: string; minutes: number }> };

    expect(expList.result).toEqual([
      expect.objectContaining({ merchant: "Blue Bottle", amount: 6.5 }),
    ]);
    expect(wrkList.result).toEqual([
      expect.objectContaining({ activity: "Morning 5K", minutes: 28 }),
    ]);

    const updatedFiles = await loadControlTowerFiles();
    updatedFiles.set(
      "personal-control-tower/expenses/operations.js",
      updatedFiles
        .get("personal-control-tower/expenses/operations.js")!
        .replace("LIMIT 200", "LIMIT 100"),
    );
    const secondStage = await staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(updatedFiles),
      signal,
    });
    const expStep = secondStage.collections.find((c) => c.alias === "expenses")!;
    const wrkStep = secondStage.collections.find((c) => c.alias === "workouts")!;
    expect(expStep.action).toBe("migrate");
    expect(expStep.migrationPath).toBeNull();
    expect(expStep.changes?.some((c) => c.summary.includes("code"))).toBe(true);
    expect(wrkStep.action).toBe("unchanged");

    const secondApproved = await staged.approve({
      stageId: secondStage.stageId,
      reviewDigest: secondStage.reviewDigest,
      signal,
    });
    expect(secondApproved.collectionsApplied).toHaveLength(1);
    expect(secondApproved.collectionsApplied[0]).toMatchObject({ action: "migrate", revision: 2 });

    const expAfter = (await host.apps.request(secondApproved.publicationId, "invoke", {
      authorityRevision: secondApproved.authorityRevision,
      dataset: "expenses",
      operation: "listExpenses",
      idempotencyKey: "exp-list-after",
      input: {},
    })) as { result: Array<{ merchant: string }> };
    expect(expAfter.result).toEqual([expect.objectContaining({ merchant: "Blue Bottle" })]);

    const schemaChangedFiles = new Map(updatedFiles);
    schemaChangedFiles.set(
      "personal-control-tower/expenses/schema.sql",
      `${updatedFiles.get("personal-control-tower/expenses/schema.sql")!}\n-- altered\n`,
    );
    await expect(
      staged.stage({
        appRoot: "personal-control-tower",
        deferredWrites: [],
        adapter: sourceCaptureAdapter(schemaChangedFiles),
        signal,
      }),
    ).rejects.toThrow(/Provide a migration file/i);
  }, 60_000);

  it("preflights every Collection and compiles the app before saving any staged proposal", async () => {
    const { staged, host } = await openFixture();
    const signal = new AbortController().signal;

    const badAppFiles = await loadControlTowerFiles();
    badAppFiles.set("personal-control-tower/index.tsx", "export const broken = <div;");
    await expect(
      staged.stage({
        appRoot: "personal-control-tower",
        deferredWrites: [],
        adapter: sourceCaptureAdapter(badAppFiles),
        signal,
      }),
    ).rejects.toThrow();
    expect(await staged.list()).toEqual([]);
    expect(host.list().datasets).toHaveLength(0);

    const badSchemaFiles = await loadControlTowerFiles();
    badSchemaFiles.set("personal-control-tower/workouts/schema.sql", "CREATE BROKEN TABLE (;");
    await expect(
      staged.stage({
        appRoot: "personal-control-tower",
        deferredWrites: [],
        adapter: sourceCaptureAdapter(badSchemaFiles),
        signal,
      }),
    ).rejects.toThrow();
    expect(await staged.list()).toEqual([]);
    expect(host.list().datasets).toHaveLength(0);
  }, 60_000);

  it("records durable per-step receipts for crash-safe idempotent resume and supports discard", async () => {
    let calls = 0;
    const { workspaceRoot, staged, host } = await openFixture({
      onBeforeApproveCreate: () => {
        calls += 1;
        if (calls === 2) throw new Error("Simulated crash before second Collection.");
      },
    });
    const files = await loadControlTowerFiles();
    const signal = new AbortController().signal;

    const summary = await staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
    });

    await expect(
      staged.approve({ stageId: summary.stageId, reviewDigest: summary.reviewDigest, signal }),
    ).rejects.toThrow(/Simulated crash/);

    const [pending] = await staged.list("personal-control-tower");
    expect(pending).toBeDefined();
    expect(pending!.collections.filter((c) => c.applied)).toHaveLength(1);
    expect(pending!.collections.filter((c) => !c.applied)).toHaveLength(1);
    expect(host.list().datasets).toHaveLength(1);

    await host.close();
    const reopened = await openFixture({ workspaceRoot });
    const [reopenedPending] = await reopened.staged.list("personal-control-tower");
    expect(reopenedPending?.collections.filter((c) => c.applied)).toHaveLength(1);

    const resumed = await reopened.staged.approve({
      stageId: summary.stageId,
      reviewDigest: summary.reviewDigest,
      signal,
    });
    expect(resumed.collectionsApplied).toHaveLength(2);
    expect(reopened.host.list().datasets).toHaveLength(2);
    expect(await reopened.staged.list()).toEqual([]);

    const third = await reopened.staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
    });
    expect(await reopened.staged.list()).toHaveLength(1);
    await reopened.staged.discard(third.stageId);
    expect(await reopened.staged.list()).toEqual([]);
  }, 60_000);

  it("refuses a stale second Collection before committing the first so the active app stays live", async () => {
    const { host, staged } = await openFixture();
    const files = await loadControlTowerFiles();
    const signal = new AbortController().signal;

    const initialStage = await staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
    });
    const initialApproved = await staged.approve({
      stageId: initialStage.stageId,
      reviewDigest: initialStage.reviewDigest,
      signal,
    });
    const expensesCol = initialStage.collections.find((c) => c.alias === "expenses")!;
    const workoutsCol = initialStage.collections.find((c) => c.alias === "workouts")!;

    const updatedFiles = new Map(files);
    updatedFiles.set(
      "personal-control-tower/expenses/operations.js",
      `${files.get("personal-control-tower/expenses/operations.js")!}\n// expense v2\n`,
    );
    updatedFiles.set(
      "personal-control-tower/workouts/operations.js",
      `${files.get("personal-control-tower/workouts/operations.js")!}\n// workout v2\n`,
    );
    const updateStage = await staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(updatedFiles),
      signal,
    });

    await host.apps.request(initialApproved.publicationId, "invoke", {
      authorityRevision: initialApproved.authorityRevision,
      dataset: "workouts",
      operation: "logWorkout",
      idempotencyKey: "wrk-stale",
      input: {
        date: "2026-11-23",
        activity: "Run",
        minutes: 20,
        effort: "Easy",
        notes: "",
      },
    });

    await expect(
      staged.approve({
        stageId: updateStage.stageId,
        reviewDigest: updateStage.reviewDigest,
        signal,
      }),
    ).rejects.toThrow(/changed after staging/i);

    expect(host.approvedArtifacts(expensesCol.datasetId).revision.revision).toBe(1);
    expect(host.approvedArtifacts(workoutsCol.datasetId).revision.revision).toBe(1);
    expect(host.apps.list("personal-control-tower", "main").some((p) => p.active)).toBe(true);
  }, 60_000);

  it("refuses discard while an approval is in progress so receipts and Collections stay consistent", async () => {
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let seen = 0;
    const { host, staged } = await openFixture({
      onBeforeApproveCreate: async () => {
        seen += 1;
        if (seen === 1) {
          enteredFirst();
          await gate;
        }
      },
    });
    const files = await loadControlTowerFiles();
    const signal = new AbortController().signal;

    const summary = await staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
    });

    const approving = staged.approve({
      stageId: summary.stageId,
      reviewDigest: summary.reviewDigest,
      signal,
    });
    let result!: Awaited<typeof approving>;
    try {
      await firstEntered;

      await expect(staged.discard(summary.stageId)).rejects.toThrow(/currently being approved/i);
      await expect(staged.discard(summary.stageId.toUpperCase())).rejects.toThrow(
        /currently being approved/i,
      );
      await expect(
        staged.approve({
          stageId: summary.stageId,
          reviewDigest: summary.reviewDigest,
          signal,
        }),
      ).rejects.toThrow(/already being approved/i);
      await expect(
        staged.stage({
          appRoot: "personal-control-tower",
          deferredWrites: [],
          adapter: sourceCaptureAdapter(files),
          signal,
        }),
      ).rejects.toThrow(/currently being approved/i);
    } finally {
      releaseFirst();
      result = await approving.catch(() => ({
        stageId: "",
        publicationId: "",
        authorityRevision: 0,
        collectionsApplied: [],
      }));
    }
    expect(result.collectionsApplied).toHaveLength(2);
    expect(host.list().datasets).toHaveLength(2);
    expect(host.apps.list("personal-control-tower", "main").some((p) => p.active)).toBe(true);
    expect(await staged.list()).toEqual([]);
  }, 60_000);

  it("refuses approval retry before further writes when a receipted Collection was archived", async () => {
    let calls = 0;
    const { host, staged } = await openFixture({
      onBeforeApproveCreate: () => {
        calls += 1;
        if (calls === 2) throw new Error("Simulated crash before second Collection.");
      },
    });
    const files = await loadControlTowerFiles();
    const signal = new AbortController().signal;

    const summary = await staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
    });
    await expect(
      staged.approve({ stageId: summary.stageId, reviewDigest: summary.reviewDigest, signal }),
    ).rejects.toThrow(/Simulated crash/);

    const created = host.list().datasets;
    expect(created).toHaveLength(1);
    host.archive({ datasetId: created[0]!.datasetId });

    await expect(
      staged.approve({ stageId: summary.stageId, reviewDigest: summary.reviewDigest, signal }),
    ).rejects.toThrow(/changed or is unavailable/i);
    expect(host.list({ includeArchived: true }).datasets).toHaveLength(1);
  }, 60_000);

  it("blocks concurrent live writes during staged migration approval so active apps stay consistent", async () => {
    let concurrentWriteError: unknown = null;
    let initialPublicationId = "";
    let initialAuthorityRevision = 0;
    let duringApprove = false;
    let injected = false;
    let hostRef!: LocalDatasetHost;
    const { host, staged } = await openFixture({
      onBeforePrepareMigration: async () => {
        if (!duringApprove || injected) return;
        injected = true;
        try {
          await hostRef.apps.request(initialPublicationId, "invoke", {
            authorityRevision: initialAuthorityRevision,
            dataset: "workouts",
            operation: "logWorkout",
            idempotencyKey: "wrk-during-approval",
            input: {
              date: "2026-11-23",
              activity: "Sprint",
              minutes: 15,
              effort: "Hard",
              notes: "",
            },
          });
        } catch (error) {
          concurrentWriteError = error;
        }
      },
    });
    hostRef = host;
    const files = await loadControlTowerFiles();
    const signal = new AbortController().signal;

    const initialStage = await staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
    });
    const initialApproved = await staged.approve({
      stageId: initialStage.stageId,
      reviewDigest: initialStage.reviewDigest,
      signal,
    });
    initialPublicationId = initialApproved.publicationId;
    initialAuthorityRevision = initialApproved.authorityRevision;
    const expensesCol = initialStage.collections.find((c) => c.alias === "expenses")!;
    const workoutsCol = initialStage.collections.find((c) => c.alias === "workouts")!;

    const updatedFiles = new Map(files);
    updatedFiles.set(
      "personal-control-tower/expenses/operations.js",
      `${files.get("personal-control-tower/expenses/operations.js")!}\n// expense v2\n`,
    );
    updatedFiles.set(
      "personal-control-tower/workouts/operations.js",
      `${files.get("personal-control-tower/workouts/operations.js")!}\n// workout v2\n`,
    );
    const updateStage = await staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(updatedFiles),
      signal,
    });

    duringApprove = true;
    const migrated = await staged.approve({
      stageId: updateStage.stageId,
      reviewDigest: updateStage.reviewDigest,
      signal,
    });
    expect(injected).toBe(true);
    expect(concurrentWriteError).toBeInstanceOf(JournalError);
    expect((concurrentWriteError as Error).message).toMatch(/being updated/i);
    expect(migrated.collectionsApplied).toHaveLength(2);
    expect(host.approvedArtifacts(expensesCol.datasetId).revision.revision).toBe(2);
    expect(host.approvedArtifacts(workoutsCol.datasetId).revision.revision).toBe(2);
    expect(host.apps.list("personal-control-tower", "main").some((p) => p.active)).toBe(true);
  }, 60_000);

  it("refuses approval when staged revision.json fields are modified", async () => {
    const { workspaceRoot, host, staged } = await openFixture();
    const files = await loadControlTowerFiles();
    const signal = new AbortController().signal;

    const summary = await staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
    });

    const expensesCol = summary.collections.find((c) => c.alias === "expenses")!;
    const revisionPath = join(
      workspaceRoot,
      ".dohc",
      "local",
      "staged-apps",
      summary.stageId,
      "collections",
      expensesCol.datasetId,
      "revision.json",
    );
    const parsed = JSON.parse(await readFile(revisionPath, "utf8")) as {
      schemaSha256: string;
    };
    parsed.schemaSha256 = parsed.schemaSha256.startsWith("0")
      ? `1${parsed.schemaSha256.slice(1)}`
      : `0${parsed.schemaSha256.slice(1)}`;
    await writeFile(revisionPath, JSON.stringify(parsed));

    await expect(
      staged.approve({ stageId: summary.stageId, reviewDigest: summary.reviewDigest, signal }),
    ).rejects.toThrow(/failed integrity check/i);
    expect(host.list().datasets).toHaveLength(0);
  }, 60_000);

  it("blocks standalone Collection migration approval during staged approval", async () => {
    let standaloneError: unknown = null;
    let duringApprove = false;
    let injected = false;
    let standaloneArgs: Parameters<LocalDatasetHost["approveMigrationCandidate"]>[0] | null = null;
    let hostRef!: LocalDatasetHost;
    const { host, staged } = await openFixture({
      onBeforePrepareMigration: async () => {
        if (!duringApprove || injected || !standaloneArgs) return;
        injected = true;
        try {
          await hostRef.approveMigrationCandidate(standaloneArgs);
        } catch (error) {
          standaloneError = error;
        }
      },
    });
    hostRef = host;
    const files = await loadControlTowerFiles();
    const signal = new AbortController().signal;

    const initialStage = await staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
    });
    await staged.approve({
      stageId: initialStage.stageId,
      reviewDigest: initialStage.reviewDigest,
      signal,
    });
    const expensesCol = initialStage.collections.find((c) => c.alias === "expenses")!;
    const workoutsCol = initialStage.collections.find((c) => c.alias === "workouts")!;

    const updatedFiles = new Map(files);
    updatedFiles.set(
      "personal-control-tower/expenses/operations.js",
      `${files.get("personal-control-tower/expenses/operations.js")!}\n// expense v2\n`,
    );
    updatedFiles.set(
      "personal-control-tower/workouts/operations.js",
      `${files.get("personal-control-tower/workouts/operations.js")!}\n// workout v2\n`,
    );
    const updateStage = await staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(updatedFiles),
      signal,
    });

    const workoutsApproved = host.approvedArtifacts(workoutsCol.datasetId);
    const altOpSource = `${files.get("personal-control-tower/workouts/operations.js")!}\n// standalone alt v2\n`;
    const altRevision = describeDatasetRevision({
      definition: workoutsApproved.revision.definition,
      revision: 2,
      schemaSql: workoutsApproved.schemaSql,
      operationSource: altOpSource,
    });
    const standaloneCandidate = await host.prepareMigrationCandidate({
      workspaceId: "w",
      revision: altRevision,
      expected: workoutsApproved.cursor,
      schemaSql: workoutsApproved.schemaSql,
      operationSource: altOpSource,
      migrationSql: "SELECT 1;",
      signal,
    });
    standaloneArgs = {
      workspaceId: "w",
      datasetId: workoutsCol.datasetId,
      candidateId: standaloneCandidate.candidateId,
      checkpointSha256: standaloneCandidate.checkpointSha256,
      signal,
    };

    duringApprove = true;
    const migrated = await staged.approve({
      stageId: updateStage.stageId,
      reviewDigest: updateStage.reviewDigest,
      signal,
    });
    expect(injected).toBe(true);
    expect(standaloneError).toBeInstanceOf(JournalError);
    expect((standaloneError as Error).message).toMatch(/being updated/i);
    expect(migrated.collectionsApplied).toHaveLength(2);
    expect(host.approvedArtifacts(expensesCol.datasetId).revision.revision).toBe(2);
    expect(host.approvedArtifacts(workoutsCol.datasetId).revision.revision).toBe(2);
    expect(host.apps.list("personal-control-tower", "main").some((p) => p.active)).toBe(true);
  }, 60_000);

  it("drains an in-flight Collection transfer before running staged approval pre-check", async () => {
    let enteredExclusive!: () => void;
    const exclusiveEntered = new Promise<void>((resolve) => {
      enteredExclusive = resolve;
    });
    let trackExclusive = false;
    let transferSettled = false;
    let importRecoveryFinished = false;
    let transferInFlightAtPreCheck: boolean | null = null;
    let importRecoveryFinishedAtPreCheck: boolean | null = null;
    let workoutsDatasetId = "";
    const { host, staged } = await openFixture({
      onEnterExclusiveDatasets: () => {
        if (trackExclusive) enteredExclusive();
      },
      onTryApprovedArtifacts: () => {
        if (trackExclusive && transferInFlightAtPreCheck === null) {
          transferInFlightAtPreCheck = Boolean(host.transferInFlight(workoutsDatasetId));
          importRecoveryFinishedAtPreCheck = importRecoveryFinished;
        }
      },
    });
    const files = await loadControlTowerFiles();
    const signal = new AbortController().signal;

    const initialStage = await staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
    });
    await staged.approve({
      stageId: initialStage.stageId,
      reviewDigest: initialStage.reviewDigest,
      signal,
    });
    const expensesCol = initialStage.collections.find((c) => c.alias === "expenses")!;
    const workoutsCol = initialStage.collections.find((c) => c.alias === "workouts")!;

    const updatedFiles = new Map(files);
    updatedFiles.set(
      "personal-control-tower/expenses/operations.js",
      `${files.get("personal-control-tower/expenses/operations.js")!}\n// expense v2\n`,
    );
    updatedFiles.set(
      "personal-control-tower/workouts/operations.js",
      `${files.get("personal-control-tower/workouts/operations.js")!}\n// workout v2\n`,
    );
    const updateStage = await staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(updatedFiles),
      signal,
    });

    let enteredTransfer!: () => void;
    let releaseTransfer!: () => void;
    const transferStarted = new Promise<void>((resolve) => {
      enteredTransfer = resolve;
    });
    const transferGate = new Promise<void>((resolve) => {
      releaseTransfer = resolve;
    });

    workoutsDatasetId = workoutsCol.datasetId;
    const transferring = host
      .transferToShared({
        datasetId: workoutsCol.datasetId,
        targetOrigin: "https://relay.example",
        target: {
          importRecovery: async (input) => {
            enteredTransfer();
            await transferGate;
            importRecoveryFinished = true;
            return {
              transferId: input.transferId,
              manifestSha256: input.manifestSha256,
              sourceCursor: input.sourceCursor,
              targetCursor: {
                ...input.sourceCursor,
                hostEpoch: `${input.sourceCursor.hostEpoch}-remote`,
                revision: input.sourceCursor.revision + 1,
              },
            };
          },
        },
        signal,
      })
      .finally(() => {
        transferSettled = true;
      });
    let approving: Promise<unknown> | null = null;
    let approvalSettledBeforeTransfer = false;
    try {
      await transferStarted;

      trackExclusive = true;
      approving = staged
        .approve({
          stageId: updateStage.stageId,
          reviewDigest: updateStage.reviewDigest,
          signal,
        })
        .catch((error) => {
          if (!transferSettled) approvalSettledBeforeTransfer = true;
          throw error;
        });
      await exclusiveEntered;
      expect(transferInFlightAtPreCheck).toBeNull();
      expect(approvalSettledBeforeTransfer).toBe(false);
    } finally {
      releaseTransfer();
      await transferring.catch(() => undefined);
    }

    await expect(approving!).rejects.toThrow(/unavailable/i);
    expect(transferInFlightAtPreCheck).toBe(false);
    expect(importRecoveryFinishedAtPreCheck).toBe(true);
    expect(approvalSettledBeforeTransfer).toBe(false);
    expect(host.approvedArtifacts(expensesCol.datasetId).revision.revision).toBe(1);
    expect(host.approvedArtifacts(workoutsCol.datasetId).active).toBe(false);
  }, 60_000);

  it("preserves exclusive local migration access and rejects mixed-host bindings through production handler wiring", async () => {
    const { workspaceRoot, host } = await openFixture();
    const files = await loadControlTowerFiles();
    const controller = new AbortController();
    const signal = controller.signal;

    const remoteMock = {
      approvedArtifacts: async (datasetId: string) => ({
        ...host.approvedArtifacts(datasetId),
        active: true,
      }),
      prepareMigrationCandidate: (
        input: Parameters<LocalDatasetHost["prepareMigrationCandidate"]>[0],
      ) => host.prepareMigrationCandidate(input),
      approveMigrationCandidate: (
        input: Parameters<LocalDatasetHost["approveMigrationCandidate"]>[0],
      ) => host.approveMigrationCandidate(input),
      discardMigrationCandidate: (
        input: Parameters<LocalDatasetHost["discardMigrationCandidate"]>[0],
      ) => host.discardMigrationCandidate(input),
    };
    const routed = createDatasetAuthorityRouter(host, {
      marker: (datasetId) => host.transferStatus(datasetId),
      status: async (datasetId) => host.transferStatus(datasetId),
      remote: async () => remoteMock as never,
    });

    let currentFiles = new Map(files);
    let hostKind: "local" | "server" = "local";
    let failMigrationAuthority = false;
    const handlerHost = {
      ...host,
      appHostKind: () => hostKind,
    };
    const handler = createLocalOwnerAppPublicationHandler({
      datasetForWorkspace: async () => handlerHost,
      approvedArtifacts: async (_ws, datasetId) => routed.approvedArtifacts(datasetId),
      migrationAuthority: async () => {
        if (failMigrationAuthority) throw new Error("Sign in to your server first.");
        return {
          approvedArtifacts: (datasetId) => Promise.resolve(routed.approvedArtifacts(datasetId)),
          prepareMigrationCandidate: (input) => routed.prepareMigrationCandidate!(input),
          approveMigrationCandidate: (input) => routed.approveMigrationCandidate!(input),
          discardMigrationCandidate: (input) => routed.discardMigrationCandidate!(input),
        };
      },
      flushCapture: async () => ({ deferredWrites: [] }),
      withAdapter: async (_ws, work) => work(sourceCaptureAdapter(currentFiles) as never),
      compile: compileClosedApp,
    });
    const op = {
      workspace: { workspaceId: "w", rootPath: workspaceRoot },
      signal,
      assertCurrent() {},
    };

    const firstStage = await handler(
      { action: "stage", workspaceId: "w", appRoot: "personal-control-tower" },
      "caller",
      op,
    );
    if (!firstStage || firstStage.kind !== "staged") throw new Error("Expected staged result.");
    const firstApprove = await handler(
      {
        action: "approveStaged",
        workspaceId: "w",
        stageId: firstStage.stage.stageId,
        reviewDigest: firstStage.stage.reviewDigest,
      },
      "caller",
      op,
    );
    expect(firstApprove?.kind).toBe("stagedApproved");

    currentFiles = new Map(files);
    currentFiles.set(
      "personal-control-tower/expenses/operations.js",
      `${files.get("personal-control-tower/expenses/operations.js")!}\n// handler local migration v2\n`,
    );
    const secondStage = await handler(
      { action: "stage", workspaceId: "w", appRoot: "personal-control-tower" },
      "caller",
      op,
    );
    if (!secondStage || secondStage.kind !== "staged") throw new Error("Expected second stage.");
    const secondApprove = await handler(
      {
        action: "approveStaged",
        workspaceId: "w",
        stageId: secondStage.stage.stageId,
        reviewDigest: secondStage.stage.reviewDigest,
      },
      "caller",
      op,
    );
    expect(secondApprove?.kind).toBe("stagedApproved");
    const expensesCol = firstStage.stage.collections.find((c) => c.alias === "expenses")!;
    const workoutsCol = firstStage.stage.collections.find((c) => c.alias === "workouts")!;
    expect(host.approvedArtifacts(expensesCol.datasetId).revision.revision).toBe(2);

    await host.transferToShared({
      datasetId: workoutsCol.datasetId,
      targetOrigin: "https://relay.example",
      target: {
        importRecovery: async (input) => ({
          transferId: input.transferId,
          manifestSha256: input.manifestSha256,
          sourceCursor: input.sourceCursor,
          targetCursor: {
            ...input.sourceCursor,
            hostEpoch: `${input.sourceCursor.hostEpoch}-remote`,
            revision: input.sourceCursor.revision + 1,
          },
        }),
      },
      signal,
    });

    hostKind = "server";
    currentFiles = new Map(files);
    await expect(
      handler(
        { action: "stage", workspaceId: "w", appRoot: "personal-control-tower" },
        "caller",
        op,
      ),
    ).rejects.toThrow(/same host/i);

    hostKind = "local";
    const newDatasetId = "00000000-0000-4000-8000-000000000099";
    const mixedFiles = new Map(files);
    mixedFiles.set(
      "personal-control-tower/expenses/dataset.json",
      files
        .get("personal-control-tower/expenses/dataset.json")!
        .replace(expensesCol.datasetId, newDatasetId),
    );
    currentFiles = mixedFiles;
    await expect(
      handler(
        { action: "stage", workspaceId: "w", appRoot: "personal-control-tower" },
        "caller",
        op,
      ),
    ).rejects.toThrow(/unavailable|inactive/i);
    expect(
      host.list({ includeArchived: true }).datasets.some((d) => d.datasetId === newDatasetId),
    ).toBe(false);

    failMigrationAuthority = true;
    const offlineList = await handler(
      { action: "listStaged", workspaceId: "w", appRoot: "personal-control-tower" },
      "caller",
      op,
    );
    expect(offlineList).toEqual({ kind: "stagedListed", stages: [] });
    const offlineDiscard = await handler(
      { action: "discardStaged", workspaceId: "w", stageId: firstStage.stage.stageId },
      "caller",
      op,
    );
    expect(offlineDiscard).toEqual({
      kind: "stagedDiscarded",
      stageId: firstStage.stage.stageId,
    });
  }, 60_000);

  it("refuses a staged SQL backfill migration when a standalone migration already reached the same rules hash", async () => {
    const { host, staged } = await openFixture();
    const files = await loadControlTowerFiles();
    const signal = new AbortController().signal;

    const initialStage = await staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
    });
    const initialApproved = await staged.approve({
      stageId: initialStage.stageId,
      reviewDigest: initialStage.reviewDigest,
      signal,
    });
    await host.apps.request(initialApproved.publicationId, "invoke", {
      authorityRevision: initialApproved.authorityRevision,
      dataset: "workouts",
      operation: "logWorkout",
      idempotencyKey: "wrk-backfill-seed",
      input: {
        date: "2026-11-23",
        activity: "Row",
        minutes: 25,
        effort: "Moderate",
        notes: "before",
      },
    });
    const workoutsCol = initialStage.collections.find((c) => c.alias === "workouts")!;

    const updatedFiles = new Map(files);
    const updatedOps = `${files.get("personal-control-tower/workouts/operations.js")!}\n// backfill v2\n`;
    updatedFiles.set("personal-control-tower/workouts/operations.js", updatedOps);
    updatedFiles.set(
      "personal-control-tower/workouts/backfill.sql",
      "UPDATE workouts SET notes = 'backfilled';",
    );
    const backfillStage = await staged.stage({
      appRoot: "personal-control-tower",
      migrations: { workouts: "personal-control-tower/workouts/backfill.sql" },
      deferredWrites: [],
      adapter: sourceCaptureAdapter(updatedFiles),
      signal,
    });

    const workoutsApproved = host.approvedArtifacts(workoutsCol.datasetId);
    const sameRulesRevision = describeDatasetRevision({
      definition: workoutsApproved.revision.definition,
      revision: 2,
      schemaSql: workoutsApproved.schemaSql,
      operationSource: updatedOps,
    });
    const standalone = await host.prepareMigrationCandidate({
      workspaceId: "w",
      revision: sameRulesRevision,
      expected: workoutsApproved.cursor,
      schemaSql: workoutsApproved.schemaSql,
      operationSource: updatedOps,
      migrationSql: "SELECT 1;",
      signal,
    });
    await host.approveMigrationCandidate({
      workspaceId: "w",
      datasetId: workoutsCol.datasetId,
      candidateId: standalone.candidateId,
      checkpointSha256: standalone.checkpointSha256,
      signal,
    });

    await expect(
      staged.approve({
        stageId: backfillStage.stageId,
        reviewDigest: backfillStage.reviewDigest,
        signal,
      }),
    ).rejects.toThrow(/changed after staging/i);
  }, 60_000);

  it("refuses to skip a staged SQL backfill after a pre-commit crash with a saved inProgress marker, while resuming a genuinely committed backfill", async () => {
    const files = await loadControlTowerFiles();
    const signal = new AbortController().signal;

    let crashBeforeCommit = false;
    let savedBeforeCommitProposal = "";
    let proposalPath = "";
    const preCommitFixture = await openFixture({
      onBeforeApproveMigration: async () => {
        if (!crashBeforeCommit) return;
        crashBeforeCommit = false;
        savedBeforeCommitProposal = await readFile(proposalPath, "utf8");
        throw new Error("simulated crash before migration commit");
      },
    });
    const preInitialStage = await preCommitFixture.staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
    });
    const preInitialApproved = await preCommitFixture.staged.approve({
      stageId: preInitialStage.stageId,
      reviewDigest: preInitialStage.reviewDigest,
      signal,
    });
    await preCommitFixture.host.apps.request(preInitialApproved.publicationId, "invoke", {
      authorityRevision: preInitialApproved.authorityRevision,
      dataset: "workouts",
      operation: "logWorkout",
      idempotencyKey: "wrk-pre-commit-seed",
      input: {
        date: "2026-11-23",
        activity: "Row",
        minutes: 25,
        effort: "Moderate",
        notes: "before",
      },
    });
    const workoutsCol = preInitialStage.collections.find((c) => c.alias === "workouts")!;
    const updatedFiles = new Map(files);
    const updatedOps = `${files.get("personal-control-tower/workouts/operations.js")!}\n// backfill crash v2\n`;
    updatedFiles.set("personal-control-tower/workouts/operations.js", updatedOps);
    updatedFiles.set(
      "personal-control-tower/workouts/backfill.sql",
      "UPDATE workouts SET notes = 'backfilled';",
    );
    const preBackfillStage = await preCommitFixture.staged.stage({
      appRoot: "personal-control-tower",
      migrations: { workouts: "personal-control-tower/workouts/backfill.sql" },
      deferredWrites: [],
      adapter: sourceCaptureAdapter(updatedFiles),
      signal,
    });
    proposalPath = join(
      preCommitFixture.workspaceRoot,
      ".dohc",
      "local",
      "staged-apps",
      preBackfillStage.stageId,
      "proposal.json",
    );
    crashBeforeCommit = true;
    await expect(
      preCommitFixture.staged.approve({
        stageId: preBackfillStage.stageId,
        reviewDigest: preBackfillStage.reviewDigest,
        signal,
      }),
    ).rejects.toThrow(/simulated crash before migration commit/i);
    expect(JSON.parse(savedBeforeCommitProposal).inProgress?.checkpointSha256).toMatch(
      /^[0-9a-f]{64}$/,
    );

    const liveBeforeStandalone = preCommitFixture.host.approvedArtifacts(workoutsCol.datasetId);
    const sameRulesRevision = describeDatasetRevision({
      definition: liveBeforeStandalone.revision.definition,
      revision: 2,
      schemaSql: liveBeforeStandalone.schemaSql,
      operationSource: updatedOps,
    });
    const standalone = await preCommitFixture.host.prepareMigrationCandidate({
      workspaceId: "w",
      revision: sameRulesRevision,
      expected: liveBeforeStandalone.cursor,
      schemaSql: liveBeforeStandalone.schemaSql,
      operationSource: updatedOps,
      migrationSql: "SELECT 1;",
      signal,
    });
    await preCommitFixture.host.approveMigrationCandidate({
      workspaceId: "w",
      datasetId: workoutsCol.datasetId,
      candidateId: standalone.candidateId,
      checkpointSha256: standalone.checkpointSha256,
      signal,
    });
    await writeFile(proposalPath, savedBeforeCommitProposal, "utf8");

    await expect(
      preCommitFixture.staged.approve({
        stageId: preBackfillStage.stageId,
        reviewDigest: preBackfillStage.reviewDigest,
        signal,
      }),
    ).rejects.toThrow(/changed after staging/i);
    const liveAfterStandalone = preCommitFixture.host.approvedArtifacts(workoutsCol.datasetId);
    const listWorkoutsOp = preCommitFixture.host
      .describe(workoutsCol.datasetId)
      .operations.find((op) => op.name === "listWorkouts")!;
    const rowsAfterStandalone = await preCommitFixture.host.query({
      datasetId: workoutsCol.datasetId,
      revision: liveAfterStandalone.revision.revision,
      revisionSha256: liveAfterStandalone.revision.revisionSha256,
      operationId: listWorkoutsOp.operationId,
      idempotencyKey: "wrk-after-standalone",
      input: {},
      signal,
    });
    expect((rowsAfterStandalone.result as Array<{ notes: string }>).map((r) => r.notes)).toEqual([
      "before",
    ]);

    let crashAfterCommit = false;
    const postCommitFixture = await openFixture({
      onAfterApproveMigration: () => {
        if (!crashAfterCommit) return;
        crashAfterCommit = false;
        throw new Error("simulated crash after migration commit before receipt");
      },
    });
    const postInitialStage = await postCommitFixture.staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
    });
    const postInitialApproved = await postCommitFixture.staged.approve({
      stageId: postInitialStage.stageId,
      reviewDigest: postInitialStage.reviewDigest,
      signal,
    });
    await postCommitFixture.host.apps.request(postInitialApproved.publicationId, "invoke", {
      authorityRevision: postInitialApproved.authorityRevision,
      dataset: "workouts",
      operation: "logWorkout",
      idempotencyKey: "wrk-post-commit-seed",
      input: {
        date: "2026-11-23",
        activity: "Row",
        minutes: 25,
        effort: "Moderate",
        notes: "before",
      },
    });
    const postBackfillStage = await postCommitFixture.staged.stage({
      appRoot: "personal-control-tower",
      migrations: { workouts: "personal-control-tower/workouts/backfill.sql" },
      deferredWrites: [],
      adapter: sourceCaptureAdapter(updatedFiles),
      signal,
    });
    crashAfterCommit = true;
    await expect(
      postCommitFixture.staged.approve({
        stageId: postBackfillStage.stageId,
        reviewDigest: postBackfillStage.reviewDigest,
        signal,
      }),
    ).rejects.toThrow(/simulated crash after migration commit before receipt/i);

    const resumed = await postCommitFixture.staged.approve({
      stageId: postBackfillStage.stageId,
      reviewDigest: postBackfillStage.reviewDigest,
      signal,
    });
    expect(resumed.collectionsApplied).toHaveLength(1);
    expect(resumed.collectionsApplied[0]?.revision).toBe(2);
    const resumedRows = (await postCommitFixture.host.apps.request(
      resumed.publicationId,
      "invoke",
      {
        authorityRevision: resumed.authorityRevision,
        dataset: "workouts",
        operation: "listWorkouts",
        idempotencyKey: "wrk-after-resume",
        input: {},
      },
    )) as { result: Array<{ notes: string }> };
    expect(resumedRows.result.map((r) => r.notes)).toEqual(["backfilled"]);
  }, 60_000);

  it("carries checkpointSha256 through the remote artifacts contract so server-backed staged migrations resume after commit", async () => {
    const serverFixture = await openFixture();
    const desktopFixture = await openFixture();
    const files = await loadControlTowerFiles();
    const signal = new AbortController().signal;

    const initialStage = await serverFixture.staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
    });
    const initialApproved = await serverFixture.staged.approve({
      stageId: initialStage.stageId,
      reviewDigest: initialStage.reviewDigest,
      signal,
    });
    await serverFixture.host.apps.request(initialApproved.publicationId, "invoke", {
      authorityRevision: initialApproved.authorityRevision,
      dataset: "workouts",
      operation: "logWorkout",
      idempotencyKey: "wrk-server-resume-seed",
      input: {
        date: "2026-11-23",
        activity: "Row",
        minutes: 25,
        effort: "Moderate",
        notes: "before",
      },
    });
    const workoutsCol = initialStage.collections.find((c) => c.alias === "workouts")!;

    const remote = createRemoteDatasetData({
      workspaceId: "w",
      credentials: {
        serverUrl: "https://account.example",
        relayUrl: "https://relay.example",
        userId: "owner",
        token: "test-only",
        email: "owner@example.test",
      },
      credentialGeneration: 1,
      signal,
      currentCredentialGeneration: () => 1,
      assertCurrent() {},
      relayJson: async (_credentials, path) => {
        const match = /^\/sync\/w\/datasets\/([^/]+)\/artifacts$/.exec(path);
        if (!match) throw new Error(`Unexpected relay path ${path}`);
        return JSON.parse(JSON.stringify(serverFixture.host.approvedArtifacts(match[1]!)));
      },
    });

    const updatedFiles = new Map(files);
    const updatedOps = `${files.get("personal-control-tower/workouts/operations.js")!}\n// server backfill v2\n`;
    updatedFiles.set("personal-control-tower/workouts/operations.js", updatedOps);
    updatedFiles.set(
      "personal-control-tower/workouts/backfill.sql",
      "UPDATE workouts SET notes = 'backfilled';",
    );

    let crashAfterServerCommit = false;
    const serverLocalHost = {
      ...desktopFixture.host,
      appHostKind: () => "server" as const,
      keptDatasetIds: () => [],
      apps: serverFixture.host.apps,
    };
    const handler = createLocalOwnerAppPublicationHandler({
      datasetForWorkspace: async () => serverLocalHost,
      approvedArtifacts: async (_ws, datasetId) => remote.approvedArtifacts(datasetId),
      migrationAuthority: async () => ({
        approvedArtifacts: (datasetId) => remote.approvedArtifacts(datasetId),
        prepareMigrationCandidate: (input) => serverFixture.host.prepareMigrationCandidate(input),
        approveMigrationCandidate: async (input) => {
          const migrated = await serverFixture.host.approveMigrationCandidate(input);
          if (crashAfterServerCommit) {
            crashAfterServerCommit = false;
            throw new Error("simulated crash after server migration commit");
          }
          return migrated;
        },
        discardMigrationCandidate: (input) => serverFixture.host.discardMigrationCandidate(input),
      }),
      flushCapture: async () => ({ deferredWrites: [] }),
      withAdapter: async (_ws, work) => work(sourceCaptureAdapter(updatedFiles) as never),
      compile: compileClosedApp,
    });
    const op = {
      workspace: { workspaceId: "w", rootPath: desktopFixture.workspaceRoot },
      signal,
      assertCurrent() {},
    };

    const stagedUpdate = await handler(
      {
        action: "stage",
        workspaceId: "w",
        appRoot: "personal-control-tower",
        migrations: { workouts: "personal-control-tower/workouts/backfill.sql" },
      },
      "caller",
      op,
    );
    if (!stagedUpdate || stagedUpdate.kind !== "staged") throw new Error("Expected staged update.");

    crashAfterServerCommit = true;
    await expect(
      handler(
        {
          action: "approveStaged",
          workspaceId: "w",
          stageId: stagedUpdate.stage.stageId,
          reviewDigest: stagedUpdate.stage.reviewDigest,
        },
        "caller",
        op,
      ),
    ).rejects.toThrow(/simulated crash after server migration commit/i);

    const resumed = await handler(
      {
        action: "approveStaged",
        workspaceId: "w",
        stageId: stagedUpdate.stage.stageId,
        reviewDigest: stagedUpdate.stage.reviewDigest,
      },
      "caller",
      op,
    );
    if (!resumed || resumed.kind !== "stagedApproved")
      throw new Error("Expected stagedApproved resume result.");
    expect(resumed.collectionsApplied).toHaveLength(1);
    expect(resumed.collectionsApplied[0]?.revision).toBe(2);
    const liveWorkouts = await remote.approvedArtifacts(workoutsCol.datasetId);
    expect(liveWorkouts.checkpointSha256).toMatch(/^[0-9a-f]{64}$/);
    const resumedRows = (await serverFixture.host.apps.request(resumed.publicationId, "invoke", {
      authorityRevision: resumed.authorityRevision,
      dataset: "workouts",
      operation: "listWorkouts",
      idempotencyKey: "wrk-server-after-resume",
      input: {},
    })) as { result: Array<{ notes: string }> };
    expect(resumedRows.result.map((r) => r.notes)).toEqual(["backfilled"]);
  }, 60_000);

  it("rejects staged proposals whose review display metadata was altered on disk", async () => {
    const { workspaceRoot, staged } = await openFixture();
    const files = await loadControlTowerFiles();
    const signal = new AbortController().signal;

    const summary = await staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
    });
    const proposalPath = join(
      workspaceRoot,
      ".dohc",
      "local",
      "staged-apps",
      summary.stageId,
      "proposal.json",
    );
    const stored = JSON.parse(await readFile(proposalPath, "utf8")) as {
      collections: Array<{ tables?: Array<{ name: string; fields: string[] }> }>;
    };
    stored.collections[0]!.tables = [];
    await writeFile(proposalPath, JSON.stringify(stored, null, 2), "utf8");

    expect(await staged.list("personal-control-tower")).toEqual([]);
    await expect(
      staged.approve({ stageId: summary.stageId, reviewDigest: summary.reviewDigest, signal }),
    ).rejects.toThrow(/not found|changed/i);
  }, 60_000);
});
