import * as Y from "yjs";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  DaemonRefusalError,
  type EngineYdocProviderSession,
  type EngineYdocProviderSessionOptions,
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
  const rootPath = await mkdtemp(join(nativeTmpdir(), prefix));
  roots.push(rootPath);
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
    journal: [] as Uint8Array[],
    settleCalls: [] as number[],
    settledMarkdowns: [] as string[],
    generation: 0,
    generationOptions: [] as EngineYdocProviderSessionOptions[],
  };
  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    const gen = ++state.generation;
    state.generationOptions.push(options);
    const doc = new Y.Doc();
    for (const update of state.journal) Y.applyUpdate(doc, update);
    let tokens = 0;
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      contentKind: "plaintext",
      path: options.path,
      head: "present" as const,
      lineage: "existing" as const,
      async applyLocalUpdate(update) {
        Y.applyUpdate(doc, update);
        state.journal.push(update);
      },
      async settleNow() {
        state.settleCalls.push(gen);
        const token = ++tokens;
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
          materialized: true,
          projection: {
            contentKind: "plaintext" as const,
            sourceStateVectorSha256: "a".repeat(64),
            destructive: false,
          },
        };
        await options.onSettled?.(result, token);
        state.settledMarkdowns.push(markdown);
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
  const capture = createWorkspaceEngineCapture({
    workspaceId,
    rootPath,
    rustEngineSessions: sessions,
    openRustYDocProviderSession: openProvider,
    onError: () => undefined,
  });
  return { capture, state };
}

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
