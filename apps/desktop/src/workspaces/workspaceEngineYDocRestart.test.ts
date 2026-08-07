import * as Y from "yjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  DaemonRefusalError,
  type EngineYdocProviderSession,
  type EngineYdocProviderSessionOptions,
  YdocReleasedWithSettleFailureError,
  VersionedLoopbackEngine,
  YdocLoopbackEngine,
  type EngineTransport,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import {
  EngineDaemonUnavailableError,
  EngineWorkspaceSessions,
  type EngineDaemonClient,
} from "@dohc/workspace-engine-client/daemon";
import {
  createWorkspaceEngineCapture,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import { createTestScratch } from "./testTemp";
import {
  createEngineYDocSaveSeqState,
  noteLocalEdit,
  noteSettleOutcome,
  noteSettleStart,
} from "./engineYDocSaveSeq";

async function reconnectFailureCapture(prefix: string) {
  const rootPath = await createTestScratch(prefix);
  const workspaceId = prefix.replace(/-+$/, "");
  const loopback = new VersionedLoopbackEngine();
  const state = {
    failBackgroundCapture: false,
    generation: 0,
    leaseActive: false,
    releaseCalls: [] as Array<{ generation: number; settle?: boolean }>,
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
      if (state.failBackgroundCapture) {
        throw new Error("background capture unavailable");
      }
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions({
    currentClient: () => daemonClient,
  });
  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    if (state.leaseActive) throw new Error("ydoc-session-busy");
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
          markdown,
          sha256: createHash("sha256").update(markdown).digest("hex"),
          materialized: true,
          projection: {
            contentKind: "plaintext",
            sourceStateVectorSha256: "a".repeat(64),
            destructive: false,
          },
        };
      },
      async applyExternalMarkdownEdit(markdown) {
        return { kind: "merged", markdown } as const;
      },
      async close(closeOptions) {
        state.releaseCalls.push({
          generation: openedGeneration,
          ...(closeOptions?.settle !== undefined
            ? { settle: closeOptions.settle }
            : {}),
        });
        state.leaseActive = false;
      },
    };
  };
  const outcomes: boolean[] = [];
  const capture = createWorkspaceEngineCapture({
    workspaceId,
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onCaptureOutcome: ({ ok }) => outcomes.push(ok),
    onError: () => undefined,
  });
  return { capture, outcomes, rootPath, state };
}

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

it("retains a reconnect-failed generation when replacement open is refused", async () => {
  const { capture, state } = await reconnectFailureCapture(
    "dohc-ydoc-reconnect-busy-",
  );
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });

  await failRendererUpdate(session);
  expect(state.leaseActive).toBe(true);
  expect(state.releaseCalls).toEqual([]);

  await expect(session.close({ settle: false })).resolves.toBeUndefined();
  expect(state.releaseCalls).toEqual([{ generation: 1, settle: false }]);
  expect(state.leaseActive).toBe(false);

  const reopened = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  expect(state.generation).toBe(2);
  await reopened.close({ settle: false });
  await capture.stop();
});

it("publishes dead-session recovery without masking background capture health", async () => {
  const { capture, outcomes, rootPath, state } =
    await reconnectFailureCapture("dohc-ydoc-outcome-recovery-");

  const healthyBackgroundSession = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  await failRendererUpdate(healthyBackgroundSession);
  expect(outcomes).toEqual([false]);
  await healthyBackgroundSession.close({ settle: false });
  expect(outcomes).toEqual([false, true]);

  const failingBackgroundSession = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  await failRendererUpdate(failingBackgroundSession);
  expect(outcomes).toEqual([false, true, false]);

  state.failBackgroundCapture = true;
  await writeFile(join(rootPath, "background.md"), "capture me\n");
  capture.captureBatch([{ path: "background.md", operation: "update" }]);
  await capture.flush();
  expect(outcomes).toEqual([false, true, false, false]);

  state.failBackgroundCapture = false;
  await failingBackgroundSession.close({ settle: false });
  expect(outcomes).toEqual([false, true, false, false, false]);

  capture.captureBatch([{ path: "background.md", operation: "update" }]);
  await capture.flush();
  expect(outcomes).toEqual([false, true, false, false, false, true]);
  await capture.stop();
});

it("rebinds a live Y.Doc and replays renderer state after the daemon restarts", async () => {
  const rootPath = await createTestScratch("dohc-ydoc-restart-");
  const loopback = new VersionedLoopbackEngine();

  const client = (generation: number): EngineDaemonClient & EngineTransport => ({
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      const params = request.params as Record<string, unknown>;
      if (request.method === "workspace.open") {
        return {
          id: request.id,
          result: { workspace: "ydoc-restart" },
        };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
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

  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, seedUpdate);
    openedDocs.push(doc);
    const generation =
      options.transport === firstClient
        ? 1
        : options.transport === secondClient
          ? 2
          : 3;
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      contentKind: "plaintext",
      path: options.path,
      head: "present" as const,
      lineage: "existing" as const,
      async applyLocalUpdate(update) {
        Y.applyUpdate(doc, update);
        if (generation === 2 && secondGenerationApplyCount++ === 0) {
          const beforeRemote = Y.encodeStateVector(doc);
          doc.getText("plainText").insert(
            doc.getText("plainText").length,
            " remote",
          );
          options.onRemoteUpdate(
            Y.encodeStateAsUpdate(doc, beforeRemote),
          );
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
          markdown,
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
      async applyExternalMarkdownEdit(markdown) {
        doc.getText("plainText").delete(0, doc.getText("plainText").length);
        doc.getText("plainText").insert(0, markdown);
        return { kind: "merged", markdown } as const;
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
  expect(settled.markdown).toBe("seed survives remote");
  expect(openedDocs).toHaveLength(2);
  expect(openedDocs[1].getText("plainText").toString()).toBe(
    "seed survives remote",
  );
  expect(session.doc).toBe(stableDoc);
  expect(stableDoc.getText("plainText").toString()).toBe(
    "seed survives remote",
  );

  const beforeSecondRestart = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(13, " twice");
  session.applyLocalUpdate(
    Y.encodeStateAsUpdate(rendererDoc, beforeSecondRestart),
  );

  const settledAfterSecondRestart = await session.settleNow();
  expect(settledAfterSecondRestart.markdown).toBe(
    "seed survives twice remote",
  );
  expect(openedDocs).toHaveLength(3);
  expect(openedDocs[2].getText("plainText").toString()).toBe(
    "seed survives twice remote",
  );
  expect(stableDoc.getText("plainText").toString()).toBe(
    "seed survives twice remote",
  );
  expect(rendererDoc.getText("plainText").toString()).toBe(
    "seed survives twice remote",
  );

  await session.close({ settle: false });
  await capture.stop();
});

it("opens first when record recovery loses the restarted daemon transport", async () => {
  const rootPath = await createTestScratch("dohc-ydoc-chain-restart-");
  const workspaceHandle = "ydoc-chain-restart";
  const versioned = new VersionedLoopbackEngine();
  versioned.seedTextFile({
    workspace: workspaceHandle,
    path: "note.md",
    text: "",
  });
  const firstYdoc = new YdocLoopbackEngine();
  const secondYdoc = new YdocLoopbackEngine();
  for (const engine of [firstYdoc, secondYdoc]) {
    engine.seedFile({
      workspace: workspaceHandle,
      versionId: "main",
      path: "note.md",
      markdown: "",
      contentKind: "plaintext",
    });
  }
  const lifecycle: string[] = [];
  let broken = false;
  let currentClient: EngineDaemonClient & EngineTransport;
  const transportError = (stage: string) =>
    Object.assign(new Error(`${stage}: daemon restarted`), {
      code: "transport-error",
    });
  const routeWorkspace = async (request: Request): Promise<Response | null> => {
    if (request.method === "workspace.open") {
      return { id: request.id, result: { workspace: workspaceHandle } };
    }
    if (request.method === "workspace.close") {
      return { id: request.id, result: { closed: true } };
    }
    if (!request.method.startsWith("ydoc.")) {
      return await versioned.sendRequest(request);
    }
    return null;
  };
  const secondClient: EngineDaemonClient & EngineTransport = {
    close: () => undefined,
    onEvent: (handler) => secondYdoc.onEvent(handler),
    async sendRequest(request) {
      const workspaceResponse = await routeWorkspace(request);
      if (workspaceResponse) return workspaceResponse;
      lifecycle.push(`${request.method}:second`);
      return await secondYdoc.sendRequest(request);
    },
  };
  const firstClient: EngineDaemonClient & EngineTransport = {
    close: () => undefined,
    onEvent: (handler) => firstYdoc.onEvent(handler),
    async sendRequest(request) {
      const workspaceResponse = await routeWorkspace(request);
      if (workspaceResponse) return workspaceResponse;
      lifecycle.push(`${request.method}:first`);
      if (request.method === "ydoc.recordUpdate") {
        broken = true;
        currentClient = secondClient;
        throw transportError("record");
      }
      if (request.method === "ydoc.resync") throw transportError("resync");
      if (broken) throw transportError(request.method);
      return await firstYdoc.sendRequest(request);
    },
  };
  currentClient = firstClient;
  const sessions = new EngineWorkspaceSessions(
    { currentClient: () => currentClient },
    { sleep: async () => undefined },
  );
  const outcomes: boolean[] = [];
  const onError = vi.fn();
  const capture = createWorkspaceEngineCapture({
    workspaceId: workspaceHandle,
    rootPath,
    rustEngineSessions: sessions,
    onCaptureOutcome: ({ ok }) => outcomes.push(ok),
    onError,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    contentKind: "plaintext",
    onRemoteUpdate: () => undefined,
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);
  const before = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(0, "survives");

  session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));
  await expect(session.settleNow()).resolves.toMatchObject({
    markdown: "survives",
  });

  // MUTATION: remove either reconnect-class rethrow in ydocLiveAdapter. The
  // generic recovery wrapper selects release-first here, sends ydoc.close
  // through `firstClient`, and the session dies instead of settling.
  expect(lifecycle).toEqual([
    "ydoc.open:first",
    "ydoc.recordUpdate:first",
    "ydoc.resync:first",
    "ydoc.open:second",
    "ydoc.recordUpdate:second",
    "ydoc.settle:second",
  ]);
  expect(lifecycle).not.toContain("ydoc.close:first");
  expect(outcomes).not.toContain(false);
  expect(onError).not.toHaveBeenCalled();
  await session.close({ settle: false });
  await capture.stop();
});

it("recovers a non-reconnect local refusal by releasing, rebinding, and replaying", async () => {
  const rootPath = await createTestScratch("dohc-ydoc-refusal-");
  const loopback = new VersionedLoopbackEngine();
  const daemonClient: EngineDaemonClient & EngineTransport = {
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "ydoc-refusal" } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions({
    currentClient: () => daemonClient,
  });
  const seed = new Y.Doc();
  seed.getText("plainText").insert(0, "seed");
  const seedUpdate = Y.encodeStateAsUpdate(seed);
  const lifecycle: string[] = [];
  let generation = 0;
  const refusal = new Error("record-update-refused");

  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    const openedGeneration = ++generation;
    lifecycle.push(`open-${openedGeneration}`);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, seedUpdate);
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      contentKind: "plaintext",
      path: options.path,
      head: "present" as const,
      lineage: "existing" as const,
      async applyLocalUpdate(update) {
        if (openedGeneration === 1) throw refusal;
        Y.applyUpdate(doc, update);
      },
      async settleNow() {
        const markdown = doc.getText("plainText").toString();
        return {
          momentId: `moment-${openedGeneration}`,
          path: options.path,
          markdown,
          sha256: createHash("sha256").update(markdown).digest("hex"),
          materialized: true,
          projection: {
            contentKind: "plaintext",
            sourceStateVectorSha256: "a".repeat(64),
            destructive: false,
          },
        };
      },
      async applyExternalMarkdownEdit(markdown) {
        return { kind: "merged", markdown } as const;
      },
      async close() {
        lifecycle.push(`close-${openedGeneration}`);
      },
    };
  };
  const onError = vi.fn();
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-refusal",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onError,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);
  const before = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(4, " survives");

  session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));
  const settled = await session.settleNow();

  expect(settled.markdown).toBe("seed survives");
  expect(lifecycle.slice(0, 3)).toEqual(["open-1", "close-1", "open-2"]);
  expect(onError).not.toHaveBeenCalled();
  await session.close({ settle: false });
  await capture.stop();
});

it("releases a close-latched failed generation with settle true before the next edit", async () => {
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
      async applyLocalUpdate(update) {
        // Models the round-1 provider latch: once close starts, another apply
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
          markdown,
          sha256: createHash("sha256").update(markdown).digest("hex"),
          materialized: true,
          projection: {
            contentKind: "plaintext",
            sourceStateVectorSha256: "a".repeat(64),
            destructive: false,
          },
        };
      },
      async applyExternalMarkdownEdit(markdown) {
        return { kind: "merged", markdown } as const;
      },
      async close(closeOptions) {
        providerClosed = true;
        closeAttempts.push({
          generation: openedGeneration,
          ...(closeOptions?.settle !== undefined
            ? { settle: closeOptions.settle }
            : {}),
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
    onCaptureOutcome: ({ ok }) => outcomes.push(ok),
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
    markdown: "seed first",
  });

  const beforeSecond = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(10, " second");
  session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, beforeSecond));
  await expect(session.settleNow()).resolves.toMatchObject({
    markdown: "seed first second",
  });

  expect(closeAttempts.slice(0, 2)).toEqual([
    { generation: 1, settle: false },
    { generation: 1, settle: true },
  ]);
  expect(journaledGenerations).toEqual([2, 2]);
  expect(generation).toBe(2);
  expect(leaseActive).toBe(true);
  expect(outcomes).toEqual([]);
  await session.close({ settle: false });
  expect(leaseActive).toBe(false);
  await capture.stop();
});

