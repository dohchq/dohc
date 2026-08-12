import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { defaultWorkspaceMode } from "@dohc/workspace-core";
import {
  EngineDaemonLifecycle,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import {
  VersionedLiveAdapter,
  YdocReleasedWithSettleFailureError,
} from "@dohc/workspace-engine-client";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import {
  createWorkspaceEngineCapture,
  isYDocPathNotInVersionError,
  YDocUncapturedArtifactError,
} from "./workspaceEngineCapture";
import { createWorkspaceActivity } from "./workspaceActivity";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import { createTestScratch } from "./testTemp";
import { waitForPathMoments } from "./waitForPathMoments";

// This suite looked only under the repo root, so it SKIPPED everywhere from the
// day it was written and its coverage came and went with whoever last ran
// `cargo build` (#390). The shared gate also checks apps/desktop/target/debug,
// which is where the app under test and the staged-binary harnesses put it.
const engine = requireEngineBinaryOrSkip();

async function waitForDaemonCaptureDeferral(
  sessions: EngineWorkspaceSessions,
  workspaceId: string,
  rootPath: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const outcome = await sessions.run(
      { workspaceId, rootPath },
      async ({ client, workspace }) =>
        await new VersionedLiveAdapter(client, workspace, {
          workspaceId,
        }).flushCapture(),
    );
    if (!outcome.settled) return;
    await delay(25);
  }
  throw new Error("Daemon capture did not report its live-session deferral.");
}

async function listDaemonPathMoments(
  sessions: EngineWorkspaceSessions,
  workspaceId: string,
  rootPath: string,
  path: string,
) {
  const page = await sessions.run(
    { workspaceId, rootPath },
    async ({ client, workspace }) =>
      await new VersionedLiveAdapter(client, workspace, {
        workspaceId,
      }).listMoments({ workspaceId, limit: 100 }),
  );
  return page.moments.filter((moment) => moment.path === path);
}

it.skipIf(engine.missing)(
  "drives watcher-batch capture, readback, and version-switch materialization through the real daemon",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-e2e-");
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
    const root = await createTestScratch("dohc-capture-rust-drift-");
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
    const root = await createTestScratch("dohc-capture-rust-stop-");
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
    const root = await createTestScratch("dohc-capture-rust-codes-");
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

// #496 under the live-session capture gate: the daemon observes the outside
// edit but cannot ingest it while the Y.Doc lease is live. The unsettled flush
// is the ordering proof. A clean close releases the lease, after which the
// queued disk edit becomes a capture moment.
it.skipIf(engine.missing)(
  "closes clean, then captures an outside edit deferred by its live lease",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-race-");
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
    const errors: string[] = [];
    const capture = createWorkspaceEngineCapture({
      workspaceId: "capture-rust-race",
      rootPath: root,
      rustEngineSessions: sessions,
      daemonOwnsCapture: true,
      onError: (context) => errors.push(context),
    });
    const outside = "written outside dohc\n";
    const workspaceId = "capture-rust-race";
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
        workspaceId,
        root,
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
      await waitForDaemonCaptureDeferral(sessions, workspaceId, root);
      expect(
        await listDaemonPathMoments(sessions, workspaceId, root, "note.md"),
      ).toHaveLength(2);
      states.length = 0;
      errors.length = 0;

      // A clean close: nothing was typed since the settle, so the release
      // prunes, which is what proves the refusal benign — the file belongs to
      // the outside author and this document's text is a settled moment in
      // History. The refusal is still reported as it happens and withdrawn
      // after the release; the editor's LAST word is what it acts on.
      await expect(session.close()).resolves.toBeUndefined();
      expect(states).toEqual(["settling", "error", "changed-on-disk"]);
      expect(errors).toEqual(["ydoc settle of note.md"]);

      expect(await readFile(join(root, "note.md"), "utf8")).toBe(outside);

      // Reopening the workspace rebuilds the capture layer from its durable
      // manifest. That is the deterministic retry seam for the path the
      // live-lease refusal parked.
      await sessions.closeWorkspace(workspaceId);
      const capturedMoments = await waitForPathMoments(
        capture,
        "note.md",
        settledMoments.length + 1,
      );
      expect(capturedMoments).toHaveLength(3);
      expect(capturedMoments[0]?.id).not.toBe(settledMoments[0]?.id);
    } finally {
      await capture.stop().catch(() => undefined);
      await sessions.closeAll().catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
    }
  },
  60_000,
);

// dohc-ai/dohc#337 item 5, driven by its own mechanism: another app holds the
// `.md` open WITHOUT FILE_SHARE_DELETE, so every attempt to replace it fails
// with a sharing violation. An ACL cannot model this — the workspace folder
// grants FILE_DELETE_CHILD, which lets the replace through a deny-write ACE on
// the file itself.
async function holdWithoutShareDelete(absolute: string): Promise<() => Promise<void>> {
  const script =
    `$f=[System.IO.File]::Open('${absolute.replace(/'/g, "''")}','Open','ReadWrite','Read');` +
    "Write-Output 'held';[Console]::In.ReadLine()|Out-Null;$f.Close()";
  const child = spawn(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    let seen = "";
    child.stdout.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      if (seen.includes("held")) resolve();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
    });
    child.on("exit", () => reject(new Error(`holder exited: ${seen}`)));
    child.on("error", reject);
  });
  return async () => {
    child.stdin.write("\n");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  };
}

