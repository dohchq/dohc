import { describe, expect, it } from "vitest";
import { SharedFileReadOnlyError } from "@dohc/workspace-contracts/relay";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import {
  assertShareProposalGranter,
  requireShareViewProposalScope,
  shareProposalOpPath,
} from "./shareProposals";

// A registry marker as the share-view open path writes one.
function marker(
  overrides: {
    access?: ShareAccess | null;
    ended?: boolean;
    shareId?: string;
    paths?: string[];
  } = {},
): Record<string, unknown> {
  const access = overrides.access === undefined ? "edit" : overrides.access;
  return {
    shareId: overrides.shareId ?? "share-1",
    granterEmail: "granter@example.com",
    relayUrl: "https://relay.example.com",
    ended: overrides.ended ?? false,
    grantedSelector:
      access === null
        ? // Damage: a selector whose level the relay could not have issued.
          { paths: overrides.paths ?? ["docs"], versionId: null, access: "owner" }
        : { paths: overrides.paths ?? ["docs"], versionId: null, access },
  };
}

describe("requireShareViewProposalScope (the recipient lane)", () => {
  it("resolves the share and its pinned grant at edit level", () => {
    const scope = requireShareViewProposalScope(marker());
    expect(scope.shareId).toBe("share-1");
    expect(scope.grant.access).toBe("edit");
    expect(scope.grant.paths).toEqual(["docs"]);
  });

  it("refuses a view-level share view", () => {
    expect(() => requireShareViewProposalScope(marker({ access: "view" }))).toThrow(
      SharedFileReadOnlyError,
    );
  });

  it("refuses a comment-level share view", () => {
    expect(() =>
      requireShareViewProposalScope(marker({ access: "comment" })),
    ).toThrow(SharedFileReadOnlyError);
  });

  it("refuses a share view whose grant reads back as damage", () => {
    expect(
      () => requireShareViewProposalScope(marker({ access: null })),
      "MUTATION: a damaged grant must never resolve a submit scope",
    ).toThrow(SharedFileReadOnlyError);
  });

  it("refuses an ended edit share view", () => {
    expect(() => requireShareViewProposalScope(marker({ ended: true }))).toThrow(
      SharedFileReadOnlyError,
    );
  });

  it("refuses a marker that lost its share id", () => {
    expect(() => requireShareViewProposalScope(marker({ shareId: "" }))).toThrow(
      SharedFileReadOnlyError,
    );
  });

  // The granter's own workspace. Its marker is ABSENT, not null.
  it("refuses a workspace that is not a share view", () => {
    expect(() => requireShareViewProposalScope(undefined)).toThrow(
      "This workspace is not a shared view.",
    );
  });

  // A stored `null` is a share view whose marker lost its value, and the one
  // direction this must never fail is reading it as an ordinary workspace.
  it("refuses a share view whose whole marker lost its value", () => {
    expect(
      () => requireShareViewProposalScope(null),
      "MUTATION: a truthiness read makes a damaged marker an ordinary workspace",
    ).toThrow(SharedFileReadOnlyError);
  });
});

describe("assertShareProposalGranter (the granter lane)", () => {
  it("allows a workspace this machine owns", () => {
    expect(() => assertShareProposalGranter(undefined)).not.toThrow();
  });

  // PRESENCE, not level. An edit share view is writable and still is not the
  // granter of anything.
  it("refuses every share view, edit included", () => {
    for (const shareView of [
      marker(),
      marker({ access: "view" }),
      marker({ access: null }),
      null,
    ]) {
      expect(
        () => assertShareProposalGranter(shareView),
        "MUTATION: a share view accepting its own changes writes into someone else's workspace",
      ).toThrow("This is a shared view");
    }
  });
});

describe("shareProposalOpPath", () => {
  it("states the after path for a write and the base path for a delete", () => {
    expect(
      shareProposalOpPath({
        afterPath: "docs/b.md",
        basedOnPath: "docs/a.md",
        currentPath: "docs/a.md",
      }),
    ).toBe("docs/b.md");
    expect(
      shareProposalOpPath({
        afterPath: null,
        basedOnPath: "docs/a.md",
        currentPath: "docs/a.md",
      }),
    ).toBe("docs/a.md");
  });

  it("answers null when the relay stated no path at all", () => {
    expect(
      shareProposalOpPath({ afterPath: null, basedOnPath: null, currentPath: null }),
    ).toBeNull();
  });
});