it("defers a version switch behind a dead generation until release converges", async () => {
  const rootPath = await createTestScratch("dohc-ydoc-close-dead-");
  const loopback = new VersionedLoopbackEngine();
  const daemonClient: EngineDaemonClient & EngineTransport = {
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "ydoc-close-dead" } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions({
    currentClient: () => daemonClient,
  });
  const seed = new Y.Doc();
  seed.getText("plainText").insert(0, "seed");
  const seedUpdate = Y.encodeStateAsUpdate(seed);
  const closeAttempts: Array<boolean | undefined> = [];
  const refusal = new Error("record-update-refused");
  const settlingCloseFailure = new Error("settling close also refused");
  let applyCount = 0;
  let leaseActive = false;
  let generation = 0;

  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    if (leaseActive) throw new Error("ydoc-session-busy");
    leaseActive = true;
    generation += 1;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, seedUpdate);
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      contentKind: "plaintext",
      path: options.path,
      head: "present" as const,
      lineage: "existing" as const,
      async applyLocalUpdate() {
        applyCount += 1;
        throw refusal;
      },
      async settleNow() {
        throw new Error("dead generation must not settle");
      },
      async applyExternalMarkdownEdit(markdown) {
        return { kind: "merged", markdown } as const;
      },
      async close(closeOptions) {
        closeAttempts.push(closeOptions?.settle);
        if (closeAttempts.length < 5) {
          if (closeOptions?.settle === true) throw settlingCloseFailure;
          throw new Error("plain close refused");
        }
        leaseActive = false;
      },
    };
  };
  const outcomes: boolean[] = [];
  let historyCaptureFailed = false;
  const onError = vi.fn();
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-close-dead",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onCaptureOutcome: ({ ok }) => {
      outcomes.push(ok);
      historyCaptureFailed = !ok;
    },
    onError,
  });
  await capture.createVersion("Draft");
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);
  const before = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(4, " refused");

  session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));
  await expect(session.settleNow()).rejects.toThrow(/closed/i);
  expect(closeAttempts).toEqual([false, true]);
  expect(outcomes).toEqual([false]);
  expect(historyCaptureFailed).toBe(true);
  expect(onError).toHaveBeenCalledWith(
    "Y.Doc local update of note.md",
    settlingCloseFailure,
  );

  const beforeNext = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(12, " next");
  session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, beforeNext));
  await expect(session.settleNow()).rejects.toThrow(/closed/i);
  expect(applyCount).toBe(1);
  expect(outcomes).toEqual([false]);
  expect(historyCaptureFailed).toBe(true);

  await writeFile(join(rootPath, "unrelated.md"), "captured safely\n");
  capture.captureBatch([{ path: "unrelated.md", operation: "update" }]);
  await capture.flush();
  expect(outcomes).toEqual([false, false]);
  expect(historyCaptureFailed).toBe(true);

  // MUTATION: omit markDead's failing-close transition. The switch enters the
  // healthy-session settle branch and fails on the dead wrapper before it can
  // exercise the retained release obligation.
  await expect(capture.switchVersion("main")).rejects.toBe(
    settlingCloseFailure,
  );
  expect(closeAttempts).toEqual([false, true, false, true]);
  expect(leaseActive).toBe(true);
  expect(historyCaptureFailed).toBe(true);
  await expect(
    capture.openYDocSession({
      path: "note.md",
      onRemoteUpdate: () => undefined,
    }),
  ).rejects.toThrow("ydoc-session-busy");
  expect(generation).toBe(1);

  await expect(capture.switchVersion("main")).resolves.toMatchObject({
    activeVersionId: "main",
  });
  expect(closeAttempts).toEqual([false, true, false, true, false]);
  expect(leaseActive).toBe(false);
  expect(outcomes).toEqual([false, false, true]);
  expect(historyCaptureFailed).toBe(false);
  await writeFile(join(rootPath, "unrelated.md"), "captured safely again\n");
  capture.captureBatch([{ path: "unrelated.md", operation: "update" }]);
  await capture.flush();
  expect(outcomes).toEqual([false, false, true, true]);
  expect(historyCaptureFailed).toBe(false);
  const reopened = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  expect(generation).toBe(2);
  await reopened.close({ settle: false });
  await capture.stop();
});

it("treats typed session-not-found during release-first rebind as already released", async () => {
  const rootPath = await createTestScratch("dohc-ydoc-gone-");
  const loopback = new VersionedLoopbackEngine();
  const daemonClient: EngineDaemonClient & EngineTransport = {
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "ydoc-gone" } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions({
    currentClient: () => daemonClient,
  });
  const seed = new Y.Doc();
  seed.getText("plainText").insert(0, "seed");
  const seedUpdate = Y.encodeStateAsUpdate(seed);
  const notFound = new DaemonRefusalError(
    {
      code: "INVALID_PARAMS",
      message: "ydoc-session-not-found",
      retry: "no",
    },
    new Error("daemon response"),
  );
  let generation = 0;
  let closeCount = 0;

  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    const openedGeneration = ++generation;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, seedUpdate);
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      contentKind: "plaintext",
      path: options.path,
      head: "present" as const,
      lineage: "existing" as const,
      async applyLocalUpdate(update) {
        if (openedGeneration === 1) throw new Error("record refusal");
        Y.applyUpdate(doc, update);
      },
      async settleNow() {
        const markdown = doc.getText("plainText").toString();
        return {
          momentId: `moment-${openedGeneration}`,
          path: options.path,
          markdown,
          sha256: createHash("sha256").update(markdown).digest("hex"),
          materialized: true,
          projection: {
            contentKind: "plaintext",
            sourceStateVectorSha256: "a".repeat(64),
            destructive: false,
          },
        };
      },
      async applyExternalMarkdownEdit(markdown) {
        return { kind: "merged", markdown } as const;
      },
      async close() {
        closeCount += 1;
        if (openedGeneration === 1) throw notFound;
      },
    };
  };
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-gone",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);
  const before = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(4, " survives");

  session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));
  await expect(session.settleNow()).resolves.toMatchObject({
    markdown: "seed survives",
  });
  expect(generation).toBe(2);
  expect(closeCount).toBe(1);
  await session.close({ settle: false });
  await capture.stop();
});

it("an over-cap settle (markdown omitted from the response) leaves the engine's file on disk intact", async () => {
  // AUDIT-SILENTSAVE, fix 2. Past the engine's in-band response cap the settle
  // still commits and the DAEMON materializes the .md — the response just
  // cannot carry the body as one wire string, so it answers markdown: null.
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
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions({
    currentClient: () => daemonClient,
  });

  // What the engine already wrote to disk when it materialized the settle.
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
      async applyLocalUpdate(update) {
        Y.applyUpdate(doc, update);
      },
      async settleNow() {
        const result = {
          momentId: "moment-overcap",
          path: options.path,
          // The engine's over-cap answer.
          markdown: null,
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
      async applyExternalMarkdownEdit(markdown) {
        return { kind: "merged", markdown } as const;
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

  // THE load-bearing assertion: the engine's file is untouched, not truncated.
  const onDisk = await readFile(join(rootPath, "load.md"), "utf8");
  expect(onDisk).toBe(onDiskBody);
  expect(onDisk.length).toBeGreaterThan(48 * 1024);
  // And it IS saved — the settle committed; nothing about this is an error.
  expect(states).toContain("saved");
  expect(states).not.toContain("error");
  expect(onError).not.toHaveBeenCalled();

  await session.close({ settle: false });
  await capture.stop();
});

it("a settle whose materialization was BLOCKED reports an error, never Saved", async () => {
  // AUDIT-SILENTSAVE round 2 (codex P2). `JobOutcome::Blocked` (a symlinked
  // target) is deliberately a durably-pending SUCCESS for the settle contract
  // — marker kept, write retried later — so the response is Ok. But the file
  // on disk is still the OLD artifact. With markdown omitted (over-cap) the
  // desktop writes nothing, so nothing else would ever notice. The engine now
  // says `materialized: false` and the editor must not claim Saved.
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
      async applyLocalUpdate(update) {
        Y.applyUpdate(doc, update);
      },
      async settleNow() {
        const result = {
          momentId: "moment-blocked",
          path: options.path,
          markdown: null,
          sha256: createHash("sha256").update("never landed").digest("hex"),
          // Committed, but the disk did not move.
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
      async applyExternalMarkdownEdit(markdown) {
        return { kind: "merged", markdown } as const;
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

  // THE load-bearing assertion: the document must NOT read Saved.
  expect(states).not.toContain("saved");
  expect(states).toContain("error");
  expect(onError).toHaveBeenCalled();
  expect(String(onError.mock.calls.at(-1)?.[0])).toContain("note.md");
  // And the disk really is still the old artifact.
  expect(await readFile(join(rootPath, "note.md"), "utf8")).toBe(stale);

  await session.close({ settle: false });
  await capture.stop();
});

it("surfaces an unrecoverable local refusal and releases every opened lease", async () => {
  const rootPath = await createTestScratch("dohc-ydoc-loud-");
  const loopback = new VersionedLoopbackEngine();
  const daemonClient: EngineDaemonClient & EngineTransport = {
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "ydoc-loud" } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions({
    currentClient: () => daemonClient,
  });
  const seed = new Y.Doc();
  seed.getText("plainText").insert(0, "seed");
  const seedUpdate = Y.encodeStateAsUpdate(seed);
  const closedGenerations: number[] = [];
  let generation = 0;
  let leaseActive = false;
  const refusal = new Error("permanent-record-update-refusal");
  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    if (leaseActive) throw new Error("ydoc-session-busy");
    leaseActive = true;
    const openedGeneration = ++generation;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, seedUpdate);
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      contentKind: "plaintext",
      path: options.path,
      head: "present" as const,
      lineage: "existing" as const,
      async applyLocalUpdate() {
        throw refusal;
      },
      async settleNow() {
        throw new Error("settle must not run after failed recovery");
      },
      async applyExternalMarkdownEdit(markdown) {
        return { kind: "merged", markdown } as const;
      },
      async close() {
        closedGenerations.push(openedGeneration);
        leaseActive = false;
      },
    };
  };
  const onError = vi.fn();
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-loud",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onError,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);
  const before = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(4, " refused");

  session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));
  await expect(session.settleNow()).rejects.toThrow(/closed/i);
  expect(onError).toHaveBeenCalledWith(
    "Y.Doc local update of note.md",
    refusal,
  );
  // Generations 1 and 2 die to the refusal; the settle then makes ONE more
  // recovery attempt (a settle must try to persist what the canonical doc
  // holds), which refuses too. The bar is that every opened lease is released.
  expect(closedGenerations).toEqual([1, 2, 3]);
  expect(leaseActive).toBe(false);
  await expect(session.close({ settle: false })).resolves.toBeUndefined();
  const reopened = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  expect(generation).toBe(4);
  await reopened.close({ settle: false });
  await capture.stop();
});

// AUDIT-KILLREC. A hard `taskkill /F` on the daemon takes the whole transport
// with it: the generation's applyLocalUpdate fails AND the replacement open
// fails, until the supervisor relaunches. This harness reproduces that window,
// which is where the dogfood journey lost the text typed before the kill.
//
// It models the daemon's DURABLE state, not an empty stand-in: a replacement
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
  openProvider: (
    options: EngineYdocProviderSessionOptions,
  ) => Promise<EngineYdocProviderSession>;
  state: {
    daemonAlive: boolean;
    generation: number;
    lineage: "present" | "absent";
    durableUpdates: Uint8Array[];
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
    diskMarkdown: "",
    settled: [] as string[],
    seedRequests: [] as boolean[],
    // What each open REPORTED for the lineage. A fake that hardcodes this
    // cannot be caught by any assertion about the code under test, so the
    // fixture is asserted on directly.
    reportedLineage: [] as Array<"existing" | "absent">,
    // A LIVE daemon refusing the write (not a transport death): the generation
    // still owns its lease, so recovery must release before reopening.
    refuseApply: false,
    failRelease: false,
    releasedGenerations: [] as number[],
  };
  const generations: Y.Doc[] = [];
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
          throw new EngineDaemonUnavailableError(
            "Rust engine daemon is not available.",
          );
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
      // The client's absent-lineage seed: a FRESH doc built from the markdown,
      // carrying a client id that overlaps nothing already in the canonical doc.
      const seed = new Y.Doc();
      seed.getText("plainText").insert(0, state.diskMarkdown);
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
    }
    generations.push(doc);
    const reportLineage = (): "existing" | "absent" => {
      const reported = state.lineage === "present" ? "existing" : "absent";
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
      // MAPPED from the state this fake models, never hardcoded.
      // `loseDurableLineage()` is the whole point of the fixture — it models a
      // crash that took the durable CRDT rows — and a fake that kept reporting
      // "existing" through it would certify the one state it exists to stage.
      // No production read reaches this today (the guard consults `lineage`
      // only once `head` is absent, which cannot happen here), so the fixture
      // is asserted on DIRECTLY instead; see `state.reportedLineage`.
      lineage: reportLineage(),
      async applyLocalUpdate(update) {
        if (!state.daemonAlive) throw transportDeath();
        if (state.refuseApply) throw new Error("record-update-refused");
        Y.applyUpdate(doc, update);
        state.durableUpdates.push(update);
      },
      async settleNow() {
        if (!state.daemonAlive) throw transportDeath();
        const markdown = settle();
        return {
          momentId: `moment-${openedGeneration}`,
          path: options.path,
          markdown,
          sha256: createHash("sha256").update(markdown).digest("hex"),
          materialized: true,
          projection: {
            contentKind: "plaintext",
            sourceStateVectorSha256: "b".repeat(64),
            destructive: false,
          },
        };
      },
      async applyExternalMarkdownEdit(markdown) {
        return { kind: "merged", markdown } as const;
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
    // A crash that took the durable CRDT lineage with it; only the .md survives.
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
  const { rootPath, sessions, openProvider, state, generations } =
    await daemonDeathCapture("dohc-ydoc-daemon-death-", "ydoc-daemon-death");
  const outcomes: boolean[] = [];
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-daemon-death",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onCaptureOutcome: ({ ok }) => outcomes.push(ok),
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

  // taskkill /F: the generation's writes fail AND no replacement can open.
  state.daemonAlive = false;
  typeInto(rendererDoc, session, "PRE_KILL ");
  typeInto(rendererDoc, session, "DURING_OUTAGE ");
  await expect(session.settleNow()).rejects.toThrow(/closed/i);
  expect(state.generation).toBe(1);
  expect(outcomes.at(-1)).toBe(false);

  // The supervisor relaunches. The very next keystroke must heal the session
  // and carry BOTH outage keystrokes into the replacement generation.
  state.daemonAlive = true;
  typeInto(rendererDoc, session, "AFTER_RESTART");
  await expect.poll(() => state.generation, { timeout: 5_000 }).toBe(2);

  const settled = await session.settleNow();
  expect(settled.markdown).toBe("alive PRE_KILL DURING_OUTAGE AFTER_RESTART");
  expect(generations[1]?.getText("plainText").toString()).toBe(
    "alive PRE_KILL DURING_OUTAGE AFTER_RESTART",
  );
  // The canonical doc — the renderer's truth — never lost a keystroke either.
  expect(session.doc.getText("plainText").toString()).toBe(
    "alive PRE_KILL DURING_OUTAGE AFTER_RESTART",
  );
  // And the session is honestly live again, not still reported dead.
  expect(outcomes.at(-1)).toBe(true);

  await session.close({ settle: false });
  await capture.stop();
});