// The journey behind #337 item 5, end to end through the real daemon. It was
// filed as "no retry OR error". PR #495 gave the save indicator honest
// states; #554 closes the retry half: a file-locked settle re-arms itself
// with backoff, so the write lands when the external handle releases — no
// further edit needed.
it.skipIf(engine.missing || process.platform !== "win32")(
  "surfaces a locked save and lands it by itself once the lock releases",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-lock-");
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
    const errors: string[] = [];
    const capture = createWorkspaceEngineCapture({
      workspaceId: "capture-rust-lock",
      rootPath: root,
      rustEngineSessions: sessions,
      daemonOwnsCapture: true,
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
      expect(states).toEqual(["settling", "file-locked"]);
      expect(errors).toEqual(["ydoc settle of note.md"]);
      expect(await readFile(absolute, "utf8")).toBe("base\n");

      await release();
      release = null;
      states.length = 0;
      errors.length = 0;

      // The item's second claim, closed (#554): the provider retries the
      // settle on a doubling delay, so releasing the lock is followed by the
      // write landing BY ITSELF — no further edit. The retry replays the
      // durably pending materialization job through the idempotent settle.
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if ((await readFile(absolute, "utf8")) !== "base\n") break;
        await delay(200);
      }
      expect(await readFile(absolute, "utf8")).toBe("locked edit\nbase\n");
      expect(states).toContain("saved");

      // And an ordinary settle keeps working after the recovery: BOTH edits
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
// deferred outside edit as above, but the user has UNSETTLED edits when the
// close runs: the close-settle refuses ConflictStaleTarget, and then the
// release refuses too — a local-only prune needs the CRDT projection to equal
// `last_settled_sha` (crates/dohc-engine-collab/src/durable.rs) and the
// daemon REINSERTS the session entry on that refusal
// (crates/dohc-workspace-engine/src/lib.rs, ydoc_close_inner). The doc stays
// reserved, live, and unsaved, so the failure must stay loud. Deciding this
// at the refusal instead of after the release reported "changed on disk" over
// exactly this state.
it.skipIf(engine.missing)(
  "keeps the close loud when unsettled edits meet a deferred outside edit",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-loud-");
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
    const errors: string[] = [];
    const capture = createWorkspaceEngineCapture({
      workspaceId: "capture-rust-loud",
      rootPath: root,
      rustEngineSessions: sessions,
      daemonOwnsCapture: true,
      onError: (context) => errors.push(context),
    });
    const outside = "written outside dohc\n";
    const workspaceId = "capture-rust-loud";
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
        workspaceId,
        root,
        "note.md",
      );
      expect(settledMoments).toHaveLength(2);

      await writeFile(join(root, "note.md"), outside, "utf8");
      await waitForDaemonCaptureDeferral(sessions, workspaceId, root);
      expect(
        await listDaemonPathMoments(sessions, workspaceId, root, "note.md"),
      ).toHaveLength(2);

      // The difference from the clean case: text the engine has journaled but
      // never settled, so the projection no longer equals `last_settled_sha`
      // and the release cannot prune.
      await type("never settled\n");
      states.length = 0;
      errors.length = 0;

      const closeError = await session.close().then(
        () => null,
        (error: unknown) => error,
      );
      // The sharpest statement of the fix. The error the release throws here
      // CARRIES the stale-target message — the escalated settling release
      // refuses the same way the settle did — while NOT being the
      // released-with-settle-failure signal, because nothing was released.
      // A downgrade keyed on the refusal's message would fire on exactly
      // this; keyed on the type, it cannot.
      expect(closeError).not.toBeNull();
      expect(closeError).not.toBeInstanceOf(YdocReleasedWithSettleFailureError);
      expect(String(closeError)).toContain("conflict-stale-target");
      expect(states.at(-1)).toBe("error");
      expect(states).not.toContain("changed-on-disk");
      expect(errors).toContain("ydoc settle of note.md");

      // The refused close kept the session usable and its lease held. A
      // second settle reaches the same stale target, and no capture moment
      // can appear over that still-unsaved Y.Doc state.
      await expect(session.settleNow()).rejects.toThrow("conflict-stale-target");
      expect(
        await listDaemonPathMoments(sessions, workspaceId, root, "note.md"),
      ).toHaveLength(2);

      // The outside author still owns the file, and the unsettled text is not
      // in it — which is why "changed on disk" would have been a lie.
      expect(await readFile(join(root, "note.md"), "utf8")).toBe(outside);

      // Workspace teardown is the safe eviction boundary after the caller
      // has observed the loud refusal. Reopening rebuilds capture and ingests
      // the queued disk edit without letting the failed Y.Doc close overwrite
      // it.
      await sessions.closeWorkspace(workspaceId);
      const capturedMoments = await waitForPathMoments(capture, "note.md", 3);
      expect(capturedMoments).toHaveLength(3);
      expect(await readFile(join(root, "note.md"), "utf8")).toBe(outside);
    } finally {
      await capture.stop().catch(() => undefined);
      await sessions.closeAll().catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
    }
  },
  60_000,
);

// #534 against the REAL daemon, which is the only place `head` actually
// crosses the wire. The loopback tests state what the daemon does; this proves
// the daemon does it — that an absent head really comes back absent, and that
// the three outcomes the contract distinguishes are the three that happen.
it.skipIf(engine.missing)(
  "refuses a live session for a path the version does not have, and still opens a new file",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-absent-");
    const lifecycle = new EngineDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = new EngineWorkspaceSessions(lifecycle);
    const capture = createWorkspaceEngineCapture({
      workspaceId: "capture-rust-absent-head",
      rootPath: root,
      rustEngineSessions: sessions,
      daemonOwnsCapture: true,
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

      // On disk with content but not captured yet: refused, but NOT as missing.
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

      // Creation, the case the daemon's absent-head bind exists for: an EMPTY
      // artifact on disk, exactly what workspaceFiles.createFile leaves. The
      // open must be ADMITTED — the guard above refused two paths in a row, and
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
