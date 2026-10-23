import {createHash} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {expect, it} from "vitest";
import * as Y from "yjs";
import {markdownToYDoc, yDocToMarkdown} from "@dohc/ydoc-projection";
import type {OwnerYDocOutboxPending} from "@dohc/workspace-engine-client";
import {saveLiveRecoveryCopy} from "./ownerLiveRecoveryCopy";
import {createDurableFile} from "./workspaceFiles";
import {createTestScratch} from "./testTemp";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const binding = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
  currentPath: "notes/plan.md", selectorPaths: ["notes/plan.md"], restoreFenceGeneration: 0};
const source = {path: "notes/plan.md", reason: "capacity-refused", storedOn: "this-computer" as const};

/** A queue of `count` typed edits on a base, far past what a Stop releases (32 entries, 4 KiB). */
function queue(count: number): {pending: OwnerYDocOutboxPending; markdown: string} {
  const doc = markdownToYDoc("# Plan\n\nStart here.");
  const baseUpdate = Y.encodeStateAsUpdate(doc);
  const entries = [];
  for (let sequence = 1; sequence <= count; sequence++) {
    const before = Y.encodeStateVector(doc);
    doc.getMap("frontmatter").set(`edit${sequence}`, "x".repeat(200));
    const update = Y.encodeStateAsUpdate(doc, before);
    entries.push({sequence, appendKey: `append-${sequence}`, deliveryId: `delivery-${sequence}`, updateDigest: sha256(update), update,
      byteLength: update.byteLength, createdAtMs: 1_000 + sequence, ...(sequence % 2 ? {personEdit: true as const} : {})});
  }
  const markdown = yDocToMarkdown(doc); doc.destroy();
  return {markdown, pending: {outboxId: "outbox", binding, baseUpdateDigest: sha256(baseUpdate), baseUpdate, state: "quarantined",
    pendingBytes: entries.reduce((sum, entry) => sum + entry.byteLength, 0), oldestEntryAtMs: 1_001, entries, quarantineReason: "capacity-refused",
    observedBinding: null, retryDeliveryId: null}};
}

async function workspace() {
  const root = await createTestScratch("dohc-live-recovery-");
  return {root, create: (relative: string, text: string) => createDurableFile(root, relative, text)};
}

it("saves a queue over the release limits as a readable copy and a package that rebuilds it", async () => {
  const {root, create} = await workspace(), {pending, markdown} = queue(40);
  expect(pending.pendingBytes).toBeGreaterThan(4 * 1024);
  const saved = await saveLiveRecoveryCopy(pending, source, create, Date.UTC(2026, 9, 24));
  expect(saved).toEqual({copyPath: "notes/plan (recovered).md", packagePath: "notes/plan (recovered).dohc-recovery.json"});
  expect(await readFile(join(root, saved.copyPath!), "utf8")).toBe(markdown);
  const recovery = JSON.parse(await readFile(join(root, saved.packagePath), "utf8"));
  expect(recovery).toMatchObject({format: "dohc.live-recovery", version: 1, path: "notes/plan.md", reason: "capacity-refused",
    storedOn: "this-computer", outboxId: "outbox", binding, savedAt: "2026-10-24T00:00:00.000Z"});
  expect(recovery.updates).toHaveLength(40);
  expect(recovery.updates[0]).toMatchObject({sequence: 1, deliveryId: "delivery-1", author: {kind: "person"}});
  expect(recovery.updates[1].author).toBeNull();
  // What the package says to do rebuilds the same document.
  const rebuilt = new Y.Doc();
  for (const part of [recovery.base, ...recovery.updates]) {
    const bytes = Buffer.from(part.base64, "base64");
    expect(sha256(bytes)).toBe(part.sha256);
    Y.applyUpdate(rebuilt, bytes);
  }
  expect(yDocToMarkdown(rebuilt)).toBe(markdown); rebuilt.destroy();
});

it("keeps the original bytes in a package when the edits cannot be read as a document", async () => {
  const {root, create} = await workspace(), {pending} = queue(3);
  // Without the first edit, the later ones wait on what they depend on.
  const broken = {...pending, entries: pending.entries.slice(1)};
  const saved = await saveLiveRecoveryCopy(broken, source, create);
  expect(saved).toEqual({copyPath: null, packagePath: "notes/plan (recovered).dohc-recovery.json"});
  const recovery = JSON.parse(await readFile(join(root, saved.packagePath), "utf8"));
  expect(recovery.updates.map((update: {base64: string}) => Buffer.from(update.base64, "base64")))
    .toEqual(broken.entries.map(entry => Buffer.from(entry.update)));
});

it("never replaces a file: an earlier recovery copy keeps its name", async () => {
  const {root, create} = await workspace(), {pending} = queue(2);
  await create("notes/plan (recovered).md", "older copy");
  const saved = await saveLiveRecoveryCopy(pending, source, create);
  expect(saved).toEqual({copyPath: "notes/plan (recovered 2).md", packagePath: "notes/plan (recovered).dohc-recovery.json"});
  expect(await readFile(join(root, "notes/plan (recovered).md"), "utf8")).toBe("older copy");
  await writeFile(join(root, "untouched.md"), "x");
  await expect(create("untouched.md", "y")).rejects.toMatchObject({code: "EEXIST"});
});

it("refuses a queue whose bytes do not match their digests, and writes nothing", async () => {
  const {root, create} = await workspace(), {pending} = queue(2);
  const tampered = {...pending, entries: [pending.entries[0]!, {...pending.entries[1]!, update: Uint8Array.of(1, 2, 3)}]};
  await expect(saveLiveRecoveryCopy(tampered, source, create)).rejects.toThrow("could not read your kept edits");
  await expect(readFile(join(root, "notes/plan (recovered).dohc-recovery.json"))).rejects.toMatchObject({code: "ENOENT"});
});
