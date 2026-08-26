import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "./channels";
import { registerShareMountIpcHandlers } from "./shareMountIpc";

interface TestEvent {
  trusted: boolean;
  activeWorkspaceId: string;
  generation: number;
}

const workspace = {
  workspaceId: "workspace-1",
  rootPath: "C:/workspace-1",
};
const workspaceSummary = {
  ...workspace,
  kind: "personal" as const,
  mode: "local-first" as const,
};
const shareId = "11111111-1111-4111-8111-111111111111";

function harness() {
  const handlers = new Map<
    string,
    (event: TestEvent, payload: unknown) => Promise<unknown>
  >();
  const trace: string[] = [];
  let writable = true;
  let activeWorkspaceId = workspace.workspaceId;
  let generation = 1;
  let physicalWorkspace = workspace;
  const commands = {
    mount: vi.fn(async ({ shareCode }: { shareCode: string }) => {
      trace.push(`mount:${shareCode}`);
      return {
        workspace: workspaceSummary,
        mount: {
          shareId,
          label: "alex",
          status: "updated" as const,
          changedPaths: 2,
        },
      };
    }),
    refresh: vi.fn(async (_input: { assertCurrent(): void }) => {
      trace.push("refresh");
      return { results: [] };
    }),
    unmount: vi.fn(async ({ shareId: requested }: { shareId: string }) => {
      trace.push(`unmount:${requested}`);
      return { workspace: workspaceSummary };
    }),
  };
  const dependencies = {
    registerHandler: (
      channel: string,
      handler: (event: TestEvent, payload: unknown) => Promise<unknown>,
    ) => {
      if (handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`);
      handlers.set(channel, handler);
    },
    assertTrustedSender: (event: TestEvent) => {
      trace.push("trust");
      if (!event.trusted) throw new Error("Untrusted renderer.");
    },
    withWorkspaceOperation: async (
      event: TestEvent,
      workspaceId: string,
      work: (operation: {
        workspace: typeof workspace;
        assertCurrent(): void;
      }) => Promise<unknown>,
    ) => {
      trace.push(`operation:${workspaceId}`);
      const admittedGeneration = event.generation;
      const assertCurrent = () => {
        if (
          event.activeWorkspaceId !== workspaceId ||
          event.activeWorkspaceId !== activeWorkspaceId ||
          event.generation !== admittedGeneration ||
          generation !== admittedGeneration
        ) {
          throw new Error("This window changed workspaces.");
        }
      };
      assertCurrent();
      const result = await work({ workspace: physicalWorkspace, assertCurrent });
      assertCurrent();
      return result;
    },
    assertWritableWorkspace: () => {
      trace.push("write gate");
      if (!writable) throw new Error("This workspace is read-only.");
    },
    commands,
  };
  registerShareMountIpcHandlers(dependencies);
  return {
    handlers,
    trace,
    commands,
    setWritable(value: boolean) {
      writable = value;
    },
    setActiveWorkspace(workspaceId: string) {
      activeWorkspaceId = workspaceId;
    },
    retireRenderer() {
      generation += 1;
    },
    setPhysicalWorkspace(next: typeof workspace) {
      physicalWorkspace = next;
    },
    invoke(
      channel: string,
      payload: unknown,
      event = {
        trusted: true,
        activeWorkspaceId: workspace.workspaceId,
        generation: 1,
      },
    ) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing handler: ${channel}`);
      return handler(event, payload);
    },
  };
}

