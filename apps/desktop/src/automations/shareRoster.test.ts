import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { checkAutomationReach } from "@dohc/automation-executor/automation-reach";
import { createRegistryStore, type RegistryEntry } from "../workspaces/registryStore";
import { createTestScratch } from "../workspaces/testTemp";
import {
  createShareRosters,
  listRosterGrants,
  reachRosterFor,
  rosterAuthorLabel,
  SHARE_ROSTER_FRESH_MS,
  SHARE_ROSTER_REFRESH_MS,
  type ListedGrant,
  type ListedLink,
  type RosterAnswer,
  type RosterListing,
} from "./shareRoster";

const WORKSPACE = "ws-trip";
const remote = { serverUrl: "https://server.dohc.test", ownerUserId: "u-owner" };

function row(overrides: Record<string, unknown> = {}) {
  return {
    shareId: "s-1", workspaceId: WORKSPACE, grantId: "g-1", principalKind: "user", generation: 1,
    recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", createdAtMs: 1, revokedAtMs: null,
    selector: { paths: ["Trip"], versionId: null }, access: "edit", automationsGeneration: null, ...overrides,
  };
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    grantId: "g-link", status: "active", selector: { paths: ["Trip"], versionId: null }, access: "edit", automationsGeneration: null,
    dependents: [{ grantId: "g-dep", recipientUserId: "u-ben", recipientEmail: "ben@dohc.test", access: "edit", generation: 1, createdAtMs: 1 }],
    ...overrides,
  };
}

// A link's own grant, as the listing keeps it.
function linkGrant(grantId: string, overrides: Record<string, unknown> = {}) {
  return {
    grant: { grantId, recipientUserId: null, recipientEmail: null, selector: { paths: ["Trip"], versionId: null }, access: "edit" },
    ended: false, automationsGeneration: null, ...overrides,
  } as ListedLink;
}

