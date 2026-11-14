import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import type { OwnerYDocOutboxEntry, OwnerYDocOutboxRecovery } from "@dohc/workspace-engine-client";
import {
  keepOnThisComputer,
  liveRecoveryPackage,
  parseLiveRecoveryPackage,
  saveLiveRecoveryCopy,
} from "./ownerLiveRecoveryCopy";
import { directDocumentProjection, type DocumentProjection } from "./documentProjection";
import { createDurableFile } from "./workspaceFiles";
import { createTestScratch } from "./testTemp";
import { openedLocalState } from "../testing/preparedLocalState";

const KEPT = ".dohc/local/live-recovery";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const binding = {
  workspaceId: "workspace",
  mainVersionId: "main",
  objectId: "object",
  lineageClaimId: "a".repeat(64),
  currentPath: "notes/plan.md",
  selectorPaths: ["notes/plan.md"],
  restoreFenceGeneration: 0,
};
const source = {
  path: "notes/plan.md",
  reason: "capacity-refused",
  storedOn: "this-computer" as const,
};

/**
 * A document typed in `count` edits after a base. The server accepted the
 * first `accepted` of them, so they left the queue and live only in the
 * checkpoint; each later edit builds on the one before it.
 */
function queue(
  count: number,
  accepted = 0,
  attribution: (sequence: number) => Partial<OwnerYDocOutboxEntry> = () => ({}),
): { recovery: OwnerYDocOutboxRecovery; markdown: string } {
  const doc = markdownToYDoc("# Plan\n\nStart here.");
  const baseUpdate = Y.encodeStateAsUpdate(doc);
  let checkpoint: Uint8Array | null = null;
  const entries = [];
  for (let sequence = 1; sequence <= count; sequence++) {
    const before = Y.encodeStateVector(doc);
    doc.getMap("frontmatter").set("status", `edit ${sequence} ${"x".repeat(200)}`);
    const update = Y.encodeStateAsUpdate(doc, before);
    if (sequence <= accepted) {
      checkpoint = Y.encodeStateAsUpdate(doc);
      continue;
    }
    entries.push({
      sequence,
      appendKey: `append-${sequence}`,
      deliveryId: `delivery-${sequence}`,
      updateDigest: sha256(update),
      update,
      byteLength: update.byteLength,
      createdAtMs: 1_000 + sequence,
      ...attribution(sequence),
    });
  }
  const markdown = yDocToMarkdown(doc);
  doc.destroy();
  return {
    markdown,
    recovery: {
      outboxId: "outbox",
      binding,
      baseUpdateDigest: sha256(baseUpdate),
      baseUpdate,
      checkpoint,
      checkpointDigest: checkpoint === null ? null : sha256(checkpoint),
      state: "quarantined",
      pendingBytes: entries.reduce((sum, entry) => sum + entry.byteLength, 0),
      oldestEntryAtMs: 1_001,
      entries,
      quarantineReason: "capacity-refused",
      observedBinding: null,
      retryDeliveryId: null,
    },
  };
}

async function workspace() {
  const root = await createTestScratch("dohc-live-recovery-");
  const local = { workspaceId: "live-recovery", rootPath: root };
  await openedLocalState(local);
  const writes = {
    create: (relative: string, text: string) => createDurableFile(root, relative, text),
    keep: keepOnThisComputer(local),
    exists: (relative: string) =>
      access(join(root, relative)).then(
        () => true,
        () => false,
      ),
  };
  return { root, writes };
}

/** Follows the package's own `open` field with nothing but its bytes. */
function reopen(recovery: {
  checkpoint: { base64: string; sha256: string } | null;
  base: { base64: string; sha256: string };
  updates: { base64: string; sha256: string }[];
}) {
  const rebuilt = new Y.Doc();
  try {
    for (const part of [
      ...(recovery.checkpoint ? [recovery.checkpoint] : []),
      recovery.base,
      ...recovery.updates,
    ]) {
      const bytes = Buffer.from(part.base64, "base64");
      expect(sha256(bytes)).toBe(part.sha256);
      Y.applyUpdate(rebuilt, bytes);
    }
    expect(rebuilt.store.pendingStructs).toBeNull();
    return yDocToMarkdown(rebuilt);
  } finally {
    rebuilt.destroy();
  }
}