describe("share mount IPC registration", () => {
  it("registers exactly the three share mount commands", () => {
    const test = harness();
    expect([...test.handlers.keys()]).toEqual([
      CHANNELS.mountShare,
      CHANNELS.refreshShareMounts,
      CHANNELS.unmountShare,
    ]);
  });

  it("parses, scopes, gates, and validates every command", async () => {
    const test = harness();

    await expect(
      test.invoke(CHANNELS.mountShare, {
        workspaceId: workspace.workspaceId,
        shareCode: "dohc-share:test",
      }),
    ).resolves.toMatchObject({ mount: { shareId, changedPaths: 2 } });
    expect(test.trace.splice(0)).toEqual([
      "trust",
      `operation:${workspace.workspaceId}`,
      "write gate",
      "mount:dohc-share:test",
    ]);
    expect(test.commands.mount).toHaveBeenCalledWith({
      workspace,
      shareCode: "dohc-share:test",
      assertCurrent: expect.any(Function),
    });

    await expect(
      test.invoke(CHANNELS.refreshShareMounts, {
        workspaceId: workspace.workspaceId,
      }),
    ).resolves.toEqual({ results: [] });
    expect(test.trace.splice(0)).toEqual([
      "trust",
      `operation:${workspace.workspaceId}`,
      "write gate",
      "refresh",
    ]);
    expect(test.commands.refresh).toHaveBeenCalledWith({
      workspace,
      assertCurrent: expect.any(Function),
    });

    await expect(
      test.invoke(CHANNELS.unmountShare, {
        workspaceId: workspace.workspaceId,
        shareId,
      }),
    ).resolves.toEqual({ workspace: workspaceSummary });
    expect(test.trace).toEqual([
      "trust",
      `operation:${workspace.workspaceId}`,
      "write gate",
      `unmount:${shareId}`,
    ]);
    expect(test.commands.unmount).toHaveBeenCalledWith({
      workspace,
      shareId,
      assertCurrent: expect.any(Function),
    });
  });

  it.each([
    [
      CHANNELS.mountShare,
      { workspaceId: workspace.workspaceId, shareCode: "code" },
    ],
    [CHANNELS.refreshShareMounts, { workspaceId: workspace.workspaceId }],
    [CHANNELS.unmountShare, { workspaceId: workspace.workspaceId, shareId }],
  ])("refuses %s when the renderer has another workspace active", async (channel, payload) => {
    const test = harness();
    test.setActiveWorkspace("workspace-2");

    await expect(
      test.invoke(channel, payload, {
        trusted: true,
        activeWorkspaceId: workspace.workspaceId,
        generation: 1,
      }),
    ).rejects.toThrow("changed workspaces");
    expect(test.commands.mount).not.toHaveBeenCalled();
    expect(test.commands.refresh).not.toHaveBeenCalled();
    expect(test.commands.unmount).not.toHaveBeenCalled();
  });

  it("passes the exact operation workspace instead of the registry alias", async () => {
    const test = harness();
    const canonicalWorkspace = {
      ...workspace,
      rootPath: "C:/canonical-workspace-1",
    };
    test.setPhysicalWorkspace(canonicalWorkspace);

    await test.invoke(CHANNELS.refreshShareMounts, {
      workspaceId: workspace.workspaceId,
    });

    expect(test.commands.refresh).toHaveBeenCalledWith({
      workspace: canonicalWorkspace,
      assertCurrent: expect.any(Function),
    });
  });

  it("refuses a held command result after renderer retirement", async () => {
    const command = Promise.withResolvers<{ results: [] }>();
    const test = harness();
    test.commands.refresh.mockReturnValueOnce(command.promise);
    const pending = test.invoke(CHANNELS.refreshShareMounts, {
      workspaceId: workspace.workspaceId,
    });

    await vi.waitFor(() => expect(test.commands.refresh).toHaveBeenCalledOnce());
    test.retireRenderer();
    command.resolve({ results: [] });

    await expect(pending).rejects.toThrow("changed workspaces");
  });

  it("does not run a post-prerequisite effect after renderer retirement", async () => {
    const prerequisite = Promise.withResolvers<void>();
    const effect = vi.fn();
    const test = harness();
    test.commands.refresh.mockImplementationOnce(async (input) => {
      await prerequisite.promise;
      input.assertCurrent();
      effect();
      return { results: [] };
    });
    const pending = test.invoke(CHANNELS.refreshShareMounts, {
      workspaceId: workspace.workspaceId,
    });

    await vi.waitFor(() => expect(test.commands.refresh).toHaveBeenCalledOnce());
    test.retireRenderer();
    prerequisite.resolve();

    await expect(pending).rejects.toThrow("changed workspaces");
    expect(effect).not.toHaveBeenCalled();
  });

  it.each([
    [
      CHANNELS.mountShare,
      { workspaceId: workspace.workspaceId, shareCode: "code" },
    ],
    [CHANNELS.refreshShareMounts, { workspaceId: workspace.workspaceId }],
    [CHANNELS.unmountShare, { workspaceId: workspace.workspaceId, shareId }],
  ])("gates %s before its command", async (channel, payload) => {
    const test = harness();
    test.setWritable(false);

    await expect(test.invoke(channel, payload)).rejects.toThrow(
      "This workspace is read-only.",
    );
    expect(test.trace).toEqual([
      "trust",
      `operation:${workspace.workspaceId}`,
      "write gate",
    ]);
    expect(test.commands.mount).not.toHaveBeenCalled();
    expect(test.commands.refresh).not.toHaveBeenCalled();
    expect(test.commands.unmount).not.toHaveBeenCalled();
  });

  it("rejects an untrusted sender before parsing the payload", async () => {
    const test = harness();
    await expect(
      test.invoke(CHANNELS.mountShare, null, {
        trusted: false,
        activeWorkspaceId: workspace.workspaceId,
        generation: 1,
      }),
    ).rejects.toThrow("Untrusted renderer.");
    expect(test.trace).toEqual(["trust"]);
  });

  it("rejects malformed payloads before workspace lookup", async () => {
    const test = harness();
    await expect(
      test.invoke(CHANNELS.refreshShareMounts, { workspaceId: "" }),
    ).rejects.toThrow();
    expect(test.trace).toEqual(["trust"]);
  });

  it("rejects malformed command results at the IPC seam", async () => {
    const mount = harness();
    mount.commands.mount.mockResolvedValueOnce({} as never);
    await expect(
      mount.invoke(CHANNELS.mountShare, {
        workspaceId: workspace.workspaceId,
        shareCode: "code",
      }),
    ).rejects.toThrow();

    const refresh = harness();
    refresh.commands.refresh.mockResolvedValueOnce({} as never);
    await expect(
      refresh.invoke(CHANNELS.refreshShareMounts, {
        workspaceId: workspace.workspaceId,
      }),
    ).rejects.toThrow();

    const unmount = harness();
    unmount.commands.unmount.mockResolvedValueOnce({} as never);
    await expect(
      unmount.invoke(CHANNELS.unmountShare, {
        workspaceId: workspace.workspaceId,
        shareId,
      }),
    ).rejects.toThrow();
  });
});
