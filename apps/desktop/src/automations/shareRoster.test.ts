import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { createRegistryStore, type RegistryEntry } from "../workspaces/registryStore";
import { createTestScratch } from "../workspaces/testTemp";
import {
  createShareRosters,
  listRosterGrants,
  reachRosterFor,
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

type Page = { status: number; body: unknown } | Error;

function relay(pages: Record<string, Page>) {
  return vi.fn(async (path: string) => {
    const page = pages[path];
    if (page === undefined) throw new Error(`unexpected ${path}`);
    if (page instanceof Error) throw page;
    return page;
  });
}

// The listing for one /sync/shares body and one page of links.
async function listed(shares: unknown, links: unknown[] = []): Promise<RosterListing> {
  const answer = await listRosterGrants(WORKSPACE, relay({
    "/sync/shares": { status: 200, body: shares },
    "/sync/ws-trip/shares/links": { status: 200, body: { ok: true, links } },
  }));
  if (answer.kind !== "answered") throw new Error("the relay answered every request");
  return answer.listing;
}

const unusable = { kind: "answered", listing: { grants: null, problem: { kind: "unusable-listing" } } };
const serverDown = { status: 503, body: null };

describe("roster from the relay's listings", () => {
  it("keeps the owner's active grants on this workspace", async () => {
    const group = { kind: "group", channelWireId: "wire-trip", paths: ["Trip"], versionId: null };
    const listing = await listed({
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
    });
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

  it("lists the dependents of active share links like named grants", async () => {
    expect(await listed({ granted: [] }, [
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
  ])("names %s on this workspace as damaged", async (_case, damaged) => {
    expect(await listed({ granted: [row(), damaged] }))
      .toEqual({ grants: null, problem: { kind: "damaged-share", recipientEmail: damaged.recipientEmail } });
  });

  it("ignores another workspace's damaged row, and calls a row with no workspace unusable", async () => {
    expect(await listed({
      granted: [
        row({ grantId: "g-2", selector: null, damaged: true, revokedAtMs: 5 }),
        row({ grantId: "g-3", workspaceId: "ws-other", selector: null, damaged: true, access: 7, principalKind: 3, revokedAtMs: "no" }),
        row(),
      ],
    })).toEqual({ grants: [ana] });
    expect(await listed({ granted: [row({ workspaceId: undefined })] }))
      .toEqual({ grants: null, problem: { kind: "unusable-listing" } });
  });

  it("calls a damaged link with dependents, or a link it cannot read, damaged", async () => {
    for (const damaged of [link({ selector: null }), link({ status: "paused" }), link({ dependents: "all" })]) {
      expect(await listed({ granted: [] }, [damaged])).toEqual({ grants: null, problem: { kind: "damaged-link" } });
    }
  });

  it("calls a listing that is not the relay's shape unusable", async () => {
    for (const shares of [{ granted: "all" }, null, []]) {
      expect(await listed(shares)).toEqual({ grants: null, problem: { kind: "unusable-listing" } });
    }
  });
});

describe("listing from the relay", () => {
  const noLinks = { "/sync/ws-trip/shares/links": { status: 200, body: { links: [] } } };

  it("pages through share links", async () => {
    const get = relay({
      "/sync/shares": { status: 200, body: { ok: true, granted: [row()] } },
      "/sync/ws-trip/shares/links": { status: 200, body: { ok: true, links: [], nextCursor: "c 1" } },
      "/sync/ws-trip/shares/links?cursor=c%201": { status: 200, body: { ok: true, links: [link()] } },
    });
    const answer = await listRosterGrants(WORKSPACE, get);
    expect(answer.kind === "answered" && answer.listing.grants?.map((grant) => grant.grantId)).toEqual(["g-1", "g-dep"]);
  });

  it("reports no answer, and names what to do", async () => {
    const cases: Array<[Page, string]> = [
      [new TypeError("fetch failed"), "Check your connection, then try again."],
      [{ status: 401, body: { ok: false } }, "Sign in again, then try again."],
      [serverDown, "Your server is not answering. Try again later."],
      [{ status: 429, body: null }, "Your server is not answering. Try again later."],
    ];
    for (const [shares, next] of cases) {
      expect(await listRosterGrants(WORKSPACE, relay({ "/sync/shares": shares, ...noLinks })))
        .toEqual({ kind: "unanswered", next, partial: false });
    }
  });

  it("says when the relay answered part of a listing and then stopped", async () => {
    expect(await listRosterGrants(WORKSPACE, relay({
      "/sync/shares": { status: 200, body: { granted: [row()] } },
      "/sync/ws-trip/shares/links": serverDown,
    }))).toEqual({ kind: "unanswered", next: "Your server is not answering. Try again later.", partial: true });
  });

  it("decides on damage or a refusal as soon as it arrives, whatever the later requests do", async () => {
    const damagedShare = relay({
      "/sync/shares": { status: 200, body: { granted: [row({ selector: null, damaged: true, access: "unknown" })] } },
      "/sync/ws-trip/shares/links": serverDown,
    });
    expect(await listRosterGrants(WORKSPACE, damagedShare))
      .toEqual({ kind: "answered", listing: { grants: null, problem: { kind: "damaged-share", recipientEmail: "ana@dohc.test" } } });
    expect(damagedShare).toHaveBeenCalledTimes(1);

    const damagedLink = relay({
      "/sync/shares": { status: 200, body: { granted: [] } },
      "/sync/ws-trip/shares/links": { status: 200, body: { links: [link({ selector: null })], nextCursor: "c-2" } },
      "/sync/ws-trip/shares/links?cursor=c-2": serverDown,
    });
    expect(await listRosterGrants(WORKSPACE, damagedLink))
      .toEqual({ kind: "answered", listing: { grants: null, problem: { kind: "damaged-link" } } });
    expect(damagedLink).toHaveBeenCalledTimes(2);

    expect(await listRosterGrants(WORKSPACE, relay({
      "/sync/shares": { status: 200, body: { granted: [] } },
      "/sync/ws-trip/shares/links": { status: 403, body: null },
    }))).toEqual(unusable);
  });

  it("calls a refused, malformed, looping, or over-long answer unusable", async () => {
    const shares = { "/sync/shares": { status: 200, body: { granted: [] } } };
    expect(await listRosterGrants(WORKSPACE, relay({ "/sync/shares": { status: 404, body: { ok: false } } }))).toEqual(unusable);
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
  const offline: RosterAnswer = { kind: "unanswered", next: "Check your connection, then try again.", partial: false };
  const failing: RosterAnswer = { kind: "unanswered", next: "Your server is not answering. Try again later.", partial: false };
  const cached = { kind: "owner", ownerUserId: "u-owner", grants: [anaOnRoster] };
  const unchecked = (next: string) => ({ kind: "unknown", problem: { kind: "unchecked", next } });

  // A roster listed a second ago, with no sync pass since.
  function seed(): void {
    store.setShareRoster(WORKSPACE, { grants: [ana] }, now - 1_000);
  }

  // The same registry file, read the way a restarted dohc reads it.
  function restart(): void {
    store = createRegistryStore(store.registryFile);
  }

  function rosters(listRoster: (workspace: RegistryEntry) => Promise<RosterAnswer>, save = store.setShareRoster) {
    const logError = vi.fn();
    const list = vi.fn(listRoster);
    const saveRoster = vi.fn(save);
    return {
      list, logError, saveRoster,
      rosters: createShareRosters({
        findWorkspace: store.find, saveRoster, markRosterPulled: store.markShareRosterPulled, listRoster: list,
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
    expect(store.find(WORKSPACE)?.shareRoster).toMatchObject({ version: 1, grants: [ana] });

    vi.advanceTimersByTime(SHARE_ROSTER_REFRESH_MS);
    expect(list).toHaveBeenCalledTimes(2);
    r.close(WORKSPACE);
    vi.advanceTimersByTime(SHARE_ROSTER_REFRESH_MS * 3);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("lists again before a run only when the last listing is older than a minute", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana] }));
    expect(await r.forRun(WORKSPACE)).toEqual(cached);
    now += SHARE_ROSTER_FRESH_MS - 1;
    await r.forRun(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(1);
    now += 1;
    await r.forRun(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps the last answer while nothing from the relay answers, and says why when there is none", async () => {
    const { rosters: first } = rosters(async () => offline);
    expect(await first.forRun(WORKSPACE)).toEqual(unchecked(offline.next));
    seed();
    const { list, rosters: r } = rosters(async () => offline);
    expect(await r.forRun(WORKSPACE)).toEqual(cached);
    now += SHARE_ROSTER_FRESH_MS * 5;
    expect(await r.forRun(WORKSPACE)).toEqual(cached);
    expect(list, "a run waited on a relay that already failed").toHaveBeenCalledTimes(1);
  });

  it("makes the roster unknown once sync reaches the relay while listings still fail", async () => {
    seed();
    const { list, rosters: r } = rosters(async () => failing);
    expect(await r.forRun(WORKSPACE)).toEqual(cached);
    await r.pulled(WORKSPACE, false);
    expect(await r.forRun(WORKSPACE)).toEqual(unchecked(failing.next));
    for (let minute = 1; minute <= 5; minute += 1) {
      now += SHARE_ROSTER_FRESH_MS;
      await r.pulled(WORKSPACE, false);
      expect(list).toHaveBeenCalledTimes(1 + minute);
      expect(await r.forRun(WORKSPACE), `minute ${minute}`).toEqual(unchecked(failing.next));
    }
    list.mockImplementation(async () => answered({ grants: [ana] }));
    now += SHARE_ROSTER_FRESH_MS;
    await r.pulled(WORKSPACE, false);
    expect(await r.forRun(WORKSPACE)).toEqual(cached);
  });

  it("makes the roster unknown when a pass ended after the cached listing, even before the failing listing", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana] }));
    expect(await r.forRun(WORKSPACE)).toEqual(cached);
    // t=100: a pass brings changes the listing did not see. The listing is not due yet.
    now += SHARE_ROSTER_FRESH_MS - 1;
    await r.pulled(WORKSPACE, false);
    expect(list).toHaveBeenCalledTimes(1);
    expect(store.find(WORKSPACE)?.shareRoster?.pulledAfter).toBe(true);
    // t=101: the due listing fails.
    list.mockImplementation(async () => failing);
    now += 1;
    expect(await r.forRun(WORKSPACE)).toEqual(unchecked(failing.next));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps the cache when the last pass ended before the cached listing started", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana] }));
    await r.pulled(WORKSPACE, false);
    expect(await r.forRun(WORKSPACE)).toEqual(cached);
    expect(store.find(WORKSPACE)?.shareRoster?.pulledAfter).toBeUndefined();
    list.mockImplementation(async () => failing);
    now += SHARE_ROSTER_FRESH_MS;
    expect(await r.forRun(WORKSPACE)).toEqual(cached);
  });

  it("remembers across a restart that a pass ended after the cached listing", async () => {
    const before = rosters(async () => answered({ grants: [ana] }));
    await before.rosters.forRun(WORKSPACE);
    now += 1;
    await before.rosters.pulled(WORKSPACE, false);
    restart();
    now += 1_000;
    // A claim from before the restart runs before any pass or listing answers.
    const { rosters: after } = rosters(async () => offline);
    expect(await after.forRun(WORKSPACE)).toEqual(unchecked(offline.next));
  });

  it("uses the cache after a restart when no pass ended after it was listed", async () => {
    const before = rosters(async () => answered({ grants: [ana] }));
    await before.rosters.forRun(WORKSPACE);
    restart();
    now += 1_000;
    const { rosters: after } = rosters(async () => offline);
    expect(await after.forRun(WORKSPACE)).toEqual(cached);
  });

  it("counts any pass this session for a copy saved without its listing time", async () => {
    seed();
    const file = JSON.parse(readFileSync(store.registryFile, "utf8")) as { workspaces: Array<{ shareRoster?: { listedAtMs?: number } }> };
    delete file.workspaces[0]!.shareRoster!.listedAtMs;
    writeFileSync(store.registryFile, JSON.stringify(file));
    restart();
    const { rosters: r } = rosters(async () => failing);
    expect(await r.forRun(WORKSPACE)).toEqual(cached);
    now -= 60 * 60_000;
    await r.pulled(WORKSPACE, false);
    expect(await r.forRun(WORKSPACE)).toEqual(unchecked(failing.next));
  });

  it("makes the roster unknown when the relay answered part of a listing and then stopped", async () => {
    seed();
    const { rosters: r } = rosters(async () => ({ ...failing, partial: true }));
    expect(await r.forRun(WORKSPACE)).toEqual(unchecked(failing.next));
  });

  it("replaces the cache when the relay answers with something dohc cannot use", async () => {
    seed();
    const { rosters: r } = rosters(async () => answered({ grants: null, problem: { kind: "unusable-listing" } }));
    expect(await r.forRun(WORKSPACE)).toEqual({ kind: "unknown", problem: { kind: "unusable-listing" } });
    expect(store.find(WORKSPACE)?.shareRoster).toMatchObject({ version: 2, grants: null, problem: { kind: "unusable-listing" } });
  });

  it("treats a listing that throws as unusable, not as offline", async () => {
    seed();
    const { rosters: r } = rosters(async () => { throw new Error("bug"); });
    expect(await r.forRun(WORKSPACE)).toEqual({ kind: "unknown", problem: { kind: "unusable-listing" } });
  });

  it("uses a new listing it could not save, and saves it on the next try", async () => {
    seed();
    let fail = true;
    const { list, rosters: r } = rosters(async () => answered({ grants: [] }), (id, listing, listedAtMs) => {
      if (fail) throw new Error("disk full");
      store.setShareRoster(id, listing, listedAtMs);
    });
    expect(await r.forRun(WORKSPACE)).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [] });
    expect(store.find(WORKSPACE)?.shareRoster?.grants).toEqual([ana]);
    fail = false;
    expect(await r.forRun(WORKSPACE)).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [] });
    expect(list, "the retry listed again instead of saving what it knew").toHaveBeenCalledTimes(1);
    expect(store.find(WORKSPACE)?.shareRoster).toMatchObject({ version: 2, grants: [] });
  });

  it("retries a listing that got no answer on sync passes, once a minute, until one answers", async () => {
    const { list, rosters: r } = rosters(async () => offline);
    await r.pulled(WORKSPACE, true);
    expect(list).toHaveBeenCalledTimes(1);
    now += 10_000;
    await r.pulled(WORKSPACE, false);
    expect(list, "a pass retried within a minute").toHaveBeenCalledTimes(1);
    now += SHARE_ROSTER_FRESH_MS - 10_000;
    await r.pulled(WORKSPACE, false);
    expect(list, "an early pass ended the retries").toHaveBeenCalledTimes(2);
    now += SHARE_ROSTER_FRESH_MS;
    list.mockImplementation(async () => answered({ grants: [ana] }));
    await r.pulled(WORKSPACE, false);
    expect(list).toHaveBeenCalledTimes(3);
    now += SHARE_ROSTER_FRESH_MS;
    await r.pulled(WORKSPACE, false);
    expect(list, "a pass listed again after a listing answered").toHaveBeenCalledTimes(3);
    expect(store.find(WORKSPACE)?.shareRoster).toMatchObject({ version: 1, grants: [ana] });
  });

  it("lists when sync recovers, at most once a minute", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana] }));
    await r.pulled(WORKSPACE, false);
    expect(list, "an ordinary pass listed").not.toHaveBeenCalled();
    await r.pulled(WORKSPACE, true);
    expect(list).toHaveBeenCalledTimes(1);
    for (let pass = 0; pass < 11; pass += 1) {
      now += 5_000;
      await r.pulled(WORKSPACE, true);
    }
    expect(list, "repeated recoveries listed more than once a minute").toHaveBeenCalledTimes(1);
    now += 5_000;
    await r.pulled(WORKSPACE, true);
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
    expect(store.find(WORKSPACE)?.shareRoster).toMatchObject({ version: 2, grants: [ana] });
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
