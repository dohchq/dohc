import { describe, expect, it } from "vitest";
import {
  requireShareViewMembership,
  requireShareViewProposalScope,
  sameShareViewProposalScope,
} from "./shareProposals";
import { createShareProposalOperationScope } from "./shareProposalOperationScope";

function shareView(input: {
  shareId: string;
  access: "view" | "edit";
  ended?: boolean;
}) {
  return {
    shareId: input.shareId,
    grantedSelector: {
      paths: ["docs"],
      versionId: null,
      access: input.access,
    },
    ended: input.ended === true,
  };
}

describe("share proposal operation scopes", () => {
  it.each([
    ["downgrade", shareView({ shareId: "share-a", access: "view" })],
    ["end", shareView({ shareId: "share-a", access: "edit", ended: true })],
    ["retarget", shareView({ shareId: "share-b", access: "edit" })],
  ])("rejects a submit after a concurrent %s", (_name, replacement) => {
    let live = shareView({ shareId: "share-a", access: "edit" });
    const operation = createShareProposalOperationScope({
      resolve: () => requireShareViewProposalScope(live),
      same: sameShareViewProposalScope,
      changedMessage: "shared view changed",
    });
    const beforeReconcile = operation.resolve();

    live = replacement;

    expect(() => operation.assert(beforeReconcile)).toThrow();
  });

  it("rejects a membership operation after a concurrent share retarget", () => {
    let live = shareView({ shareId: "share-a", access: "view" });
    const operation = createShareProposalOperationScope({
      resolve: () => requireShareViewMembership(live),
      same: (left, right) => left.shareId === right.shareId,
      changedMessage: "shared view changed",
    });
    const beforeRelay = operation.resolve();

    live = shareView({ shareId: "share-b", access: "view" });

    expect(() => operation.assert(beforeRelay)).toThrow("shared view changed");
  });
});
