import { EngineCaptureNotSettledError } from "./workspaceEngineCaptureLiveStore";
import {
  flushTypingCheckpointsSync,
  writeTypingCheckpointSync,
  flushTypingCheckpoints,
  readTypingCheckpoints,
  retireTypingCheckpoint,
  writeTypingCheckpoint,
} from "./outageTypingRecovery";
import * as Y from "yjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as nodeFs from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  DaemonRefusalError,
  YDOC_PENDING_MAX_RECORDS,
  openEngineYdocProviderSession,
  type EngineYdocProviderSession,
  type EngineYdocProviderSessionOptions,
  YdocReleasedWithSettleFailureError,
  type EngineTransport,
  type JsonValue,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine, YdocLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import {
  EngineDaemonUnavailableError,
  EngineWorkspaceSessions,
  type EngineDaemonClient,
} from "@dohc/workspace-engine-client/daemon";
import {
  createWorkspaceEngineCapture as createAttachedWorkspaceEngineCapture,
  YDOC_UNCERTAIN_FAILURE_BACKOFF_MS,
  type WorkspaceEngineCapture,
  type WorkspaceEngineCaptureOptions,
} from "./workspaceEngineCapture";
import { createTestScratch } from "./testTemp";
import { HistoryStillPausedError } from "../ipc/errorWords";
import { daemonCaptureLifecycleAnswer } from "../testing/liveEngineSessions";
import {
  createWorkspaceActivity,
  settleYDocsAfterFileObservation,
  WorkspaceActivityState,
} from "./workspaceActivity";
import { idleObservation } from "./workspaceActivity.testSupport";
import {
  createEngineYDocSaveSeqState,
  noteLocalEdit,
  noteSettleOutcome,
  noteSettleStart,
} from "./engineYDocSaveSeq";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

// The close-retry ladders run at test speed: a rung is 20 ms and the cap
// 100 ms. A test that prices the production ladder passes its own
// `teardownRetryMs`.
const TEST_TEARDOWN_RETRY_MS = { initial: 20, cap: 100 };

function uncertainFailureClock(): () => void {
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  onTestFinished(() => clock.mockRestore());
  return () => {
    now += YDOC_UNCERTAIN_FAILURE_BACKOFF_MS;
  };
}

// The capture exposes no retry hook, so a test that asserts a retry did NOT
// fire waits past every rung the ladder could have scheduled (initial, then
// doubling to the cap: 20 + 40 + 80 + 100 ms) and then some. This is the one
// place a fixed wait remains; it is a bound on the ladder, not a guess.
async function pastRetryRungs(): Promise<void> {
  const { initial, cap } = TEST_TEARDOWN_RETRY_MS;
  let total = 0;
  for (let rung = initial; rung < cap; rung *= 2) total += rung;
  await new Promise((resolve) => setTimeout(resolve, total + cap + 50));
}

// A clock that never moves: a session's open, a delete and a settle's start
// all land in one millisecond, as they often do on a fast machine. Only the
// order the capture saw them in can say which came first.
const frozenClock = (): number => 1_000_000;

function createWorkspaceEngineCapture(
  options: Omit<WorkspaceEngineCaptureOptions, "attachmentId">,
) {
  return createAttachedWorkspaceEngineCapture({
    teardownRetryMs: TEST_TEARDOWN_RETRY_MS,
    ...options,
    attachmentId: Symbol(`test-workspace-attachment:${options.workspaceId}`),
  });
}

async function reconnectFailureCapture(prefix: string) {
  const rootPath = await createTestScratch(prefix);
  const workspaceId = prefix.replace(/-+$/, "");
  const loopback = new VersionedLoopbackEngine();
  const state = {
    generation: 0,
    leaseActive: false,
    moveRefusalAt: null as "preflight" | "native" | null,
    adoptOnClose: false,
    moveRequests: [] as string[],
    ownedUnder: null as string | null,
    ownedPage: null as string | null,
    checkedFolders: [] as Array<{ path: string; folder: boolean }>,
    releaseCalls: [] as Array<{ generation: number; settle?: boolean }>,
    // Capture that never settles: "unsettled" runs healthy, "scanning" is a
    // replacement still on its first scan, "stopped" a driver that stopped.
    // "rescanning" settles, then reads a deliberate rescan's moment.
    captureAnswer: null as "unsettled" | "scanning" | "stopped" | "rescanning" | null,
  };
  const daemonClient: EngineDaemonClient & EngineTransport = {
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: workspaceId } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      if (request.method === "versionedText.checkMove") {
        const params = request.params as {
          path: string;
          change?: "movePage" | "moveFolder" | "delete";
        };
        state.checkedFolders.push({ path: params.path, folder: params.change === "moveFolder" });
        if (
          params.change === "moveFolder" &&
          state.ownedUnder !== null &&
          state.ownedUnder.startsWith(`${params.path}/`)
        ) {
          state.moveRequests.push(request.method);
          throw new DaemonRefusalError(
            { code: "INVALID_PARAMS", message: "live-folder-page-owned", retry: "no" },
            new Error("daemon response"),
          );
        }
        if (
          params.change === "delete" &&
          state.ownedUnder !== null &&
          state.ownedUnder.startsWith(`${params.path}/`)
        ) {
          throw new DaemonRefusalError(
            { code: "INVALID_PARAMS", message: "live-folder-page-owned", retry: "no" },
            new Error("daemon response"),
          );
        }
        if (
          (params.change === "movePage" || params.change === "delete") &&
          params.path === state.ownedPage
        ) {
          state.moveRequests.push(request.method);
          throw new DaemonRefusalError(
            { code: "INVALID_PARAMS", message: "live-page-owned", retry: "no" },
            new Error("daemon response"),
          );
        }
      }
      if (
        request.method === "versionedText.checkMove" ||
        request.method === "versionedText.rename"
      ) {
        state.moveRequests.push(request.method);
        if (
          state.moveRefusalAt ===
          (request.method === "versionedText.checkMove" ? "preflight" : "native")
        ) {
          throw new DaemonRefusalError(
            { code: "INVALID_PARAMS", message: "live-document-binding-active", retry: "no" },
            new Error("daemon response"),
          );
        }
      }
      const answer = state.captureAnswer;
      const lifecycle = daemonCaptureLifecycleAnswer(request, () => ({
        deferredWrites: [],
        heldFiles: [],
        degraded: false,
        settled: answer === null || answer === "rescanning",
        running: answer === null || answer === "unsettled",
      }));
      if (
        lifecycle &&
        (answer === "scanning" || answer === "stopped") &&
        request.method === "watcher.status"
      ) {
        return {
          ...lifecycle,
          result: {
            ...(lifecycle.result as { [key: string]: JsonValue }),
            running: false,
            degraded: answer === "stopped",
            phase: "degraded",
          },
        };
      }
      if (lifecycle && answer === "rescanning" && request.method === "watcher.status") {
        return {
          ...lifecycle,
          result: { ...(lifecycle.result as { [key: string]: JsonValue }), running: false },
        };
      }
      if (lifecycle) return lifecycle;
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions({
    currentClient: () => daemonClient,
  });
  // The daemon leases each path to one session.
  const leased = new Set<string>();
  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    if (leased.has(options.path)) throw new Error("ydoc-session-busy");
    leased.add(options.path);
    state.leaseActive = true;
    const openedGeneration = ++state.generation;
    const doc = new Y.Doc();
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      contentKind: "plaintext",
      path: options.path,
      head: "present" as const,
      lineage: "existing" as const,
      unsettled: false,
      evict: async () => undefined,
      async applyLocalUpdate() {
        throw Object.assign(new Error("control frame encoding failed"), {
          code: "transport-error",
        });
      },
      async settleNow() {
        const markdown = doc.getText("plainText").toString();
        return {
          momentId: `moment-${openedGeneration}`,
          path: options.path,
          content: markdown,
          sha256: createHash("sha256").update(markdown).digest("hex"),
          materialized: true,
          projection: {
            contentKind: "plaintext",
            sourceStateVectorSha256: "a".repeat(64),
            destructive: false,
          },
        };
      },
      async close(closeOptions) {
        if (state.adoptOnClose) state.moveRefusalAt = "preflight";
        state.releaseCalls.push({
          generation: openedGeneration,
          ...(closeOptions?.settle !== undefined ? { settle: closeOptions.settle } : {}),
        });
        leased.delete(options.path);
        state.leaseActive = leased.size > 0;
      },
    };
  };
  const outcomes: boolean[] = [];
  const capture = createWorkspaceEngineCapture({
    workspaceId,
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onCaptureOutcome: (failure) => outcomes.push(failure === null),
    onError: () => undefined,
  });
  return { capture, outcomes, rootPath, state };
}

it("refuses a folder delete when owner adoption finishes during teardown and releases its reservation", async () => {
  const { capture, state, rootPath } = await reconnectFailureCapture(
    "dohc-adopted-owner-delete-race-",
  );
  await mkdir(join(rootPath, "notes"));
  await writeFile(join(rootPath, "notes/note.md"), "original");
  await capture.openYDocSession({ path: "notes/note.md", onRemoteUpdate: () => undefined });
  state.adoptOnClose = true;
  await expect(capture.settleAndCloseLiveSessionsForPath("notes")).rejects.toThrow(
    "dohc could not delete notes.",
  );
  expect(state.releaseCalls).toHaveLength(1);
  expect(state.moveRequests).toEqual(["versionedText.checkMove", "versionedText.checkMove"]);
  expect(await readFile(join(rootPath, "notes/note.md"), "utf8")).toBe("original");
  const reopened = await capture.openYDocSession({
    path: "notes/note.md",
    onRemoteUpdate: () => undefined,
  });
  await reopened.close();
  state.moveRefusalAt = null;
  const finish = await capture.settleAndCloseLiveSessionsForPath("notes");
  finish(false);
  await capture.stop();
});

const MOVE_AUTHOR = { kind: "human" as const, humanId: "local-person" };
const MOVE_OPERATION = "dohc-operation:44444444-4444-4444-8444-444444444444";

it("refuses deleting an owned page, or a folder that holds one, before anything closes", async () => {
  const { capture, state, rootPath } = await reconnectFailureCapture("dohc-owned-folder-delete-");
  await mkdir(join(rootPath, "notes"));
  await writeFile(join(rootPath, "notes/page.md"), "original");
  state.ownedUnder = "notes/page.md";
  state.ownedPage = "notes/page.md";
  await expect(capture.settleAndCloseLiveSessionsForPath("notes")).rejects.toMatchObject({
    name: "LiveFolderError",
    message: [
      `dohc can't delete "notes" while a page in it has live editing on`,
      "In Live documents, stop live editing for every page in this folder, then delete the folder again.",
    ].join(String.fromCharCode(10)),
  });
  await expect(capture.settleAndCloseLiveSessionsForPath("notes/page.md")).rejects.toMatchObject({
    name: "LivePageOwnedError",
    message: [
      `dohc can't delete "notes/page.md" while it has live editing on`,
      "In Live documents, stop live editing for this page, then delete it again.",
    ].join(String.fromCharCode(10)),
  });
  expect(await readFile(join(rootPath, "notes/page.md"), "utf8")).toBe("original");
  await capture.stop();
});

it("refuses a move that would replace an owned page or a folder that holds one, before anything closes or moves", async () => {
  const { capture, state, rootPath } = await reconnectFailureCapture(
    "dohc-owned-move-destination-",
  );
  await mkdir(join(rootPath, "notes"));
  await mkdir(join(rootPath, "box"));
  await writeFile(join(rootPath, "notes/page.md"), "source");
  await writeFile(join(rootPath, "notes/target.md"), "owned");
  await writeFile(join(rootPath, "box/page.md"), "owned in a folder");
  state.ownedPage = "notes/target.md";
  state.ownedUnder = "box/page.md";
  const session = await capture.openYDocSession({
    path: "notes/target.md",
    onRemoteUpdate: () => undefined,
  });
  const work = vi.fn(async () => "moved");
  const replace = (to: string) =>
    capture
      .changePathsAs(
        ["notes/page.md", to],
        { operation: "move", author: MOVE_AUTHOR, operationId: MOVE_OPERATION },
        work,
        () => [],
      )
      .catch((error: unknown) => error);
  expect(await replace("notes/target.md")).toMatchObject({
    name: "LivePageOwnedError",
    message: [
      `dohc can't replace "notes/target.md" while it has live editing on`,
      "In Live documents, stop live editing for this page, then try again.",
    ].join(String.fromCharCode(10)),
  });
  expect(await replace("box")).toMatchObject({
    name: "LiveFolderError",
    message: [
      `dohc can't replace "box" while a page in it has live editing on`,
      "In Live documents, stop live editing for every page in this folder, then try again.",
    ].join(String.fromCharCode(10)),
  });
  expect(work).not.toHaveBeenCalled();
  expect(state.releaseCalls).toEqual([]);
  expect(await readFile(join(rootPath, "notes/page.md"), "utf8")).toBe("source");
  expect(await readFile(join(rootPath, "notes/target.md"), "utf8")).toBe("owned");
  expect(await readFile(join(rootPath, "box/page.md"), "utf8")).toBe("owned in a folder");
  await session.settleNow();
  await session.close();
  await capture.stop();
});

async function failRendererUpdate(
  session: Awaited<ReturnType<WorkspaceEngineCapture["openYDocSession"]>>,
): Promise<void> {
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);
  const before = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(0, "renderer-only edit");
  session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));
  await expect(session.settleNow()).rejects.toThrow(/closed/i);
}

it("names every page whose live editing stopped when Try again leaves History paused, until those pages close", async () => {
  const { capture, outcomes } = await reconnectFailureCapture("dohc-ydoc-history-retry-dead-");
  const plan = await capture.openYDocSession({
    path: "notes/plan.md",
    onRemoteUpdate: () => undefined,
  });
  await failRendererUpdate(plan);
  const agenda = await capture.openYDocSession({
    path: "notes/agenda.md",
    onRemoteUpdate: () => undefined,
  });
  await failRendererUpdate(agenda);
  expect(outcomes.at(-1)).toBe(false);

  const refused = await capture.retryHistoryCapture().then(
    () => null,
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(HistoryStillPausedError);
  expect(refused).toMatchObject({
    code: "live-editing-stopped",
    paths: ["notes/agenda.md", "notes/plan.md"],
  });
  expect(outcomes.at(-1)).toBe(false);

  // Close each page as the renderer's release does
  // (engineYDocSessionOwner.ts), which tries to revive a dead session first.
  await plan.close(undefined);
  await expect(capture.retryHistoryCapture()).rejects.toMatchObject({ paths: ["notes/agenda.md"] });
  expect(outcomes.at(-1)).toBe(false);
  await agenda.close(undefined);
  expect(outcomes.at(-1)).toBe(true);
  await expect(capture.retryHistoryCapture()).resolves.toBeUndefined();
  await capture.stop();
});

it("keeps History paused when Try again finds capture stopped again, and catching up while it still runs", async () => {
  const { capture, state } = await reconnectFailureCapture("dohc-ydoc-history-retry-unsettled-");
  state.captureAnswer = "unsettled";
  await expect(capture.retryHistoryCapture()).rejects.toBeInstanceOf(EngineCaptureNotSettledError);
  state.captureAnswer = "scanning";
  await expect(capture.retryHistoryCapture()).rejects.toBeInstanceOf(EngineCaptureNotSettledError);
  state.captureAnswer = "stopped";
  const refused = await capture.retryHistoryCapture().then(
    () => null,
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(HistoryStillPausedError);
  expect(refused).toMatchObject({ paths: [] });
  state.captureAnswer = null;
  await capture.stop();
});

it("rebinds a live Y.Doc and replays renderer state after the daemon restarts", async () => {
  const rootPath = await createTestScratch("dohc-ydoc-restart-");
  const loopback = new VersionedLoopbackEngine();

  const client = (generation: number): EngineDaemonClient & EngineTransport => ({
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      if (request.method === "workspace.open") {
        return {
          id: request.id,
          result: { workspace: "ydoc-restart" },
        };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      const lifecycle = daemonCaptureLifecycleAnswer(request);
      if (lifecycle) return lifecycle;
      return await loopback.sendRequest(request);
    },
  });
  const firstClient = client(1);
  const secondClient = client(2);
  const thirdClient = client(3);
  let currentClient = firstClient;
  let secondGenerationApplyCount = 0;
  const sessions = new EngineWorkspaceSessions(
    { currentClient: () => currentClient },
    { sleep: async () => undefined },
  );
  const openedDocs: Y.Doc[] = [];
  const seededDoc = new Y.Doc();
  seededDoc.getText("plainText").insert(0, "seed");
  const seedUpdate = Y.encodeStateAsUpdate(seededDoc);
  const durableDoc = new Y.Doc();
  Y.applyUpdate(durableDoc, seedUpdate);

  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(durableDoc));
    openedDocs.push(doc);
    const generation =
      options.transport === firstClient ? 1 : options.transport === secondClient ? 2 : 3;
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      contentKind: "plaintext",
      path: options.path,
      head: "present" as const,
      lineage: "existing" as const,
      unsettled: false,
      evict: async () => undefined,
      async applyLocalUpdate(update) {
        Y.applyUpdate(doc, update);
        Y.applyUpdate(durableDoc, update);
        if (generation === 2 && secondGenerationApplyCount++ === 0) {
          const beforeRemote = Y.encodeStateVector(doc);
          doc.getText("plainText").insert(doc.getText("plainText").length, " remote");
          const remote = Y.encodeStateAsUpdate(doc, beforeRemote);
          Y.applyUpdate(durableDoc, remote);
          options.onRemoteUpdate(remote);
          return;
        }
        if (generation === 1 || generation === 2) {
          currentClient = generation === 1 ? secondClient : thirdClient;
          throw Object.assign(new Error("daemon exited"), {
            code: "transport-error",
          });
        }
      },
      async settleNow() {
        const markdown = doc.getText("plainText").toString();
        const result = {
          momentId: `moment-${generation}`,
          path: options.path,
          content: markdown,
          sha256: createHash("sha256").update(markdown).digest("hex"),
          materialized: true,
          projection: {
            contentKind: "plaintext" as const,
            sourceStateVectorSha256: "a".repeat(64),
            destructive: false,
          },
        };
        await options.onSettled?.(result, 1);
        return result;
      },
      async close() {
        return;
      },
    };
  };

  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-restart",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
  });
  let rendererDoc: Y.Doc | null = null;
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: (update) => {
      if (rendererDoc) Y.applyUpdate(rendererDoc, update);
    },
  });
  rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);
  const stableDoc = session.doc;
  const before = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(4, " survives");
  session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));

  const settled = await session.settleNow();
  expect(settled?.content).toBe("seed survives remote");
  expect(openedDocs).toHaveLength(2);
  expect(openedDocs[1].getText("plainText").toString()).toBe("seed survives remote");
  expect(session.doc).toBe(stableDoc);
  expect(stableDoc.getText("plainText").toString()).toBe("seed survives remote");

  const beforeSecondRestart = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(13, " twice");
  session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, beforeSecondRestart));

  const settledAfterSecondRestart = await session.settleNow();
  expect(settledAfterSecondRestart?.content).toBe("seed survives twice remote");
  expect(openedDocs).toHaveLength(3);
  expect(openedDocs[2].getText("plainText").toString()).toBe("seed survives twice remote");
  expect(stableDoc.getText("plainText").toString()).toBe("seed survives twice remote");
  expect(rendererDoc.getText("plainText").toString()).toBe("seed survives twice remote");

  await session.close({ settle: false });
  await capture.stop();
});

