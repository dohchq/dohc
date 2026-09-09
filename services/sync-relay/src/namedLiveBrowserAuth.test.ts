import { describe, expect, it, vi } from "vitest";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import { createNamedLiveBrowserResolver } from "./namedLiveBrowserAuth";
import type { SyncRelayShareGrantRow, SyncRelayShareRow } from "./storage";

const scope = { workspaceId: "workspace", shareId: "share", grantId: "alice-edit" };
const share: SyncRelayShareRow = {
  shareId: scope.shareId, workspaceId: scope.workspaceId, granterUserId: "owner",
  selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }), createdAtMs: 1,
};
const grant: SyncRelayShareGrantRow = {
  grantId: scope.grantId, shareId: scope.shareId, principalKind: "user",
  principalUserId: "alice", principalEmail: null, access: "edit", generation: 1,
  status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null,
};

function fixture(resolveActor: ResolveActor = async (_request, workspaceId) => ({ userId: "alice", workspaceId })) {
  const currentShare = { ...share };
  const currentGrant = { ...grant };
  const storage = {
    getShare: (id: string) => id === currentShare.shareId ? currentShare : null,
    getShareGrant: vi.fn((id: string) => id === currentGrant.grantId ? currentGrant : null),
    workspaceIsOwnedBy: () => true,
    findChannelCreateKind: () => null,
  };
  return { currentShare, currentGrant, storage, resolve: createNamedLiveBrowserResolver({ storage, resolveActor }) };
}

function request() {
  return new Request("https://share.example.test/api/live/ticket?grantId=bob-edit", {
    method: "POST",
    headers: { cookie: "session=alice", authorization: "Bearer bob", "x-user-id": "bob", "content-type": "application/json" },
    body: JSON.stringify({ objectId: "doc", userId: "bob", grantId: "bob-edit" }),
  });
}

describe("named live browser authentication", () => {
  it("binds the validated cookie account to the exact trusted grant without consuming the browser body", async () => {
    const resolveActor = vi.fn<ResolveActor>(async (incoming, workspaceId) => {
      expect([...incoming.headers]).toEqual([["cookie", "session=alice"]]);
      return { userId: "alice", workspaceId };
    });
    const { resolve, storage } = fixture(resolveActor);
    const incoming = request();
    expect(await resolve(incoming, scope)).toEqual({ kind: "named", userId: "alice", ...scope });
    expect(incoming.bodyUsed).toBe(false);
    expect(storage.getShareGrant).toHaveBeenCalledWith(scope.grantId);
  });

  it("refuses a different account and never selects an alternative grant", async () => {
    const { resolve } = fixture(async (_request, workspaceId) => ({ userId: "bob", workspaceId }));
    expect(await resolve(request(), scope)).toBeNull();
  });

  it("refuses absent sessions while preserving authentication infrastructure errors", async () => {
    const absent = fixture(async () => { throw new UnauthorizedError(); });
    expect(await absent.resolve(request(), scope)).toBeNull();
    expect(absent.storage.getShareGrant).not.toHaveBeenCalled();
    const failure = new Error("auth database unavailable");
    await expect(fixture(async () => { throw failure; }).resolve(request(), scope)).rejects.toBe(failure);
  });

  it.each([
    { workspaceId: "other" }, { shareId: "other" }, { grantId: "other" },
  ])("refuses mismatched trusted route scope %j", async (changed) => {
    expect(await fixture().resolve(request(), { ...scope, ...changed })).toBeNull();
  });

  it("reads grant standing after the asynchronous session lookup", async () => {
    const state = fixture(async (_request, workspaceId) => {
      state.currentGrant.status = "revoked";
      return { userId: "alice", workspaceId };
    });
    expect(await state.resolve(request(), scope)).toBeNull();
  });

  it("captures trusted route coordinates before asynchronous authentication", async () => {
    const mutableScope = { ...scope };
    const state = fixture(async (_request, workspaceId) => {
      mutableScope.grantId = "other";
      return { userId: "alice", workspaceId };
    });
    expect(await state.resolve(request(), mutableScope)).toEqual({ kind: "named", userId: "alice", ...scope });
  });

  it.each(["view", "comment"])("refuses %s grants", async (access) => {
    const state = fixture();
    state.currentGrant.access = access;
    expect(await state.resolve(request(), scope)).toBeNull();
  });

  it("refuses a resolver actor from a different workspace", async () => {
    const state = fixture(async () => ({ userId: "alice", workspaceId: "other" }));
    expect(await state.resolve(request(), scope)).toBeNull();
  });

  it("refuses a link Edit grant", async () => {
    const state = fixture();
    state.currentGrant.principalKind = "link";
    state.currentGrant.principalUserId = null;
    expect(await state.resolve(request(), scope)).toBeNull();
  });
});
