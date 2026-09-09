import { expect, it } from "vitest";
import { referencedBlobShas } from "./blobReferences";

it("retains the historical settlement projection", () => {
  const markdownDigest = "d".repeat(64);
  expect(referencedBlobShas("live.audit.settlement", JSON.stringify({record: {markdownDigest}}), {workspaceId: "workspace", recordedAtMs: 0})).toEqual([markdownDigest]);
});

it("retains each application audit chunk and its Y.Doc update before log append", () => {
  const update = "a".repeat(64);
  const chunks = ["b".repeat(64), "c".repeat(64)];
  const payload = { updateBlobSha256: update, manifest: { chunks: chunks.map(sha256 => ({ sha256, byteLength: 4_194_304 })) } };
  expect(referencedBlobShas("live.audit.application", JSON.stringify(payload), { workspaceId: "workspace", recordedAtMs: 0 })).toEqual([update, ...chunks]);
});
