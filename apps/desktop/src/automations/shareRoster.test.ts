import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { createRegistryStore, type RegistryEntry } from "../workspaces/registryStore";
import { createTestScratch } from "../workspaces/testTemp";
import {
  createShareRosters,
  listRosterGrants,
  reachRosterFor,
  rosterListingFrom,
  SHARE_ROSTER_FRESH_MS,
  SHARE_ROSTER_REFRESH_MS,
  type ListedGrant,
  type RosterAnswer,
  type RosterListing,
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

const ana: ListedGrant = {
  grantId: "g-1", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test",
  selector: { paths: ["Trip"], versionId: null }, access: "edit",
};
const anaOnRoster = {
  recipientUserId: "u-ana", recipientEmail: "ana@dohc.test",
  files: { paths: ["Trip"], versionId: null, access: "edit" }, channel: null,
};

describe("roster from the relay's listings", () => {
  it("keeps the owner's active grants on this workspace", () => {
    const group = { kind: "group", channelWireId: "wire-trip", paths: ["Trip"], versionId: null };
    const listing = rosterListingFrom(WORKSPACE, {
      ok: true,
      granted: [
        row({ grantId: "g-5" }),
        row({ grantId: "g-other", workspaceId: "ws-other" }),
        row({ grantId: "g-revoked", revokedAtMs: 9 }),
        row({ grantId: "g-link", principalKind: "link", recipientUserId: null, recipientEmail: null }),
        row({ grantId: "g-4", principalKind: "email", recipientUserId: null, recipientEmail: "cai@dohc.test", access: "view" }),
        row({ grantId: "g-3", selector: group, access: "read-write" }),
        row({ grantId: "g-2", selector: group, access: "read-only" }),
        row({ grantId: "g-1", selector: { kind: "chat-channel", channelWireId: "wire-family" }, access: "read-write" }),
        row({ grantId: "g-6", selector: { paths: [], versionId: "v-1" }, access: "edit" }),
      ],
      received: [row({ grantId: "g-received", workspaceId: undefined })],
    }, []);
    expect(listing.grants?.map((grant) => grant.grantId)).toEqual(["g-1", "g-2", "g-3", "g-4", "g-5", "g-6"]);
    const entry: RegistryEntry = { workspaceId: WORKSPACE, rootPath: "/trip", kind: "personal", mode: "local-first", remote };
    expect(reachRosterFor({ entry, localUserId: null, latest: listing, next: "" })).toEqual({
      kind: "owner", ownerUserId: "u-owner", grants: [
        { ...anaOnRoster, files: null, channel: { wireId: "wire-family", canPost: true } },
        { ...anaOnRoster, files: { paths: ["Trip"], versionId: null, access: "view" }, channel: { wireId: "wire-trip", canPost: false } },
        { ...anaOnRoster, channel: { wireId: "wire-trip", canPost: true } },
        { recipientUserId: null, recipientEmail: "cai@dohc.test", files: { paths: ["Trip"], versionId: null, access: "view" }, channel: null },
        anaOnRoster,
        { ...anaOnRoster, files: { paths: [], versionId: "v-1", access: "edit" } },
      ],
    });
  });

  it("lists the dependents of active share links like named grants", () => {
    expect(rosterListingFrom(WORKSPACE, { granted: [] }, [
      link(),
      link({ status: "revoked" }),
      link({ selector: null, dependents: [] }),
    ])).toEqual({ grants: [{
      grantId: "g-dep", recipientUserId: "u-ben", recipientEmail: "ben@dohc.test",
      selector: { paths: ["Trip"], versionId: null }, access: "edit",
    }] });
  });

  it.each([
    ["a damaged grant", row({ selector: null, damaged: true, access: "unknown" })],
    ["a chat level on a file grant", row({ access: "read-write" })],
    ["a file level on a Group", row({ selector: { kind: "group", channelWireId: "wire-trip", paths: ["Trip"], versionId: null }, access: "edit" })],
    ["a path the relay could not issue", row({ selector: { paths: ["../Trip"], versionId: null } })],
    ["a file grant with no scope", row({ selector: { paths: [], versionId: null } })],
    ["an unknown kind of grantee", row({ principalKind: "group" })],
    ["a grant that names nobody", row({ recipientUserId: null, recipientEmail: null })],
  ])("names %s on this workspace as damaged", (_case, damaged) => {
    expect(rosterListingFrom(WORKSPACE, { granted: [row(), damaged] }, []))
      .toEqual({ grants: null, problem: { kind: "damaged-share", recipientEmail: damaged.recipientEmail } });
  });

  it("ignores another workspace's damaged row, and calls a row with no workspace unusable", () => {
    expect(rosterListingFrom(WORKSPACE, {
      granted: [
        row({ grantId: "g-2", selector: null, damaged: true, revokedAtMs: 5 }),
        row({ grantId: "g-3", workspaceId: "ws-other", selector: null, damaged: true, access: 7, principalKind: 3, revokedAtMs: "no" }),
        row(),
      ],
    }, [])).toEqual({ grants: [ana] });
    expect(rosterListingFrom(WORKSPACE, { granted: [row({ workspaceId: undefined })] }, []))
      .toEqual({ grants: null, problem: { kind: "unusable-listing" } });
  });

  it("calls a damaged link with dependents, or a link it cannot read, damaged", () => {
    for (const damaged of [link({ selector: null }), link({ status: "paused" }), link({ dependents: "all" })]) {
      expect(rosterListingFrom(WORKSPACE, { granted: [] }, [damaged])).toEqual({ grants: null, problem: { kind: "damaged-link" } });
    }
  });

  it("calls a listing that is not the relay's shape unusable", () => {
    for (const shares of [{ granted: "all" }, null, []]) {
      expect(rosterListingFrom(WORKSPACE, shares, [])).toEqual({ grants: null, problem: { kind: "unusable-listing" } });
    }
  });
});

describe("listing from the relay", () => {
  const unusable = { kind: "answered", listing: { grants: null, problem: { kind: "unusable-listing" } } };

  function relay(pages: Record<string, { status: number; body: unknown } | Error>) {
    return vi.fn(async (path: string) => {
      const page = pages[path];
      if (page === undefined) throw new Error(`unexpected ${path}`);
      if (page instanceof Error) throw page;
      return page;
    });
  }

  it("pages through share links", async () => {
    const get = relay({
      "/sync/shares": { status: 200, body: { ok: true, granted: [row()] } },
      "/sync/ws-trip/shares/links": { status: 200, body: { ok: true, links: [], nextCursor: "c 1" } },
      "/sync/ws-trip/shares/links?cursor=c%201": { status: 200, body: { ok: true, links: [link()] } },
    });
    const answer = await listRosterGrants(WORKSPACE, get);
    expect(answer.kind === "answered" && answer.listing.grants?.map((grant) => grant.grantId)).toEqual(["g-1", "g-dep"]);
  });

  it("keeps the cache when no answer arrives, and names what to do", async () => {
    const links = { "/sync/ws-trip/shares/links": { status: 200, body: { links: [] } } };
    const cases: Array<[{ status: number; body: unknown } | Error, string]> = [
      [new TypeError("fetch failed"), "Check your connection, then try again."],
      [{ status: 401, body: { ok: false } }, "Sign in again, then try again."],
      [{ status: 503, body: null }, "Your server is not answering. Try again later."],
      [{ status: 429, body: null }, "Your server is not answering. Try again later."],
    ];
    for (const [shares, next] of cases) {
      expect(await listRosterGrants(WORKSPACE, relay({ "/sync/shares": shares, ...links }))).toEqual({ kind: "unanswered", next });
    }
  });

  it("calls a refused, malformed, looping, or over-long answer unusable", async () => {
    const shares = { "/sync/shares": { status: 200, body: { granted: [] } } };
    expect(await listRosterGrants(WORKSPACE, relay({ "/sync/shares": { status: 404, body: { ok: false } } }))).toEqual(unusable);
    expect(await listRosterGrants(WORKSPACE, relay({ ...shares, "/sync/ws-trip/shares/links": { status: 403, body: null } }))).toEqual(unusable);
    expect(await listRosterGrants(WORKSPACE, relay({ ...shares, "/sync/ws-trip/shares/links": { status: 200, body: { links: "all" } } })))
      .toEqual(unusable);
    const looping = vi.fn(async (path: string) =>
      ({ status: 200, body: path === "/sync/shares" ? { granted: [] } : { links: [], nextCursor: "same" } }));
    expect(await listRosterGrants(WORKSPACE, looping)).toEqual(unusable);
    let page = 0;
    const endless = vi.fn(async (path: string) =>
      ({ status: 200, body: path === "/sync/shares" ? { granted: [] } : { links: [], nextCursor: `c-${(page += 1)}` } }));
    expect(await listRosterGrants(WORKSPACE, endless)).toEqual(unusable);
    expect(endless).toHaveBeenCalledTimes(51);
  });
});

describe("the roster the reach check reads", () => {
  const entry: RegistryEntry = { workspaceId: WORKSPACE, rootPath: "/trip", kind: "personal", mode: "local-first" };

  it("gives a workspace that does not sync only its owner, signed in or not", () => {
    expect(reachRosterFor({ entry, localUserId: "u-local", latest: null, next: "" }))
      .toEqual({ kind: "owner", ownerUserId: "u-local", grants: [] });
    expect(reachRosterFor({ entry, localUserId: null, latest: null, next: "" }))
      .toEqual({ kind: "owner", ownerUserId: null, grants: [] });
  });

  it("knows only the Collection itself on a collaborator's computer", () => {
    const shareView = {
      shareId: "s-1", granterEmail: "owner@dohc.test", genericChatWritable: false,
      grantedSelector: { paths: ["Trip"], versionId: null, access: "edit" as const },
    };
    expect(reachRosterFor({ entry: { ...entry, remote, shareView }, localUserId: "u-ana", latest: null, next: "" }))
      .toEqual({ kind: "shared-view" });
  });

  it("reads the stored grants with the relay's rules, and calls a copy it cannot read unchecked", () => {
    const next = "Check your connection, then try again.";
    const unchecked = { kind: "unknown", problem: { kind: "unchecked", next } };
    const read = (shareRoster: unknown) =>
      reachRosterFor({ entry: { ...entry, remote, shareRoster: shareRoster as RegistryEntry["shareRoster"] }, localUserId: null, latest: null, next });
    expect(reachRosterFor({ entry: { ...entry, remote }, localUserId: null, latest: null, next })).toEqual(unchecked);
    expect(read({ version: 2, grants: [ana] })).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [anaOnRoster] });
    expect(read({ version: 2, grants: null, problem: { kind: "damaged-link" } }))
      .toEqual({ kind: "unknown", problem: { kind: "damaged-link" } });
    for (const damaged of [
      { ...ana, selector: { paths: [], versionId: null } },
      { ...ana, selector: { paths: ["../Budget"], versionId: null } },
      { ...ana, access: "read-write" },
      { ...ana, selector: { kind: "group", channelWireId: "wire", paths: [], versionId: null }, access: "read-write" },
      { ...ana, recipientUserId: null, recipientEmail: null },
    ]) {
      expect(read({ version: 2, grants: [damaged] }), JSON.stringify(damaged)).toEqual(unchecked);
    }
    expect(read({ version: 2, grants: null })).toEqual(unchecked);
  });

  it("prefers a listing it learned but could not save", () => {
    expect(reachRosterFor({
      entry: { ...entry, remote, shareRoster: { version: 1, grants: [ana] } }, localUserId: null, next: "",
      latest: { grants: null, problem: { kind: "unusable-listing" } },
    })).toEqual({ kind: "unknown", problem: { kind: "unusable-listing" } });
  });
});

