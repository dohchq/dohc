import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "/tmp/dohc-test-user-data",
  },
  BrowserWindow: vi.fn(),
  nativeTheme: { shouldUseDarkColors: false },
  screen: {
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1200, height: 800 },
    }),
  },
}));

import {
  allowLoopbackFrameOrigin,
  isAllowedLoopbackFrameUrl,
} from "../window/createMainWindow";
import {
  createSitePreviewLifecycle,
  type SitePreviewExecution,
} from "./sitePreviewLifecycle";
import type {
  SiteLogEntry,
  SiteProcessHandle,
  StaticSitePreview,
} from "./siteRunner";

function fakeStaticHandle(url: string) {
  const handle: StaticSitePreview = {
    url,
    root: "/workspace/site",
    stop: vi.fn(async () => undefined),
  };
  return handle;
}

function fakeProcessHandle(url: string) {
  let exited = false;
  const logs: SiteLogEntry[] = [];
  const exitListeners = new Set<() => void>();
  const handle: SiteProcessHandle = {
    url,
    command: "test-server",
    args: [],
    cwd: "/workspace/site",
    logs: () => [...logs],
    onExit(listener) {
      if (exited) queueMicrotask(listener);
      else exitListeners.add(listener);
    },
    stop: vi.fn(async () => undefined),
  };
  return {
    handle,
    appendLog(log: SiteLogEntry) {
      logs.push(log);
    },
    exit() {
      if (exited) return;
      exited = true;
      for (const listener of exitListeners) listener();
      exitListeners.clear();
    },
  };
}

function testLifecycle() {
  const releases = new Map<string, ReturnType<typeof vi.fn>>();
  const allowOrigin = vi.fn((url: string) => {
    const release = vi.fn();
    releases.set(url, release);
    return release;
  });
  return {
    lifecycle: createSitePreviewLifecycle({ allowOrigin }),
    allowOrigin,
    releases,
  };
}

function execution(
  handle: StaticSitePreview | SiteProcessHandle,
  logs: SiteLogEntry[] = [],
): SitePreviewExecution<{ logs: SiteLogEntry[] }> {
  return { handle, result: { logs } };
}

function startHandle(
  lifecycle: ReturnType<typeof createSitePreviewLifecycle>,
  handle: StaticSitePreview | SiteProcessHandle,
  input: {
    senderId?: number;
    workspaceId?: string;
    siteRoot?: string;
  } = {},
) {
  return lifecycle.start({
    senderId: input.senderId ?? 1,
    workspaceId: input.workspaceId ?? "workspace-1",
    siteRoot: input.siteRoot ?? "site",
    isCurrent: () => true,
    prepare: async () => async () => execution(handle),
  });
}

