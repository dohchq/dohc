import { describe, expect, it } from "vitest";
import vectors from "../vectors/share-grant-vectors.json";
import {
  isGrantBinding,
  isGrantStatusValue,
  isLinkCredentialRecord,
  isShareGrantRecord,
  isSharePrincipal,
} from "./shareGrant";

const contracts = [
  ["share principals", vectors.sharePrincipals, isSharePrincipal],
  ["grant statuses", vectors.grantStatuses, isGrantStatusValue],
  ["share grant records", vectors.shareGrantRecords, isShareGrantRecord],
  [
    "link credential records",
    vectors.linkCredentialRecords,
    isLinkCredentialRecord,
  ],
  ["grant bindings", vectors.grantBindings, isGrantBinding],
] as const;

describe("share grant contract vectors", () => {
  for (const [name, { accepted, refused }, guard] of contracts) {
    it(`accepts and refuses ${name}`, () => {
      for (const value of accepted)
        expect(guard(value), JSON.stringify(value)).toBe(true);
      for (const value of refused)
        expect(guard(value), JSON.stringify(value)).toBe(false);
    });
  }
});
