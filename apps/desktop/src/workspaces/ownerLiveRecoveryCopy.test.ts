import {createHash} from "node:crypto";
import {access, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {expect, it, vi} from "vitest";
import * as Y from "yjs";
import {getDohcYDocBodyFragment, markdownToYDoc, yDocToMarkdown} from "@dohc/ydoc-projection";
import {WORKER_LIVE_VALIDATION_POLICY, withinLiveNoteCapacity} from "@dohc/ydoc-projection/live-journal-validation";
import type {OwnerYDocOutboxEntry, OwnerYDocOutboxRecovery} from "@dohc/workspace-engine-client";
import {liveRecoveryPackage, parseLiveRecoveryPackage, saveLiveRecoveryCopy} from "./ownerLiveRecoveryCopy";
import {directDocumentProjection, type DocumentProjection} from "./documentProjection";
import {createDurableFile} from "./workspaceFiles";
import {createTestScratch} from "./testTemp";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const binding = {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "a".repeat(64),
  currentPath: "notes/plan.md", selectorPaths: ["notes/plan.md"], restoreFenceGeneration: 0};
const source = {path: "notes/plan.md", reason: "capacity-refused", storedOn: "this-computer" as const};

/**
 * A document typed in `count` edits after a base. The server accepted the
 * first `accepted` of them, so they left the queue and live only in the
 * checkpoint; each later edit builds on the one before it.
 */
function queue(count: number, accepted = 0, attribution: (sequence: number) => Partial<OwnerYDocOutboxEntry> = () => ({})):
  {recovery: OwnerYDocOutboxRecovery; markdown: string} {
  const doc = markdownToYDoc("# Plan\n\nStart here.");
  const baseUpdate = Y.encodeStateAsUpdate(doc);
  let checkpoint: Uint8Array | null = null;
  const entries = [];
  for (let sequence = 1; sequence <= count; sequence++) {
    const before = Y.encodeStateVector(doc);
    doc.getMap("frontmatter").set("status", `edit ${sequence} ${"x".repeat(200)}`);
    const update = Y.encodeStateAsUpdate(doc, before);
    if (sequence <= accepted) {checkpoint = Y.encodeStateAsUpdate(doc); continue;}
    entries.push({sequence, appendKey: `append-${sequence}`, deliveryId: `delivery-${sequence}`, updateDigest: sha256(update), update,
      byteLength: update.byteLength, createdAtMs: 1_000 + sequence, ...attribution(sequence)});
  }
  const markdown = yDocToMarkdown(doc); doc.destroy();
  return {markdown, recovery: {outboxId: "outbox", binding, baseUpdateDigest: sha256(baseUpdate), baseUpdate, checkpoint,
    checkpointDigest: checkpoint === null ? null : sha256(checkpoint), state: "quarantined",
    pendingBytes: entries.reduce((sum, entry) => sum + entry.byteLength, 0), oldestEntryAtMs: 1_001, entries, quarantineReason: "capacity-refused",
    observedBinding: null, retryDeliveryId: null}};
}

async function workspace() {
  const root = await createTestScratch("dohc-live-recovery-");
  const writes = {
    create: (relative: string, text: string) => createDurableFile(root, relative, text),
    exists: (relative: string) => access(join(root, relative)).then(() => true, () => false),
  };
  return {root, writes};
}

/** Follows the package's own `open` field with nothing but its bytes. */
function reopen(recovery: {checkpoint: {base64: string; sha256: string} | null; base: {base64: string; sha256: string}; updates: {base64: string; sha256: string}[]}) {
  const rebuilt = new Y.Doc();
  try {
    for (const part of [...(recovery.checkpoint ? [recovery.checkpoint] : []), recovery.base, ...recovery.updates]) {
      const bytes = Buffer.from(part.base64, "base64");
      expect(sha256(bytes)).toBe(part.sha256);
      Y.applyUpdate(rebuilt, bytes);
    }
    expect(rebuilt.store.pendingStructs).toBeNull();
    return yDocToMarkdown(rebuilt);
  } finally {rebuilt.destroy();}
}

it("rebuilds the kept edits from the package alone after the server accepted the edits they build on", async () => {
  const {root, writes} = await workspace(), {recovery, markdown} = queue(5, 2);
  expect(recovery.entries.map(entry => entry.sequence)).toEqual([3, 4, 5]);
  const saved = await saveLiveRecoveryCopy(liveRecoveryPackage(recovery, source), writes, directDocumentProjection);
  expect(saved).toEqual({copyPath: "notes/plan (recovered).md", packagePath: "notes/plan (recovered).dohc-recovery.json", storedOn: "this-computer"});
  expect(await readFile(join(root, saved.copyPath!), "utf8")).toBe(markdown);
  const written = JSON.parse(await readFile(join(root, saved.packagePath), "utf8"));
  expect(written.open).toMatch(/^Apply checkpoint when present, then base, then each update in order/);
  expect(written.updates.map((update: {sequence: number}) => update.sequence)).toEqual([3, 4, 5]);
  expect(reopen(written)).toBe(markdown);
});

it("saves a queue over the release limits as a readable copy and a package that rebuilds it", async () => {
  const {root, writes} = await workspace(), {recovery, markdown} = queue(40);
  expect(recovery.pendingBytes).toBeGreaterThan(4 * 1024);
  const saved = await saveLiveRecoveryCopy(liveRecoveryPackage(recovery, source), writes, directDocumentProjection, Date.UTC(2026, 9, 24));
  expect(await readFile(join(root, saved.copyPath!), "utf8")).toBe(markdown);
  const written = JSON.parse(await readFile(join(root, saved.packagePath), "utf8"));
  expect(written).toMatchObject({format: "dohc.live-recovery", version: 1, path: "notes/plan.md", reason: "capacity-refused",
    storedOn: "this-computer", outboxId: "outbox", binding, savedAt: "2026-10-24T00:00:00.000Z", checkpoint: null});
  expect(written.updates).toHaveLength(40);
  expect(reopen(written)).toBe(markdown);
});

it("keeps the original bytes in a package when the edits cannot be read as a document", async () => {
  const {root, writes} = await workspace(), {recovery} = queue(5, 2);
  // Without the checkpoint, the kept edits wait on the accepted ones they build on.
  const saved = await saveLiveRecoveryCopy(liveRecoveryPackage({...recovery, checkpoint: null}, source), writes, directDocumentProjection);
  expect(saved).toEqual({copyPath: null, packagePath: "notes/plan (recovered).dohc-recovery.json", storedOn: "this-computer"});
  const written = JSON.parse(await readFile(join(root, saved.packagePath), "utf8"));
  expect(written.updates.map((update: {base64: string}) => Buffer.from(update.base64, "base64")))
    .toEqual(recovery.entries.map(entry => Buffer.from(entry.update)));
});

it("writes the package before the copy is projected, and keeps it when the projection fails", async () => {
  const {root, writes} = await workspace(), {recovery} = queue(3);
  const packaged = join(root, "notes/plan (recovered).dohc-recovery.json");
  const projection: DocumentProjection = {run: vi.fn(async () => {
    await expect(access(packaged)).resolves.toBeUndefined();
    throw new Error("dohc could not prepare the document (its worker exited with 1).");
  })};
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const saved = await saveLiveRecoveryCopy(liveRecoveryPackage(recovery, source), writes, projection);
    expect(saved).toEqual({copyPath: null, packagePath: "notes/plan (recovered).dohc-recovery.json", storedOn: "this-computer"});
    expect(projection.run).toHaveBeenCalledOnce();
    expect(reopen(JSON.parse(await readFile(packaged, "utf8")))).toBeTruthy();
  } finally {vi.restoreAllMocks();}
});

