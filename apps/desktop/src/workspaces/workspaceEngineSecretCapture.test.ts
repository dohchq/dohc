import {
  VERSIONED_METHOD,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import type { SecretFileMoment } from "@dohc/workspace-contracts/engine";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";

// A built-in ESM module's namespace is not configurable, so `vi.spyOn`
// cannot wrap it directly — `vi.mock` with `importOriginal` is the
// supported way to keep the real implementation while tracking calls
// (used only by the plaintext-reader isolation pin below; every other
// test in this file calls through unchanged).
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockDaemonSessions, mockLiveSessions } from "../testing/liveEngineSessions";
import {
  createWorkspaceEngineCapture,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";

import { createTestScratch } from "./testTemp";
// Secret-backed files through the desktop daemon pipeline: protected moments
// stay metadata-only while switch, merge, and restore materialize disk state.

const MARKER = "DESKTOP_SECRET_MARKER_31337";
const ENV_A = `API_KEY=${MARKER}\n`;
const ENV_B = `API_KEY=${MARKER}\nEXTRA=b\n`;

afterEach(async () => {
  vi.restoreAllMocks();
});

async function write(root: string, path: string, contents: string) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function readText(root: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(root, path), "utf8");
  } catch {
    return null;
  }
}

// The daemon path holds real secret, version, and moment state in the loopback.
// The request log proves which live adapter calls ran.
function daemonCapture(
  root: string,
  loopback: VersionedLoopbackEngine,
  requests?: Request[],
): WorkspaceEngineCapture {
  const workspaceId = "engine-secret-test";
  return createWorkspaceEngineCapture({
    workspaceId,
    rootPath: root,
    attachmentId: Symbol("test-workspace-attachment"),
    rustEngineSessions: mockDaemonSessions({ rootPath: root, workspaceId, loopback, requests }),
  });
}

class SecretMergeLoopbackEngine extends VersionedLoopbackEngine {
  override async sendRequest(request: Request): Promise<Response> {
    if (request.method === "conflicts.list") {
      return {
        id: request.id,
        result: { conflicts: [], nextAfterConflictId: null },
      };
    }
    return await super.sendRequest(request);
  }
}

async function writeLoopbackSecret(
  loopback: VersionedLoopbackEngine,
  id: string,
  text: string,
): Promise<SecretFileMoment> {
  const response = await loopback.sendRequest({
    id: 10_000 + text.length,
    method: VERSIONED_METHOD.secretsWrite,
    workspace: "engine-secret-test",
    params: {
      workspaceId: "engine-secret-test",
      versionId: "main",
      path: ".env",
      text,
      origin: "api",
      momentId: id,
      summary: id,
      correlationId: id,
    },
  });
  const moment = (response.result as { moment: SecretFileMoment | null }).moment;
  if (moment === null) throw new Error("Expected a protected moment.");
  return moment;
}

