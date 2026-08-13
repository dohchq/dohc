import * as Y from "yjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  EXPECTED_ENGINE_EVENT_EXPIRY_MS,
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
      evict: async () => undefined,
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
          markdown: "winning root",
          sha256: createHash("sha256").update("winning root").digest("hex"),
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
    markdown: "winning root",
  });
  expect(session.doc).not.toBe(losingDoc);
  expect(session.doc.getText("plainText").toString()).toBe("winning root");
  expect(session.doc.getText("plainText").toString()).not.toContain("losing root");
  expect(replacements).toEqual([{ text: "winning root", recoveredPaths: [] }]);

  await session.close({ settle: false });
  await capture.stop();
});

it("keeps an unclaimed lineage when its claimed generation shares CRDT history", async () => {
  const rootPath = await createTestScratch("dohc-ydoc-lineage-promotion-");
  const loopback = new VersionedLoopbackEngine();
  const client = (): EngineDaemonClient & EngineTransport => ({
    close: () => undefined,
    onEvent: () => () => undefined,
    async sendRequest(request: Request): Promise<Response> {
      if (request.method === "workspace.open") {
        return { id: request.id, result: { workspace: "lineage-promotion" } };
      }
      if (request.method === "workspace.close") {
        return { id: request.id, result: { closed: true } };
      }
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
  base.getText("plainText").insert(0, "shared root");
  const baseUpdate = Y.encodeStateAsUpdate(base);
  const openProvider = async (
    options: EngineYdocProviderSessionOptions,
  ): Promise<EngineYdocProviderSession> => {
    const unclaimed = options.transport === unclaimedClient;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, baseUpdate);
    if (!unclaimed) doc.getText("plainText").insert("shared root".length, " remote");
    return {
      doc,
      initialUpdate: Y.encodeStateAsUpdate(doc),
      lineageClaimId: unclaimed ? null : "promoted-claim",
      contentKind: "plaintext",
      path: options.path,
      head: "present",
      lineage: "existing",
      evict: async () => undefined,
      async applyLocalUpdate() {
        return;
      },
      async settleNow() {
        if (unclaimed) {
          currentClient = claimedClient;
          throw Object.assign(new Error("daemon exited"), {
            code: "transport-error",
          });
        }
        const markdown = doc.getText("plainText").toString();
        return {
          momentId: "promoted-moment",
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
        return;
      },
    };
  };
  const capture = createWorkspaceEngineCapture({
    workspaceId: "lineage-promotion",
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
  const stableDoc = session.doc;

  await expect(session.settleNow()).resolves.toMatchObject({
    markdown: "shared root remote",
  });
  expect(session.doc).toBe(stableDoc);
  expect(session.doc.getText("plainText").toString()).toBe("shared root remote");
  expect(session.lineageClaimId).toBe("promoted-claim");
  expect(replacements).toEqual([]);

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
      evict: async () => undefined,
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
      evict: async () => undefined,
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
      evict: async () => undefined,
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
      evict: async () => undefined,
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
      evict: async () => undefined,
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
      evict: async () => undefined,
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
      evict: async () => undefined,
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
      evict: async () => undefined,
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
      evict: async () => undefined,
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
async function lockedRebindCapture(
  prefix: string,
  options?: {
    daemonOwnsCapture?: boolean;
    now?: () => number;
    // Wraps the base provider open for one test's own generation, so it
    // can override a single method (e.g. `settleNow`'s timing) while
    // reusing everything else — the shared `state`'s locking, failure
    // injection, and bookkeeping all keep working unmodified.
    wrapProvider?: (
      base: (
        openOptions: EngineYdocProviderSessionOptions,
      ) => Promise<EngineYdocProviderSession>,
    ) => (
      openOptions: EngineYdocProviderSessionOptions,
    ) => Promise<EngineYdocProviderSession>;
  },
) {
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
    // #746 P1-B: how many times a session discharged through evict instead
    // of a materializing close. The orphan path already counts on this
    // exit; a suppressed close-retry's own dirty-session refusal needs the
    // same escape or its lease wedges the path busy until restart.
    evicts: 0,
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
      evict: async () => {
        state.evicts += 1;
      },
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
        // Real provider ordering: the settle ANNOUNCES itself before its
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
    openRustYDocProviderSession: options?.wrapProvider
      ? options.wrapProvider(openProvider)
      : openProvider,
    onError: (context, error) => {
      state.errors.push(context);
      state.errorMessages.push(
        error instanceof Error ? error.message : String(error),
      );
    },
    ...(options?.daemonOwnsCapture ? { daemonOwnsCapture: true } : {}),
    ...(options?.now ? { now: options.now } : {}),
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

async function expectRemovalOpenRefused(
  capture: WorkspaceEngineCapture,
  path: string,
  inProgress: string,
): Promise<void> {
  const refusal = await capture
    .openYDocSession({ path, onRemoteUpdate: () => undefined })
    .then(
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

it("pays a BUSY close debt too, which is what lets the chip say settling", async () => {
  // The premise the close-state test rests on. `settling` is only honest at a
  // close because something is still going to write the artifact — and for the
  // busy class that something is this debt. Narrow the arming back to the file
  // lock and every desktop suite stays green while the chip claims "saving"
  // forever with nothing behind it, which is the surface-lies failure #554
  // exists to remove.
  //
  // The shape is the replicated one: the release SUCCEEDS over a refused
  // pre-close settle, so the entry and its per-entry ladder are gone and only
  // a detached debt can finish the write.
  //
  // MUTATION: narrow the arming to `isFileLockedCause(error.cause)` -> nothing
  // is armed, and `settledMarkdowns` stays empty forever.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-busy-debt-");
  const { session } = await openWithOneEdit(capture, "busy replicated edit");

  state.replicated = true;
  state.closeSettleFailure = busyRefusal();
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The store frees; the detached debt reopens and settles by itself.
  state.closeSettleFailure = null;
  await expect
    .poll(() => state.settledMarkdowns, { timeout: 15_000 })
    .toEqual(["busy replicated edit"]);
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

it("a rename after a version-switch stand-down refuses instead of saving stale content", async () => {
  // #681, active-version-branch door: `standDownFromWrite` used to delete
  // the debt entry the same way the other two doors did, so `beginFileRename`
  // read the fence's stand-down as a landed write and would have recorded
  // the STALE pre-lock disk artifact under the new name.
  //
  // Round 2 lifecycle check: this door's own comment says the RUST engine's
  // fence (`materialize_replay_pending_for_fence`, lib.rs) already replays
  // this write before a switch can succeed — but that replay is a daemon-
  // internal operation this desktop session never opens a provider for, so
  // it never reaches `onSettled` and never clears this JS-side marker. The
  // shared refusal copy stays plainly true from where this rename stands:
  // relative to the version now active, this path's disk content still
  // never came from this debt's write — the fence's own copy already landed
  // it under the OLD version, not this one.
  const { capture, state, loopback, workspaceId, rootPath } =
    await lockedRebindCapture("dohc-ydoc-fence-rename-");
  await writeFile(join(rootPath, "note.md"), "stale pre-lock artifact\n", "utf8");
  const { session } = await openWithOneEdit(capture, "old version edit");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

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
    .poll(
      () => state.errors.filter((context) => context.includes("close retry")),
      { timeout: 15_000 },
    )
    .toHaveLength(1);

  // RED against current main: absence read as landed, so this resolved and
  // recorded renamed.md from the stale pre-lock text instead of refusing.
  await expect(
    capture.beginFileRename("note.md", "renamed.md"),
  ).rejects.toThrow(
    "dohc could not rename note.md. dohc gave up on writing note.md earlier, so its last edits never reached disk. The edits stay in the document's history. Open note.md to write them again. Then rename note.md again.",
  );
  await expect(readFile(join(rootPath, "renamed.md"), "utf8")).rejects.toThrow();
  expect(state.settledMarkdowns).toEqual([]);
  await capture.stop();
}, 25_000);

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

it("an external delete observed before a debt registers cancels it at the door instead of arming a resurrecting ladder", async () => {
  // #681 round 7, codex P1 (real): a debt used to register unconditionally
  // at its one door — `scheduleDetachedLockedSettle`, reached directly (a
  // release that succeeds over a failed settle) and again after a
  // transient close retry ladder that runs OFF the capture chain for as
  // long as TEARDOWN_RETRY_CAP_MS allows (seconds wide in production,
  // unlike the chain-serialized delete/move seams #697 already fences).
  // An external delete landing anywhere in that window finds no debt yet
  // (`cleanupDetachedDebtForEvent`'s has(path) gate correctly skips it),
  // and the LATE registration that follows then owns a path that is
  // already gone: its own ladder can recreate the deleted file from the
  // canonical Y.Doc, or (if it later stands down) strand a marker
  // blocking an unrelated file recreated at that same path.
  //
  // The session opens FIRST, then the delete lands (#681 round 8): the
  // registration door now discriminates by session age, so the session
  // under test must genuinely predate the delete it is meant to be
  // cancelled by — swapped from this test's original delete-then-open
  // order once that order stopped matching what the fix actually checks.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-late-registration-",
  );
  const { session } = await openWithOneEdit(capture, "would resurrect this");

  // The watcher observes the external delete before this session's own
  // close ever registers a debt.
  capture.captureBatch([{ path: "note.md", operation: "delete" }]);
  await capture.flush();

  state.locked = true;
  state.replicated = true;

  // RED before the fix: nothing remembered the earlier delete, so this
  // close's own registration armed a fresh, un-cancelled debt.
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );
  state.locked = false;

  // The cancel trace names the absence, not a fabricated lock.
  expect(
    state.errorMessages.some((message) =>
      message.includes("an external delete of note.md removed the path"),
    ),
  ).toBe(true);

  // And the ladder never armed: no reopen, no settle, ever — the deleted
  // path stays deleted.
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  expect(state.generation).toBe(1);
  expect(state.settledMarkdowns).toEqual([]);
  await capture.stop();
}, 15_000);

it("a recreated path's own session arms its debt normally instead of being cancelled by an earlier delete", async () => {
  // #681 round 8, codex P1 (real, corrected mid-round): the round-7
  // tombstone is path-keyed, so a delete-then-recreate landing inside its
  // TTL left it armed for the NEW file too. A first attempt fixed this by
  // having any non-delete event INVALIDATE the tombstone outright — wrong
  // shape, reverted before shipping: the certifier's S2(b) showed it lets
  // an OLD session, still mid-retry-ladder when the recreation lands,
  // arm a late debt that settles its STALE canonical doc over the NEW
  // file — the exact resurrection-over-live-content corruption this whole
  // PR exists to prevent. The correct discriminator is THIS session's own
  // open time against the tombstone's: a session that opened AFTER the
  // delete (this one) was never the delete's victim, so it must arm
  // normally regardless of whether a recreation happened at all — see the
  // sibling pin for the OLD session, which must still cancel.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-tombstone-recreate-",
  );

  // The path is deleted (no debt exists yet, so the tombstone is set),
  // then recreated — both before this test's own session ever opens.
  capture.captureBatch([{ path: "note.md", operation: "delete" }]);
  await capture.flush();
  capture.captureBatch([{ path: "note.md", operation: "update" }]);
  await capture.flush();

  // A NEW session — opened after both events — hits a genuine transient
  // lock on close.
  const { session } = await openWithOneEdit(capture, "a real pending edit");
  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // RED before the fix: the stale tombstone, still armed, was consumed
  // here and cancelled this genuine pending write instead of arming it.
  expect(
    state.errorMessages.some((message) =>
      message.includes("removed the path while a pending write waited"),
    ),
  ).toBe(false);

  // The lock releases, and the ladder — armed normally — lands the write.
  state.locked = false;
  await expect
    .poll(() => state.settledMarkdowns, { timeout: 15_000 })
    .toEqual(["a real pending edit"]);
  await capture.stop();
}, 20_000);

it("a stale session's late debt still cancels at the door despite a later recreation of its path", async () => {
  // #681 round 8, codex P1 pin (b) — the corruption guard. An OLD session
  // opens BEFORE the delete and is still closing (its own transient retry
  // ladder running off the chain) when the path is deleted AND recreated.
  // This session's registration must STILL cancel: its content is exactly
  // what the delete orphaned, and the sibling pin above is what proves a
  // GENUINELY new session at the same path is unaffected — together they
  // show the door discriminates by session age, not by whether a
  // recreation happened.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-tombstone-stale-session-",
  );

  // The old session opens first — before anything else happens to its
  // path.
  const { session } = await openWithOneEdit(capture, "the stale content");

  // The path is deleted, then recreated, while the old session has not
  // closed yet (its own registration has not run).
  capture.captureBatch([{ path: "note.md", operation: "delete" }]);
  await capture.flush();
  capture.captureBatch([{ path: "note.md", operation: "update" }]);
  await capture.flush();

  // NOW the old session's close hits a transient lock, registering LATE —
  // exactly the round-7 shape, with a recreation now sitting in between.
  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );
  state.locked = false;

  // This old session's debt is still cancelled: it opened before the
  // delete, so it is the incarnation the tombstone actually names.
  await expect
    .poll(
      () =>
        state.errorMessages.filter((message) =>
          message.includes("removed the path while a pending write waited"),
        ),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  expect(state.generation).toBe(1);
  expect(state.settledMarkdowns).toEqual([]);
  await capture.stop();
}, 20_000);

it("a late-registering debt's cancellation trace names dohc's own removal, not a fabricated external delete", async () => {
  // #681 round 8, certifier's cosmetic finding (folded): the no-debt
  // tombstone recorded EXPECTED deletes (an engine-owned removal, e.g. a
  // version switch's own materialization) the same as external ones, so a
  // debt registering within the tombstone's memory always blamed "an
  // external delete" — even when dohc itself removed the path. The
  // recorder is the only place that verdict is still known once this
  // becomes a bare memory; thread it through instead of guessing at the
  // door.
  // The session opens FIRST (#681 round 8: the registration door
  // discriminates by session age, so the session under test must
  // genuinely predate the removal it is meant to be cancelled by).
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-tombstone-expected-",
  );
  const { session } = await openWithOneEdit(capture, "would resurrect this");

  // The engine registers the removal as expected, then the watcher
  // observes it — the same sequence materialize() uses for a version
  // switch's own delete operation.
  capture.registerExpectedEngineEvents([
    { path: "note.md", operation: "delete" },
  ]);
  capture.captureBatch([{ path: "note.md", operation: "delete" }]);
  await capture.flush();

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // RED before the fix: this cancellation always said "an external
  // delete", even though the recorder knew the removal was dohc's own.
  expect(
    state.errorMessages.some((message) =>
      message.includes("dohc's own removal of note.md removed the path"),
    ),
  ).toBe(true);
  state.locked = false;
  await capture.stop();
}, 15_000);

it("a materialized settle retires a session's deletion fence, so post-recovery edits arm normally", async () => {
  // #681 round 9, codex P1 (real): a session is classified once, at open,
  // against a delete it predates — but round 8's discriminator never
  // revisits that classification. A session opened before a delete can
  // still recover mid-session: one of its OWN settles can rematerialize
  // the path, proving the deletion's premise is gone. Without retiring
  // the tombstone there, a LATER transient close failure over edits made
  // AFTER that recovery still reads as belonging to the deleted
  // incarnation and gets wrongly cancelled — the post-recovery edits get
  // no retry and the artifact stays stale.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-tombstone-rematerialize-",
  );

  // The session opens, then the path is deleted externally — this
  // session predates the delete, so the discriminator alone would
  // classify it "old" for the rest of its life.
  const { session, mirror } = await openWithOneEdit(capture, "first edit");
  capture.captureBatch([{ path: "note.md", operation: "delete" }]);
  await capture.flush();

  // The SAME session settles for real — no lock, no failure — and its
  // materialized write proves note.md exists again.
  await expect(session.settleNow()).resolves.toMatchObject({
    markdown: "first edit",
  });

  // More edits land on this session, made AFTER the recovery above.
  const before = Y.encodeStateVector(mirror);
  mirror
    .getText("plainText")
    .insert(mirror.getText("plainText").length, " second edit");
  await session.applyLocalUpdate(Y.encodeStateAsUpdate(mirror, before));

  // This close hits a genuine transient lock.
  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // RED before the fix: the tombstone from before the recovery, still
  // classifying this session as "old," was consumed here and cancelled
  // these genuinely pending post-recovery edits instead of arming them.
  expect(
    state.errorMessages.some((message) =>
      message.includes("removed the path while a pending write waited"),
    ),
  ).toBe(false);

  // The lock releases, and the ladder — armed normally — lands the write.
  state.locked = false;
  await expect
    .poll(() => state.settledMarkdowns, { timeout: 15_000 })
    .toEqual(["first edit", "first edit second edit"]);
  await capture.stop();
}, 20_000);

it("a retry whose own opts already carry settle:false still consults the tombstone before an escalated write", async () => {
  // Codex P1-A on #746. `EngineYdocProviderSession.close` treats `settle:
  // false` as a preference, not a promise: a release the daemon refuses
  // ESCALATES to a full settling close unless the caller also passes
  // `settleOnRefusal: false` (packages/workspace-engine-client/src/ydoc/
  // ydocProviderSession.ts). The retry guard used to read `opts?.settle
  // !== false && suppressSettleForRemoval()`: once a caller had ALREADY
  // asked for `settle: false` — the vacate-before-delete shape,
  // `entry.close({ settle: false })` from `settleAndCloseLiveYDocSessions`
  // — the short-circuit skipped the tombstone check entirely and never
  // forced `settleOnRefusal: false`, so a retry whose own close kept
  // escalating on a persistent refusal could still materialize the doc
  // onto a path deleted mid-ladder.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-close-retry-settlefalse-escalate-",
  );
  const { session } = await openWithOneEdit(
    capture,
    "would resurrect via escalation",
  );

  // A release refusal unrelated to the settle itself — the shape
  // `entry.close({ settle: false })` meets when the daemon's own store is
  // busy releasing the lease. `settle: false` alone is only a preference,
  // so the provider escalates and materializes the pending edit before
  // throwing.
  state.closeFailure = busyRefusal();
  await expect(session.close({ settle: false })).rejects.toThrow(
    "engine-store-busy",
  );
  // That escalation landed the pending edit once, before anything was
  // deleted — the write is legitimate.
  expect(state.settledMarkdowns).toEqual(["would resurrect via escalation"]);

  // The watcher observes the external delete while the ladder sleeps
  // between attempts, exactly as the sibling pin below.
  capture.captureBatch([{ path: "note.md", operation: "delete" }]);
  await capture.flush();

  // RED before the fix: the retry's own opts still carry `settle: false`
  // from the original call, so `opts?.settle !== false` short-circuited
  // the tombstone check and the retry's escalated settle re-wrote the doc
  // onto the path the user just deleted — a SECOND entry lands in
  // `settledMarkdowns` after the delete.
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  expect(state.settledMarkdowns).toEqual(["would resurrect via escalation"]);
  expect(
    state.errorMessages.some((message) =>
      message.includes("an external delete of note.md removed the path"),
    ),
  ).toBe(true);
  await capture.stop();
}, 10_000);

it("a suppressed retry's dirty-session refusal discharges through evict instead of wedging the lease", async () => {
  // Codex P1-B on #746. Forcing `settleOnRefusal: false` on a suppressed
  // retry (the P1-A fix above) can meet a daemon that refuses the
  // non-settling release because the session still holds unsettled state —
  // `ydoc-unsettled-close` — and that refusal is TERMINAL, not transient
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

  capture.captureBatch([{ path: "note.md", operation: "delete" }]);
  await capture.flush();

  // The lock clears, but the RELEASE itself now refuses hard: the daemon
  // will not drop a dirty session without settling it.
  state.locked = false;
  state.closeFailure = new DaemonRefusalError(
    { code: "INVALID_PARAMS", message: "ydoc-unsettled-close", retry: "no" },
    new Error("daemon response"),
  );

  // RED before the fix: nothing ever evicts a non-orphaned entry, so the
  // terminal refusal just stops the ladder with the lease still held.
  await expect.poll(() => state.evicts, { timeout: 15_000 }).toBe(1);
  // The refusal never escalated into a write: the deleted path stays gone.
  expect(state.settledMarkdowns).toEqual([]);

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
}, 20_000);

it("a delete delivered while the capture chain is busy still suppresses a retry that fires before the chain drains", async () => {
  // Codex P1-C on #746. `captureBatch` QUEUES `cleanupDetachedDebtForEvent`
  // — the only place that used to record the no-debt tombstone — onto the
  // capture chain, so it does not run until the chain is free. The
  // close-retry ladder's own timer runs OFF the chain, and every sibling
  // pin above hides this ordering by awaiting `capture.flush()` before the
  // retry window: that guarantees the tombstone landed first. In
  // production a busy chain (reconciliation, a version op, another
  // batch) can leave the cleanup queued behind it for as long as that
  // work takes, and a retry firing inside that window used to find no
  // tombstone at all and resurrect the file. No `flush()` runs here before
  // the retry fires — the chain stays occupied the whole time.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-close-retry-chain-busy-",
  );
  const { session } = await openWithOneEdit(
    capture,
    "would resurrect via chain race",
  );

  state.locked = true;
  await expect(session.close()).rejects.toThrow("file-locked");
  // Nothing blocks the retry's own settle technically — only the tombstone
  // (once it is visible) should stop it.
  state.locked = false;

  // Occupy the chain with a parked open, the same technique the existing
  // rollback-window pins use: the open runs as a chain task and does not
  // resolve until the test releases the gate, so anything enqueued after
  // it — including this delete's cleanup — stays queued.
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
  capture.captureBatch([{ path: "note.md", operation: "delete" }]);

  // RED before the fix: the enqueued cleanup that used to be the only
  // place recording the tombstone is still queued behind the parked open,
  // so the retry (which fires here, off-chain) finds nothing and
  // resettles the doc onto the path the user just deleted.
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  expect(state.settledMarkdowns).toEqual([]);
  expect(
    state.errorMessages.some((message) =>
      message.includes("an external delete of note.md removed the path"),
    ),
  ).toBe(true);

  releaseOpen();
  await (await parked).close({ settle: false });
  await capture.stop();
}, 20_000);

it("a delete landing past the tombstone's own TTL still suppresses an active retry ladder directly", async () => {
  // Certification follow-up on #746 (TTL boundary): the no-debt
  // tombstone's TTL (`EXPECTED_ENGINE_EVENT_EXPIRY_MS`, 10s) and the
  // close-retry ladder's own doubling delay cap (`TEARDOWN_RETRY_CAP_MS`,
  // also 10s) converge — once the ladder is capped, the gap between two
  // consecutive retries EQUALS the tombstone's own TTL. A delete landing
  // right after one retry's own consult can sit unconsulted for that
  // whole gap, and the map-only tombstone expires before the next retry
  // ever asks. `armRemovalSuppression` (the fix) arms the session
  // directly, at watcher-delivery time, bypassing the TTL-bounded map for
  // that session entirely — nothing there can expire.
  //
  // A virtual clock proves this without a real 10s+ wait: the retry
  // ladder still fires on its own real timers, but `now()` reports a
  // delete old enough that the map-only path would already read it as
  // expired by the time any retry consults it.
  let virtualNowMs = 1_000_000;
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-close-retry-ttl-boundary-",
    { now: () => virtualNowMs },
  );
  const { session } = await openWithOneEdit(
    capture,
    "must not resurrect past the tombstone's own TTL",
  );

  state.locked = true;
  await expect(session.close()).rejects.toThrow("file-locked");

  // Virtual time must actually move past the session's own open time
  // before the delete lands — the age discrimination (recreation vs. the
  // stale incarnation a delete orphaned) reads an EQUAL timestamp as "not
  // before the delete", same as the map-based door does.
  virtualNowMs += 500;

  // The delete lands — `armRemovalSuppression` sees it immediately, at
  // THIS virtual time. Only afterward does virtual time jump past the
  // tombstone's own TTL, well before the retry (still on a real ~1s
  // timer) ever fires.
  capture.captureBatch([{ path: "note.md", operation: "delete" }]);
  await capture.flush();
  virtualNowMs += EXPECTED_ENGINE_EVENT_EXPIRY_MS + 1;

  state.locked = false;

  // RED before the fix: the retry's only door was the TTL-bounded map,
  // already expired by virtual time, so the retry re-settled the doc onto
  // the path the user just deleted.
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  expect(state.settledMarkdowns).toEqual([]);
  expect(
    state.errorMessages.some((message) =>
      message.includes("an external delete of note.md removed the path"),
    ),
  ).toBe(true);
  await capture.stop();
}, 10_000);

it("a delete landing after a settle's write but before its late onSettled callback still suppresses the retry", async () => {
  // Codex P1 on 847ef7d9: the synchronous tombstone recording above (the
  // P1-C fix) exposed an ordering hazard in the SEPARATE clear #681 round
  // 9 added — `onSettled`, on a materialized write, unconditionally
  // retired this path's no-debt tombstone, on the theory that landing a
  // write proves an earlier deletion's premise no longer holds. But
  // `onSettled` can run LATE: behind an occupied capture chain, or simple
  // scheduling. A delete landing in that exact gap — after the write
  // already materialized, before the stale callback finally runs — used
  // to have its OWN, newer tombstone erased by that late callback, purely
  // because an OLDER settle's completion happened to run after it.
  let releaseSettled!: () => void;
  const settleGate = new Promise<void>((resolve) => {
    releaseSettled = resolve;
  });
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-settle-clear-race-",
    {
      wrapProvider: (base) => async (openOptions) => {
        const inner = await base(openOptions);
        let token = 0;
        return {
          ...inner,
          async settleNow() {
            token += 1;
            const thisToken = token;
            const markdown = inner.doc.getText("plainText").toString();
            openOptions.onSettleStart?.(thisToken);
            const result = {
              momentId: `moment-race-${thisToken}`,
              path: openOptions.path,
              markdown,
              sha256: createHash("sha256").update(markdown).digest("hex"),
              materialized: true,
              projection: {
                contentKind: "plaintext" as const,
                sourceStateVectorSha256: "c".repeat(64),
                destructive: false,
              },
            };
            // THE WRITE LANDS now — observable immediately, same as a real
            // materialized settle.
            state.settledMarkdowns.push(markdown);
            // The callback that reports it is late.
            await settleGate;
            await openOptions.onSettled?.(result, thisToken);
            return result;
          },
        };
      },
    },
  );
  const { session } = await openWithOneEdit(capture, "first version");

  // The settle starts and its write lands, but its own completion
  // callback is held open — modelling a chain occupied by other work.
  const settling = session.settleNow();
  await expect
    .poll(() => state.settledMarkdowns, { timeout: 15_000 })
    .toEqual(["first version"]);

  // The delete lands INSIDE the gap: after the write, before the stale
  // callback. No debt exists for this path, so this is the no-debt
  // tombstone the stale callback must not erase.
  capture.captureBatch([{ path: "note.md", operation: "delete" }]);
  await capture.flush();

  // The stale callback finally fires and reaches its own clear.
  releaseSettled();
  await settling;

  // A later close-retry ladder must still find the tombstone. RED before
  // the fix: the stale callback already erased it, so this retry
  // resettles the doc onto the path the user just deleted.
  state.locked = true;
  await expect(session.close()).rejects.toThrow("file-locked");
  state.locked = false;
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  expect(state.settledMarkdowns).toEqual(["first version"]);
  expect(
    state.errorMessages.some((message) =>
      message.includes("an external delete of note.md removed the path"),
    ),
  ).toBe(true);
  await capture.stop();
}, 20_000);

it("a recreated path's fresh close-retry ladder still settles normally despite an earlier delete", async () => {
  // #746 non-regression, the inverse of the pin above: this session opens
  // AFTER the delete-then-recreate, so it is not the incarnation any
  // tombstone names — the fix must not start refusing it. True at both
  // the unfixed and the fixed head (run first, to prove the pin does not
  // depend on the fix): a fresh session's close-retry ladder never
  // consulted the tombstone before this PR either, and the age
  // discrimination #744 built for the registration door already answers
  // "no" for this session once the fix asks it too.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-close-retry-recreate-",
  );

  capture.captureBatch([{ path: "note.md", operation: "delete" }]);
  await capture.flush();
  capture.captureBatch([{ path: "note.md", operation: "update" }]);
  await capture.flush();

  const { session } = await openWithOneEdit(capture, "a real pending edit");
  state.locked = true;
  await expect(session.close()).rejects.toThrow("file-locked");

  state.locked = false;
  await expect
    .poll(() => state.settledMarkdowns, { timeout: 15_000 })
    .toEqual(["a real pending edit"]);
  await capture.stop();
}, 20_000);

it("a suppressed close-retry ladder stands down once, honestly, instead of resurrecting or repeating", async () => {
  // #746: `scheduleDetachedLockedSettle` (above) is the debt-REGISTRATION
  // door, reached only through the replicated `YdocReleasedWithSettleFailureError`
  // shape. An UNREPLICATED close refusal never reaches it at all —
  // `scheduleTransientCloseRetry` retries `closeEntry` itself, off the
  // capture chain, with no debt ever registered — so none of #744's
  // registry-side fences ever see this ladder. An external delete landing
  // between the failed first attempt and a later retry used to be
  // silently undone by that retry's own settle.
  //
  // Stand-down honesty (the close-result contract): once removal evidence
  // suppresses a retry's settle, the ladder must record that ONE
  // stand-down and stop — never report a landed artifact, and never
  // re-consult (or re-announce) a tombstone it already consumed on a
  // later retry. The exactly-once assertion below subsumes the weaker
  // at-least-once check a resurrection alone would need: it proves both
  // that nothing resettled AND that the stand-down never repeats.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-close-retry-standdown-",
  );
  const { session } = await openWithOneEdit(capture, "stood-down content");

  state.locked = true;
  await expect(session.close()).rejects.toThrow("file-locked");

  // The watcher observes the external delete while the ladder sleeps
  // between attempts. No debt exists yet for this path — Ladder B never
  // registers one — so the no-debt tombstone is the only place this is
  // remembered.
  capture.captureBatch([{ path: "note.md", operation: "delete" }]);
  await capture.flush();
  state.locked = false;

  // Let several retry windows pass — the ladder's own doubling delay,
  // twice over.
  await new Promise((resolve) => setTimeout(resolve, 3_500));

  // The close result stays truthful: no artifact ever landed...
  expect(state.settledMarkdowns).toEqual([]);
  // ...and the stand-down was recorded exactly once, not re-announced on
  // every later retry.
  expect(
    state.errorMessages.filter((message) =>
      message.includes("an external delete of note.md removed the path"),
    ),
  ).toHaveLength(1);
  await capture.stop();
}, 15_000);

