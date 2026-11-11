import {expect, it} from "vitest";
import * as Y from "yjs";
import {markdownToYDoc} from "../../../../packages/ydoc-projection/src/import-export";
import {WORKER_LIVE_VALIDATION_POLICY} from "../../../../packages/ydoc-projection/src/liveValidationPolicy";
import {validateOrdinaryActivation} from "./ordinaryActivationValidation";

const document = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "lineage"};
const state = (markdown: string) => {
  const doc = markdownToYDoc(markdown);
  try {return Y.encodeStateAsUpdate(doc);} finally {doc.destroy();}
};

// A note too dense to check live waits for its owner with its own reason, rather than reading as a capture that does not match.
it("answers document-too-dense for a capture too dense to check live", () => {
  const work = {document, currentPath: "docs/a.md", baselineBytes: state("A **bold** paragraph\n")};
  expect(validateOrdinaryActivation(work, WORKER_LIVE_VALIDATION_POLICY).kind).toBe("accepted");
  expect(validateOrdinaryActivation(work, {...WORKER_LIVE_VALIDATION_POLICY, maxStructVisits: 1})).toEqual({kind: "document-too-dense"});
  expect(validateOrdinaryActivation({...work, baselineBytes: state("x".repeat(2 * 1024 * 1024))}, WORKER_LIVE_VALIDATION_POLICY))
    .toEqual({kind: "document-too-dense"});
});