describe("secret capture through the desktop pipeline (daemon path)", () => {
  it("captures metadata-only .env batches, coalesces no-op rewrites, and retires deletions", async () => {
    const root = await createTestScratch("dohc-engine-secret-");
    await write(root, ".env", ENV_A);
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const engine = daemonCapture(root, loopback, requests);
    engine.start();
    await engine.flush();

    // The chain opens the daemon workspace; the daemon writes the secret
    // into its own store, never the chain.
    const methods = requests.map((request) => request.method);
    expect(methods).toContain("workspace.open");
    expect(methods).not.toContain(VERSIONED_METHOD.secretsWrite);
    expect(loopback.requests.map((request) => request.method)).toContain(
      VERSIONED_METHOD.secretsWrite,
    );

    // Same content again: no second moment (content-equality no-op).
    engine.captureBatch([{ path: ".env", operation: "update" }]);
    await engine.flush();
    let page = await engine.listMoments();
    let protectedMoments = page.moments.filter((moment) => moment.protected);
    expect(protectedMoments).toHaveLength(1);
    expect(protectedMoments[0].path).toBe(".env");
    expect(protectedMoments[0].metadata.summary).toBe("Updated .env");
    expect(JSON.stringify(protectedMoments[0]).includes(MARKER)).toBe(false);

    const detail = await engine.readMoment(protectedMoments[0].id);
    expect(detail?.protected).toBe(true);
    expect(JSON.stringify(detail).includes(MARKER)).toBe(false);
    expect(requests.map((request) => request.method)).toContain(
      VERSIONED_METHOD.secretsMomentsGet,
    );

    // Real change: one more metadata-only moment.
    await write(root, ".env", ENV_B);
    engine.captureBatch([{ path: ".env", operation: "update" }]);
    await engine.flush();
    page = await engine.listMoments();
    expect(page.moments.filter((moment) => moment.protected)).toHaveLength(2);

    // Deletion retires the protected state with a moment.
    await rm(join(root, ".env"));
    engine.captureBatch([{ path: ".env", operation: "delete" }]);
    await engine.flush();
    page = await engine.listMoments();
    protectedMoments = page.moments.filter((moment) => moment.protected);
    expect(protectedMoments).toHaveLength(3);
    expect(protectedMoments[0].operation).toBe("delete");
    expect(protectedMoments[0].metadata.summary).toBe("Deleted .env");
    expect(loopback.requests.map((request) => request.method)).toContain(
      VERSIONED_METHOD.secretsDelete,
    );
    await engine.stop();
  });

  it("a version that never had .env removes it from disk on switch and restores it on the way back", async () => {
    const root = await createTestScratch("dohc-engine-secret-");
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const engine = daemonCapture(root, loopback, requests);
    engine.start();
    await engine.flush();
    // Fork Experiment while no secret exists.
    const created = await engine.createVersion("Experiment");
    const experimentId = created.activeVersionId;
    // Back on Main, gain a secret.
    await engine.switchVersion("main");
    await write(root, ".env", ENV_A);
    engine.captureBatch([{ path: ".env", operation: "update" }]);
    await engine.flush();

    await engine.switchVersion(experimentId);
    expect(await readText(root, ".env")).toBeNull();
    await engine.switchVersion("main");
    expect(await readText(root, ".env")).toBe(ENV_A);

    // Both calls went over the wire. Note what each one does and does not show:
    // `createVersion` ran while NO secret existed, so the recorded secretsFork
    // forked an empty secret map — it proves the fork path is exercised, not that
    // tips were carried. The disk assertions above are what prove the switch
    // behaviour, and secretsMaterialize is what shows the plaintext came from the
    // engine's single authorized materialization rather than a leftover file.
    const methods = requests.map((request) => request.method);
    expect(methods).toContain(VERSIONED_METHOD.secretsFork);
    expect(methods).toContain(VERSIONED_METHOD.secretsMaterialize);
    await engine.stop();
  });

  it("compareVersions reports protected changes without contents", async () => {
    const root = await createTestScratch("dohc-engine-secret-");
    await write(root, ".env", ENV_A);
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const engine = daemonCapture(root, loopback, requests);
    engine.start();
    await engine.flush();
    const created = await engine.createVersion("Experiment");
    await write(root, ".env", ENV_B);
    engine.captureBatch([{ path: ".env", operation: "update" }]);
    await engine.flush();

    const page = await engine.compareVersions(created.activeVersionId);
    expect(page.nextAfterPath).toBeNull();
    const changes = page.files;
    const secretChange = changes.find((change) => change.path === ".env");
    expect(secretChange).toMatchObject({ status: "modified", protected: true });
    expect(secretChange?.currentText).toBeUndefined();
    expect(secretChange?.incomingText).toBeUndefined();
    // The comparison the assertions above read was answered by the engine's
    // protected comparison, not by a text diff of a plaintext row.
    expect(requests.map((request) => request.method)).toContain(
      VERSIONED_METHOD.secretsCompare,
    );
    // Absence claim: `currentText`/`incomingText` are the fields a text change
    // carries, so this catches a protected change routed as text.
    expect(JSON.stringify(changes).includes(MARKER)).toBe(false);
    await engine.stop();
  });
});

