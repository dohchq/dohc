import { expect, it, vi } from "vitest";
import { checkAutomationReach, type ReachStep } from "./automationReach";
import { listRosterGrants, ownerRoster, readStoredRoster } from "./rosterListing";

const facts = { shareId: "share", generation: 2, status: "active", granterUserId: "owner",
  granterEmail: "owner@example.test", subjectName: "Trip", sharerName: "Owner" };
const { granterUserId, granterEmail, ...linkFacts } = facts;
const selector = { paths: ["Trip"], versionId: null };
const named = { ...facts, workspaceId: "workspace", grantId: "named", principalKind: "user",
  recipientUserId: "recipient", recipientEmail: "recipient@example.test", revokedAtMs: null,
  selector, access: "edit", automationsGeneration: null };
const link = (access: string, dependents: unknown[] = []) => ({ ...linkFacts, grantId: `link-${access}`,
  selector, access, automationsGeneration: null, dependents });
const acquire = (links: unknown[], granted: unknown[] = []) => listRosterGrants("workspace", async path => ({
  status: 200, body: path.startsWith("/sync/shares?") ? { granterUserId, granterEmail, granted } : { links },
}));

it("takes link and dependent owner facts only from the granted-page context, even with no named grants", async () => {
  const answer = await acquire([{ ...link("edit", [{ grantId: "dependent", recipientUserId: "recipient",
    recipientEmail: "recipient@example.test", generation: 1, access: "edit", granterUserId: "wrong", granterEmail: "wrong@example.test" }]),
    granterUserId: "wrong", granterEmail: "wrong@example.test" }]);
  if (answer.kind !== "answered" || answer.listing.grants === null) throw new Error("unusable listing");
  expect(answer.listing.links[0].grant).toMatchObject({ granterUserId, granterEmail });
  expect(answer.listing.grants[0]).toMatchObject({ granterUserId, granterEmail });
});

it.each([{ granted: [] }, { granterUserId: "", granterEmail: null, granted: [] },
  { granterUserId, granterEmail: 123, granted: [] }])("rejects a missing or damaged granted-page owner context: %j", async body => {
  const get = vi.fn(async (path: string) => ({ status: 200, body: path.startsWith("/sync/shares?") ? body : { links: [link("edit")] } }));
  const answer = await listRosterGrants("workspace", get);
  expect(answer).toMatchObject({ kind: "answered", listing: { grants: null, problem: { kind: "unusable-listing" } } });
  expect(get).toHaveBeenCalledTimes(1);
});

it.each(["view", "comment"])("retains an active %s link for Access without automation writes or dependents", async access => {
  const answer = await acquire([link(access)]);
  if (answer.kind !== "answered" || answer.listing.grants === null) throw new Error("unusable listing");
  expect(answer.listing.links.map(row => row.grant.grantId)).toEqual([`link-${access}`]);
});

it("retains share identity, grant generation, status and display facts for an Access row", async () => {
  const answer = await acquire([], [named]);
  if (answer.kind !== "answered" || answer.listing.grants === null) throw new Error("unusable listing");
  expect(answer.listing.grants[0]).toMatchObject(facts);
});

it("keeps all link levels and dependents without changing non-Edit automation reach", async () => {
  const links = ["view", "comment", "edit"].map(access => link(access, [{ grantId: `dependent-${access}`,
    recipientUserId: `person-${access}`, recipientEmail: `${access}@example.test`, generation: 1, access }]));
  const answer = await acquire(links, [named]);
  const baseline = await acquire([links[2]], [named]);
  if (answer.kind !== "answered" || answer.listing.grants === null || baseline.kind !== "answered") throw new Error("unusable listing");
  expect(answer.listing.links.map(row => row.grant.access)).toEqual(["comment", "edit", "view"]);
  expect(answer.listing.grants.map(row => row.grantId)).toEqual(["dependent-comment", "dependent-edit", "dependent-view", "named"]);
  const steps: ReachStep[] = [{ kind: "change-records", collection: { path: "Trip", name: "Trip" } },
    { kind: "find-records", collection: { path: "Budget", name: "Budget" } },
    { kind: "post", group: { channelWireId: "wire", name: "Group" } }];
  const automation = { id: "automation", collection: { path: "Trip", name: "Trip" }, codeFiles: [], steps };
  expect(checkAutomationReach(ownerRoster("owner", answer.listing, ""), automation))
    .toEqual(checkAutomationReach(ownerRoster("owner", baseline.listing, ""), automation));
});

it("allowlists live and stored facts, including nested links and dependents", async () => {
  const secrets = { credentials: { token: "secret" }, bearerUrl: "https://secret.test/bearer",
    browserInvitationUrl: "https://secret.test/invite", shareCode: "secret-code", token: "secret-token" };
  const answer = await acquire([{ ...link("edit", [{ grantId: "dependent", recipientUserId: "recipient",
    recipientEmail: "recipient@example.test", generation: 1, access: "edit", ...secrets }]), ...secrets }], [{ ...named, ...secrets }]);
  if (answer.kind !== "answered" || answer.listing.grants === null) throw new Error("unusable listing");
  expect(answer.listing.links[0].grant).toMatchObject(facts);
  expect(answer.listing.grants[0]).toMatchObject({ shareId: "share", generation: 1, status: "active" });
  const stored = readStoredRoster({ ...answer.listing, ...secrets,
    grants: answer.listing.grants.map(row => ({ ...row, ...secrets })) });
  expect(stored).toEqual(answer.listing);
  expect(JSON.stringify(stored)).not.toContain("secret");
});

it("reads old-shape and damaged grant facts as unknown", () => {
  const { shareId: _share, generation: _generation, status: _status, ...old } = named;
  for (const grant of [old, { ...named, generation: 0 }, { ...named, shareId: "" }, { ...named, status: "paused" }]) {
    const stored = { grants: [grant], links: [], formerGrants: [], endedGrants: [] };
    expect(readStoredRoster(stored)).toBeNull();
    expect(ownerRoster("owner", stored, "refresh")).toMatchObject({ kind: "unknown" });
  }
});

it("retains more than 1,000 active View links across pages", async () => {
  const links = Array.from({ length: 1001 }, (_, index) => ({ ...link("view"), grantId: `link-${String(index).padStart(4, "0")}` }));
  const answer = await listRosterGrants("workspace", async path => ({ status: 200,
    body: path.startsWith("/sync/shares?") ? { granterUserId, granterEmail, granted: [] }
      : path.includes("cursor=") ? { links: links.slice(1000) } : { links: links.slice(0, 1000), nextCursor: "page2" },
  }));
  if (answer.kind !== "answered" || answer.listing.grants === null) throw new Error("unusable listing");
  expect(answer.listing.links).toHaveLength(1001);
});
