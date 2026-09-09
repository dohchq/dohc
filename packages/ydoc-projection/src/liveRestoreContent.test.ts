import {createHash} from "node:crypto";
import {expect, it, vi} from "vitest";
import * as Y from "yjs";
import {markdownToYDoc, yDocToMarkdown} from "./import-export.js";
import {compareLiveRestoreContent} from "./liveRestoreContent.js";
import {createLiveMarkdownJournalValidator} from "./liveDocumentValidation.js";
const policy = {maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000};
const budget = {maxBytes: 1_000_000, maxEvents: 20};
const document = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "lineage"};
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function fixture(markdown = "Selected **bold** and 🦀.", fresh = true, changeSharedType = false) {
  const point = markdownToYDoc(markdown), head = new Y.Doc({gc: false});
  if (changeSharedType) {const nested = new Y.Map();nested.set("x", 1);point.getMap("frontmatter").set("nested", nested);}
  const baseline = Y.encodeStateAsUpdate(point);
  Y.applyUpdate(head, baseline);
  const previous = Y.encodeStateVector(head);
  const body = head.getXmlFragment("body");
  head.transact(() => {body.insert(0, [new Y.XmlElement("paragraph")]);});
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
  const input = {document, currentPath: "docs/a.md", accepted: {checkpoint: baseline, suffix: [] as Uint8Array[]},
    point: {checkpoint: baseline, suffix: [] as Uint8Array[]}, nativeSources: [native], frozenState: frozen, candidate,
    replacementRanges: [...result.evidence.candidate.ranges], pointMarkdownDigest: hash(yDocToMarkdown(point)),
    pointProjectionDigest: hash(yDocToMarkdown(point)), assertCurrent: vi.fn()};
  point.destroy();head.destroy();
  return input;
}
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