it("replaces rather than merges an independently rooted lineage after restart", async () => {
  const rootPath = await createTestScratch("dohc-ydoc-lineage-restart-");
  const loopback = new VersionedLoopbackEngine();
  const client = (): EngineDaemonClient & EngineTransport => ({
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "lineage-restart" } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      const lifecycle = daemonCaptureLifecycleAnswer(request);
      if (lifecycle) return lifecycle;
      return await loopback.sendRequest(request);
    },
  });
  const losingClient = client();
  const winningClient = client();
  let currentClient = losingClient;
  const sessions = new EngineWorkspaceSessions(
    { currentClient: () => currentClient },
    { sleep: async () => undefined },
  );
  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    const losing = options.transport === losingClient;
    const doc = new Y.Doc();
    doc.getText("plainText").insert(0, losing ? "losing root" : "winning root");
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      lineageClaimId: losing ? null : "winning-claim",
      contentKind: "plaintext",
      path: options.path,
      head: "present",
      lineage: "existing",
      unsettled: false,
      evict: async () => undefined,
      async applyLocalUpdate() {
        return;
      },
      async settleNow() {
        if (losing) {
          currentClient = winningClient;
          throw Object.assign(new Error("daemon exited"), {
            code: "transport-error",
          });
        }
        return {
          momentId: "winner-moment",
          path: options.path,
          content: "winning root",
          sha256: createHash("sha256").update("winning root").digest("hex"),
          materialized: true,
          projection: {
            contentKind: "plaintext",
            sourceStateVectorSha256: "a".repeat(64),
            destructive: false,
          },
        };
      },
      async close() {
        return;
      },
    };
  };
  const capture = createWorkspaceEngineCapture({
    workspaceId: "lineage-restart",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
  });
  const replacements: Array<{ text: string; recoveredPaths: string[] }> = [];
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
    onLineageReplaced: (update, recoveredPaths) => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, update);
      replacements.push({
        text: doc.getText("plainText").toString(),
        recoveredPaths,
      });
    },
  });
  const losingDoc = session.doc;

  await expect(session.settleNow()).resolves.toMatchObject({
    content: "winning root",
  });
  expect(session.doc).not.toBe(losingDoc);
  expect(session.doc.getText("plainText").toString()).toBe("winning root");
  expect(session.doc.getText("plainText").toString()).not.toContain("losing root");
  expect(replacements).toEqual([{ text: "winning root", recoveredPaths: [] }]);

  await session.close({ settle: false });
  await capture.stop();
});

// A claim can reach the engine while this session's generation is gone. The
// next keystroke finds the generation gone, and the reopened generation
// carries the claim. `claimedState` is the lineage the claim names.
async function typeIntoLostGeneration(input: {
  base: string;
  claimedState: (base: Uint8Array) => Uint8Array;
  originatedHere: boolean;
  claimedObjectId?: string;
  edit: (text: Y.Text) => void;
}) {
  const rootPath = await createTestScratch("dohc-ydoc-lineage-claim-typing-");
  const loopback = new VersionedLoopbackEngine();
  const client = (): EngineDaemonClient & EngineTransport => ({
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "claim-typing" } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      const lifecycle = daemonCaptureLifecycleAnswer(request);
      if (lifecycle) return lifecycle;
      return await loopback.sendRequest(request);
    },
  });
  const unclaimedClient = client();
  const claimedClient = client();
  let currentClient = unclaimedClient;
  const sessions = new EngineWorkspaceSessions(
    { currentClient: () => currentClient },
    { sleep: async () => undefined },
  );
  const base = new Y.Doc();
  base.getText("plainText").insert(0, input.base);
  const baseUpdate = Y.encodeStateAsUpdate(base);
  const claimedUpdate = input.claimedState(baseUpdate);
  const claimId = createHash("sha256").update(claimedUpdate).digest("hex");
  const claimedRecords: Uint8Array[] = [];
  const claimedDocs: Y.Doc[] = [];
  const reopenObjectIds: Array<string | undefined> = [];
  const claimedObjectId = input.claimedObjectId ?? "original-object";
  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    const unclaimed = options.transport === unclaimedClient;
    if (!unclaimed) {
      reopenObjectIds.push(options.expectedObjectId);
      if (options.expectedObjectId !== undefined && options.expectedObjectId !== claimedObjectId) {
        throw new DaemonRefusalError(
          { code: "INVALID_PARAMS", message: "ydoc-object-changed", retry: "no" },
          new Error("daemon response"),
        );
      }
    }
    const doc = new Y.Doc();
    Y.applyUpdate(doc, unclaimed ? baseUpdate : claimedUpdate);
    if (!unclaimed) claimedDocs.push(doc);
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      objectId: unclaimed ? "original-object" : claimedObjectId,
      lineageClaimId: unclaimed ? null : claimId,
      lineageOriginatedHere: !unclaimed && input.originatedHere,
      contentKind: "plaintext",
      path: options.path,
      head: "present",
      lineage: "existing",
      unsettled: false,
      evict: async () => undefined,
      async applyLocalUpdate(update) {
        if (unclaimed) {
          currentClient = claimedClient;
          throw Object.assign(new Error("daemon exited"), {
            code: "transport-error",
          });
        }
        Y.applyUpdate(doc, update);
        claimedRecords.push(update);
      },
      async settleNow() {
        const markdown = doc.getText("plainText").toString();
        return {
          momentId: "claimed-moment",
          path: options.path,
          content: markdown,
          sha256: createHash("sha256").update(markdown).digest("hex"),
          materialized: true,
          projection: {
            contentKind: "plaintext",
            sourceStateVectorSha256: "a".repeat(64),
            destructive: false,
          },
        };
      },
      async close() {
        return;
      },
    };
  };
  const capture = createWorkspaceEngineCapture({
    workspaceId: "claim-typing",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
  });
  const replacements: string[] = [];
  let objectChanges = 0;
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
    onLineageReplaced: (update) => {
      const replacement = new Y.Doc();
      Y.applyUpdate(replacement, update);
      replacements.push(replacement.getText("plainText").toString());
    },
    onObjectChanged: () => {
      objectChanges += 1;
    },
  });
  const openedDoc = session.doc;
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);
  const before = Y.encodeStateVector(rendererDoc);
  input.edit(rendererDoc.getText("plainText"));
  session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));
  const settled = await session.settleNow().then(
    (value) => value,
    (error: unknown) => ({ refused: error }),
  );
  return {
    settled,
    reopenObjectIds,
    objectChanges: () => objectChanges,
    rendererDoc,
    session,
    openedDoc,
    claimId,
    replacements,
    claimedRecords,
    claimedTexts: () => claimedDocs.map((doc) => doc.getText("plainText").toString()),
    close: async () => {
      await session.close({ settle: false });
      await capture.stop();
    },
  };
}

it("keeps typing the lost generation could not record when the engine claimed its history", async () => {
  const typed = await typeIntoLostGeneration({
    base: "recorded",
    claimedState: (base) => base,
    originatedHere: true,
    edit: (text) => text.insert(text.length, " typed"),
  });

  expect(typed.settled).toMatchObject({ content: "recorded typed" });
  expect(typed.replacements).toEqual([]);
  expect(typed.session.doc).toBe(typed.openedDoc);
  expect(typed.session.lineageClaimId).toBe(typed.claimId);
  expect(typed.claimedRecords).toHaveLength(1);
  expect(typed.claimedTexts()).toEqual(["recorded typed"]);
  await typed.close();
});

it("replaces the document when a foreign fork claims it while the generation is lost", async () => {
  const typed = await typeIntoLostGeneration({
    base: "abcdef",
    claimedState: (base) => {
      const fork = new Y.Doc();
      Y.applyUpdate(fork, base);
      fork.getText("plainText").delete(0, 1);
      return Y.encodeStateAsUpdate(fork);
    },
    originatedHere: false,
    edit: (text) => {
      text.delete(0, 2);
      text.insert(text.length, " local");
    },
  });

  expect(typed.settled).toMatchObject({ content: "bcdef" });
  expect(typed.replacements).toEqual(["bcdef"]);
  expect(typed.session.doc).not.toBe(typed.openedDoc);
  expect(typed.claimedRecords).toEqual([]);
  expect(typed.claimedTexts()).toEqual(["bcdef"]);
  await typed.close();
});

it("refuses to reopen onto another object that moved onto the path", async () => {
  const typed = await typeIntoLostGeneration({
    base: "old document",
    claimedObjectId: "other-object",
    claimedState: () => {
      const other = new Y.Doc();
      other.getText("plainText").insert(0, "different document");
      return Y.encodeStateAsUpdate(other);
    },
    originatedHere: true,
    edit: (text) => text.insert(text.length, " typed"),
  });

  expect(typed.reopenObjectIds[0]).toBe("original-object");
  expect(typed.settled).toMatchObject({ refused: expect.any(Error) });
  expect(typed.replacements).toEqual([]);
  expect(typed.claimedRecords).toEqual([]);
  expect(typed.session.doc.getText("plainText").toString()).toBe("old document typed");
  expect(typed.objectChanges()).toBe(1);
  const before = Y.encodeStateVector(typed.rendererDoc);
  typed.rendererDoc.getText("plainText").insert(0, "more ");
  typed.session.applyLocalUpdate(Y.encodeStateAsUpdate(typed.rendererDoc, before));
  await expect(typed.session.settleNow()).rejects.toThrow();
  expect(typed.reopenObjectIds).toHaveLength(1);
  expect(typed.objectChanges()).toBe(1);
  await typed.close();
});

// The session recorded a word, and sync turned on before its settle ran. The
// generation is gone, its settle fails, and the sync pass claims exactly what
// was recorded. The replacement needs no replay, so the settle the lost
// generation owed must still run, or the file stays behind the document.
// The lost generation can report its failed settle before the drop, or only
// after adoption has already run: its settle waits out a delay, and the drop
// can arrive first through a session event. Both orders must settle.
for (const order of ["settle failure first", "drop first"] as const) {
  it(`settles a recorded word whose settle was lost with its generation (${order})`, async () => {
    const rootPath = await createTestScratch("dohc-ydoc-lineage-owed-settle-");
    const loopback = new VersionedLoopbackEngine();
    const client = (): EngineDaemonClient & EngineTransport => ({
      close: () => undefined,
      onEvent: () => () => undefined,
      async sendRequest(request: Request): Promise<Response> {
        if (request.method === "workspace.open") {
          return { id: request.id, result: { workspace: "owed-settle" } };
        }
        if (request.method === "workspace.close") {
          return { id: request.id, result: { closed: true } };
        }
        const lifecycle = daemonCaptureLifecycleAnswer(request);
        if (lifecycle) return lifecycle;
        return await loopback.sendRequest(request);
      },
    });
    const unclaimedClient = client();
    const claimedClient = client();
    let currentClient = unclaimedClient;
    const sessions = new EngineWorkspaceSessions(
      { currentClient: () => currentClient },
      { sleep: async () => undefined },
    );
    const engineDoc = new Y.Doc();
    engineDoc.getText("plainText").insert(0, "recorded");
    let recorded!: () => void;
    const wordRecorded = new Promise<void>((resolve) => {
      recorded = resolve;
    });
    let settledOnClaim!: (content: string) => void;
    const claimSettled = new Promise<string>((resolve) => {
      settledOnClaim = resolve;
    });
    let lostOptions: EngineYdocProviderSessionOptions | undefined;
    let claimedOpens = 0;
    const openProvider = async (
      options: EngineYdocProviderSessionOptions,
    ): Promise<EngineYdocProviderSession> => {
      const unclaimed = options.transport === unclaimedClient;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(engineDoc));
      const claimId = createHash("sha256").update(Y.encodeStateAsUpdate(engineDoc)).digest("hex");
      if (unclaimed) lostOptions = options;
      else claimedOpens += 1;
      return {
        doc,
        initialUpdate: Y.encodeStateAsUpdate(doc),
        objectId: "original-object",
        lineageClaimId: unclaimed ? null : claimId,
        lineageOriginatedHere: !unclaimed,
        contentKind: "plaintext",
        path: options.path,
        head: "present",
        lineage: "existing",
        unsettled: false,
        evict: async () => undefined,
        async applyLocalUpdate(update) {
          Y.applyUpdate(doc, update);
          Y.applyUpdate(engineDoc, update);
          recorded();
        },
        async settleNow() {
          const markdown = doc.getText("plainText").toString();
          if (!unclaimed) settledOnClaim(markdown);
          return {
            momentId: "owed-moment",
            path: options.path,
            content: markdown,
            sha256: createHash("sha256").update(markdown).digest("hex"),
            materialized: true,
            projection: {
              contentKind: "plaintext",
              sourceStateVectorSha256: "a".repeat(64),
              destructive: false,
            },
          };
        },
        async close() {
          return;
        },
      };
    };
    const capture = createWorkspaceEngineCapture({
      workspaceId: "owed-settle",
      rootPath,
      rustEngineSessions: sessions,
      openRustYDocProviderSession: openProvider,
    });
    const replacements: Y.Doc[] = [];
    const session = await capture.openYDocSession({
      path: "note.md",
      onRemoteUpdate: () => undefined,
      onLineageReplaced: (update) => {
        const replacement = new Y.Doc();
        Y.applyUpdate(replacement, update);
        replacements.push(replacement);
      },
    });
    const rendererDoc = new Y.Doc();
    Y.applyUpdate(rendererDoc, session.initialUpdate);
    const before = Y.encodeStateVector(rendererDoc);
    rendererDoc.getText("plainText").insert("recorded".length, " typed");
    session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));
    await wordRecorded;

    currentClient = claimedClient;
    const lost = Object.assign(new Error("workspace handle is unavailable"), {
      code: "transport-error",
    });
    if (order === "settle failure first") {
      lostOptions?.onSettleError?.(lost, 1);
      lostOptions?.onSessionError?.(lost);
    } else {
      lostOptions?.onSessionError?.(lost);
      await expect.poll(() => claimedOpens, { timeout: 5_000 }).toBe(1);
      await new Promise((resolve) => setImmediate(resolve));
      lostOptions?.onSettleStart?.(1);
      lostOptions?.onSettleError?.(lost, 1);
    }

    await expect(claimSettled).resolves.toBe("recorded typed");
    expect(replacements).toEqual([]);
    await session.close({ settle: false });
    await capture.stop();
  });
}

it("evicts a failed generation before accepting the next edit", async () => {
  const rootPath = await createTestScratch("dohc-ydoc-close-retry-");
  const loopback = new VersionedLoopbackEngine();
  const daemonClient: EngineDaemonClient & EngineTransport = {
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "ydoc-close-retry" } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      const lifecycle = daemonCaptureLifecycleAnswer(request);
      if (lifecycle) return lifecycle;
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions({
    currentClient: () => daemonClient,
  });
  const seed = new Y.Doc();
  seed.getText("plainText").insert(0, "seed");
  const seedUpdate = Y.encodeStateAsUpdate(seed);
  const closeAttempts: Array<{ generation: number; settle?: boolean }> = [];
  const journaledGenerations: number[] = [];
  let generation = 0;
  let leaseActive = false;
  const refusal = new Error("record-update-refused");
  const unsettledClose = new Error("ydoc-unsettled-close");

  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    if (leaseActive) throw new Error("ydoc-session-busy");
    leaseActive = true;
    const openedGeneration = ++generation;
    let providerClosed = false;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, seedUpdate);
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      contentKind: "plaintext",
      path: options.path,
      head: "present" as const,
      lineage: "existing" as const,
      unsettled: false,
      evict: async () => {
        providerClosed = true;
        closeAttempts.push({ generation: openedGeneration, settle: false });
        leaseActive = false;
      },
      async applyLocalUpdate(update) {
        // Models the provider latch: once close starts, another apply
        // resolves without journaling. Capture must never leave this provider
        // installed after the first close refusal.
        if (providerClosed) return;
        if (openedGeneration === 1) throw refusal;
        Y.applyUpdate(doc, update);
        journaledGenerations.push(openedGeneration);
      },
      async settleNow() {
        const markdown = doc.getText("plainText").toString();
        return {
          momentId: `moment-${openedGeneration}`,
          path: options.path,
          content: markdown,
          sha256: createHash("sha256").update(markdown).digest("hex"),
          materialized: true,
          projection: {
            contentKind: "plaintext",
            sourceStateVectorSha256: "a".repeat(64),
            destructive: false,
          },
        };
      },
      async close(closeOptions) {
        providerClosed = true;
        closeAttempts.push({
          generation: openedGeneration,
          ...(closeOptions?.settle !== undefined ? { settle: closeOptions.settle } : {}),
        });
        if (openedGeneration === 1 && closeOptions?.settle === false) {
          throw unsettledClose;
        }
        leaseActive = false;
      },
    };
  };
  const outcomes: boolean[] = [];
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-close-retry",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onCaptureOutcome: (failure) => outcomes.push(failure === null),
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);

  const beforeFirst = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(4, " first");
  session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, beforeFirst));
  await expect(session.settleNow()).resolves.toMatchObject({
    content: "seed first",
  });

  const beforeSecond = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(10, " second");
  session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, beforeSecond));
  await expect(session.settleNow()).resolves.toMatchObject({
    content: "seed first second",
  });

  expect(closeAttempts).toEqual([{ generation: 1, settle: false }]);
  expect(journaledGenerations).toEqual([2, 2]);
  expect(generation).toBe(2);
  expect(leaseActive).toBe(true);
  expect(outcomes).toEqual([]);
  await session.close({ settle: false });
  expect(leaseActive).toBe(false);
  await capture.stop();
});

