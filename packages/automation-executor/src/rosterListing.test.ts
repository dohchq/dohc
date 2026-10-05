import { describe, expect, it, vi } from "vitest";
import {checkAutomationReach, type ReachStep} from "./automationReach";
import { listRosterGrants, ownerRoster, readStoredRoster } from "./rosterListing";

const WORKSPACE = "ws-trip";

function row(overrides: Record<string, unknown> = {}) {
  return {
    shareId: "s-1", workspaceId: WORKSPACE, grantId: "g-1", principalKind: "user", generation: 1,
    recipientUserId: "u-ana", recipientEmail: "ana@dohc.test", createdAtMs: 1, revokedAtMs: null,
    selector: { paths: ["Trip"], versionId: null }, access: "edit", automationsGeneration: null, ...overrides,
  };
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    grantId: "g-link", access: "edit", automationsGeneration: null, status: "active", selector: { paths: ["Trip"], versionId: null },
    dependents: [{ grantId: "g-dep", recipientUserId: "u-ben", recipientEmail: "ben@dohc.test", access: "edit", generation: 1, createdAtMs: 1 }],
    ...overrides,
  };
}

type Page = { status: number; body: unknown } | Error;

function relay(pages: Record<string, Page>) {
  return vi.fn(async (path: string) => {
    const page = pages[path];
    if (page === undefined) throw new Error(`unexpected ${path}`);
    if (page instanceof Error) throw page;
    return page;
  });
}

const unusable = { kind: "answered", listing: { grants: null, problem: { kind: "unusable-listing" } } };
const serverDown = { status: 503, body: null };

