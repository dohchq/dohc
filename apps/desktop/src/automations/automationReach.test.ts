import { describe, expect, it } from "vitest";
import {
  checkAutomationReach,
  shareImpactOf,
  type ReachAutomation,
  type ReachCollection,
  type ReachRoster,
  type ReachStep,
  type RosterGrant,
} from "./automationReach";

const OWNER = "u-owner";
const trip = { path: "Trip", name: "Trip" };
const budget = { path: "Budget", name: "Budget" };

function grant(
  recipient: { userId?: string; email?: string },
  files: { paths: string[]; access: "view" | "comment" | "edit"; versionId?: string } | null,
  channel: { wireId: string; canPost: boolean } | null = null,
): RosterGrant {
  return {
    recipientUserId: recipient.userId ?? null,
    recipientEmail: recipient.email ?? null,
    files: files && { paths: files.paths, versionId: files.versionId ?? null, access: files.access },
    channel,
  };
}

const ana = { userId: "u-ana", email: "ana@dohc.test" };
const ben = { userId: "u-ben", email: "ben@dohc.test" };

function owner(...grants: RosterGrant[]): ReachRoster {
  return { kind: "owner", ownerUserId: OWNER, grants };
}

function check(roster: ReachRoster, step: ReachStep, collection: ReachCollection = trip, codeFiles: string[] = []) {
  return checkAutomationReach(roster, { id: "a", collection, codeFiles, steps: [step] })[0];
}

const change = (collection: ReachCollection): ReachStep => ({ kind: "change-records", collection });
const find = (collection: ReachCollection): ReachStep => ({ kind: "find-records", collection });
const post = (channelWireId: string | null, name = "Family"): ReachStep => ({ kind: "post", group: { channelWireId, name } });
const notify = (userId: string, name = "Someone"): ReachStep => ({ kind: "notify", person: { userId, name } });
const personal = (userId: string, name = "Someone"): ReachStep => ({ kind: "personal", person: { userId, name } });
const allowed = { allowed: true };
const stopped = (reason: string) => expect.objectContaining({ allowed: false, reason });
const everyStep = [change(trip), change(budget), find(budget), post("wire-family"), notify(OWNER), personal(OWNER)];

