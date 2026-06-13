// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyForView, FileInspector, lineSpanInText } from "./FileInspector";

describe("lineSpanInText (search scroll-to-line, Phase E5.0)", () => {
  const text = "first\nsecond line\n\nfourth";

  it("spans each 1-based line, excluding the newline", () => {
    expect(lineSpanInText(text, 1)).toEqual({ start: 0, end: 5 });
    expect(lineSpanInText(text, 2)).toEqual({ start: 6, end: 17 });
    expect(lineSpanInText(text, 3)).toEqual({ start: 18, end: 18 }); // empty line
    expect(lineSpanInText(text, 4)).toEqual({ start: 19, end: 25 });
  });

  it("clamps a line past the end to the last line", () => {
    expect(lineSpanInText(text, 99)).toEqual({ start: 19, end: 25 });
    expect(lineSpanInText("", 5)).toEqual({ start: 0, end: 0 });
  });
});

describe("classifyForView dispatch", () => {
  const cases: Array<[string, string]> = [
    ["notes/today.md", "markdown"],
    ["readme.markdown", "markdown"],
    ["data/transactions.csv", "csv"],
    ["data/config.json", "json"],
    ["notes/plain.txt", "text"],
    ["uploads/receipt.png", "image"],
    ["uploads/logo.svg", "image"],
    ["uploads/voice.m4a", "audio"],
    ["uploads/contract.pdf", "pdf"],
    ["finance/wallet.sqlite", "database"],
    ["archive/old.db", "database"],
    ["finance/.apps/ledger/app.json", "app-source"],
    ["finance/.apps/ledger/src/App.tsx", "app-source"],
    ["uploads/mystery.bin", "binary"],
  ];

  for (const [path, expected] of cases) {
    it(`classifies ${path} as ${expected}`, () => {
      expect(classifyForView(path)).toBe(expected);
    });
  }

  it("treats an app-source file as app even if it has a data extension", () => {
    // .apps/<name>/app.json is app source, not a standalone JSON document.
    expect(classifyForView("x/.apps/ledger/app.json")).toBe("app-source");
  });
});

// THE P1 trap (codex review): typing arms an 800ms autosave, and unmounting
// (tab close, tab switch — the inspector is keyed by the active tab) used to
// clear the timer WITHOUT flushing, silently dropping the draft. The unmount
// cleanup must fire the pending draft through writeWorkspaceText.
describe("markdown editor unmount flush", () => {
  const bridgeMock = {
    readWorkspaceText: vi.fn(async () => ({ text: "# Hello\n", truncated: false })),
    writeWorkspaceText: vi.fn(async () => ({ path: "a.md", recorded: true })),
    listWorkspaceFiles: vi.fn(async () => ({ files: [{ path: "a.md", kind: "file" }], folders: [] })),
    collabToken: vi.fn(async () => ({ available: false as const })),
  };

  beforeEach(() => {
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function typeDraft() {
    const user = userEvent.setup();
    const view = render(<FileInspector workspaceId="ws-1" path="a.md" />);
    await screen.findByTestId("view-markdown");
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    await user.type(screen.getByTestId("markdown-editor"), "Draft!");
    return { user, view };
  }

  it("flushes the pending draft on unmount — the write carries the FINAL text", async () => {
    const { view } = await typeDraft();
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    // Unmount INSIDE the 800ms autosave window (real timers; typing is fast).
    view.unmount();
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      relativePath: "a.md",
      text: "# Hello\nDraft!",
    });
  });

  it("does not double-write when the draft already saved before unmount", async () => {
    const { user, view } = await typeDraft();
    // "Done" flushes immediately (the Ctrl+S path) — draft saved.
    await user.click(screen.getByTestId("markdown-edit-toggle"));
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
    view.unmount();
    // The unmount flush keys off the unsaved-draft flag, not the timer
    // handle: a clean save must not be replayed as a second write.
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledTimes(1);
  });
});