describe("site preview lifecycle", () => {
  it("keeps the current preview when preparation rejects", async () => {
    const { lifecycle } = testLifecycle();
    const current = fakeStaticHandle("http://127.0.0.1:4173/");
    await startHandle(lifecycle, current);

    await expect(
      lifecycle.start({
        senderId: 1,
        workspaceId: "workspace-1",
        siteRoot: "site",
        isCurrent: () => true,
        prepare: async () => {
          throw new Error("Not a detected app: site");
        },
      }),
    ).rejects.toThrow("Not a detected app: site");

    expect(current.stop).not.toHaveBeenCalled();
    expect(lifecycle.status("workspace-1", "site").running).toBe(true);
    await lifecycle.stopAll();
  });

  it("registers a pending start before preparation and lets stop cancel it", async () => {
    const { lifecycle } = testLifecycle();
    const current = fakeStaticHandle("http://127.0.0.1:4173/");
    const candidate = fakeStaticHandle("http://127.0.0.1:5173/");
    await startHandle(lifecycle, current);

    let finishPreparation: () => void = () => undefined;
    const preparationGate = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const execute = vi.fn(async () => execution(candidate));
    const starting = lifecycle
      .start({
        senderId: 7,
        workspaceId: "workspace-1",
        siteRoot: "site",
        isCurrent: () => true,
        prepare: async () => {
          await preparationGate;
          return execute;
        },
      })
      .catch((error: unknown) => error as Error);

    const stopping = lifecycle.stop({
      getActiveWorkspaceId: () => "workspace-1",
      workspaceId: "workspace-1",
      siteRoot: "site",
    });
    await stopping;
    expect(current.stop).toHaveBeenCalledTimes(1);

    finishPreparation();
    const startError = await starting;
    expect(startError).toBeInstanceOf(Error);
    expect((startError as Error).message).toMatch(/renderer restarted/i);
    expect(execute).not.toHaveBeenCalled();
    expect(candidate.stop).not.toHaveBeenCalled();
  });

  it("aborts a matching execution before the stop lane and rechecks workspace authority inside it", async () => {
    const { lifecycle } = testLifecycle();
    const candidate = fakeStaticHandle("http://127.0.0.1:4173/");
    let activeWorkspaceId = "workspace-1";
    let observedSignal: AbortSignal | undefined;
    let executionStarted: () => void = () => undefined;
    const startedGate = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    let finishExecution: () => void = () => undefined;
    const executionGate = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    const starting = lifecycle
      .start({
        senderId: 7,
        workspaceId: "workspace-1",
        siteRoot: "site",
        isCurrent: () => true,
        prepare: async () => async (signal) => {
          observedSignal = signal;
          executionStarted();
          await executionGate;
          return execution(candidate);
        },
      })
      .catch((error: unknown) => error as Error);
    await startedGate;

    const stopping = lifecycle.stop({
      getActiveWorkspaceId: () => activeWorkspaceId,
      workspaceId: "workspace-1",
      siteRoot: "site",
    });
    expect(observedSignal?.aborted).toBe(true);
    activeWorkspaceId = "workspace-2";
    finishExecution();

    await expect(stopping).rejects.toThrow(
      "The app preview stop request does not target the active workspace. Open the workspace and stop the preview again.",
    );
    expect(await starting).toBeInstanceOf(Error);
    expect(candidate.stop).toHaveBeenCalledTimes(1);
  });

  it("returns an exited result when the process died before its listener attached", async () => {
    const { lifecycle } = testLifecycle();
    const server = fakeProcessHandle("http://127.0.0.1:4173/");
    server.appendLog({ stream: "stderr", text: "bind failed", at: 1 });
    server.exit();

    const result = await startHandle(lifecycle, server.handle);

    expect(result).not.toHaveProperty("handle");
    expect(result.exited).toBe(true);
    expect(result.logs).toEqual([
      { stream: "stderr", text: "bind failed", at: 1 },
      expect.objectContaining({
        stream: "system",
        text: "Dev server exited unexpectedly.",
      }),
    ]);
    await lifecycle.stopAll();
    expect(server.handle.stop).toHaveBeenCalledTimes(1);
  });

  it("reports one coherent running or exited snapshot", async () => {
    const { lifecycle } = testLifecycle();
    const server = fakeProcessHandle("http://127.0.0.1:4173/");
    await startHandle(lifecycle, server.handle);
    server.appendLog({
      stream: "stderr",
      text: "compiler warning after readiness",
      at: 2,
    });

    expect(lifecycle.status("workspace-1", "site")).toEqual({
      logs: [
        {
          stream: "stderr",
          text: "compiler warning after readiness",
          at: 2,
        },
      ],
      running: true,
      exited: false,
    });

    server.exit();
    expect(lifecycle.status("workspace-1", "site")).toEqual({
      logs: [
        {
          stream: "stderr",
          text: "compiler warning after readiness",
          at: 2,
        },
        expect.objectContaining({
          stream: "system",
          text: "Dev server exited unexpectedly.",
        }),
      ],
      running: false,
      exited: true,
    });
    await lifecycle.stopAll();
  });

  it("releases the real loopback origin when a process exits", async () => {
    const lifecycle = createSitePreviewLifecycle({
      allowOrigin: allowLoopbackFrameOrigin,
    });
    const server = fakeProcessHandle("http://127.0.0.1:6199/");
    await startHandle(lifecycle, server.handle);
    expect(isAllowedLoopbackFrameUrl("http://127.0.0.1:6199/frame")).toBe(
      true,
    );

    server.exit();

    expect(isAllowedLoopbackFrameUrl("http://127.0.0.1:6199/frame")).toBe(
      false,
    );
    await lifecycle.stopAll();
  });

  it("serializes two starts for the same site", async () => {
    const { lifecycle } = testLifecycle();
    const firstHandle = fakeStaticHandle("http://127.0.0.1:4173/");
    const secondHandle = fakeStaticHandle("http://127.0.0.1:5173/");
    let firstExecutionStarted: () => void = () => undefined;
    const firstStartedGate = new Promise<void>((resolve) => {
      firstExecutionStarted = resolve;
    });
    let finishFirstExecution: () => void = () => undefined;
    const firstExecutionGate = new Promise<void>((resolve) => {
      finishFirstExecution = resolve;
    });
    let secondExecutionStarted: () => void = () => undefined;
    const secondStartedGate = new Promise<void>((resolve) => {
      secondExecutionStarted = resolve;
    });
    let finishSecondExecution: () => void = () => undefined;
    const secondExecutionGate = new Promise<void>((resolve) => {
      finishSecondExecution = resolve;
    });

    const first = lifecycle.start({
      senderId: 1,
      workspaceId: "workspace-1",
      siteRoot: "site",
      isCurrent: () => true,
      prepare: async () => async () => {
        firstExecutionStarted();
        await firstExecutionGate;
        return execution(firstHandle);
      },
    });
    await firstStartedGate;
    const secondExecute = vi.fn(async () => {
      secondExecutionStarted();
      await secondExecutionGate;
      return execution(secondHandle);
    });
    const second = lifecycle.start({
      senderId: 2,
      workspaceId: "workspace-1",
      siteRoot: "site",
      isCurrent: () => true,
      prepare: async () => secondExecute,
    });
    await Promise.resolve();
    expect(secondExecute).not.toHaveBeenCalled();

    finishFirstExecution();
    await first;
    await secondStartedGate;
    expect(firstHandle.stop).toHaveBeenCalledTimes(1);

    finishSecondExecution();
    await second;
    expect(secondHandle.stop).not.toHaveBeenCalled();
    await lifecycle.stopAll();
  });

  it("keeps the newer start when an older preparation finishes last", async () => {
    const { lifecycle } = testLifecycle();
    const staleHandle = fakeStaticHandle("http://127.0.0.1:4173/");
    const currentHandle = fakeStaticHandle("http://127.0.0.1:5173/");
    let finishStalePreparation: () => void = () => undefined;
    const stalePreparationGate = new Promise<void>((resolve) => {
      finishStalePreparation = resolve;
    });
    const staleExecute = vi.fn(async () => execution(staleHandle));
    const staleStart = lifecycle
      .start({
        senderId: 1,
        workspaceId: "workspace-1",
        siteRoot: "site",
        isCurrent: () => true,
        prepare: async () => {
          await stalePreparationGate;
          return staleExecute;
        },
      })
      .catch((error: unknown) => error as Error);

    await expect(
      startHandle(lifecycle, currentHandle, { senderId: 2 }),
    ).resolves.toMatchObject({ url: currentHandle.url, exited: false });

    finishStalePreparation();
    expect(await staleStart).toBeInstanceOf(Error);
    expect(staleExecute).not.toHaveBeenCalled();
    expect(currentHandle.stop).not.toHaveBeenCalled();
    expect(lifecycle.status("workspace-1", "site").running).toBe(true);

    await lifecycle.stopAll();
    expect(currentHandle.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps an older preparation eligible when a newer preparation fails", async () => {
    const { lifecycle } = testLifecycle();
    const firstHandle = fakeStaticHandle("http://127.0.0.1:4173/");
    let finishFirstPreparation: () => void = () => undefined;
    const firstPreparationGate = new Promise<void>((resolve) => {
      finishFirstPreparation = resolve;
    });
    const firstStart = lifecycle.start({
      senderId: 1,
      workspaceId: "workspace-1",
      siteRoot: "site",
      isCurrent: () => true,
      prepare: async () => {
        await firstPreparationGate;
        return async () => execution(firstHandle);
      },
    });

    await expect(
      lifecycle.start({
        senderId: 2,
        workspaceId: "workspace-1",
        siteRoot: "site",
        isCurrent: () => true,
        prepare: async () => {
          throw new Error("Site preparation failed.");
        },
      }),
    ).rejects.toThrow("Site preparation failed.");

    finishFirstPreparation();
    await expect(firstStart).resolves.toMatchObject({
      url: firstHandle.url,
      exited: false,
    });
    expect(firstHandle.stop).not.toHaveBeenCalled();
    await lifecycle.stopAll();
  });

  it("lets an executing start finish when a newer preparation fails", async () => {
    const { lifecycle } = testLifecycle();
    const firstHandle = fakeStaticHandle("http://127.0.0.1:4173/");
    let executionStarted: () => void = () => undefined;
    const executionStartedGate = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    let finishExecution: () => void = () => undefined;
    const executionGate = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const firstStart = lifecycle.start({
      senderId: 1,
      workspaceId: "workspace-1",
      siteRoot: "site",
      isCurrent: () => true,
      prepare: async () => async (signal) => {
        observedSignal = signal;
        executionStarted();
        await executionGate;
        return execution(firstHandle);
      },
    });
    await executionStartedGate;

    await expect(
      lifecycle.start({
        senderId: 2,
        workspaceId: "workspace-1",
        siteRoot: "site",
        isCurrent: () => true,
        prepare: async () => {
          throw new Error("Site preparation failed.");
        },
      }),
    ).rejects.toThrow("Site preparation failed.");
    expect(observedSignal?.aborted).toBe(false);

    finishExecution();
    await expect(firstStart).resolves.toMatchObject({
      url: firstHandle.url,
      exited: false,
    });
    expect(firstHandle.stop).not.toHaveBeenCalled();
    expect(lifecycle.status("workspace-1", "site").running).toBe(true);

    await lifecycle.stopAll();
    expect(firstHandle.stop).toHaveBeenCalledTimes(1);
  });

  it("stops a handle when renderer authority expires without an abort", async () => {
    const { lifecycle } = testLifecycle();
    const candidate = fakeStaticHandle("http://127.0.0.1:4173/");
    let current = true;
    let executionStarted: () => void = () => undefined;
    const startedGate = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    let finishExecution: () => void = () => undefined;
    const executionGate = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const starting = lifecycle.start({
      senderId: 1,
      workspaceId: "workspace-1",
      siteRoot: "site",
      isCurrent: () => current,
      prepare: async () => async (signal) => {
        observedSignal = signal;
        executionStarted();
        await executionGate;
        return execution(candidate);
      },
    });
    await startedGate;

    current = false;
    finishExecution();

    await expect(starting).rejects.toThrow(/renderer restarted/i);
    expect(observedSignal?.aborted).toBe(false);
    expect(candidate.stop).toHaveBeenCalledTimes(1);
    expect(lifecycle.status("workspace-1", "site").running).toBe(false);
    await lifecycle.stopAll();
  });

  it("releases and stops a handle when exit-listener installation fails", async () => {
    const releaseOrigin = vi.fn();
    const lifecycle = createSitePreviewLifecycle({
      allowOrigin: () => releaseOrigin,
    });
    const handle: SiteProcessHandle = {
      url: "http://127.0.0.1:4173/",
      command: "test-server",
      args: [],
      cwd: "/workspace/site",
      logs: () => [],
      onExit: () => {
        throw new Error("listener failed");
      },
      stop: vi.fn(async () => undefined),
    };

    await expect(startHandle(lifecycle, handle)).rejects.toThrow(
      "listener failed",
    );

    expect(releaseOrigin).toHaveBeenCalledTimes(1);
    expect(handle.stop).toHaveBeenCalledTimes(1);
    expect(lifecycle.status("workspace-1", "site")).toEqual({
      logs: [],
      running: false,
      exited: false,
    });
  });

  it("retains a handle when setup and its first cleanup attempt both fail", async () => {
    const releaseOrigin = vi.fn();
    const lifecycle = createSitePreviewLifecycle({
      allowOrigin: () => releaseOrigin,
    });
    const handle: SiteProcessHandle = {
      url: "http://127.0.0.1:4173/",
      command: "test-server",
      args: [],
      cwd: "/workspace/site",
      logs: () => [],
      onExit: () => {
        throw new Error("listener failed");
      },
      stop: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("setup cleanup remained ambiguous"))
        .mockResolvedValue(undefined),
    };
    const replacement = fakeStaticHandle("http://127.0.0.1:5173/");

    await expect(startHandle(lifecycle, handle)).rejects.toThrow(
      "listener failed",
    );

    expect(releaseOrigin).toHaveBeenCalledTimes(1);
    expect(handle.stop).toHaveBeenCalledTimes(1);
    expect(lifecycle.status("workspace-1", "site").running).toBe(true);

    await startHandle(lifecycle, replacement, { senderId: 2 });

    expect(handle.stop).toHaveBeenCalledTimes(2);
    expect(replacement.stop).not.toHaveBeenCalled();
    await lifecycle.stopAll();
  });

  it("replaces a preview inside one site lane and releases each origin once", async () => {
    const { lifecycle, releases } = testLifecycle();
    const oldPreview = fakeStaticHandle("http://127.0.0.1:4173/");
    const replacement = fakeStaticHandle("http://127.0.0.1:5173/");
    await startHandle(lifecycle, oldPreview);

    await startHandle(lifecycle, replacement);

    expect(oldPreview.stop).toHaveBeenCalledTimes(1);
    expect(releases.get(oldPreview.url)).toHaveBeenCalledTimes(1);
    expect(replacement.stop).not.toHaveBeenCalled();
    expect(lifecycle.status("workspace-1", "site").running).toBe(true);

    await lifecycle.stopAll();
    expect(replacement.stop).toHaveBeenCalledTimes(1);
    expect(releases.get(replacement.url)).toHaveBeenCalledTimes(1);
  });

  it("retains a failed stop and blocks replacement until a retry proves the old preview stopped", async () => {
    const { lifecycle, releases } = testLifecycle();
    const oldPreview = fakeStaticHandle("http://127.0.0.1:4173/");
    const discardedReplacement = fakeStaticHandle("http://127.0.0.1:5173/");
    const replacement = fakeStaticHandle("http://127.0.0.1:6173/");
    oldPreview.stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("stop remained ambiguous"))
      .mockResolvedValue(undefined);
    await startHandle(lifecycle, oldPreview);

    const discardedExecute = vi.fn(async () => execution(discardedReplacement));
    await expect(
      lifecycle.start({
        senderId: 2,
        workspaceId: "workspace-1",
        siteRoot: "site",
        isCurrent: () => true,
        prepare: async () => discardedExecute,
      }),
    ).rejects.toThrow("stop remained ambiguous");

    expect(discardedExecute).not.toHaveBeenCalled();
    expect(oldPreview.stop).toHaveBeenCalledTimes(1);
    expect(releases.get(oldPreview.url)).toHaveBeenCalledTimes(1);
    expect(lifecycle.status("workspace-1", "site").running).toBe(true);

    await startHandle(lifecycle, replacement, { senderId: 3 });

    expect(oldPreview.stop).toHaveBeenCalledTimes(2);
    expect(replacement.stop).not.toHaveBeenCalled();
    expect(lifecycle.status("workspace-1", "site").running).toBe(true);
    await lifecycle.stopAll();
  });

  it("serializes concurrent replacements behind the exact failed stop retry", async () => {
    const { lifecycle } = testLifecycle();
    const oldPreview = fakeStaticHandle("http://127.0.0.1:4173/");
    const discardedReplacement = fakeStaticHandle("http://127.0.0.1:5173/");
    const replacement = fakeStaticHandle("http://127.0.0.1:6173/");
    let rejectFirstStop: (error: Error) => void = () => undefined;
    const firstStopGate = new Promise<void>((_resolve, reject) => {
      rejectFirstStop = reject;
    });
    let firstStopStarted: () => void = () => undefined;
    const firstStopStartedGate = new Promise<void>((resolve) => {
      firstStopStarted = resolve;
    });
    let finishRetry: () => void = () => undefined;
    const retryGate = new Promise<void>((resolve) => {
      finishRetry = resolve;
    });
    let retryStarted: () => void = () => undefined;
    const retryStartedGate = new Promise<void>((resolve) => {
      retryStarted = resolve;
    });
    oldPreview.stop = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => {
        firstStopStarted();
        return firstStopGate;
      })
      .mockImplementationOnce(() => {
        retryStarted();
        return retryGate;
      });
    await startHandle(lifecycle, oldPreview);

    const discardedExecute = vi.fn(async () => execution(discardedReplacement));
    const firstReplacement = lifecycle
      .start({
        senderId: 2,
        workspaceId: "workspace-1",
        siteRoot: "site",
        isCurrent: () => true,
        prepare: async () => discardedExecute,
      })
      .catch((error: unknown) => error as Error);
    await firstStopStartedGate;

    const replacementExecute = vi.fn(async () => execution(replacement));
    const secondReplacement = lifecycle.start({
      senderId: 3,
      workspaceId: "workspace-1",
      siteRoot: "site",
      isCurrent: () => true,
      prepare: async () => replacementExecute,
    });
    await Promise.resolve();
    expect(discardedExecute).not.toHaveBeenCalled();
    expect(replacementExecute).not.toHaveBeenCalled();

    rejectFirstStop(new Error("first stop failed"));
    expect(await firstReplacement).toBeInstanceOf(Error);
    await retryStartedGate;
    expect(oldPreview.stop).toHaveBeenCalledTimes(2);
    expect(replacementExecute).not.toHaveBeenCalled();

    finishRetry();
    await secondReplacement;
    expect(discardedExecute).not.toHaveBeenCalled();
    expect(replacementExecute).toHaveBeenCalledTimes(1);
    await lifecycle.stopAll();
  });

  it("ignores an old exit after a same-origin replacement", async () => {
    const lifecycle = createSitePreviewLifecycle({
      allowOrigin: allowLoopbackFrameOrigin,
    });
    const url = "http://127.0.0.1:6201/";
    const oldServer = fakeProcessHandle(url);
    const replacement = fakeProcessHandle(url);
    await startHandle(lifecycle, oldServer.handle);
    await startHandle(lifecycle, replacement.handle);

    oldServer.exit();

    expect(isAllowedLoopbackFrameUrl(`${url}frame`)).toBe(true);
    expect(lifecycle.status("workspace-1", "site").running).toBe(true);

    replacement.exit();

    expect(isAllowedLoopbackFrameUrl(`${url}frame`)).toBe(false);
    expect(lifecycle.status("workspace-1", "site").exited).toBe(true);
    await lifecycle.stopAll();
  });

  it("cancelSender cancels only that sender's pending starts", async () => {
    const { lifecycle } = testLifecycle();
    const cancelledHandle = fakeStaticHandle("http://127.0.0.1:4173/");
    const survivingHandle = fakeStaticHandle("http://127.0.0.1:5173/");
    let finishPreparation: () => void = () => undefined;
    const preparationGate = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const cancelledExecute = vi.fn(async () => execution(cancelledHandle));
    const survivingExecute = vi.fn(async () => execution(survivingHandle));
    const cancelled = lifecycle
      .start({
        senderId: 7,
        workspaceId: "workspace-1",
        siteRoot: "site-a",
        isCurrent: () => true,
        prepare: async () => {
          await preparationGate;
          return cancelledExecute;
        },
      })
      .catch((error: unknown) => error as Error);
    const surviving = lifecycle.start({
      senderId: 8,
      workspaceId: "workspace-1",
      siteRoot: "site-b",
      isCurrent: () => true,
      prepare: async () => {
        await preparationGate;
        return survivingExecute;
      },
    });

    lifecycle.cancelSender(7);
    finishPreparation();

    expect(await cancelled).toBeInstanceOf(Error);
    await expect(surviving).resolves.toMatchObject({
      url: survivingHandle.url,
      exited: false,
    });
    expect(cancelledExecute).not.toHaveBeenCalled();
    expect(survivingExecute).toHaveBeenCalledTimes(1);
    await lifecycle.stopAll();
  });

  it("cancelSender still cancels the sender's lane-owning execution", async () => {
    const { lifecycle } = testLifecycle();
    const candidate = fakeStaticHandle("http://127.0.0.1:4173/");
    let executionStarted: () => void = () => undefined;
    const executionStartedGate = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    let finishExecution: () => void = () => undefined;
    const executionGate = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const starting = lifecycle
      .start({
        senderId: 7,
        workspaceId: "workspace-1",
        siteRoot: "site",
        isCurrent: () => true,
        prepare: async () => async (signal) => {
          observedSignal = signal;
          executionStarted();
          await executionGate;
          return execution(candidate);
        },
      })
      .catch((error: unknown) => error as Error);
    await executionStartedGate;

    lifecycle.cancelSender(7);
    expect(observedSignal?.aborted).toBe(true);
    finishExecution();

    expect(await starting).toBeInstanceOf(Error);
    expect(candidate.stop).toHaveBeenCalledTimes(1);
  });

  it("retains a late cancelled handle when its first stop fails", async () => {
    const { lifecycle } = testLifecycle();
    const candidate = fakeStaticHandle("http://127.0.0.1:4173/");
    const replacement = fakeStaticHandle("http://127.0.0.1:5173/");
    candidate.stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("late stop remained ambiguous"))
      .mockResolvedValue(undefined);
    let executionStarted: () => void = () => undefined;
    const executionStartedGate = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    let finishExecution: () => void = () => undefined;
    const executionGate = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    const starting = lifecycle
      .start({
        senderId: 7,
        workspaceId: "workspace-1",
        siteRoot: "site",
        isCurrent: () => true,
        prepare: async () => async () => {
          executionStarted();
          await executionGate;
          return execution(candidate);
        },
      })
      .catch((error: unknown) => error as Error);
    await executionStartedGate;

    lifecycle.cancelSender(7);
    finishExecution();
    expect(await starting).toBeInstanceOf(Error);
    expect(candidate.stop).toHaveBeenCalledTimes(1);

    await startHandle(lifecycle, replacement, { senderId: 8 });

    expect(candidate.stop).toHaveBeenCalledTimes(2);
    expect(replacement.stop).not.toHaveBeenCalled();
    await lifecycle.stopAll();
  });

  it("stopWorkspace returns while cancelled preparation is still unresolved", async () => {
    const { lifecycle } = testLifecycle();
    const candidate = fakeStaticHandle("http://127.0.0.1:4173/");
    let finishPreparation: () => void = () => undefined;
    const preparationGate = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const execute = vi.fn(async () => execution(candidate));
    const starting = lifecycle
      .start({
        senderId: 1,
        workspaceId: "workspace-1",
        siteRoot: "site",
        isCurrent: () => true,
        prepare: async () => {
          await preparationGate;
          return execute;
        },
      })
      .catch((error: unknown) => error as Error);

    await expect(
      lifecycle.stopWorkspace("workspace-1"),
    ).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();

    finishPreparation();
    expect(await starting).toBeInstanceOf(Error);
    expect(execute).not.toHaveBeenCalled();
  });

  it("stopWorkspace cancels and drains a lane-owning execution", async () => {
    const { lifecycle } = testLifecycle();
    const candidate = fakeStaticHandle("http://127.0.0.1:4173/");
    let executionStarted: () => void = () => undefined;
    const executionStartedGate = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    let finishExecution: () => void = () => undefined;
    const executionGate = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const starting = lifecycle
      .start({
        senderId: 1,
        workspaceId: "workspace-1",
        siteRoot: "site",
        isCurrent: () => true,
        prepare: async () => async (signal) => {
          observedSignal = signal;
          executionStarted();
          await executionGate;
          return execution(candidate);
        },
      })
      .catch((error: unknown) => error as Error);
    await executionStartedGate;

    const stopping = lifecycle.stopWorkspace("workspace-1");
    expect(observedSignal?.aborted).toBe(true);
    finishExecution();

    expect(await starting).toBeInstanceOf(Error);
    await stopping;
    expect(candidate.stop).toHaveBeenCalledTimes(1);
  });

  it("stopWorkspace stops its snapshot without stopping a later replacement", async () => {
    const { lifecycle } = testLifecycle();
    const oldPreview = fakeStaticHandle("http://127.0.0.1:4173/");
    const replacement = fakeStaticHandle("http://127.0.0.1:5173/");
    let oldStopStarted: () => void = () => undefined;
    const oldStopStartedGate = new Promise<void>((resolve) => {
      oldStopStarted = resolve;
    });
    let finishOldStop: () => void = () => undefined;
    oldPreview.stop = vi.fn(
      () => {
        oldStopStarted();
        return new Promise<void>((resolve) => {
          finishOldStop = resolve;
        });
      },
    );
    await startHandle(lifecycle, oldPreview);

    const workspaceStop = lifecycle.stopWorkspace("workspace-1");
    const replacing = startHandle(lifecycle, replacement);
    await oldStopStartedGate;
    expect(oldPreview.stop).toHaveBeenCalledTimes(1);
    expect(replacement.stop).not.toHaveBeenCalled();

    finishOldStop();
    await workspaceStop;
    await replacing;

    expect(replacement.stop).not.toHaveBeenCalled();
    expect(lifecycle.status("workspace-1", "site").running).toBe(true);
    await lifecycle.stopAll();
  });

  it("stopAll returns while cancelled preparation is still unresolved", async () => {
    const { lifecycle } = testLifecycle();
    const candidate = fakeStaticHandle("http://127.0.0.1:4173/");
    let finishPreparation: () => void = () => undefined;
    const preparationGate = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const execute = vi.fn(async () => execution(candidate));
    const starting = lifecycle
      .start({
        senderId: 1,
        workspaceId: "workspace-1",
        siteRoot: "site",
        isCurrent: () => true,
        prepare: async () => {
          await preparationGate;
          return execute;
        },
      })
      .catch((error: unknown) => error as Error);

    await expect(lifecycle.stopAll()).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();

    finishPreparation();
    expect(await starting).toBeInstanceOf(Error);
    expect(execute).not.toHaveBeenCalled();
  });

  it("stopAll retires the owner, waits for late handles, and memoizes teardown", async () => {
    const { lifecycle, allowOrigin } = testLifecycle();
    const lateHandle = fakeStaticHandle("http://127.0.0.1:4173/");
    lateHandle.stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("stop failed"))
      .mockResolvedValue(undefined);
    let observedSignal: AbortSignal | undefined;
    let executionStarted: () => void = () => undefined;
    const startedGate = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    let finishExecution: () => void = () => undefined;
    const executionGate = new Promise<void>((resolve) => {
      finishExecution = resolve;
    });
    const starting = lifecycle
      .start({
        senderId: 1,
        workspaceId: "workspace-1",
        siteRoot: "site",
        isCurrent: () => true,
        prepare: async () => async (signal) => {
          observedSignal = signal;
          executionStarted();
          await executionGate;
          return execution(lateHandle);
        },
      })
      .catch((error: unknown) => error as Error);
    await startedGate;

    const firstStop = lifecycle.stopAll();
    const repeatedStop = lifecycle.stopAll();
    expect(repeatedStop).toBe(firstStop);
    expect(observedSignal?.aborted).toBe(true);

    let stopSettled = false;
    void firstStop.then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    finishExecution();
    expect(await starting).toBeInstanceOf(Error);
    await expect(firstStop).resolves.toBeUndefined();
    expect(lateHandle.stop).toHaveBeenCalledTimes(2);
    expect(allowOrigin).not.toHaveBeenCalled();

    const prepareAfterRetirement = vi.fn();
    await expect(
      lifecycle.start({
        senderId: 1,
        workspaceId: "workspace-1",
        siteRoot: "site",
        isCurrent: () => true,
        prepare: prepareAfterRetirement,
      }),
    ).rejects.toThrow(/renderer restarted/i);
    expect(prepareAfterRetirement).not.toHaveBeenCalled();
  });

  it("stopAll isolates failures, retains them for retry, and releases each origin once", async () => {
    const { lifecycle, releases } = testLifecycle();
    const running = fakeStaticHandle("http://127.0.0.1:4173/");
    const exited = fakeProcessHandle("http://127.0.0.1:5173/");
    running.stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("stop failed"))
      .mockResolvedValue(undefined);
    await startHandle(lifecycle, running, { siteRoot: "site-a" });
    await startHandle(lifecycle, exited.handle, { siteRoot: "site-b" });
    exited.exit();

    const firstStop = lifecycle.stopAll().catch((error: unknown) => error as Error);
    expect(await firstStop).toBeInstanceOf(Error);

    expect(running.stop).toHaveBeenCalledTimes(1);
    expect(exited.handle.stop).toHaveBeenCalledTimes(1);
    expect(releases.get(running.url)).toHaveBeenCalledTimes(1);
    expect(releases.get(exited.handle.url)).toHaveBeenCalledTimes(1);

    await expect(lifecycle.stopAll()).resolves.toBeUndefined();
    expect(running.stop).toHaveBeenCalledTimes(2);
    expect(exited.handle.stop).toHaveBeenCalledTimes(1);
    expect(releases.get(running.url)).toHaveBeenCalledTimes(1);
    expect(releases.get(exited.handle.url)).toHaveBeenCalledTimes(1);
  });

  it("retains failed stopAll ownership and retries it on the next call", async () => {
    const { lifecycle, releases } = testLifecycle();
    const preview = fakeStaticHandle("http://127.0.0.1:4173/");
    preview.stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("quit stop remained ambiguous"))
      .mockResolvedValue(undefined);
    await startHandle(lifecycle, preview);

    const firstStop = lifecycle.stopAll();
    expect(lifecycle.stopAll()).toBe(firstStop);
    await expect(firstStop).rejects.toThrow(/quit stop remained ambiguous/);
    expect(preview.stop).toHaveBeenCalledTimes(1);
    expect(releases.get(preview.url)).toHaveBeenCalledTimes(1);
    expect(lifecycle.status("workspace-1", "site").running).toBe(true);

    const retry = lifecycle.stopAll();
    expect(retry).not.toBe(firstStop);
    await expect(retry).resolves.toBeUndefined();
    expect(preview.stop).toHaveBeenCalledTimes(2);
    expect(lifecycle.status("workspace-1", "site").running).toBe(false);
  });
});

