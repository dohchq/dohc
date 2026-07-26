import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  EngineDaemonLifecycle,
} from "./engineDaemonLifecycle";
import { EngineWorkspaceSessions } from "./engineWorkspaceSessions";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { nativeTmpdir } from "./testTemp";

const binaryPath = fileURLToPath(
  new URL(
    "../../../../target/debug/dohc-workspace-engine.exe",
    import.meta.url,
  ),
);
const originalRustAdapter = process.env.DOHC_RUST_ENGINE_ADAPTER;
const originalKernelSidecar = process.env.DOHC_KERNEL_SIDECAR;
const roots: string[] = [];

afterEach(async () => {
  if (originalRustAdapter === undefined) {
    delete process.env.DOHC_RUST_ENGINE_ADAPTER;
  } else {
    process.env.DOHC_RUST_ENGINE_ADAPTER = originalRustAdapter;
  }
  if (originalKernelSidecar === undefined) {
    delete process.env.DOHC_KERNEL_SIDECAR;
  } else {
    process.env.DOHC_KERNEL_SIDECAR = originalKernelSidecar;
  }
  await Promise.all(
    roots.splice(0).map(
      async (root) => await rm(root, { recursive: true, force: true }),
    ),
  );
});

it.skipIf(!existsSync(binaryPath))(
  "drives watcher-batch capture, readback, and version-switch materialization through the real daemon",
  async () => {
    process.env.DOHC_RUST_ENGINE_ADAPTER = "1";
    process.env.DOHC_KERNEL_SIDECAR = "0";
    const root = await mkdtemp(join(nativeTmpdir(), "dohc-capture-rust-e2e-"));
    roots.push(root);
    const markerDirectory = join(root, ".dohc", "engine");
    await mkdir(markerDirectory, { recursive: true });
    await writeFile(
      join(markerDirectory, "SHADOW_CLONE"),
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "utf8",
    );
    const lifecycle = new EngineDaemonLifecycle({
      command: binaryPath,
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = new EngineWorkspaceSessions(lifecycle);
    const capture = createWorkspaceEngineCapture({
      workspaceId: "capture-rust-e2e",
      rootPath: root,
      rustEngineSessions: sessions,
    });
    try {
      await writeFile(join(root, "note.md"), "main\n", "utf8");
      capture.captureBatch([{ path: "note.md", operation: "update" }]);
      await capture.flush();
      expect(await capture.fileObjectIdForPath("note.md")).toBeTruthy();

      const draft = await capture.createVersion("Draft");
      await writeFile(join(root, "note.md"), "draft\n", "utf8");
      capture.captureBatch([{ path: "note.md", operation: "update" }]);
      await capture.flush();

      await capture.switchVersion("main");
      expect(await readFile(join(root, "note.md"), "utf8")).toBe("main\n");
      await capture.switchVersion(draft.activeVersionId);
      expect(await readFile(join(root, "note.md"), "utf8")).toBe("draft\n");
    } finally {
      await capture.stop();
      await sessions.closeAll();
      await lifecycle.stop();
    }
  },
  60_000,
);