describe("listing from the relay", () => {
  const noLinks = { "/sync/ws-trip/shares/links": { status: 200, body: { links: [], formerGrants: [] } } };

  it("pages through share links", async () => {
    const get = relay({
      "/sync/shares?workspaceId=ws-trip": { status: 200, body: { ok: true, granted: [row()] } },
      "/sync/ws-trip/shares/links": { status: 200, body: { ok: true, links: [], nextCursor: "c 1" } },
      "/sync/ws-trip/shares/links?cursor=c%201": { status: 200, body: { ok: true, links: [link()] } },
    });
    const answer = await listRosterGrants(WORKSPACE, get);
    expect(answer.kind === "answered" && answer.listing.grants?.map((grant) => grant.grantId)).toEqual(["g-1", "g-dep"]);
    expect(answer.kind === "answered" && answer.listing.grants !== null && answer.listing.links.map((own) => own.grant.grantId))
      .toEqual(["g-link"]);
  });

  it("reads every granted page before links and encodes workspace and cursor", async () => {
    const get = relay({
      "/sync/shares?workspaceId=ws%20trip": {status: 200, body: {granted: [row({workspaceId: "ws trip"})], nextCursor: "c 1"}},
      "/sync/shares?workspaceId=ws%20trip&cursor=c%201": {status: 200, body: {granted: [row({workspaceId: "ws trip", grantId: "g-2"})]}},
      "/sync/ws%20trip/shares/links": {status: 200, body: {links: []}},
    });
    const answer = await listRosterGrants("ws trip", get);
    expect(answer.kind === "answered" && answer.listing.grants?.map(grant => grant.grantId)).toEqual(["g-1", "g-2"]);
    expect(get.mock.calls.map(([path]) => path)).toEqual([
      "/sync/shares?workspaceId=ws%20trip", "/sync/shares?workspaceId=ws%20trip&cursor=c%201", "/sync/ws%20trip/shares/links",
    ]);
  });

  it("cannot use partial, looping, malformed, or over-long granted pages", async () => {
    const first = {"/sync/shares?workspaceId=ws-trip": {status: 200, body: {granted: [row()], nextCursor: "c-1"}}};
    expect(await listRosterGrants(WORKSPACE, relay({...first,
      "/sync/shares?workspaceId=ws-trip&cursor=c-1": serverDown,
    }))).toEqual({kind: "unanswered", next: "Your server is not answering. Try again later.", partial: true});
    expect(await listRosterGrants(WORKSPACE, relay({...first,
      "/sync/shares?workspaceId=ws-trip&cursor=c-1": {status: 200, body: {granted: [], nextCursor: "c-1"}},
    }))).toEqual(unusable);
    expect(await listRosterGrants(WORKSPACE, relay({
      "/sync/shares?workspaceId=ws-trip": {status: 200, body: {granted: [], nextCursor: null}},
    }))).toEqual(unusable);
    let page = 0;
    const get = vi.fn(async () => ({status: 200, body: {granted: [], nextCursor: `c-${++page}`}}));
    expect(await listRosterGrants(WORKSPACE, get)).toEqual(unusable);
    expect(get).toHaveBeenCalledTimes(50);
  });

  it("reports no answer, and names what to do", async () => {
    const cases: Array<[Page, string]> = [
      [new TypeError("fetch failed"), "Check your connection, then try again."],
      [{ status: 401, body: { ok: false } }, "Sign in again, then try again."],
      [serverDown, "Your server is not answering. Try again later."],
      [{ status: 429, body: null }, "Your server is not answering. Try again later."],
    ];
    for (const [shares, next] of cases) {
      expect(await listRosterGrants(WORKSPACE, relay({ "/sync/shares?workspaceId=ws-trip": shares, ...noLinks })))
        .toEqual({ kind: "unanswered", next, partial: false });
    }
  });

  it("says when the relay answered part of a listing and then stopped", async () => {
    expect(await listRosterGrants(WORKSPACE, relay({
      "/sync/shares?workspaceId=ws-trip": { status: 200, body: { granted: [row()] } },
      "/sync/ws-trip/shares/links": serverDown,
    }))).toEqual({ kind: "unanswered", next: "Your server is not answering. Try again later.", partial: true });
  });

  it("decides on damage or a refusal as soon as it arrives, whatever the later requests do", async () => {
    const damagedShare = relay({
      "/sync/shares?workspaceId=ws-trip": { status: 200, body: { granted: [row({ selector: null, damaged: true, access: "unknown" })] } },
      "/sync/ws-trip/shares/links": serverDown,
    });
    expect(await listRosterGrants(WORKSPACE, damagedShare))
      .toEqual({ kind: "answered", listing: { grants: null, problem: { kind: "damaged-share", recipientEmail: "ana@dohc.test" } } });
    expect(damagedShare).toHaveBeenCalledTimes(1);

    const damagedLink = relay({
      "/sync/shares?workspaceId=ws-trip": { status: 200, body: { granted: [] } },
      "/sync/ws-trip/shares/links": { status: 200, body: { links: [link({ selector: null })], nextCursor: "c-2" } },
      "/sync/ws-trip/shares/links?cursor=c-2": serverDown,
    });
    expect(await listRosterGrants(WORKSPACE, damagedLink))
      .toEqual({ kind: "answered", listing: { grants: null, problem: { kind: "damaged-link" } } });
    expect(damagedLink).toHaveBeenCalledTimes(2);

    expect(await listRosterGrants(WORKSPACE, relay({
      "/sync/shares?workspaceId=ws-trip": { status: 200, body: { granted: [] } },
      "/sync/ws-trip/shares/links": { status: 403, body: null },
    }))).toEqual(unusable);
  });

  it("calls a refused, malformed, looping, or over-long answer unusable", async () => {
    const shares = { "/sync/shares?workspaceId=ws-trip": { status: 200, body: { granted: [] } } };
    expect(await listRosterGrants(WORKSPACE, relay({ "/sync/shares?workspaceId=ws-trip": { status: 404, body: { ok: false } } }))).toEqual(unusable);
    expect(await listRosterGrants(WORKSPACE, relay({ ...shares, "/sync/ws-trip/shares/links": { status: 200, body: { links: "all" } } })))
      .toEqual(unusable);
    const looping = vi.fn(async (path: string) =>
      ({ status: 200, body: path === "/sync/shares?workspaceId=ws-trip" ? { granted: [] } : { links: [], nextCursor: "same" } }));
    expect(await listRosterGrants(WORKSPACE, looping)).toEqual(unusable);
    let page = 0;
    const endless = vi.fn(async (path: string) =>
      ({ status: 200, body: path === "/sync/shares?workspaceId=ws-trip" ? { granted: [] } : { links: [], nextCursor: `c-${(page += 1)}` } }));
    expect(await listRosterGrants(WORKSPACE, endless)).toEqual(unusable);
    expect(endless).toHaveBeenCalledTimes(51);
  });
});

