import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { createRegistryStore, type RegistryEntry } from "../workspaces/registryStore";
import { createTestScratch } from "../workspaces/testTemp";
import {
  createShareRosters,
  listRosterGrants,
  reachRosterFor,
  rosterGrantsFrom,
  SHARE_ROSTER_FRESH_MS,
  SHARE_ROSTER_REFRESH_MS,
  type RosterGrant,
} from "./shareRoster";

const WORKSPACE = "ws-trip";
const remote = { serverUrl: "https://server.dohc.test", ownerUserId: "u-owner" };

function row(overrides: Record<string, unknown> = {}) {
  return {
    shareId: "s-1", workspaceId: WORKSPACE, grantId: "g-1", principalKind: "user", generation: 1,
    recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", createdAtMs: 1, revokedAtMs: null,
    selector: { paths: ["Trip"], versionId: null }, access: "edit", ...overrides,
  };
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    status: "active", selector: { paths: ["Trip"], versionId: null },
    dependents: [{ grantId: "g-dep", recipientUserId: "u-ben", recipientEmail: "ben@dohc.test", access: "edit", generation: 1, createdAtMs: 1 }],
    ...overrides,
  };
}

const ana: RosterGrant = {
  grantId: "g-1", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test",
  files: { paths: ["Trip"], versionId: null, access: "edit" }, channel: null,
};

