import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { LiveOwnerAdoptionCut, RetainedPrefix } from "@dohc/workspace-engine-client/daemon";
import { parseLiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { ownerAdoptionCutEvidenceDigest } from "./liveCommittedDelivery";

// The vectors native adoption's own test reads (successor_tests.rs).
const vectors = JSON.parse(readFileSync(new URL(
  "../../../../crates/dohc-engine-collab/tests/owner-source/owner-adoption-evidence.json", import.meta.url), "utf8")) as {
  binding: unknown;
  cut: Omit<LiveOwnerAdoptionCut, "adoptionId" | "terminalReceipt" | "retainedPrefix" | "events" | "baselineBytes"> & {baselineBytes: number[]};
  cases: {name: string; retainedPrefix: RetainedPrefix | null; evidenceDigest: string}[];
};

it.each(vectors.cases)("hashes a prefix cut's evidence as native does: $name", ({retainedPrefix, evidenceDigest}) => {
  const cut: LiveOwnerAdoptionCut = {...vectors.cut, adoptionId: "adoption", baselineBytes: new Uint8Array(vectors.cut.baselineBytes),
    terminalReceipt: retainedPrefix?.terminalReceipt ?? null, retainedPrefix, events: []};
  expect(ownerAdoptionCutEvidenceDigest(parseLiveObjectBinding(vectors.binding), cut)).toBe(evidenceDigest);
  // Field order is the contract: native serializes the prefix in this order.
  if (retainedPrefix) {
    const reordered = Object.fromEntries(Object.entries(retainedPrefix).reverse()) as unknown as RetainedPrefix;
    expect(ownerAdoptionCutEvidenceDigest(parseLiveObjectBinding(vectors.binding), {...cut, retainedPrefix: reordered})).toBe(evidenceDigest);
  }
});
