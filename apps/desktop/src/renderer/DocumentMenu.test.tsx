// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentMenu } from "./DocumentMenu";
// The HTML/PDF actions load ./editor/documentExport lazily, on demand — a
// Tiptap + ProseMirror + KaTeX graph the app deliberately keeps off its open
// path. Import it here so vitest transforms and executes that graph while
// collecting this file, not in the middle of a test. Leaving it on the test's
// own clock put ~600ms of module load inside the assertion, and a busy machine
// pushed it past the window (#522).
import "./editor/documentExport";

type ExportDocumentFileCall = {
  workspaceId: string;
  suggestedName: string;
  content: string;
  kind: "markdown" | "html" | "pdf";
};

// Every assertion below awaits the call itself, never a wall-clock window. A
// slow machine must delay these tests, never fail them — and no abandoned
// export can land in the next test and corrupt its call count.
let pendingClipboardWrite: ((text: string) => void) | null = null;
let pendingExport: ((payload: ExportDocumentFileCall) => void) | null = null;

const writeText = vi.fn(async (text: string) => {
  pendingClipboardWrite?.(text);
  pendingClipboardWrite = null;
});
const exportDocumentFile = vi.fn(async (payload: ExportDocumentFileCall) => {
  pendingExport?.(payload);
  pendingExport = null;
  return { path: "/tmp/out.html" };
});

// Arm before the click that should trigger the call, await after it.
function nextClipboardWrite(): Promise<string> {
  return new Promise((resolve) => {
    pendingClipboardWrite = resolve;
  });
}

function nextExport(): Promise<ExportDocumentFileCall> {
  return new Promise((resolve) => {
    pendingExport = resolve;
  });
}

vi.mock("./bridge", () => ({
  bridge: () => ({ exportDocumentFile }),
}));

const MARKDOWN = "---\ntitle: Plan\n---\n\n# Plan\n\nBody text.\n";