it("a suppressed retry's own transient release failure still stands down on the following retry", async () => {
  // Certification follow-up on #746: `suppressSettleForRemoval`'s
  // stickiness (`if (writeCancelled) return true;`, checked before any
  // tombstone consult) is what protects a SECOND retry once the FIRST
  // suppressed close's own release fails transiently — not a lock, this
  // time, but the same file-locked/engine-store-busy class the ladder
  // already retries through. Without stickiness, the tombstone was
  // already consumed by the first suppression, so a later retry that
  // re-asked would find nothing and settle the doc back onto the deleted
  // path. `writeCancelled` alone is what makes a second, third, or
  // Nth suppressed retry as honest as the first.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-close-retry-standdown-sticky-",
  );
  const { session } = await openWithOneEdit(
    capture,
    "must not resurrect after a hiccup",
  );

  state.locked = true;
  await expect(session.close()).rejects.toThrow("file-locked");

  capture.captureBatch([{ path: "note.md", operation: "delete" }]);
  await capture.flush();
  state.locked = false;
  // The suppressed retry's own settle:false release meets a transient
  // refusal of its own — unrelated to the file lock above, and unrelated
  // to the tombstone this retry already consumed.
  state.closeFailure = busyRefusal();

  // The first suppressed retry fires (~1s) and stands down exactly once.
  await expect
    .poll(
      () =>
        state.errorMessages.filter((message) =>
          message.includes("an external delete of note.md removed the path"),
        ).length,
      { timeout: 15_000 },
    )
    .toBe(1);
  expect(state.settledMarkdowns).toEqual([]);
  const closesAtFirstStandDown = state.closeCalls.length;

  // The release clears; the next retry (~2s later, the doubled delay)
  // must complete WITHOUT re-consulting or re-announcing the tombstone —
  // only `writeCancelled`'s stickiness can produce that, since the
  // tombstone itself was already consumed by the first suppression. Poll
  // for the SECOND retry's own close call having actually run before
  // asserting silence — a fixed sleep here would let a loaded runner pass
  // vacuously, before the second retry ever fires.
  state.closeFailure = null;
  await expect
    .poll(() => state.closeCalls.length, { timeout: 15_000 })
    .toBeGreaterThan(closesAtFirstStandDown);
  expect(state.settledMarkdowns).toEqual([]);
  expect(
    state.errorMessages.filter((message) =>
      message.includes("an external delete of note.md removed the path"),
    ),
  ).toHaveLength(1);

  // No busy-wedge left behind: the eventually-clean release freed the path.
  const reopened = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  await reopened.close({ settle: false });
  await capture.stop();
}, 20_000);

