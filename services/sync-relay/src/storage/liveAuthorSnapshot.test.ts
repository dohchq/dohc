import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveAuthorContext } from "@dohc/live-session-contract";
import type { ServerDerivedLiveUpdateAuthority } from "@dohc/live-session-contract/live-update-admission";
import { openSyncRelayStorage } from "../storage";
import type { StorageContext } from "./context";
import {
  admitsWorkspaceLiveAuthorship,
  claimsPersonalAgent,
  deriveLiveAuthorSnapshot,
  ensureLiveLinkPublicPrincipal,
  personalLiveAuthorSnapshot,
} from "./liveAuthorSnapshot";
import { workspaceUsageBytes } from "./workspaces";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
const account = { accountId: "owner", name: "Trusted owner" };
const owner: ServerDerivedLiveUpdateAuthority = {
  principalKind: "owner",
  principalId: "owner",
  grantId: null,
  grantGeneration: null,
};
const named: ServerDerivedLiveUpdateAuthority = {
  principalKind: "named",
  principalId: "owner",
  grantId: "grant-private",
  grantGeneration: 1,
};
const link: Extract<ServerDerivedLiveUpdateAuthority, { principalKind: "named" | "link" }> = {
  principalKind: "link",
  principalId: "principal-private",
  grantId: "grant-private",
  grantGeneration: 1,
};
const agent = { agentId: "writer", agentName: "Writer", onBehalfOf: "owner", depth: 1 };

it("binds a recipient's agent to the recipient despite a declared owner", () => {
  const authority = { ...named, principalId: "reader" };
  const context: LiveAuthorContext = { kind: "account", accountId: "reader", agent };
  expect(
    deriveLiveAuthorSnapshot(fixture(), authority, context, {
      accountId: "reader",
      name: "Reader",
    }),
  ).toEqual([
    { kind: "human", humanId: "reader", humanName: "Reader" },
    { kind: "agent", ...agent, onBehalfOf: "reader" },
  ]);
  expect(context.agent?.onBehalfOf).toBe("owner");
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "live-author-snapshot-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const storage = openSyncRelayStorage(join(directory, "relay.sqlite")) as StorageContext;
  cleanups.push(() => storage.close());
  storage.claimWorkspace({ workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1 });
  storage.createShare({
    share: {
      shareId: "share",
      workspaceId: "workspace",
      granterUserId: "owner",
      selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }),
      createdAtMs: 1,
    },
    grant: {
      grantId: link.grantId,
      shareId: "share",
      principalKind: "user",
      principalUserId: "reader",
      principalEmail: null,
      access: "edit",
      generation: 1,
      status: "active",
      createdAtMs: 1,
      revokedAtMs: null,
      parentGrantId: null,
    },
  });
  storage.db
    .prepare(
      "UPDATE sync_relay_share_grants SET principal_kind='link',principal_user_id=NULL WHERE grant_id=?",
    )
    .run(link.grantId);
  storage.db
    .prepare(`INSERT INTO sync_relay_link_principals (
    principal_id,grant_id,mint_generation,profile_token_hash,display_name,created_at_ms,blocked_at_ms,discussion_revision,storage_bytes)
    VALUES (?,?,1,'profile-private','Sam',1,NULL,0,256)`)
    .run(link.principalId, link.grantId);
  return storage;
}

it.each([owner])(
  "uses the trusted account name for matching $principalKind context",
  (authority) => {
    const storage = fixture();
    expect(
      deriveLiveAuthorSnapshot(
        storage,
        authority,
        { kind: "account", accountId: "owner", agent },
        account,
      ),
    ).toEqual([
      { kind: "human", humanId: "owner", humanName: "Trusted owner" },
      { kind: "agent", ...agent },
    ]);
  },
);

it.each(["Owner\u0000"])(
  "keeps owner attribution bounded when the trusted name is invalid",
  (name) => {
    expect(
      deriveLiveAuthorSnapshot(
        fixture(),
        owner,
        { kind: "account", accountId: "owner" },
        { ...account, name },
      ),
    ).toEqual([{ kind: "human", humanId: "owner", humanName: "Unnamed" }]);
  },
);