it("rebuilds the kept edits from the package alone after the server accepted the edits they build on", async () => {
  const { root, writes } = await workspace(),
    { recovery, markdown } = queue(5, 2);
  expect(recovery.entries.map((entry) => entry.sequence)).toEqual([3, 4, 5]);
  const saved = await saveLiveRecoveryCopy(
    liveRecoveryPackage(recovery, source),
    writes,
    directDocumentProjection,
  );
  expect(saved).toEqual({
    copyPath: "notes/plan (recovered).md",
    packagePath: `${KEPT}/notes/plan (recovered).dohc-recovery.json`,
    notInNote: 0,
    storedOn: "this-computer",
  });
  expect(await readFile(join(root, saved.copyPath!), "utf8")).toBe(markdown);
  const written = JSON.parse(await readFile(join(root, saved.packagePath), "utf8"));
  expect(written.open).toMatch(
    /^Apply checkpoint when present, then base, then each update in order/,
  );
  expect(written.updates.map((update: { sequence: number }) => update.sequence)).toEqual([3, 4, 5]);
  expect(reopen(written)).toBe(markdown);
});

it("saves a queue over the release limits as a readable copy and a package that rebuilds it", async () => {
  const { root, writes } = await workspace(),
    { recovery, markdown } = queue(40);
  expect(recovery.pendingBytes).toBeGreaterThan(4 * 1024);
  const saved = await saveLiveRecoveryCopy(
    liveRecoveryPackage(recovery, source),
    writes,
    directDocumentProjection,
    Date.UTC(2026, 9, 24),
  );
  expect(await readFile(join(root, saved.copyPath!), "utf8")).toBe(markdown);
  const written = JSON.parse(await readFile(join(root, saved.packagePath), "utf8"));
  expect(written).toMatchObject({
    format: "dohc.live-recovery",
    version: 1,
    path: "notes/plan.md",
    reason: "capacity-refused",
    storedOn: "this-computer",
    outboxId: "outbox",
    binding,
    savedAt: "2026-10-24T00:00:00.000Z",
    checkpoint: null,
  });
  expect(written.updates).toHaveLength(40);
  expect(reopen(written)).toBe(markdown);
});

it("keeps the original bytes in a package when the edits cannot be read as a document", async () => {
  const { root, writes } = await workspace(),
    { recovery } = queue(5, 2);
  // Without the checkpoint, the kept edits wait on the accepted ones they build on.
  const saved = await saveLiveRecoveryCopy(
    liveRecoveryPackage({ ...recovery, checkpoint: null }, source),
    writes,
    directDocumentProjection,
  );
  expect(saved).toEqual({
    copyPath: null,
    packagePath: `${KEPT}/notes/plan (recovered).dohc-recovery.json`,
    notInNote: 0,
    storedOn: "this-computer",
  });
  const written = JSON.parse(await readFile(join(root, saved.packagePath), "utf8"));
  expect(
    written.updates.map((update: { base64: string }) => Buffer.from(update.base64, "base64")),
  ).toEqual(recovery.entries.map((entry) => Buffer.from(entry.update)));
});

it("writes the package before the copy is projected, and keeps it when the projection fails", async () => {
  const { root, writes } = await workspace(),
    { recovery } = queue(3);
  const packaged = join(root, KEPT, "notes/plan (recovered).dohc-recovery.json");
  const projection: DocumentProjection = {
    run: vi.fn(async () => {
      await expect(access(packaged)).resolves.toBeUndefined();
      throw new Error("dohc could not prepare the document (its worker exited with 1).");
    }),
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const saved = await saveLiveRecoveryCopy(
      liveRecoveryPackage(recovery, source),
      writes,
      projection,
    );
    expect(saved).toEqual({
      copyPath: null,
      packagePath: `${KEPT}/notes/plan (recovered).dohc-recovery.json`,
    notInNote: 0,
      storedOn: "this-computer",
    });
    expect(projection.run).toHaveBeenCalledOnce();
    expect(reopen(JSON.parse(await readFile(packaged, "utf8")))).toBeTruthy();
  } finally {
    vi.restoreAllMocks();
  }
});