it("a delete refuses the open that could register a debt while disk work is in flight", async () => {
  // #696 rescanned for debts registered after its suspension snapshot. #697
  // makes that late registration unreachable: a new live open cannot enter
  // the removal window at all. Keep the original pre-window debt here so the
  // successful finisher still proves #696 cancellation was not weakened.
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

  // The former second debt is refused before the daemon opens a generation.
  const generationAtDelete = state.generation;
  await expectRemovalOpenRefused(
    capture,
    "note.md",
    "dohc is still deleting note.md.",
  );

  // The delete succeeded. BOTH debts are cancelled: the path is provably gone.
  finishDelete(true);
  state.locked = false;

  // THE FACT: the deleted path is not reopened and nothing is settled onto it.
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  expect(state.generation).toBe(generationAtDelete);
  expect(state.settledMarkdowns).toEqual([]);
  // The one debt that existed before the window said so out loud.
  expect(
    state.errors.filter((context) => context.includes("close retry")),
  ).toHaveLength(1);
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

it("a delete's watcher event landing during a suspended debt's window still suppresses the restored payment", async () => {
  // Certification follow-up on #746, the three-way race the sibling pin
  // above sets up half of. `settleAndCloseLiveSessionsForPath` SUSPENDS a
  // registered debt for its own attempt window (`suspendDetachedDebts`
  // removes it from the registry entirely, not merely marks it). An
  // external delete's watcher event landing in that exact window sees NO
  // debt registered — `detachedLockedDebts.has(path)` is false — so it
  // becomes the no-debt tombstone (#681 round 7), the same door a path
  // with no debt at all would hit. When the destructive op then FAILS,
  // `restoreSuspendedDebts` puts the SAME debt back and re-arms it. The
  // restored payment's own `settleForProof` must still ask
  // `suppressSettleForRemoval()` before writing — the debt's mere
  // continued existence says nothing about whether the path is still
  // there.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-suspend-restore-race-",
  );
  const { session } = await openWithOneEdit(
    capture,
    "must not resurrect after a suspended restore",
  );

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // A destructive op suspends the debt for the length of its own attempt.
  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");

  // The external delete's watcher event lands INSIDE the suspension
  // window — no debt is registered right now, so this is the exact
  // no-debt tombstone shape.
  capture.captureBatch([{ path: "note.md", operation: "delete" }]);
  await capture.flush();

  // The destructive op FAILS: restore and re-arm, not cancel.
  finishDelete(false);
  state.locked = false;

  // RED before the fix: the restored payment's own settle never asked
  // about the tombstone and resettled the doc onto the path the watcher
  // had already confirmed gone.
  await expect
    .poll(
      () =>
        state.errorMessages.some((message) =>
          message.includes("an external delete of note.md removed the path"),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  expect(state.settledMarkdowns).toEqual([]);
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

it("a move refuses the open that could register a debt while disk work is in flight", async () => {
  // #697 closes the late-debt entrance #696 had to rescan: a new live open
  // cannot enter the move window and therefore cannot arm a moved-from retry.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-move-race-",
  );
  await writeFile(join(rootPath, "note.md"), "stale artifact\n", "utf8");

  // The move starts with a clean registry, so it prepares instead of refusing.
  const finishMove = await capture.beginFileRename("note.md", "moved.md");

  const generationAtMove = state.generation;
  await expectRemovalOpenRefused(
    capture,
    "note.md",
    "dohc is still moving note.md.",
  );

  // The move landed. No late debt or daemon session ever existed.
  await finishMove(true);
  state.locked = false;

  // THE FACT: the moved-from path is never reopened and nothing is settled
  // back onto it.
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  expect(state.generation).toBe(generationAtMove);
  expect(state.settledMarkdowns).toEqual([]);
  await capture.stop();
}, 20_000);

it("a folder move settles and closes a live child session before opening its window", async () => {
  // #738: the move seam used to vacate only its exact fromPath/toPath, so a
  // live Y.Doc session on a folder's CHILD survived into the open window.
  // Its own later settle (a reopen's flush, a daemon-armed debounced settle)
  // could then materialize the moved-away child path mid-move. The vacate is
  // now prefix-based, exactly like the delete seam's, so the child never
  // reaches the window alive to race it.
  //
  // MUTATION: narrow the vacate's match back to exact fromPath/toPath -> the
  // child session survives past `beginFileRename`, `settledMarkdowns` stays
  // empty here, and the later close/reopen assertions below fail.
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
  // GREEN proof 1: the child's edit landed through the move's OWN vacate
  // settle, before the window ever opened — not through some later,
  // racing settle.
  expect(state.settledMarkdowns).toEqual([
    "child settles before the window opens",
  ]);
  // GREEN proof 2: the session is already gone, so closing it again is a
  // harmless no-op instead of a fresh settle racing the window.
  const settlesAtClose = state.settleCalls.length;
  await session.close();
  expect(state.settleCalls).toHaveLength(settlesAtClose);

  // Refusal side, on the settle door itself: a stray settle on the SAME
  // handle — the shape a straggling debounced timer would produce — still
  // meets the removal window and refuses there, independent of the vacate
  // above.
  //
  // MUTATION: drop the removal-window check from the settle door (capture.ts
  // ~2137-2145) -> this settle reaches the daemon instead of refusing.
  const settleRefusal = await session.settleNow().then(
    () => null,
    (error: unknown) => error,
  );
  expect(settleRefusal).toMatchObject({
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
  await expectRemovalOpenRefused(
    capture,
    "dir/note.md",
    "dohc is still moving dir.",
  );

  await finishMove(true);
  await capture.stop();
}, 20_000);

it("a failed folder move's vacated child session needs no debt to keep its edit", async () => {
  // #738 follow-up: because the vacate above settles the child
  // unconditionally, its edit survives a rollback (`finishMove(false)`)
  // without ever routing through the detached-debt ladder the pre-#738
  // vacate depended on to save a child the window had left live.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-foldermove-child-rollback-",
  );
  await mkdir(join(rootPath, "dir"), { recursive: true });
  await writeFile(join(rootPath, "dir", "note.md"), "stale artifact\n", "utf8");
  await openWithOneEdit(capture, "survives a failed move too", "dir/note.md");

  const finishMove = await capture.beginFileRename("dir", "moved");
  expect(state.settledMarkdowns).toEqual(["survives a failed move too"]);
  const settledAtWindow = state.settledMarkdowns.length;

  // The disk move failed; the finisher rolls the engine rename back. No
  // debt ladder ever had anything to pay, so a full retry interval passes
  // with nothing left to settle.
  await finishMove(false);
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  await capture.flush();
  expect(state.settledMarkdowns).toHaveLength(settledAtWindow);
  await capture.stop();
}, 20_000);

it("a delete window refuses a debt's payment while the disk delete is unfinished", async () => {
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-delete-payment-window-",
  );
  const { session } = await openWithOneEdit(capture, "written mid-delete");
  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");
  const attemptsAtWindow = state.openAttempts;
  const settlesAtWindow = state.settledMarkdowns.length;
  state.locked = false;
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  await capture.flush();

  expect(state.openAttempts).toBe(attemptsAtWindow);
  expect(state.settledMarkdowns).toHaveLength(settlesAtWindow);
  finishDelete(true);
  await capture.stop();
}, 20_000);

it("a delete window that closes hands the debt back instead of stranding it", async () => {
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-delete-payment-release-",
  );
  const { session } = await openWithOneEdit(capture, "survives the window");
  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");
  finishDelete(false);
  state.locked = false;

  await expect
    .poll(() => state.settledMarkdowns, { timeout: 15_000 })
    .toContain("survives the window");
  await capture.stop();
}, 20_000);

it("a debt's ladder settles nothing while its path's delete is in flight", async () => {
  // The delete seam suspends the existing debt for the whole disk interval.
  // Its first timer rung passes while the finisher is held, then a successful
  // outcome cancels the debt without materializing the path.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-delete-ladder-payment-",
  );
  const { session } = await openWithOneEdit(capture, "written by the ladder");
  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );
  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");
  const generationAtDelete = state.generation;

  state.locked = false;
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  await capture.flush();
  expect(state.generation).toBe(generationAtDelete);
  expect(state.settledMarkdowns).toEqual([]);

  finishDelete(true);
  await capture.stop();
}, 20_000);

it("a move window refuses a live open before it reaches the daemon", async () => {
  // #696 stopped detached-debt payment inside this interval. #697 closes the
  // earlier entrance too: a live open cannot create the session that could
  // later register a debt or settle the moved-from path.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-move-inflight-",
  );
  await writeFile(join(rootPath, "note.md"), "stale artifact\n", "utf8");

  const finishMove = await capture.beginFileRename("note.md", "moved.md");
  const attemptsAtMove = state.openAttempts;
  await expectRemovalOpenRefused(
    capture,
    "note.md",
    "dohc is still moving note.md.",
  );
  await capture.flush();

  // THE FACT: no reopen of the moved-from path, and nothing written to it.
  expect(state.openAttempts).toBe(attemptsAtMove);
  expect(state.settledMarkdowns).toEqual([]);

  await finishMove(true);
  await capture.stop();
}, 25_000);