it("an over-cap settle (content omitted from the response) leaves the engine's file on disk intact", async () => {
  // AUDIT-SILENTSAVE, fix 2. Past the engine's in-band response cap the settle
  // still commits and the DAEMON materializes the .md — the response just
  // cannot carry the body as one wire string, so it answers content: null.
  // The capture must recognize that and stand down. Mirroring null onto disk
  // would truncate the user's file to zero bytes, which is the very loss this
  // whole change exists to stop.
  const rootPath = await createTestScratch("dohc-ydoc-overcap-");
  const loopback = new VersionedLoopbackEngine();
  const daemonClient: EngineDaemonClient & EngineTransport = {
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "ydoc-overcap" } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      const lifecycle = daemonCaptureLifecycleAnswer(request);
      if (lifecycle) return lifecycle;
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions({
    currentClient: () => daemonClient,
  });

  const onDiskBody = "pasted load-test paragraph.\n".repeat(4_000);
  await writeFile(join(rootPath, "load.md"), onDiskBody);

  const seed = new Y.Doc();
  seed.getText("plainText").insert(0, "seed");
  const seedUpdate = Y.encodeStateAsUpdate(seed);
  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, seedUpdate);
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      contentKind: "plaintext",
      path: options.path,
      head: "present",
      lineage: "existing" as const,
      unsettled: false,
      evict: async () => undefined,
      async applyLocalUpdate(update) {
        Y.applyUpdate(doc, update);
      },
      async settleNow() {
        const result = {
          momentId: "moment-overcap",
          path: options.path,
          content: null,
          sha256: createHash("sha256").update(onDiskBody).digest("hex"),
          materialized: true,
          projection: {
            contentKind: "plaintext" as const,
            sourceStateVectorSha256: "b".repeat(64),
            destructive: false,
          },
        };
        await options.onSettled?.(result, 1);
        return result;
      },
      async close() {
        return;
      },
    };
  };
  const onError = vi.fn();
  const states: string[] = [];
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-overcap",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onError,
  });
  const session = await capture.openYDocSession({
    path: "load.md",
    onRemoteUpdate: () => undefined,
    onSaveState: (state) => states.push(state),
  });
  await session.settleNow();

  const onDisk = await readFile(join(rootPath, "load.md"), "utf8");
  expect(onDisk).toBe(onDiskBody);
  expect(onDisk.length).toBeGreaterThan(48 * 1024);
  expect(states).toContain("saved");
  expect(states).not.toContain("error");
  expect(onError).not.toHaveBeenCalled();

  await session.close({ settle: false });
  await capture.stop();
});

it("a settle whose materialization was blocked reports an error, never Saved", async () => {
  const rootPath = await createTestScratch("dohc-ydoc-blocked-");
  const loopback = new VersionedLoopbackEngine();
  const daemonClient: EngineDaemonClient & EngineTransport = {
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "ydoc-blocked" } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      const lifecycle = daemonCaptureLifecycleAnswer(request);
      if (lifecycle) return lifecycle;
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions({
    currentClient: () => daemonClient,
  });

  const stale = "the artifact that is still on disk\n";
  await writeFile(join(rootPath, "note.md"), stale);

  const seed = new Y.Doc();
  seed.getText("plainText").insert(0, "seed");
  const seedUpdate = Y.encodeStateAsUpdate(seed);
  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, seedUpdate);
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      contentKind: "plaintext",
      path: options.path,
      head: "present",
      lineage: "existing" as const,
      unsettled: false,
      evict: async () => undefined,
      async applyLocalUpdate(update) {
        Y.applyUpdate(doc, update);
      },
      async settleNow() {
        const result = {
          momentId: "moment-blocked",
          path: options.path,
          content: null,
          sha256: createHash("sha256").update("never landed").digest("hex"),
          materialized: false,
          projection: {
            contentKind: "plaintext" as const,
            sourceStateVectorSha256: "c".repeat(64),
            destructive: false,
          },
        };
        await options.onSettled?.(result, 1);
        return result;
      },
      async close() {
        return;
      },
    };
  };
  const onError = vi.fn();
  const states: string[] = [];
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-blocked",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onError,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
    onSaveState: (state) => states.push(state),
  });
  await session.settleNow();

  expect(states).not.toContain("saved");
  expect(states).toContain("error");
  expect(onError).toHaveBeenCalled();
  expect(String(onError.mock.calls.at(-1)?.[0])).toContain("note.md");
  expect(await readFile(join(rootPath, "note.md"), "utf8")).toBe(stale);

  await session.close({ settle: false });
  await capture.stop();
});

// AUDIT-KILLREC. A hard `taskkill /F` on the daemon takes the whole transport
// with it: the generation's applyLocalUpdate fails and the replacement open
// fails, until the supervisor relaunches. This harness reproduces that window,
// which is where the dogfood journey lost the text typed before the kill.
//
// It models the daemon's durable state, not an empty stand-in: a replacement
// generation replays the journaled updates, so the reconcile-then-replay merge
// in adoptGeneration is genuinely exercised. `lineage: "absent"` models a crash
// that lost the durable lineage, where the client would otherwise seed a fresh
// doc from the .md. Retry counts are production's; only the backoff sleep is
// stubbed, so the transport-retry path runs for real without wall time. Every
// delay it asks for is recorded, so a test can price a retry path exactly
// instead of timing it against a machine other tests are also using.
async function daemonDeathCapture(
  prefix: string,
  workspaceId: string,
): Promise<{
  rootPath: string;
  sessions: EngineWorkspaceSessions;
  openProvider: (options: EngineYdocProviderSessionOptions) => Promise<EngineYdocProviderSession>;
  state: {
    daemonAlive: boolean;
    generation: number;
    lineage: "present" | "absent";
    durableUpdates: Uint8Array[];
    recoveryBases: Uint8Array[];
    journalKeys: Array<string | null>;
    applyFaults: Array<
      | "drop"
      | "commit-then-drop"
      | "commit-then-die"
      | "commit-then-cancel"
      | "commit-then-internal"
    >;
    applyRefusals: unknown[];
    diskMarkdown: string;
    settled: string[];
    seedRequests: boolean[];
    reportedLineage: Array<"existing" | "absent">;
    refuseApply: boolean;
    failRelease: boolean;
    releasedGenerations: number[];
  };
  generations: Y.Doc[];
  backoff: { delays: number[] };
  loseDurableLineage: () => void;
  applyDaemonSideEdit: (text: string) => void;
}> {
  const rootPath = await createTestScratch(prefix);
  const loopback = new VersionedLoopbackEngine();
  const state = {
    daemonAlive: true,
    generation: 0,
    lineage: "present" as "present" | "absent",
    durableUpdates: [] as Uint8Array[],
    recoveryBases: [] as Uint8Array[],
    journalKeys: [] as Array<string | null>,
    // What the next journal writes meet, one fault per write. "drop": the
    // daemon died before recording, and is already back for the rebind.
    // "commit-then-drop": it recorded, then the response was lost the same
    // way. "commit-then-die": it recorded, then died and stays down.
    applyFaults: [] as Array<
      | "drop"
      | "commit-then-drop"
      | "commit-then-die"
      | "commit-then-cancel"
      | "commit-then-internal"
    >,
    applyRefusals: [] as unknown[],
    diskMarkdown: "",
    settled: [] as string[],
    seedRequests: [] as boolean[],
    // What each open reported for the lineage. A fake that hardcodes this
    // cannot be caught by any assertion about the code under test, so the
    // fixture is asserted on directly.
    reportedLineage: [] as Array<"existing" | "absent">,
    // A live daemon refusing the write (not a transport death): the generation
    // still owns its lease, so recovery must release before reopening.
    refuseApply: false,
    failRelease: false,
    releasedGenerations: [] as number[],
  };
  const generations: Y.Doc[] = [];
  // The daemon's request ledger: a key refuses bytes it was not first used
  // with, and outlives any one generation.
  const keyLedger = new Map<string, string>();
  const transportDeath = () =>
    Object.assign(new Error("The engine client is closed: transport closed."), {
      code: "transport-error",
    });
  const daemonClient: EngineDaemonClient & EngineTransport = {
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      if (!state.daemonAlive) throw transportDeath();
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: workspaceId } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      const lifecycle = daemonCaptureLifecycleAnswer(request);
      if (lifecycle) return lifecycle;
      return await loopback.sendRequest(request);
    },
  };
  // Backoff never sleeps, so no test pays wall time for it; the requested
  // delays are the record a test asserts against.
  const backoff = { delays: [] as number[] };
  const sessions = new EngineWorkspaceSessions(
    {
      // The supervisor stops handing out a client once the daemon process is
      // gone (EngineDaemonLifecycle.requireClient), so a caller that reaches
      // for one during the outage never gets a stale transport to fail on.
      // Returning the dead client here made a rebind look one attempt cheaper
      // than production's.
      currentClient: () => {
        if (!state.daemonAlive) {
          throw new EngineDaemonUnavailableError("Rust engine daemon is not available.");
        }
        return daemonClient;
      },
    },
    {
      sleep: async (delayMs) => {
        backoff.delays.push(delayMs);
      },
    },
  );
  const replayLineage = (doc: Y.Doc): void => {
    for (const update of state.durableUpdates) Y.applyUpdate(doc, update);
  };
  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    if (!state.daemonAlive) throw transportDeath();
    const openedGeneration = ++state.generation;
    const seeds = options.seedAbsentLineage !== false;
    state.seedRequests.push(seeds);
    const doc = new Y.Doc();
    if (state.lineage === "present") {
      replayLineage(doc);
    } else if (seeds) {
      // The client's absent-lineage seed: a fresh doc built from the markdown,
      // carrying a client id that overlaps nothing already in the canonical doc.
      const seed = new Y.Doc();
      seed.getText("plainText").insert(0, state.diskMarkdown);
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
    }
    generations.push(doc);
    const reportLineage = (): "existing" | "absent" => {
      // Existing means durable state, as in the daemon: a lineage with no
      // updates yet is absent.
      const reported =
        state.lineage === "present" && state.durableUpdates.length > 0 ? "existing" : "absent";
      state.reportedLineage.push(reported);
      return reported;
    };
    const settle = (): string => {
      const markdown = doc.getText("plainText").toString();
      state.settled.push(markdown);
      state.diskMarkdown = markdown;
      return markdown;
    };
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      contentKind: "plaintext",
      path: options.path,
      // The .md exists on disk throughout this fake, so the VERSION SNAPSHOT
      // never goes away: `head` is about that, and stays present.
      head: "present" as const,
      // Mapped from the state this fake models, never hardcoded.
      // `loseDurableLineage()` is the whole point of the fixture — it models a
      // crash that took the durable CRDT rows — and a fake that kept reporting
      // "existing" through it would certify the one state it exists to stage.
      // No production read reaches this today (the guard consults `lineage`
      // only once `head` is absent, which cannot happen here), so the fixture
      // is asserted on directly instead; see `state.reportedLineage`.
      lineage: reportLineage(),
      unsettled: false,
      evict: async () => {
        if (!state.daemonAlive) throw transportDeath();
        if (state.failRelease) throw new Error("release-refused");
        state.releasedGenerations.push(openedGeneration);
      },
      async reestablishAcknowledgedState(update) {
        if (!state.daemonAlive) throw transportDeath();
        expect(state.reportedLineage.at(-1)).toBe("absent");
        expect(state.durableUpdates).toHaveLength(0);
        state.recoveryBases.push(update);
        state.durableUpdates.push(update);
        state.lineage = "present";
        Y.applyUpdate(doc, update);
      },
      async applyLocalUpdate(update, applyOptions) {
        if (!state.daemonAlive) throw transportDeath();
        if (state.applyRefusals.length > 0) throw state.applyRefusals.shift();
        const fault = state.applyFaults.shift();
        if (fault === "drop") throw transportDeath();
        if (state.refuseApply) throw new Error("record-update-refused");
        const key = applyOptions?.idempotencyKey;
        const bytes = Buffer.from(update).toString("base64");
        if (key !== undefined && keyLedger.has(key)) {
          if (keyLedger.get(key) !== bytes) {
            throw Object.assign(new Error("idempotency-key-reuse-mismatch"), {
              wireError: {
                code: "INVALID_PARAMS",
                message: "idempotency-key-reuse-mismatch",
                retry: "no",
              },
            });
          }
          return;
        }
        if (key !== undefined) keyLedger.set(key, bytes);
        Y.applyUpdate(doc, update);
        state.durableUpdates.push(update);
        state.journalKeys.push(key ?? null);
        if (fault === "commit-then-cancel" || fault === "commit-then-internal") {
          throw new DaemonRefusalError(
            {
              code: fault === "commit-then-cancel" ? "CANCELLED" : "INTERNAL",
              message: "answer lost after commit",
              retry: "no",
            },
            undefined,
          );
        }
        if (fault === "commit-then-die") state.daemonAlive = false;
        if (fault !== undefined) throw transportDeath();
      },
      async settleNow() {
        if (!state.daemonAlive) throw transportDeath();
        const markdown = settle();
        return {
          momentId: `moment-${openedGeneration}`,
          path: options.path,
          content: markdown,
          sha256: createHash("sha256").update(markdown).digest("hex"),
          materialized: true,
          projection: {
            contentKind: "plaintext",
            sourceStateVectorSha256: "b".repeat(64),
            destructive: false,
          },
        };
      },
      async close(closeOptions) {
        if (!state.daemonAlive) throw transportDeath();
        if (state.failRelease) throw new Error("release-refused");
        if (closeOptions?.settle !== false) settle();
        state.releasedGenerations.push(openedGeneration);
      },
    };
  };
  return {
    rootPath,
    sessions,
    openProvider,
    state,
    generations,
    backoff,
    loseDurableLineage: () => {
      state.lineage = "absent";
      state.durableUpdates = [];
    },
    // An agent/CLI edit landing on the daemon while the editor session is dead:
    // a different client id, so it is genuinely absent from the canonical doc.
    applyDaemonSideEdit: (text: string) => {
      const scratch = new Y.Doc();
      replayLineage(scratch);
      const before = Y.encodeStateVector(scratch);
      const body = scratch.getText("plainText");
      body.insert(body.length, text);
      state.durableUpdates.push(Y.encodeStateAsUpdate(scratch, before));
    },
  };
}

function typeInto(
  rendererDoc: Y.Doc,
  session: { applyLocalUpdate: (update: Uint8Array) => void },
  text: string,
): void {
  const before = Y.encodeStateVector(rendererDoc);
  const body = rendererDoc.getText("plainText");
  body.insert(body.length, text);
  session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));
}

it("keeps every keystroke typed while the daemon is dead and replays them into the replacement", async () => {
  const { rootPath, sessions, openProvider, state, generations } = await daemonDeathCapture(
    "dohc-ydoc-daemon-death-",
    "ydoc-daemon-death",
  );
  const outcomes: boolean[] = [];
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-daemon-death",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onCaptureOutcome: (failure) => outcomes.push(failure === null),
    onError: () => undefined,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);

  typeInto(rendererDoc, session, "alive ");
  await session.settleNow();
  expect(generations[0]?.getText("plainText").toString()).toBe("alive ");

  state.daemonAlive = false;
  typeInto(rendererDoc, session, "PRE_KILL ");
  typeInto(rendererDoc, session, "DURING_OUTAGE ");
  await expect(session.settleNow()).rejects.toThrow(/closed/i);
  expect(state.generation).toBe(1);
  expect(outcomes.at(-1)).toBe(false);

  state.daemonAlive = true;
  typeInto(rendererDoc, session, "AFTER_RESTART");
  await expect.poll(() => state.generation).toBe(2);

  const settled = await session.settleNow();
  expect(settled?.content).toBe("alive PRE_KILL DURING_OUTAGE AFTER_RESTART");
  expect(generations[1]?.getText("plainText").toString()).toBe(
    "alive PRE_KILL DURING_OUTAGE AFTER_RESTART",
  );
  expect(session.doc.getText("plainText").toString()).toBe(
    "alive PRE_KILL DURING_OUTAGE AFTER_RESTART",
  );
  expect(outcomes.at(-1)).toBe(true);

  await session.close({ settle: false });
  await capture.stop();
});

function keyedUpdate(rendererDoc: Y.Doc, text: string): Uint8Array {
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(rendererDoc));
  const before = Y.encodeStateVector(scratch);
  const body = scratch.getText("plainText");
  body.insert(body.length, text);
  return Y.encodeStateAsUpdate(scratch, before);
}

