import { historyCursor, historyPageFields, neutralHistoryPresentations } from "../testing/historyPageFixture";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { createRegistryStore, type RegistryEntry } from "../workspaces/registryStore";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { checkAutomationReach, type ReachStep } from "@dohc/automation-executor/automation-reach";
import { readSyncHistory, recordNeverSynced, recordSynced } from "../workspaces/syncHistory";
import { createTestScratch } from "../workspaces/testTemp";
import {
  listRosterGrants,
  lookupHistoryAccounts,
  readStoredRoster,
  type ListedGrant,
  type ListedLink,
  type RosterAnswer,
  type RosterListing,
} from "@dohc/automation-executor/roster-listing";
import {
  createShareRosters,
  createHistoryLabels,
  reachRosterFor,
  rosterAuthorLabel,
  rosterPersonLabel,
  SHARE_ROSTER_FRESH_MS,
  SHARE_ROSTER_REFRESH_MS,
} from "./shareRoster";
import { listEngineMomentsForIpc } from "../ipc/engineHistoryIpc";

const WORKSPACE = "ws-trip";

it.each(["Mira", null, ""])("names the received share's owner from relay identity (name %s)", sharerName => {
  const shareView = { granterUserId: "u-owner", sharerName, granterEmail: "mira@example.test" };
  const lookupAccounts = vi.fn();
  const names = createHistoryLabels({
    snapshot: () => ({ roster: null, owner: false, shareView, context: "recipient", inventory: undefined }),
    lookupAccounts,
  });
  names.prepare(WORKSPACE, [{ userId: "u-owner" }, { userId: "someone-else" }]);
  expect.soft(names.person(WORKSPACE, "u-owner")).toBe(sharerName || "mira@example.test");
  expect(names.person(WORKSPACE, "someone-else")).toBe("Someone you shared with");
  expect(lookupAccounts).not.toHaveBeenCalled();
  // An old identity has no verified owner id until its next refresh.
  shareView.granterUserId = "";
  expect(names.person(WORKSPACE, "u-owner")).toBe("Someone you shared with");
});
const remote = { serverUrl: "https://server.dohc.test", ownerUserId: "u-owner" };

const facts = { shareId: "s-1", generation: 1, status: "active" as const, granterUserId: "u-owner",
  granterEmail: null, subjectName: null, sharerName: null };
const { granterUserId, granterEmail, ...linkFacts } = facts;

function row(overrides: Record<string, unknown> = {}) {
  return {
    ...facts, status: overrides.revokedAtMs ? "revoked" : "active", shareId: "s-1", workspaceId: WORKSPACE, grantId: "g-1", principalKind: "user", generation: 1,
    recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", createdAtMs: 1, revokedAtMs: null,
    selector: { paths: ["Trip"], versionId: null }, access: "edit", automationsGeneration: null, ...overrides,
  };
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    ...linkFacts, grantId: "g-link", status: "active", selector: { paths: ["Trip"], versionId: null }, access: "edit", automationsGeneration: null,
    dependents: [{ grantId: "g-dep", recipientUserId: "u-ben", recipientEmail: "ben@dohc.test", access: "edit", generation: 1, createdAtMs: 1 }],
    ...overrides,
  };
}

// A link's own grant, as the listing keeps it.
function linkGrant(grantId: string, overrides: Record<string, unknown> = {}) {
  return {
    grant: { ...facts, status: overrides.ended ? "revoked" : "active", grantId, recipientUserId: null, recipientEmail: null, selector: { paths: ["Trip"], versionId: null }, access: "edit" },
    ended: false, automationsGeneration: null, ...overrides,
  } as ListedLink;
}

const ana: ListedGrant = {
  ...facts,
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
    return page.body !== null && typeof page.body === "object" && "granted" in page.body
      ? { ...page, body: { granterUserId, granterEmail, ...page.body } } : page;
  });
}

// The listing for one /sync/shares body and one page of links.
async function listed(shares: unknown, links: unknown[] = []): Promise<RosterListing> {
  const answer = await listRosterGrants(WORKSPACE, relay({
    "/sync/shares?workspaceId=ws-trip": { status: 200, body: shares },
    "/sync/ws-trip/shares/links": { status: 200, body: { ok: true, links } },
  }));
  if (answer.kind !== "answered") throw new Error("the relay answered every request");
  return answer.listing;
}

it("keeps paused owner reach and cached recipients instead of treating it as reattached", async () => {
  const listing = await listed({ granted: [row()] });
  const entry: RegistryEntry = { workspaceId: WORKSPACE, rootPath: "/trip", kind: "personal", mode: "local-first",
    pausedRemote: remote, shareRoster: { ...listing, version: 1, listedAtMs: 42 } };
  const roster = reachRosterFor({ entry, localUserId: null, localPersonId: null, history: "synced", latest: null, next: "" });
  expect(roster).toMatchObject({ kind: "owner", ownerUserId: "u-owner", grants: [anaOnRoster] });
  const [reach] = checkAutomationReach(roster, { id: "local", collection: { path: "Trip", name: "Trip" }, codeFiles: [],
    steps: [{ kind: "change-records", collection: { path: "Trip", name: "Trip" } }] });
  expect(reach.allowed).toBe(true);
});