it("a delete window refuses a live open while the disk delete is unfinished", async () => {
  // The disk delete runs off the capture chain. A live open can therefore be
  // queued while that work is unfinished unless the open door checks the
  // existing #696 interval. No timer decides this assertion.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-delete-window-",
  );
  await writeFile(join(rootPath, "note.md"), "stale artifact\n", "utf8");

  // The delete starts. Its disk work has not reported, so the finisher is held.
  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");

  const generationAtDelete = state.generation;
  await expectRemovalOpenRefused(
    capture,
    "note.md",
    "dohc is still deleting note.md.",
  );

  // THE FACT: the path being deleted was never reopened and never written.
  expect(state.settledMarkdowns).toEqual([]);
  expect(state.generation).toBe(generationAtDelete);

  finishDelete(true);
  await capture.stop();
}, 20_000);

it("a failed delete closes its window before a later debt is paid", async () => {
  // The fence is an interval, not a verdict. A failed delete leaves the path
  // in place, so the next live open must succeed and any later debt must pay.
  //
  // MUTATION: never call `closeRemovalWindow` in the finisher -> the drain is
  // refused forever and the rename throws instead of settling.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-delete-window-release-",
  );
  await writeFile(join(rootPath, "note.md"), "stale artifact\n", "utf8");

  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");
  await expectRemovalOpenRefused(
    capture,
    "note.md",
    "dohc is still deleting note.md.",
  );

  // The delete FAILED. The path is still there and the open fence must lift.
  finishDelete(false);

  const { session } = await openWithOneEdit(capture, "survives the window");
  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );
  state.locked = false;

  // The very next drain lands it — no timer, no backoff, nothing stranded.
  const finish = await capture.beginFileRename("note.md", "renamed.md");
  expect(state.settledMarkdowns).toEqual(["survives the window"]);
  await finish(true);
  await capture.stop();
}, 20_000);

