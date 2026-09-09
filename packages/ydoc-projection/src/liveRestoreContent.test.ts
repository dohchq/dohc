import {createHash} from "node:crypto";
import {expect, it, vi} from "vitest";
import * as Y from "yjs";
import {markdownToYDoc, yDocToMarkdown} from "./import-export.js";
import {compareLiveRestoreContent} from "./liveRestoreContent.js";
import {projectLiveRestoreReviewContent, validateLiveRestoreProposal} from "./liveRestoreProof.js";
import {createLiveMarkdownJournalValidator} from "./liveDocumentValidation.js";
const policy = {maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000};
const budget = {maxBytes: 1_000_000, maxEvents: 20};
const document = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "lineage"};
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function contentProposalFixture(nativeText?: string) {
  const input = fixture(undefined, true, false, nativeText), doc = new Y.Doc({gc: false});
  Y.applyUpdate(doc, input.frozenState);const beforeStateVector = [...Y.encodeStateVector(doc)];
  Y.applyUpdate(doc, input.candidate);const afterStateVector = [...Y.encodeStateVector(doc)];doc.destroy();
  const point = {journalCursor: 0, receiptDigest: hash(input.point.checkpoint), markdownDigest: input.pointMarkdownDigest, projectionDigest: input.pointProjectionDigest};
  const capture = {selected: {target: "selected" as const, binding: {...document, currentPath: input.currentPath},
    checkpoint: {bytes: input.point.checkpoint}, events: [], point: {journalCursor: 0, receiptDigest: point.receiptDigest}, assertCurrent: input.assertCurrent},
    accepted: {target: "accepted" as const, binding: {...document, currentPath: input.currentPath}, checkpoint: {bytes: input.accepted.checkpoint},
      events: [], point: {journalCursor: 0, receiptDigest: point.receiptDigest}, assertCurrent: input.assertCurrent},
    receipt: {point, candidateDigest: hash(input.candidate), frozenStateDigest: hash(input.frozenState), pointStateDigest: hash(input.point.checkpoint),
      beforeStateVector, afterStateVector, replacementRanges: input.replacementRanges,
      nativeSources: input.nativeSources.map(bytes => ({byteLength: bytes.byteLength, updateDigest: hash(bytes)}))}, assertCurrent: input.assertCurrent};
  const bytes = {candidateBytes: input.candidate, frozenStateBytes: input.frozenState,
    pointStateBytes: input.point.checkpoint, nativeSourceBytes: input.nativeSources};
  return {capture, bytes};
}
it("snapshots the checked native source count when the caller grows its array during an indexed read", () => {
  const f = contentProposalFixture(), sources = [...f.bytes.nativeSourceBytes];
  const nativeSourceBytes = new Proxy(sources, {get(target, key, receiver) {
    if (key === "0") target.push(Uint8Array.of(0, 0));
    return Reflect.get(target, key, receiver);
  }});
  expect(validateLiveRestoreProposal(f.capture, {...f.bytes, nativeSourceBytes}, policy, budget).content.candidateDigest).toBe(f.capture.receipt.candidateDigest);
  expect(sources).toHaveLength(2);
});
it("validates proposal bytes, selected content and native vectors under one proof input budget", () => {
  const f = contentProposalFixture(), result = validateLiveRestoreProposal(f.capture, f.bytes, policy, budget);
  expect(result.content.candidateDigest).toBe(hash(f.bytes.candidateBytes));
  result.candidateBytes.fill(0);expect(hash(result.candidateBytes)).toBe(f.capture.receipt.candidateDigest);
  f.bytes.candidateBytes.fill(0);expect(hash(result.candidateBytes)).toBe(f.capture.receipt.candidateDigest);
});
it("refuses proposal byte changes, substituted full point and changed before or after vectors", () => {
  for (const name of ["candidateBytes", "frozenStateBytes", "pointStateBytes"] as const) {
    const f = contentProposalFixture();f.bytes[name] = Uint8Array.of(0, 0);
    expect(() => validateLiveRestoreProposal(f.capture, f.bytes, policy, budget)).toThrow();
  }
  for (const name of ["beforeStateVector", "afterStateVector"] as const) {
    const f = contentProposalFixture();f.capture.receipt[name] = [0];
    expect(() => validateLiveRestoreProposal(f.capture, f.bytes, policy, budget)).toThrow();
  }
  const f = contentProposalFixture();f.bytes.pointStateBytes = f.bytes.frozenStateBytes;
  f.capture.receipt.pointStateDigest = hash(f.bytes.pointStateBytes);
  expect(() => validateLiveRestoreProposal(f.capture, f.bytes, policy, budget)).toThrow();
});
it("charges the separate proposal point and refuses omitted native input or retired standing", () => {
  const f = contentProposalFixture();const good = validateLiveRestoreProposal(f.capture, f.bytes, policy, budget);
  expect(() => validateLiveRestoreProposal(f.capture, f.bytes, policy, {...budget,
    maxBytes: good.content.inputBytes + f.bytes.pointStateBytes.byteLength - 1})).toThrow();
  expect(() => validateLiveRestoreProposal(f.capture, {...f.bytes, nativeSourceBytes: []}, policy, budget)).toThrow();
  f.capture.assertCurrent.mockImplementation(() => {throw Error("retired");});
  expect(() => validateLiveRestoreProposal(f.capture, f.bytes, policy, budget)).toThrow("retired");
});
function fixture(markdown = "Selected **bold** and 🦀.", fresh = true, changeSharedType = false, nativeText?: string) {
  const point = markdownToYDoc(markdown), head = new Y.Doc({gc: false});
  if (changeSharedType) {const nested = new Y.Map();nested.set("x", 1);point.getMap("frontmatter").set("nested", nested);}
  const baseline = Y.encodeStateAsUpdate(point);
  Y.applyUpdate(head, baseline);
  const previous = Y.encodeStateVector(head);
  const body = head.getXmlFragment("body");
  head.transact(() => {
    const paragraph = new Y.XmlElement("paragraph");
    if (nativeText !== undefined) {const text = new Y.XmlText(); text.insert(0, nativeText); paragraph.insert(0, [text]);}
    body.insert(0, [paragraph]);
  });
  const native = Y.encodeStateAsUpdate(head, previous), frozen = Y.encodeStateAsUpdate(head);
  if (fresh) {const used = Y.decodeStateVector(Y.encodeStateVector(head));let next = 1;while (used.has(next)) next++;head.clientID = next;}
  const beforeRestore = Y.encodeStateVector(head);
  head.transact(() => {body.delete(0, body.length);body.insert(0, point.getXmlFragment("body").toArray().map(node => {
    if (!(node instanceof Y.XmlElement || node instanceof Y.XmlText)) throw Error("Unsupported test body");
    return node.clone();
  }));});
  if (changeSharedType) head.getMap("frontmatter").set("nested", {x: 1});
  const candidate = Y.encodeStateAsUpdate(head, beforeRestore);
  const result = createLiveMarkdownJournalValidator(policy)({document, currentPath: "docs/a.md", checkpoint: frozen, suffix: [], candidate});
  if (result.kind !== "accepted") throw Error(JSON.stringify(result));
  const input = {document, currentPath: "docs/a.md", accepted: {target: "accepted" as const, checkpoint: baseline, suffix: [] as Uint8Array[]},
    point: {target: "selected" as const, checkpoint: baseline, suffix: [] as Uint8Array[]}, nativeSources: [native], frozenState: frozen, candidate,
    replacementRanges: [...result.evidence.candidate.ranges], pointMarkdownDigest: hash(yDocToMarkdown(point)),
    pointProjectionDigest: hash(yDocToMarkdown(point)), assertCurrent: vi.fn()};
  point.destroy();head.destroy();
  return input;
}
it("returns the validated frozen and restored Markdown with their exact byte digests", () => {
  const f = contentProposalFixture("Native work 🦀"), result = projectLiveRestoreReviewContent(f.capture, f.bytes, policy, {...budget,maxOutputBytes:1_000_000});
  expect(result.frozenMarkdown).toContain("Native work 🦀");
  expect(result.frozenMarkdown).toContain("Selected **bold** and 🦀.");
  expect(result.restoredMarkdown).toContain("Selected **bold** and 🦀.");
  expect(result.restoredMarkdown).not.toContain("Native work");
  expect(result.frozenMarkdownDigest).toBe(hash(result.frozenMarkdown));
  expect(result.restoredMarkdownDigest).toBe(hash(result.restoredMarkdown));
  expect(result.restoredMarkdownDigest).toBe(f.capture.receipt.point.markdownDigest);
  expect(result.frozenMarkdownByteLength).toBe(Buffer.byteLength(result.frozenMarkdown));
  expect(result.restoredMarkdownByteLength).toBe(Buffer.byteLength(result.restoredMarkdown));
  expect(result.frozenMarkdownByteLength).toBeGreaterThan(result.frozenMarkdown.length);
  const exact=result.frozenMarkdownByteLength+result.restoredMarkdownByteLength;
  expect(projectLiveRestoreReviewContent(f.capture,f.bytes,policy,{...budget,maxOutputBytes:exact})).toEqual(result);
  expect(()=>projectLiveRestoreReviewContent(f.capture,f.bytes,policy,{...budget,maxOutputBytes:exact-1})).toThrow("output budget");
  f.capture.assertCurrent.mockImplementation(()=>{throw Error("retired");});
  expect(()=>projectLiveRestoreReviewContent(f.capture,f.bytes,policy,{...budget,maxOutputBytes:exact})).toThrow("retired");
});
it.each(["Selected **bold** and 🦀.", "# Title\n\n- one\n- two", "[Selected](https://example.com)"])(
  "verifies a fresh owner rewrite with retained native context: %s", markdown => {
    const input = fixture(markdown), original = input.nativeSources.map(bytes => [...bytes]);
    const result = compareLiveRestoreContent(input, policy, budget);
    expect(result.candidateDigest).toBe(hash(input.candidate));
    expect(input.nativeSources.map(bytes => [...bytes])).toEqual(original);
    expect(input.assertCurrent).toHaveBeenCalledTimes(2);
    const bytes = result.stateUpdate;bytes.fill(0);expect(hash(result.stateUpdate)).toBe(result.restoredStateDigest);
  });