// Only the relay attributes work to a personal agent, so no recording context may name one.
const personal = { ...agent, agentId: `p-${"a".repeat(26)}` };
it.each<[string, ServerDerivedLiveUpdateAuthority, (publicId: string) => LiveAuthorContext]>([
  ["owner", owner, () => ({ kind: "account", accountId: "owner", agent: personal })],
])(
  "refuses an %s recording context that declares a personal agent",
  (_kind, authority, context) => {
    const storage = fixture(),
      publicId = storage.tx(() => ensureLiveLinkPublicPrincipal(storage, link));
    expect(claimsPersonalAgent(context(publicId))).toBe(true);
    expect(() =>
      storage.tx(() => deriveLiveAuthorSnapshot(storage, authority, context(publicId), account)),
    ).toThrow(/personal agent/);
    const own = { ...context(publicId), agent } as LiveAuthorContext;
    expect(claimsPersonalAgent(own)).toBe(false);
    expect(
      storage.tx(() => deriveLiveAuthorSnapshot(storage, authority, own, account)),
    ).toContainEqual(expect.objectContaining({ kind: "agent", agentId: "writer" }));
  },
);

it("reuses a durable public mapping and publishes only its ID and stored label", () => {
  const storage = fixture(),
    before = workspaceUsageBytes(storage, "workspace");
  const publicId = storage.tx(() => ensureLiveLinkPublicPrincipal(storage, link));
  expect(publicId).toMatch(/^public_/);
  const row = storage.db.prepare("SELECT * FROM sync_relay_app_public_principals").get()!;
  const charged = workspaceUsageBytes(storage, "workspace");
  expect(charged - before).toBe(row.storage_bytes);
  expect(storage.tx(() => ensureLiveLinkPublicPrincipal(storage, link))).toBe(publicId);
  expect(workspaceUsageBytes(storage, "workspace")).toBe(charged);
  const snapshot = storage.tx(() =>
    deriveLiveAuthorSnapshot(storage, link, { kind: "link", publicPrincipalId: publicId, agent }),
  );
  expect(snapshot).toEqual([
    { kind: "link", publicPrincipalId: publicId, label: "Sam" },
    { kind: "agent", ...agent, onBehalfOf: publicId },
  ]);
  expect(
    deriveLiveAuthorSnapshot(storage, link, {
      kind: "link",
      publicPrincipalId: publicId,
      agent: { ...agent, onBehalfOf: "other" },
    }),
  ).toEqual(snapshot);
  const serialized = JSON.stringify(snapshot);
  expect(serialized).not.toContain(link.principalId);
  expect(serialized).not.toContain(link.grantId);
  expect(serialized).not.toContain("profile-private");
  storage.db
    .prepare("UPDATE sync_relay_link_principals SET display_name=NULL WHERE principal_id=?")
    .run(link.principalId);
  expect(
    storage.tx(() =>
      deriveLiveAuthorSnapshot(storage, link, { kind: "link", publicPrincipalId: publicId }),
    ),
  ).toEqual([{ kind: "link", publicPrincipalId: publicId, label: "Anonymous" }]);
});

it("leaves a different public link context unnamed, including its agent declaration", () => {
  const storage = fixture();
  expect(
    storage.tx(() =>
      deriveLiveAuthorSnapshot(storage, link, {
        kind: "link",
        publicPrincipalId: "public_other",
        agent,
      }),
    ),
  ).toEqual([]);
  expect(
    storage.db.prepare("SELECT COUNT(*) AS count FROM sync_relay_app_public_principals").get()!
      .count,
  ).toBe(0);
  const before = workspaceUsageBytes(storage, "workspace");
  storage.options.workspaceQuotaBytes = before;
  expect(
    storage.tx(() =>
      deriveLiveAuthorSnapshot(storage, link, {
        kind: "link",
        publicPrincipalId: "public_other",
        agent,
      }),
    ),
  ).toEqual([]);
  expect(workspaceUsageBytes(storage, "workspace")).toBe(before);
});

it("checks the enrolled principal's grant when an existing mapping matches", () => {
  const storage = fixture(),
    publicId = storage.tx(() => ensureLiveLinkPublicPrincipal(storage, link));
  const principal = storage.getLinkPrincipal(link.principalId)!;
  const read = vi
    .spyOn(storage, "getLinkPrincipal")
    .mockReturnValue({ ...principal, grantId: "other-grant" });
  expect(() =>
    deriveLiveAuthorSnapshot(storage, link, { kind: "link", publicPrincipalId: publicId }),
  ).toThrow(/principal changed/);
  read.mockRestore();
});

