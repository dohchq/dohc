import {
  VERSIONED_METHOD,
  VersionedLoopbackEngine,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import { nativeTmpdir } from "./testTemp";
import {
  createWorkspaceEngineCapture,
  type WorkspaceEngineMomentSummary,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";

// Secret-backed files through the desktop daemon pipeline: protected moments
// stay metadata-only while switch, merge, and restore materialize disk state.

const MARKER = "DESKTOP_SECRET_MARKER_31337";
const ENV_A = `API_KEY=${MARKER}\n`;
const ENV_B = `API_KEY=${MARKER}\nEXTRA=b\n`;

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(nativeTmpdir(), "dohc-engine-secret-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
  return createWorkspaceEngineCapture({
    workspaceId: "engine-secret-test",
    rootPath: root,
    rustEngineSessions: mockLiveSessions(loopback, requests),
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

function momentSummary(
  id: string,
  recordedAtMs: number,
  protectedMoment: boolean,
): WorkspaceEngineMomentSummary {
  return {
    id,
    versionId: "main",
    path: protectedMoment ? ".env" : "doc.md",
    recordedAtMs,
    operation: "write",
    metadata: {
      origin: "api",
      summary: id,
      correlationId: id,
    },
    momentOrder: recordedAtMs,
    protected: protectedMoment,
  };
}

function fuseMomentPage(
  textMoments: WorkspaceEngineMomentSummary[],
  protectedMoments: WorkspaceEngineMomentSummary[],
  window: { lowerMs: number; upperMs: number },
): WorkspaceEngineMomentSummary[] {
  const protectedInWindow = protectedMoments.filter(
    (moment) =>
      moment.recordedAtMs >= window.lowerMs && moment.recordedAtMs < window.upperMs,
  );
  return [...textMoments, ...protectedInWindow].sort(
    (a, b) => b.recordedAtMs - a.recordedAtMs,
  );
}

describe("secret capture through the desktop pipeline (daemon path)", () => {
  it("captures metadata-only .env batches, coalesces no-op rewrites, and retires deletions", async () => {
    const root = await tempRoot();
    await write(root, ".env", ENV_A);
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const engine = daemonCapture(root, loopback, requests);
    engine.start();
    await engine.flush();

    // The legacy in-process engine never opens a daemon workspace or writes
    // the secret over the wire.
    const methods = requests.map((request) => request.method);
    expect(methods).toContain("workspace.open");
    expect(methods).toContain(VERSIONED_METHOD.secretsWrite);

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
    expect(requests.map((request) => request.method)).toContain(
      VERSIONED_METHOD.secretsDelete,
    );
    await engine.stop();
  });

  it("a version that never had .env removes it from disk on switch and restores it on the way back", async () => {
    const root = await tempRoot();
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
    const root = await tempRoot();
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

    const changes = await engine.compareVersions(created.activeVersionId);
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

describe("secret version operations through the desktop daemon path", () => {
  it("merges a version's secret into Main and materializes it", async () => {
    const root = await tempRoot();
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

    // Merge while Main is ACTIVE so the merged secret must land on disk.
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
    const root = await tempRoot();
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

describe("fuseMomentPage", () => {
  it("assigns tied protected moments to one half-open page window", () => {
    const protectedMoments = [
      momentSummary("protected-upper", 30, true),
      momentSummary("protected-middle", 25, true),
      momentSummary("protected-lower", 20, true),
    ];
    const newest = fuseMomentPage(
      [momentSummary("text-newest", 40, false), momentSummary("text-upper", 30, false)],
      protectedMoments,
      { lowerMs: 30, upperMs: Number.POSITIVE_INFINITY },
    );
    const middle = fuseMomentPage(
      [momentSummary("text-lower", 20, false)],
      protectedMoments,
      { lowerMs: 20, upperMs: 30 },
    );
    const oldest = fuseMomentPage(
      [momentSummary("text-oldest", 10, false)],
      protectedMoments,
      { lowerMs: Number.NEGATIVE_INFINITY, upperMs: 20 },
    );

    expect(newest.map((moment) => moment.id)).toEqual([
      "text-newest",
      "text-upper",
      "protected-upper",
    ]);
    expect(middle.map((moment) => moment.id)).toEqual([
      "protected-middle",
      "text-lower",
      "protected-lower",
    ]);
    expect(oldest.map((moment) => moment.id)).toEqual(["text-oldest"]);

    const protectedIds = [...newest, ...middle, ...oldest]
      .filter((moment) => moment.protected)
      .map((moment) => moment.id);
    expect(protectedIds).toEqual([
      "protected-upper",
      "protected-middle",
      "protected-lower",
    ]);
    expect(new Set(protectedIds).size).toBe(protectedMoments.length);
  });
});
