import { expect, it, vi } from "vitest";
import { createAccessOwner, ownerAccessRoster } from "./accessOwner";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { RosterObservation } from "../automations/shareRoster";

const credentials: CloudCredentials = { serverUrl: "https://server.test", relayUrl: "https://relay.test",
  userId: "owner", email: "owner@test.dev", token: "test-token" };
const workspace = { workspaceId: "w", remote: { ownerUserId: "owner", serverUrl: "https://server.test" } };
const observation: RosterObservation = { checkedAtMs: 42, freshness: "fresh", listing: {
  grants: [{ shareId: "share", grantId: "grant", granterUserId: "owner", granterEmail: null,
    recipientUserId: "recipient", recipientEmail: null, subjectName: null, sharerName: null,
    generation: 1, status: "active", selector: { paths: ["Notes"], versionId: null }, access: "view" }],
  links: [], formerGrants: [], endedGrants: [],
} };

it.each([
  ["separate relay", credentials],
  ["same URLs", { ...credentials, relayUrl: credentials.serverUrl }],
  ["trailing server slash", { ...credentials, serverUrl: credentials.serverUrl + "/", relayUrl: credentials.serverUrl }],
] as const)("shows owner Access with %s", async (_case, account) => {
  const h = harness(workspace, account);
  for (const answer of [await h.owner.object(workspace, { ref }), h.owner.sharing(workspace, { lane: "granted" })]) {
    expect(answer).toMatchObject({ freshness: "fresh", checkedAtMs: 42, rows: [{ shareId: "share", grantId: "grant" }] });
  }
  expect(h.readObservation).toHaveBeenCalledWith("w");
});

it.each([
  ["different server", "other-server", { ...credentials, serverUrl: "https://other-server.test" }],
  ["different server and account", "other-server", { ...credentials, serverUrl: "https://other-server.test", userId: "other-owner" }],
  ["different server with a relay matching the workspace server", "other-server", { ...credentials,
    serverUrl: "https://other-server.test", relayUrl: workspace.remote.serverUrl }],
  ["different account", "other-account", { ...credentials, userId: "other-owner" }],
  ["different account without relay", "other-account", { ...credentials, userId: "other-owner", relayUrl: undefined }],
  ["signed out", "signed-out", null],
  ["missing relay", "unreadable", { ...credentials, relayUrl: undefined }],
] as const)("withholds owner Access for %s", async (_case, unknownReason, account) => {
  const h = harness(workspace, account);
  for (const answer of [await h.owner.object(workspace, { ref }), h.owner.sharing(workspace, { lane: "granted" })]) {
    expect(answer).toMatchObject({ freshness: "unknown", unknownReason, checkedAtMs: null, rows: [], coverage: { complete: false } });
  }
  expect(h.readObservation).not.toHaveBeenCalled();
});

it("does not use an owner's roster without an enrolled workspace", async () => {
  const entry = { ...workspace, remote: undefined };
  const unknownReason = "not-synced";
  const h = harness(entry, credentials);
  for (const answer of [await h.owner.object(entry, { ref }), h.owner.sharing(entry, { lane: "granted" })]) {
    expect(answer).toMatchObject({ freshness: "unknown", unknownReason, checkedAtMs: null, rows: [], coverage: { complete: false } });
  }
  expect(h.readObservation).not.toHaveBeenCalled();
});

const ref = { kind: "path" as const, path: "Notes/a.md", versionId: null };
function harness(entry: Pick<RegistryEntry, "workspaceId" | "remote" | "shareView">, account: CloudCredentials | null) {
  const readObservation = vi.fn(() => observation);
  const owner = createAccessOwner({
    resolve: async (_workspace: typeof entry, ref) => ({ ref, visibility: "visible" as const }),
    roster: workspace => ownerAccessRoster(workspace, account, readObservation),
    received: () => ({ inventory: null, checkedAtMs: null, freshness: "unknown" as const }),
    account: () => account ? { ...account, generation: 1 } : null,
    scope: () => "workspace-account-scope", assertCurrent: () => undefined,
    permissions: async () => { throw new Error("unused"); }, refresh: async () => ({ status: "requested" }),
  });
  return { owner, readObservation };
}

it("withholds the owner roster by design in a share view", async () => {
  const entry = { ...workspace, shareView: { shareId: "received", granterEmail: null, genericChatWritable: false,
    grantedSelector: { paths: ["Notes"], versionId: null, access: "view" as const } } };
  const h = harness(entry, credentials);
  for (const answer of [await h.owner.object(entry, { ref }), h.owner.sharing(entry, { lane: "granted" })]) {
    expect(answer).toMatchObject({ visibility: "hidden", unknownReason: null, rows: [], coverage: { kind: "unavailable" } });
  }
  expect(h.readObservation).not.toHaveBeenCalled();
});
