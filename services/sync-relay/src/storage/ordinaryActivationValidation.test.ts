import {expect, it} from "vitest";
import * as Y from "yjs";
import {markdownToYDoc} from "../../../../packages/ydoc-projection/src/import-export";
import {WORKER_LIVE_VALIDATION_POLICY} from "../../../../packages/ydoc-projection/src/liveValidationPolicy";
import type {NativeOwnerActivationSource} from "@dohc/workspace-engine-client/daemon";
import {validateOrdinaryActivation, type OrdinaryActivationHistory} from "./ordinaryActivationValidation";

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

// Every prefix of an activation's history shares one work budget, so a long history runs it out for a note well within the
// bound. That is a budget the next activation can meet, not a note that must be split.
it("keeps a history that outruns its shared budget apart from a note too dense to check live", () => {
  const doc = new Y.Doc({gc: false}), body = doc.getXmlFragment("body");
  Y.applyUpdate(doc, state(Array.from({length: 40}, (_, i) => `Paragraph ${i} with **bold** text`).join("\n\n") + "\n"));
  const baselineBytes = Y.encodeStateAsUpdate(doc), updates: Uint8Array[] = [baselineBytes];
  for (let i = 0; i < 8; i += 1) {
    const before = Y.encodeStateVector(doc);
    ((body.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, `${i}`);
    updates.push(Y.encodeStateAsUpdate(doc, before));
  }
  const fullState = Y.encodeStateAsUpdate(doc); doc.destroy();
  // The fewest struct visits that check the whole note once; twice that covers the note but not its eight prefixes.
  let low = 1, high = 1_000_000;
  const fits = (visits: number) => validateOrdinaryActivation({document, currentPath: "docs/a.md", baselineBytes: fullState},
    {...WORKER_LIVE_VALIDATION_POLICY, maxStructVisits: visits}).kind === "accepted";
  while (low < high) {const mid = Math.floor((low + high) / 2); if (fits(mid)) high = mid; else low = mid + 1;}
  const policy = {...WORKER_LIVE_VALIDATION_POLICY, maxStructVisits: 2 * low};
  const source = {currentPath: "docs/a.md", sourceDigest: "", sourceByteLength: 0} as unknown as NativeOwnerActivationSource;
  const result = validateOrdinaryActivation({document, currentPath: "docs/a.md", baselineBytes,
    cut: {source, fullState, maxBytesPerDrain: 64 * 1024 * 1024, history: {updates, from: 0, wanted: [], settled: null, charged: 0} as unknown as OrdinaryActivationHistory}},
  policy);
  expect(result).toEqual({kind: "refused", message: "Ordinary activation history exceeds its configured validation budget."});
});
