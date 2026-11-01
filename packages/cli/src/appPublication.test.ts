import { describe, expect, it } from "vitest";
import { OwnerAppPublicationRequest, OwnerAppPublicationResult } from "./appPublication";
import { parseCliArguments } from "./args";

const capability = { kind: "collection-create", collectionPath: "responses", schemaSha256: "a".repeat(64),
  allowedFields: ["destination", "name"], requiredFields: ["destination"], readFields: ["destination"] };
const prepared = { kind: "prepared", approvalId: "00000000-0000-4000-8000-000000000001", candidateDigest: "b".repeat(64),
  appRoot: "app", versionId: "main", sourceRevision: "c".repeat(64), sourcePaths: ["app/main.js", "responses/collection.yaml"],
  capabilities: [capability], externalNetwork: true };

describe("owner publication review contract", () => {
  it("retains independent dataset binding metadata in preparation and local listings", () => {
    const datasetCapability = { kind: "dataset", name: "Orders", datasetId: "00000000-0000-4000-8000-000000000001", revision: 1, revisionSha256: "a".repeat(64),
      operationIds: ["00000000-0000-4000-8000-000000000002"], operations: [{ operationId: "00000000-0000-4000-8000-000000000002", name: "submit", access: "link", readOnly: false }] };
    expect(OwnerAppPublicationResult.parse({ ...prepared, capabilities: [datasetCapability] })).toMatchObject({ capabilities: [datasetCapability] });
    const publication = { publicationId: "b".repeat(64), authorityRevision: 1, appRoot: "app", sourceRevision: "c".repeat(64), active: true, datasetCapability };
    const local = { ...publication, approved: true };
    expect(OwnerAppPublicationResult.parse({ kind: "localListed", publications: [local] })).toEqual({ kind: "localListed", publications: [local] });
    const shared = { ...publication, shareId: "share", grantId: "grant", linkCurrent: true, manifestUnavailable: false, collectionCapability: null };
    expect(OwnerAppPublicationResult.parse({ kind: "listed", publications: [shared], nextCursor: null })).toEqual({ kind: "listed", publications: [shared], nextCursor: null });
    expect(OwnerAppPublicationResult.parse({ kind: "listUnavailable" })).toEqual({ kind: "listUnavailable" });
    expect(OwnerAppPublicationResult.safeParse({ kind: "listUnavailable", publications: [] }).success).toBe(false);
    expect(OwnerAppPublicationResult.safeParse({ ...prepared, capabilities: [{ ...datasetCapability, source: "replace rules" }] }).success).toBe(false);
  });
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
      const value = list({...row,collectionCapability,datasetCapability:null});
      expect(OwnerAppPublicationResult.parse(value)).toEqual(value);
    }
  });
  it("preserves every approved collection field for CLI readers", () => {
    expect(OwnerAppPublicationResult.parse(prepared)).toEqual(prepared);
  });
  it("lists local Collection apps with unconfirmed responses and keeps an unconfirmed withdrawal distinct", () => {
    const local = { publicationId: "b".repeat(64), authorityRevision: 3, appRoot: "app", sourceRevision: "c".repeat(64), approved: false, active: false, collectionCapability: capability, pendingCreates: 2 };
    expect(OwnerAppPublicationResult.parse({ kind: "localListed", publications: [local] })).toEqual({ kind: "localListed", publications: [local] });
    expect(OwnerAppPublicationResult.safeParse({ kind: "localListed", publications: [{ ...local, datasetCapability: null }] }).success).toBe(false);
    const { pendingCreates: _, ...withoutPending } = local;
    expect(OwnerAppPublicationResult.safeParse({ kind: "localListed", publications: [withoutPending] }).success).toBe(false);
    const unconfirmed = { kind: "withdrawalUnconfirmed", publicationId: "b".repeat(64), authorityRevision: 3, unresolvedCreates: 2 };
    expect(OwnerAppPublicationResult.parse(unconfirmed)).toEqual(unconfirmed);
    expect(OwnerAppPublicationResult.safeParse({ ...unconfirmed, unresolvedCreates: 0 }).success).toBe(false);
  });
  it.each([
    { ...capability, schemaSha256: "caller supplied" },
    { ...capability, requiredFields: ["unknown"] },
    { ...capability, allowedFields: ["created_by"] },
  ])("refuses malformed collection capabilities", invalid => {
    expect(OwnerAppPublicationResult.safeParse({ ...prepared, capabilities: [invalid] }).success).toBe(false);
  });
});


it("creates only an explicitly scoped retryable link, defaulting to View", () => {
  expect(OwnerAppPublicationRequest.parse({action:"createLink", workspaceId:"w", appRoot:"app", operationId:"00000000-0000-4000-8000-000000000001"})).toMatchObject({access:"view"});
  for (const paths of [[], [""], ["app"]]) {
    const result = OwnerAppPublicationRequest.safeParse({action:"createLink", workspaceId:"w", appRoot:"app", operationId:"00000000-0000-4000-8000-000000000001",paths});
    expect(result.success).toBe(paths.length === 1 && paths[0] === "app");
  }
  expect(OwnerAppPublicationRequest.safeParse({action:"rotateLink",workspaceId:"w"}).success).toBe(false);
  expect(OwnerAppPublicationRequest.safeParse({action:"createLink",workspaceId:"w",appRoot:"app"}).success).toBe(false);
});

it("refuses bearer material in publication results", () => {
  const published={kind:"published",publicationId:"a".repeat(64),authorityRevision:1,appQuery:"?app="+"a".repeat(64)};
  expect(OwnerAppPublicationResult.parse(published)).toEqual(published);
  expect(OwnerAppPublicationResult.safeParse({...published,url:"https://relay.example/s/#secret"}).success).toBe(false);
  expect(OwnerAppPublicationResult.safeParse({...published,urlUnavailable:{grantId:"g"}}).success).toBe(false);
});

it("preserves the operator record in owner listings and rejects caller-selected actors", () => {
  const operatorTakedown = {actor: "operator", disabledAtMs: 30, reason: "Confirmed phishing"};
  const publication = {publicationId: "a".repeat(64), authorityRevision: 2, shareId: "s", grantId: "g", active: false,
    linkCurrent: true, manifestUnavailable: true, collectionCapability: null, datasetCapability: null, operatorTakedown};
  const value = {kind: "listed", publications: [publication], nextCursor: null};
  expect(OwnerAppPublicationResult.parse(value)).toEqual(value);
  expect(OwnerAppPublicationResult.safeParse({...value, publications: [{...publication, operatorTakedown: {...operatorTakedown, actor: "owner"}}]}).success).toBe(false);
});
