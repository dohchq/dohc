import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  VersionedLoopbackEngine,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import {
  EngineWorkspaceRetryDeadlineError,
  EngineWorkspaceSessions,
  EngineWorkspaceShuttingDownError,
  isEngineWorkspaceOpenRefusedError,
  isEngineWorkspaceRetryDeadlineError,
  type EngineWorkspaceRunOptions,
} from "@dohc/workspace-engine-client/daemon";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import { nativeTmpdir } from "./testTemp";
import {
  YDOC_OPEN_RETRY_DEADLINE_MS,
  YDocOpenRacedError,
  YDocUncapturedArtifactError,
  createWorkspaceEngineCapture,
} from "./workspaceEngineCapture";

// #564: one document open may not hold the capture chain for the whole
// six-attempt transport ladder. The deadline lives in the sessions layer
// (engineWorkspaceSessions.test.ts proves what it does); these prove the
// desktop passes it for exactly the open that holds the chain, and record
// the measured healthy range the limit sits beyond.

const WORKSPACE_ID = "ydoc-open-deadline-test";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(nativeTmpdir(), "dohc-ydoc-deadline-"));
  roots.push(root);
  return root;
}

async function write(root: string, path: string, contents: string) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

function recordingSessions(): {
  sessions: EngineWorkspaceSessions;
  runOptions: Array<EngineWorkspaceRunOptions | undefined>;
} {
  const sessions = mockLiveSessions(new VersionedLoopbackEngine());
  const runOptions: Array<EngineWorkspaceRunOptions | undefined> = [];
  const originalRun = sessions.run.bind(sessions);
  sessions.run = ((workspace, operation, options) => {
    runOptions.push(options);
    return originalRun(workspace, operation, options);
  }) as typeof sessions.run;
  return { sessions, runOptions };
}

function captureWith(root: string, sessions: EngineWorkspaceSessions) {
  const doc = new Y.Doc();
  doc.getText("plainText").insert(0, "seed");
  return createWorkspaceEngineCapture({
    workspaceId: WORKSPACE_ID,
    rootPath: root,
    rustEngineSessions: sessions,
    // The loopback speaks no ydoc.* method, so the provider is stubbed at the
    // same seam the drift/buffer fixtures use. head "present" keeps the open
    // off the absent-head disk checks — this file is about the chain hold,
    // not the admission rules.
    openRustYDocProviderSession: async () => ({
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      contentKind: "plaintext" as const,
      path: "note.md",
      head: "present" as const,
      lineage: "existing" as const,
      applyLocalUpdate: async () => undefined,
      settleNow: async () => ({ sha256: "a".repeat(64), markdown: "" }) as never,
      applyExternalMarkdownEdit: async () => ({ kind: "merged" }) as never,
      close: async () => undefined,
    }),
  });
}