it("a failure sink that throws cannot turn a daemon death into an unhandled rejection", async () => {
  const { rootPath, sessions, openProvider, state } = await daemonDeathCapture(
    "dohc-ydoc-death-loud-sink-",
    "ydoc-death-loud-sink",
  );
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-death-loud-sink",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    // Exactly the journey's shape: the capture's default sink is console.error,
    // and on a broken stdio pipe console.error THROWS.
    onError: () => {
      throw new Error("EPIPE: broken pipe, write");
    },
  });
  try {
    const session = await capture.openYDocSession({
      path: "note.md",
      onRemoteUpdate: () => undefined,
    });
    const rendererDoc = new Y.Doc();
    Y.applyUpdate(rendererDoc, session.initialUpdate);

    state.daemonAlive = false;
    typeInto(rendererDoc, session, "PRE_KILL ");
    typeInto(rendererDoc, session, "DURING_OUTAGE ");
    await expect(session.settleNow()).rejects.toThrow(/closed/i);

    // Let Node surface any rejection nobody handled.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unhandled).toEqual([]);

    // And the session still heals once the daemon is back.
    state.daemonAlive = true;
    typeInto(rendererDoc, session, "AFTER_RESTART");
    await expect.poll(() => state.generation, { timeout: 5_000 }).toBe(2);
    expect((await session.settleNow()).markdown).toBe(
      "PRE_KILL DURING_OUTAGE AFTER_RESTART",
    );
    await session.close({ settle: false });
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await capture.stop();
  }
});

// The journey's ACTUAL scenario: the user stopped typing before the app went
// away. Recovery that only runs on the next keystroke never runs at all, and
// the quit path's settling close is the last chance to persist the text.
it("a settling close persists outage text when the user never types again", async () => {
  const { rootPath, sessions, openProvider, state } = await daemonDeathCapture(
    "dohc-ydoc-death-quit-",
    "ydoc-death-quit",
  );
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-death-quit",
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
  expect(state.settled).toEqual(["alive "]);

  state.daemonAlive = false;
  typeInto(rendererDoc, session, "PRE_KILL");
  await expect(session.settleNow()).rejects.toThrow(/closed/i);
  expect(state.generation).toBe(1);

  // The supervisor relaunches and the user quits without touching the keyboard.
  state.daemonAlive = true;
  await session.close();

  expect(state.settled.at(-1)).toBe("alive PRE_KILL");
  expect(state.diskMarkdown).toBe("alive PRE_KILL");
  expect(state.generation).toBe(2);
  await capture.stop();
});

// The reconcile half of adoptGeneration: a replacement generation carrying
// daemon-side work the canonical doc never saw must be merged in, exactly once.
it("merges a daemon-side edit made during the outage into the canonical doc once", async () => {
  const { rootPath, sessions, openProvider, state, applyDaemonSideEdit } =
    await daemonDeathCapture("dohc-ydoc-death-merge-", "ydoc-death-merge");
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

  // An agent writes through the daemon while the editor session is dead.
  state.daemonAlive = true;
  applyDaemonSideEdit("AGENT_EDIT ");

  await session.close();

  const merged = state.settled.at(-1) ?? "";
  expect(merged).toContain("TYPED_IN_OUTAGE");
  expect(merged).toContain("AGENT_EDIT");
  expect(merged.match(/AGENT_EDIT/g)).toHaveLength(1);
  expect(merged.match(/TYPED_IN_OUTAGE/g)).toHaveLength(1);
  expect(merged.match(/alive/g)).toHaveLength(1);
  // The renderer is told about the daemon-side work rather than silently
  // diverging from the canonical doc.
  expect(remoteUpdates.length).toBeGreaterThan(0);
  await capture.stop();
});

// A hard kill can take the object's durable CRDT lineage with it. The client
// normally seeds an absent lineage from the .md — a FRESH client id whose state
// does not overlap the canonical doc, so merging it would append a second copy
// of the whole file. Every generation after the first must therefore open
// without seeding and let the replay re-establish the content.
it("does not duplicate the document when the reopen finds no durable lineage", async () => {
  const {
    rootPath,
    sessions,
    openProvider,
    state,
    loseDurableLineage,
  } = await daemonDeathCapture("dohc-ydoc-death-absent-", "ydoc-death-absent");
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

  // The crash lost the lineage; only the .md survived.
  loseDurableLineage();
  state.daemonAlive = true;
  await session.close();

  expect(state.settled.at(-1)).toBe("Anchor paragraph. PRE_KILL");
  expect(state.settled.at(-1)?.match(/Anchor paragraph\./g)).toHaveLength(1);
  // The first open seeds; every replacement declines, because the canonical doc
  // already holds the document and will replay it.
  expect(state.seedRequests).toEqual([true, false]);
  // The fake told the truth about the state it models: it reported an existing
  // lineage while it had one, and an absent lineage once the modelled crash
  // took it. A fixture that hardcoded "existing" here would keep passing every
  // assertion above while certifying the one condition it exists to stage.
  expect(state.reportedLineage[0]).toBe("existing");
  expect(state.reportedLineage.at(-1)).toBe("absent");
  await capture.stop();
});

// settleNow is its own persistence entry point (the renderer's explicit save
// and the version-op flush both reach it), so recovery cannot live only in the
// keystroke path.
it("a settle after the daemon returns recovers the session on its own", async () => {
  const { rootPath, sessions, openProvider, state } = await daemonDeathCapture(
    "dohc-ydoc-death-settle-",
    "ydoc-death-settle",
  );
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-death-settle",
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

  state.daemonAlive = true;
  const settled = await session.settleNow();

  expect(settled.markdown).toBe("alive PRE_KILL");
  expect(state.generation).toBe(2);
  await session.close({ settle: false });
  await capture.stop();
});

// "failing-close" and "dead generation" are different conditions on the same
// registry entry. A recovering generation may lift only the guard it set: a
// teardown that failed leaves the reservation possibly held and the on-disk
// state indeterminate, and capture must stay deferred until teardown converges.
it("a recovered generation does not lift a failed teardown's guard", async () => {
  const { rootPath, sessions, openProvider, state } = await daemonDeathCapture(
    "dohc-ydoc-death-guard-",
    "ydoc-death-guard",
  );
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-death-guard",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onError: () => undefined,
  });
  await capture.createVersion("Draft");
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);
  typeInto(rendererDoc, session, "alive ");
  await session.settleNow();

  // A teardown that fails: the entry is guarded as failing-close.
  state.failRelease = true;
  await expect(session.close({ settle: false })).rejects.toThrow(
    /release-refused/,
  );
  state.failRelease = false;

  // The daemon then dies and comes back, and the session recovers.
  state.daemonAlive = false;
  typeInto(rendererDoc, session, "PRE_KILL");
  await expect(session.settleNow()).rejects.toThrow(/closed/i);
  state.daemonAlive = true;
  typeInto(rendererDoc, session, " AFTER");
  await expect.poll(() => state.generation, { timeout: 5_000 }).toBe(2);

  // A version op must still SKIP the settle for a guarded entry and go straight
  // to release — lifting the guard would settle over an indeterminate teardown.
  const settledBefore = state.settled.length;
  await capture.switchVersion("main");
  expect(state.settled).toHaveLength(settledBefore);
  await capture.stop();
});

// markDead records the dead generation's unreleased lease with `??=`, so a
// STALE obligation left over from an earlier death would shadow the real one
// and leak the live lease at teardown. A successful recovery discharges it.
it("a recovered session does not leave a stale release obligation behind", async () => {
  const { rootPath, sessions, openProvider, state } = await daemonDeathCapture(
    "dohc-ydoc-death-obligation-",
    "ydoc-death-obligation",
  );
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-death-obligation",
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

  // Death 1 (transport): generation 1 is recorded as the release obligation.
  state.daemonAlive = false;
  typeInto(rendererDoc, session, "PRE_KILL ");
  await expect(session.settleNow()).rejects.toThrow(/closed/i);

  // Recovery into generation 2 discharges it.
  state.daemonAlive = true;
  typeInto(rendererDoc, session, "AFTER ");
  await expect.poll(() => state.generation, { timeout: 5_000 }).toBe(2);

  // Death 2 on a LIVE daemon: generation 2 refuses the write AND its release,
  // so IT is the lease that teardown still owes.
  state.refuseApply = true;
  state.failRelease = true;
  typeInto(rendererDoc, session, "REFUSED");
  await expect(session.settleNow()).rejects.toThrow(/closed/i);

  state.refuseApply = false;
  state.failRelease = false;
  await session.close({ settle: false });

  expect(state.releasedGenerations).toContain(2);
  await capture.stop();
});

// AUDIT-KILLREC N1. `will-quit` races the WHOLE shutdown chain against one 3s
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
// The tests below price both paths as the backoff each ASKS the supervisor
// for, not as elapsed wall time: a wall-clock bound loose enough to survive a
// loaded suite also passes a real regression on a quiet machine.
const BOUNDED_CLOSE_BACKOFF_MS = [100];
const TRANSPORT_LADDER_MS = [100, 200, 400, 800, 1_000];

it("a settling close of a DEAD session against a down daemon takes one bounded backoff, not the ladder", async () => {
  const { rootPath, sessions, openProvider, state, backoff } =
    await daemonDeathCapture("dohc-ydoc-death-budget-", "ydoc-death-budget");
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
  // The user quits before the supervisor's replacement is up.
  await session.close({ shuttingDown: true }).catch(() => undefined);

  expect(backoff.delays).toEqual(BOUNDED_CLOSE_BACKOFF_MS);
  // And it never opened a generation it could not have reached.
  expect(state.generation).toBe(1);
});

// The other half of the same quit: nothing was typed after the daemon died, so
// the session is still on its LIVE generation and reaches its rebind from
// close() rather than from the dead-session revive.
it("a quit close of a session still LIVE when the daemon died takes one bounded backoff, not the ladder", async () => {
  const { rootPath, sessions, openProvider, state, backoff } =
    await daemonDeathCapture("dohc-ydoc-live-budget-", "ydoc-live-budget");
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-live-budget",
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
  backoff.delays.length = 0;
  await session.close({ shuttingDown: true }).catch(() => undefined);

  expect(backoff.delays).toEqual(BOUNDED_CLOSE_BACKOFF_MS);
  expect(state.generation).toBe(1);
});

// The scope of the bound, which is the other half of getting it right: the
// same dead daemon and the same live session, closed the way a USER closes a
// document. Here the wait is the point — the supervisor relaunches in about a
// second, and a session that rode the ladder out comes back alive instead of
// leaving the path's capture deferred until somebody reopens it.
it("an ordinary close of the same session still rides the full transport ladder", async () => {
  const { rootPath, sessions, openProvider, state, backoff } =
    await daemonDeathCapture("dohc-ydoc-user-close-", "ydoc-user-close");
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-user-close",
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
  backoff.delays.length = 0;
  await session.close().catch(() => undefined);

  expect(backoff.delays).toEqual(TRANSPORT_LADDER_MS);
  expect(state.generation).toBe(1);
});

it("an explicit settle against a down daemon fails fast instead of blocking", async () => {
  const { rootPath, sessions, openProvider, state, backoff } =
    await daemonDeathCapture("dohc-ydoc-death-settle-cost-", "ydoc-death-settle-cost");
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-death-settle-cost",
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

  backoff.delays.length = 0;
  await expect(session.settleNow()).rejects.toThrow(/closed/i);
  expect(backoff.delays).toEqual(BOUNDED_CLOSE_BACKOFF_MS);

  await session.close({ settle: false }).catch(() => undefined);
  await capture.stop();
});

