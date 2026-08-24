import { describe, expect, it } from "vitest";
import vectors from "../vectors/share-grant-vectors.json";
import {
  isGrantBinding,
  isGrantStatusValue,
  isLinkCredentialRecord,
  isShareGrantRecord,
  isSharePrincipal,
} from "./shareGrant";

function expectVectors(
  accepted: readonly unknown[],
  refused: readonly unknown[],
  guard: (value: unknown) => boolean,
): void {
  for (const value of accepted) expect(guard(value), JSON.stringify(value)).toBe(true);
  for (const value of refused) expect(guard(value), JSON.stringify(value)).toBe(false);
}

describe("share grant contract vectors", () => {
  it("accepts and refuses share principals", () => {
    expectVectors(
      vectors.sharePrincipals.accepted,
      vectors.sharePrincipals.refused,
      isSharePrincipal,
    );
  });

  it("accepts and refuses grant statuses", () => {
    expectVectors(
      vectors.grantStatuses.accepted,
      vectors.grantStatuses.refused,
      isGrantStatusValue,
    );
  });

  it("accepts and refuses share grant records", () => {
    expectVectors(
      vectors.shareGrantRecords.accepted,
      vectors.shareGrantRecords.refused,
      isShareGrantRecord,
    );
  });

  it("accepts and refuses link credential records", () => {
    expectVectors(
      vectors.linkCredentialRecords.accepted,
      vectors.linkCredentialRecords.refused,
      isLinkCredentialRecord,
    );
  });

  it("accepts and refuses grant bindings", () => {
    expectVectors(
      vectors.grantBindings.accepted,
      vectors.grantBindings.refused,
      isGrantBinding,
    );
  });
});
