import type { ArtifactAssetDescriptor } from "@dohc/workspace-engine-client";
import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";

import {
  YDocPathNotInVersionError,
  YDocRemovalInProgressError,
  YDocSessionUnreleasedError,
  type WorkspaceEngineYDocProviderSession,
} from "./workspaceEngineCapture";
import {
  createEngineYDocSessionIpc,
  type EngineYDocIpcSender,
  type EngineYDocSessionCapture,
} from "./engineYDocSessionIpc";
import { ENGINE_YDOC_UPDATE_MAX_BYTES } from "../ipc/channels";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeSender implements EngineYDocIpcSender {
  readonly sent: Array<{ channel: string; payload: unknown }> = [];
  readonly #destroyedListeners: Array<() => void> = [];
  #destroyed = false;
  #sendError: Error | null = null;

  constructor(readonly id: number) {}

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  send(channel: string, payload: unknown): void {
    if (this.#destroyed) throw new Error("sender destroyed");
    if (this.#sendError) throw this.#sendError;
    this.sent.push({ channel, payload });
  }

  once(event: "destroyed", listener: () => void): this {
    if (event === "destroyed") this.#destroyedListeners.push(listener);
    return this;
  }

  destroy(): void {
    this.#destroyed = true;
    for (const listener of this.#destroyedListeners) listener();
  }

  failSendsWith(error: Error | null): void {
    this.#sendError = error;
  }
}

function asset(id: string, ref = `assets/${id}.png`): ArtifactAssetDescriptor {
  return {
    id,
    mimeType: "image/png",
    created: 1,
    ref,
    sha256: "a".repeat(64),
  };
}

function providerSession(
  input: Partial<WorkspaceEngineYDocProviderSession> = {},
): WorkspaceEngineYDocProviderSession {
  const base = {
    doc: new Y.Doc(),
    initialUpdate: new Uint8Array(),
    path: "notes/a.md",
    contentKind: "richdoc",
    settleNow: vi.fn(async () => {
      throw new Error("settleNow is not used by this IPC adapter fixture");
    }),
    applyLocalUpdate: vi.fn((_update, onArmed) => onArmed?.()),
    applyExternalMarkdownEdit: vi.fn(async () => ({ supported: true })),
    readArtifactAsset: vi.fn(async (descriptor) => ({
      descriptor,
      bytes: new Uint8Array([1, 2, 3]),
    })),
    close: vi.fn(async () => undefined),
  } satisfies WorkspaceEngineYDocProviderSession;
  return Object.assign(base, input);
}

interface TestHarnessOptions {
  resolveDocumentPath?: (
    workspace: { workspaceId: string; rootPath: string },
    path: string,
  ) => Promise<string | null>;
  rendererWorkspaceId?: string;
}

function rendererSession(
  generationOf: () => number = () => 1,
  isAvailable: () => boolean = () => true,
  workspaceId = "workspace-1",
) {
  const generation = generationOf();
  return {
    workspaceId,
    generation,
    isCurrent: () => isAvailable() && generationOf() === generation,
  };
}

function harness(
  session = providerSession(),
  options: TestHarnessOptions = {},
) {
  const resolveDocumentPath =
    options.resolveDocumentPath ?? (async (_workspace, path: string) => path);
  let generation = 1;
  let retired = false;
  let readOnly = false;
  let capturedOpen:
    | Parameters<EngineYDocSessionCapture["openYDocSession"]>[0]
    | undefined;
  const capture: EngineYDocSessionCapture = {
    openYDocSession: vi.fn(async (input) => {
      capturedOpen = input;
      return session;
    }),
  };
  const onError = vi.fn();
  const ipc = createEngineYDocSessionIpc({
    sessionFor: () =>
      retired
        ? undefined
        : rendererSession(
            () => generation,
            () => !retired,
            options.rendererWorkspaceId,
          ),
    requireWorkspace: (workspaceId) => ({
      workspaceId,
      rootPath: "C:/workspace",
    }),
    captureFor: () => capture,
    ensureCaptureFor: vi.fn(async () => undefined),
    isSharedView: () => readOnly,
    resolveDocumentPath,
    onError,
  });
  return {
    ipc,
    capture,
    onError,
    session,
    capturedOpen: () => capturedOpen,
    setGeneration: (next: number) => {
      generation = next;
    },
    retireSession: () => {
      retired = true;
    },
    setReadOnly: (next: boolean) => {
      readOnly = next;
    },
  };
}

const openPayload = {
  workspaceId: "workspace-1",
  sessionId: "renderer-session-1",
  path: "notes/a.md",
};

describe("engine Y.Doc IPC adapter", () => {
  it("opens the canonical session and applies updates through its save sequence", async () => {
    const sender = new FakeSender(7);
    const h = harness();

    const opened = await h.ipc.open(sender, openPayload);

    expect(opened).toMatchObject({
      available: true,
      lineageGeneration: 1,
      artifactAssets: [],
    });
    expect(opened.initialUpdate).toBeInstanceOf(Uint8Array);
    expect(h.capturedOpen()).toMatchObject({
      path: "notes/a.md",
      contentKind: "richdoc",
    });
    await expect(
      h.ipc
        .fileMutationPort()
        .withDocumentUnowned("workspace-1", "notes/a.md", async () => true),
    ).rejects.toThrow(
      "The engine owns this live document. Close its editor before writing the file directly.",
    );

    expect(
      h.ipc.applyUpdate(sender, {
        sessionId: openPayload.sessionId,
        update: new Uint8Array([1]),
        lineageGeneration: 1,
        seq: 4,
      }),
    ).toEqual({ accepted: true });
    h.capturedOpen()?.onSaveState?.("settling", 9);
    h.capturedOpen()?.onSaveState?.("saved", 9);
    expect(sender.sent.slice(-2).map(({ payload }) => payload)).toEqual([
      { sessionId: openPayload.sessionId, state: "settling", seq: 4 },
      { sessionId: openPayload.sessionId, state: "saved", seq: 4 },
    ]);
  });

  it("refuses an open outside the renderer session's workspace", async () => {
    const sender = new FakeSender(7);
    const h = harness(providerSession(), {
      rendererWorkspaceId: "workspace-2",
    });

    await expect(h.ipc.open(sender, openPayload)).resolves.toEqual({
      available: false,
    });
    expect(h.capture.openYDocSession).not.toHaveBeenCalled();
  });

  it("reports current remote-update delivery failures but ignores stale senders", async () => {
    const sender = new FakeSender(7);
    const h = harness();
    await h.ipc.open(sender, openPayload);
    const deliveryError = new Error("renderer send failed");

    sender.failSendsWith(deliveryError);
    h.capturedOpen()?.onRemoteUpdate(new Uint8Array([1]));
    expect(h.onError).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("remote-update delivery failed"),
      deliveryError,
    );

    sender.failSendsWith(null);
    h.onError.mockClear();
    h.capturedOpen()?.onRemoteUpdate(
      new Uint8Array(ENGINE_YDOC_UPDATE_MAX_BYTES + 1),
    );
    expect(h.onError).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("remote-update delivery failed"),
      expect.any(Error),
    );

    h.onError.mockClear();
    h.setGeneration(2);
    h.capturedOpen()?.onRemoteUpdate(new Uint8Array([2]));
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("resolves the physical workspace path before reserving and opening it", async () => {
    const sender = new FakeSender(7);
    const resolveDocumentPath = vi.fn(
      async (
        _workspace: { workspaceId: string; rootPath: string },
        _path: string,
      ) =>
        "notes/a.md",
    );
    const h = harness(providerSession(), { resolveDocumentPath });

    await expect(
      h.ipc.open(sender, { ...openPayload, path: "alias/a.md" }),
    ).resolves.toMatchObject({ available: true });

    expect(resolveDocumentPath).toHaveBeenCalledWith(
      { workspaceId: "workspace-1", rootPath: "C:/workspace" },
      "alias/a.md",
    );
    expect(resolveDocumentPath.mock.calls.map(([, path]) => path)).toEqual([
      "alias/a.md",
      "alias/a.md",
    ]);
    expect(h.capturedOpen()).toMatchObject({ path: "notes/a.md" });
    await expect(
      h.ipc
        .fileMutationPort()
        .withDocumentUnowned("workspace-1", "notes/a.md", async () => true),
    ).rejects.toThrow("The engine owns this live document");
  });

  it.each([
    {
      requestedPath: "alias/note.md",
      canonicalPath: "drawings/scene.excalidraw",
      canonicalKind: "scene" as const,
    },
    {
      requestedPath: "alias/scene.excalidraw",
      canonicalPath: "notes/note.md",
      canonicalKind: "richdoc" as const,
    },
  ])(
    "refuses a $requestedPath leaf alias to a cross-kind $canonicalPath target",
    async ({ requestedPath, canonicalPath, canonicalKind }) => {
      const sender = new FakeSender(7);
      const resolveDocumentPath = vi.fn(async () => canonicalPath);
      const h = harness(
        providerSession({ path: canonicalPath, contentKind: canonicalKind }),
        { resolveDocumentPath },
      );

      await expect(
        h.ipc.open(sender, { ...openPayload, path: requestedPath }),
      ).resolves.toEqual({
        available: false,
        documentUnavailable: true,
      });

      expect(resolveDocumentPath).toHaveBeenCalledOnce();
      expect(h.capture.openYDocSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      requestedPath: "alias/note.md",
      canonicalPath: "notes/note.markdown",
      documentKind: "richdoc" as const,
    },
    {
      requestedPath: "alias/scene.excalidraw",
      canonicalPath: "drawings/scene.excalidraw",
      documentKind: "scene" as const,
    },
  ])(
    "keeps a same-kind $requestedPath leaf alias eligible for its canonical session",
    async ({ requestedPath, canonicalPath, documentKind }) => {
      const sender = new FakeSender(7);
      const resolveDocumentPath = vi.fn(async () => canonicalPath);
      const h = harness(
        providerSession({ path: canonicalPath, contentKind: documentKind }),
        { resolveDocumentPath },
      );

      await expect(
        h.ipc.open(sender, { ...openPayload, path: requestedPath }),
      ).resolves.toMatchObject({ available: true });

      expect(resolveDocumentPath).toHaveBeenCalledTimes(2);
      expect(h.capturedOpen()).toMatchObject({
        path: canonicalPath,
        contentKind: documentKind,
      });
    },
  );

  it("coordinates case aliases through their resolved physical path", async () => {
    const sender = new FakeSender(7);
    const canonicalPath = "Notes/Folder/A.md";
    const h = harness(providerSession({ path: canonicalPath }), {
      resolveDocumentPath: async () => canonicalPath,
    });
    await h.ipc.open(sender, {
      ...openPayload,
      path: "notes/folder/a.md",
    });

    const mutation = vi.fn(async () => undefined);
    await expect(
      h.ipc
        .fileMutationPort()
        .withDocumentUnowned("workspace-1", canonicalPath, mutation),
    ).rejects.toThrow("The engine owns this live document");
    expect(mutation).not.toHaveBeenCalled();

    h.ipc
      .fileMutationPort()
      .markDeletedUnderPath("workspace-1", "Notes/Folder");
    expect(sender.sent.at(-1)?.payload).toMatchObject({ state: "deleted" });
  });

  it("opens the workspace activity when the renderer outruns daemon startup", async () => {
    const sender = new FakeSender(7);
    let captureAvailable = false;
    const capture: EngineYDocSessionCapture = {
      openYDocSession: vi.fn(async () => providerSession()),
    };
    const ensureCaptureFor = vi.fn(async () => {
      captureAvailable = true;
    });
    const ipc = createEngineYDocSessionIpc({
      sessionFor: () => rendererSession(),
      requireWorkspace: (workspaceId) => ({
        workspaceId,
        rootPath: "C:/workspace",
      }),
      captureFor: () => (captureAvailable ? capture : null),
      ensureCaptureFor,
      isSharedView: () => false,
      resolveDocumentPath: async (_workspace, path) => path,
      onError: vi.fn(),
    });

    await expect(ipc.open(sender, openPayload)).resolves.toMatchObject({
      available: true,
    });
    expect(ensureCaptureFor).toHaveBeenCalledWith("workspace-1");
    expect(capture.openYDocSession).toHaveBeenCalledOnce();
  });

  it("releases a provider whose document kind does not match the request", async () => {
    const session = providerSession({ contentKind: "scene" });
    const sender = new FakeSender(7);
    const h = harness(session);

    await expect(h.ipc.open(sender, openPayload)).resolves.toEqual({
      available: false,
    });
    expect(session.close).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("kind-mismatched lineage"),
    );
  });

  it("reports when a kind-mismatched provider may still hold the document", async () => {
    const releaseError = new Error("provider close failed");
    const session = providerSession({
      contentKind: "scene",
      close: vi.fn(async () => {
        throw releaseError;
      }),
    });
    const sender = new FakeSender(7);
    const h = harness(session);

    await expect(h.ipc.open(sender, openPayload)).resolves.toEqual({
      available: false,
      engineMayHoldDocument: true,
    });
    expect(session.close).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("kind-mismatched lineage"),
    );
    expect(h.onError).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("session close failed"),
      releaseError,
    );
  });

  it("refuses a direct mutation while a canonical session is opening", async () => {
    const sender = new FakeSender(7);
    const openingEntered = deferred<void>();
    const providerReady = deferred<WorkspaceEngineYDocProviderSession>();
    const capture: EngineYDocSessionCapture = {
      openYDocSession: vi.fn(async () => {
        openingEntered.resolve();
        return providerReady.promise;
      }),
    };
    const ipc = createEngineYDocSessionIpc({
      sessionFor: () => rendererSession(),
      requireWorkspace: (workspaceId) => ({
        workspaceId,
        rootPath: "C:/workspace",
      }),
      captureFor: () => capture,
      ensureCaptureFor: vi.fn(async () => undefined),
      isSharedView: () => false,
      resolveDocumentPath: async (_workspace, path) => path,
      onError: vi.fn(),
    });

    const opening = ipc.open(sender, openPayload);
    await openingEntered.promise;
    const mutation = vi.fn(async () => undefined);
    await expect(
      ipc
        .fileMutationPort()
        .withDocumentUnowned("workspace-1", "notes/a.md", mutation),
    ).rejects.toThrow(
      "The engine owns this live document. Close its editor before writing the file directly.",
    );
    expect(mutation).not.toHaveBeenCalled();

    providerReady.resolve(providerSession());
    await expect(opening).resolves.toMatchObject({ available: true });
  });

  it("queues a canonical session open behind the direct mutation that owns the path", async () => {
    const sender = new FakeSender(7);
    const h = harness();
    const trace: string[] = [];
    const mutationEntered = deferred<void>();
    const releaseMutation = deferred<void>();
    const openingEntered = deferred<void>();
    const providerReady = deferred<WorkspaceEngineYDocProviderSession>();
    vi.mocked(h.capture.openYDocSession).mockImplementationOnce(async () => {
      trace.push("open-entered");
      openingEntered.resolve();
      return providerReady.promise;
    });
    const mutation = h.ipc
      .fileMutationPort()
      .withDocumentUnowned("workspace-1", "notes/a.md", async () => {
        mutationEntered.resolve();
        await releaseMutation.promise;
        trace.push("mutation-finished");
      });
    await mutationEntered.promise;

    const opening = h.ipc.open(sender, openPayload);
    void opening.then(() => {
      trace.push("opened");
    });

    releaseMutation.resolve();
    await mutation;
    await openingEntered.promise;
    expect(trace).toEqual(["mutation-finished", "open-entered"]);
    const laterMutation = vi.fn(async () => undefined);
    await expect(
      h.ipc
        .fileMutationPort()
        .withDocumentUnowned("workspace-1", "notes/a.md", laterMutation),
    ).rejects.toThrow("The engine owns this live document");
    expect(laterMutation).not.toHaveBeenCalled();

    providerReady.resolve(providerSession());
    await expect(opening).resolves.toMatchObject({ available: true });
    expect(h.capture.openYDocSession).toHaveBeenCalledOnce();
    expect(trace).toEqual(["mutation-finished", "open-entered", "opened"]);
  });

  it("releases a failed direct-mutation reservation", async () => {
    const sender = new FakeSender(7);
    const h = harness();
    const failure = new Error("write failed");

    await expect(
      h.ipc
        .fileMutationPort()
        .withDocumentUnowned("workspace-1", "notes/a.md", async () => {
          throw failure;
        }),
    ).rejects.toBe(failure);

    await expect(h.ipc.open(sender, openPayload)).resolves.toMatchObject({
      available: true,
    });
    expect(h.capture.openYDocSession).toHaveBeenCalledOnce();
  });

  it("opens after the direct mutation ahead of it fails", async () => {
    const sender = new FakeSender(7);
    const h = harness();
    const mutationEntered = deferred<void>();
    const releaseMutation = deferred<void>();
    const mutationError = new Error("write failed after admission");
    const mutation = h.ipc
      .fileMutationPort()
      .withDocumentUnowned("workspace-1", "notes/a.md", async () => {
        mutationEntered.resolve();
        await releaseMutation.promise;
        throw mutationError;
      });
    await mutationEntered.promise;

    const opening = h.ipc.open(sender, openPayload);
    releaseMutation.resolve();

    await expect(mutation).rejects.toBe(mutationError);
    await expect(opening).resolves.toMatchObject({ available: true });
    expect(h.capture.openYDocSession).toHaveBeenCalledOnce();
  });

  it("refuses an alias that retargets while its canonical open is queued", async () => {
    const sender = new FakeSender(7);
    const firstResolution = deferred<void>();
    let aliasTarget = "notes/a.md";
    const resolveDocumentPath = vi.fn(async (_workspace, requestedPath: string) => {
      if (requestedPath === "alias/a.md") {
        const target = aliasTarget;
        firstResolution.resolve();
        return target;
      }
      return requestedPath;
    });
    const h = harness(providerSession(), { resolveDocumentPath });
    const mutationEntered = deferred<void>();
    const releaseMutation = deferred<void>();
    const mutation = h.ipc
      .fileMutationPort()
      .withDocumentUnowned("workspace-1", "notes/a.md", async () => {
        mutationEntered.resolve();
        await releaseMutation.promise;
      });
    await mutationEntered.promise;

    const opening = h.ipc.open(sender, { ...openPayload, path: "alias/a.md" });
    await firstResolution.promise;
    aliasTarget = "notes/b.md";
    releaseMutation.resolve();
    await mutation;

    await expect(opening).resolves.toEqual({
      available: false,
      documentUnavailable: true,
    });
    expect(h.capture.openYDocSession).not.toHaveBeenCalled();
    expect(resolveDocumentPath.mock.calls.map(([, path]) => path)).toEqual([
      "alias/a.md",
      "alias/a.md",
    ]);
    const laterMutation = vi.fn(async () => undefined);
    await expect(
      h.ipc
        .fileMutationPort()
        .withDocumentUnowned("workspace-1", "notes/a.md", laterMutation),
    ).resolves.toBeUndefined();
    expect(laterMutation).toHaveBeenCalledOnce();
  });

  it.each(["renderer generation", "shared view"] as const)(
    "releases a queued open when its %s changes",
    async (transition) => {
      const sender = new FakeSender(7);
      const firstResolution = deferred<void>();
      const resolveDocumentPath = vi.fn(async (_workspace, path: string) => {
        firstResolution.resolve();
        return path;
      });
      const h = harness(providerSession(), { resolveDocumentPath });
      const mutationEntered = deferred<void>();
      const releaseMutation = deferred<void>();
      const mutation = h.ipc
        .fileMutationPort()
        .withDocumentUnowned("workspace-1", "notes/a.md", async () => {
          mutationEntered.resolve();
          await releaseMutation.promise;
        });
      await mutationEntered.promise;

      const opening = h.ipc.open(sender, openPayload);
      await firstResolution.promise;
      if (transition === "renderer generation") h.setGeneration(2);
      else h.setReadOnly(true);
      releaseMutation.resolve();
      await mutation;

      await expect(opening).resolves.toEqual({ available: false });
      expect(resolveDocumentPath).toHaveBeenCalledTimes(2);
      expect(h.capture.openYDocSession).not.toHaveBeenCalled();
      h.setGeneration(1);
      h.setReadOnly(false);
      const laterMutation = vi.fn(async () => undefined);
      await expect(
        h.ipc
          .fileMutationPort()
          .withDocumentUnowned("workspace-1", "notes/a.md", laterMutation),
      ).resolves.toBeUndefined();
      expect(laterMutation).toHaveBeenCalledOnce();
    },
  );

  it("refuses an open when the physical path changes before capture admission", async () => {
    const sender = new FakeSender(7);
    let resolution = 0;
    const resolveDocumentPath = vi.fn(async () => {
      resolution += 1;
      return resolution === 1 ? "notes/a.md" : null;
    });
    const h = harness(providerSession(), { resolveDocumentPath });

    await expect(h.ipc.open(sender, openPayload)).resolves.toEqual({
      available: false,
      documentUnavailable: true,
    });

    expect(resolveDocumentPath).toHaveBeenCalledTimes(2);
    expect(h.capture.openYDocSession).not.toHaveBeenCalled();
  });

  it("keeps a live document unavailable when it disappears before admission", async () => {
    const sender = new FakeSender(7);
    const h = harness(providerSession(), {
      resolveDocumentPath: async () => null,
    });

    await expect(h.ipc.open(sender, openPayload)).resolves.toEqual({
      available: false,
      documentUnavailable: true,
    });
    expect(h.capture.openYDocSession).not.toHaveBeenCalled();
  });

  it("refuses a capture resolved for a retired renderer generation", async () => {
    const sender = new FakeSender(7);
    let generation = 1;
    let captureAvailable = false;
    const captureReady = deferred<void>();
    const ensureStarted = deferred<void>();
    const capture: EngineYDocSessionCapture = {
      openYDocSession: vi.fn(async () => providerSession()),
    };
    const ensureCaptureFor = vi.fn(() => {
      ensureStarted.resolve();
      return captureReady.promise;
    });
    const ipc = createEngineYDocSessionIpc({
      sessionFor: () => rendererSession(() => generation),
      requireWorkspace: (workspaceId) => ({
        workspaceId,
        rootPath: "C:/workspace",
      }),
      captureFor: () => (captureAvailable ? capture : null),
      ensureCaptureFor,
      isSharedView: () => false,
      resolveDocumentPath: async (_workspace, path) => path,
      onError: vi.fn(),
    });

    const opening = ipc.open(sender, openPayload);
    await ensureStarted.promise;
    expect(ensureCaptureFor).toHaveBeenCalledOnce();
    generation = 2;
    captureAvailable = true;
    captureReady.resolve();

    await expect(opening).resolves.toEqual({ available: false });
    expect(capture.openYDocSession).not.toHaveBeenCalled();
  });

  it("denies a fresh open after reload retirement invalidates admission", async () => {
    const sender = new FakeSender(7);
    const h = harness();
    h.retireSession();

    await expect(h.ipc.open(sender, openPayload)).resolves.toEqual({
      available: false,
    });

    expect(h.capture.openYDocSession).not.toHaveBeenCalled();
  });

  it("rechecks shared-view and deletion policy before every update", async () => {
    const sender = new FakeSender(7);
    const h = harness();
    await h.ipc.open(sender, openPayload);

    h.setReadOnly(true);
    expect(
      h.ipc.applyUpdate(sender, {
        sessionId: openPayload.sessionId,
        update: new Uint8Array([1]),
        lineageGeneration: 1,
        seq: 5,
      }),
    ).toEqual({ accepted: false, reason: "read-only" });
    expect(sender.sent.at(-1)?.payload).toEqual({
      sessionId: openPayload.sessionId,
      state: "read-only",
      seq: 5,
    });

    h.setReadOnly(false);
    h.ipc
      .fileMutationPort()
      .markDeletedUnderPath("workspace-1", "notes");
    expect(sender.sent.at(-1)?.payload).toEqual({
      sessionId: openPayload.sessionId,
      state: "deleted",
      seq: 0,
    });
    expect(
      h.ipc.applyUpdate(sender, {
        sessionId: openPayload.sessionId,
        update: new Uint8Array([2]),
        lineageGeneration: 1,
        seq: 6,
      }),
    ).toEqual({ accepted: false, reason: "deleted" });
    expect(h.session.applyLocalUpdate).not.toHaveBeenCalled();
  });

  it("moves pinned artifact authority only when the lineage is acknowledged", async () => {
    const losing = asset("shared", "assets/losing.png");
    const winner = asset("shared", "assets/winner.png");
    const session = providerSession({ artifactAssets: [losing] });
    const sender = new FakeSender(7);
    const h = harness(session);
    await h.ipc.open(sender, openPayload);

    Object.defineProperty(session, "artifactAssets", { value: [winner] });
    h.capturedOpen()?.onLineageReplaced?.(
      new Uint8Array([9]),
      ["recovered/losing.md"],
    );
    h.capturedOpen()?.onRemoteUpdate(new Uint8Array([8]));

    expect(sender.sent.at(-1)?.payload).toMatchObject({
      sessionId: openPayload.sessionId,
      update: new Uint8Array([9]),
      recoveredPaths: ["recovered/losing.md"],
      artifactAssets: [winner],
      lineageGeneration: 2,
    });
    await expect(
      h.ipc.readArtifactAsset(sender, {
        sessionId: openPayload.sessionId,
        descriptor: losing,
      }),
    ).resolves.toMatchObject({ descriptor: losing });

    expect(
      h.ipc.acknowledgeLineageReplacement(sender, {
        sessionId: openPayload.sessionId,
        lineageGeneration: 2,
      }),
    ).toEqual({ accepted: true, updates: [new Uint8Array([8])] });
    expect(
      h.ipc.acknowledgeLineageReplacement(sender, {
        sessionId: openPayload.sessionId,
        lineageGeneration: 2,
      }),
    ).toEqual({ accepted: false, reason: "lineage-transition" });
    await expect(
      h.ipc.readArtifactAsset(sender, {
        sessionId: openPayload.sessionId,
        descriptor: winner,
      }),
    ).resolves.toMatchObject({ descriptor: winner });
    await expect(
      h.ipc.readArtifactAsset(sender, {
        sessionId: openPayload.sessionId,
        descriptor: losing,
      }),
    ).resolves.toMatchObject({ descriptor: losing });
  });

  it("derives asset access from the exact sender, generation, and pinned descriptor", async () => {
    const pinned = asset("image");
    const sender = new FakeSender(7);
    const foreign = new FakeSender(7);
    const h = harness(providerSession({ artifactAssets: [pinned] }));
    await h.ipc.open(sender, openPayload);

    await expect(
      h.ipc.readArtifactAsset(foreign, {
        sessionId: openPayload.sessionId,
        descriptor: pinned,
      }),
    ).rejects.toThrow("no longer available");
    await expect(
      h.ipc.readArtifactAsset(sender, {
        sessionId: openPayload.sessionId,
        descriptor: { ...pinned, sha256: "b".repeat(64) },
      }),
    ).rejects.toThrow("does not reference artifact asset image");

    h.ipc
      .fileMutationPort()
      .markDeletedUnderPath("workspace-1", "notes/a.md");
    await expect(
      h.ipc.readArtifactAsset(sender, {
        sessionId: openPayload.sessionId,
        descriptor: pinned,
      }),
    ).resolves.toMatchObject({ descriptor: pinned });

    h.setGeneration(2);
    await expect(
      h.ipc.readArtifactAsset(sender, {
        sessionId: openPayload.sessionId,
        descriptor: pinned,
      }),
    ).rejects.toThrow("no longer available");
  });

  it("keeps a failed release read-only and retries it by workspace path", async () => {
    let releaseFails = true;
    const close = vi.fn(async () => {
      if (releaseFails) throw new Error("daemon retained the session");
    });
    const sender = new FakeSender(7);
    const h = harness(providerSession({ close }));
    await expect(h.ipc.open(sender, openPayload)).resolves.toMatchObject({
      available: true,
    });
    await h.ipc.close(sender, { sessionId: openPayload.sessionId });

    await expect(
      h.ipc.open(sender, { ...openPayload, sessionId: "retry-session" }),
    ).resolves.toEqual({ available: false, engineMayHoldDocument: true });
    expect(h.capture.openYDocSession).toHaveBeenCalledTimes(1);

    releaseFails = false;
    await expect(
      h.ipc.open(sender, { ...openPayload, sessionId: "retry-session-2" }),
    ).resolves.toMatchObject({ available: true });
    expect(h.capture.openYDocSession).toHaveBeenCalledTimes(2);
  });

  it("keeps duplicate document opens read-only until the owner releases them", async () => {
    const sender = new FakeSender(7);
    const openStarted = deferred<void>();
    const engineOpen = deferred<WorkspaceEngineYDocProviderSession>();
    const closeStarted = deferred<void>();
    const closeGate = deferred<void>();
    const close = vi.fn(async () => {
      closeStarted.resolve();
      await closeGate.promise;
    });
    const capture: EngineYDocSessionCapture = {
      openYDocSession: vi.fn(() => {
        openStarted.resolve();
        return engineOpen.promise;
      }),
    };
    const ipc = createEngineYDocSessionIpc({
      sessionFor: () => rendererSession(),
      requireWorkspace: (workspaceId) => ({
        workspaceId,
        rootPath: "C:/workspace",
      }),
      captureFor: () => capture,
      ensureCaptureFor: vi.fn(async () => undefined),
      isSharedView: () => false,
      resolveDocumentPath: async (_workspace, path) => path,
      onError: vi.fn(),
    });

    const opening = ipc.open(sender, openPayload);
    await openStarted.promise;
    await expect(
      ipc.open(sender, { ...openPayload, sessionId: "while-opening" }),
    ).resolves.toEqual({
      available: false,
      engineMayHoldDocument: true,
    });

    engineOpen.resolve(providerSession({ close }));
    await expect(opening).resolves.toMatchObject({ available: true });
    await expect(
      ipc.open(sender, { ...openPayload, sessionId: "while-open" }),
    ).resolves.toEqual({
      available: false,
      engineMayHoldDocument: true,
    });

    const closing = ipc.close(sender, { sessionId: openPayload.sessionId });
    await closeStarted.promise;
    const replacement = ipc.open(sender, {
      ...openPayload,
      sessionId: "after-release",
    });
    expect(capture.openYDocSession).toHaveBeenCalledTimes(1);

    closeGate.resolve();
    await closing;
    await expect(replacement).resolves.toMatchObject({ available: true });
    expect(capture.openYDocSession).toHaveBeenCalledTimes(2);
  });

  it("maps domain open refusals to the bridge contract", async () => {
    const sender = new FakeSender(7);
    const cases: Array<[unknown, object]> = [
      [
        new YDocPathNotInVersionError("notes/a.md", "version-2"),
        { available: false, notInVersion: true },
      ],
      [
        new YDocRemovalInProgressError(
          "notes/a.md",
          "A move is in progress.",
          "open",
          "move",
        ),
        {
          available: false,
          removalInProgress: {
            operation: "move",
            message: "A move is in progress.",
          },
        },
      ],
      [
        new YDocSessionUnreleasedError("notes/a.md", new Error("held")),
        { available: false, engineMayHoldDocument: true },
      ],
      [
        {
          wireError: {
            code: "INTERNAL",
            message: "ydoc-artifact-assets-invalid",
          },
        },
        { available: false, artifactAssetsInvalid: true },
      ],
    ];

    for (const [error, expected] of cases) {
      const capture: EngineYDocSessionCapture = {
        openYDocSession: vi.fn(async () => {
          throw error;
        }),
      };
      const ipc = createEngineYDocSessionIpc({
        sessionFor: () => rendererSession(),
        requireWorkspace: (workspaceId) => ({
          workspaceId,
          rootPath: "C:/workspace",
        }),
        captureFor: () => capture,
        ensureCaptureFor: vi.fn(async () => undefined),
        isSharedView: () => false,
        resolveDocumentPath: async (_workspace, path) => path,
        onError: vi.fn(),
      });
      await expect(ipc.open(sender, openPayload)).resolves.toEqual(expected);
    }
  });

  it("refuses shared, unclassified, and invalid paths before opening a session", async () => {
    const sender = new FakeSender(7);
    const shared = harness();
    shared.setReadOnly(true);
    await expect(shared.ipc.open(sender, openPayload)).resolves.toEqual({
      available: false,
    });
    expect(shared.capture.openYDocSession).not.toHaveBeenCalled();

    const ordinary = harness();
    await expect(
      ordinary.ipc.open(sender, { ...openPayload, path: "notes/a.bin" }),
    ).resolves.toEqual({ available: false });
    await expect(
      ordinary.ipc.open(sender, { ...openPayload, path: "../escape.md" }),
    ).resolves.toEqual({ available: false });
    expect(ordinary.capture.openYDocSession).not.toHaveBeenCalled();
  });

  it("retires a pending open through the central sender-retirement adapter", async () => {
    const sender = new FakeSender(7);
    const openStarted = deferred<void>();
    const engineOpen = deferred<WorkspaceEngineYDocProviderSession>();
    const close = vi.fn(async () => undefined);
    const capture: EngineYDocSessionCapture = {
      openYDocSession: vi.fn(() => {
        openStarted.resolve();
        return engineOpen.promise;
      }),
    };
    const ipc = createEngineYDocSessionIpc({
      sessionFor: () => rendererSession(),
      requireWorkspace: (workspaceId) => ({
        workspaceId,
        rootPath: "C:/workspace",
      }),
      captureFor: () => capture,
      ensureCaptureFor: vi.fn(async () => undefined),
      isSharedView: () => false,
      resolveDocumentPath: async (_workspace, path) => path,
      onError: vi.fn(),
    });

    const opening = ipc.open(sender, openPayload);
    await openStarted.promise;
    const retirement = ipc.retireSender(sender, 1);
    engineOpen.resolve(providerSession({ close }));

    await expect(opening).resolves.toEqual({ available: false });
    await retirement;
    expect(close).toHaveBeenCalledWith(undefined);
  });

  it("drops stale-generation output and releases an unannounced lineage", async () => {
    const close = vi.fn(async () => undefined);
    const sender = new FakeSender(7);
    const h = harness(providerSession({ close }));
    await h.ipc.open(sender, openPayload);
    sender.sent.length = 0;

    h.setGeneration(2);
    h.capturedOpen()?.onRemoteUpdate(new Uint8Array([1]));
    h.capturedOpen()?.onLineageReplaced?.(new Uint8Array([2]), []);

    expect(sender.sent).toEqual([]);
    expect(close).toHaveBeenCalledWith(undefined);
    expect(
      h.ipc.applyUpdate(sender, {
        sessionId: openPayload.sessionId,
        update: new Uint8Array([3]),
        lineageGeneration: 1,
        seq: 1,
      }),
    ).toEqual({ accepted: false, reason: "session-unavailable" });
  });

  it("releases pending work on sender retirement and uses shuttingDown only for quit", async () => {
    const sender = new FakeSender(7);
    const close = vi.fn(async () => undefined);
    const h = harness(providerSession({ close }));
    await h.ipc.open(sender, openPayload);

    await h.ipc.retireSender(sender, 1);
    expect(close).toHaveBeenCalledWith(undefined);

    h.setGeneration(2);
    await h.ipc.open(sender, { ...openPayload, sessionId: "second" });
    await h.ipc.shutdown();
    expect(close).toHaveBeenLastCalledWith({ shuttingDown: true });
  });
});