it("refuses a fresh mapping at quota without leaving a partial write", () => {
  const storage = fixture();
  const before = workspaceUsageBytes(storage, "workspace");
  storage.options.workspaceQuotaBytes = before;
  expect(() => storage.tx(() => ensureLiveLinkPublicPrincipal(storage, link))).toThrow(
    /quota exceeded/,
  );
  expect(
    storage.db.prepare("SELECT COUNT(*) AS count FROM sync_relay_app_public_principals").get()!
      .count,
  ).toBe(0);
  expect(workspaceUsageBytes(storage, "workspace")).toBe(before);
});

it("refuses a principal from another grant and detects a damaged mapping", () => {
  const storage = fixture();
  expect(() =>
    storage.tx(() => ensureLiveLinkPublicPrincipal(storage, { ...link, grantId: "other-grant" })),
  ).toThrow(/unavailable/);
  storage.tx(() => ensureLiveLinkPublicPrincipal(storage, link));
  storage.claimWorkspace({
    workspaceId: "other-workspace",
    ownerUserId: "other-owner",
    createdAtMs: 1,
  });
  storage.db
    .prepare("UPDATE sync_relay_app_public_principals SET workspace_id='other-workspace'")
    .run();
  expect(() => storage.tx(() => ensureLiveLinkPublicPrincipal(storage, link))).toThrow(/damaged/);
});

it("requires the authenticated account to match, even when the recording context matches", () => {
  const storage = fixture(),
    context = { kind: "account" as const, accountId: "owner", agent };
  expect(deriveLiveAuthorSnapshot(storage, owner, context)).toEqual([]);
  expect(
    deriveLiveAuthorSnapshot(storage, owner, context, { ...account, accountId: "other" }),
  ).toEqual([]);
  expect(deriveLiveAuthorSnapshot(storage, link, context, account)).toEqual([]);
});

const helper: Extract<ServerDerivedLiveUpdateAuthority, { principalKind: "personal" }> = {
  principalKind: "personal",
  principalId: `p-${"b".repeat(26)}`,
  grantId: null,
  grantGeneration: null,
};
function withHelper(ownerUserId = "owner") {
  const storage = fixture();
  storage.db
    .prepare(`INSERT INTO sync_relay_personal_agents(agent_id,owner_user_id,name,hue,status,epoch,created_at_ms)
    VALUES (?,?,'Helper','blue','active',1,1)`)
    .run(helper.principalId, ownerUserId);
  return storage;
}

it("builds a personal agent's snapshot from its record, on behalf of its owner", () => {
  const storage = withHelper();
  const built = {
    kind: "agent" as const,
    agentId: helper.principalId,
    agentName: "Helper",
    onBehalfOf: "owner",
  };
  expect(personalLiveAuthorSnapshot(storage, helper)).toEqual([built]);
  storage.db
    .prepare("UPDATE sync_relay_personal_agents SET name='Renamed' WHERE agent_id=?")
    .run(helper.principalId);
  expect(personalLiveAuthorSnapshot(storage, helper)).toEqual([{ ...built, agentName: "Renamed" }]);
  expect(personalLiveAuthorSnapshot(storage, { ...helper, principalId: personal.agentId })).toEqual(
    [],
  );
});

it("admits a personal agent's update only on behalf of the workspace's owner", () => {
  const storage = withHelper();
  const built = {
    kind: "agent" as const,
    agentId: helper.principalId,
    agentName: "Helper",
    onBehalfOf: "owner",
  };
  expect(
    admitsWorkspaceLiveAuthorship(
      storage,
      "workspace",
      helper,
      personalLiveAuthorSnapshot(storage, helper),
    ),
  ).toBe(true);
  expect(
    admitsWorkspaceLiveAuthorship(storage, "workspace", helper, [
      { ...built, onBehalfOf: "reader" },
    ]),
  ).toBe(false);
  expect(admitsWorkspaceLiveAuthorship(storage, "missing-workspace", helper, [built])).toBe(false);
  const other = withHelper("other-owner");
  expect(
    admitsWorkspaceLiveAuthorship(
      other,
      "workspace",
      helper,
      personalLiveAuthorSnapshot(other, helper),
    ),
  ).toBe(false);
  expect(
    admitsWorkspaceLiveAuthorship(storage, "workspace", owner, [{ kind: "agent", ...agent }]),
  ).toBe(true);
  expect(
    admitsWorkspaceLiveAuthorship(storage, "workspace", owner, [{ kind: "agent", ...personal }]),
  ).toBe(false);
});
