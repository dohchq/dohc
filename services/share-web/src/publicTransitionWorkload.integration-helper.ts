import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {dirname, isAbsolute, resolve} from "node:path";
import * as Y from "yjs";
import {yDocToMarkdown} from "@dohc/ydoc-projection";
import type {WorkloadPin} from "./publicLinkWorkload.integration-helper.js";
import type {createLiveMarkdownJournalValidator} from "@dohc/ydoc-projection/live-journal-validation";
import type {LiveDocumentKey} from "@dohc/live-session-contract/live-update-admission";

export const transitionNames = ["restart", "staleFrame", "selectorDrift", "accessChange", "restore"] as const;
export type TransitionName = typeof transitionNames[number];
type Projection = {markdown: WorkloadPin; editorText: WorkloadPin; viewText: WorkloadPin};
type Update = {deliveryId: string; bytes: WorkloadPin; expected: Projection};
type Continuation = {deliveryId: string; recipe: WorkloadPin; expected: Projection};
export interface RestoreContinuationRecipe {version: 1; kind: "append-paragraph"; text: string}
interface Case {
  baseline: Projection & {checkpoint: WorkloadPin};
  updates: Update[];
  interrupted?: {deliveryId: string; bytes: WorkloadPin};
  resumed?: Update;
  continuation?: Continuation;
}
interface Manifest {version: 1; concurrency: number; cases: Record<TransitionName | "view", Case>}
export const workloadHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function parseRestoreContinuationRecipe(bytes: Uint8Array): RestoreContinuationRecipe {
  const value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
  if (!value || Object.keys(value).sort().join() !== "kind,text,version" || value.version !== 1 ||
      value.kind !== "append-paragraph" || typeof value.text !== "string" || !value.text.length) {
    throw new Error("Invalid restore continuation recipe.");
  }
  return value;
}

// Submitted bytes must be derived from the synchronized restored state, never an old branch delta.
export function deriveRestoreContinuation(checkpoint: Uint8Array, recipe: RestoreContinuationRecipe,
  expectedBaseline: Uint8Array, expectedMarkdown: Uint8Array, retiredUpdates: readonly Uint8Array[]) {
  const doc = new Y.Doc({gc: false});
  try {
    Y.applyUpdate(doc, checkpoint);
    if (workloadHash(Buffer.from(yDocToMarkdown(doc))) !== workloadHash(expectedBaseline)) throw new Error("Actual restore projection differs from selected baseline.");
    const before = Y.encodeStateVector(doc), clients = new Set(Y.decodeStateVector(before).keys());
    for (const update of retiredUpdates) {
      const decoded = Y.decodeUpdate(update);
      for (const item of decoded.structs) clients.add(item.id.client);
      for (const client of decoded.ds.clients.keys()) clients.add(client);
    }
    let clientId = 1;
    while (clients.has(clientId)) clientId++;
    doc.clientID = clientId;
    const paragraph = new Y.XmlElement("paragraph"), text = new Y.XmlText();
    text.insert(0, recipe.text); paragraph.insert(0, [text]);
    doc.getXmlFragment("body").push([paragraph]);
    const bytes = Y.encodeStateAsUpdate(doc, before), markdown = Buffer.from(yDocToMarkdown(doc));
    if (workloadHash(markdown) !== workloadHash(expectedMarkdown)) throw new Error("Restore continuation projection differs from selected expectation.");
    const structs = Y.decodeUpdate(bytes).structs;
    if (!structs.length || structs.some(item => item.id.client !== clientId)) throw new Error("Restore continuation reused prior writer structs.");
    return {bytes, markdown, clientId, restoredStateVectorSha256: workloadHash(before)};
  } finally {doc.destroy();}
}

export function validateInterruptedPublicUpdate(input: {document: LiveDocumentKey; currentPath: string; checkpoint: Uint8Array;
  suffix: Uint8Array[]; candidate: Uint8Array; bounds: {maxSubmissionBytes: number; maxAdmissionBytes: number; maxUpdateBytes: number};
  validate: ReturnType<typeof createLiveMarkdownJournalValidator>}) {
  const {candidate, checkpoint, suffix, bounds} = input;
  const total = suffix.reduce((sum, bytes) => sum + bytes.length, checkpoint.length + candidate.length);
  if (!candidate.length || candidate.length > bounds.maxSubmissionBytes || candidate.length > bounds.maxUpdateBytes || total > bounds.maxAdmissionBytes) throw new Error("Interrupted update exceeds admitted capacity.");
  const validation = input.validate({document: input.document, currentPath: input.currentPath, checkpoint, suffix, candidate});
  if (validation.kind !== "accepted") throw new Error(`Interrupted update is not admissible: ${JSON.stringify(validation)}`);
  const doc = new Y.Doc({gc: false});
  try {
    Y.applyUpdate(doc, checkpoint); for (const bytes of suffix) Y.applyUpdate(doc, bytes);
    const before = workloadHash(Y.encodeStateAsUpdate(doc)); Y.applyUpdate(doc, candidate);
    if (workloadHash(Y.encodeStateAsUpdate(doc)) === before) throw new Error("Interrupted update adds no state.");
  } finally {doc.destroy();}
  return {updateSha256: workloadHash(candidate), admittedBytes: total, projectedMarkdownSha256: validation.evidence.projectedMarkdownSha256};
}

