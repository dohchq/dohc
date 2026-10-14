import {expect, it} from "vitest";
import {parseReleasePublicationTag} from "./releaseClaim";

const tag = {releaseDigest:"a".repeat(64),restoreFenceGeneration:1,
  document:{workspaceId:"workspace",mainVersionId:"main",objectId:"object",lineageClaimId:"b".repeat(64)}};
it("parses an exact release publication identity", () => {
  expect(parseReleasePublicationTag(tag)).toEqual(tag);
});
it.each([null,[],{...tag,extra:true},{...tag,releaseId:"a".repeat(64)},{...tag,releaseDigest:"invalid"},{...tag,restoreFenceGeneration:-1},
  {...tag,restoreFenceGeneration:1.5},{...tag,document:{...tag.document,mainVersionId:"other"}},
  {...tag,document:{...tag.document,lineageClaimId:"invalid"}}])("refuses an invalid release publication tag %#", value => {
  expect(() => parseReleasePublicationTag(value)).toThrow();
});