it("never replaces a file, and gives the copy and its package the same free number", async () => {
  const {root, writes} = await workspace(), {recovery} = queue(2);
  await writes.create("notes/plan (recovered).md", "older copy");
  await writes.create("notes/plan (recovered 2).dohc-recovery.json", "older package");
  const saved = await saveLiveRecoveryCopy(liveRecoveryPackage(recovery, source), writes, directDocumentProjection);
  expect(saved).toEqual({copyPath: "notes/plan (recovered 3).md", packagePath: "notes/plan (recovered 3).dohc-recovery.json", storedOn: "this-computer"});
  expect(await readFile(join(root, "notes/plan (recovered).md"), "utf8")).toBe("older copy");
  expect(await readFile(join(root, "notes/plan (recovered 2).dohc-recovery.json"), "utf8")).toBe("older package");
  await writeFile(join(root, "untouched.md"), "x");
  await expect(writes.create("untouched.md", "y")).rejects.toMatchObject({code: "EEXIST"});
});

it("refuses a queue whose bytes do not match their digests, and writes nothing", async () => {
  const {root, writes} = await workspace(), {recovery} = queue(2);
  const tampered = {...recovery, entries: [recovery.entries[0]!, {...recovery.entries[1]!, update: Uint8Array.of(1, 2, 3)}]};
  expect(() => liveRecoveryPackage(tampered, source)).toThrow("could not read your kept edits");
  const text = JSON.stringify(liveRecoveryPackage(recovery, source));
  expect(() => parseLiveRecoveryPackage(text.replace(/"base64":"[^"]+"/, `"base64":"${Buffer.from("other").toString("base64")}"`)))
    .toThrow("could not read your kept edits");
  await expect(saveLiveRecoveryCopy(parseLiveRecoveryPackage(text), {...writes, create: async () => {throw new Error("disk full");}},
    directDocumentProjection)).rejects.toThrow("disk full");
  await expect(access(join(root, "notes"))).rejects.toMatchObject({code: "ENOENT"});
});

it("keeps who wrote each edit: a declaration, a person, and the author a native update's journal recorded", async () => {
  const native = (actorKind: string | null, actorOriginId: string | null) => ({nativeSource: {binding, adoptionId: "adoption", nativeSequence: 7,
    updateDigest: "", origin: {kind: "nativeUpdate" as const, actorOriginId, actorKind, onBehalfOf: actorKind === "human" ? null : "local-person",
      chainDepth: actorKind === "human" ? 0 : 1, recordedAtMs: 5}}});
  const kinds: Record<number, Partial<OwnerYDocOutboxEntry>> = {
    1: {agentDeclaration: {agentId: "trip-agent", onBehalfOf: "local-person", depth: 1}},
    2: {personEdit: true},
    3: native("human", "local-person"),
    4: native("agent", "trip-agent"),
    5: native("automation", "automation-1"),
    6: {nativeSource: {binding, adoptionId: "adoption", nativeSequence: 0, updateDigest: "", origin: {kind: "adoptionSeed"}}},
    7: {nativeSource: {...native("agent", "trip-agent").nativeSource,
      origin: {...native("agent", "trip-agent").nativeSource.origin, agentRunId: "run-1"}}},
    8: {agentDeclaration: {agentId: "trip-agent", onBehalfOf: "local-person", depth: 1}, agentRunId: "run-2"},
  };
  const {recovery} = queue(8, 0, sequence => kinds[sequence]!);
  const written = parseLiveRecoveryPackage(JSON.stringify(liveRecoveryPackage(recovery, source)));
  expect(written.updates.map(update => update.author)).toEqual([
    {kind: "agent", declaration: {agentId: "trip-agent", onBehalfOf: "local-person", depth: 1}},
    {kind: "person"},
    {kind: "person", actorOriginId: "local-person", onBehalfOf: null, chainDepth: 0},
    {kind: "agent", actorOriginId: "trip-agent", onBehalfOf: "local-person", chainDepth: 1},
    {kind: "automation", actorOriginId: "automation-1", onBehalfOf: "local-person", chainDepth: 1},
    null,
    // An agent's edit made in a run keeps the run, native or declared.
    {kind: "agent", actorOriginId: "trip-agent", onBehalfOf: "local-person", chainDepth: 1, agentRunId: "run-1"},
    {kind: "agent", declaration: {agentId: "trip-agent", onBehalfOf: "local-person", depth: 1}, agentRunId: "run-2"},
  ]);
  // The recorded source itself travels with each native edit, unchanged.
  expect(written.updates.map(update => update.nativeSource?.origin)).toEqual([undefined, undefined,
    ...[3, 4, 5, 6, 7].map(sequence => kinds[sequence]!.nativeSource!.origin), undefined]);
});

/** Whether the note these updates build is within the bound the server checks live notes against. */
function withinBound(...updates: Uint8Array[]): boolean {
  const doc = new Y.Doc({gc: false});
  try {
    for (const update of updates) Y.applyUpdate(doc, update);
    return withinLiveNoteCapacity(doc, WORKER_LIVE_VALIDATION_POLICY);
  } finally {doc.destroy();}
}
function addLines(body: Y.XmlFragment, label: string, count: number): void {
  body.insert(body.length, Array.from({length: count}, (_, line) => {
    const paragraph = new Y.XmlElement("paragraph"); paragraph.insert(0, [new Y.XmlText(`${label} ${line}`)]); return paragraph;
  }));
}
/**
 * A note the server accepted just under the bound, and one pasted block of
 * lines the server refused because it took the note over. `history` makes the
 * note dense with lines that were added and later removed, which still count.
 */
function tooDenseQueue(history: boolean): {recovery: OwnerYDocOutboxRecovery; markdown: string; accepted: Uint8Array} {
  const doc = new Y.Doc({gc: false});
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(markdownToYDoc("# Plan\n\nStart here.")));
  const body = getDohcYDocBodyFragment(doc);
  addLines(body, history ? "removed" : "kept", 30_000);
  if (history) body.delete(2, 30_000);
  const accepted = Y.encodeStateAsUpdate(doc), before = Y.encodeStateVector(doc);
  addLines(body, "pasted", 3_000);
  const update = Y.encodeStateAsUpdate(doc, before), markdown = yDocToMarkdown(doc);
  doc.destroy();
  const entry = {sequence: 1, appendKey: "append-1", deliveryId: "delivery-1", updateDigest: sha256(update), update,
    byteLength: update.byteLength, createdAtMs: 1_001, personEdit: true as const};
  return {markdown, accepted, recovery: {outboxId: "outbox", binding, baseUpdateDigest: sha256(accepted), baseUpdate: accepted, checkpoint: null,
    checkpointDigest: null, state: "quarantined", pendingBytes: update.byteLength, oldestEntryAtMs: 1_001, entries: [entry],
    quarantineReason: "document-too-dense", observedBinding: null, retryDeliveryId: null}};
}

it.each([
  ["its past edits", true, true],
  ["what it holds now", false, false],
])("saves a readable copy, with the refused paste, of a note too dense through %s", async (_, history, copyWithinBound) => {
  const {root, writes} = await workspace(), {recovery, markdown, accepted} = tooDenseQueue(history);
  expect(withinBound(accepted)).toBe(true);
  expect(withinBound(accepted, recovery.entries[0]!.update)).toBe(false);
  const saved = await saveLiveRecoveryCopy(liveRecoveryPackage(recovery, {...source, reason: "document-too-dense"}), writes, directDocumentProjection);
  expect(saved).toEqual({copyPath: "notes/plan (recovered).md", packagePath: "notes/plan (recovered).dohc-recovery.json", storedOn: "this-computer"});
  const copy = await readFile(join(root, saved.copyPath!), "utf8");
  expect(copy).toBe(markdown);
  expect(copy).toContain("pasted 2999");
  // The copy is a new note. Without the old note's removed lines it can be
  // edited live again; a note dense through what it holds is still too dense.
  const reopened = markdownToYDoc(copy);
  try {
    expect(withinLiveNoteCapacity(reopened, WORKER_LIVE_VALIDATION_POLICY)).toBe(copyWithinBound);
  } finally {reopened.destroy();}
});