describe("the owner's roster from a listing", () => {
  it("maps each grant to what the reach check reads, and calls a listing it cannot read unchecked", async () => {
    const answer = await listRosterGrants(WORKSPACE, relay({
      "/sync/shares?workspaceId=ws-trip": { status: 200, body: { granted: [row()] } },
      "/sync/ws-trip/shares/links": { status: 200, body: { links: [] } },
    }));
    if (answer.kind !== "answered") throw new Error("the relay answered every request");
    expect(ownerRoster("u-owner", answer.listing, "")).toEqual({ kind: "owner", ownerUserId: "u-owner", grants: [{
      grantId: "g-1", recipientUserId: "u-ana", recipientEmail: "ana@dohc.test",
      files: { paths: ["Trip"], versionId: null, access: "edit" }, channel: null,
    }], formerEditors: [] });
    expect(ownerRoster("u-owner", { grants: null, problem: { kind: "damaged-link" } }, ""))
      .toEqual({ kind: "unknown", problem: { kind: "damaged-link" } });
    expect(ownerRoster("u-owner", { grants: "all" }, "Sign in again."))
      .toEqual({ kind: "unknown", problem: { kind: "unchecked", next: "Sign in again." } });
  });
});


describe("Group scope on the saved roster", () => {
  it.each([null, 2])("keeps an unserved Group usable with automation generation %s", async (automationsGeneration) => {
    const answer = await listRosterGrants(WORKSPACE, relay({
      "/sync/shares?workspaceId=ws-trip": {status: 200, body: {granted: [row({
        selector: {kind: "group", channelWireId: "wire-trip", paths: ["Trip"], versionId: null},
        access: "read-write", fileScope: "not-served", automationsGeneration,
      })]}},
      "/sync/ws-trip/shares/links": {status: 200, body: {links: []}},
    }));
    if (answer.kind !== "answered") throw new Error("expected an answer");
    expect(readStoredRoster(answer.listing)).toEqual(answer.listing);
    const roster = ownerRoster("owner", answer.listing, "");
    expect(roster.kind).toBe("owner");
    if (roster.kind !== "owner") throw new Error("expected an owner roster");
    expect(roster.grants[0]?.files).toBeNull();
    expect(roster.grants[0]?.channel).toBeNull();
    expect(roster.formerEditors).toEqual([]);
    if (answer.listing.grants === null) throw new Error("expected grants");
    expect(answer.listing.grants[0]?.selector).toEqual({kind: "group", channelWireId: "wire-trip", paths: ["Trip"], versionId: null});
  });

  it("rejects stored Group observations without an explicit file-scope answer", () => {
    expect(readStoredRoster({grants: [row({selector: {kind: "group", channelWireId: "wire-trip", paths: ["Trip"], versionId: null}, access: "read-write"})],
      links: [], formerGrants: [], endedGrants: []})).toBeNull();
  });
});


it("keeps reach verdicts unchanged with View and Comment links in the stored roster", () => {
  const listing = {grants: [row()], links: [], formerGrants: [], endedGrants: []};
  const trip = {path: "Trip", name: "Trip"};
  const steps: ReachStep[] = [
    {kind: "change-records", collection: trip},
    {kind: "find-records", collection: {path: "Budget", name: "Budget"}},
    {kind: "post", group: {channelWireId: "wire-trip", name: "Trip"}},
    {kind: "notify", person: {userId: "owner", name: "Owner"}},
    {kind: "personal", person: {userId: "owner", name: "Owner"}},
  ];
  const automation = {id: "a", collection: trip, codeFiles: [], steps};
  const additions = ["view", "comment"].map(access => ({
    grant: {grantId: `g-${access}`, recipientUserId: null, recipientEmail: null,
      selector: {paths: ["Trip"], versionId: null}, access},
    ended: false, automationsGeneration: null,
  }));
  expect(checkAutomationReach(ownerRoster("owner", {...listing, links: additions}, ""), automation))
    .toEqual(checkAutomationReach(ownerRoster("owner", listing, ""), automation));
});