describe("roster from the relay's listings", () => {
  it("loads missing History names once per inventory without fetching known names or changing the roster", async () => {
    const roster = await listed({ granted: [row()] });
    const before = JSON.stringify(roster);
    let inventory = 1;
    const hold = deferred<Awaited<ReturnType<typeof lookupHistoryAccounts>>>();
    const lookupAccounts = vi.fn(() => hold.promise);
    const names = createHistoryLabels({ snapshot: () => ({ roster, owner: true, context: "window", inventory }), lookupAccounts });
    await names.prepare(WORKSPACE, [{ userId: "u-ana", grantId: "g-1" }]);
    expect(lookupAccounts).not.toHaveBeenCalled();
    const author = { userId: "u-ben", grantId: "g-dep" };
    const first = names.prepare(WORKSPACE, [author]);
    const second = names.prepare(WORKSPACE, [author]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(lookupAccounts).toHaveBeenCalledTimes(1);
    hold.resolve([{ ...author, recipientUserId: author.userId, recipientEmail: "Ben", parentGrantId: "g-link" }]);
    await Promise.all([first, second]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(names.author(WORKSPACE, author)).toBe("Ben (via share link)");
    await names.prepare(WORKSPACE, [author]);
    expect(lookupAccounts).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(roster)).toBe(before);
    inventory++;
    await names.prepare(WORKSPACE, [author]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(lookupAccounts).toHaveBeenCalledTimes(2);
    names.invalidate(WORKSPACE);
    await names.prepare(WORKSPACE, [author]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(lookupAccounts).toHaveBeenCalledTimes(3);
  });

  it("isolates History caches and discards responses after account or attachment changes", async () => {
    const roster = await listed({ granted: [] });
    const hold = deferred<Awaited<ReturnType<typeof lookupHistoryAccounts>>>();
    let context = "first-account";
    const lookupAccounts = vi.fn(() => hold.promise);
    const names = createHistoryLabels({ snapshot: () => ({ roster, owner: true, context, inventory: 1 }), lookupAccounts });
    const author = { userId: "u-ben", grantId: "g-dep" };
    const pending = names.prepare(WORKSPACE, [author]);
    await new Promise<void>(resolve => setImmediate(resolve));
    context = "next-account";
    hold.resolve([{ ...author, recipientUserId: author.userId, recipientEmail: "Ben", parentGrantId: "g-link" }]);
    await pending;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(names.author(WORKSPACE, author)).toBe("Someone you shared with");
    await names.prepare("another-workspace", [author]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(names.author("another-workspace", author)).toBe("Ben (via share link)");
    expect(names.author(WORKSPACE, author)).toBe("Someone you shared with");
  });

  it("keeps holder data owner-only and retries unavailable History lookups", async () => {
    const roster = await listed({ granted: [] });
    let owner = false;
    const lookupAccounts = vi.fn(async () => null);
    const names = createHistoryLabels({ snapshot: () => ({ roster, owner, context: "window", inventory: 1 }), lookupAccounts });
    const author = { userId: "u-ben", grantId: "g-dep" };
    await names.prepare(WORKSPACE, [author]);
    expect(lookupAccounts).not.toHaveBeenCalled();
    owner = true;
    names.prepare(WORKSPACE, [author]);
    await new Promise<void>(resolve => setImmediate(resolve));
    names.prepare(WORKSPACE, [author]);
    expect(lookupAccounts).toHaveBeenCalledTimes(1);
    expect(names.author(WORKSPACE, author)).toBe("Someone you shared with");
  });
  it("marks an active link holder's History label as their own choice", async () => {
    const listing = await listed({ granted: [] }, [link()]);
    expect(rosterAuthorLabel(listing, { userId: "u-ben", grantId: "g-dep" })).toBe("ben@dohc.test (Edit)");
    expect(rosterPersonLabel(listing, "u-ben")).toBe("ben@dohc.test");
  });
  it.each([null, 3])("names an ended link holder in History without current access (automations generation %s)", async (automationsGeneration) => {
    const listing = await listed({ granted: [] });
    const get = relay({ "/sync/ws-trip/shares/links?historyGrantId=g-dep": { status: 200, body: { holders: [{ grantId: "g-dep", recipientUserId: "u-ben", recipientEmail: "Ben", parentGrantId: "g-link" }] } } });
    const names = createHistoryLabels({ snapshot: () => ({ roster: listing, owner: true, context: "window", inventory: 1 }),
      lookupAccounts: (_workspaceId, ids) => lookupHistoryAccounts(WORKSPACE, get, ids) });
    expect(get).not.toHaveBeenCalled();
    expect(listing.grants).toEqual([]);
    expect(reachRosterFor({ entry: { workspaceId: WORKSPACE, rootPath: "/trip", kind: "personal", mode: "local-first", remote },
      localUserId: null, localPersonId: null, history: null, latest: listing, next: "" }))
      .toMatchObject({ kind: "owner", grants: [], formerEditors: [] });
    const readHistory = () => listEngineMomentsForIpc(async () => ({
      moments: [{ id: "m-ended", workspaceId: WORKSPACE, versionId: "main", objectId: "o-1", path: "Trip/a.md", recordedAtMs: 1,
        operation: "write", metadata: { origin: "sync" }, momentOrder: 0, protected: false,
        authors: [{ kind: "named", userId: "u-ben", grantId: "g-dep", grantGeneration: 1 }] }],
      nextCursor: null, latestMomentOrder: 0, activeVersionId: "main", ...historyPageFields,
    }), { agent: () => undefined, person: () => undefined, automation: () => null, presentations: neutralHistoryPresentations,
      prepare: authors => names.prepare(WORKSPACE, authors.filter(author => author.kind === "named")), named: author => names.author(WORKSPACE, author) });
    const immediate = await readHistory();
    expect(immediate).toMatchObject({ moments: [{ namedAuthor: { label: "Someone you shared with" } }] });
    await new Promise<void>(resolve => setImmediate(resolve));
    const history = await readHistory();
    expect(history).toMatchObject({ moments: [{ namedAuthor: { label: "Ben (via share link)" } }] });
    expect(names.person(WORKSPACE, "u-ben")).toBe("Ben (via share link)");
    expect(listing.grants !== null && listing.endedGrants).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("names an author missing from the roster on a moment several people wrote once the lookup finishes", async () => {
    const listing = await listed({ granted: [row()] });
    const get = relay({ "/sync/ws-trip/shares/links?historyGrantId=g-dep": { status: 200, body: { holders: [{ grantId: "g-dep", recipientUserId: "u-ben", recipientEmail: "ben@dohc.test", parentGrantId: "g-link" }] } } });
    const names = createHistoryLabels({ snapshot: () => ({ roster: listing, owner: true, context: "window", inventory: 1 }),
      lookupAccounts: (_workspaceId, ids) => lookupHistoryAccounts(WORKSPACE, get, ids) });
    const readHistory = () => listEngineMomentsForIpc(async () => ({
      moments: [{ id: "m-both", workspaceId: WORKSPACE, versionId: "main", objectId: "o-1", path: "Trip/a.md", recordedAtMs: 1,
        operation: "write", metadata: { origin: "sync" }, momentOrder: 0, protected: false,
        authors: [
          { kind: "named", userId: "u-ana", grantId: "g-1", grantGeneration: 1 },
          { kind: "agent", agentId: "agent" },
          { kind: "named", userId: "u-ben", grantId: "g-dep", grantGeneration: 1 },
        ] }],
      nextCursor: null, latestMomentOrder: 0, activeVersionId: "main", ...historyPageFields,
    }), { agent: () => undefined, person: () => undefined, automation: () => null, presentations: neutralHistoryPresentations,
      prepare: authors => names.prepare(WORKSPACE, authors.filter(author => author.kind === "named")), named: author => names.author(WORKSPACE, author) });
    expect(await readHistory()).toMatchObject({ moments: [{ authorLabels: ["ana@dohc.test (Edit)", "Agent", "Someone you shared with"] }] });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(await readHistory()).toMatchObject({ moments: [{ authorLabels: ["ana@dohc.test (Edit)", "Agent", "ben@dohc.test (via share link)"] }] });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("keeps the owner's active grants on this workspace, and only the person of a revoked one", async () => {
    const group = { kind: "group", channelWireId: "wire-trip", paths: ["Trip"], versionId: null };
    const listing = await listed({
      ok: true,
      granted: [
        row({ grantId: "g-5" }),
        row({ grantId: "g-revoked", revokedAtMs: 9 }),
        row({ grantId: "g-link", principalKind: "link", recipientUserId: null, recipientEmail: null }),
        row({ grantId: "g-4", principalKind: "email", recipientUserId: null, recipientEmail: "cai@dohc.test", access: "view" }),
        row({ grantId: "g-3", selector: group, access: "read-write", fileScope: "served" }),
        row({ grantId: "g-2", selector: group, access: "read-only", fileScope: "served" }),
        row({ grantId: "g-1", selector: { kind: "chat", channelWireId: "wire-family" }, access: "read-write" }),
        row({ grantId: "g-6", selector: { paths: [], versionId: "v-1" }, access: "edit" }),
      ],
      received: [row({ grantId: "g-received", workspaceId: undefined })],
    });
    expect(listing.grants?.map((grant) => grant.grantId)).toEqual(["g-1", "g-2", "g-3", "g-4", "g-5", "g-6"]);
    // The revoked grant stays only as its person, which reach below never reads.
    expect(listing.grants !== null && listing.endedGrants)
      .toEqual([{ ...facts, status: "revoked", grantId: "g-revoked", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test" }]);
    const entry: RegistryEntry = { workspaceId: WORKSPACE, rootPath: "/trip", kind: "personal", mode: "local-first", remote };
    expect(reachRosterFor({ entry, localUserId: null, localPersonId: null, history: null, latest: listing, next: "" })).toEqual({
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

  it("lists each active link as its own grant, and every active link's dependents like named grants", async () => {
    expect(await listed({ granted: [] }, [
      link(),
      link({ grantId: "g-view", access: "view", dependents: [] }),
      link({ grantId: "g-comment", access: "comment", dependents: [] }),
      link({ grantId: "g-revoked", status: "revoked" }),
      link({ grantId: "g-revoked-damaged", status: "revoked", selector: null, access: "unknown" }),
    ])).toEqual({
      grants: [{
        ...facts, grantId: "g-dep", recipientUserId: "u-ben", recipientEmail: "ben@dohc.test",
        selector: { paths: ["Trip"], versionId: null }, access: "edit",
      }],
      links: [linkGrant("g-comment", { grant: { ...linkGrant("g-comment").grant, access: "comment" } }),
        linkGrant("g-link"), linkGrant("g-view", { grant: { ...linkGrant("g-view").grant, access: "view" } })],
      formerGrants: [], endedGrants: [],
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
      formerGrants: [], endedGrants: [],
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

  it("refuses a row with another workspace or no workspace", async () => {
    expect(await listed({
      granted: [
        row({ grantId: "g-2", selector: null, damaged: true, revokedAtMs: 5 }),
        row({ grantId: "g-3", workspaceId: "ws-other", selector: null, damaged: true, access: 7, principalKind: 3, revokedAtMs: "no" }),
        row(),
      ],
    })).toEqual({ grants: null, problem: { kind: "unusable-listing" } });
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
    const stored = { version: 1, listedAtMs: 0, grants: null, problem: { kind: "outdated-server" } } as const;
    expect(reachRosterFor({ entry: { ...entry, shareRoster: stored }, localUserId: null, localPersonId: null, history: null, latest: null, next: "" }))
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
        { grant: { ...ana, status: "revoked", grantId: "g-revoked" }, automationsGeneration: 2 },
      ],
      // A revoked grant that never wrote automations names its person for History only.
      endedGrants: [{ ...facts, status: "revoked", grantId: "g-revoked-idle", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test" }],
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
      entry: { ...entry, shareRoster: { version: 1, listedAtMs: 0, grants: [], links: [], formerGrants: [{ grant: chat, automationsGeneration: 1 }], endedGrants: [] } },
      localUserId: null, localPersonId: null, history: null, latest: null, next: "",
    })).toEqual({ kind: "unknown", problem: { kind: "unchecked", next: "" } });
  });

  it("says the server needs an update when it lists this workspace's grants without their automations writes", async () => {
    const { automationsGeneration: _left, ...older } = row();
    expect(await listed({ granted: [older] })).toEqual({ grants: null, problem: { kind: "outdated-server" } });
    const { automationsGeneration: _other, ...elsewhere } = row({ workspaceId: "ws-other" });
    expect(await listed({ granted: [elsewhere, row()] })).toEqual({ grants: null, problem: { kind: "unusable-listing" } });
  });

  it("finds the evidence to hold a step after the owner revoked, from another computer, a recipient who wrote it", async () => {
    // Ana wrote Trip's automations directly; the owner revoked her on another
    // computer before this one pulled what she wrote.
    const listing = await listed({ granted: [row({ revokedAtMs: 9, automationsGeneration: 1 })] });
    const entry: RegistryEntry = { workspaceId: WORKSPACE, rootPath: "/trip", kind: "personal", mode: "local-first", remote };
    const roster = reachRosterFor({ entry, localUserId: null, localPersonId: null, history: null, latest: listing, next: "" });
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
    expect(reachRosterFor({ entry, localUserId: null, localPersonId: null, history: null, latest: listing, next: "" })).toMatchObject({
      formerEditors: [{ grantId: "g-1", holder: "person", recipientEmail: null }],
    });
  });

  it("calls a listing that is not the relay's shape unusable", async () => {
    for (const shares of [{ granted: "all" }, null, []]) {
      expect(await listed(shares)).toEqual({ grants: null, problem: { kind: "unusable-listing" } });
    }
  });
});

describe("the roster the reach check reads", () => {
  const entry: RegistryEntry = { workspaceId: WORKSPACE, rootPath: "/trip", kind: "personal", mode: "local-first" };

  it("gives a workspace that does not sync only its owner, signed in or not", () => {
    expect(reachRosterFor({ entry, localUserId: "u-local", localPersonId: null, history: "never-synced", latest: null, next: "" }))
      .toEqual({ kind: "owner", ownerUserId: "u-local", grants: [] });
    expect(reachRosterFor({ entry, localUserId: null, localPersonId: null, history: "never-synced", latest: null, next: "" }))
      .toEqual({ kind: "owner", ownerUserId: null, grants: [] });
  });

  it("names this computer's person by its own id for them only in a workspace that does not sync", () => {
    expect(reachRosterFor({ entry, localUserId: null, localPersonId: "install-here", history: "never-synced", latest: null, next: "" }))
      .toEqual({ kind: "owner", ownerUserId: null, localPersonId: "install-here", grants: [] });
    expect(reachRosterFor({
      entry: { ...entry, remote, shareRoster: { version: 1, listedAtMs: 0, grants: [], links: [], formerGrants: [], endedGrants: [] } }, localUserId: null, localPersonId: "install-here", history: null, latest: null, next: "",
    })).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [], formerEditors: [] });
  });

  it("does not know who can edit a workspace that synced but has no server connection in the registry", () => {
    const syncAgain = { kind: "unknown", problem: { kind: "unchecked", next: "Sync this workspace in Settings → Sync and sharing, then try again." } };
    expect(reachRosterFor({ entry, localUserId: "u-owner", localPersonId: null, history: "synced", latest: null, next: "" })).toEqual(syncAgain);
    // A record dohc cannot read or parse may say it synced.
    expect(reachRosterFor({ entry, localUserId: "u-owner", localPersonId: null, history: "unknown", latest: null, next: "" })).toEqual(syncAgain);
    // A folder with no record keeps its owner, as before the record existed.
    expect(reachRosterFor({ entry, localUserId: "u-owner", localPersonId: null, history: "absent", latest: null, next: "" }))
      .toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [] });
  });

  it("knows only the Collection itself on a collaborator's computer", () => {
    const shareView = {
      shareId: "s-1", granterEmail: "owner@dohc.test", genericChatWritable: false,
      grantedSelector: { paths: ["Trip"], versionId: null, access: "edit" as const },
    };
    expect(reachRosterFor({ entry: { ...entry, remote, shareView }, localUserId: "u-ana", localPersonId: null, history: null, latest: null, next: "" }))
      .toEqual({ kind: "shared-view" });
  });

  it("reads the stored grants with the relay's rules, and calls a copy it cannot read unchecked", () => {
    const next = "Check your connection, then try again.";
    const unchecked = { kind: "unknown", problem: { kind: "unchecked", next } };
    const read = (shareRoster: unknown) =>
      reachRosterFor({ entry: { ...entry, remote, shareRoster: shareRoster as RegistryEntry["shareRoster"] }, localUserId: null, localPersonId: null, history: null, latest: null, next });
    expect(reachRosterFor({ entry: { ...entry, remote }, localUserId: null, localPersonId: null, history: null, latest: null, next })).toEqual(unchecked);
    expect(read({ version: 2, listedAtMs: 0, grants: [ana], links: [], formerGrants: [], endedGrants: [] })).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [anaOnRoster], formerEditors: [] });
    expect(read({ version: 2, listedAtMs: 0, grants: null, problem: { kind: "damaged-link" } }))
      .toEqual({ kind: "unknown", problem: { kind: "damaged-link" } });
    for (const damaged of [
      { ...ana, selector: { paths: [], versionId: null } },
      { ...ana, selector: { paths: ["../Budget"], versionId: null } },
      { ...ana, access: "read-write" },
      { ...ana, selector: { kind: "group", channelWireId: "wire", paths: [], versionId: null }, access: "read-write" },
      { ...ana, recipientUserId: null, recipientEmail: null },
    ]) {
      expect(read({ version: 2, listedAtMs: 0, grants: [damaged], links: [], formerGrants: [], endedGrants: [] }), JSON.stringify(damaged)).toEqual(unchecked);
    }
    expect(read({ version: 2, listedAtMs: 0, grants: null })).toEqual(unchecked);
  });

  it("makes each active link an editor of its own, and keeps a link that wrote automations directly and stopped editing", () => {
    const read = (links: unknown[]) => reachRosterFor({
      entry: { ...entry, remote, shareRoster: { version: 2, listedAtMs: 0, grants: [ana], links, formerGrants: [], endedGrants: [] } as RegistryEntry["shareRoster"] },
      localUserId: null, localPersonId: null, history: null, latest: null, next: "",
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
      reachRosterFor({ entry: { ...entry, remote, shareRoster: shareRoster as RegistryEntry["shareRoster"] }, localUserId: null, localPersonId: null, history: null, latest: null, next: "" });
    expect(read({ version: 2, listedAtMs: 0, grants: [ana] })).toEqual(unchecked);
    expect(read({ version: 2, listedAtMs: 0, grants: [], formerGrants: [], endedGrants: [], links: [linkGrant("g-a", { grant: { ...linkGrant("g-a").grant, recipientUserId: "u-ana" } })] }))
      .toEqual(unchecked);
    expect(read({ version: 2, listedAtMs: 0, grants: [], formerGrants: [], endedGrants: [], links: [{ ...linkGrant("g-a"), ended: undefined }] })).toEqual(unchecked);
  });

  it("prefers a listing it learned but could not save", () => {
    expect(reachRosterFor({
      entry: { ...entry, remote, shareRoster: { version: 1, listedAtMs: 0, grants: [ana], links: [], formerGrants: [], endedGrants: [] } }, localUserId: null, localPersonId: null, history: null, next: "",
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
    store.setShareRoster(WORKSPACE, { grants: [ana], links: [], formerGrants: [], endedGrants: [] }, false);
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
        localUserId: async () => null, localPersonId: async () => null, syncHistory: async () => "never-synced", logError, nowMs: () => now,
      }),
    };
  }

  it("refuses a paused pulled-after roster until an authenticated listing answers", async () => {
    seed();
    store.markShareRosterPulled(WORKSPACE);
    store.pauseRemote(WORKSPACE);
    const { list, rosters: r } = rosters(async () => offline);
    const roster = await r.forRun(WORKSPACE);
    expect(roster).toEqual(unchecked(offline.next));
    const [reach] = checkAutomationReach(roster, { id: "new-editor", collection: { path: "Trip", name: "Trip" }, codeFiles: [],
      steps: [{ kind: "change-records", collection: { path: "Private", name: "Private" } }] });
    expect(reach.allowed).toBe(false);
    expect(store.find(WORKSPACE)?.shareRoster?.pulledAfter).toBe(true);
    const revoked = await listed({ granted: [row({ revokedAtMs: 10 })] });
    list.mockResolvedValue(answered(revoked));
    now += SHARE_ROSTER_FRESH_MS;
    await r.requestRefresh(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(2);
    expect(store.find(WORKSPACE)?.shareRoster?.pulledAfter).toBeUndefined();
    expect(await r.forRun(WORKSPACE)).toMatchObject({ kind: "owner", grants: [] });
    expect(r.observation(WORKSPACE).listing).toEqual(revoked);
  });

  it("preserves signed-out advice for a paused pulled-after roster", async () => {
    seed(); store.markShareRosterPulled(WORKSPACE); store.pauseRemote(WORKSPACE);
    const { rosters: r } = rosters(async () => ({ kind: "unanswered", partial: false, next: "Sign in to your server first." }));
    expect(await r.forRun(WORKSPACE)).toEqual(unchecked("Sign in to your server first."));
  });

  it("asks to turn sync on when a paused workspace has no roster or listing answer", async () => {
    store.pauseRemote(WORKSPACE);
    const { rosters: r, list } = rosters(async () => offline);
    expect(await r.cached(WORKSPACE)).toEqual(unchecked("Turn sync on in Settings → Sync and sharing, then try again."));
    expect(list).not.toHaveBeenCalled();
  });

  it("does not read local identity or sync history for a paused owner", async () => {
    seed(); store.pauseRemote(WORKSPACE);
    const localUserId = vi.fn(), localPersonId = vi.fn(), syncHistory = vi.fn();
    const r = createShareRosters({
      findWorkspace: store.find, saveRoster: store.setShareRoster, markRosterPulled: store.markShareRosterPulled,
      listRoster: async () => offline, localUserId, localPersonId, syncHistory, logError: vi.fn(),
    });
    expect(await r.cached(WORKSPACE)).toEqual(cached);
    expect(localUserId).not.toHaveBeenCalled(); expect(localPersonId).not.toHaveBeenCalled(); expect(syncHistory).not.toHaveBeenCalled();
  });
  it("lists at open and every 10 minutes while open, and stops at close", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }));
    r.open(WORKSPACE);
    r.open(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(1);
    await r.forRun(WORKSPACE);
    expect(store.find(WORKSPACE)?.shareRoster).toMatchObject({ version: 1, grants: [ana], links: [], formerGrants: [], endedGrants: [] });

    now += SHARE_ROSTER_REFRESH_MS;
    vi.advanceTimersByTime(SHARE_ROSTER_REFRESH_MS);
    expect(list).toHaveBeenCalledTimes(2);
    r.close(WORKSPACE);
    vi.advanceTimersByTime(SHARE_ROSTER_REFRESH_MS * 3);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("shows the cached roster without listing; a run refreshes after a pull", async () => {
    seed();
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }));
    expect(await r.cached(WORKSPACE)).toEqual(cached);
    r.pullStarting(WORKSPACE)();
    expect(await r.cached(WORKSPACE)).toEqual(cached);
    expect(list).not.toHaveBeenCalled();
    // A run lists first, and the listing clears the pull.
    expect(await r.forRun(WORKSPACE)).toEqual(cached);
    expect(await r.cached(WORKSPACE)).toEqual(cached);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("asks for this computer's own id for its person only for a workspace that does not sync, at every read", async () => {
    store.register({ workspaceId: "w-local", rootPath: "/notes", kind: "personal", mode: "local-first" });
    let proved = true;
    const localPersonId = vi.fn(async (workspace: RegistryEntry) => (proved ? `install-for-${workspace.workspaceId}` : null));
    const r = createShareRosters({
      findWorkspace: store.find, saveRoster: store.setShareRoster, markRosterPulled: store.markShareRosterPulled,
      listRoster: async () => answered({ grants: [], links: [], formerGrants: [], endedGrants: [] }), localUserId: async () => null, localPersonId, syncHistory: async () => "never-synced", logError: vi.fn(), nowMs: () => now,
    });
    expect(await r.forRun("w-local")).toEqual({ kind: "owner", ownerUserId: null, localPersonId: "install-for-w-local", grants: [] });
    proved = false;
    expect(await r.cached("w-local")).toEqual({ kind: "owner", ownerUserId: null, grants: [] });
    await r.forRun(WORKSPACE);
    expect(localPersonId.mock.calls.map(([workspace]) => workspace.workspaceId)).toEqual(["w-local", "w-local"]);
  });

  it("lists again before a run only when the last listing is older than a minute", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }));
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

  it("keeps the roster version and file bytes when the owner-email acquisition fails", async () => {
    seed();
    const before = store.find(WORKSPACE)?.shareRoster;
    const directory = join(dirname(store.registryFile), "share-rosters");
    const files = await readdir(directory);
    const bytes = await Promise.all(files.map(file => readFile(join(directory, file), "utf8")));
    const get = relay({ "/sync/shares?workspaceId=ws-trip": { status: 500, body: { ok: false } } });
    const { rosters: r, saveRoster } = rosters(() => listRosterGrants(WORKSPACE, get));
    expect(await r.forRun(WORKSPACE)).toEqual(cached);
    expect(saveRoster).not.toHaveBeenCalled();
    expect(store.find(WORKSPACE)?.shareRoster).toEqual(before);
    expect(await Promise.all(files.map(file => readFile(join(directory, file), "utf8")))).toEqual(bytes);
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
    const before = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }));
    await before.rosters.forRun(WORKSPACE);
    before.rosters.pullStarting(WORKSPACE);
    restart();
    const { rosters: after } = rosters(async () => offline);
    expect(await after.forRun(WORKSPACE)).toEqual(unchecked(offline.next));
  });

  it("uses the cache after a restart when no pull followed the listing", async () => {
    const before = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }));
    await before.rosters.forRun(WORKSPACE);
    restart();
    const { rosters: after } = rosters(async () => offline);
    expect(await after.forRun(WORKSPACE)).toEqual(cached);
  });

  it("does not depend on the clock", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }));
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
    list.mockImplementation(async () => answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }));
    expect(await r.forRun(WORKSPACE)).toEqual(cached);
  });

  it("lists once more when a pull lands while the listing a run waits on is running", async () => {
    const first = deferred<RosterAnswer>();
    const { list, rosters: r } = rosters(() => first.promise);
    r.open(WORKSPACE);
    const run = r.forRun(WORKSPACE);
    // A pull lands during that listing, and may bring a new editor's change.
    r.pullStarting(WORKSPACE)();
    list.mockImplementation(async () => answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }));
    first.resolve(answered({ grants: [], links: [], formerGrants: [], endedGrants: [] }));
    expect(await run, "the run used a listing a pull overlapped").toEqual(cached);
    expect(list).toHaveBeenCalledTimes(2);

    // When a pull overlaps that listing too, this run gets no roster.
    const third = deferred<RosterAnswer>();
    const fourth = deferred<RosterAnswer>();
    list.mockImplementationOnce(() => third.promise).mockImplementationOnce(() => fourth.promise);
    now += SHARE_ROSTER_FRESH_MS;
    const busy = r.forRun(WORKSPACE);
    r.pullStarting(WORKSPACE)();
    third.resolve(answered({ grants: [], links: [], formerGrants: [], endedGrants: [] }));
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(4));
    r.pullStarting(WORKSPACE)();
    fourth.resolve(answered({ grants: [], links: [], formerGrants: [], endedGrants: [] }));
    expect(await busy).toEqual(unchecked("Try again in a moment."));
  });

  it("lists again before a run when a pull followed the listing, and only while the relay answers", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }));
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
    const { list, saveRoster, rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }));
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
    answer.resolve(answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }));
    expect(await run).toEqual(cached);
    expect(saveRoster.mock.calls.at(-2)?.[2], "the overlapped listing saved without its mark").toBe(true);
    expect(store.find(WORKSPACE)?.shareRoster?.pulledAfter).toBeUndefined();
  });

  it("marks a listing it could not save yet", async () => {
    let fail = true;
    const { rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }), (id, listing, pulledAfter) => {
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
    const { list, rosters: r } = rosters(async () => answered({ grants: [], links: [], formerGrants: [], endedGrants: [] }), (id, listing, pulledAfter) => {
      if (fail) throw new Error("disk full");
      store.setShareRoster(id, listing, pulledAfter);
    });
    expect(await r.forRun(WORKSPACE)).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [], formerEditors: [] });
    expect(store.find(WORKSPACE)?.shareRoster?.grants).toEqual([ana]);
    fail = false;
    expect(await r.forRun(WORKSPACE)).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [], formerEditors: [] });
    expect(list, "the retry listed again instead of saving what it knew").toHaveBeenCalledTimes(1);
    expect(store.find(WORKSPACE)?.shareRoster).toMatchObject({ version: 2, grants: [], links: [], formerGrants: [], endedGrants: [] });
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
    list.mockImplementation(async () => answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }));
    await r.pulled(WORKSPACE, false);
    expect(list).toHaveBeenCalledTimes(3);
    now += SHARE_ROSTER_FRESH_MS;
    await r.pulled(WORKSPACE, false);
    expect(list, "a pass listed again after a listing answered").toHaveBeenCalledTimes(3);
    expect(store.find(WORKSPACE)?.shareRoster).toMatchObject({ version: 1, grants: [ana], links: [], formerGrants: [], endedGrants: [] });
  });

  it("lists when sync recovers, at most once a minute", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }));
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
    list.mockImplementation(async () => answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }));
    first.resolve(answered({ grants: [], links: [], formerGrants: [], endedGrants: [] }));
    await r.forRun(WORKSPACE);
    expect(list).toHaveBeenCalledTimes(2);
    expect(store.find(WORKSPACE)?.shareRoster).toMatchObject({ version: 2, grants: [ana], links: [], formerGrants: [], endedGrants: [] });
  });

  it("refreshes every open workspace when a change names none", async () => {
    const { list, rosters: r } = rosters(async () => answered({ grants: [], links: [], formerGrants: [], endedGrants: [] }));
    r.open(WORKSPACE);
    await r.forRun(WORKSPACE);
    r.sharesChanged(null);
    await r.forRun(WORKSPACE);
    expect(list.mock.calls.map(([workspace]) => workspace.workspaceId)).toEqual([WORKSPACE, WORKSPACE]);
  });

  it("lists nothing for a workspace that does not sync, whose owner is this computer's person", async () => {
    store.register({ workspaceId: "ws-local", rootPath: "/local", kind: "personal", mode: "local-first" });
    const { list, rosters: r } = rosters(async () => answered({ grants: [ana], links: [], formerGrants: [], endedGrants: [] }));
    r.open("ws-local");
    expect(await r.forRun("ws-local")).toEqual({ kind: "owner", ownerUserId: null, grants: [] });
    expect(list).not.toHaveBeenCalled();
  });
});

