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

  constructor(readonly id: number) {}

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  send(channel: string, payload: unknown): void {
    if (this.#destroyed) throw new Error("sender destroyed");
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
  return {
    doc: new Y.Doc(),
    contentKind: "richdoc",
    applyLocalUpdate: vi.fn((_update, onArmed) => onArmed?.()),
    applyExternalMarkdownEdit: vi.fn(async () => ({ supported: true })),
    readArtifactAsset: vi.fn(async (descriptor) => ({
      descriptor,
      bytes: new Uint8Array([1, 2, 3]),
    })),
    close: vi.fn(async () => undefined),
    ...input,
  } as WorkspaceEngineYDocProviderSession;
}

function harness(session = providerSession()) {
  let generation = 1;
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
  const ipc = createEngineYDocSessionIpc({
    generationOf: () => generation,
    requireWorkspace: (workspaceId) => ({ workspaceId }),
    captureFor: () => capture,
    ensureCaptureFor: vi.fn(async () => undefined),
    isSharedView: () => readOnly,
    onError: vi.fn(),
  });
  return {
    ipc,
    capture,
    session,
    capturedOpen: () => capturedOpen,
    setGeneration: (next: number) => {
      generation = next;
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
    expect(h.ipc.ownsDocument("workspace-1", "notes/a.md")).toBe(true);

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
      generationOf: () => 1,
      requireWorkspace: (workspaceId) => ({ workspaceId }),
      captureFor: () => (captureAvailable ? capture : null),
      ensureCaptureFor,
      isSharedView: () => false,
      onError: vi.fn(),
    });

    await expect(ipc.open(sender, openPayload)).resolves.toMatchObject({
      available: true,
    });
    expect(ensureCaptureFor).toHaveBeenCalledWith("workspace-1");
    expect(capture.openYDocSession).toHaveBeenCalledOnce();
  });

  it("refuses a capture resolved for a retired renderer generation", async () => {
    const sender = new FakeSender(7);
    let generation = 1;
    let captureAvailable = false;
    const captureReady = deferred<void>();
    const capture: EngineYDocSessionCapture = {
      openYDocSession: vi.fn(async () => providerSession()),
    };
    const ensureCaptureFor = vi.fn(() => captureReady.promise);
    const ipc = createEngineYDocSessionIpc({
      generationOf: () => generation,
      requireWorkspace: (workspaceId) => ({ workspaceId }),
      captureFor: () => (captureAvailable ? capture : null),
      ensureCaptureFor,
      isSharedView: () => false,
      onError: vi.fn(),
    });

    const opening = ipc.open(sender, openPayload);
    expect(ensureCaptureFor).toHaveBeenCalledOnce();
    generation = 2;
    captureAvailable = true;
    captureReady.resolve();

    await expect(opening).resolves.toEqual({ available: false });
    expect(capture.openYDocSession).not.toHaveBeenCalled();
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
    h.ipc.notifyDeleted("workspace-1", "notes/");
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

    h.ipc.notifyDeleted("workspace-1", "notes/a.md");
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

  it("keeps duplicate opens read-only while the exact session is reserved", async () => {
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
      generationOf: () => 1,
      requireWorkspace: (workspaceId) => ({ workspaceId }),
      captureFor: () => capture,
      ensureCaptureFor: vi.fn(async () => undefined),
      isSharedView: () => false,
      onError: vi.fn(),
    });

    const opening = ipc.open(sender, openPayload);
    await openStarted.promise;
    await expect(ipc.open(sender, openPayload)).resolves.toEqual({
      available: false,
      engineMayHoldDocument: true,
    });

    engineOpen.resolve(providerSession({ close }));
    await expect(opening).resolves.toMatchObject({ available: true });
    await expect(ipc.open(sender, openPayload)).resolves.toEqual({
      available: false,
      engineMayHoldDocument: true,
    });

    const closing = ipc.close(sender, { sessionId: openPayload.sessionId });
    await closeStarted.promise;
    await expect(ipc.open(sender, openPayload)).resolves.toEqual({
      available: false,
      engineMayHoldDocument: true,
    });
    expect(capture.openYDocSession).toHaveBeenCalledTimes(1);

    closeGate.resolve();
    await closing;
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
        generationOf: () => 1,
        requireWorkspace: (workspaceId) => ({ workspaceId }),
        captureFor: () => capture,
        ensureCaptureFor: vi.fn(async () => undefined),
        isSharedView: () => false,
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

  it("retires a pending open when its exact sender is destroyed", async () => {
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
      generationOf: () => 1,
      requireWorkspace: (workspaceId) => ({ workspaceId }),
      captureFor: () => capture,
      ensureCaptureFor: vi.fn(async () => undefined),
      isSharedView: () => false,
      onError: vi.fn(),
    });

    const opening = ipc.open(sender, openPayload);
    await openStarted.promise;
    sender.destroy();
    engineOpen.resolve(providerSession({ close }));

    await expect(opening).resolves.toEqual({ available: false });
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
