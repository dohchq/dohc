import { describe, expect, it } from "vitest";
import {
  checkAutomationReach,
  shareImpactOf,
  type ReachAutomation,
  type ReachRoster,
  type ReachStep,
} from "./automationReach";
import type { RosterGrant } from "./shareRoster";

const OWNER = "u-owner";
const trip = { path: "Trip", name: "Trip" };
const budget = { path: "Budget", name: "Budget" };

let grants = 0;

function grant(
  recipient: { userId?: string; email?: string },
  files: { paths: string[]; access: "view" | "comment" | "edit"; versionId?: string } | null,
  channel: { wireId: string; canPost: boolean } | null = null,
): RosterGrant {
  grants += 1;
  return {
    grantId: `g-${grants}`,
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

function check(roster: ReachRoster, step: ReachStep, collection = trip) {
  return checkAutomationReach(roster, { id: "a", collection, steps: [step] })[0];
}

const change = (collection: { path: string; name: string }): ReachStep => ({ kind: "change-records", collection });
const find = (collection: { path: string; name: string }): ReachStep => ({ kind: "find-records", collection });
const post = (channelWireId: string | null, name = "Family"): ReachStep => ({ kind: "post", group: { channelWireId, name } });
const notify = (userId: string, name = "Someone"): ReachStep => ({ kind: "notify", person: { userId, name } });
const personal = (userId: string, name = "Someone"): ReachStep => ({ kind: "personal", person: { userId, name } });
const allowed = { allowed: true };
const stopped = (reason: string) => ({ allowed: false, reason });

describe("reach check", () => {
  it("lets the only editor reach everything the owner can", () => {
    const roster = owner(grant(ana, { paths: ["Trip"], access: "view" }));
    expect(checkAutomationReach(roster, {
      id: "a", collection: trip,
      steps: [change(budget), find(budget), post("wire-family"), notify(OWNER), personal(OWNER)],
    })).toEqual([allowed, allowed, allowed, allowed, allowed]);
  });

  it("always allows steps inside the Collection, including a Collection nested in it", () => {
    const roster = owner(grant(ana, { paths: ["Trip"], access: "edit" }));
    expect(check(roster, change(trip))).toEqual(allowed);
    expect(check(roster, find({ path: "Trip/Packing", name: "Packing" }))).toEqual(allowed);
    expect(check({ kind: "unknown", cause: "not-listed" }, change(trip))).toEqual(allowed);
    expect(check({ kind: "shared-view" }, change(trip))).toEqual(allowed);
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
    // A grant on a child does not cover its parent.
    const child = grant(ana, { paths: ["Budget/2026"], access: "edit" });
    expect(check(owner(grant(ana, { paths: ["Trip"], access: "edit" }), child), change(budget)))
      .toEqual(stopped("ana@dohc.test cannot edit Budget."));
    // "Trip" does not cover "Trip 2", so Ana does not edit it.
    expect(check(owner(grant(ana, { paths: ["Trip"], access: "edit" })), change(budget), { path: "Trip 2", name: "Trip 2" }))
      .toEqual(allowed);
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

  it("counts a grant pinned to a saved version as an editor that reaches nothing now", () => {
    const pinned = grant(ana, { paths: [], access: "edit", versionId: "v-1" });
    expect(check(owner(pinned), personal(OWNER))).toEqual(stopped("This step acts as you, and ana@dohc.test can also edit Trip."));
    expect(check(owner(pinned), change(budget))).toEqual(stopped("ana@dohc.test cannot edit Budget."));
  });

  it("allows only steps inside the Collection when the roster is unknown", () => {
    expect(check({ kind: "unknown", cause: "not-listed" }, change(budget)))
      .toEqual(stopped("dohc has not checked who else can edit Trip. Connect to your server, then try again."));
    expect(check({ kind: "unknown", cause: "not-listed" }, notify(OWNER)).allowed).toBe(false);
    expect(check({ kind: "unknown", cause: "unreadable" }, personal(OWNER)))
      .toEqual(stopped("dohc could not read a share in this workspace. End it in Settings → Cloud, then try again."));
  });

  it("allows only steps inside the Collection on a collaborator's computer", () => {
    for (const step of [change(budget), find(budget), post("wire-family"), notify(OWNER), personal(OWNER)]) {
      expect(check({ kind: "shared-view" }, step)).toEqual(stopped("In a shared view, automations can use only Trip."));
    }
  });

  it("never reaches into shared-with-me, and never runs a Collection that came through a share", () => {
    const received = { path: "shared-with-me/Ana/Budget", name: "Budget" };
    expect(check(owner(), change(received))).toEqual(stopped("Budget came to you through a share, so automations cannot use it."));
    expect(check(owner(), find(received))).toEqual(stopped("Budget came to you through a share, so automations cannot use it."));
    expect(check(owner(), change(received), received))
      .toEqual(stopped("Budget came to you through a share, so its automations cannot run."));
    expect(check(owner(), notify(OWNER), received).allowed).toBe(false);
  });
});

describe("share impact", () => {
  const automations: ReachAutomation[] = [
    { id: "stamp", collection: trip, steps: [change(trip), change(budget), personal(OWNER), find({ path: "Notes", name: "Notes" })] },
    { id: "log", collection: budget, steps: [change(trip)] },
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

  it("stops nothing for a View share or a share that only widens an editor's reach", () => {
    const roster = owner(grant(ana, { paths: ["Trip"], access: "edit" }), grant(ana, { paths: ["Notes"], access: "view" }));
    expect(shareImpactOf(owner(), { paths: ["Trip"], versionId: null, access: "view", recipientEmail: "ana@dohc.test" }, automations)).toEqual([]);
    // Ana already edits Trip, so her steps there already stop. Budget widens her reach.
    expect(shareImpactOf(roster, { paths: ["Budget"], versionId: null, access: "edit", recipientEmail: "ANA@dohc.test" }, automations)).toEqual([]);
  });

  it("stops steps for a version share with Edit, and changes nothing off the owner's computer", () => {
    expect(shareImpactOf(owner(), { paths: [], versionId: "v-1", access: "edit", recipientEmail: "ana@dohc.test" }, automations))
      .toHaveLength(4);
    for (const roster of [{ kind: "shared-view" }, { kind: "unknown", cause: "not-listed" }] as const) {
      expect(shareImpactOf(roster, { paths: ["Trip"], versionId: null, access: "edit", recipientEmail: "ana@dohc.test" }, automations)).toEqual([]);
    }
  });
});
