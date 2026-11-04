import { expect, it, vi } from "vitest";
import { createPhysicalWorkspaceRemoval, createWorkspaceForget } from "./physicalWorkspaceRemoval";
import { createWorkspaceAuthorityOwner } from "./workspaceAuthorityOwner";
import { createJoinedWorkspaceRunner } from "./createJoinedWorkspace";
import type { RegistryEntry } from "./registryStore";
import { createWorkspaceTrust } from "./workspaceTrust";

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
  // The real trust store, with its file kept in memory.
  const files = new Map<string, string>();
  const writeText = vi.fn(async (file: string, text: string) => { files.set(file, text); });
  const trust = createWorkspaceTrust({
    file: "workspace-trust.json",
    identify: async () => "folder",
    readText: async file => {
      const text = files.get(file);
      if (text === undefined) throw Object.assign(new Error("no trust file"), {code: "ENOENT"});
      return text;
    },
    writeText: (file, text) => writeText(file, text),
  });
  const restrict = vi.spyOn(trust, "restrict");
  const forget = createWorkspaceForget({
    currentBinding: workspaceId => owner.currentBinding(workspaceId),
    removePhysicalWorkspace: remove,
    trust, clearNotices, notifyRenderer,
  });
  return {
    workspace, owner, remove, forget, removeWorkspace, removeDrafts, onError, trust, restrict, writeText, files,
    clearNotices, notifyRenderer,
    trustIt: () => trust.trust(workspace, {folder: "folder"}),
    grants: () => (JSON.parse(files.get("workspace-trust.json") ?? '{"trusted":[]}') as {trusted: {workspaceId: string}[]})
      .trusted.map(grant => grant.workspaceId),
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

it("warns before removing unresolved typing and leaves its trust, registry and copies when cancelled", async () => {
 const confirm = vi.fn(async () => false); const h = harness(true, confirm);
 await h.trustIt();
 await expect(h.forget("workspace")).resolves.toBeUndefined();
 expect(h.restrict).not.toHaveBeenCalled(); expect(h.grants()).toEqual(["workspace"]); expect(await h.trust.isTrusted(h.workspace)).toBe(true);
 expect(h.clearNotices).not.toHaveBeenCalled();expect(h.notifyRenderer).not.toHaveBeenCalled();expect(h.onError).not.toHaveBeenCalled();
 expect(confirm).toHaveBeenCalledExactlyOnceWith("workspace"); expect(h.removeWorkspace).not.toHaveBeenCalled(); expect(h.removeDrafts).not.toHaveBeenCalled(); expect(h.current()).toEqual(h.workspace);
});

it("restricts a forgotten workspace after its typing question and while it is still open, and a failed restrict removes nothing", async () => {
  const confirm = vi.fn(async () => true);
  const h = harness(true, confirm);
  await h.trustIt();
  const error = new Error("trust file is busy");
  h.writeText.mockImplementationOnce(async () => {
    h.owner.acquire("workspace").release();
    throw error;
  });
  await expect(h.forget("workspace")).rejects.toBe(error);
  expect(h.grants()).toEqual(["workspace"]);
  expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(h.restrict.mock.invocationCallOrder[0]!);
  expect(h.current()).toEqual(h.workspace);
  expect(h.owner.workspaceIds()).toEqual(["workspace"]);
  expect(h.removeWorkspace).not.toHaveBeenCalled();
  expect(h.removeDrafts).not.toHaveBeenCalled();
  expect(h.clearNotices).not.toHaveBeenCalled();
  expect(h.notifyRenderer).not.toHaveBeenCalled();

  await h.forget("workspace");
  expect(h.restrict).toHaveBeenCalledTimes(3);
  expect(h.restrict.mock.invocationCallOrder[1]).toBeLessThan(h.removeWorkspace.mock.invocationCallOrder[0]!);
  expect(h.restrict.mock.invocationCallOrder[2]).toBeLessThan(h.removeWorkspace.mock.invocationCallOrder[0]!);
  expect(h.current()).toBeNull();
  expect(h.grants()).toEqual([]);
  expect(h.clearNotices).toHaveBeenCalledExactlyOnceWith("workspace");
});

it("leaves no grant behind when a Trust is given during the typing question", async () => {
  let answer!: (forget: boolean) => void;
  const confirm = vi.fn(() => new Promise<boolean>(resolve => { answer = resolve; }));
  const h = harness(true, confirm);
  const forgetting = h.forget("workspace");
  expect(confirm).toHaveBeenCalledOnce();
  expect(await h.trustIt()).toBe(true);
  answer(true);
  await forgetting;
  expect(h.grants()).toEqual([]);
  expect(h.current()).toBeNull();
});

it("leaves no grant behind when a Trust is given while Forget runs", async () => {
  const h = harness(true, vi.fn(async () => true));
  await h.trustIt();
  let late: Promise<boolean> | undefined;
  h.writeText.mockImplementationOnce(async (file, text) => {
    // Another window's Trust holds the workspace until it is written.
    late = h.owner.withAuthority("workspace", () => h.trustIt());
    h.files.set(file, text);
  });
  await h.forget("workspace");
  expect(await late).toBe(true);
  expect(h.grants()).toEqual([]);
  expect(h.trust.isRevoked("workspace")).toBe(true);
  expect(await h.trust.isTrusted(h.workspace)).toBe(false);
  expect(h.current()).toBeNull();
});

it("keeps the workspace listed when the restrict after it closes fails", async () => {
  const h = harness(true, vi.fn(async () => true));
  await h.trustIt();
  const error = new Error("trust file is busy");
  let late: Promise<boolean> | undefined;
  h.writeText
    .mockImplementationOnce(async (file, text) => {
      late = h.owner.withAuthority("workspace", () => h.trustIt());
      h.files.set(file, text);
    })
    .mockImplementationOnce(async (file, text) => { h.files.set(file, text); })
    .mockImplementationOnce(async () => { throw error; });
  await expect(h.forget("workspace")).rejects.toBe(error);
  expect(await late).toBe(true);
  expect(h.trust.isRevoked("workspace")).toBe(true);
  expect(h.grants()).toEqual(["workspace"]);
  expect(h.current()).toEqual(h.workspace);
  expect(h.removeWorkspace).not.toHaveBeenCalled();
  expect(h.clearNotices).not.toHaveBeenCalled();
});

it("leaves no grant behind when another window's Restrict fails while Forget runs", async () => {
  const h = harness(true, vi.fn(async () => true));
  await h.trustIt();
  const error = new Error("trust file is busy");
  let late: Promise<boolean> | undefined;
  let restricted: Promise<unknown> | undefined;
  h.writeText
    .mockImplementationOnce(async (file, text) => {
      late = h.owner.withAuthority("workspace", () => h.trustIt());
      h.files.set(file, text);
    })
    .mockImplementationOnce(async (file, text) => {
      // Another window restricts while that Trust writes, and its own write fails.
      restricted = h.trust.restrict("workspace").catch((failure: unknown) => failure);
      h.files.set(file, text);
    })
    .mockImplementationOnce(async () => { throw error; });
  await h.forget("workspace");
  expect(await late).toBe(false);
  expect(await restricted).toBe(error);
  expect(h.grants()).toEqual([]);
  expect(h.current()).toBeNull();
});
