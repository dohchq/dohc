import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import * as Y from "yjs";
import {yDocToMarkdown} from "@dohc/ydoc-projection";

export interface WorkloadPin {path: string; sha256: string; byteLength: number}
interface WorkloadManifest {
  version: 1;
  concurrency: number;
  baseline: {checkpoint: WorkloadPin; markdown: WorkloadPin};
  rounds: {updates: {client: number; deliveryId: string; bytes: WorkloadPin}[]; markdown: WorkloadPin}[];
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// This is a consumer of selected corpus bytes; it never generates or scales cases.
export function readPublicWorkload(pin: {path: string; sha256: string}, concurrency: number) {
  const manifestBytes = readFileSync(pin.path);
  if (hash(manifestBytes) !== pin.sha256) throw new Error("Public workload manifest changed.");
  const manifest = JSON.parse(manifestBytes.toString()) as WorkloadManifest;
  if (manifest.version !== 1 || manifest.concurrency !== concurrency || !manifest.rounds.length) throw new Error("Invalid workload coverage.");
  const pins: WorkloadPin[] = [];
  function read(asset: WorkloadPin) {
    const path = resolve(dirname(pin.path), asset.path), bytes = readFileSync(path);
    if (hash(bytes) !== asset.sha256 || bytes.length !== asset.byteLength) throw new Error(`Workload asset changed: ${path}`);
    pins.push({...asset, path}); return bytes;
  }
  const checkpoint = read(manifest.baseline.checkpoint), markdown = read(manifest.baseline.markdown);
  const doc = new Y.Doc({gc: false}), deliveries = new Set<string>(), digests = new Set<string>();
  try {
    Y.applyUpdate(doc, checkpoint);
    if (hash(Buffer.from(yDocToMarkdown(doc))) !== hash(markdown)) throw new Error("Baseline projection mismatch.");
    const rounds = manifest.rounds.map(round => {
      if (round.updates.length !== concurrency || new Set(round.updates.map(update => update.client)).size !== concurrency) throw new Error("Every round requires distinct clients.");
      const updates = round.updates.map(update => {
        if (!Number.isSafeInteger(update.client) || update.client < 0 || update.client >= concurrency || !update.deliveryId || deliveries.has(update.deliveryId)) throw new Error("Invalid workload delivery identity.");
        const bytes = read(update.bytes);
        if (digests.has(hash(bytes))) throw new Error("Duplicate workload update bytes do not prove independent work.");
        deliveries.add(update.deliveryId); digests.add(hash(bytes)); return {...update, content: bytes};
      });
      const before = Y.encodeStateAsUpdate(doc);
      // Each candidate must add actual state even after all other clients' candidates.
      for (const candidate of updates) {
        const isolated = new Y.Doc({gc: false});
        try {
          Y.applyUpdate(isolated, before);
          for (const other of updates) if (other !== candidate) Y.applyUpdate(isolated, other.content);
          const prior = hash(Y.encodeStateAsUpdate(isolated)); Y.applyUpdate(isolated, candidate.content);
          if (hash(Y.encodeStateAsUpdate(isolated)) === prior) throw new Error("Workload candidate adds no independent state.");
        } finally {isolated.destroy();}
      }
      for (const update of updates) Y.applyUpdate(doc, update.content);
      const expected = read(round.markdown);
      if (hash(Buffer.from(yDocToMarkdown(doc))) !== hash(expected)) throw new Error("Round projection mismatch.");
      return {updates, markdown: expected};
    });
    return {manifest, checkpoint, markdown, rounds, pins};
  } finally {doc.destroy();}
}
