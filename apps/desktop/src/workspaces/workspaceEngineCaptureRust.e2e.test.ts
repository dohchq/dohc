import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { defaultWorkspaceMode } from "@dohc/workspace-core";
import {
  EngineDaemonLifecycle,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import { createWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { createWorkspaceActivity } from "./workspaceActivity";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { nativeTmpdir } from "./testTemp";

// This suite looked only under the repo root, so it SKIPPED everywhere from the
// day it was written and its coverage came and went with whoever last ran
// `cargo build` (#390). The shared gate also checks apps/desktop/target/debug,
// which is where the app under test and the staged-binary harnesses put it.
const engine = requireEngineBinaryOrSkip();
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

it.skipIf(engine.missing)(
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
      command: engine.require(),
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

// #338: another app (Notepad, an agent, `>>`) writes the .md WHILE the
// document is open in dohc. The session's close runs a pre-close settle; the
// engine answers it from the lineage's last settled content and never touches
// the drifted file, and the desktop then mirrored those bytes over it — the
// outside edit vanished from disk, recoverable only by knowing to open
// History. The mirror write is the clobber, so this test reads DISK.
it.skipIf(engine.missing)(
  "keeps an edit made outside dohc when the open document closes",
  async () => {
    const root = await mkdtemp(join(nativeTmpdir(), "dohc-capture-rust-drift-"));
    roots.push(root);
    const markerDirectory = join(root, ".dohc", "engine");
    await mkdir(markerDirectory, { recursive: true });
    await writeFile(
      join(markerDirectory, "SHADOW_CLONE"),
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "utf8",
    );
    const lifecycle = new EngineDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = new EngineWorkspaceSessions(lifecycle);
    const capture = createWorkspaceEngineCapture({
      workspaceId: "capture-rust-drift",
      rootPath: root,
      rustEngineSessions: sessions,
      daemonOwnsCapture: true,
    });
    const outside = "written outside dohc\n";
    try {
      await writeFile(join(root, "note.md"), "base\n", "utf8");
      await waitForPathMoments(capture, "note.md", 1);

      const session = await capture.openYDocSession({
        path: "note.md",
        onRemoteUpdate: () => undefined,
      });
      const editor = new Y.Doc();
      Y.applyUpdate(editor, session.initialUpdate);
      const before = Y.encodeStateVector(editor);
      editor.getText("plainText").insert(0, "typed in dohc\n");
      await session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
      const settled = await session.settleNow();
      expect(await readFile(join(root, "note.md"), "utf8")).toBe(
        settled.markdown,
      );

      // The outside writer replaces the file. Nothing is typed afterwards, so
      // the close settle has the same projection it already settled.
      await writeFile(join(root, "note.md"), outside, "utf8");
      // Whether the daemon's own capture reached the outside edit before this
      // close decides which answer the engine gives (a refused settle, or one
      // answered from the lineage). The FILE must survive either way, so the
      // close error — race-dependent, and its own issue — is not asserted.
      await session.close().catch(() => undefined);

      expect(await readFile(join(root, "note.md"), "utf8")).toBe(outside);

      // The other half of the promise: nothing the editor held is lost — the
      // typed text stays in History.
      const moments = await capture.listMoments({ limit: 100 });
      const texts = await Promise.all(
        moments.moments
          .filter((moment) => moment.path === "note.md")
          .map(async (moment) => {
            const detail = await capture.readMoment(moment.id);
            const payload = detail?.protected === false ? detail.moment.payload : undefined;
            return payload?.after.text ?? "";
          }),
      );
      expect(texts.some((text) => text.includes("typed in dohc"))).toBe(true);
    } finally {
      await capture.stop().catch(() => undefined);
      await sessions.closeAll().catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
    }
  },
  60_000,
);

it.skipIf(engine.missing)(
  "preserves a settled watcher capture across stopAll and a new daemon process",
  async () => {
    const root = await mkdtemp(join(nativeTmpdir(), "dohc-capture-rust-stop-"));
    roots.push(root);
    const workspace: CreatedWorkspace = {
      workspaceId: "capture-rust-stop",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    const firstLifecycle = new EngineDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await firstLifecycle.start();
    const firstSessions = new EngineWorkspaceSessions(firstLifecycle);
    const openedState: {
      capture: ReturnType<typeof createWorkspaceEngineCapture> | null;
    } = { capture: null };
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: (openedWorkspace) => {
        const capture = createWorkspaceEngineCapture({
          workspaceId: openedWorkspace.workspaceId,
          rootPath: openedWorkspace.rootPath,
          rustEngineSessions: firstSessions,
          daemonOwnsCapture: true,
        });
        openedState.capture = capture;
        return { capture };
      },
    });

    try {
      await activity.open(workspace);
      const capture = openedState.capture;
      if (!capture) throw new Error("workspace capture did not open");

      // Prove the daemon's startup baseline has finished before the write that
      // stopAll must drain. Otherwise the baseline scan can race that write and
      // make the shutdown assertion pass for the wrong reason.
      await writeFile(join(root, "baseline-ready.md"), "ready\n", "utf8");
      await waitForPathMoments(capture, "baseline-ready.md", 1);

      const finalText = "must survive shutdown\n";
      await writeFile(join(root, "final.md"), finalText, "utf8");
      // Prove the Rust watcher captured the settled write before shutdown. The
      // request-order unit test covers stopAll's flush-before-close contract;
      // this real-daemon test covers durable preservation across process exit.
      await waitForPathMoments(capture, "final.md", 1);

      // stopAll must not lose an already-settled durable capture.
      await activity.stopAll();
      await firstSessions.closeAll();
      await firstLifecycle.stop();

      // Remove the disk source while no daemon is running. A later scan can
      // record a delete, but it cannot recreate the persisted write moment.
      await rm(join(root, "final.md"));

      const secondLifecycle = new EngineDaemonLifecycle({
        command: engine.require(),
        maxRestarts: 0,
      });
      await secondLifecycle.start();
      const secondSessions = new EngineWorkspaceSessions(secondLifecycle);
      const reopened = createWorkspaceEngineCapture({
        workspaceId: workspace.workspaceId,
        rootPath: workspace.rootPath,
        rustEngineSessions: secondSessions,
        daemonOwnsCapture: true,
      });
      try {
        const moments = await waitForPathMoments(reopened, "final.md", 1);
        const persistedWrite = moments.find(
          (moment) => moment.operation === "write",
        );
        expect(persistedWrite).toBeTruthy();
        const detail = await reopened.readMoment(persistedWrite!.id);
        const payload = detail?.protected === false ? detail.moment.payload : undefined;
        expect(payload?.after.text).toBe(finalText);
      } finally {
        await reopened.stop().catch(() => undefined);
        await secondSessions.closeAll().catch(() => undefined);
        await secondLifecycle.stop().catch(() => undefined);
      }
    } finally {
      await activity.stopAll().catch(() => undefined);
      await firstSessions.closeAll().catch(() => undefined);
      await firstLifecycle.stop().catch(() => undefined);
    }
  },
  60_000,
);

// The domain-code translation (#418) is asserted on the loopback in
// workspaceVersionOperations.test.ts. It is asserted HERE against the real
// daemon because the loopback is where those codes could quietly stop matching
// the engine's: the translation reads the refusal message, and a fixture is free
// to write any message it likes.
it.skipIf(engine.missing)(
  "reports refusals from the real daemon under their domain error codes",
  async () => {
    const root = await mkdtemp(join(nativeTmpdir(), "dohc-capture-rust-codes-"));
    roots.push(root);
    const lifecycle = new EngineDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = new EngineWorkspaceSessions(lifecycle);
    const capture = createWorkspaceEngineCapture({
      workspaceId: "capture-rust-codes",
      rootPath: root,
      rustEngineSessions: sessions,
      daemonOwnsCapture: true,
    });
    try {
      await capture.createVersion("Draft");
      await expect(capture.createVersion("Draft")).rejects.toMatchObject({
        code: "version-name-conflict",
      });
      await expect(capture.switchVersion("no-such-version")).rejects.toMatchObject({
        code: "version-not-found",
      });
    } finally {
      await capture.stop();
      await sessions.closeAll();
      await lifecycle.stop();
    }
  },
  60_000,
);
