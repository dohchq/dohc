import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {expect, it, vi} from "vitest";
import * as Y from "yjs";
import {restoreValidators} from "./liveRestoreValidation.js";
import {compareLiveRestoreContent} from "./liveRestoreContent.js";
import {markdownToYDoc, yDocToMarkdown} from "./import-export.js";
import {createLiveMarkdownJournalValidator} from "./liveDocumentValidation.js";
import {validateLiveRestoreProposal} from "./liveRestoreProof.js";
import {resolveLiveRestorePoint} from "./liveRestorePoint.js";
const policy = {maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000};

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const vector = JSON.parse(readFileSync(new URL("../../../crates/dohc-engine-collab/tests/reader-resolver.json", import.meta.url), "utf8"));
it("keeps main's native journal refusal when an artifact getter is available", () => {
  const doc = markdownToYDoc("Native paragraph\n");
  try {
    doc.getMap("meta").set("dohcLineageEpoch", "e".repeat(64));
    const checkpoint = Y.encodeStateAsUpdate(doc);
    const input = {document: {workspaceId:"w",mainVersionId:"main",objectId:"o",lineageClaimId:"l"},
      currentPath:"a.md",checkpoint,suffix:[],candidate:Uint8Array.of(0,0)};
    const native = createLiveMarkdownJournalValidator(policy)(input);
    expect(native.kind).toBe("refused");
    expect(restoreValidators(policy, () => undefined).journal(input)).toEqual(native);
  } finally {doc.destroy();}
});
function fixture(damage = "valid") {
  const doc = new Y.Doc({gc: false});
  Y.applyUpdate(doc, Buffer.from(vector.checkpoint, "base64"));
  const source = new TextEncoder().encode(vector.source);
  const blobs = new Map([[hash(source), source]]);
  const meta = doc.getMap("meta");
  if (damage === "partial") meta.delete("dohcMarkdownSourceSha256");
  if (damage === "stale") meta.set("dohcMarkdownSourceProjectionSha256", "0".repeat(64));
  if (damage === "forged") {
    const foreign = new TextEncoder().encode("a foreign document\n");
    meta.set("dohcMarkdownSource", new TextDecoder().decode(foreign));
    meta.set("dohcMarkdownSourceSha256", hash(foreign));
    blobs.set(hash(foreign), foreign);
  }
  if (damage === "missing") blobs.clear();
  const checkpoint = Y.encodeStateAsUpdate(doc); doc.destroy();
  const document = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: hash(checkpoint)};
  const input = {document, currentPath: "a.md", checkpoint};
  const artifact = vi.fn((digest: string) => blobs.get(digest));
  return {input, artifact, source};
}
it("proves the selected reader point from separately stored bytes", () => {
  const f = fixture();
  const result = restoreValidators(policy, f.artifact).registration(f.input);
  expect(result.kind).toBe("accepted");
  if (result.kind !== "accepted") throw Error(result.reason);
  expect(result.evidence.projectedMarkdown).toBe(vector.source);
  const point = resolveLiveRestorePoint({target: "selected", binding: {...f.input.document, currentPath: f.input.currentPath},
    checkpoint: {bytes: f.input.checkpoint}, events: [], point: {journalCursor: 0, receiptDigest: f.input.document.lineageClaimId},
    artifact: f.artifact, assertCurrent() {}}, policy);
  expect(point.markdownDigest).toBe(hash(f.source));
});
it.each(["forged", "partial", "stale", "missing"])("holds a %s reader point", damage => {
  const f = fixture(damage);
  const attempt = () => restoreValidators(policy, f.artifact).registration(f.input);
  try { expect(attempt().kind).toBe("refused"); } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Restore/);
  }
});
it("cannot anchor a witness without a stored artifact reader", () => {
  const f = fixture();
  expect(restoreValidators(policy).registration(f.input).kind).toBe("refused");
  expect(f.artifact).not.toHaveBeenCalled();
});

