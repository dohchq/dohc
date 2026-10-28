// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { checkLossyNote, knownLossyNoteVerdict, useBoundNoteCheck } from "./lossyNote";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("gives up on a check past its deadline, and remembers no verdict", async () => {
  vi.useFakeTimers();
  const terminate = vi.fn();
  vi.stubGlobal("Worker", class {
    onmessage = null;
    onerror = null;
    postMessage() {}
    terminate = terminate;
  });
  const check = checkLossyNote("e".repeat(64), "# Note\n");
  const refused = expect(check).rejects.toThrow("The note check took too long.");
  await vi.advanceTimersByTimeAsync(30_000);
  await refused;
  expect(terminate).toHaveBeenCalled();
  expect(knownLossyNoteVerdict("e".repeat(64))).toBeUndefined();
});

it("remembers an answered verdict by content hash", async () => {
  await expect(checkLossyNote("f".repeat(64), "<details>\n\nHidden.\n</details>\n")).resolves.toBe(true);
  expect(knownLossyNoteVerdict("f".repeat(64))).toBe(true);
});

it("remembers verdicts across a restart of a built app, for the same checker only", async () => {
  vi.stubEnv("DEV", false);
  try {
    // A restart is a new window: a fresh module that reads storage again.
    await expect(checkLossyNote("a".repeat(64), "<details>\n\nHidden.\n</details>\n")).resolves.toBe(true);
    await expect(checkLossyNote("b".repeat(64), "# Note\n")).resolves.toBe(false);
    vi.resetModules();
    const restarted = await import("./lossyNote");
    expect(restarted.knownLossyNoteVerdict("a".repeat(64))).toBe(true);
    expect(restarted.knownLossyNoteVerdict("b".repeat(64))).toBe(false);

    const stored = JSON.parse(localStorage.getItem("dohc.lossyNoteVerdicts") ?? "null") as { checker: string };
    localStorage.setItem("dohc.lossyNoteVerdicts", JSON.stringify({ ...stored, checker: `${stored.checker}-other` }));
    vi.resetModules();
    expect((await import("./lossyNote")).knownLossyNoteVerdict("a".repeat(64))).toBeUndefined();
  } finally {
    localStorage.removeItem("dohc.lossyNoteVerdicts");
  }
});

it("checks again when stored verdicts are damaged", async () => {
  vi.stubEnv("DEV", false);
  try {
    await expect(checkLossyNote("d".repeat(64), "# Note\n")).resolves.toBe(false);
    const { checker } = JSON.parse(localStorage.getItem("dohc.lossyNoteVerdicts") ?? "null") as { checker: string };
    for (const damaged of ["{", JSON.stringify({ checker, verdicts: [["d".repeat(64), "false"]] }), JSON.stringify({ checker, verdicts: "d" })]) {
      localStorage.setItem("dohc.lossyNoteVerdicts", damaged);
      vi.resetModules();
      expect((await import("./lossyNote")).knownLossyNoteVerdict("d".repeat(64))).toBeUndefined();
    }
  } finally {
    localStorage.removeItem("dohc.lossyNoteVerdicts");
  }
});

it("keeps verdicts out of storage on a dev server", async () => {
  await expect(checkLossyNote("c".repeat(64), "# Note\n")).resolves.toBe(false);
  expect(localStorage.getItem("dohc.lossyNoteVerdicts")).toBeNull();
});

