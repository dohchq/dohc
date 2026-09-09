import { describe, expect, it } from "vitest";
import {
  authorizeLinkShareAction,
  authorizeNamedLiveEditShareGrant,
  authorizeShareAction,
  resolveReceivedShareAuthority,
  type ShareAction,
} from "./shareAuthorization";
import type {
  SyncRelayShareGrantRow,
  SyncRelayShareRow,
} from "./storage";

type AuthorizationStorage = Parameters<typeof authorizeShareAction>[0]["storage"];

const share: SyncRelayShareRow = {
  shareId: "share-1",
  workspaceId: "workspace-1",
  granterUserId: "owner-1",
  selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }),
  createdAtMs: 1000,
};

const grant: SyncRelayShareGrantRow = {
  grantId: "grant-1",
  shareId: share.shareId,
  principalKind: "user",
  principalUserId: "recipient-1",
  principalEmail: null,
  access: "edit",
  generation: 1,
  status: "active",
  createdAtMs: 1000,
  revokedAtMs: null,
  parentGrantId: null,
};

function storageFixture(options: {
  share?: SyncRelayShareRow | null;
  grant?: SyncRelayShareGrantRow | null;
  ownerStanding?: boolean;
  channelKind?: "channel" | "dm" | "agent" | null | undefined;
} = {}): AuthorizationStorage {
  const storedShare = options.share === undefined ? share : options.share;
  const storedGrant = options.grant === undefined ? grant : options.grant;
  return {
    getShare: () => storedShare,
    getShareGrant: () => storedGrant,
    listActiveShareGrantsForRecipient: () => (storedGrant ? [storedGrant] : []),
    workspaceIsOwnedBy: () => options.ownerStanding ?? true,
    findChannelCreateKind: () => options.channelKind ?? "channel",
  };
}

function authorize(
  action: ShareAction,
  storage = storageFixture(),
  actorUserId = "recipient-1",
) {
  return authorizeShareAction({
    storage,
    actorUserId,
    shareId: share.shareId,
    action,
  });
}

function receivedAuthorityStorage(options: {
  grants: SyncRelayShareGrantRow[];
  otherGrants?: SyncRelayShareGrantRow[];
  share?: SyncRelayShareRow;
  ownerStanding?: boolean;
  channelKind?: "channel" | "dm" | "agent" | null;
  onScan?: () => void;
}): AuthorizationStorage {
  const storedShare = options.share ?? share;
  const storedGrants = [...options.grants, ...(options.otherGrants ?? [])];
  return {
    getShare: (shareId) => (shareId === storedShare.shareId ? storedShare : null),
    getShareGrant: (grantId) =>
      storedGrants.find((candidate) => candidate.grantId === grantId) ?? null,
    listActiveShareGrantsForRecipient: () => {
      options.onScan?.();
      return options.grants;
    },
    workspaceIsOwnedBy: () => options.ownerStanding ?? true,
    findChannelCreateKind: () => options.channelKind ?? "channel",
  };
}