describe("the stand-down marker cleanup must never touch secret paths", () => {
  it("a secret path's watcher event never reaches the plaintext reader", async () => {
    // The stand-down cleanup once called the plaintext reader
    // (readDiskTextState) for every event, before the secret floor, reading
    // secret bytes through a reader with no secret-store awareness. The
    // daemon reads the file for capture; the chain has no reason to. The
    // sessions here carry no daemon disk side, so every readFile of .env
    // after the flush is the chain's own.
    const root = await createTestScratch("dohc-engine-secret-");
    await write(root, ".env", ENV_A);
    const engine = createWorkspaceEngineCapture({
      workspaceId: "engine-secret-test",
      rootPath: root,
      attachmentId: Symbol("test-workspace-attachment"),
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine()),
    });
    engine.start();
    await engine.flush();

    const envAbsolute = join(root, ".env");
    const trackedReadFile = vi.mocked(fsPromises.readFile);
    trackedReadFile.mockClear();
    await write(root, ".env", ENV_B);
    engine.captureBatch([{ path: ".env", operation: "update" }]);
    await engine.flush();

    const envReads = trackedReadFile.mock.calls.filter(
      (call) => call[0] === envAbsolute,
    );
    expect(envReads).toHaveLength(0);
    await engine.stop();
  });
});

describe("secret version operations through the desktop daemon path", () => {
  it("merges a version's secret into Main and materializes it", async () => {
    const root = await createTestScratch("dohc-engine-secret-");
    await write(root, ".env", ENV_A);
    const loopback = new SecretMergeLoopbackEngine();
    const requests: Request[] = [];
    const engine = daemonCapture(root, loopback, requests);
    engine.start();
    await engine.flush();
    const created = await engine.createVersion("Experiment");
    await write(root, ".env", ENV_B);
    engine.captureBatch([{ path: ".env", operation: "update" }]);
    await engine.flush();

    // Merge while Main is active so the merged secret must land on disk.
    await engine.switchVersion("main");
    expect(await readText(root, ".env")).toBe(ENV_A);
    const result = await engine.mergeVersionIntoMain(created.activeVersionId);
    expect(result.mergedFileCount).toBeGreaterThanOrEqual(1);
    expect(await readText(root, ".env")).toBe(ENV_B);

    const methods = requests.map((request) => request.method);
    expect(methods).toContain("conflicts.list");
    expect(methods).toContain(VERSIONED_METHOD.secretsApply);
    expect(methods).toContain(VERSIONED_METHOD.secretsMaterialize);
    expect(methods).not.toContain(VERSIONED_METHOD.versionsMerge);
    await engine.stop();
  });

  it("restores a protected file to before a moment and materializes it", async () => {
    const root = await createTestScratch("dohc-engine-secret-");
    await write(root, ".env", ENV_A);
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const engine = daemonCapture(root, loopback, requests);
    engine.start();
    await engine.flush();
    await write(root, ".env", ENV_B);
    engine.captureBatch([{ path: ".env", operation: "update" }]);
    await engine.flush();

    const page = await engine.listMoments();
    const editMoment = page.moments.find(
      (moment) => moment.protected && moment.operation === "write",
    );
    expect(editMoment).toBeDefined();
    const result = await engine.restoreFileToBeforeMoment(editMoment?.id ?? "");
    expect(result.restored).toBe("text");
    expect(result.path).toBe(".env");
    expect(await readText(root, ".env")).toBe(ENV_A);

    // The materialized write consumes its expected event: no re-capture.
    engine.captureBatch([{ path: ".env", operation: "update" }]);
    await engine.flush();
    const after = await engine.listMoments();
    expect(after.moments[0].id).toBe(result.restoredMomentId);
    expect(after.moments[0].metadata.summary).toBe("Restored .env");
    expect(JSON.stringify(after).includes(MARKER)).toBe(false);
    const methods = requests.map((request) => request.method);
    expect(methods).toContain(VERSIONED_METHOD.secretsRestore);
    expect(methods).toContain(VERSIONED_METHOD.secretsMaterialize);
    await engine.stop();
  });
});