const ana: ListedGrant = {
  grantId: "g-1", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test",
  selector: { paths: ["Trip"], versionId: null }, access: "edit",
};
const anaOnRoster = {
  grantId: "g-1", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test",
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
        row({ grantId: "g-1", selector: { kind: "chat", channelWireId: "wire-family" }, access: "read-write" }),
        row({ grantId: "g-6", selector: { paths: [], versionId: "v-1" }, access: "edit" }),
      ],
      received: [row({ grantId: "g-received", workspaceId: undefined })],
    });
    expect(listing.grants?.map((grant) => grant.grantId)).toEqual(["g-1", "g-2", "g-3", "g-4", "g-5", "g-6"]);
    const entry: RegistryEntry = { workspaceId: WORKSPACE, rootPath: "/trip", kind: "personal", mode: "local-first", remote };
    expect(reachRosterFor({ entry, localUserId: null, latest: listing, next: "" })).toEqual({
      kind: "owner", ownerUserId: "u-owner", grants: [
        { ...anaOnRoster, files: null, channel: { wireId: "wire-family", canPost: true } },
        { ...anaOnRoster, grantId: "g-2", files: { paths: ["Trip"], versionId: null, access: "view" }, channel: { wireId: "wire-trip", canPost: false } },
        { ...anaOnRoster, grantId: "g-3", channel: { wireId: "wire-trip", canPost: true } },
        { grantId: "g-4", recipientUserId: null, recipientEmail: "cai@dohc.test", files: { paths: ["Trip"], versionId: null, access: "view" }, channel: null },
        { ...anaOnRoster, grantId: "g-5" },
        { ...anaOnRoster, grantId: "g-6", files: { paths: [], versionId: "v-1", access: "edit" } },
      ],
      formerEditors: [],
    });
  });

  it("lists each active Edit link as its own grant, and every active link's dependents like named grants", async () => {
    expect(await listed({ granted: [] }, [
      link(),
      link({ grantId: "g-view", access: "view", dependents: [] }),
      link({ grantId: "g-comment", access: "comment", dependents: [] }),
      link({ grantId: "g-revoked", status: "revoked" }),
      link({ grantId: "g-revoked-damaged", status: "revoked", selector: null, access: "unknown" }),
    ])).toEqual({
      grants: [{
        grantId: "g-dep", recipientUserId: "u-ben", recipientEmail: "ben@dohc.test",
        selector: { paths: ["Trip"], versionId: null }, access: "edit",
      }],
      links: [linkGrant("g-link")],
      formerGrants: [],
    });
  });

  it("keeps a link that wrote automations directly after it ends, without its dependents", async () => {
    const listing = await listed({ granted: [] }, [
      link({ grantId: "g-ended", status: "revoked", automationsGeneration: 3 }),
      link({ grantId: "g-narrowed", access: "view", automationsGeneration: 3, dependents: [] }),
    ]);
    expect(listing).toEqual({
      grants: [],
      links: [
        linkGrant("g-ended", { ended: true, automationsGeneration: 3 }),
        linkGrant("g-narrowed", { automationsGeneration: 3, grant: { ...linkGrant("g-narrowed").grant, access: "view" } }),
      ],
      formerGrants: [],
    });
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
    })).toEqual({ grants: [ana], links: [], formerGrants: [] });
    expect(await listed({ granted: [row({ workspaceId: undefined })] }))
      .toEqual({ grants: null, problem: { kind: "unusable-listing" } });
  });

  it("calls an active link it cannot read, or an ended one that wrote automations directly, damaged", async () => {
    for (const damaged of [
      link({ selector: null }),
      link({ selector: null, access: "unknown", dependents: [] }),
      link({ status: "paused" }),
      link({ dependents: "all" }),
      link({ automationsGeneration: 0 }),
      link({ automationsGeneration: "2" }),
      link({ access: "read-write" }),
      link({ status: "revoked", automationsGeneration: 3, selector: null }),
      link({ status: "revoked", automationsGeneration: 3, selector: { kind: "chat", channelWireId: "wire" }, access: "read-write" }),
      link({ status: "revoked", automationsGeneration: 3, selector: { paths: [], versionId: "v-1" } }),
    ]) {
      expect(await listed({ granted: [] }, [damaged])).toEqual({ grants: null, problem: { kind: "damaged-link" } });
    }
  });

  it("says the server needs an update when it lists links without their automations writes", async () => {
    const { automationsGeneration: _left, ...older } = link();
    expect(await listed({ granted: [] }, [older])).toEqual({ grants: null, problem: { kind: "outdated-server" } });
    const entry: RegistryEntry = { workspaceId: WORKSPACE, rootPath: "/trip", kind: "personal", mode: "local-first", remote };
    const stored = { version: 1, grants: null, problem: { kind: "outdated-server" } } as const;
    expect(reachRosterFor({ entry: { ...entry, shareRoster: stored }, localUserId: null, latest: null, next: "" }))
      .toEqual({ kind: "unknown", problem: { kind: "outdated-server" } });
  });

  it("keeps a named grant that wrote automations and stopped editing as a former grant", async () => {
    const listing = await listed({
      granted: [
        row({ grantId: "g-revoked", revokedAtMs: 9, automationsGeneration: 2 }),
        row({ grantId: "g-revoked-idle", revokedAtMs: 9 }),
        row({ grantId: "g-narrowed", access: "view", automationsGeneration: 1 }),
        row({ grantId: "g-editing", automationsGeneration: 1 }),
      ],
    });
    expect(listing).toEqual({
      grants: [
        { ...ana, grantId: "g-editing" },
        { ...ana, grantId: "g-narrowed", access: "view" },
      ],
      links: [],
      formerGrants: [
        { grant: { ...ana, grantId: "g-narrowed", access: "view" }, automationsGeneration: 1 },
        { grant: { ...ana, grantId: "g-revoked" }, automationsGeneration: 2 },
      ],
    });
    // A revoked grant that wrote automations but cannot be read, or says it
    // did and covers no files, fails closed.
    for (const damaged of [
      row({ revokedAtMs: 9, automationsGeneration: 1, selector: null, damaged: true, access: "unknown" }),
      row({ revokedAtMs: 9, automationsGeneration: 1, selector: { kind: "chat", channelWireId: "wire" }, access: "read-write" }),
      row({ revokedAtMs: 9, automationsGeneration: 1, selector: { paths: [], versionId: "v-1" } }),
      row({ automationsGeneration: 1, selector: { kind: "chat", channelWireId: "wire" }, access: "read-only" }),
    ]) {
      expect(await listed({ granted: [damaged] }), JSON.stringify(damaged))
        .toEqual({ grants: null, problem: { kind: "damaged-share", recipientEmail: "ana@dohc.test" } });
    }
    // A stored copy is read by the same rule.
    const entry: RegistryEntry = { workspaceId: WORKSPACE, rootPath: "/trip", kind: "personal", mode: "local-first", remote };
    const chat = { ...ana, selector: { kind: "chat" as const, channelWireId: "wire" }, access: "read-write" as const };
    expect(reachRosterFor({
      entry: { ...entry, shareRoster: { version: 1, grants: [], links: [], formerGrants: [{ grant: chat, automationsGeneration: 1 }] } },
      localUserId: null, latest: null, next: "",
    })).toEqual({ kind: "unknown", problem: { kind: "unchecked", next: "" } });
  });

  it("says the server needs an update when it lists this workspace's grants without their automations writes", async () => {
    const { automationsGeneration: _left, ...older } = row();
    expect(await listed({ granted: [older] })).toEqual({ grants: null, problem: { kind: "outdated-server" } });
    const { automationsGeneration: _other, ...elsewhere } = row({ workspaceId: "ws-other" });
    expect(await listed({ granted: [elsewhere, row()] })).toEqual({ grants: [ana], links: [], formerGrants: [] });
  });

  it("finds the evidence to hold a step after the owner revoked, from another computer, a recipient who wrote it", async () => {
    // Ana wrote Trip's automations directly; the owner revoked her on another
    // computer before this one pulled what she wrote.
    const listing = await listed({ granted: [row({ revokedAtMs: 9, automationsGeneration: 1 })] });
    const entry: RegistryEntry = { workspaceId: WORKSPACE, rootPath: "/trip", kind: "personal", mode: "local-first", remote };
    const roster = reachRosterFor({ entry, localUserId: null, latest: listing, next: "" });
    expect(roster).toEqual({
      kind: "owner", ownerUserId: "u-owner", grants: [],
      formerEditors: [{ grantId: "g-1", generation: 1, holder: "person", recipientEmail: "ana@dohc.test", files: { paths: ["Trip"], versionId: null } }],
    });
    const [reach] = checkAutomationReach(roster, {
      id: "spend", collection: { path: "Trip", name: "Trip" }, codeFiles: [],
      steps: [{ kind: "change-records", collection: { path: "Budget", name: "Budget" } }],
    });
    // Allowed for the editors left, with Ana as the evidence the executor holds it on.
    expect(reach).toEqual({ allowed: true, formerStops: [{ evidence: "g-1#1", name: "ana@dohc.test" }] });
  });

  it("keeps a revoked recipient the relay has no email for as a person, not a link", async () => {
    const listing = await listed({ granted: [row({ revokedAtMs: 9, automationsGeneration: 1, recipientEmail: null })] });
    const entry: RegistryEntry = { workspaceId: WORKSPACE, rootPath: "/trip", kind: "personal", mode: "local-first", remote };
    expect(reachRosterFor({ entry, localUserId: null, latest: listing, next: "" })).toMatchObject({
      formerEditors: [{ grantId: "g-1", holder: "person", recipientEmail: null }],
    });
  });

  it("calls a listing that is not the relay's shape unusable", async () => {
    for (const shares of [{ granted: "all" }, null, []]) {
      expect(await listed(shares)).toEqual({ grants: null, problem: { kind: "unusable-listing" } });
    }
  });
});