it.each(["insert", "delete"] as const)(
  "acknowledges a durable %s after its third spaced answer is lost",
  async (kind) => {
    const advanceBackoff = uncertainFailureClock();
    const fixture = await daemonDeathCapture("dohc-ydoc-third-commit-", "ydoc-third-commit");
    const notices = vi.fn();
    const capture = createWorkspaceEngineCapture({
      workspaceId: "ydoc-third-commit",
      rootPath: fixture.rootPath,
      rustEngineSessions: fixture.sessions,
      openRustYDocProviderSession: fixture.openProvider,
      onError: () => undefined,
    });
    const session = await capture.openYDocSession({
      path: "note.md",
      onRemoteUpdate: () => undefined,
      onEditRefused: notices,
    });
    await session.applyDecidedLocalUpdate(() => keyedUpdate(session.doc, "Base"));
    const mirror = new Y.Doc();
    Y.applyUpdate(mirror, Y.encodeStateAsUpdate(session.doc));
    const before = Y.encodeStateVector(mirror);
    if (kind === "delete") mirror.getText("plainText").delete(0, 4);
    else mirror.getText("plainText").insert(4, " saved once");
    const original = Y.encodeStateAsUpdate(mirror, before);
    const fail = () =>
      fixture.state.applyRefusals.push(
        new DaemonRefusalError(
          {
            code: "INTERNAL",
            message: "answer lost",
            retry: "no",
          },
          undefined,
        ),
      );
    fail();
    fail();
    fail();
    session.applyLocalUpdate(original, undefined, { idempotencyKey: "third-commit" });
    await expect(session.settleNow()).rejects.toThrow(/closed/i);
    advanceBackoff();
    fail();
    await expect(session.settleNow()).rejects.toThrow(/closed/i);
    advanceBackoff();
    fixture.state.applyFaults.push("commit-then-internal");
    expect((await session.settleNow())?.content).toBe(kind === "delete" ? "" : "Base saved once");
    expect(fixture.state.journalKeys.filter((key) => key === "third-commit")).toHaveLength(1);
    expect(notices).not.toHaveBeenCalled();
    mirror.destroy();
    await session.close({ settle: false });
    await capture.stop();
  },
);

it("retires an unanswered deletion whose clocks are durable but whose delete set is missing", async () => {
  const advanceBackoff = uncertainFailureClock();
  const fixture = await daemonDeathCapture(
    "dohc-ydoc-unrecorded-delete-",
    "ydoc-unrecorded-delete",
  );
  const notices = vi.fn();
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-unrecorded-delete",
    rootPath: fixture.rootPath,
    rustEngineSessions: fixture.sessions,
    openRustYDocProviderSession: fixture.openProvider,
    onError: () => undefined,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
    onEditRefused: notices,
  });
  await session.applyDecidedLocalUpdate(() => keyedUpdate(session.doc, "Keep me"));
  const mirror = new Y.Doc();
  Y.applyUpdate(mirror, Y.encodeStateAsUpdate(session.doc));
  const before = Y.encodeStateVector(mirror);
  mirror.getText("plainText").delete(0, 7);
  const deletion = Y.encodeStateAsUpdate(mirror, before);
  expect(Y.encodeStateVector(mirror)).toEqual(before);
  fixture.state.daemonAlive = false;
  session.applyLocalUpdate(deletion);
  await expect(session.settleNow()).rejects.toThrow(/closed/i);
  fixture.state.daemonAlive = true;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    advanceBackoff();
    fixture.state.applyRefusals.push(
      new DaemonRefusalError(
        {
          code: "INTERNAL",
          message: "unanswered deletion",
          retry: "no",
        },
        undefined,
      ),
    );
    if (attempt < 2) await expect(session.settleNow()).rejects.toThrow(/closed/i);
    else expect((await session.settleNow())?.content).toBe("Keep me");
  }
  expect(notices).toHaveBeenCalledTimes(1);
  expect(notices.mock.calls[0]?.[1]).toContain("No answer after three attempts.");
  mirror.destroy();
  await session.close({ settle: false });
  await capture.stop();
});

it.each(["definitive", "frozen", "uncertain", "uncertain-after-busy"])(
  "reports one %s replay refusal batch and preserves an independent client",
  async (kind) => {
    const advanceBackoff = uncertainFailureClock();
    const fixture = await daemonDeathCapture("dohc-ydoc-causal-refusal-", "ydoc-causal-refusal");
    const notices: string[] = [];
    const paused: (boolean | undefined)[] = [];
    const capture = createWorkspaceEngineCapture({
      workspaceId: "ydoc-causal-refusal",
      rootPath: fixture.rootPath,
      rustEngineSessions: fixture.sessions,
      openRustYDocProviderSession: fixture.openProvider,
      onError: () => undefined,
    });
    const mirror = new Y.Doc();
    const session = await capture.openYDocSession({
      path: "note.md",
      onRemoteUpdate: () => undefined,
      onEditRefused: (_id, message, isPaused) => {
        notices.push(message);
        paused.push(isPaused);
      },
      onLineageReplaced: (update) => {
        const fresh = new Y.Doc();
        Y.applyUpdate(fresh, update);
        expect(fresh.getText("plainText").toString()).toBe("Saved independent");
        fresh.destroy();
      },
    });
    Y.applyUpdate(mirror, session.initialUpdate);
    typeInto(mirror, session, "Saved ");
    await session.settleNow();
    const independent = keyedUpdate(mirror, "independent");
    fixture.state.daemonAlive = false;
    for (const text of ["refused", " dependent", " tail"]) typeInto(mirror, session, text);
    session.applyLocalUpdate(independent, undefined, {
      idempotencyKey: "other-client",
      actorOriginId: "other-agent",
    });
    await expect(session.settleNow()).rejects.toThrow(/closed/i);
    fixture.state.daemonAlive = true;
    const attempts = kind === "uncertain-after-busy" ? 5 : kind === "uncertain" ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const busy = kind === "uncertain-after-busy" && attempt === 1;
      fixture.state.applyRefusals.push(
        new DaemonRefusalError(
          {
            code: busy
              ? "OVERLOADED"
              : kind === "definitive" || kind === "frozen"
                ? "INVALID_PARAMS"
                : "INTERNAL",
            message: busy
              ? "engine-store-busy"
              : kind === "frozen"
                ? "owner-outbox-frozen"
                : "future-refusal",
            retry: busy ? "afterBackoff" : "no",
          },
          undefined,
        ),
      );
    }
    for (let attempt = 0; attempt < attempts - 1; attempt += 1) {
      await expect(session.settleNow()).rejects.toThrow(/closed/i);
      expect(notices).toHaveLength(0);
      advanceBackoff();
    }
    expect((await session.settleNow())?.content).toBe("Saved independent");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('could not save edits to "note.md"');
    expect(notices[0]).toContain("Open Notices. Use Save copy on this file's recovery row.");
    expect(notices[0]).toContain(
      kind === "definitive"
        ? "dohc refused this edit."
        : kind === "frozen"
          ? "Live editing is paused for this file."
          : "No answer after three attempts.",
    );
    expect(paused).toEqual([kind === "frozen"]);
    expect(fixture.state.journalKeys).toContain("other-client");
    mirror.destroy();
    await session.close({ settle: false });
    await capture.stop();
  },
);

it("names the pending queue limit and releases its byte budget after draining", async () => {
  const fixture = await daemonDeathCapture("dohc-ydoc-queue-limit-", "ydoc-queue-limit");
  const notices: string[] = [];
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-queue-limit",
    rootPath: fixture.rootPath,
    rustEngineSessions: fixture.sessions,
    openRustYDocProviderSession: fixture.openProvider,
    onError: () => undefined,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
    onEditRefused: (_id, message) => notices.push(message),
  });
  const empty = new Uint8Array([0, 0]);
  for (let count = 0; count <= YDOC_PENDING_MAX_RECORDS; count += 1)
    session.applyLocalUpdate(empty);
  await session.settleNow();
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("Too many edits are waiting to save.");
  expect(notices[0]).not.toContain("too large");
  expect(notices[0]).toContain("Open Notices. Use Save copy on this file's recovery row.");
  await session.applyDecidedLocalUpdate((doc) => keyedUpdate(doc, "later"), undefined, {
    idempotencyKey: "after-drain",
  });
  expect((await session.settleNow())?.content).toBe("later");
  expect(notices).toHaveLength(1);
  await session.close({ settle: false });
  await capture.stop();
});

it("sends a keyed write again under its key after its daemon died, so the key still refuses changed content", async () => {
  const { rootPath, sessions, openProvider, state } = await daemonDeathCapture(
    "dohc-ydoc-death-key-reuse-",
    "ydoc-death-key-reuse",
  );
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-death-key-reuse",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onError: () => undefined,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  await session.applyDecidedLocalUpdate((doc) => keyedUpdate(doc, "FIRST "), undefined, {
    idempotencyKey: "claim/1/0",
  });

  state.applyFaults.push("drop");
  await expect(
    session.applyDecidedLocalUpdate((doc) => keyedUpdate(doc, "CHANGED "), undefined, {
      idempotencyKey: "claim/1/0",
    }),
  ).rejects.toThrow("idempotency-key-reuse-mismatch");
  expect(session.doc.getText("plainText").toString()).toBe("FIRST ");

  state.applyFaults.push("drop");
  await session.applyDecidedLocalUpdate((doc) => keyedUpdate(doc, "NEXT"), undefined, {
    idempotencyKey: "claim/1/1",
  });
  expect(state.journalKeys).toEqual(["claim/1/0", "claim/1/1"]);
  expect((await session.settleNow())?.content).toBe("FIRST NEXT");
  await session.close({ settle: false });
  await capture.stop();
});

async function keyedFaultCapture(prefix: string) {
  const fixture = await daemonDeathCapture(prefix, prefix.replace(/-+$/, ""));
  const errors: string[] = [];
  const capture = createWorkspaceEngineCapture({
    workspaceId: prefix.replace(/-+$/, ""),
    rootPath: fixture.rootPath,
    rustEngineSessions: fixture.sessions,
    openRustYDocProviderSession: fixture.openProvider,
    onError: (context) => errors.push(context),
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  return { ...fixture, capture, session, errors };
}

it("says a keyed write may have been recorded when its retry's answer is lost with the daemon", async () => {
  const { capture, session, state, errors } = await keyedFaultCapture("dohc-ydoc-keyed-uncertain-");
  state.applyFaults.push("drop", "commit-then-die");
  await expect(
    session.applyDecidedLocalUpdate((doc) => keyedUpdate(doc, "KEYED"), undefined, {
      idempotencyKey: "claim/1/0",
    }),
  ).rejects.toThrow("may have been recorded");
  expect(errors).toContain("Y.Doc rebind of note.md");

  state.daemonAlive = true;
  expect((await session.settleNow())?.content).toBe("KEYED");
  expect(state.journalKeys).toEqual(["claim/1/0"]);
  await session.close({ settle: false });
  await capture.stop();
});

it("a workspace close fails while the daemon is still down, and reopens nothing", async () => {
  const reported: string[] = [];
  const { rootPath, sessions, openProvider, state } = await daemonDeathCapture(
    "dohc-ydoc-death-still-down-",
    "ydoc-death-still-down",
  );
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-death-still-down",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onError: (context) => reported.push(context),
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);
  typeInto(rendererDoc, session, "alive ");
  await session.settleNow();
  state.daemonAlive = false;
  typeInto(rendererDoc, session, "PRE_KILL");
  await expect(session.settleNow()).rejects.toThrow(/closed/i);

  await expect(capture.settleAndCloseAllLiveSessions()).rejects.toThrow(/closed/i);
  expect(state.generation).toBe(1);
  expect(state.diskMarkdown).toBe("alive ");

  state.daemonAlive = true;
  await capture.stop();
  await session.close();
  expect(state.generation).toBe(1);
  expect(reported).toContain("Y.Doc close recovery of note.md");
});

it("merges a daemon-side edit made during the outage into the canonical doc once", async () => {
  const { rootPath, sessions, openProvider, state, applyDaemonSideEdit } = await daemonDeathCapture(
    "dohc-ydoc-death-merge-",
    "ydoc-death-merge",
  );
  const remoteUpdates: Uint8Array[] = [];
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-death-merge",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onError: () => undefined,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: (update) => remoteUpdates.push(update),
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);

  typeInto(rendererDoc, session, "alive ");
  await session.settleNow();

  state.daemonAlive = false;
  typeInto(rendererDoc, session, "TYPED_IN_OUTAGE ");
  await expect(session.settleNow()).rejects.toThrow(/closed/i);

  state.daemonAlive = true;
  applyDaemonSideEdit("AGENT_EDIT ");

  await session.close();

  const merged = state.settled.at(-1) ?? "";
  expect(merged).toContain("TYPED_IN_OUTAGE");
  expect(merged).toContain("AGENT_EDIT");
  expect(merged.match(/AGENT_EDIT/g)).toHaveLength(1);
  expect(merged.match(/TYPED_IN_OUTAGE/g)).toHaveLength(1);
  expect(merged.match(/alive/g)).toHaveLength(1);
  expect(remoteUpdates.length).toBeGreaterThan(0);
  await capture.stop();
});

it("does not duplicate the document when the reopen finds no durable lineage", async () => {
  const { rootPath, sessions, openProvider, state, loseDurableLineage } = await daemonDeathCapture(
    "dohc-ydoc-death-absent-",
    "ydoc-death-absent",
  );
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-death-absent",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onError: () => undefined,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);

  typeInto(rendererDoc, session, "Anchor paragraph. ");
  await session.settleNow();
  expect(state.diskMarkdown).toBe("Anchor paragraph. ");

  state.daemonAlive = false;
  typeInto(rendererDoc, session, "PRE_KILL");
  await expect(session.settleNow()).rejects.toThrow(/closed/i);

  loseDurableLineage();
  state.daemonAlive = true;
  await session.close();

  expect(state.settled.at(-1)).toBe("Anchor paragraph. PRE_KILL");
  expect(state.settled.at(-1)?.match(/Anchor paragraph\./g)).toHaveLength(1);
  // The first open seeds; every replacement declines, because the canonical doc
  // already holds the document and will replay it.
  expect(state.seedRequests).toEqual([true, false]);
  // The fake told the truth about the state it models: no durable state at the
  // first open, and none again once the modelled crash took the lineage. A
  // fixture that hardcoded "existing" here would keep passing every assertion
  // above while certifying the one condition it exists to stage.
  expect(state.reportedLineage).toEqual(["absent", "absent"]);
  expect(state.recoveryBases).toHaveLength(1);
  const base = new Y.Doc();
  Y.applyUpdate(base, state.recoveryBases[0]!);
  expect(base.getText("plainText").toString()).toBe("Anchor paragraph. ");
  base.destroy();
  await capture.stop();
});

it("does not adopt an absent lineage as the winner of an acknowledged claim", async () => {
  const fixture = await daemonDeathCapture("dohc-ydoc-lost-claim-", "ydoc-lost-claim");
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-lost-claim",
    rootPath: fixture.rootPath,
    rustEngineSessions: fixture.sessions,
    openRustYDocProviderSession: async (options) => ({
      ...(await fixture.openProvider(options)),
      lineageClaimId: fixture.state.generation === 1 ? "saved-claim" : null,
    }),
    onError: () => undefined,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const mirror = new Y.Doc();
  Y.applyUpdate(mirror, session.initialUpdate);
  typeInto(mirror, session, "Saved ");
  await session.settleNow();
  fixture.state.daemonAlive = false;
  typeInto(mirror, session, "pending");
  await expect(session.settleNow()).rejects.toThrow(/closed/i);
  fixture.loseDurableLineage();
  fixture.state.daemonAlive = true;
  await expect(session.settleNow()).rejects.toThrow(/closed/i);
  expect(fixture.state.diskMarkdown).toBe("Saved ");
  expect(session.doc.getText("plainText").toString()).toBe("Saved pending");
  expect(fixture.state.recoveryBases).toHaveLength(0);
  mirror.destroy();
  await session.close({ settle: false });
  await capture.stop();
});

// AUDIT-KILLREC N1. `will-quit` races the whole shutdown chain against one 3s
// timer and then calls app.exit(0); the Y.Doc session closes are its first
// link, with the SQLite/WAL closes and the daemon stop chained behind them. A
// recovery attempt on the close/settle path must therefore be BOUNDED: against
// a daemon that is still down it cannot succeed anyway, and burning the
// transport retry ladder (100+200+400+800+1000ms = 2.5s of the 3s budget)
// would starve the cleanup that still can.
//
// The bound is scoped to the quit teardown, which is the only close inside
// that budget. A user closing a document keeps the ladder, so a daemon that
// relaunches in a second still gives them a live session back.
//
// The tests below price both paths as the backoff each asks the supervisor
// for, not as elapsed wall time: a wall-clock bound loose enough to survive a
// loaded suite also passes a real regression on a quiet machine.
const BOUNDED_CLOSE_BACKOFF_MS = [100];

it("a settling close of a DEAD session against a down daemon takes one bounded backoff, not the ladder", async () => {
  const { rootPath, sessions, openProvider, state, backoff } = await daemonDeathCapture(
    "dohc-ydoc-death-budget-",
    "ydoc-death-budget",
  );
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-death-budget",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onError: () => undefined,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);
  typeInto(rendererDoc, session, "alive ");
  await session.settleNow();

  state.daemonAlive = false;
  typeInto(rendererDoc, session, "PRE_KILL");
  await expect(session.settleNow()).rejects.toThrow(/closed/i);

  // Only the close is priced: the set-up's own retries are not the subject.
  backoff.delays.length = 0;
  await session.close({ shuttingDown: true }).catch(() => undefined);

  expect(backoff.delays).toEqual(BOUNDED_CLOSE_BACKOFF_MS);
  expect(state.generation).toBe(1);
});

