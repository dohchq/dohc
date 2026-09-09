import {createHash} from "node:crypto";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {isAbsolute, join} from "node:path";
import {expect, it} from "vitest";
import * as Y from "yjs";
import {markdownToYDoc, yDocToMarkdown} from "@dohc/ydoc-projection";
import {readPublicWorkload, type WorkloadPin} from "./publicLinkWorkload.integration-helper.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture(run: (input: ReturnType<typeof prepare>) => void) {
  const prefix = join(tmpdir(), "dohc-public-workload-loader-"), root = mkdtempSync(prefix);
  try {run(prepare(root));}
  finally {
    if (!isAbsolute(root) || !root.startsWith(prefix)) throw new Error("Unexpected test cleanup path.");
    rmSync(root, {recursive: true, force: true});
  }
}
function prepare(root: string) {
  function pin(path: string, bytes: Uint8Array): WorkloadPin {
    writeFileSync(join(root, path), bytes); return {path, sha256: hash(bytes), byteLength: bytes.length};
  }
  const baseline = markdownToYDoc("Hello"), first = new Y.Doc({gc: false}), second = new Y.Doc({gc: false});
  try {
    const checkpoint = Y.encodeStateAsUpdate(baseline), vector = Y.encodeStateVector(baseline);
    Y.applyUpdate(first, checkpoint); Y.applyUpdate(second, checkpoint);
    first.getMap("frontmatter").set("first", "one"); second.getMap("frontmatter").set("second", "two");
    const updates = [first, second].map((doc, client) => ({client, deliveryId: `client-${client}`,
      bytes: pin(`update-${client}.bin`, Y.encodeStateAsUpdate(doc, vector))}));
    Y.applyUpdate(baseline, readFileSync(join(root, updates[0]!.bytes.path)));
    Y.applyUpdate(baseline, readFileSync(join(root, updates[1]!.bytes.path)));
    const manifest = {version: 1, concurrency: 2,
      baseline: {checkpoint: pin("baseline.bin", checkpoint), markdown: pin("baseline.md", Buffer.from("Hello"))},
      rounds: [{updates, markdown: pin("final.md", Buffer.from(yDocToMarkdown(baseline)))}]};
    function seal() {
      const path = join(root, "manifest.json"), bytes = Buffer.from(JSON.stringify(manifest));
      writeFileSync(path, bytes); return {path, sha256: hash(bytes)};
    }
    return {root, manifest, pin, seal};
  } finally {baseline.destroy(); first.destroy(); second.destroy();}
}

it("loads distinct concurrent clients and verifies the final projection", () => fixture(({seal}) => {
  const loaded = readPublicWorkload(seal(), 2);
  expect(loaded.rounds[0]!.updates.map(update => update.client)).toEqual([0, 1]);
  expect(loaded.rounds[0]!.markdown.toString()).toContain("first: one");
  expect(loaded.rounds[0]!.markdown.toString()).toContain("second: two");
}));
it("rejects duplicate updates under different delivery IDs", () => fixture(({manifest, seal}) => {
  manifest.rounds[0]!.updates[1]!.bytes = manifest.rounds[0]!.updates[0]!.bytes;
  expect(() => readPublicWorkload(seal(), 2)).toThrow("Duplicate workload update bytes");
}));
it("rejects a client that adds no independent state", () => fixture(({manifest, pin, seal}) => {
  const empty = new Y.Doc();
  try {manifest.rounds[0]!.updates[1]!.bytes = pin("empty.bin", Y.encodeStateAsUpdate(empty));}
  finally {empty.destroy();}
  expect(() => readPublicWorkload(seal(), 2)).toThrow("adds no independent state");
}));
it("rejects changed asset bytes", () => fixture(({root, manifest, seal}) => {
  const sealed = seal(); writeFileSync(join(root, manifest.rounds[0]!.updates[0]!.bytes.path), "changed");
  expect(() => readPublicWorkload(sealed, 2)).toThrow("Workload asset changed");
}));
it("rejects a pinned but incorrect expected projection", () => fixture(({manifest, pin, seal}) => {
  manifest.rounds[0]!.markdown = pin("wrong.md", Buffer.from("Wrong"));
  expect(() => readPublicWorkload(seal(), 2)).toThrow("Round projection mismatch");
}));
