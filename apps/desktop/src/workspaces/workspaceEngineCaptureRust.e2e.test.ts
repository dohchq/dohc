import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  EngineDaemonLifecycle,
} from "./engineDaemonLifecycle";
import { EngineWorkspaceSessions } from "./engineWorkspaceSessions";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { nativeTmpdir } from "./testTemp";

// The binary name is platform-dependent. Hardcoding `.exe` meant this test
// could not run on Linux or macOS at all, and CI does not build a debug daemon
// on any platform -- so the one end-to-end test of the desktop capture path
// against a real daemon SKIPPED everywhere, from the day it was written.
const binaryPath = fileURLToPath(
  new URL(
    `../../../../target/debug/dohc-workspace-engine${
      process.platform === "win32" ? ".exe" : ""
    }`,
    import.meta.url,
  ),
);
// A skip is right for a developer who has not built the daemon and wrong for
// CI, where it is the difference between this test guarding the cutover path
// and reporting green without running. Same pattern as DOHC_REQUIRE_POSTGRES.
const engineBinaryPresent = existsSync(binaryPath);
if (!engineBinaryPresent && process.env.DOHC_REQUIRE_ENGINE_E2E === "1") {
  throw new Error(
    `DOHC_REQUIRE_ENGINE_E2E=1 but no engine binary at ${binaryPath}. ` +
      "Build it with: cargo build -p dohc-workspace-engine --bin dohc-workspace-engine",
  );
}
const roots: string[] = [];

async function waitForPathMoments(
  capture: ReturnType<typeof createWorkspaceEngineCapture>,
  path: string,
  count: number,
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await capture.flush();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.endsWith(" did not settle.")
      ) {
        throw error;
      }
      await delay(25);
      continue;
    }
    const page = await capture.listMoments({ limit: 100 });
    const matching = page.moments.filter((moment) => moment.path === path);
    if (matching.length >= count) return matching;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${count} captured moments for ${path}.`);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(
      async (root) => await rm(root, { recursive: true, force: true }),
    ),
  );
});

it.skipIf(!engineBinaryPresent)(
  "drives watcher-batch capture, readback, and version-switch materialization through the real daemon",
  async () => {
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
      daemonOwnsCapture: true,
    });
    try {
      const mainText = `main\n${"m".repeat(64 * 1024)}`;
      const draftText = `draft\n${"d".repeat(64 * 1024)}`;
      await writeFile(join(root, "note.md"), mainText, "utf8");
      capture.captureBatch([{ path: "note.md", operation: "update" }]);
      await capture.flush();
      expect(await capture.fileObjectIdForPath("note.md")).toBeTruthy();

      const activeRun = {
        agentId: "dohc-e2e-agent",
        onBehalfOf: "local",
        agentRunId: "run-rust-capture-author",
      };
      await capture.setActiveAgentRun(activeRun);
      await writeFile(join(root, "agent-note.md"), "written by agent\n", "utf8");
      capture.captureBatch([{ path: "agent-note.md", operation: "update" }]);
      const [agentMoment] = await waitForPathMoments(
        capture,
        "agent-note.md",
        1,
      );
      await capture.setActiveAgentRun(null);
      expect(agentMoment?.author).toEqual({
        kind: "agent",
        ...activeRun,
      });

      const draft = await capture.createVersion("Draft");
      await writeFile(join(root, "note.md"), draftText, "utf8");
      capture.captureBatch([{ path: "note.md", operation: "update" }]);
      await capture.flush();

      await capture.switchVersion("main");
      expect(await readFile(join(root, "note.md"), "utf8")).toBe(mainText);
      await capture.switchVersion(draft.activeVersionId);
      expect(await readFile(join(root, "note.md"), "utf8")).toBe(draftText);

      const firstBinary = new Uint8Array(64 * 1024).fill(0x11);
      const secondBinary = new Uint8Array(64 * 1024).fill(0x22);
      await writeFile(join(root, "asset.bin"), firstBinary);
      await waitForPathMoments(capture, "asset.bin", 1);
      await writeFile(join(root, "asset.bin"), secondBinary);
      const binaryMoments = await waitForPathMoments(
        capture,
        "asset.bin",
        2,
      );
      const binaryEdit = binaryMoments[0];
      expect(binaryEdit).toBeTruthy();

      await capture.restoreFileToBeforeMoment(binaryEdit!.id);
      expect(await readFile(join(root, "asset.bin"))).toEqual(
        Buffer.from(firstBinary),
      );
    } finally {
      await capture.stop();
      await sessions.closeAll();
      await lifecycle.stop();
    }
  },
  60_000,
);