describe("an app preview shown by more than one surface", () => {
  function surfaces() {
    const { lifecycle } = testLifecycle();
    const handles: StaticSitePreview[] = [];
    const prepare = vi.fn(async () => async () => {
      const handle = fakeStaticHandle(`http://127.0.0.1:${4200 + handles.length}/`);
      handles.push(handle);
      return execution(handle);
    });
    const show = (holderId: string, input: { mode?: string; restart?: boolean; senderId?: number } = {}) =>
      lifecycle.acquire({
        holderId,
        senderId: input.senderId ?? 1,
        workspaceId: "workspace-1",
        siteRoot: "site",
        mode: input.mode ?? "static",
        restart: input.restart ?? false,
        isCurrent: () => true,
        prepare,
      });
    const hide = (holderId: string) =>
      lifecycle.release({
        getActiveWorkspaceId: () => "workspace-1",
        holderId,
        workspaceId: "workspace-1",
        siteRoot: "site",
      });
    return { lifecycle, handles, prepare, show, hide };
  }

  it.each([["tab", "pin"], ["pin", "tab"]])("shares one preview when %s opens before %s, and stops it after both close", async (first, second) => {
    const s = surfaces();
    const shown = await s.show(first);
    await expect(s.show(second)).resolves.toEqual(shown);
    expect(s.prepare).toHaveBeenCalledOnce();

    await s.hide(first);
    expect(s.handles[0]!.stop).not.toHaveBeenCalled();
    expect(s.lifecycle.status("workspace-1", "site").running).toBe(true);
    await s.hide(second);
    expect(s.handles[0]!.stop).toHaveBeenCalledOnce();
    expect(s.lifecycle.status("workspace-1", "site").running).toBe(false);
  });

  it("keeps the preview when the pinned panel is switched away and back", async () => {
    const s = surfaces();
    await s.show("tab");
    await s.show("pin");
    await s.hide("pin");
    await s.show("pin-again");
    expect(s.prepare).toHaveBeenCalledOnce();
    expect(s.handles[0]!.stop).not.toHaveBeenCalled();
  });

  it("starts once when two surfaces restore at the same time", async () => {
    const s = surfaces();
    const [tab, pin] = await Promise.all([s.show("tab"), s.show("pin")]);
    expect(pin).toEqual(tab);
    expect(s.prepare).toHaveBeenCalledOnce();
  });

  it("starts again for a mode change or a restart the person asked for", async () => {
    const s = surfaces();
    await s.show("tab");
    await s.show("pin");
    const rebuilt = await s.show("tab", { mode: "build" });
    expect(s.handles[0]!.stop).toHaveBeenCalledOnce();
    expect(rebuilt.url).toBe(s.handles[1]!.url);
    // The pinned panel lost the static preview to the mode change; closing
    // it leaves the new preview running.
    await s.hide("pin");
    expect(s.handles[1]!.stop).not.toHaveBeenCalled();
    await s.show("tab", { mode: "build", restart: true });
    expect(s.handles[1]!.stop).toHaveBeenCalledOnce();
    expect(s.prepare).toHaveBeenCalledTimes(3);
  });

  it("stops a preview only a closed window showed", async () => {
    const s = surfaces();
    await s.show("tab", { senderId: 1 });
    await s.show("pin", { senderId: 2 });
    s.lifecycle.cancelSender(1);
    expect(s.handles[0]!.stop).not.toHaveBeenCalled();
    s.lifecycle.cancelSender(2);
    // A later stop runs in the same lane, so once it answers the stop that
    // closing the window queued has run.
    await s.hide("nobody");
    expect(s.handles[0]!.stop).toHaveBeenCalledOnce();
  });
});
