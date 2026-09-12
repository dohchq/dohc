import { describe, expect, it } from "vitest";
import { OwnerAppPublicationResult } from "./appPublication";

const capability = { kind: "collection-create", collectionPath: "responses", schemaSha256: "a".repeat(64),
  allowedFields: ["destination", "name"], requiredFields: ["destination"], readFields: ["destination"] };
const prepared = { kind: "prepared", approvalId: "00000000-0000-4000-8000-000000000001", candidateDigest: "b".repeat(64),
  appRoot: "app", versionId: "main", sourceRevision: "c".repeat(64), sourcePaths: ["app/main.js", "responses/collection.yaml"],
  capabilities: [capability], externalNetwork: true };

describe("owner publication review contract", () => {
  it("preserves every approved collection field for CLI readers", () => {
    expect(OwnerAppPublicationResult.parse(prepared)).toEqual(prepared);
  });
  it.each([
    { ...capability, schemaSha256: "caller supplied" },
    { ...capability, requiredFields: ["unknown"] },
    { ...capability, allowedFields: ["created_by"] },
  ])("refuses malformed collection capabilities", invalid => {
    expect(OwnerAppPublicationResult.safeParse({ ...prepared, capabilities: [invalid] }).success).toBe(false);
  });
});
