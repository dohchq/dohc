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
interface Case {
  baseline: Projection & {checkpoint: WorkloadPin};
  updates: Update[];
  interrupted?: {deliveryId: string; bytes: WorkloadPin};
  resumed?: Update;
}
interface Manifest {version: 1; concurrency: number; cases: Record<TransitionName | "view", Case>}
export const workloadHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

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
    if (!selected || !Array.isArray(selected.updates) || !selected.updates.length || (name !== "view" && !selected.interrupted) || (["restart", "staleFrame", "restore"].includes(name) && !selected.resumed)) throw new Error(`Incomplete transition: ${name}`);
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
      // Restored content is the exact selected baseline, with a native-generated restore fence.
      // Validate resumed corpus content against that baseline; the runtime supplies the real restore.
      let resumed: ReturnType<typeof apply> | undefined;
      if (selected.resumed) {
        if (name === "restore") {
          const restored = new Y.Doc({gc: false});
          try {
            Y.applyUpdate(restored, baseline.checkpoint);
            previousProjection = baseline;
            resumed = apply(selected.resumed, restored);
          } finally {restored.destroy();}
        } else resumed = apply(selected.resumed);
      }
      return {baseline, updates, interrupted, resumed};
    } finally {doc.destroy();}
  }
  const cases = Object.fromEntries(([...transitionNames, "view"] as const).map(name => [name, load(name)])) as Record<TransitionName | "view", ReturnType<typeof load>>;
  return {manifest, cases, pins};
}
export type LoadedPublicTransitions = ReturnType<typeof readPublicTransitionWorkload>;
