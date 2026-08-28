import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const storageSource = readFileSync(new URL("./storage.ts", import.meta.url), "utf8");

function createShareSource(): string {
  const classStart = storageSource.indexOf(
    "class SqliteSyncRelayStorage implements SyncRelayStorage",
  );
  const start = storageSource.indexOf("  createShare(input: {", classStart);
  const end = storageSource.indexOf("\n  createFileLinkShare(input: {", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return storageSource.slice(start, end);
}

describe("SqliteSyncRelayStorage.createShare source contract", () => {
  it("validates before inserting a share and grant through the helpers", () => {
    const methodSource = createShareSource();
    const shareValidation = methodSource.indexOf(
      "input.grant.shareId !== input.share.shareId",
    );
    const grantValidation = methodSource.indexOf(
      'input.grant.principalKind === "link"',
    );
    const transaction = methodSource.indexOf("this.tx(() => {");

    expect(shareValidation).toBeGreaterThanOrEqual(0);
    expect(grantValidation).toBeGreaterThan(shareValidation);
    expect(transaction).toBeGreaterThan(grantValidation);
    expect(methodSource.slice(transaction)).toMatch(
      /this\.insertShare\(input\.share\);\s*this\.insertShareGrant\(input\.grant\);/,
    );
    expect(methodSource).not.toContain("INSERT INTO");
  });
});
