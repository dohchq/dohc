import { describe, expect, it, vi } from "vitest";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createJoinedWorkspaceRunner } from "./createJoinedWorkspace";
import { createWorkspaceFolder } from "./createWorkspaceFolder";
import { createWorkspaceAuthorityOwner } from "./workspaceAuthorityOwner";
import { createTestScratch } from "./testTemp";
import type { RegistryEntry } from "./registryStore";

function harness(rootPath = "/joined") {
  const registry = new Map<string, RegistryEntry>();
  const authorities = createWorkspaceAuthorityOwner<RegistryEntry, object>({
    findWorkspace: (id) => registry.get(id) ?? null,
    canonicalizeRoot: (path) => path,
    createState: () => ({}),
  });
  const events: string[] = [];
  const workspace: RegistryEntry = {
    workspaceId: "joined",
    rootPath,
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
    closeRelay: cleanup,
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
  it("preserves existing files when folder creation fails before the join owns anything", async () => {
    const root = await createTestScratch("dohc-join-preserve-");
    const h = harness(root);
    await writeFile(join(root, "local-work.md"), "work from another tool");
    h.createFolder.mockRejectedValue(new Error("manifest creation failed"));

    await expect(h.run(h.input)).rejects.toThrow("download failed");

    expect(await readdir(root)).toEqual(["local-work.md"]);
    expect(await readFile(join(root, "local-work.md"), "utf8")).toBe("work from another tool");
    expect(h.registry.size).toBe(0);
    expect(h.cleanup).toHaveBeenCalledWith("joined");
  });

  it.each(["prepare", "populate"] as const)("preserves files added during %s and permits retry in another empty folder", async (phase) => {
    const root = await createTestScratch("dohc-join-preserve-");
    const h = harness(root);
    h.createFolder.mockImplementation(() => createWorkspaceFolder({
      rootPath: h.workspace.rootPath,
      workspaceId: h.workspace.workspaceId,
      kind: "personal",
    }));
    const entered = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    const fail = async () => {
      entered.resolve();
      await resumed.promise;
      throw new Error("download interrupted");
    };
    const result = h.run({ ...h.input, [phase]: fail });
    const refusal = expect(result).rejects.toThrow("download failed");
    await entered.promise;
    const manifest = await readFile(join(root, ".dohc", "manifest.json"), "utf8");
    await writeFile(join(root, "local-work.md"), "unsynced local work");
    await writeFile(join(root, "partial.md"), "downloaded before interruption");
    resumed.resolve();
    await refusal;

    expect(await readFile(join(root, "local-work.md"), "utf8")).toBe("unsynced local work");
    expect(await readFile(join(root, "partial.md"), "utf8")).toBe("downloaded before interruption");
    expect(await readFile(join(root, ".dohc", "manifest.json"), "utf8")).toBe(manifest);
    expect(h.registry.size).toBe(0);
    expect(h.cleanup).toHaveBeenCalledWith("joined");

    const retryRoot = await createTestScratch("dohc-join-retry-");
    h.workspace.rootPath = retryRoot;
    await expect(h.run({ ...h.input, rootPath: retryRoot })).resolves.toMatchObject({ rootPath: retryRoot });
    expect(h.registry.get("joined")?.rootPath).toBe(retryRoot);
    expect(await readFile(join(root, "local-work.md"), "utf8")).toBe("unsynced local work");
  });

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

  it("retires a registered workspace and closes its relay before removing the registry entry", async () => {
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