it("refuses an omitted native source even when the final visible content would match", () => {
  const input = fixture(); input.nativeSources = [];
  expect(() => compareLiveRestoreContent(input, policy, budget)).toThrow("frozen context differs");
});
it("refuses a frozen state with different deletion history", () => {
  const input = fixture();input.frozenState = input.accepted.checkpoint;
  expect(() => compareLiveRestoreContent(input, policy, budget)).toThrow("frozen context differs");
});
it("refuses a replacement range not produced by the candidate", () => {
  const input = fixture();input.replacementRanges[0] = {...input.replacementRanges[0]!, endClock: 999999};
  expect(() => compareLiveRestoreContent(input, policy, budget)).toThrow("replacement ranges differ");
});
it("refuses an owner rewrite that extends a pre-fence writer", () => {
  expect(() => compareLiveRestoreContent(fixture(undefined, false), policy, budget)).toThrow("replacement writer is not fresh");
});
it("refuses changing a shared frontmatter map to an atomic value with identical Markdown", () => {
  expect(() => compareLiveRestoreContent(fixture(undefined, true, true), policy, budget)).toThrow("restored structure differs");
});
it("refuses changed point artifact or projection claims", () => {
  for (const field of ["pointMarkdownDigest", "pointProjectionDigest"] as const) {
    const input = fixture();input[field] = "f".repeat(64);
    expect(() => compareLiveRestoreContent(input, policy, budget)).toThrow(/differs/);
  }
});
it("checks budgets before scratch work and rechecks authority before returning", () => {
  const input = fixture();
  expect(() => compareLiveRestoreContent(input, policy, {...budget, maxBytes: 1})).toThrow("byte budget");
  input.assertCurrent.mockReset().mockImplementationOnce(() => {}).mockImplementationOnce(() => {throw Error("retired");});
  expect(() => compareLiveRestoreContent(input, policy, budget)).toThrow("retired");
});

