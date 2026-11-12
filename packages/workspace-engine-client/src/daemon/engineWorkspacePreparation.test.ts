import type { PathLike } from "node:fs";
import { lstat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Request, Response } from "../protocol";
import type { EngineDaemonClient } from "./engineDaemonLifecycle";
import {
  EngineWorkspaceFolderTimeoutError,
  EngineWorkspaceSessions,
} from "./engineWorkspaceSessions";

// Hangs `lstat` on one workspace root, as a network drive that stopped
// answering does, and leaves every other path to the real file system.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const DEADLINE_MS = 300;
const roots: string[] = [];
const releases: Array<() => void> = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(lstat).mockReset().mockImplementation(actual.lstat);
  await Promise.all(roots.splice(0).map((root) => actual.rm(root, { recursive: true, force: true })));
});

async function tempWorkspace(workspaceId: string) {
  const rootPath = await mkdtemp(join(tmpdir(), "dohc-engine-preparation-"));
  roots.push(rootPath);
  return { workspaceId, rootPath };
}

// Until `settle` runs, `lstat` on the root never answers. `settle` then ends
// the calls already waiting, with `failure` if given, and later calls answer
// at once.
async function hangRoot(rootPath: string) {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const root = resolve(rootPath);
  const gate = Promise.withResolvers<void>();
  releases.push(() => gate.resolve());
  let settled = false, error: Error | undefined;
  vi.mocked(lstat).mockImplementation((async (path: PathLike) => {
    if (String(path) === root && !settled) {
      await gate.promise;
      if (error) throw error;
    }
    return await actual.lstat(path);
  }) as typeof lstat);
  return {
    calls: () => vi.mocked(lstat).mock.calls.filter(([path]) => String(path) === root).length,
    settle(failure?: Error) {
      settled = true;
      error = failure;
      gate.resolve();
    },
  };
}

class OpenClient implements EngineDaemonClient {
  readonly opens: string[] = [];

  async sendRequest(request: Request): Promise<Response> {
    if (request.method === "workspace.open") {
      const workspaceId = String((request.params as { workspaceId?: unknown }).workspaceId);
      this.opens.push(workspaceId);
      return { id: request.id, result: { workspace: `handle-${workspaceId}` } };
    }
    if (request.method === "workspace.close") return { id: request.id, result: { closed: true } };
    throw new Error(`Unexpected method: ${request.method}`);
  }

  close(): void {}
}

function sessionsFor(client: OpenClient) {
  return new EngineWorkspaceSessions(
    { currentClient: () => client },
    { sleep: async () => undefined, workspaceOpenDeadlineMs: DEADLINE_MS },
  );
}

// Settles to the run's error, or to "still waiting" well past the deadline.
async function outcomeOf(run: Promise<unknown>): Promise<unknown> {
  const bound = Promise.withResolvers<string>();
  const timer = setTimeout(() => bound.resolve("still waiting"), DEADLINE_MS * 20);
  try {
    return await Promise.race([run.then(() => "opened", (error: unknown) => error), bound.promise]);
  } finally {
    clearTimeout(timer);
  }
}

it("stops opening a workspace whose folder does not answer, and checks the folder again once that check fails", async () => {
  const workspace = await tempWorkspace("stuck-folder");
  const client = new OpenClient();
  const sessions = sessionsFor(client);
  const root = await hangRoot(workspace.rootPath);

  const first = await outcomeOf(sessions.run(workspace, async () => "ran"));
  expect(first).toBeInstanceOf(EngineWorkspaceFolderTimeoutError);
  expect((first as Error).message).toContain("stuck-folder");
  expect((first as Error).message).not.toContain(workspace.rootPath);
  expect(client.opens).toEqual([]);

  // A reopen while the stuck check is pending waits on that check again,
  // rather than starting another file system call that can hang too.
  const second = sessions.run(workspace, async () => "ran");
  await vi.waitFor(() => expect(sessions.openInProgress(workspace)).not.toBeNull(), { interval: 5 });
  expect(root.calls()).toBe(1);
  // That check then fails. It is not kept: the open's immediate retry checks
  // the folder again, and opens the workspace.
  root.settle(Object.assign(new Error("i/o error"), { code: "EIO" }));
  await expect(second).resolves.toBe("ran");
  expect(root.calls()).toBe(2);
  expect(client.opens).toEqual(["stuck-folder"]);
  await sessions.closeAll();
});

it("opens another workspace while one workspace's folder does not answer", async () => {
  const stuck = await tempWorkspace("stuck-folder");
  const healthy = await tempWorkspace("healthy-folder");
  const client = new OpenClient();
  const sessions = sessionsFor(client);
  const root = await hangRoot(stuck.rootPath);

  const waiting = sessions.run(stuck, async () => "ran");
  await expect(sessions.run(healthy, async () => "ran")).resolves.toBe("ran");
  expect(client.opens).toEqual(["healthy-folder"]);
  expect(await outcomeOf(waiting)).toBeInstanceOf(EngineWorkspaceFolderTimeoutError);

  root.settle();
  await sessions.closeAll();
});
