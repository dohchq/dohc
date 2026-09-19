import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  DaemonRefusalError,
  YDOC_OPEN_DEADLINE_MS,
  YdocOpenTimedOutError,
  type Request,
  type Response,
  type Event,
} from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import {
  EngineRequestDeadlineError,
  EngineRequestError,
  EngineWorkspaceRetryDeadlineError,
  EngineWorkspaceSessions,
  EngineWorkspaceShuttingDownError,
  isEngineWorkspaceOpenRefusedError,
  type EngineWorkspaceRunOptions,
} from "@dohc/workspace-engine-client/daemon";
import {
  daemonCaptureLifecycleAnswer,
  mockLiveSessions,
} from "../testing/liveEngineSessions";
import {
  YDOC_OPEN_RETRY_DEADLINE_MS,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
  YDocOpenRacedError,
  YDocSessionUnreleasedError,
  YDocUncapturedArtifactError,
  createWorkspaceEngineCapture as createAttachedWorkspaceEngineCapture,
  isYDocSessionUnreleasedError,
  type WorkspaceEngineCaptureOptions,
} from "./workspaceEngineCapture";

import { createTestScratch } from "./testTemp";
function createWorkspaceEngineCapture(
  options: Omit<WorkspaceEngineCaptureOptions, "attachmentId">,
) {
  return createAttachedWorkspaceEngineCapture({
    ...options,
    attachmentId: Symbol(`test-workspace-attachment:${options.workspaceId}`),
  });
}

// One document open may not hold the capture chain for the whole
// six-attempt transport ladder. The deadline lives in the sessions layer
// (engineWorkspaceSessions.test.ts proves what it does); these prove the
// desktop passes it for exactly the open that holds the chain, and record
// the measured healthy range the limit sits beyond.

const WORKSPACE_ID = "ydoc-open-deadline-test";

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

function captureWith(
  root: string,
  sessions: EngineWorkspaceSessions,
  onProviderOpen = () => {},
) {
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
    openRustYDocProviderSession: async () => {
      onProviderOpen();
      return {
        doc,
        initialUpdate: Y.encodeStateAsUpdate(doc),
        contentKind: "plaintext" as const,
        path: "note.md",
        head: "present" as const,
        lineage: "existing" as const,
        applyLocalUpdate: async () => undefined,
        settleNow: async () => ({ sha256: "a".repeat(64), content: "" }) as never,
        applyExternalMarkdownEdit: async () => ({ kind: "merged" }) as never,
        close: async () => undefined,
        evict: async () => undefined,
      };
    },
  });
}

