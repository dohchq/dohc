import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {isAbsolute, join} from "node:path";
import {expect, it} from "vitest";
import * as Y from "yjs";
import {markdownToYDoc, yDocToMarkdown} from "@dohc/ydoc-projection";
import {createLiveMarkdownJournalValidator} from "@dohc/ydoc-projection/live-journal-validation";
import {deriveRestoreContinuation, parseRestoreContinuationRecipe, readPublicTransitionWorkload, transitionNames, validateInterruptedPublicUpdate, workloadHash as hash} from "./publicTransitionWorkload.integration-helper.js";
import type {WorkloadPin} from "./publicLinkWorkload.integration-helper.js";

type Projection = {markdown: WorkloadPin; editorText: WorkloadPin; viewText: WorkloadPin};
type Update = {deliveryId: string; bytes: WorkloadPin; expected: Projection};
type Case = {baseline: Projection & {checkpoint: WorkloadPin}; updates: Update[]; interrupted?: {deliveryId: string; bytes: WorkloadPin}; resumed?: Update;
  continuation?: {deliveryId: string; recipe: WorkloadPin; expected: Projection}};
function withFixture(run: (fixture: ReturnType<typeof prepare>) => void) {
  const prefix = join(tmpdir(), "dohc-transition-loader-"), root = mkdtempSync(prefix);
  try {run(prepare(root));}
  finally {
    if (!isAbsolute(root) || !root.startsWith(prefix)) throw new Error("Unexpected test cleanup path.");
    rmSync(root, {recursive: true, force: true});
  }
}
function prepare(root: string) {
  const pin = (path: string, bytes: Uint8Array): WorkloadPin => {
    writeFileSync(join(root, path), bytes); return {path, sha256: hash(bytes), byteLength: bytes.length};
  };
  const projection = (name: string, text: string): Projection => ({markdown: pin(`${name}.md`, Buffer.from(text)),
    editorText: pin(`${name}.editor.txt`, Buffer.from(text)), viewText: pin(`${name}.view.txt`, Buffer.from(text))});
  function append(doc: Y.Doc, deliveryId: string, text: string): Update {
    const vector = Y.encodeStateVector(doc), paragraph = doc.getXmlFragment("body").get(0) as Y.XmlElement;
    const content = paragraph.get(0) as Y.XmlText; content.insert(content.length, text);
    return {deliveryId, bytes: pin(`${deliveryId}.bin`, Y.encodeStateAsUpdate(doc, vector)), expected: projection(deliveryId, yDocToMarkdown(doc))};
  }
  const cases: Record<string, Case> = {};
  for (const name of [...transitionNames, "view"]) {
    const doc = markdownToYDoc("Hello"), interrupted = new Y.Doc({gc: false}), restored = new Y.Doc({gc: false});
    try {
      const checkpoint = Y.encodeStateAsUpdate(doc);
      const baseline = {...projection(`${name}-baseline`, "Hello"), checkpoint: pin(`${name}-baseline.bin`, checkpoint)};
      const updates = [append(doc, `${name}-first`, " first"), append(doc, `${name}-second`, " second")];
      const selected: Case = {baseline, updates};
      if (name !== "view") {
        Y.applyUpdate(interrupted, Y.encodeStateAsUpdate(doc));
        const pending = append(interrupted, `${name}-interrupted`, " held");
        selected.interrupted = {deliveryId: pending.deliveryId, bytes: pending.bytes};
      }
      if (name === "restart" || name === "staleFrame") selected.resumed = append(doc, `${name}-resumed`, " resumed");
      if (name === "restore") {
        Y.applyUpdate(restored, checkpoint);
        const paragraph = new Y.XmlElement("paragraph"), text = new Y.XmlText();
        text.insert(0, "recovered"); paragraph.insert(0, [text]); restored.getXmlFragment("body").push([paragraph]);
        selected.continuation = {deliveryId: "restore-resumed", recipe: pin("restore-recipe.json", Buffer.from(JSON.stringify({version: 1, kind: "append-paragraph", text: "recovered"}))),
          expected: projection("restore-resumed", yDocToMarkdown(restored))};
      }
      cases[name] = selected;
    } finally {doc.destroy(); interrupted.destroy(); restored.destroy();}
  }
  const manifest = {version: 1, concurrency: 2, cases};
  const seal = () => {
    const path = join(root, "manifest.json"), bytes = Buffer.from(JSON.stringify(manifest));
    writeFileSync(path, bytes); return {path, sha256: hash(bytes)};
  };
  return {root, manifest, pin, projection, seal};
}