it("never replaces a file, and gives the copy and its package the same free number", async () => {
  const { root, writes } = await workspace(),
    { recovery } = queue(2);
  await writes.create("notes/plan (recovered).md", "older copy");
  await writes.keep("notes/plan (recovered 2).dohc-recovery.json", "older package");
  const saved = await saveLiveRecoveryCopy(
    liveRecoveryPackage(recovery, source),
    writes,
    directDocumentProjection,
  );
  expect(saved).toEqual({
    copyPath: "notes/plan (recovered 3).md",
    packagePath: `${KEPT}/notes/plan (recovered 3).dohc-recovery.json`,
    notInNote: 0,
    storedOn: "this-computer",
  });
  expect(await readFile(join(root, "notes/plan (recovered).md"), "utf8")).toBe("older copy");
  expect(await readFile(join(root, KEPT, "notes/plan (recovered 2).dohc-recovery.json"), "utf8")).toBe(
    "older package",
  );
  await writeFile(join(root, "untouched.md"), "x");
  await expect(writes.create("untouched.md", "y")).rejects.toMatchObject({ code: "EEXIST" });
});

it("refuses a queue whose bytes do not match their digests, and writes nothing", async () => {
  const { root, writes } = await workspace(),
    { recovery } = queue(2);
  const tampered = {
    ...recovery,
    entries: [recovery.entries[0]!, { ...recovery.entries[1]!, update: Uint8Array.of(1, 2, 3) }],
  };
  expect(() => liveRecoveryPackage(tampered, source)).toThrow("could not read your kept edits");
  const text = JSON.stringify(liveRecoveryPackage(recovery, source));
  expect(() =>
    parseLiveRecoveryPackage(
      text.replace(/"base64":"[^"]+"/, `"base64":"${Buffer.from("other").toString("base64")}"`),
    ),
  ).toThrow("could not read your kept edits");
  await expect(
    saveLiveRecoveryCopy(
      parseLiveRecoveryPackage(text),
      {
        ...writes,
        keep: async () => {
          throw new Error("disk full");
        },
      },
      directDocumentProjection,
    ),
  ).rejects.toThrow("disk full");
  await expect(access(join(root, "notes"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps who wrote each edit: a declaration, a person, and the author a native update's journal recorded", async () => {
  const native = (actorKind: string | null, actorOriginId: string | null) => ({
    nativeSource: {
      binding,
      adoptionId: "adoption",
      nativeSequence: 7,
      updateDigest: "",
      origin: {
        kind: "nativeUpdate" as const,
        actorOriginId,
        actorKind,
        onBehalfOf: actorKind === "human" ? null : "local-person",
        chainDepth: actorKind === "human" ? 0 : 1,
        recordedAtMs: 5,
      },
    },
  });
  const kinds: Record<number, Partial<OwnerYDocOutboxEntry>> = {
    1: { agentDeclaration: { agentId: "trip-agent", onBehalfOf: "local-person", depth: 1 } },
    2: { personEdit: true },
    3: native("human", "local-person"),
    4: native("agent", "trip-agent"),
    5: native("automation", "automation-1"),
    6: {
      nativeSource: {
        binding,
        adoptionId: "adoption",
        nativeSequence: 0,
        updateDigest: "",
        origin: { kind: "adoptionSeed" },
      },
    },
    7: {
      nativeSource: {
        ...native("agent", "trip-agent").nativeSource,
        origin: { ...native("agent", "trip-agent").nativeSource.origin, agentRunId: "run-1" },
      },
    },
    8: {
      agentDeclaration: { agentId: "trip-agent", onBehalfOf: "local-person", depth: 1 },
      agentRunId: "run-2",
    },
  };
  const { recovery } = queue(8, 0, (sequence) => kinds[sequence]!);
  const written = parseLiveRecoveryPackage(JSON.stringify(liveRecoveryPackage(recovery, source)));
  expect(written.updates.map((update) => update.author)).toEqual([
    { kind: "agent", declaration: { agentId: "trip-agent", onBehalfOf: "local-person", depth: 1 } },
    { kind: "person" },
    { kind: "person", actorOriginId: "local-person", onBehalfOf: null, chainDepth: 0 },
    { kind: "agent", actorOriginId: "trip-agent", onBehalfOf: "local-person", chainDepth: 1 },
    {
      kind: "automation",
      actorOriginId: "automation-1",
      onBehalfOf: "local-person",
      chainDepth: 1,
    },
    null,
    {
      kind: "agent",
      actorOriginId: "trip-agent",
      onBehalfOf: "local-person",
      chainDepth: 1,
      agentRunId: "run-1",
    },
    {
      kind: "agent",
      declaration: { agentId: "trip-agent", onBehalfOf: "local-person", depth: 1 },
      agentRunId: "run-2",
    },
  ]);
  expect(written.updates.map((update) => update.nativeSource?.origin)).toEqual([
    undefined,
    undefined,
    ...[3, 4, 5, 6, 7].map((sequence) => kinds[sequence]!.nativeSource!.origin),
    undefined,
  ]);
});

/**
 * A kept edit that conflicts with a change the server already accepted from
 * someone else. The person (client 1) and the other editor (client 2) both
 * start from the same note; the other editor's change is in the checkpoint.
 * Each of `mine` is one kept update.
 */
function conflict(
  mine: ((doc: Y.Doc) => void) | readonly ((doc: Y.Doc) => void)[],
  theirs: (doc: Y.Doc) => void,
): OwnerYDocOutboxRecovery {
  const start = markdownToYDoc("# Plan\n\nStart here.\n\nKeep this.\n\n- [ ] tick me");
  const baseUpdate = Y.encodeStateAsUpdate(start);
  start.destroy();
  const editor = (clientID: number) => {
    const doc = new Y.Doc();
    doc.clientID = clientID;
    Y.applyUpdate(doc, baseUpdate);
    return doc;
  };
  const person = editor(1),
    other = editor(2);
  const updates = (typeof mine === "function" ? [mine] : mine).map((edit) => {
    const before = Y.encodeStateVector(person);
    edit(person);
    return Y.encodeStateAsUpdate(person, before);
  });
  theirs(other);
  const checkpoint = Y.encodeStateAsUpdate(other);
  person.destroy();
  other.destroy();
  return {
    outboxId: "outbox",
    binding,
    baseUpdateDigest: sha256(baseUpdate),
    baseUpdate,
    checkpoint,
    checkpointDigest: sha256(checkpoint),
    state: "quarantined",
    pendingBytes: updates.reduce((total, update) => total + update.byteLength, 0),
    oldestEntryAtMs: 1_001,
    entries: updates.map((update, index) => ({
      sequence: index + 1,
      appendKey: `append-${index + 1}`,
      deliveryId: `delivery-${index + 1}`,
      updateDigest: sha256(update),
      update,
      byteLength: update.byteLength,
      createdAtMs: 1_001 + index,
    })),
    quarantineReason: "invalid-update",
    observedBinding: null,
    retryDeliveryId: null,
  };
}

const body = (doc: Y.Doc) => doc.getXmlFragment("body");
const paragraph = (doc: Y.Doc) => (body(doc).get(1) as Y.XmlElement).get(0) as Y.XmlText;
const task = (doc: Y.Doc) => (body(doc).get(3) as Y.XmlElement).get(0) as Y.XmlElement;
const LISTED =
  "***\n\n## Kept edits that aren’t in this copy\n\nThese edits were kept on the computer that made them. A change saved at the same moment removed or replaced the place they were made, so the note above doesn’t have them.\n\n";

it.each([
  [
    "text typed into a paragraph someone else deleted",
    (doc: Y.Doc) => paragraph(doc).insert("Start here.".length, " Typed *sentence* [1]."),
    (doc: Y.Doc) => body(doc).delete(1, 1),
    "# Plan\n\nKeep this.\n\n- [ ] tick me\n",
    "Text added to a part that was deleted:\n\n> Typed \*sentence\* \[1\].\n",
  ],
  [
    "a field someone else set at the same moment",
    (doc: Y.Doc) => doc.getMap("frontmatter").set("status", "mine"),
    (doc: Y.Doc) => doc.getMap("frontmatter").set("status", "theirs"),
    "---\nstatus: theirs\n---\n\n# Plan\n\nStart here.\n\nKeep this.\n\n- [ ] tick me\n",
    "Set status to “mine”. The note has “theirs”.\n",
  ],
  [
    "a to-do someone else set at the same moment",
    (doc: Y.Doc) => task(doc).setAttribute("checked", true as never),
    (doc: Y.Doc) => task(doc).setAttribute("checked", false as never),
    "# Plan\n\nStart here.\n\nKeep this.\n\n- [ ] tick me\n",
    "Ticked “tick me”. The note has it unticked.\n",
  ],
  [
    "the words a later kept edit left, of text typed into a paragraph someone else deleted",
    [
      (doc: Y.Doc) => paragraph(doc).insert("Start here.".length, " Kept words."),
      (doc: Y.Doc) => paragraph(doc).delete("Start here.".length, " Kept".length),
    ],
    (doc: Y.Doc) => body(doc).delete(1, 1),
    "# Plan\n\nKeep this.\n\n- [ ] tick me\n",
    "Text added to a part that was deleted:\n\n> words.\n",
  ],
  [
    "the words a later kept edit left at the start, of text typed into a paragraph someone else deleted",
    [
      (doc: Y.Doc) => paragraph(doc).insert("Start here.".length, " Kept words."),
      (doc: Y.Doc) => paragraph(doc).delete("Start here. Kept".length, " words.".length),
    ],
    (doc: Y.Doc) => body(doc).delete(1, 1),
    "# Plan\n\nKeep this.\n\n- [ ] tick me\n",
    "Text added to a part that was deleted:\n\n> Kept\n",
  ],
  [
    "a tick on a to-do someone else deleted",
    (doc: Y.Doc) => task(doc).setAttribute("checked", true as never),
    (doc: Y.Doc) => body(doc).delete(3, 1),
    "# Plan\n\nStart here.\n\nKeep this.\n",
    "Ticked a to-do that was deleted.\n",
  ],
  [
    "an image added to a to-do someone else deleted",
    (doc: Y.Doc) => {
      const image = new Y.XmlElement("image");
      image.setAttribute("src", "photo.png");
      task(doc).insert(task(doc).length, [image]);
    },
    (doc: Y.Doc) => body(doc).delete(3, 1),
    "# Plan\n\nStart here.\n\nKeep this.\n",
    "1 more kept edit, such as an image, can’t be shown as text.\n",
  ],
] as const)("lists %s at the end of the readable copy", async (_case, mine, theirs, note, listed) => {
  const { root, writes } = await workspace();
  const saved = await saveLiveRecoveryCopy(
    liveRecoveryPackage(conflict(mine, theirs), source),
    writes,
    directDocumentProjection,
  );
  expect(saved).toMatchObject({ copyPath: "notes/plan (recovered).md", notInNote: 1 });
  expect(await readFile(join(root, saved.copyPath!), "utf8")).toBe(`${note}\n${LISTED}${listed}`);
});

it("lists nothing when a kept edit's own later edit removed it", async () => {
  const { root, writes } = await workspace();
  const saved = await saveLiveRecoveryCopy(
    liveRecoveryPackage(
      conflict(
        (doc) => {
          paragraph(doc).insert(0, "Gone ");
          paragraph(doc).delete(0, "Gone ".length);
          doc.getMap("frontmatter").set("status", "first");
          doc.getMap("frontmatter").set("status", "second");
        },
        (doc) => doc.getMap("frontmatter").set("owner", "Sam"),
      ),
      source,
    ),
    writes,
    directDocumentProjection,
  );
  expect(saved.notInNote).toBe(0);
  expect(await readFile(join(root, saved.copyPath!), "utf8")).toBe(
    "---\nowner: Sam\nstatus: second\n---\n\n# Plan\n\nStart here.\n\nKeep this.\n\n- [ ] tick me\n",
  );
});

it("lists nothing when someone else set the same value at the same moment", async () => {
  const { root, writes } = await workspace();
  const same = (doc: Y.Doc) => {
    task(doc).setAttribute("checked", true as never);
    doc.getMap("frontmatter").set("status", "done");
  };
  const saved = await saveLiveRecoveryCopy(
    liveRecoveryPackage(conflict(same, same), source),
    writes,
    directDocumentProjection,
  );
  expect(saved.notInNote).toBe(0);
  expect(await readFile(join(root, saved.copyPath!), "utf8")).toBe(
    "---\nstatus: done\n---\n\n# Plan\n\nStart here.\n\nKeep this.\n\n- [x] tick me\n",
  );
});
