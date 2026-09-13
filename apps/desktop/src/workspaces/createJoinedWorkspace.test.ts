import { describe, expect, it, vi } from "vitest";
import { createJoinedWorkspaceRunner } from "./createJoinedWorkspace";
import { createWorkspaceAuthorityOwner } from "./workspaceAuthorityOwner";
import type { RegistryEntry } from "./registryStore";

function harness() {
  const registry = new Map<string, RegistryEntry>();
  const authorities = createWorkspaceAuthorityOwner<RegistryEntry, object>({
    findWorkspace: (id) => registry.get(id) ?? null,
    canonicalizeRoot: (path) => path,
    createState: () => ({}),
  });
  const events: string[] = [];
  const workspace: RegistryEntry = {
    workspaceId: "joined",
    rootPath: "/joined",
    kind: "personal",
    mode: "local-first",
  };
  const createFolder = vi.fn(async () => {
    events.push("create");
    return workspace;
  });
  const cleanup = vi.fn(async () => {
    events.push("cleanup");
  });
  const rollbackComplete = vi.fn(() => {
    events.push("notify");
  });
  const run = createJoinedWorkspaceRunner({
    reserve: (input) => authorities.reserveBinding(input),
    createFolder,
    register: (reservation, entry) => {
      events.push("register");
      return authorities.registerReservedBinding(reservation, entry, {
        persist: () => {
          registry.set(entry.workspaceId, entry);
        },
        rollback: () => {
          registry.delete(entry.workspaceId);
        },
      });
    },
    remove: (binding, finalize) =>
      authorities.retireBinding(binding, {
        finalize,
        removeBinding: () => {
          events.push("remove");
          registry.delete(binding.workspaceId);
        },
      }),
    release: (reservation, finalize) =>
      authorities.releaseReservation(reservation, finalize),
    cleanup,
    rollbackComplete,
    logError: vi.fn(),
  });
  const input = {
    ...workspace,
    populate: vi.fn(async () => {
      events.push("populate");
    }),
    rollbackLabel: "join",
    cleanupFailureMessage: "cleanup failed",
    failure: () => new Error("download failed"),
  };
  return {
    run,
    input,
    workspace,
    registry,
    events,
    createFolder,
    cleanup,
    rollbackComplete,
    authorities,
  };
}

describe("joined workspace creation", () => {
  it("prepares identity before registration and starts population afterward", async () => {
    const h = harness();
    await expect(
      h.run({
        ...h.input,
        prepare: async (created) => {
          expect(h.registry.size).toBe(0);
          h.events.push("prepare");
          return { ...created, joinBootstrapPending: true };
        },
      }),
    ).resolves.toBe(h.workspace);
    expect(h.events).toEqual(["create", "prepare", "register", "populate"]);
    expect(h.registry.get("joined")?.joinBootstrapPending).toBe(true);
    expect(h.createFolder).toHaveBeenCalledWith({
      rootPath: "/joined",
      workspaceId: "joined",
      kind: "personal",
    });
  });

  it("releases a failed preparation reservation and permits a retry", async () => {
    const h = harness();
    await expect(
      h.run({
        ...h.input,
        prepare: async () => {
          throw new Error("bootstrap failed");
        },
      }),
    ).rejects.toThrow("download failed");
    expect(h.registry.size).toBe(0);
    expect(h.input.populate).not.toHaveBeenCalled();
    expect(h.events).toEqual(["create", "cleanup", "notify"]);
    await expect(h.run(h.input)).resolves.toBe(h.workspace);
  });

  it("retires a registered workspace and cleans its files before removing the registry entry", async () => {
    const h = harness();
    h.input.populate.mockRejectedValue(new Error("first pull failed"));
    h.cleanup.mockImplementation(async () => {
      expect(h.registry.has("joined")).toBe(true);
      h.events.push("cleanup");
    });
    await expect(h.run(h.input)).rejects.toThrow("download failed");
    expect(h.events).toEqual([
      "create",
      "register",
      "cleanup",
      "remove",
      "notify",
    ]);
    expect(h.registry.size).toBe(0);
  });

  it("retains the registry and blocks reuse when cleanup fails", async () => {
    const h = harness();
    h.input.populate.mockRejectedValue(new Error("first pull failed"));
    h.cleanup.mockRejectedValue(new Error("folder in use"));
    await expect(h.run(h.input)).rejects.toThrow("cleanup failed");
    expect(h.registry.has("joined")).toBe(true);
    expect(h.rollbackComplete).not.toHaveBeenCalled();
    await expect(h.run(h.input)).rejects.toThrow();
    expect(h.createFolder).toHaveBeenCalledTimes(1);
  });

  it("does not create files if the workspace identity is already reserved", async () => {
    const h = harness();
    h.authorities.reserveBinding(h.workspace);
    await expect(h.run(h.input)).rejects.toThrow();
    expect(h.createFolder).not.toHaveBeenCalled();
    expect(h.cleanup).not.toHaveBeenCalled();
  });
});