it("loads pinned restart bytes and a distinct pinned restore continuation recipe", () => withFixture(({seal}) => {
  const loaded = readPublicTransitionWorkload(seal(), 2);
  expect(Object.keys(loaded.cases)).toEqual([...transitionNames, "view"]);
  expect(loaded.cases.restart.resumed!.expected.markdown.toString()).toBe("Hello first second resumed");
  expect(loaded.cases.restore.updates.at(-1)!.expected.markdown.toString()).toBe("Hello first second");
  expect(loaded.cases.restore.resumed).toBeUndefined();
  expect(loaded.cases.restore.continuation!.expected.markdown.toString()).toBe("Hello\n\nrecovered");
}));
it("refuses missing required transition coverage", () => withFixture(({manifest, seal}) => {
  delete manifest.cases.selectorDrift;
  expect(() => readPublicTransitionWorkload(seal(), 2)).toThrow("Incomplete transition coverage");
}));
it("refuses changed pinned update bytes", () => withFixture(({root, manifest, seal}) => {
  const admission = seal(); writeFileSync(join(root, manifest.cases.restart!.updates[0]!.bytes.path), "changed");
  expect(() => readPublicTransitionWorkload(admission, 2)).toThrow("Transition asset changed");
}));
it("refuses a duplicate delivery across distinct cases", () => withFixture(({manifest, seal}) => {
  manifest.cases.staleFrame!.updates[0]!.deliveryId = manifest.cases.restart!.updates[0]!.deliveryId;
  expect(() => readPublicTransitionWorkload(seal(), 2)).toThrow("Transition delivery IDs must be distinct");
}));
it("refuses an unchanged editor witness even when CRDT bytes change", () => withFixture(({manifest, seal}) => {
  manifest.cases.restart!.updates[0]!.expected.editorText = manifest.cases.restart!.baseline.editorText;
  expect(() => readPublicTransitionWorkload(seal(), 2)).toThrow("changed expected projection");
}));
it("refuses an unchanged View witness independently of the editor witness", () => withFixture(({manifest, seal}) => {
  manifest.cases.view!.updates[0]!.expected.viewText = manifest.cases.view!.baseline.viewText;
  expect(() => readPublicTransitionWorkload(seal(), 2)).toThrow("changed expected projection");
}));
it("applies the same visible-witness rule after restore", () => withFixture(({manifest, seal}) => {
  manifest.cases.restore!.continuation!.expected.editorText = manifest.cases.restore!.baseline.editorText;
  expect(() => readPublicTransitionWorkload(seal(), 2)).toThrow("changed expected projection");
}));
it("refuses baseline-relative preselected bytes as a restore continuation", () => withFixture(({manifest, seal}) => {
  manifest.cases.restore!.resumed = manifest.cases.restart!.resumed;
  expect(() => readPublicTransitionWorkload(seal(), 2)).toThrow("Incomplete transition: restore");
}));
it("refuses a changed recipe asset", () => withFixture(({manifest, root, seal}) => {
  const admission = seal(); writeFileSync(join(root, manifest.cases.restore!.continuation!.recipe.path), "changed");
  expect(() => readPublicTransitionWorkload(admission, 2)).toThrow("Transition asset changed");
}));
it("refuses an unchanged restore View witness", () => withFixture(({manifest, seal}) => {
  manifest.cases.restore!.continuation!.expected.viewText = manifest.cases.restore!.baseline.viewText;
  expect(() => readPublicTransitionWorkload(seal(), 2)).toThrow("changed expected projection");
}));
it("refuses a recipe whose projection does not match its pinned expectation", () => withFixture(({manifest, pin, seal}) => {
  manifest.cases.restore!.continuation!.recipe = pin("wrong-recipe.json", Buffer.from(JSON.stringify({version: 1, kind: "append-paragraph", text: "different"})));
  expect(() => readPublicTransitionWorkload(seal(), 2)).toThrow("differs from selected expectation");
}));
it.each([
  {version: 1, kind: "append-paragraph", text: ""},
  {version: 1, kind: "replace-body", text: "resurrect"},
  {version: 1, kind: "append-paragraph", text: "valid", clientId: 1},
])("refuses malformed continuation recipe %j", recipe => {
  expect(() => parseRestoreContinuationRecipe(Buffer.from(JSON.stringify(recipe)))).toThrow("Invalid restore continuation recipe");
});