describe("keeping the roster current", () => {
  let store: ReturnType<typeof createRegistryStore>;
  let now: number;

  beforeEach(async () => {
    vi.useFakeTimers();
    store = createRegistryStore(join(await createTestScratch("dohc-roster-"), "workspaces.json"));
    store.register({ workspaceId: WORKSPACE, rootPath: "/trip", kind: "personal", mode: "local-first", remote });
    now = 1_000_000;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const answered = (listing: RosterListing): RosterAnswer => ({ kind: "answered", listing });
  const offline: RosterAnswer = { kind: "unanswered", next: "Check your connection, then try again." };

  function rosters(listRoster: (workspace: RegistryEntry) => Promise<RosterAnswer>, save = store.setShareRoster) {
    const logError = vi.fn();
    const list = vi.fn(listRoster);
    const saveRoster = vi.fn(save);
    return {
      list, logError, saveRoster,
      rosters: createShareRosters({
        findWorkspace: store.find, saveRoster, listRoster: list,
        localUserId: async () => null, logError, nowMs: () => now,
      }),
    };
  }

  it("lists at open and every 10 minutes while open, and stops at close", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana] }));
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

  it("lists again before a run only when the last listing is older than a minute", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana] }));
    expect(await r.forRun(WORKSPACE)).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [anaOnRoster] });
    now += SHARE_ROSTER_FRESH_MS - 1;
    await r.forRun(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(1);
    now += 1;
    await r.forRun(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps the last answer when the relay does not answer, and says why when there is none", async () => {
    const { rosters: first } = rosters(async () => offline);
    expect(await first.forRun(WORKSPACE)).toEqual({ kind: "unknown", problem: { kind: "unchecked", next: offline.next } });
    store.setShareRoster(WORKSPACE, { grants: [ana] });
    const { list, rosters: r } = rosters(async () => offline);
    expect(await r.forRun(WORKSPACE)).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [anaOnRoster] });
    now += SHARE_ROSTER_FRESH_MS * 5;
    await r.forRun(WORKSPACE);
    expect(list, "a run waited on a relay that already failed").toHaveBeenCalledTimes(1);
  });

  it("replaces the cache when the relay answers with something dohc cannot use", async () => {
    store.setShareRoster(WORKSPACE, { grants: [ana] });
    const { rosters: r } = rosters(async () => answered({ grants: null, problem: { kind: "unusable-listing" } }));
    expect(await r.forRun(WORKSPACE)).toEqual({ kind: "unknown", problem: { kind: "unusable-listing" } });
    expect(store.find(WORKSPACE)?.shareRoster).toEqual({ version: 2, grants: null, problem: { kind: "unusable-listing" } });
  });

  it("treats a listing that throws as unusable, not as offline", async () => {
    store.setShareRoster(WORKSPACE, { grants: [ana] });
    const { rosters: r } = rosters(async () => { throw new Error("bug"); });
    expect(await r.forRun(WORKSPACE)).toEqual({ kind: "unknown", problem: { kind: "unusable-listing" } });
  });

  it("uses a new listing it could not save, and saves it on the next try", async () => {
    store.setShareRoster(WORKSPACE, { grants: [ana] });
    let fail = true;
    const { list, rosters: r } = rosters(async () => answered({ grants: [] }), (id, listing) => {
      if (fail) throw new Error("disk full");
      store.setShareRoster(id, listing);
    });
    expect(await r.forRun(WORKSPACE)).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [] });
    expect(store.find(WORKSPACE)?.shareRoster?.grants).toEqual([ana]);
    fail = false;
    expect(await r.forRun(WORKSPACE)).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [] });
    expect(list, "the retry listed again instead of saving what it knew").toHaveBeenCalledTimes(1);
    expect(store.find(WORKSPACE)?.shareRoster).toEqual({ version: 2, grants: [] });
  });

  it("lists at most once a minute while listings fail and sync pulls succeed", async () => {
    store.setShareRoster(WORKSPACE, { grants: [ana] });
    const { list, rosters: r } = rosters(async () => offline);
    await r.forRun(WORKSPACE);
    for (let pass = 0; pass < 10; pass += 1) {
      now += 5_000;
      r.pulled(WORKSPACE, false);
      expect(await r.forRun(WORKSPACE)).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [anaOnRoster] });
    }
    expect(list).toHaveBeenCalledTimes(1);
    now += 10_000;
    r.pulled(WORKSPACE, false);
    await r.forRun(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("lists on the first sync pass a minute after a listing got no answer, as after signing in again", async () => {
    const { list, rosters: r } = rosters(async () => offline);
    await r.forRun(WORKSPACE);
    list.mockImplementation(async () => answered({ grants: [ana] }));
    now += SHARE_ROSTER_FRESH_MS;
    r.pulled(WORKSPACE, false);
    expect(list).toHaveBeenCalledTimes(2);
    expect(await r.forRun(WORKSPACE)).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [anaOnRoster] });
  });

  it("lists when relay sync recovers from a failed pass", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana] }));
    r.open(WORKSPACE);
    await r.forRun(WORKSPACE);
    r.pulled(WORKSPACE, false);
    expect(list).toHaveBeenCalledTimes(1);
    r.pulled(WORKSPACE, true);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("lists once more after a share changes during a listing", async () => {
    const first = deferred<RosterAnswer>();
    const { list, rosters: r } = rosters(() => first.promise);
    r.open(WORKSPACE);
    r.sharesChanged(WORKSPACE);
    r.sharesChanged(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(1);
    list.mockImplementation(async () => answered({ grants: [ana] }));
    first.resolve(answered({ grants: [] }));
    await r.forRun(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(2);
    expect(store.find(WORKSPACE)?.shareRoster).toEqual({ version: 2, grants: [ana] });
  });

  it("refreshes every open workspace when a change names none", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [] }));
    r.open(WORKSPACE);
    await r.forRun(WORKSPACE);
    r.sharesChanged(null);
    await r.forRun(WORKSPACE);
    expect(list.mock.calls.map(([workspace]) => workspace.workspaceId)).toEqual([WORKSPACE, WORKSPACE]);
  });

  it("lists nothing for a workspace that does not sync, whose owner is this computer's person", async () => {
    store.register({ workspaceId: "ws-local", rootPath: "/local", kind: "personal", mode: "local-first" });
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana] }));
    r.open("ws-local");
    expect(await r.forRun("ws-local")).toEqual({ kind: "owner", ownerUserId: null, grants: [] });
    expect(list).not.toHaveBeenCalled();
  });

  it("answers share impact from a current roster", async () => {
    const { rosters: r } = rosters(async () => answered({ grants: [ana] }));
    const impact = await r.shareImpact(
      WORKSPACE,
      { paths: ["Budget"], versionId: null, access: "edit", recipientEmail: "ben@dohc.test" },
      [{ id: "log", collection: { path: "Budget", name: "Budget" }, codeFiles: [], steps: [{ kind: "find-records", collection: { path: "Notes", name: "Notes" } }] }],
    );
    expect(impact).toEqual([{ automationId: "log", step: 0, reason: "ben@dohc.test cannot view Notes." }]);
  });
});