it("a failed move holds its window across the rollback, not just up to it", async () => {
  // #696 keeps the interval open until engine rollback completes. #697 makes
  // the observable contract direct: an open is refused while that interval
  // stands and succeeds only after the failed move has rolled back.
  //
  // TWO MUTATIONS, one per assertion:
  //   - close the window before rollback -> the queued open enters the gap.
  //   - never close it -> the open after rollback is still refused.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-move-rollback-gap-",
  );
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
  expect(state.settledMarkdowns).toEqual([]);
  const reopened = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  await reopened.close({ settle: false });
  await (await parked).close({ settle: false });
  await capture.stop();
}, 20_000);

it("a failed no-op move closes its window before a later debt is paid", async () => {
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
  await expectRemovalOpenRefused(
    capture,
    "dir/note.md",
    "dohc is still moving dir.",
  );
  await finishMove(false);

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

  // The next move drains the descendant's debt by prefix, exactly as the
  // first one would have.
  const finish = await capture.beginFileRename("dir", "moved");
  expect(state.settledMarkdowns).toEqual(["survives a failed folder move"]);
  await finish(true);
  await capture.stop();
}, 20_000);

it("a delete-window open creates no session, debt, or settle", async () => {
  // The full absence proof: after the refused open and a drained capture
  // chain, the daemon generation and settled output are unchanged.
  const { capture, state } = await lockedRebindCapture("dohc-ydoc-delete-ladder-");
  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");
  const generationAtDelete = state.generation;
  await expectRemovalOpenRefused(
    capture,
    "note.md",
    "dohc is still deleting note.md.",
  );
  await capture.flush();

  expect(state.generation).toBe(generationAtDelete);
  expect(state.settledMarkdowns).toEqual([]);

  // The delete landed. With no late open there is no debt to cancel and no
  // retry trace to wait for.
  finishDelete(true);
  expect(state.settledMarkdowns).toEqual([]);
  await capture.stop();
}, 25_000);

it("a folder move fences late live opens on the no-op finisher path", async () => {
  // `beginFileRename` returns a NO-OP finisher for everything the engine
  // rename declines — folders, binary, untracked paths — but the disk move
  // still happens, so a late live session could recreate the moved-from tree.
  // The test above covers the engine-rename finisher; without this one, the
  // no-op path carries the fix untested (verified: mutating only the no-op
  // finisher leaves the test above green).
  //
  // MUTATION: return a bare `async () => {}` no-op again -> the descendant
  // open is not fenced.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-foldermove-race-",
  );
  await mkdir(join(rootPath, "dir"), { recursive: true });
  await writeFile(join(rootPath, "dir", "note.md"), "stale artifact\n", "utf8");

  // A directory is not engine-renamable text, so this hands back the no-op.
  const finishMove = await capture.beginFileRename("dir", "moved");
  const generationAtMove = state.generation;
  await expectRemovalOpenRefused(
    capture,
    "dir/note.md",
    "dohc is still moving dir.",
  );

  await finishMove(true);

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

it("a rename after a terminal settle refusal refuses instead of saving stale content", async () => {
  // #681, terminal-settle door (conflict-stale-target branch):
  // `standDownFromWrite` used to delete the debt entry here too, so a rename
  // right after this stand-down would have read the STALE pre-lock disk
  // artifact as proof the write landed and recorded it under the new name.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-terminal-rename-",
  );
  await writeFile(join(rootPath, "note.md"), "stale pre-lock artifact\n", "utf8");
  const { session } = await openWithOneEdit(capture, "conflicting edit");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

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

  // RED against current main: absence read as landed, so this resolved and
  // recorded renamed.md from the stale pre-lock text instead of refusing.
  await expect(
    capture.beginFileRename("note.md", "renamed.md"),
  ).rejects.toThrow(
    "dohc could not rename note.md. dohc gave up on writing note.md earlier, so its last edits never reached disk. The edits stay in the document's history. Open note.md to write them again. Then rename note.md again.",
  );
  await expect(readFile(join(rootPath, "renamed.md"), "utf8")).rejects.toThrow();
  expect(state.settledMarkdowns).toEqual([]);
  await capture.stop();
}, 25_000);

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