it("continues on fresh copied body IDs without resurrecting the discarded branch", () => withFixture(({seal}) => {
  const selected = readPublicTransitionWorkload(seal(), 2).cases.restore, continuation = selected.continuation!;
  const point = new Y.Doc({gc: false}), restored = new Y.Doc({gc: false});
  try {
    Y.applyUpdate(point, selected.baseline.checkpoint); Y.applyUpdate(restored, selected.baseline.checkpoint);
    for (const update of selected.updates) Y.applyUpdate(restored, update.bytes);
    const used = Y.decodeStateVector(Y.encodeStateVector(restored));
    let restoreClient = 1; while (used.has(restoreClient)) restoreClient++;
    restored.clientID = restoreClient;
    const body = restored.getXmlFragment("body");
    const copied = point.getXmlFragment("body").toArray().map(node => {
      if (!(node instanceof Y.XmlElement || node instanceof Y.XmlText)) throw new Error("Restore fixture contains an unsupported XML node.");
      return node.clone();
    });
    body.delete(0, body.length); body.push(copied);
    const checkpoint = Y.encodeStateAsUpdate(restored), before = Y.decodeStateVector(Y.encodeStateVector(restored));
    const retired = [...selected.updates.map(update => update.bytes), selected.interrupted!.bytes];
    const result = deriveRestoreContinuation(checkpoint, continuation.recipe, selected.baseline.markdown, continuation.expected.markdown, retired);
    expect(before.has(result.clientId)).toBe(false);
    expect(Y.decodeUpdate(result.bytes).structs.every(item => item.id.client === result.clientId)).toBe(true);
    for (const bytes of retired) expect(Y.decodeUpdate(bytes).structs.some(item => item.id.client === result.clientId)).toBe(false);
    const input = {document: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: hash(selected.baseline.checkpoint)},
      currentPath: "docs/a.md", checkpoint, suffix: [], candidate: result.bytes,
      bounds: {maxSubmissionBytes: result.bytes.length, maxUpdateBytes: result.bytes.length, maxAdmissionBytes: checkpoint.length + result.bytes.length},
      validate: createLiveMarkdownJournalValidator(policy)};
    expect(validateInterruptedPublicUpdate(input).projectedMarkdownSha256).toBe(hash(continuation.expected.markdown));
    expect(() => validateInterruptedPublicUpdate({...input, bounds: {...input.bounds, maxSubmissionBytes: result.bytes.length - 1}})).toThrow("exceeds admitted capacity");
    Y.applyUpdate(restored, result.bytes);
    expect(yDocToMarkdown(restored)).toBe("Hello\n\nrecovered");
    for (const update of selected.updates) Y.applyUpdate(restored, update.bytes);
    expect(yDocToMarkdown(restored)).toBe("Hello\n\nrecovered");
    expect(() => deriveRestoreContinuation(Y.encodeStateAsUpdate(restored), continuation.recipe, selected.baseline.markdown, continuation.expected.markdown, retired)).toThrow("Actual restore projection differs");
  } finally {point.destroy(); restored.destroy();}
}));
it("refuses malformed interrupted bytes before a runtime refusal can count", () => withFixture(({manifest, pin, seal}) => {
  manifest.cases.restart!.interrupted!.bytes = pin("malformed.bin", Uint8Array.of(255));
  expect(() => readPublicTransitionWorkload(seal(), 2)).toThrow();
}));
it("refuses a no-op interrupted update", () => withFixture(({manifest, pin, seal}) => {
  const empty = new Y.Doc();
  try {manifest.cases.restart!.interrupted!.bytes = pin("empty.bin", Y.encodeStateAsUpdate(empty));}
  finally {empty.destroy();}
  expect(() => readPublicTransitionWorkload(seal(), 2)).toThrow("Interrupted update adds no state");
}));

// These generous synthetic-test values do not select any release policy.
const policy = {maxStructVisits: 10000, maxValueNodeVisits: 10000, maxDecodedPayloadByteVisits: 100000,
  maxStructClientGroupVisits: 10000, maxDeleteClientGroupVisits: 10000, maxDeleteIntervalVisits: 10000, maxIndexOperations: 100000};
function candidateInput(fixture: ReturnType<typeof prepare>) {
  const selected = fixture.manifest.cases.restart!, read = (pin: WorkloadPin) => readFileSync(join(fixture.root, pin.path));
  const checkpoint = read(selected.baseline.checkpoint), suffix = selected.updates.map(update => read(update.bytes)), candidate = read(selected.interrupted!.bytes);
  return {document: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: hash(checkpoint)}, currentPath: "docs/a.md",
    checkpoint, suffix, candidate, bounds: {maxSubmissionBytes: candidate.length, maxUpdateBytes: candidate.length,
      maxAdmissionBytes: checkpoint.length + suffix.reduce((sum, bytes) => sum + bytes.length, candidate.length)},
    validate: createLiveMarkdownJournalValidator(policy)};
}
it("qualifies an interrupted candidate against the actual journal cut and exact byte budget", () => withFixture(fixture => {
  const input = candidateInput(fixture), result = validateInterruptedPublicUpdate(input);
  expect(result.updateSha256).toBe(hash(input.candidate));
  expect(result.admittedBytes).toBe(input.bounds.maxAdmissionBytes);
}));
it("refuses interrupted bytes outside the supplied frame or admission budget", () => withFixture(fixture => {
  const input = candidateInput(fixture);
  expect(() => validateInterruptedPublicUpdate({...input, bounds: {...input.bounds, maxUpdateBytes: input.candidate.length - 1}})).toThrow("exceeds admitted capacity");
  expect(() => validateInterruptedPublicUpdate({...input, bounds: {...input.bounds, maxAdmissionBytes: input.bounds.maxAdmissionBytes - 1}})).toThrow("exceeds admitted capacity");
}));
it("refuses a candidate outside the supplied validation work policy", () => withFixture(fixture => {
  const input = candidateInput(fixture);
  expect(() => validateInterruptedPublicUpdate({...input, validate: createLiveMarkdownJournalValidator({...policy, maxStructVisits: 1})})).toThrow("not admissible");
}));
