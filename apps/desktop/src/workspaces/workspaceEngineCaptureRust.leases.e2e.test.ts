import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { defaultWorkspaceMode } from "@dohc/workspace-core";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import { createWorkspaceEngineCapture as createAttachedWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { createInMemoryWorkspaceActivity as createWorkspaceActivity } from "./workspaceActivity.testSupport";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions } from "../testing/realDaemonWorkspaceSessions";
import { createTestScratch } from "./testTemp";
import { waitForPathMoments } from "./waitForPathMoments";
import { createWorkspaceEngineCapture, engine, waitForDaemonCaptureDeferral, waitForRecoveredSibling, listDaemonPathMoments, holdWithoutShareDelete } from "./workspaceEngineCaptureRust.fixture";

it.skipIf(engine.missing)(
  "preserves a settled watcher capture across stopAll and a new daemon process",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-stop-");
    const workspace: CreatedWorkspace = {
      workspaceId: "capture-rust-stop",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    const firstLifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await firstLifecycle.start();
    const firstSessions = createRealDaemonWorkspaceSessions(firstLifecycle);
    const openedState: {
      capture: ReturnType<typeof createWorkspaceEngineCapture> | null;
    } = { capture: null };
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: (openedWorkspace) => {
        const capture = createWorkspaceEngineCapture({
          workspaceId: openedWorkspace.workspaceId,
          rootPath: openedWorkspace.rootPath,
          rustEngineSessions: firstSessions,
        });
        openedState.capture = capture;
        return { capture, shareView: false };
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

      const secondLifecycle = createRealDaemonLifecycle({
        command: engine.require(),
        maxRestarts: 0,
      });
      await secondLifecycle.start();
      const secondSessions = createRealDaemonWorkspaceSessions(secondLifecycle);
      const reopened = createWorkspaceEngineCapture({
        workspaceId: workspace.workspaceId,
        rootPath: workspace.rootPath,
        rustEngineSessions: secondSessions,
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

// The journey behind #337 item 5, end to end through the real daemon. It was
// filed as "no retry OR error". PR #495 gave the save indicator honest
// states; #554 closes the retry half: a file-locked settle re-arms itself
// with backoff, so the write lands when the external handle releases — no
// further edit needed.
it.skipIf(engine.missing || process.platform !== "win32")(
  "surfaces a locked save and lands it by itself once the lock releases",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-lock-");
    const lifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const errors: string[] = [];
    const capture = createWorkspaceEngineCapture({
      workspaceId: "capture-rust-lock",
      rootPath: root,
      rustEngineSessions: sessions,
      onError: (context) => errors.push(context),
    });
    const absolute = join(root, "note.md");
    let release: (() => Promise<void>) | null = null;
    try {
      await writeFile(absolute, "base\n", "utf8");
      await waitForPathMoments(capture, "note.md", 1);

      const states: string[] = [];
      const session = await capture.openYDocSession({
        path: "note.md",
        onRemoteUpdate: () => undefined,
        onSaveState: (state) => states.push(state),
      });
      const editor = new Y.Doc();
      Y.applyUpdate(editor, session.initialUpdate);
      const type = async (text: string) => {
        const before = Y.encodeStateVector(editor);
        editor.getText("plainText").insert(0, text);
        await session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
      };

      release = await holdWithoutShareDelete(absolute);
      await type("locked edit\n");

      // The item's first claim, refuted: the blocked save IS surfaced, and
      // named — the wire carries `file-locked` (Overloaded/afterBackoff), so
      // the editor gets its own state whose copy names the blocker instead
      // of advising another edit.
      await expect(session.settleNow()).rejects.toThrow();
      expect(states).toEqual(["saved", "settling", "file-locked"]);
      expect(errors).toEqual(["ydoc settle of note.md"]);
      expect(await readFile(absolute, "utf8")).toBe("base\n");

      // The retry can finish while the holder exits. Clear first so this test
      // does not erase the recovery state it is waiting for.
      states.length = 0;
      errors.length = 0;
      await release();
      release = null;

      // The item's second claim, closed: the provider retries the
      // settle on a doubling delay, so releasing the lock is followed by the
      // write landing BY ITSELF — no further edit. The retry replays the
      // durably pending materialization job through the idempotent settle.
      await expect.poll(() => states.includes("saved"), {timeout: 20_000}).toBe(true);
      expect(await readFile(absolute, "utf8")).toBe("locked edit\nbase\n");
      expect(states).toContain("saved");

      // And an ordinary settle keeps working after the recovery: both edits
      // stay in the file, so nothing the lock blocked was dropped.
      states.length = 0;
      await type("second edit\n");
      await session.settleNow();
      expect(states).toEqual(["settling", "saved"]);
      expect(await readFile(absolute, "utf8")).toBe(
        "second edit\nlocked edit\nbase\n",
      );

      await expect(session.close()).resolves.toBeUndefined();
    } finally {
      await release?.();
      await capture.stop().catch(() => undefined);
      await sessions.closeAll().catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
    }
  },
  120_000,
);

// The half a refusal cannot answer, driven against the real daemon. Same
// deferred outside edit as above, but the user has unsettled edits when the
// close runs: the close-settle refuses ConflictStaleTarget, and then the
// release refuses too — a local-only prune needs the CRDT projection to equal
// `last_settled_sha` (crates/dohc-engine-collab/src/durable.rs). The outside
// edit waits for this session, so the close evicts it: the disk version
// stands and the unsettled text comes back as a recovered copy (#2463). The
// save refusal still reads as an error, never as "changed on disk".
it.skipIf(engine.missing)(
  "keeps unsettled edits in a recovered copy when their close meets a deferred outside edit",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-loud-");
    const lifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const errors: string[] = [];
    const workspace = {
      workspaceId: "capture-rust-loud",
      rootPath: root,
      attachmentId: Symbol("test-workspace-attachment:capture-rust-loud"),
    };
    const capture = createAttachedWorkspaceEngineCapture({
      ...workspace,
      rustEngineSessions: sessions,
      onError: (context) => errors.push(context),
    });
    const outside = "written outside dohc\n";
    try {
      await writeFile(join(root, "note.md"), "base\n", "utf8");
      await waitForPathMoments(capture, "note.md", 1);

      const states: string[] = [];
      const session = await capture.openYDocSession({
        path: "note.md",
        onRemoteUpdate: () => undefined,
        onSaveState: (state) => states.push(state),
      });
      const editor = new Y.Doc();
      Y.applyUpdate(editor, session.initialUpdate);
      const type = async (text: string) => {
        const before = Y.encodeStateVector(editor);
        editor.getText("plainText").insert(0, text);
        await session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
      };
      await type("typed in dohc\n");
      await session.settleNow();
      const settledMoments = await listDaemonPathMoments(
        sessions,
        workspace,
        "note.md",
      );
      expect(settledMoments).toHaveLength(2);

      await writeFile(join(root, "note.md"), outside, "utf8");
      await waitForDaemonCaptureDeferral(sessions, workspace);
      expect(
        await listDaemonPathMoments(sessions, workspace, "note.md"),
      ).toHaveLength(2);

      // The difference from the clean case: text the engine has journaled but
      // never settled, so the projection no longer equals `last_settled_sha`
      // and the release cannot prune.
      await type("never settled\n");
      states.length = 0;
      errors.length = 0;

      await expect(session.close()).resolves.toBeUndefined();
      // The refused save reads as the change made outside dohc, which clears
      // its save-failure notice. No capture poll ran before this close.
      expect(states).toContain("error");
      expect(states.at(-1)).toBe("changed-on-disk");
      expect(errors).toContain("ydoc settle of note.md");

      // The close recorded the queued disk edit without letting the refused
      // Y.Doc save overwrite it.
      const capturedMoments = await waitForPathMoments(capture, "note.md", 4);
      expect(capturedMoments).toHaveLength(4);
      const recovery = capturedMoments.find(moment => moment.metadata.origin === "capture-recovery");
      expect(recovery).toBeDefined();
      const detail = await capture.readMoment(recovery!.id);
      if (!detail || detail.protected) throw new Error("recovery must have a readable History payload");
      expect(detail.moment.payload.before?.text).toBe("never settled\ntyped in dohc\nbase\n");
      expect(detail.moment.payload.after?.text).toBe(outside);
      expect(await readFile(join(root, "note.md"), "utf8")).toBe(outside);

      // The outside bytes became the file. The text the engine admitted but
      // never settled is not discarded with the lineage: it comes back as an
      // ordinary sibling file, complete, with its own History moment.
      const recovered = await waitForRecoveredSibling(root, "note");
      expect(await readFile(join(root, recovered), "utf8")).toBe(
        "never settled\ntyped in dohc\nbase\n",
      );
      const [recoveredMoment] = await waitForPathMoments(capture, recovered, 1);
      expect(recoveredMoment?.metadata.origin).toBe("ydoc");
      expect(recoveredMoment?.metadata.summary).toBe(
        "Recovered unsaved edits from note.md after a later write changed the file.",
      );
    } finally {
      await capture.stop().catch(() => undefined);
      await sessions.closeAll().catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
    }
  },
  60_000,
);