it("a rename after a symlink stand-down refuses instead of saving stale content", async () => {
  // #681, blocked-target door: `standDownFromBlockedTarget` reaches the same
  // `standDownFromWrite` as the other two doors, which used to delete the
  // debt entry. `beginFileRename` read that absence as proof the write
  // landed, read the moved-from disk (the STALE pre-lock text a symlinked
  // target never received), and would have recorded it as a new moment
  // before renaming — the exact silent stale moment #681 names.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-symlink-rename-",
  );
  await writeFile(join(rootPath, "note.md"), "stale pre-lock artifact\n", "utf8");
  const { session } = await openWithOneEdit(capture, "never written");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  state.locked = false;
  state.unmaterialized = true;
  await expect
    .poll(
      () => state.errorMessages.filter((message) => message.includes("symlink")),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);

  // RED against current main: absence read as landed, so this resolved and
  // recorded renamed.md from the stale pre-lock text instead of refusing.
  await expect(
    capture.beginFileRename("note.md", "renamed.md"),
  ).rejects.toThrow(
    "dohc could not rename note.md. dohc gave up on writing note.md earlier, so its last edits never reached disk. The edits stay in the document's history. Open note.md to write them again. Then rename note.md again.",
  );
  await expect(readFile(join(rootPath, "renamed.md"), "utf8")).rejects.toThrow();
  expect(state.settledMarkdowns).toHaveLength(0);
  await capture.stop();
}, 25_000);

it("reopening a stood-down path without a real settle leaves the marker refusing", async () => {
  // #681 round 2, P1 (codex): an open alone used to clear the marker, but
  // it proves only that no conflicting lease survives — not that anything
  // reached disk. Closing with settle:false runs no settle at all, so disk
  // stays exactly as stale as the stand-down left it. Clearing here was the
  // defect recreated: this exact sequence used to make the next rename
  // record that stale artifact as landed.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-standdown-noclear-",
  );
  await writeFile(join(rootPath, "note.md"), "stale pre-lock artifact\n", "utf8");
  const { session } = await openWithOneEdit(capture, "never written");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  state.locked = false;
  state.unmaterialized = true;
  await expect
    .poll(
      () => state.errorMessages.filter((message) => message.includes("symlink")),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);

  // The refusal is live before recovery.
  await expect(
    capture.beginFileRename("note.md", "renamed.md"),
  ).rejects.toThrow(/dohc gave up on writing note\.md earlier/);

  // The user reopens the path but the close that follows settles nothing.
  state.unmaterialized = false;
  const reopened = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  await reopened.close({ settle: false });

  // RED before the redesign: the open alone had already cleared the
  // marker, so this resolved instead of refusing.
  await expect(
    capture.beginFileRename("note.md", "renamed.md"),
  ).rejects.toThrow(/dohc gave up on writing note\.md earlier/);
  await expect(readFile(join(rootPath, "renamed.md"), "utf8")).rejects.toThrow();
  await capture.stop();
}, 25_000);

it("onSettled clearing a stood-down flag does not strand a debt still awaiting its own release", async () => {
  // #681 round 4, O3 (certifier, required): round 3's onSettled fix
  // (clear `stoodDown`, not delete the entry) had no pin of its own —
  // mutating it back to entry-deletion left every other test green.
  //
  // The reachable interleaving: a debt stands down over a version switch
  // WHILE its own retry session's release is STILL being refused —
  // `standDownFromWrite` cancels W but explicitly leaves L's ladder armed
  // when a lease is still held. A different session then settles for real
  // at the same path (simplified here to a plain reopen — a rename onto
  // the path first reaches the identical state, since round 3's fix
  // leaves a destination-side stood-down debt untouched). If THAT settle's
  // `onSettled` deletes the whole entry instead of clearing the flag, the
  // first debt's still-retrying release ladder loses its only owner: its
  // next timer tick's ownership check finds nothing to match, stops
  // retrying, and the daemon lease strands at ydoc-session-busy.
  const { capture, state, loopback, workspaceId } = await lockedRebindCapture(
    "dohc-ydoc-onsettled-strand-",
  );
  const { session } = await openWithOneEdit(capture, "object A");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The retry settles (materialized), a peer update outruns it, and the
  // release is refused: pendingRelease is now set, the write not yet
  // cancelled — the same setup as "a cancelled debt whose release is
  // refused keeps retrying that release", above.
  state.locked = false;
  state.emitUpdateAfterSettle = true;
  state.closeFailure = new Error("ydoc-unsettled-close");
  await expect
    .poll(
      () => state.closeCalls.filter((generation) => generation === 2).length,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  // Before the next retry fires, the workspace moves to a new version.
  // That retry's version check trips FIRST, ahead of its own
  // pendingRelease check, so it stands down the write while L is still
  // unresolved.
  const ensured = await loopback.sendRequest({
    id: 9_301,
    method: "versions.ensureMain",
    workspace: workspaceId,
    params: { workspaceId },
  });
  const main = ensured.result as { id?: string };
  const created = await loopback.sendRequest({
    id: 9_302,
    method: "versions.createNamed",
    workspace: workspaceId,
    params: {
      workspaceId,
      name: "strand-target",
      fromVersionId: main.id ?? "main",
    },
    idempotencyKey: "strand-create-1",
  } as Parameters<typeof loopback.sendRequest>[0]);
  const createdVersion = created.result as { id?: string };
  await loopback.sendRequest({
    id: 9_303,
    method: "versions.setActive",
    workspace: workspaceId,
    params: { workspaceId, versionId: createdVersion.id! },
  });

  // The stand-down fired: W gave up. L (the refused release) survives it.
  await expect
    .poll(
      () =>
        state.errorMessages.filter((message) =>
          message.includes("the version fence replay owns pending writes"),
        ),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);

  // A different session lands at the same path and settles for real.
  const reopened = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const mirror = new Y.Doc();
  Y.applyUpdate(mirror, reopened.initialUpdate);
  const before = Y.encodeStateVector(mirror);
  mirror.getText("plainText").insert(0, "object B");
  await reopened.applyLocalUpdate(Y.encodeStateAsUpdate(mirror, before));
  await reopened.settleNow();

  // RED under the entry-deletion mutant: the first debt's release ladder
  // finds nothing to match on its next tick and stops retrying, so this
  // never lands even once the daemon accepts the release.
  const releasesBeforeRecovery = state.closesWithSettleFalse;
  state.closeFailure = null;
  await expect
    .poll(() => state.closesWithSettleFalse, { timeout: 25_000 })
    .toBeGreaterThan(releasesBeforeRecovery);

  await reopened.close({ settle: false });
  await capture.stop();
}, 45_000);

it("a recovered debt with no retained release does not linger for a later delete to falsely cancel", async () => {
  // #681 round 6, codex P2-A (real, small): `onSettled`'s recovery only
  // flipped `stoodDown`. When the retry session's release had ALREADY
  // completed — the symlink-block door never holds one open at all, per
  // its own `pendingRelease` reasoning — no lease obligation remained,
  // yet the entry lingered forever anyway. A later delete of the
  // recovered path then found it and traced a cancellation for a write
  // that had already landed, and the closure graph stayed retained past
  // workspace stop.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-recovered-no-lease-",
  );
  const { session } = await openWithOneEdit(capture, "never written");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  state.locked = false;
  state.unmaterialized = true;
  await expect
    .poll(
      () => state.errorMessages.filter((message) => message.includes("symlink")),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);

  // The user replaces the symlink, reopens, and settles for real — this
  // door never holds a lease open, so recovery leaves nothing owed.
  state.unmaterialized = false;
  const reopened = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const mirror = new Y.Doc();
  Y.applyUpdate(mirror, reopened.initialUpdate);
  const before = Y.encodeStateVector(mirror);
  mirror.getText("plainText").insert(0, "recovered, nothing owed");
  await reopened.applyLocalUpdate(Y.encodeStateAsUpdate(mirror, before));
  await reopened.settleNow();
  // Anti-vacuity: the recovery settle actually reached disk — otherwise
  // the entry could be retired for an unrelated reason and this test
  // would still pass on the negative trace assertion alone. (The doc
  // carries the journaled "never written" text too — the recovery
  // session's seed, per the fake's own replay of durable state.)
  expect(
    state.settledMarkdowns.some((text) => text.includes("recovered, nothing owed")),
  ).toBe(true);
  await reopened.close({ settle: false });
  // Drain the chain so recovery's own enqueued pay() retires the entry
  // before the delete below.
  await capture.flush();

  // An external program deletes the recovered path.
  capture.captureBatch([{ path: "note.md", operation: "delete" }]);
  await capture.flush();

  // RED before the fix: the entry lingered after recovery, so this
  // delete found it and traced a cancellation for a write that had
  // already landed.
  expect(
    state.errorMessages.some((message) =>
      message.includes("removed the path while a pending write waited"),
    ),
  ).toBe(false);
  await capture.stop();
}, 25_000);