describe("the document open's capture-chain hold (#564)", () => {
  it("bounds the WHOLE task, including the version read before the open", async () => {
    // The hazard the reviewer instrumented: the task reads the active
    // version FIRST, through the store's own six-attempt transport ladder.
    // Bounding only the provider open left that read unbounded — a
    // daemon-down open failed there, held the chain for the full ladder,
    // and rejected with a rebind error the surface reads as an ordinary
    // fallback (the writable plain editor this bound exists to prevent).
    const root = await tempRoot();
    await write(root, "note.md", "hello\n");
    let nowMs = 0;
    const sleeps: number[] = [];
    // The daemon is UP while the store opens — the hazard is a daemon that
    // drops afterwards, so the task begins at the version read exactly as it
    // does in production. Each retry attempt costs 2.5 s of the injected
    // clock: the shape of a workspace.open deadline plus overhead.
    const loopback = new VersionedLoopbackEngine();
    let daemonDown = false;
    const client = {
      close: () => undefined,
      onEvent: () => () => undefined,
      async sendRequest(request: Request): Promise<Response> {
        if (daemonDown) {
          nowMs += 2_500;
          throw { code: "transport-error" };
        }
        if (request.method === "workspace.open") {
          return {
            id: request.id,
            result: { workspace: String(WORKSPACE_ID) },
          };
        }
        if (request.method === "workspace.close") {
          return { id: request.id, result: { closed: true } };
        }
        return await loopback.sendRequest(request);
      },
    };
    const sessions = new EngineWorkspaceSessions(
      { currentClient: () => client },
      {
        now: () => nowMs,
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
        },
      },
    );
    const engine = captureWith(root, sessions);
    engine.start();
    // Opens the store while the daemon is healthy.
    await engine.flush();
    daemonDown = true;

    const refusal = await engine
      .openYDocSession({ path: "note.md", onRemoteUpdate: () => undefined })
      .catch((error: unknown) => error);

    // MUTATION: drop withRetryBudget from the task -> the version read runs
    // its full ladder and this is an EngineWorkspaceRebindError instead,
    // which main maps to a plain fallback rather than openTimedOut.
    expect(isEngineWorkspaceRetryDeadlineError(refusal)).toBe(true);
    expect((refusal as Error).message).toContain(
      `limit of ${YDOC_OPEN_RETRY_DEADLINE_MS}ms`,
    );
    // The budget stopped the ladder well inside the six attempts it would
    // otherwise have spent holding the chain.
    expect(sleeps.length).toBeLessThanOrEqual(3);
    await engine.stop();
  });

  it("passes no per-run deadline: the task budget is the only one", async () => {
    const root = await tempRoot();
    await write(root, "note.md", "hello\n");
    const { sessions, runOptions } = recordingSessions();
    const engine = captureWith(root, sessions);
    engine.start();
    await engine.flush();

    const session = await engine.openYDocSession({
      path: "note.md",
      onRemoteUpdate: () => undefined,
    });
    await session.close({ settle: false });
    await engine.stop();

    // One budget for the task, not one per call: a per-run deadline here
    // would mean the task carries two clocks that disagree.
    expect(
      runOptions.filter((options) => options?.retryDeadlineMs !== undefined),
    ).toHaveLength(0);
    expect(runOptions.length).toBeGreaterThan(1);
  });

  it("sits beyond the measured healthy open on a busy chain", async () => {
    // AGENTS.md, measure limits that reject work: the deadline only ever
    // interrupts transport-retry WAITING, but the honest floor is still the
    // healthy open itself. Eight opens, each queued behind a captureBatch of
    // three files (the chain traffic a busy workspace produces), through the
    // real chain + loopback RPCs with an instant provider stub. Real daemon
    // RPC latency is governed separately by WORKSPACE_OPEN_DEADLINE_MS, which
    // the deadline is derived FROM — so the margin measured here understates
    // the real one only by bounded, already-budgeted amounts.
    const root = await tempRoot();
    await write(root, "note.md", "hello\n");
    const { sessions } = recordingSessions();
    const engine = captureWith(root, sessions);
    engine.start();
    await engine.flush();

    let maxMs = 0;
    for (let round = 0; round < 8; round += 1) {
      for (let file = 0; file < 3; file += 1) {
        await write(root, `busy-${file}.md`, `round ${round} file ${file}\n`);
      }
      engine.captureBatch([
        { path: "busy-0.md", operation: "update" },
        { path: "busy-1.md", operation: "update" },
        { path: "busy-2.md", operation: "update" },
      ]);
      const startedAt = performance.now();
      const session = await engine.openYDocSession({
        path: "note.md",
        onRemoteUpdate: () => undefined,
      });
      maxMs = Math.max(maxMs, performance.now() - startedAt);
      await session.close({ settle: false });
    }
    await engine.stop();

    console.log(
      `[measure] healthy ydoc open on a busy chain: max ${maxMs.toFixed(1)}ms ` +
        `over 8 opens; YDOC_OPEN_RETRY_DEADLINE_MS=${YDOC_OPEN_RETRY_DEADLINE_MS}ms`,
    );
    expect(maxMs).toBeLessThan(YDOC_OPEN_RETRY_DEADLINE_MS);
  });

  // #564, codex round 13. The absent-head branches REFUSE by releasing the
  // session and then throwing a refusal that describes the DISK. That release
  // runs inside the same budget the task opened, so a flaky transport can
  // leave it spent — and then the close rejects with the deadline error, the
  // daemon still holds the restart-safe session, and the refusal thrown in its
  // place is one main answers with a plain `available:false`. The renderer
  // hands the user a writable plain editor over a session the engine has not
  // released: the double writer #533 and #567 exist to prevent.
  describe("a release the budget refused is not a disk verdict", () => {
    function captureRefusingRelease(
      root: string,
      sessions: EngineWorkspaceSessions,
      closeError: unknown,
    ) {
      const doc = new Y.Doc();
      return createWorkspaceEngineCapture({
        workspaceId: WORKSPACE_ID,
        rootPath: root,
        rustEngineSessions: sessions,
        // Absent head AND absent lineage: the bind the absent-head contract
        // judges by what is on disk.
        openRustYDocProviderSession: async () => ({
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext" as const,
          path: "note.md",
          head: "absent" as const,
          lineage: "absent" as const,
          applyLocalUpdate: async () => undefined,
          settleNow: async () =>
            ({ sha256: "a".repeat(64), markdown: "" }) as never,
          applyExternalMarkdownEdit: async () => ({ kind: "merged" }) as never,
          close: async () => {
            throw closeError;
          },
        }),
      });
    }

    async function refusalFrom(
      root: string,
      closeError: unknown,
    ): Promise<unknown> {
      const { sessions } = recordingSessions();
      const engine = captureRefusingRelease(root, sessions, closeError);
      engine.start();
      await engine.flush();
      const refusal = await engine
        .openYDocSession({ path: "note.md", onRemoteUpdate: () => undefined })
        .catch((error: unknown) => error);
      await engine.stop();
      return refusal;
    }

    it("reports the timeout, not an uncaptured artifact, when the release times out", async () => {
      const root = await tempRoot();
      // Content on disk: the branch that refuses whatever else is true.
      await write(root, "note.md", "uncaptured bytes\n");

      const refusal = await refusalFrom(
        root,
        new EngineWorkspaceRetryDeadlineError(
          WORKSPACE_ID,
          "withRetryBudget budgetMs",
          YDOC_OPEN_RETRY_DEADLINE_MS,
          "since the first failure",
          YDOC_OPEN_RETRY_DEADLINE_MS,
          YDOC_OPEN_RETRY_DEADLINE_MS,
          2,
          new Error("transport-error"),
        ),
      );

      // MUTATION: attach the release failure as `refusal.cause` and throw the
      // artifact refusal anyway -> main answers a bare `available:false` and
      // the renderer opens the writable plain editor over a session the
      // daemon still holds.
      expect(isEngineWorkspaceRetryDeadlineError(refusal)).toBe(true);
      expect(refusal).not.toBeInstanceOf(YDocUncapturedArtifactError);
    });

    // The other half of the same defect, and the one the user feels. The
    // client stopped waiting; the daemon did not stop working. Its close runs
    // in a SPAWNED task (crates/dohc-workspace-engine/src/lib.rs,
    // ydoc_close_inner) that runs to completion whatever happens to the RPC
    // future, and a genuine close refusal — an update raced in, so the
    // lineage is dirty — REINSERTS the session entry with its lease held.
    // The refusal that left this function was the last reference to that
    // session, so every later open answered ydoc-session-busy and "Try again"
    // could never work again. Retain it where a close can still reach it.
    it("discharges the session it could not release, so the retry binds", async () => {
      const root = await tempRoot();
      await write(root, "note.md", "uncaptured bytes\n");
      const { sessions } = recordingSessions();
      const doc = new Y.Doc();
      let opens = 0;
      let closes = 0;
      const engine = createWorkspaceEngineCapture({
        workspaceId: WORKSPACE_ID,
        rootPath: root,
        rustEngineSessions: sessions,
        openRustYDocProviderSession: async () => {
          opens += 1;
          // Open 1 binds absent-head over content and refuses. Open 2 is the
          // user's retry, by which point the racing update has landed — the
          // daemon has a head, so the document binds normally.
          const absent = opens === 1;
          return {
            doc,
            initialUpdate: Y.encodeStateAsUpdate(doc),
            contentKind: "plaintext" as const,
            path: "note.md",
            head: absent ? ("absent" as const) : ("present" as const),
            lineage: absent ? ("absent" as const) : ("existing" as const),
            applyLocalUpdate: async () => undefined,
            settleNow: async () =>
              ({ sha256: "a".repeat(64), markdown: "" }) as never,
            applyExternalMarkdownEdit: async () =>
              ({ kind: "merged" }) as never,
            close: async () => {
              closes += 1;
              // The refusal release: the budget stopped waiting for it.
              if (closes === 1) {
                throw new EngineWorkspaceRetryDeadlineError(
                  WORKSPACE_ID,
                  "withRetryBudget budgetMs",
                  YDOC_OPEN_RETRY_DEADLINE_MS,
                  "since the first failure",
                  YDOC_OPEN_RETRY_DEADLINE_MS,
                  YDOC_OPEN_RETRY_DEADLINE_MS,
                  2,
                  new Error("transport-error"),
                );
              }
            },
          };
        },
      });
      engine.start();
      await engine.flush();

      const refusal = await engine
        .openYDocSession({ path: "note.md", onRemoteUpdate: () => undefined })
        .catch((error: unknown) => error);
      expect(isEngineWorkspaceRetryDeadlineError(refusal)).toBe(true);

      // "Try again". MUTATION: drop the retention (or the discharge) -> the
      // unreleased session is unreachable, and in production every open from
      // here answers ydoc-session-busy until the app restarts.
      const session = await engine.openYDocSession({
        path: "note.md",
        onRemoteUpdate: () => undefined,
      });
      expect(session.doc).toBe(doc);
      // The retry closed the stranded session before binding a new one.
      expect(closes).toBe(2);

      await session.close({ settle: false });
      await engine.stop();
    });

    it("reports the shutdown, not a raced open, when quit refuses the release", async () => {
      const root = await tempRoot();
      // No file: the sibling branch, which would otherwise claim the open
      // raced a writer and fall back the same silent way.

      const refusal = await refusalFrom(
        root,
        new EngineWorkspaceShuttingDownError(),
      );

      // MUTATION: keep `released = false` as the only classification -> the
      // raced refusal downgrades a quitting app to the plain editor.
      expect(isEngineWorkspaceOpenRefusedError(refusal)).toBe(true);
      expect(refusal).not.toBeInstanceOf(YDocOpenRacedError);
    });
  });
});
