import { describe, expect, it, vi } from "vitest";
import { createExactMountOperationRunner } from "./exactMountOperation";

function harness() {
  const workspace = {
    workspaceId: "workspace",
    attachmentId: Symbol("attachment"),
  };
  const assertCurrent = vi.fn();
  const operation = { workspace, assertCurrent };
  const acquired = vi.fn();
  const withOperation = async <Result>(
    _workspaceId: string,
    run: (current: typeof operation) => Promise<Result>,
  ) => {
    acquired();
    return run(operation);
  };
  const engineReady = vi.fn(async (): Promise<void> => {});
  const run = createExactMountOperationRunner<
    typeof workspace,
    typeof operation
  >({ withOperation, engineReady });
  const input = { workspace, assertCurrent: vi.fn() };
  const mutate = vi.fn(async () => "mounted");
  return {
    workspace,
    input,
    run,
    mutate,
    withOperation: acquired,
    engineReady,
    assertCurrent,
  };
}

describe("exact mount operations", () => {
  it("requires an attachment before acquiring authority", () => {
    const h = harness();
    expect(() =>
      h.run({ ...h.input, workspace: { workspaceId: "workspace" } }, h.mutate),
    ).toThrow("exact workspace attachment");
    expect(h.withOperation).not.toHaveBeenCalled();
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it("refuses a replaced attachment before engine startup and storage", async () => {
    const h = harness();
    await expect(
      h.run(
        {
          ...h.input,
          workspace: Object.assign({}, h.workspace, {
            attachmentId: Symbol("old"),
          }),
        },
        h.mutate,
      ),
    ).rejects.toThrow("retired workspace");
    expect(h.engineReady).not.toHaveBeenCalled();
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it.each(["assertCurrent", "caller"] as const)(
    "checks %s after engine startup before mutation",
    async (gate) => {
      const h = harness();
      const started = Promise.withResolvers<void>();
      h.engineReady.mockReturnValue(started.promise);
      const result = h.run(h.input, h.mutate);
      (gate === "caller"
        ? h.input.assertCurrent
        : h.assertCurrent
      ).mockImplementation(() => {
        throw new Error("retired");
      });
      started.resolve();
      await expect(result).rejects.toThrow("retired");
      expect(h.mutate).not.toHaveBeenCalled();
    },
  );

  it("passes the canonical workspace and keeps both guards in later mutation callbacks", async () => {
    const h = harness();
    await h.run(h.input, async (operation, current) => {
      expect(current.workspace).toBe(operation.workspace);
      h.input.assertCurrent.mockImplementation(() => {
        throw new Error("caller retired");
      });
      expect(current.assertCurrent).toThrow("caller retired");
      h.assertCurrent.mockImplementation(() => {
        throw new Error("physical retired");
      });
      expect(current.assertCurrent).toThrow("physical retired");
    });
  });
});
