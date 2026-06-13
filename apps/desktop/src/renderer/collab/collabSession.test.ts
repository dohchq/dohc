import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createCollabSessionState,
  firstSyncMaterializationBase,
  isSelfMaterializedWrite,
  recordMaterialization,
  reconcileExternalEdit,
  rescuePathFor,
  resolveFileLifecycle,
  sha256Hex,
  shouldMaterialize,
} from "./collabSession";

// The 6 plan data-loss cases (D-07) EACH get an explicit test. "Preserves both
// versions" is the floor; silent loss is never acceptable; git conflict markers
// must never appear in any merged output.

const CONFLICT_MARKERS = /^(<<<<<<<|=======|>>>>>>>)/m;

describe("CASE 1: CRDT is canonical while a shared doc has an active session", () => {
  it("does not materialize on every change — only at a settle point with real pending content", () => {
    const state = { ...createCollabSessionState(), active: true };
    // No trigger that is a settle point, but a debounce IS a settle point:
    expect(
      shouldMaterialize({
        state,
        docText: "hello world",
        onDiskText: "hello",
        trigger: "settle-debounce",
      }),
    ).toBe(true);
  });

  it("never materializes when the doc already equals disk (nothing pending)", () => {
    const state = { ...createCollabSessionState(), active: true };
    expect(
      shouldMaterialize({
        state,
        docText: "same",
        onDiskText: "same",
        trigger: "explicit-save",
      }),
    ).toBe(false);
  });

  it("does not let the closed-session (file-canonical) path materialize through this model", () => {
    const state = createCollabSessionState(); // inactive
    expect(
      shouldMaterialize({
        state,
        docText: "doc",
        onDiskText: "disk",
        trigger: "settle-debounce",
      }),
    ).toBe(false);
    // ...but a session-close settle is allowed even when inactive (final flush).
    expect(
      shouldMaterialize({
        state,
        docText: "doc",
        onDiskText: "disk",
        trigger: "session-close",
      }),
    ).toBe(true);
  });
});

describe("CASE 2: a base-hash record per materialization", () => {
  it("records the sha of the exact materialized text", () => {
    let state = { ...createCollabSessionState(), active: true };
    state = recordMaterialization(state, "version one", 1000);
    expect(state.lastMaterialized).not.toBeNull();
    expect(state.lastMaterialized?.sha).toBe(sha256Hex("version one"));
    expect(state.lastMaterialized?.atMs).toBe(1000);

    // A new materialization replaces the base hash.
    state = recordMaterialization(state, "version two", 2000);
    expect(state.lastMaterialized?.sha).toBe(sha256Hex("version two"));
    expect(state.lastMaterialized?.sha).not.toBe(sha256Hex("version one"));
  });

  it("suppresses a redundant materialize of the exact text we just wrote", () => {
    let state = { ...createCollabSessionState(), active: true };
    state = recordMaterialization(state, "doc text", 1000);
    expect(
      shouldMaterialize({
        state,
        docText: "doc text",
        onDiskText: "stale disk read",
        trigger: "settle-debounce",
      }),
    ).toBe(false);
  });
});

describe("first rich sync base selection", () => {
  it("uses the server body cache as the base when the local file still matches it", () => {
    expect(
      firstSyncMaterializationBase({
        serverBaseText: "# Doc\n\nBefore projection\n",
        docText: "# Doc\n\nBefore projection\n\nLive remote edit\n",
        onDiskText: "# Doc\n\nBefore projection\n",
        lastMaterializedText: null,
      }),
    ).toBe("# Doc\n\nBefore projection\n");
  });

  it("does not invent a base when the local file has a divergent offline edit", () => {
    expect(
      firstSyncMaterializationBase({
        serverBaseText: "# Doc\n\nBefore projection\n",
        docText: "# Doc\n\nBefore projection\n\nLive remote edit\n",
        onDiskText: "# Doc\n\nBefore projection\n\nLocal offline edit\n",
        lastMaterializedText: null,
      }),
    ).toBeNull();
  });
});

describe("CASE 3: watcher must suppress self-materialized writes (no loop)", () => {
  it("recognises our own write by sha and suppresses it", () => {
    const state = recordMaterialization(
      { ...createCollabSessionState(), active: true },
      "the materialized text",
      1000,
    );
    const observed = sha256Hex("the materialized text");
    expect(isSelfMaterializedWrite(observed, state.lastMaterialized)).toBe(true);
  });

  it("does NOT suppress a genuinely different write (external edit passes through)", () => {
    const state = recordMaterialization(
      { ...createCollabSessionState(), active: true },
      "the materialized text",
      1000,
    );
    const observed = sha256Hex("an external agent edited this");
    expect(isSelfMaterializedWrite(observed, state.lastMaterialized)).toBe(false);
  });

  it("never suppresses when nothing was materialized yet", () => {
    expect(isSelfMaterializedWrite("anything", null)).toBe(false);
  });

  it("reconcileExternalEdit no-ops on a self-materialized bounce", () => {
    const base = "the materialized text";
    const sha = sha256Hex(base);
    const res = reconcileExternalEdit({
      onDiskText: base,
      lastMaterializedText: base,
      docText: "doc has newer edits",
      observedSha: sha,
      lastMaterialized: { sha, atMs: 1 },
    });
    expect(res.kind).toBe("no-op");
  });
});