it("a materialized settle after reopening a stood-down path clears the marker and re-enables the rename", async () => {
  // #681 round 2's honest lifecycle end: only PROOF clears the marker — a
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
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  state.locked = false;
  state.unmaterialized = true;
  await expect
    .poll(
      () => state.errorMessages.filter((message) => message.includes("symlink")),
      { timeout: 15_000 },
    )
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
  // Anti-vacuity: THIS settle is what cleared it, not some unrelated path.
  // (The doc carries the journaled "never written" text too — the recovery
  // session's seed, per the fake's own replay of durable state.)
  expect(
    state.settledMarkdowns.some((text) => text.includes("recovered edit")),
  ).toBe(true);

  // The marker is gone: the rename now proceeds like any ordinary one.
  const finish = await capture.beginFileRename("note.md", "renamed.md");
  await finish(true);
  await reopened.close({ settle: false });
  await capture.stop();
}, 25_000);

it("a rename's own vacate settle clears a stood-down marker for a session still mid-recovery", async () => {
  // #681 round 2, P1 follow-up: `beginFileRename` now vacates live sessions
  // over its endpoints BEFORE draining detached debts, exactly so a
  // session that reopened a stood-down path but has not settled on its own
  // yet gets that chance here rather than being refused on a marker its
  // own vacate settle is about to clear.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-standdown-vacate-clears-",
  );
  await writeFile(join(rootPath, "note.md"), "stale pre-lock artifact\n", "utf8");
  const { session } = await openWithOneEdit(capture, "never written");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  state.locked = false;
  state.unmaterialized = true;
  await expect
    .poll(
      () => state.errorMessages.filter((message) => message.includes("symlink")),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);

  // The user reopens and edits, but the rename arrives before they settle
  // or close it themselves.
  state.unmaterialized = false;
  const reopened = await capture.openYDocSession({
    path: "note.md",
    onRemoteUpdate: () => undefined,
  });
  const mirror = new Y.Doc();
  Y.applyUpdate(mirror, reopened.initialUpdate);
  const before = Y.encodeStateVector(mirror);
  mirror.getText("plainText").insert(0, "recovered mid-rename");
  await reopened.applyLocalUpdate(Y.encodeStateAsUpdate(mirror, before));

  // RED under the original drain-then-vacate order: the drain would see
  // the marker still set (this session never settled anything itself) and
  // refuse before its own vacate ever ran.
  const finish = await capture.beginFileRename("note.md", "renamed.md");
  await finish(true);
  // Anti-vacuity: the vacate's OWN settle is what cleared it.
  expect(
    state.settledMarkdowns.some((text) => text.includes("recovered mid-rename")),
  ).toBe(true);
  await capture.stop();
}, 25_000);

it("a cancelled debt's registry entry does not survive its own release landing", async () => {
  // #681 round 2, P2 (codex, verified): `discardDetachedLockedDebt`
  // re-registers a NONTERMINAL entry (stoodDown: false) when the release it
  // owes is refused (#595 round 11). Once that release finally lands, only
  // L was ever left to finish. Leaving the entry in place made a later
  // rename over the same, already-removed path falsely claim another
  // program still held it.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-cancel-release-clears-",
  );
  const { session } = await openWithOneEdit(capture, "leased and deleted");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  // The retry settles, a peer update outruns it, and the release is
  // refused — the same setup as "a cancelled debt whose release is refused
  // keeps retrying that release", above.
  state.locked = false;
  state.emitUpdateAfterSettle = true;
  state.closeFailure = new Error("ydoc-unsettled-close");
  await expect
    .poll(
      () => state.closeCalls.filter((generation) => generation === 2).length,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  const finishDelete = await capture.settleAndCloseLiveSessionsForPath("note.md");
  finishDelete(true);
  await expect
    .poll(() => state.errors.filter((c) => c.includes("close retry")), {
      timeout: 15_000,
    })
    .not.toHaveLength(0);

  const releasesBeforeLanding = state.closesWithSettleFalse;
  state.closeFailure = null;
  await expect
    .poll(() => state.closesWithSettleFalse, { timeout: 20_000 })
    .toBeGreaterThan(releasesBeforeLanding);

  // Poll the OUTCOME rather than sleep a fixed window past the release: a
  // refused call throws before `openRemovalWindow` ever opens (a retry
  // registers nothing to clean up), so retrying here is safe, and this
  // does not depend on how many ticks the ownership check actually needs.
  //
  // RED before the fix: the stale nonterminal entry never left the
  // registry, so this kept rejecting "Another program still has note.md
  // open" even though nothing holds it anymore.
  let finish: Awaited<ReturnType<typeof capture.beginFileRename>> | undefined;
  await expect
    .poll(
      async () => {
        try {
          finish = await capture.beginFileRename("note.md", "elsewhere.md");
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  expect(typeof finish).toBe("function");
  await capture.stop();
}, 60_000);

it("a watcher-captured external delete cancels a stood-down debt instead of leaving it immortal", async () => {
  // #681 round 2, P2 (codex, verified): the delete/move seams suspend and
  // cancel a debt on removal, but an EXTERNAL delete — never runs through
  // them — left a stood-down marker sitting at a dead path forever. Since
  // `beginFileRename`'s endpointMatch checks the destination too, renaming
  // any OTHER file onto that freed path would have refused with an
  // instruction naming a file no longer there.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-external-delete-",
  );
  const { session } = await openWithOneEdit(capture, "never written");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  state.locked = false;
  state.unmaterialized = true;
  await expect
    .poll(
      () => state.errorMessages.filter((message) => message.includes("symlink")),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);

  // An external program deletes the path directly; the watcher observes it.
  capture.captureBatch([{ path: "note.md", operation: "delete" }]);
  await capture.flush();

  // RED before the fix: nothing cancelled the marker or traced its removal.
  expect(
    state.errorMessages.some((message) =>
      message.includes("an external delete of note.md removed the path"),
    ),
  ).toBe(true);

  // And it stays cancelled: no reopen, no resurrection.
  const generationAtDelete = state.generation;
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  expect(state.generation).toBe(generationAtDelete);
  expect(state.settledMarkdowns).toEqual([]);
  await capture.stop();
}, 20_000);

it("an engine-materialized delete of a stood-down path also cancels its debt", async () => {
  // #681 round 4, codex P2 (real): a version switch whose target omits the
  // file, or a relay fast-forward delete, removes the path through
  // `materialize()` — which registers the deletion as an EXPECTED engine
  // event (its own `registerExpectedEngineEvents` call, same as this test
  // does directly) so it never re-journals as a new moment. The round-3
  // cleanup was gated on `isExternalDelete`, so this exact door left the
  // marker behind: the ENGINE removing a path is exactly as terminal for
  // the abandoned write as an external delete — only the reason differs.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-materialized-delete-",
  );

  // note.md must be TRACKED before the debt exists: a stray journal from
  // the Q1b mutant (the hoisted cleanup's peek reverted to a consume) is
  // observable only if there is something for `deleteIfTracked` to
  // record — an untracked path's delete is a silent no-op either way.
  await writeFile(join(rootPath, "note.md"), "already tracked\n", "utf8");
  capture.captureBatch([{ path: "note.md", operation: "update" }]);
  await capture.flush();

  const { session } = await openWithOneEdit(capture, "never written");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  state.locked = false;
  state.unmaterialized = true;
  await expect
    .poll(
      () => state.errorMessages.filter((message) => message.includes("symlink")),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);

  // The engine registers the removal as expected — exactly what
  // `materialize()` does for a delete operation during a version switch —
  // then the watcher observes the disk change that follows.
  capture.registerExpectedEngineEvents([
    { path: "note.md", operation: "delete" },
  ]);
  await rm(join(rootPath, "note.md"));
  capture.captureBatch([{ path: "note.md", operation: "delete" }]);
  await capture.flush();

  // RED before the fix: cleanup was gated on isExternalDelete, so an
  // EXPECTED delete never reached it and this trace never appeared.
  expect(
    state.errorMessages.some((message) =>
      message.includes("dohc's own removal of note.md removed the path"),
    ),
  ).toBe(true);

  // Q1b (certifier, required): a peek-to-consume regression on the
  // hoisted cleanup keeps the trace above correct — peek and consume
  // return the identical verdict — but steals the token before
  // `captureOnePath`'s own real consumption. That leaves the engine's
  // own removal reading as external THERE, and `deleteIfTracked` records
  // a spurious new "delete" moment for a path the engine already knows
  // is gone. Assert the journal, not just the trace.
  const page = await capture.listMoments();
  const strayDeletes = page.moments.filter(
    (moment) => moment.path === "note.md" && moment.operation === "delete",
  );
  expect(strayDeletes).toHaveLength(0);

  // The path is recreated (the version now active has a file there, or
  // the user made a new one) and a rename now proceeds — no stale refusal.
  await writeFile(join(rootPath, "note.md"), "fresh content\n", "utf8");
  const finish = await capture.beginFileRename("note.md", "renamed.md");
  expect(typeof finish).toBe("function");
  await capture.stop();
}, 20_000);

it("in the daemon-owned production configuration, an external delete still cancels a stood-down debt", async () => {
  // #681 round 6, codex P2-B (real — the same class as #736's dead fence):
  // production constructs capture with `daemonOwnsCapture: true`
  // (engineCaptureGate.ts:65), under which `captureBatch` used to return
  // before ever calling `captureOnePath` — the function that carried
  // rounds 3-5's entire debt-cleanup fix. Every prior external-removal
  // pin drove this file's JS-capture harness (`daemonOwnsCapture`
  // unset), so none of them proved the SHIPPED configuration behaved the
  // same way. Detached debts arise independently of which side captures
  // disk content — they come from a Y.Doc session's own close failure,
  // which `daemonOwnsCapture` never gates — so the cleanup has to run
  // for them regardless.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-daemon-owned-cleanup-",
    { daemonOwnsCapture: true },
  );
  const { session } = await openWithOneEdit(capture, "never written");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  state.locked = false;
  state.unmaterialized = true;
  await expect
    .poll(
      () => state.errorMessages.filter((message) => message.includes("symlink")),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);

  // An external program deletes the path. The watcher still reports the
  // same event in daemon-owned mode — only the disk-to-engine CAPTURE is
  // the daemon's job, not this registry's own cleanup. `flush()` is not
  // usable here: in daemon-owned mode it also flushes the DAEMON's own
  // capture over the wire, which this loopback harness does not model —
  // poll the observable trace instead.
  capture.captureBatch([{ path: "note.md", operation: "delete" }]);

  // RED before the fix: `captureBatch` returned before `captureOnePath`
  // ever ran, so this trace never appeared and the marker never cleared.
  await expect
    .poll(
      () =>
        state.errorMessages.some((message) =>
          message.includes("an external delete of note.md removed the path"),
        ),
      { timeout: 15_000 },
    )
    .toBe(true);

  // The path is recreated and a rename now proceeds cleanly — no stale
  // refusal, in the same configuration the app actually ships.
  await writeFile(join(rootPath, "note.md"), "fresh content\n", "utf8");
  const finish = await capture.beginFileRename("note.md", "elsewhere.md");
  expect(typeof finish).toBe("function");
  // No `capture.stop()`/`flush()` here: in daemon-owned mode both also
  // flush the DAEMON's own capture over the wire (a real RPC this
  // loopback harness does not model). `session.close()` above DID arm a
  // detached retry timer regardless of `capture.start()` — but the
  // external delete's own cancellation already cleared it
  // (`discardDetachedLockedDebt`, reached through `cancelSuspendedDebts`),
  // so nothing is left running past this test.
}, 20_000);