describe("useBoundNoteCheck", () => {
  const LOSSY = "# Note\n\n<details>\n\nHidden.\n</details>\n";
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  // A session seeded from LOSSY, with the witness the desktop records.
  function seeded(): Y.Doc {
    const doc = markdownToYDoc(LOSSY);
    doc.getMap("meta").set("dohcMarkdownSource", LOSSY);
    doc.getMap("meta").set("dohcMarkdownSourceSha256", sha(LOSSY));
    doc.getMap("meta").set("dohcMarkdownSourceProjectionSha256", sha(yDocToMarkdown(doc)));
    return doc;
  }

  it("clears an absent witness but checks a lossy witness even for previously checked bytes", async () => {
    const plain = markdownToYDoc("# Note\n");
    expect(renderHook(() => useBoundNoteCheck({ open: "a", doc: plain, checkedHash: "c".repeat(64) })).result.current).toBe("clear");
    const doc = seeded();
    const { result } = renderHook(() => useBoundNoteCheck({ open: "a", doc, checkedHash: sha(LOSSY), headSha256: sha(LOSSY) }));
    expect(result.current).toBe("checking");
    await waitFor(() => expect(result.current).toBe("lossy"));
  });

  it("checks a session holding other bytes than the ones checked", async () => {
    const doc = seeded();
    const { result } = renderHook(() => useBoundNoteCheck({ open: "a", doc, checkedHash: "c".repeat(64), headSha256: sha(LOSSY) }));
    expect(result.current).toBe("checking");
    await waitFor(() => expect(result.current).toBe("lossy"));
  });

  it("clears later sessions whose source keeps its meaning, including after edits", async () => {
    // Hand-written, not in dohc's form, and not lossy.
    const source = "Title\n=====\n\n* one\n";
    const witnessed = () => {
      const doc = markdownToYDoc(source);
      doc.getMap("meta").set("dohcMarkdownSource", source);
      doc.getMap("meta").set("dohcMarkdownSourceSha256", sha(source));
      doc.getMap("meta").set("dohcMarkdownSourceProjectionSha256", sha(yDocToMarkdown(doc)));
      return doc;
    };
    const first = witnessed();
    const view = renderHook(({ doc }) => useBoundNoteCheck({ open: "a", doc, checkedHash: "c".repeat(64), headSha256: sha(source) }), {
      initialProps: { doc: first },
    });
    expect(view.result.current).toBe("checking");
    await waitFor(() => expect(view.result.current).toBe("clear"));

    // The note reopens after an edit in dohc: a new document, the same witness.
    const reopened = witnessed();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("Typed.")]);
    reopened.getXmlFragment("body").push([paragraph]);
    view.rerender({ doc: reopened });
    await waitFor(() => expect(view.result.current).toBe("clear"));
  });

  it("remembers the witness of the state it checked, not the one the note rendered with", async () => {
    // The note renders with a lossy source; sync then records a source that
    // keeps its meaning before the check encodes the document.
    const doc = seeded();
    const kept = "Title\n=====\n\n* one\n";
    let swapped = false;
    const first = renderHook(() => {
      const check = useBoundNoteCheck({ open: "a", doc, checkedHash: "c".repeat(64), headSha256: null });
      if (!swapped) {
        swapped = true;
        doc.getMap("meta").set("dohcMarkdownSource", kept);
        doc.getMap("meta").set("dohcMarkdownSourceSha256", sha(kept));
        doc.getMap("meta").set("dohcMarkdownSourceProjectionSha256", sha(yDocToMarkdown(markdownToYDoc(kept))));
      }
      return check;
    });
    await waitFor(() => expect(first.result.current).toBe("clear"));

    // Another session that records the lossy source still gets its check.
    const other = seeded();
    const second = renderHook(() => useBoundNoteCheck({ open: "b", doc: other, checkedHash: "c".repeat(64), headSha256: null }));
    expect(second.result.current).toBe("checking");
    await waitFor(() => expect(second.result.current).toBe("lossy"));
  });

  it("checks a replacement document with the same source against its authoritative head", async () => {
    const edited = seeded();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("Typed.")]);
    edited.getXmlFragment("body").push([paragraph]);
    const view = renderHook(({ doc, headSha256 }) => useBoundNoteCheck({ open: "a", doc, checkedHash: "c".repeat(64), headSha256 }), {
      initialProps: { doc: edited, headSha256: sha("converted file") },
    });
    await waitFor(() => expect(view.result.current).toBe("clear"));

    // Sync swaps in another device's unedited import of the same bytes.
    view.rerender({ doc: seeded(), headSha256: sha(LOSSY) });
    expect(view.result.current).toBe("checking");
    await waitFor(() => expect(view.result.current).toBe("lossy"));
  });

  it("holds an expired lossy witness until the authoritative file head changes", async () => {
    const doc = seeded();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("Typed.")]);
    doc.getXmlFragment("body").push([paragraph]);
    const { result, rerender } = renderHook(({ headSha256 }) => useBoundNoteCheck({ open: "a", doc, checkedHash: "c".repeat(64), headSha256 }), {
      initialProps: { headSha256: sha(LOSSY) },
    });
    await waitFor(() => expect(result.current).toBe("lossy"));
    rerender({ headSha256: sha("converted file") });
    await waitFor(() => expect(result.current).toBe("clear"));
  });
});
