import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "./channels";
import { registerWorkspaceSearchIpcHandlers } from "./workspaceSearchIpc";

interface TestEvent {
  trusted: boolean;
  sender: {
    id: number;
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
    once(event: "destroyed", listener: () => void): void;
  };
}

function harness() {
  const trace: string[] = [];
  let activeWorkspaceId = "workspace-1";
  let rendererSessionCurrent = true;
  const handlers = new Map<
    string,
    (event: TestEvent, payload: unknown) => Promise<unknown> | unknown
  >();
  const workspace = {
    workspaceId: "workspace-1",
    rootPath: "C:/workspace-1",
  };
  const attachmentId = Symbol("workspace-1");
  const signal = new AbortController().signal;
  const owner = {
    start: vi.fn(async () => ({ settled: Promise.resolve() })),
    cancel: vi.fn(),
  };
  const authorizeCancel = vi.fn((_event: TestEvent) => {
    return rendererSessionCurrent;
  });
  const onActivityError = vi.fn();
  registerWorkspaceSearchIpcHandlers<TestEvent, typeof workspace>({
    registerHandler: (channel, handler) => handlers.set(channel, handler),
    assertTrustedSender: (event) => {
      trace.push("trust");
      if (!event.trusted) throw new Error("Untrusted renderer.");
    },
    withWorkspaceOperation: async (_event, workspaceId, work) => {
      trace.push(`workspace:${workspaceId}`);
      if (workspaceId !== workspace.workspaceId) {
        throw new Error("Renderer has no authority for this workspace.");
      }
      if (!rendererSessionCurrent || activeWorkspaceId !== workspaceId) {
        throw new Error("Search does not target the open workspace.");
      }
      return work({
        workspace,
        attachmentId,
        signal,
        isCurrent: () =>
          rendererSessionCurrent &&
          activeWorkspaceId === workspace.workspaceId,
      });
    },
    authorizeCancel,
    owner,
    onActivityError,
  });
  const event: TestEvent = {
    trusted: true,
    sender: {
      id: 19,
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
    },
  };
  return {
    trace,
    owner,
    authorizeCancel,
    onActivityError,
    event,
    setActiveWorkspaceId(workspaceId: string) {
      activeWorkspaceId = workspaceId;
    },
    retireRendererSession() {
      rendererSessionCurrent = false;
    },
    channels: [...handlers.keys()],
    invoke: async (channel: string, payload: unknown, invokedEvent = event) =>
      await handlers.get(channel)!(invokedEvent, payload),
  };
}

describe("workspace search IPC registration", () => {
  it("registers the start and cancel commands", () => {
    const test = harness();
    expect(test.channels).toEqual([
      CHANNELS.searchWorkspace,
      CHANNELS.cancelWorkspaceSearch,
    ]);
  });

  it("checks trust, parses the request, and resolves workspace authority before start", async () => {
    const test = harness();
    const payload = {
      workspaceId: "workspace-1",
      searchId: "search-1",
      query: "needle",
    };

    await expect(test.invoke(CHANNELS.searchWorkspace, payload)).resolves.toEqual({
      status: "accepted",
    });

    expect(test.trace).toEqual(["trust", "workspace:workspace-1"]);
    expect(test.owner.start).toHaveBeenCalledWith(
      test.event.sender,
      {
        workspace: {
          workspaceId: "workspace-1",
          rootPath: "C:/workspace-1",
        },
        attachmentId: expect.any(Symbol),
        signal: expect.any(AbortSignal),
        isCurrent: expect.any(Function),
      },
      payload,
    );
  });

  it("rejects untrusted, malformed, and unauthorized starts before the owner", async () => {
    const untrusted = harness();
    await expect(
      untrusted.invoke(
        CHANNELS.searchWorkspace,
        null,
        { ...untrusted.event, trusted: false },
      ),
    ).rejects.toThrow("Untrusted renderer.");
    expect(untrusted.trace).toEqual(["trust"]);

    const malformed = harness();
    await expect(
      malformed.invoke(CHANNELS.searchWorkspace, { workspaceId: "" }),
    ).rejects.toThrow();
    expect(malformed.trace).toEqual(["trust"]);

    const unauthorized = harness();
    await expect(
      unauthorized.invoke(CHANNELS.searchWorkspace, {
        workspaceId: "workspace-2",
        searchId: "search-1",
        query: "needle",
      }),
    ).rejects.toThrow("Renderer has no authority for this workspace.");
    expect(unauthorized.trace).toEqual(["trust", "workspace:workspace-2"]);
    expect(untrusted.owner.start).not.toHaveBeenCalled();
    expect(malformed.owner.start).not.toHaveBeenCalled();
    expect(unauthorized.owner.start).not.toHaveBeenCalled();
  });

  it("rejects a registered workspace that is not open in the caller", async () => {
    const test = harness();
    test.setActiveWorkspaceId("workspace-2");

    await expect(
      test.invoke(CHANNELS.searchWorkspace, {
        workspaceId: "workspace-1",
        searchId: "search-1",
        query: "needle",
      }),
    ).rejects.toThrow("does not target the open workspace");

    expect(test.owner.start).not.toHaveBeenCalled();
  });

  it("passes a stopped owner invocation back to the renderer", async () => {
    const test = harness();
    test.owner.start.mockRejectedValueOnce(
      new Error("Workspace search stopped because it is no longer current."),
    );

    await expect(
      test.invoke(CHANNELS.searchWorkspace, {
        workspaceId: "workspace-1",
        searchId: "search-1",
        query: "needle",
      }),
    ).rejects.toThrow(
      "Workspace search stopped because it is no longer current.",
    );
  });

  it("returns a stable refusal code while the workspace is updating", async () => {
    const test = harness();
    test.owner.start.mockRejectedValueOnce(
      Object.assign(new Error("Workspace is still updating. Try again."), {
        wireError: {
          code: "OVERLOADED",
          message: "Workspace is still updating. Try again.",
          retry: "afterBackoff",
        },
      }),
    );

    await expect(
      test.invoke(CHANNELS.searchWorkspace, {
        workspaceId: "workspace-1",
        searchId: "search-1",
        query: "needle",
      }),
    ).resolves.toEqual({
      status: "refused",
      code: "workspace-updating",
    });
    expect(test.onActivityError).not.toHaveBeenCalled();
  });

  it("denies a fresh search as soon as reload retirement invalidates the lease", async () => {
    const test = harness();
    test.retireRendererSession();

    await expect(
      test.invoke(CHANNELS.searchWorkspace, {
        workspaceId: "workspace-1",
        searchId: "search-after-reload",
        query: "needle",
      }),
    ).rejects.toThrow("does not target the open workspace");

    expect(test.owner.start).not.toHaveBeenCalled();
  });

  it("cancels only the caller's named search", async () => {
    const test = harness();

    await test.invoke(CHANNELS.cancelWorkspaceSearch, { searchId: "search-1" });

    expect(test.trace).toEqual(["trust"]);
    expect(test.authorizeCancel).toHaveBeenCalledWith(test.event);
    expect(test.owner.cancel).toHaveBeenCalledWith(19, "search-1");
  });

  it("ignores a cancel after the caller's renderer session retires", async () => {
    const test = harness();
    test.retireRendererSession();

    await test.invoke(CHANNELS.cancelWorkspaceSearch, { searchId: "search-1" });

    expect(test.owner.cancel).not.toHaveBeenCalled();
  });
});
