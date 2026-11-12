import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { defaultWorkspaceMode } from "@dohc/workspace-core";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import { createWorkspaceEngineCapture as createAttachedWorkspaceEngineCapture, isYDocPathNotInVersionError, YDocUncapturedArtifactError } from "./workspaceEngineCapture";
import { createInMemoryWorkspaceActivity as createWorkspaceActivity } from "./workspaceActivity.testSupport";
import { createRealDaemonLifecycle, createRealDaemonWorkspaceSessions } from "../testing/realDaemonWorkspaceSessions";
import { createTestScratch } from "./testTemp";
import { waitForPathMoments } from "./waitForPathMoments";
import { createWorkspaceEngineCapture, engine, waitForDaemonCaptureDeferral, waitForRecoveredSibling, listDaemonPathMoments, holdWithoutShareDelete } from "./workspaceEngineCaptureRust.fixture";

// Another app (Notepad, an agent, `>>`) writes the.md while the
// document is open in dohc. The session's close runs a pre-close settle; the
// engine answers it from the lineage's last settled content and never touches
// the drifted file, and the desktop then mirrored those bytes over it — the
// outside edit vanished from disk, recoverable only by knowing to open
// History. The mirror write is the clobber, so this test reads DISK.
it.skipIf(engine.missing)(
  "keeps an edit made outside dohc when the open document closes",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-drift-");
    const lifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const capture = createWorkspaceEngineCapture({
      workspaceId: "capture-rust-drift",
      rootPath: root,
      rustEngineSessions: sessions,
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
        settled?.content,
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

// #496 under the live-session capture gate: the daemon observes the outside
// edit but cannot ingest it while the Y.Doc lease is live. The deferred path
// is the ordering proof. A clean close releases the lease, after which the
// queued disk edit becomes a capture moment.
it.skipIf(engine.missing)(
  "closes clean, then captures an outside edit deferred by its live lease",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-race-");
    const lifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const errors: string[] = [];
    const workspace = {
      workspaceId: "capture-rust-race",
      rootPath: root,
      attachmentId: Symbol("test-workspace-attachment:capture-rust-race"),
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
      const before = Y.encodeStateVector(editor);
      editor.getText("plainText").insert(0, "typed in dohc\n");
      await session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, before));
      await session.settleNow();
      const settledMoments = await listDaemonPathMoments(
        sessions,
        workspace,
        "note.md",
      );
      expect(settledMoments).toHaveLength(2);
      expect(
        settledMoments.some((moment) =>
          moment.afterText?.includes("typed in dohc"),
        ),
      ).toBe(true);

      // The outside writer replaces the file. Capture observes it, but the
      // live Y.Doc lease keeps the head at the last settled projection.
      await writeFile(join(root, "note.md"), outside, "utf8");
      await waitForDaemonCaptureDeferral(sessions, workspace);
      expect(
        await listDaemonPathMoments(sessions, workspace, "note.md"),
      ).toHaveLength(2);
      states.length = 0;
      errors.length = 0;

      // Nothing was typed since the verified settle. Close reuses that
      // settlement and releases the lease without settling or reporting save
      // states or errors. The outside author's bytes remain on disk.
      await expect(session.close()).resolves.toBeUndefined();
      expect(states).toEqual([]);
      expect(errors).toEqual([]);

      expect(await readFile(join(root, "note.md"), "utf8")).toBe(outside);

      // Reopening the workspace rebuilds the capture layer from its durable
      // manifest. That is the deterministic retry seam for the path the
      // live-lease refusal parked.
      await sessions.closeWorkspace(workspace);
      const capturedMoments = await waitForPathMoments(
        capture,
        "note.md",
        settledMoments.length + 1,
      );
      expect(capturedMoments).toHaveLength(3);
      expect(capturedMoments[0]?.id).not.toBe(settledMoments[0]?.momentId);
    } finally {
      await capture.stop().catch(() => undefined);
      await sessions.closeAll().catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
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

// #534 against the real daemon, which is the only place `head` actually
// crosses the wire. The loopback tests state what the daemon does; this proves
// the daemon does it — that an absent head really comes back absent, and that
// the three outcomes the contract distinguishes are the three that happen.
it.skipIf(engine.missing)(
  "refuses a live session for a path the version does not have, and still opens a new file",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-absent-");
    const lifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const capture = createWorkspaceEngineCapture({
      workspaceId: "capture-rust-absent-head",
      rootPath: root,
      rustEngineSessions: sessions,
    });
    try {
      // Nothing in the version, nothing on disk: the path is not here.
      const refusal = await capture
        .openYDocSession({ path: "gone.md", onRemoteUpdate: () => undefined })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(isYDocPathNotInVersionError(refusal)).toBe(true);
      // The refusal wrote nothing. This is the phantom, at the real boundary.
      await expect(readFile(join(root, "gone.md"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });

      // On disk with content but not captured yet: refused, but not as missing.
      await writeFile(join(root, "uncaptured.md"), "real bytes", "utf8");
      const uncaptured = await capture
        .openYDocSession({
          path: "uncaptured.md",
          onRemoteUpdate: () => undefined,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(uncaptured).toBeInstanceOf(YDocUncapturedArtifactError);
      expect(await readFile(join(root, "uncaptured.md"), "utf8")).toBe(
        "real bytes",
      );

      // Creation, the case the daemon's absent-head bind exists for: an empty
      // artifact on disk, exactly what workspaceFiles.createFile leaves. The
      // open must be admitted — the guard above refused two paths in a row, and
      // a guard that refused this one too would look just as green.
      //
      // Deliberately stops at the open. Whether the daemon's own capture reaches
      // the new file before or after this runs is a race, and settling across it
      // is a separate, pre-existing conflict (the settle expects the head the
      // open saw). What is race-free, and what this proves, is that a
      // freshly-created empty artifact still opens against the real daemon.
      await writeFile(join(root, "created.md"), "", "utf8");
      const session = await capture.openYDocSession({
        path: "created.md",
        onRemoteUpdate: () => undefined,
      });
      expect(session.path).toBe("created.md");
      await session.close({ settle: false });
    } finally {
      await capture.stop();
      await sessions.closeAll();
      await lifecycle.stop();
    }
  },
  60_000,
);
