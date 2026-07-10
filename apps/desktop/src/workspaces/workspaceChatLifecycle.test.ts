import { describe, expect, it, vi } from "vitest";
import { createWorkspaceChatLifecycle } from "./workspaceChatLifecycle";

describe("workspace chat lifecycle", () => {
  it("maintains every writable registered workspace on boot", async () => {
    const maintain = vi.fn(async () => undefined);
    const lifecycle = createWorkspaceChatLifecycle({
      isReadOnly: (workspaceId) => workspaceId === "shared",
      maintain,
      onError: vi.fn(),
    });

    await lifecycle.boot([
      { workspaceId: "personal-a", rootPath: "/a" },
      { workspaceId: "shared", rootPath: "/shared" },
      { workspaceId: "personal-b", rootPath: "/b" },
    ]);
    await lifecycle.open(
      { workspaceId: "personal-a", rootPath: "/a" },
      async () => undefined,
    );

    expect(maintain.mock.calls).toEqual([["/a"], ["/b"]]);
  });

  it("coalesces concurrent first opens and skips later maintenance", async () => {
    let releaseMaintenance: () => void = () => {
      throw new Error("Maintenance did not start.");
    };
    const maintain = vi.fn(
      () => new Promise<void>((resolve) => {
        releaseMaintenance = resolve;
      }),
    );
    const lifecycle = createWorkspaceChatLifecycle({
      isReadOnly: () => false,
      maintain,
      onError: vi.fn(),
    });
    const workspace = { workspaceId: "personal", rootPath: "/workspace" };

    const first = lifecycle.open(workspace, async () => "first");
    const second = lifecycle.open(workspace, async () => "second");
    await vi.waitFor(() => expect(maintain).toHaveBeenCalledTimes(1));
    releaseMaintenance();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    await lifecycle.open(workspace, async () => "later");

    expect(maintain).toHaveBeenCalledTimes(1);
  });

  it("makes maintenance part of first open and runs it after join hydration", async () => {
    const order: string[] = [];
    const lifecycle = createWorkspaceChatLifecycle({
      isReadOnly: () => false,
      maintain: async () => {
        order.push("maintain");
      },
      onError: vi.fn(),
    });

    const result = await lifecycle.open(
      { workspaceId: "personal", rootPath: "/workspace" },
      async () => {
        order.push("open");
        return "opened";
      },
      async () => {
        order.push("hydrate");
      },
    );

    expect(result).toBe("opened");
    expect(order).toEqual(["open", "hydrate", "maintain"]);
  });

  it("reports maintenance errors without making workspace open fail", async () => {
    const error = new Error("read-only filesystem");
    const onError = vi.fn();
    const lifecycle = createWorkspaceChatLifecycle({
      isReadOnly: () => false,
      maintain: async () => {
        throw error;
      },
      onError,
    });

    await expect(lifecycle.open(
      { workspaceId: "personal", rootPath: "/workspace" },
      async () => "opened",
    )).resolves.toBe("opened");
    expect(onError).toHaveBeenCalledWith(error);
  });
});