describe("listing from the relay", () => {
  const noLinks = { "/sync/ws-trip/shares/links": { status: 200, body: { links: [], formerGrants: [] } } };

  it("pages through share links", async () => {
    const get = relay({
      "/sync/shares": { status: 200, body: { ok: true, granted: [row()] } },
      "/sync/ws-trip/shares/links": { status: 200, body: { ok: true, links: [], nextCursor: "c 1" } },
      "/sync/ws-trip/shares/links?cursor=c%201": { status: 200, body: { ok: true, links: [link()] } },
    });
    const answer = await listRosterGrants(WORKSPACE, get);
    expect(answer.kind === "answered" && answer.listing.grants?.map((grant) => grant.grantId)).toEqual(["g-1", "g-dep"]);
    expect(answer.kind === "answered" && answer.listing.grants !== null && answer.listing.links.map((own) => own.grant.grantId))
      .toEqual(["g-link"]);
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
    expect(read({ version: 2, grants: [ana], links: [], formerGrants: [] })).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [anaOnRoster], formerEditors: [] });
    expect(read({ version: 2, grants: null, problem: { kind: "damaged-link" } }))
      .toEqual({ kind: "unknown", problem: { kind: "damaged-link" } });
    for (const damaged of [
      { ...ana, selector: { paths: [], versionId: null } },
      { ...ana, selector: { paths: ["../Budget"], versionId: null } },
      { ...ana, access: "read-write" },
      { ...ana, selector: { kind: "group", channelWireId: "wire", paths: [], versionId: null }, access: "read-write" },
      { ...ana, recipientUserId: null, recipientEmail: null },
    ]) {
      expect(read({ version: 2, grants: [damaged], links: [], formerGrants: [] }), JSON.stringify(damaged)).toEqual(unchecked);
    }
    expect(read({ version: 2, grants: null })).toEqual(unchecked);
  });

  it("makes each active link an editor of its own, and keeps a link that wrote automations directly and stopped editing", () => {
    const read = (links: unknown[]) => reachRosterFor({
      entry: { ...entry, remote, shareRoster: { version: 2, grants: [ana], links, formerGrants: [] } as RegistryEntry["shareRoster"] },
      localUserId: null, latest: null, next: "",
    });
    const onRoster = (grantId: string, access = "edit") =>
      ({ grantId, recipientUserId: null, recipientEmail: null, files: { paths: ["Trip"], versionId: null, access }, channel: null });
    expect(read([
      linkGrant("g-a"),
      linkGrant("g-b", { automationsGeneration: 3 }),
      linkGrant("g-ended", { ended: true, automationsGeneration: 3 }),
      linkGrant("g-narrowed", { automationsGeneration: 3, grant: { ...linkGrant("g-narrowed").grant, access: "comment" } }),
      linkGrant("g-view", { grant: { ...linkGrant("g-view").grant, access: "view" } }),
    ])).toEqual({
      kind: "owner", ownerUserId: "u-owner",
      grants: [anaOnRoster, onRoster("g-a"), onRoster("g-b"), onRoster("g-narrowed", "comment"), onRoster("g-view", "view")],
      formerEditors: [
        { grantId: "g-ended", generation: 3, holder: "link", recipientEmail: null, files: { paths: ["Trip"], versionId: null } },
        { grantId: "g-narrowed", generation: 3, holder: "link", recipientEmail: null, files: { paths: ["Trip"], versionId: null } },
      ],
    });
  });

  it("calls a copy saved before links were listed, or a link that names a person, unchecked", () => {
    const unchecked = { kind: "unknown", problem: { kind: "unchecked", next: "" } };
    const read = (shareRoster: unknown) =>
      reachRosterFor({ entry: { ...entry, remote, shareRoster: shareRoster as RegistryEntry["shareRoster"] }, localUserId: null, latest: null, next: "" });
    expect(read({ version: 2, grants: [ana] })).toEqual(unchecked);
    expect(read({ version: 2, grants: [], formerGrants: [], links: [linkGrant("g-a", { grant: { ...linkGrant("g-a").grant, recipientUserId: "u-ana" } })] }))
      .toEqual(unchecked);
    expect(read({ version: 2, grants: [], formerGrants: [], links: [{ ...linkGrant("g-a"), ended: undefined }] })).toEqual(unchecked);
  });

  it("prefers a listing it learned but could not save", () => {
    expect(reachRosterFor({
      entry: { ...entry, remote, shareRoster: { version: 1, grants: [ana], links: [], formerGrants: [] } }, localUserId: null, next: "",
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
  const cached = { kind: "owner", ownerUserId: "u-owner", grants: [anaOnRoster], formerEditors: [] };
  const unchecked = (next: string) => ({ kind: "unknown", problem: { kind: "unchecked", next } });

  // A roster listed before, with no pull since.
  function seed(): void {
    store.setShareRoster(WORKSPACE, { grants: [ana], links: [], formerGrants: [] }, false);
  }

  // The same registry file, read the way a restarted dohc reads it.
  function restart(): void {
    store = createRegistryStore(store.registryFile);
  }

  function rosters(
    listRoster: (workspace: RegistryEntry) => Promise<RosterAnswer>,
    save = store.setShareRoster,
    markRosterPulled = store.markShareRosterPulled,
  ) {
    const logError = vi.fn();
    const list = vi.fn(listRoster);
    const saveRoster = vi.fn(save);
    return {
      list, logError, saveRoster,
      rosters: createShareRosters({
        findWorkspace: store.find, saveRoster, markRosterPulled, listRoster: list,
        localUserId: async () => null, logError, nowMs: () => now,
      }),
    };
  }

  it("lists at open and every 10 minutes while open, and stops at close", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [] }));
    r.open(WORKSPACE);
    r.open(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(1);
    await r.forRun(WORKSPACE);
    expect(store.find(WORKSPACE)?.shareRoster).toMatchObject({ version: 1, grants: [ana], links: [], formerGrants: [] });

    vi.advanceTimersByTime(SHARE_ROSTER_REFRESH_MS);
    expect(list).toHaveBeenCalledTimes(2);
    r.close(WORKSPACE);
    vi.advanceTimersByTime(SHARE_ROSTER_REFRESH_MS * 3);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("shows the cached roster without listing; a run refreshes after a pull", async () => {
    seed();
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [] }));
    expect(await r.cached(WORKSPACE)).toEqual(cached);
    r.pullStarting(WORKSPACE)();
    expect(await r.cached(WORKSPACE)).toEqual(cached);
    expect(list).not.toHaveBeenCalled();
    // A run lists first, and the listing clears the pull.
    expect(await r.forRun(WORKSPACE)).toEqual(cached);
    expect(await r.cached(WORKSPACE)).toEqual(cached);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("lists again before a run only when the last listing is older than a minute", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [] }));
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

  it("keeps the cache while this computer sends no pull", async () => {
    seed();
    const { rosters: r } = rosters(async () => failing);
    expect(await r.forRun(WORKSPACE)).toEqual(cached);
    for (let minute = 1; minute <= 3; minute += 1) {
      now += SHARE_ROSTER_FRESH_MS;
      expect(await r.forRun(WORKSPACE), `minute ${minute}`).toEqual(cached);
    }
    expect(store.find(WORKSPACE)?.shareRoster?.pulledAfter).toBeUndefined();
  });

  it("records a pull before it starts, so one that never reports back still counts", async () => {
    seed();
    const { rosters: r } = rosters(async () => failing);
    // The pull starts and its result never arrives: the engine may have
    // applied a page, and the desktop never hears of it.
    r.pullStarting(WORKSPACE);
    expect(store.find(WORKSPACE)?.shareRoster?.pulledAfter).toBe(true);
    expect(await r.forRun(WORKSPACE)).toEqual(unchecked(failing.next));
  });

  it("keeps the mark across a restart, so a claim that runs before any listing answers sees it", async () => {
    const before = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [] }));
    await before.rosters.forRun(WORKSPACE);
    before.rosters.pullStarting(WORKSPACE);
    restart();
    const { rosters: after } = rosters(async () => offline);
    expect(await after.forRun(WORKSPACE)).toEqual(unchecked(offline.next));
  });

  it("uses the cache after a restart when no pull followed the listing", async () => {
    const before = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [] }));
    await before.rosters.forRun(WORKSPACE);
    restart();
    const { rosters: after } = rosters(async () => offline);
    expect(await after.forRun(WORKSPACE)).toEqual(cached);
  });

  it("does not depend on the clock", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [] }));
    await r.forRun(WORKSPACE);
    now -= 60 * 60_000;
    r.pullStarting(WORKSPACE)();
    list.mockImplementation(async () => failing);
    now += 2 * 60 * 60_000;
    expect(await r.forRun(WORKSPACE)).toEqual(unchecked(failing.next));
  });

  it("refuses the pull when the mark cannot be saved, and names the write", async () => {
    seed();
    let fail = true;
    const { rosters: r } = rosters(async () => failing, store.setShareRoster, (id) => {
      if (fail) throw new Error("disk full");
      store.markShareRosterPulled(id);
    });
    expect(() => r.pullStarting(WORKSPACE)).toThrow(
      "dohc did not pull because it could not save the share roster's pull mark to the workspace registry: disk full",
    );
    const diskFull = unchecked("Check that your disk has free space, then try again.");
    expect(await r.forRun(WORKSPACE)).toEqual(diskFull);
    expect(await r.forRun(WORKSPACE), "the write failure resolved itself").toEqual(diskFull);
    // A mark that saves resolves it. The listing still fails after a pull.
    fail = false;
    r.pullStarting(WORKSPACE)();
    expect(await r.forRun(WORKSPACE)).toEqual(unchecked(failing.next));
  });

  it("resolves a failed mark write when a listing answers", async () => {
    seed();
    const { list, rosters: r } = rosters(async () => failing, store.setShareRoster, () => {
      throw new Error("disk full");
    });
    expect(() => r.pullStarting(WORKSPACE)).toThrow("disk full");
    list.mockImplementation(async () => answered({ grants: [ana], links: [], formerGrants: [] }));
    expect(await r.forRun(WORKSPACE)).toEqual(cached);
  });

  it("lists once more when a pull lands while the listing a run waits on is running", async () => {
    const first = deferred<RosterAnswer>();
    const { list, rosters: r } = rosters(() => first.promise);
    r.open(WORKSPACE);
    const run = r.forRun(WORKSPACE);
    // A pull lands during that listing, and may bring a new editor's change.
    r.pullStarting(WORKSPACE)();
    list.mockImplementation(async () => answered({ grants: [ana], links: [], formerGrants: [] }));
    first.resolve(answered({ grants: [], links: [], formerGrants: [] }));
    expect(await run, "the run used a listing a pull overlapped").toEqual(cached);
    expect(list).toHaveBeenCalledTimes(2);

    // When a pull overlaps that listing too, this run gets no roster.
    const third = deferred<RosterAnswer>();
    const fourth = deferred<RosterAnswer>();
    list.mockImplementationOnce(() => third.promise).mockImplementationOnce(() => fourth.promise);
    now += SHARE_ROSTER_FRESH_MS;
    const busy = r.forRun(WORKSPACE);
    r.pullStarting(WORKSPACE)();
    third.resolve(answered({ grants: [], links: [], formerGrants: [] }));
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(4));
    r.pullStarting(WORKSPACE)();
    fourth.resolve(answered({ grants: [], links: [], formerGrants: [] }));
    expect(await busy).toEqual(unchecked("Try again in a moment."));
  });

  it("lists again before a run when a pull followed the listing, and only while the relay answers", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [] }));
    await r.forRun(WORKSPACE);
    await r.forRun(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(1);
    r.pullStarting(WORKSPACE)();
    expect(await r.forRun(WORKSPACE)).toEqual(cached);
    expect(list, "a run used a listing a pull followed").toHaveBeenCalledTimes(2);
    await r.forRun(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(2);

    // Once listings fail, retries keep their pace of once a minute.
    list.mockImplementation(async () => failing);
    now += SHARE_ROSTER_FRESH_MS;
    r.pullStarting(WORKSPACE)();
    expect(await r.forRun(WORKSPACE)).toEqual(unchecked(failing.next));
    r.pullStarting(WORKSPACE)();
    expect(await r.forRun(WORKSPACE)).toEqual(unchecked(failing.next));
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("clears the mark when the next listing answers, unless a pull ran during it", async () => {
    seed();
    const { list, saveRoster, rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [] }));
    r.pullStarting(WORKSPACE)();
    expect(await r.forRun(WORKSPACE)).toEqual(cached);
    expect(store.find(WORKSPACE)?.shareRoster?.pulledAfter).toBeUndefined();

    // A pull that is still running when a listing starts may fetch past it,
    // and it runs through the run's second listing too.
    const ended = r.pullStarting(WORKSPACE);
    now += SHARE_ROSTER_FRESH_MS;
    expect(await r.forRun(WORKSPACE)).toEqual(unchecked("Try again in a moment."));
    expect(store.find(WORKSPACE)?.shareRoster?.pulledAfter).toBe(true);
    ended();

    // So may a pull that starts while the listing waits for its answer. The
    // run lists once more, and that listing clears the mark.
    const answer = deferred<RosterAnswer>();
    list.mockImplementationOnce(() => answer.promise);
    now += SHARE_ROSTER_FRESH_MS;
    const run = r.forRun(WORKSPACE);
    r.pullStarting(WORKSPACE)();
    answer.resolve(answered({ grants: [ana], links: [], formerGrants: [] }));
    expect(await run).toEqual(cached);
    expect(saveRoster.mock.calls.at(-2)?.[2], "the overlapped listing saved without its mark").toBe(true);
    expect(store.find(WORKSPACE)?.shareRoster?.pulledAfter).toBeUndefined();
  });

  it("marks a listing it could not save yet", async () => {
    let fail = true;
    const { rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [] }), (id, listing, pulledAfter) => {
      if (fail) throw new Error("disk full");
      store.setShareRoster(id, listing, pulledAfter);
    });
    await r.forRun(WORKSPACE);
    expect(() => r.pullStarting(WORKSPACE), "a pull ran with its mark unsaved").toThrow("disk full");
    fail = false;
    r.pullStarting(WORKSPACE)();
    expect(store.find(WORKSPACE)?.shareRoster).toMatchObject({ grants: [ana], links: [], pulledAfter: true });
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
    const { list, rosters: r } = rosters(async () => answered({ grants: [], links: [], formerGrants: [] }), (id, listing, pulledAfter) => {
      if (fail) throw new Error("disk full");
      store.setShareRoster(id, listing, pulledAfter);
    });
    expect(await r.forRun(WORKSPACE)).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [], formerEditors: [] });
    expect(store.find(WORKSPACE)?.shareRoster?.grants).toEqual([ana]);
    fail = false;
    expect(await r.forRun(WORKSPACE)).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [], formerEditors: [] });
    expect(list, "the retry listed again instead of saving what it knew").toHaveBeenCalledTimes(1);
    expect(store.find(WORKSPACE)?.shareRoster).toMatchObject({ version: 2, grants: [], links: [], formerGrants: [] });
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
    list.mockImplementation(async () => answered({ grants: [ana], links: [], formerGrants: [] }));
    await r.pulled(WORKSPACE, false);
    expect(list).toHaveBeenCalledTimes(3);
    now += SHARE_ROSTER_FRESH_MS;
    await r.pulled(WORKSPACE, false);
    expect(list, "a pass listed again after a listing answered").toHaveBeenCalledTimes(3);
    expect(store.find(WORKSPACE)?.shareRoster).toMatchObject({ version: 1, grants: [ana], links: [], formerGrants: [] });
  });

  it("lists when sync recovers, at most once a minute", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [] }));
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
    list.mockImplementation(async () => answered({ grants: [ana], links: [], formerGrants: [] }));
    first.resolve(answered({ grants: [], links: [], formerGrants: [] }));
    await r.forRun(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(2);
    expect(store.find(WORKSPACE)?.shareRoster).toMatchObject({ version: 2, grants: [ana], links: [], formerGrants: [] });
  });

  it("refreshes every open workspace when a change names none", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [], links: [], formerGrants: [] }));
    r.open(WORKSPACE);
    await r.forRun(WORKSPACE);
    r.sharesChanged(null);
    await r.forRun(WORKSPACE);
    expect(list.mock.calls.map(([workspace]) => workspace.workspaceId)).toEqual([WORKSPACE, WORKSPACE]);
  });

  it("lists nothing for a workspace that does not sync, whose owner is this computer's person", async () => {
    store.register({ workspaceId: "ws-local", rootPath: "/local", kind: "personal", mode: "local-first" });
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [] }));
    r.open("ws-local");
    expect(await r.forRun("ws-local")).toEqual({ kind: "owner", ownerUserId: null, grants: [] });
    expect(list).not.toHaveBeenCalled();
  });
});