describe("reach check", () => {
  it("lets the only editor reach everything the owner can", () => {
    const roster = owner(grant(ana, { paths: ["Trip"], access: "view" }));
    expect(checkAutomationReach(roster, { id: "a", collection: trip, codeFiles: [], steps: everyStep }))
      .toEqual(everyStep.map(() => allowed));
  });

  it("allows steps inside the Collection when every editor can edit it, including a Collection nested in it", () => {
    const roster = owner(grant(ana, { paths: ["Trip"], access: "edit" }));
    expect(check(roster, change(trip))).toEqual(allowed);
    expect(check(roster, find({ path: "Trip/Packing", name: "Packing" }))).toEqual(allowed);
  });

  it("counts Edit on automations.yaml alone as an editor who still cannot change the Collection's records", () => {
    const roster = owner(grant(ana, { paths: ["Trip/automations.yaml"], access: "edit" }));
    expect(check(roster, change(trip))).toEqual(stopped("ana@dohc.test cannot edit Trip."));
    expect(check(roster, find(trip))).toEqual(stopped("ana@dohc.test cannot view Trip."));
    expect(check(owner(grant(ana, { paths: ["Trip/automations.yaml"], access: "edit" }), grant(ana, { paths: ["Trip"], access: "view" })), find(trip)))
      .toEqual(allowed);
    expect(check(roster, personal(OWNER))).toEqual(stopped("This step acts as you, and ana@dohc.test can also edit Trip."));
    // Edit on another file in the Collection does not make an editor.
    expect(check(owner(grant(ana, { paths: ["Trip/collection.yaml"], access: "edit" })), personal(OWNER))).toEqual(allowed);
  });

  it("counts Edit on a code file the automation runs as an editor", () => {
    const roster = owner(grant(ana, { paths: ["Trip/scripts/stamp.js"], access: "edit" }));
    expect(check(roster, change(trip), trip, ["Trip/scripts/stamp.js"])).toEqual(stopped("ana@dohc.test cannot edit Trip."));
    expect(check(roster, change(trip), trip, [])).toEqual(allowed);
  });

  it("changes records elsewhere only where every editor can edit", () => {
    const editor = grant(ana, { paths: ["Trip"], access: "edit" });
    expect(check(owner(editor), change(budget))).toEqual(stopped("ana@dohc.test cannot edit Budget."));
    expect(check(owner(editor, grant(ana, { paths: ["Budget"], access: "view" })), change(budget)))
      .toEqual(stopped("ana@dohc.test cannot edit Budget."));
    expect(check(owner(editor, grant(ana, { paths: ["Budget"], access: "edit" })), change(budget))).toEqual(allowed);
  });

  it("finds records elsewhere where every editor has any grant", () => {
    const editor = grant(ana, { paths: ["Trip"], access: "edit" });
    expect(check(owner(editor), find(budget))).toEqual(stopped("ana@dohc.test cannot view Budget."));
    for (const access of ["view", "comment", "edit"] as const) {
      expect(check(owner(editor, grant(ana, { paths: ["Budget"], access })), find(budget))).toEqual(allowed);
    }
  });

  it("reads grants on folders as covering everything beneath them, and nothing beside them", () => {
    const projects = grant(ana, { paths: ["Projects"], access: "edit" });
    const nestedTrip = { path: "Projects/Trip", name: "Trip" };
    expect(check(owner(projects), change({ path: "Projects/Budget", name: "Budget" }), nestedTrip)).toEqual(allowed);
    const child = grant(ana, { paths: ["Budget/2026"], access: "edit" });
    expect(check(owner(grant(ana, { paths: ["Trip"], access: "edit" }), child), change(budget)))
      .toEqual(stopped("ana@dohc.test cannot edit Budget."));
    // "Trip" does not cover "Trip 2", so Ana does not edit it.
    expect(check(owner(grant(ana, { paths: ["Trip"], access: "edit" })), change(budget), { path: "Trip 2", name: "Trip 2" }))
      .toEqual(allowed);
  });

  it("counts a grant in another case or with a Windows name ending as an editor, and never as reach", () => {
    for (const spelling of ["trip", "TRIP", "Trip.", "Trip "]) {
      const roster = owner(grant(ana, { paths: [spelling], access: "edit" }));
      expect(check(roster, personal(OWNER)), spelling).toEqual(stopped("This step acts as you, and ana@dohc.test can also edit Trip."));
      expect(check(roster, change(trip)), spelling).toEqual(stopped("ana@dohc.test cannot edit Trip."));
    }
    // Unicode composed and decomposed forms, and full case folding.
    const cafe = { path: "Café", name: "Café" };
    const cafeGrant = owner(grant(ana, { paths: ["Café/automations.yaml"], access: "edit" }));
    expect(check(cafeGrant, personal(OWNER), cafe)).toEqual(stopped("This step acts as you, and ana@dohc.test can also edit Café."));
    expect(check(cafeGrant, change(cafe), cafe)).toEqual(stopped("ana@dohc.test cannot edit Café."));
    const plans = { path: "Plans", name: "Plans" };
    expect(check(owner(grant(ana, { paths: ["Planſ"], access: "edit" })), personal(OWNER), plans))
      .toEqual(stopped("This step acts as you, and ana@dohc.test can also edit Plans."));
    for (const [collection, granted] of [["Straße", "STRAẞE"], ["Straße", "Straẞe"], ["Strasse", "STRAẞE"], ["STRAẞE", "straße"]]) {
      expect(check(owner(grant(ana, { paths: [granted!], access: "edit" })), personal(OWNER), { path: collection!, name: "Street" }), `${collection} ${granted}`)
        .toEqual(stopped("This step acts as you, and ana@dohc.test can also edit Street."));
    }
    // A step that spells its target differently reaches nothing through the spelling.
    const roster = owner(grant(ana, { paths: ["Trip"], access: "edit" }), grant(ana, { paths: ["Budget"], access: "edit" }));
    expect(check(roster, change({ path: "budget", name: "budget" }))).toEqual(stopped("ana@dohc.test cannot edit budget."));
  });

  it("stops every step when a path is not one the engine would list", () => {
    for (const path of ["Trip/../Budget", "Trip\\Records", "./Trip", "Trip/", "Trip.", "TRIPPL~1", "/Trip", "Trip/%2e%2e/Budget"]) {
      expect(check(owner(), change({ path, name: "Target" })), path).toEqual(stopped(`"${path}" is not a path in this workspace.`));
      expect(checkAutomationReach(owner(), { id: "a", collection: { path, name: "Trip" }, codeFiles: [], steps: everyStep }), path)
        .toEqual(everyStep.map(() => stopped(`"${path}" is not a path in this workspace.`)));
    }
    expect(check(owner(), change(trip), trip, ["Trip/../Budget/code.js"]))
      .toEqual(stopped('"Trip/../Budget/code.js" is not a path in this workspace.'));
  });

  it("never reaches into shared-with-me, whatever its spelling, and never runs a Collection that came through a share", () => {
    for (const path of ["shared-with-me/Ana/Budget", "Shared-With-Me/Ana/Budget", "SHARED~1/Ana/Budget", "shared-with-me./Budget"]) {
      const received = { path, name: "Budget" };
      expect(check(owner(), change(received)), path).toEqual(stopped("Budget came to you through a share, so automations cannot use it."));
      expect(check(owner(), notify(OWNER), received), path)
        .toEqual(stopped("Budget came to you through a share, so its automations cannot run."));
    }
    expect(check(owner(), change({ path: "Trip/../shared-with-me/Budget", name: "Budget" })).allowed).toBe(false);
    expect(check({ kind: "shared-view" }, change({ path: "shared-with-me/Trip", name: "Trip" }), { path: "shared-with-me", name: "All" }))
      .toEqual(stopped("All came to you through a share, so its automations cannot run."));
  });

  it("counts only people with Edit on the Collection as editors", () => {
    const roster = owner(grant(ana, { paths: ["Trip"], access: "comment" }), grant(ben, { paths: ["Trip"], access: "view" }));
    expect(check(roster, change(budget))).toEqual(allowed);
    expect(check(roster, personal(OWNER))).toEqual(allowed);
  });

  it("counts a pending invite as an editor, named by its email", () => {
    const roster = owner(grant({ email: "cai@dohc.test" }, { paths: ["Trip"], access: "edit" }));
    expect(check(roster, change(budget))).toEqual(stopped("cai@dohc.test cannot edit Budget."));
  });

  it("joins one person's grants across shares, and names someone with no email", () => {
    const roster = owner(grant(ana, { paths: ["Trip"], access: "edit" }), grant(ana, { paths: ["Budget"], access: "edit" }));
    expect(check(roster, change(budget))).toEqual(allowed);
    const unnamed = owner(grant({ userId: "u-dan" }, { paths: ["Trip"], access: "edit" }));
    expect(check(unnamed, change(budget))).toEqual(stopped("Someone you shared with cannot edit Budget."));
  });

  it("ignores a grant to the owner's own account", () => {
    expect(check(owner(grant({ userId: OWNER }, { paths: ["Trip"], access: "edit" })), personal(OWNER))).toEqual(allowed);
  });

  it("reads a Group's read-write as Edit on its folder and a post in its chat, and read-only as neither", () => {
    const readWrite = grant(ana, { paths: ["Trip"], access: "edit" }, { wireId: "wire-trip", canPost: true });
    expect(check(owner(readWrite), post("wire-trip", "Trip team"))).toEqual(allowed);
    expect(check(owner(readWrite), post("wire-family"))).toEqual(stopped("ana@dohc.test cannot post in Family."));
    expect(check(owner(readWrite), post(null))).toEqual(stopped("ana@dohc.test cannot post in Family."));
    const readOnly = grant(ana, { paths: ["Trip"], access: "view" }, { wireId: "wire-trip", canPost: false });
    expect(check(owner(readOnly), post("wire-family"))).toEqual(allowed);
    expect(check(owner(readOnly, grant(ben, { paths: ["Trip"], access: "edit" }), grant(ben, null, { wireId: "wire-trip", canPost: false })), post("wire-trip")))
      .toEqual(stopped("ben@dohc.test cannot post in Family."));
  });

  it("lets every editor with a read-write chat grant be posted for", () => {
    const roster = owner(grant(ana, { paths: ["Trip"], access: "edit" }), grant(ana, null, { wireId: "wire-family", canPost: true }));
    expect(check(roster, post("wire-family"))).toEqual(allowed);
  });

  it("notifies only people who can view the Collection", () => {
    const roster = owner(
      grant(ana, { paths: ["Trip"], access: "view" }),
      grant(ben, { paths: ["Trip"], access: "edit", versionId: "v-1" }),
    );
    expect(check(roster, notify(OWNER))).toEqual(allowed);
    expect(check(roster, notify("u-ana"))).toEqual(allowed);
    expect(check(roster, notify("u-ben"))).toEqual(stopped("ben@dohc.test cannot view Trip."));
    expect(check(roster, notify("u-cai", "Cai"))).toEqual(stopped("Cai cannot view Trip."));
  });

  it("allows a personal step only when its person is the only editor", () => {
    expect(check(owner(), personal(OWNER))).toEqual(allowed);
    expect(check(owner(grant(ana, { paths: ["Trip"], access: "edit" })), personal(OWNER)))
      .toEqual(stopped("This step acts as you, and ana@dohc.test can also edit Trip."));
    expect(check(owner(grant(ana, { paths: ["Trip"], access: "edit" })), personal("u-ana")))
      .toEqual(stopped("This step acts as ana@dohc.test, and you can also edit Trip."));
    expect(check(owner(), personal("u-cai", "Cai"))).toEqual(stopped("This step acts as Cai, and you can also edit Trip."));
  });

  it("allows a personal step in a workspace that does not sync with no account signed in", () => {
    const local: ReachRoster = { kind: "owner", ownerUserId: null, grants: [] };
    expect(check(local, personal("u-anyone"))).toEqual(allowed);
    expect(check(local, change(budget))).toEqual(allowed);
  });

  it("counts a grant pinned to a saved version as an editor only when it names paths, and never as reach", () => {
    const whole = grant(ana, { paths: [], access: "edit", versionId: "v-1" });
    expect(check(owner(whole), personal(OWNER))).toEqual(allowed);
    expect(check(owner(whole), change(budget))).toEqual(allowed);
    const pinned = grant(ana, { paths: ["Trip"], access: "edit", versionId: "v-1" });
    expect(check(owner(pinned), personal(OWNER))).toEqual(stopped("This step acts as you, and ana@dohc.test can also edit Trip."));
    expect(check(owner(pinned), change(trip))).toEqual(stopped("ana@dohc.test cannot edit Trip."));
  });

  it("stops every step, even inside the Collection, when the owner's computer does not know the roster", () => {
    const cases: Array<[ReachRoster, string]> = [
      [{ kind: "unknown", problem: { kind: "unchecked", next: "Sign in to the account that synced this workspace." } },
        "dohc could not check who can edit Trip. Sign in to the account that synced this workspace."],
      [{ kind: "unknown", problem: { kind: "damaged-share", recipientEmail: "ana@dohc.test" } },
        "dohc can't read what your share with ana@dohc.test grants. End it in Settings → Sync and sharing, then try again."],
      [{ kind: "unknown", problem: { kind: "damaged-share", recipientEmail: null } },
        "dohc can't read what one of your shares grants. End it in Settings → Sync and sharing, then try again."],
      [{ kind: "unknown", problem: { kind: "damaged-link" } },
        "dohc can't read what one of your share links grants. End it from Share… on any file, then try again."],
      [{ kind: "unknown", problem: { kind: "unusable-listing" } },
        "dohc could not read this workspace's shares from your server. Try again later."],
    ];
    for (const [roster, reason] of cases) {
      expect(checkAutomationReach(roster, { id: "a", collection: trip, codeFiles: [], steps: everyStep }))
        .toEqual(everyStep.map(() => stopped(reason)));
    }
  });

  it("allows only steps inside the Collection on a collaborator's computer", () => {
    expect(check({ kind: "shared-view" }, change(trip))).toEqual(allowed);
    expect(check({ kind: "shared-view" }, find({ path: "Trip/Packing", name: "Packing" }))).toEqual(allowed);
    expect(check({ kind: "shared-view" }, change({ path: "trip", name: "trip" })))
      .toEqual(stopped("In a shared view, automations can use only Trip."));
    for (const step of [change(budget), find(budget), post("wire-family"), notify(OWNER), personal(OWNER)]) {
      expect(check({ kind: "shared-view" }, step)).toEqual(stopped("In a shared view, automations can use only Trip."));
    }
  });
});

