import { expect, it, vi } from "vitest";
import { createPhysicalWorkspaceRemoval, createWorkspaceForget } from "./physicalWorkspaceRemoval";
import { createWorkspaceAuthorityOwner } from "./workspaceAuthorityOwner";
import { createJoinedWorkspaceRunner } from "./createJoinedWorkspace";
import type { RegistryEntry } from "./registryStore";

function harness(registeredInitially = true, confirmDraftRemoval?: (workspaceId: string) => Promise<boolean>) {
  const workspace: RegistryEntry = {workspaceId: "workspace", rootPath: "root", kind: "personal", mode: "local-first"};
  let registered: RegistryEntry | null = registeredInitially ? workspace : null;
  const owner = createWorkspaceAuthorityOwner({
    findWorkspace: () => registered,
    canonicalizeRoot: path => path,
    createState: () => ({}),
  });
  const removeWorkspace = vi.fn(() => { registered = null; });
  const removeDrafts = vi.fn(async (_workspaceId: string) => {});
  const onError = vi.fn();
  const clearNotices = vi.fn();
  const notifyRenderer = vi.fn();
  const remove = createPhysicalWorkspaceRemoval({
    retireBinding: (binding, retirement) => owner.retireBinding(binding, retirement),
    findWorkspace: () => registered,
    removeWorkspace, removeDrafts, onError, confirmDraftRemoval,
  });
  const forget = createWorkspaceForget({
    remove: workspaceId => remove(owner.currentBinding(workspaceId)),
    clearNotices, notifyRenderer,
  });
  return {
    workspace, owner, remove, forget, removeWorkspace, removeDrafts, onError, clearNotices, notifyRenderer,
    current: () => registered,
    setRegistered: (next: RegistryEntry | null) => { registered = next; },
  };
}

it.each(["EPERM", "EBUSY"])("Forget resolves and notifies the renderer when draft cleanup fails with %s", async code => {
  const h = harness();
  const error = Object.assign(new Error("recovery record is busy"), {code});
  h.removeDrafts.mockRejectedValueOnce(error);
  await expect(h.forget(h.workspace.workspaceId)).resolves.toBeUndefined();
  expect(h.current()).toBeNull();
  expect(h.owner.workspaceIds()).toEqual([]);
  expect(h.clearNotices).toHaveBeenCalledExactlyOnceWith(h.workspace.workspaceId);
  expect(h.notifyRenderer).toHaveBeenCalledOnce();
  expect(h.onError).toHaveBeenCalledExactlyOnceWith(h.workspace.workspaceId, error);
});

it("still rejects registry removal failures and does not report them as draft cleanup failures", async () => {
  const h = harness();
  const error = new Error("registry removal refused");
  h.removeWorkspace.mockImplementationOnce(() => { throw error; });
  await expect(h.forget(h.workspace.workspaceId)).rejects.toBe(error);
  expect(h.current()).toEqual(h.workspace);
  expect(h.removeDrafts).not.toHaveBeenCalled();
  expect(h.onError).not.toHaveBeenCalled();
  expect(h.clearNotices).not.toHaveBeenCalled();
  expect(h.notifyRenderer).not.toHaveBeenCalled();
});

it("reports a draft cleanup failure during failed-join rollback without replacing the original failure or skipping notification", async () => {
  const h = harness(false);
  const cleanupError = Object.assign(new Error("recovery record is busy"), {code: "EPERM"});
  const joinError = new Error("join failed");
  h.removeDrafts.mockRejectedValueOnce(cleanupError);
  const logError = vi.fn();
  const run = createJoinedWorkspaceRunner({
    canonicalizeRoot: root => root,
    reserve: input => h.owner.reserveBinding(input),
    createFolder: async () => h.workspace,
    register: (reservation, workspace) => h.owner.registerReservedBinding(reservation, workspace, {
      persist: () => h.setRegistered(workspace),
      rollback: () => h.setRegistered(null),
    }),
    remove: async(binding,cleanup)=>{await h.remove(binding,cleanup);},
    release: (reservation, finalize) => h.owner.releaseReservation(reservation, finalize),
    closeRelay: vi.fn(async () => {}),
    rollbackComplete: h.notifyRenderer,
    logError,
  });
  await expect(run({
    workspaceId: h.workspace.workspaceId, rootPath: h.workspace.rootPath,
    populate: async () => { throw joinError; },
    rollbackLabel: "join", cleanupFailureMessage: "rollback failed",
    failure: () => joinError,
  })).rejects.toBe(joinError);
  expect(h.current()).toBeNull();
  expect(h.notifyRenderer).toHaveBeenCalledOnce();
  expect(h.onError).toHaveBeenCalledExactlyOnceWith(h.workspace.workspaceId, cleanupError);
  expect(logError).toHaveBeenCalledOnce();
  expect(logError.mock.calls[0]?.[1]).toBe(joinError);
});

it("warns before removing unresolved typing and leaves its registry and copies when cancelled", async () => {
 const confirm = vi.fn(async () => false); const h = harness(true, confirm);
 await expect(h.forget("workspace")).resolves.toBeUndefined();
 expect(h.clearNotices).not.toHaveBeenCalled();expect(h.notifyRenderer).not.toHaveBeenCalled();expect(h.onError).not.toHaveBeenCalled();
 expect(confirm).toHaveBeenCalledExactlyOnceWith("workspace"); expect(h.removeWorkspace).not.toHaveBeenCalled(); expect(h.removeDrafts).not.toHaveBeenCalled(); expect(h.current()).toEqual(h.workspace);
});
