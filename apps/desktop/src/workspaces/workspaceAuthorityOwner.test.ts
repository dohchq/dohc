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
      });
      expect(first.binding).not.toHaveProperty("workspace");
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

  it("runs physical work against the canonical attachment and rechecks it before returning", async () => {
    const test = testOwner({
      workspaceId: "workspace",
      rootPath: "alias",
      label: "A",
    });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let attachmentId!: symbol;
    const running = test.owner.withOperation("workspace", async (operation) => {
      attachmentId = operation.workspace.attachmentId;
      expect(operation.workspace).toMatchObject({
        workspaceId: "workspace",
        rootPath: "real:alias",
        label: "A",
        attachmentId: operation.workspace.attachmentId,
      });
      entered.resolve();
      await resume.promise;
      return operation.workspace.rootPath;
    });

    await entered.promise;
    test.replace(null);
    const retiring = test.owner.invalidate("workspace");
    resume.resolve();

    await expect(running).rejects.toThrow("retired workspace authority");
    await retiring;
    expect(test.disposed).toEqual([attachmentId]);
  });

  it("keeps the admitted canonical root when its registry alias is retargeted", async () => {
    const workspace = {
      workspaceId: "workspace",
      rootPath: "alias",
      label: "A",
    };
    let aliasTarget = "canonical-c";
    const owner = createWorkspaceAuthorityOwner({
      findWorkspace: () => workspace,
      canonicalizeRoot: () => aliasTarget,
      createState: () => ({}),
      disposeState: () => undefined,
    });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const running = owner.withOperation("workspace", async (operation) => {
      entered.resolve();
      await resume.promise;
      operation.assertCurrent();
      return operation.workspace.rootPath;
    });

    await entered.promise;
    aliasTarget = "canonical-d";
    resume.resolve();

    await expect(running).resolves.toBe("canonical-c");
    await owner.invalidate("workspace");
  });

  it("aborts a held physical operation so retirement can kill and drain its exact work", async () => {
    const test = testOwner({
      workspaceId: "workspace",
      rootPath: "alias",
      label: "A",
    });
    const entered = Promise.withResolvers<void>();
    const childClosed = Promise.withResolvers<void>();
    const killed: symbol[] = [];
    let attachmentId!: symbol;
    const running = test.owner.withOperation("workspace", async (operation) => {
      attachmentId = operation.workspace.attachmentId;
      operation.signal.addEventListener(
        "abort",
        () => {
          killed.push(operation.workspace.attachmentId);
          childClosed.resolve();
        },
        { once: true },
      );
      entered.resolve();
      await childClosed.promise;
    });

    await entered.promise;
    test.replace(null);
    const retiring = test.owner.invalidate("workspace");

    expect(killed).toEqual([attachmentId]);
    await expect(running).rejects.toThrow("retired workspace authority");
    await retiring;
  });

  it("blocks replacement B until held startup work for attachment A drains", async () => {
    const test = testOwner({
      workspaceId: "workspace",
      rootPath: "root-a",
      label: "A",
    });
    const entered = Promise.withResolvers<void>();
    const daemonReady = Promise.withResolvers<void>();
    let attachmentA!: symbol;
    const opening = test.owner.withOperation("workspace", async (operation) => {
      attachmentA = operation.workspace.attachmentId;
      entered.resolve();
      await daemonReady.promise;
    });

    await entered.promise;
    test.replace({ workspaceId: "workspace", rootPath: "root-b", label: "B" });
    const retirement = test.owner.invalidate("workspace");
    expect(() => test.owner.acquire("workspace")).toThrow(
      "retiring or blocked",
    );

    daemonReady.resolve();
    await expect(opening).rejects.toThrow("retired workspace authority");
    await retirement;
    const attachmentB = test.owner.acquire("workspace");
    expect(attachmentB.binding.attachmentId).not.toBe(attachmentA);
    expect(attachmentB.binding.canonicalRootPath).toBe("real:root-b");
    attachmentB.release();
  });

  it("releases the lease when operation construction loses registry currentness", async () => {
    const workspace = {
      workspaceId: "workspace",
      rootPath: "root",
      label: "A",
    };
    let reads = 0;
    const disposeState = vi.fn();
    const owner = createWorkspaceAuthorityOwner({
      findWorkspace: () => (++reads < 3 ? workspace : null),
      canonicalizeRoot: (rootPath) => rootPath,
      createState: () => ({}),
      disposeState,
    });

    await expect(
      owner.withOperation("workspace", async () => undefined),
    ).rejects.toThrow("retired workspace authority");

    await owner.invalidate("workspace");
    expect(disposeState).toHaveBeenCalledOnce();
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
    const retiring = test.owner.retireBinding(lease.binding, { removeBinding });

    await Promise.resolve();
    expect(removeBinding).not.toHaveBeenCalled();
    lease.release();
    await retiring;
    expect(removeBinding).toHaveBeenCalledOnce();
  });

  it("keeps the registry and tombstone until every finalizer finishes", async () => {
    let workspace: Workspace | null = {
      workspaceId: "workspace",
      rootPath: "root",
      label: "old",
    };
    const owner = createWorkspaceAuthorityOwner({
      findWorkspace: () => workspace,
      canonicalizeRoot: (rootPath) => rootPath,
      createState: () => ({}),
    });
    const lease = owner.acquire("workspace");
    const steps: string[] = [];
    let finalizerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      finalizerStarted = resolve;
    });
    let finishRelay!: () => void;
    const relay = new Promise<void>((resolve) => {
      finishRelay = resolve;
    });
    let folderResetStarted!: () => void;
    const folderStarted = new Promise<void>((resolve) => {
      folderResetStarted = resolve;
    });
    let finishFolderReset!: () => void;
    const folderReset = new Promise<void>((resolve) => {
      finishFolderReset = resolve;
    });
    let bindingRemoved!: () => void;
    const removed = new Promise<void>((resolve) => {
      bindingRemoved = resolve;
    });
    let finishRemoval!: () => void;
    const removalFinished = new Promise<void>((resolve) => {
      finishRemoval = resolve;
    });
    const retiring = owner.retireBinding(lease.binding, {
      finalize: async () => {
        steps.push("relay-close");
        finalizerStarted();
        await relay;
        steps.push("folder-reset");
        folderResetStarted();
        await folderReset;
      },
      removeBinding: async () => {
        steps.push("remove-binding");
        workspace = null;
        bindingRemoved();
        await removalFinished;
      },
    });
    lease.release();
    await started;

    const replacement = {
      workspaceId: "workspace",
      rootPath: "root",
      label: "replacement",
    };
    const persist = vi.fn(() => {
      workspace = replacement;
    });
    const rollback = vi.fn(() => {
      workspace = null;
    });
    expect(() =>
      owner.registerBinding(replacement, { persist, rollback }),
    ).toThrow("retiring or blocked");
    expect(persist).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    expect(workspace?.label).toBe("old");
    expect(steps).toEqual(["relay-close"]);

    finishRelay();
    await folderStarted;
    expect(workspace?.label).toBe("old");
    expect(() =>
      owner.registerBinding(replacement, { persist, rollback }),
    ).toThrow("retiring or blocked");
    expect(steps).toEqual(["relay-close", "folder-reset"]);

    finishFolderReset();
    await removed;
    expect(workspace).toBeNull();
    expect(() =>
      owner.registerBinding(replacement, { persist, rollback }),
    ).toThrow("retiring or blocked");
    expect(persist).not.toHaveBeenCalled();
    expect(steps).toEqual([
      "relay-close",
      "folder-reset",
      "remove-binding",
    ]);

    finishRemoval();
    await retiring;
    expect(workspace).toBeNull();
    const next = owner.registerBinding(replacement, { persist, rollback });
    expect(next.attachmentId).not.toBe(lease.binding.attachmentId);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("holds an exact id and canonical root reservation through async cleanup", async () => {
    const registry = new Map<string, Workspace>();
    const canonicalizeRoot = vi.fn((rootPath: string) =>
      rootPath.startsWith("alias-") ? "real:shared" : `real:${rootPath}`,
    );
    const owner = createWorkspaceAuthorityOwner({
      findWorkspace: (workspaceId) => registry.get(workspaceId) ?? null,
      canonicalizeRoot,
      createState: () => ({}),
    });
    const reservation = owner.reserveBinding({
      workspaceId: "workspace",
      rootPath: "alias-a",
    });
    const persist = vi.fn();
    const rollback = vi.fn();

    expect(() =>
      owner.registerBinding(
        { workspaceId: "workspace", rootPath: "other", label: "duplicate" },
        { persist, rollback },
      ),
    ).toThrow("retiring or blocked");
    expect(() =>
      owner.registerBinding(
        { workspaceId: "other", rootPath: "alias-b", label: "alias" },
        { persist, rollback },
      ),
    ).toThrow("blocked by failed cleanup");
    expect(persist).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();

    let cleanupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    let finishCleanup!: () => void;
    const finish = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const releasing = owner.releaseReservation(reservation, async () => {
      cleanupStarted();
      await finish;
    });
    await started;

    registry.set("workspace", {
      workspaceId: "workspace",
      rootPath: "alias-a",
      label: "same-id successor",
    });
    expect(() => owner.acquire("workspace")).toThrow("retiring or blocked");
    registry.delete("workspace");
    registry.set("other", {
      workspaceId: "other",
      rootPath: "alias-b",
      label: "canonical alias successor",
    });
    expect(() => owner.acquire("other")).toThrow("blocked by failed cleanup");
    registry.delete("other");

    finishCleanup();
    await releasing;
    registry.set("other", {
      workspaceId: "other",
      rootPath: "alias-b",
      label: "admitted after cleanup",
    });
    const lease = owner.acquire("other");
    expect(lease.binding.canonicalRootPath).toBe("real:shared");
    lease.release();
  });

  it("keeps a reservation when exact registration rollback leaves a row", async () => {
    let workspace: Workspace | null = null;
    const cleanup = vi.fn();
    const owner = createWorkspaceAuthorityOwner({
      findWorkspace: () => workspace,
      canonicalizeRoot: (rootPath) => `real:${rootPath}`,
      createState: () => {
        throw new Error("state admission failed");
      },
    });
    const attempted = {
      workspaceId: "workspace",
      rootPath: "root",
      label: "attempted",
    };
    const reservation = owner.reserveBinding(attempted);

    expect(() =>
      owner.registerReservedBinding(reservation, attempted, {
        persist: () => {
          workspace = attempted;
        },
        rollback: () => undefined,
      }),
    ).toThrow("could not be rolled back");
    await expect(
      owner.releaseReservation(reservation, cleanup),
    ).rejects.toThrow("registry binding remains");
    expect(cleanup).not.toHaveBeenCalled();
    expect(() => owner.acquire("workspace")).toThrow("retiring or blocked");
    expect(workspace).toBe(attempted);
  });

  it("commits a reservation without resolving its canonical root again", () => {
    let workspace: Workspace | null = null;
    const canonicalizeRoot = vi.fn((rootPath: string) => `real:${rootPath}`);
    const owner = createWorkspaceAuthorityOwner({
      findWorkspace: () => workspace,
      canonicalizeRoot,
      createState: () => ({}),
    });
    const registered = {
      workspaceId: "workspace",
      rootPath: "root",
      label: "registered",
    };
    const reservation = owner.reserveBinding(registered);
    const binding = owner.registerReservedBinding(reservation, registered, {
      persist: () => {
        workspace = registered;
      },
      rollback: () => {
        workspace = null;
      },
    });

    expect(binding.canonicalRootPath).toBe("real:root");
    expect(canonicalizeRoot).toHaveBeenCalledOnce();
    const lease = owner.acquireBinding(binding);
    lease.release();
  });

  it("does not close while reserved-workspace cleanup is running", async () => {
    const owner = createWorkspaceAuthorityOwner({
      findWorkspace: () => null,
      canonicalizeRoot: (rootPath) => `real:${rootPath}`,
      createState: () => ({}),
    });
    const reservation = owner.reserveBinding({
      workspaceId: "workspace",
      rootPath: "root",
    });
    let cleanupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    let finishCleanup!: () => void;
    const finish = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const releasing = owner.releaseReservation(reservation, async () => {
      cleanupStarted();
      await finish;
    });
    await started;
    let closed = false;
    const closing = owner.close().then(() => {
      closed = true;
    });

    await Promise.resolve();
    expect(closed).toBe(false);
    finishCleanup();
    await Promise.all([releasing, closing]);
    expect(closed).toBe(true);
  });

  it("keeps the id and canonical-root tombstone when reservation cleanup fails", async () => {
    const owner = createWorkspaceAuthorityOwner({
      findWorkspace: () => null,
      canonicalizeRoot: () => "real:shared",
      createState: () => ({}),
    });
    const reservation = owner.reserveBinding({
      workspaceId: "workspace",
      rootPath: "alias-a",
    });

    await expect(
      owner.releaseReservation(reservation, async () => {
        throw new Error("relay close failed");
      }),
    ).rejects.toThrow("relay close failed");
    expect(() =>
      owner.reserveBinding({ workspaceId: "workspace", rootPath: "other" }),
    ).toThrow("retiring or blocked");
    expect(() =>
      owner.reserveBinding({ workspaceId: "other", rootPath: "alias-b" }),
    ).toThrow("blocked by failed cleanup");
  });

  it("rolls back the just-persisted row when state admission fails", () => {
    let workspace: Workspace | null = null;
    let failStateCreation = true;
    const owner = createWorkspaceAuthorityOwner({
      findWorkspace: () => workspace,
      canonicalizeRoot: (rootPath) => rootPath,
      createState: () => {
        if (failStateCreation) throw new Error("state admission failed");
        return {};
      },
    });
    const registered = {
      workspaceId: "workspace",
      rootPath: "root",
      label: "registered",
    };
    const persist = vi.fn(() => {
      workspace = registered;
    });
    const rollback = vi.fn(() => {
      if (workspace?.rootPath !== registered.rootPath) {
        throw new Error("registration changed");
      }
      workspace = null;
    });

    expect(() =>
      owner.registerBinding(registered, { persist, rollback }),
    ).toThrow("state admission failed");
    expect(workspace).toBeNull();
    expect(persist).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();

    failStateCreation = false;
    expect(
      owner.registerBinding(registered, { persist, rollback }).workspaceId,
    ).toBe("workspace");
  });

  it("blocks lazy admission when registration rollback fails", () => {
    let workspace: Workspace | null = null;
    const owner = createWorkspaceAuthorityOwner({
      findWorkspace: () => workspace,
      canonicalizeRoot: (rootPath) => rootPath,
      createState: () => {
        throw new Error("state admission failed");
      },
    });
    const registered = {
      workspaceId: "workspace",
      rootPath: "root",
      label: "registered",
    };

    expect(() =>
      owner.registerBinding(registered, {
        persist: () => {
          workspace = registered;
        },
        rollback: () => {
          throw new Error("registry rollback failed");
        },
      }),
    ).toThrow("could not be rolled back");
    expect(workspace).toEqual(registered);
    expect(() => owner.acquire("workspace")).toThrow("retiring or blocked");
  });

  it("preserves a successor row and blocks admission when rollback loses its compare-and-remove", () => {
    let workspace: Workspace | null = null;
    const attempted = {
      workspaceId: "workspace",
      rootPath: "attempted-root",
      label: "attempted",
    };
    const successor = {
      workspaceId: "workspace",
      rootPath: "successor-root",
      label: "successor",
    };
    const owner = createWorkspaceAuthorityOwner({
      findWorkspace: () => workspace,
      canonicalizeRoot: (rootPath) => rootPath,
      createState: () => {
        workspace = successor;
        throw new Error("state admission failed");
      },
    });

    expect(() =>
      owner.registerBinding(attempted, {
        persist: () => {
          workspace = attempted;
        },
        rollback: () => {
          if (workspace !== attempted) {
            throw new Error("registry binding changed");
          }
          workspace = null;
        },
      }),
    ).toThrow("could not be rolled back");
    expect(workspace).toBe(successor);
    expect(() => owner.acquire("workspace")).toThrow("retiring or blocked");
  });

  it("detects a no-op registration rollback and keeps a tombstone", () => {
    let workspace: Workspace | null = null;
    const attempted = {
      workspaceId: "workspace",
      rootPath: "root",
      label: "attempted",
    };
    const owner = createWorkspaceAuthorityOwner({
      findWorkspace: () => workspace,
      canonicalizeRoot: (rootPath) => rootPath,
      createState: () => {
        throw new Error("state admission failed");
      },
    });

    expect(() =>
      owner.registerBinding(attempted, {
        persist: () => {
          workspace = attempted;
        },
        rollback: () => undefined,
      }),
    ).toThrow("could not be rolled back");
    expect(workspace).toBe(attempted);
    expect(() => owner.acquire("workspace")).toThrow("retiring or blocked");
  });

  it("refuses an existing workspace id before persistence", () => {
    const existing = {
      workspaceId: "workspace",
      rootPath: "existing-root",
      label: "existing",
    };
    const test = testOwner(existing);
    const persist = vi.fn();
    const rollback = vi.fn();

    expect(() =>
      test.owner.registerBinding(
        { ...existing, rootPath: "replacement-root" },
        { persist, rollback },
      ),
    ).toThrow("already registered");
    expect(persist).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    const lease = test.owner.acquire("workspace");
    expect(lease.binding.registeredRootPath).toBe("existing-root");
    lease.release();
  });

  it("disposes with current metadata for the same exact registry binding", async () => {
    let workspace: Workspace | null = {
      workspaceId: "workspace",
      rootPath: "root",
      label: "initial",
    };
    const disposedWith: Readonly<Workspace>[] = [];
    const owner = createWorkspaceAuthorityOwner({
      findWorkspace: () => workspace,
      canonicalizeRoot: (rootPath) => rootPath,
      createState: () => ({}),
      disposeState: (_state, _binding, workspaceAtDisposal) => {
        disposedWith.push(workspaceAtDisposal);
      },
    });
    const lease = owner.acquire("workspace");
    workspace = { ...workspace, label: "updated" };
    const retiring = owner.retireBinding(lease.binding, {
      removeBinding: () => {
        workspace = null;
      },
    });
    lease.release();

    await retiring;
    expect(disposedWith).toEqual([
      { workspaceId: "workspace", rootPath: "root", label: "updated" },
    ]);
    expect(Object.isFrozen(disposedWith[0])).toBe(true);
  });

  it("lists only attachments that still admit work", async () => {
    const test = testOwner({
      workspaceId: "workspace",
      rootPath: "root",
      label: "A",
    });
    const lease = test.owner.acquire("workspace");
    expect(test.owner.workspaceIds()).toEqual(["workspace"]);

    const retiring = test.owner.retireBinding(lease.binding, {
      removeBinding: () => undefined,
    });
    expect(test.owner.workspaceIds()).toEqual([]);
    lease.release();
    await retiring;
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