it("validates nonempty accepted and selected suffixes", () => {
  const input = fixture(), empty = new Y.Doc({gc: false});
  input.accepted.suffix = input.nativeSources;
  input.nativeSources = [];
  input.point.suffix = [input.point.checkpoint];
  input.point.checkpoint = Y.encodeStateAsUpdate(empty);
  empty.destroy();
  expect(compareLiveRestoreContent(input, policy, budget).candidateDigest).toBe(hash(input.candidate));
  expect(() => compareLiveRestoreContent(input, policy, {...budget, maxEvents: 1})).toThrow("event budget");
});

it("refuses shared buffers and checks initial authority before invalid budgets", () => {
  const input = fixture(), shared = new Uint8Array(new SharedArrayBuffer(input.candidate.byteLength));
  shared.set(input.candidate);input.candidate = shared;
  expect(() => compareLiveRestoreContent(input, policy, budget)).toThrow("invalid bytes");
  input.assertCurrent.mockImplementation(() => {throw Error("retired first");});
  expect(() => compareLiveRestoreContent(input, policy, {...budget, maxBytes: 0})).toThrow("retired first");
});

it("refuses stale tagged metadata even while it has no effect on current Markdown", () => {
  const input = fixture(), doc = new Y.Doc({gc: false});
  try {
    Y.applyUpdate(doc, input.frozenState);
    const before = Y.encodeStateVector(doc);
    Y.applyUpdate(doc, input.candidate);
    doc.clientID = input.replacementRanges[0]!.clientId;
    doc.getMap("meta").set("dohcTaggedFrontmatterPrefix", "---\na: !custom value\n---\n\n");
    doc.getMap("meta").set("dohcTaggedFrontmatterBaseline", "a: value\n");
    expect(hash(yDocToMarkdown(doc))).toBe(input.pointProjectionDigest);
    input.candidate = Y.encodeStateAsUpdate(doc, before);
    expect(() => compareLiveRestoreContent(input, policy, budget)).toThrow("invalid-schema");
  } finally {doc.destroy();}
});