// #514, codex P2. The revive path's ordering. An edit typed after the daemon
// died is replayed into the replacement generation, and that replay ARMS a
// settle before its journal RPC returns. The settle can therefore start while
// the RPC is still in flight — and it snapshots the edit count at that moment.
//
// So the count has to be raised when the replay is armed. Raised after the
// journal completes, it misses the settle that the replay itself armed: that
// settle succeeds, carrying the edit, while reporting a seq below it. The
// renderer only clears on seq >= its own, and with the user done typing
// nothing arms another settle — the document reads "Saving…" forever over a
// file that already holds it.
//
// The wiring below is main.ts's: noteLocalEdit through the hand-over callback,
// noteSettleStart/noteSettleOutcome on the save-state channel.
it("counts a revived edit against the settle its own replay armed", async () => {
  const { rootPath, sessions, openProvider, state } = await daemonDeathCapture(
    "dohc-ydoc-revive-seq-",
    "ydoc-revive-seq",
  );
  // The replacement's journal RPC, held open so the settle its replay arms
  // starts while it is still in flight — a slow daemon under load.
  let releaseReplayJournal: (() => void) | null = null;
  const replayJournalHeld = new Promise<void>((resolve) => {
    releaseReplayJournal = resolve;
  });
  // Held on an object: a `let` assigned only inside a callback narrows to
  // `null` for the reader below, and the non-null dance that hides costs more
  // than it explains.
  const armed: { settle: ((markdown: string) => Promise<void>) | null } = {
    settle: null,
  };
  let replayArrived: (() => void) | null = null;
  const replayReached = new Promise<void>((resolve) => {
    replayArrived = resolve;
  });

  const gatedOpenProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    const inner = await openProvider(options);
    // Generation 1 behaves normally; the REPLACEMENT is the one under test.
    if (state.generation < 2) return inner;
    let token = 0;
    return {
      ...inner,
      async applyLocalUpdate(update) {
        // A real provider journals and arms its settle synchronously here,
        // then awaits the RPC. Everything below the await is the RPC.
        token += 1;
        const settleToken = token;
        armed.settle = async (markdown: string): Promise<void> => {
          // The debounce fires: this settle announces itself, and only then
          // does the journal complete and the settle land.
          options.onSettleStart?.(settleToken);
          releaseReplayJournal?.();
          await replayJournalHeld;
          await writeFile(join(rootPath, options.path), markdown, "utf8");
          await options.onSettled?.(
            {
              momentId: `moment-revive-${settleToken}`,
              path: options.path,
              markdown,
              sha256: createHash("sha256").update(markdown).digest("hex"),
              materialized: true,
              projection: {
                contentKind: "plaintext",
                sourceStateVectorSha256: "b".repeat(64),
                destructive: false,
              },
            },
            settleToken,
          );
        };
        replayArrived?.();
        await replayJournalHeld;
        await inner.applyLocalUpdate(update);
      },
    };
  };

  const saveSeq = createEngineYDocSaveSeqState();
  const reported: Array<{ state: string; seq: number }> = [];
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-revive-seq",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: gatedOpenProvider,
    onError: () => undefined,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
    onSaveState: (saveState, token) => {
      const seq =
        saveState === "settling"
          ? noteSettleStart(saveSeq, token)
          : noteSettleOutcome(saveSeq, token);
      reported.push({ state: saveState, seq });
    },
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);

  // The renderer's own counter, exactly as useEngineDoc keeps it.
  let rendererSeq = 0;
  const type = (text: string): void => {
    const before = Y.encodeStateVector(rendererDoc);
    const body = rendererDoc.getText("plainText");
    body.insert(body.length, text);
    rendererSeq += 1;
    const edited = rendererSeq;
    session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before), () =>
      noteLocalEdit(saveSeq, edited),
    );
  };

  type("alive ");
  await session.settleNow();

  // The daemon dies. The next edit finds no generation and must revive one.
  state.daemonAlive = false;
  await expect(session.settleNow()).rejects.toThrow(/closed|not available/i);
  state.daemonAlive = true;

  type("TYPED_AFTER_DEATH");
  await replayReached;

  // THE INTERLEAVING: the settle the replay armed starts now, while that
  // replay's journal RPC has not returned.
  expect(armed.settle, "the replay never reached the replacement").not.toBeNull();
  await armed.settle?.("alive TYPED_AFTER_DEATH");

  // The save that carried the edit must vouch for it. A lower seq leaves the
  // renderer on "Saving…" with nothing left to arm another settle.
  const saved = reported.filter((entry) => entry.state === "saved").at(-1);
  expect(saved, "the revived settle never reported a save").toBeDefined();
  expect(
    saved?.seq,
    `the save that carried the revived edit vouched for seq ${saved?.seq}, ` +
      `below the renderer's ${rendererSeq} — the document sticks on "Saving…"`,
  ).toBeGreaterThanOrEqual(rendererSeq);

  await session.close({ settle: false }).catch(() => undefined);
  await capture.stop();
});

// #514, codex P2 round 2. The third arm point. A provider can refuse an edit
// SYNCHRONOUSLY — YdocAdapterSession.assertOpen rejects a valid edit on a
// stale or quarantined generation — and it throws before arming anything, so
// nothing is announced there. The catch applies the edit to the canonical doc
// and rebinds, and THAT replay is the settle which carries it. Announce
// nothing on the recovery and the settle succeeds while vouching for the
// previous seq: the document reads "Saving…" for good, the same stuck state
// as the revive path, reached through a different door.
it("counts an edit recovered from a synchronous provider refusal", async () => {
  const rootPath = await createTestScratch("dohc-ydoc-sync-refuse-");
  const loopback = new VersionedLoopbackEngine();
  const daemonClient: EngineDaemonClient & EngineTransport = {
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "ydoc-sync-refuse" } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions({
    currentClient: () => daemonClient,
  });
  await writeFile(join(rootPath, "note.md"), "", "utf8");

  let generation = 0;
  const armedSettle: {
    fire: ((markdown: string) => Promise<void>) | null;
  } = { fire: null };
  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    const opened = ++generation;
    const doc = new Y.Doc();
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      contentKind: "plaintext",
      path: options.path,
      head: "present" as const,
      lineage: "existing" as const,
      applyLocalUpdate(update: Uint8Array): Promise<void> {
        // Generation 1 refuses SYNCHRONOUSLY — no settle is armed, so the
        // hand-over callback never runs on this path.
        if (opened === 1) throw new Error("ydoc-session-not-open");
        Y.applyUpdate(doc, update);
        // The recovery replay: this call is what arms the settle that will
        // carry the edit.
        armedSettle.fire = async (markdown: string): Promise<void> => {
          options.onSettleStart?.(1);
          await writeFile(join(rootPath, options.path), markdown, "utf8");
          await options.onSettled?.(
            {
              momentId: "moment-recovered",
              path: options.path,
              markdown,
              sha256: createHash("sha256").update(markdown).digest("hex"),
              materialized: true,
              projection: {
                contentKind: "plaintext",
                sourceStateVectorSha256: "b".repeat(64),
                destructive: false,
              },
            },
            1,
          );
        };
        return Promise.resolve();
      },
      async settleNow() {
        const markdown = doc.getText("plainText").toString();
        return {
          momentId: `moment-${opened}`,
          path: options.path,
          markdown,
          sha256: createHash("sha256").update(markdown).digest("hex"),
          materialized: true,
          projection: {
            contentKind: "plaintext" as const,
            sourceStateVectorSha256: "b".repeat(64),
            destructive: false,
          },
        };
      },
      async applyExternalMarkdownEdit(markdown) {
        return { kind: "merged", markdown } as const;
      },
      async close() {
        return;
      },
    };
  };

  const saveSeq = createEngineYDocSaveSeqState();
  const reported: Array<{ state: string; seq: number }> = [];
  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-sync-refuse",
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onError: () => undefined,
  });
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
    onSaveState: (saveState, token) => {
      const seq =
        saveState === "settling"
          ? noteSettleStart(saveSeq, token)
          : noteSettleOutcome(saveSeq, token);
      reported.push({ state: saveState, seq });
    },
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);

  let rendererSeq = 0;
  const before = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(0, "REFUSED_THEN_RECOVERED");
  rendererSeq += 1;
  const edited = rendererSeq;
  session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before), () =>
    noteLocalEdit(saveSeq, edited),
  );

  await expect
    .poll(() => armedSettle.fire, { timeout: 5_000 })
    .not.toBeNull();
  // The recovery generation holds the edit, and its replay armed the settle
  // that lands it.
  await armedSettle.fire?.("REFUSED_THEN_RECOVERED");

  const saved = reported.filter((entry) => entry.state === "saved").at(-1);
  expect(saved, "the recovery settle never reported a save").toBeDefined();
  expect(
    saved?.seq,
    `the settle that saved the recovered edit vouched for seq ${saved?.seq}, ` +
      `below the renderer's ${rendererSeq} — the document sticks on "Saving…"`,
  ).toBeGreaterThanOrEqual(rendererSeq);

  await session.close({ settle: false }).catch(() => undefined);
  await capture.stop();
});

// The once-guard, pinned. An ASYNCHRONOUS refusal reaches BOTH arm points:
// the failed generation armed a settle before its journal rejected, so the
// edit is announced there, and the recovery replay then arms another. Both are
// handed the same callback, so without the guard the edit is announced twice.
//
// Two announcements of the SAME seq are harmless only because main's callback
// happens to be an idempotent assignment. The callback type promises nothing
// of the sort, and a second announcement arriving late is a count moving
// backwards. Announce exactly once, by construction.
it("announces a recovered edit exactly once when both arm points run", async () => {
  const rootPath = await createTestScratch("dohc-ydoc-async-refuse-");
  const loopback = new VersionedLoopbackEngine();
  const daemonClient: EngineDaemonClient & EngineTransport = {
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "ydoc-async-refuse" } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions({
    currentClient: () => daemonClient,
  });
  await writeFile(join(rootPath, "note.md"), "", "utf8");

  let generation = 0;
  let replayed = 0;
  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    const opened = ++generation;
    const doc = new Y.Doc();
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      contentKind: "plaintext",
      path: options.path,
      head: "present" as const,
      lineage: "existing" as const,
      async applyLocalUpdate(update: Uint8Array): Promise<void> {
        // Generation 1 arms its settle, THEN its journal rejects.
        if (opened === 1) throw new Error("record-update-refused");
        replayed += 1;
        Y.applyUpdate(doc, update);
      },
      async settleNow() {
        const markdown = doc.getText("plainText").toString();
        return {
          momentId: `moment-${opened}`,
          path: options.path,
          markdown,
          sha256: createHash("sha256").update(markdown).digest("hex"),
          materialized: true,
          projection: {
            contentKind: "plaintext" as const,
            sourceStateVectorSha256: "b".repeat(64),
            destructive: false,
          },
        };
      },
      async applyExternalMarkdownEdit(markdown) {
        return { kind: "merged", markdown } as const;
      },
      async close() {
        return;
      },
    };
  };

  const capture = createWorkspaceEngineCapture({
    workspaceId: "ydoc-async-refuse",
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

  let announcements = 0;
  const before = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(0, "ASYNC_REFUSED");
  session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before), () => {
    announcements += 1;
  });

  // Both arm points have run once the recovery generation took the replay.
  await expect.poll(() => replayed, { timeout: 5_000 }).toBeGreaterThan(0);
  expect(announcements, "the edit was announced more than once").toBe(1);

  await session.close({ settle: false }).catch(() => undefined);
  await capture.stop();
});

// A locked-settle rebind harness: every applied update lands in a durable
// journal, and each new generation opens already holding all of it — so the
// adoption's replay is EMPTY, which is exactly the gap #595 names: nothing
// arms a settle on the replacement, and the pending locked write would sit
// stale until an unrelated edit.
async function lockedRebindCapture(prefix: string) {
  // #630's scratch, like every other harness in this file: the run root is
  // swept even when a test fails, and an unremovable tree fails the suite
  // instead of being left behind under a green run.
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
      return await loopback.sendRequest(request);
    },
  };
  const sessions = new EngineWorkspaceSessions(
    { currentClient: () => client },
    { sleep: async () => undefined },
  );
  const state = {
    locked: false,
    // The replicated shape (#595 round 4): the compaction release SUCCEEDS
    // over a failed pre-close settle, so close throws
    // YdocReleasedWithSettleFailureError instead of the refusal itself.
    replicated: false,
    closeFailure: null as Error | null,
    closeSettleFailure: null as Error | null,
    // #595 round 10: a settle that fails for a NON-lock reason (the live
    // session's reconnect retry exhausted), and a remote update delivered
    // after a settle resolves.
    settleFailure: null as Error | null,
    // #658: a JOURNAL write the engine refuses. The busy case is the one the
    // provider retries by itself, so the wrapper must not rebind for it.
    recordFailure: null as Error | null,
    emitUpdateAfterSettle: false,
    // #595 round 14: a peer update that lands while a session is RETAINED —
    // after its close unsubscribed and before the daemon accepted the
    // release. It reaches the durable lineage; the deaf session never hears
    // it. This is the window a stale write proof survives into.
    peerEditWhileRetained: false,
    // Parks the NEXT provider open until the test releases it. An open runs as
    // a capture-chain task, so parking one HOLDS THE CHAIN — which is how a
    // test puts a debt payment on the queue ahead of work a finisher appends
    // later.
    openGate: null as Promise<void> | null,
    // Counts every provider open the ladder attempts, including one that never
    // completes. A test proving a payment did NOT start reads this, because
    // `generation` only moves once the open succeeds.
    openAttempts: 0,
    // #595 round 12: the engine COMMITS the settle and declines to write the
    // target (a symlinked path or ancestor), so the call resolves clean while
    // the artifact stays stale.
    unmaterialized: false,
    closesWithSettleFalse: 0,
    journal: [] as Uint8Array[],
    settleCalls: [] as number[],
    closeCalls: [] as number[],
    settledMarkdowns: [] as string[],
    generation: 0,
    generationOptions: [] as EngineYdocProviderSessionOptions[],
    errors: [] as string[],
    // The MESSAGE, not just the context: a debt that gives up has to say
    // what the user can act on, and only the error carries that.
    errorMessages: [] as string[],
  };
  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    // Counted BEFORE the gate, so a test can see a parked open.
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
    // The real provider unsubscribes from remote updates at the TOP of
    // close(), before it asks the daemon to release
    // (ydocProviderSession.ts). A fake that keeps forwarding after a refused
    // close models a session that can still hear peers, which no retained
    // session can — and that difference is exactly what hid #595 round 14.
    let listening = true;
    const deliverPeerEdit = (text: string) => {
      // The daemon's lineage advances whether or not this client hears it:
      // the update is journaled, so the NEXT generation opens holding it.
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
      lineage: "existing" as const,
      async applyLocalUpdate(update) {
        // The provider's post-#658 contract for a transient journal refusal:
        // it KEEPS the update (its own ladder resends it from durable state)
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
          markdown,
          sha256: createHash("sha256").update(markdown).digest("hex"),
          materialized: !state.unmaterialized,
          projection: {
            contentKind: "plaintext" as const,
            sourceStateVectorSha256: "a".repeat(64),
            destructive: false,
          },
        };
        await options.onSettled?.(result, token);
        // The array is what LANDED on disk. An unmaterialized settle
        // committed the lineage and wrote nothing.
        if (!state.unmaterialized) state.settledMarkdowns.push(markdown);
        if (state.emitUpdateAfterSettle) {
          // A peer's update lands after this settle resolved: the close
          // that follows cannot vouch for it. It must be a REAL update —
          // an undecodable one throws inside the settle instead, which
          // re-arms the ladder on its own and proves nothing.
          state.emitUpdateAfterSettle = false;
          deliverPeerEdit("peer edit");
        }
        return result;
      },
      async applyExternalMarkdownEdit(markdown) {
        return { kind: "merged", markdown } as const;
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
        // ORDER, copied from the provider: the pre-close settle runs FIRST,
        // and only then is the release attempted. A release that fails has
        // still run its settle, so `closeFailure` cannot be checked up here.
        let preCloseError: unknown = null;
        if (closeOptions?.settle === false) {
          state.closesWithSettleFalse += 1;
        } else {
          // The pre-close settle, same contract as settleNow: refuses while
          // locked, records the settled markdown when it lands.
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
            state.settledMarkdowns.push(doc.getText("plainText").toString());
          }
        }
        // The RELEASE. Its failure is what reaches the caller, and it buries
        // the pre-close settle's failure exactly as the provider does.
        if (state.closeFailure) {
          // `settle: false` is a PREFERENCE, not a promise. A daemon that
          // refuses the release as unsettled makes the provider ESCALATE to a
          // settling close so pending edits survive a transient failure — and
          // that close MATERIALIZES the artifact on its way out.
          // `settleOnRefusal: false` is the only thing that turns it off.
          if (
            closeOptions?.settle === false &&
            closeOptions?.settleOnRefusal !== false
          ) {
            state.settleCalls.push(gen);
            if (!state.locked && !state.unmaterialized) {
              state.settledMarkdowns.push(doc.getText("plainText").toString());
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
            throw new YdocReleasedWithSettleFailureError(
              options.path,
              preCloseError,
            );
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
    openRustYDocProviderSession: openProvider,
    onError: (context, error) => {
      state.errors.push(context);
      state.errorMessages.push(
        error instanceof Error ? error.message : String(error),
      );
    },
  });
  return { capture, state, loopback, workspaceId, rootPath };
}

