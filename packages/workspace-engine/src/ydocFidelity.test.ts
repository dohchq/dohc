// WS-G2-B fidelity harness.
//
// MARKDOWN-IS-THE-ARTIFACT means anything the projection (yDocToMarkdown)
// drops is lost on EVERY close, not just at migration. This harness rounds a
// corpus through BOTH the pure projection AND the engine driver (file -> Y.Doc
// on open, Y.Doc -> file on settle/reopen) to pin, as executable facts:
//   1. WHAT SURVIVES — every markdown structure the Tiptap schema serializes.
//   2. WHAT IS LOSSY — Y.Doc state with no markdown surface (the design's
//      known lossy corners: suggestion threads / non-serialized marks). Because
//      we CHOSE markdown-is-the-artifact, that loss is EXPECTED; pinning it
//      here makes it known, not surprising.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import { createVersionedTextStore } from "./versionedTextStore";
import { createYDocEngineDriver } from "./ydocEngineDriver";
import type { VersionedTextStore } from "@dohc/workspace-contracts/engine";

const WS = "ws-fidelity";

// A representative corpus: each entry is [name, markdown, survivingFragments].
// The fragments are what MUST still be present after a full file->Y.Doc->file
// round trip (a subset of exact serialization, robust to whitespace nits the
// projection legitimately normalizes).
const CORPUS: Array<{ name: string; markdown: string; survives: string[] }> = [
  {
    name: "headings + inline marks",
    markdown: [
      "# ATX heading",
      "",
      "A paragraph with **bold**, *emphasis*, `code`, and",
      "[a link](https://example.com).",
    ].join("\n"),
    survives: ["# ATX heading", "**bold**", "*emphasis*", "`code`", "[a link](https://example.com)"],
  },
  {
    name: "lists + nesting + blockquote",
    markdown: [
      "> Quote level one",
      ">",
      "> - quoted bullet",
      "",
      "1. ordered",
      "2. ordered again",
      "   - nested bullet",
    ].join("\n"),
    survives: ["> Quote level one", "> - quoted bullet", "1. ordered", "- nested bullet"],
  },
  {
    name: "GFM table + task list + strikethrough",
    markdown: [
      "| Metric | Value |",
      "| --- | ---: |",
      "| apples | 10 |",
      "",
      "- [ ] write the migration",
      "- [x] keep completed work visible",
      "",
      "~~obsolete note~~",
    ].join("\n"),
    survives: ["| Metric", "apples", "- [ ] write the migration", "- [x] keep completed work visible", "~~obsolete note~~"],
  },
  {
    name: "code fence + custom dohc query fence",
    markdown: ["```ts", "const answer = 42", "```", "", "```query render=\"text\"", "tasks.list(\"open\")", "```"].join("\n"),
    survives: ["```ts\nconst answer = 42\n```", "```dohc-query render=\"text\"", "tasks.list(\"open\")"],
  },
  {
    name: "frontmatter + obsidian power-user syntax",
    markdown: [
      "---",
      "title: Daily note",
      "tags:",
      "  - alpha/beta",
      "---",
      "",
      "# Daily note",
      "",
      "See [[Projects/dohc#Graph view|graph plan]] and ![[assets/chart.png]].",
      "",
      "Body with #work/deep and ==highlighted text==.",
    ].join("\n"),
    survives: [
      "title: Daily note",
      "tags:\n  - alpha/beta",
      "# Daily note",
      "[[Projects/dohc#Graph view|graph plan]]",
      "![[assets/chart.png]]",
      "#work/deep",
      "==highlighted text==",
    ],
  },
];

let root: string;
let store: VersionedTextStore;
let versionId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-ydoc-fidelity-"));
  store = createVersionedTextStore(root);
  const main = await store.ensureMainVersion({ workspaceId: WS });
  versionId = main.id;
});

afterEach(async () => {
  await store.close();
  closeTrackedEngineDbHandlesForTest();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("YDoc fidelity — what SURVIVES the projection round trip", () => {
  for (const entry of CORPUS) {
    it(`pure projection is stable + preserves structure: ${entry.name}`, () => {
      const once = yDocToMarkdown(markdownToYDoc(entry.markdown));
      const twice = yDocToMarkdown(markdownToYDoc(once));
      // Idempotent: a second round trip is a no-op (deterministic projection,
      // design Risk 4 — cross-machine settle history stays coherent).
      expect(twice).toBe(once);
      for (const fragment of entry.survives) {
        expect(once).toContain(fragment);
      }
    });

    it(`driver round trip (file -> Y.Doc -> file) preserves structure: ${entry.name}`, async () => {
      const path = `docs/${entry.name.replace(/[^a-z0-9]+/gi, "-")}.md`;
      await store.writeTextFile({
        workspaceId: WS,
        versionId,
        path,
        text: entry.markdown,
        metadata: { origin: "api" },
      });
      const driver = createYDocEngineDriver({ store, rootDir: root });
      // Open (file -> Y.Doc), settle (Y.Doc -> file), close.
      const session = await driver.openSession({ workspaceId: WS, versionId, path });
      await session.settle();
      await session.close();
      // Reopen and read the projection the closed file now yields.
      const reopened = await store.readTextFile({ workspaceId: WS, versionId, path });
      expect(reopened).not.toBeNull();
      for (const fragment of entry.survives) {
        expect(reopened?.text).toContain(fragment);
      }
      await driver.close();
    });
  }
});

describe("YDoc fidelity — what is LOSSY (expected under markdown-is-the-artifact)", () => {
  it("Y.Doc state with no markdown surface is dropped on projection", () => {
    const doc = markdownToYDoc("# Real body\n");
    // Simulate a suggestion-thread / ephemeral sidecar: a Y.Doc field the
    // projection has no markdown surface for (the design's named lossy corner).
    doc.getMap("suggestionThreads").set("thread-1", {
      anchorFrom: 3,
      anchorTo: 8,
      comment: "please tighten this",
    });
    doc.getArray("pendingMarks").push([{ type: "aiSuggestion", from: 0, to: 4 }]);

    const projected = yDocToMarkdown(doc);
    // The real body survives...
    expect(projected).toContain("# Real body");
    // ...but the sidecar state has NO markdown surface: it is gone. Pinned so
    // this loss is KNOWN. A future persistent-threads layer (the additive
    // ydoc_snapshots-kept-durable path) is what would preserve it — NOT the
    // markdown file.
    expect(projected).not.toContain("please tighten this");
    expect(projected).not.toContain("aiSuggestion");

    // And a reopened doc seeded FROM the projected markdown has no trace of it.
    const reseeded = markdownToYDoc(projected);
    expect(reseeded.getMap("suggestionThreads").size).toBe(0);
    expect(reseeded.getArray("pendingMarks").length).toBe(0);
  });

  it("the lossy sidecar does NOT survive a driver close either", async () => {
    const path = "docs/lossy.md";
    await store.writeTextFile({
      workspaceId: WS,
      versionId,
      path,
      text: "# Real body\n",
      metadata: { origin: "api" },
    });
    const driver = createYDocEngineDriver({ store, rootDir: root });
    const session = await driver.openSession({ workspaceId: WS, versionId, path });
    // Attach ephemeral sidecar state to the LIVE doc, then close (settle).
    session.doc.getMap("suggestionThreads").set("t1", { comment: "ephemeral" });
    await session.close();

    const reopened = await store.readTextFile({ workspaceId: WS, versionId, path });
    expect(reopened?.text).toContain("# Real body");
    expect(reopened?.text).not.toContain("ephemeral");
    await driver.close();
  });
});