it.each(["failure", "success"] as const)(
  "pairs an old generation's delayed %s with its own save sequence",
  async (oldOutcome) => {
    const rootPath = await createTestScratch("dohc-ydoc-settle-identity-");
    const workspace = "ydoc-settle-identity";
    const versioned = new VersionedLoopbackEngine();
    versioned.seedTextFile({ workspace, path: "note.md", text: "" });
    await writeFile(join(rootPath, "note.md"), "", "utf8");
    const engines = [new YdocLoopbackEngine(), new YdocLoopbackEngine()];
    for (const engine of engines) {
      engine.seedFile({
        workspace,
        versionId: "main",
        path: "note.md",
        content: "",
        contentKind: "plaintext",
      });
    }
    const oldResponse = Promise.withResolvers<void>();
    const oldReached = Promise.withResolvers<void>();
    const newResponse = Promise.withResolvers<void>();
    const newReached = Promise.withResolvers<void>();
    let restarted = false;
    let replacementBusy = true;
    const transportError = () =>
      Object.assign(new Error("daemon restarted"), { code: "transport-error" });
    let currentClient: EngineDaemonClient & EngineTransport;
    const clients = engines.map((engine, index): EngineDaemonClient & EngineTransport => ({
      close: () => undefined,
      helloAck: engine.helloAck,
      onBlob: (handler) => engine.onBlob(handler),
      onEvent: (handler) => engine.onEvent(handler),
      async sendRequest(request) {
        if (request.method === "workspace.open") return { id: request.id, result: { workspace } };
        if (request.method === "workspace.close")
          return { id: request.id, result: { closed: true } };
        if (!request.method.startsWith("ydoc.")) {
          return daemonCaptureLifecycleAnswer(request) ?? (await versioned.sendRequest(request));
        }
        if (index === 0 && restarted) {
          currentClient = clients[1]!;
          throw transportError();
        }
        if (request.method === "ydoc.settle" && index === 1) {
          newReached.resolve();
          await newResponse.promise;
          if (replacementBusy) throw busyRefusal();
        }
        const response = await engine.sendRequest(request);
        if (request.method === "ydoc.settle") {
          const result = response.result as { content: string };
          await writeFile(join(rootPath, "note.md"), result.content, "utf8");
        }
        return response;
      },
    }));
    currentClient = clients[0]!;
    const sessions = new EngineWorkspaceSessions(
      { currentClient: () => currentClient },
      { sleep: async () => undefined },
    );
    const timers: Array<{
      generation: number;
      fire: () => void;
      cancelled: boolean;
    }> = [];
    let generation = 0;
    const saveSeq = createEngineYDocSaveSeqState();
    const reported: Array<{ state: string; seq: number }> = [];
    const capture = createWorkspaceEngineCapture({
      workspaceId: workspace,
      rootPath,
      rustEngineSessions: sessions,
      openRustYDocProviderSession: (options) => {
        const opened = ++generation;
        return openEngineYdocProviderSession({
          ...options,
          scheduleSettle: (fire) => {
            const timer = { generation: opened, fire, cancelled: false };
            timers.push(timer);
            return () => {
              timer.cancelled = true;
            };
          },
        });
      },
      onError: () => undefined,
    });
    const session = await capture.openYDocSession({
      path: "note.md",
      contentKind: "plaintext",
      onRemoteUpdate: () => undefined,
      onSaveState: (state, token, event) => {
        const seq =
          event === "start"
            ? noteSettleStart(saveSeq, token)
            : event === "outcome"
              ? noteSettleOutcome(saveSeq, token)
              : 0;
        reported.push({ state, seq });
      },
    });
    const rendererDoc = new Y.Doc();
    Y.applyUpdate(rendererDoc, session.initialUpdate);
    let rendererSeq = 0;
    expect(reported).toEqual([{ state: "saved", seq: 0 }]);
    reported.length = 0;
    const type = (text: string) => {
      const before = Y.encodeStateVector(rendererDoc);
      const body = rendererDoc.getText("plainText");
      body.insert(body.length, text);
      const seq = ++rendererSeq;
      session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before), () =>
        noteLocalEdit(saveSeq, seq),
      );
    };
    const { createReadStream } = await vi.importActual<typeof import("node:fs")>("node:fs");
    let oldReadHeld = false;
    const readSpy = vi.mocked(nodeFs.createReadStream).mockImplementation((path, options) => {
      if (String(path) !== join(rootPath, "note.md") || oldReadHeld) {
        return createReadStream(path, options);
      }
      oldReadHeld = true;
      // The old settle RPC succeeds before the daemon restarts. Its capture
      // callback is still awaiting the file check, which can be slow or fail.
      return Readable.from(
        (async function* () {
          oldReached.resolve();
          await oldResponse.promise;
          if (oldOutcome === "failure") {
            throw Object.assign(new Error("file check refused"), { code: "EACCES" });
          }
          yield* createReadStream(path, options);
        })(),
      ) as ReturnType<typeof createReadStream>;
    });
    try {
      type("old edit");
      await expect
        .poll(() => timers.find((timer) => timer.generation === 1 && !timer.cancelled))
        .toBeDefined();
      timers.find((timer) => timer.generation === 1 && !timer.cancelled)!.fire();
      await oldReached.promise;
      expect(reported).toEqual([{ state: "settling", seq: 1 }]);

      restarted = true;
      type(" plus new edit");
      await expect
        .poll(() => timers.find((timer) => timer.generation === 2 && !timer.cancelled))
        .toBeDefined();
      timers.find((timer) => timer.generation === 2 && !timer.cancelled)!.fire();
      await newReached.promise;
      expect(reported.at(-1)).toEqual({ state: "settling", seq: 2 });
      expect([...saveSeq.inFlight.values()]).toEqual([1, 2]);

      oldResponse.resolve();
      await expect
        .poll(() => reported.filter((entry) => entry.state !== "settling").length)
        .toBe(1);
      expect(await readFile(join(rootPath, "note.md"), "utf8")).toBe("old edit");
      expect.soft(reported.at(-1)).toEqual({
        state: oldOutcome === "success" ? "saved" : "error",
        seq: 1,
      });
      expect([...saveSeq.inFlight.values()]).toEqual([2]);

      vi.useFakeTimers();
      newResponse.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      vi.useRealTimers();
      expect(reported).toHaveLength(4);
      expect(reported.at(-1)).toEqual({ state: "settling", seq: rendererSeq });
      expect(saveSeq.inFlight.size).toBe(0);
      expect(await readFile(join(rootPath, "note.md"), "utf8")).toBe("old edit");

      replacementBusy = false;
      await session.settleNow();
      await expect
        .poll(() => reported.filter((entry) => entry.state !== "settling").length)
        .toBe(2);
      expect(reported.at(-1)).toEqual({ state: "saved", seq: rendererSeq });
      expect(await readFile(join(rootPath, "note.md"), "utf8")).toBe("old edit plus new edit");
      expect(saveSeq.inFlight.size).toBe(0);
    } finally {
      vi.useRealTimers();
      oldResponse.resolve();
      newResponse.resolve();
      readSpy.mockImplementation(createReadStream);
      await session.close({ settle: false });
      await capture.stop();
      rendererDoc.destroy();
    }
  },
);

// A locked-settle rebind harness: every applied update lands in a durable
// journal, and each new generation opens already holding all of it. So the
// adoption's replay is empty, and unless the adoption arms a settle on the
// replacement, the pending locked write sits stale until an unrelated edit.
async function lockedRebindCapture(
  prefix: string,
  options?: {
    monotonic?: () => number;
    teardownRetryMs?: WorkspaceEngineCaptureOptions["teardownRetryMs"];
    wrapProvider?: (
      base: (openOptions: EngineYdocProviderSessionOptions) => Promise<EngineYdocProviderSession>,
    ) => (openOptions: EngineYdocProviderSessionOptions) => Promise<EngineYdocProviderSession>;
  },
) {
  const rootPath = await createTestScratch(prefix);
  const workspaceId = prefix.replace(/-+$/, "");
  const loopback = new VersionedLoopbackEngine();
  const client: EngineDaemonClient & EngineTransport = {
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: workspaceId } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      const lifecycle = daemonCaptureLifecycleAnswer(request);
      if (lifecycle) return lifecycle;
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions(
    { currentClient: () => client },
    { sleep: async () => undefined },
  );
  const state = {
    locked: false,
    // The replicated shape: the compaction release succeeds
    // over a failed pre-close settle, so close throws
    // YdocReleasedWithSettleFailureError instead of the refusal itself.
    replicated: false,
    closeFailure: null as Error | null,
    closeSettleFailure: null as Error | null,
    settleFailure: null as Error | null,
    // A JOURNAL write the engine refuses. The busy case is the one the
    // provider retries by itself, so the wrapper must not rebind for it.
    recordFailure: null as Error | null,
    emitUpdateAfterSettle: false,
    // A peer update that lands while a session is retained —
    // after its close unsubscribed and before the daemon accepted the
    // release. It reaches the durable lineage; the deaf session never hears
    // it. This is the window a stale write proof survives into.
    peerEditWhileRetained: false,
    openGate: null as Promise<void> | null,
    // Counts every provider open the ladder attempts, including one that never
    // completes. A test proving a payment did not start reads this, because
    // `generation` only moves once the open succeeds.
    openAttempts: 0,
    // The engine commits the settle and declines to write the
    // target (a symlinked path or ancestor), so the call resolves clean while
    // the artifact stays stale.
    unmaterialized: false,
    closesWithSettleFalse: 0,
    journal: [] as Uint8Array[],
    settleCalls: [] as number[],
    closeCalls: [] as number[],
    settledContents: [] as string[],
    generation: 0,
    generationOptions: [] as EngineYdocProviderSessionOptions[],
    errors: [] as string[],
    // The MESSAGE, not just the context: a debt that gives up has to say
    // what the user can act on, and only the error carries that.
    errorMessages: [] as string[],
    // How many times a session discharged through evict instead
    // of a materializing close. The orphan path already counts on this
    // exit; a suppressed close-retry's own dirty-session refusal needs the
    // same escape or its lease wedges the path busy until restart.
    evicts: 0,
  };
  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    // Counted before the gate, so a test can see a parked open.
    state.openAttempts += 1;
    if (state.openGate) {
      const gate = state.openGate;
      state.openGate = null;
      await gate;
    }
    const gen = ++state.generation;
    state.generationOptions.push(options);
    const doc = new Y.Doc();
    for (const update of state.journal) Y.applyUpdate(doc, update);
    let tokens = 0;
    // The real provider unsubscribes from remote updates at the top of
    // close(), before it asks the daemon to release
    // (ydocProviderSession.ts). A fake that keeps forwarding after a refused
    // close models a session that can still hear peers, which no retained
    // session can, and that difference hides defects.
    let listening = true;
    const deliverPeerEdit = (text: string) => {
      // The daemon's lineage advances whether or not this client hears it:
      // the update is journaled, so the next generation opens holding it.
      const peer = new Y.Doc();
      peer.getText("plainText").insert(0, text);
      const update = Y.encodeStateAsUpdate(peer);
      Y.applyUpdate(doc, update);
      state.journal.push(update);
      if (listening) options.onRemoteUpdate(update);
    };
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      contentKind: "plaintext",
      path: options.path,
      head: "present" as const,
      // The daemon reports a lineage only once it holds durable state.
      lineage: state.journal.length > 0 ? "existing" : "absent",
      unsettled: false,
      evict: async () => {
        state.evicts += 1;
      },
      async applyLocalUpdate(update) {
        // The provider's contract for a transient journal refusal:
        // it keeps the update (its own ladder resends it from durable state)
        // and rejects so the caller hears the truth. Modelling the rejection
        // without the keep would make the wrapper look safe for the wrong
        // reason — there would be nothing left to lose.
        Y.applyUpdate(doc, update);
        state.journal.push(update);
        if (state.recordFailure) throw state.recordFailure;
      },
      async settleNow() {
        state.settleCalls.push(gen);
        const token = ++tokens;
        // Real provider ordering: the settle announces itself before its
        // outcome is known, whatever that outcome turns out to be.
        options.onSettleStart?.(token);
        if (state.settleFailure) {
          const failure = state.settleFailure;
          options.onSettleError?.(failure, token);
          throw failure;
        }
        if (state.locked) {
          const refusal = new DaemonRefusalError(
            { code: "OVERLOADED", message: "file-locked", retry: "afterBackoff" },
            new Error("daemon response"),
          );
          options.onSettleError?.(refusal, token);
          throw refusal;
        }
        const markdown = doc.getText("plainText").toString();
        const result = {
          momentId: `moment-${gen}-${token}`,
          path: options.path,
          content: markdown,
          sha256: createHash("sha256").update(markdown).digest("hex"),
          materialized: !state.unmaterialized,
          projection: {
            contentKind: "plaintext" as const,
            sourceStateVectorSha256: "a".repeat(64),
            destructive: false,
          },
        };
        await options.onSettled?.(result, token);
        // The array is what landed on disk. An unmaterialized settle
        // committed the lineage and wrote nothing.
        if (!state.unmaterialized) state.settledContents.push(markdown);
        if (state.emitUpdateAfterSettle) {
          // A peer's update lands after this settle resolved: the close
          // that follows cannot vouch for it. It must be a real update —
          // an undecodable one throws inside the settle instead, which
          // re-arms the ladder on its own and proves nothing.
          state.emitUpdateAfterSettle = false;
          deliverPeerEdit("peer edit");
        }
        return result;
      },
      async close(closeOptions) {
        state.closeCalls.push(gen);
        // Ordering copied from the real provider: the subscriptions go first,
        // before the release is even attempted, and they never come back.
        listening = false;
        if (state.peerEditWhileRetained) {
          state.peerEditWhileRetained = false;
          deliverPeerEdit("peer edit while retained");
        }
        // ORDER, copied from the provider: the pre-close settle runs first,
        // and only then is the release attempted. A release that fails has
        // still run its settle, so `closeFailure` cannot be checked up here.
        let preCloseError: unknown = null;
        if (closeOptions?.settle === false) {
          state.closesWithSettleFalse += 1;
        } else {
          // The pre-close settle, same contract as settleNow: refuses while
          // locked, records the settled content when it lands.
          state.settleCalls.push(gen);
          const token = ++tokens;
          if (state.replicated && state.closeSettleFailure) {
            options.onSettleError?.(state.closeSettleFailure, token);
            preCloseError = state.closeSettleFailure;
          } else if (state.locked) {
            const refusal = new DaemonRefusalError(
              {
                code: "OVERLOADED",
                message: "file-locked",
                retry: "afterBackoff",
              },
              new Error("daemon response"),
            );
            options.onSettleError?.(refusal, token);
            preCloseError = refusal;
          } else {
            state.settledContents.push(doc.getText("plainText").toString());
          }
        }
        // The RELEASE. Its failure is what reaches the caller, and it buries
        // the pre-close settle's failure exactly as the provider does.
        if (state.closeFailure) {
          // `settle: false` is a preference, not a promise. A daemon that
          // refuses the release as unsettled makes the provider escalate to a
          // settling close so pending edits survive a transient failure — and
          // that close materializes the artifact on its way out.
          // `settleOnRefusal: false` is the only thing that turns it off.
          if (closeOptions?.settle === false && closeOptions?.settleOnRefusal !== false) {
            state.settleCalls.push(gen);
            if (!state.locked && !state.unmaterialized) {
              state.settledContents.push(doc.getText("plainText").toString());
            }
          }
          throw state.closeFailure;
        }
        if (preCloseError !== null) {
          // The release succeeded over a failed settle. Replicated lineages
          // compact and release cleanly, which is the shape that produces
          // this error; a local-only lineage refuses and the raw refusal is
          // what the escalated settling close ends up throwing.
          if (state.replicated) {
            throw new YdocReleasedWithSettleFailureError(options.path, preCloseError);
          }
          throw preCloseError;
        }
      },
    };
  };
  const capture = createWorkspaceEngineCapture({
    workspaceId,
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: options?.wrapProvider
      ? options.wrapProvider(openProvider)
      : openProvider,
    onError: (context, error) => {
      state.errors.push(context);
      state.errorMessages.push(error instanceof Error ? error.message : String(error));
    },
    ...(options?.monotonic ? { monotonic: options.monotonic } : {}),
    ...(options?.teardownRetryMs ? { teardownRetryMs: options.teardownRetryMs } : {}),
  });
  return { capture, state, loopback, workspaceId, rootPath };
}

/**
 * Open a document and journal one local edit through a renderer mirror.
 *
 * This is the prologue a debt test needs before it can put the path under a
 * lock, and nothing more. Everything a test actually asserts on — when the
 * lock goes on, which failure the fake raises, the order of close and delete,
 * what the journal ends up holding — stays written out in the test, because in
 * most of these the ORDER is the point. A test whose prologue differs at all
 * keeps its own; four do.
 */
async function openWithOneEdit(
  capture: WorkspaceEngineCapture,
  text: string,
  path = "note.md",
): Promise<{
  session: Awaited<ReturnType<WorkspaceEngineCapture["openYDocSession"]>>;
  mirror: Y.Doc;
}> {
  const session = await capture.openYDocSession({
    path,
    onRemoteUpdate: () => undefined,
  });
  const mirror = new Y.Doc();
  Y.applyUpdate(mirror, session.initialUpdate);
  const before = Y.encodeStateVector(mirror);
  mirror.getText("plainText").insert(0, text);
  await session.applyLocalUpdate(Y.encodeStateAsUpdate(mirror, before));
  return { session, mirror };
}