describe("share authorization", () => {
  it("authorizes only the supplied named Edit grant for live-edit", () => {
    const view = { ...grant, grantId: "view-grant", access: "view" };
    const edit = { ...grant, grantId: "edit-grant", generation: 19 };
    const storage = receivedAuthorityStorage({
      grants: [view, edit],
      onScan: () => { throw new Error("live Edit must not scan other grants"); },
    });
    const resolve = (grantId: string) => authorizeNamedLiveEditShareGrant({
      storage, actorUserId: "recipient-1", grantId,
    });
    expect(resolve(view.grantId)).toEqual({ ok: false, reason: "stale-selector" });
    expect(resolve("missing-grant")).toEqual({ ok: false, reason: "not-authorized" });
    expect(resolve(edit.grantId)).toMatchObject({
      ok: true, grant: { grantId: edit.grantId, generation: 19 },
      effectiveSelector: { access: "edit", versionId: null, paths: ["docs"] },
    });
    edit.generation = 20;
    expect(resolve(edit.grantId)).toMatchObject({ ok: true, grant: { generation: 20 } });
  });

  it("distinguishes lost named standing from an ineligible live Edit selector", () => {
    const lostStanding: Array<Partial<SyncRelayShareGrantRow>> = [
      { status: "revoked" }, { revokedAtMs: 2000 }, { generation: 0 }, { generation: 1.5 },
      { principalUserId: "other-user" }, { principalUserId: null },
      { principalEmail: "claimed@example.test" },
      { principalKind: "link", principalUserId: null },
      { principalKind: "email", principalUserId: null, principalEmail: "recipient@example.test" },
    ];
    for (const changed of lostStanding) {
      expect(authorizeNamedLiveEditShareGrant({
        storage: storageFixture({ grant: { ...grant, ...changed } }),
        actorUserId: "recipient-1", grantId: grant.grantId,
      }), JSON.stringify(changed)).toEqual({ ok: false, reason: "not-authorized" });
    }
    for (const storage of [
      storageFixture({ grant: null }), storageFixture({ share: null }),
      storageFixture({ ownerStanding: false }),
    ]) {
      expect(authorizeNamedLiveEditShareGrant({
        storage, actorUserId: "recipient-1", grantId: grant.grantId,
      })).toEqual({ ok: false, reason: "not-authorized" });
    }
    for (const selectorJson of [
      "{", JSON.stringify({ paths: ["docs"], versionId: "pinned-version" }),
      JSON.stringify({ paths: [], versionId: null }),
      JSON.stringify({ kind: "chat-channel", channelWireId: "channel-1" }),
    ]) {
      expect(authorizeNamedLiveEditShareGrant({
        storage: storageFixture({ share: { ...share, selectorJson } }),
        actorUserId: "recipient-1", grantId: grant.grantId,
      }), selectorJson).toEqual({ ok: false, reason: "stale-selector" });
    }
    for (const access of ["view", "comment"]) {
      expect(authorizeNamedLiveEditShareGrant({
        storage: storageFixture({ grant: { ...grant, access } }),
        actorUserId: "recipient-1", grantId: grant.grantId,
      }), access).toEqual({ ok: false, reason: "stale-selector" });
    }
    expect(authorizeNamedLiveEditShareGrant({
      storage: storageFixture({ ownerStanding: false, share: { ...share, selectorJson: "{" } }),
      actorUserId: "recipient-1", grantId: grant.grantId,
    })).toEqual({ ok: false, reason: "not-authorized" });
  });

  it("keeps dependent live Edit contingent on its exact active parent", () => {
    const parent: SyncRelayShareGrantRow = {
      ...grant, grantId: "parent-link", principalKind: "link", principalUserId: null,
    };
    const dependent = { ...grant, parentGrantId: parent.grantId };
    for (const currentParent of [
      parent, null, { ...parent, status: "revoked" as const }, { ...parent, revokedAtMs: 2000 },
      { ...parent, access: "view" }, { ...parent, access: "comment" },
      { ...parent, shareId: "other-share" },
      { ...parent, principalKind: "user" as const, principalUserId: "recipient-1" },
    ]) {
      const result = authorizeNamedLiveEditShareGrant({
        storage: receivedAuthorityStorage({
          grants: [dependent], otherGrants: currentParent ? [currentParent] : [],
          onScan: () => { throw new Error("live Edit must not scan other grants"); },
        }),
        actorUserId: "recipient-1", grantId: dependent.grantId,
      });
      expect(result.ok, JSON.stringify(currentParent)).toBe(currentParent === parent);
      if (currentParent !== parent) expect(result).toEqual({ ok: false, reason: "not-authorized" });
    }
    expect(authorize("live-edit", storageFixture())).toMatchObject({ ok: true });
    expect(authorize("live-edit", storageFixture({ grant: { ...grant, access: "comment" } })))
      .toEqual({ ok: false, reason: "denied" });
    expect(authorizeLinkShareAction({
      storage: storageFixture({ grant: parent }), grantId: parent.grantId, action: "live-edit",
    })).toMatchObject({ ok: true, effectiveSelector: { access: "edit" } });
  });

  it("derives received-share read selection and generic appendability from one grant pass", () => {
    const parent: SyncRelayShareGrantRow = {
      ...grant,
      grantId: "parent-link",
      principalKind: "link",
      principalUserId: null,
      access: "edit",
    };
    const dependentComment: SyncRelayShareGrantRow = {
      ...grant,
      grantId: "dependent-comment",
      access: "comment",
      parentGrantId: parent.grantId,
    };
    const dependentEdit: SyncRelayShareGrantRow = {
      ...grant,
      grantId: "dependent-edit",
      parentGrantId: parent.grantId,
    };
    const directView = { ...grant, grantId: "direct-view", access: "view" };
    const directComment = {
      ...grant,
      grantId: "direct-comment",
      access: "comment",
    };
    const directEdit = { ...grant, grantId: "direct-edit" };
    const revoked = {
      ...directComment,
      grantId: "revoked-comment",
      status: "revoked" as const,
      generation: 2,
      revokedAtMs: 2_000,
    };
    const damagedShare = { ...share, selectorJson: "{damaged" };
    const blockedShare: SyncRelayShareRow = {
      ...share,
      selectorJson: JSON.stringify({
        kind: "chat-channel",
        channelWireId: "wire-agent",
      }),
    };
    const blockedGrant = {
      ...grant,
      grantId: "blocked-channel",
      access: "read-write",
    };
    const cases: Array<{
      name: string;
      grants: SyncRelayShareGrantRow[];
      otherGrants?: SyncRelayShareGrantRow[];
      storedShare?: SyncRelayShareRow;
      ownerStanding?: boolean;
      channelKind?: "channel" | "dm" | "agent" | null;
      selectedGrantId: string | null;
      genericChatWritable: boolean;
      fallbackGrantId?: string;
    }> = [
      {
        name: "dependent-only Comment",
        grants: [dependentComment],
        otherGrants: [parent],
        selectedGrantId: dependentComment.grantId,
        genericChatWritable: false,
      },
      {
        name: "independent-only Comment",
        grants: [directComment],
        selectedGrantId: directComment.grantId,
        genericChatWritable: true,
      },
      {
        name: "mixed dependent Edit and independent Comment",
        grants: [directComment, dependentEdit],
        otherGrants: [parent],
        selectedGrantId: dependentEdit.grantId,
        genericChatWritable: true,
      },
      {
        name: "direct View",
        grants: [directView],
        selectedGrantId: directView.grantId,
        genericChatWritable: false,
      },
      {
        name: "direct Comment",
        grants: [directComment],
        selectedGrantId: directComment.grantId,
        genericChatWritable: true,
      },
      {
        name: "direct Edit",
        grants: [directEdit],
        selectedGrantId: directEdit.grantId,
        genericChatWritable: true,
      },
      {
        name: "revoked",
        grants: [revoked],
        selectedGrantId: null,
        genericChatWritable: false,
      },
      {
        name: "lost owner",
        grants: [directComment],
        ownerStanding: false,
        selectedGrantId: null,
        genericChatWritable: false,
      },
      {
        name: "damaged selector",
        grants: [directComment],
        storedShare: damagedShare,
        selectedGrantId: null,
        genericChatWritable: false,
        fallbackGrantId: directComment.grantId,
      },
      {
        name: "blocked channel",
        grants: [blockedGrant],
        storedShare: blockedShare,
        channelKind: "agent",
        selectedGrantId: null,
        genericChatWritable: false,
        fallbackGrantId: blockedGrant.grantId,
      },
    ];

    for (const testCase of cases) {
      let scans = 0;
      const result = resolveReceivedShareAuthority({
        storage: receivedAuthorityStorage({
          grants: testCase.grants,
          otherGrants: testCase.otherGrants,
          share: testCase.storedShare,
          ownerStanding: testCase.ownerStanding,
          channelKind: testCase.channelKind,
          onScan: () => {
            scans += 1;
          },
        }),
        actorUserId: "recipient-1",
        shareId: share.shareId,
      });

      expect(scans, testCase.name).toBe(1);
      expect(result.genericChatWritable, testCase.name).toBe(
        testCase.genericChatWritable,
      );
      if (testCase.selectedGrantId === null) {
        expect(result, testCase.name).toMatchObject({
          ok: false,
          reason: "gauntlet",
          genericChatWritable: false,
        });
        if (!result.ok) {
          expect(result.fallback?.grant.grantId, testCase.name).toBe(
            testCase.fallbackGrantId,
          );
        }
      } else {
        expect(result.ok, testCase.name).toBe(true);
        if (result.ok) {
          expect(result.grant.grantId, testCase.name).toBe(testCase.selectedGrantId);
        }
      }
    }
  });

  it("applies each file-share action to the grant access", () => {
    const cases: Array<{
      access: string;
      action: ShareAction;
      allowed: boolean;
    }> = [
      { access: "view", action: "read", allowed: true },
      { access: "view", action: "presence", allowed: true },
      { access: "view", action: "list-own-proposals", allowed: true },
      { access: "view", action: "withdraw-proposal", allowed: true },
      { access: "view", action: "append", allowed: false },
      { access: "comment", action: "append", allowed: true },
      { access: "comment", action: "propose", allowed: false },
      { access: "edit", action: "append", allowed: true },
      { access: "edit", action: "propose", allowed: true },
    ];
    for (const testCase of cases) {
      const result = authorize(
        testCase.action,
        storageFixture({ grant: { ...grant, access: testCase.access } }),
      );
      expect(
        result.ok,
        `${testCase.access} ${testCase.action}`,
      ).toBe(testCase.allowed);
      if (!testCase.allowed) expect(result).toEqual({ ok: false, reason: "denied" });
    }
  });

  it("applies each chat-channel action to the grant access", () => {
    const chatShare: SyncRelayShareRow = {
      ...share,
      selectorJson: JSON.stringify({
        kind: "chat-channel",
        channelWireId: "wire-1",
      }),
    };
    for (const [access, action, allowed] of [
      ["read-only", "read", true],
      ["read-only", "presence", true],
      ["read-only", "append", false],
      ["read-write", "append", true],
      ["read-write", "propose", false],
      ["read-write", "list-own-proposals", true],
      ["read-write", "withdraw-proposal", true],
    ] as const) {
      const result = authorize(
        action,
        storageFixture({
          share: chatShare,
          grant: { ...grant, access },
        }),
      );
      expect(result.ok, `${access} ${action}`).toBe(allowed);
      if (!allowed) expect(result).toEqual({ ok: false, reason: "denied" });
    }
  });

  it("refuses version-share appends and proposals at edit access", () => {
    const versionShare: SyncRelayShareRow = {
      ...share,
      selectorJson: JSON.stringify({ paths: [], versionId: "version-1" }),
    };
    const storage = storageFixture({ share: versionShare });
    expect(authorize("read", storage).ok).toBe(true);
    expect(authorize("append", storage)).toEqual({ ok: false, reason: "denied" });
    expect(authorize("propose", storage)).toEqual({ ok: false, reason: "denied" });
  });

  it("refuses only append authority inherited from a parent link", () => {
    const parent: SyncRelayShareGrantRow = {
      ...grant,
      grantId: "parent-link",
      principalKind: "link",
      principalUserId: null,
      access: "edit",
    };
    const dependent: SyncRelayShareGrantRow = {
      ...grant,
      grantId: "dependent-grant",
      parentGrantId: parent.grantId,
    };
    const base = storageFixture({ grant: dependent });
    const storage: AuthorizationStorage = {
      ...base,
      getShareGrant: (grantId) => {
        if (grantId === dependent.grantId) return dependent;
        if (grantId === parent.grantId) return parent;
        return null;
      },
    };

    expect(authorize("read", storage)).toMatchObject({ ok: true });
    expect(authorize("append", storage)).toEqual({
      ok: false,
      reason: "denied",
    });
    expect(authorize("propose", storage)).toMatchObject({ ok: true });
  });

  it("refuses revoked grants, wrong actors, and lost granter ownership", () => {
    expect(
      authorize(
        "read",
        storageFixture({
          grant: { ...grant, status: "revoked", generation: 2, revokedAtMs: 2000 },
        }),
      ),
    ).toEqual({ ok: false, reason: "gauntlet" });
    expect(authorize("read", storageFixture(), "stranger")).toEqual({
      ok: false,
      reason: "gauntlet",
    });
    expect(authorize("read", storageFixture({ ownerStanding: false }))).toEqual({
      ok: false,
      reason: "gauntlet",
    });
  });

  it("refuses blocked channels and crossed selector/access values", () => {
    const chatShare: SyncRelayShareRow = {
      ...share,
      selectorJson: JSON.stringify({
        kind: "chat-channel",
        channelWireId: "wire-agent",
      }),
    };
    expect(
      authorize(
        "read",
        storageFixture({ share: chatShare, channelKind: "agent" }),
      ),
    ).toEqual({ ok: false, reason: "gauntlet" });
    expect(
      authorize(
        "read",
        storageFixture({ share: chatShare, grant: { ...grant, access: "edit" } }),
      ),
    ).toEqual({ ok: false, reason: "gauntlet" });
    expect(
      authorize(
        "read",
        storageFixture({ grant: { ...grant, access: "read-write" } }),
      ),
    ).toEqual({ ok: false, reason: "gauntlet" });
  });
});