/**
 * Open a document and journal ONE local edit through a renderer mirror.
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

function busyRefusal(): DaemonRefusalError {
  return new DaemonRefusalError(
    { code: "OVERLOADED", message: "engine-store-busy", retry: "afterBackoff" },
    new Error("daemon response"),
  );
}

it("absorbs a busy journal refusal instead of rebinding the generation", async () => {
  // #658, codex P1 on the desktop tail. The provider now keeps a journal write
  // the engine refused busy and re-arms its own ladder to resend it — and this
  // boundary read that rejection as a broken generation and rebound, which
  // CLOSES the provider and cancels the retry it just armed. If the
  // replacement's replay met the same busy store, adoptGeneration marked the
  // session dead with no timer behind it: the canonical Y.Doc lived in memory
  // and the .md stayed stale until some unrelated edit.
  //
  // Three edits while the store stays busy is the spiral: under the old code
  // each one rebound again.
  //
  // MUTATION: drop the `isTransientEngineCause` branch from the local-update
  // catch -> the generation count climbs with every edit.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-busy-journal-");
  const { session, mirror } = await openWithOneEdit(capture, "first edit ");
  expect(state.generation).toBe(1);

  state.recordFailure = busyRefusal();
  typeInto(mirror, session, "second ");
  typeInto(mirror, session, "third ");
  typeInto(mirror, session, "fourth ");
  await new Promise((resolve) => setTimeout(resolve, 200));

  // THE assertion: no rebind, no reopen. The retry lives one layer down.
  expect(state.generation).toBe(1);
  expect(state.openAttempts).toBe(1);

  // The contention clears and the session — never torn down — settles the
  // text it was holding the whole time.
  state.recordFailure = null;
  await session.settleNow();
  const settled = state.settledMarkdowns.at(-1) ?? "";
  for (const text of ["first edit", "second", "third", "fourth"]) {
    expect(settled).toContain(text);
  }
  await capture.stop();
}, 20_000);

it("still rebinds when a journal write fails for a cause nobody is retrying", async () => {
  // The narrowness guard, and the reason this classifies instead of absorbing
  // everything: only the transient class has a retry behind it. A generation
  // that failed for any other reason still needs replacing, and swallowing
  // that would strand the edit with nothing arranged to carry it.
  //
  // MUTATION: absorb every error at the local-update catch -> no replacement
  // generation is ever opened.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-journal-terminal-");
  const { session, mirror } = await openWithOneEdit(capture, "first edit ");
  expect(state.generation).toBe(1);

  state.recordFailure = new Error("persist-failed");
  typeInto(mirror, session, "stranded ");
  await expect.poll(() => state.generation, { timeout: 10_000 }).toBe(2);

  await capture.stop();
}, 20_000);

it("re-arms a pending locked settle on the generation that replaces a dead one", async () => {
  // #595 codex P2: the locked retry ladder lives in the generation and dies
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

  // The daemon dies and the lock releases while the shell reconnects. No
  // further edit happens.
  state.locked = false;
  state.generationOptions[0]!.onSessionError?.(
    Object.assign(new Error("daemon exited"), { code: "transport-error" }),
  );

  // The replacement generation settles BY ITSELF, and the settle carries the
  // journaled edit the lock blocked.
  await expect.poll(() => state.settleCalls, { timeout: 5_000 }).toEqual([1, 2]);
  await expect.poll(() => state.settledMarkdowns, { timeout: 5_000 }).toEqual([
    "locked edit",
  ]);

  await session.close({ settle: false }).catch(() => undefined);
  await capture.stop();
});

it("a rebind with no pending locked settle settles nothing on its own", async () => {
  // The inverse guard: adoption must not settle every replacement — only one
  // that owes a locked write. A successful settle clears the debt first.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-clean-rebind-");
  const session = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });

  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);
  const before = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(0, "settled edit");
  await session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));

  // Locked once, then settled clean: the debt is paid before the restart.
  state.locked = true;
  await expect(session.settleNow()).rejects.toThrow("file-locked");
  state.locked = false;
  await session.settleNow();
  expect(state.settleCalls).toEqual([1, 1]);

  state.generationOptions[0]!.onSessionError?.(
    Object.assign(new Error("daemon exited"), { code: "transport-error" }),
  );
  await expect.poll(() => state.generation, { timeout: 5_000 }).toBe(2);
  // Give the adoption a beat: nothing may settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(state.settleCalls).toEqual([1, 1]);

  await session.close({ settle: false }).catch(() => undefined);
  await capture.stop();
});

it("pays a locked close debt by itself once the lock releases", async () => {
  // #595 round 3: the locked retry died with the DOCUMENT close — the
  // renderer forgets the session on a failed close and main swallows the
  // error, so the durably pending write sat until restart. The capture
  // entry outlives them both and retries the teardown (which re-runs the
  // pre-close settle) until the lock releases.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-locked-close-");
  const { session } = await openWithOneEdit(capture, "closing edit");

  state.locked = true;
  await expect(session.close()).rejects.toThrow("file-locked");

  // The lock releases after the renderer already gave up. No reopen and no
  // restart: the capture layer's own retry pays the debt.
  state.locked = false;
  await expect
    .poll(() => state.settledMarkdowns, { timeout: 15_000 })
    .toEqual(["closing edit"]);
  await capture.stop();
}, 20_000);

it("a close that fails for a non-lock cause is not retried by the capture layer", async () => {
  // The inverse guard: only the lock is worth polling. A terminal teardown
  // failure keeps the failing-close entry for the existing force-close and
  // teardown paths, with no timer behind it.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-terminal-close-");
  const { session } = await openWithOneEdit(capture, "stranded edit");

  state.closeFailure = new Error("persist-failed");
  await expect(session.close()).rejects.toThrow("persist-failed");
  state.closeFailure = null;

  // The pre-close settle ran BEFORE the release and landed — the release is
  // what failed. This suite used to assert the opposite (nothing settled),
  // which was the fake's ordering, not the provider's: `close()` settles
  // first and only then asks the daemon to release (#595 round 15 fake audit).
  expect(state.settledMarkdowns).toEqual(["stranded edit"]);
  const settlesAtFailure = state.settleCalls.length;

  // THE invariant this test owns: only a LOCK is worth polling. Past the
  // first retry delay, no timer has re-run the teardown — no new settle, no
  // new generation.
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  expect(state.settleCalls).toHaveLength(settlesAtFailure);
  expect(state.generation).toBe(1);
  await capture.stop();
}, 10_000);

it("retries a close the engine refused because its own store was busy", async () => {
  // #658, the close half of the same answer. A busy engine database clears by
  // waiting exactly as a file lock does, so a teardown refused for it re-arms
  // beside the lock. Left out of the ladder it read as a terminal failure:
  // the entry stayed failing-close with the daemon still holding its lease,
  // and nothing would run again until restart.
  //
  // MUTATION: narrow `isTransientCloseCause` back to `isFileLockedCause` and
  // no second close is ever attempted.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-busy-close-");
  const { session } = await openWithOneEdit(capture, "closing edit");

  state.closeFailure = new DaemonRefusalError(
    { code: "OVERLOADED", message: "engine-store-busy", retry: "afterBackoff" },
    new Error("daemon response"),
  );
  await expect(session.close()).rejects.toThrow("engine-store-busy");
  const closesAtFailure = state.closeCalls.length;

  // The contention clears after the renderer has already given up. The
  // capture entry outlives it and finishes the teardown by itself.
  state.closeFailure = null;
  await expect
    .poll(() => state.closeCalls.length, { timeout: 15_000 })
    .toBeGreaterThan(closesAtFailure);
  await capture.stop();
}, 20_000);

it("pays a locked close debt even when a replicated release succeeds", async () => {
  // #595 round 4: a replicated lineage compacts on release without the
  // local-only pending-job guard, so the close RELEASES over the locked
  // settle — the session and its entry are gone, and the per-entry ladder
  // with them. The detached retry reopens enough state to settle once the
  // lock releases: no reopen by anyone else, no restart.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-replicated-close-",
  );
  const { session } = await openWithOneEdit(capture, "replicated edit");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  state.locked = false;
  await expect
    .poll(() => state.settledMarkdowns, { timeout: 15_000 })
    .toEqual(["replicated edit"]);
  await capture.stop();
}, 20_000);

it("a replicated release with a non-lock settle failure arms no detached retry", async () => {
  // The inverse guard: only the lock is worth reopening for. A terminal
  // settle failure under a succeeded release stays what it was — loud once,
  // then nothing scheduled.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-replicated-terminal-",
  );
  const { session } = await openWithOneEdit(capture, "terminal edit");

  state.replicated = true;
  state.closeSettleFailure = new Error("persist-failed");
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );
  state.closeSettleFailure = null;

  // Past the first retry delay: no reopen, nothing settled.
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  expect(state.generation).toBe(1);
  expect(state.settledMarkdowns).toEqual([]);
  await capture.stop();
}, 10_000);

it("the version fence drops a detached locked retry after a switch", async () => {
  // #595 round 5 P1: the debt was armed for the version the document lived
  // in. If the workspace moves before the timer fires, reopening the OLD
  // version outside the capture chain could write its projection over the
  // active version. The retry runs on the chain and fences on the active
  // version at fire time: dropped, with a trace — the fence replay owns
  // pending writes across switches.
  const { capture, state, loopback, workspaceId } = await lockedRebindCapture(
    "dohc-ydoc-fence-drop-",
  );
  const { session } = await openWithOneEdit(capture, "old version edit");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The workspace moves to a new version while the timer sleeps, and the
  // lock releases.
  const ensured = await loopback.sendRequest({
    id: 9_001,
    method: "versions.ensureMain",
    workspace: workspaceId,
    params: { workspaceId },
  });
  const main = ensured.result as { id?: string };
  const created = await loopback.sendRequest({
    id: 9_002,
    method: "versions.createNamed",
    workspace: workspaceId,
    params: {
      workspaceId,
      name: "fence-target",
      fromVersionId: main.id ?? "main",
    },
    idempotencyKey: "fence-create-1",
  } as Parameters<typeof loopback.sendRequest>[0]);
  const createdVersion = created.result as { id?: string };
  await loopback.sendRequest({
    id: 9_003,
    method: "versions.setActive",
    workspace: workspaceId,
    params: { workspaceId, versionId: createdVersion.id! },
  });
  state.locked = false;

  // The fence drops the debt: no reopen of the old version, nothing written,
  // and the drop leaves a trace.
  await expect
    .poll(
      () => state.errors.filter((context) => context.includes("close retry")),
      { timeout: 15_000 },
    )
    .toHaveLength(1);
  expect(state.generation).toBe(1);
  expect(state.settledMarkdowns).toEqual([]);
  await capture.stop();
}, 20_000);

it("a reopen before the timer fires receives the locked debt, not silence", async () => {
  // #595 round 5 P2: opening a document settles nothing by itself, so a
  // stand-down that merely SEES the live session would strand the pending
  // write until the user happens to edit. The retry transfers the debt: it
  // asks the live session to settle, and that session's own machinery owns
  // it from there.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-debt-transfer-");
  const { session } = await openWithOneEdit(capture, "transferred edit");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The user reopens the document before the retry fires, then the lock
  // releases. No edit ever happens in the reopened session.
  const reopened = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  expect(state.generation).toBe(2);
  state.locked = false;

  await expect
    .poll(() => state.settledMarkdowns, { timeout: 15_000 })
    .toEqual(["transferred edit"]);
  // The debt was paid THROUGH the live session — no detached reopen.
  expect(state.generation).toBe(2);
  await reopened.close({ settle: false });
  await capture.stop();
}, 20_000);

it("a rename drains the detached locked debt before touching disk", async () => {
  // #595 round 6: with the session gone and the timer sleeping, a rename
  // would read the STALE pre-lock artifact and carry old bytes to the new
  // path, leaving the retry aimed at the moved-from file. Rename is another
  // lifecycle edge: it finds the debt in the registry and pays it FIRST, on
  // the same chain, before reading anything from disk.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-rename-drain-",
  );
  await writeFile(join(rootPath, "note.md"), "stale pre-lock artifact\n", "utf8");
  const { session } = await openWithOneEdit(capture, "renamed edit");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The lock releases; before the timer fires, the user renames the file.
  state.locked = false;
  const finish = await capture.beginFileRename("note.md", "renamed.md");
  // The debt was paid BEFORE the rename proceeded: the pending write settled
  // through a detached reopen, not left targeting a dead path.
  expect(state.settledMarkdowns).toEqual(["renamed edit"]);
  expect(state.generation).toBe(2);
  await finish(true);
  await capture.stop();
}, 20_000);

it("a destructive delete cancels the detached locked debt instead of recreating the file", async () => {
  // #595 round 7: the user deleted the file. A delayed payment reopening the
  // path would RECREATE it — the clobber inverted — so the destructive
  // vacate cancels the debt with a trace. Nothing durable is lost: the
  // edits stay in the object's lineage.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-delete-cancel-");
  const { session } = await openWithOneEdit(capture, "deleted edit");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The user deletes the file, then the lock releases.
  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");
  finishDelete(true); // the delete succeeded: the path is provably gone
  state.locked = false;

  // The cancel left a trace, and the retry window passes with no reopen and
  // no settle: the deleted file is not recreated.
  await expect
    .poll(
      () => state.errors.filter((context) => context.includes("close retry")),
      { timeout: 5_000 },
    )
    .toHaveLength(1);
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  expect(state.generation).toBe(1);
  expect(state.settledMarkdowns).toEqual([]);
  await capture.stop();
}, 15_000);

it("a delete cancels a debt that registered while the disk delete was in flight", async () => {
  // #595 round 14 (codex P2). The suspension snapshots the registry, but the
  // filesystem delete runs OFF the capture chain — so an open of the same
  // path can land on the chain while the delete is still running, meet the
  // lock, and register a debt the finisher never saw. Cancelling only the
  // snapshot left that debt armed, and its ladder recreates the file the user
  // just deleted. The finisher rescans instead.
  //
  // MUTATION: cancel `suspended` alone -> the second debt survives, its
  // ladder opens a third generation, and the deleted path is settled back
  // onto disk.
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
  await expect(first.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The delete starts: live sessions are vacated and the debt is suspended.
  // The disk work has NOT finished, so the finisher has not been called.
  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");

  // Another window opens the same document inside that window and meets the
  // same lock. This registers a SECOND debt, invisible to the snapshot above.
  const second = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const secondDoc = new Y.Doc();
  Y.applyUpdate(secondDoc, second.initialUpdate);
  const secondBefore = Y.encodeStateVector(secondDoc);
  secondDoc.getText("plainText").insert(0, "raced edit");
  await second.applyLocalUpdate(Y.encodeStateAsUpdate(secondDoc, secondBefore));
  await expect(second.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );
  const generationAtDelete = state.generation;

  // The delete succeeded. BOTH debts are cancelled: the path is provably gone.
  finishDelete(true);
  state.locked = false;

  // THE FACT, asserted first: the deleted path is not reopened and nothing is
  // settled back onto it. A trace count would only prove the finisher ran.
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  expect(state.generation).toBe(generationAtDelete);
  expect(state.settledMarkdowns).toEqual([]);
  // And both debts said so out loud.
  expect(
    state.errors.filter((context) => context.includes("close retry")),
  ).toHaveLength(2);
  await capture.stop();
}, 20_000);

it("a moved-away directory cancels detached locked debts under its prefix", async () => {
  // Same rule, prefix shape: moving or deleting `dir` must not let a debt
  // for `dir/note.md` rebuild the moved-from tree.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-dir-cancel-");
  const session = await capture.openYDocSession({
    path: "dir/note.md",
    onRemoteUpdate: () => undefined,
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);
  const before = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(0, "moved-away edit");
  await session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("dir");
  finishDelete(true);
  state.locked = false;

  await expect
    .poll(
      () => state.errors.filter((context) => context.includes("close retry")),
      { timeout: 5_000 },
    )
    .toHaveLength(1);
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  expect(state.generation).toBe(1);
  expect(state.settledMarkdowns).toEqual([]);
  await capture.stop();
}, 15_000);

it("a FAILED delete restores the detached locked debt instead of cancelling it", async () => {
  // #595 round 8: the same no-delete-share handle that blocks the write can
  // block the OS trash AND the workspace-trash fallback. Cancelling on the
  // ATTEMPT would strand the promised write forever over a file that is
  // still there. The finisher takes the outcome: a failed delete restores
  // and re-arms, so the release still lands the write.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-delete-failed-");
  const { session } = await openWithOneEdit(capture, "survives a failed delete");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The delete is attempted and FAILS (the same handle blocks it).
  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");
  finishDelete(false);
  state.locked = false;

  // The debt survived the failed attempt and pays itself once the lock goes.
  await expect
    .poll(() => state.settledMarkdowns, { timeout: 15_000 })
    .toEqual(["survives a failed delete"]);
  await capture.stop();
}, 20_000);

it("a rename REFUSES while its debt payment is still locked", async () => {
  // #595 round 8: the payment RESOLVES when it merely re-armed against a
  // still-held lock. Proceeding would read the stale pre-lock artifact and
  // commit it through writeIfChanged — replacing the canonical Y.Doc head
  // with pre-lock text, which the finisher's path rollback cannot undo. The
  // registry is the proof: still named means it did not land, so the rename
  // refuses and the debt stays.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-rename-locked-",
  );
  await writeFile(join(rootPath, "note.md"), "stale pre-lock artifact\n", "utf8");
  const { session } = await openWithOneEdit(capture, "must not be lost");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The lock STILL holds when the rename runs: it must refuse, naming the
  // blocker and the way out, and nothing may be written.
  await expect(capture.beginFileRename("note.md", "renamed.md")).rejects.toThrow(
    /Another program still has note\.md open/,
  );
  expect(state.settledMarkdowns).toEqual([]);

  // The debt survived the refusal: releasing the lock still lands the write.
  state.locked = false;
  await expect
    .poll(() => state.settledMarkdowns, { timeout: 15_000 })
    .toEqual(["must not be lost"]);
  await capture.stop();
}, 25_000);

it("a failed release keeps the debt instead of dropping it", async () => {
  // #595 round 8: a replicated update arriving between the retry's settle
  // and its release makes `settle: false` escalate to a settling close,
  // which can fail. Swallowing that dropped the debt while the daemon
  // session could stay reserved and the newest update had no retry. The
  // failure reaches the handler, which retains and re-arms — the next
  // attempt completes the release.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-release-failed-");
  const { session } = await openWithOneEdit(capture, "release fails once");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The lock releases, but the retry's own RELEASE keeps failing.
  state.locked = false;
  state.replicated = false;
  state.closeFailure = new Error("ydoc-unsettled-close");
  await expect
    .poll(
      () => state.errors.filter((context) => context.includes("close retry")),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);
  const closesAtFailure = state.closeCalls.length;
  const generationAtFailure = state.generation;

  // THE proof of retention: with the debt dropped, nothing would ever run
  // again. It is retained, so attempts keep coming — and #595 round 9:
  // they retry the RETAINED session's own close. The daemon reinserted
  // that session and kept its lease, so opening a fresh one would be
  // refused ydoc-session-busy forever; a growing generation count here
  // would mean exactly that bug.
  await expect
    .poll(() => state.closeCalls.length, { timeout: 15_000 })
    .toBeGreaterThan(closesAtFailure);
  expect(state.generation).toBe(generationAtFailure);
  state.closeFailure = null;
  await expect
    .poll(() => state.settledMarkdowns.length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  await capture.stop();
}, 25_000);


it("a directory move drains a detached debt under its prefix", async () => {
  // #595 round 9: beginFileRename serves directory moves too, so a debt for
  // `dir/note.md` rides a move of `dir`. Left behind, its delayed payment
  // reopens the moved-from path and recreates the tree the user just moved
  // away. The endpoint scan is prefix-based, like the delete seam's.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-dirmove-drain-",
  );
  await mkdir(join(rootPath, "dir"), { recursive: true });
  await writeFile(join(rootPath, "dir", "note.md"), "stale artifact\n", "utf8");
  const session = await capture.openYDocSession({
    path: "dir/note.md",
    onRemoteUpdate: () => undefined,
  });
  const rendererDoc = new Y.Doc();
  Y.applyUpdate(rendererDoc, session.initialUpdate);
  const before = Y.encodeStateVector(rendererDoc);
  rendererDoc.getText("plainText").insert(0, "moved edit");
  await session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The lock releases; the user moves the whole directory.
  state.locked = false;
  const finish = await capture.beginFileRename("dir", "moved");
  // The descendant's debt was paid BEFORE the move proceeded.
  expect(state.settledMarkdowns).toEqual(["moved edit"]);
  await finish(true);
  await capture.stop();
}, 20_000);

it("a move cancels a debt that registered while the disk move was in flight", async () => {
  // The move seam's half of the delete fence. `beginFileRename` drains the
  // debts it can SEE, then hands back a finisher and releases the capture
  // chain — and main awaits the filesystem move off that chain. Another window
  // can open the source in that window, meet the lock, and register a debt the
  // drain never saw. Left armed, its ladder reopens the moved-from path and
  // recreates the file the user just moved away.
  //
  // MUTATION: drop the rescan from the finisher's `ok` branch -> the ladder
  // opens a third generation over the source path.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-move-race-",
  );
  await writeFile(join(rootPath, "note.md"), "stale artifact\n", "utf8");

  // The move starts with a clean registry, so it prepares instead of refusing.
  const finishMove = await capture.beginFileRename("note.md", "moved.md");

  // Another window opens the source inside the move window and meets the lock.
  const { session } = await openWithOneEdit(capture, "raced during the move");
  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );
  const generationAtMove = state.generation;

  // The move landed. The late debt is cancelled with it.
  await finishMove(true);
  state.locked = false;

  // THE FACT: the moved-from path is never reopened and nothing is settled
  // back onto it.
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  expect(state.generation).toBe(generationAtMove);
  expect(state.settledMarkdowns).toEqual([]);
  await capture.stop();
}, 20_000);

it("a move window stops a debt's payment before it ever reaches the daemon", async () => {
  // The fence above cancels REGISTRY ENTRIES, off the capture chain, AFTER the
  // disk move. That is too late for a payment already parked in its settle RPC:
  // the cancel lands at the client while the daemon writes the moved-from path,
  // and a settle cannot be recalled (#663).
  //
  // This test used to park the ladder at its session OPEN and lean on the
  // re-check in `settleForProof` to stop it on the way out. The removal window
  // refuses the payment a step earlier — it never opens, so nothing is ever in
  // flight to be caught. That construction is no longer reachable, and the
  // stronger fact replaces it.
  //
  // MUTATION: drop the removal-window check in `payDetachedLockedDebt` -> the
  // ladder opens a second generation over the moved-from path and settles
  // "mid-flight edit" onto it while the disk move is still running.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-move-inflight-",
  );
  await writeFile(join(rootPath, "note.md"), "stale artifact\n", "utf8");

  const finishMove = await capture.beginFileRename("note.md", "moved.md");
  const { session } = await openWithOneEdit(capture, "mid-flight edit");
  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );
  const attemptsAtMove = state.openAttempts;

  // The lock releases while the disk move is still running, so every rung of
  // the ladder from here on would settle the moved-from path. The wait is past
  // the ladder's 1 s first rung; `flush()` then drains the capture chain, so
  // the assertion never has to guess whether a payment already ran.
  state.locked = false;
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  await capture.flush();

  // THE FACT: no reopen of the moved-from path, and nothing written to it.
  expect(state.openAttempts).toBe(attemptsAtMove);
  expect(state.settledMarkdowns).toEqual([]);

  await finishMove(true);
  await capture.stop();
}, 25_000);

it("a delete window refuses a debt's payment while the disk delete is unfinished", async () => {
  // #663. The fence above cancels REGISTRY ENTRIES from the finisher, which
  // runs off the capture chain AFTER the disk delete. A payment that starts
  // inside that window passes every check, reaches its settle, and parks in the
  // RPC — and the cancel then lands at the client while the daemon is already
  // writing the path the user just deleted. A settle cannot be recalled, so the
  // window itself has to refuse the payment.
  //
  // Driven through the INLINE door (`beginFileRename` pays a matching debt on
  // the chain), so every step is awaited and no timer decides the outcome. It
  // is the same predicate the ladder's timer-driven payment consults — the
  // test below covers that door end to end.
  //
  // MUTATION: drop the removal-window check in `payDetachedLockedDebt` -> the
  // drain reopens the path mid-delete and settles it, so `settledMarkdowns`
  // holds "written mid-delete" and the rename no longer refuses.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-delete-window-",
  );
  await writeFile(join(rootPath, "note.md"), "stale artifact\n", "utf8");

  // The delete starts. Its disk work has not reported, so the finisher is held.
  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");

  // The document is opened again while the delete is unfinished, and meets the
  // lock — registering a debt the suspension snapshot never saw.
  const { session } = await openWithOneEdit(capture, "written mid-delete");
  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );
  const generationAtDelete = state.generation;

  // The lock is GONE — nothing but the window can hold this payment now.
  state.locked = false;

  // A rename drains matching debts on the chain. The window refuses that
  // payment, so the debt is still owed and the rename refuses in turn — naming
  // the delete, because "close that program" would send the user after a lock
  // that no longer exists.
  await expect(capture.beginFileRename("note.md", "renamed.md")).rejects.toThrow(
    /dohc is still deleting note\.md\./,
  );

  // THE FACT: the path being deleted was never reopened and never written.
  expect(state.settledMarkdowns).toEqual([]);
  expect(state.generation).toBe(generationAtDelete);

  finishDelete(true);
  await capture.stop();
}, 20_000);

it("a delete window that closes hands the debt back instead of stranding it", async () => {
  // The other half of the same rule: the fence is an INTERVAL, not a verdict.
  // The same no-share handle that blocks the write blocks the trash and the
  // workspace-trash fallback too, so a delete that FAILS must leave the path
  // owing its write — and the payment the window refused must land as soon as
  // the window closes.
  //
  // MUTATION: never call `closeRemovalWindow` in the finisher -> the drain is
  // refused forever and the rename throws instead of settling.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-delete-window-release-",
  );
  await writeFile(join(rootPath, "note.md"), "stale artifact\n", "utf8");

  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");
  const { session } = await openWithOneEdit(capture, "survives the window");
  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );
  state.locked = false;

  // The delete FAILED. The path is still there and still owes its write.
  finishDelete(false);

  // The very next drain lands it — no timer, no backoff, nothing stranded.
  const finish = await capture.beginFileRename("note.md", "renamed.md");
  expect(state.settledMarkdowns).toEqual(["survives the window"]);
  await finish(true);
  await capture.stop();
}, 20_000);

it("a failed move holds its window across the rollback, not just up to it", async () => {
  // codex on #696. A finisher that closes the window and THEN calls
  // `enqueueResult("rename rollback", …)` has only APPENDED the rollback: work
  // already queued on the capture chain runs first, against an engine whose
  // object sits at `moved.md` while the file is still at `note.md`. A payment
  // released into that gap settles `note.md` against an identity that is about
  // to stop existing. The move is not over until its engine state is back.
  //
  // The ORDER is forced, not timed: a parked provider open holds the chain, the
  // ladder's payment queues behind it, and the finisher's rollback queues
  // behind the payment. Releasing the gate runs payment-then-rollback.
  //
  // TWO MUTATIONS, one per assertion, because this test owns both halves of
  // the engine finisher's failure path:
  //   - close the window before the rollback is enqueued -> the payment runs
  //     in the gap and `settledMarkdowns` already holds the edit when the
  //     finisher resolves.
  //   - never close it -> the debt never discharges and the second assertion
  //     times out. (This is why the separate engine-finisher release test was
  //     dropped: verified subsumed, by running that mutation against this test
  //     alone.)
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-move-rollback-gap-",
  );
  await writeFile(join(rootPath, "note.md"), "stale artifact\n", "utf8");

  // An engine-coordinated rename, so a rollback exists at all.
  const finishMove = await capture.beginFileRename("note.md", "moved.md");

  // A debt for the source registers inside the move window and arms its ladder.
  const { session } = await openWithOneEdit(capture, "written in the rollback gap");
  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );
  state.locked = false;

  // HOLD THE CHAIN. An open is a chain task, so parking one keeps every later
  // task queued — including the ladder's payment and, after it, the rollback.
  let releaseOpen!: () => void;
  state.openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const parked = capture.openYDocSession({
    path: "other.md",
    onRemoteUpdate: () => undefined,
  });
  await expect
    .poll(() => state.openAttempts, { timeout: 15_000 })
    .toBeGreaterThan(1);

  // Long enough for a rung of the ladder to fire while the chain is held: the
  // first is 1 s and the next 2 s, so one payment is queued either way.
  await new Promise((resolve) => setTimeout(resolve, 2_500));

  // The disk move FAILED. The rollback is appended behind the queued payment.
  const finishing = finishMove(false);
  releaseOpen();
  await finishing;

  // THE FACT: the payment did not run in the gap. Had it, it would have settled
  // the source against the engine's mid-move identity.
  expect(state.settledMarkdowns).toEqual([]);

  // And the window did end with the rollback: the debt discharges cleanly on
  // its next rung, with the engine object back at note.md.
  await expect
    .poll(() => state.settledMarkdowns, { timeout: 15_000 })
    .toEqual(["written in the rollback gap"]);

  await (await parked).close({ settle: false });
  await capture.stop();
}, 30_000);

it("a move window that closes hands the debt back, on the no-op finisher", async () => {
  // The other finisher. `beginFileRename` returns a no-op for everything the
  // engine rename declines — folders, binary, untracked paths — and the window
  // it opened is just as real, so the no-op has to close it too.
  //
  // MUTATION: drop `closeRemovalWindow()` from `noop` -> the second move
  // refuses instead of draining the descendant's debt.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-foldermove-release-",
  );
  await mkdir(join(rootPath, "dir"), { recursive: true });
  await writeFile(join(rootPath, "dir", "note.md"), "stale artifact\n", "utf8");

  const finishMove = await capture.beginFileRename("dir", "moved");
  const { session } = await openWithOneEdit(
    capture,
    "survives a failed folder move",
    "dir/note.md",
  );
  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );
  state.locked = false;

  await finishMove(false);

  // The next move drains the descendant's debt by prefix, exactly as the
  // first one would have.
  const finish = await capture.beginFileRename("dir", "moved");
  expect(state.settledMarkdowns).toEqual(["survives a failed folder move"]);
  await finish(true);
  await capture.stop();
}, 20_000);

it("a debt's ladder settles nothing while its path's delete is in flight", async () => {
  // #663 at the door that actually hurts: the ladder's own timer. The test
  // above pins the predicate deterministically through the inline drain; this
  // one pins the product fact, because a real delete races the ladder, not a
  // rename. The wait is past the ladder's 1 s first rung, and `flush()` then
  // drains the capture chain, so the assertion never has to guess whether the
  // payment already ran.
  //
  // MUTATION: drop the removal-window check in `payDetachedLockedDebt` -> the
  // ladder opens a fresh generation over the deleted path and settles
  // "written by the ladder" onto it.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-delete-ladder-");
  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");

  const { session } = await openWithOneEdit(capture, "written by the ladder");
  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );
  const generationAtDelete = state.generation;

  // The lock releases while the disk delete is still running: every rung of
  // the ladder from here on would settle, and every one must be refused.
  state.locked = false;
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  await capture.flush();

  expect(state.generation).toBe(generationAtDelete);
  expect(state.settledMarkdowns).toEqual([]);

  // The delete landed. The debt the window held is cancelled with a trace, and
  // the deleted path stays deleted.
  finishDelete(true);
  await expect
    .poll(
      () => state.errors.filter((context) => context.includes("close retry")),
      { timeout: 5_000 },
    )
    .toHaveLength(1);
  expect(state.settledMarkdowns).toEqual([]);
  await capture.stop();
}, 25_000);

it("a folder move fences late debts too, on the no-op finisher path", async () => {
  // `beginFileRename` returns a NO-OP finisher for everything the engine
  // rename declines — folders, binary, untracked paths — but the disk move
  // still happens, so a late debt recreates the moved-from tree just the same.
  // The test above covers the engine-rename finisher; without this one, the
  // no-op path carries the fix untested (verified: mutating only the no-op
  // finisher leaves the test above green).
  //
  // MUTATION: return a bare `async () => {}` no-op again -> the descendant's
  // ladder opens a second generation over `dir/note.md`.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-foldermove-race-",
  );
  await mkdir(join(rootPath, "dir"), { recursive: true });
  await writeFile(join(rootPath, "dir", "note.md"), "stale artifact\n", "utf8");

  // A directory is not engine-renamable text, so this hands back the no-op.
  const finishMove = await capture.beginFileRename("dir", "moved");

  const { session } = await openWithOneEdit(
    capture,
    "raced during the folder move",
    "dir/note.md",
  );
  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );
  const generationAtMove = state.generation;

  await finishMove(true);
  state.locked = false;

  await new Promise((resolve) => setTimeout(resolve, 1_600));
  expect(state.generation).toBe(generationAtMove);
  expect(state.settledMarkdowns).toEqual([]);
  await capture.stop();
}, 20_000);

it("refused renames never stack more than one retry ladder", async () => {
  // #595 round 9: a refused rename reaches the debt's arming path while its
  // ORIGINAL timer is still scheduled. Stacking them gave every rename
  // attempt an independent ladder, each opening and settling its own
  // temporary session once it hit the cap — engine load proportional to how
  // often someone tried to rename. One debt, one timer.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-one-timer-",
  );
  await writeFile(join(rootPath, "note.md"), "stale artifact\n", "utf8");
  const { session } = await openWithOneEdit(capture, "one ladder only");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // Four refused renames while the lock holds: each pays, fails, and arms.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await expect(capture.beginFileRename("note.md", "renamed.md")).rejects.toThrow(
      /Another program still has note\.md open/,
    );
  }
  const settlesAfterRenames = state.settleCalls.length;

  // THE measurement, taken while the lock still HOLDS: this is where
  // stacked ladders cost. Each one wakes on its own schedule and opens and
  // settles its own temporary session, so N ladders do N times the engine
  // work every cycle. One ladder on a doubling delay (1s, 2s, 4s...) can
  // fit at most three attempts in this window; four stacked ladders fit
  // far more. The bound is deliberately generous — it fails on the
  // MULTIPLE, not on exact timing.
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  const attemptsWhileLocked = state.settleCalls.length - settlesAfterRenames;
  // Correct: the one surviving timer sits at the doubled delay (8s by now),
  // so nothing fires in this window. Stacked: the 1s, 2s and 4s ladders all
  // wake inside it.
  expect(attemptsWhileLocked).toBeLessThanOrEqual(1);

  // And the single ladder still pays the debt once the lock releases.
  state.locked = false;
  await expect
    .poll(() => state.settledMarkdowns, { timeout: 15_000 })
    .toEqual(["one ladder only"]);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(state.settledMarkdowns).toEqual(["one ladder only"]);
  await capture.stop();
}, 30_000);

it("a failing active-version read re-arms instead of stranding the debt", async () => {
  // #595 round 9: the version read sat before the guarded block, so a
  // rejection (reconnect ladder exhausted, engine refusing the read) left
  // the debt in the registry with NO timer — stranded until an unrelated
  // lifecycle action or a restart. Inside the block it re-arms like any
  // other failure.
  const { capture, state, loopback } = await lockedRebindCapture(
    "dohc-ydoc-version-read-fails-",
  );
  const { session } = await openWithOneEdit(capture, "survives a failed read");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The active-version read fails while the retry ladder runs.
  const realSend = loopback.sendRequest.bind(loopback);
  let failVersionReads = true;
  loopback.sendRequest = async (request) => {
    if (failVersionReads && request.method === "versions.active") {
      throw new Error("version read unavailable");
    }
    return await realSend(request);
  };
  state.locked = false;

  // The debt was NOT stranded: once the read works again, the write lands.
  await expect
    .poll(
      () => state.errors.filter((context) => context.includes("close retry")),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);
  failVersionReads = false;
  await expect
    .poll(() => state.settledMarkdowns, { timeout: 15_000 })
    .toEqual(["survives a failed read"]);
  await capture.stop();
}, 30_000);


it("a handoff to a live session keeps the debt when that settle fails", async () => {
  // #595 round 10: the transfer was fire-and-forget — it dropped the debt on
  // the mere EXISTENCE of a live session. That settle can exhaust its own
  // reconnect retry, and the receiving generation never saw the original
  // lock refusal, so nothing there re-arms: the durable Y.Doc holds the edit
  // while the artifact stays stale until an unrelated action or a restart.
  // The handoff is awaited, and a failure keeps the debt.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-handoff-");
  const { session } = await openWithOneEdit(capture, "handed off");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The user reopens the document, and the handoff settle FAILS for a
  // non-lock reason.
  state.locked = false;
  state.settleFailure = new Error("workspace unavailable");
  const reopened = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  await expect
    .poll(
      () => state.errors.filter((context) => context.includes("close retry")),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);

  // The debt was NOT dropped on the failed handoff: once settles work, the
  // write lands without any new edit.
  state.settleFailure = null;
  await expect
    .poll(() => state.settledMarkdowns, { timeout: 15_000 })
    .toEqual(["handed off"]);
  await reopened.close({ settle: false });
  await capture.stop();
}, 30_000);

it("cancelling a debt releases the session whose close was refused", async () => {
  // #595 round 10: a retained retry session is a live daemon LEASE. Deleting
  // a debt that holds one strands it, and restoring or recreating that path
  // then answers ydoc-session-busy until the daemon restarts. Cancelling
  // closes what it discards.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-discard-lease-");
  const { session } = await openWithOneEdit(capture, "leased edit");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The retry opens a session and its RELEASE is refused: the debt now holds
  // the only session that can free the lease.
  state.locked = false;
  state.closeFailure = new Error("ydoc-unsettled-close");
  // Wait for the RETRY's own release to be refused — generation 2's close,
  // not the original session's, which already ran above.
  await expect
    .poll(
      () => state.closeCalls.filter((generation) => generation === 2).length,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  const releasesBeforeCancel = state.closesWithSettleFalse;

  // The user deletes the path: the debt is cancelled — and must release.
  state.closeFailure = null;
  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");
  finishDelete(true);
  await expect
    .poll(() => state.closesWithSettleFalse, { timeout: 15_000 })
    .toBeGreaterThan(releasesBeforeCancel);
  await capture.stop();
}, 30_000);

it("a close that raced a newer update is not proof the write landed", async () => {
  // #595 round 10: an update arriving after settleNow resolves is not
  // covered by that settle. The close cancels its debounce and sends
  // settle: false, and a REPLICATED lineage compacts and releases without
  // the local-only unsettled guard — so the close succeeds over a
  // projection that never reached Markdown. Ok from the close proves the
  // RELEASE, not the write.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-raced-close-");
  const { session } = await openWithOneEdit(capture, "raced edit");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The retry's settle succeeds, then a peer update lands before its close.
  state.locked = false;
  state.emitUpdateAfterSettle = true;
  await expect
    .poll(() => state.settledMarkdowns.length, { timeout: 15_000 })
    .toBeGreaterThan(0);

  // The debt was NOT released by that close: another attempt follows and
  // settles the newer state.
  const settlesAfterRace = state.settleCalls.length;
  await expect
    .poll(() => state.settleCalls.length, { timeout: 15_000 })
    .toBeGreaterThan(settlesAfterRace);
  await capture.stop();
}, 30_000);

it("a retained session's settle is never proof, because it stopped hearing the document", async () => {
  // #595 round 14 (codex P2). Round 11 replaced a stored `settled: true` with
  // a live comparison so a later update would withdraw the proof by itself.
  // On the RETAINED path that comparison cannot move: `close()` unsubscribes
  // from remote updates before it asks the daemon to release, so a session
  // whose release was refused is deaf from that moment on. `updateSeq` freezes
  // at whatever the settle covered, the comparison keeps answering yes, and
  // the next successful release deletes the debt over an update the artifact
  // never received — the stored yes, wearing a comparison's clothes.
  //
  // The old test could not see this: it emitted the peer update DURING the
  // settle, while the session was still listening. This one puts the update
  // in the window that actually matters, and the fake now models the
  // unsubscribe the same way the provider does.
  //
  // MUTATION: drop `settleCovers = -1` at retention -> the retained release
  // discharges the debt, no further session opens, and the peer edit never
  // reaches settledMarkdowns.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-deaf-proof-");
  const { session } = await openWithOneEdit(capture, "deaf proof");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The retry settles cleanly. Its release is refused, and the peer update
  // lands inside that refused close — after the unsubscribe, so this session
  // never hears it, while the durable lineage does.
  state.locked = false;
  state.closeFailure = new Error("ydoc-unsettled-close");
  state.peerEditWhileRetained = true;
  await expect
    .poll(() => state.closeCalls.length, { timeout: 15_000 })
    .toBeGreaterThan(1);

  // The release now succeeds, discharging the lease. The write is NOT
  // discharged with it, so a FRESH session must open to settle the update the
  // retained one never heard.
  //
  // The assertion is the new GENERATION, not the settled text. While the
  // release was refused, the provider's escalation settled on its way out and
  // that settle already carried the peer edit — so asserting on
  // `settledMarkdowns` passes whether or not the debt survived. Only opening
  // another session distinguishes them.
  const generationAtRelease = state.generation;
  state.closeFailure = null;
  await expect
    .poll(() => state.generation, { timeout: 25_000 })
    .toBeGreaterThan(generationAtRelease);
  await capture.stop();
}, 45_000);

it("a settle held through a refused release stops being proof when an update lands", async () => {
  // #595 round 11, invariant W: the write is discharged only against proof
  // that the artifact reflects the NEWEST Y.Doc state. Recording "this
  // settle landed" as a flag on the retained session let a later attempt
  // read a yes that a peer update had already invalidated: the release
  // succeeded, the debt was deleted, and that update never reached
  // Markdown. The proof is asked at discharge time, so the update withdraws
  // it without any branch remembering to.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-proof-expiry-");
  const { session } = await openWithOneEdit(capture, "proof expires");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The retry settles, a peer update lands after it, and THEN the release is
  // refused — so the debt retains the session with a settle that no longer
  // covers the document.
  state.locked = false;
  state.emitUpdateAfterSettle = true;
  state.closeFailure = new Error("ydoc-unsettled-close");
  await expect
    .poll(() => state.settledMarkdowns.length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const generationAtRetention = state.generation;

  // The release now succeeds. Believing the stored flag, the debt would be
  // deleted here and the peer update would never be written: no further
  // session is ever opened. Asking the proof, the release discharges only
  // the lease, and a FRESH session settles the newer state.
  state.closeFailure = null;
  await expect
    .poll(() => state.generation, { timeout: 20_000 })
    .toBeGreaterThan(generationAtRetention);
  await capture.stop();
}, 40_000);

it("a cancelled debt whose release is refused keeps retrying that release", async () => {
  // #595 round 11, invariant L: a session lease has exactly one owner at all
  // times. Discarding a debt cancels the WRITE; it cannot cancel the lease.
  // Clearing the reference before the close meant a refused release left the
  // lease owned by nobody, and every later open of the path answered
  // ydoc-session-busy until the daemon restarted. The debt goes back to the
  // registry — release-only — instead.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-lease-owner-");
  const { session } = await openWithOneEdit(capture, "leased twice");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The retry settles, a peer update outruns it, and the release is refused.
  // The debt now holds the only session that can free the lease AND still
  // owes a write — the state where cancelling has both things to get right.
  state.locked = false;
  state.emitUpdateAfterSettle = true;
  state.closeFailure = new Error("ydoc-unsettled-close");
  await expect
    .poll(
      () => state.closeCalls.filter((generation) => generation === 2).length,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  const releasesBeforeCancel = state.closesWithSettleFalse;
  const generationBeforeCancel = state.generation;
  const settlesBeforeCancel = state.settledMarkdowns.length;

  // The user deletes the path WHILE the release is still refused.
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
  // The release itself is the subtler half (#595 round 16, codex P2).
  // `settle: false` does not promise the file is left alone: the provider
  // ESCALATES a refused release to a settling close to preserve pending
  // edits, and that close materializes. A cancelled debt must therefore
  // release with `settleOnRefusal: false`. This assertion is what catches
  // it — but only since the fake models the escalation; before that it
  // passed while the real provider recreated the file.
  // Long enough for two more rungs of the ladder.
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  expect(state.generation).toBe(generationBeforeCancel);
  expect(state.settledMarkdowns).toHaveLength(settlesBeforeCancel);
  await capture.stop();
}, 60_000);

it("a settle the engine refuses for good stops the ladder and says why", async () => {
  // #595 round 11: the external program EDITED the file before releasing its
  // lock, so the pending job's preimage no longer matches and the engine
  // refuses conflict-stale-target forever. The unconditional re-arm polled
  // that permanent refusal every 10 seconds, reopening a session each time,
  // and never told the user the one thing they could act on.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-terminal-conflict-");
  const { session } = await openWithOneEdit(capture, "conflicting edit");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The lock releases, but the file it guarded is no longer the one the
  // pending write was built against.
  state.locked = false;
  state.settleFailure = new DaemonRefusalError(
    { code: "INVALID_PARAMS", message: "conflict-stale-target", retry: "no" },
    new Error("daemon response"),
  );
  await expect
    .poll(
      () =>
        state.errorMessages.filter((message) =>
          message.includes("changed outside dohc"),
        ),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);
  const [stopMessage] = state.errorMessages.filter((message) =>
    message.includes("changed outside dohc"),
  );
  expect(stopMessage).toContain("note.md");
  expect(stopMessage).toContain("history");

  // THE liveness proof: the ladder is done. Left armed, the 2s and 4s rungs
  // both wake inside this window and reopen a session for the same
  // permanent refusal.
  const settlesAtStandDown = state.settleCalls.length;
  const generationAtStandDown = state.generation;
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  expect(state.settleCalls.length).toBe(settlesAtStandDown);
  expect(state.generation).toBe(generationAtStandDown);
  await capture.stop();
}, 40_000);

it("a settle that committed but wrote nothing stops the ladder and names the symlink", async () => {
  // #651. A settle RESOLVING is the adjacent operation, not the write: the
  // engine commits the lineage and answers materialized: false for a target it
  // declines to write, so the call comes back clean while the .md stays stale
  // (#595 round 12 caught that much — it stopped discharging the debt there).
  //
  // What it did NOT settle is what that answer MEANS. `materialized: false`
  // has exactly one producer: `JobOutcome::Blocked` <-
  // `MaterializeError::SymlinkTarget` (crates/dohc-engine-files/src/
  // materialize.rs) — the path or an ancestor is a symlink. Waiting restores
  // no containment, so re-arming polls a condition that cannot clear and tells
  // the user nothing they can act on.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-unmaterialized-");
  const { session } = await openWithOneEdit(capture, "never written");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The lock releases, but the target became unsafe: every settle now
  // commits and writes nothing.
  state.locked = false;
  state.unmaterialized = true;
  await expect
    .poll(
      () => state.errorMessages.filter((message) => message.includes("symlink")),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);
  const [stopMessage] = state.errorMessages.filter((message) =>
    message.includes("symlink"),
  );
  // The blocking condition is NAMED, with the path and the way back — not
  // "the engine cannot write note.md (workspace operation failed)", which is
  // what the generic terminal stop says one rung later.
  expect(stopMessage).toContain("note.md");
  expect(stopMessage).toContain("did not write");
  expect(stopMessage).toContain("history");
  // BOTH components, because the engine names neither. `materialized: false`
  // is the answer whether the symlink is the target FILE or a folder above it
  // (prepare_target_parent_symlink_free checks the ancestors and the leaf).
  // An instruction that says only "folder" tells a user whose note.md IS the
  // symlink to replace it with a directory, which can never materialize.
  expect(stopMessage).toContain("real file");
  expect(stopMessage).toContain("real folder");

  // Nothing was ever reported as written. A stand-down must not read as a save.
  expect(state.settledMarkdowns).toHaveLength(0);

  // THE liveness proof: the ladder is done. Left armed, its next two rungs
  // both wake inside this window and reopen a session for the same
  // permanent condition.
  const settlesAtStandDown = state.settleCalls.length;
  const generationAtStandDown = state.generation;
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  expect(state.settleCalls.length).toBe(settlesAtStandDown);
  expect(state.generation).toBe(generationAtStandDown);
  await capture.stop();
}, 40_000);

it("a settle refused because peers outran it keeps the write ladder alive", async () => {
  // #650. `ydoc-remote-updates-pending` reports a RACE — remote edits drained
  // under this session's lease while its settle was in flight — and it clears
  // as soon as the session resyncs and settles the merged state. It arrives as
  // INVALID_PARAMS / retry: "no", the same shape as a refusal that answers the
  // write for good, so the ladder read it as terminal, cancelled the pending
  // write, and told the user retrying could not change the outcome.
  //
  // REACHABILITY, stated honestly: no shipping build raises this. The engine
  // refuses only for a marker in `Regime::Replicated`
  // (crates/dohc-engine-runtime/src/actor.rs), and that regime is constructed
  // only by dohc-engine-sync's inbound apply path — the sync stack is not
  // built (#356, #378). The refusal is INJECTED here so the classification is
  // right before two-peer sync makes it reachable.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-remote-pending-");
  const { session } = await openWithOneEdit(capture, "outrun by a peer");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The lock releases, and peers are now outrunning every settle. By the time
  // this shape reaches the ladder, `YdocLiveAdapter.settle` has already
  // resynced and settled once — the ladder owns what comes after that.
  state.locked = false;
  state.settleFailure = new DaemonRefusalError(
    {
      code: "INVALID_PARAMS",
      message: "ydoc-remote-updates-pending",
      retry: "no",
    },
    new Error("daemon response"),
  );
  await expect
    .poll(
      () => state.settleCalls.filter((generation) => generation >= 2).length,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  // The ladder KEEPS GOING, and says nothing final about a write that is
  // still owed. Read from the wire code alone, this is where it stops.
  const settlesAtRefusal = state.settleCalls.length;
  await expect
    .poll(() => state.settleCalls.length, { timeout: 20_000 })
    .toBeGreaterThan(settlesAtRefusal);
  expect(
    state.errorMessages.filter((message) =>
      message.includes("locked-write retry stopped"),
    ),
  ).toHaveLength(0);

  // THE proof the write survived the race: the peers stop outrunning the
  // settle, the debt is still owed, and the edit reaches the artifact.
  state.settleFailure = null;
  await expect
    .poll(() => state.settledMarkdowns, { timeout: 25_000 })
    .toEqual(["outrun by a peer"]);
  await capture.stop();
}, 60_000);

it("a materialization the engine refuses for good stops the ladder and says why", async () => {
  // #595 round 12: a locked file that turns read-only stops answering
  // file-locked and answers a terminal materialization failure instead. The
  // conflict-only stop let that re-arm every ten seconds forever. The class
  // is "the wire said do not retry", not "the failure was a conflict".
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-terminal-io-");
  const { session } = await openWithOneEdit(capture, "unwritable target");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  state.locked = false;
  state.settleFailure = new DaemonRefusalError(
    { code: "INTERNAL", message: "workspace operation failed", retry: "no" },
    new Error("daemon response"),
  );
  await expect
    .poll(
      () =>
        state.errorMessages.filter((message) =>
          message.includes("cannot write"),
        ),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);
  const [stopMessage] = state.errorMessages.filter((message) =>
    message.includes("cannot write"),
  );
  // The constraint is named, not just the fact of failure.
  expect(stopMessage).toContain("note.md");
  expect(stopMessage).toContain("workspace operation failed");
  expect(stopMessage).toContain("history");

  const settlesAtStandDown = state.settleCalls.length;
  const generationAtStandDown = state.generation;
  await new Promise((resolve) => setTimeout(resolve, 8_000));
  expect(state.settleCalls.length).toBe(settlesAtStandDown);
  expect(state.generation).toBe(generationAtStandDown);
  await capture.stop();
}, 40_000);

it("a release the daemon refuses terminally still keeps the write ladder alive", async () => {
  // #595 round 12, the boundary the widened stop must NOT cross. A refused
  // release (`ydoc-unsettled-close`) is INVALID_PARAMS / retry: no — as
  // terminal on the wire as a refused write — but it says nothing about the
  // write, and the daemon kept the session's lease. Stopping there strands
  // both obligations. What separates them is which CALL raised it.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-terminal-release-");
  const { session } = await openWithOneEdit(capture, "release refused hard");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The lock releases; a peer update outruns the settle, and THEN the
  // retry's own RELEASE is refused terminally. The write is genuinely still
  // owed, so treating the release's refusal as an answer about the write
  // loses it.
  state.locked = false;
  state.emitUpdateAfterSettle = true;
  state.closeFailure = new DaemonRefusalError(
    { code: "INVALID_PARAMS", message: "ydoc-unsettled-close", retry: "no" },
    new Error("daemon response"),
  );
  await expect
    .poll(
      () => state.closeCalls.filter((generation) => generation === 2).length,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  // The ladder is still alive, and it retries the RETAINED session rather
  // than opening new ones.
  const closesAtRefusal = state.closeCalls.length;
  const generationAtRefusal = state.generation;
  await expect
    .poll(() => state.closeCalls.length, { timeout: 20_000 })
    .toBeGreaterThan(closesAtRefusal);
  expect(state.generation).toBe(generationAtRefusal);

  // THE proof the write survived the release's refusal: once the daemon
  // accepts the release, the debt is still owed, so a FRESH session opens
  // and settles the state that peer update left behind. Read as an answer
  // about the write, the debt would have been cancelled and this generation
  // would never exist.
  state.closeFailure = null;
  await expect
    .poll(() => state.generation, { timeout: 25_000 })
    .toBeGreaterThan(generationAtRefusal);
  await capture.stop();
}, 60_000);