async function expectRemovalOpenRefused(
  capture: WorkspaceEngineCapture,
  path: string,
  inProgress: string,
): Promise<void> {
  const refusal = await capture.openYDocSession({ path, onRemoteUpdate: () => undefined }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(refusal).toMatchObject({
    name: "YDocRemovalInProgressError",
    code: "removal-in-progress",
    workspacePath: path,
  });
  expect((refusal as Error).message).toContain(inProgress);
}

function busyRefusal(): DaemonRefusalError {
  return new DaemonRefusalError(
    { code: "OVERLOADED", message: "engine-store-busy", retry: "afterBackoff" },
    new Error("daemon response"),
  );
}

it("absorbs a busy journal refusal instead of rebinding the generation", async () => {
  // The provider keeps a journal write the engine refused busy and re-arms
  // its own ladder to resend it. This boundary must not read that rejection
  // as a broken generation and rebind: a rebind closes the provider and
  // cancels the retry it just armed. If the replacement's replay met the same
  // busy store, adoptGeneration would mark the session dead with no timer
  // behind it, the canonical Y.Doc would live in memory, and the .md would
  // stay stale until some unrelated edit.
  //
  // Three edits while the store stays busy check that no edit rebinds.
  //
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-busy-journal-");
  const { session, mirror } = await openWithOneEdit(capture, "first edit ");
  expect(
    state.generation,
    "drop the `isTransientEngineCause` branch from the local-update catch -> the generation count climbs with every edit.",
  ).toBe(1);

  state.recordFailure = busyRefusal();
  typeInto(mirror, session, "second ");
  typeInto(mirror, session, "third ");
  typeInto(mirror, session, "fourth ");
  await new Promise((resolve) => setTimeout(resolve, 200));

  expect(state.generation).toBe(1);
  expect(state.openAttempts).toBe(1);

  state.recordFailure = null;
  await session.settleNow();
  const settled = state.settledContents.at(-1) ?? "";
  for (const text of ["first edit", "second", "third", "fourth"]) {
    expect(settled).toContain(text);
  }
  await capture.stop();
});

it("re-arms a pending locked settle on the generation that replaces a dead one", async () => {
  // The locked retry ladder lives in the generation and dies
  // with it. The adoption must ask the replacement to settle when a locked
  // write is pending, or a lock released after a daemon restart leaves the
  // artifact stale until an unrelated edit. (A still-held lock at that point
  // re-enters the provider's own ladder — pinned by the client-package test
  // "an explicit flush that hits the lock arms the retry too".)
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-locked-rebind-");
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });

  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);
  const before = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(0, "locked edit");
  await session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));

  state.locked = true;
  await expect(session.settleNow()).rejects.toThrow("file-locked");
  expect(state.settleCalls).toEqual([1]);

  state.locked = false;
  state.generationOptions[0]!.onSessionError?.(
    Object.assign(new Error("daemon exited"), { code: "transport-error" }),
  );

  await expect.poll(() => state.settleCalls).toEqual([1, 2]);
  await expect.poll(() => state.settledContents).toEqual(["locked edit"]);

  await session.close({ settle: false }).catch(() => undefined);
  await capture.stop();
});

it("replays no deletion history and settles nothing after the file changed outside dohc", async () => {
  // A deletion the lost generation already recorded still appears in any
  // diff, because a diff against a state vector carries the whole delete set.
  // The replacement lacks nothing, so nothing may be journaled into it, and
  // after a stale-target refusal nothing may settle over the outside change.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-stale-delete-");
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);
  let before = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(0, "abc");
  await session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));
  before = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").delete(1, 1);
  await session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));

  state.settleFailure = new DaemonRefusalError(
    { code: "INVALID_PARAMS", message: "conflict-stale-target", retry: "no" },
    new Error("daemon response"),
  );
  await expect(session.settleNow()).rejects.toThrow("conflict-stale-target");
  state.settleFailure = null;
  const journaled = state.journal.length;

  state.generationOptions[0]!.onSessionError?.(
    Object.assign(new Error("daemon exited"), { code: "transport-error" }),
  );
  await expect.poll(() => state.generation, { timeout: 5_000 }).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(state.journal).toHaveLength(journaled);
  expect(state.settleCalls).toEqual([1]);
  expect(state.settledContents).toEqual([]);

  await session.close({ settle: false }).catch(() => undefined);
  await capture.stop();
});

it("pays a locked close debt by itself once the lock releases", async () => {
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-locked-close-");
  const { session } = await openWithOneEdit(capture, "closing edit");

  state.locked = true;
  await expect(session.close()).rejects.toThrow("file-locked");

  state.locked = false;
  await expect.poll(() => state.settledContents, { timeout: 15_000 }).toEqual(["closing edit"]);
  await capture.stop();
});

it("pays a locked close debt even when a replicated release succeeds", async () => {
  // A replicated lineage compacts on release without the
  // local-only pending-job guard, so the close releases over the locked
  // settle — the session and its entry are gone, and the per-entry ladder
  // with them. The detached retry reopens enough state to settle once the
  // lock releases: no reopen by anyone else, no restart.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-replicated-close-");
  const { session } = await openWithOneEdit(capture, "replicated edit");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);

  state.locked = false;
  await expect.poll(() => state.settledContents, { timeout: 15_000 }).toEqual(["replicated edit"]);
  await capture.stop();
});

it("a rename after a version-switch stand-down refuses instead of saving stale content", async () => {
  // The active-version-branch door. `standDownFromWrite` must keep a marker
  // for the debt it stands down. If it deleted the entry, `beginFileRename`
  // would read the fence's stand-down as a landed write and record the stale
  // pre-lock disk artifact under the new name.
  //
  // The Rust engine's fence (`materialize_replay_pending_for_fence`, lib.rs)
  // replays this write before a switch can succeed, but that replay is a
  // daemon-internal operation this desktop session never opens a provider
  // for, so it never reaches `onSettled` and never clears this JS-side
  // marker. The shared refusal copy stays true from where this rename stands:
  // relative to the version now active, this path's disk content still
  // never came from this debt's write — the fence's own copy already landed
  // it under the old version, not this one.
  const { capture, state, loopback, workspaceId, rootPath } =
    await lockedRebindCapture("dohc-ydoc-fence-rename-");
  await writeFile(join(rootPath, "note.md"), "stale pre-lock artifact\n", "utf8");
  const { session } = await openWithOneEdit(capture, "old version edit");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);

  const ensured = await loopback.sendRequest({
    id: 9_101,
    method: "versions.ensureMain",
    workspace: workspaceId,
    params: { workspaceId },
  });
  const main = ensured.result as { id?: string };
  const created = await loopback.sendRequest({
    id: 9_102,
    method: "versions.createNamed",
    workspace: workspaceId,
    params: {
      workspaceId,
      name: "fence-rename-target",
      fromVersionId: main.id ?? "main",
    },
    idempotencyKey: "fence-rename-create-1",
  } as Parameters<typeof loopback.sendRequest>[0]);
  const createdVersion = created.result as { id?: string };
  await loopback.sendRequest({
    id: 9_103,
    method: "versions.setActive",
    workspace: workspaceId,
    params: { workspaceId, versionId: createdVersion.id! },
  });
  state.locked = false;

  await expect
    .poll(() => state.errors.filter((context) => context.includes("close retry")), {
      timeout: 15_000,
    })
    .toHaveLength(1);

  await expect(capture.beginFileRename("note.md", "renamed.md")).rejects.toThrow(
    "dohc could not rename note.md. dohc gave up on writing note.md earlier, so its last edits never reached disk. The edits stay in the document's history. Open note.md to write them again. Then rename note.md again.",
  );
  await expect(readFile(join(rootPath, "renamed.md"), "utf8")).rejects.toThrow();
  expect(state.settledContents).toEqual([]);
  await capture.stop();
});

it("a reopen before the timer fires receives the locked debt, not silence", async () => {
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-debt-transfer-");
  const { session } = await openWithOneEdit(capture, "transferred edit");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);

  const reopened = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  expect(state.generation).toBe(2);
  state.locked = false;

  await expect.poll(() => state.settledContents, { timeout: 15_000 }).toEqual(["transferred edit"]);
  expect(state.generation).toBe(2);
  await reopened.close({ settle: false });
  await capture.stop();
});

it("a rename drains the detached locked debt before touching disk", async () => {
  // With the session gone and the timer sleeping, a rename
  // would read the stale pre-lock artifact and carry old bytes to the new
  // path, leaving the retry aimed at the moved-from file. Rename is another
  // lifecycle edge: it finds the debt in the registry and pays it first, on
  // the same chain, before reading anything from disk.
  const { capture, state, rootPath } = await lockedRebindCapture("dohc-ydoc-rename-drain-");
  await writeFile(join(rootPath, "note.md"), "stale pre-lock artifact\n", "utf8");
  const { session } = await openWithOneEdit(capture, "renamed edit");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);

  state.locked = false;
  const finish = await capture.beginFileRename("note.md", "renamed.md");
  expect(state.settledContents).toEqual(["renamed edit"]);
  expect(state.generation).toBe(2);
  await finish(true);
  await capture.stop();
});

it("a destructive delete cancels the detached locked debt instead of recreating the file", async () => {
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-delete-cancel-");
  const { session } = await openWithOneEdit(capture, "deleted edit");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);

  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");
  finishDelete(true); // the delete succeeded: the path is provably gone
  state.locked = false;

  await expect
    .poll(() => state.errors.filter((context) => context.includes("close retry")))
    .toHaveLength(1);
  await pastRetryRungs();
  expect(state.generation).toBe(1);
  expect(state.settledContents).toEqual([]);
  await capture.stop();
});

it("an external delete observed before a debt registers cancels it at the door instead of arming a resurrecting ladder", async () => {
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-late-registration-", {
    monotonic: frozenClock,
  });
  const { session } = await openWithOneEdit(capture, "would resurrect this");

  // The watcher observes the external delete before this session's own
  // close ever registers a debt.
  capture.observeFileEvents([{ path: "note.md", operation: "delete" }]);
  await capture.flush();

  state.locked = true;
  state.replicated = true;

  // The earlier delete must be remembered, or this close's own registration
  // arms a fresh, un-cancelled debt.
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);
  state.locked = false;

  expect(
    state.errorMessages.some((message) =>
      message.includes("an external delete of note.md removed the path"),
    ),
  ).toBe(true);

  await pastRetryRungs();
  expect(state.generation).toBe(1);
  expect(state.settledContents).toEqual([]);
  await capture.stop();
});

it("a recreated path's own session arms its debt normally instead of being cancelled by an earlier delete", async () => {
  // The no-debt tombstone is path-keyed, so a delete-then-recreate landing
  // inside its TTL would leave it armed for the new file too. A non-delete
  // event must not invalidate the tombstone: an old session, still
  // mid-retry-ladder when the recreation lands, could then arm a late debt
  // that settles its stale canonical doc over the new file. The
  // discriminator is this session's own open time against the tombstone's:
  // a session that opened after the delete (this one) was never the
  // delete's victim, so it must arm normally whether or not a recreation
  // happened. See the sibling pin for the old session, which must still
  // cancel.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-tombstone-recreate-");

  capture.observeFileEvents([{ path: "note.md", operation: "delete" }]);
  await capture.flush();
  capture.observeFileEvents([{ path: "note.md", operation: "update" }]);
  await capture.flush();

  const { session } = await openWithOneEdit(capture, "a real pending edit");
  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);

  // A stale tombstone, still armed, must not be consumed here and cancel
  // this genuine pending write instead of arming it.
  expect(
    state.errorMessages.some((message) =>
      message.includes("removed the path while a pending write waited"),
    ),
  ).toBe(false);

  state.locked = false;
  await expect
    .poll(() => state.settledContents, { timeout: 15_000 })
    .toEqual(["a real pending edit"]);
  await capture.stop();
});

it.each(["quit", "close"] as const)(
  "a failed observation drain probes deletion before %s settles live sessions",
  async (mode) => {
    const { capture, state, rootPath, workspaceId } = await lockedRebindCapture(
      "dohc-file-feed-failed-drain-",
    );
    await writeFile(join(rootPath, "note.md"), "Original.");
    const activityState = new WorkspaceActivityState();
    const workspace = {
      workspaceId,
      rootPath,
      attachmentId: Symbol("failed-drain"),
      kind: "personal" as const,
      mode: "local-first" as const,
    };
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => ({ shareView: false, capture }),
      observationFor: () => ({
        ...idleObservation(workspace, {} as never),
        stop: async () => {
          throw new Error("drain unavailable");
        },
      }),
    });
    await activity.open(workspace, activityState);
    const { session } = await openWithOneEdit(capture, "must stay deleted");
    state.locked = true;
    await expect(session.close()).rejects.toThrow("file-locked");
    await rm(join(rootPath, "note.md"));
    state.locked = false;
    if (mode === "quit") {
      await settleYDocsAfterFileObservation([activity.drainObservations(activityState)], () =>
        capture.settleAndCloseAllLiveSessions(),
      );
      await capture.stop();
    } else {
      await expect(activity.close(workspace, activityState)).rejects.toThrow("drain unavailable");
    }
    expect(state.settledContents).toEqual([]);
    await expect(readFile(join(rootPath, "note.md"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("a suppressed retry's dirty-session refusal discharges through evict instead of wedging the lease", async () => {
  // Forcing `settleOnRefusal: false` on a suppressed
  // retry (the test above) can meet a daemon that refuses the
  // non-settling release because the session still holds unsettled state —
  // `ydoc-unsettled-close` — and that refusal is terminal, not transient
  // (`isTransientEngineRefusal` names only file-locked and
  // engine-store-busy). Left as a plain rethrow, `scheduleTransientCloseRetry`
  // never re-arms, and the live entry stays registered with the daemon's
  // lease held — every later open of the path refuses busy until restart.
  // The evict discharge the orphan path already uses on this exact refusal
  // must cover the suppressed-and-refused shape too: nothing is lost (the
  // durable lineage survives an evict), and nothing is stranded.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-close-retry-unsettled-discharge-",
  );
  const { session } = await openWithOneEdit(capture, "must not wedge the lease");

  state.locked = true;
  await expect(session.close()).rejects.toThrow("file-locked");

  capture.observeFileEvents([{ path: "note.md", operation: "delete" }]);
  await capture.flush();

  // The lock clears, but the RELEASE itself now refuses hard: the daemon
  // will not drop a dirty session without settling it.
  state.locked = false;
  state.closeFailure = new DaemonRefusalError(
    { code: "INVALID_PARAMS", message: "ydoc-unsettled-close", retry: "no" },
    new Error("daemon response"),
  );

  // A non-orphaned entry must evict too, or the terminal refusal stops the
  // ladder with the lease still held.
  await expect.poll(() => state.evicts, { timeout: 15_000 }).toBe(1);
  expect(state.settledContents).toEqual([]);

  // No busy-wedge: a fresh open of the same path succeeds outright. Clear
  // the persistent release refusal first — it was this session's own
  // refusal, not a standing property of the path.
  state.closeFailure = null;
  const reopened = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  expect(reopened).toBeTruthy();
  await reopened.close({ settle: false });
  await capture.stop();
});

it("a delete delivered while the capture chain is busy still suppresses a retry that fires before the chain drains", async () => {
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-close-retry-chain-busy-", {
    teardownRetryMs: { initial: 300, cap: 300 },
  });
  const { session } = await openWithOneEdit(capture, "would resurrect via chain race");

  state.locked = true;
  await expect(session.close()).rejects.toThrow("file-locked");
  // Nothing blocks the retry's own settle technically — only the tombstone
  // (once it is visible) should stop it.
  state.locked = false;

  let releaseOpen!: () => void;
  state.openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const attemptsBeforePark = state.openAttempts;
  const parked = capture.openYDocSession({
    path: "other.md",
    onRemoteUpdate: () => undefined,
  });
  await expect
    .poll(() => state.openAttempts, { timeout: 15_000 })
    .toBeGreaterThan(attemptsBeforePark);

  // The watcher delivers the delete while the chain is still stuck inside
  // the parked open — deliberately no `await capture.flush()` here.
  capture.observeFileEvents([{ path: "note.md", operation: "delete" }]);

  // The enqueued cleanup is still queued behind the parked open. If it were
  // the only place recording the tombstone, the retry (which fires here,
  // off-chain) would find nothing and resettle the doc onto the path the
  // user just deleted. The retry's own stand-down trace is the signal that
  // it fired and met the tombstone.
  await expect
    .poll(() =>
      state.errorMessages.some((message) =>
        message.includes("an external delete of note.md removed the path"),
      ),
    )
    .toBe(true);
  expect(state.settledContents).toEqual([]);

  releaseOpen();
  await (await parked).close({ settle: false });
  await capture.stop();
});

it("a recreated path's fresh close-retry ladder still settles normally despite an earlier delete", async () => {
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-close-retry-recreate-");

  capture.observeFileEvents([{ path: "note.md", operation: "delete" }]);
  await capture.flush();
  capture.observeFileEvents([{ path: "note.md", operation: "update" }]);
  await capture.flush();

  const { session } = await openWithOneEdit(capture, "a real pending edit");
  state.locked = true;
  await expect(session.close()).rejects.toThrow("file-locked");

  state.locked = false;
  await expect
    .poll(() => state.settledContents, { timeout: 15_000 })
    .toEqual(["a real pending edit"]);
  await capture.stop();
});

it("a delete refuses the open that could register a debt while disk work is in flight", async () => {
  // A debt cannot register after the delete's suspension snapshot: a new
  // live open cannot enter the removal window at all. Keep the pre-window
  // debt here so the successful finisher still proves the delete cancels it.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-delete-race-");
  const first = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, first.initialUpdate);
  const before = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(0, "first edit");
  await first.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));

  state.locked = true;
  state.replicated = true;
  await expect(first.close()).rejects.toThrow(/released, but its pre-close settle failed/);

  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");

  // The former second debt is refused before the daemon opens a generation.
  const generationAtDelete = state.generation;
  await expectRemovalOpenRefused(capture, "note.md", "dohc is still deleting note.md.");

  finishDelete(true);
  state.locked = false;

  await pastRetryRungs();
  expect(state.generation).toBe(generationAtDelete);
  expect(state.settledContents).toEqual([]);
  expect(state.errors.filter((context) => context.includes("close retry"))).toHaveLength(1);
  await capture.stop();
});

it("a failed delete restores the detached locked debt instead of cancelling it", async () => {
  // The same no-delete-share handle that blocks the write can
  // block the OS trash and the workspace-trash fallback. Cancelling on the
  // attempt would strand the promised write forever over a file that is
  // still there. The finisher takes the outcome: a failed delete restores
  // and re-arms, so the release still lands the write.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-delete-failed-");
  const { session } = await openWithOneEdit(capture, "survives a failed delete");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);

  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");
  finishDelete(false);
  state.locked = false;

  await expect
    .poll(() => state.settledContents, { timeout: 15_000 })
    .toEqual(["survives a failed delete"]);
  await capture.stop();
});