describe("a shared workspace forgotten and attached again", () => {
  const trip = { path: "Trip", name: "Trip" };
  // Steps Ana could have written into Trip/automations.yaml: one that acts
  // as the owner, and one that changes a Collection only the owner can edit.
  const steps: ReachStep[] = [
    { kind: "personal", person: { userId: "u-owner", name: "you" } },
    { kind: "change-records", collection: { path: "Budget", name: "Budget" } },
    { kind: "change-records", collection: trip },
  ];

  it("stops a collaborator's steps until the workspace syncs again, then checks them against its grants", async () => {
    const root = await createTestScratch("dohc-reattach-");
    const store = createRegistryStore(join(await createTestScratch("dohc-reattach-registry-"), "workspaces.json"));
    const listing = { grants: [ana], links: [], formerGrants: [], endedGrants: [] };
    let now = 0;
    const rosters = createShareRosters({
      findWorkspace: store.find, saveRoster: store.setShareRoster, markRosterPulled: store.markShareRosterPulled,
      listRoster: async () => ({ kind: "answered", listing }), localUserId: async () => "u-owner",
      localPersonId: async () => null, syncHistory: (workspace) => readSyncHistory(workspace.rootPath), logError: vi.fn(), nowMs: () => now,
    });
    const check = async () => checkAutomationReach(await rosters.forRun(WORKSPACE), { id: "a", collection: trip, codeFiles: [], steps });

    // Shared with Ana, who can edit Trip.
    await mkdir(join(root, ".dohc"));
    await recordNeverSynced(root, { installId: "install-here", label: "This Mac" });
    store.register({ workspaceId: WORKSPACE, rootPath: root, kind: "personal", mode: "local-first" });
    await recordSynced(root);
    store.setRemote(WORKSPACE, remote);
    const shared = await check();
    expect(shared.map((reach) => reach.allowed)).toEqual([false, false, true]);

    // Forgotten, then attached again: the registry no longer names a server.
    store.remove(WORKSPACE);
    store.register({ workspaceId: WORKSPACE, rootPath: root, kind: "personal", mode: "local-first" });
    const reason = "dohc could not check who can edit Trip. Sync this workspace in Settings → Sync and sharing, then try again.";
    expect(await check()).toEqual(steps.map(() => ({ allowed: false, reason })));

    // A record cut off mid-write, or one dohc cannot read, still stops them.
    const record = join(root, ".dohc", "sync-history.json");
    const synced = await readFile(record, "utf8");
    await writeFile(record, synced.slice(0, 10));
    expect(await check()).toEqual(steps.map(() => ({ allowed: false, reason })));
    await rm(record);
    await mkdir(record);
    expect(await check()).toEqual(steps.map(() => ({ allowed: false, reason })));
    await rm(record, { recursive: true });
    await writeFile(record, synced);

    // Synced again, the roster is listed again: until then it stays unknown.
    store.setRemote(WORKSPACE, remote);
    expect(await check()).toEqual(steps.map(() => expect.objectContaining({ allowed: false })));
    now += SHARE_ROSTER_FRESH_MS;
    // Ana is still an editor.
    expect(await check()).toEqual(shared);
  });
});

