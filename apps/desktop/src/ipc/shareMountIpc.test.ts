import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "./channels";
import { registerShareMountIpcHandlers } from "./shareMountIpc";

interface TestEvent {
  trusted: boolean;
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
    refresh: vi.fn(async () => {
      trace.push("refresh");
      return { results: [] };
    }),
    unmount: vi.fn(async ({ shareId: requested }: { shareId: string }) => {
      trace.push(`unmount:${requested}`);
      return { workspace: workspaceSummary };
    }),
  };
  registerShareMountIpcHandlers({
    registerHandler: (channel, handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`);
      handlers.set(channel, handler);
    },
    assertTrustedSender: (event: TestEvent) => {
      trace.push("trust");
      if (!event.trusted) throw new Error("Untrusted renderer.");
    },
    requireWorkspace: (workspaceId) => {
      trace.push(`workspace:${workspaceId}`);
      if (workspaceId !== workspace.workspaceId) {
        throw new Error(`Unknown workspace: ${workspaceId}`);
      }
      return workspace;
    },
    assertWritableWorkspace: () => {
      trace.push("write gate");
      if (!writable) throw new Error("This workspace is read-only.");
    },
    commands,
  });
  return {
    handlers,
    trace,
    commands,
    setWritable(value: boolean) {
      writable = value;
    },
    invoke(channel: string, payload: unknown, event = { trusted: true }) {
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
      `workspace:${workspace.workspaceId}`,
      "write gate",
      "mount:dohc-share:test",
    ]);
    expect(test.commands.mount).toHaveBeenCalledWith({
      workspace,
      shareCode: "dohc-share:test",
    });

    await expect(
      test.invoke(CHANNELS.refreshShareMounts, {
        workspaceId: workspace.workspaceId,
      }),
    ).resolves.toEqual({ results: [] });
    expect(test.trace.splice(0)).toEqual([
      "trust",
      `workspace:${workspace.workspaceId}`,
      "write gate",
      "refresh",
    ]);
    expect(test.commands.refresh).toHaveBeenCalledWith({ workspace });

    await expect(
      test.invoke(CHANNELS.unmountShare, {
        workspaceId: workspace.workspaceId,
        shareId,
      }),
    ).resolves.toEqual({ workspace: workspaceSummary });
    expect(test.trace).toEqual([
      "trust",
      `workspace:${workspace.workspaceId}`,
      "write gate",
      `unmount:${shareId}`,
    ]);
    expect(test.commands.unmount).toHaveBeenCalledWith({ workspace, shareId });
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
      `workspace:${workspace.workspaceId}`,
      "write gate",
    ]);
    expect(test.commands.mount).not.toHaveBeenCalled();
    expect(test.commands.refresh).not.toHaveBeenCalled();
    expect(test.commands.unmount).not.toHaveBeenCalled();
  });

  it("rejects an untrusted sender before parsing the payload", async () => {
    const test = harness();
    await expect(
      test.invoke(CHANNELS.mountShare, null, { trusted: false }),
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