it("a rename refuses while its debt payment is still locked", async () => {
  // The payment resolves when it merely re-armed against a
  // still-held lock. Proceeding would read the stale pre-lock artifact and
  // commit it through writeIfChanged — replacing the canonical Y.Doc head
  // with pre-lock text, which the finisher's path rollback cannot undo. The
  // registry is the proof: still named means it did not land, so the rename
  // refuses and the debt stays.
  const { capture, state, rootPath } = await lockedRebindCapture("dohc-ydoc-rename-locked-");
  await writeFile(join(rootPath, "note.md"), "stale pre-lock artifact\n", "utf8");
  const { session } = await openWithOneEdit(capture, "must not be lost");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);

  await expect(capture.beginFileRename("note.md", "renamed.md")).rejects.toThrow(
    /Another program still has note\.md open/,
  );
  expect(state.settledContents).toEqual([]);

  state.locked = false;
  await expect.poll(() => state.settledContents, { timeout: 15_000 }).toEqual(["must not be lost"]);
  await capture.stop();
});

it("a folder move settles and closes a live child session before opening its window", async () => {
  // The move seam's vacate is prefix-based, like the delete seam's. Vacating
  // only the exact fromPath/toPath would let a live Y.Doc session on a
  // folder's child survive into the open window, and its later settle (a
  // reopen's flush, a daemon-armed debounced settle) could materialize the
  // moved-away child path mid-move.
  //
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-foldermove-child-vacate-",
  );
  await mkdir(join(rootPath, "dir"), { recursive: true });
  await writeFile(join(rootPath, "dir", "note.md"), "stale artifact\n", "utf8");
  const { session } = await openWithOneEdit(
    capture,
    "child settles before the window opens",
    "dir/note.md",
  );

  const finishMove = await capture.beginFileRename("dir", "moved");
  // GREEN proof 1: the child's edit landed through the move's own vacate
  // settle, before the window ever opened — not through some later,
  // racing settle.
  expect(state.settledContents).toEqual(["child settles before the window opens"]);
  // GREEN proof 2: the session is already gone, so closing it again is a
  // harmless no-op instead of a fresh settle racing the window.
  const settlesAtClose = state.settleCalls.length;
  await session.close();
  expect(state.settleCalls).toHaveLength(settlesAtClose);

  // Refusal side, on the settle door itself: a stray settle on the same
  // handle — the shape a straggling debounced timer would produce — still
  // meets the removal window and refuses there, independent of the vacate
  // above.
  //
  const settleRefusal = await session.settleNow().then(
    () => null,
    (error: unknown) => error,
  );
  expect(
    settleRefusal,
    "drop the removal-window check from the settle door (capture.ts ~2137-2145) -> this settle reaches the daemon instead of refusing.",
  ).toMatchObject({
    name: "YDocRemovalInProgressError",
    code: "removal-in-progress",
    workspacePath: "dir/note.md",
    operation: "settle",
    removalOperation: "move",
  });
  expect((settleRefusal as Error).message).toBe(
    "dohc could not save dir/note.md. dohc is still moving dir. Wait for that to finish. Then save again.",
  );

  // Refusal side, on the open door: the window still covers the child by
  // prefix, so a reopen cannot slip in and recreate the very race the
  // vacate just closed off.
  await expectRemovalOpenRefused(capture, "dir/note.md", "dohc is still moving dir.");

  await finishMove(true);
  await capture.stop();
});

it("a failed move holds its window across the rollback, not just up to it", async () => {
  // The interval stays open until engine rollback completes. An open is
  // refused while that interval stands and succeeds only after the failed
  // move has rolled back.
  //
  // Two mutations, one per assertion:
  //   - close the window before rollback -> the queued open enters the gap.
  //   - never close it -> the open after rollback is still refused.
  const { capture, state, rootPath } = await lockedRebindCapture("dohc-ydoc-move-rollback-gap-");
  await writeFile(join(rootPath, "note.md"), "stale artifact\n", "utf8");

  // An engine-coordinated rename, so a rollback exists at all.
  const finishMove = await capture.beginFileRename("note.md", "moved.md");

  // Hold the capture chain, queue the source open, then queue rollback behind
  // it. If the finisher closes the window before enqueueing rollback, this
  // open lands against the mid-move engine identity.
  let releaseOpen!: () => void;
  state.openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const attemptsBeforePark = state.openAttempts;
  const parked = capture.openYDocSession({
    path: "other.md",
    onRemoteUpdate: () => undefined,
  });
  await expect
    .poll(() => state.openAttempts, { timeout: 15_000 })
    .toBeGreaterThan(attemptsBeforePark);
  const racedOpen = capture
    .openYDocSession({ path: "note.md", onRemoteUpdate: () => undefined })
    .then(
      () => null,
      (error: unknown) => error,
    );
  const finishing = finishMove(false);
  releaseOpen();

  expect(await racedOpen).toMatchObject({
    name: "YDocRemovalInProgressError",
    code: "removal-in-progress",
    workspacePath: "note.md",
  });
  await finishing;
  expect(state.settledContents).toEqual([]);
  const reopened = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  await reopened.close({ settle: false });
  await (await parked).close({ settle: false });
  await capture.stop();
});

it("a folder move fences late live opens on the no-op finisher path", async () => {
  // `beginFileRename` returns a NO-OP finisher for everything the engine
  // rename declines — folders, binary, untracked paths — but the disk move
  // still happens, so a late live session could recreate the moved-from tree.
  // The test above covers the engine-rename finisher. Mutating only the
  // no-op finisher leaves that test green, so this one covers the no-op path.
  //
  const { capture, state, rootPath } = await lockedRebindCapture("dohc-ydoc-foldermove-race-");
  await mkdir(join(rootPath, "dir"), { recursive: true });
  await writeFile(join(rootPath, "dir", "note.md"), "stale artifact\n", "utf8");

  const finishMove = await capture.beginFileRename("dir", "moved");
  const generationAtMove = state.generation;
  await expectRemovalOpenRefused(capture, "dir/note.md", "dohc is still moving dir.");

  await finishMove(true);

  await pastRetryRungs();
  expect(state.generation).toBe(generationAtMove);
  expect(state.settledContents).toEqual([]);
  await capture.stop();
});

it("refused renames never stack more than one retry ladder", async () => {
  const { capture, state, rootPath } = await lockedRebindCapture("dohc-ydoc-one-timer-", {
    teardownRetryMs: { initial: 1_000, cap: 10_000 },
  });
  await writeFile(join(rootPath, "note.md"), "stale artifact\n", "utf8");
  const { session } = await openWithOneEdit(capture, "one ladder only");

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const advanceAndDrain = async (durationMs: number) => {
    for (let elapsed = 0; elapsed < durationMs; elapsed += 1_000) {
      await vi.advanceTimersByTimeAsync(Math.min(1_000, durationMs - elapsed));
      // Timer callbacks enqueue capture work that can await real filesystem I/O.
      await capture.flush();
    }
  };
  try {
    state.locked = true;
    state.replicated = true;
    await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(capture.beginFileRename("note.md", "renamed.md")).rejects.toThrow(
        /Another program still has note\.md open/,
      );
    }
    const settlesAfterRenames = state.settleCalls.length;

    // Stacked ladders wake at 1 s, 2 s, and 4 s. One replacement timer
    // waits beyond this window, so the original generous count bound still applies.
    await advanceAndDrain(4_000);
    const attemptsWhileLocked = state.settleCalls.length - settlesAfterRenames;
    expect(attemptsWhileLocked).toBeLessThanOrEqual(1);

    // Keep the original recovery budget, then observe two more seconds for duplicates.
    state.locked = false;
    for (
      let elapsed = 0;
      elapsed < 15_000 && state.settledContents.length === 0;
      elapsed += 1_000
    ) {
      await advanceAndDrain(1_000);
    }
    expect(state.settledContents).toEqual(["one ladder only"]);
    await advanceAndDrain(2_000);
    expect(state.settledContents).toEqual(["one ladder only"]);
  } finally {
    try {
      await capture.stop();
    } finally {
      vi.useRealTimers();
    }
  }
}, 30_000);

it("a failing active-version read re-arms instead of stranding the debt", async () => {
  const { capture, state, loopback } = await lockedRebindCapture("dohc-ydoc-version-read-fails-");
  const { session } = await openWithOneEdit(capture, "survives a failed read");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);

  const realSend = loopback.sendRequest.bind(loopback);
  let failVersionReads = true;
  loopback.sendRequest = async (request) => {
    if (failVersionReads && request.method === "versions.active") {
      throw new Error("version read unavailable");
    }
    return await realSend(request);
  };
  state.locked = false;

  await expect
    .poll(() => state.errors.filter((context) => context.includes("close retry")), {
      timeout: 15_000,
    })
    .not.toHaveLength(0);
  failVersionReads = false;
  await expect
    .poll(() => state.settledContents, { timeout: 15_000 })
    .toEqual(["survives a failed read"]);
  await capture.stop();
}, 30_000);

it("cancelling a debt releases the session whose close was refused", async () => {
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-discard-lease-");
  const { session } = await openWithOneEdit(capture, "leased edit");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);

  // The retry opens a session and its RELEASE is refused: the debt now holds
  // the only session that can free the lease.
  state.locked = false;
  state.closeFailure = new Error("ydoc-unsettled-close");
  // Wait for the retry's own release to be refused — generation 2's close,
  // not the original session's, which already ran above.
  await expect
    .poll(() => state.closeCalls.filter((generation) => generation === 2).length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  const releasesBeforeCancel = state.closesWithSettleFalse;

  state.closeFailure = null;
  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");
  finishDelete(true);
  await expect
    .poll(() => state.closesWithSettleFalse, { timeout: 15_000 })
    .toBeGreaterThan(releasesBeforeCancel);
  await capture.stop();
}, 30_000);

it("a cancelled debt whose release is refused keeps retrying that release", async () => {
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-lease-owner-");
  const { session } = await openWithOneEdit(capture, "leased twice");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);

  // The retry settles, a peer update outruns it, and the release is refused.
  // The debt now holds the only session that can free the lease and still
  // owes a write — the state where cancelling has both things to get right.
  state.locked = false;
  state.emitUpdateAfterSettle = true;
  state.closeFailure = new Error("ydoc-unsettled-close");
  await expect
    .poll(() => state.closeCalls.filter((generation) => generation === 2).length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  const releasesBeforeCancel = state.closesWithSettleFalse;
  const generationBeforeCancel = state.generation;
  const settlesBeforeCancel = state.settledContents.length;

  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");
  finishDelete(true);
  await expect
    .poll(() => state.errors.filter((c) => c.includes("close retry")), {
      timeout: 15_000,
    })
    .not.toHaveLength(0);

  // The daemon accepts the release at last. Nothing is left to retry it if
  // the discard dropped the session, so this is the whole proof of the
  // handback.
  state.closeFailure = null;
  await expect
    .poll(() => state.closesWithSettleFalse, { timeout: 20_000 })
    .toBeGreaterThan(releasesBeforeCancel);

  // And the cancelled write stays cancelled. The debt still looks unpaid —
  // that peer update never reached Markdown — so a debt that only knew how
  // to chase the write would reopen the DELETED path and settle the file
  // back into existence.
  //
  // The release itself is the subtler half.
  // `settle: false` does not promise the file is left alone: the provider
  // escalates a refused release to a settling close to preserve pending
  // edits, and that close materializes. A cancelled debt must therefore
  // release with `settleOnRefusal: false`. This assertion is what catches
  // it — but only since the fake models the escalation; before that it
  // passed while the real provider recreated the file.
  // Long enough for two more rungs of the ladder.
  await pastRetryRungs();
  expect(state.generation).toBe(generationBeforeCancel);
  expect(state.settledContents).toHaveLength(settlesBeforeCancel);
  await capture.stop();
}, 60_000);

it("a settle the engine refuses for good stops the ladder and says why", async () => {
  // The external program edited the file before releasing its
  // lock, so the pending job's preimage no longer matches and the engine
  // refuses conflict-stale-target forever. The unconditional re-arm polled
  // that permanent refusal every 10 seconds, reopening a session each time,
  // and never told the user the one thing they could act on.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-terminal-conflict-");
  const { session } = await openWithOneEdit(capture, "conflicting edit");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);

  state.locked = false;
  state.settleFailure = new DaemonRefusalError(
    { code: "INVALID_PARAMS", message: "conflict-stale-target", retry: "no" },
    new Error("daemon response"),
  );
  await expect
    .poll(() => state.errorMessages.filter((message) => message.includes("changed outside dohc")), {
      timeout: 15_000,
    })
    .not.toHaveLength(0);
  const [stopMessage] = state.errorMessages.filter((message) =>
    message.includes("changed outside dohc"),
  );
  expect(stopMessage).toContain("note.md");
  expect(stopMessage).toContain("history");

  // The liveness proof: the ladder is done. Left armed, the 2s and 4s rungs
  // both wake inside this window and reopen a session for the same
  // permanent refusal.
  const settlesAtStandDown = state.settleCalls.length;
  const generationAtStandDown = state.generation;
  await pastRetryRungs();
  expect(state.settleCalls.length).toBe(settlesAtStandDown);
  expect(state.generation).toBe(generationAtStandDown);
  await capture.stop();
}, 40_000);

it("a settle that committed but wrote nothing stops the ladder and names the symlink", async () => {
  // A settle resolving is the adjacent operation, not the write: the
  // engine commits the lineage and answers materialized: false for a target it
  // declines to write, so the call comes back clean while the .md stays
  // stale, and the debt is not discharged there.
  //
  // `materialized: false`
  // has exactly one producer: `JobOutcome::Blocked` <-
  // `MaterializeError::SymlinkTarget` (crates/dohc-engine-files/src/
  // materialize.rs) — the path or an ancestor is a symlink. Waiting restores
  // no containment, so re-arming polls a condition that cannot clear and tells
  // the user nothing they can act on.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-unmaterialized-");
  const { session } = await openWithOneEdit(capture, "never written");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);

  // The lock releases, but the target became unsafe: every settle now
  // commits and writes nothing.
  state.locked = false;
  state.unmaterialized = true;
  await expect
    .poll(() => state.errorMessages.filter((message) => message.includes("symlink")), {
      timeout: 15_000,
    })
    .not.toHaveLength(0);
  const [stopMessage] = state.errorMessages.filter((message) => message.includes("symlink"));
  expect(stopMessage).toContain("note.md");
  expect(stopMessage).toContain("did not write");
  expect(stopMessage).toContain("history");
  // Both components, because the engine names neither. `materialized: false`
  // is the answer whether the symlink is the target FILE or a folder above it
  // (prepare_target_parent_symlink_free checks the ancestors and the leaf).
  // An instruction that says only "folder" tells a user whose note.md IS the
  // symlink to replace it with a directory, which can never materialize.
  expect(stopMessage).toContain("real file");
  expect(stopMessage).toContain("real folder");

  expect(state.settledContents).toHaveLength(0);

  // The liveness proof: the ladder is done. Left armed, its next two rungs
  // both wake inside this window and reopen a session for the same
  // permanent condition.
  const settlesAtStandDown = state.settleCalls.length;
  const generationAtStandDown = state.generation;
  await pastRetryRungs();
  expect(state.settleCalls.length).toBe(settlesAtStandDown);
  expect(state.generation).toBe(generationAtStandDown);
  await capture.stop();
}, 40_000);

it("a materialized settle after reopening a stood-down path clears the marker and re-enables the rename", async () => {
  // Only proof clears the marker: a
  // settle the engine reports as materialized, which is the moment "its
  // last edit reached disk" becomes true. This is the recovery every
  // stand-down message already prescribes ("open it to write it again"),
  // finished all the way through to a real save instead of stopping at
  // the open.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-standdown-settle-clears-",
  );
  await writeFile(join(rootPath, "note.md"), "stale pre-lock artifact\n", "utf8");
  const { session } = await openWithOneEdit(capture, "never written");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);

  state.locked = false;
  state.unmaterialized = true;
  await expect
    .poll(() => state.errorMessages.filter((message) => message.includes("symlink")), {
      timeout: 15_000,
    })
    .not.toHaveLength(0);

  state.unmaterialized = false;
  const reopened = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const mirror = new Y.Doc();
  Y.applyUpdate(mirror, reopened.initialUpdate);
  const before = Y.encodeStateVector(mirror);
  mirror.getText("plainText").insert(0, "recovered edit");
  await reopened.applyLocalUpdate(Y.encodeStateAsUpdate(mirror, before));
  await reopened.settleNow();
  // Anti-vacuity: this settle is what cleared it, not some unrelated path.
  // (The doc carries the journaled "never written" text too — the recovery
  // session's seed, per the fake's own replay of durable state.)
  expect(state.settledContents.some((text) => text.includes("recovered edit"))).toBe(true);

  const finish = await capture.beginFileRename("note.md", "renamed.md");
  await finish(true);
  await reopened.close({ settle: false });
  await capture.stop();
});

it("a materialization the engine refuses for good stops the ladder and says why", async () => {
  // A locked file that turns read-only stops answering
  // file-locked and answers a terminal materialization failure instead. The
  // conflict-only stop let that re-arm every ten seconds forever. The class
  // is "the wire said do not retry", not "the failure was a conflict".
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-terminal-io-");
  const { session } = await openWithOneEdit(capture, "unwritable target");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);

  state.locked = false;
  state.settleFailure = new DaemonRefusalError(
    { code: "INTERNAL", message: "workspace operation failed", retry: "no" },
    new Error("daemon response"),
  );
  await expect
    .poll(() => state.errorMessages.filter((message) => message.includes("cannot write")), {
      timeout: 15_000,
    })
    .not.toHaveLength(0);
  const [stopMessage] = state.errorMessages.filter((message) => message.includes("cannot write"));
  expect(stopMessage).toContain("note.md");
  expect(stopMessage).toContain("workspace operation failed");
  expect(stopMessage).toContain("history");

  const settlesAtStandDown = state.settleCalls.length;
  const generationAtStandDown = state.generation;
  await pastRetryRungs();
  expect(state.settleCalls.length).toBe(settlesAtStandDown);
  expect(state.generation).toBe(generationAtStandDown);
  await capture.stop();
}, 40_000);