it("a stood-down debt on the rename's destination survives a move that fails because the destination exists", async () => {
  // #681 round 3, P1 (codex, real — the round-2 destination cancel rested
  // on a false premise). `movePath` REFUSES an existing destination
  // (workspaceFiles.ts, `destExists`) — moves never overwrite. Cancelling
  // the destination's stood-down debt at PREPARE time, before the disk
  // move even runs, destroyed the marker for a move that could then FAIL —
  // leaving the abandoned write undefended even though nothing about it
  // had actually changed.
  //
  // The fix leaves the destination's debt alone: an existing destination
  // makes `movePath` fail on its own with the standard, followable
  // "Destination already exists" refusal; an externally removed one is
  // already cleared by the watcher's own delete-cancel. Neither scenario
  // needs this seam to touch the marker at all.
  const { capture, state, rootPath } = await lockedRebindCapture(
    "dohc-ydoc-dest-move-fails-",
  );
  await writeFile(join(rootPath, "source.md"), "moving in\n", "utf8");
  await writeFile(join(rootPath, "target.md"), "still there\n", "utf8");
  const { session } = await openWithOneEdit(capture, "never written", "target.md");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  state.locked = false;
  state.unmaterialized = true;
  await expect
    .poll(
      () => state.errorMessages.filter((message) => message.includes("symlink")),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);

  // Prepare does not refuse and does not touch the destination's marker —
  // the disk-level check is what decides, once the move is attempted.
  const finish = await capture.beginFileRename("source.md", "target.md");
  // The disk move fails: target.md is still there. main.ts reports that
  // outcome to the finisher.
  await finish(false);

  // RED before the fix: the marker was already cancelled at prepare time
  // (before the failed move even ran), so this resolved instead of
  // refusing.
  await expect(
    capture.beginFileRename("target.md", "elsewhere.md"),
  ).rejects.toThrow(
    "dohc could not rename target.md. dohc gave up on writing target.md earlier, so its last edits never reached disk. The edits stay in the document's history. Open target.md to write them again. Then rename target.md again.",
  );
  await capture.stop();
}, 25_000);

it("a write-classified event over an already-absent stood-down path also cancels its debt", async () => {
  // #681 round 3 (cert N4b): the "absent" branch — a write-classified
  // watcher event that, once read, turns out to have no file — is a
  // SEPARATE door from the explicit "delete" operation branch above it.
  // Both call cancelSuspendedDebts with the same trace, but only the
  // "delete" branch had a pin: severing this one's call left every
  // existing restart test green.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-absent-branch-delete-",
  );
  const { session } = await openWithOneEdit(capture, "never written");

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  state.locked = false;
  state.unmaterialized = true;
  await expect
    .poll(
      () => state.errorMessages.filter((message) => message.includes("symlink")),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);

  // The symlink stand-down never materialized note.md, so no file exists
  // at rootPath/note.md — an "update"-classified event resolves to
  // disk.kind === "absent" once captureOnePath reads it: the write-
  // classified door, not the explicit "delete" operation one.
  capture.captureBatch([{ path: "note.md", operation: "update" }]);
  await capture.flush();

  // RED under a sever of just this branch's cancel call: nothing traces
  // the removal, so this assertion is what catches it.
  expect(
    state.errorMessages.some((message) =>
      message.includes("an external delete of note.md removed the path"),
    ),
  ).toBe(true);

  // Pin the outcome, not only the trace: a change that keeps the log but
  // leaves the entry in `detachedLockedDebts` would still pass the
  // assertion above.
  const finish = await capture.beginFileRename("note.md", "renamed.md");
  expect(typeof finish).toBe("function");
  await capture.stop();
}, 20_000);

it("a watcher-captured external delete of a policy-excluded path still cancels its stood-down debt", async () => {
  // #681 round 3, P2 (codex, real): the cleanup ran AFTER
  // `captureOnePath`'s policy-tracking gate, so an excluded path's
  // external delete could never reach it — the same immortal-marker gap
  // as the tracked case (round 2), through a different door. A debt can
  // exist for an excluded path regardless: opening a live session is never
  // gated by policy, only capture is (policyTracksPath has no call site in
  // `openYDocSessionTask`).
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-excluded-external-delete-",
  );
  const { session } = await openWithOneEdit(
    capture,
    "never written",
    "node_modules/pkg/index.js",
  );

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  state.locked = false;
  state.unmaterialized = true;
  await expect
    .poll(
      () => state.errorMessages.filter((message) => message.includes("symlink")),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);

  // An external program deletes the excluded path directly.
  capture.captureBatch([
    { path: "node_modules/pkg/index.js", operation: "delete" },
  ]);
  await capture.flush();

  // Anti-vacuity: the cleanup ran, not just "nothing refused by accident".
  expect(
    state.errorMessages.some((message) =>
      message.includes(
        "an external delete of node_modules/pkg/index.js removed the path",
      ),
    ),
  ).toBe(true);

  // RED before the fix: policyTracksPath("node_modules/...") is false, so
  // the cleanup never ran and this rejected instead of resolving.
  const finish = await capture.beginFileRename(
    "node_modules/pkg/index.js",
    "node_modules/pkg/renamed.js",
  );
  expect(typeof finish).toBe("function");
  await capture.stop();
}, 20_000);

it("a write-classified event over an already-absent, policy-excluded stood-down path also cancels its debt", async () => {
  // #681 round 4, O4 (certifier, required): round 3's hoist moved the
  // "delete" OPERATION branch's cleanup ahead of the policy gate, but the
  // "absent" branch — reached only after `readDiskTextState`, which itself
  // only ran after that same gate — stayed behind it. An excluded path
  // whose removal arrives write-classified (the watcher's classification
  // lagging disk, exactly like the tracked case above) could still never
  // reach it: the racy stat-then-read door the round-3 hoist missed.
  const { capture, state } = await lockedRebindCapture(
    "dohc-ydoc-excluded-absent-branch-",
  );
  const { session } = await openWithOneEdit(
    capture,
    "never written",
    "node_modules/pkg/index.js",
  );

  state.locked = true;
  state.replicated = true;
  await expect(session.close()).rejects.toThrow(
    /released, but its pre-close settle failed/,
  );

  state.locked = false;
  state.unmaterialized = true;
  await expect
    .poll(
      () => state.errorMessages.filter((message) => message.includes("symlink")),
      { timeout: 15_000 },
    )
    .not.toHaveLength(0);

  // No file exists at rootPath/node_modules/pkg/index.js (never
  // materialized), so an "update"-classified event resolves to absent once
  // read — the write-classified door, on an excluded path.
  capture.captureBatch([
    { path: "node_modules/pkg/index.js", operation: "update" },
  ]);
  await capture.flush();

  // RED before the fix: the disk read (and the cleanup gated on it) ran
  // only after the policy-tracking gate, so this excluded path's cleanup
  // never fired.
  expect(
    state.errorMessages.some((message) =>
      message.includes(
        "an external delete of node_modules/pkg/index.js removed the path",
      ),
    ),
  ).toBe(true);

  const finish = await capture.beginFileRename(
    "node_modules/pkg/index.js",
    "node_modules/pkg/renamed.js",
  );
  expect(typeof finish).toBe("function");
  await capture.stop();
}, 20_000);

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
