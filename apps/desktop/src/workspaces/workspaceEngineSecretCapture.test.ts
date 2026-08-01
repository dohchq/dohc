import {
  VERSIONED_METHOD,
  VersionedLoopbackEngine,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import type { SecretFileStore } from "@dohc/workspace-contracts/engine";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import { nativeTmpdir } from "./testTemp";
import {
  createWorkspaceEngineCapture,
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
  secretStore?: SecretFileStore,
): WorkspaceEngineCapture {
  return createWorkspaceEngineCapture({
    workspaceId: "engine-secret-test",
    rootPath: root,
    rustEngineSessions: mockLiveSessions(loopback, requests),
    ...(secretStore === undefined ? {} : { secretStore }),
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

function secretMoment(
  id: string,
  recordedAtMs: number,
): Awaited<ReturnType<SecretFileStore["listSecretMoments"]>>[number] {
  return {
    id,
    workspaceId: "engine-secret-test",
    versionId: "main",
    path: ".env",
    recordedAtMs,
    operation: "write",
    metadata: {
      origin: "api",
      summary: id,
      correlationId: id,
    },
    momentOrder: recordedAtMs,
    protected: true,
  };
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

describe("listMoments protected pagination", () => {
  it("assigns tied protected moments to one half-open production page window", async () => {
    const root = await tempRoot();
    const loopback = new VersionedLoopbackEngine();
    await loopback.sendRequest({
      id: 1,
      method: VERSIONED_METHOD.versionsEnsureMain,
      workspace: "engine-secret-test",
      params: { workspaceId: "engine-secret-test" },
    });
    for (const recordedAtMs of [10, 20, 30, 40, 50, 60]) {
      await loopback.sendRequest({
        id: recordedAtMs,
        method: VERSIONED_METHOD.textWrite,
        workspace: "engine-secret-test",
        params: {
          workspaceId: "engine-secret-test",
          versionId: "main",
          path: `text-${recordedAtMs}.md`,
          text: String(recordedAtMs),
          origin: "api",
          momentId: `text-${recordedAtMs}`,
          nowMs: recordedAtMs,
        },
      });
    }
    const protectedMoments = [
      secretMoment("protected-upper", 50),
      secretMoment("protected-middle", 35),
      secretMoment("protected-lower", 20),
    ];
    const secretStore = {
      listSecretMoments: vi.fn(async () => protectedMoments),
    } as unknown as SecretFileStore;
    const engine = daemonCapture(root, loopback, undefined, secretStore);

    const newest = await engine.listMoments({ limit: 2 });
    const middle = await engine.listMoments({
      limit: 2,
      beforeMomentOrder: newest.nextBeforeMomentOrder ?? undefined,
    });
    const oldest = await engine.listMoments({
      limit: 2,
      beforeMomentOrder: middle.nextBeforeMomentOrder ?? undefined,
    });

    expect(newest.moments.map((moment) => moment.id)).toEqual([
      "text-60",
      "text-50",
      "protected-upper",
    ]);
    expect(middle.moments.map((moment) => moment.id)).toEqual([
      "text-40",
      "protected-middle",
      "text-30",
    ]);
    expect(oldest.moments.map((moment) => moment.id)).toEqual([
      "text-20",
      "protected-lower",
      "text-10",
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
    expect(secretStore.listSecretMoments).toHaveBeenCalledTimes(3);
    await engine.stop();
  });
});