function stubClipboard() {
  // navigator.clipboard is a getter-only property in jsdom; define it AFTER
  // userEvent.setup() so its own stub doesn't shadow this one.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

function renderMenu() {
  return render(
    <DocumentMenu
      workspaceId="ws-1"
      suggestedName="Plan"
      getMarkdown={() => MARKDOWN}
    />,
  );
}

beforeEach(() => {
  vi.useRealTimers();
  pendingClipboardWrite = null;
  pendingExport = null;
  writeText.mockClear();
  exportDocumentFile.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("DocumentMenu", () => {
  it("is closed until the trigger is clicked, then opens a labeled menu", async () => {
    const user = userEvent.setup();
    renderMenu();
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(screen.getByTestId("document-menu-trigger"));

    expect(screen.getByRole("menu", { name: "Document actions" })).toBeTruthy();
    expect(screen.getByText("Copy as Markdown")).toBeTruthy();
    expect(screen.getByText("Export as Markdown…")).toBeTruthy();
    expect(screen.getByText("Export as HTML…")).toBeTruthy();
    expect(screen.getByText("Export as PDF…")).toBeTruthy();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByTestId("document-menu-trigger"));
    expect(screen.getByRole("menu")).toBeTruthy();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("returns focus to the trigger when closed with Escape", async () => {
    const user = userEvent.setup();
    renderMenu();
    const trigger = screen.getByTestId("document-menu-trigger");
    await user.click(trigger);
    // Focus moves into the menu list on open.
    expect(document.activeElement).toBe(screen.getByRole("menu"));

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("navigates items with ArrowDown/ArrowUp and selects with Enter", async () => {
    const user = userEvent.setup();
    renderMenu();
    stubClipboard();
    await user.click(screen.getByTestId("document-menu-trigger"));

    // First item ("Copy as Markdown") is selected by default.
    expect(
      screen.getByTestId("document-menu-item-copy-markdown").className,
    ).toContain("is-selected");
    await user.keyboard("{ArrowDown}");
    expect(
      screen.getByTestId("document-menu-item-export-markdown").className,
    ).toContain("is-selected");
    await user.keyboard("{ArrowUp}");
    expect(
      screen.getByTestId("document-menu-item-copy-markdown").className,
    ).toContain("is-selected");

    const written = nextClipboardWrite();
    await user.keyboard("{Enter}");
    expect(await written).toBe(MARKDOWN);
  });

  it("copies the exact current markdown to the clipboard and shows quiet confirmation", async () => {
    const user = userEvent.setup();
    renderMenu();
    stubClipboard();
    await user.click(screen.getByTestId("document-menu-trigger"));

    const written = nextClipboardWrite();
    await user.click(screen.getByTestId("document-menu-item-copy-markdown"));

    expect(await written).toBe(MARKDOWN);
    // Lets the component's own `await` chain finish and React repaint. No
    // polling and no timeout: the queued work is microtask-bound, so this
    // does not depend on elapsed time.
    await act(async () => {});
    expect(screen.getByText("Copied")).toBeTruthy();
  });

  it("exports as HTML through the bridge with the rendered document and closes the menu", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByTestId("document-menu-trigger"));

    const exported = nextExport();
    await user.click(screen.getByTestId("document-menu-item-export-html"));

    const call = await exported;
    expect(exportDocumentFile).toHaveBeenCalledTimes(1);
    expect(call.workspaceId).toBe("ws-1");
    expect(call.suggestedName).toBe("Plan");
    expect(call.kind).toBe("html");
    expect(call.content).toContain("<!doctype html>");
    expect(call.content).toContain("Plan");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("exports as Markdown through the bridge with the RAW document source", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByTestId("document-menu-trigger"));

    const exported = nextExport();
    await user.click(screen.getByTestId("document-menu-item-export-markdown"));

    const call = await exported;
    expect(exportDocumentFile).toHaveBeenCalledTimes(1);
    expect(call.kind).toBe("markdown");
    // Verbatim source, frontmatter included — no HTML rendering involved.
    expect(call.content).toBe(MARKDOWN);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // #564: an engine-backed document whose editor has not mounted (or failed
  // to) cannot be serialized — the markdown cache beside it is EMPTY on the
  // failed-read recovery path, and falling back to it copied and exported an
  // empty document while telling the user it worked. Every action refuses.
  it("refuses to copy or export a document it cannot serialize", async () => {
    const user = userEvent.setup();
    stubClipboard();
    render(
      <DocumentMenu
        workspaceId="ws-1"
        suggestedName="Plan"
        getMarkdown={() => null}
      />,
    );

    await user.click(screen.getByTestId("document-menu-trigger"));
    await user.click(screen.getByTestId("document-menu-item-copy-markdown"));
    // Same settle the copy test uses: let the component's own await chain
    // finish and React repaint before reading the label.
    await act(async () => {});
    // MUTATION: fall back to the empty cache -> "Copied", and the clipboard
    // holds nothing.
    const copyItem = screen.getByTestId("document-menu-item-copy-markdown");
    expect(copyItem.textContent).toBe("Document not open");
    // The label states the fact; the next step rides in the tooltip, because
    // an inline label that swaps for 1.2s has no room for it.
    expect(copyItem.getAttribute("title")).toBe(
      "You can copy this document when it opens.",
    );
    expect(writeText).not.toHaveBeenCalled();

    // The refusal leaves the menu open, so the export item is right there.
    await user.click(screen.getByTestId("document-menu-item-export-markdown"));
    await act(async () => {});
    // ONE label, on the item the user just clicked. There is one timer, so a
    // second refusal inside its window retires the first item's label as it
    // replaces the timer — otherwise the copy item keeps its refusal with
    // nothing left to clear it (codex r14).
    expect(screen.getAllByText("Document not open")).toHaveLength(1);
    const exportItem = screen.getByTestId("document-menu-item-export-markdown");
    expect(exportItem.textContent).toBe("Document not open");
    // Each action names its OWN next step.
    expect(exportItem.getAttribute("title")).toBe(
      "You can export this document when it opens.",
    );
    // MUTATION: the same fallback -> a .md file containing one newline,
    // written as if it were the user's document.
    expect(exportDocumentFile).not.toHaveBeenCalled();
  });

  // codex r23: NULL is the refusal this menu expects; a THROW is not. The
  // serializer reads a live editor, and reading it can fail — and once the
  // call moved outside the action's try boundary, that rejected the action's
  // promise into nothing: no feedback, no log, and the menu still open as
  // though the click had missed.
  it("reports a serializer that throws instead of rejecting into nothing", async () => {
    const user = userEvent.setup();
    stubClipboard();
    const failure = new Error("editor is gone");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <DocumentMenu
          workspaceId="ws-1"
          suggestedName="Plan"
          getMarkdown={() => {
            throw failure;
          }}
        />,
      );

      await user.click(screen.getByTestId("document-menu-trigger"));
      await user.click(screen.getByTestId("document-menu-item-copy-markdown"));
      await act(async () => {});

      // MUTATION: call `getMarkdown()` outside the boundary -> an unhandled
      // rejection, and the user sees the menu sit there.
      expect(
        screen.getByTestId("document-menu-item-copy-markdown").textContent,
      ).toBe("Couldn't copy");
      expect(logged).toHaveBeenCalledWith("Copy as Markdown failed", failure);
      expect(writeText).not.toHaveBeenCalled();

      // The export path answers the same way, in its own words.
      await user.click(screen.getByTestId("document-menu-item-export-markdown"));
      await act(async () => {});
      expect(
        screen.getByTestId("document-menu-item-export-markdown").textContent,
      ).toBe("Couldn't export");
      expect(logged).toHaveBeenCalledWith("Export as MARKDOWN failed", failure);
      expect(exportDocumentFile).not.toHaveBeenCalled();
      // A failure the user can still see: the menu stays open for it, exactly
      // as the refusal does.
      expect(screen.queryByRole("menu")).not.toBeNull();
    } finally {
      logged.mockRestore();
    }
  });

  it("exports as PDF through the bridge with kind: pdf", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByTestId("document-menu-trigger"));

    const exported = nextExport();
    await user.click(screen.getByTestId("document-menu-item-export-pdf"));

    expect((await exported).kind).toBe("pdf");
    expect(exportDocumentFile).toHaveBeenCalledTimes(1);
  });
});