describe("listMoments protected pagination", () => {
  it("assigns tied protected moments to one half-open production page window", async () => {
    const root = await createTestScratch("dohc-engine-secret-");
    const loopback = new VersionedLoopbackEngine();
    await loopback.sendRequest({
      id: 1,
      method: VERSIONED_METHOD.versionsEnsureMain,
      workspace: "engine-secret-test",
      params: { workspaceId: "engine-secret-test" },
    });
    const protectedMoments = [
      await writeLoopbackSecret(loopback, "protected-lower", "one"),
      await writeLoopbackSecret(loopback, "protected-middle", "two"),
      await writeLoopbackSecret(loopback, "protected-upper", "three"),
    ];
    const textTimes = protectedMoments.flatMap((moment) => [
      moment.recordedAtMs - 1,
      moment.recordedAtMs,
    ]);
    for (const [index, recordedAtMs] of textTimes.entries()) {
      await loopback.sendRequest({
        id: 20_000 + index,
        method: VERSIONED_METHOD.textWrite,
        workspace: "engine-secret-test",
        params: {
          workspaceId: "engine-secret-test",
          versionId: "main",
          path: `text-${index}.md`,
          text: String(recordedAtMs),
          origin: "api",
          momentId: `text-${index}`,
          nowMs: recordedAtMs,
        },
      });
    }
    const requests: Request[] = [];
    const engine = daemonCapture(root, loopback, requests);
    await engine.listVersions();
    requests.length = 0;

    const newest = await engine.listMoments({ limit: 2 });
    const middle = await engine.listMoments({
      limit: 2,
      beforeMomentOrder: newest.nextBeforeMomentOrder ?? undefined,
    });
    const oldest = await engine.listMoments({
      limit: 2,
      beforeMomentOrder: middle.nextBeforeMomentOrder ?? undefined,
    });

    // protected-upper ties text-5, which ends the first page, so it waits
    // for the page that contains that timestamp. Each page must omit the two
    // protected rows outside its own half-open time window.
    expect(newest.moments.map((moment) => moment.id)).toEqual([
      "text-5",
      "protected-upper",
      "text-4",
    ]);
    expect(middle.moments.map((moment) => moment.id)).toEqual([
      "text-3",
      "protected-middle",
      "text-2",
    ]);
    expect(oldest.moments.map((moment) => moment.id)).toEqual([
      "text-1",
      "protected-lower",
      "text-0",
    ]);
    // What the user reads is the pages appended in order; the split above may
    // move, this may not.
    expect(
      [...newest.moments, ...middle.moments, ...oldest.moments].map(
        (moment) => moment.id,
      ),
    ).toEqual([
      "text-5",
      "protected-upper",
      "text-4",
      "text-3",
      "protected-middle",
      "text-2",
      "text-1",
      "protected-lower",
      "text-0",
    ]);

    const protectedIds = [...newest.moments, ...middle.moments, ...oldest.moments]
      .filter((moment) => moment.protected)
      .map((moment) => moment.id);
    expect(protectedIds).toEqual([
      "protected-upper",
      "protected-middle",
      "protected-lower",
    ]);
    expect(new Set(protectedIds).size).toBe(protectedMoments.length);
    expect(requests.map((request) => request.method)).toEqual([
      VERSIONED_METHOD.historyPage,
      VERSIONED_METHOD.historyPage,
      VERSIONED_METHOD.historyPage,
    ]);
    await engine.stop();
  });

  // One daemon reconcile pass stamps every moment it produces with the same
  // wall clock, so a tie is the normal case, not a rarity. The merge states
  // the order instead of inheriting it from Array#sort stability: newer
  // recordedAtMs first, then text before protected, then higher momentOrder,
  // then lower id. Ids here are chosen so that dropping any one rule reorders
  // the result.
  it("orders same-millisecond text before protected rows by the stated rule", async () => {
    const root = await createTestScratch("dohc-engine-secret-");
    const loopback = new VersionedLoopbackEngine();
    await loopback.sendRequest({
      id: 1,
      method: VERSIONED_METHOD.versionsEnsureMain,
      workspace: "engine-secret-test",
      params: { workspaceId: "engine-secret-test" },
    });
    const tiedSecret = await writeLoopbackSecret(
      loopback,
      "aa-secret",
      "tie",
    );
    // "aaa-text" is written first, so it holds the lower momentOrder even
    // though its id sorts first.
    const textWrites: ReadonlyArray<[string, number]> = [
      ["older-text", tiedSecret.recordedAtMs - 1],
      ["aaa-text", tiedSecret.recordedAtMs],
      ["zz-text", tiedSecret.recordedAtMs],
    ];
    let requestId = 2;
    for (const [momentId, nowMs] of textWrites) {
      await loopback.sendRequest({
        id: requestId++,
        method: VERSIONED_METHOD.textWrite,
        workspace: "engine-secret-test",
        params: {
          workspaceId: "engine-secret-test",
          versionId: "main",
          path: `${momentId}.md`,
          text: momentId,
          origin: "api",
          momentId,
          nowMs,
        },
      });
    }
    // The protected id sorts before both text ids. Text-before-protected must
    // therefore come from the merge rule, not from the ids or arrival order.
    const engine = daemonCapture(root, loopback);
    const page = await engine.listMoments();
    expect(page.moments.map((moment) => moment.id)).toEqual([
      "zz-text",
      "aaa-text",
      "aa-secret",
      "older-text",
    ]);
    await engine.stop();
  });

  // The rule has to hold across the whole timeline the user reads, not only
  // inside one page. DesktopWorkspaceShell loads 200 moments at a time and
  // appends each later page, so a tie group longer than one page would put
  // the protected moment in front of the tied text moments still to come.
  it("keeps tied text before a protected moment across a page boundary", async () => {
    const root = await createTestScratch("dohc-engine-secret-");
    const loopback = new VersionedLoopbackEngine();
    await loopback.sendRequest({
      id: 1,
      method: VERSIONED_METHOD.versionsEnsureMain,
      workspace: "engine-secret-test",
      params: { workspaceId: "engine-secret-test" },
    });
    // One reconcile pass, one clock reading, one moment more than a page.
    const tiedSecret = await writeLoopbackSecret(
      loopback,
      "tied-secret",
      "tie",
    );
    const tiedTextCount = 201;
    for (let index = 0; index < tiedTextCount; index += 1) {
      await loopback.sendRequest({
        id: index + 2,
        method: VERSIONED_METHOD.textWrite,
        workspace: "engine-secret-test",
        params: {
          workspaceId: "engine-secret-test",
          versionId: "main",
          path: `tied-${index}.md`,
          text: String(index),
          origin: "api",
          momentId: `tied-${index}`,
          nowMs: tiedSecret.recordedAtMs,
        },
      });
    }
    const engine = daemonCapture(root, loopback);

    // The shell's own paging: 200 per request, later pages appended.
    const first = await engine.listMoments({ limit: 200 });
    const second = await engine.listMoments({
      limit: 200,
      beforeMomentOrder: first.nextBeforeMomentOrder ?? undefined,
    });
    const timeline = [...first.moments, ...second.moments];
    await engine.stop();

    expect(timeline.filter((moment) => moment.protected)).toHaveLength(1);
    expect(timeline.map((moment) => moment.id)).toEqual([
      ...Array.from(
        { length: tiedTextCount },
        (_, index) => `tied-${tiedTextCount - 1 - index}`,
      ),
      "tied-secret",
    ]);
  });
});
