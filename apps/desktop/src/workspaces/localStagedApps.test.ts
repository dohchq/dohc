import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JournalError } from "@dohc/app-backend-runtime/journal";
import { compileClosedApp } from "./closedAppCompiler";
import { createLocalDatasetHost, type LocalDatasetHost } from "./localDatasetHost";
import { createLocalStagedApps } from "./localStagedApps";
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
  onBeforeApproveCreate?: (revisionSha256: string) => void | Promise<void>;
  onBeforePrepareMigration?: (datasetId: string) => void | Promise<void>;
}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-staged-apps-"));
  roots.push(workspaceRoot);
  await openedLocalState({ workspaceId: "w", rootPath: workspaceRoot });
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
    approveMigrationCandidate: (input) => host.approveMigrationCandidate(input),
    discardMigrationCandidate: (input) => host.discardMigrationCandidate(input),
    activateApp: (prepared, signal, agent) => host.apps.activate(prepared, signal, agent),
    withExclusiveDatasets: (datasetIds, signal, work) =>
      host.withExclusiveDatasets(datasetIds, signal, work),
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
    const { staged, host } = await openFixture({
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

    const resumed = await staged.approve({
      stageId: summary.stageId,
      reviewDigest: summary.reviewDigest,
      signal,
    });
    expect(resumed.collectionsApplied).toHaveLength(2);
    expect(host.list().datasets).toHaveLength(2);
    expect(await staged.list()).toEqual([]);

    const third = await staged.stage({
      appRoot: "personal-control-tower",
      deferredWrites: [],
      adapter: sourceCaptureAdapter(files),
      signal,
    });
    expect(await staged.list()).toHaveLength(1);
    await staged.discard(third.stageId);
    expect(await staged.list()).toEqual([]);
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
    expect(host.apps.list("personal-control-tower").some((p) => p.active)).toBe(true);
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

    releaseFirst();
    const result = await approving;
    expect(result.collectionsApplied).toHaveLength(2);
    expect(host.list().datasets).toHaveLength(2);
    expect(host.apps.list("personal-control-tower").some((p) => p.active)).toBe(true);
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
    expect(host.apps.list("personal-control-tower").some((p) => p.active)).toBe(true);
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
});