describe("roster from the relay's listings", () => {
  it("keeps the owner's active grants on this workspace", () => {
    const grants = rosterGrantsFrom(WORKSPACE, {
      ok: true,
      granted: [
        row({ grantId: "g-5" }),
        row({ grantId: "g-other", workspaceId: "ws-other" }),
        row({ grantId: "g-revoked", revokedAtMs: 9 }),
        row({ grantId: "g-link", principalKind: "link", recipientUserId: null, recipientEmail: null }),
        row({ grantId: "g-4", principalKind: "email", recipientUserId: null, recipientEmail: "cai@dohc.test", access: "view" }),
        row({ grantId: "g-3", selector: { kind: "group", channelWireId: "wire-trip", paths: ["Trip"], versionId: null }, access: "read-write" }),
        row({ grantId: "g-2", selector: { kind: "group", channelWireId: "wire-trip", paths: ["Trip"], versionId: null }, access: "read-only" }),
        row({ grantId: "g-1", selector: { kind: "chat-channel", channelWireId: "wire-family" }, access: "read-write" }),
        row({ grantId: "g-6", selector: { paths: [], versionId: "v-1" }, access: "edit" }),
      ],
      received: [row({ grantId: "g-received" })],
    }, []);
    expect(grants).toEqual([
      { grantId: "g-1", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", files: null, channel: { wireId: "wire-family", canPost: true } },
      { grantId: "g-2", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test",
        files: { paths: ["Trip"], versionId: null, access: "view" }, channel: { wireId: "wire-trip", canPost: false } },
      { grantId: "g-3", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test",
        files: { paths: ["Trip"], versionId: null, access: "edit" }, channel: { wireId: "wire-trip", canPost: true } },
      { grantId: "g-4", recipientUserId: null, recipientEmail: "cai@dohc.test", files: { paths: ["Trip"], versionId: null, access: "view" }, channel: null },
      { ...ana, grantId: "g-5" },
      { ...ana, grantId: "g-6", files: { paths: [], versionId: "v-1", access: "edit" } },
    ]);
  });

  it("lists the dependents of active share links like named grants", () => {
    expect(rosterGrantsFrom(WORKSPACE, { granted: [] }, [
      link(),
      link({ status: "revoked" }),
      link({ selector: null, dependents: [] }),
    ])).toEqual([{
      grantId: "g-dep", recipientUserId: "u-ben", recipientEmail: "ben@dohc.test",
      files: { paths: ["Trip"], versionId: null, access: "edit" }, channel: null,
    }]);
  });

  it.each([
    ["a damaged grant", row({ selector: null, damaged: true, access: "unknown" })],
    ["a chat level on a file grant", row({ access: "read-write" })],
    ["a file level on a Group", row({ selector: { kind: "group", channelWireId: "wire-trip", paths: ["Trip"], versionId: null }, access: "edit" })],
    ["a path the relay could not issue", row({ selector: { paths: ["../Trip"], versionId: null } })],
    ["a file grant with no scope", row({ selector: { paths: [], versionId: null } })],
    ["an unknown kind of grantee", row({ principalKind: "group" })],
    ["a grant that names nobody", row({ recipientUserId: null, recipientEmail: null })],
    ["a grant that names no workspace", { ...row(), workspaceId: undefined }],
  ])("reads %s on this workspace as unreadable", (_case, damaged) => {
    expect(rosterGrantsFrom(WORKSPACE, { granted: [row(), damaged] }, [])).toBeNull();
  });

  it("reads a damaged link with dependents as unreadable, and ignores damage elsewhere", () => {
    expect(rosterGrantsFrom(WORKSPACE, { granted: [] }, [link({ selector: null })])).toBeNull();
    expect(rosterGrantsFrom(WORKSPACE, { granted: [] }, [link({ status: "paused" })])).toBeNull();
    expect(rosterGrantsFrom(WORKSPACE, {
      granted: [
        row({ grantId: "g-2", selector: null, damaged: true, revokedAtMs: 5 }),
        row({ grantId: "g-3", selector: null, damaged: true, workspaceId: "ws-other" }),
        row(),
      ],
    }, [])).toEqual([ana]);
  });

  it("refuses a listing that is not the relay's shape", () => {
    expect(() => rosterGrantsFrom(WORKSPACE, { granted: "all" }, [])).toThrow();
    expect(() => rosterGrantsFrom(WORKSPACE, null, [])).toThrow();
  });

  it("pages through share links and refuses a page it has already read", async () => {
    const get = vi.fn(async (path: string): Promise<unknown> => {
      if (path === "/sync/shares") return { ok: true, granted: [row()] };
      if (path === "/sync/ws-trip/shares/links") return { ok: true, links: [], nextCursor: "c 1" };
      if (path === "/sync/ws-trip/shares/links?cursor=c%201") return { ok: true, links: [link()] };
      throw new Error(`unexpected ${path}`);
    });
    expect((await listRosterGrants(WORKSPACE, get))?.map((grant) => grant.grantId)).toEqual(["g-1", "g-dep"]);
    expect(get).toHaveBeenCalledTimes(3);

    const looping = vi.fn(async (path: string): Promise<unknown> =>
      path === "/sync/shares" ? { granted: [] } : { links: [], nextCursor: "same" });
    await expect(listRosterGrants(WORKSPACE, looping)).rejects.toThrow("repeated");
  });
});

describe("the roster the reach check reads", () => {
  const entry: RegistryEntry = { workspaceId: WORKSPACE, rootPath: "/trip", kind: "personal", mode: "local-first" };

  it("gives a workspace that does not sync only its owner, the signed-in account", () => {
    expect(reachRosterFor(entry, "u-local")).toEqual({ kind: "owner", ownerUserId: "u-local", grants: [] });
  });

  it("knows only the Collection itself on a collaborator's computer", () => {
    const shareView = {
      shareId: "s-1", granterEmail: "owner@dohc.test", genericChatWritable: false,
      grantedSelector: { paths: ["Trip"], versionId: null, access: "edit" as const },
    };
    expect(reachRosterFor({ ...entry, remote, shareView }, "u-ana")).toEqual({ kind: "shared-view" });
  });

  it("reads the owner's stored grants, and anything it cannot read as unknown", () => {
    expect(reachRosterFor({ ...entry, remote }, "u-owner")).toEqual({ kind: "unknown", cause: "not-listed" });
    expect(reachRosterFor({ ...entry, remote, shareRoster: { version: 2, grants: null } }, "u-owner"))
      .toEqual({ kind: "unknown", cause: "unreadable" });
    const edited = { ...ana, files: { paths: ["../Budget"], versionId: null, access: "edit" as const } };
    expect(reachRosterFor({ ...entry, remote, shareRoster: { version: 2, grants: [edited] } }, "u-owner"))
      .toEqual({ kind: "unknown", cause: "unreadable" });
    expect(reachRosterFor({ ...entry, remote, shareRoster: { version: 2, grants: [ana] } }, "u-other"))
      .toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [ana] });
  });
});