describe("a direct write's author in History", () => {
  // As History reads it: the saved roster parsed once, then each author named from it.
  const labelFrom = (saved: unknown, author: { userId: string; grantId: string }) =>
    rosterAuthorLabel(readStoredRoster(saved), author);

  const grant = (grantId: string, recipientUserId: string | null, recipientEmail: string | null, access: "view" | "edit") =>
    ({ ...facts, grantId, recipientUserId, recipientEmail, selector: { paths: ["trip"], versionId: null }, access }) as ListedGrant;
  const roster = { version: 1, listedAtMs: 0, grants: [grant("g-1", "ana", "ana@example.com", "edit"), grant("g-2", "ben", "ben@example.com", "view")], links: [], formerGrants: [], endedGrants: [] };

  it("names a Button presser by active, former, then ended grants, with no opaque-id fallback", () => {
    const listing = { ...roster,
      formerGrants: [{ grant: grant("old", "ana", "old@example.com", "edit"), automationsGeneration: 1 },
        { grant: grant("former", "cy", "cy@example.com", "edit"), automationsGeneration: 1 }],
      endedGrants: [{ ...facts, status: "revoked" as const, grantId: "ended", recipientUserId: "cy", recipientEmail: "older@example.com" },
        { ...facts, status: "revoked" as const, grantId: "last", recipientUserId: "dee", recipientEmail: "dee@example.com" }],
    };
    expect(rosterPersonLabel(listing, "ana")).toBe("ana@example.com");
    expect(rosterPersonLabel(listing, "cy")).toBe("cy@example.com");
    expect(rosterPersonLabel(listing, "dee")).toBe("dee@example.com");
    expect(rosterPersonLabel(listing, "unknown-id")).toBe("Someone you shared with");
    expect(rosterPersonLabel(null, "ana")).toBe("Someone you shared with");
  });

  it("names the person and the level of the grant they wrote through", () => {
    expect(labelFrom(roster, { userId: "ana", grantId: "g-1" })).toBe("ana@example.com (Edit)");
  });

  it("names the person without a level when that grant is gone", () => {
    expect(labelFrom(roster, { userId: "ben", grantId: "revoked" })).toBe("ben@example.com");
  });

  it("names a person whose access ended by the grant the roster keeps for them, without a level", () => {
    // Cy wrote automations.yaml, then the owner stopped them: the relay lists the revoked grant as former.
    const ended = { ...roster, formerGrants: [{ grant: grant("g-3", "cy", "cy@example.com", "edit"), automationsGeneration: 1 }] };
    expect(labelFrom(ended, { userId: "cy", grantId: "g-3" })).toBe("cy@example.com");
    expect(labelFrom(ended, { userId: "cy", grantId: "older" })).toBe("cy@example.com");
    expect(labelFrom(ended, { userId: "dee", grantId: "g-3" })).toBe("Someone you shared with");
  });

  it("names a recipient who edited only records and was then stopped, from the relay's listing", async () => {
    // Ana wrote records, never automations.yaml, and the owner stopped her.
    const listing = await listed({ granted: [row({ revokedAtMs: 9 })] });
    expect(listing.grants).toEqual([]);
    expect(labelFrom({ ...listing, version: 1, listedAtMs: 0 }, { userId: "u-ana", grantId: "g-1" })).toBe("ana@dohc.test");
    // An invite nobody claimed names no person, so it cannot name a writer.
    const unclaimed = await listed({ granted: [row({ revokedAtMs: 9, principalKind: "email", recipientUserId: null })] });
    expect(labelFrom({ ...unclaimed, version: 1, listedAtMs: 0 }, { userId: "u-ana", grantId: "g-1" })).toBe("Someone you shared with");
  });

  it("keeps History loading on a saved roster this build cannot read, and names nobody from it", async () => {
    // Saved by a build from before ended grants, and not listed again while offline.
    const { endedGrants: _missing, ...saved } = roster;
    expect(readStoredRoster(saved)).toBeNull();
    expect(labelFrom(saved, { userId: "ana", grantId: "g-1" })).toBe("Someone you shared with");
    const history = await listEngineMomentsForIpc(async () => ({
      moments: [{
        id: "m-1", workspaceId: WORKSPACE, versionId: "main", objectId: "o-1", path: "trip/a.md", recordedAtMs: 1,
        operation: "write", metadata: { origin: "sync" }, momentOrder: 0, protected: false,
        authors: [{ kind: "named", userId: "ana", grantId: "g-1", grantGeneration: 1 }],
      }],
      nextCursor: null, latestMomentOrder: 0, activeVersionId: "main", ...historyPageFields,
    }), { agent: () => undefined, person: () => undefined, automation: () => null, named: (author) => labelFrom(saved, author),
      presentations: neutralHistoryPresentations });
    expect(history).toMatchObject({ moments: [{ namedAuthor: { userId: "ana", label: "Someone you shared with" } }] });
  });

  it("names nobody it cannot match", () => {
    expect(labelFrom(roster, { userId: "cy", grantId: "revoked" })).toBe("Someone you shared with");
    expect(labelFrom(roster, { userId: "cy", grantId: "g-1" })).toBe("Someone you shared with");
    expect(labelFrom(undefined, { userId: "ana", grantId: "g-1" })).toBe("Someone you shared with");
    expect(labelFrom({ version: 1, listedAtMs: 0, grants: null, problem: { kind: "unusable-listing" } }, { userId: "ana", grantId: "g-1" }))
      .toBe("Someone you shared with");
  });
});