it("requires owner replacement writes even when deleting the native tail would recover the point", () => {
  const input = fixture(), doc = new Y.Doc({gc: false});
  try {
    Y.applyUpdate(doc, input.frozenState);
    const before = Y.encodeStateVector(doc);
    doc.getXmlFragment("body").delete(0, 1);
    input.candidate = Y.encodeStateAsUpdate(doc, before);
    input.replacementRanges = [];
    expect(hash(yDocToMarkdown(doc))).toBe(input.pointProjectionDigest);
    expect(() => compareLiveRestoreContent(input, policy, budget)).toThrow("candidate makes no owner replacement writes");
  } finally {doc.destroy();}
});

it("uses the same candidate reference for accounting and validation", () => {
  const input = fixture(), candidate = input.candidate;
  let reads = 0;
  Object.defineProperty(input, "candidate", {enumerable: true, get() {
    reads++;
    if (reads > 1) throw Error("candidate was read again");
    return candidate;
  }});
  expect(compareLiveRestoreContent(input, policy, budget).candidateDigest).toBe(hash(candidate));
  expect(reads).toBe(1);
});

it("refuses swapped histories and ignores caller-defined array iteration", () => {
  const input = fixture();
  expect(() => compareLiveRestoreContent({...input, accepted: input.point, point: input.accepted} as never, policy, budget))
    .toThrow("history target differs");
  const updates = input.nativeSources;
  updates[Symbol.iterator] = function* () {throw Error("custom iterator must not run");};
  expect(compareLiveRestoreContent(input, policy, budget).candidateDigest).toBe(hash(input.candidate));
});