describe("the document open's capture-chain hold", () => {
  it("wakes the opening document on capture settlement and still checks the active version", async () => {
    const root = await createTestScratch("dohc-ydoc-capture-wake-");
    await write(root, "note.md", "hello\n");
    const loopback = new VersionedLoopbackEngine();
    const handlers = new Set<(event: Event) => void>();
    const waits = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const fallback = Promise.withResolvers<void>();
    let importing = false;
    let activeReads = 0;
    let sleeps = 0;
    const providerOpen = vi.fn();
    const client = {
      close: () => undefined,
      onEvent(handler: (event: Event) => void) {
        handlers.add(handler);
        return () => { handlers.delete(handler); };
      },
      async sendRequest(request: Request): Promise<Response> {
        if (request.method === "workspace.open") {
          return { id: request.id, result: { workspace: WORKSPACE_ID } };
        }
        if (request.method === "workspace.close") {
          return { id: request.id, result: { closed: true } };
        }
        if (importing && request.method === "versions.active") {
          activeReads += 1;
          throw new EngineRequestError(request.id, {
            code: "OVERLOADED",
            message: "Workspace is still updating. Try again.",
            retry: "afterBackoff",
          });
        }
        return daemonCaptureLifecycleAnswer(request) ?? await loopback.sendRequest(request);
      },
    };
    const sessions = new EngineWorkspaceSessions({ currentClient: () => client }, {
      sleep: () => {
        waits[sleeps++]?.resolve();
        return fallback.promise;
      },
    });
    const engine = captureWith(root, sessions, providerOpen);
    const notify = () => {
      for (const handler of [...handlers]) handler({
        name: "capture.initialSettled", payload: { workspaceId: WORKSPACE_ID },
        seq: 1, sessionGeneration: 1,
      });
    };
    engine.start();
    await engine.flush();
    importing = true;
    const opening = engine.openYDocSession({ path: "note.md", onRemoteUpdate: () => undefined });
    try {
      await waits[0]!.promise;
      notify();
      await waits[1]!.promise;
      expect(providerOpen).not.toHaveBeenCalled();
      expect(activeReads).toBe(2);
      importing = false;
      notify();
      await opening;
      expect(providerOpen).toHaveBeenCalledOnce();
      expect(sleeps).toBe(2);
      expect(handlers.size).toBe(0);
    } finally {
      importing = false;
      fallback.resolve();
      await opening.catch(() => undefined);
      await engine.stop();
    }
  });

  it.each(["ready", "deadline", "shutdown"] as const)(
    "waits for the initial capture before opening the provider: %s",
    async (outcome) => {
      const root = await createTestScratch("dohc-ydoc-initial-capture-");
      await write(root, "note.md", "hello\n");
      const loopback = new VersionedLoopbackEngine();
      let importing = false;
      let activeReads = 0;
      let workspaceOpens = 0;
      let providerOpens = 0;
      let nowMs = 0;
      const sleeps: number[] = [];
      const client = {
        close: () => undefined,
        onEvent: () => () => undefined,
        async sendRequest(request: Request): Promise<Response> {
          if (request.method === "workspace.open") {
            workspaceOpens += 1;
            return { id: request.id, result: { workspace: WORKSPACE_ID } };
          }
          if (request.method === "workspace.close") {
            return { id: request.id, result: { closed: true } };
          }
          if (importing && request.method === "versions.active") {
            activeReads += 1;
            throw new EngineRequestError(request.id, {
              code: "OVERLOADED",
              message: "Workspace is still updating. Try again.",
              retry: "afterBackoff",
            });
          }
          return daemonCaptureLifecycleAnswer(request) ?? await loopback.sendRequest(request);
        },
      };
      const sessions = new EngineWorkspaceSessions({ currentClient: () => client }, {
        now: () => nowMs,
        sleep: async (delayMs) => {
          sleeps.push(delayMs);
          nowMs += delayMs;
          // Initial capture can take more attempts than transport recovery.
          if (outcome === "ready" && sleeps.length === 8) importing = false;
          if (outcome === "shutdown") sessions.beginShutdown();
        },
      });
      const engine = captureWith(root, sessions, () => { providerOpens += 1; });
      engine.start();
      await engine.flush();
      const opensBefore = workspaceOpens;
      importing = true;
      try {
        const opened = await engine.openYDocSession({
          path: "note.md", onRemoteUpdate: () => undefined,
        }).catch((error: unknown) => error);
        if (outcome === "ready") {
          expect(opened).not.toBeInstanceOf(Error);
          expect(providerOpens).toBe(1);
          expect(activeReads).toBe(8);
        } else {
          expect(opened).toBeInstanceOf(
            outcome === "deadline" ? EngineWorkspaceRetryDeadlineError : DaemonRefusalError,
          );
          expect(isEngineWorkspaceOpenRefusedError(opened)).toBe(true);
          expect(providerOpens).toBe(0);
          if (outcome === "deadline") {
            expect(nowMs).toBeGreaterThanOrEqual(YDOC_OPEN_RETRY_DEADLINE_MS);
          } else {
            expect(activeReads).toBe(1);
          }
        }
        expect(sleeps.length).toBeGreaterThan(0);
        expect(workspaceOpens).toBe(opensBefore);
        importing = false;
        // A finished or refused open must release the capture chain.
        await engine.listMoments({ limit: 1 });
      } finally {
        importing = false;
        await engine.stop();
      }
    },
  );

  it("bounds the whole task, including the version read before the open", async () => {
    // The hazard the reviewer instrumented: the task reads the active
    // version first, through the store's own six-attempt transport ladder.
    // Bounding only the provider open left that read unbounded — a
    // daemon-down open failed there, held the chain for the full ladder,
    // and rejected with a rebind error the surface reads as an ordinary
    // fallback (the writable plain editor this bound exists to prevent).
    const root = await createTestScratch("dohc-ydoc-deadline-");
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
        return (
          daemonCaptureLifecycleAnswer(request) ?? (await loopback.sendRequest(request))
        );
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

    expect(refusal, "drop withRetryBudget from the task -> the version read runs its full ladder and this is an EngineWorkspaceRebindError instead, which main maps to a plain fallback rather than engineMayHoldDocument.").toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
    expect((refusal as Error).message).toContain(
      `limit of ${YDOC_OPEN_RETRY_DEADLINE_MS}ms`,
    );
    // The budget stopped the ladder well inside the six attempts it would
    // otherwise have spent holding the chain.
    expect(sleeps.length).toBeLessThanOrEqual(3);
    // stop() flushes daemon capture, so the daemon has to be back for it.
    daemonDown = false;
    await engine.stop();
  });

  it("frees the chain at the ydoc.open bound when the daemon never answers", async () => {
    // The retry budget above bounds retry waiting, and a daemon that
    // accepts `ydoc.open` and then says nothing never fails once — so before
    // this bound the chain was held for as long as the silence lasted.
    const root = await createTestScratch("dohc-ydoc-deadline-");
    await write(root, "note.md", "hello\n");
    const loopback = new VersionedLoopbackEngine();
    // The EngineClient seam, and only it: a deadlined request arms a timer at
    // `request.deadlineMs` and rejects with EngineRequestDeadlineError
    // (engineClient.ts, `sendRequest`). Everything else answers normally, so
    // the open reaches `ydoc.open` through the real provider and the real
    // adapter rather than a stub standing in for them.
    const client = {
      close: () => undefined,
      onEvent: () => () => undefined,
      async sendRequest(request: Request): Promise<Response> {
        if (request.method === "workspace.open") {
          return { id: request.id, result: { workspace: String(WORKSPACE_ID) } };
        }
        if (request.method === "workspace.close") {
          return { id: request.id, result: { closed: true } };
        }
        if (request.method === "ydoc.open") {
          const deadlineMs = request.deadlineMs;
          if (deadlineMs === undefined || deadlineMs === null) {
            return await new Promise<never>(() => undefined);
          }
          return await new Promise<never>((_resolve, reject) => {
            setTimeout(() => {
              reject(
                new EngineRequestDeadlineError(
                  request.id,
                  request.method,
                  deadlineMs,
                ),
              );
            }, deadlineMs);
          });
        }
        return (
          daemonCaptureLifecycleAnswer(request) ?? (await loopback.sendRequest(request))
        );
      },
    };
    const sessions = new EngineWorkspaceSessions({ currentClient: () => client });
    const engine = createWorkspaceEngineCapture({
      workspaceId: WORKSPACE_ID,
      rootPath: root,
      rustEngineSessions: sessions,
    });
    engine.start();
    await engine.flush();

    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
    });
    try {
      const opening = engine
        .openYDocSession({ path: "note.md", onRemoteUpdate: () => undefined })
        .catch((error: unknown) => error);
      // Ordinary chain traffic, queued behind the open. Whether it runs is how
      // "the chain is held" is observed rather than asserted.
      let chainFreed = false;
      const queued = engine
        .listMoments({ limit: 1 })
        .then(() => {
          chainFreed = true;
        })
        .catch(() => {
          chainFreed = true;
        });

      await vi.advanceTimersByTimeAsync(YDOC_OPEN_DEADLINE_MS - 1);
      expect(chainFreed).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const refusal = await opening;
      expect(refusal, "translate the deadline into a plain transport error -> the run ladder retries it, each retry costs another full bound, and the refusal that eventually reaches main names the retry budget instead of the limit that actually fired.").toBeInstanceOf(YdocOpenTimedOutError);
      expect((refusal as Error).message).toContain(
        `The ydoc.open deadlineMs limit of ${YDOC_OPEN_DEADLINE_MS}ms was reached`,
      );
      // The surface answer #533 requires: read-only with a retry, never the
      // writable plain editor.
      expect(isEngineWorkspaceOpenRefusedError(refusal)).toBe(true);
      await queued;
      expect(chainFreed).toBe(true);
    } finally {
      vi.useRealTimers();
      await engine.stop();
    }
  });

  it("keeps the retry read-only when the timed-out open had already taken the session", async () => {
    // The deadline can fire over an open that succeeded: the
    // daemon writes one output item at a time and its queue holds 64 of them,
    // any of which may be a frame-sized `ydoc.open` state
    // (engineDaemonLifecycle.ts). A reply stuck behind that queue is not a
    // daemon that failed — the session exists, the lease is held, and this
    // refusal discards the only copy of the session id.
    //
    // So the first open is read-only, which is right, and then "Try again"
    // meets `ydoc-session-busy` — the daemon saying it holds this document.
    // Classified as an ordinary refusal, that answered the retry with the
    // writable plain editor over a daemon-held canonical Y.Doc: the double
    // writer #533 exists to prevent, reached by way of the fix for #616.
    const root = await createTestScratch("dohc-ydoc-deadline-");
    await write(root, "note.md", "hello\n");
    const loopback = new VersionedLoopbackEngine();
    // A daemon that takes the lease and then cannot get its reply out. It is
    // stateful on purpose: the busy refusal is a consequence of the first open
    // landing, not a canned answer, so a fake that never took the session
    // could not produce it either.
    let leaseHeld = false;
    const client = {
      close: () => undefined,
      onEvent: () => () => undefined,
      async sendRequest(request: Request): Promise<Response> {
        if (request.method === "workspace.open") {
          return { id: request.id, result: { workspace: String(WORKSPACE_ID) } };
        }
        if (request.method === "workspace.close") {
          return { id: request.id, result: { closed: true } };
        }
        if (request.method === "ydoc.open") {
          if (leaseHeld) {
            throw new EngineRequestError(request.id, {
              code: "INVALID_PARAMS",
              message: "ydoc-session-busy",
              retry: "no",
            });
          }
          const deadlineMs = request.deadlineMs ?? 0;
          return await new Promise<never>((_resolve, reject) => {
            // The session lands daemon-side while the reply waits behind the
            // output queue. Nothing resolves this promise afterwards, which is
            // what EngineClient does with a reply for an abandoned id.
            setTimeout(() => {
              leaseHeld = true;
            }, deadlineMs / 2);
            setTimeout(() => {
              reject(
                new EngineRequestDeadlineError(
                  request.id,
                  request.method,
                  deadlineMs,
                ),
              );
            }, deadlineMs);
          });
        }
        return (
          daemonCaptureLifecycleAnswer(request) ?? (await loopback.sendRequest(request))
        );
      },
    };
    const sessions = new EngineWorkspaceSessions({ currentClient: () => client });
    const engine = createWorkspaceEngineCapture({
      workspaceId: WORKSPACE_ID,
      rootPath: root,
      rustEngineSessions: sessions,
    });
    engine.start();
    await engine.flush();

    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
    });
    try {
      const opening = engine
        .openYDocSession({ path: "note.md", onRemoteUpdate: () => undefined })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(YDOC_OPEN_DEADLINE_MS);
      expect(await opening).toBeInstanceOf(YdocOpenTimedOutError);
      expect(leaseHeld).toBe(true);

      // "Try again": a fresh open of the same document, which the daemon now
      // refuses because it holds the session the first attempt took.
      const retry = await engine
        .openYDocSession({ path: "note.md", onRemoteUpdate: () => undefined })
        .catch((error: unknown) => error);
      expect((retry as Error).message).toBe("ydoc-session-busy");
      expect(isEngineWorkspaceOpenRefusedError(retry), "drop the busy refusal from the read-only family -> this is `false`, main answers a plain `available: false`, and the renderer puts a writable plain editor over a document the daemon still holds.").toBe(true);
    } finally {
      vi.useRealTimers();
      await engine.stop();
    }
  });

  it("spends one budget across the several runs the task makes", async () => {
    const root = await createTestScratch("dohc-ydoc-deadline-");
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

    // Why the budget is a region rather than a per-call limit: the task
    // makes several daemon calls, and a limit on each would let their waits
    // add up to something no caller ever set.
    expect(runOptions.length).toBeGreaterThan(1);
  });

  it("sits beyond the measured healthy open on a busy chain", async () => {
    // AGENTS.md, measure limits that reject work: the deadline only ever
    // interrupts transport-retry waiting, but the honest floor is still the
    // healthy open itself. Eight opens, each queued behind a captureBatch of
    // three files (the chain traffic a busy workspace produces), through the
    // real chain + loopback RPCs with an instant provider stub. Real daemon
    // RPC latency is governed separately by WORKSPACE_OPEN_DEADLINE_MS, which
    // the deadline is derived FROM — so the margin measured here understates
    // the real one only by bounded, already-budgeted amounts.
    const root = await createTestScratch("dohc-ydoc-deadline-");
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

  // The absent-head branches refuse by releasing the
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
        // Absent head and absent lineage: the bind the absent-head contract
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
            ({ sha256: "a".repeat(64), content: "" }) as never,
          applyExternalMarkdownEdit: async () => ({ kind: "merged" }) as never,
          close: async () => {
            throw closeError;
          },
          // The daemon this fake models is unreachable, so the evict the
          // orphan tries next fails too and the session stays the daemon's.
          // That is the precondition both tests below are about: while a
          // session is unreleased, no refusal may describe the DISK.
          evict: async () => {
            throw new Error("evict failed: transport-error");
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
      const root = await createTestScratch("dohc-ydoc-deadline-");
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

      expect(refusal, "attach the release failure as `refusal.cause` and throw the artifact refusal anyway -> main answers a bare `available:false` and the renderer opens the writable plain editor over a session the daemon still holds.").toBeInstanceOf(EngineWorkspaceRetryDeadlineError);
      expect(refusal).not.toBeInstanceOf(YDocUncapturedArtifactError);
    });

    // The other half of the same defect, and the one the user feels. The
    // client stopped waiting; the daemon did not stop working. Its close runs
    // in a spawned task (crates/dohc-workspace-engine/src/lib.rs,
    // ydoc_close_inner) that runs to completion whatever happens to the RPC
    // future, and a genuine close refusal — an update raced in, so the
    // lineage is dirty — reinserts the session entry with its lease held.
    // The refusal that left this function was the last reference to that
    // session, so every later open answered ydoc-session-busy and "Try again"
    // could never work again. Retain it where a close can still reach it.
    it("discharges the session it could not release, so the retry binds", async () => {
      const root = await createTestScratch("dohc-ydoc-deadline-");
      await write(root, "note.md", "uncaptured bytes\n");
      const { sessions } = recordingSessions();
      const doc = new Y.Doc();
      let opens = 0;
      let closes = 0;
      let evicts = 0;
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
              ({ sha256: "a".repeat(64), content: "" }) as never,
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
            evict: async () => {
              evicts += 1;
            },
          };
        },
      });
      engine.start();
      await engine.flush();

      const refusal = await engine
        .openYDocSession({ path: "note.md", onRemoteUpdate: () => undefined })
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(EngineWorkspaceRetryDeadlineError);

      // "Try again".
      const session = await engine.openYDocSession({
        path: "note.md",
        onRemoteUpdate: () => undefined,
      });
      expect(session.doc).toBe(doc);
      // The retry closed the stranded session before binding a new one.
      expect(closes).toBe(2);
      // And it closed it — a spent transport budget is waited out, never
      // evicted.
      expect(evicts).toBe(0);

      await session.close({ settle: false });
      await engine.stop();
    });

    it("keeps the read-only classification when the daemon refuses the release", async () => {
      // codex r17 P1. The rethrow covered the BUDGET's refusals only, so an
      // ordinary one — UnsettledClose, which is the daemon saying an update
      // raced in and the lineage is dirty — fell through to the disk verdict.
      // That verdict is one `main` answers with a bare `available: false`, so
      // the renderer opened the writable plain editor over the session this
      // very branch had just retained as an orphan, lease and all. The
      // classification does not depend on what refused the release: while the
      // session is unreleased the engine may still own the document.
      const root = await createTestScratch("dohc-ydoc-deadline-");
      await write(root, "note.md", "uncaptured bytes\n");

      const refusal = await refusalFrom(
        root,
        new Error("ydoc close refused: unsettled-close"),
      );

      expect(refusal, "rethrow only budget refusals -> YDocUncapturedArtifactError, a plain fallback, and two writers on one path.").toBeInstanceOf(YDocSessionUnreleasedError);
      expect(refusal).not.toBeInstanceOf(YDocUncapturedArtifactError);
      // Named for the agent reading it, with the daemon's own refusal kept.
      expect((refusal as Error).cause).toMatchObject({
        message: "ydoc close refused: unsettled-close",
      });
      // The surface stays read-only because `main` answers this with
      // `engineMayHoldDocument` — the same door the deadline uses.
      expect(isYDocSessionUnreleasedError(refusal)).toBe(true);
    });

    it("evicts a dirty orphan instead of settling it over the file", async () => {
      // codex r20, and the last data-loss door. The discharge released on
      // easier terms than the release that orphaned the session: no
      // `settleOnRefusal: false`, so a repeated UnsettledClose escalated to a
      // settling close inside the provider. The doc this session holds was
      // seeded from neither a head nor a snapshot — settling it writes what
      // replication delivered over bytes the watcher has not captured yet,
      // which is exactly what rule 1 refuses the open to prevent.
      //
      // #665 closed the other end. A close that keeps refusing used to leave
      // the orphan retained, holding its lease, and on a path no capture will
      // ever reach — policy-excluded, or over the 10 MiB capture limit — the
      // document stayed read-only until the daemon restarted. The orphan now
      // evicts: the daemon lets go of the session while its lineage stays
      // durable, so nothing is written and nothing is discarded.
      const root = await createTestScratch("dohc-ydoc-deadline-");
      const uncaptured = "bytes the watcher has not ingested yet\n";
      await write(root, "note.md", uncaptured);
      const { sessions } = recordingSessions();
      const doc = new Y.Doc();
      const closeCalls: Array<{ settle?: boolean; settleOnRefusal?: boolean }> =
        [];
      let evicts = 0;
      const engine = createWorkspaceEngineCapture({
        workspaceId: WORKSPACE_ID,
        rootPath: root,
        rustEngineSessions: sessions,
        openRustYDocProviderSession: async () => ({
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext" as const,
          path: "note.md",
          head: "absent" as const,
          lineage: "absent" as const,
          applyLocalUpdate: async () => undefined,
          settleNow: async () =>
            ({ sha256: "a".repeat(64), content: "" }) as never,
          applyExternalMarkdownEdit: async () => ({ kind: "merged" }) as never,
          close: async (closeOptions?: {
            settle?: boolean;
            settleOnRefusal?: boolean;
          }) => {
            closeCalls.push({ ...closeOptions });
            // The daemon keeps refusing: the lineage is dirty and the file it
            // would settle over is still uncaptured.
            throw new DaemonRefusalError(
              {
                code: "INVALID_PARAMS",
                message: "ydoc-unsettled-close",
                retry: "no",
              },
              undefined,
            );
          },
          evict: async () => {
            evicts += 1;
          },
        }),
      });
      engine.start();
      await engine.flush();

      const first = await engine
        .openYDocSession({ path: "note.md", onRemoteUpdate: () => undefined })
        .catch((error: unknown) => error);
      // The session is gone, so the refusal may describe the disk again: the
      // file is really there and the plain editor shows its real bytes.
      expect(first, "drop the evict fallback (#665) -> a YDocSessionUnreleasedError, an orphan holding its lease, and a path that stays read-only until the daemon restarts.").toBeInstanceOf(YDocUncapturedArtifactError);
      expect(evicts).toBe(1);

      // "Try again" binds a fresh session rather than discharging a retained
      // orphan, and answers the same honest refusal.
      const retry = await engine
        .openYDocSession({ path: "note.md", onRemoteUpdate: () => undefined })
        .catch((error: unknown) => error);
      expect(retry).toBeInstanceOf(YDocUncapturedArtifactError);
      expect(evicts).toBe(2);

      expect(closeCalls, "discharge with `{ settle: false }` alone -> the provider escalates the repeated refusal to a settling close, and the doc lands on top of the user's uncaptured bytes.").toEqual([
        { settle: false, settleOnRefusal: false },
        { settle: false, settleOnRefusal: false },
      ]);
      // The bytes are still the user's.
      expect(await readFile(join(root, "note.md"), "utf8")).toBe(uncaptured);
      await engine.stop();
    });

    it("binds the lineage an evicted orphan left behind, with no restart", async () => {
      // On a path no capture will ever reach — one
      // `.dohc/files.toml` excludes, or a file above the engine text capture
      // limit and the 2 MiB editor limit — the orphan's close can never be
      // satisfied, because only a captured or settled artifact can satisfy it.
      // Evicting is what breaks that loop: the daemon lets go of the session
      // and keeps the lineage, so the next open finds the resurrected draft
      // (head absent, lineage existing) and binds it. Before this, the answer
      // was ydoc-session-busy until the daemon restarted — and on these two
      // paths a restart did not help either, because the reopen still found
      // no head.
      const root = await createTestScratch("dohc-ydoc-deadline-");
      const excluded = "x".repeat(MAX_ENGINE_CAPTURE_TEXT_BYTES + 1024) + "\n";
      await write(root, "note.md", excluded);
      const { sessions } = recordingSessions();
      const doc = new Y.Doc();
      let evicted = false;
      let opens = 0;
      const engine = createWorkspaceEngineCapture({
        workspaceId: WORKSPACE_ID,
        rootPath: root,
        rustEngineSessions: sessions,
        openRustYDocProviderSession: async () => {
          opens += 1;
          return {
            doc,
            initialUpdate: Y.encodeStateAsUpdate(doc),
            contentKind: "plaintext" as const,
            // The head stays absent forever: no capture will mint one here.
            // The LINEAGE is what the evict preserves, and the daemon
            // resurrects it on the next open (actor.rs).
            head: "absent" as const,
            path: "note.md",
            lineage: evicted ? ("existing" as const) : ("absent" as const),
            applyLocalUpdate: async () => undefined,
            settleNow: async () =>
              ({ sha256: "a".repeat(64), content: "" }) as never,
            applyExternalMarkdownEdit: async () =>
              ({ kind: "merged" }) as never,
            close: async () => {
              throw new DaemonRefusalError(
                {
                  code: "INVALID_PARAMS",
                  message: "ydoc-unsettled-close",
                  retry: "no",
                },
                undefined,
              );
            },
            evict: async () => {
              evicted = true;
            },
          };
        },
      });
      engine.start();
      await engine.flush();

      const refusal = await engine
        .openYDocSession({ path: "note.md", onRemoteUpdate: () => undefined })
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(YDocUncapturedArtifactError);
      expect(evicted).toBe(true);

      const session = await engine.openYDocSession({
        path: "note.md",
        onRemoteUpdate: () => undefined,
      });
      expect(session.doc, "drop the evict fallback in `closeEntry` (#665) -> this open answers YDocSessionUnreleasedError from the retained orphan, and every later one does too.").toBe(doc);
      expect(opens).toBe(2);
      // Nothing was written on the way out.
      expect(await readFile(join(root, "note.md"), "utf8")).toBe(excluded);

      await session.close({ settle: false }).catch(() => undefined);
      await engine.stop();
    });

    // #710/#721 rider F6. The test above pins the disk-size clause of
    // `captureWillReachPath`; a real `.dohc/files.toml` `tracked = false`
    // rule is what exercises the `policyTracksPath` clause, and only this
    // fixture severs cleanly from that one alone — the file here is a few
    // plain bytes, well under every size cap.
    it("binds a policy-excluded orphan's resurrected lineage the same way", async () => {
      const root = await createTestScratch("dohc-ydoc-deadline-");
      const excluded = "small, policy-excluded content\n";
      await write(root, "note.md", excluded);
      await write(
        root,
        ".dohc/files.toml",
        '[[rule]]\npath = "note.md"\ntracked = false\n',
      );
      const { sessions } = recordingSessions();
      const doc = new Y.Doc();
      let evicted = false;
      let opens = 0;
      const engine = createWorkspaceEngineCapture({
        workspaceId: WORKSPACE_ID,
        rootPath: root,
        rustEngineSessions: sessions,
        openRustYDocProviderSession: async () => {
          opens += 1;
          return {
            doc,
            initialUpdate: Y.encodeStateAsUpdate(doc),
            contentKind: "plaintext" as const,
            // The head stays absent forever: no capture will mint one here,
            // because the policy excludes the path.
            head: "absent" as const,
            path: "note.md",
            lineage: evicted ? ("existing" as const) : ("absent" as const),
            applyLocalUpdate: async () => undefined,
            settleNow: async () =>
              ({ sha256: "a".repeat(64), content: "" }) as never,
            applyExternalMarkdownEdit: async () =>
              ({ kind: "merged" }) as never,
            close: async () => {
              throw new DaemonRefusalError(
                {
                  code: "INVALID_PARAMS",
                  message: "ydoc-unsettled-close",
                  retry: "no",
                },
                undefined,
              );
            },
            evict: async () => {
              evicted = true;
            },
          };
        },
      });
      engine.start();
      await engine.flush();

      const refusal = await engine
        .openYDocSession({ path: "note.md", onRemoteUpdate: () => undefined })
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(YDocUncapturedArtifactError);
      expect(evicted).toBe(true);

      const session = await engine.openYDocSession({
        path: "note.md",
        onRemoteUpdate: () => undefined,
      });
      expect(session.doc, "sever the `policyTracksPath` clause of `captureWillReachPath` (treat every path as capture-reachable) -> this second open refuses again instead of binding, because the disk-size clause alone never excludes a few plain bytes.").toBe(doc);
      expect(opens).toBe(2);
      // Nothing was written on the way out.
      expect(await readFile(join(root, "note.md"), "utf8")).toBe(excluded);

      await session.close({ settle: false }).catch(() => undefined);
      await engine.stop();
    });

    it("refuses to settle an orphan for a lifecycle close either", async () => {
      // codex r21, and the third site of one mechanism — which is why the
      // never-settle rule now lives on the ORPHAN instead of at each caller.
      // A registered orphan is visible to the lifecycle sweep every version
      // switch, merge, rename and delete runs, and that sweep closes with
      // `{ settle: false }` alone: the provider escalates a refused close into
      // a settling one, over the uncaptured file.
      const root = await createTestScratch("dohc-ydoc-deadline-");
      const uncaptured = "bytes the watcher has not ingested yet\n";
      await write(root, "note.md", uncaptured);
      const { sessions } = recordingSessions();
      const doc = new Y.Doc();
      const closeCalls: Array<{ settle?: boolean; settleOnRefusal?: boolean }> =
        [];
      const engine = createWorkspaceEngineCapture({
        workspaceId: WORKSPACE_ID,
        rootPath: root,
        rustEngineSessions: sessions,
        openRustYDocProviderSession: async () => ({
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext" as const,
          path: "note.md",
          head: "absent" as const,
          lineage: "absent" as const,
          applyLocalUpdate: async () => undefined,
          settleNow: async () =>
            ({ sha256: "a".repeat(64), content: "" }) as never,
          applyExternalMarkdownEdit: async () => ({ kind: "merged" }) as never,
          close: async (closeOptions?: {
            settle?: boolean;
            settleOnRefusal?: boolean;
          }) => {
            closeCalls.push({ ...closeOptions });
            throw new Error("unsettled-close");
          },
          // The evict fails too, which is what retains the orphan — the
          // precondition of this test. An orphan the daemon released is not
          // registered, so no lifecycle sweep can reach it.
          evict: async () => {
            throw new Error("evict failed: transport-error");
          },
        }),
      });
      engine.start();
      await engine.flush();

      const refusal = await engine
        .openYDocSession({ path: "note.md", onRemoteUpdate: () => undefined })
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(YDocSessionUnreleasedError);

      // A version switch sweeps live sessions for the paths it is about to
      // rewrite, and this orphan is one of them.
      await engine
        .settleAndCloseLiveSessionsForPath("note.md")
        .catch(() => undefined);

      for (const call of closeCalls) {
        expect(call, "drop the entry-level policy -> the sweep's `{ settle: false }` arrives without `settleOnRefusal: false`, the provider escalates, and the doc lands on the user's uncaptured bytes.").toMatchObject({ settle: false, settleOnRefusal: false });
      }
      expect(await readFile(join(root, "note.md"), "utf8")).toBe(uncaptured);
      await engine.stop();
    });

    it("reports the shutdown, not a raced open, when quit refuses the release", async () => {
      const root = await createTestScratch("dohc-ydoc-deadline-");
      // No file: the sibling branch, which would otherwise claim the open
      // raced a writer and fall back the same silent way.

      const refusal = await refusalFrom(
        root,
        new EngineWorkspaceShuttingDownError(),
      );

      expect(isEngineWorkspaceOpenRefusedError(refusal), "keep `released = false` as the only classification -> the raced refusal downgrades a quitting app to the plain editor.").toBe(true);
      expect(refusal).not.toBeInstanceOf(YDocOpenRacedError);
    });
  });
});
