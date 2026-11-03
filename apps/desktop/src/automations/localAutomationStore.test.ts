import { chmod, lstat, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AutomationStoreNotOpenedError, createAutomationRunStore, type StoredReach, type StoredRun } from "@dohc/automation-executor/automation-run-store";
import { fakeLocalStateOpens } from "../testing/preparedLocalState";
import { LocalStateUnavailableError } from "../workspaces/workspaceLocalState";
import { createTestScratch } from "../workspaces/testTemp";
import { localAutomationStoreFolder } from "./localAutomationStore";

const engine = fakeLocalStateOpens();
const AUTOMATION = "collection:Tasks#bump";
const NOT_OPENED = "dohc did not save automation progress because the workspace has not finished opening. Try again when it opens.";
const NOT_EXCLUDED = "dohc did not save automation progress because it can't keep this computer's automation progress out of iCloud Drive. Restart dohc to try again.";

let workspaces = 0;
async function workspace() {
  workspaces += 1;
  const opened = { workspaceId: `automations-${workspaces}`, rootPath: await createTestScratch("dohc-local-automations-") };
  return { opened, store: () => createAutomationRunStore(localAutomationStoreFolder(opened)) };
}

function run(claimId: string, atMs: number): StoredRun {
  return {
    durableEffects: 0, version: 13, claimId, automationId: AUTOMATION, definitionHash: "0123456789abcdef", keySeed: "0123456789abcdef",
    startedAtMs: atMs, finishedAtMs: atMs, steps: [{ ordinal: 0, effects: [{ kind: "add", collectionPath: "Log", recordId: "rec_a", name: "a", fields: [] }] }], applied: [], created: [], replans: [], undoRequests: [],
    undoCalls: [], undoCovers: [], readableFields: null, collections: [], rules: null, superseded: false, undo: null, undoKept: [], settled: true,
    outcome: { state: "done" },
  };
}

// A step a person allowed, which a reach file this store does not trust must not allow.
const allowed: StoredReach = {
  verdicts: [{ automationId: AUTOMATION, definitionHash: "0123456789abcdef", step: "0", verdict: "allowed", stoppedFor: null, seq: 1 }],
  hostRecord: 0, unproven: [], unprovenAll: false, unprovenFolders: [], unprovenPaths: [], pending: null, taken: null,
};
const none = { verdicts: [], hostRecord: 0, unproven: [], unprovenAll: false, unprovenFolders: [], unprovenPaths: [], pending: null, taken: null };

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(LocalStateUnavailableError);
  return (error as Error).message;
}