it("a release the daemon refuses terminally still keeps the write ladder alive", async () => {
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-terminal-release-");
  const { session } = await openWithOneEdit(capture, "release refused hard");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(/released, but its pre-close settle failed/);

  state.locked = false;
  state.emitUpdateAfterSettle = true;
  state.closeFailure = new DaemonRefusalError(
    { code: "INVALID_PARAMS", message: "ydoc-unsettled-close", retry: "no" },
    new Error("daemon response"),
  );
  await expect
    .poll(() => state.closeCalls.filter((generation) => generation === 2).length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);

  const closesAtRefusal = state.closeCalls.length;
  const generationAtRefusal = state.generation;
  await expect
    .poll(() => state.closeCalls.length, { timeout: 20_000 })
    .toBeGreaterThan(closesAtRefusal);
  expect(state.generation).toBe(generationAtRefusal);

  // The proof the write survived the release's refusal: once the daemon
  // accepts the release, the debt is still owed, so a fresh session opens
  // and settles the state that peer update left behind. Read as an answer
  // about the write, the debt would have been cancelled and this generation
  // would never exist.
  state.closeFailure = null;
  await expect
    .poll(() => state.generation, { timeout: 25_000 })
    .toBeGreaterThan(generationAtRefusal);
  await capture.stop();
}, 60_000);

it("checkpoints outage typing before quit and flushes edits queued behind reconnect without daemon calls", async () => {
  const { rootPath, sessions, openProvider, state } = await daemonDeathCapture(
    "outage-checkpoint-",
    "outage-checkpoint",
  );
  const directory = join(rootPath, "recovery");
  const writes = vi.fn((checkpoint) => writeTypingCheckpoint(directory, checkpoint));
  const capture = createWorkspaceEngineCapture({
    workspaceId: "outage-checkpoint",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: async (options) => ({
      ...(await openProvider(options)),
      objectId: "object",
      versionId: "main",
    }),
    onError: () => undefined,
    writeTypingCheckpoint: writes,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const renderer = new Y.Doc();
  Y.applyUpdate(renderer, session.initialUpdate);
  typeInto(renderer, session, "base ");
  await session.settleNow();
  state.daemonAlive = false;
  typeInto(renderer, session, "OUTAGE_ONE");
  await expect(session.settleNow()).rejects.toThrow(/closed/i);
  await expect.poll(() => writes.mock.calls.length).toBeGreaterThan(0);
  typeInto(renderer, session, " OUTAGE_TWO");
  typeInto(renderer, session, " OUTAGE_THREE");
  await flushTypingCheckpoints("outage-checkpoint");
  const saved = (await readTypingCheckpoints(directory, "outage-checkpoint"))[0]!.checkpoint;
  expect(saved.text).toBe("base OUTAGE_ONE OUTAGE_TWO OUTAGE_THREE");
  expect(saved.updates).toHaveLength(3);
  expect(new Set(saved.updates.map((u) => u.requestId)).size).toBe(3);
  expect(state.generation).toBe(1);
  await session.close({ shuttingDown: true });
  expect((await readTypingCheckpoints(directory, "outage-checkpoint"))[0]!.checkpoint.text).toBe(
    saved.text,
  );
  state.daemonAlive = true;
  await capture.stop();
  renderer.destroy();
});

it("upgrades a renderer close started before the outage checkpoint existed", async () => {
  const { rootPath, sessions, openProvider, state } = await daemonDeathCapture(
    "outage-late-close-",
    "outage-late-close",
  );
  const directory = join(rootPath, "recovery");
  const writes = vi.fn((checkpoint) => writeTypingCheckpoint(directory, checkpoint));
  let closeStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    closeStarted = resolve;
  });
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  let notifyDeath!: (error: unknown) => void;
  const capture = createWorkspaceEngineCapture({
    workspaceId: "outage-late-close",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: async (options) => {
      notifyDeath = options.onSessionError!;
      const provider = await openProvider(options);
      return {
        ...provider,
        objectId: "object",
        versionId: "main",
        close: async (closeOptions) => {
          closeStarted();
          await closeGate;
          await provider.close(closeOptions);
        },
      };
    },
    onError: () => undefined,
    writeTypingCheckpoint: writes,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const renderer = new Y.Doc();
  Y.applyUpdate(renderer, session.initialUpdate);
  typeInto(renderer, session, "base ");
  await session.settleNow();
  expect(writes).not.toHaveBeenCalled();
  const closing = session.close();
  await started;
  state.daemonAlive = false;
  typeInto(renderer, session, "OUTAGE_LATE_CLOSE");
  notifyDeath(
    Object.assign(new Error("The engine client is closed: transport closed."), {
      code: "transport-error",
    }),
  );
  await expect.poll(() => writes.mock.calls.length).toBeGreaterThan(0);
  capture.beginShutdown();
  await closing;
  expect(
    (await readTypingCheckpoints(directory, "outage-late-close"))[0]!.checkpoint.text,
  ).toContain("OUTAGE_LATE_CLOSE");
  releaseClose();
  state.daemonAlive = true;
  await capture.stop();
  renderer.destroy();
});

it("retires already admitted typing without losing later outage edits", async () => {
  const workspaceId = "outage-admitted-retirement";
  const { rootPath, sessions, openProvider, state } = await daemonDeathCapture(
    "outage-admitted-retirement-",
    workspaceId,
  );
  const directory = join(rootPath, "recovery");
  let notifyDeath!: (error: unknown) => void;
  const capture = createWorkspaceEngineCapture({
    workspaceId,
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: async (options) => {
      notifyDeath = options.onSessionError!;
      return { ...(await openProvider(options)), objectId: "object", versionId: "main" };
    },
    onError: () => undefined,
    writeTypingCheckpoint: (checkpoint) => writeTypingCheckpoint(directory, checkpoint),
    retireTypingCheckpoint: async (checkpoint) => {
      for (const row of await readTypingCheckpoints(directory, workspaceId)) {
        if (row.content === JSON.stringify(checkpoint)) await retireTypingCheckpoint(row);
      }
    },
  });
  const renderer = new Y.Doc();
  onTestFinished(async () => {
    state.daemonAlive = true;
    await capture.stop();
    renderer.destroy();
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  Y.applyUpdate(renderer, session.initialUpdate);
  typeInto(renderer, session, "admitted ");
  await session.settleNow();
  const admittedCount = state.durableUpdates.length;
  state.daemonAlive = false;
  notifyDeath(
    Object.assign(new Error("The engine client is closed: transport closed."), {
      code: "transport-error",
    }),
  );
  await flushTypingCheckpoints(workspaceId);
  expect(state.durableUpdates).toHaveLength(admittedCount);
  expect(await readTypingCheckpoints(directory, workspaceId)).toEqual([]);
  typeInto(renderer, session, "LATER_OUTAGE");
  await flushTypingCheckpoints(workspaceId);
  expect((await readTypingCheckpoints(directory, workspaceId))[0]!.checkpoint.text).toBe(
    "admitted LATER_OUTAGE",
  );
  state.daemonAlive = true;
  await session.settleNow();
  await flushTypingCheckpoints(workspaceId);
  expect(state.generation).toBe(2);
  expect(state.diskMarkdown).toBe("admitted LATER_OUTAGE");
  expect(await readTypingCheckpoints(directory, workspaceId)).toEqual([]);
});

it("warns before quit when drawing edits cannot enter a text checkpoint", async () => {
  const workspaceId = "scene-outage-warning";
  const { rootPath, sessions, openProvider, state } = await daemonDeathCapture(
    "scene-outage-warning-",
    workspaceId,
  );
  const failure = vi.fn();
  const capture = createWorkspaceEngineCapture({
    workspaceId,
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: async (options) => ({
      ...(await openProvider(options)),
      contentKind: "scene" as const,
      objectId: "scene",
      versionId: "main",
    }),
    onError: () => {},
    writeTypingCheckpoint: async () => {},
    onTypingCheckpointFailure: failure,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    contentKind: "scene",
    onRemoteUpdate: () => {},
  });
  const renderer = new Y.Doc();
  Y.applyUpdate(renderer, session.initialUpdate);
  onTestFinished(async () => {
    state.daemonAlive = true;
    await capture.stop();
    renderer.destroy();
  });
  state.daemonAlive = false;
  typeInto(renderer, session, "DRAWING_OUTAGE");
  await expect(session.settleNow()).rejects.toThrow();
  await expect(flushTypingCheckpoints(workspaceId)).rejects.toThrow(
    "dohc cannot keep drawing changes while it reconnects.",
  );
  expect(failure).toHaveBeenCalledWith("note.md", expect.any(Error));
});

it("retires the final synchronous checkpoint after an aborted OS session end", async () => {
  const workspaceId = "outage-aborted-os-end";
  const { rootPath, sessions, openProvider, state } = await daemonDeathCapture(
    "outage-aborted-os-end-",
    workspaceId,
  );
  const directory = join(rootPath, "recovery");
  let notifyDeath!: (error: unknown) => void;
  let entered!: () => void;
  const writing = new Promise<void>((r) => {
    entered = r;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let held = false;
  const capture = createWorkspaceEngineCapture({
    workspaceId,
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: async (options) => {
      notifyDeath = options.onSessionError!;
      return { ...(await openProvider(options)), objectId: "object", versionId: "main" };
    },
    onError: () => {},
    writeTypingCheckpoint: async (checkpoint) => {
      const write = writeTypingCheckpoint(directory, checkpoint);
      if (held) {
        held = false;
        entered();
        await gate;
      }
      await write;
    },
    writeTypingCheckpointSync: (checkpoint) => writeTypingCheckpointSync(directory, checkpoint),
    retireTypingCheckpoint: async (checkpoint) => {
      for (const row of await readTypingCheckpoints(directory, workspaceId))
        if (row.content === JSON.stringify(checkpoint)) await retireTypingCheckpoint(row);
    },
  });
  const renderer = new Y.Doc();
  onTestFinished(async () => {
    release();
    state.daemonAlive = true;
    await capture.stop();
    renderer.destroy();
  });
  const session = await capture.openYDocSession({ path: "note.md", onRemoteUpdate: () => {} });
  Y.applyUpdate(renderer, session.initialUpdate);
  state.daemonAlive = false;
  notifyDeath(
    Object.assign(Error("The engine client is closed: transport closed."), {
      code: "transport-error",
    }),
  );
  await flushTypingCheckpoints(workspaceId);
  typeInto(renderer, session, "BEFORE_END ");
  held = true;
  const pending = flushTypingCheckpoints(workspaceId);
  await writing;
  typeInto(renderer, session, "QUEUED_OLDER ");
  const queued = flushTypingCheckpoints(workspaceId);
  typeInto(renderer, session, "FINAL_OS_TYPING");
  flushTypingCheckpointsSync(workspaceId);
  release();
  await pending;
  await queued;
  expect((await readTypingCheckpoints(directory, workspaceId))[0]!.checkpoint.text).toContain(
    "FINAL_OS_TYPING",
  );
  state.daemonAlive = true;
  await session.settleNow();
  await flushTypingCheckpoints(workspaceId);
  expect(state.diskMarkdown).toContain("FINAL_OS_TYPING");
  expect(await readTypingCheckpoints(directory, workspaceId)).toEqual([]);
});

it("combines queued checkpoint flushes and waits for the newest disk write", async () => {
  const workspaceId = "outage-queued-flush";
  const { rootPath, sessions, openProvider, state } = await daemonDeathCapture(
    "outage-queued-flush-",
    workspaceId,
  );
  const directory = join(rootPath, "recovery");
  let notifyDeath!: (error: unknown) => void;
  const first = Promise.withResolvers<void>();
  const firstEntered = Promise.withResolvers<void>();
  const older = Promise.withResolvers<void>();
  const newer = Promise.withResolvers<void>();
  const olderEntered = Promise.withResolvers<"older">();
  const newerEntered = Promise.withResolvers<"newer">();
  let writes = 0;
  const capture = createWorkspaceEngineCapture({
    workspaceId,
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: async (options) => {
      notifyDeath = options.onSessionError!;
      return { ...(await openProvider(options)), objectId: "object", versionId: "main" };
    },
    onError: () => {},
    writeTypingCheckpoint: async (checkpoint) => {
      writes += 1;
      if (writes === 1) {
        firstEntered.resolve();
        await first.promise;
      } else if (checkpoint.text.includes("NEWER")) {
        newerEntered.resolve("newer");
        await newer.promise;
      } else if (checkpoint.text.includes("OLDER")) {
        olderEntered.resolve("older");
        await older.promise;
      }
      await writeTypingCheckpoint(directory, checkpoint);
    },
  });
  const renderer = new Y.Doc();
  let olderFlush = Promise.resolve();
  let newerFlush = Promise.resolve();
  onTestFinished(async () => {
    first.resolve();
    older.resolve();
    newer.resolve();
    await Promise.allSettled([olderFlush, newerFlush]);
    state.daemonAlive = true;
    await capture.stop();
    renderer.destroy();
  });
  const session = await capture.openYDocSession({ path: "note.md", onRemoteUpdate: () => {} });
  Y.applyUpdate(renderer, session.initialUpdate);
  state.daemonAlive = false;
  notifyDeath(
    Object.assign(Error("The engine client is closed: transport closed."), {
      code: "transport-error",
    }),
  );
  typeInto(renderer, session, "INITIAL ");
  const firstFlush = flushTypingCheckpoints(workspaceId);
  await firstEntered.promise;
  typeInto(renderer, session, "OLDER ");
  olderFlush = flushTypingCheckpoints(workspaceId);
  typeInto(renderer, session, "NEWER");
  newerFlush = flushTypingCheckpoints(workspaceId);
  let olderDone = false;
  void olderFlush.then(() => {
    olderDone = true;
  });
  first.resolve();
  expect(await Promise.race([olderEntered.promise, newerEntered.promise])).toBe("newer");
  expect(olderDone).toBe(false);
  expect(writes).toBe(2);
  newer.resolve();
  await firstFlush;
  await olderFlush;
  await newerFlush;
  expect((await readTypingCheckpoints(directory, workspaceId))[0]!.checkpoint.text).toContain(
    "NEWER",
  );
});

it("retires the checkpoint actually stored by A when newer B fails", async () => {
  const workspaceId = "outage-newer-write-failed";
  const { rootPath, sessions, openProvider, state } = await daemonDeathCapture(
    "outage-newer-write-failed-",
    workspaceId,
  );
  const directory = join(rootPath, "recovery");
  let notifyDeath!: (error: unknown) => void;
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const capture = createWorkspaceEngineCapture({
    workspaceId,
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: async (options) => {
      notifyDeath = options.onSessionError!;
      return { ...(await openProvider(options)), objectId: "object", versionId: "main" };
    },
    onError: () => {},
    writeTypingCheckpoint: async (checkpoint) => {
      if (checkpoint.text.includes("FAILED_B")) throw Error("disk full");
      if (checkpoint.text.includes("STORED_A")) {
        entered.resolve();
        await gate.promise;
      }
      await writeTypingCheckpoint(directory, checkpoint);
    },
    retireTypingCheckpoint: async (checkpoint) => {
      for (const row of await readTypingCheckpoints(directory, workspaceId))
        if (row.content === JSON.stringify(checkpoint)) await retireTypingCheckpoint(row);
    },
  });
  const renderer = new Y.Doc();
  onTestFinished(async () => {
    gate.resolve();
    state.daemonAlive = true;
    await capture.stop();
    renderer.destroy();
  });
  const session = await capture.openYDocSession({ path: "note.md", onRemoteUpdate: () => {} });
  Y.applyUpdate(renderer, session.initialUpdate);
  state.daemonAlive = false;
  notifyDeath(
    Object.assign(Error("The engine client is closed: transport closed."), {
      code: "transport-error",
    }),
  );
  await flushTypingCheckpoints(workspaceId);
  typeInto(renderer, session, "STORED_A ");
  const first = flushTypingCheckpoints(workspaceId);
  await entered.promise;
  typeInto(renderer, session, "FAILED_B");
  const failed = expect(flushTypingCheckpoints(workspaceId)).rejects.toThrow("disk full");
  gate.resolve();
  await first;
  await failed;
  const stored = (await readTypingCheckpoints(directory, workspaceId))[0]!.checkpoint.text;
  expect(stored).toContain("STORED_A");
  expect(stored).not.toContain("FAILED_B");
  state.daemonAlive = true;
  await session.settleNow();
  await flushTypingCheckpoints(workspaceId);
  expect(state.diskMarkdown).toContain("FAILED_B");
  expect(await readTypingCheckpoints(directory, workspaceId)).toEqual([]);
});

it("Duplicate settles the source and leaves its session and write admission intact", async () => {
  const summaries: (string | undefined)[] = [];
  const { capture, state } = await lockedRebindCapture("dohc-duplicate-live-", {
    wrapProvider: (base) => async (opts) => {
      const session = await base(opts);
      return {
        ...session,
        settleNow: async (options) => {
          summaries.push(options?.summary);
          return session.settleNow(options);
        },
      };
    },
  });
  const { session, mirror } = await openWithOneEdit(capture, "first edit");
  try {
    await capture.changePathsAs(
      ["note.md"],
      {
        operation: "duplicate",
        operationId: "dohc-operation:11111111-1111-4111-8111-111111111111",
        author: { kind: "human", humanId: "person" },
      },
      async () => {
        expect(state.closeCalls).toEqual([]);
        expect(state.settledContents).toContain("first edit");
        const before = Y.encodeStateVector(mirror);
        mirror.getText("plainText").insert(0, "still typing ");
        await session.applyLocalUpdate(Y.encodeStateAsUpdate(mirror, before));
      },
      () => [],
    );
    expect(state.closeCalls).toEqual([]);
    expect(state.generation).toBe(1);
    expect(summaries).toContain("Saved latest edits before duplicating the file");
    expect(summaries.join(" ")).not.toMatch(/moving|deleting|rename/);
  } finally {
    mirror.destroy();
    await capture.stop();
  }
});
