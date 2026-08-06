import { defaultWorkspaceMode } from "@dohc/workspace-core";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import { createTestScratch } from "./testTemp";
import { createWorkspaceActivity } from "./workspaceActivity";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { createCaptureLiveStores } from "./workspaceEngineCaptureLiveStore";
import { startWorkspaceWatch } from "./workspaceWatcher";

// The watch handle is the ONE collaborator faked here, because the window
// under test is its timing: a batch that settles while the initial scan is
// still running. That window is real — watchWorkspaceEvents arms its settle
// timer from the first add/change event, while chokidar's `ready` waits for
// the whole scan — but a real watcher cannot be asked for it on demand.
// Everything else is production: workspaceActivity.open, the engine capture,
// and its real chain.
vi.mock("./workspaceWatcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workspaceWatcher")>()),
  startWorkspaceWatch: vi.fn(),
}));

const WORKSPACE_ID = "activity-startup-order";
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await createTestScratch("dohc-activity-order-");
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspaceActivity startup ordering", () => {
  it("gives startup reconciliation the chain slot ahead of a batch that settles inside the ready window", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "offline.md"), "offline edit\n");

    const order: string[] = [];
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const liveStore = createCaptureLiveStores(
      { workspaceId: WORKSPACE_ID, rootPath: root },
      sessions,
    ).store;
    const trackedStore = new Proxy(liveStore, {
      get(target, property) {
        if (property === "listTextFileMetadata") {
          return async (
            input: Parameters<NonNullable<typeof liveStore.listTextFileMetadata>>[0],
          ) => {
            // Reconciliation's final phase, so its disk scan has already run.
            // The batch's file lands HERE: a scan that saw live.md would
            // reconcile it itself and the batch would dedupe to nothing, a
            // sequence that says nothing about which task reached the chain
            // first. Created after the scan, the path can only be written by
            // the batch — or by nobody, when the batch ran too early to see it.
            await writeFile(join(root, "live.md"), "live edit\n");
            // Slow, so a batch that jumped the chain interleaves ahead of the
            // push below instead of racing it.
            await new Promise((resolve) => setTimeout(resolve, 50));
            order.push("reconcile:listTextFileMetadata");
            return await liveStore.listTextFileMetadata!(input);
          };
        }
        if (property === "writeTextFile") {
          return async (input: Parameters<typeof liveStore.writeTextFile>[0]) => {
            order.push(`write:${input.path}`);
            return await liveStore.writeTextFile(input);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    vi.mocked(startWorkspaceWatch).mockImplementation((_workspace, options = {}) => {
      // Settles before `ready` resolves — the batch reaches the capture while
      // open() is still inside its ready race.
      const settled = Promise.resolve().then(() => {
        options.engineCapture?.()?.captureBatch([{ path: "live.md", operation: "update" }]);
      });
      return { ready: settled, stop: async () => await settled };
    });

    const workspace: CreatedWorkspace = {
      workspaceId: WORKSPACE_ID,
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    // The capture is built here exactly as engineCaptureGate builds it, minus
    // daemonOwnsCapture: that flag makes both enqueues below return early, so
    // only the client-side capture has a chain whose order can be read.
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => ({
        shareView: false,
        capture: createWorkspaceEngineCapture({
          workspaceId: WORKSPACE_ID,
          rootPath: root,
          store: trackedStore,
          rustEngineSessions: sessions,
        }),
      }),
    });
    await activity.open(workspace);
    await activity.stopAll();

    expect(order).toEqual([
      "write:offline.md",
      "reconcile:listTextFileMetadata",
      "write:live.md",
    ]);
    await liveStore.close();
  });
});
