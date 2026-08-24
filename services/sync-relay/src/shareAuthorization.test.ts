import { describe, expect, it } from "vitest";
import {
  authorizeShareAction,
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
    getShareGrantForRecipient: () => storedGrant,
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

describe("share authorization", () => {
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