describe("a direct write's author in History", () => {
  const grant = (grantId: string, recipientUserId: string | null, recipientEmail: string | null, access: "view" | "edit") =>
    ({ grantId, recipientUserId, recipientEmail, selector: { paths: ["trip"], versionId: null }, access }) as ListedGrant;
  const roster = { version: 1, grants: [grant("g-1", "ana", "ana@example.com", "edit"), grant("g-2", "ben", "ben@example.com", "view")], links: [], formerGrants: [] };

  it("names the person and the level of the grant they wrote through", () => {
    expect(rosterAuthorLabel(roster, { userId: "ana", grantId: "g-1" })).toBe("ana@example.com (Edit)");
  });

  it("names the person without a level when that grant is gone", () => {
    expect(rosterAuthorLabel(roster, { userId: "ben", grantId: "revoked" })).toBe("ben@example.com");
  });

  it("names nobody it cannot match", () => {
    expect(rosterAuthorLabel(roster, { userId: "cy", grantId: "revoked" })).toBe("Someone you shared with");
    expect(rosterAuthorLabel(roster, { userId: "cy", grantId: "g-1" })).toBe("Someone you shared with");
    expect(rosterAuthorLabel(undefined, { userId: "ana", grantId: "g-1" })).toBe("Someone you shared with");
    expect(rosterAuthorLabel({ version: 1, grants: null, problem: { kind: "unusable-listing" } }, { userId: "ana", grantId: "g-1" }))
      .toBe("Someone you shared with");
  });
});
