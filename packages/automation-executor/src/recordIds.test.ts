import { describe, expect, it } from "vitest";
import { derivedRecordId } from "./recordIds";

describe("derivedRecordId", () => {
  it("derives the same valid record id from the same seed and different ids from different seeds", () => {
    const id = derivedRecordId("claim-7/0");
    expect(id).toMatch(/^rec_[a-z2-7]{26}$/);
    expect(derivedRecordId("claim-7/0")).toBe(id);
    expect(derivedRecordId("claim-7/1")).not.toBe(id);
    // Pinned (RFC 4648 base32 of the first 16 SHA-256 bytes, as the engine
    // encodes record ids) so a change to the derivation cannot orphan the
    // records earlier attempts created.
    expect(id).toBe("rec_dcsqghdllg25i2gjn2zgruogiq");
  });
});
