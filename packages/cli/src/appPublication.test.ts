import { describe, expect, it } from "vitest";
import { OwnerAppPublicationResult } from "./appPublication";
import { parseCliArguments } from "./args";

const capability = { kind: "collection-create", collectionPath: "responses", schemaSha256: "a".repeat(64),
  allowedFields: ["destination", "name"], requiredFields: ["destination"], readFields: ["destination"] };
const prepared = { kind: "prepared", approvalId: "00000000-0000-4000-8000-000000000001", candidateDigest: "b".repeat(64),
  appRoot: "app", versionId: "main", sourceRevision: "c".repeat(64), sourcePaths: ["app/main.js", "responses/collection.yaml"],
  capabilities: [capability], externalNetwork: true };

describe("owner publication review contract", () => {
  it("supports local preparation and approved bundle launch without share identities", () => {
    expect(parseCliArguments(["app", "prepareLocal", JSON.stringify({ workspaceId: "w", appRoot: "app" })], {})).toMatchObject({
      verb: "appPublication", request: { action: "prepareLocal", workspaceId: "w", appRoot: "app" },
    });
    expect(parseCliArguments(["app", "launchLocal", JSON.stringify({ workspaceId: "w", publicationId: "a".repeat(64) })], {})).toMatchObject({
      verb: "appPublication", request: { action: "launchLocal", workspaceId: "w", publicationId: "a".repeat(64) },
    });
  });
  it("requires current collection approval state and preserves damaged approvals", () => {
    const row = {publicationId:"d".repeat(64),authorityRevision:2,shareId:"s",grantId:"g",active:true,linkCurrent: true, manifestUnavailable: false,appRoot:"app",sourceRevision:"c".repeat(64)};
    const list = (publication: unknown) => ({kind:"listed",publications:[publication],nextCursor:null});
    expect(OwnerAppPublicationResult.safeParse(list(row)).success).toBe(false);
    for (const collectionCapability of [null, capability, "unavailable"]) {
      const value = list({...row,collectionCapability,backendCapability:null});
      expect(OwnerAppPublicationResult.parse(value)).toEqual(value);
    }
  });
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