describe("keeping the roster current", () => {
  let store: ReturnType<typeof createRegistryStore>;
  let now: number;

  beforeEach(async () => {
    vi.useFakeTimers();
    store = createRegistryStore(join(await createTestScratch("dohc-roster-"), "workspaces.json"));
    store.register({ workspaceId: WORKSPACE, rootPath: "/trip", kind: "personal", mode: "local-first", remote });
    store.register({ workspaceId: "ws-other", rootPath: "/other", kind: "personal", mode: "local-first", remote });
    now = 1_000_000;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function rosters(listGrants: (workspace: RegistryEntry) => Promise<RosterGrant[] | null>) {
    const logError = vi.fn();
    const list = vi.fn(listGrants);
    return {
      list, logError,
      rosters: createShareRosters({
        findWorkspace: store.find, saveRoster: store.setShareRoster, listGrants: list,
        localUserId: () => "u-owner", logError, nowMs: () => now,
      }),
    };
  }

  it("lists at open and every 10 minutes while open, and stops at close", async () => {
    const { list, rosters: r } = rosters(async () => [ana]);
    r.open(WORKSPACE);
    r.open(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(1);
    await r.forRun(WORKSPACE);
    expect(store.find(WORKSPACE)?.shareRoster).toEqual({ version: 1, grants: [ana] });

    vi.advanceTimersByTime(SHARE_ROSTER_REFRESH_MS);
    expect(list).toHaveBeenCalledTimes(2);
    r.close(WORKSPACE);
    vi.advanceTimersByTime(SHARE_ROSTER_REFRESH_MS * 3);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("lists again before a run only when the roster is older than a minute", async () => {
    const { list, rosters: r } = rosters(async () => [ana]);
    expect(await r.forRun(WORKSPACE)).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [ana] });
    now += SHARE_ROSTER_FRESH_MS - 1;
    await r.forRun(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(1);
    now += 1;
    await r.forRun(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("uses the cached roster while the relay does not answer, and lists again once it does", async () => {
    store.setShareRoster(WORKSPACE, [ana]);
    const { list, logError, rosters: r } = rosters(async () => { throw new Error("offline"); });
    expect(await r.forRun(WORKSPACE)).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [ana] });
    expect(logError).toHaveBeenCalledWith(WORKSPACE, new Error("offline"));
    now += SHARE_ROSTER_FRESH_MS * 5;
    await r.forRun(WORKSPACE);
    expect(list, "a run waited on a relay that already failed").toHaveBeenCalledTimes(1);

    list.mockImplementation(async () => []);
    r.pulled(WORKSPACE);
    await r.forRun(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(2);
    expect(store.find(WORKSPACE)?.shareRoster).toEqual({ version: 2, grants: [] });
    r.pulled(WORKSPACE);
    expect(list, "every sync pass listed shares").toHaveBeenCalledTimes(2);
  });

  it("lists once more after a share changes during a listing", async () => {
    const first = deferred<RosterGrant[] | null>();
    const { list, rosters: r } = rosters(() => first.promise);
    r.open(WORKSPACE);
    r.sharesChanged(WORKSPACE);
    r.sharesChanged(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(1);
    list.mockImplementation(async () => [ana]);
    first.resolve([]);
    await r.forRun(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(2);
    expect(store.find(WORKSPACE)?.shareRoster).toEqual({ version: 2, grants: [ana] });
  });

  it("refreshes every open workspace when a change names none", async () => {
    const { list, rosters: r } = rosters(async () => []);
    r.open(WORKSPACE);
    await r.forRun(WORKSPACE);
    r.sharesChanged(null);
    await r.forRun(WORKSPACE);
    expect(list.mock.calls.map(([workspace]) => workspace.workspaceId)).toEqual([WORKSPACE, WORKSPACE]);
  });

  it("lists nothing for a workspace that does not sync", async () => {
    store.register({ workspaceId: "ws-local", rootPath: "/local", kind: "personal", mode: "local-first" });
    const { list, rosters: r } = rosters(async () => [ana]);
    r.open("ws-local");
    expect(await r.forRun("ws-local")).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [] });
    expect(list).not.toHaveBeenCalled();
  });

  it("answers share impact from a current roster", async () => {
    const { rosters: r } = rosters(async () => [ana]);
    const impact = await r.shareImpact(
      WORKSPACE,
      { paths: ["Budget"], versionId: null, access: "edit", recipientEmail: "ben@dohc.test" },
      [{ id: "log", collection: { path: "Budget", name: "Budget" }, steps: [{ kind: "find-records", collection: { path: "Notes", name: "Notes" } }] }],
    );
    expect(impact).toEqual([{ automationId: "log", step: 0, reason: "ben@dohc.test cannot view Notes." }]);
  });
});