export function readPublicTransitionWorkload(pin: {path: string; sha256: string}, concurrency: number) {
  if (!isAbsolute(pin.path)) throw new Error("An absolute transition manifest path is required.");
  const raw = readFileSync(pin.path);
  if (workloadHash(raw) !== pin.sha256) throw new Error("Transition manifest changed.");
  const manifest = JSON.parse(raw.toString()) as Manifest;
  if (manifest.version !== 1 || manifest.concurrency !== concurrency || Object.keys(manifest.cases).sort().join() !== [...transitionNames, "view"].sort().join()) throw new Error("Incomplete transition coverage.");
  const pins: WorkloadPin[] = [], ids = new Set<string>();
  function read(asset: WorkloadPin) {
    const path = resolve(dirname(pin.path), asset.path), content = readFileSync(path);
    if (workloadHash(content) !== asset.sha256 || content.length !== asset.byteLength) throw new Error(`Transition asset changed: ${path}`);
    pins.push({...asset, path}); return content;
  }
  function projection(value: Projection) {return {markdown: read(value.markdown), editorText: read(value.editorText), viewText: read(value.viewText)};}
  function update(value: {deliveryId: string; bytes: WorkloadPin}) {
    if (!value.deliveryId || ids.has(value.deliveryId)) throw new Error("Transition delivery IDs must be distinct.");
    ids.add(value.deliveryId); return {deliveryId: value.deliveryId, bytes: read(value.bytes)};
  }
  function load(name: TransitionName | "view") {
    const selected = manifest.cases[name];
    if (!selected || !Array.isArray(selected.updates) || !selected.updates.length || (name !== "view" && !selected.interrupted) || (["restart", "staleFrame"].includes(name) && !selected.resumed) ||
        (name === "restore" && !selected.continuation) || (selected.resumed && !["restart", "staleFrame"].includes(name)) ||
        (name !== "restore" && selected.continuation)) throw new Error(`Incomplete transition: ${name}`);
    const baseline = {...projection(selected.baseline), checkpoint: read(selected.baseline.checkpoint)};
    const doc = new Y.Doc({gc: false});
    try {
      Y.applyUpdate(doc, baseline.checkpoint);
      if (workloadHash(Buffer.from(yDocToMarkdown(doc))) !== workloadHash(baseline.markdown)) throw new Error(`Baseline projection mismatch: ${name}`);
      let previousProjection = baseline;
      const apply = (value: Update, target = doc) => {
        const item = {...update(value), expected: projection(value.expected)}, before = workloadHash(Y.encodeStateAsUpdate(target));
        if (workloadHash(item.expected.editorText) === workloadHash(previousProjection.editorText) ||
          (name === "view" && workloadHash(item.expected.viewText) === workloadHash(previousProjection.viewText))) throw new Error("A render witness requires a changed expected projection.");
        Y.applyUpdate(target, item.bytes);
        if (workloadHash(Y.encodeStateAsUpdate(target)) === before) throw new Error(`Transition update adds no state: ${item.deliveryId}`);
        if (workloadHash(Buffer.from(yDocToMarkdown(target))) !== workloadHash(item.expected.markdown)) throw new Error(`Transition projection mismatch: ${item.deliveryId}`);
        previousProjection = {...baseline, ...item.expected}; return item;
      };
      const updates = selected.updates.map(value => apply(value)), interrupted = selected.interrupted && update(selected.interrupted);
      if (interrupted) {
        const pending = new Y.Doc({gc: false});
        try {
          Y.applyUpdate(pending, Y.encodeStateAsUpdate(doc)); const before = workloadHash(Y.encodeStateAsUpdate(pending));
          Y.applyUpdate(pending, interrupted.bytes);
          if (workloadHash(Y.encodeStateAsUpdate(pending)) === before) throw new Error("Interrupted update adds no state.");
        } finally {pending.destroy();}
      }
      const resumed = selected.resumed && apply(selected.resumed);
      let continuation: {deliveryId: string; recipe: RestoreContinuationRecipe; recipePin: WorkloadPin; expected: ReturnType<typeof projection>} | undefined;
      if (selected.continuation) {
        const value = selected.continuation;
        if (!value.deliveryId || ids.has(value.deliveryId)) throw new Error("Transition delivery IDs must be distinct.");
        ids.add(value.deliveryId);
        const recipe = parseRestoreContinuationRecipe(read(value.recipe)), expected = projection(value.expected);
        if (workloadHash(expected.editorText) === workloadHash(baseline.editorText) || workloadHash(expected.viewText) === workloadHash(baseline.viewText)) throw new Error("A render witness requires a changed expected projection.");
        // Check recipe content here; runtime derives its only submitted bytes from the actual restore.
        deriveRestoreContinuation(baseline.checkpoint, recipe, baseline.markdown, expected.markdown,
          [...updates.map(update => update.bytes), ...(interrupted ? [interrupted.bytes] : [])]);
        continuation = {deliveryId: value.deliveryId, recipe, recipePin: {...value.recipe, path: resolve(dirname(pin.path), value.recipe.path)}, expected};
      }
      return {baseline, updates, interrupted, resumed, continuation};
    } finally {doc.destroy();}
  }
  const cases = Object.fromEntries(([...transitionNames, "view"] as const).map(name => [name, load(name)])) as Record<TransitionName | "view", ReturnType<typeof load>>;
  return {manifest, cases, pins, manifestPin: pin};
}
export type LoadedPublicTransitions = ReturnType<typeof readPublicTransitionWorkload>;