describe("share impact", () => {
  const automations: ReachAutomation[] = [
    { id: "stamp", collection: trip, codeFiles: [], steps: [change(trip), change(budget), personal(OWNER), find({ path: "Notes", name: "Notes" })] },
    { id: "log", collection: budget, codeFiles: [], steps: [change(trip)] },
  ];

  it("names the steps a new editor would stop, and only those", () => {
    const roster = owner(grant(ben, { paths: ["Notes"], access: "view" }));
    expect(shareImpactOf(roster, { paths: ["Trip"], versionId: null, access: "edit", recipientEmail: "ana@dohc.test" }, automations))
      .toEqual([
        { automationId: "stamp", step: 1, reason: "ana@dohc.test cannot edit Budget." },
        { automationId: "stamp", step: 2, reason: "This step acts as you, and ana@dohc.test can also edit Trip." },
        { automationId: "stamp", step: 3, reason: "ana@dohc.test cannot view Notes." },
      ]);
  });

  it("counts whoever opens an Edit link as one new editor, apart from everyone the roster lists", () => {
    // Ana already edits Trip with the reach Budget needs; the link's opener does not.
    const roster = owner(grant(ana, { paths: ["Trip", "Budget", "Notes"], access: "edit" }));
    expect(shareImpactOf(roster, { paths: ["Trip"], versionId: null, access: "edit", recipientEmail: null }, automations))
      .toEqual([
        { automationId: "stamp", step: 1, reason: "Someone you shared with cannot edit Budget." },
        { automationId: "stamp", step: 3, reason: "Someone you shared with cannot view Notes." },
      ]);
  });

  it("names the steps a share of automations.yaml alone would stop", () => {
    expect(shareImpactOf(owner(), { paths: ["Trip/automations.yaml"], versionId: null, access: "edit", recipientEmail: "ana@dohc.test" }, automations))
      .toEqual([
        { automationId: "stamp", step: 0, reason: "ana@dohc.test cannot edit Trip." },
        { automationId: "stamp", step: 1, reason: "ana@dohc.test cannot edit Budget." },
        { automationId: "stamp", step: 2, reason: "This step acts as you, and ana@dohc.test can also edit Trip." },
        { automationId: "stamp", step: 3, reason: "ana@dohc.test cannot view Notes." },
      ]);
  });

  it("stops nothing for a View share, a whole-version share, or a share that only widens an editor's reach", () => {
    const roster = owner(grant(ana, { paths: ["Trip"], access: "edit" }), grant(ana, { paths: ["Notes"], access: "view" }));
    expect(shareImpactOf(owner(), { paths: ["Trip"], versionId: null, access: "view", recipientEmail: "ana@dohc.test" }, automations)).toEqual([]);
    expect(shareImpactOf(owner(), { paths: [], versionId: "v-1", access: "edit", recipientEmail: "ana@dohc.test" }, automations)).toEqual([]);
    // Ana already edits Trip, so her steps there already stop. Budget widens her reach.
    expect(shareImpactOf(roster, { paths: ["Budget"], versionId: null, access: "edit", recipientEmail: "ANA@dohc.test" }, automations)).toEqual([]);
  });

  it("changes nothing off the owner's computer or when the roster is unknown", () => {
    for (const roster of [{ kind: "shared-view" }, { kind: "unknown", problem: { kind: "unusable-listing" } }] as const) {
      expect(shareImpactOf(roster, { paths: ["Trip"], versionId: null, access: "edit", recipientEmail: "ana@dohc.test" }, automations)).toEqual([]);
    }
  });
});
