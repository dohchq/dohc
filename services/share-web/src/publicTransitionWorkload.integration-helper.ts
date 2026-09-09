import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {dirname, isAbsolute, resolve} from "node:path";
import * as Y from "yjs";
import {yDocToMarkdown} from "@dohc/ydoc-projection";
import type {WorkloadPin} from "./publicLinkWorkload.integration-helper.js";

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
    const selected = manifest.cases[name], doc = new Y.Doc({gc: false});
    if (!selected.updates.length || (name !== "view" && !selected.interrupted) || (["restart", "staleFrame", "restore"].includes(name) && !selected.resumed)) throw new Error(`Incomplete transition: ${name}`);
    const baseline = {...projection(selected.baseline), checkpoint: read(selected.baseline.checkpoint)};
    try {
      Y.applyUpdate(doc, baseline.checkpoint);
      if (workloadHash(Buffer.from(yDocToMarkdown(doc))) !== workloadHash(baseline.markdown)) throw new Error(`Baseline projection mismatch: ${name}`);
      let previousProjection = baseline;
      const apply = (value: Update) => {
        const item = {...update(value), expected: projection(value.expected)}, before = workloadHash(Y.encodeStateAsUpdate(doc));
        if (workloadHash(item.expected.editorText) === workloadHash(previousProjection.editorText) ||
          (name === "view" && workloadHash(item.expected.viewText) === workloadHash(previousProjection.viewText))) throw new Error("A render witness requires a changed expected projection.");
        Y.applyUpdate(doc, item.bytes);
        if (workloadHash(Y.encodeStateAsUpdate(doc)) === before) throw new Error(`Transition update adds no state: ${item.deliveryId}`);
        if (workloadHash(Buffer.from(yDocToMarkdown(doc))) !== workloadHash(item.expected.markdown)) throw new Error(`Transition projection mismatch: ${item.deliveryId}`);
        previousProjection = {...baseline, ...item.expected}; return item;
      };
      const updates = selected.updates.map(apply), interrupted = selected.interrupted && update(selected.interrupted);
      // Restored content is the exact selected baseline, with a native-generated restore fence.
      // Validate resumed corpus content against that baseline; the runtime supplies the real restore.
      let resumed: ReturnType<typeof apply> | undefined;
      if (selected.resumed) {
        if (name === "restore") {
          const restored = new Y.Doc({gc: false});
          try {
            Y.applyUpdate(restored, baseline.checkpoint);
            resumed = {...update(selected.resumed), expected: projection(selected.resumed.expected)};
            Y.applyUpdate(restored, resumed.bytes);
            if (workloadHash(Buffer.from(yDocToMarkdown(restored))) !== workloadHash(resumed.expected.markdown)) throw new Error("Restored successor projection mismatch.");
          } finally {restored.destroy();}
        } else resumed = apply(selected.resumed);
      }
      return {baseline, updates, interrupted, resumed};
    } finally {doc.destroy();}
  }
  const cases = Object.fromEntries([...transitionNames, "view"].map(name => [name, load(name)])) as Record<TransitionName | "view", ReturnType<typeof load>>;
  return {manifest, cases, pins};
}
export type LoadedPublicTransitions = ReturnType<typeof readPublicTransitionWorkload>;