describe("this computer's automation store", () => {
  it("keeps everything in .dohc/local/automations and reads nothing from an old .dohc/automations", async () => {
    const { opened, store } = await workspace();
    // What an earlier build left, which this one neither reads nor moves.
    const old = join(opened.rootPath, ".dohc", "automations");
    await mkdir(join(old, "runs"), { recursive: true });
    await writeFile(join(old, "reach.json"), `${JSON.stringify({ version: 3, ...allowed })}\n`, { mode: 0o600 });
    await writeFile(join(old, "enabled.json"), `${JSON.stringify({ version: 1, collections: [{ path: "Tasks", enabled: ["bump"] }] })}\n`, { mode: 0o600 });
    await engine.open(opened);
    await expect(store().readReachVerdicts()).resolves.toEqual({ ...none, unreadable: false, missing: true });
    await expect(store().readEnabledAutomations()).resolves.toBeNull();

    await store().save(run("atc_one", 1));
    await store().saveReachVerdicts(allowed);
    await store().savePendingRestore({ id: "restore", claims: ["atc_one"] });
    const local = join(opened.rootPath, ".dohc", "local", "automations");
    expect((await readdir(local)).sort()).toEqual(["reach.json", "restoring.json", "runs"]);
    expect((await store().runsOf(AUTOMATION, "atc_one")).runs).toHaveLength(1);
    await expect(store().readReachVerdicts()).resolves.toEqual({ ...allowed, unreadable: false, missing: false });
    // Each file is this user's alone, whatever the umask.
    if (process.platform !== "win32") expect((await lstat(join(local, "reach.json"))).mode & 0o777).toBe(0o600);
    expect((await readdir(old)).sort()).toEqual(["enabled.json", "reach.json", "runs"]);
    expect(await readdir(join(old, "runs"))).toEqual([]);
  });

  it("writes nothing and makes no .dohc/local before the engine's open prepares it", async () => {
    const { opened, store } = await workspace();
    const writes = (written: ReturnType<typeof store>) => [
      written.save(run("atc_one", 1)),
      written.saveReachVerdicts(allowed),
      written.saveSubscriptions([]),
      written.saveEnabledAutomations(new Map()),
      written.savePendingRestore({ id: "restore", claims: [] }),
    ];
    // Before any open, and with reads first, which make nothing.
    await expect(store().readReachVerdicts()).resolves.toMatchObject({ missing: true });
    await expect(store().runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: false });
    for (const write of writes(store())) expect(await refusal(write)).toBe(NOT_OPENED);
    await expect(store().expire(1, async () => "gone", null)).resolves.toBeNull();
    await expect(readdir(opened.rootPath)).resolves.toEqual([]);

    // An open that could not keep the folder out of iCloud Drive.
    await engine.open(opened, false);
    for (const write of writes(store())) expect(await refusal(write)).toBe(NOT_EXCLUDED);
    // An open that stands while its folder is gone.
    engine.close(opened);
    await engine.open(opened);
    await rm(join(opened.rootPath, ".dohc", "local"), { recursive: true });
    for (const write of writes(store())) expect(await refusal(write)).toBe(NOT_OPENED);
    await expect(readdir(join(opened.rootPath, ".dohc"))).resolves.toEqual([]);
  });

  it("keeps what it saved when a later write is refused, and goes on from it once the open is back", async () => {
    const { opened, store } = await workspace();
    await engine.open(opened);
    const writer = store();
    const saved = { ...run("atc_one", 1), finishedAtMs: null, outcome: null, settled: false };
    await writer.save(saved);
    await writer.updateState(saved, { undo: "started", undoScope: "scope" });
    const session = { grants: ["grant"], target: { kind: "person" as const, userId: "ana" }, label: "Ana", definitions: [],
      filesUndone: false, receipts: [], result: { status: "waiting" } };
    await writer.savePendingRestore({ id: "restore", claims: ["atc_one"], session });
    await writer.saveReachVerdicts(allowed);
    const files = join(opened.rootPath, ".dohc", "local", "automations");
    const before = await Promise.all(["restoring.json", "undoing.json", "reach.json"].map((name) => readFile(join(files, name), "utf8")));

    // The workspace closes, or the engine restarts, part way through.
    engine.close(opened);
    const effect = { ordinal: 0, writes: [{ kind: "created" as const, recordId: "rec_a", path: "Log/a.md" }] };
    for (const write of [
      writer.appendEffect(saved, effect),
      writer.updateState(saved, { undo: "done" }),
      writer.recordRestoreReceipts("restore", [{ path: "Tasks/a.md", restoredMomentId: "moment" }]),
      writer.removePendingRestore("restore"),
      writer.saveReachVerdicts(none),
    ]) expect(await refusal(write)).toBe(NOT_OPENED);
    expect(await Promise.all(["restoring.json", "undoing.json", "reach.json"].map((name) => readFile(join(files, name), "utf8")))).toEqual(before);

    await engine.open(opened);
    const reopened = store();
    const [kept] = (await reopened.runsOf(AUTOMATION, "atc_one")).runs;
    expect(kept).toMatchObject({ undo: "started", undoScope: "scope", applied: [] });
    await expect(reopened.unfinishedUndos()).resolves.toEqual(new Set(["atc_one"]));
    await expect(reopened.pendingRestores()).resolves.toEqual([{ id: "restore", claims: ["atc_one"], session }]);
    await expect(reopened.readReachVerdicts()).resolves.toEqual({ ...allowed, unreadable: false, missing: false });
    // The refused effect is recorded now, after the step it belongs to.
    await reopened.appendEffect(saved, effect);
    expect((await reopened.runsOf(AUTOMATION, "atc_one")).runs[0]!.applied).toEqual([effect]);
  });

  it("expires saved runs in .dohc/local/automations and leaves an old .dohc/automations alone", async () => {
    const { opened, store } = await workspace();
    await engine.open(opened);
    await store().save(run("atc_old", 1));
    const old = join(opened.rootPath, ".dohc", "automations", "runs", "f1");
    await mkdir(old, { recursive: true });
    await writeFile(join(old, "run.json"), "{}\n");
    const now = 30 * 24 * 60 * 60 * 1000 + 2;
    await expect(store().expire(now, async () => "gone", null)).resolves.toBeNull();
    const local = join(opened.rootPath, ".dohc", "local", "automations");
    expect(await readdir(join(local, "runs"))).toEqual([]);
    expect(await readdir(local)).toContain("expiry.json");
    expect(await readdir(old)).toEqual(["run.json"]);
  });

  // A folder dohc can't look into may hold allowed steps and Undo, so it reads
  // as unreadable, never as an empty store. chmod can't hide a folder from
  // root, and Windows has no such mode.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reads a .dohc or .dohc/local it can't look into as unreadable, not as nothing saved",
    async () => {
      const { opened, store } = await workspace();
      await engine.open(opened);
      await store().save(run("atc_one", 1));
      await store().saveReachVerdicts(allowed);
      for (const folder of [join(opened.rootPath, ".dohc"), join(opened.rootPath, ".dohc", "local")]) {
        await chmod(folder, 0o600);
        try {
          const reader = store();
          await expect(reader.readReachVerdicts()).resolves.toEqual({ ...none, unreadable: true, missing: false });
          await expect(reader.runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: true });
          await expect(reader.unfinishedUndos()).resolves.toBeNull();
        } finally {
          await chmod(folder, 0o700);
        }
      }
      await expect(store().readReachVerdicts()).resolves.toEqual({ ...allowed, unreadable: false, missing: false });
    },
  );

  it("reads nothing under a .dohc/local that is a link or another user's, and allows no step from it", async () => {
    const { opened, store } = await workspace();
    await engine.open(opened);
    await store().save(run("atc_one", 1));
    await store().saveReachVerdicts(allowed);
    await store().saveEnabledAutomations(new Map([["Tasks", ["bump"]]]));
    await store().recordCircuitBreaker({ automationId: AUTOMATION, claimId: "atc_one", datasetInstance: null, reason: "consecutive-timeouts", collectionPath: "Tasks", run: 1 });
    const unread = async () => {
      const reader = store();
      await expect(reader.readReachVerdicts()).resolves.toEqual({ ...none, unreadable: true, missing: false });
      await expect(reader.runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: true });
      await expect(reader.readEnabledAutomations()).resolves.toBeNull();
      await expect(reader.readCircuitBreakers()).resolves.toEqual([]);
      await expect(reader.unfinishedUndos()).resolves.toBeNull();
    };

    // The same files, reached through a link.
    const local = join(opened.rootPath, ".dohc", "local");
    const elsewhere = join(await createTestScratch("dohc-local-automations-"), "local");
    await rename(local, elsewhere);
    await symlink(elsewhere, local, "dir");
    await unread();
    await rm(local);
    await rename(elsewhere, local);
    await expect(store().readReachVerdicts()).resolves.toEqual({ ...allowed, unreadable: false, missing: false });

    // The same files, in a folder another user owns. Node reports no owner on Windows.
    if (process.platform === "win32") return;
    const someoneElse = vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    try {
      await unread();
    } finally {
      someoneElse.mockRestore();
    }
  });

  // Node can't see who may change a folder on Windows, so there the store
  // trusts `.dohc/local` only while the engine's open holds it. The steps a
  // person allowed then say the workspace has not opened, not that nobody can
  // read them, which would ask the person to reset every hold. Unfinished
  // Stop and restore progress says so too, so it shows no false error.
  it("on Windows, reads nothing once no engine open holds .dohc/local, and the allowed steps and unfinished restores say the workspace has not opened", async () => {
    const { opened, store } = await workspace();
    await engine.open(opened);
    await store().saveReachVerdicts(allowed);
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      await expect(store().readReachVerdicts()).resolves.toEqual({ ...allowed, unreadable: false, missing: false });
      engine.close(opened);
      const refused = await store().readReachVerdicts().then(() => null, (error: unknown) => error);
      expect(refused).toBeInstanceOf(AutomationStoreNotOpenedError);
      expect((refused as Error).message).toBe("dohc has not finished opening this workspace. Try again when it opens.");
      await expect(store().runsOf(AUTOMATION, "atc_one")).resolves.toEqual({ runs: [], unreadable: true });
      await expect(store().pendingRestores()).rejects.toBeInstanceOf(AutomationStoreNotOpenedError);
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
  });
});