it.each(["reader-restore","reader-to-reader","native-to-reader","reader-to-native","expired-to-native","expired-to-fresh","expired-to-expired"])("validates the engine's %s proposal and review", direction => {
  const saved = JSON.parse(readFileSync(new URL(`../../../crates/dohc-engine-collab/tests/${direction}.json`,import.meta.url),"utf8"));
  const source = new TextEncoder().encode(saved.source);
  const artifact = (digest: string) => digest === hash(source) ? source : undefined;
  const binding = saved.receipt.fence.operation.oldBinding;
  const selected = {target:"selected" as const,binding,checkpoint:{bytes:Uint8Array.from(saved.pointStateBytes)},events:[],
    point:{journalCursor:saved.receipt.point.journalCursor,receiptDigest:saved.receipt.point.receiptDigest},artifact,assertCurrent(){}};
  const capture = {selected,accepted:{...selected,target:"accepted" as const,checkpoint:{bytes:Uint8Array.from(saved.acceptedCheckpoint)}},
    receipt:saved.receipt,assertCurrent(){}};
  const bytes={candidateBytes:Uint8Array.from(saved.candidateBytes),frozenStateBytes:Uint8Array.from(saved.frozenStateBytes),
    pointStateBytes:Uint8Array.from(saved.pointStateBytes),nativeSourceBytes:saved.nativeSourceBytes.map((b:number[])=>Uint8Array.from(b))};
  const checked=validateLiveRestoreProposal(capture,bytes,policy,{maxBytes:2_000_000,maxEvents:100});
  expect(checked.content.projectedMarkdownSha256).toBe(saved.receipt.point.markdownDigest);
  expect(checked.projectReview(2_000_000).restoredMarkdown).toBe(saved.restoredMarkdown ?? (direction === "reader-to-native" ? "native original\n" : saved.source));
});

it("does not accept the obsolete prefix identity in a restore receipt", async () => {
  const {parseNativeRestoreProposalReceipt} = await import("../../../services/sync-relay/src/liveRestoreProposal.js");
  const saved = JSON.parse(readFileSync(new URL("../../../crates/dohc-engine-collab/tests/reader-to-native.json",import.meta.url),"utf8"));
  const {readerPrefixMoment: _removed, ...receipt} = saved.receipt;
  // The exported JSON fixture sorts object keys after computing the wire digest.
  receipt.nativeSourceManifestDigest = hash(JSON.stringify([receipt.fence,receipt.nativeSources]));
  expect(parseNativeRestoreProposalReceipt(JSON.stringify(receipt),{maxBytes:2_000_000,maxEvents:100})).toBeDefined();
  for (const readerPrefixMoment of ["reader-current",null,"",42,"a".repeat(2049)]) {
    expect(() => parseNativeRestoreProposalReceipt(JSON.stringify({...receipt,readerPrefixMoment}),{maxBytes:2_000_000,maxEvents:100})).toThrow();
  }
});


it.each(["selected", "prefix"])("refuses canonical source bytes with a stale %s witness hash", direction => {
  const doc = new Y.Doc({gc: false});
  Y.applyUpdate(doc, Buffer.from(vector.canonicalStale, "base64"));
  doc.getMap("meta").delete("dohcLineageEpoch");
  const checkpoint = Y.encodeStateAsUpdate(doc), before = Y.encodeStateVector(doc);
  const source = new TextEncoder().encode(vector.canonicalSource);
  const document = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: hash(checkpoint)};
  const input = {document, currentPath: "a.md", checkpoint};
  const validators = restoreValidators(policy, digest => digest === hash(source) ? source : undefined);
  try {
    if (direction === "selected") {
      expect(() => validators.registration(input)).toThrow(/Restore source proof refused/);
    } else {
      doc.transact(() => {
        const body = doc.getXmlFragment("body");body.delete(0,body.length);
        const paragraph = new Y.XmlElement("paragraph"), text = new Y.XmlText();
        text.insert(0,"native target");paragraph.insert(0,[text]);body.insert(0,[paragraph]);
        for (const key of ["dohcMarkdownSourceReader","dohcMarkdownSource","dohcMarkdownSourceSha256","dohcMarkdownSourceProjectionSha256"]) doc.getMap("meta").delete(key);
      });
      const candidate = Y.encodeStateAsUpdate(doc,before);
      const nativePoint = Y.encodeStateAsUpdate(doc), markdownDigest = hash(yDocToMarkdown(doc));
      const structs = Y.decodeUpdate(candidate).structs;
      const replacementRanges = [{clientId: doc.clientID, startClock: 0,
        endClock: Math.max(...structs.map(item => item.id.clock + item.length))}];
      expect(() => compareLiveRestoreContent({document,currentPath:"a.md",
        accepted:{target:"accepted",checkpoint,suffix:[]},point:{target:"selected",checkpoint:nativePoint,suffix:[]},
        nativeSources:[],frozenState:checkpoint,candidate,replacementRanges,
        pointMarkdownDigest:markdownDigest,pointProjectionDigest:markdownDigest,
        artifact:digest => digest === hash(source) ? source : undefined,assertCurrent() {}},policy,{maxBytes:2_000_000,maxEvents:100}))
        .toThrow(/Restore source proof refused/);
    }
  } finally {doc.destroy();}
});