describe("CASE 4: external edit during a live session never silently loses data", () => {
  it("merges a non-overlapping external edit into the doc (both kept, no markers)", () => {
    const base = "line1\nline2\nline3";
    const doc = "line1 edited by me\nline2\nline3"; // local changed line 1
    const disk = "line1\nline2\nline3 edited externally"; // remote changed line 3
    const res = reconcileExternalEdit({
      onDiskText: disk,
      lastMaterializedText: base,
      docText: doc,
    });
    expect(res.kind).toBe("merge-into-doc");
    if (res.kind === "merge-into-doc") {
      expect(res.mergedText).toContain("line1 edited by me");
      expect(res.mergedText).toContain("line3 edited externally");
      expect(res.mergedText).not.toMatch(CONFLICT_MARKERS);
    }
  });

  it("raises a conflict (both versions preserved) when edits overlap — never picks one", () => {
    const base = "the original sentence";
    const doc = "my rewrite of the sentence";
    const disk = "their rewrite of the sentence";
    const res = reconcileExternalEdit({
      onDiskText: disk,
      lastMaterializedText: base,
      docText: doc,
    });
    expect(res.kind).toBe("conflict");
    if (res.kind === "conflict") {
      expect(res.docText).toBe(doc);
      expect(res.onDiskText).toBe(disk);
    }
  });

  it("adopts on-disk text when the doc is still empty (no divergence to lose)", () => {
    const res = reconcileExternalEdit({
      onDiskText: "external content",
      lastMaterializedText: null,
      docText: "",
    });
    expect(res).toEqual({ kind: "merge-into-doc", mergedText: "external content" });
  });

  it("conflicts (preserves both) when there is no base but the doc already diverged", () => {
    const res = reconcileExternalEdit({
      onDiskText: "external content",
      lastMaterializedText: null,
      docText: "my unsaved doc work",
    });
    expect(res.kind).toBe("conflict");
  });
});

describe("CASE 5: offline reconnect convergence (Yjs property, proven at the Y.Doc level)", () => {
  it("two docs edited offline converge after exchanging updates, with NO git markers", () => {
    // Both clients start from the same base (a materialized file).
    const base = "shared notes\n- first item\n";
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.getText("content").insert(0, base);
    // Seed B from A's state so they share history (as a fresh join would).
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    // Go offline: each edits independently at different positions.
    const a = docA.getText("content");
    const b = docB.getText("content");
    a.insert(a.length, "- A added this while offline\n");
    b.insert(b.length, "- B added this while offline\n");
    expect(a.toString()).not.toBe(b.toString());

    // Reconnect: exchange updates both ways.
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));

    // Converged, both offline edits survived, and no conflict markers exist.
    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toContain("- A added this while offline");
    expect(a.toString()).toContain("- B added this while offline");
    expect(a.toString()).not.toMatch(CONFLICT_MARKERS);

    docA.destroy();
    docB.destroy();
  });

  it("converges regardless of the order updates are applied (commutative)", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.getText("content").insert(0, "start");
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    docA.getText("content").insert(0, "X");
    docB.getText("content").insert(docB.getText("content").length, "Y");

    const updA = Y.encodeStateAsUpdate(docA);
    const updB = Y.encodeStateAsUpdate(docB);
    const r1 = new Y.Doc();
    const r2 = new Y.Doc();
    // Apply in opposite orders.
    Y.applyUpdate(r1, updA);
    Y.applyUpdate(r1, updB);
    Y.applyUpdate(r2, updB);
    Y.applyUpdate(r2, updA);
    expect(r1.getText("content").toString()).toBe(r2.getText("content").toString());

    docA.destroy();
    docB.destroy();
    r1.destroy();
    r2.destroy();
  });
});

describe("CASE 6: rename/delete of a file with a live doc is safe", () => {
  it("follows a rename to the new path (no data at risk)", () => {
    const res = resolveFileLifecycle({
      event: { kind: "renamed", from: "notes/old.md", to: "notes/new.md" },
      docText: "anything",
      lastMaterializedText: "anything",
    });
    expect(res).toEqual({ kind: "follow-rename", newPath: "notes/new.md" });
  });

  it("rescues unmaterialized doc content to an explicit sibling when the file is deleted", () => {
    const res = resolveFileLifecycle({
      event: { kind: "deleted", path: "notes/draft.md" },
      docText: "important unsaved work in the live doc",
      lastMaterializedText: "an older version",
    });
    expect(res.kind).toBe("rescue");
    if (res.kind === "rescue") {
      expect(res.text).toBe("important unsaved work in the live doc");
      expect(res.rescuePath).toBe("notes/draft.recovered.md");
    }
  });

  it("closes cleanly when the doc held nothing the disk didn't already have", () => {
    const res = resolveFileLifecycle({
      event: { kind: "deleted", path: "notes/draft.md" },
      docText: "synced content",
      lastMaterializedText: "synced content",
    });
    expect(res).toEqual({ kind: "close-clean" });
  });

  it("rescue path names are unmistakable and never look like normal content", () => {
    expect(rescuePathFor("a/b/file.md")).toBe("a/b/file.recovered.md");
    expect(rescuePathFor("noext")).toBe("noext.recovered");
    expect(rescuePathFor("dir.with.dot/file")).toBe("dir.with.dot/file.recovered");
  });
});
