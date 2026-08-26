import { describe, expect, it, vi } from "vitest";
import { createWorkspaceAuthorityOwner } from "./workspaceAuthorityOwner";

interface Workspace {
  workspaceId: string;
  rootPath: string;
  label: string;
}

function testOwner(initial: Workspace | null) {
  let workspace = initial;
  const canonicalizeRoot = vi.fn((rootPath: string) => `real:${rootPath}`);
  const disposed: symbol[] = [];
  const owner = createWorkspaceAuthorityOwner({
    findWorkspace: () => workspace,
    canonicalizeRoot,
    createState: (binding) => ({
      binding: binding.attachmentId,
      values: [] as string[],
    }),
    disposeState: (state) => {
      disposed.push(state.binding);
    },
  });
  return {
    owner,
    canonicalizeRoot,
    disposed,
    replace(next: Workspace | null): void {
      workspace = next;
    },
  };
}

describe("workspace authority owner", () => {
  it("canonicalizes one registry binding once and owns its state", async () => {
    const test = testOwner({
      workspaceId: "workspace",
      rootPath: "alias",
      label: "A",
    });

    await test.owner.withAuthority("workspace", async (first) => {
      first.state.values.push("kept");
      expect(first.binding).toMatchObject({
        workspaceId: "workspace",
        registeredRootPath: "alias",
        canonicalRootPath: "real:alias",
        workspace: { label: "A" },
      });
      await test.owner.withAuthority("workspace", async (second) => {
        expect(second.binding).toBe(first.binding);
        expect(second.state).toBe(first.state);
        expect(second.state.values).toEqual(["kept"]);
      });
    });

    expect(test.canonicalizeRoot).toHaveBeenCalledOnce();
  });

  it("retires an absent-to-identical registration without resurrecting state", async () => {
    const workspace = {
      workspaceId: "workspace",
      rootPath: "root",
      label: "A",
    };
    const test = testOwner(workspace);
    const first = test.owner.acquire("workspace");
    first.state.values.push("old");

    test.replace(null);
    const drained = test.owner.invalidate("workspace");
    test.replace({ ...workspace });

    expect(() => first.assertCurrent()).toThrow("retired workspace authority");
    expect(() => test.owner.acquire("workspace")).toThrow("retiring or blocked");
    first.release();
    await drained;
    const replacement = test.owner.acquire("workspace");
    expect(replacement.binding.attachmentId).not.toBe(first.binding.attachmentId);
    expect(replacement.state.values).toEqual([]);
    replacement.release();
  });

  it("keeps retired state alive until the exact async lease releases", async () => {
    const test = testOwner({
      workspaceId: "workspace",
      rootPath: "root-a",
      label: "A",
    });
    let resume!: () => void;
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const running = test.owner.withAuthority("workspace", async (lease) => {
      const identity = lease.binding.attachmentId;
      await held;
      expect(test.disposed).not.toContain(identity);
      expect(() => lease.assertCurrent()).toThrow("retired workspace authority");
      return identity;
    });

    test.replace({ workspaceId: "workspace", rootPath: "root-b", label: "B" });
    const drained = test.owner.invalidate("workspace");
    expect(test.disposed).toEqual([]);
    resume();
    const retiredIdentity = await running;
    await drained;
    expect(test.disposed).toEqual([retiredIdentity]);
  });

  it("lets a cached adapter reacquire only its exact binding", async () => {
    const test = testOwner({
      workspaceId: "workspace",
      rootPath: "root",
      label: "A",
    });
    const first = test.owner.acquire("workspace");
    const binding = first.binding;
    first.release();

    await expect(
      test.owner.withBinding(binding, async (lease) => {
        lease.state.values.push("called");
      }),
    ).resolves.toBeUndefined();

    const drained = test.owner.invalidate("workspace");
    await drained;
    await expect(
      Promise.resolve().then(() => test.owner.withBinding(binding, async () => undefined)),
    ).rejects.toThrow("retired workspace authority");
  });

  it("deduplicates different registry spellings of one canonical root", async () => {
    let current: Workspace | null = {
      workspaceId: "first",
      rootPath: "alias-a",
      label: "A",
    };
    const owner = createWorkspaceAuthorityOwner({
      findWorkspace: (workspaceId) => (current?.workspaceId === workspaceId ? current : null),
      canonicalizeRoot: () => "one-real-root",
      createState: () => ({}),
    });
    const first = owner.acquire("first");
    current = { workspaceId: "second", rootPath: "alias-b", label: "B" };

    expect(() => owner.acquire("second")).toThrow("already attached as workspace first");
    first.release();
    await owner.close();
  });

  it("runs compare-and-remove only after held work drains", async () => {
    const test = testOwner({
      workspaceId: "workspace",
      rootPath: "root",
      label: "A",
    });
    const lease = test.owner.acquire("workspace");
    const removeBinding = vi.fn();
    const retiring = test.owner.retireBinding(lease.binding, removeBinding);

    await Promise.resolve();
    expect(removeBinding).not.toHaveBeenCalled();
    lease.release();
    await retiring;
    expect(removeBinding).toHaveBeenCalledOnce();
  });

  it("keeps a blocking tombstone when cleanup fails", async () => {
    let workspace: Workspace | null = {
      workspaceId: "workspace",
      rootPath: "root",
      label: "A",
    };
    const owner = createWorkspaceAuthorityOwner({
      findWorkspace: () => workspace,
      canonicalizeRoot: (rootPath) => rootPath,
      createState: () => ({}),
      disposeState: async () => {
        throw new Error("cleanup failed");
      },
    });
    const lease = owner.acquire("workspace");
    lease.release();

    await expect(owner.invalidate("workspace")).rejects.toThrow("cleanup failed");
    workspace = { ...workspace };
    expect(() => owner.acquire("workspace")).toThrow("retiring or blocked");
  });

  it("does not let a released lease touch its former authority", () => {
    const test = testOwner({
      workspaceId: "workspace",
      rootPath: "root",
      label: "A",
    });
    const lease = test.owner.acquire("workspace");
    lease.release();

    expect(() => lease.assertCurrent()).toThrow("lease was released");
    lease.release();
  });

  it("refuses an unknown workspace before creating state", () => {
    const test = testOwner(null);
    expect(() => test.owner.acquire("missing")).toThrow("Unknown workspace: missing");
    expect(test.canonicalizeRoot).not.toHaveBeenCalled();
  });
});
